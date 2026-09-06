/**
 * e2e-quick-billing.mjs
 * Real-browser end-to-end verification of the Quick Billing / Walk-in POS
 * flow: the dashboard entry point, live service search + selection, the live
 * breakdown, the one-step "Complete Payment" write, the receipt modal, and
 * that the resulting record is a Completed + paid walk-in appointment that
 * shows up in the list and drives the dashboard revenue figure.
 *
 * Uses the demo-mode seeded catalog (no service creation needed):
 *   Signature Facial  ₹95  60m
 *   Precision Haircut ₹75  45m
 *
 * Usage: node scripts/e2e-quick-billing.mjs  (server on :5500)
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killChromeTree } from './e2e-helpers.mjs';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5500/';
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9337;
const userData = mkdtempSync(join(tmpdir(), 'luxe-qb-'));

let ws;
let msgId = 0;
const pending = new Map();
let chromeProc = null;

function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
        pending.set(id, (err, result) => { clearTimeout(timer); err ? reject(err) : resolve(result); });
        ws.send(JSON.stringify({ id, method, params }));
    });
}

async function evaluate(expression) {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(exceptionDetails));
    return result.value;
}

async function waitFor(expr, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try { if (await evaluate(expr)) return; } catch (e) { /* retry */ }
        await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Timed out waiting for: ${expr}`);
}

/** Poll an expression returning { ok, dump } and dump state on timeout. */
async function pollWithDebug(expr, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const res = await evaluate(expr);
        if (res && res.ok) return res;
        await new Promise((r) => setTimeout(r, 150));
    }
    console.log('  [debug] state at timeout:', await evaluate(expr).then((r) => r && r.dump));
    throw new Error(`Timed out polling: ${expr}`);
}

let pass = 0;
let fail = 0;
function assert(cond, label) {
    if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
    else { fail += 1; console.log(`  FAIL  ${label}`); }
}

async function click(selector) {
    const ok = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
    if (!ok) throw new Error('click failed: ' + selector);
}

/** Set a value and bubble input + change so the delegated handlers run. */
async function setValue(nameOrSelector, value) {
    const el = nameOrSelector.startsWith('[')
        ? `document.querySelector(${JSON.stringify(nameOrSelector)})`
        : `document.querySelector('form[data-action="submit-quick-billing"] [name=${JSON.stringify(nameOrSelector)}]')`;
    await evaluate(`(() => {
        const el = ${el};
        if (!el) return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
}

/** Type into the service-search input and click a matching suggestion. */
async function addService(serviceName) {
    await setValue('[data-action="quick-billing-service-search"]', serviceName);
    await waitFor(`document.querySelector('[data-action="quick-billing-add-service"][data-name=${JSON.stringify(serviceName)}]') !== null`);
    await click(`[data-action="quick-billing-add-service"][data-name=${JSON.stringify(serviceName)}]`);
}

/** Read the Est. Revenue stat card value text. */
const revenueExpr = `
    [...document.querySelectorAll('main p')]
        .filter((el) => el.textContent.trim() === 'Est. Revenue')
        .map((el) => el.nextElementSibling.textContent.trim())[0] || null`;

async function openQuickBilling() {
    await click('[data-action="tab"][data-tab="dashboard"]');
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance')`);
    await click('[data-action="modal"][data-modal="quick-billing"]');
    await waitFor(`document.querySelector('form[data-action="submit-quick-billing"]') !== null`);
}

async function main() {
    console.log('Launching headless Chrome…');
    chromeProc = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=' + PORT, `--user-data-dir=${userData}`, 'about:blank',
    ], { stdio: 'ignore' });

    let list = null;
    for (let i = 0; i < 40; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/json`);
            if (res.ok) { list = await res.json(); break; }
        } catch (e) { /* retry */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    if (!list) throw new Error('Could not reach Chrome DevTools endpoint');

    const page = list.find((t) => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && pending.has(msg.id)) {
            const cb = pending.get(msg.id);
            pending.delete(msg.id);
            cb(msg.error, msg.result);
        }
    };
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: APP_URL });
    await waitFor(`document.readyState === 'complete'`);

    // Sign in (demo mode).
    await waitFor(`document.querySelector('form[data-action="email-auth"]') !== null`);
    await evaluate(`localStorage.setItem('spacrm_tutorial_progress_v1', JSON.stringify({ completedTours: {}, setupGuideSeen: true })); true`);
    await evaluate(`(() => {
        const f = document.querySelector('form[data-action="email-auth"]');
        const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } };
        set('salonName', 'Quick Bill Salon');
        set('email', 'qb@test.com');
        set('password', 'secret123');
        return true;
    })()`);
    await evaluate(`document.querySelector('form[data-action="email-auth"]').requestSubmit()`);
    // A cold Chrome start under full-suite load can take a while before the
    // demo session renders; allow well past the default wait here.
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance') || document.querySelector('[aria-label="SPACRM guided tour"]') !== null`, 20000);
    if (await evaluate(`document.querySelector('[aria-label="SPACRM guided tour"]') !== null`)) {
        await click('[data-tutorial-action="skip"]');
        await click('[data-action="tab"][data-tab="dashboard"]');
    }
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance')`, 20000);

    console.log('\n[1] Fresh salon starts at ₹0 for the revenue period');
    assert(await evaluate(`${revenueExpr} === '₹0'`), `Est. Revenue is ₹0 before any walk-in (got ${await evaluate(revenueExpr)})`);

    console.log('\n[2] Dashboard Quick Bill tile opens the walk-in form');
    assert(await evaluate(`document.querySelector('[data-action="modal"][data-modal="quick-billing"]') !== null`), 'Quick Bill tile is present on the owner dashboard');
    await openQuickBilling();
    assert(await evaluate(`document.querySelector('form[data-action="submit-quick-billing"]') !== null`), 'walk-in form opened from the dashboard tile');
    assert(await evaluate(`(() => { const btn = document.querySelector('form[data-action="submit-quick-billing"] button[type="submit"]'); return btn && btn.disabled; })()`), "Complete Payment starts disabled (nothing selected)");

    console.log('\n[3] Live service search adds services to the bill');
    await addService('Signature Facial');
    await addService('Precision Haircut');
    await waitFor(`(() => { const el = document.querySelector('form[data-action="submit-quick-billing"] [data-quickbilling-selected-services]'); return el && el.innerText.includes('Subtotal') && el.innerText.includes('170'); })()`);
    const selectedText = await evaluate(`document.querySelector('form[data-action="submit-quick-billing"] [data-quickbilling-selected-services]').innerText`);
    assert(selectedText.includes('Signature Facial') && selectedText.includes('Precision Haircut'), 'both services appear in the selected-services list');
    assert(selectedText.includes('₹170'), 'subtotal is ₹170 for the two services (95 + 75)');
    assert(await evaluate(`(() => { const el = document.querySelector('form[data-action="submit-quick-billing"] [data-quickbilling-summary]'); return el && el.innerText.includes('₹170'); })()`), 'live summary shows the ₹170 invoice');

    console.log('\n[4] Wallet block renders for a client with no referral balance');
    assert(await evaluate(`document.body.innerText.includes('No referral balance available (₹0)')`), 'wallet block shows the empty-balance state for a new client');

    console.log('\n[5] Typing a new client and picking a payment method enables the button');
    await setValue('customerName', 'Walkin Test Client');
    await setValue('paymentMethod', 'upi');
    await setValue('paymentReference', 'UPIREFDEMO');
    await waitFor(`(() => { const btn = document.querySelector('form[data-action="submit-quick-billing"] button[type="submit"]'); return btn && !btn.disabled; })()`);
    assert(true, 'Complete Payment enabled once client + method are set');

    console.log('\n[6] One-step bill writes the walk-in and shows the receipt');
    await evaluate(`document.querySelector('form[data-action="submit-quick-billing"]').requestSubmit()`);
    await waitFor(`document.body.innerText.includes('Walk-in billed & paid')`);
    const receiptText = await evaluate(`(document.querySelector('[role="dialog"]') || document.body).innerText`);
    assert(receiptText.includes('Walk-in billed & paid'), 'receipt modal confirms the walk-in was billed & paid');
    assert(/INV-[A-Z0-9]+/.test(receiptText), 'receipt shows an invoice number (INV-…)');
    assert(receiptText.includes('Walkin Test Client'), 'receipt shows the client name');
    assert(receiptText.includes('₹170'), 'receipt shows the ₹170 invoice total');
    assert(receiptText.includes('UPI'), 'receipt shows the payment method (UPI)');

    console.log('\n[7] The persisted record is a Completed + paid walk-in');
    const record = await evaluate(`(async () => {
        const { listAppointments } = await import('/js/services/appointmentsRepository.js');
        const rows = listAppointments().filter((a) => a.customerName === 'Walkin Test Client');
        return rows[rows.length - 1] || null;
    })()`);
    assert(record && record.source === 'walkin', 'record is tagged source: walkin');
    assert(record && record.status === 'Completed', 'record status is Completed');
    assert(record && record.paid === true, 'record is paid');
    assert(record && record.invoiceAmount === 170, 'record invoiceAmount is ₹170');
    const servicesOk = await evaluate(`(async () => {
        const { listAppointments } = await import('/js/services/appointmentsRepository.js');
        const rows = listAppointments().filter((a) => a.customerName === 'Walkin Test Client');
        const a = rows[rows.length - 1];
        return !!a && Array.isArray(a.services) && a.services.length === 2;
    })()`);
    assert(servicesOk, 'record stores both selected services');

    console.log('\n[8] The walk-in appears in the appointments list and drives revenue');
    await click('[data-action="tab"][data-tab="appointments"]');
    await waitFor(`document.body.innerText.includes('Walkin Test Client')`);
    assert(true, 'appointments list shows the walk-in');
    await click('[data-action="tab"][data-tab="dashboard"]');
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance')`);
    const rev = await evaluate(revenueExpr);
    assert(rev === '₹170', `Est. Revenue reflects the walk-in: ₹170 (got ${rev})`);

    console.log('\n[9] Remove-service path keeps the breakdown correct');
    await openQuickBilling();
    await setValue('customerName', 'Walkin Test Client');
    await setValue('paymentMethod', 'upi');
    await addService('Signature Facial');    // ₹95
    await addService('Balayage & Gloss');    // ₹160
    const afterAdd = await pollWithDebug(
        `(() => { const el = document.querySelector('form[data-action="submit-quick-billing"] [data-quickbilling-selected-services]'); const h = document.querySelector('form[data-action="submit-quick-billing"] [name="selectedServices"]'); return { ok: el && el.innerText.includes('Balayage & Gloss') && el.innerText.includes('255'), dump: JSON.stringify({ hidden: h && h.value, text: el && el.innerText }) }; })()`,
    );
    assert(afterAdd.ok, 'adding a third-time service updates the subtotal to ₹255 (95 + 160)');
    await click('[data-action="quick-billing-remove-service"][data-name="Balayage & Gloss"]');
    const afterRemove = await pollWithDebug(
        `(() => { const el = document.querySelector('form[data-action="submit-quick-billing"] [data-quickbilling-selected-services]'); const h = document.querySelector('form[data-action="submit-quick-billing"] [name="selectedServices"]'); return { ok: el && !el.innerText.includes('Balayage & Gloss') && el.innerText.includes('95') && !el.innerText.includes('255'), dump: JSON.stringify({ hidden: h && h.value, text: el && el.innerText }) }; })()`,
    );
    assert(afterRemove.ok, 'removing a service drops it and restores the ₹95 subtotal');
    assert(await evaluate(`(() => { const el = document.querySelector('form[data-action="submit-quick-billing"] [data-quickbilling-summary]'); return el && el.innerText.includes('₹95'); })()`), 'live summary follows the removal (₹95)');

    console.log(`\n===== QUICK BILLING E2E RESULT: ${pass} passed, ${fail} failed =====`);
    if (ws) ws.close();
    killChromeTree(chromeProc && chromeProc.pid);
    cleanup();
    process.exit(fail === 0 ? 0 : 1);
}

function cleanup() {
    for (let i = 0; i < 5; i++) {
        try {
            rmSync(userData, { recursive: true, force: true });
            return;
        } catch (e) { /* wait for Chrome to release the lock */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
}

main().catch((err) => {
    console.error('\nQUICK BILLING E2E ERROR:', err.message);
    if (ws) try { ws.close(); } catch (e) { /* ignore */ }
    killChromeTree(chromeProc && chromeProc.pid);
    cleanup();
    process.exit(2);
});