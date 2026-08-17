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

export function createScopedRepository({ stateKey, collectionName, seed }) {
    let unsub = null;
    let salonId = null;
    let subscribedId = null;

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
        if (isDemoMode()) return;
        // No tenant data exists until a signed-in user points at a real salon.
        // Listening with an empty/inaccessible salon id only produces
        // "Missing or insufficient permissions." errors, so we stay silent.
        if (!id || !store.getState().currentUser) return;
        unsub = listenCollection(
            ['salons', id, collectionName],
            (rows) => setData(rows),
            () => setData([]),
        );
    }

    /** (Re)point the repository at a different salon. */
    function setSalon(id) {
        if (id !== subscribedId) subscribe(id);
    }

    function init(id) {
        subscribe(id);
    }

    async function add(payload, opts = {}) {
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
            const record = { id: `${collectionName.slice(0, 3)}_${Date.now().toString(36)}`, ...row };
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
        if (isDemoMode()) {
            setData(data().map((row) => (row.id === id ? { ...row, ...patch } : row)));
            return { id, ...patch };
        }
        // Listener refreshes the list; no local mutation.
        return updateDocument(['salons', salonId, collectionName], id, patch);
    }

    async function remove(id) {
        if (isDemoMode()) {
            setData(data().filter((row) => row.id !== id));
            return { id };
        }
        // Listener refreshes the list; no local mutation.
        await deleteDocument(['salons', salonId, collectionName], id);
        return { id };
    }

    return { init, setSalon, add, update, remove, data, seed };
}

export default createScopedRepository;
