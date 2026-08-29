/**
 * salonsRepository.js
 * Global salons collection (super admin sees all; owners see their own).
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { listenCollection, addDocument, updateDocument } from './db.js';
import { makeId } from '../core/utils.js';
import { validateForm } from '../core/validate.js';

export const seed = [
    { id: 'salon_luxe_01', name: 'Luxe Glow Flagship', ownerEmail: 'owner@luxeglow.com', phone: '+1 (555) 382-9100', address: '450 Regent Street, Beverly Hills' },
    { id: 'salon_soho_02', name: 'Luxe Glow SoHo', ownerEmail: 'soho@luxeglow.com', phone: '+1 (555) 492-8111', address: '78 Mercer St, New York' },
];

let unsub = null;
let subscribedFor = null; // scope (ownerId or 'all') of the active listener
let subscribing = false;  // guards re-entrant store-triggered subscribes

function subscribe() {
    if (subscribing) return;
    if (isDemoMode()) return;
    const state = store.getState();

    if (!state.currentUser) {
        if (unsub) {
            unsub();
            unsub = null;
        }
        subscribedFor = null;
        return;
    }

    const opts = {};
    if (state.accountRole === 'salon_owner' && state.currentUser) {
        opts.where = [['ownerId', '==', state.currentUser.uid]];
    }
    const scopeKey = opts.where ? opts.where[0][2] : 'all';

    // Never tear down and recreate the SAME Firestore watch target: this
    // function is called from resolveSalonScope() on nearly every store
    // update (including the update the listener's OWN first snapshot
    // triggers via `salonsLoaded: true`). Without this guard, every one of
    // those calls unsubscribed and immediately resubscribed the identical
    // listener — a rapid subscribe/unsubscribe/resubscribe churn on the same
    // watch target that is a known trigger for the Firestore SDK's internal
    // "INTERNAL ASSERTION FAILED: Unexpected state" (WatchChangeAggregator /
    // TargetState) crash. Only a genuine scope change (a different owner uid,
    // or switching to/from the admin's unfiltered view) may resubscribe.
    if (scopeKey === subscribedFor && unsub) return;

    if (unsub) {
        unsub();
        unsub = null;
    }
    if (state.salonsLoaded) {
        subscribing = true;
        store.setState({ salonsList: [], salonsLoaded: false, salonsError: null });
        subscribing = false;
    }
    subscribedFor = scopeKey;
    unsub = listenCollection(
        ['salons'],
        (rows) => store.setState({ salonsList: rows, salonsLoaded: true, salonsError: null }),
        (err) => store.setState({
            salonsList: [],
            salonsLoaded: true,
            salonsError: err && err.message ? err.message : 'Failed to load salons.',
        }),
        opts,
    );
}

export function initSalons() {
    if (isDemoMode()) {
        store.setState({ salonsList: [...seed], salonsLoaded: true });
        return;
    }
    subscribe();
}

/** Re-evaluate the salons subscription (call on auth / role changes). */
export function resubscribeSalons() {
    if (isDemoMode()) return;
    subscribe();
}

/** Update a salon document (demo state or Firestore). */
export async function updateSalon(id, patch) {
    if (isDemoMode()) {
        const row = (store.getState().salonsList || []).find((s) => s.id === id);
        const merged = { ...row, ...patch };
        store.setState({ salonsList: (store.getState().salonsList || []).map((s) => (s.id === id ? merged : s)) });
        return merged;
    }
    await updateDocument(['salons'], id, patch);
    return { id, ...patch };
}

export async function addSalon(payload) {
    const errors = validateForm('submit-salon', payload);
    if (Object.keys(errors).length > 0) {
        throw new Error(errors[Object.keys(errors)[0]]);
    }
    const state = store.getState();
    if (isDemoMode()) {
        const row = { id: makeId('salon'), ...payload };
        store.setState({ salonsList: [...store.getState().salonsList, row] });
        return row;
    }
    if (!state.currentUser || !state.currentUser.uid) {
        throw new Error('You must be signed in to create a salon branch.');
    }
    const ownerId = state.accountRole === 'super_admin'
        ? state.currentUser.uid
        : state.currentUser.uid;
    const row = await addDocument(['salons'], {
        ...payload,
        ownerId,
        createdAt: new Date().toISOString(),
    });
    return row;
}

export default {
    initSalons,
    resubscribeSalons,
    addSalon,
    updateSalon,
    seed,
};
