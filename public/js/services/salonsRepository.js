/**
 * salonsRepository.js
 * Global salons collection (super admin sees all; owners see their own).
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { listenCollection, addDocument, updateDocument } from './db.js';
import { makeId } from '../core/utils.js';
import { validateForm } from '../core/validate.js';
import { findDuplicateName, validateBranchHours } from '../core/branches.js';

export const seed = [
    { id: 'salon_luxe_01', name: 'Luxe Glow Flagship', ownerEmail: 'owner@luxeglow.com', phone: '+1 (555) 382-9100', address: '450 Regent Street, Beverly Hills', timezone: 'Asia/Kolkata', active: true },
    { id: 'salon_soho_02', name: 'Luxe Glow SoHo', ownerEmail: 'soho@luxeglow.com', phone: '+1 (555) 492-8111', address: '78 Mercer St, New York', timezone: 'America/New_York', active: true },
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

/**
 * Throw when `payload` would break a branch rule for this owner. Only runs for
 * payloads that carry branch fields (hours), so the legacy sign-up / super
 * admin provisioning paths are untouched.
 */
function assertBranchRules(payload, existing, excludeId = null) {
    if (payload.name !== undefined && findDuplicateName(existing, payload.name, excludeId)) {
        throw new Error('A branch with this name already exists.');
    }
    if (payload.openTime !== undefined || payload.closeTime !== undefined) {
        const hours = validateBranchHours(payload.openTime, payload.closeTime);
        const first = Object.values(hours)[0];
        if (first) throw new Error(first);
    }
}

/** Update a salon (branch) document (demo state or Firestore). */
export async function updateSalon(id, rawPatch) {
    const patch = { ...rawPatch };
    const state = store.getState();
    const list = state.salonsList || [];
    // Branch edits: the name must stay unique among the owner's branches.
    if (state.accountRole !== 'super_admin') assertBranchRules(patch, list, id);
    // Only a super admin may change the admin-controlled status.
    if (state.accountRole !== 'super_admin') delete patch.status;
    if (isDemoMode()) {
        const row = list.find((s) => s.id === id);
        const merged = { ...row, ...patch };
        store.setState({ salonsList: list.map((s) => (s.id === id ? merged : s)) });
        return merged;
    }
    await updateDocument(['salons'], id, patch);
    return { id, ...patch };
}

/** Activate / deactivate a branch. Data is never deleted. */
export async function setBranchActive(id, active) {
    return updateSalon(id, { active: active === true });
}

export async function addSalon(payload) {
    const errors = validateForm('submit-salon', payload);
    if (Object.keys(errors).length > 0) {
        throw new Error(errors[Object.keys(errors)[0]]);
    }
    const state = store.getState();
    const isAdmin = state.accountRole === 'super_admin';
    const existing = state.salonsList || [];
    if (!isAdmin) {
        // Subscription limit (central FeatureAccess) + unique name. The very
        // first branch is always allowed so sign-up can complete.
        if (existing.length > 0 && state.access) {
            const gate = state.access.canCreate('branch');
            if (!gate.ok) throw new Error(gate.reason);
        }
        assertBranchRules(payload, existing);
    }
    if (isDemoMode()) {
        const row = { id: makeId('salon'), active: true, ...payload };
        store.setState({ salonsList: [...store.getState().salonsList, row] });
        return row;
    }
    if (!state.currentUser || !state.currentUser.uid) {
        throw new Error('You must be signed in to create a salon branch.');
    }
    const ownerId = state.currentUser.uid;
    const row = await addDocument(['salons'], {
        ...payload,
        active: true,
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
    setBranchActive,
    seed,
};
