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
    if (unsub) {
        unsub();
        unsub = null;
    }
    if (isDemoMode()) return;
    const state = store.getState();
    if (!state.currentUser) return;
    const opts = {};
    if (state.accountRole === 'salon_owner' && state.currentUser) {
        opts.where = [['ownerId', '==', state.currentUser.uid]];
    }
    const scopeKey = opts.where ? opts.where[0][2] : 'all';
    if (scopeKey !== subscribedFor && state.salonsLoaded) {
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
