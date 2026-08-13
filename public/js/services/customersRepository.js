/**
 * customersRepository.js
 * Tenant-scoped customers + referral bonus program.
 */

import { createScopedRepository } from './scopedRepository.js';
import { generateReferralCode, referralCodeFor, REFERRAL_SIGNUP_BONUS } from '../core/rewards.js';

export const seed = [
    { id: 'c1', salonId: 'salon_luxe_01', name: 'Olivia Wilde', phone: '+1 555-0143', email: 'olivia@example.com', referralPoints: 150, referralCode: 'LG-OLIVIA' },
    { id: 'c2', salonId: 'salon_luxe_01', name: 'Jessica Alba', phone: '+1 555-0199', email: 'jessica@example.com', referralPoints: 220, referralCode: 'LG-JESSIC' },
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
export const deleteCustomer = repo.remove;

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
 * Add a client, awarding the signup bonus points and a referral code.
 * Duplicate clients (same phone or exact name) within the salon are rejected.
 */
export async function addCustomer(payload) {
    const existing = findCustomerByPhone(payload.phone) || findCustomerByName(payload.name);
    if (existing) {
        throw new Error(`A client already exists in this salon (${existing.name}${existing.phone ? `, ${existing.phone}` : ''}).`);
    }
    return repo.add({
        ...payload,
        referralPoints: REFERRAL_SIGNUP_BONUS,
        referralCode: generateReferralCode(),
    });
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
            referralPoints: REFERRAL_SIGNUP_BONUS,
            referralCode: generateReferralCode(),
        },
        { skipValidation: true },
    );
}

/** Get a customer row by id. */
export function getCustomer(id) {
    return listCustomers().find((c) => c.id === id) || null;
}

/** Stable referral code for a customer (fallback derived from id). */
export function getReferralCode(customer) {
    if (!customer) return '';
    if (customer.referralCode) return customer.referralCode;
    const stable = referralCodeFor(customer);
    // Persist the code so it stays identical across devices/sessions.
    repo.update(customer.id, { referralCode: stable }).catch(() => {});
    return stable;
}

/**
 * Redeem a reward tier. `tierPoints` is the cost in points; throws when the
 * customer cannot afford it (transaction-safe message for the UI).
 */
export async function redeemReward(customerId, tierPoints) {
    const pts = Number(getCustomer(customerId)?.referralPoints) || 0;
    if (pts < tierPoints) {
        throw new Error(`Need at least ${tierPoints} points for this reward.`);
    }
    return repo.update(customerId, { referralPoints: pts - tierPoints });
}

export default {
    initCustomers,
    setSalon,
    addCustomer,
    addCustomerQuick,
    findCustomerByName,
    findCustomerByPhone,
    updateCustomer,
    deleteCustomer,
    listCustomers,
    getCustomer,
    getReferralCode,
    redeemReward,
    seed,
};