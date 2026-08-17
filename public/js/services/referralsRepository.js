/**
 * referralsRepository.js
 * Global referrals ledger.
 *
 * A referral is created when a new customer is added with a valid referral
 * code. Its status moves Pending → Successful (the referred customer completes
 * their first appointment) → Bonus Credited (the bonus points are credited to
 * the referred customer). Salon owners may reject a pending referral. Status
 * transitions and the bonus amount are enforced by Firestore rules — clients
 * can never fabricate a Successful/credited state or a bonus amount.
 *
 * NOTE: this module deliberately does NOT import customersRepository (a bonus
 * credit updates the referred customer's points, which would create an import
 * cycle). That flow lives in appointmentsRepository instead.
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { listenCollection, setDocument, updateDocument, getDocument, getCollection } from './db.js';
import { normalizeCode } from './referralCodesRepository.js';
import { REFERRAL_BONUS_POINTS } from '../core/rewards.js';

/** Demo ledger (seeded so the program overview renders without a backend). */
export const seed = [
    {
        id: 'LG-OLIVIA__c2',
        code: 'LG-OLIVIA',
        referringSalonId: 'salon_luxe_01',
        referringCustomerId: 'c1',
        referringCustomerName: 'Olivia Wilde',
        referredSalonId: 'salon_luxe_01',
        referredCustomerId: 'c2',
        referredCustomerName: 'Jessica Alba',
        referredCustomerPhone: '+1 555-0199',
        status: 'Bonus Credited',
        bonusAmount: REFERRAL_BONUS_POINTS,
        createdAt: '2026-06-01T10:00:00.000Z',
        firstAppointmentAt: '2026-06-10T10:00:00.000Z',
        bonusCreditedAt: '2026-06-10T10:00:00.000Z',
    },
];

const STATUS_ORDER = {
    'Bonus Credited': 0,
    Successful: 1,
    Pending: 2,
    Rejected: 3,
};

function sortReferrals(rows) {
    return (rows || []).slice().sort((a, b) => {
        const order = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
        if (order !== 0) return order;
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
}

let unsub = null;
let subscribedScope = null;

/**
 * Keep the referral ledger in sync with the current viewer. Super admins see
 * every referral; salon owners only their own salon's (referredSalonId == the
 * active salon). No listener is opened until a real user is signed in.
 */
export function resubscribeReferrals() {
    const state = store.getState();

    if (isDemoMode()) {
        // Demo ledger is append-only for the session; never reset over writes.
        if (!store.getState().referralsLoaded) {
            store.setState({ referralsList: sortReferrals(seed), referralsLoaded: true, referralsError: null });
        }
        return;
    }

    // Guests are not allowed to read referrals (rules); never open a listener
    // before a real user is signed in.
    if (!state.currentUser) {
        if (unsub) {
            unsub();
            unsub = null;
        }
        subscribedScope = null;
        return;
    }

    const isAdmin = state.accountRole === 'super_admin';
    const scopeKey = isAdmin ? 'all' : `owner:${state.currentSalonId || ''}`;

    if (scopeKey === subscribedScope) return;

    if (unsub) {
        unsub();
        unsub = null;
    }
    subscribedScope = scopeKey;
    store.setState({ referralsList: [], referralsLoaded: false, referralsError: null });

    // Owners without a resolved salon have no referrals to show yet.
    if (!isAdmin && !state.currentSalonId) {
        store.setState({ referralsList: [], referralsLoaded: true });
        return;
    }

    const opts = isAdmin ? {} : { where: [['referredSalonId', '==', state.currentSalonId]] };
    unsub = listenCollection(
        ['referrals'],
        (rows) => store.setState({ referralsList: sortReferrals(rows), referralsLoaded: true, referralsError: null }),
        (err) => store.setState({
            referralsList: [],
            referralsLoaded: true,
            referralsError: err && err.message ? err.message : 'Failed to load referrals.',
        }),
        opts,
    );
}

/** Deterministic id for a referral: `<code>__<referredCustomerId>`. */
export function referralIdFor(code, referredCustomerId) {
    return `${normalizeCode(code)}__${referredCustomerId}`;
}

/**
 * Find a referral for a code + referred customer (by deterministic id).
 * Reads from the local store first (fast); falls back to Firestore when the
 * realtime listener hasn't synced yet (e.g. referral created moments before
 * the first appointment was booked).
 */
export async function findReferral(code, referredCustomerId) {
    const id = referralIdFor(code, referredCustomerId);
    const fromStore = (store.getState().referralsList || []).find((r) => r.id === id) || null;
    if (fromStore) return fromStore;
    if (isDemoMode()) return null;
    try {
        return await getDocument(['referrals'], id);
    } catch (err) {
        console.warn('[REFERRAL] Firestore fallback read failed for', id, err);
        return null;
    }
}

/**
 * Create a Pending referral. The id is deterministic (code + referred
 * customer), so a duplicate add can never produce a second record.
 */
export async function createReferral(data) {
    const id = referralIdFor(data.code, data.referredCustomerId);
    const now = new Date().toISOString();
    const row = {
        id,
        code: normalizeCode(data.code),
        referringSalonId: data.referringSalonId,
        referringCustomerId: data.referringCustomerId || null,
        referringCustomerName: data.referringCustomerName || '',
        referredSalonId: data.referredSalonId,
        referredCustomerId: data.referredCustomerId,
        referredCustomerName: data.referredCustomerName,
        referredCustomerPhone: data.referredCustomerPhone || '',
        status: 'Pending',
        bonusAmount: REFERRAL_BONUS_POINTS,
        createdAt: now,
        updatedAt: now,
    };
    if (isDemoMode()) {
        const existing = store.getState().referralsList || [];
        if (!existing.some((r) => r.id === id)) {
            store.setState({ referralsList: sortReferrals([...existing, row]) });
        }
        return row;
    }
    return setDocument(['referrals'], id, row);
}

/** Apply a status transition and mirror it into the store (demo) or Firestore. */
async function applyStatus(referral, updated) {
    const merged = { ...(referral || {}), ...updated };
    if (referral && referral.id) {
        if (isDemoMode()) {
            store.setState({
                referralsList: sortReferrals(
                    (store.getState().referralsList || []).map((r) => (r.id === referral.id ? merged : r)),
                ),
            });
        } else {
            await updateDocument(['referrals'], referral.id, updated);
        }
    }
    return merged;
}

/** Mark a referral Successful after the referred customer's first appointment. */
export async function markReferralSuccessful(referral, appointmentId) {
    if (!referral || referral.status !== 'Pending') return referral;
    return applyStatus(referral, {
        status: 'Successful',
        appointmentId,
        // Date object → Firestore Timestamp, satisfying the rules `is timestamp`.
        firstAppointmentAt: new Date(),
        updatedAt: new Date().toISOString(),
    });
}

/** Reject a pending referral (salon owner action). */
export async function rejectReferral(referral) {
    if (!referral || referral.status !== 'Pending') return referral;
    return applyStatus(referral, {
        status: 'Rejected',
        updatedAt: new Date().toISOString(),
    });
}

/** Mark a Successful referral as Bonus Credited after points are awarded. */
export async function completeReferral(referral) {
    if (!referral || referral.status !== 'Successful') return referral;
    return applyStatus(referral, {
        status: 'Bonus Credited',
        bonusCreditedAt: new Date(),
        updatedAt: new Date().toISOString(),
    });
}

/**
 * One-shot Firestore fetch that refreshes the referrals store.
 * Called after referral writes as a safety net in case the onSnapshot
 * listener hasn't fired yet or the salonId filter caused a stale snapshot.
 * In demo mode, this is a no-op (the listener-driven store is already current).
 */
export async function forceRefreshReferrals() {
    if (isDemoMode()) return;
    const state = store.getState();
    const isAdmin = state.accountRole === 'super_admin';
    const salonId = state.currentSalonId;
    if (!isAdmin && !salonId) return;
    try {
        const opts = isAdmin ? {} : { where: [['referredSalonId', '==', salonId]] };
        const rows = await getCollection(['referrals'], opts);
        const sorted = sortReferrals(rows);
        store.setState({ referralsList: sorted, referralsLoaded: true, referralsError: null });
        console.log('[REFERRAL] forceRefreshReferrals: Total', rows.length,
            '| Pending', rows.filter((r) => r.status === 'Pending').length,
            '| Done', rows.filter((r) => r.status === 'Successful' || r.status === 'Bonus Credited').length,
            '| Earned', rows.filter((r) => r.status === 'Bonus Credited').reduce((s, r) => s + (Number(r.bonusAmount) || 0), 0));
    } catch (err) {
        console.warn('[REFERRAL] forceRefreshReferrals failed:', err);
    }
}

export default {
    seed,
    resubscribeReferrals,
    forceRefreshReferrals,
    referralIdFor,
    findReferral,
    createReferral,
    markReferralSuccessful,
    rejectReferral,
    completeReferral,
};