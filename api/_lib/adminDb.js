/**
 * firebase-admin adapter implementing the small `db` interface handlers.js
 * expects. Dates are epoch milliseconds in handler code and Firestore
 * Timestamps in the database (so security rules can compare them).
 */
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const DATE_FIELDS = new Set([
    'createdAt', 'paidAt', 'failedAt', 'cancelledAt', 'refundedAt', 'at', 'trialStartedAt', 'trialEndsAt',
    'currentPeriodStart', 'currentPeriodEnd', 'periodStart', 'periodEnd', 'updatedAt', 'usageUpdatedAt',
    'nextChargeAt', 'scheduledChangeAt', 'lastEventAt',
]);

export class AdminNotConfigured extends Error {
    constructor() {
        super('Firebase Admin is not configured on the server.');
        this.name = 'AdminNotConfigured';
    }
}

function app() {
    if (getApps().length) return getApps()[0];
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new AdminNotConfigured();
    // Accept raw JSON or base64-encoded JSON (easier to paste into Vercel).
    const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return initializeApp({ credential: cert(JSON.parse(json)) });
}

const fromDb = (data) => {
    const out = {};
    Object.entries(data).forEach(([k, v]) => { out[k] = v instanceof Timestamp ? v.toMillis() : v; });
    return out;
};
const toDb = (data) => {
    const out = {};
    Object.entries(data).forEach(([k, v]) => {
        if (v === undefined) return;
        out[k] = DATE_FIELDS.has(k) && typeof v === 'number' ? Timestamp.fromMillis(v) : v;
    });
    return out;
};

export function createAdminDb() {
    const fs = getFirestore(app());
    return {
        async get(path) {
            const s = await fs.doc(path).get();
            return s.exists ? fromDb(s.data()) : null;
        },
        async list(collectionPath) {
            const s = await fs.collection(collectionPath).get();
            return s.docs.map((d) => ({ id: d.id, ...fromDb(d.data()) }));
        },
        async set(path, data) {
            await fs.doc(path).set(toDb(data));
        },
        async transaction(fn) {
            return fs.runTransaction(async (t) => fn({
                async get(path) {
                    const s = await t.get(fs.doc(path));
                    return s.exists ? fromDb(s.data()) : null;
                },
                set(path, data) {
                    t.set(fs.doc(path), toDb(data));
                },
            }));
        },
    };
}

// Native sync needs query reads inside transactions (for uniqueness/quotas).
// Keep the existing billing adapter and its timestamp contract unchanged.
export function getAdminFirestore() {
    return getFirestore(app());
}

/** Verify the caller's Firebase ID token -> { uid, email } or null. */
export async function verifyRequestUser(request, checkRevoked = false) {
    const h = request.headers.get('authorization') || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) return null;
    try {
        const d = await getAuth(app()).verifyIdToken(m[1], checkRevoked);
        return { uid: d.uid, email: d.email || '' };
    } catch {
        return null;
    }
}
