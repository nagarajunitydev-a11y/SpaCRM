/**
 * appointmentsRepository.js
 * Tenant-scoped appointments / bookings.
 */

import { createScopedRepository } from './scopedRepository.js';

export const seed = [
    { id: 'a1', salonId: 'salon_luxe_01', customerName: 'Olivia Wilde', serviceName: 'Balayage & Gloss', staffName: 'Victoria Sterling', date: '2026-06-15', time: '10:00', status: 'Completed', amount: 160, discount: 0, couponCode: '', loyaltyRedemption: 0, tax: 28.8, refund: 0, paymentMethod: 'upi', paid: true, paymentNote: '' },
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
 * Add an appointment. Referral bonus is triggered server-side by a Cloud
 * Function when the appointment status changes to "Completed" — not here.
 */
export async function addAppointment(payload, opts = {}) {
    return repo.add(payload, opts);
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