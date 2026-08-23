/**
 * walletRepository.js
 * Immutable referral-wallet ledger: `salons/{salonId}/walletTransactions/{id}`.
 *
 * Every rupee that enters or leaves a client's referral wallet is recorded
 * here with the balance before, the amount and the balance after. Rows are
 * append-only — the security rules deny update and delete — so the history is
 * a genuine audit trail.
 *
 * This module is read-only on purpose. Ledger rows are written exclusively by
 * referralService.js, inside the same atomic transaction that moves the
 * referral and the client's balance, so a posting can never exist without the
 * state change it describes (or the other way round).
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { listenCollection } from './db.js';

export const COLLECTION = 'walletTransactions';

let unsub = null;
let subscribedId = null;

/** Wallet ledger rows for the active salon. */
export function listTransactions() {
    return store.getState().walletTransactionsList || [];
}

function setTransactions(rows) {
    const byId = new Map();
    (rows || []).forEach((row) => {
        if (row && row.id) byId.set(row.id, row);
    });
    store.setState({ walletTransactionsList: [...byId.values()] });
}

/** (Re)point the ledger listener at a salon. */
export function setSalon(salonId) {
    if (salonId === subscribedId && unsub) return;
    if (unsub) {
        unsub();
        unsub = null;
    }
    subscribedId = salonId;

    if (isDemoMode()) return;
    if (!salonId || !store.getState().currentUser) {
        setTransactions([]);
        return;
    }
    unsub = listenCollection(
        ['salons', salonId, COLLECTION],
        (rows) => setTransactions(rows),
        () => setTransactions([]),
    );
}

/** A client's ledger, newest first. */
export function listForCustomer(customerId) {
    if (!customerId) return [];
    return listTransactions()
        .filter((tx) => tx.customerId === customerId)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export default {
    COLLECTION,
    setSalon,
    listTransactions,
    listForCustomer,
};
