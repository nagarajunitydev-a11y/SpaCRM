import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHandlers } from '../api/_lib/handlers.js';
import { createGateway, hmacSha256Hex, GatewayNotConfigured } from '../api/_lib/gateways/razorpay.js';
import { isNativeCheckout } from '../api/_lib/billingPolicy.js';
import { DEFAULT_PLANS, planPrice } from '../public/js/core/plans.js';
import { newTrial, DAY_MS, addPeriod, effectiveStatus } from '../public/js/core/subscriptionState.js';

let passed = 0;
async function check(name, test) { await test(); passed++; console.log(`PASS ${name}`); }
const NOW = Date.UTC(2026, 9, 20, 10);
const SECRET = 'fixture-secret', WEBHOOK = 'fixture-webhook-secret';
const clone = value => value == null ? null : structuredClone(value);
function memoryDb() {
    const docs = new Map();
    let queue = Promise.resolve();
    return {
        get: async path => clone(docs.get(path)),
        set: async (path, data) => docs.set(path, clone(data)),
        list: async path => [...docs.entries()].filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
            .map(([key, value]) => ({ id: key.slice(path.length + 1), ...clone(value) })),
        transaction(fn) {
            const operation = queue.then(async () => {
                const writes = [];
                let writing = false;
                const result = await fn({
                    get: async path => { assert(!writing, 'Firestore requires all reads before writes'); return clone(docs.get(path)); },
                    set: (path, value) => { writing = true; writes.push([path, clone(value)]); },
                });
                for (const [path, value] of writes) docs.set(path, value);
                return result;
            });
            queue = operation.catch(() => {});
            return operation;
        },
    };
}

let realDb;
if (process.env.FIRESTORE_EMULATOR_HOST) {
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) throw new Error('Only a local demo emulator is allowed.');
    const { initializeApp } = await import('firebase-admin/app');
    initializeApp({ projectId: 'demo-spacrm-audit' });
    const { createAdminDb } = await import('../api/_lib/adminDb.js');
    realDb = createAdminDb();
}

async function setup(overrides = {}) {
    const uid = `billing_${randomUUID().replaceAll('-', '')}`;
    // A separate Firestore subtree per fixture prevents one scenario's failed
    // webhook inbox from contaminating another, while exercising real retries.
    const prefix = `paymentTestRuns/${uid}`;
    const db = realDb ? {
        get: path => realDb.get(`${prefix}/${path}`),
        set: (path, value) => realDb.set(`${prefix}/${path}`, value),
        list: path => realDb.list(`${prefix}/${path}`),
        transaction: fn => realDb.transaction(tx => fn({
            get: path => tx.get(`${prefix}/${path}`), set: (path, value) => tx.set(`${prefix}/${path}`, value),
        })),
    } : memoryDb();
    let time = NOW;
    await db.set(`users/${uid}`, { role: 'salon_owner' });
    await db.set(`salons/${uid}`, { ownerId: uid });
    await db.set(`subscriptions/${uid}`, { ...newTrial(uid, NOW - 5 * DAY_MS), salonId: uid, ...overrides });
    let sequence = 0;
    const plans = new Map(), subs = new Map(), payments = new Map(), invoices = new Map(), orders = [];
    const real = createGateway({ RAZORPAY_KEY_ID: 'rzp_test_fixture', RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK });
    const gw = {
        ...real, plans, subs, payments, invoices, orders,
        createPlan: async data => { const id = `plan_${uid}_${++sequence}`; plans.set(id, data); return { id }; },
        createSubscription: async data => { const id = `sub_${uid}_${++sequence}`; const sub = { id, status: 'created', plan_id: data.planId, ...data }; subs.set(id, sub); return clone(sub); },
        fetchSubscription: async id => clone(subs.get(id)),
        fetchPayment: async id => clone(payments.get(id)),
        fetchInvoice: async id => clone(invoices.get(id)),
        fetchInvoices: async (id, skip = 0) => [...invoices.values()].filter(invoice => invoice.subscription_id === id).slice(skip, skip + 100),
        cancelSubscription: async (id, atCycleEnd) => { const sub = subs.get(id); if (!atCycleEnd) sub.status = 'cancelled'; sub.cancelAtCycleEnd = atCycleEnd; return clone(sub); },
        updateSubscription: async (id, planId) => { subs.get(id).scheduledPlan = planId; return clone(subs.get(id)); },
        createOrder: async data => { const order = { id: `order_${uid}_${++sequence}`, ...data }; orders.push(order); return clone(order); },
        capturePayment: async id => { payments.get(id).status = 'captured'; },
    };
    const h = createHandlers({ db, gateway: gw, now: () => time });
    const key = () => randomUUID();
    const create = (planId = 'standard', billingCycle = 'monthly', idempotencyKey = key()) => h.createRecurring({ uid,
        body: { planId, billingCycle, consent: true, salonId: uid, idempotencyKey } });
    const webhook = event => { const rawBody = JSON.stringify(event); return h.webhook({ rawBody, signature: hmacSha256Hex(WEBHOOK, rawBody) }); };
    const life = (id, status, event = `subscription.${status}`, at = time) => webhook({ event, created_at: Math.floor(at / 1000),
        payload: { subscription: { entity: { id, status, plan_id: subs.get(id).plan_id } } } });
    function charged(id, start, end, providerPlan = subs.get(id).plan_id) {
        const paymentId = `pay_${uid}_${++sequence}`, invoiceId = `inv_${uid}_${sequence}`, orderId = `order_${uid}_${sequence}`;
        const plan = plans.get(providerPlan);
        payments.set(paymentId, { id: paymentId, status: 'captured', invoiceId, orderId,
            amountMinor: plan.amountMinor, currency: 'INR', method: 'upi' });
        invoices.set(invoiceId, { id: invoiceId, payment_id: paymentId, subscription_id: id, order_id: orderId, status: 'paid',
            amount_paid: plan.amountMinor, currency: 'INR', billing_start: start / 1000, billing_end: end / 1000,
            line_items: [{ type: 'plan', amount: plan.amountMinor }] });
        Object.assign(subs.get(id), { status: 'active', current_start: start / 1000, current_end: end / 1000 });
        return { event: 'subscription.charged', created_at: Math.floor(time / 1000), payload: {
            subscription: { entity: { id, status: 'active', plan_id: providerPlan, current_start: start / 1000, current_end: end / 1000 } },
            payment: { entity: { id: paymentId } },
        } };
    }
    return { uid, db, gw, h, create, webhook, life, charged, key, setTime: value => { time = value; }, sub: () => db.get(`subscriptions/${uid}`) };
}

for (const planId of ['basic', 'standard', 'premium', 'business']) for (const cycle of ['monthly', 'annual']) {
    await check(`${planId}/${cycle}: trusted recurring price and preserved free trial`, async () => {
        const f = await setup();
        const before = await f.sub();
        const result = await f.create(planId, cycle);
        assert.equal(result.status, 200);
        assert.equal(result.body.amountMinor, planPrice(DEFAULT_PLANS[planId], cycle) * 100);
        assert(result.body.startAt >= before.trialEndsAt);
        assert.equal((await f.sub()).trialEndsAt, before.trialEndsAt);
        assert.equal((await f.sub()).status, 'TRIAL');
    });
}

await check('Mandate authorisation cannot activate paid features; forged mandate signature rejected', async () => {
    const f = await setup();
    const id = (await f.create()).body.subscriptionId;
    f.gw.subs.get(id).status = 'authenticated';
    assert.equal((await f.h.verifyRecurring({ uid: f.uid, body: { subscriptionId: id, paymentId: 'pay_auth', signature: 'bad' } })).status, 400);
    const signature = hmacSha256Hex(SECRET, `pay_auth|${id}`);
    assert.equal((await f.h.verifyRecurring({ uid: f.uid, body: { subscriptionId: id, paymentId: 'pay_auth', signature } })).body.status, 'PENDING');
    assert.equal((await f.sub()).status, 'TRIAL');
});

await check('Concurrent mandate creation and checkout replay never create two mandates', async () => {
    const f = await setup();
    const key = f.key();
    const results = await Promise.all([f.create('standard', 'monthly', key), f.create('standard', 'monthly', key)]);
    // A contending request can see the in-flight reservation (409), or the
    // already-completed response (200) after Firestore retries its transaction.
    assert(results.some(result => result.status === 200));
    assert(results.every(result => [200, 409].includes(result.status)));
    assert.equal(new Set(results.filter(result => result.status === 200).map(result => result.body.subscriptionId)).size, 1);
    assert.equal(f.gw.subs.size, 1);
    assert.equal((await f.create('standard', 'monthly', key)).body.subscriptionId, results.find(result => result.status === 200).body.subscriptionId);
    assert.equal((await f.create('premium', 'annual')).status, 409);
    assert.equal(f.gw.subs.size, 1);
});

await check('Ambiguous provider failure blocks new mandate attempts for operator reconciliation', async () => {
    const f = await setup();
    f.gw.createSubscription = async () => { throw new Error('Connection lost after provider accepted request'); };
    await assert.rejects(f.create(), /Connection lost/);
    assert.equal((await f.create()).body.code, 'RECONCILIATION_REQUIRED');
});

await check('Captured renewal, duplicate delivery, and out-of-order billing periods are idempotent', async () => {
    const f = await setup();
    const id = (await f.create()).body.subscriptionId;
    const start = (await f.sub()).trialEndsAt, end = addPeriod(start, 'monthly'), next = addPeriod(end, 'monthly');
    f.setTime(start);
    const first = f.charged(id, start, end);
    assert.equal((await f.webhook(first)).status, 200);
    assert.equal((await f.webhook(first)).body.duplicate, true);
    f.setTime(end);
    assert.equal((await f.webhook(f.charged(id, end, next))).status, 200);
    const replay = { ...first, created_at: first.created_at + 1 };
    assert.equal((await f.webhook(replay)).status, 200);
    assert.equal((await f.sub()).currentPeriodEnd, next);
    assert.equal((await f.db.list(`subscriptions/${f.uid}/payments`)).length, 2);
    const records = await f.db.list(`subscriptions/${f.uid}/payments`);
    assert(records.every(payment => payment.receiptNumber && payment.gatewayPaymentId));
});

await check('Second captured payment for one billing period cannot extend access twice', async () => {
    const f = await setup();
    const id = (await f.create()).body.subscriptionId;
    const start = (await f.sub()).trialEndsAt, end = addPeriod(start, 'monthly');
    await f.webhook(f.charged(id, start, end));
    assert.equal((await f.webhook(f.charged(id, start, end))).status, 200);
    assert.equal((await f.sub()).currentPeriodEnd, end);
    assert((await f.db.list(`subscriptions/${f.uid}/payments`)).some(payment => payment.requiresReview));
});

await check('Wrong amount, currency, invoice owner, or uncaptured payment never grants access', async () => {
    for (const mutation of ['amount', 'currency', 'owner', 'status']) {
        const f = await setup();
        const id = (await f.create()).body.subscriptionId;
        const start = (await f.sub()).trialEndsAt;
        const event = f.charged(id, start, addPeriod(start, 'monthly'));
        const payment = f.gw.payments.get(event.payload.payment.entity.id);
        if (mutation === 'amount') payment.amountMinor = 1;
        if (mutation === 'currency') payment.currency = 'USD';
        if (mutation === 'owner') f.gw.invoices.get(payment.invoiceId).subscription_id = 'another_owner';
        if (mutation === 'status') payment.status = 'authorized';
        assert.notEqual((await f.webhook(event)).status, 200);
        assert.equal((await f.sub()).status, 'TRIAL');
    }
});

await check('Failed renewals retain only configured grace, then recover on a captured retry', async () => {
    const f = await setup();
    const id = (await f.create()).body.subscriptionId;
    const start = (await f.sub()).trialEndsAt, end = addPeriod(start, 'monthly');
    f.setTime(start);
    await f.webhook(f.charged(id, start, end));
    f.setTime(end + DAY_MS);
    await f.life(id, 'pending');
    assert.equal(effectiveStatus(await f.sub(), end + 2 * DAY_MS), 'GRACE_PERIOD');
    assert.equal(effectiveStatus(await f.sub(), end + 3 * DAY_MS), 'EXPIRED');
    await f.h.syncStatuses();
    await f.webhook(f.charged(id, end, addPeriod(end, 'monthly')));
    assert.equal((await f.sub()).status, 'ACTIVE');
});

await check('Cancellation preserves paid access, stops grace, and ignores older active events', async () => {
    const f = await setup();
    const id = (await f.create()).body.subscriptionId;
    const start = (await f.sub()).trialEndsAt, end = addPeriod(start, 'monthly');
    f.setTime(start);
    await f.webhook(f.charged(id, start, end));
    assert.equal((await f.h.manageRecurring({ uid: f.uid, body: { subscriptionId: id, action: 'cancel' } })).status, 200);
    assert.equal(f.gw.subs.get(id).cancelAtCycleEnd, true);
    assert.equal(effectiveStatus(await f.sub(), end - 1), 'ACTIVE');
    assert.equal(effectiveStatus(await f.sub(), end), 'EXPIRED');
    f.setTime(end);
    await f.life(id, 'cancelled');
    await f.life(id, 'active', 'subscription.activated', start - 1000);
    assert.equal((await f.sub()).autoRenew, false);
});

await check('Automatic upgrades and downgrades change features only on the next paid period', async () => {
    for (const target of ['basic', 'premium']) {
        const f = await setup();
        const id = (await f.create()).body.subscriptionId;
        const start = (await f.sub()).trialEndsAt, end = addPeriod(start, 'monthly');
        f.setTime(start);
        await f.webhook(f.charged(id, start, end));
        assert.equal((await f.h.manageRecurring({ uid: f.uid, body: { subscriptionId: id, action: 'change', planId: target, billingCycle: 'annual' } })).status, 200);
        assert.equal((await f.sub()).planId, 'standard');
        const newPlan = f.gw.subs.get(id).scheduledPlan;
        f.setTime(end);
        await f.webhook(f.charged(id, end, addPeriod(end, 'annual'), newPlan));
        assert.equal((await f.sub()).planId, target);
        assert.equal((await f.sub()).billingCycle, 'annual');
    }
});

await check('A captured charge cannot lift administrator suspension', async () => {
    const f = await setup();
    const id = (await f.create()).body.subscriptionId;
    const start = (await f.sub()).trialEndsAt;
    await f.db.set(`subscriptions/${f.uid}`, { ...await f.sub(), status: 'SUSPENDED' });
    await f.webhook(f.charged(id, start, addPeriod(start, 'monthly')));
    assert.equal((await f.sub()).status, 'SUSPENDED');
});

await check('Other tenants and staff cannot manage a mandate or create a paid checkout', async () => {
    const f = await setup();
    const id = (await f.create()).body.subscriptionId;
    await f.db.set('users/intruder', { role: 'salon_owner' });
    assert.equal((await f.h.manageRecurring({ uid: 'intruder', body: { subscriptionId: id, action: 'cancel' } })).status, 404);
    await f.db.set(`users/${f.uid}`, { role: 'staff' });
    assert.equal((await f.h.createOrder({ uid: f.uid, body: { planId: 'basic', billingCycle: 'monthly' } })).status, 403);
});

await check('Cron recovers a missed charged webhook from verified invoices', async () => {
    const f = await setup();
    const id = (await f.create()).body.subscriptionId;
    const start = (await f.sub()).trialEndsAt;
    f.charged(id, start, addPeriod(start, 'monthly'));
    await f.h.reconcileRecurring();
    assert.equal((await f.sub()).status, 'ACTIVE');
    await f.h.reconcileRecurring();
    assert.equal((await f.db.list(`subscriptions/${f.uid}/payments`)).length, 1);
});

await check('Native checkout policy detects WebView and native platform headers, preserves Android browser checkout', async () => {
    const request = headers => new Request('https://example.test', { headers });
    assert(isNativeCheckout(request({ 'user-agent': 'Mozilla/5.0 (Linux; Android 16; wv)' })));
    assert(isNativeCheckout(request({ 'user-agent': 'QvrixGlowOSAndroid/1' })));
    assert(isNativeCheckout(request({ 'x-qvrix-platform': 'android' })));
    assert(!isNativeCheckout(request({ 'user-agent': 'Mozilla/5.0 (Linux; Android 16) Chrome' })));
});

await check('Razorpay adapter uses test-only keys and correct mandate HMAC / API contract', async () => {
    const calls = [];
    const gw = createGateway({ RAZORPAY_KEY_ID: 'rzp_test_fixture', RAZORPAY_KEY_SECRET: SECRET }, async (url, init) => {
        calls.push({ url, ...init, body: init.body && JSON.parse(init.body) });
        return { ok: true, json: async () => ({ id: 'fixture' }) };
    });
    await gw.createPlan({ name: 'Standard', amountMinor: 79900, currency: 'INR', billingCycle: 'annual' });
    assert.equal(calls[0].body.period, 'yearly');
    await gw.createSubscription({ planId: 'plan_fixture', startAt: NOW, billingCycle: 'annual', notes: {} });
    assert.equal(calls[1].body.total_count, 10);
    await gw.updateSubscription('sub_fixture', 'plan_premium');
    assert.equal(calls[2].body.schedule_change_at, 'cycle_end');
    await gw.cancelSubscription('sub_fixture', false);
    assert.equal(calls[3].body.cancel_at_cycle_end, false);
    assert(gw.verifySubscriptionSignature('sub_fixture', 'pay_fixture', hmacSha256Hex(SECRET, 'pay_fixture|sub_fixture')));
    const live = createGateway({ RAZORPAY_KEY_ID: 'rzp_live_fixture', RAZORPAY_KEY_SECRET: SECRET });
    assert.throws(() => live.publicKey(), GatewayNotConfigured);
    const productionTest = createGateway({ RAZORPAY_KEY_ID: 'rzp_test_fixture', RAZORPAY_KEY_SECRET: SECRET, VERCEL_ENV: 'production' });
    assert.throws(() => productionTest.publicKey(), GatewayNotConfigured);
});

await check('Manual checkout keys are idempotent and simultaneous paid orders cannot extend twice', async () => {
    const f = await setup();
    const key = f.key();
    const create = idempotencyKey => f.h.createOrder({ uid: f.uid, body: { planId: 'standard', billingCycle: 'monthly', idempotencyKey } });
    const first = (await create(key)).body;
    assert.equal((await create(key)).body.orderId, first.orderId);
    assert.equal(f.gw.orders.length, 1);
    const second = (await create(f.key())).body;
    for (const [i, order] of [first, second].entries()) f.gw.payments.set(`pay_manual_${i}`, {
        id: `pay_manual_${i}`, orderId: order.orderId, amountMinor: order.amountMinor, currency: 'INR', status: 'captured', method: 'upi',
    });
    const results = await Promise.all([first, second].map((order, i) => f.h.verifyPayment({ uid: f.uid, body: {
        orderId: order.orderId, paymentId: `pay_manual_${i}`, signature: hmacSha256Hex(SECRET, `${order.orderId}|pay_manual_${i}`),
    } })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 202]);
    assert.equal((await f.sub()).currentPeriodEnd, addPeriod(NOW, 'monthly'));
    assert.equal((await f.db.list(`subscriptions/${f.uid}/payments`)).filter(payment => payment.requiresReview).length, 1);
});

await check('Failed automatic attempts enter payment history without exposing payment credentials', async () => {
    const f = await setup();
    const id = (await f.create()).body.subscriptionId;
    const start = (await f.sub()).trialEndsAt;
    const charged = f.charged(id, start, addPeriod(start, 'monthly'));
    const paymentId = charged.payload.payment.entity.id;
    const payment = f.gw.payments.get(paymentId);
    payment.status = 'failed';
    const event = { event: 'payment.failed', created_at: NOW / 1000,
        payload: { payment: { entity: { id: paymentId, invoice_id: payment.invoiceId, order_id: payment.orderId, error_description: 'Failure' } } } };
    assert.equal((await f.webhook(event)).status, 200);
    const history = await f.db.list(`subscriptions/${f.uid}/payments`);
    assert.equal(history.length, 1);
    assert.equal(history[0].status, 'FAILED');
    assert(!Object.keys(history[0]).some(key => /card|cvv|pin|credential|secret|signature/i.test(key)));
    assert.equal((await f.sub()).status, 'TRIAL');
});

await check('Forged webhook bytes and modified signatures cannot activate automatic access', async () => {
    const f = await setup();
    const id = (await f.create()).body.subscriptionId;
    const start = (await f.sub()).trialEndsAt;
    const rawBody = JSON.stringify(f.charged(id, start, addPeriod(start, 'monthly')));
    assert.equal((await f.h.webhook({ rawBody, signature: '00'.repeat(32) })).status, 401);
    assert.equal((await f.h.webhook({ rawBody: rawBody + ' ', signature: hmacSha256Hex(WEBHOOK, rawBody) })).status, 401);
    assert.equal((await f.sub()).status, 'TRIAL');
});

await check('Manual renewal after cancellation is not changed by a late mandate-cancelled event', async () => {
    const f = await setup();
    const id = (await f.create()).body.subscriptionId;
    const start = (await f.sub()).trialEndsAt, end = addPeriod(start, 'monthly');
    f.setTime(start);
    await f.webhook(f.charged(id, start, end));
    await f.h.manageRecurring({ uid: f.uid, body: { subscriptionId: id, action: 'cancel' } });
    const order = (await f.h.createOrder({ uid: f.uid, body: { planId: 'standard', billingCycle: 'monthly' } })).body;
    f.gw.payments.set('pay_manual_after_cancel', { orderId: order.orderId, status: 'captured', amountMinor: order.amountMinor, currency: 'INR' });
    assert.equal((await f.h.verifyPayment({ uid: f.uid, body: { orderId: order.orderId, paymentId: 'pay_manual_after_cancel',
        signature: hmacSha256Hex(SECRET, `${order.orderId}|pay_manual_after_cancel`) } })).status, 200);
    await f.life(id, 'cancelled');
    assert.equal((await f.sub()).cancelAtPeriodEnd, false);
    assert.equal((await f.sub()).gatewaySubscriptionId, null);
    assert.equal((await f.sub()).currentPeriodEnd, addPeriod(end, 'monthly'));
});

await check('Explicit zero and extended grace periods match effective access boundaries', async () => {
    const base = { status: 'ACTIVE', planId: 'standard', currentPeriodEnd: NOW };
    assert.equal(effectiveStatus({ ...base, graceDays: 0 }, NOW), 'EXPIRED');
    assert.equal(effectiveStatus({ ...base, graceDays: 7 }, NOW + 4 * DAY_MS), 'GRACE_PERIOD');
    assert.equal(effectiveStatus({ ...base, graceDays: 7, cancelAtPeriodEnd: true }, NOW), 'EXPIRED');
});

await check('Signed provider events recover an accepted mandate after an HTTP timeout', async () => {
    const f = await setup();
    const create = f.gw.createSubscription;
    f.gw.createSubscription = async body => { await create(body); throw new Error('Lost provider response'); };
    const key = f.key();
    await assert.rejects(f.create('standard', 'monthly', key), /Lost provider response/);
    const id = [...f.gw.subs.keys()][0];
    f.gw.subs.get(id).status = 'authenticated';
    assert.equal((await f.life(id, 'authenticated')).status, 200);
    assert.equal((await f.create('standard', 'monthly', key)).body.subscriptionId, id);
    assert.equal(f.gw.subs.size, 1);
    assert.equal((await f.sub()).status, 'TRIAL');
});

await check('An unfinished mandate can resume after a page reload without creating a second mandate', async () => {
    const f = await setup();
    const id = (await f.create()).body.subscriptionId;
    const result = await f.h.createRecurring({ uid: f.uid, body: { resumeSubscriptionId: id, consent: true } });
    assert.equal(result.status, 200);
    assert.equal(result.body.subscriptionId, id);
    assert.equal(f.gw.subs.size, 1);
});

await check('A refund delivered before capture cannot later activate a paid period', async () => {
    const f = await setup();
    const order = (await f.h.createOrder({ uid: f.uid, body: { planId: 'basic', billingCycle: 'monthly' } })).body;
    f.gw.payments.set('pay_refunded', { orderId: order.orderId, status: 'refunded', amountMinor: order.amountMinor,
        refundedAmountMinor: order.amountMinor, currency: 'INR' });
    await f.webhook({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_fixture', payment_id: 'pay_refunded', amount: order.amountMinor } } } });
    await f.webhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_refunded', order_id: order.orderId, amount: order.amountMinor, currency: 'INR' } } } });
    assert.equal((await f.sub()).status, 'TRIAL');
    assert.equal((await f.db.get(`subscriptions/${f.uid}/payments/${order.orderId}`)).status, 'REFUNDED');
});

console.log(`\nRECURRING PAYMENTS: ${passed} scenarios passed (${realDb ? 'Firestore emulator transactions' : 'serialized in-memory transactions'}).`);
