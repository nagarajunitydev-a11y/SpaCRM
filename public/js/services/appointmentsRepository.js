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
 * Idempotent — safe to call multiple times for the same customer.
 */
async function maybeCreditReferralBonus(appointment) {
    console.log('[REFERRAL] maybeCreditReferralBonus called for appointment:', appointment.id, 'customer:', appointment.customerId);

    // Fetch the customer directly from their salon (not the scoped store) so
    // cross-salon referrals and Firestore listener race conditions are handled.
    const customer = await customersRepository.getCustomerFromSalon(
        appointment.customerId,
        appointment.salonId,
    );
    if (!customer || !customer.referredByCode) {
        console.log('[REFERRAL] No referredByCode on customer — skipping.');
        return;
    }
    console.log('[REFERRAL] Customer referred by code:', customer.referredByCode);

    const referral = await referralsRepository.findReferral(
        customer.referredByCode,
        customer.id,
    );
    if (!referral || referral.status !== 'Pending') {
        console.log('[REFERRAL] No pending referral found (status:', referral && referral.status, ') — skipping.');
        return;
    }
    console.log('[REFERRAL] Pending referral found:', referral.id);

    // Mark Successful (requires an appointmentId — the Firestore rule gateway).
    const successful = await referralsRepository.markReferralSuccessful(
        referral,
        appointment.id,
    );
    console.log('[REFERRAL] Referral marked Successful:', successful.id);

    // Credit the referrer's points balance — fetch from the referrer's own salon.
    const referrer = await customersRepository.getCustomerFromSalon(
        referral.referringCustomerId,
        referral.referringSalonId,
    );
    if (!referrer) {
        console.warn('[REFERRAL] Referrer not found:', referral.referringCustomerId, 'in salon', referral.referringSalonId);
        return;
    }
    const currentPts = Number(referrer.referralPoints) || 0;
    const newPts = currentPts + REFERRAL_BONUS_POINTS;
    await customersRepository.updateCustomerInSalon(referrer.id, referral.referringSalonId, {
        referralPoints: newPts,
    });
    console.log('[REFERRAL] Credited', REFERRAL_BONUS_POINTS, 'points to referrer', referrer.id, '(total:', newPts, ')');

    // Mark the referral as Bonus Credited.
    await referralsRepository.completeReferral(successful);
    console.log('[REFERRAL] Referral marked Bonus Credited:', successful.id);

    // Create reward transaction record for audit.
    await rewardTransactionsRepository.recordReferralBonus({
        referralId: referral.id,
        referrerId: referrer.id,
        referrerName: referrer.name,
        salonId: referral.referredSalonId,
    });
    console.log('[REFERRAL] Referral bonus transaction recorded for:', referral.id);
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