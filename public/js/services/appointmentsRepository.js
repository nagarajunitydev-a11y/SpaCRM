/**
 * appointmentsRepository.js
 * Tenant-scoped appointments / bookings.
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
export const addAppointment = repo.add;
export const updateAppointment = repo.update;
export const deleteAppointment = repo.remove;
export const listAppointments = repo.data;

export default { initAppointments, setSalon, addAppointment, updateAppointment, deleteAppointment, listAppointments, seed };
