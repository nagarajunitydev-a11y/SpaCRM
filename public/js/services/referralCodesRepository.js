/**
 * referralCodesRepository.js
 * The per-salon referral-code registry: `salons/{salonId}/referralCodes/{CODE}`.
 *
 * The document id IS the code, so uniqueness is enforced by the database key
 * itself — two clients can never end up sharing a code even if two devices
 * register at the same instant. Allocation goes through `createIfAbsent`, an
 * atomic create-only transaction, and retries with a fresh code on collision.
 *
 * Codes are unique inside a salon (the tenancy boundary the whole app is built
 * on); a code entered at one salon is meaningless at another.
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { listenCollection, createIfAbsent, updateDocument } from './db.js';
import { generateReferralCode, normalizeCode, isValidCodeFormat } from '../core/referral.js';

export const COLLECTION = 'referralCodes';

let unsub = null;
let subscribedId = null;

/** Codes registered inside the active salon. */
export function listCodes() {
    return store.getState().referralCodesList || [];
}

function setCodes(rows) {
    const byId = new Map();
    (rows || []).forEach((row) => {
        if (row && row.id) byId.set(row.id, row);
    });
    store.setState({ referralCodesList: [...byId.values()] });
}

/** (Re)point the code registry at a salon. */
export function setSalon(salonId) {
    if (salonId === subscribedId && unsub) return;
    if (unsub) {
        unsub();
        unsub = null;
    }
    subscribedId = salonId;

    if (isDemoMode()) return;
    if (!salonId || !store.getState().currentUser) {
        setCodes([]);
        return;
    }
    unsub = listenCollection(
        ['salons', salonId, COLLECTION],
        (rows) => setCodes(rows),
        () => setCodes([]),
    );
}

/** Look up the registry row for a code (case/format insensitive). */
export function findByCode(code) {
    const key = normalizeCode(code);
    if (!key) return null;
    return listCodes().find((row) => normalizeCode(row.code || row.id) === key) || null;
}

/** The code already registered for a client, when there is one. */
export function findByCustomer(customerId) {
    if (!customerId) return null;
    return listCodes().find((row) => row.customerId === customerId) || null;
}

/**
 * Allocate a unique referral code for a client.
 *
 * Idempotent: a client that already has a code keeps it. The write is an
 * atomic create-only transaction on the code document, so a collision is
 * detected by the database (not by a read-then-write race) and simply retried
 * with a freshly generated code.
 */
export async function allocateCode(customer, salonIdOverride = null) {
    if (!customer || !customer.id) throw new Error('A client is required to allocate a referral code.');

    const existing = findByCustomer(customer.id);
    if (existing) return existing.code || existing.id;
    if (isValidCodeFormat(customer.referralCode)) return normalizeCode(customer.referralCode);

    const state = store.getState();
    const salonId = salonIdOverride || state.currentSalonId || customer.salonId || null;
    if (!isDemoMode()) {
        if (!salonId) {
            throw new Error('No salon selected. Cannot allocate a referral code.');
        }
        // Fail fast with an actionable message instead of letting a stale/
        // mismatched salon scope reach Firestore as an opaque permission-denied.
        // `salonsList` is always server-filtered to salons this account owns
        // (super admins are exempt — they can act on any salon).
        const owns = state.accountRole === 'super_admin'
            || (state.salonsList || []).some((s) => s.id === salonId);
        if (!owns) {
            throw new Error('You do not have access to this salon. Please reselect your salon and try again.');
        }
    }
    const taken = new Set(listCodes().map((row) => normalizeCode(row.code || row.id)));

    for (let attempt = 0; attempt < 8; attempt += 1) {
        const code = generateReferralCode(customer.name, taken);
        const row = {
            code,
            customerId: customer.id,
            customerName: customer.name || '',
            salonId,
            active: true,
            createdAt: new Date().toISOString(),
        };

        if (isDemoMode()) {
            if (taken.has(code)) continue;
            setCodes([...listCodes(), { id: code, ...row }]);
            return code;
        }

        const result = await createIfAbsent(['salons', salonId, COLLECTION], code, row);
        if (result && result.created) return code;
        // Lost the race for this code — remember it and try another.
        taken.add(code);
    }

    throw new Error('Could not allocate a unique referral code. Please try again.');
}

/** Deactivate a code (used when its owning client is deleted). */
export async function deactivateCodeFor(customerId) {
    const row = findByCustomer(customerId);
    if (!row) return null;
    const salonId = store.getState().currentSalonId;

    if (isDemoMode()) {
        setCodes(listCodes().map((c) => (c.id === row.id ? { ...c, active: false } : c)));
        return { id: row.id, active: false };
    }
    if (!salonId) return null;
    return updateDocument(['salons', salonId, COLLECTION], row.id, { active: false });
}

export default {
    COLLECTION,
    setSalon,
    listCodes,
    findByCode,
    findByCustomer,
    allocateCode,
    deactivateCodeFor,
};
