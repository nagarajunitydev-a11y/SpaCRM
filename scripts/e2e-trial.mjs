// Browser → real Firebase Auth emulator → subscription service → Firestore
// rules/transaction → dashboard. No mock subscription or payment activation.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { killChromeTree } from './e2e-helpers.mjs';

const projectId = 'demo-spacrm-trial';
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8085', 'Requires isolated Firestore emulator');
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9098', 'Requires isolated Auth emulator');
const admin = getFirestore(initializeApp({ projectId }));
const rules = readFileSync('firestore.rules', 'utf8');
async function loadRules(source) {
    const env = await initializeTestEnvironment({ projectId, firestore: { rules: source } });
    await env.cleanup();
}
const root = resolve('public');
const server = createServer((req, res) => {
    const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
    if (!path.startsWith(root + '\\') && !path.startsWith(root + '/')) { res.writeHead(403).end(); return; }
    try {
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
        res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(readFileSync(path));
    } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(5511, '127.0.0.1', resolve));
const profile = mkdtempSync(join(tmpdir(), 'spacrm-trial-'));
let chrome, ws, sequence = 0, passed = 0;
const pending = new Map(), errors = [], paymentRequests = [];
function send(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 30000);
        pending.set(id, msg => { clearTimeout(timeout); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); });
        ws.send(JSON.stringify({ id, method, params }));
    });
}
async function evaluate(expression) {
    const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(expression) {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(200); }
    throw new Error('Timed out: ' + expression + '\n' + await evaluate('document.body.innerText'));
}
async function click(selector) {
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing button'); el.click(); })()`);
}
async function fill(selector, values) {
    await evaluate(`(() => { const form = document.querySelector(${JSON.stringify(selector)}); for (const [name, value] of Object.entries(${JSON.stringify(values)})) { const el = form.querySelector('[name="' + name + '"]'); if (!el) throw new Error('Missing field ' + name); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
}
function check(condition, label) { assert.ok(condition, label); passed++; console.log('PASS ' + label); }
const stateExpr = `(await import('/js/core/store.js')).store.getState()`;

try {
    chrome = spawn(process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=9348', `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    let targets;
    for (let i = 0; i < 50; i++) { try { targets = await (await fetch('http://127.0.0.1:9348/json')).json(); break; } catch { await pause(200); } }
    assert.ok(targets, 'Chrome starts');
    ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    ws.onmessage = event => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
        if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
        if (msg.method === 'Network.requestWillBeSent') {
            const url = new URL(msg.params.request.url);
            if (url.hostname.endsWith('razorpay.com') || url.pathname.startsWith('/api/subscription/')) paymentRequests.push(url.href);
        }
    };
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
        window.__firebase_config = JSON.stringify({ projectId: '${projectId}', apiKey: 'fake-api-key', authDomain: 'localhost', appId: 'demo-trial-app' });
        localStorage.setItem('spacrm_tutorial_progress_v1', JSON.stringify({ completedTours: {}, setupGuideSeen: true }));
    ` });
    await send('Page.navigate', { url: 'http://127.0.0.1:5511/?firebaseEmulators=1' });
    await wait(`document.querySelector('form[data-action="email-auth"]') !== null`);
    check(await evaluate(`(async () => ${stateExpr}.mode === 'firebase')()`), 'Application uses Firebase, not demo data');
    await click('[data-action="toggle-form-mode"]');
    await fill('form[data-action="email-auth"]', { salonName: 'New Trial Salon', email: `trial-${Date.now()}@example.test`, password: 'TrialTest123!' });
    await evaluate(`document.querySelector('form[data-action="email-auth"]').requestSubmit()`);
    await wait(`document.body.innerText.includes('Set up your salon')`);
    await click('[data-action="modal"][data-modal="salon"]');
    await wait(`document.querySelector('form[data-action="submit-salon"]') !== null`);
    await fill('form[data-action="submit-salon"]', { name: 'New Trial Salon', email: 'owner@example.test', phone: '9876543210', address: '1 Emulator Road' });
    await evaluate(`document.querySelector('form[data-action="submit-salon"]').requestSubmit()`);
    await wait(`document.querySelector('[data-action="start-trial"]') !== null`);
    const identity = await evaluate(`(async () => { const s = ${stateExpr}; return { uid: s.currentUser.uid, salonId: s.currentSalonId }; })()`);
    check(!!identity.uid && !!identity.salonId, 'New Firebase Auth user and salon created through UI');
    const subscriptionRef = admin.doc(`subscriptions/${identity.uid}`);
    check(!(await subscriptionRef.get()).exists, 'Trial is not silently activated before the owner chooses it');
    await click('[data-action="tab"][data-tab="subscription"]');

    const denied = rules.replace('allow create: if isSignedIn() && request.auth.uid == uid && isValidNewTrial', 'allow create: if false && isSignedIn() && request.auth.uid == uid && isValidNewTrial');
    assert.notEqual(denied, rules);
    await loadRules(denied);
    await click('[data-plan-card="trial"] [data-action="start-trial"]');
    await wait(`document.querySelector('[data-trial-error]')?.innerText.includes('permission to activate')`);
    check(!(await subscriptionRef.get()).exists, 'Rejected write leaves no trial document');
    check(await evaluate(`(async () => ${stateExpr}.activeTab === 'subscription' && !${stateExpr}.access.isTrial)()`), 'Failure remains on subscription page without false activation');
    check(await evaluate(`!document.querySelector('[data-plan-card="trial"] [data-action="start-trial"]').disabled`), 'Retry button re-enabled after failure');
    await loadRules(rules);
    await admin.doc('salons/foreign-salon').set({ ownerId: 'different-owner' });
    const foreignDenied = await evaluate(`(async () => {
        const { getFirebase } = await import('/js/services/firebase.js');
        const { doc, setDoc, Timestamp } = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
        const start = Date.now(), end = start + 30 * 86400000;
        try {
            await setDoc(doc(getFirebase().db, 'subscriptions', getFirebase().auth.currentUser.uid), {
                ownerId: getFirebase().auth.currentUser.uid, salonId: 'foreign-salon', planId: 'trial', status: 'TRIAL',
                startDate: Timestamp.fromMillis(start), trialStartedAt: Timestamp.fromMillis(start),
                endDate: Timestamp.fromMillis(end), trialEndsAt: Timestamp.fromMillis(end),
            });
            return false;
        } catch (error) { return error.code === 'permission-denied'; }
    })()`);
    check(foreignDenied && !(await subscriptionRef.get()).exists, 'Rules reject trials linked to another owner’s salon');
    await evaluate(`(() => { const button = document.querySelector('[data-plan-card="trial"] [data-action="start-trial"]'); for (let i = 0; i < 5; i++) button.click(); })()`);
    await wait(`(async () => { const s = ${stateExpr}; return s.activeTab === 'dashboard' && s.access.isTrial && !s.trialStarting; })()`);
    const record = (await subscriptionRef.get()).data();
    check(record.planId === 'trial' && record.status === 'TRIAL' && record.salonId === identity.salonId && record.ownerId === identity.uid, 'Persisted trial belongs to the authenticated salon and correct Free Trial catalog plan');
    const start = record.startDate.toMillis(), end = record.endDate.toMillis();
    check(end - start === 30 * 86400000 && start === record.trialStartedAt.toMillis() && end === record.trialEndsAt.toMillis(), 'Persisted dates and compatibility timestamps equal exactly 30 days');
    check(record.periodAmount === 0 && record.lastPaymentId === null && record.billingCycle === null, 'Zero-cost activation with no payment/card');
    check((await subscriptionRef.collection('payments').get()).empty, 'Trial creates no payment history entry');
    check((await admin.collection('subscriptions').get()).size === 1, 'Repeated clicks create exactly one subscription');
    check(await evaluate(`(async () => { const s = ${stateExpr}; return s.access.can('onlineBooking') && s.access.can('referral') && !s.access.can('aiGrowth') && s.access.trialDaysLeft === 30; })()`), 'Free Trial uses Standard features and 30 active days');
    const repeated = await evaluate(`(async () => { const service = await import('/js/services/subscriptionService.js'); const rows = await Promise.all([service.startTrial(), service.startTrial(), service.startTrial()]); return rows.map(row => row.trialEndsAt); })()`);
    check(repeated.every(value => value === end) && (await subscriptionRef.get()).data().endDate.toMillis() === end, 'Existing active trial resumes without extending dates');
    await send('Page.reload', { ignoreCache: true });
    await wait(`(async () => ${stateExpr}.access?.isTrial === true)()`);
    check(await evaluate(`(async () => ${stateExpr}.subscription.endDate === ${end})()`), 'Auth restoration and refresh preserve persisted trial');
    const expiredEnd = Date.now() - 1000;
    await subscriptionRef.update({ trialStartedAt: Timestamp.fromMillis(expiredEnd - 30 * 86400000), trialEndsAt: Timestamp.fromMillis(expiredEnd), startDate: Timestamp.fromMillis(expiredEnd - 30 * 86400000), endDate: Timestamp.fromMillis(expiredEnd) });
    await wait(`(async () => ${stateExpr}.access?.status === 'EXPIRED')()`);
    const expiredMessage = await evaluate(`(async () => { try { await (await import('/js/services/subscriptionService.js')).startTrial(); return ''; } catch (error) { return error.message; } })()`);
    check(expiredMessage.includes('already expired'), 'Expired trial reports exhaustion instead of granting another trial');
    check((await subscriptionRef.get()).data().endDate.toMillis() === expiredEnd, 'Expired trial data is preserved');
    await subscriptionRef.update({ planId: 'basic', status: 'ACTIVE', currentPeriodEnd: Timestamp.fromMillis(Date.now() + 30 * 86400000) });
    await wait(`(async () => ${stateExpr}.subscription?.planId === 'basic')()`);
    const paidMessage = await evaluate(`(async () => { try { await (await import('/js/services/subscriptionService.js')).startTrial(); return ''; } catch (error) { return error.message; } })()`);
    check(paidMessage.includes('already has a subscription') && (await subscriptionRef.get()).data().planId === 'basic', 'Trial action cannot overwrite an existing paid subscription');
    await evaluate(`(async () => { await (await import('/js/services/authService.js')).signOut(); })()`);
    const signedOut = await evaluate(`(async () => { try { await (await import('/js/services/subscriptionService.js')).startTrial(); return ''; } catch (error) { return error.message; } })()`);
    check(signedOut.includes('Sign in'), 'Signed-out trial attempt is rejected');
    check(paymentRequests.length === 0, 'No payment API or Razorpay request during trial flow');
    check(errors.length === 0, 'No unhandled browser runtime errors');
    console.log(`TRIAL FIREBASE E2E: ${passed} passed`);
} finally {
    await loadRules(rules);
    if (ws) ws.close();
    killChromeTree(chrome?.pid);
    server.close();
    for (let i = 0; i < 5; i++) { try { rmSync(profile, { recursive: true }); break; } catch { await pause(200); } }
    await admin.terminate();
}
