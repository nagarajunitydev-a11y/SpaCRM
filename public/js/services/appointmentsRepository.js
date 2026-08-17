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
    console.log('[REFERRAL] ─── maybeCreditReferralBonus START ───');
    console.log('[REFERRAL] Appointment ID:', appointment.id,
        '| Customer ID:', appointment.customerId,
        '| Salon ID:', appointment.salonId);

    // 1. Fetch the referred customer directly from their salon.
    const customer = await customersRepository.getCustomerFromSalon(
        appointment.customerId,
        appointment.salonId,
    );
    if (!customer || !customer.referredByCode) {
        console.log('[REFERRAL] No referredByCode on customer — skipping.');
        return;
    }
    console.log('[REFERRAL] Customer B →', customer.id, '|', customer.name,
        '| referredByCode:', customer.referredByCode,
        '| referringSalonId:', customer.referringSalonId,
        '| referringCustomerId:', customer.referringCustomerId);

    // 2. Find the referral (reads directly from Firestore in Firebase mode).
    const referral = await referralsRepository.findReferral(
        customer.referredByCode,
        customer.id,
    );
    if (!referral) {
        console.log('[REFERRAL] No referral record found for code',
            customer.referredByCode, '+ customer', customer.id, '— skipping.');
        return;
    }
    console.log('[REFERRAL] Referral found →', referral.id,
        '| status:', referral.status,
        '| referrer:', referral.referringCustomerId,
        '| referrerSalon:', referral.referringSalonId,
        '| bonusAmount:', referral.bonusAmount);

    // 3. Already fully processed — nothing to do.
    if (referral.status === 'Bonus Credited') {
        console.log('[REFERRAL] Referral already Bonus Credited:', referral.id, '— skipping.');
        return;
    }

    // 4. Mid-chain recovery: referral is "Successful" but points may never
    //    have been credited (previous call crashed after marking Successful
    //    but before completing the full credit flow).
    const needsSuccessfulMark = referral.status === 'Pending';
    if (!needsSuccessfulMark && referral.status !== 'Successful') {
        console.log('[REFERRAL] Referral in unexpected status:', referral.status, '— skipping.');
        return;
    }

    // 5. Mark Successful (only if still Pending).
    if (needsSuccessfulMark) {
        try {
            await referralsRepository.markReferralSuccessful(referral, appointment.id);
            console.log('[REFERRAL] Referral marked Successful:', referral.id,
                '| appointmentId:', appointment.id);
        } catch (err) {
            // Firestore rule may have rejected the transition because a
            // concurrent call already advanced the status.  Re-read from
            // Firestore and continue if it is already Successful.
            const fresh = await referralsRepository.findReferral(
                customer.referredByCode,
                customer.id,
            );
            if (fresh && fresh.status === 'Successful') {
                console.log('[REFERRAL] Referral already Successful in Firestore:',
                    referral.id, '— proceeding to credit.');
                Object.assign(referral, fresh);
            } else {
                console.error('[REFERRAL] markReferralSuccessful failed and referral',
                    'is not Successful in Firestore:', err);
                throw err;
            }
        }
    } else {
        console.log('[REFERRAL] Referral already Successful:', referral.id, '— proceeding to credit.');
    }

    // 6. Fetch the referrer (Customer A) from their salon.
    let referrer;
    try {
        referrer = await customersRepository.getCustomerFromSalon(
            referral.referringCustomerId,
            referral.referringSalonId,
        );
    } catch (err) {
        console.error('[REFERRAL] Failed to fetch referrer', referral.referringCustomerId,
            'from salon', referral.referringSalonId, '— possible cross-salon permission issue:', err.message || err);
        return;
    }
    if (!referrer) {
        console.warn('[REFERRAL] Referrer not found:', referral.referringCustomerId,
            'in salon', referral.referringSalonId,
            '— cross-salon referral cannot be credited.');
        return;
    }
    console.log('[REFERRAL] Referrer Customer A →', referrer.id,
        '|', referrer.name,
        '| salon:', referral.referringSalonId,
        '| current pts:', Number(referrer.referralPoints) || 0);

    // 7. Idempotency guard: skip if a reward transaction was already recorded
    //    for this referral (prevents double credit on retry).
    const existingTx = await rewardTransactionsRepository.findReferralTransaction(referral.id);
    if (existingTx) {
        console.log('[REFERRAL] Reward transaction already exists for referral:',
            referral.id, '— ensuring terminal state.');
        try { await referralsRepository.completeReferral({ ...referral, status: 'Successful' }); } catch (_) { /* already credited */ }
        return;
    }

    // 8. Mark the referral as Bonus Credited BEFORE crediting points.
    //    This uses the referral status as the primary idempotency lock:
    //    once the status is "Bonus Credited" no subsequent call can
    //    re-trigger the credit.  If we crash after this step but before
    //    crediting points, the referrer loses the points (safe failure)
    //    rather than risking a double credit.
    try {
        await referralsRepository.completeReferral({ ...referral, status: 'Successful' });
        console.log('[REFERRAL] Referral marked Bonus Credited (lock):', referral.id);
    } catch (err) {
        console.warn('[REFERRAL] completeReferral failed (may already be completed):',
            err.message);
    }

    // 9. Record the reward transaction for audit.
    try {
        await rewardTransactionsRepository.recordReferralBonus({
            referralId: referral.id,
            referrerId: referrer.id,
            referrerName: referrer.name,
            salonId: referral.referredSalonId,
        });
        console.log('[REFERRAL] Reward transaction recorded for:', referral.id);
    } catch (err) {
        console.warn('[REFERRAL] recordReferralBonus failed:', err.message);
    }

    // 10. Credit the referrer's points balance.
    const currentPts = Number(referrer.referralPoints) || 0;
    const newPts = currentPts + REFERRAL_BONUS_POINTS;
    console.log('[REFERRAL] Crediting points:', REFERRAL_BONUS_POINTS,
        '| Referrer:', referrer.id, '|', currentPts, '→', newPts, 'pts');
    await customersRepository.updateCustomerInSalon(referrer.id, referral.referringSalonId, {
        referralPoints: newPts,
    });
    console.log('[REFERRAL] ✅ Points credited:', referrer.id, '→', newPts, 'pts');

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