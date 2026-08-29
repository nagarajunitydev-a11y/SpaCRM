/**
 * rewardTransactionsRepository.js
 * Reward/points transaction ledger for audit and history.
 *
 * Every points movement (signup bonus, redemption) is logged
 * as an immutable transaction record. This provides a complete audit trail
 * and prevents duplicate rewards via idempotency checks.
 *
 * Transaction types:
 *   SIGNUP_BONUS     — 100 pts credited when a new client is created
 *   REDEMPTION       — points deducted when a client redeems a reward tier
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { listenCollection, setDocument, getDocument } from './db.js';

export const TX_TYPES = {
    SIGNUP_BONUS: 'SIGNUP_BONUS',
    REDEMPTION: 'REDEMPTION',
};

/** Demo seed — no transactions at start. */
export const seed = [];

let unsub = null;
let subscribedFor = null; // scope ('all' or salonId) of the active listener

/**
 * Subscribe to the global reward transactions ledger. Super admins see all;
 * salon owners see only their salon's clients' transactions.
 */
export function resubscribeTransactions() {
    const state = store.getState();

    if (isDemoMode()) {
        if (unsub) {
            unsub();
            unsub = null;
            subscribedFor = null;
        }
        if (!state.transactionsLoaded) {
            store.setState({ transactionsList: [...seed], transactionsLoaded: true, transactionsError: null });
        }
        return;
    }

    if (!state.currentUser) {
        if (unsub) {
            unsub();
            unsub = null;
            subscribedFor = null;
        }
        return;
    }

    const isAdmin = state.accountRole === 'super_admin';
    if (!isAdmin && !state.currentSalonId) {
        if (unsub) {
            unsub();
            unsub = null;
            subscribedFor = null;
        }
        store.setState({ transactionsList: [], transactionsLoaded: true });
        return;
    }

    const scopeKey = isAdmin ? 'all' : state.currentSalonId;
    // Never tear down and recreate the SAME listener: this is called from
    // resolveSalonScope() on every scope-key change, which fires several
    // times during a normal sign-in (salonsLoaded flipping, target salon
    // resolving); only a genuine scope change should touch the subscription.
    // Rapid subscribe/unsubscribe/resubscribe churn on the same Firestore
    // watch target is a known trigger for the SDK's internal
    // "INTERNAL ASSERTION FAILED: Unexpected state" crash.
    if (scopeKey === subscribedFor && unsub) return;

    if (unsub) {
        unsub();
        unsub = null;
    }
    subscribedFor = scopeKey;

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
 * Create a reward transaction record. Idempotent — returns the existing
 * transaction if one already exists for the given key.
 */
export async function createTransaction({ id, clientId, clientName, salonId, points, type, description }) {
    const now = new Date().toISOString();
    const row = {
        id,
        clientId,
        clientName: clientName || '',
        salonId: salonId || null,
        points,
        type,
        description,
        createdAt: now,
    };

    if (isDemoMode()) {
        const existing = store.getState().transactionsList || [];
        if (existing.some((tx) => tx.id === id)) {
            return existing.find((tx) => tx.id === id);
        }
        store.setState({ transactionsList: [...existing, row] });
        return row;
    }

    return setDocument(['rewardTransactions'], id, row);
}

export default {
    seed,
    TX_TYPES,
    resubscribeTransactions,
    createTransaction,
};
