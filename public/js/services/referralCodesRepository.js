/**
 * referralCodesRepository.js
 * Global referral-code registry.
 *
 * Every salon and every customer has a unique referral code. Codes live in a
 * top-level `referralCodes` collection (document id = the code) so any salon
 * can validate a friend's code against the correct salon before a customer is
 * created. In demo mode the registry is an in-memory Map so the app remains
 * fully functional without a backend.
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { getDocument, setDocument, deleteDocument } from './db.js';
import { generateReferralCode } from '../core/rewards.js';

/** Strip anything that is not a code character and normalise to uppercase. */
export function normalizeCode(code) {
    return String(code || '').trim().replace(/[^A-Za-z0-9-]/g, '').toUpperCase();
}

/** In-memory registry (demo mode) mirroring the Firestore collection. */
const demoRegistry = new Map();

function localSet(code, entry) {
    demoRegistry.set(code, { ...entry });
}

function localDelete(code) {
    demoRegistry.delete(code);
}

function localGet(code) {
    return demoRegistry.get(code) || null;
}

/** True when a code is already registered anywhere (local or Firestore). */
export async function isCodeTaken(code) {
    if (!code) return false;
    if (isDemoMode()) return demoRegistry.has(code);
    return !!(await getDocument(['referralCodes'], code));
}

/**
 * Register a code. `entry` is `{ code, salonId, kind, customerId,
 * customerName, createdAt }` — kind is 'salon' or 'customer'. Salon owners may
 * only register codes for salons they own (enforced again by Firestore rules).
 */
export async function registerReferralCode(entry) {
    const code = normalizeCode(entry && entry.code);
    if (!code) return null;
    const row = { code, ...entry, createdAt: entry.createdAt || new Date().toISOString() };
    if (isDemoMode()) {
        localSet(code, row);
        return row;
    }
    return setDocument(['referralCodes'], code, row);
}

/** Remove a code from the registry. */
export async function unregisterReferralCode(code) {
    const normalized = normalizeCode(code);
    if (!normalized) return null;
    if (isDemoMode()) {
        localDelete(normalized);
        return { id: normalized };
    }
    return deleteDocument(['referralCodes'], normalized);
}

/**
 * Resolve a code to its registry entry (`{ code, salonId, kind, customerId,
 * customerName, createdAt }`) or null when it is unknown.
 */
export async function lookupReferralCode(code) {
    const normalized = normalizeCode(code);
    if (!normalized) return null;
    if (isDemoMode()) return localGet(normalized);
    return getDocument(['referralCodes'], normalized);
}

/**
 * Generate a referral code that is not already registered anywhere.
 * `prefix` defaults to 'LG'; yields `PREFIX-XXXXXX`.
 */
export async function generateUniqueCode(prefix = 'LG') {
    for (let i = 0; i < 8; i += 1) {
        const candidate = generateReferralCode(prefix);
        if (!(await isCodeTaken(candidate))) return candidate;
    }
    // Extremely unlikely collision streak — fall back to a timestamp-suffixed code.
    const stamp = Date.now().toString(36).toUpperCase().slice(-6);
    return `${prefix}-${stamp}`;
}

/** Registry entry for a salon's own code. */
export function salonCodeEntry(code, salon) {
    return {
        code,
        salonId: salon.id,
        kind: 'salon',
        customerId: null,
        customerName: salon.name,
        createdAt: new Date().toISOString(),
    };
}

/** Registry entry for a customer's own code. */
export function customerCodeEntry(code, customer, salonId) {
    return {
        code,
        salonId,
        kind: 'customer',
        customerId: customer.id,
        customerName: customer.name,
        createdAt: new Date().toISOString(),
    };
}

/**
 * Seed the demo registry so seeded salons/customers codes resolve without a
 * backend. Idempotent — re-running just re-registers the same entries.
 */
export function seedDemoRegistry() {
    if (!isDemoMode()) return;
    (store.getState().salonsList || []).forEach((salon) => {
        if (salon.referralCode) localSet(salon.referralCode, salonCodeEntry(salon.referralCode, salon));
    });
    (store.getState().customersList || []).forEach((customer) => {
        if (customer.referralCode && customer.salonId) {
            localSet(customer.referralCode, customerCodeEntry(customer.referralCode, customer, customer.salonId));
        }
    });
}

export default {
    normalizeCode,
    isCodeTaken,
    registerReferralCode,
    unregisterReferralCode,
    lookupReferralCode,
    generateUniqueCode,
    salonCodeEntry,
    customerCodeEntry,
    seedDemoRegistry,
};