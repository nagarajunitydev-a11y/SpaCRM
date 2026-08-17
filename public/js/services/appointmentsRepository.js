/**
 * appointmentsRepository.js
 * Tenant-scoped appointments / bookings.
 *
 * When a new appointment is created for a referred customer, the referral is
 * marked Successful and the referrer receives 100 bonus points with an audit
 * transaction record. This keeps client creation decoupled from referral
 * completion — the referral is only rewarded when the referred customer
 * actually books a visit.
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
 * Add an appointment. When this is the first appointment for a referred
 * customer, the referral is marked Successful and the referrer is credited.
 */
export async function addAppointment(payload, opts = {}) {
    const created = await repo.add(payload, opts);
    // Fire-and-forget: referral bonus processing must not block the booking.
    if (created && created.id) {
        maybeCreditReferralBonus(created).catch((err) => {
            console.warn('[REFERRAL] Bonus credit failed:', err);
        });
    }
    return created;
}

/**
 * When a referred customer books their first appointment, mark the referral
 * as Successful, credit the referrer's points, and record the transaction.
 *
 * Handles mid-chain failures: if a previous call marked the referral
 * Successful but crashed before crediting points, this call detects the
 * "Successful" state and retries the credit + Bonus Credited transition.
 *
 * Idempotent: checks the transaction ledger before crediting to prevent
 * duplicate points.
 */
async function maybeCreditReferralBonus(appointment) {
    console.log('[REFERRAL] ─── maybeCreditReferralBonus START ───');
    console.log('[REFERRAL] Appointment ID:', appointment.id, '| Customer ID:', appointment.customerId);

    // 1. Fetch the referred customer directly from their salon.
    const customer = await customersRepository.getCustomerFromSalon(
        appointment.customerId,
        appointment.salonId,
    );
    if (!customer || !customer.referredByCode) {
        console.log('[REFERRAL] No referredByCode on customer — skipping.');
        return;
    }
    console.log('[REFERRAL] Referred Customer B ID:', customer.id, '| Name:', customer.name, '| referredByCode:', customer.referredByCode);

    // 2. Find the pending referral (store first, then Firestore fallback).
    const referral = await referralsRepository.findReferral(
        customer.referredByCode,
        customer.id,
    );
    if (!referral) {
        console.log('[REFERRAL] No referral record found — skipping.');
        return;
    }

    // 3. Already fully processed — nothing to do.
    if (referral.status === 'Bonus Credited') {
        console.log('[REFERRAL] Referral already Bonus Credited:', referral.id, '— skipping.');
        return;
    }

    // 4. Mid-chain recovery: referral is "Successful" but points were never
    //    credited (previous call crashed after marking Successful but before
    //    updateCustomerInSalon + completeReferral).  Skip straight to
    //    crediting — do NOT re-mark as Successful.
    const needsSuccessfulMark = referral.status === 'Pending';
    if (!needsSuccessfulMark && referral.status !== 'Successful') {
        console.log('[REFERRAL] Referral in unexpected status:', referral.status, '— skipping.');
        return;
    }

    // 5. Mark Successful (only if still Pending).
    if (needsSuccessfulMark) {
        await referralsRepository.markReferralSuccessful(referral, appointment.id);
        console.log('[REFERRAL] Referral marked Successful:', referral.id);
    } else {
        console.log('[REFERRAL] Referral already Successful:', referral.id, '— proceeding to credit.');
    }

    // 6. Fetch the referrer (Customer A) from their salon.
    const referrer = await customersRepository.getCustomerFromSalon(
        referral.referringCustomerId,
        referral.referringSalonId,
    );
    if (!referrer) {
        console.warn('[REFERRAL] Referrer not found:', referral.referringCustomerId, 'in salon', referral.referringSalonId);
        return;
    }
    console.log('[REFERRAL] Referrer Customer A ID:', referrer.id, '| Name:', referrer.name, '| Current points:', Number(referrer.referralPoints) || 0);

    // 7. Idempotency guard: skip if a reward transaction was already recorded
    //    for this referral (prevents double credit on retry).
    const existingTx = rewardTransactionsRepository.findReferralTransaction(referral.id);
    if (existingTx) {
        console.log('[REFERRAL] Reward transaction already exists for referral:', referral.id, '— ensuring Bonus Credited status.');
        // Ensure the referral status is also advanced (safe — idempotent write).
        try { await referralsRepository.completeReferral({ ...referral, status: 'Successful' }); } catch (_) { /* already credited */ }
        return;
    }

    // 8. Credit the referrer's points balance.
    const currentPts = Number(referrer.referralPoints) || 0;
    const newPts = currentPts + REFERRAL_BONUS_POINTS;
    console.log('[REFERRAL] Bonus points calculated:', REFERRAL_BONUS_POINTS, '| Referrer:', referrer.id, '|', currentPts, '→', newPts);
    await customersRepository.updateCustomerInSalon(referrer.id, referral.referringSalonId, {
        referralPoints: newPts,
    });
    console.log('[REFERRAL] Firebase points update DONE:', referrer.id, '→', newPts, 'pts');

    // 9. Mark the referral as Bonus Credited.
    //    completeReferral requires status === 'Successful' — build that object
    //    regardless of whether we just marked it or it was already Successful.
    await referralsRepository.completeReferral({ ...referral, status: 'Successful' });
    console.log('[REFERRAL] Referral marked Bonus Credited:', referral.id);

    // 10. Create reward transaction record for audit.
    await rewardTransactionsRepository.recordReferralBonus({
        referralId: referral.id,
        referrerId: referrer.id,
        referrerName: referrer.name,
        salonId: referral.referredSalonId,
    });
    console.log('[REFERRAL] Reward transaction recorded for:', referral.id);

    // 11. Force-refresh the referral card so Total/Done/Pending/Earned update
    //     immediately (safety net on top of the onSnapshot realtime listener).
    await referralsRepository.forceRefreshReferrals();
    console.log('[REFERRAL] Referral card refreshed via forceRefreshReferrals');
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