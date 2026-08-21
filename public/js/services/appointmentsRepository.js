/**
 * appointmentsRepository.js
 * Tenant-scoped appointments / bookings.
 */

import { createScopedRepository } from './scopedRepository.js';
import { appointmentSeed } from './seedData.js';

export const seed = appointmentSeed;

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