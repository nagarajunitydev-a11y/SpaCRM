/**
 * db.js
 * Generic Cloud Firestore repository layer.
 *
 * All Firestore reads/writes are routed through this module. UI components and
 * views never import the Firestore SDK directly — they interact with typed
 * repositories (see *Repository.js). In demo mode these helpers operate on
 * local arrays so the app remains fully functional without a backend.
 */

import { getFirebase } from './firebase.js';
import {
    collection,
    doc as fbDoc,
    getDoc as fbGetDoc,
    getDocs,
    onSnapshot,
    setDoc as fbSetDoc,
    addDoc as fbAddDoc,
    updateDoc as fbUpdateDoc,
    deleteDoc as fbDeleteDoc,
    query as fbQuery,
    where as fbWhere,
    orderBy as fbOrderBy,
    runTransaction as fbRunTransaction,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

/** True when a snapshot actually exists (`exists` is a method in the modular SDK). */
function snapExists(docSnap) {
    if (!docSnap) return false;
    return typeof docSnap.exists === 'function' ? docSnap.exists() : !!docSnap.exists;
}

/** Convert a Firestore document snapshot to a plain object (null when absent). */
export function mapDoc(docSnap) {
    if (!snapExists(docSnap)) return null;
    return { id: docSnap.id, ...docSnap.data() };
}

/** Build a scoped collection reference from a list of segments. */
export function colRef(...segments) {
    const fb = getFirebase();
    return collection(fb.db, ...segments);
}

/** Build a scoped document reference from a list of segments. */
export function docRef(...segments) {
    const fb = getFirebase();
    return fbDoc(fb.db, ...segments);
}

/**
 * Subscribe to a collection and invoke `onData(rows)` whenever it changes.
 * Returns an unsubscribe function. Never throws — errors are reported.
 */
export function listenCollection(segments, onData, onError, options = {}) {
    const fb = getFirebase();
    if (!fb) return () => {};

    const col = colRef(...segments);
    let q = col;
    if (options.where) q = fbQuery(col, ...options.where.map(([field, op, value]) => fbWhere(field, op, value)));
    if (options.orderBy) q = fbQuery(q, fbOrderBy(options.orderBy.field, options.orderBy.dir || 'asc'));

    try {
        return onSnapshot(q, (snapshot) => {
            onData(snapshot.docs.map(mapDoc));
        }, (err) => {
            console.warn(`Firestore listen failed (${segments.join('/')}):`, err);
            if (onError) onError(err);
        });
    } catch (err) {
        console.warn(`Firestore listen setup failed (${segments.join('/')}):`, err);
        if (onError) onError(err);
        return () => {};
    }
}

/** Fetch a collection once. */
export async function getCollection(segments, options = {}) {
    const fb = getFirebase();
    if (!fb) return [];
    try {
        let q = colRef(...segments);
        if (options.where) q = fbQuery(q, ...options.where.map(([f, op, v]) => fbWhere(f, op, v)));
        const snapshot = await getDocs(q);
        return snapshot.docs.map(mapDoc);
    } catch (err) {
        console.warn(`Firestore read failed (${segments.join('/')}):`, err);
        return [];
    }
}

/** Fetch a single document once. */
export async function getDocument(segments, id) {
    const fb = getFirebase();
    if (!fb) return null;
    try {
        const ref = docRef(...segments, id);
        const snapshot = await fbGetDoc(ref);
        return mapDoc(snapshot);
    } catch (err) {
        console.warn(`Firestore read failed (${segments.join('/')}/${id}):`, err);
        return null;
    }
}

/** Add a document to a collection. Returns the new document row. */
export async function addDocument(segments, data) {
    const fb = getFirebase();
    if (!fb) return null;
    const col = colRef(...segments);
    const ref = await fbAddDoc(col, data);
    return { id: ref.id, ...data };
}

/** Write a document by id (create or overwrite). */
export async function setDocument(segments, id, data) {
    const fb = getFirebase();
    if (!fb) return null;
    const ref = docRef(...segments, id);
    await fbSetDoc(ref, data);
    return { id, ...data };
}

/** Update specific fields of a document. */
export async function updateDocument(segments, id, data) {
    const fb = getFirebase();
    if (!fb) return null;
    const ref = docRef(...segments, id);
    await fbUpdateDoc(ref, data);
    return { id, ...data };
}

/**
 * Run an atomic Firestore transaction.
 *
 * `work` receives a small path-based facade over the native transaction so
 * callers keep speaking the same `(segments, id)` language as the rest of this
 * module and never import the Firestore SDK themselves. Firestore requires all
 * reads before any write, and may re-run `work` on contention, so `work` must
 * be free of side effects outside the transaction.
 *
 *   await runAtomic(async (tx) => {
 *       const row = await tx.get(['salons', id, 'referrals'], refId);
 *       if (row) throw new Error('already exists');
 *       tx.set(['salons', id, 'referrals'], refId, data);
 *   });
 *
 * Returns whatever `work` returns, or null in demo mode (no backend).
 */
export async function runAtomic(work) {
    const fb = getFirebase();
    if (!fb) return null;
    return fbRunTransaction(fb.db, async (tx) => {
        const facade = {
            async get(segments, id) {
                return mapDoc(await tx.get(docRef(...segments, id)));
            },
            set(segments, id, data) {
                tx.set(docRef(...segments, id), data);
            },
            update(segments, id, data) {
                tx.update(docRef(...segments, id), data);
            },
            delete(segments, id) {
                tx.delete(docRef(...segments, id));
            },
        };
        return work(facade);
    });
}

/**
 * Atomically create a document only when its id is still free. Returns
 * `{ created, row }` — `created` is false when another writer won the race.
 * This is the primitive that makes referral codes and referral links unique.
 */
export async function createIfAbsent(segments, id, data) {
    const fb = getFirebase();
    if (!fb) return { created: false, row: null };
    return runAtomic(async (tx) => {
        const existing = await tx.get(segments, id);
        if (existing) return { created: false, row: existing };
        tx.set(segments, id, data);
        return { created: true, row: { id, ...data } };
    });
}

/** Delete a document. */
export async function deleteDocument(segments, id) {
    const fb = getFirebase();
    if (!fb) return null;
    const ref = docRef(...segments, id);
    await fbDeleteDoc(ref);
    return { id };
}

export default {
    mapDoc,
    colRef,
    docRef,
    listenCollection,
    getCollection,
    getDocument,
    addDocument,
    setDocument,
    updateDocument,
    deleteDocument,
    runAtomic,
    createIfAbsent,
};
