/**
 * staffRepository.js
 * Tenant-scoped staff team.
 */

import { createScopedRepository } from './scopedRepository.js';

export const seed = [
    { id: 'st1', salonId: 'salon_luxe_01', name: 'Victoria Sterling', role: 'Master Stylist', phone: '+1 555-0112' },
    { id: 'st2', salonId: 'salon_luxe_01', name: 'Julian Vance', role: 'Esthetician', phone: '+1 555-0199' },
];

const repo = createScopedRepository({
    stateKey: 'staffList',
    collectionName: 'staff',
    seed,
});

export const initStaff = repo.init;
export const setSalon = repo.setSalon;
export const addStaff = repo.add;
export const updateStaff = repo.update;
export const deleteStaff = repo.remove;
export const listStaff = repo.data;

export default { initStaff, setSalon, addStaff, updateStaff, deleteStaff, listStaff, seed };
