/**
 * customersRepository.js
 * Tenant-scoped customers + referral bonus program.
 *
 * Every customer is stored under their salon and receives a unique referral
 * code. When a customer is added with a referral code, the code is validated
 * against the global registry (the referring salon is identified automatically)
 * and a Pending referral is created. The referral is marked Successful (and the
 * referrer credited) only when the referred customer books their first
 * appointment — see appointmentsRepository.maybeCreditReferralBonus. Duplicate
 * customers (same phone or exact name) within the salon are rejected before
 * anything is written. Self-referrals are rejected.
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { getDocument, updateDocument } from './db.js';
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
 * When `referralCode` is provided the code is validated, a Pending referral
 * is created, and the referrer will be credited when the new client books
 * their first appointment (see appointmentsRepository). Self-referrals are
 * rejected. Duplicate clients within the salon are rejected. Idempotent —
 * retrying the same referral never creates duplicate Pending referrals.
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

    // Register the new customer's referral code in the global registry.
    // Side-effect: a failure here must not block customer creation.
    try {
        await referralCodesRepository.registerReferralCode(
            referralCodesRepository.customerCodeEntry(ownCode, created, created.salonId),
        );
    } catch (err) {
        console.warn('[REFERRAL] Failed to register referral code for', created.id, err);
    }

    // Create a Pending referral (completed on first appointment).
    // Side-effect: a failure here must not block customer creation.
    if (referring && referring.kind === 'customer' && referring.customerId) {
        if (referring.customerId === created.id) {
            console.warn('[REFERRAL] Self-referral rejected for customer:', created.id);
        } else {
            try {
                await referralsRepository.createReferral({
                    code: referralCodesRepository.normalizeCode(code),
                    referringSalonId: referring.salonId,
                    referringCustomerId: referring.customerId,
                    referringCustomerName: referring.customerName,
                    referredSalonId: created.salonId,
                    referredCustomerId: created.id,
                    referredCustomerName: created.name,
                    referredCustomerPhone: created.phone,
                });
                // Ensure the Referral Program card shows the new Pending entry.
                referralsRepository.forceRefreshReferrals().catch(() => {});
            } catch (err) {
                console.warn('[REFERRAL] Failed to create referral for', created.id, err);
            }
        }
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
    // Side-effect: a failure here must not block customer creation.
    try {
        await referralCodesRepository.registerReferralCode(
            referralCodesRepository.customerCodeEntry(ownCode, created, created.salonId),
        );
    } catch (err) {
        console.warn('[REFERRAL] Failed to register referral code for quick-add', created.id, err);
    }
    return created;
}

/** Get a customer row by id. */
export function getCustomer(id) {
    return listCustomers().find((c) => c.id === id) || null;
}

/**
 * Fetch a customer by id from a specific salon, bypassing the current salon
 * scope. Used for cross-salon referral lookups (e.g. crediting a referrer who
 * belongs to a different salon). In demo mode searches the full store; in
 * Firebase mode reads directly from Firestore.
 */
export async function getCustomerFromSalon(customerId, salonId) {
    if (!customerId || !salonId) return null;
    if (isDemoMode()) {
        return (store.getState().customersList || []).find(
            (c) => c.id === customerId && c.salonId === salonId,
        ) || null;
    }
    return getDocument(['salons', salonId, 'customers'], customerId);
}

/**
 * Update a customer in a specific salon. Used for cross-salon operations like
 * crediting a referrer's points when the referrer belongs to a different salon.
 *
 * In Firebase mode, writes to Firestore first (so the write can fail safely),
 * then applies an optimistic local store update so the UI reflects the change
 * immediately — the Firestore onSnapshot listener will later confirm it.
 */
export async function updateCustomerInSalon(customerId, salonId, patch) {
    if (!customerId || !salonId) return null;
    if (isDemoMode()) {
        const list = store.getState().customersList || [];
        store.setState({
            customersList: list.map((c) =>
                c.id === customerId && c.salonId === salonId ? { ...c, ...patch } : c,
            ),
        });
        return { id: customerId, ...patch };
    }
    // Write to Firestore first — if this fails, no local mutation happens.
    const result = await updateDocument(['salons', salonId, 'customers'], customerId, patch);
    // Optimistic local update for instant UI feedback before the listener syncs.
    const list = store.getState().customersList || [];
    store.setState({
        customersList: list.map((c) =>
            c.id === customerId && c.salonId === salonId ? { ...c, ...patch } : c,
        ),
    });
    return result;
}

/** Stable referral code for a customer (fallback derived from id). */
export function getReferralCode(customer) {
    if (!customer) return '';
    if (customer.referralCode) return customer.referralCode;
    const stable = referralCodeFor(customer);
    // Persist the code so it stays identical across devices/sessions.
    repo.update(customer.id, { referralCode: stable }).catch(() => {});
    // Register in the global registry so the code can be looked up for referrals.
    if (customer.salonId) {
        referralCodesRepository.registerReferralCode(
            referralCodesRepository.customerCodeEntry(stable, customer, customer.salonId),
        ).catch(() => {});
    }
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
    updateCustomerInSalon,
    deleteCustomer,
    listCustomers,
    getCustomer,
    getCustomerFromSalon,
    getReferralCode,
    redeemReward,
    seed,
};