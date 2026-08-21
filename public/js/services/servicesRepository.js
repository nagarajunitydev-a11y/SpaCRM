/**
 * servicesRepository.js
 * Tenant-scoped salon services catalog.
 */

import { createScopedRepository } from './scopedRepository.js';
import { serviceSeed } from './seedData.js';

export const seed = serviceSeed;

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
