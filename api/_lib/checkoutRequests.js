import { createHash, randomUUID } from 'node:crypto';

export const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export function billingError(message, status = 409, code = 'BILLING_CONFLICT') {
    return Object.assign(new Error(message), { httpStatus: status, code });
}

export async function requireOwner(db, uid, salonId) {
    if (!validId(uid) || (salonId != null && !validId(salonId))) throw billingError('Invalid account or salon.', 400);
    const profile = await db.get(`users/${uid}`);
    if (profile?.role !== 'salon_owner') throw billingError('Salon owner access required.', 403);
    const sub = await db.get(`subscriptions/${uid}`);
    if (sub && sub.ownerId !== uid) throw billingError('Subscription ownership mismatch.', 403);
    const chosenSalon = salonId || sub?.salonId;
    if (chosenSalon) {
        const salon = await db.get(`salons/${chosenSalon}`);
        if (salon?.ownerId !== uid) throw billingError('That salon does not belong to your account.', 403);
    }
    return sub;
}

/** Durable reservation: an ambiguous provider timeout is never retried as a new charge. */
export async function checkoutRequest({ db, uid, key, fingerprint, now, execute }) {
    if (key != null && !validId(key)) throw billingError('Invalid checkout request key.', 400);
    const requestId = hash(`${uid}:${key || randomUUID()}`);
    const path = `checkoutRequests/${requestId}`;
    const lockPath = `checkoutLocks/${uid}`;
    const cached = await db.transaction(async (tx) => {
        const request = await tx.get(path);
        const lock = await tx.get(lockPath);
        if (request) {
            if (request.fingerprint !== fingerprint) throw billingError('Checkout key was used for another purchase.');
            if (request.response) return request.response;
            if (request.status !== 'failed') throw billingError('Checkout is awaiting reconciliation. Do not submit another payment.', 409, 'RECONCILIATION_REQUIRED');
        }
        if (lock && ['creating', 'unknown'].includes(lock.status)) {
            throw billingError('Another checkout is awaiting confirmation.', 409, 'RECONCILIATION_REQUIRED');
        }
        tx.set(path, { uid, fingerprint, status: 'creating', createdAt: now });
        tx.set(lockPath, { requestId, status: 'creating', createdAt: now });
        return null;
    });
    if (cached) return cached;
    try {
        const response = await execute(requestId);
        await db.transaction(async (tx) => {
            const record = await tx.get(path);
            tx.set(path, { ...record, response, status: 'created', updatedAt: now });
            tx.set(lockPath, { requestId, status: 'created', updatedAt: now });
        });
        return response;
    } catch (error) {
        // A provider 4xx or local validation failure is definitive. Network/5xx
        // failures may have created a remote mandate and need operator recovery.
        const status = (error.gatewayStatus >= 400 && error.gatewayStatus < 500) || error.httpStatus ? 'failed' : 'unknown';
        await db.transaction(async (tx) => {
            const record = await tx.get(path);
            if (record.response) return; // A signed webhook already recovered the remote operation.
            tx.set(path, { ...record, status, updatedAt: now });
            tx.set(lockPath, { requestId, status, updatedAt: now });
        });
        throw error;
    }
}
