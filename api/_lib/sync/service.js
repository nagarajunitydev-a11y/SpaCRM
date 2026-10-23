import { createHash } from 'node:crypto';
import { buildAccess } from '../../../public/js/core/featureAccess.js';
import { mergePlans } from '../../../public/js/core/plans.js';
import { ATTENDANCE_STATUSES } from '../../../public/js/core/validate.js';

export const PROTOCOL_VERSION = 1;
export const READ_COLLECTIONS = ['customers', 'services', 'staff', 'attendance', 'appointments', 'referrals', 'walletTransactions'];
const EDIT_COLLECTIONS = ['customers', 'services', 'staff', 'attendance'];
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function syncError(message, httpStatus = 400, code = 'INVALID_COMMAND') {
    return Object.assign(new Error(message), { httpStatus, code });
}
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
export const revision = value => value == null ? null : createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const text = (v, max, required = false) => typeof v === 'string' && v.length <= max && (!required || v.trim().length > 0);
const fields = {
    customers: ['name', 'phone', 'email'],
    services: ['name', 'price', 'duration', 'category', 'active'],
    staff: ['name', 'phone', 'role'],
    attendance: ['staffId', 'staffName', 'date', 'status', 'checkIn', 'checkOut', 'notes'],
};
function payloadFor(collection, raw) {
    if (!object(raw) || Object.keys(raw).some(key => !fields[collection].includes(key))) throw syncError('Unsupported fields. Financial and permission fields are server-owned.');
    const data = { ...raw };
    if (collection !== 'attendance' && !text(data.name, 120, true)) throw syncError('Enter a name (maximum 120 characters).');
    if (data.name) data.name = data.name.trim();
    if (['customers', 'staff'].includes(collection)) {
        if (data.phone) {
            const digits = String(data.phone).replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
            if (!/^[6-9]\d{9}$/.test(digits)) throw syncError('Enter a valid Indian mobile number.');
            data.phone = `+91${digits}`;
        }
        if (data.phone != null && !text(data.phone, 20)) throw syncError('Invalid phone.');
    }
    if (collection === 'customers' && (!text(data.email ?? '', 254) || (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)))) throw syncError('Invalid email.');
    if (collection === 'staff' && !text(data.role ?? '', 80)) throw syncError('Invalid staff role label.');
    if (collection === 'services') {
        if (!Number.isFinite(data.price) || data.price < 0 || data.price > 1000000 || Math.abs(data.price * 100 - Math.round(data.price * 100)) > 0.00001) throw syncError('Service price must be a non-negative amount with at most two decimals.');
        if (!Number.isInteger(data.duration) || data.duration < 5 || data.duration > 720) throw syncError('Service duration must be 5–720 minutes.');
        if (data.category != null && !text(data.category, 80)) throw syncError('Invalid category.');
        if (data.active != null && typeof data.active !== 'boolean') throw syncError('Invalid active state.');
    }
    if (collection === 'attendance') {
        const parsed = new Date(`${data.date}T00:00:00Z`);
        if (!id(data.staffId) || !text(data.staffName, 120) || !/^\d{4}-\d{2}-\d{2}$/.test(data.date ?? '') || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== data.date) throw syncError('Invalid staff or attendance date.');
        if (!ATTENDANCE_STATUSES.includes(data.status)) throw syncError('Invalid attendance status.');
        for (const key of ['checkIn', 'checkOut']) if (data[key] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data[key])) throw syncError('Invalid attendance time.');
        if (!text(data.notes ?? '', 1000)) throw syncError('Attendance notes are too long.');
    }
    return data;
}

export function createSyncService({ db, now = Date.now }) {
    async function scope(tx, uid, salonId) {
        if (!id(uid) || !id(salonId)) throw syncError('Invalid account or branch.');
        const profile = await tx.get(`users/${uid}`);
        const salon = await tx.get(`salons/${salonId}`);
        // Initial pilot is owner-only. A staff roster role never grants account access.
        if (profile?.role !== 'salon_owner' || salon?.ownerId !== uid) throw syncError('Branch owner access required.', 403, 'ACCESS_DENIED');
        return salon;
    }
    async function access(tx, uid, salon, salonId, counts = {}) {
        const subscription = await tx.get(`subscriptions/${uid}`);
        const rows = await tx.list('plans');
        const plans = mergePlans(rows.map(row => ({ ...row.data, id: row.id })));
        const result = buildAccess({ subscription, plans, usage: { customer: counts.customers ?? 0, staff: counts.staff ?? 0, branch: 1 }, now: now() });
        const allowed = !result.locked && salon.active !== false && salon.status !== 'suspended';
        const grace = Number.isInteger(subscription?.graceDays) && subscription.graceDays >= 0 && subscription.graceDays <= 30 ? subscription.graceDays : 3;
        const end = subscription?.planId === 'trial' ? subscription?.trialEndsAt : (subscription?.currentPeriodEnd ?? 0) + (subscription?.cancelAtPeriodEnd || subscription?.status === 'CANCELLED' ? 0 : grace * 86400000);
        return { allowed, result, subscription, plans, grant: { ownerUid: uid, salonId, issuedAt: now(), expiresAt: allowed ? Math.min(now() + 72 * 3600000, end) : now(), allowedCollections: allowed ? EDIT_COLLECTIONS : [] } };
    }
    return {
        async branches(uid) {
            return db.transaction(async tx => {
                if (!id(uid) || (await tx.get(`users/${uid}`))?.role !== 'salon_owner') throw syncError('Owner profile required.', 403, 'ACCESS_DENIED');
                const rows = await tx.list('salons', 'ownerId', uid);
                return { protocolVersion: PROTOCOL_VERSION, branches: rows.map(row => ({ id: row.id, name: row.data.name, active: row.data.active !== false, status: row.data.status ?? 'active' })) };
            });
        },
        async snapshot(uid, salonId) {
            return db.transaction(async tx => {
                const salon = await scope(tx, uid, salonId);
                const collections = {};
                for (const name of READ_COLLECTIONS) collections[name] = await tx.list(`salons/${salonId}/${name}`);
                const auth = await access(tx, uid, salon, salonId, Object.fromEntries(Object.entries(collections).map(([k, v]) => [k, v.length])));
                return { protocolVersion: PROTOCOL_VERSION, ownerUid: uid, salonId, serverTime: now(), branch: salon,
                    grant: auth.grant, subscription: auth.subscription, plans: auth.plans,
                    records: Object.entries(collections).flatMap(([collection, rows]) => rows.map(row => ({ collection, entityId: row.id, data: row.data, revision: revision(row.data) }))) };
            });
        },
        async receipt(uid, salonId, commandId) {
            if (!id(commandId)) throw syncError('Invalid command ID.');
            return db.transaction(async tx => {
                await scope(tx, uid, salonId);
                return tx.get(`nativeSyncAccounts/${uid}/receipts/${commandId}`).then(row => row?.salonId === salonId ? row.result : null);
            });
        },
        async push(uid, command) {
            if (!object(command) || command.protocolVersion !== PROTOCOL_VERSION) throw syncError('Unsupported sync protocol.', 426, 'UPGRADE_REQUIRED');
            const { salonId, commandId, entityId, collection, baseRevision, payload } = command;
            if (!id(commandId) || !id(entityId) || !id(salonId) || !EDIT_COLLECTIONS.includes(collection) || !(baseRevision === null || /^[a-f0-9]{64}$/.test(baseRevision ?? ''))) throw syncError('Invalid command identity or revision.');
            const input = payloadFor(collection, payload);
            const fingerprint = revision(command);
            return db.transaction(async tx => {
                const salon = await scope(tx, uid, salonId);
                const receiptPath = `nativeSyncAccounts/${uid}/receipts/${commandId}`;
                const previous = await tx.get(receiptPath);
                if (previous) {
                    if (previous.fingerprint !== fingerprint) throw syncError('Command ID reused with a different payload.', 409, 'IDEMPOTENCY_MISMATCH');
                    return previous.result;
                }
                const path = `salons/${salonId}/${collection}/${entityId}`;
                const existing = await tx.get(path);
                const rows = await tx.list(`salons/${salonId}/${collection}`);
                const auth = await access(tx, uid, salon, salonId, { [collection]: rows.length });
                // Read every dependency before performing any write.
                const staff = collection === 'attendance' ? await tx.get(`salons/${salonId}/staff/${input.staffId}`) : null;
                const result = { commandId, entityId, collection, salonId, status: 'ACCEPTED', serverTime: now() };
                if (!auth.allowed) Object.assign(result, { status: 'REJECTED', code: 'ACCESS_EXPIRED', message: 'Branch or subscription is read-only. Local work is preserved.' });
                else if (revision(existing) !== baseRevision) Object.assign(result, { status: 'CONFLICT', code: 'VERSION_CONFLICT', message: 'This record changed on another device. Review both versions.', serverData: existing, serverRevision: revision(existing) });
                else if (!existing && ['customers', 'staff'].includes(collection) && !auth.result.canCreate(collection === 'customers' ? 'customer' : 'staff').ok) Object.assign(result, { status: 'REJECTED', code: 'PLAN_LIMIT', message: 'The current plan limit has been reached.' });
                else if (collection === 'customers' && rows.some(row => row.id !== entityId && ((input.phone && String(row.data.phone ?? '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '') === input.phone.slice(3)) || (!input.phone && String(row.data.name ?? '').trim().toLowerCase() === input.name.toLowerCase())))) Object.assign(result, { status: 'CONFLICT', code: 'DUPLICATE_CUSTOMER', message: 'A matching customer already exists. Resolve the identity before retrying.' });
                else if (collection === 'attendance' && (!staff || entityId !== `${input.staffId}_${input.date}`)) Object.assign(result, { status: 'REJECTED', code: 'INVALID_STAFF', message: 'Attendance must reference an existing staff member and its unique daily ID.' });
                if (result.status === 'ACCEPTED') {
                    const data = { ...(existing ?? {}), ...input, salonId, updatedAt: new Date(now()).toISOString() };
                    if (!existing) data.createdAt = new Date(now()).toISOString();
                    // New pilot-created customers receive the existing signup points,
                    // but never an offline-created referral wallet or paid status.
                    if (!existing && collection === 'customers') Object.assign(data, { rewardPoints: 100, walletBalance: 0 });
                    if (collection === 'services') data.duration = `${input.duration}m`;
                    if (collection === 'attendance') data.staffName = staff.name;
                    result.data = data; result.revision = revision(data);
                    // Do not re-serialize legacy Timestamp/unknown fields from
                    // the wire snapshot into Firestore when changing a profile.
                    if (existing) {
                        const patch = { ...input, salonId, updatedAt: data.updatedAt };
                        if (collection === 'services') patch.duration = data.duration;
                        if (collection === 'attendance') patch.staffName = data.staffName;
                        tx.merge(path, patch);
                    } else tx.set(path, data);
                }
                tx.set(receiptPath, { salonId, fingerprint, result, createdAt: now() });
                return result;
            });
        },
    };
}
