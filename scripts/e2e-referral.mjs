/**
 * e2e-referral.mjs
 * Real-browser end-to-end verification of the referral programme, driven
 * through the actual UI (Chrome DevTools Protocol, zero dependencies).
 *
 * Covers the whole documented flow and every way it can go wrong:
 *   code allocation -> registration with a code -> Pending -> completion ->
 *   payment -> Credited -> partial redemption -> full redemption -> Redeemed,
 *   plus invalid codes, self-referral, duplicate referrals, non-qualifying and
 *   unpaid invoices, duplicate reward credits, redemption limits, split
 *   payment, refund reversal, redemption reversal and cancellation reversal.
 *
 * Modules are imported inside the page for assertions and for setting up the
 * secondary chains; the primary journey is driven by real clicks and forms.
 *
 * Usage: node scripts/e2e-referral.mjs  (server on :5500)
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5500/';
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9335;
const userData = mkdtempSync(join(tmpdir(), 'luxe-ref-'));

let ws;
let msgId = 0;
const pending = new Map();
const errors = [];

function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 20000);
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
            } else if (msg.method === 'Runtime.exceptionThrown') {
                errors.push(msg.params.exceptionDetails?.text || 'exception');
            } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
                errors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
            }
        };
    });
}

async function evaluate(expression) {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(exceptionDetails).slice(0, 400));
    return result.value;
}

async function waitFor(expr, timeoutMs = 8000) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
        try { if (await evaluate(expr)) return true; } catch (e) { last = e; }
        await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error(`Timed out waiting for: ${expr}${last ? ' (' + last.message + ')' : ''}`);
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, label) {
    if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
    else { fail += 1; failures.push(label); console.log(`  FAIL  ${label}`); }
}

async function click(selector) {
    const ok = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click();
        return true;
    })()`);
    if (!ok) throw new Error(`click failed, no element: ${selector}`);
    await pause(120);
}

/** Set form fields and fire input events so the live validator keeps up. */
async function fill(formSelector, fields) {
    await evaluate(`(() => {
        const f = document.querySelector(${JSON.stringify(formSelector)});
        if (!f) return false;
        const values = ${JSON.stringify(fields)};
        Object.keys(values).forEach((name) => {
            const el = f.querySelector('[name="' + name + '"]');
            if (!el) return;
            el.value = values[name];
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        return true;
    })()`);
    await pause(120);
}

async function submit(formSelector) {
    await evaluate(`document.querySelector(${JSON.stringify(formSelector)}).requestSubmit()`);
    await pause(350);
}

/**
 * Case-insensitive page-text check. innerText reflects rendered text, and
 * several labels are uppercased by CSS, so raw case comparison is unreliable.
 */
async function bodyHas(text) {
    return evaluate(`document.body.innerText.toLowerCase().includes(${JSON.stringify(String(text).toLowerCase())})`);
}

const bodyHasExpr = (text) => `document.body.innerText.toLowerCase().includes(${JSON.stringify(String(text).toLowerCase())})`;

async function toastText() {
    return evaluate(`(document.getElementById('toast-notification') || {}).innerText || ''`);
}

async function clearToast() {
    await evaluate(`document.getElementById('toast-notification')?.remove()`);
}

/** Read a value out of the live store. `expr` may use `s` (the state). */
async function fromStore(expr) {
    return evaluate(`(async () => {
        const { store } = await import('/js/core/store.js');
        const s = store.getState();
        return (${expr});
    })()`);
}

/** Run code with the referral modules in scope. */
async function withServices(body) {
    return evaluate(`(async () => {
        const { store } = await import('/js/core/store.js');
        const referralService = await import('/js/services/referralService.js');
        const referrals = await import('/js/services/referralsRepository.js');
        const customers = await import('/js/services/customersRepository.js');
        const appointments = await import('/js/services/appointmentsRepository.js');
        const s = store.getState();
        ${body}
    })()`);
}

const findCustomer = (name) => `(s.customersList.find((c) => c.name === ${JSON.stringify(name)}) || null)`;
const referralFor = (name) => `(s.referralsList.find((r) => r.referredName === ${JSON.stringify(name)}) || null)`;

async function main() {
    console.log(`Launching headless Chrome (${CHROME})…`);
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=' + PORT, `--user-data-dir=${userData}`, 'about:blank',
    ], { stdio: 'ignore' });

    let targetList = null;
    for (let i = 0; i < 40; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/json`);
            if (res.ok) { targetList = await res.json(); break; }
        } catch (e) { /* retry */ }
        await pause(250);
    }
    if (!targetList) throw new Error('Could not reach Chrome DevTools endpoint');

    const page = targetList.find((t) => t.type === 'page');
    await connect(page.webSocketDebuggerUrl);
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: APP_URL });
    await waitFor(`document.readyState === 'complete'`);

    /* ------------------------------------------------------------------ */
    console.log('\n[1] Sign in and reach the owner dashboard');
    await waitFor(`document.querySelector('form[data-action="email-auth"]') !== null`);
    await fill('form[data-action="email-auth"]', { salonName: 'Referral Test Salon', email: 'owner@ref.test', password: 'secret123' });
    await submit('form[data-action="email-auth"]');
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance')`);
    assert(true, 'owner dashboard reached');

    /* ------------------------------------------------------------------ */
    console.log('\n[2] Referrals tab and automatic code backfill');
    await click('[data-action="tab"][data-tab="referrals"]');
    await waitFor(bodyHasExpr('Referral Programme'));
    assert(await bodyHas('Total referrals'), 'referral summary panel renders');
    assert(await evaluate(`document.querySelector('[data-referral-list]') !== null`), 'referral list container renders');

    // Existing (pre-programme) clients are given codes by the maintenance pass.
    await waitFor(`(async () => {
        const { store } = await import('/js/core/store.js');
        return (store.getState().customersList || []).every((c) => !!c.referralCode);
    })()`, 8000);
    assert(true, 'existing clients were backfilled with referral codes');
    const seedCodes = await fromStore(`s.customersList.map((c) => c.referralCode)`);
    assert(new Set(seedCodes).size === seedCodes.length, 'backfilled codes are unique');
    assert(seedCodes.every((c) => /^[A-HJ-NP-Z2-9]{8}$/.test(c)), 'backfilled codes use the unambiguous 8-char alphabet');

    /* ------------------------------------------------------------------ */
    console.log('\n[3] Owner configures the referral programme');
    await click('[data-action="referral-tab"][data-referral-tab="settings"]');
    await waitFor(`document.querySelector('form[data-action="submit-referral-settings"]') !== null`);
    await fill('form[data-action="submit-referral-settings"]', {
        rewardType: 'fixed',
        rewardValue: '100',
        maxRewardAmount: '0',
        minInvoiceAmount: '500',
        rewardTrigger: 'invoice_paid',
        expiryDays: '90',
        maxRedemptionPercent: '50',
    });
    await submit('form[data-action="submit-referral-settings"]');
    await pause(300);
    const saved = await fromStore(`s.referralSettings`);
    assert(saved && saved.rewardValue === 100 && saved.minInvoiceAmount === 500, 'reward value and minimum invoice saved');
    assert(saved.maxRedemptionPercent === 50 && saved.expiryDays === 90, 'redemption cap and expiry saved');
    assert(saved.enabled === true && saved.rewardTrigger === 'invoice_paid', 'programme enabled with the paid-invoice trigger');

    // Out-of-range settings are rejected by the shared validator.
    await fill('form[data-action="submit-referral-settings"]', { maxRedemptionPercent: '250' });
    assert(await evaluate(`document.querySelector('form[data-action="submit-referral-settings"] button[type="submit"]').disabled === true`), 'save disabled for an out-of-range redemption cap');
    await fill('form[data-action="submit-referral-settings"]', { maxRedemptionPercent: '50' });
    assert(await evaluate(`document.querySelector('form[data-action="submit-referral-settings"] button[type="submit"]').disabled === false`), 'save re-enabled once the value is valid');

    /* ------------------------------------------------------------------ */
    console.log('\n[4] Register the referrer and read their code');
    await click('[data-action="tab"][data-tab="customers"]');
    await click('[data-action="modal"][data-modal="customer"]');
    await waitFor(`document.querySelector('form[data-action="submit-customer"]') !== null`);
    assert(await evaluate(`document.querySelector('form[data-action="submit-customer"] [name="referralCode"]') !== null`), 'new-client form offers a referral code field');
    await fill('form[data-action="submit-customer"]', { name: 'Rhea Kapoor', phone: '9000000001', email: 'rhea@ref.test' });
    await submit('form[data-action="submit-customer"]');
    await waitFor(`document.body.innerText.includes('Rhea Kapoor')`);

    await waitFor(`(async () => {
        const { store } = await import('/js/core/store.js');
        const c = (store.getState().customersList || []).find((x) => x.name === 'Rhea Kapoor');
        return !!(c && c.referralCode);
    })()`);
    const referrerCode = await fromStore(`${findCustomer('Rhea Kapoor')}.referralCode`);
    assert(/^[A-HJ-NP-Z2-9]{8}$/.test(referrerCode), `referrer received a valid code (${referrerCode})`);
    assert(await fromStore(`${findCustomer('Rhea Kapoor')}.walletBalance`) === 0, 'new client starts with an empty referral wallet');

    // The profile sheet surfaces the code and the referral figures.
    await click(`[data-action="customer-profile"][data-id="${await fromStore(`${findCustomer('Rhea Kapoor')}.id`)}"]`);
    await waitFor(bodyHasExpr('Referral code'));
    assert(await bodyHas(referrerCode), 'profile shows the referral code');
    assert(await bodyHas('Available referral balance'), 'profile shows the available balance');
    assert(await bodyHas('Total referrals'), 'profile shows the referral counters');
    await click('[data-action="close-modal"]');

    /* ------------------------------------------------------------------ */
    console.log('\n[5] Invalid and self-referral codes are rejected');
    const beforeInvalid = await fromStore(`s.customersList.length`);
    await click('[data-action="modal"][data-modal="customer"]');
    await waitFor(`document.querySelector('form[data-action="submit-customer"]') !== null`);
    await fill('form[data-action="submit-customer"]', { name: 'Bad Code Client', phone: '9000000009', email: 'bad@ref.test', referralCode: 'ABC' });
    assert(await evaluate(`document.querySelector('form[data-action="submit-customer"] button[type="submit"]').disabled === true`), 'malformed referral code blocks the save button');

    await clearToast();
    await fill('form[data-action="submit-customer"]', { referralCode: 'ZZZZZZZZ' });
    await submit('form[data-action="submit-customer"]');
    await pause(300);
    assert(/No client owns that referral code/.test(await toastText()), 'unknown referral code is rejected');
    assert(await fromStore(`s.customersList.length`) === beforeInvalid, 'no client is created when the code is unknown');

    await clearToast();
    // Same email as the referrer -> the same person referring themselves.
    await fill('form[data-action="submit-customer"]', { name: 'Rhea Alt', phone: '9000000008', email: 'rhea@ref.test', referralCode: referrerCode });
    await submit('form[data-action="submit-customer"]');
    await pause(300);
    assert(/cannot refer themselves/.test(await toastText()), 'self-referral by matching email is rejected');
    assert(await fromStore(`s.customersList.length`) === beforeInvalid, 'no client is created on a self-referral attempt');
    await click('[data-action="close-modal"]');

    /* ------------------------------------------------------------------ */
    console.log('\n[6] Register the referred client with a valid code');
    await clearToast();
    await click('[data-action="modal"][data-modal="customer"]');
    await waitFor(`document.querySelector('form[data-action="submit-customer"]') !== null`);
    await fill('form[data-action="submit-customer"]', { name: 'Ishita Rao', phone: '9000000003', email: 'ishita@ref.test', referralCode: referrerCode });
    await submit('form[data-action="submit-customer"]');
    await waitFor(`(async () => {
        const { store } = await import('/js/core/store.js');
        return (store.getState().referralsList || []).some((r) => r.referredName === 'Ishita Rao');
    })()`);

    const referral = await fromStore(referralFor('Ishita Rao'));
    assert(referral.status === 'Pending', 'referral opens in Pending');
    assert(referral.code === referrerCode, 'referral records the code that was used');
    assert(referral.rewardAmount === 0, 'no reward is credited at registration');
    assert(referral.minInvoiceAmount === 500 && referral.rewardValue === 100, 'referral snapshots the terms it was created under');
    assert(await fromStore(`${findCustomer('Ishita Rao')}.referredBy`) === referral.referrerId, 'referred client records their referrer');

    await click('[data-action="tab"][data-tab="referrals"]');
    // Step 3 left the Settings sub-tab active; go back to the referral list.
    await click('[data-action="referral-tab"][data-referral-tab="list"]');
    await waitFor(bodyHasExpr('Ishita Rao'));
    assert(await bodyHas('Rhea Kapoor'), 'referral list shows the referrer');
    assert(await bodyHas('Pending'), 'referral list shows the Pending status');

    /* ------------------------------------------------------------------ */
    console.log('\n[7] Only one referrer per client');
    const dupe = await withServices(`
        const referred = s.customersList.find((c) => c.name === 'Ishita Rao');
        try {
            await referralService.linkReferral(referred, ${JSON.stringify(referrerCode)});
            return 'linked-again';
        } catch (err) { return err.message; }
    `);
    assert(/already has a referrer/.test(dupe), 'a second referrer is rejected');
    assert(await fromStore(`s.referralsList.filter((r) => r.referredName === 'Ishita Rao').length`) === 1, 'exactly one referral exists for the client');

    /* ------------------------------------------------------------------ */
    console.log('\n[8] Filters and search over the referral list');
    await click('[data-action="referral-filter"][data-status="Credited"]');
    await pause(200);
    assert(await evaluate(`document.querySelector('[data-referral-list]').innerText.includes('No referrals match')`), 'filtering by Credited hides the pending referral');
    await click('[data-action="referral-filter"][data-status="Pending"]');
    await pause(200);
    assert(await evaluate(`document.querySelector('[data-referral-list]').innerText.includes('Ishita Rao')`), 'filtering by Pending shows it again');
    await click('[data-action="referral-filter"][data-status="all"]');
    await pause(200);

    await evaluate(`(() => {
        const el = document.querySelector('[data-action="referral-search"]');
        el.value = 'zzzz-no-match';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);
    await pause(400);
    assert(await evaluate(`document.querySelector('[data-referral-list]').innerText.includes('No referrals match')`), 'search narrows the list');
    await evaluate(`(() => {
        const el = document.querySelector('[data-action="referral-search"]');
        el.value = 'Ishita';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);
    await pause(400);
    assert(await evaluate(`document.querySelector('[data-referral-list]').innerText.includes('Ishita Rao')`), 'search finds a referral by referred client name');
    await evaluate(`(() => {
        const el = document.querySelector('[data-action="referral-search"]');
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);
    await pause(400);

    /* ------------------------------------------------------------------ */
    console.log('\n[9] Completion without payment does not credit');
    const apptA = await withServices(`
        const referred = s.customersList.find((c) => c.name === 'Ishita Rao');
        const row = await appointments.addAppointment({
            customerId: referred.id, customerName: referred.name,
            serviceName: 'Balayage & Gloss', staffName: 'Victoria Sterling',
            date: '2030-09-01', time: '10:00', status: 'Confirmed',
        });
        return row.id;
    `);
    await click('[data-action="tab"][data-tab="appointments"]');
    await pause(200);
    await click(`[data-action="update-appointment-status"][data-id="${apptA}"][data-status="In Progress"]`);
    await click(`[data-action="update-appointment-status"][data-id="${apptA}"][data-status="Completed"]`);
    await pause(400);
    assert(await fromStore(`${referralFor('Ishita Rao')}.status`) === 'Pending', 'completed but unpaid appointment leaves the referral Pending');
    assert(await fromStore(`${findCustomer('Rhea Kapoor')}.walletBalance`) === 0, 'referrer wallet is untouched');

    /* ------------------------------------------------------------------ */
    console.log('\n[10] Paid but non-qualifying invoice does not credit');
    await clearToast();
    await click(`[data-action="open-payment"][data-id="${apptA}"]`);
    await waitFor(`document.querySelector('form[data-action="collect-payment"]') !== null`);
    await fill('form[data-action="collect-payment"]', { invoiceAmount: '300', paymentMethod: 'cash' });
    await submit('form[data-action="collect-payment"]');
    await pause(500);
    assert(await fromStore(`s.appointmentsList.find((a) => a.id === ${JSON.stringify(apptA)}).paid`) === true, 'invoice is settled');
    assert(await fromStore(`${referralFor('Ishita Rao')}.status`) === 'Pending', 'invoice below the minimum leaves the referral Pending');
    assert(await fromStore(`${findCustomer('Rhea Kapoor')}.walletBalance`) === 0, 'no reward is credited for a non-qualifying invoice');

    /* ------------------------------------------------------------------ */
    console.log('\n[11] First qualifying invoice credits the reward');
    const apptB = await withServices(`
        const referred = s.customersList.find((c) => c.name === 'Ishita Rao');
        const row = await appointments.addAppointment({
            customerId: referred.id, customerName: referred.name,
            serviceName: 'Balayage & Gloss', staffName: 'Victoria Sterling',
            date: '2030-09-05', time: '11:00', status: 'Confirmed',
        });
        return row.id;
    `);
    await click('[data-action="tab"][data-tab="appointments"]');
    await pause(200);
    await click(`[data-action="update-appointment-status"][data-id="${apptB}"][data-status="In Progress"]`);
    await click(`[data-action="update-appointment-status"][data-id="${apptB}"][data-status="Completed"]`);
    await pause(300);
    await clearToast();
    await click(`[data-action="open-payment"][data-id="${apptB}"]`);
    await waitFor(`document.querySelector('form[data-action="collect-payment"]') !== null`);
    await fill('form[data-action="collect-payment"]', { invoiceAmount: '1000', paymentMethod: 'upi' });
    await submit('form[data-action="collect-payment"]');
    await pause(600);

    const credited = await fromStore(referralFor('Ishita Rao'));
    assert(credited.status === 'Credited', 'referral moves to Credited');
    assert(credited.rewardAmount === 100, 'fixed reward of 100 is applied');
    assert(credited.qualifyingAppointmentId === apptB, 'referral records the qualifying appointment');
    assert(credited.qualifyingInvoiceAmount === 1000, 'referral records the qualifying invoice amount');
    assert(!!credited.qualifyingInvoiceNo, 'referral records the qualifying invoice number');
    assert(!!credited.creditedAt && !!credited.expiresAt, 'referral records credit and expiry timestamps');
    assert(await fromStore(`${findCustomer('Rhea Kapoor')}.walletBalance`) === 100, 'referrer wallet is credited with 100');

    const creditTx = await fromStore(`s.walletTransactionsList.find((t) => t.type === 'REFERRAL_CREDIT')`);
    assert(!!creditTx, 'a wallet ledger row was written');
    assert(creditTx.balanceBefore === 0 && creditTx.balanceAfter === 100, 'ledger row records the balance before and after');
    assert(creditTx.source === 'REFERRAL', 'ledger row is tagged as referral money, separate from loyalty');
    assert(creditTx.referralId === credited.id, 'ledger row is traceable to its referral');

    /* ------------------------------------------------------------------ */
    console.log('\n[12] Duplicate reward credits are impossible');
    const replay = await withServices(`
        const appt = s.appointmentsList.find((a) => a.id === ${JSON.stringify(apptB)});
        const first = await referralService.settleAppointment(appt);
        const second = await referralService.settleAppointment(appt);
        return { first, second };
    `);
    assert(replay.first.credited === false && replay.second.credited === false, 'replaying settlement never credits again');
    assert(replay.first.reason === 'already-settled', 'the replay is refused as already settled');
    assert(await fromStore(`${findCustomer('Rhea Kapoor')}.walletBalance`) === 100, 'wallet balance is unchanged after replays');
    assert(await fromStore(`s.walletTransactionsList.filter((t) => t.type === 'REFERRAL_CREDIT').length`) === 1, 'only one credit row exists in the ledger');

    /* ------------------------------------------------------------------ */
    console.log('\n[13] Partial redemption with a wallet + UPI split');
    const referrerId = await fromStore(`${findCustomer('Rhea Kapoor')}.id`);
    const apptC = await withServices(`
        const referrer = s.customersList.find((c) => c.name === 'Rhea Kapoor');
        const row = await appointments.addAppointment({
            customerId: referrer.id, customerName: referrer.name,
            serviceName: 'Signature Facial', staffName: 'Julian Vance',
            date: '2030-09-10', time: '12:00', status: 'Confirmed',
        });
        return row.id;
    `);
    await click('[data-action="tab"][data-tab="appointments"]');
    await pause(200);
    await clearToast();
    await click(`[data-action="open-payment"][data-id="${apptC}"]`);
    await waitFor(`document.querySelector('form[data-action="collect-payment"]') !== null`);
    assert(await bodyHas('Referral wallet'), 'billing sheet offers the referral wallet');
    await fill('form[data-action="collect-payment"]', { invoiceAmount: '1000' });
    await pause(200);
    assert(await evaluate(`document.querySelector('[data-payment-summary]').innerText.includes('Maximum redeemable')`), 'billing sheet shows the redemption ceiling');
    await fill('form[data-action="collect-payment"]', { walletRedeem: '40', paymentMethod: 'upi' });
    await pause(200);
    assert(await evaluate(`document.querySelector('[data-payment-summary]').innerText.includes('960')`), 'live summary shows the remaining amount due');
    await submit('form[data-action="collect-payment"]');
    await pause(600);

    const billedC = await fromStore(`s.appointmentsList.find((a) => a.id === ${JSON.stringify(apptC)})`);
    assert(billedC.walletRedeemed === 40 && billedC.amountDue === 960, 'invoice splits into 40 wallet + 960 UPI');
    assert(billedC.walletBalanceBefore === 100 && billedC.walletBalanceAfter === 60, 'invoice records the wallet balance before and after');
    assert(billedC.paymentMethod === 'upi', 'the non-wallet leg records its payment method');
    assert(await fromStore(`${findCustomer('Rhea Kapoor')}.walletBalance`) === 60, 'wallet balance drops by the redeemed amount');
    assert(await fromStore(`${referralFor('Ishita Rao')}.redeemedAmount`) === 40, 'the redemption is booked against the referral that earned it');
    assert(await fromStore(`${referralFor('Ishita Rao')}.status`) === 'Credited', 'a partially spent referral stays Credited');

    const redeemTx = await fromStore(`s.walletTransactionsList.find((t) => t.type === 'REFERRAL_REDEEM')`);
    assert(redeemTx.balanceBefore === 100 && redeemTx.amount === 40 && redeemTx.balanceAfter === 60, 'redemption ledger row records before/amount/after');
    assert(Array.isArray(redeemTx.allocations) && redeemTx.allocations.length === 1, 'redemption is allocated to a specific referral');

    /* ------------------------------------------------------------------ */
    console.log('\n[14] Redemption limits are enforced');
    const apptD = await withServices(`
        const referrer = s.customersList.find((c) => c.name === 'Rhea Kapoor');
        const row = await appointments.addAppointment({
            customerId: referrer.id, customerName: referrer.name,
            serviceName: 'Precision Haircut', staffName: 'Julian Vance',
            date: '2030-09-11', time: '12:00', status: 'Confirmed',
        });
        return row.id;
    `);
    await click('[data-action="tab"][data-tab="appointments"]');
    await pause(200);
    await clearToast();
    await click(`[data-action="open-payment"][data-id="${apptD}"]`);
    await waitFor(`document.querySelector('form[data-action="collect-payment"]') !== null`);

    // Beyond the available balance.
    await fill('form[data-action="collect-payment"]', { invoiceAmount: '1000', walletRedeem: '500', paymentMethod: 'cash' });
    await submit('form[data-action="collect-payment"]');
    await pause(400);
    assert(/exceeds the available referral balance/.test(await toastText()), 'redemption beyond the balance is refused');
    assert(await fromStore(`s.appointmentsList.find((a) => a.id === ${JSON.stringify(apptD)}).paid`) !== true, 'a refused redemption leaves the invoice unsettled');
    assert(await fromStore(`${findCustomer('Rhea Kapoor')}.walletBalance`) === 60, 'wallet is untouched by a refused redemption');

    // Beyond the invoice itself.
    await clearToast();
    await fill('form[data-action="collect-payment"]', { invoiceAmount: '30', walletRedeem: '50' });
    await pause(200);
    assert(await evaluate(`document.querySelector('form[data-action="collect-payment"] button[type="submit"]').disabled === true`), 'redemption above the invoice total blocks the save button');

    // Beyond the configured share of the invoice (50%).
    await clearToast();
    await fill('form[data-action="collect-payment"]', { invoiceAmount: '100', walletRedeem: '60', paymentMethod: 'cash' });
    await submit('form[data-action="collect-payment"]');
    await pause(400);
    assert(/50%/.test(await toastText()), 'redemption beyond the configured share is refused');
    assert(await fromStore(`${findCustomer('Rhea Kapoor')}.walletBalance`) === 60, 'wallet is untouched by an over-cap redemption');

    /* ------------------------------------------------------------------ */
    console.log('\n[15] Full redemption exhausts the referral');
    await clearToast();
    await fill('form[data-action="collect-payment"]', { invoiceAmount: '200', walletRedeem: '60', paymentMethod: 'cash' });
    await submit('form[data-action="collect-payment"]');
    await pause(600);
    assert(await fromStore(`${findCustomer('Rhea Kapoor')}.walletBalance`) === 0, 'wallet is emptied by a full redemption');
    assert(await fromStore(`${referralFor('Ishita Rao')}.status`) === 'Redeemed', 'a fully spent referral becomes Redeemed');
    const billedD = await fromStore(`s.appointmentsList.find((a) => a.id === ${JSON.stringify(apptD)})`);
    assert(billedD.walletRedeemed === 60 && billedD.amountDue === 140, 'the final invoice splits 60 wallet + 140 cash');

    /* ------------------------------------------------------------------ */
    console.log('\n[16] Refunding an invoice returns the wallet money it used');
    await clearToast();
    await click(`[data-action="open-payment"][data-id="${apptD}"]`);
    await waitFor(bodyHasExpr('Invoice settled'));
    assert(await bodyHas('Wallet before'), 'settled invoice shows the wallet audit line');
    await click('[data-action="refund-invoice"]');
    await pause(700);
    assert(await fromStore(`${findCustomer('Rhea Kapoor')}.walletBalance`) === 60, 'redeemed wallet money is returned on refund');
    assert(await fromStore(`${referralFor('Ishita Rao')}.status`) === 'Credited', 'the referral returns to Credited');
    assert(await fromStore(`${referralFor('Ishita Rao')}.redeemedAmount`) === 40, 'the returned amount is un-booked from the referral');
    assert(await fromStore(`s.appointmentsList.find((a) => a.id === ${JSON.stringify(apptD)}).refunded`) === true, 'the invoice is marked refunded');

    /* ------------------------------------------------------------------ */
    console.log('\n[17] Refunding the qualifying invoice reverses the reward');
    await clearToast();
    await click('[data-action="tab"][data-tab="appointments"]');
    await pause(200);
    await click(`[data-action="open-payment"][data-id="${apptB}"]`);
    await waitFor(bodyHasExpr('Invoice settled'));
    await click('[data-action="refund-invoice"]');
    await pause(700);
    const reversed = await fromStore(referralFor('Ishita Rao'));
    assert(reversed.status === 'Reversed', 'the referral is reversed when its qualifying invoice is refunded');
    assert(reversed.reversedAmount === 60, 'only the unspent remainder is clawed back');
    assert(/already redeemed/.test(reversed.reversalReason || ''), 'the already-spent portion is recorded on the referral');
    assert(await fromStore(`${findCustomer('Rhea Kapoor')}.walletBalance`) === 0, 'the unspent reward leaves the wallet');
    assert(await fromStore(`s.walletTransactionsList.some((t) => t.type === 'REFERRAL_REVERSAL')`), 'a reversal row is written to the ledger');

    /* ------------------------------------------------------------------ */
    console.log('\n[18] Cancelling a qualifying appointment reverses the reward');
    const chainB = await withServices(`
        const referrer = await customers.addCustomer({ name: 'Meera Nair', phone: '+919000000021', email: 'meera@ref.test' });
        const code = await referralService.ensureReferralCode(referrer);
        const referred = await customers.addCustomer({ name: 'Sana Ali', phone: '+919000000022', email: 'sana@ref.test' });
        await referralService.linkReferral(referred, code);
        const appt = await appointments.addAppointment({
            customerId: referred.id, customerName: referred.name,
            serviceName: 'Balayage & Gloss', staffName: 'Victoria Sterling',
            date: '2030-10-01', time: '10:00', status: 'Confirmed',
        });
        await appointments.updateAppointment(appt.id, {
            status: 'Completed', paid: true, invoiceAmount: 800, amount: 800,
        });
        const settled = await referralService.settleAppointment({
            ...appt, status: 'Completed', paid: true, invoiceAmount: 800,
        });
        return { apptId: appt.id, referrerId: referrer.id, settled };
    `);
    assert(chainB.settled.credited === true && chainB.settled.amount === 100, 'a second referral chain credits normally');
    assert(await fromStore(`s.customersList.find((c) => c.id === ${JSON.stringify(chainB.referrerId)}).walletBalance`) === 100, 'the second referrer is credited');

    await click('[data-action="tab"][data-tab="appointments"]');
    await pause(200);
    await click(`[data-action="open-edit"][data-type="appointment"][data-id="${chainB.apptId}"]`);
    await waitFor(`document.querySelector('form[data-action="submit-appointment"]') !== null`);
    await fill('form[data-action="submit-appointment"]', { status: 'Cancelled' });
    await submit('form[data-action="submit-appointment"]');
    await pause(700);
    assert(await fromStore(`${referralFor('Sana Ali')}.status`) === 'Reversed', 'cancelling the qualifying appointment reverses the referral');
    assert(await fromStore(`s.customersList.find((c) => c.id === ${JSON.stringify(chainB.referrerId)}).walletBalance`) === 0, 'the cancelled reward leaves the wallet');

    /* ------------------------------------------------------------------ */
    console.log('\n[19] Expiry sweep removes unspent credit past its window');
    const expiryResult = await withServices(`
        const referrer = await customers.addCustomer({ name: 'Tara Sethi', phone: '+919000000031', email: 'tara@ref.test' });
        const code = await referralService.ensureReferralCode(referrer);
        const referred = await customers.addCustomer({ name: 'Nikita Bose', phone: '+919000000032', email: 'nikita@ref.test' });
        await referralService.linkReferral(referred, code);
        const appt = await appointments.addAppointment({
            customerId: referred.id, customerName: referred.name,
            serviceName: 'Balayage & Gloss', staffName: 'Victoria Sterling',
            date: '2030-11-01', time: '10:00', status: 'Confirmed',
        });
        await referralService.settleAppointment({
            ...appt, status: 'Completed', paid: true, invoiceAmount: 900,
        });

        // Backdate the expiry so the sweep has something to collect.
        const referral = referrals.listReferrals().find((r) => r.referredId === referred.id);
        store.setState({
            referralsList: store.getState().referralsList.map((r) =>
                (r.id === referral.id ? { ...r, expiresAt: '2020-01-01T00:00:00.000Z' } : r)),
        });

        const expired = await referralService.expireDueReferrals();
        const again = await referralService.expireDueReferrals();
        const after = store.getState();
        return {
            expired,
            again,
            status: after.referralsList.find((r) => r.id === referral.id).status,
            balance: after.customersList.find((c) => c.id === referrer.id).walletBalance,
            expiryRows: after.walletTransactionsList.filter((t) => t.type === 'REFERRAL_EXPIRY').length,
        };
    `);
    assert(expiryResult.expired === 1, 'the sweep expires the overdue credit');
    assert(expiryResult.status === 'Expired', 'the referral is marked Expired');
    assert(expiryResult.balance === 0, 'the expired amount leaves the wallet');
    assert(expiryResult.again === 0 && expiryResult.expiryRows === 1, 're-running the sweep is a no-op');

    /* ------------------------------------------------------------------ */
    console.log('\n[20] Disabling the programme stops new rewards');
    const disabled = await withServices(`
        const settings = await import('/js/services/referralSettingsRepository.js');
        await settings.saveSettings({ enabled: false });
        const referrer = await customers.addCustomer({ name: 'Aisha Khan', phone: '+919000000041', email: 'aisha@ref.test' });
        const code = await referralService.ensureReferralCode(referrer);
        const referred = await customers.addCustomer({ name: 'Divya Menon', phone: '+919000000042', email: 'divya@ref.test' });
        let linkError = null;
        try { await referralService.linkReferral(referred, code); } catch (err) { linkError = err.message; }
        await settings.saveSettings({ enabled: true });
        return { linkError };
    `);
    assert(/disabled/.test(disabled.linkError || ''), 'no referral can be linked while the programme is off');

    /* ------------------------------------------------------------------ */
    console.log('\n[21] Existing features still work');
    await click('[data-action="tab"][data-tab="dashboard"]');
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance')`);
    assert(await bodyHas('Est. Revenue'), 'dashboard revenue card still renders');

    const revenueCheck = await evaluate(`(async () => {
        const { store } = await import('/js/core/store.js');
        const { computeEstimatedRevenue } = await import('/js/core/revenue.js');
        const { scopedBySalon } = await import('/js/core/utils.js');
        const s = store.getState();
        const appts = scopedBySalon(s.appointmentsList, s.currentSalonId);
        const services = scopedBySalon(s.servicesList, s.currentSalonId);
        const all = computeEstimatedRevenue(appts, services);
        // A wallet redemption must never reduce gross estimated revenue.
        const redeemed = appts.filter((a) => a.walletRedeemed > 0);
        const grossOfRedeemed = redeemed.reduce((sum, a) => sum + Number(a.amount || 0), 0);
        return { total: all.total, redeemedCount: redeemed.length, grossOfRedeemed };
    })()`);
    assert(revenueCheck.redeemedCount > 0, 'the period contains invoices that used wallet money');
    assert(revenueCheck.total >= revenueCheck.grossOfRedeemed, 'wallet redemptions do not reduce gross estimated revenue');

    assert(await fromStore(`${findCustomer('Rhea Kapoor')}.rewardPoints`) === 100, 'loyalty points are untouched by referral activity');
    assert(await fromStore(`(s.transactionsList || []).length === 0 || s.transactionsList.every((t) => t.type !== 'REFERRAL_CREDIT')`), 'referral money never lands in the loyalty ledger');

    await click('[data-action="tab"][data-tab="services"]');
    await pause(200);
    assert(await bodyHas('Balayage & Gloss'), 'services view still renders');
    await click('[data-action="tab"][data-tab="staff"]');
    await pause(200);
    assert(await bodyHas('Victoria Sterling'), 'staff view still renders');

    /* ------------------------------------------------------------------ */
    console.log('\n[22] Layout and runtime health');
    for (const [w, h, label] of [[320, 568, 'small phone'], [375, 667, 'iPhone'], [768, 1024, 'tablet']]) {
        await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 768 });
        await pause(300);
        assert(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), `no horizontal overflow at ${w}x${h} (${label})`);
    }
    await click('[data-action="tab"][data-tab="referrals"]');
    await pause(250);
    assert(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), 'referrals view fits a small phone');
    assert(await evaluate(`document.querySelectorAll('#app script, #app [onclick], #app img[onerror]').length === 0`), 'no executable attributes in the rendered DOM');

    const uniqueErrors = [...new Set(errors)].filter((e) => !/favicon|net::ERR/.test(e));
    assert(uniqueErrors.length === 0, `no console errors (found: ${uniqueErrors.length ? uniqueErrors.join(' | ') : 'none'})`);
    uniqueErrors.forEach((e) => console.log('      -> ' + e));

    console.log(`\n===== REFERRAL E2E: ${pass} passed, ${fail} failed =====`);
    if (failures.length) failures.forEach((f) => console.log('  failed: ' + f));
    if (ws) ws.close();
    chrome.kill('SIGKILL');
    cleanup();
    process.exit(fail === 0 ? 0 : 1);
}

function cleanup() {
    for (let i = 0; i < 5; i++) {
        try { rmSync(userData, { recursive: true, force: true }); return; } catch (e) { /* wait for the lock */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
}

main().catch((err) => {
    console.error('\nREFERRAL E2E ERROR:', err.message);
    if (ws) ws.close();
    cleanup();
    process.exit(2);
});
