/**
 * appointmentsRepository.js
 * Tenant-scoped appointments / bookings.
 *
 * Referral bonus is credited when an appointment reaches "Completed" status,
 * not on booking creation.  This ensures the referrer is rewarded only when
 * the referred customer actually attends their visit.
 */

import { createScopedRepository } from './scopedRepository.js';
import { REFERRAL_BONUS_POINTS } from '../core/rewards.js';
import * as referralsRepository from './referralsRepository.js';
import * as customersRepository from './customersRepository.js';
import * as rewardTransactionsRepository from './rewardTransactionsRepository.js';

export const seed = [
    { id: 'a1', salonId: 'salon_luxe_01', customerName: 'Olivia Wilde', serviceName: 'Balayage & Gloss', staffName: 'Victoria Sterling', date: '2026-06-15', time: '10:00', status: 'Confirmed' },
];

const repo = createScopedRepository({
    stateKey: 'appointmentsList',
    collectionName: 'appointments',
    seed,
});

export const initAppointments = repo.init;
export const setSalon = repo.setSalon;
export const updateAppointment = repo.update;
export const deleteAppointment = repo.remove;
export const listAppointments = repo.data;

/**
 * Add an appointment.  Referral bonus is NOT triggered here — it fires
 * only when the appointment status changes to "Completed".
 */
export async function addAppointment(payload, opts = {}) {
    return repo.add(payload, opts);
}

/**
 * Credit the referrer when a referred customer's appointment is completed.
 *
 * Handles mid-chain failures: if a previous call marked the referral
 * Successful but crashed before crediting points, this call detects the
 * "Successful" state and retries the credit + Bonus Credited transition.
 *
 * Idempotent: checks the transaction ledger before crediting to prevent
 * duplicate points.
 */
export async function maybeCreditReferralBonus(appointment) {
    const apptId = appointment.id;
    const custId = appointment.customerId;
    const salonId = appointment.salonId;
    console.log('[REFERRAL] ─── maybeCreditReferralBonus START ───');
    console.log('[REFERRAL] Appointment:', apptId, '| Customer B:', custId, '| Salon:', salonId);

    // 1. Fetch the referred customer directly from their salon.
    const customer = await customersRepository.getCustomerFromSalon(custId, salonId);
    if (!customer || !customer.referredByCode) {
        console.log('[REFERRAL] Customer has no referredByCode — skipping.');
        return;
    }
    const refCode = customer.referredByCode;
    const clientAId = customer.referringCustomerId;
    console.log('[REFERRAL] Client B:', customer.id, '|', customer.name,
        '| referredByCode:', refCode,
        '| Client A ID:', clientAId,
        '| Client A salon:', customer.referringSalonId);

    // 2. Find the referral (reads directly from Firestore in Firebase mode).
    const referral = await referralsRepository.findReferral(refCode, customer.id);
    if (!referral) {
        console.log('[REFERRAL] No referral record found for code', refCode,
            '+ customer', customer.id, '— skipping.');
        return;
    }
    console.log('[REFERRAL] Referral:', referral.id,
        '| status:', referral.status,
        '| Client A:', referral.referringCustomerId,
        '| bonus:', referral.bonusAmount);

    // 3. Already fully processed — nothing to do.
    if (referral.status === 'Bonus Credited') {
        console.log('[REFERRAL] Already Bonus Credited — skipping.');
        return;
    }

    // 4. Mid-chain recovery: referral is "Successful" but points may never
    //    have been credited (previous call crashed after marking Successful
    //    but before completing the full credit flow).
    const needsSuccessfulMark = referral.status === 'Pending';
    if (!needsSuccessfulMark && referral.status !== 'Successful') {
        console.log('[REFERRAL] Unexpected status:', referral.status, '— skipping.');
        return;
    }

    // 5. Mark Successful (only if still Pending).
    if (needsSuccessfulMark) {
        try {
            const result = await referralsRepository.markReferralSuccessful(referral, apptId);
            if (result) Object.assign(referral, result);
            console.log('[REFERRAL] Marked Successful:', referral.id, '| appointment:', apptId);
        } catch (err) {
            const fresh = await referralsRepository.findReferral(refCode, customer.id);
            if (fresh && fresh.status === 'Successful') {
                console.log('[REFERRAL] Already Successful in Firestore — proceeding.');
                Object.assign(referral, fresh);
            } else {
                console.error('[REFERRAL] markReferralSuccessful failed:', err);
                throw err;
            }
        }
    } else {
        console.log('[REFERRAL] Already Successful — proceeding to credit.');
    }

    // 6. Fetch the referrer (Client A) from their salon.
    let referrer;
    try {
        referrer = await customersRepository.getCustomerFromSalon(
            referral.referringCustomerId,
            referral.referringSalonId,
        );
    } catch (err) {
        console.error('[REFERRAL] Failed to fetch Client A', referral.referringCustomerId,
            'from salon', referral.referringSalonId, ':', err.message || err);
        return;
    }
    if (!referrer) {
        console.warn('[REFERRAL] Client A not found:', referral.referringCustomerId,
            'in salon', referral.referringSalonId);
        return;
    }
    const prevPts = Number(referrer.referralPoints) || 0;
    console.log('[REFERRAL] Client A:', referrer.id, '|', referrer.name,
        '| salon:', referral.referringSalonId,
        '| prev pts:', prevPts);

    // 7. Idempotency guard: skip if a reward transaction was already recorded.
    const existingTx = await rewardTransactionsRepository.findReferralTransaction(referral.id);
    if (existingTx) {
        console.log('[REFERRAL] Transaction already exists for', referral.id,
            '— ensuring terminal state.');
        try { await referralsRepository.completeReferral(referral); } catch (_) { /* already credited */ }
        return;
    }

    // 8. Mark Bonus Credited BEFORE crediting points (primary idempotency lock).
    try {
        await referralsRepository.completeReferral(referral);
        console.log('[REFERRAL] Referral status → Bonus Credited:', referral.id);
    } catch (err) {
        console.warn('[REFERRAL] completeReferral failed (may already be completed):',
            err.message);
    }

    // 9. Record the reward transaction for audit.
    const bonus = Number(referral.bonusAmount) || REFERRAL_BONUS_POINTS;
    try {
        await rewardTransactionsRepository.recordReferralBonus({
            referralId: referral.id,
            referrerId: referrer.id,
            referrerName: referrer.name,
            salonId: referral.referredSalonId,
        });
        console.log('[REFERRAL] Transaction recorded:', referral.id);
    } catch (err) {
        console.warn('[REFERRAL] recordReferralBonus failed:', err.message);
    }

    // 10. Credit the referrer's points balance.
    const newPts = prevPts + bonus;
    await customersRepository.updateCustomerInSalon(referrer.id, referral.referringSalonId, {
        referralPoints: newPts,
    });
    console.log('[REFERRAL] ✅ Points credited — Client A:', referrer.id,
        '| prev:', prevPts, '| bonus:', bonus, '| updated:', newPts, 'pts',
        '| referral status:', referral.status === 'Bonus Credited' ? 'Bonus Credited' : 'Bonus Credited');

    // 11. Force-refresh the referral card so the UI reflects the new state.
    await referralsRepository.forceRefreshReferrals();
    console.log('[REFERRAL] Referral card refreshed');
    console.log('[REFERRAL] ─── maybeCreditReferralBonus END ───');
}

export default {
    initAppointments,
    setSalon,
    addAppointment,
    maybeCreditReferralBonus,
    updateAppointment,
    deleteAppointment,
    listAppointments,
    seed,
};