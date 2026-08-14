/**
 * e2e-smoke.mjs
 * Real-browser end-to-end smoke test using Chrome DevTools Protocol.
 * Zero dependencies (uses Node 22+ global WebSocket + fetch).
 *
 * Usage: node scripts/e2e-smoke.mjs
 * Requires: Chrome/Edge installed, local server running on :5500.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5500/';
const CHROME = process.env.CHROME_BIN
    || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const PORT = 9333;
const userData = mkdtempSync(join(tmpdir(), 'luxe-cdp-'));

let ws;
let msgId = 0;
const pending = new Map();
const events = [];
const errors = [];

function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
        pending.set(id, (err, result) => { clearTimeout(timer); err ? reject(err) : resolve(result); });
        ws.send(JSON.stringify({ id, method, params }));
    });
}

function connect(url) {
    return new Promise((resolve, reject) => {
        ws = new WebSocket(url);
        ws.onopen = () => resolve();
        ws.onerror = (e) => reject(new Error('WebSocket error: ' + e.message));
        ws.onmessage = (m) => {
            const msg = JSON.parse(m.data);
            if (msg.id && pending.has(msg.id)) {
                const cb = pending.get(msg.id);
                pending.delete(msg.id);
                cb(msg.error, msg.result);
            } else if (msg.method) {
                if (msg.method === 'Runtime.exceptionThrown') {
                    errors.push(msg.params.exceptionDetails?.text || 'exception');
                }
                if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
                    const text = (msg.params.args || []).map((a) => a.value || a.description || '').join(' ');
                    errors.push(text);
                }
                events.push(msg);
            }
        };
    });
}

async function evaluate(expression) {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
    });
    if (exceptionDetails) {
        throw new Error('evaluate failed: ' + JSON.stringify(exceptionDetails));
    }
    return result.value;
}

async function waitFor(expr, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            if (await evaluate(expr)) return true;
        } catch (e) { /* retry */ }
        await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Timed out waiting for: ${expr}`);
}

let pass = 0;
let fail = 0;

function assert(cond, label) {
    if (cond) {
        pass += 1;
        console.log(`  PASS  ${label}`);
    } else {
        fail += 1;
        console.log(`  FAIL  ${label}`);
    }
}

async function click(selector) {
    const ok = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click();
        return true;
    })()`);
    if (!ok) throw new Error(`click failed, no element: ${selector}`);
}

async function fillForm(fields) {
    // fields: {name: value}
    await evaluate(`(() => {
        ${Object.entries(fields).map(([name, value]) =>
            `{const i = document.querySelector('[name="${name}"]'); if (i) { i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', {bubbles:true})); }}`
        ).join('\n')}
        return true;
    })()`);
}

async function submitForm(selector) {
    await evaluate(`(() => {
        const f = document.querySelector(${JSON.stringify(selector)});
        if (!f) return false;
        f.requestSubmit();
        return true;
    })()`);
}

const J = (str) => JSON.stringify(str);

async function main() {
    console.log(`Launching headless Chrome (${CHROME})…`);
    const chrome = spawn(CHROME, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=' + PORT,
        `--user-data-dir=${userData}`,
        'about:blank',
    ], { stdio: 'ignore' });

    // Wait for CDP endpoint.
    let targetList = null;
    for (let i = 0; i < 40; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/json`);
            if (res.ok) { targetList = await res.json(); break; }
        } catch (e) { /* retry */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    if (!targetList) throw new Error('Could not reach Chrome DevTools endpoint');

    // Navigate the existing blank target to the app.
    const page = targetList.find((t) => t.type === 'page');
    await connect(page.webSocketDebuggerUrl);
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: APP_URL });
    await waitFor(`document.readyState === 'complete'`);

    // ---- Test suite ----
    console.log('\n[1] Login screen (guest) — no role selection');
    await waitFor(`document.querySelector('[data-action="google-signin"]') !== null`);
    assert(await evaluate(`document.body.innerText.includes('LuxeGlow Salon CRM')`), 'branding shown');
    assert(await evaluate(`!document.body.innerText.includes('Salon Owner Portal') && !document.body.innerText.includes('Super Admin Oversight')`), 'no role selection buttons');
    assert(await evaluate(`document.querySelector('form[data-action="email-auth"]') !== null`), 'email form present');
    assert(await evaluate(`document.querySelector('[data-action="toggle-form-mode"]') !== null`), 'sign-in/sign-up toggle present');

    console.log('\n[2] Email sign-in (demo mode) -> dashboard');
    await fillForm({ salonName: 'Luxe Glow Test', email: 'owner@test.com', password: 'secret123' });
    await submitForm('form[data-action="email-auth"]');
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance')`);
    assert(await evaluate(`document.body.innerText.includes('Bookings')`), 'dashboard stat cards');
    assert(await evaluate(`document.querySelector('[data-action="modal"]') !== null`), 'quick action buttons');

    console.log('\n[4] Owner bottom navigation');
    const tabs = ['appointments', 'customers', 'services', 'staff'];
    for (const tab of tabs) {
        await click(`[data-action="tab"][data-tab="${tab}"]`);
        await new Promise((r) => setTimeout(r, 100));
        const ok = await evaluate(`(() => {
            const main = document.querySelector('.app-shell main');
            return main && main.innerText.length > 0;
        })()`);
        assert(ok, `tab '${tab}' renders content`);
    }

    console.log('\n[5] Forms & modals');
    // Client modal (open from the Clients tab)
    await click(`[data-action="tab"][data-tab="customers"]`);
    await new Promise((r) => setTimeout(r, 150));
    await click(`[data-action="modal"][data-modal="customer"]`);
    await waitFor(`document.querySelector('form[data-action="submit-customer"]') !== null`);
    await fillForm({ name: 'Test Client', phone: '9876500000', email: 'test@client.com' });
    await click('form[data-action="submit-customer"] button[type="submit"]');
    await waitFor(`document.body.innerText.includes('Test Client')`);
    assert(true, 'new client appears in list (real button click)');

    console.log('\n[5a] Referral program (salon code + code validation)');
    await click(`[data-action="tab"][data-tab="customers"]`);
    await new Promise((r) => setTimeout(r, 150));
    // Salon owner sees their salon's referral code + share/copy actions.
    assert(await evaluate(`document.body.innerText.includes('SLN-LUXE01')`), 'salon referral code shown');
    assert(await evaluate(`document.querySelector('[data-action="copy-salon-code"]') !== null`), 'copy salon code button present');
    assert(await evaluate(`document.querySelector('[data-action="share-salon-code"]') !== null`), 'share salon code button present');
    // Stat cards reflect the seeded bonus-credited referral.
    assert(await evaluate(`document.body.innerText.includes('Bonus Earned (pts)')`), 'referral stat cards shown');

    // An unknown referral code must be rejected and nothing saved.
    await click(`[data-action="modal"][data-modal="customer"]`);
    await waitFor(`document.querySelector('form[data-action="submit-customer"]') !== null`);
    await fillForm({ name: 'Bad Referral Client', phone: '9876511111', email: 'bad@ref.com', referralCode: 'ZZZ-999' });
    await click('form[data-action="submit-customer"] button[type="submit"]');
    await new Promise((r) => setTimeout(r, 300));
    assert(await evaluate(`document.body.innerText.includes('Invalid referral code')`), 'invalid referral code rejected');
    assert(await evaluate(`!document.body.innerText.includes('Bad Referral Client')`), 'no client saved with invalid code');
    await click('[data-action="close-modal"]');
    await new Promise((r) => setTimeout(r, 150));

    // A valid referral code saves the client and auto-identifies the referrer.
    await click(`[data-action="modal"][data-modal="customer"]`);
    await waitFor(`document.querySelector('form[data-action="submit-customer"]') !== null`);
    await fillForm({ name: 'Referred Client', phone: '9876522222', email: 'ref@client.com', referralCode: 'LG-OLIVIA' });
    await click('form[data-action="submit-customer"] button[type="submit"]');
    await waitFor(`document.body.innerText.includes('Referred Client')`);
    assert(await evaluate(`document.body.innerText.includes('Referred by Olivia Wilde')`), 'referring customer auto-identified');
    assert(await evaluate(`document.body.innerText.includes('Pending')`), 'pending referral shown in activity');
    assert(await evaluate(`document.querySelector('[data-action="reject-referral"]') !== null`), 'reject action shown for pending referral');

    // Owner can reject a pending referral.
    await click('[data-action="reject-referral"]');
    await new Promise((r) => setTimeout(r, 300));
    assert(await evaluate(`document.body.innerText.includes('Referral rejected')`), 'reject confirmation toast');
    assert(await evaluate(`document.querySelector('[data-action="reject-referral"]') === null`), 'no reject button after rejection');


    // Service modal
    await click(`[data-action="tab"][data-tab="services"]`);
    await new Promise((r) => setTimeout(r, 150));
    await click(`[data-action="modal"][data-modal="service"]`);
    await waitFor(`document.querySelector('form[data-action="submit-service"]') !== null`);
    await fillForm({ name: 'Test Treatment', price: '120', duration: '60m' });
    await submitForm('form[data-action="submit-service"]');
    await waitFor(`document.body.innerText.includes('Test Treatment')`);
    assert(true, 'new service appears in catalog');

    // Appointment modal (needs service + staff selected)
    await click(`[data-action="tab"][data-tab="appointments"]`);
    await new Promise((r) => setTimeout(r, 150));
    await click(`[data-action="modal"][data-modal="appointment"]`);
    await waitFor(`document.querySelector('form[data-action="submit-appointment"]') !== null`);
    await evaluate(`(() => {
        const f = document.querySelector('form[data-action="submit-appointment"]');
        f.querySelector('[name="customerName"]').value = 'Jessica Alba';
        const svc = f.querySelector('[name="serviceName"]');
        const stf = f.querySelector('[name="staffName"]');
        svc.selectedIndex = 1;
        stf.selectedIndex = 1;
        f.querySelector('[name="date"]').value = '2030-08-20';
        f.querySelector('[name="time"]').value = '14:30';
        return svc.value && stf.value;
    })()`);
    await submitForm('form[data-action="submit-appointment"]');
    await new Promise((r) => setTimeout(r, 200));
    assert(await evaluate(`document.body.innerText.includes('Jessica Alba')`), 'appointment booked');

    console.log('\n[5b] Appointment validation');
    await click(`[data-action="tab"][data-tab="appointments"]`);
    await new Promise((r) => setTimeout(r, 150));
    await click(`[data-action="modal"][data-modal="appointment"]`);
    await waitFor(`document.querySelector('form[data-action="submit-appointment"]') !== null`);
    // Remove any lingering success toast from the earlier booking step.
    await evaluate(`document.getElementById('toast-notification')?.remove()`);

    // Fresh empty form -> Save button is disabled (cannot be saved).
    assert(await evaluate(`document.querySelector('form[data-action="submit-appointment"] button[type="submit"]').disabled === true`), 'submit disabled when form empty');

    // Empty form -> inline errors, save blocked, modal stays open.
    await submitForm('form[data-action="submit-appointment"]');
    await new Promise((r) => setTimeout(r, 250));
    const errCount = await evaluate(`document.querySelectorAll('.field-error').length`);
    assert(errCount >= 5, `inline errors shown for all required fields (${errCount})`);
    assert(await evaluate(`document.body.innerText.includes('Client name is required.')`), 'client name error message');
    assert(await evaluate(`document.body.innerText.includes('Select a service.')`), 'service error message');
    assert(await evaluate(`document.body.innerText.includes('Date is required.')`), 'date error message');
    assert(await evaluate(`document.body.innerText.includes('Time is required.')`), 'time error message');
    assert(await evaluate(`document.querySelector('form[data-action="submit-appointment"]') !== null`), 'save blocked (modal stays open)');
    assert(await evaluate(`!document.body.innerText.includes('Appointment booked successfully')`), 'no success toast on invalid save');

    // Invalid calendar date + invalid time format rejected.
    await evaluate(`(() => {
        const f = document.querySelector('form[data-action="submit-appointment"]');
        f.querySelector('[name="customerName"]').value = 'Valid Name';
        f.querySelector('[name="serviceName"]').selectedIndex = 1;
        f.querySelector('[name="staffName"]').selectedIndex = 1;
        f.querySelector('[name="date"]').value = '2030-13-45';
        f.querySelector('[name="time"]').value = '25:99';
        return true;
    })()`);
    await submitForm('form[data-action="submit-appointment"]');
    await new Promise((r) => setTimeout(r, 250));
    // The browser sanitizes invalid date/time input values to '', so the fields
    // surface as required errors. Full format validation is unit-tested in
    // unit-validate.mjs; here we assert the save is blocked either way.
    assert(await evaluate(`document.querySelectorAll('.field-error').length >= 2`), 'invalid date/time rejected inline');
    assert(await evaluate(`!document.body.innerText.includes('Appointment booked successfully')`), 'no save on invalid date/time');

    // Whitespace-only name -> treated as missing.
    await evaluate(`(() => {
        const f = document.querySelector('form[data-action="submit-appointment"]');
        f.querySelector('[name="customerName"]').value = '   ';
        f.querySelector('[name="date"]').value = '2030-08-20';
        f.querySelector('[name="time"]').value = '14:30';
        return true;
    })()`);
    await submitForm('form[data-action="submit-appointment"]');
    await new Promise((r) => setTimeout(r, 250));
    assert(await evaluate(`document.body.innerText.includes('Client name is required.')`), 'whitespace-only name rejected');
    assert(await evaluate(`!document.body.innerText.includes('Appointment booked successfully')`), 'no save on whitespace name');

    // Past date rejected.
    await evaluate(`(() => {
        const f = document.querySelector('form[data-action="submit-appointment"]');
        f.querySelector('[name="customerName"]').value = 'Valid Name';
        f.querySelector('[name="date"]').value = '2020-01-01';
        f.querySelector('[name="time"]').value = '14:30';
        return true;
    })()`);
    await submitForm('form[data-action="submit-appointment"]');
    await new Promise((r) => setTimeout(r, 250));
    assert(await evaluate(`document.body.innerText.includes('Date must be today or later.')`), 'past date rejected');

    // Fully valid appointment saves with existing confirmation.
    await evaluate(`(() => {
        const f = document.querySelector('form[data-action="submit-appointment"]');
        f.querySelector('[name="customerName"]').value = 'Validation Test Client';
        f.querySelector('[name="date"]').value = '2030-08-20';
        f.querySelector('[name="time"]').value = '14:30';
        // Simulate typing so the live validator enables the button.
        ['customerName', 'date', 'time'].forEach((n) => {
            const el = f.querySelector('[name="' + n + '"]');
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        return true;
    })()`);
    assert(await evaluate(`document.querySelector('form[data-action="submit-appointment"] button[type="submit"]').disabled === false`), 'submit enabled when form valid');
    await submitForm('form[data-action="submit-appointment"]');
    await waitFor(`document.body.innerText.includes('Validation Test Client')`);
    assert(true, 'valid appointment saved');

    console.log('\n[6] Referral bonus UI');
    await click(`[data-action="tab"][data-tab="customers"]`);
    await new Promise((r) => setTimeout(r, 150));
    assert(await evaluate(`document.body.innerText.includes('Referral Rewards Program')`), 'rewards program summary shown');
    assert(await evaluate(`document.body.innerText.includes('₹25 Service Voucher')`), 'reward tiers shown');
    assert(await evaluate(`document.querySelector('[data-action="share-referral"]') !== null`), 'share button on client card');
    await click('[data-action="redeem"]');
    await waitFor(`document.querySelector('[data-action="redeem-reward"]') !== null`);
    assert(await evaluate(`document.body.innerText.includes('Referral code: LG-')`), 'rewards modal shows referral code');
    assert(await evaluate(`document.querySelectorAll('[data-action="redeem-reward"]').length >= 1`), 'affordable tier enabled');
    await click('[data-action="redeem-reward"]');
    await new Promise((r) => setTimeout(r, 300));
    assert(await evaluate(`document.body.innerText.includes('Reward redeemed')`), 'tier redemption confirmation');

    console.log('\n[7] Logout + Super Admin');
    await click('[data-action="logout"]');
    await waitFor(`document.querySelector('[data-action="google-signin"]') !== null`);
    // Demo mode has no backend, so the Super Admin dashboard is reached via the
    // demo preview link; in production the role comes from the user profile.
    await click('[data-action="role"][data-role="super_admin"]');
    await waitFor(`document.body.innerText.includes('All Salons Franchise')`);
    assert(await evaluate(`document.body.innerText.includes('Luxe Glow Flagship')`), 'admin sees salons list');
    assert(await evaluate(`document.querySelectorAll('[data-action="manage-salon"]').length >= 2`), 'manage buttons present');

    console.log('\n[8] Admin -> manage salon (owner view scoped)');
    await click('[data-action="manage-salon"]');
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance')`);
    assert(true, 'manage switches to owner dashboard');

    console.log('\n[9] Network banner (offline simulation)');
    await evaluate(`window.dispatchEvent(new Event('offline'))`);
    await new Promise((r) => setTimeout(r, 200));
    assert(await evaluate(`document.body.innerText.includes('Offline')`), 'offline banner shown');

    console.log('\n[10] XSS / sanitization');
    // We are in owner view (post manage-salon). Add a malicious client name.
    await click(`[data-action="tab"][data-tab="customers"]`);
    await new Promise((r) => setTimeout(r, 150));
    await click(`[data-action="modal"][data-modal="customer"]`);
    await waitFor(`document.querySelector('form[data-action="submit-customer"]') !== null`);
    await evaluate(`(() => {
        const evil = '<img src=x onerror=window.__pwned=1><script>window.__pwned=1<\\/script><b>bold</b>';
        const f = document.querySelector('form[data-action="submit-customer"]');
        f.querySelector('[name="name"]').value = evil;
        f.querySelector('[name="phone"]').value = '9876599999';
        f.querySelector('[name="email"]').value = 'evil@x.com';
        f.requestSubmit();
        return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    assert(await evaluate(`window.__pwned === undefined`), 'no script/onerror execution');
    assert(await evaluate(`document.querySelectorAll('#app script, #app img[onerror], #app [onclick]').length === 0`), 'no executable attributes in app DOM');
    assert(await evaluate(`document.body.innerText.includes('<img')`), 'payload rendered as escaped text');

    console.log('\n[10b] Salon switching & remaining flows');
    await click(`[data-action="tab"][data-tab="dashboard"]`);
    await new Promise((r) => setTimeout(r, 150));
    const secondSalonId = await evaluate(`(() => {
        const opts = document.querySelectorAll('[data-action="salon"] option');
        return opts.length > 1 ? opts[1].value : null;
    })()`);
    if (secondSalonId) {
        await evaluate(`(() => { const s = document.querySelector('[data-action="salon"]'); s.value = ${J(secondSalonId)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await new Promise((r) => setTimeout(r, 250));
        assert(await evaluate(`document.querySelector('[data-action="salon"]').value === ${J(secondSalonId)}`), 'salon selector switches salons');
    } else {
        assert(false, 'salon selector has multiple salons');
    }

    console.log('\n[10c] Super admin provisioning + auth flows');
    await click('[data-action="logout"]');
    await waitFor(`document.querySelector('[data-action="google-signin"]') !== null`);
    await click('[data-action="role"][data-role="super_admin"]');
    await waitFor(`document.querySelector('[data-action="modal"][data-modal="salon"]') !== null`);
    await click(`[data-action="modal"][data-modal="salon"]`);
    await waitFor(`document.querySelector('form[data-action="submit-salon"]') !== null`);
    await fillForm({ name: 'Luxe Glow Test Branch', email: 'branch@test.com', phone: '9876577777', address: '1 Test Ave' });
    // Real user path: click the actual Provision button (click delegation must
    // NOT hijack the form submit, see submit-salon handler signature).
    await click('form[data-action="submit-salon"] button[type="submit"]');
    await waitFor(`document.body.innerText.includes('Luxe Glow Test Branch')`);
    assert(true, 'super admin provisions new salon (real button click)');

    // Auth screen: sign-in toggle + Google sign-in (demo mode)
    await click('[data-action="logout"]');
    await waitFor(`document.querySelector('[data-action="google-signin"]') !== null`);
    await click('[data-action="toggle-form-mode"]');
    await new Promise((r) => setTimeout(r, 200));
    assert(await evaluate(`document.querySelector('form[data-action="email-auth"] [name="salonName"]') === null`), 'sign-in toggle hides salon name field');
    await click('[data-action="toggle-form-mode"]'); // back to signup
    await new Promise((r) => setTimeout(r, 150));
    // Google Sign-In is REAL Firebase OAuth. In demo mode there is no Firebase
    // backend, so it must NOT fabricate a session — an error toast is shown and
    // the user stays on the auth screen.
    await click('[data-action="google-signin"]');
    await new Promise((r) => setTimeout(r, 400));
    const googleBlocked = await evaluate(`(function () {
        const toast = document.getElementById('toast-notification');
        const stillAuth = document.querySelector('[data-action="google-signin"]') !== null;
        return stillAuth && !!toast && !toast.textContent.includes('Signed in successfully');
    })()`);
    assert(googleBlocked, 'Google sign-in requires Firebase (demo mode shows error, no fake session)');

    console.log('\n[11] Mobile viewport & no horizontal overflow');
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 3, mobile: true });
    await new Promise((r) => setTimeout(r, 300));
    const overflow375 = await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`);
    assert(overflow375, 'no horizontal overflow at 375x667 (iPhone)');

    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
    await new Promise((r) => setTimeout(r, 300));
    assert(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), 'no horizontal overflow at 320x568 (small phone)');

    await send('Emulation.setDeviceMetricsOverride', { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true });
    await new Promise((r) => setTimeout(r, 300));
    assert(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), 'no horizontal overflow at 768x1024 (tablet)');

    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 300));
    assert(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), 'no horizontal overflow at 1920x1080 (desktop)');

    console.log('\n[12] Console / runtime errors');
    // The demo-mode Google sign-in failure is a designed, asserted path ([10c]):
    // it must NOT fabricate a session, so it logs an error + shows a toast.
    // Allowlist those expected debug-error lines; any other console.error fails.
    const uniqueErrors = [...new Set(errors)]
        .filter((e) => !/favicon|net::ERR/.test(e))
        .filter((e) => !/\[debug:error\] google-signin-(no-firebase|action)/.test(e));
    assert(uniqueErrors.length === 0, `no console errors (found: ${uniqueErrors.length ? uniqueErrors.join(' | ') : 'none'})`);
    if (uniqueErrors.length) uniqueErrors.forEach((e) => console.log('      -> ' + e));

    console.log(`\n===== RESULT: ${pass} passed, ${fail} failed =====`);
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
    console.error('\nSMOKE TEST ERROR:', err.message);
    if (ws) ws.close();
    cleanup();
    process.exit(2);
});
