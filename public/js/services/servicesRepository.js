/**
 * servicesRepository.js
 * Tenant-scoped salon services catalog.
 */

import { createScopedRepository } from './scopedRepository.js';

export const seed = [
    { id: 's1', salonId: 'salon_luxe_01', name: 'Balayage & Gloss', price: 160, duration: '120m' },
    { id: 's2', salonId: 'salon_luxe_01', name: 'Signature Facial', price: 95, duration: '60m' },
    { id: 's3', salonId: 'salon_luxe_01', name: 'Precision Haircut', price: 75, duration: '45m' },
];

const repo = createScopedRepository({
    stateKey: 'servicesList',
    collectionName: 'services',
    seed,
});

export const initServices = repo.init;
export const setSalon = repo.setSalon;
export const addService = repo.add;
export const updateService = repo.update;
export const deleteService = repo.remove;
export const listServices = repo.data;

export default { initServices, setSalon, addService, updateService, deleteService, listServices, seed };
