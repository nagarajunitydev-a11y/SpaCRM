/**
 * appointmentsRepository.js
 * Tenant-scoped appointments / bookings.
 *
 * Referral bonus is credited SERVER-SIDE by a Cloud Function
 * (functions/index.js → onAppointmentStatusChange) when an appointment
 * document is updated to status "Completed". This ensures the referrer
 * is rewarded only when the referred customer actually attends their visit,
 * and the credit is atomic and idempotent via Firestore transactions.
 *
 * This module no longer handles referral crediting — that logic has been
 * moved to Firebase Cloud Functions for data integrity guarantees.
 */

import { createScopedRepository } from './scopedRepository.js';

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