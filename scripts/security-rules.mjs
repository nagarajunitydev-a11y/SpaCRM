// Real Firestore emulator tests. Never connects to a production project.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, deleteDoc, writeBatch, Timestamp } from 'firebase/firestore';
import { DEFAULT_PLANS } from '../public/js/core/plans.js';

const projectId = 'demo-spacrm-audit';
const env = await initializeTestEnvironment({ projectId, firestore: { rules: readFileSync('firestore.rules', 'utf8') } });
const now = Date.now(), day = 86400000;
let passed = 0;
const probes = [];
async function check(name, work) { await work(); passed++; console.log(`PASS ${name}`); }
const customer = { name: 'Audit Client', phone: '+919876543210', rewardPoints: 100, walletBalance: 0 };
const staff = { name: 'Audit Staff', role: 'Stylist', phone: '+919876543210' };
const salon = (uid) => ({ ownerId: uid, name: uid, phone: '+919876543210', address: 'Emulator only', active: true });
const sub = (planId, status = planId === 'trial' ? 'TRIAL' : 'ACTIVE') => ({
    ownerId: `TEST_${planId === 'trial' ? 'FREE_TRIAL' : planId.toUpperCase()}`, planId, status,
    trialStartedAt: Timestamp.fromMillis(now - day), trialEndsAt: Timestamp.fromMillis(now + 29 * day),
    currentPeriodEnd: Timestamp.fromMillis(now + 30 * day),
});
const booking = { enabled: true, slotIntervalMinutes: 30, advanceBookingDays: 30, minNoticeMinutes: 0, workingHours: {}, publicServices: [], publicStaff: [] };
const referral = { enabled: true, rewardType: 'fixed', rewardValue: 50, minInvoiceAmount: 100, rewardTrigger: 'invoice_paid', expiryDays: 30, maxRedemptionPercent: 50 };
const appointment = { customerName: 'Audit Client', serviceName: 'Haircut', staffName: 'Audit Staff', date: '2026-10-08', time: '10:00', status: 'Confirmed', customerId: 'c1' };
async function seed(path, data) { await env.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), path), data)); }
async function probe(name, operation) {
    try { await operation(); probes.push({ name, status: 'FAIL', actual: 'Forbidden operation was accepted by Firestore' }); }
    catch (error) { if (error.code !== 'permission-denied') throw error; probes.push({ name, status: 'PASS', actual: 'Denied by Firestore' }); }
    console.log(`${probes.at(-1).status} AUDIT ${name}`);
}

try {
    await env.clearFirestore();
    for (const plan of Object.values(DEFAULT_PLANS)) {
        const record = sub(plan.id), uid = record.ownerId, sid = uid;
        await seed(`users/${uid}`, { role: 'salon_owner' });
        await seed(`salons/${sid}`, salon(uid));
        await seed(`subscriptions/${uid}`, record);
        const db = env.authenticatedContext(uid).firestore();
        const path = (collection, id) => doc(db, `salons/${sid}/${collection}/${id}`);
        await check(`${uid}: customer persisted/read`, async () => {
            await assertSucceeds(setDoc(path('customers', 'c1'), customer));
            assert.equal((await getDoc(path('customers', 'c1'))).data().name, customer.name);
        });
        await check(`${uid}: staff persisted`, () => assertSucceeds(setDoc(path('staff', 's1'), staff)));
        await check(`${uid}: services persisted`, () => assertSucceeds(setDoc(path('services', 'svc1'), { name: 'Haircut', price: 250, duration: '30m' })));
        await check(`${uid}: appointment and billing persisted`, async () => {
            await assertSucceeds(setDoc(path('appointments', 'a1'), appointment));
            await assertSucceeds(updateDoc(path('appointments', 'a1'), { paid: true, invoiceAmount: 250, paymentMethod: 'cash', status: 'Completed' }));
        });
        await check(`${uid}: attendance persisted`, () => assertSucceeds(setDoc(path('attendance', 's1_2026-10-08'), { staffId: 's1', staffName: staff.name, date: '2026-10-08', status: 'Present' })));
        await check(`${uid}: alternate attendance key denied`, () => assertFails(setDoc(path('attendance', 'duplicate'), { staffId: 's1', staffName: staff.name, date: '2026-10-08', status: 'Present' })));
        await check(`${uid}: booking entitlement`, () => (plan.id === 'basic' ? assertFails : assertSucceeds)(setDoc(path('bookingSettings', 'config'), booking)));
        await check(`${uid}: referral entitlement`, () => (plan.id === 'basic' ? assertFails : assertSucceeds)(setDoc(path('referralSettings', 'config'), referral)));
        await check(`${uid}: profile role cannot escalate`, () => assertFails(updateDoc(doc(db, `users/${uid}`), { role: 'super_admin' })));
        await check(`${uid}: paid plan cannot be forged`, () => assertFails(updateDoc(doc(db, `subscriptions/${uid}`), { planId: 'business', status: 'ACTIVE' })));
        await check(`${uid}: payment history cannot be forged`, () => assertFails(setDoc(doc(db, `subscriptions/${uid}/payments/forged`), { status: 'SUCCESS' })));
        await check(`${uid}: ownership cannot be transferred`, () => assertFails(updateDoc(doc(db, `salons/${sid}`), { ownerId: 'intruder' })));
        await check(`${uid}: tenant read denied`, () => assertFails(getDoc(doc(env.authenticatedContext('intruder').firestore(), `salons/${sid}/customers/c1`))));

        await check(`${uid}: invoice discount entitlement`, () => (plan.id === 'basic' ? assertFails : assertSucceeds)(updateDoc(path('appointments', 'a1'), { discountApplied: 10 })));
        await check(`${uid}: customer discount entitlement`, () => (plan.id === 'basic' ? assertFails : assertSucceeds)(updateDoc(path('customers', 'c1'), { discountType: 'fixed', discountValue: 10 })));
        await check(`${uid}: wallet mutation entitlement`, () => (plan.id === 'basic' ? assertFails : assertSucceeds)(updateDoc(path('customers', 'c1'), { walletBalance: 10 })));
        // Populate actual persisted records to the advertised boundary, then
        // attempt the next write through a rules-enforced owner connection.
        for (const [collection, max, payload] of [['staff', plan.maxStaff ?? 16, staff], ['customers', plan.maxCustomers ?? 5001, customer]]) {
            await env.withSecurityRulesDisabled(async (ctx) => {
                const admin = ctx.firestore();
                // Clear the earlier sample so this collection contains exactly max.
                await deleteDoc(doc(admin, `salons/${sid}/${collection}/${collection === 'staff' ? 's1' : 'c1'}`));
                for (let offset = 0; offset < max - 1; offset += 400) {
                    const batch = writeBatch(admin);
                    for (let i = offset; i < Math.min(max - 1, offset + 400); i++) batch.set(doc(admin, `salons/${sid}/${collection}/boundary_${i}`), payload);
                    await batch.commit();
                }
            });
            await check(`${uid}: ${collection} record ${max} allowed`, () => assertSucceeds(setDoc(path(collection, 'last_allowed'), payload)));
            if (plan.id === 'business') {
                await check(`${uid}: ${collection} above lower tier allowed`, () => assertSucceeds(setDoc(path(collection, 'above_limit'), payload)));
            } else {
                await probe(`${uid}: ${collection} record ${max + 1} must block`, () => setDoc(path(collection, 'above_limit'), payload));
            }
        }
        if (plan.id !== 'business') await probe(`${uid}: second branch must block`, () => setDoc(doc(db, `salons/${sid}_branch2`), salon(uid)));
        else for (let i = 2; i <= 3; i++) await check(`${uid}: branch ${i} allowed`, () => assertSucceeds(setDoc(doc(db, `salons/${sid}_branch${i}`), salon(uid))));
    }
    const uid = 'TEST_STANDARD', db = env.authenticatedContext(uid).firestore();
    for (const [state, end, allowed] of [
        ['TRIAL', now + day, true], ['ACTIVE', now + day, true], ['PAST_DUE', now - day, true],
        ['GRACE_PERIOD', now - day, true], ['EXPIRED', now + day, false], ['SUSPENDED', now + day, false],
        ['CANCELLED', now + day, true], ['CANCELLED', now - day, false], ['ACTIVE', now - 4 * day, false],
        ['UNKNOWN', now + day, false],
    ]) {
        await seed(`subscriptions/${uid}`, { ...sub(state === 'TRIAL' ? 'trial' : 'standard', state), currentPeriodEnd: Timestamp.fromMillis(end) });
        await check(`${state}/${end < now ? 'ended' : 'future'}: core write ${allowed ? 'allowed' : 'denied'}`, () => (allowed ? assertSucceeds : assertFails)(setDoc(doc(db, `salons/${uid}/services/state`), { name: 'State test', price: 10, duration: '10m' })));
        await check(`${state}: existing data readable`, () => assertSucceeds(getDoc(doc(db, `salons/${uid}/customers/last_allowed`))));
        await check(`${state}: public booking ${allowed ? 'allowed' : 'denied'}`, () => (allowed ? assertSucceeds : assertFails)(setDoc(doc(env.unauthenticatedContext().firestore(), `salons/${uid}/appointments/public_${state}_${end}`), { ...appointment, source: 'public_booking', paid: false })));
    }
    await seed('subscriptions/TEST_STANDARD', sub('standard'));
    await seed('salons/TEST_STANDARD/customers/existing-public-client', customer);
    await seed('salons/TEST_STANDARD/customerPhoneIndex/9876543210', { customerId: 'existing-public-client' });
    const visitor = env.unauthenticatedContext().firestore();
    await check('public new-customer booking/index/slot commit atomically', async () => {
        const batch = writeBatch(visitor);
        batch.set(doc(visitor, 'salons/TEST_STANDARD/customers/public-new'), { ...customer, phone: '+919876543211', source: 'public_booking' });
        batch.set(doc(visitor, 'salons/TEST_STANDARD/customerPhoneIndex/9876543211'), { customerId: 'public-new' });
        batch.set(doc(visitor, 'salons/TEST_STANDARD/appointments/public-new'), { ...appointment, customerId: 'public-new', source: 'public_booking' });
        batch.set(doc(visitor, 'salons/TEST_STANDARD/appointmentSlots/public-new'), { appointmentId: 'public-new', staffName: appointment.staffName, date: appointment.date, time: appointment.time });
        await assertSucceeds(batch.commit());
    });
    await check('public phone lookup is available', () => assertSucceeds(getDoc(doc(visitor, 'salons/TEST_STANDARD/customerPhoneIndex/9876543210'))));
    await check('public booking cannot read existing customer document (current service wrongly requires this)', () => assertFails(getDoc(doc(visitor, 'salons/TEST_STANDARD/customers/existing-public-client'))));
    await probe('public phone index must reject arbitrary customer linkage', () => setDoc(doc(visitor, 'salons/TEST_STANDARD/customerPhoneIndex/1111111111'), { customerId: 'existing-public-client' }));
    await probe('public slot lock must reject reservation with no matching booking', () => setDoc(doc(visitor, 'salons/TEST_STANDARD/appointmentSlots/orphan'), { appointmentId: 'nonexistent', staffName: 'Audit Staff', date: '2026-10-08', time: '10:00' }));
    await probe('Standard wallet balance must not change without matching ledger entry', () => updateDoc(doc(db, 'salons/TEST_STANDARD/customers/existing-public-client'), { walletBalance: 999999 }));
    const businessDb = env.authenticatedContext('TEST_BUSINESS').firestore();
    for (const branch of ['TEST_BUSINESS', 'TEST_BUSINESS_branch2', 'TEST_BUSINESS_branch3']) {
        await check(`${branch}: branch edit and deactivate`, async () => {
            await assertSucceeds(updateDoc(doc(businessDb, `salons/${branch}`), { name: branch + ' edited', active: false }));
            await assertSucceeds(updateDoc(doc(businessDb, `salons/${branch}`), { active: true }));
        });
        await check(`${branch}: customer persisted in branch path`, async () => {
            await assertSucceeds(setDoc(doc(businessDb, `salons/${branch}/customers/isolation`), { ...customer, name: branch }));
            assert.equal((await getDoc(doc(businessDb, `salons/${branch}/customers/isolation`))).data().name, branch);
        });
    }
    const newcomer = env.authenticatedContext('new-owner').firestore();
    await check('new account cannot create admin profile', () => assertFails(setDoc(doc(newcomer, 'users/new-owner'), { role: 'super_admin' })));
    await check('new account can create owner profile', () => assertSucceeds(setDoc(doc(newcomer, 'users/new-owner'), { role: 'salon_owner' })));
    await seed('salons/new-owner-salon', salon('new-owner'));
    const trialStart = Date.now();
    await check('new account can start one 30-day trial', () => assertSucceeds(setDoc(doc(newcomer, 'subscriptions/new-owner'), {
        ownerId: 'new-owner', salonId: 'new-owner-salon', planId: 'trial', status: 'TRIAL', startDate: Timestamp.fromMillis(trialStart), endDate: Timestamp.fromMillis(trialStart + 30 * day), trialStartedAt: Timestamp.fromMillis(trialStart), trialEndsAt: Timestamp.fromMillis(trialStart + 30 * day),
    })));
    await check('trial cannot be restarted', () => assertFails(updateDoc(doc(newcomer, 'subscriptions/new-owner'), { trialEndsAt: Timestamp.fromMillis(Date.now() + 31 * day) })));
    await seed('rewardTransactions/legacy-unscoped', { amount: 100 });
    await check('legacy unscoped rewards cannot leak', () => assertFails(getDoc(doc(newcomer, 'rewardTransactions/legacy-unscoped'))));
    console.log(`SECURITY: ${passed} passed; ${probes.filter(p => p.status === 'FAIL').length} unresolved release probes`);
} finally {
    mkdirSync('audit', { recursive: true });
    writeFileSync('audit/security-results.json', JSON.stringify({ projectId, passed, probes }, null, 2));
    await env.cleanup();
}
if (probes.some(p => p.status === 'FAIL')) process.exitCode = 1;
