/**
 * customersRepository.js
 * Tenant-scoped customers with reward points and a referral wallet.
 *
 * Every customer is stored under their salon and receives signup bonus
 * points when created. Duplicate customers (same phone or exact name)
 * within the salon are rejected before anything is written.
 *
 * Two independent balances live on a client record and are never mixed:
 *   `rewardPoints`  - the loyalty scheme, measured in points;
 *   `walletBalance` - the referral wallet, measured in rupees, moved only by
 *                     referralService.js inside an atomic transaction.
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { createScopedRepository } from './scopedRepository.js';

const SIGNUP_BONUS = 100;

/** A new client starts with an empty referral wallet. */
const STARTING_WALLET_BALANCE = 0;

export const seed = [
    { id: 'c1', salonId: 'salon_luxe_01', name: 'Olivia Wilde', phone: '+1 555-0143', email: 'olivia@example.com', rewardPoints: 150 },
    { id: 'c2', salonId: 'salon_luxe_01', name: 'Jessica Alba', phone: '+1 555-0199', email: 'jessica@example.com', rewardPoints: 220 },
];

const repo = createScopedRepository({
    stateKey: 'customersList',
    collectionName: 'customers',
    seed,
});

export const initCustomers = repo.init;
export const setSalon = repo.setSalon;
export const listCustomers = repo.data;
export const updateCustomer = repo.update;

/** Normalise a phone to digits-only so +1 555-0143 == 15550143. */
function normalizePhone(phone) {
    return String(phone || '').replace(/\D/g, '');
}

/** Find a client in the current salon by exact name (case-insensitive). */
export function findCustomerByName(name) {
    const q = (name || '').trim().toLowerCase();
    if (!q) return null;
    return listCustomers().find((c) => (c.name || '').trim().toLowerCase() === q) || null;
}

/** Find a client in the current salon by phone (format-insensitive). */
export function findCustomerByPhone(phone) {
    const q = normalizePhone(phone);
    if (!q) return null;
    return listCustomers().find((c) => normalizePhone(c.phone) === q) || null;
}

/**
 * Add a client, awarding the signup bonus points.
 * Duplicate clients within the salon are rejected.
 */
export async function addCustomer(payload) {
    const existing = findCustomerByPhone(payload.phone) || findCustomerByName(payload.name);
    if (existing) {
        throw new Error(`A client already exists in this salon (${existing.name}${existing.phone ? `, ${existing.phone}` : ''}).`);
    }

    const row = {
        ...payload,
        rewardPoints: SIGNUP_BONUS,
        walletBalance: STARTING_WALLET_BALANCE,
    };

    return repo.add(row);
}

/**
 * Quick-add from the appointment picker. Returns the existing client when one
 * matches (name/phone), otherwise creates one — never duplicates.
 */
export async function addCustomerQuick(payload) {
    const existing = findCustomerByName(payload.name) || findCustomerByPhone(payload.phone);
    if (existing) return existing;
    return repo.add(
        {
            ...payload,
            rewardPoints: SIGNUP_BONUS,
            walletBalance: STARTING_WALLET_BALANCE,
        },
        { skipValidation: true },
    );
}

/** Get a customer row by id. */
export function getCustomer(id) {
    return listCustomers().find((c) => c.id === id) || null;
}

/**
 * Redeem a reward tier. `tierPoints` is the cost in points; throws when the
 * customer cannot afford it (transaction-safe message for the UI).
 *
 * NOTE: Points deduction is a client-side operation for now. In production,
 * this should be moved to a Cloud Function for atomicity.
 */
export async function redeemReward(customerId, tierPoints) {
    const pts = Number(getCustomer(customerId)?.rewardPoints) || 0;
    if (pts < tierPoints) {
        throw new Error(`Need at least ${tierPoints} points for this reward.`);
    }
    return repo.update(customerId, { rewardPoints: pts - tierPoints });
}

/** Find a client in the current salon by their referral code. */
export function findCustomerByReferralCode(code) {
    const q = String(code || '').trim().toUpperCase();
    if (!q) return null;
    return listCustomers().find((c) => String(c.referralCode || '').toUpperCase() === q) || null;
}

/** Delete a customer. */
export async function deleteCustomer(id) {
    return repo.remove(id);
}

export default {
    initCustomers,
    setSalon,
    addCustomer,
    addCustomerQuick,
    findCustomerByName,
    findCustomerByPhone,
    findCustomerByReferralCode,
    updateCustomer,
    deleteCustomer,
    listCustomers,
    getCustomer,
    redeemReward,
    seed,
};
