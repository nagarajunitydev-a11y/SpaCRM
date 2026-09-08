/**
 * customersRepository.js
 * Tenant-scoped customers with reward points and a referral wallet. This is the
 * SINGLE customer/contact source for the whole app — the Quick Billing / walk-in
 * flow, the Customers list, the appointment picker and the referral programme all
 * read and write through this repository, never a separate local contact store.
 *
 * Every customer is stored under their salon and receives signup bonus
 * points when created. Duplicate customers (same phone or exact name)
 * within the salon are rejected before anything is written.
 *
 * Phone numbers are normalised consistently everywhere: input is reduced to
 * its 10 national digits, and saved records always store the full E.164
 * `+91XXXXXXXXXX` form, so a bare 10-digit search matches whatever form a
 * record was saved under.
 *
 * Two independent balances live on a client record and are never mixed:
 *   `rewardPoints`  - the loyalty scheme, measured in points;
 *   `walletBalance` - the referral wallet, measured in rupees, moved only by
 *                     referralService.js inside an atomic transaction.
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { createScopedRepository } from './scopedRepository.js';
import { normalizePhoneDigits, toIndianE164, isBlank } from '../core/validate.js';

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

/**
 * True once the salon's customer list has loaded (Firebase snapshot delivered,
 * or demo/local data). Callers must await {@link ensureCustomersLoaded} before
 * deciding a number is NEW — otherwise a lookup raced against the still-empty
 * pre-first-snapshot list would fabricate duplicates.
 */
export const isCustomersLoaded = repo.isLoaded;
export const ensureCustomersLoaded = repo.ensureLoaded;

/** Find a client in the current salon by exact name (case-insensitive). */
export function findCustomerByName(name) {
    const q = (name || '').trim().toLowerCase();
    if (!q) return null;
    return listCustomers().find((c) => (c.name || '').trim().toLowerCase() === q) || null;
}

/**
 * Find a client in the current salon by phone (format-insensitive). The bare
 * 10-digit search key matches records stored as E.164 +91XXXXXXXXXX, with a
 * leading +91, or as plain national digits.
 */
export function findCustomerByPhone(phone) {
    const q = normalizePhoneDigits(phone);
    if (!q) return null;
    return listCustomers().find((c) => normalizePhoneDigits(c.phone) === q) || null;
}

/**
 * Prefix-search customers by phone for the live type-ahead dropdown. Reuses
 * the SAME tenant-scoped repository list as everywhere else — normalised to
 * the 10 national digits, so `+91…` records match a bare typed prefix the same
 * way the exact lookup matches a full number. Exact-length records sort first,
 * capped at `limit` matches.
 */
export function searchCustomersByPhone(phonePrefix, limit = 6) {
    const q = normalizePhoneDigits(phonePrefix);
    if (!q) return [];
    return listCustomers()
        .map((c) => ({ c, national: normalizePhoneDigits(c.phone) }))
        .filter(({ national }) => national && national.startsWith(q))
        .sort((a, b) => a.national.length - b.national.length)
        .slice(0, limit)
        .map(({ c }) => c);
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
 * Quick-add from the appointment picker / walk-in billing. Returns the existing
 * client when one matches, otherwise creates one — never duplicates.
 *
 * When a phone number is present it is the identity key: the client is matched
 * by phone only, so a number that is not on file can never be silently linked
 * to a different client that merely shares the typed name. Without a phone
 * (e.g. a name-only quick-add from the appointment picker) matching falls back
 * to the exact name. New records always store the E.164 phone form so every
 * future search — from Quick Billing or the Customers list — resolves to the
 * same digits.
 */
export async function addCustomerQuick(payload) {
    const existing = isBlank(payload.phone)
        ? findCustomerByName(payload.name)
        : findCustomerByPhone(payload.phone);
    if (existing) return existing;
    return repo.add(
        {
            ...payload,
            phone: toIndianE164(payload.phone),
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
    searchCustomersByPhone,
    findCustomerByReferralCode,
    updateCustomer,
    deleteCustomer,
    listCustomers,
    getCustomer,
    redeemReward,
    isCustomersLoaded,
    ensureCustomersLoaded,
    seed,
};
