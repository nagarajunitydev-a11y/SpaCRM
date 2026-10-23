import assert from 'node:assert/strict';
import { createSyncService, revision } from '../api/_lib/sync/service.js';
import { GET as getBranches } from '../api/sync/branches.js';

function memoryStore() {
    const documents = new Map(); let queue = Promise.resolve();
    return {
        documents,
        transaction(work) {
            const run = queue.then(async () => {
                const writes = []; let writing = false;
                const result = await work({
                    get: async path => { assert(!writing, 'read after write'); return structuredClone(documents.get(path) ?? null); },
                    list: async (path, field, value) => {
                        assert(!writing, 'query after write');
                        return [...documents.entries()].filter(([key, data]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/') && (!field || data[field] === value))
                            .map(([key, data]) => ({ id: key.slice(path.length + 1), data: structuredClone(data) }));
                    },
                    set: (path, data) => { writing = true; writes.push([path, structuredClone(data)]); },
                    merge: (path, data) => { writing = true; writes.push([path, { ...structuredClone(documents.get(path)), ...structuredClone(data) }]); },
                });
                writes.forEach(([path, data]) => documents.set(path, data)); return result;
            });
            queue = run.catch(() => {}); return run;
        },
    };
}
let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }
const db = memoryStore(); let time = Date.UTC(2026, 9, 22);
db.documents.set('users/owner', { role: 'salon_owner' });
db.documents.set('salons/branch', { ownerId: 'owner', name: 'Salon' });
db.documents.set('subscriptions/owner', { ownerId: 'owner', planId: 'trial', status: 'TRIAL', trialEndsAt: time + 86400000 });
const service = createSyncService({ db, now: () => time });
const cmd = (overrides = {}) => ({ protocolVersion: 1, salonId: 'branch', commandId: 'first', entityId: 'customer', collection: 'customers', baseRevision: null, payload: { name: 'Client', phone: '9876543210', email: '' }, ...overrides });
await test('HTTP pilot defaults closed and enabled API still requires authentication', async () => {
    const previous = process.env.NATIVE_SYNC_ENABLED;
    try {
        delete process.env.NATIVE_SYNC_ENABLED;
        assert.equal((await getBranches(new Request('https://staging.invalid/api/sync/branches'))).status, 503);
        process.env.NATIVE_SYNC_ENABLED = 'true';
        assert.equal((await getBranches(new Request('https://staging.invalid/api/sync/branches'))).status, 401);
    } finally { if (previous === undefined) delete process.env.NATIVE_SYNC_ENABLED; else process.env.NATIVE_SYNC_ENABLED = previous; }
});
await test('Canonical revision does not depend on object key order', () => assert.equal(revision({ a: 1, b: { y: 2, x: 3 } }), revision({ b: { x: 3, y: 2 }, a: 1 })));
await test('Owner-only branches and denied cross-tenant snapshot', async () => {
    assert.equal((await service.branches('owner')).branches.length, 1);
    await assert.rejects(service.snapshot('attacker', 'branch'), error => error.httpStatus === 403);
});
let accepted;
await test('Unsupported protocol, invalid dates, prices and status fail without writes', async () => {
    const before = db.documents.size;
    await assert.rejects(service.push('owner', cmd({ protocolVersion: 99 })), error => error.httpStatus === 426);
    for (const date of ['2026-99-99', '2026-02-30', 'invalid']) await assert.rejects(service.push('owner', cmd({ collection: 'attendance', payload: { staffId: 'stylist', staffName: 'Stylist', date, status: 'Present' } })), error => error.httpStatus === 400);
    for (const price of [-1, 1.001, '100']) await assert.rejects(service.push('owner', cmd({ collection: 'services', payload: { name: 'Cut', price, duration: 30 } })), error => error.httpStatus === 400);
    assert.equal(db.documents.size, before);
});
await test('Create persists canonical defaults and durable receipt', async () => {
    accepted = await service.push('owner', cmd());
    assert.equal(accepted.status, 'ACCEPTED'); assert.equal(accepted.data.phone, '+919876543210');
    assert.equal(accepted.data.rewardPoints, 100); assert.equal(accepted.data.walletBalance, 0);
    assert.deepEqual(await service.receipt('owner', 'branch', 'first'), accepted);
});
await test('100 duplicate deliveries produce one record and original receipt', async () => {
    for (let i = 0; i < 100; i++) assert.deepEqual(await service.push('owner', cmd()), accepted);
    assert.equal([...db.documents.keys()].filter(k => k.startsWith('salons/branch/customers/')).length, 1);
});
await test('Same key with different payload is rejected', async () => assert.rejects(service.push('owner', cmd({ payload: { name: 'Different' } })), error => error.code === 'IDEMPOTENCY_MISMATCH'));
await test('Different command IDs cannot duplicate customer phone', async () => assert.equal((await service.push('owner', cmd({ commandId: 'duplicate', entityId: 'duplicate' }))).code, 'DUPLICATE_CUSTOMER'));
await test('Concurrent edits have one winner; rejected intent is replay-stable', async () => {
    const outcomes = await Promise.all(['editA', 'editB'].map(commandId => service.push('owner', cmd({ commandId, baseRevision: accepted.revision, payload: { name: commandId, phone: '+919876543210' } }))));
    assert.equal(outcomes.filter(r => r.status === 'ACCEPTED').length, 1);
    const conflict = outcomes.find(r => r.status === 'CONFLICT');
    assert.deepEqual(await service.receipt('owner', 'branch', conflict.commandId), conflict);
});
await test('Legacy direct writes are detected without a version field', async () => {
    const snapshot = await service.snapshot('owner', 'branch'); const row = snapshot.records[0];
    db.documents.set('salons/branch/customers/customer', { ...row.data, email: 'legacy@example.com' });
    assert.equal((await service.push('owner', cmd({ commandId: 'legacyRace', baseRevision: row.revision }))).code, 'VERSION_CONFLICT');
});
await test('Payload cannot modify wallet/roles/paid fields or unknown collections', async () => {
    for (const field of ['walletBalance', 'rewardPoints', 'paid', 'ownerId', 'salonId']) await assert.rejects(service.push('owner', cmd({ payload: { name: 'Client', [field]: 1000 } })), error => error.httpStatus === 400);
    await assert.rejects(service.push('owner', cmd({ collection: 'invoices' })), error => error.httpStatus === 400);
});
await test('Path injection and missing revision are rejected', async () => {
    await assert.rejects(service.push('owner', cmd({ salonId: '../branch' })));
    await assert.rejects(service.push('owner', cmd({ baseRevision: undefined })));
});
await test('Attendance uses real staff identity and existing unique daily IDs', async () => {
    db.documents.set('salons/branch/staff/stylist', { name: 'Trusted Staff Name' });
    const attendance = cmd({ commandId: 'attendance', entityId: 'stylist_2026-10-22', collection: 'attendance', payload: { staffId: 'stylist', staffName: 'Untrusted Name', date: '2026-10-22', status: 'Late', checkIn: '10:30' } });
    const result = await service.push('owner', attendance);
    assert.equal(result.status, 'ACCEPTED'); assert.equal(result.data.staffName, 'Trusted Staff Name');
    assert.equal((await service.push('owner', { ...attendance, commandId: 'attendanceDuplicate' })).status, 'CONFLICT');
});
await test('Service duration remains compatible with existing browser scheduling', async () => {
    const result = await service.push('owner', cmd({ commandId: 'service', entityId: 'haircut', collection: 'services', payload: { name: 'Haircut', price: 400.5, duration: 30 } }));
    assert.equal(result.data.duration, '30m');
});
await test('Plan limits and suspended branch return durable rejection without effects', async () => {
    db.documents.set('plans/trial', { maxStaff: 1 });
    assert.equal((await service.push('owner', cmd({ commandId: 'staffLimit', entityId: 'secondStaff', collection: 'staff', payload: { name: 'Second' } }))).code, 'PLAN_LIMIT');
    db.documents.set('salons/branch', { ownerId: 'owner', status: 'suspended' });
    const suspended = cmd({ commandId: 'suspended', entityId: 'suspendedClient', payload: { name: 'Saved offline', phone: '+919876543212' } });
    assert.equal((await service.push('owner', suspended)).status, 'REJECTED');
    assert(!db.documents.has('salons/branch/customers/suspendedClient'));
    db.documents.set('salons/branch', { ownerId: 'owner' });
    assert.equal((await service.push('owner', suspended)).status, 'REJECTED', 'changing permissions must not change a terminal receipt');
});
await test('Permission is rechecked before receipt disclosure', async () => {
    db.documents.set('salons/branch', { ownerId: 'another' });
    await assert.rejects(service.receipt('owner', 'branch', 'first'), error => error.httpStatus === 403);
    db.documents.set('salons/branch', { ownerId: 'owner' });
});
await test('Expiry blocks new effects but retains previously accepted receipt', async () => {
    time += 2 * 86400000;
    assert.deepEqual(await service.push('owner', cmd()), accepted);
    assert.equal((await service.push('owner', cmd({ commandId: 'expired', entityId: 'newCustomer', payload: { name: 'New', phone: '9876543211' } }))).code, 'ACCESS_EXPIRED');
    assert.equal((await service.snapshot('owner', 'branch')).grant.allowedCollections.length, 0);
});
console.log(`NATIVE SYNC: ${checks} scenarios passed (serialized in-memory adapter; emulator concurrency still required).`);
