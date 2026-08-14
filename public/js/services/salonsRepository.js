/**
 * salonsRepository.js
 * Global salons collection (super admin sees all; owners see their own).
 *
 * Every salon carries a unique referral code (`SLN-XXXXXX`) registered in the
 * global referral-code registry, so friends can be referred with the salon's
 * code as well as a customer's.
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { listenCollection, addDocument, updateDocument } from './db.js';
import { makeId } from '../core/utils.js';
import { validateForm } from '../core/validate.js';
import * as referralCodesRepository from './referralCodesRepository.js';

export const seed = [
    { id: 'salon_luxe_01', name: 'Luxe Glow Flagship', ownerEmail: 'owner@luxeglow.com', phone: '+1 (555) 382-9100', address: '450 Regent Street, Beverly Hills', referralCode: 'SLN-LUXE01' },
    { id: 'salon_soho_02', name: 'Luxe Glow SoHo', ownerEmail: 'soho@luxeglow.com', phone: '+1 (555) 492-8111', address: '78 Mercer St, New York', referralCode: 'SLN-SOHO02' },
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
    // Guests are not allowed to read salons (rules); never open a listener
    // before a real user is signed in (avoids "Missing or insufficient
    // permissions." noise for anonymous browsers).
    if (!state.currentUser) return;
    const opts = {};
    // Owners see only their own salons; admins (accountRole) see the network.
    if (state.accountRole === 'salon_owner' && state.currentUser) {
        opts.where = [['ownerId', '==', state.currentUser.uid]];
    }
    const scopeKey = opts.where ? opts.where[0][2] : 'all';
    if (scopeKey !== subscribedFor && state.salonsLoaded) {
        // The subscription scope changed (e.g. owner-filtered → all-salons once
        // the admin's profile reconciles). Mark the list as loading again so a
        // stale owner-filtered result is never mistaken for an empty admin list.
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

/** Backfill a unique referral code for any salon that does not have one. */
const ensuredThisSession = new Set();

export async function ensureSalonReferralCode() {
    const salons = store.getState().salonsList || [];
    for (const salon of salons) {
        if (salon.referralCode || ensuredThisSession.has(salon.id)) continue;
        const code = await referralCodesRepository.generateUniqueCode('SLN');
        await updateSalon(salon.id, { referralCode: code });
        await referralCodesRepository.registerReferralCode(
            referralCodesRepository.salonCodeEntry(code, { ...salon, referralCode: code }),
        );
        ensuredThisSession.add(salon.id);
    }
}

export async function addSalon(payload) {
    // Reject invalid salon data before touching local state or Firestore.
    const errors = validateForm('submit-salon', payload);
    if (Object.keys(errors).length > 0) {
        throw new Error(errors[Object.keys(errors)[0]]);
    }
    const state = store.getState();
    if (isDemoMode()) {
        const row = { id: makeId('salon'), ...payload, referralCode: await referralCodesRepository.generateUniqueCode('SLN') };
        store.setState({ salonsList: [...store.getState().salonsList, row] });
        await referralCodesRepository.registerReferralCode(referralCodesRepository.salonCodeEntry(row.referralCode, row));
        return row;
    }
    // Super admins provision branches that are not yet owned; regular owners
    // create salons they own.
    const ownerId = state.accountRole === 'super_admin'
        ? ''
        : state.currentUser ? state.currentUser.uid : '';
    const code = await referralCodesRepository.generateUniqueCode('SLN');
    const row = await addDocument(['salons'], {
        ...payload,
        ownerId,
        referralCode: code,
        createdAt: new Date().toISOString(),
    });
    await referralCodesRepository.registerReferralCode(referralCodesRepository.salonCodeEntry(code, row));
    return row;
}

export default {
    initSalons,
    resubscribeSalons,
    addSalon,
    updateSalon,
    ensureSalonReferralCode,
    seed,
};