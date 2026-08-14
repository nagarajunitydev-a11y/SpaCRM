/**
 * customersRepository.js
 * Tenant-scoped customers + referral bonus program.
 *
 * Every customer is stored under their salon and receives a unique referral
 * code. When a customer is added with a referral code, the code is validated
 * against the global registry (the referring salon is identified automatically)
 * and a Pending referral is created. Duplicate customers (same phone or exact
 * name) within the salon are rejected before anything is written.
 */

import { createScopedRepository } from './scopedRepository.js';
import {
    REFERRAL_SIGNUP_BONUS,
    referralCodeFor,
} from '../core/rewards.js';
import * as referralCodesRepository from './referralCodesRepository.js';
import * as referralsRepository from './referralsRepository.js';

export const seed = [
    { id: 'c1', salonId: 'salon_luxe_01', name: 'Olivia Wilde', phone: '+1 555-0143', email: 'olivia@example.com', referralPoints: 150, referralCode: 'LG-OLIVIA' },
    { id: 'c2', salonId: 'salon_luxe_01', name: 'Jessica Alba', phone: '+1 555-0199', email: 'jessica@example.com', referralPoints: 220, referralCode: 'LG-JESSIC', referredByCode: 'LG-OLIVIA', referringSalonId: 'salon_luxe_01', referringCustomerId: 'c1', referringCustomerName: 'Olivia Wilde' },
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
 * Add a client, awarding the signup bonus points and a unique referral code.
 * When `referralCode` is provided it must resolve in the global registry; the
 * referring salon/customer is captured automatically. A Pending referral is
 * created against the referred customer. Invalid or unknown codes are rejected
 * and nothing is saved. Duplicate clients within the salon are rejected.
 */
export async function addCustomer(payload) {
    const existing = findCustomerByPhone(payload.phone) || findCustomerByName(payload.name);
    if (existing) {
        throw new Error(`A client already exists in this salon (${existing.name}${existing.phone ? `, ${existing.phone}` : ''}).`);
    }

    const code = (payload.referralCode || '').trim();
    const referring = code
        ? await referralCodesRepository.lookupReferralCode(code)
        : null;
    if (code && !referring) {
        throw new Error('Invalid referral code. Check the code and try again.');
    }

    const ownCode = await referralCodesRepository.generateUniqueCode('LG');
    const row = {
        ...payload,
        referralPoints: REFERRAL_SIGNUP_BONUS,
        referralCode: ownCode,
    };
    if (referring) {
        row.referredByCode = referralCodesRepository.normalizeCode(code);
        row.referringSalonId = referring.salonId;
        row.referringCustomerId = referring.kind === 'customer' ? referring.customerId : null;
        row.referringCustomerName = referring.customerName;
    }

    const created = await repo.add(row);
    await referralCodesRepository.registerReferralCode(
        referralCodesRepository.customerCodeEntry(ownCode, created, created.salonId),
    );

    if (referring) {
        await referralsRepository.createReferral({
            code: referralCodesRepository.normalizeCode(code),
            referringSalonId: referring.salonId,
            referringCustomerId: referring.kind === 'customer' ? referring.customerId : null,
            referringCustomerName: referring.customerName,
            referredSalonId: created.salonId,
            referredCustomerId: created.id,
            referredCustomerName: created.name,
            referredCustomerPhone: created.phone,
        });
    }

    return created;
}

/**
 * Quick-add from the appointment picker. Returns the existing client when one
 * matches (name/phone), otherwise creates one — never duplicates. No referral
 * code is processed here.
 */
export async function addCustomerQuick(payload) {
    const existing = findCustomerByName(payload.name) || findCustomerByPhone(payload.phone);
    if (existing) return existing;
    const ownCode = await referralCodesRepository.generateUniqueCode('LG');
    const created = await repo.add(
        {
            ...payload,
            referralPoints: REFERRAL_SIGNUP_BONUS,
            referralCode: ownCode,
        },
        { skipValidation: true },
    );
    await referralCodesRepository.registerReferralCode(
        referralCodesRepository.customerCodeEntry(ownCode, created, created.salonId),
    );
    return created;
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

/** Delete a customer and unregister their referral code from the registry. */
export async function deleteCustomer(id) {
    const customer = getCustomer(id);
    if (customer && customer.referralCode) {
        await referralCodesRepository.unregisterReferralCode(customer.referralCode).catch(() => {});
    }
    return repo.remove(id);
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