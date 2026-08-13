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
    getDocs,
    onSnapshot,
    setDoc as fbSetDoc,
    addDoc as fbAddDoc,
    updateDoc as fbUpdateDoc,
    deleteDoc as fbDeleteDoc,
    query as fbQuery,
    where as fbWhere,
    orderBy as fbOrderBy,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

/** Convert a Firestore document snapshot to a plain object. */
export function mapDoc(docSnap) {
    if (!docSnap || !docSnap.exists) return null;
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
    addDocument,
    setDocument,
    updateDocument,
    deleteDocument,
};
