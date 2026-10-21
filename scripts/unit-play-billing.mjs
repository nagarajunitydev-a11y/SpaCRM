/**
 * unit-play-billing.mjs
 * Google Play alternative billing with user choice (Android app), run against
 * an in-memory db, the scripted Razorpay gateway used by unit-payments.mjs and
 * a scripted Google Play Developer API behind the real googlePlay.js client
 * (real RS256 service-account JWTs). No network, no Firebase, no Play account.
 *
 * Usage: node scripts/unit-play-billing.mjs
 */
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { register } from 'node:module';
import { createHandlers } from '../api/_lib/handlers.js';
import { createPlayClient, PlayNotConfigured } from '../api/_lib/googlePlay.js';
import { nativeCallAllowed, altBillingEnabled } from '../api/_lib/billingPolicy.js';
import { createGateway, hmacSha256Hex } from '../api/_lib/gateways/razorpay.js';
import { DAY_MS, newTrial } from '../public/js/core/subscriptionState.js';

let pass = 0; let fail = 0;
const t = (c, l) => { if (c) { pass += 1; console.log('  PASS  ' + l); } else { fail += 1; console.log('  FAIL  ' + l); } };

/* ---------- in-memory db (same contract as unit-payments.mjs) ---------- */
function makeDb(seed = {}) {
    const docs = new Map(Object.entries(seed));
    const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
    return {
        docs,
        async get(p) { return clone(docs.get(p)); },
        async set(p, d) { docs.set(p, clone(d)); },
        async list(col) {
            return [...docs.entries()].filter(([k]) => k.startsWith(col + '/') && !k.slice(col.length + 1).includes('/'))
                .map(([k, v]) => ({ id: k.slice(col.length + 1), ...clone(v) }));
        },
        async transaction(fn) {
            const writes = [];
            const res = await fn({ get: async (p) => clone(docs.get(p)), set: (p, d) => writes.push([p, clone(d)]) });
            writes.forEach(([p, d]) => docs.set(p, d));
            return res;
        },
    };
}

/* ---------- scripted Razorpay ---------- */
const SECRET = 'key_secret';
function makeGateway() {
    const real = createGateway({ RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: 'wh' }, async () => { throw new Error('no network'); });
    let n = 0;
    const payments = new Map();
    return {
        id: 'razorpay', orders: [], payments,
        publicKey: () => 'rzp_test_x',
        verifyCheckoutSignature: real.verifyCheckoutSignature,
        verifyWebhookSignature: real.verifyWebhookSignature,
        parseWebhook: real.parseWebhook,
        async createOrder(o) { n += 1; const id = `order_P${n}000000`; this.orders.push({ id, ...o }); return { id, amountMinor: o.amountMinor, currency: o.currency }; },
        async fetchPayment(id) { return payments.get(id); },
        async capturePayment(id) { payments.get(id).status = 'captured'; },
    };
}

/* ---------- scripted Google Play Developer API ---------- */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = { client_email: 'play@test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const PKG = 'com.luxeglow.crm';
const RTDN = 'rtdn-secret-0123456789';
function makeGoogle() {
    const g = { subs: new Map(), acks: [], reports: new Map(), failReports: 0, jwtOk: true };
    g.fetch = async (url, init = {}) => {
        const respond = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
        if (url === 'https://oauth2.googleapis.com/token') {
            const assertion = new URLSearchParams(init.body.toString()).get('assertion');
            const [h, c, sig] = assertion.split('.');
            g.jwtOk = g.jwtOk && createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, sig, 'base64url')
                && JSON.parse(Buffer.from(c, 'base64url')).scope === 'https://www.googleapis.com/auth/androidpublisher';
            return respond(200, { access_token: 'tok', expires_in: 3600 });
        }
        if (init.headers?.Authorization !== 'Bearer tok') return respond(401, { error: { message: 'unauthenticated' } });
        const u = new URL(url);
        const base = `/androidpublisher/v3/applications/${PKG}`;
        let m;
        if ((m = u.pathname.match(new RegExp(`^${base}/purchases/subscriptionsv2/tokens/(.+)$`)))) {
            const s = g.subs.get(decodeURIComponent(m[1]));
            return s ? respond(200, JSON.parse(JSON.stringify(s))) : respond(404, { error: { message: 'not found' } });
        }
        if ((m = u.pathname.match(new RegExp(`^${base}/purchases/subscriptions/([^/]+)/tokens/(.+):acknowledge$`)))) {
            const tok = decodeURIComponent(m[2]);
            g.acks.push(tok);
            g.subs.get(tok).acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
            return respond(200, {});
        }
        if (u.pathname === `${base}/externalTransactions`) {
            if (g.failReports > 0) { g.failReports -= 1; return respond(503, { error: { message: 'unavailable' } }); }
            const id = u.searchParams.get('externalTransactionId');
            if (g.reports.has(id)) return respond(409, { error: { message: 'exists' } });
            g.reports.set(id, JSON.parse(init.body));
            return respond(200, { externalTransactionId: id });
        }
        return respond(404, { error: { message: `unexpected ${url}` } });
    };
    return g;
}
const ENV = {
    GOOGLE_PLAY_ALT_BILLING_ENABLED: 'true', GOOGLE_PLAY_PACKAGE_NAME: PKG,
    GOOGLE_PLAY_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(SA)).toString('base64'),
    GOOGLE_PLAY_TAX_PERCENT: '18', GOOGLE_PLAY_RTDN_SECRET: RTDN,
};

const NOW = Date.UTC(2026, 9, 21, 6, 0, 0);
const UID = 'owner1';
const OTHER = 'owner2';
async function setup({ env = ENV } = {}) {
    const seed = {
        [`users/${UID}`]: { role: 'salon_owner' }, [`users/${OTHER}`]: { role: 'salon_owner' },
        [`subscriptions/${UID}`]: newTrial(UID, NOW - 3 * DAY_MS), [`subscriptions/${OTHER}`]: newTrial(OTHER, NOW - 3 * DAY_MS),
    };
    const db = makeDb(seed);
    const gw = makeGateway();
    const google = makeGoogle();
    const clock = { now: NOW };
    const play = createPlayClient(env, google.fetch);
    const h = createHandlers({ db, gateway: gw, play, now: () => clock.now });
    return { db, gw, google, h, clock };
}
const paid = (gw, orderId, paymentId, status = 'captured') => {
    const o = gw.orders.find((x) => x.id === orderId);
    gw.payments.set(paymentId, { id: paymentId, orderId, status, amountMinor: o.amountMinor, currency: 'INR', method: 'upi' });
    return { orderId, paymentId, signature: hmacSha256Hex(SECRET, `${orderId}|${paymentId}`) };
};
const playSub = (account, { product = 'glowos_standard', basePlan = 'monthly', state = 'SUBSCRIPTION_STATE_ACTIVE', expiry = NOW + 30 * DAY_MS, order = 'GPA.1111-2222-3333-44444', linked, autoRenew = true } = {}) => ({
    subscriptionState: state, startTime: new Date(NOW).toISOString(), latestOrderId: order,
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING', ...(linked ? { linkedPurchaseToken: linked } : {}),
    externalAccountIdentifiers: { obfuscatedExternalAccountId: account },
    lineItems: [{ productId: product, expiryTime: new Date(expiry).toISOString(), latestSuccessfulOrderId: order,
        offerDetails: { basePlanId: basePlan }, autoRenewingPlan: { autoRenewEnabled: autoRenew } }],
});
const rtdn = (token) => JSON.stringify({ message: { data: Buffer.from(JSON.stringify({
    packageName: PKG, subscriptionNotification: { notificationType: 2, purchaseToken: token, subscriptionId: 'glowos_standard' },
})).toString('base64') } });
const STATE = 'TAMIL NADU';

console.log('\n[1] Policy gate');
t(!altBillingEnabled({}) && !nativeCallAllowed('createOrder', {}, {}) && !nativeCallAllowed('playPrepare', {}, {}), 'switched off by default: native purchases stay blocked (PLAY_BILLING_REQUIRED)');
t(nativeCallAllowed('createOrder', {}, ENV) && nativeCallAllowed('playPrepare', {}, ENV) && nativeCallAllowed('playVerify', {}, ENV), 'enabled: native order, prepare and Play verification allowed');
t(!nativeCallAllowed('createRecurring', {}, ENV) && !nativeCallAllowed('verifyRecurring', {}, ENV), 'automatic Razorpay mandates stay web-only in the app');
t(nativeCallAllowed('manageRecurring', { action: 'cancel' }, ENV) && !nativeCallAllowed('manageRecurring', { action: 'change' }, ENV), 'app may cancel (not change) an automatic renewal');
{
    const db = makeDb({ [`users/${UID}`]: { role: 'salon_owner' } });
    const h = createHandlers({ db, gateway: makeGateway(), play: createPlayClient({}, async () => { throw new Error('no'); }), now: () => NOW });
    let err; try { await h.playPrepare({ uid: UID, body: { planId: 'standard', billingCycle: 'monthly' } }); } catch (e) { err = e; }
    t(err instanceof PlayNotConfigured, 'unconfigured Play credentials fail closed (503), never a free activation');
}

console.log('\n[2] User chooses Razorpay on Google Play\'s choice screen');
{
    const { db, gw, google, h } = await setup();
    const prep = await h.playPrepare({ uid: UID, body: { planId: 'standard', billingCycle: 'monthly' } });
    t(prep.status === 200 && prep.body.mode === 'choice' && prep.body.productId === 'glowos_standard' && prep.body.basePlanId === 'monthly', 'new purchase prepares the user-choice flow for glowos_standard/monthly');
    t(/^[a-f0-9]{64}$/.test(prep.body.accountId) && db.docs.get(`playAccounts/${prep.body.accountId}`)?.uid === UID, 'purchase is bound to an obfuscated account id (no uid sent to Google)');
    const noToken = await h.createOrder({ uid: UID, native: true, body: { planId: 'standard', billingCycle: 'monthly', taxState: STATE } });
    t(noToken.status === 409 && noToken.body.code === 'PLAY_CHOICE_REQUIRED', 'app Razorpay order without Google\'s choice token is refused');
    const noState = await h.createOrder({ uid: UID, native: true, body: { planId: 'standard', billingCycle: 'monthly', externalTransactionToken: 'ext-token-abcdef' } });
    t(noState.status === 400 && noState.body.code === 'TAX_STATE_REQUIRED', 'app order requires the GST state Google needs for India');
    const order = await h.createOrder({ uid: UID, native: true, body: { planId: 'standard', billingCycle: 'monthly', taxState: STATE, externalTransactionToken: 'ext-token-abcdef', idempotencyKey: 'k1' } });
    t(order.status === 200 && order.body.amountMinor === 79900 && order.body.gateway === 'razorpay', 'existing Razorpay order created at the catalog price (₹799)');
    const rep = db.docs.get(`externalReports/${order.body.orderId}`);
    t(rep?.status === 'awaiting_payment' && rep.kind === 'initial' && rep.token === 'ext-token-abcdef', 'server-only report record stored with the order');
    t(google.reports.size === 0, 'nothing is reported before the payment is verified');
    const v = await h.verifyPayment({ uid: UID, body: paid(gw, order.body.orderId, 'pay_P1') });
    t(v.status === 200 && v.body.status === 'SUCCESS' && db.docs.get(`subscriptions/${UID}`).planId === 'standard', 'Razorpay payment verified server-side and plan activated (existing flow)');
    const sent = google.reports.get(`glowos_${order.body.orderId}`);
    t(!!sent && google.jwtOk, 'transaction reported to Google with a valid service-account JWT');
    t(sent?.recurringTransaction?.externalTransactionToken === 'ext-token-abcdef' && sent.recurringTransaction.externalSubscription.subscriptionType === 'PREPAID', 'initial report carries the choice token as a PREPAID subscription');
    t(sent?.originalPreTaxAmount.priceMicros === '677118644' && sent.originalTaxAmount.priceMicros === '121881356' && sent.originalTaxAmount.currency === 'INR', 'amount split into pre-tax and 18% GST in micros (sums to ₹799)');
    t(sent?.userTaxAddress.regionCode === 'IN' && sent.userTaxAddress.administrativeArea === STATE, 'India tax address includes the state');
    const after = db.docs.get(`externalReports/${order.body.orderId}`);
    t(after.status === 'reported' && after.token === null, 'report marked done and the token is discarded');
    const again = await h.verifyPayment({ uid: UID, body: paid(gw, order.body.orderId, 'pay_P1') });
    t(again.body.duplicate === true && google.reports.size === 1, 'repeated verify neither re-activates nor re-reports');

    console.log('\n[3] Renewal and upgrade of an in-app Razorpay subscription');
    const renewPrep = await h.playPrepare({ uid: UID, body: { planId: 'standard', billingCycle: 'monthly' } });
    t(renewPrep.body.mode === 'alt-topup', 'same-plan renewal continues the series without a new choice screen');
    const renew = await h.createOrder({ uid: UID, native: true, body: { planId: 'standard', billingCycle: 'monthly', taxState: STATE, idempotencyKey: 'k2' } });
    const periodEnd = db.docs.get(`subscriptions/${UID}`).currentPeriodEnd;
    await h.verifyPayment({ uid: UID, body: paid(gw, renew.body.orderId, 'pay_P2') });
    const topup = google.reports.get(`glowos_${renew.body.orderId}`);
    t(topup?.recurringTransaction.initialExternalTransactionId === `glowos_${order.body.orderId}` && !topup.recurringTransaction.externalTransactionToken, 'renewal reported against the initial transaction id');
    t(db.docs.get(`subscriptions/${UID}`).currentPeriodEnd > periodEnd, 'renewal extended the paid period from its end (existing rules)');
    const upPrep = await h.playPrepare({ uid: UID, body: { planId: 'premium', billingCycle: 'monthly' } });
    t(upPrep.body.mode === 'alt-upgrade' && upPrep.body.originalExternalTransactionId === `glowos_${order.body.orderId}`, 'upgrade asks Google for a new token using the original external transaction id');
    google.failReports = 1;
    const up = await h.createOrder({ uid: UID, native: true, body: { planId: 'premium', billingCycle: 'monthly', taxState: STATE, externalTransactionToken: 'ext-token-upgrade', idempotencyKey: 'k3' } });
    const upV = await h.verifyPayment({ uid: UID, body: paid(gw, up.body.orderId, 'pay_P3') });
    t(upV.body.status === 'SUCCESS' && db.docs.get(`subscriptions/${UID}`).planId === 'premium', 'upgrade (with proration credit) activates even when Google is unreachable');
    t(db.docs.get(`externalReports/${up.body.orderId}`).status === 'awaiting_payment', 'failed report stays pending');
    const cron = await h.playReconcile();
    t(cron.reported === 1 && google.reports.get(`glowos_${up.body.orderId}`)?.recurringTransaction.externalTransactionToken === 'ext-token-upgrade', 'cron retries and reports the upgrade');
    t(google.reports.get(`glowos_${up.body.orderId}`).originalPreTaxAmount.priceMicros !== '0', 'upgrade reports the amount actually charged');
}

console.log('\n[4] Failed and cancelled Razorpay payments');
{
    const { db, gw, google, h } = await setup();
    await h.playPrepare({ uid: UID, body: { planId: 'basic', billingCycle: 'annual' } });
    const o = await h.createOrder({ uid: UID, native: true, body: { planId: 'basic', billingCycle: 'annual', taxState: 'KERALA', externalTransactionToken: 'ext-token-failed1' } });
    const f = await h.verifyPayment({ uid: UID, body: paid(gw, o.body.orderId, 'pay_F1', 'failed') });
    t(f.body.status === 'FAILED' && db.docs.get(`subscriptions/${UID}`).planId === 'trial', 'failed payment does not activate');
    await h.playReconcile();
    t(db.docs.get(`externalReports/${o.body.orderId}`).status === 'not_paid' && google.reports.size === 0, 'failed payment is never reported to Google');
    const o2 = await h.createOrder({ uid: UID, native: true, body: { planId: 'basic', billingCycle: 'annual', taxState: 'KERALA', externalTransactionToken: 'ext-token-cancel1', idempotencyKey: 'c2' } });
    const c = await h.cancelOrder({ uid: UID, body: { orderId: o2.body.orderId } });
    await h.playReconcile();
    t(c.body.status === 'CANCELLED' && db.docs.get(`externalReports/${o2.body.orderId}`).status === 'not_paid', 'cancelled checkout is not charged or reported');
}

console.log('\n[5] User chooses Google Play billing');
{
    const { db, google, h, clock } = await setup();
    const prep = await h.playPrepare({ uid: UID, body: { planId: 'standard', billingCycle: 'monthly' } });
    google.subs.set('play-token-0001', playSub(prep.body.accountId));
    const bad = await h.playVerify({ uid: OTHER, body: { purchaseToken: 'play-token-0001' } });
    t(bad.status === 403 && bad.body.code === 'PLAY_ACCOUNT_MISMATCH', 'a purchase token cannot be redeemed by another account');
    const v = await h.playVerify({ uid: UID, body: { purchaseToken: 'play-token-0001' } });
    const sub = db.docs.get(`subscriptions/${UID}`);
    t(v.status === 200 && v.body.status === 'SUCCESS', 'Google Play purchase verified server-side');
    t(sub.planId === 'standard' && sub.status === 'ACTIVE' && sub.billingSource === 'google_play' && sub.currentPeriodEnd === NOW + 30 * DAY_MS, 'plan activated until the Google Play expiry');
    t(google.acks.includes('play-token-0001') && db.docs.get(`playSubscriptions/${sub.playSubscriptionId}`).acknowledged, 'purchase acknowledged after it was recorded');
    const pay = db.docs.get(`subscriptions/${UID}/payments/play_GPA_1111-2222-3333-44444`);
    t(pay?.status === 'SUCCESS' && pay.paymentGateway === 'google_play' && pay.amount === 799, 'payment history row recorded');
    t(google.reports.size === 0, 'Google Play purchases are not reported as external transactions');
    const web = await h.createOrder({ uid: UID, body: { planId: 'standard', billingCycle: 'monthly' } });
    t(web.status === 409 && web.body.code === 'MANAGED_BY_GOOGLE_PLAY', 'website checkout cannot double-bill a live Google Play subscription');
    const same = await h.playPrepare({ uid: UID, body: { planId: 'standard', billingCycle: 'annual' } });
    t(same.status === 409 && same.body.code === 'MANAGED_BY_GOOGLE_PLAY', 'same-plan purchase is managed in Google Play');
    const upPrep = await h.playPrepare({ uid: UID, body: { planId: 'business', billingCycle: 'monthly' } });
    t(upPrep.body.mode === 'play-upgrade' && upPrep.body.oldProductId === 'glowos_standard', 'upgrade replaces the existing Google Play subscription');

    console.log('\n[6] Google Play renewals, upgrades, cancellation (RTDN)');
    const unauth = await h.playNotify({ secret: 'wrong-secret-000000000', rawBody: rtdn('play-token-0001') });
    t(unauth.status === 401, 'notifications without the shared secret are rejected');
    google.subs.set('play-token-0001', playSub(prep.body.accountId, { expiry: NOW + 60 * DAY_MS, order: 'GPA.1111-2222-3333-44444..0' }));
    clock.now = NOW + 30 * DAY_MS;
    await h.playNotify({ secret: RTDN, rawBody: rtdn('play-token-0001') });
    const renewed = db.docs.get(`subscriptions/${UID}`);
    const renewalRow = db.docs.get(`subscriptions/${UID}/payments/play_GPA_1111-2222-3333-44444__0`);
    t(renewed.currentPeriodEnd === NOW + 60 * DAY_MS && renewalRow?.kind === 'renewal' && renewalRow.periodStart === NOW + 30 * DAY_MS, 'renewal extends the period and records a renewal payment');
    await h.playNotify({ secret: RTDN, rawBody: rtdn('play-token-0001') });
    t(Object.keys(Object.fromEntries(db.docs)).filter((k) => k.startsWith(`subscriptions/${UID}/payments/`)).length === 2, 'duplicate notifications are idempotent');
    google.subs.set('play-token-0002', playSub(prep.body.accountId, { product: 'glowos_business', order: 'GPA.9999-0000-0000-00000', expiry: NOW + 61 * DAY_MS, linked: 'play-token-0001' }));
    await h.playVerify({ uid: UID, body: { purchaseToken: 'play-token-0002' } });
    const upgraded = db.docs.get(`subscriptions/${UID}`);
    t(upgraded.planId === 'business' && db.docs.get(`subscriptions/${UID}/payments/play_GPA_9999-0000-0000-00000`).kind === 'upgrade', 'Google Play upgrade switches the plan');
    google.subs.set('play-token-0001', playSub(prep.body.accountId, { state: 'SUBSCRIPTION_STATE_EXPIRED', expiry: NOW + 30 * DAY_MS, order: 'GPA.1111-2222-3333-44444..0' }));
    await h.playNotify({ secret: RTDN, rawBody: rtdn('play-token-0001') });
    t(db.docs.get(`subscriptions/${UID}`).planId === 'business', 'a late notification for the replaced purchase cannot overwrite the upgrade');
    google.subs.set('play-token-0002', playSub(prep.body.accountId, { product: 'glowos_business', order: 'GPA.9999-0000-0000-00000', expiry: NOW + 61 * DAY_MS, linked: 'play-token-0001', state: 'SUBSCRIPTION_STATE_CANCELED', autoRenew: false }));
    await h.playNotify({ secret: RTDN, rawBody: rtdn('play-token-0002') });
    const cancelled = db.docs.get(`subscriptions/${UID}`);
    t(cancelled.status === 'CANCELLED' && cancelled.autoRenew === false && cancelled.cancelAtPeriodEnd && cancelled.currentPeriodEnd === NOW + 61 * DAY_MS, 'cancellation keeps access until the paid expiry');
    google.subs.set('play-token-0002', { ...google.subs.get('play-token-0002'), subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' });
    clock.now = NOW + 62 * DAY_MS;
    await h.playReconcile();
    t(db.docs.get(`subscriptions/${UID}`).status === 'EXPIRED', 'expiry is mirrored by the cron even without a notification');
}

console.log('\n[7] Pending Google Play payment');
{
    const { db, google, h } = await setup();
    const prep = await h.playPrepare({ uid: UID, body: { planId: 'basic', billingCycle: 'monthly' } });
    google.subs.set('play-token-pend', playSub(prep.body.accountId, { product: 'glowos_basic', state: 'SUBSCRIPTION_STATE_PENDING' }));
    const v = await h.playVerify({ uid: UID, body: { purchaseToken: 'play-token-pend' } });
    t(v.status === 202 && v.body.status === 'PENDING' && db.docs.get(`subscriptions/${UID}`).planId === 'trial' && google.acks.length === 0, 'pending payment does not activate or acknowledge');
}

/* ---------- client orchestration (paymentService + fake native bridge) against the handlers ---------- */
// firebase.js imports the Firebase CDN; stub it for the payment service only.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
    if (spec === '../firebase.js' && ctx.parentURL && ctx.parentURL.includes('/services/payment/')) return { url: 'stub:firebase', shortCircuit: true };
    return next(spec, ctx);
}
export async function load(url, ctx, next) {
    if (url === 'stub:firebase') return { format: 'module', shortCircuit: true,
        source: 'export const isDemoMode = () => false; export const getFirebase = () => ({ auth: { currentUser: { getIdToken: async () => "id" } } });' };
    return next(url, ctx);
}`));
globalThis.window = { location: { search: '?platform=android' } };
const { purchase, PaymentsUnavailable } = await import('../public/js/services/payment/paymentService.js');
const { initPlayBilling } = await import('../public/js/services/payment/playBilling.js');
const ROUTES = { 'create-order': 'createOrder', verify: 'verifyPayment', cancel: 'cancelOrder', 'play-prepare': 'playPrepare', 'play-verify': 'playVerify', 'create-recurring': 'createRecurring' };

console.log('\n[8] Android app purchase flow (client + server)');
{
    let err;
    try { await purchase({ planId: 'standard', billingCycle: 'monthly', taxState: STATE }); } catch (e) { err = e; }
    t(err instanceof PaymentsUnavailable, 'app build without the Play bridge keeps purchases unavailable');

    const { db, gw, google, h } = await setup();
    // fetch -> the same native gate as api/_lib/http.js, then the real handlers.
    globalThis.fetch = async (url, init) => {
        const method = ROUTES[url.replace('/api/subscription/', '')];
        const body = JSON.parse(init.body);
        const native = init.headers['X-Qvrix-Platform'] === 'android';
        const r = native && !nativeCallAllowed(method, body, ENV)
            ? { status: 403, body: { code: 'PLAY_BILLING_REQUIRED' } }
            : await h[method]({ uid: UID, email: 'o@example.com', body, native });
        return { status: r.status, json: async () => r.body };
    };
    const bridgeLog = [];
    let nextChoice;
    window.AndroidBilling = {
        postMessage(raw) {
            const m = JSON.parse(raw);
            bridgeLog.push(m);
            const reply = (o) => setTimeout(() => this.onmessage({ data: JSON.stringify(o) }));
            if (m.type === 'init') reply({ type: 'ready', available: true });
            if (m.type === 'launch') reply({ requestId: m.requestId, ...nextChoice(m) });
        },
    };
    let sheet;
    window.Razorpay = class { constructor(o) { this.o = o; } on() {} open() { sheet(this.o); } };
    let ready = false;
    initPlayBilling({ onReady: (r) => { ready = r; } });
    await new Promise((r) => setTimeout(r, 5));
    t(ready, 'native bridge reports Google Play billing ready');

    nextChoice = () => ({ type: 'cancelled' });
    const cancelled = await purchase({ planId: 'standard', billingCycle: 'monthly', taxState: STATE, idempotencyKey: 'a1' });
    t(cancelled.status === 'CANCELLED' && gw.orders.length === 0, 'backing out of Google Play\'s screen creates no order and no charge');

    let launched;
    nextChoice = (m) => { launched = m; return { type: 'alternative', token: 'ext-token-client1' }; };
    let options;
    sheet = (o) => { options = o; const p = paid(gw, o.order_id, 'pay_C1'); o.handler({ razorpay_order_id: p.orderId, razorpay_payment_id: p.paymentId, razorpay_signature: p.signature }); };
    const viaRazorpay = await purchase({ planId: 'standard', billingCycle: 'monthly', taxState: STATE, idempotencyKey: 'a2', user: { email: 'o@example.com' } });
    t(launched.mode === 'choice' && launched.productId === 'glowos_standard' && /^[a-f0-9]{64}$/.test(launched.accountId), 'app launches Google Play\'s user-choice flow for the plan');
    t(viaRazorpay.status === 'SUCCESS' && db.docs.get(`subscriptions/${UID}`).planId === 'standard', 'choosing Razorpay completes through the existing checkout and server verification');
    t(options.webview_intent === true && options.amount === 79900 && !options.config.display.hide.length, 'Razorpay sheet offers all methods (UPI apps, cards, net banking) inside the app');
    const toggles = bridgeLog.filter((m) => m.type === 'checkout').map((m) => m.active);
    t(toggles.join() === 'true,false', 'payment pop-ups (bank / 3-D Secure) are enabled only while the sheet is open');
    t(google.reports.get(`glowos_${gw.orders[0].id}`)?.recurringTransaction.externalTransactionToken === 'ext-token-client1', 'the in-app Razorpay payment is reported to Google with the choice token');

    sheet = (o) => o.modal.ondismiss();
    nextChoice = () => { throw new Error('a same-plan renewal must not reopen the choice screen'); };
    const dismissed = await purchase({ planId: 'standard', billingCycle: 'monthly', taxState: STATE, idempotencyKey: 'a3' });
    t(dismissed.status === 'CANCELLED' && db.docs.get(`subscriptions/${UID}/payments/${gw.orders[1].id}`).status === 'CANCELLED', 'renewal goes straight to Razorpay; closing the sheet cancels the order');

    sheet = (o) => o.modal.ondismiss();
    nextChoice = () => ({ type: 'purchase', purchaseToken: 'play-token-client', state: 'PURCHASED' });
    google.subs.set('play-token-client', playSub(launched.accountId, { product: 'glowos_business', order: 'GPA.5555-0000-0000-00000' }));
    const viaPlay = await purchase({ planId: 'business', billingCycle: 'monthly', taxState: STATE, idempotencyKey: 'a4' });
    t(viaPlay.status === 'SUCCESS' && db.docs.get(`subscriptions/${UID}`).billingSource === 'google_play' && gw.orders.length === 2, 'choosing Google Play is verified by the server without opening Razorpay');

    const auto = await purchase({ planId: 'business', billingCycle: 'monthly', renewalMode: 'automatic', taxState: STATE }).catch((e) => e);
    t(auto instanceof PaymentsUnavailable, 'automatic Razorpay renewal is not offered inside the app');
}
delete globalThis.window;

console.log(`\nUNIT PLAY BILLING: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
