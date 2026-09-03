/**
 * e2e-revenue.mjs
 * Real-browser end-to-end verification of the dashboard "Est. Revenue" figure.
 *
 * Drives the actual booking flow (services + appointments) and asserts the
 * rendered stat card equals the independently computed revenue from the
 * underlying records: catalog-price fallback, cancellation exclusion, and
 * no fabricated per-booking amounts.
 *
 * Usage: node scripts/e2e-revenue.mjs  (server on :5500)
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5500/';
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const userData = mkdtempSync(join(tmpdir(), 'luxe-rev-'));

let ws;
let msgId = 0;
const pending = new Map();

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

/** Read the Est. Revenue stat card value text. */
const revenueExpr = `
    [...document.querySelectorAll('main p')]
        .filter((el) => el.textContent.trim() === 'Est. Revenue')
        .map((el) => el.nextElementSibling.textContent.trim())[0] || null`;

async function bookAppointment(customer, serviceIndex) {
    await click('[data-action="tab"][data-tab="appointments"]');
    await click('[data-action="modal"][data-modal="appointment"]');
    await waitFor(`document.querySelector('form[data-action="submit-appointment"]') !== null`);
    await evaluate(`(() => {
        const f = document.querySelector('form[data-action="submit-appointment"]');
        f.querySelector('[name="customerName"]').value = ${JSON.stringify(customer)};
        f.querySelector('[name="customerName"]').dispatchEvent(new Event('input', { bubbles: true }));
        // A slot one hour from now, clamped to later-today so it stays in the
        // dashboard's "Today" period and passes the past-time validator.
        const now = new Date();
        let d = new Date(now.getTime() + 3600000);
        let pad = (n) => String(n).padStart(2, '0');
        let dateStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
        let timeStr = pad(d.getHours()) + ':' + pad(d.getMinutes());
        if (dateStr !== now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())) {
            dateStr = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
            timeStr = '23:58';
        }
        f.querySelector('[name="date"]').value = dateStr;
        f.querySelector('[name="time"]').value = timeStr;
        ['customerName', 'date', 'time'].forEach((n) => f.querySelector('[name="' + n + '"]').dispatchEvent(new Event('input', { bubbles: true })));
        f.querySelector('[name="serviceName"]').selectedIndex = ${serviceIndex};
        f.querySelector('[name="staffName"]').selectedIndex = 1;
        return true;
    })()`);
    await evaluate(`document.querySelector('form[data-action="submit-appointment"]').requestSubmit()`);
    await waitFor(`!document.querySelector('form[data-action="submit-appointment"]')`);
}

async function main() {
    console.log('Launching headless Chrome…');
    const chrome = spawn(CHROME, [
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
    await evaluate(`(() => {
        const f = document.querySelector('form[data-action="email-auth"]');
        const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } };
        set('salonName', 'Rev Check Salon');
        set('email', 'rev@test.com');
        set('password', 'secret123');
        return true;
    })()`);
    await evaluate(`document.querySelector('form[data-action="email-auth"]').requestSubmit()`);
    // A first-time owner's Initial Setup Guide can auto-navigate off the
    // dashboard within milliseconds of landing on it, so waiting on
    // dashboard-only text here would be racy — either signal means
    // sign-in succeeded.
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance') || document.querySelector('[aria-label="SPACRM guided tour"]') !== null`);
    if (await evaluate(`document.querySelector('[aria-label="SPACRM guided tour"]') !== null`)) {
        await click('[data-tutorial-action="skip"]');
        await click('[data-action="tab"][data-tab="dashboard"]');
    }
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance')`);

    console.log('\n[1] Empty period shows ₹0 — no fabricated fallback');
    assert(await evaluate(`${revenueExpr} === '₹0'`), `Est. Revenue is ₹0 with no bookings (got ${await evaluate(revenueExpr)})`);

    console.log('\n[2] Book services via the real UI flow');
    // Catalog after seeding: select index 0 = placeholder, 1..3 = seeded
    // services, then appended: 4 = Gold Ritual (₹200), 5 = Hair Spa (₹100).
    await click('[data-action="tab"][data-tab="services"]');
    await click('[data-action="modal"][data-modal="service"]');
    await waitFor(`document.querySelector('form[data-action="submit-service"]') !== null`);
    await evaluate(`(() => {
        const f = document.querySelector('form[data-action="submit-service"]');
        f.querySelector('[name="name"]').value = 'Gold Ritual';
        f.querySelector('[name="price"]').value = '200';
        f.querySelector('[name="duration"]').value = '75m';
        ['name', 'price', 'duration'].forEach((n) => f.querySelector('[name="' + n + '"]').dispatchEvent(new Event('input', { bubbles: true })));
        return true;
    })()`);
    await evaluate(`document.querySelector('form[data-action="submit-service"]').requestSubmit()`);
    await waitFor(`document.body.innerText.includes('Gold Ritual')`);

    await click('[data-action="modal"][data-modal="service"]');
    await waitFor(`document.querySelector('form[data-action="submit-service"]') !== null`);
    await evaluate(`(() => {
        const f = document.querySelector('form[data-action="submit-service"]');
        f.querySelector('[name="name"]').value = 'Hair Spa';
        f.querySelector('[name="price"]').value = '100';
        f.querySelector('[name="duration"]').value = '45m';
        ['name', 'price', 'duration'].forEach((n) => f.querySelector('[name="' + n + '"]').dispatchEvent(new Event('input', { bubbles: true })));
        return true;
    })()`);
    await evaluate(`document.querySelector('form[data-action="submit-service"]').requestSubmit()`);
    await waitFor(`document.body.innerText.includes('Hair Spa')`);

    await bookAppointment('Rev Client A', 2); // Signature Facial ₹95
    await bookAppointment('Rev Client B', 5); // Hair Spa ₹100

    await click('[data-action="tab"][data-tab="dashboard"]');
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance')`);
    let revNow = await evaluate(revenueExpr);
    assert(revNow === '₹195', `₹95 + ₹100 bookings -> Est. Revenue ₹195 (got ${revNow})`);

    await bookAppointment('Rev Client C', 4); // Gold Ritual ₹200

    await click('[data-action="tab"][data-tab="dashboard"]');
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance')`);
    revNow = await evaluate(revenueExpr);
    assert(revNow === '₹395', `third booking (₹200) -> Est. Revenue ₹395 (got ${revNow})`);

    console.log('\n[3] Cancelling one booking removes it from revenue');
    await click('[data-action="tab"][data-tab="appointments"]');
    await waitFor(`document.body.innerText.includes('Rev Client B')`);
    await evaluate(`(() => {
        const cards = [...document.querySelectorAll('main .bg-slate-900')];
        const card = cards.find((c) => c.innerText.includes('Rev Client B'));
        const edit = card && card.querySelector('[data-action="open-edit"][data-type="appointment"]');
        if (edit) edit.click();
        return !!edit;
    })()`);
    await waitFor(`document.querySelector('form[data-action="submit-appointment"] [name="status"]') !== null`);
    await evaluate(`(() => {
        const f = document.querySelector('form[data-action="submit-appointment"]');
        f.querySelector('[name="status"]').value = 'Cancelled';
        f.requestSubmit();
        return true;
    })()`);
    await waitFor(`!document.querySelector('form[data-action="submit-appointment"]')`);

    await click('[data-action="tab"][data-tab="dashboard"]');
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance')`);
    const revCancelled = await evaluate(revenueExpr);
    assert(revCancelled === '₹295', `cancelled ₹100 booking excluded -> Est. Revenue ₹295 (got ${revCancelled})`);

    console.log('\n[4] Deployed module is the gross-amount version (stale-cache guard)');
    const consistent = await evaluate(`(async () => {
        const { netRevenueFor } = await import('/js/core/revenue.js');
        // A ₹100 booking carrying tax/discount/refund must still be ₹100.
        // The OLD (net) implementation would have returned 143 here.
        const probe = { id: 'probe', serviceName: 'X', status: 'Completed', amount: 100, discount: 10, loyaltyRedemption: 5, tax: 18, refund: 20 };
        return netRevenueFor(probe, []) === 100;
    })()`);
    assert(consistent, 'in-page revenue module applies gross booked amount (₹100 stays ₹100)');

    console.log(`\n===== REVENUE E2E RESULT: ${pass} passed, ${fail} failed =====`);
    if (ws) ws.close();
    chrome.kill('SIGKILL');
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
    console.error('\nREVENUE E2E ERROR:', err.message);
    if (ws) try { ws.close(); } catch (e) { /* ignore */ }
    cleanup();
    process.exit(2);
});
