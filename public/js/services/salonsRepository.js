/**
 * salonsRepository.js
 * Global salons collection (super admin sees all; owners see their own).
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { listenCollection, addDocument } from './db.js';
import { makeId } from '../core/utils.js';
import { validateForm } from '../core/validate.js';

export const seed = [
    { id: 'salon_luxe_01', name: 'Luxe Glow Flagship', ownerEmail: 'owner@luxeglow.com', phone: '+1 (555) 382-9100', address: '450 Regent Street, Beverly Hills' },
    { id: 'salon_soho_02', name: 'Luxe Glow SoHo', ownerEmail: 'soho@luxeglow.com', phone: '+1 (555) 492-8111', address: '78 Mercer St, New York' },
];

let unsub = null;

function subscribe() {
    if (unsub) {
        unsub();
        unsub = null;
    }
    if (isDemoMode()) return;
    const state = store.getState();
    // Guests are not allowed to read salons (rules); never open a listener
    // before a real user is signed in (avoids "Missing or insufficient
    // permissions." noise for anonymous browsers).
    if (!state.currentUser) return;
    const opts = {};
    // Owners see only their own salons; admins (accountRole) see the network.
    if (state.accountRole === 'salon_owner' && state.currentUser) {
        opts.where = [['ownerId', '==', state.currentUser.uid]];
    }
    unsub = listenCollection(
        ['salons'],
        (rows) => store.setState({ salonsList: rows, salonsLoaded: true }),
        () => store.setState({ salonsList: [], salonsLoaded: true }),
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

export async function addSalon(payload) {
    // Reject invalid salon data before touching local state or Firestore.
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
    // Super admins provision branches that are not yet owned; regular owners
    // create salons they own.
    const ownerId = state.accountRole === 'super_admin'
        ? ''
        : state.currentUser ? state.currentUser.uid : '';
    const row = await addDocument(['salons'], {
        ...payload,
        ownerId,
        createdAt: new Date().toISOString(),
    });
    return row;
}

export default { initSalons, resubscribeSalons, addSalon, seed };
