/**
 * rewardTransactionsRepository.js
 * Reward/points transaction ledger for audit and history.
 *
 * Every points movement (signup bonus, referral bonus, redemption) is logged
 * as an immutable transaction record. This provides a complete audit trail
 * and prevents duplicate rewards via idempotency checks.
 *
 * Transaction types:
 *   SIGNUP_BONUS     — 100 pts credited when a new client is created
 *   REFERRAL_BONUS   — 100 pts credited to the referrer when their referred friend signs up
 *   REDEMPTION       — points deducted when a client redeems a reward tier
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { listenCollection, setDocument, getDocument } from './db.js';
import { REFERRAL_SIGNUP_BONUS, REFERRAL_BONUS_POINTS } from '../core/rewards.js';

export const TX_TYPES = {
    SIGNUP_BONUS: 'SIGNUP_BONUS',
    REFERRAL_BONUS: 'REFERRAL_BONUS',
    REDEMPTION: 'REDEMPTION',
};

/** Demo seed — no transactions at start. */
export const seed = [];

let unsub = null;

/**
 * Subscribe to the global reward transactions ledger. Super admins see all;
 * salon owners see only their salon's clients' transactions.
 */
export function resubscribeTransactions() {
    const state = store.getState();

    if (isDemoMode()) {
        if (!state.transactionsLoaded) {
            store.setState({ transactionsList: [...seed], transactionsLoaded: true, transactionsError: null });
        }
        return;
    }

    // Guests cannot read transactions.
    if (!state.currentUser) {
        if (unsub) { unsub(); unsub = null; }
        return;
    }

    // Owners see transactions scoped to their salon's clients.
    const isAdmin = state.accountRole === 'super_admin';
    if (!isAdmin && !state.currentSalonId) {
        store.setState({ transactionsList: [], transactionsLoaded: true });
        return;
    }

    const opts = isAdmin ? {} : { where: [['salonId', '==', state.currentSalonId]] };
    unsub = listenCollection(
        ['rewardTransactions'],
        (rows) => store.setState({ transactionsList: rows, transactionsLoaded: true, transactionsError: null }),
        (err) => store.setState({
            transactionsList: [],
            transactionsLoaded: true,
            transactionsError: err?.message || 'Failed to load transactions.',
        }),
        opts,
    );
}

/**
 * Deterministic idempotency key for referral bonuses:
 * `REFERRAL__<referralId>`. Prevents duplicate credits if the signup is
 * retried.
 */
export function referralTxKey(referralId) {
    return `REFERRAL__${referralId}`;
}

/**
 * Check if a referral bonus has already been credited.
 * Returns the existing transaction or null.
 *
 * Reads from the store first (fast); in Firebase mode, falls back to Firestore
 * when the realtime listener hasn't synced yet or the transaction is scoped to
 * a different salon than the current viewer's.
 */
export async function findReferralTransaction(referralId) {
    const key = referralTxKey(referralId);
    const list = store.getState().transactionsList || [];
    const fromStore = list.find((tx) => tx.id === key) || null;
    if (fromStore) return fromStore;
    if (isDemoMode()) return null;
    try {
        return await getDocument(['rewardTransactions'], key);
    } catch (err) {
        console.warn('[REFERRAL] Firestore fallback read for transaction', key, 'failed:', err);
        return null;
    }
}

/**
 * Create a reward transaction record. Idempotent — returns the existing
 * transaction if one already exists for the given key.
 */
export async function createTransaction({ id, clientId, clientName, salonId, referralId, points, type, description }) {
    const now = new Date().toISOString();
    const row = {
        id,
        clientId,
        clientName: clientName || '',
        salonId: salonId || null,
        referralId: referralId || null,
        points,
        type,
        description,
        createdAt: now,
    };

    if (isDemoMode()) {
        const existing = store.getState().transactionsList || [];
        // Idempotency: skip if already recorded.
        if (existing.some((tx) => tx.id === id)) {
            return existing.find((tx) => tx.id === id);
        }
        store.setState({ transactionsList: [...existing, row] });
        return row;
    }

    // Firestore setDocument is idempotent (overwrite by id).
    return setDocument(['rewardTransactions'], id, row);
}

/**
 * Record a referral bonus transaction. Idempotent — if already credited
 * for this referral, returns the existing transaction without creating a
 * duplicate.
 */
export async function recordReferralBonus({ referralId, referrerId, referrerName, salonId }) {
    const key = referralTxKey(referralId);
    const existing = await findReferralTransaction(referralId);
    if (existing) return existing;

    return createTransaction({
        id: key,
        clientId: referrerId,
        clientName: referrerName,
        salonId,
        referralId,
        points: REFERRAL_BONUS_POINTS,
        type: TX_TYPES.REFERRAL_BONUS,
        description: `Referral bonus for successful client signup`,
    });
}

export default {
    seed,
    TX_TYPES,
    resubscribeTransactions,
    referralTxKey,
    findReferralTransaction,
    createTransaction,
    recordReferralBonus,
};
