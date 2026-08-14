/**
 * appointmentsRepository.js
 * Tenant-scoped appointments / bookings.
 *
 * Booking a referred customer's FIRST appointment completes their referral:
 * the referral moves Pending → Successful and the bonus points are credited to
 * the referred customer, then the referral is marked Bonus Credited. Rejected
 * referrals never pay out, and later appointments never re-trigger the bonus.
 */

import { createScopedRepository } from './scopedRepository.js';
import * as customersRepository from './customersRepository.js';
import * as referralsRepository from './referralsRepository.js';

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
 * Add an appointment, then — when this is the referred customer's very first
 * appointment — complete their pending referral and credit the bonus points.
 */
export async function addAppointment(payload, opts = {}) {
    // Count existing bookings BEFORE the write so a realtime listener racing
    // the insert can never change the "first appointment" determination.
    const customerId = payload && payload.customerId;
    const isFirst = customerId
        ? !listAppointments().some((a) => a.customerId === customerId)
        : false;

    const appointment = await repo.add(payload, opts);
    if (isFirst) await maybeCreditReferralBonus(appointment);
    return appointment;
}

/** Credit a referred customer's bonus on their first completed booking. */
async function maybeCreditReferralBonus(appointment) {
    const customerId = appointment && appointment.customerId;
    if (!customerId) return;

    const customer = customersRepository.getCustomer(customerId);
    if (!customer || !customer.referredByCode || !customer.referringSalonId) return;

    // Only an open (Pending) referral can be completed; a rejected referral
    // never pays out, and an already-completed one is never double-credited.
    const referral = await referralsRepository.findReferral(customer.referredByCode, customerId);
    if (!referral || referral.status !== 'Pending') return;

    const updated = await referralsRepository.markReferralSuccessful(referral, appointment.id);
    const bonus = Number(updated.bonusAmount) || 0;
    const points = (Number(customer.referralPoints) || 0) + bonus;
    await customersRepository.updateCustomer(customerId, { referralPoints: points });
    await referralsRepository.completeReferral(updated);
}

export default {
    initAppointments,
    setSalon,
    addAppointment,
    updateAppointment,
    deleteAppointment,
    listAppointments,
    seed,
};