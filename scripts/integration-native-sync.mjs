import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { createSyncStore } from '../api/_lib/sync/store.js';
import { createSyncService } from '../api/_lib/sync/service.js';

if (!/^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) throw new Error('Run only against a local disposable Firestore emulator.');
initializeApp({ projectId: 'demo-spacrm-audit' });
const fs = getFirestore();
const prefix = `nativeSyncTests/${randomUUID()}`;
const source = createSyncStore();
const db = { transaction: work => source.transaction(tx => work({
    get: path => tx.get(`${prefix}/${path}`),
    list: (path, field, value) => tx.list(`${prefix}/${path}`, field, value),
    set: (path, data) => tx.set(`${prefix}/${path}`, data),
    merge: (path, data) => tx.merge(`${prefix}/${path}`, data),
})) };
const now = Date.now();
await fs.doc(`${prefix}/users/owner`).set({ role: 'salon_owner' });
await fs.doc(`${prefix}/salons/branch`).set({ ownerId: 'owner', name: 'Test Salon' });
await fs.doc(`${prefix}/subscriptions/owner`).set({ ownerId: 'owner', planId: 'trial', status: 'TRIAL', trialEndsAt: Timestamp.fromMillis(now + 86400000) });
const service = createSyncService({ db, now: () => now });
const command = (extra = {}) => ({ protocolVersion: 1, salonId: 'branch', commandId: randomUUID(), entityId: randomUUID(), collection: 'customers', baseRevision: null, payload: { name: 'Concurrent Customer', phone: '+919876543210' }, ...extra });
const first = command();
const duplicateOutcomes = await Promise.all(Array.from({ length: 8 }, () => service.push('owner', first)));
assert(duplicateOutcomes.every(row => row.status === 'ACCEPTED'));
assert.equal((await fs.collection(`${prefix}/salons/branch/customers`).get()).size, 1);
assert.equal((await fs.collection(`${prefix}/nativeSyncAccounts/owner/receipts`).get()).size, 1);
console.log('PASS actual Firestore concurrent duplicate delivery creates one customer/receipt');
const competitors = await Promise.all(Array.from({ length: 4 }, () => service.push('owner', command({ payload: { name: 'Same phone', phone: '+919876543211' } }))));
assert.equal(competitors.filter(row => row.status === 'ACCEPTED').length, 1);
assert.equal(competitors.filter(row => row.code === 'DUPLICATE_CUSTOMER').length, 3);
console.log('PASS actual Firestore query guards concurrent customer uniqueness');
const edits = await Promise.all(['Left', 'Right'].map(name => service.push('owner', command({ entityId: first.entityId, baseRevision: duplicateOutcomes[0].revision, payload: { name } }))));
assert.equal(edits.filter(row => row.status === 'ACCEPTED').length, 1);
assert.equal(edits.filter(row => row.status === 'CONFLICT').length, 1);
console.log('PASS actual Firestore competing updates have exactly one winner');
const preserved = Timestamp.fromMillis(123456789);
await fs.doc(`${prefix}/salons/branch/customers/${first.entityId}`).update({ legacyTimestamp: preserved });
const before = (await service.snapshot('owner', 'branch')).records.find(row => row.entityId === first.entityId);
assert.equal((await service.push('owner', command({ entityId: first.entityId, baseRevision: before.revision, payload: { name: 'Preserved legacy fields' } }))).status, 'ACCEPTED');
assert((await fs.doc(`${prefix}/salons/branch/customers/${first.entityId}`).get()).data().legacyTimestamp.isEqual(preserved));
console.log('PASS legacy Firestore timestamps retain their types across native edits');
await assert.rejects(service.snapshot('otherOwner', 'branch'), error => error.httpStatus === 403);
console.log('PASS actual Firestore adapter enforces tenant ownership');
console.log('NATIVE SYNC EMULATOR: 5 integration scenarios passed; no production connection used.');
await fs.terminate();
