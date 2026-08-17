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
    const customer = customersRepository.getCustomer(appointment.customerId);
    if (!customer || !customer.referredByCode) return;

    const referral = await referralsRepository.findReferral(
        customer.referredByCode,
        customer.id,
    );
    if (!referral || referral.status !== 'Pending') return;

    // Mark Successful (requires an appointmentId — the Firestore rule gateway).
    const successful = await referralsRepository.markReferralSuccessful(
        referral,
        appointment.id,
    );

    // Credit the referrer's points balance.
    const referrer = customersRepository.getCustomer(referral.referringCustomerId);
    if (!referrer) {
        console.warn('[REFERRAL] Referrer not found:', referral.referringCustomerId);
        return;
    }
    const currentPts = Number(referrer.referralPoints) || 0;
    await customersRepository.updateCustomer(referrer.id, {
        referralPoints: currentPts + REFERRAL_BONUS_POINTS,
    });

    // Mark the referral as Bonus Credited.
    await referralsRepository.completeReferral(successful);

    // Create reward transaction record for audit.
    await rewardTransactionsRepository.recordReferralBonus({
        referralId: referral.id,
        referrerId: referrer.id,
        referrerName: referrer.name,
        salonId: referral.referredSalonId,
    });
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