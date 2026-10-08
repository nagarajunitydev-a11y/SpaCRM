/**
 * scopedRepository.js
 * Factory for per-salon, tenant-scoped repositories (customers, services,
 * staff, appointments). Each repository exposes a small, consistent API and
 * transparently falls back to local store state in demo mode.
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { listenCollection, addDocument, updateDocument, deleteDocument } from './db.js';
import { validateForm } from '../core/validate.js';
import { makeId } from '../core/utils.js';

/** Form schema that guards each scoped collection (defense in depth). */
const COLLECTION_FORM_KEYS = {
    customers: 'submit-customer',
    services: 'submit-service',
    staff: 'submit-staff',
    appointments: 'submit-appointment',
    salons: 'submit-salon',
};

/**
 * Throw when a payload would create an invalid record. Runs immediately before
 * ANY write (state update or Firestore call), so even a non-form code path can
 * never persist an empty record. `opts.skipValidation` opts out for deliberate
 * relaxed flows (e.g. quick-add from the appointment picker).
 */
function assertValidAdd(collectionName, payload, opts = {}) {
    if (opts.skipValidation) return;
    const formKey = COLLECTION_FORM_KEYS[collectionName];
    if (!formKey) return;
    const errors = validateForm(formKey, payload);
    if (Object.keys(errors).length > 0) {
        throw new Error(errors[Object.keys(errors)[0]]);
    }
}

/**
 * Subscription gate (core/featureAccess.js via `state.access`). An expired or
 * suspended plan is read-only — nothing is ever deleted — and customers /
 * staff are capped by the plan. Absent in demo mode (access is unrestricted).
 */
const LIMITED_KINDS = { customers: 'customer', staff: 'staff' };
function assertSubscriptionAllows(collectionName, { creating }) {
    const access = store.getState().access;
    if (!access || access.unrestricted) return;
    if (access.locked) {
        throw new Error('Your subscription has expired — your data is safe and view-only. Upgrade to continue.');
    }
    const kind = LIMITED_KINDS[collectionName];
    if (creating && kind) {
        const gate = access.canCreate(kind);
        if (!gate.ok) throw new Error(gate.reason);
    }
}

export function createScopedRepository({ stateKey, collectionName, seed }) {
    let unsub = null;
    let salonId = null;
    let subscribedId = null;
    // True once the current salon's first snapshot has delivered (or the data
    // is local, e.g. demo mode). Until it flips, the list may be empty/stale,
    // so callers that decide to CREATE a record must first await ensureLoaded().
    let loaded = false;
    const loadWaiters = new Set();

    function settleLoaders() {
        if (loaded) return;
        loaded = true;
        loadWaiters.forEach((resolve) => resolve(true));
        loadWaiters.clear();
    }

    function data() {
        const rows = store.getState()[stateKey] || [];
        // Multi-salon guard: only expose records that belong to the currently
        // active salon. Legacy rows without a salonId pass through so pre-salon
        // demo data keeps working, but nothing from another salon can leak in.
        if (!salonId) return rows;
        return rows.filter((row) => !row.salonId || row.salonId === salonId);
    }

    function setData(rows) {
        // The document id is the unique key. Dedupe by id so a late snapshot /
        // optimistic append can never produce a duplicate UI entry.
        const byId = new Map();
        (rows || []).forEach((row) => {
            if (row && row.id) byId.set(row.id, row);
        });
        store.setState({ [stateKey]: [...byId.values()] });
    }

    function subscribe(id) {
        // Never stack listeners: a single realtime subscription per collection.
        if (id === subscribedId && unsub) return;
        if (unsub) {
            unsub();
            unsub = null;
        }
        subscribedId = id;
        salonId = id;
        // A new salon (or the first one) has not delivered its data yet.
        loaded = false;
        if (isDemoMode()) {
            // Demo data lives in the store and is ready immediately.
            settleLoaders();
            return;
        }
        // No tenant data exists until a signed-in user points at a real salon.
        // Listening with an empty/inaccessible salon id only produces
        // "Missing or insufficient permissions." errors, so we stay silent.
        if (!id || !store.getState().currentUser) {
            // Nothing to load yet — treat the (expected-empty) list as ready so
            // callers never wait on a listener that will not be created.
            settleLoaders();
            return;
        }
        unsub = listenCollection(
            ['salons', id, collectionName],
            (rows) => {
                settleLoaders();
                setData(rows);
            },
            () => {
                // An error still ends the loading window so awaiting callers are
                // not left hanging; the live list simply stays whatever it has.
                settleLoaders();
                setData([]);
            },
        );
    }

    /** (Re)point the repository at a different salon. */
    function setSalon(id) {
        if (id !== subscribedId) subscribe(id);
    }

    function init(id) {
        subscribe(id);
    }

    /** True when the current salon's data has loaded (always true in demo). */
    function isLoaded() {
        return isDemoMode() || loaded;
    }

    /**
     * Resolve once the current salon's data has loaded, or false after the
     * timeout (backend unreachable). A caller that is about to CREATE a record
     * should await this first so a just-existing record is never duplicated by
     * a read that predates the first snapshot.
     */
    async function ensureLoaded(timeoutMs = 6000) {
        if (isLoaded()) return true;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                loadWaiters.delete(resolve);
                resolve(false);
            }, timeoutMs);
            loadWaiters.add((result) => {
                clearTimeout(timer);
                resolve(result);
            });
        });
    }

    async function add(payload, opts = {}) {
        assertSubscriptionAllows(collectionName, { creating: true });
        // Reject invalid data before touching local state, store or Firestore.
        assertValidAdd(collectionName, payload, opts);
        if (!salonId) {
            throw new Error('No salon selected. Please set up your salon first.');
        }
        // Every tenant record is stamped with its owning salon so lists can be
        // filtered by salonId as a defense-in-depth layer on top of the scoped
        // Firestore path.
        const row = { salonId, ...payload };
        if (isDemoMode()) {
            // makeId adds a random suffix: two records created inside the same
            // millisecond must never share an id (the store dedupes by id).
            const record = { id: makeId(collectionName.slice(0, 3)), ...row, createdAt: row.createdAt || new Date().toISOString() };
            setData([...data(), record]);
            return record;
        }
        // The realtime listener is the single source of truth: after the
        // Firestore write succeeds it delivers the updated collection and the
        // store re-renders. Never append locally here — if the snapshot has
        // already arrived, a manual append duplicates the row.
        return addDocument(['salons', salonId, collectionName], {
            ...row,
            createdAt: new Date().toISOString(),
        });
    }

    async function update(id, patch) {
        assertSubscriptionAllows(collectionName, { creating: false });
        if (isDemoMode()) {
            setData(data().map((row) => (row.id === id ? { ...row, ...patch } : row)));
            return { id, ...patch };
        }
        // Listener refreshes the list; no local mutation.
        return updateDocument(['salons', salonId, collectionName], id, patch);
    }

    async function remove(id) {
        assertSubscriptionAllows(collectionName, { creating: false });
        if (isDemoMode()) {
            setData(data().filter((row) => row.id !== id));
            return { id };
        }
        // Listener refreshes the list; no local mutation.
        await deleteDocument(['salons', salonId, collectionName], id);
        return { id };
    }

    return { init, setSalon, add, update, remove, data, isLoaded, ensureLoaded, seed };
}

export default createScopedRepository;
