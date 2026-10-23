import { getAdminFirestore } from '../adminDb.js';

// Convert nested Firestore timestamps explicitly, without changing legacy data.
export function wireValue(value) {
    if (value == null) return value;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (Array.isArray(value)) return value.map(wireValue);
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wireValue(v)]));
    return value;
}

export function createSyncStore() {
    const db = getAdminFirestore();
    return {
        transaction: work => db.runTransaction(async tx => work({
            get: async path => {
                const snap = await tx.get(db.doc(path));
                return snap.exists ? wireValue(snap.data()) : null;
            },
            list: async (path, field, value) => {
                let query = db.collection(path);
                if (field) query = query.where(field, '==', value);
                const snap = await tx.get(query.limit(2001));
                if (snap.size > 2000) throw Object.assign(new Error('Branch exceeds the current pilot snapshot limit.'), { httpStatus: 413, code: 'SNAPSHOT_LIMIT' });
                return snap.docs.map(doc => ({ id: doc.id, data: wireValue(doc.data()) }));
            },
            set: (path, data) => tx.set(db.doc(path), data),
            merge: (path, data) => tx.set(db.doc(path), data, { merge: true }),
        })),
    };
}
