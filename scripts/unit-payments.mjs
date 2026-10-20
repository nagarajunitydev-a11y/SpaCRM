/**
 * unit-payments.mjs
 * Server-side payment handlers + subscription state machine, run against an
 * in-memory db and a scripted gateway. No network, no Firebase, no gateway
 * account. Real HMAC signatures are generated/verified with the Razorpay
 * gateway module.
 *
 * Usage: node scripts/unit-payments.mjs
 */
import { createHandlers } from '../api/_lib/handlers.js';
import { createGateway, hmacSha256Hex, GatewayNotConfigured } from '../api/_lib/gateways/razorpay.js';
import { DEFAULT_PLANS } from '../public/js/core/plans.js';
import { DAY_MS, addPeriod, newTrial, effectiveStatus, quotePurchase } from '../public/js/core/subscriptionState.js';

let pass = 0; let fail = 0;
const t = (c, l) => { if (c) { pass += 1; console.log('  PASS  ' + l); } else { fail += 1; console.log('  FAIL  ' + l); } };

/* ---------- in-memory db ---------- */
function makeDb(seed = {}) {
    const docs = new Map(Object.entries(seed));
    const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
    return {
        docs,
        async get(p) { return clone(docs.get(p)); },
        async set(p, d) { docs.set(p, clone(d)); },
        async list(col) {
            return [...docs.entries()]
                .filter(([k]) => k.startsWith(col + '/') && !k.slice(col.length + 1).includes('/'))
                .map(([k, v]) => ({ id: k.slice(col.length + 1), ...clone(v) }));
        },
        async transaction(fn) {
            const writes = [];
            const res = await fn({
                get: async (p) => clone(docs.get(p)),
                set: (p, d) => writes.push([p, clone(d)]),
            });
            writes.forEach(([p, d]) => docs.set(p, d)); // commit only if fn did not throw
            return res;
        },
    };
}

/* ---------- scripted gateway ---------- */
const SECRET = 'key_secret';
const WH = 'wh_secret';
function makeGateway() {
    const real = createGateway({ RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: WH }, async () => { throw new Error('no network'); });
    let n = 0;
    const payments = new Map();
    return {
        id: 'razorpay',
        orders: [],
        payments,
        publicKey: () => 'rzp_test_x',
        verifyCheckoutSignature: real.verifyCheckoutSignature,
        verifyWebhookSignature: real.verifyWebhookSignature,
        parseWebhook: real.parseWebhook,
        async createOrder(o) { n += 1; const id = `order_T${n}000000`; this.orders.push({ id, ...o }); return { id, amountMinor: o.amountMinor, currency: o.currency }; },
        async fetchPayment(id) { return payments.get(id); },
        async capturePayment(id) { const p = payments.get(id); p.status = 'captured'; },
    };
}
const sign = (orderId, payId) => hmacSha256Hex(SECRET, `${orderId}|${payId}`);

const NOW = Date.UTC(2026, 9, 7, 10, 0, 0);
let clock = NOW;
const UID = 'owner1';
const trialSub = () => ({ ...newTrial(UID, NOW - 5 * DAY_MS) });

async function setup(sub = trialSub()) {
    const seed = { [`users/${UID}`]: { role: 'salon_owner' }, 'salons/s1': { ownerId: UID }, 'salons/other': { ownerId: 'someoneElse' } };
    if (sub) seed[`subscriptions/${UID}`] = sub;
    const db = makeDb(seed);
    const gw = makeGateway();
    clock = NOW;
    const h = createHandlers({ db, gateway: gw, now: () => clock });
    return { db, gw, h };
}
const pay = (gw, orderId, paymentId, status = 'captured', over = {}) => {
    const o = gw.orders.find((x) => x.id === orderId);
    gw.payments.set(paymentId, { id: paymentId, orderId, status, amountMinor: o.amountMinor, currency: 'INR', method: 'upi', errorDescription: null, ...over });
};
const whBody = (event, entity, kind = 'payment') => JSON.stringify({ event, payload: { [kind]: { entity: { currency: 'INR', ...entity } } } });
const sendWh = (h, body, eventId, sig) => h.webhook({ rawBody: body, signature: sig === undefined ? hmacSha256Hex(WH, body) : sig, eventId });
const verify = (h, orderId, payId) => h.verifyPayment({ uid: UID, body: { orderId, paymentId: payId, signature: sign(orderId, payId) } });

/* ================= pricing is server-side ================= */
{
    const { h, gw } = await setup();
    const r = await h.createOrder({ uid: UID, email: 'a@b.c', body: { planId: 'standard', billingCycle: 'monthly', amount: 1, salonId: 's1' } });
    t(r.status === 200 && r.body.amountMinor === 79900, 'client-supplied amount ignored: Rs 799 charged for Standard monthly');
    t(gw.orders[0].currency === 'INR' && gw.orders[0].amountMinor === 79900, 'gateway order created in INR paise');
    const a = await h.createOrder({ uid: UID, email: '', body: { planId: 'premium', billingCycle: 'annual' } });
    t(a.body.amountMinor === 1499000, 'annual Premium = Rs 14,990');
    t((await h.createOrder({ uid: UID, body: { planId: 'trial', billingCycle: 'monthly' } })).status === 400, 'cannot buy the trial plan');
    t((await h.createOrder({ uid: UID, body: { planId: 'basic', billingCycle: 'weekly' } })).status === 400, 'invalid billing cycle rejected');
    t((await h.createOrder({ uid: UID, body: { planId: 'basic', billingCycle: 'monthly', salonId: 'other' } })).status === 403, 'a salon owned by someone else is rejected');
}

/* ================= success activates only after verification ================= */
{
    const { h, gw, db } = await setup();
    const o = (await h.createOrder({ uid: UID, body: { planId: 'standard', billingCycle: 'monthly', salonId: 's1' } })).body;
    t((await db.get(`subscriptions/${UID}/payments/${o.orderId}`)).status === 'PENDING', 'new order is PENDING');
    t((await db.get(`subscriptions/${UID}`)).status === 'TRIAL', 'subscription unchanged while PENDING');

    pay(gw, o.orderId, 'pay_1');
    let r = await h.verifyPayment({ uid: UID, body: { orderId: o.orderId, paymentId: 'pay_1', signature: 'deadbeef' } });
    t(r.status === 400 && (await db.get(`subscriptions/${UID}`)).status === 'TRIAL', 'forged signature rejected, nothing activated');

    pay(gw, o.orderId, 'pay_1', 'created');
    r = await verify(h, o.orderId, 'pay_1');
    t(r.status === 202 && (await db.get(`subscriptions/${UID}`)).status === 'TRIAL', 'valid signature but not captured -> still pending');

    pay(gw, o.orderId, 'pay_1', 'captured', { orderId: 'order_OTHER' });
    r = await verify(h, o.orderId, 'pay_1');
    t(r.status === 400, 'payment belonging to another order rejected');

    pay(gw, o.orderId, 'pay_1', 'captured');
    r = await verify(h, o.orderId, 'pay_1');
    const sub = await db.get(`subscriptions/${UID}`);
    t(r.status === 200 && r.body.status === 'SUCCESS', 'verified payment -> SUCCESS');
    t(sub.status === 'ACTIVE' && sub.planId === 'standard' && sub.billingCycle === 'monthly', 'subscription ACTIVE on Standard/monthly');
    t(sub.currentPeriodEnd === addPeriod(NOW, 'monthly'), 'period = 1 calendar month from payment');
    const p1 = await db.get(`subscriptions/${UID}/payments/${o.orderId}`);
    t(p1.status === 'SUCCESS' && p1.gatewayPaymentId === 'pay_1' && p1.method === 'upi' && /^RCPT-20261007-/.test(p1.receiptNumber), 'payment SUCCESS with method + receipt number');
    t(!JSON.stringify([...db.docs.values()]).match(/cvv|card_number|"pin"/i), 'no sensitive card/UPI credential fields stored');

    const end = sub.currentPeriodEnd;
    r = await verify(h, o.orderId, 'pay_1');
    t(r.body.duplicate === true && (await db.get(`subscriptions/${UID}`)).currentPeriodEnd === end, 'repeat verify is a no-op (no double activation)');

    const body = whBody('payment.captured', { id: 'pay_1', order_id: o.orderId, amount: o.amountMinor, method: 'upi' });
    const w = await sendWh(h, body, 'evt_1');
    const w2 = await sendWh(h, body, 'evt_1');
    t(w.status === 200 && w2.body.duplicate === true, 'repeated webhook event id deduped');
    const w3 = await sendWh(h, body, 'evt_2');
    t(w3.status === 200 && (await db.get(`subscriptions/${UID}`)).currentPeriodEnd === end, 'same payment re-delivered under a new event id is still idempotent');
    t((await sendWh(h, body, 'evt_9', 'bad')).status === 401, 'webhook with bad signature rejected');
}

/* ================= webhook-only activation (browser closed) ================= */
{
    const { h, db } = await setup();
    const o = (await h.createOrder({ uid: UID, body: { planId: 'basic', billingCycle: 'annual' } })).body;
    await sendWh(h, whBody('payment.captured', { id: 'pay_W', order_id: o.orderId, amount: o.amountMinor, method: 'card' }), 'evtW');
    const sub = await db.get(`subscriptions/${UID}`);
    t(sub.status === 'ACTIVE' && sub.planId === 'basic' && sub.currentPeriodEnd === addPeriod(NOW, 'annual'), 'webhook activates when the browser never returned (annual)');
    const o2 = (await h.createOrder({ uid: UID, body: { planId: 'basic', billingCycle: 'monthly' } })).body;
    await sendWh(h, whBody('payment.captured', { id: 'pay_X', order_id: o2.orderId, amount: 100, method: 'upi' }), 'evtX');
    t((await db.get(`subscriptions/${UID}/payments/${o2.orderId}`)).status === 'PENDING', 'mismatched amount never activates');
}

/* ================= failure / cancellation keep existing access ================= */
{
    const { h, gw, db } = await setup();
    const o = (await h.createOrder({ uid: UID, body: { planId: 'standard', billingCycle: 'monthly' } })).body;
    pay(gw, o.orderId, 'pay_F', 'failed', { errorDescription: 'Insufficient funds' });
    const r = await verify(h, o.orderId, 'pay_F');
    t(r.body.status === 'FAILED', 'failed payment reported as FAILED');
    t((await db.get(`subscriptions/${UID}`)).status === 'TRIAL', 'failure leaves the trial subscription untouched');
    t((await db.get(`subscriptions/${UID}/payments/${o.orderId}`)).failureReason === 'Insufficient funds', 'failure reason stored');
    pay(gw, o.orderId, 'pay_F2', 'captured');
    await verify(h, o.orderId, 'pay_F2');
    t((await db.get(`subscriptions/${UID}`)).status === 'ACTIVE', 'retry on the same order after a failure activates');
    await sendWh(h, whBody('payment.failed', { id: 'pay_F', order_id: o.orderId, error_description: 'late' }), 'late');
    t((await db.get(`subscriptions/${UID}/payments/${o.orderId}`)).status === 'SUCCESS', 'late failed webhook cannot overwrite SUCCESS');

    const o3 = (await h.createOrder({ uid: UID, body: { planId: 'standard', billingCycle: 'monthly' } })).body;
    const c = await h.cancelOrder({ uid: UID, body: { orderId: o3.orderId } });
    t(c.body.status === 'CANCELLED', 'abandoned checkout -> CANCELLED');
    t((await h.cancelOrder({ uid: UID, body: { orderId: o.orderId } })).body.duplicate === true, 'a SUCCESS payment cannot be cancelled');
    t((await db.get(`subscriptions/${UID}`)).status === 'ACTIVE', 'cancellation does not alter the active subscription');
    t((await h.cancelOrder({ uid: 'intruder', body: { orderId: o.orderId } })).status === 404, "another account cannot touch this owner's order");
}

/* ================= renewal / upgrade / downgrade ================= */
{
    const { h, gw, db } = await setup();
    const buy = async (planId, cycle, id) => {
        const o = await h.createOrder({ uid: UID, body: { planId, billingCycle: cycle } });
        if (o.status !== 200) return o;
        pay(gw, o.body.orderId, id);
        await verify(h, o.body.orderId, id);
        return o;
    };
    await buy('standard', 'monthly', 'pay_a');
    const end1 = (await db.get(`subscriptions/${UID}`)).currentPeriodEnd;
    clock = NOW + 10 * DAY_MS;
    const ren = await buy('standard', 'monthly', 'pay_b');
    t(ren.body.kind === 'renewal', 'same plan mid-period is a renewal');
    t((await db.get(`subscriptions/${UID}`)).currentPeriodEnd === addPeriod(end1, 'monthly'), 'renewal extends from the current period end (no lost days)');
    clock = NOW + 12 * DAY_MS;
    const up = await h.createOrder({ uid: UID, body: { planId: 'premium', billingCycle: 'monthly' } });
    t(up.body.kind === 'upgrade' && up.body.credit > 0 && up.body.amountMinor < 149900, 'upgrade mid-period is credited for unused time');
    pay(gw, up.body.orderId, 'pay_c');
    await verify(h, up.body.orderId, 'pay_c');
    const s = await db.get(`subscriptions/${UID}`);
    t(s.planId === 'premium' && s.currentPeriodStart === clock, 'upgrade switches plan immediately with a new period from now');
    const dn = await h.createOrder({ uid: UID, body: { planId: 'basic', billingCycle: 'monthly' } });
    t(dn.status === 409 && dn.body.code === 'DOWNGRADE_BLOCKED', 'downgrade refused while a higher plan is paid');
    clock = s.currentPeriodEnd + 5 * DAY_MS;
    const dn2 = await h.createOrder({ uid: UID, body: { planId: 'basic', billingCycle: 'monthly' } });
    t(dn2.status === 200 && dn2.body.kind === 'new', 'after the paid period ends a lower plan can be bought');
}

/* ================= refund ================= */
{
    const { h, gw, db } = await setup();
    const o = (await h.createOrder({ uid: UID, body: { planId: 'standard', billingCycle: 'monthly' } })).body;
    pay(gw, o.orderId, 'pay_R');
    await verify(h, o.orderId, 'pay_R');
    await sendWh(h, whBody('refund.processed', { id: 'rfnd_1', payment_id: 'pay_R', amount: o.amountMinor }, 'refund'), 'rf1');
    const p = await db.get(`subscriptions/${UID}/payments/${o.orderId}`);
    const s = await db.get(`subscriptions/${UID}`);
    t(p.status === 'REFUNDED', 'full refund -> payment REFUNDED');
    t(s.status === 'CANCELLED' && effectiveStatus(s, clock + 1000) === 'EXPIRED', 'refunded period no longer grants access');
    await sendWh(h, whBody('refund.processed', { id: 'rfnd_2', payment_id: 'pay_R', amount: 100 }, 'refund'), 'rf2');
    t((await db.get(`subscriptions/${UID}/payments/${o.orderId}`)).status === 'REFUNDED', 'a later partial-refund event does not reopen a refunded payment');
}

/* ================= trial / expiry / cron ================= */
{
    const trial = newTrial(UID, NOW);
    t(trial.trialEndsAt - trial.trialStartedAt === 30 * DAY_MS, 'trial lasts 30 days');
    t(effectiveStatus(trial, NOW + 29 * DAY_MS) === 'TRIAL', 'day 29 still TRIAL');
    t(effectiveStatus(trial, NOW + 31 * DAY_MS) === 'EXPIRED', 'day 31 EXPIRED');
    const paid = { ...trial, status: 'ACTIVE', planId: 'basic', currentPeriodStart: NOW, currentPeriodEnd: NOW + 30 * DAY_MS };
    t(effectiveStatus(paid, NOW + 31 * DAY_MS) === 'GRACE_PERIOD', 'day after period end -> GRACE_PERIOD');
    t(effectiveStatus(paid, NOW + 34 * DAY_MS) === 'EXPIRED', 'after grace -> EXPIRED');
    t(effectiveStatus({ ...paid, status: 'SUSPENDED' }, NOW) === 'SUSPENDED', 'SUSPENDED stays suspended');
    t(quotePurchase({ ...paid, status: 'SUSPENDED' }, 'basic', 'monthly', DEFAULT_PLANS, NOW).ok === false, 'a suspended account cannot buy');

    const db = makeDb({ 'subscriptions/a': { ...trial, ownerId: 'a' }, 'subscriptions/b': { ...paid, ownerId: 'b' } });
    const h = createHandlers({ db, gateway: makeGateway(), now: () => NOW + 31 * DAY_MS });
    const r = await h.syncStatuses();
    t(r.body.changed === 2, 'cron persists TRIAL->EXPIRED and ACTIVE->GRACE_PERIOD');
    t((await db.get('subscriptions/a')).status === 'EXPIRED' && (await db.get('subscriptions/b')).status === 'GRACE_PERIOD', 'cron statuses written');
    t((await h.syncStatuses()).body.changed === 0, 'cron is idempotent');
}

/* ================= gateway module ================= */
{
    const g = createGateway({}, async () => { throw new Error('x'); });
    let threw = false;
    try { await g.createOrder({ amountMinor: 100, currency: 'INR' }); } catch (e) { threw = e instanceof GatewayNotConfigured; }
    t(threw, 'no keys configured -> GatewayNotConfigured (never a fake success)');
    const calls = [];
    const g2 = createGateway({ RAZORPAY_KEY_ID: 'rzp_test_fixture', RAZORPAY_KEY_SECRET: 's' }, async (url, init) => { calls.push([url, init]); return { ok: true, json: async () => ({ id: 'order_Z', amount: 5000, currency: 'INR' }) }; });
    const ord = await g2.createOrder({ amountMinor: 5000, currency: 'INR', receipt: 'r', notes: {} });
    t(ord.id === 'order_Z' && calls[0][0] === 'https://api.razorpay.com/v1/orders' && /^Basic /.test(calls[0][1].headers.Authorization), 'createOrder POSTs to the Razorpay Orders API with basic auth');
}

/* Release audit: verify every price/cycle through the server handler. */
for (const planId of ['basic', 'standard', 'premium', 'business']) {
    for (const billingCycle of ['monthly', 'annual']) {
        const { h, gw, db } = await setup();
        const order = (await h.createOrder({ uid: UID, body: { planId, billingCycle, amount: 1 } })).body;
        const expected = DEFAULT_PLANS[planId][billingCycle === 'annual' ? 'priceAnnual' : 'priceMonthly'] * 100;
        t(order.amountMinor === expected && order.currency === 'INR', `${planId}/${billingCycle}: server amount and currency`);
        pay(gw, order.orderId, 'pay_cycle');
        await verify(h, order.orderId, 'pay_cycle');
        const record = await db.get(`subscriptions/${UID}`);
        t(record.planId === planId && record.billingCycle === billingCycle && record.status === 'ACTIVE' && record.currentPeriodEnd === addPeriod(NOW, billingCycle), `${planId}/${billingCycle}: verified activation and renewal date`);
    }
}
{
    const { h, db } = await setup();
    const order = (await h.createOrder({ uid: UID, body: { planId: 'basic', billingCycle: 'monthly' } })).body;
    await sendWh(h, whBody('payment.captured', { id: 'pay_currency', order_id: order.orderId, amount: order.amountMinor, currency: 'USD' }), 'wrong_currency');
    t((await db.get(`subscriptions/${UID}`)).status === 'TRIAL', 'signed webhook with wrong currency cannot activate');
    await sendWh(h, whBody('payment.captured', { id: 'pay_currency', order_id: order.orderId, amount: order.amountMinor, currency: undefined }), 'missing_currency');
    t((await db.get(`subscriptions/${UID}`)).status === 'TRIAL', 'signed webhook without currency cannot activate');
}
{
    const { h, gw, db } = await setup();
    const order = (await h.createOrder({ uid: UID, body: { planId: 'basic', billingCycle: 'monthly' } })).body;
    pay(gw, order.orderId, 'pay_suspended');
    await db.set(`subscriptions/${UID}`, { ...trialSub(), status: 'SUSPENDED' });
    await verify(h, order.orderId, 'pay_suspended');
    t((await db.get(`subscriptions/${UID}`)).status === 'SUSPENDED', 'old captured order cannot lift administrative suspension');
    t(!gw.verifyCheckoutSignature(order.orderId, 'pay_suspended', sign(order.orderId, 'pay_suspended') + 'zz'), 'HMAC signature with trailing non-hex bytes rejected');
}

console.log(`\nUNIT PAYMENTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
