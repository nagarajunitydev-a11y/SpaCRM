import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, deleteDoc, Timestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({ projectId: 'demo-spacrm-audit', firestore: { rules: readFileSync('firestore.rules', 'utf8') } });
const owner = 'payment_rules_owner', other = 'payment_rules_other', admin = 'payment_rules_admin';
const ownerDb = env.authenticatedContext(owner).firestore(), otherDb = env.authenticatedContext(other).firestore();
const adminDb = env.authenticatedContext(admin).firestore();
const t = Date.now(), day = 86400000;
let passed = 0;
const check = async (label, work) => { await work(); passed++; console.log(`PASS ${label}`); };
const seed = (path, data) => env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), path), data));
try {
    await seed(`users/${owner}`, { role: 'salon_owner' });
    await seed(`users/${other}`, { role: 'salon_owner' });
    await seed(`users/${admin}`, { role: 'super_admin' });
    await seed(`salons/${owner}`, { ownerId: owner, name: 'Rules fixture', phone: '9999999999', address: 'Test' });
    const sub = { ownerId: owner, planId: 'standard', status: 'ACTIVE', currentPeriodEnd: Timestamp.fromMillis(t + day), graceDays: 3 };
    await seed(`subscriptions/${owner}`, sub);
    await seed(`subscriptions/${owner}/payments/paid`, { status: 'SUCCESS', receiptNumber: 'fixture' });
    for (const db of [ownerDb, adminDb]) await check('Owner/admin may read payment receipt', () => assertSucceeds(getDoc(doc(db, `subscriptions/${owner}/payments/paid`))));
    await check('Other tenant cannot read subscription', () => assertFails(getDoc(doc(otherDb, `subscriptions/${owner}`))));
    await check('Other tenant cannot read receipts', () => assertFails(getDoc(doc(otherDb, `subscriptions/${owner}/payments/paid`))));
    for (const patch of [{ planId: 'business' }, { autoRenew: true }, { graceDays: 30 }, { gatewaySubscriptionId: 'forged' }, { currentPeriodEnd: Timestamp.fromMillis(t + 90 * day) }]) {
        await check('Owner cannot forge server billing metadata', () => assertFails(updateDoc(doc(ownerDb, `subscriptions/${owner}`), patch)));
    }
    await check('Owner cannot restart trial by deletion', () => assertFails(deleteDoc(doc(ownerDb, `subscriptions/${owner}`))));
    for (const root of ['paymentOrders', 'webhookEvents', 'webhookInbox', 'paymentClaims', 'checkoutRequests', 'checkoutLocks', 'recurringPlans', 'gatewayPlanCatalog', 'recurringSubscriptions']) {
        await seed(`${root}/private`, { uid: owner });
        await check(`${root}: client read denied`, () => assertFails(getDoc(doc(ownerDb, `${root}/private`))));
        await check(`${root}: client write denied`, () => assertFails(setDoc(doc(ownerDb, `${root}/private`), { uid: owner })));
    }
    await check('Paid-period deduplication ledger is server-only', () => assertFails(setDoc(doc(ownerDb, `subscriptions/${owner}/paidPeriods/forged`), { paymentId: 'fake' })));
    await check('Payment receipts cannot be forged by owner', () => assertFails(setDoc(doc(ownerDb, `subscriptions/${owner}/payments/forged`), { status: 'SUCCESS' })));
    await check('Payment receipts cannot be modified by admin client', () => assertFails(updateDoc(doc(adminDb, `subscriptions/${owner}/payments/paid`), { amount: 1 })));
    const service = doc(ownerDb, `salons/${owner}/services/grace`);
    for (const [graceDays, expiredDays, cancelled, allowed] of [[0, 1, false, false], [7, 4, false, true], [3, 4, false, false], [7, 1, true, false]]) {
        await seed(`subscriptions/${owner}`, { ...sub, graceDays, currentPeriodEnd: Timestamp.fromMillis(t - expiredDays * day), cancelAtPeriodEnd: cancelled });
        await check(`Server access: grace=${graceDays}, elapsed=${expiredDays}, cancelled=${cancelled}`, () =>
            (allowed ? assertSucceeds : assertFails)(setDoc(service, { name: 'Test', price: 100, duration: '30m' })));
    }
    console.log(`\nPAYMENT SECURITY RULES: ${passed} passed.`);
} finally { await env.cleanup(); }
