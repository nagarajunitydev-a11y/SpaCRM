/**
 * e2e-quick-billing.mjs
 * Real-browser end-to-end verification of the Quick Billing / Walk-in POS flow:
 * the dedicated page/view entry point, phone-first client lookup (new + existing
 * + invalid + duplicate numbers), live service search + selection, the live
 * breakdown, the one-step "Complete Payment" write, the receipt page, and that
 * the resulting record is a Completed + paid walk-in appointment that shows up
 * in the list and drives the dashboard revenue figure.
 *
 * Uses the demo-mode seeded catalog (no service creation needed):
 *   Signature Facial  ₹95  60m
 *   Precision Haircut ₹75  45m
 *   Balayage & Gloss  ₹160 120m
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
const NEW_PHONE = '9876543210';
const CLIENT_NAME = 'Walkin Test Client';
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

const qbFormSelector = 'form[data-action="submit-quick-billing"]';

/** Is the "Complete Payment" submit button currently disabled? */
const submitDisabledExpr = `(() => { const btn = document.querySelector('${qbFormSelector} button[type="submit"]'); return btn && btn.disabled; })()`;

/** Read the Est. Revenue stat card value text. */
const revenueExpr = `
    [...document.querySelectorAll('main p')]
        .filter((el) => el.textContent.trim() === 'Est. Revenue')
        .map((el) => el.nextElementSibling.textContent.trim())[0] || null`;

async function openQuickBilling() {
    await click('[data-action="tab"][data-tab="dashboard"]');
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance')`);
    await click('[data-action="tab"][data-tab="quickBilling"]');
    await waitFor(`document.querySelector('${qbFormSelector}') !== null`);
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

    console.log('\n[2] Dashboard Quick Bill tile opens the walk-in as a page/view (not a popup)');
    assert(await evaluate(`document.querySelector('[data-action="tab"][data-tab="quickBilling"]') !== null`), 'Quick Bill tile is present on the owner dashboard');
    await openQuickBilling();
    assert(await evaluate(`document.querySelector('${qbFormSelector}') !== null`), 'walk-in form rendered inside the active tab view');
    assert(await evaluate(`document.querySelector('[role="dialog"]') === null`), 'Quick Billing is a page/view, not a popup/modal');
    assert(await evaluate(`(() => { const btn = document.querySelector('${qbFormSelector} button[type="submit"]'); return btn && btn.disabled; })()`), "Complete Payment starts disabled (nothing entered)");

    console.log('\n[3] Live service search adds repeated service line items to the bill');
    await addService('Signature Facial');
    await addService('Precision Haircut');
    await addService('Precision Haircut');
    await waitFor(`(() => { const el = document.querySelector('${qbFormSelector} [data-quickbilling-selected-services]'); return el && el.innerText.includes('Subtotal') && el.innerText.includes('245'); })()`);
    const selectedText = await evaluate(`document.querySelector('${qbFormSelector} [data-quickbilling-selected-services]').innerText`);
    assert(selectedText.includes('Signature Facial') && (selectedText.match(/Precision Haircut/g) || []).length === 2, 'two independently selectable Haircut lines appear alongside the facial');
    assert(selectedText.includes('₹245'), 'subtotal is ₹245 for the repeated-service bill (95 + 75 + 75)');
    assert(await evaluate(`(() => { const el = document.querySelector('${qbFormSelector} [data-quickbilling-summary]'); return el && el.innerText.includes('₹245'); })()`), 'live summary includes every repeated service occurrence');

    console.log('\n[4] Phone digits-only rule + type-ahead container wired, partial number keeps search idle');
    await setValue('customerPhone', '98765-432a'); // punctuation + letter get stripped
    const sanitizedPhone = await evaluate(`document.querySelector('${qbFormSelector} [name="customerPhone"]').value`);
    assert(sanitizedPhone === '98765432', `phone input is digits-only and capped at 10 (got "${sanitizedPhone}")`);
    await waitFor(`(() => { const c = document.querySelector('${qbFormSelector} [data-quickbilling-customer]'); return c && c.innerText.includes('10-digit'); })()`);
    assert(await evaluate(`document.querySelector('${qbFormSelector} [name="customerName"]:not([type="hidden"])') === null`), 'no name field / no lookup for an incomplete number');
    assert(await evaluate(`document.querySelector('${qbFormSelector} [data-quickbilling-customer-dropdown]') !== null`), 'type-ahead dropdown container is present');
    assert(await evaluate(submitDisabledExpr), 'Complete Payment stays disabled with a partial number');
    await new Promise((r) => setTimeout(r, 400)); // let the debounced search settle
    assert(await evaluate(`document.querySelectorAll('${qbFormSelector} [data-quickbilling-customer-dropdown] [data-action="quick-billing-select-customer"]').length === 0`), 'no matching contact rows for a non-matching partial number');

    console.log('\n[5] Valid 10-digit number for a NEW client shows an inline name field');
    await setValue('customerPhone', NEW_PHONE);
    await waitFor(`document.querySelector('${qbFormSelector} [data-quickbilling-customer] [name="customerName"]') !== null`);
    assert(await evaluate(`document.body.innerText.includes('New client — ${NEW_PHONE} not on file')`), 'new-number card identifies the phone as not on file');
    assert(await evaluate(`document.body.innerText.includes('No referral balance available (₹0)')`), 'wallet block shows the empty-balance state for a new client');
    // The auto-focus-lock regression guard: after the name field appears, the
    // phone field must remain fully focusable/editable — nothing steals focus.
    assert(await evaluate(`(() => {
        const p = document.querySelector('${qbFormSelector} [name="customerPhone"]');
        if (!p) return false;
        p.focus();
        const grabbed = document.activeElement && document.activeElement.id ? document.activeElement.id : (document.activeElement && document.activeElement.name) || 'inputs';
        return document.activeElement === p && p.value === '${NEW_PHONE}';
    })()`), 'phone field stays focusable and holds its number after the name field appears');
    await evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur(); true`);

    console.log('\n[6] Adding the name + payment method enables the button');
    await setValue('customerName', CLIENT_NAME);
    await setValue('paymentMethod', 'upi');
    await setValue('paymentReference', 'UPIREFDEMO');
    await waitFor(`(() => { const btn = document.querySelector('${qbFormSelector} button[type="submit"]'); return btn && !btn.disabled; })()`);
    assert(true, 'Complete Payment enabled once phone + name + service + method are set');

    console.log('\n[7] One-step bill writes the walk-in and shows the receipt page');
    await evaluate(`document.querySelector('${qbFormSelector}').requestSubmit()`);
    await waitFor(`document.body.innerText.includes('Walk-in billed & paid')`);
    const receiptText = await evaluate(`(document.querySelector('[role="dialog"]') || document.body).innerText`);
    assert(receiptText.includes('Walk-in billed & paid'), 'receipt page confirms the walk-in was billed & paid');
    assert(receiptText.includes('Walkin Test Client'), 'receipt shows the client name');
    assert(/INV-[A-Z0-9]+/.test(receiptText), 'receipt shows an invoice number (INV-…)');
    assert(receiptText.includes('₹245'), 'receipt shows the ₹245 invoice total');
    assert(receiptText.includes('UPI'), 'receipt shows the payment method (UPI)');

    console.log('\n[8] The persisted record is a Completed + paid walk-in avoiding duplicates');
    const record = await evaluate(`(async () => {
        const { listAppointments } = await import('/js/services/appointmentsRepository.js');
        const rows = listAppointments().filter((a) => a.customerName === '${CLIENT_NAME}');
        return rows[rows.length - 1] || null;
    })()`);
    assert(record && record.source === 'walkin', 'record is tagged source: walkin');
    assert(record && record.status === 'Completed', 'record status is Completed');
    assert(record && record.paid === true, 'record is paid');
    assert(record && record.invoiceAmount === 245, 'record invoiceAmount is ₹245');
    const servicesOk = await evaluate(`(async () => {
        const { listAppointments } = await import('/js/services/appointmentsRepository.js');
        const rows = listAppointments().filter((a) => a.customerName === '${CLIENT_NAME}');
        const a = rows[rows.length - 1];
        return !!a && Array.isArray(a.services) && a.services.length === 3
            && a.services.filter((service) => service.name === 'Precision Haircut').length === 2
            && new Set(a.services.map((service) => service.lineItemId)).size === 3;
    })()`);
    assert(servicesOk, 'record persists two Haircut occurrences with distinct line-item IDs');
    const customerCount = await evaluate(`(async () => {
        const { listCustomers } = await import('/js/services/customersRepository.js');
        return listCustomers().filter((c) => (c.phone || '').replace(/\\D/g, '').slice(-10) === '${NEW_PHONE}').length;
    })()`);
    assert(customerCount === 1, 'only ONE customer record exists for the new phone (no duplicates)');
    const storedPhone = await evaluate(`(async () => {
        const { listCustomers } = await import('/js/services/customersRepository.js');
        const row = listCustomers().find((c) => (c.phone || '').replace(/\\D/g, '').slice(-10) === '${NEW_PHONE}');
        return row ? row.phone : null;
    })()`);
    assert(storedPhone === '+919876543210', `walk-in-created client stores the consistent E.164 phone form (got "${storedPhone}")`);

    console.log('\n[9] The walk-in appears in the appointments list and drives revenue');
    await click('[data-action="tab"][data-tab="appointments"]');
    await waitFor(`document.body.innerText.includes('${CLIENT_NAME}')`);
    assert(true, 'appointments list shows the walk-in');
    await click('[data-action="tab"][data-tab="customers"]');
    await waitFor(`document.body.innerText.includes('${CLIENT_NAME}')`);
    assert(true, 'walk-in-created client appears immediately in the main Customers list');
    await click('[data-action="tab"][data-tab="dashboard"]');
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance')`);
    const rev = await evaluate(revenueExpr);
    assert(rev === '₹245', `Est. Revenue reflects the walk-in: ₹245 (got ${rev})`);

    console.log('\n[10] Existing client: same phone auto-looks up, never duplicates');
    await openQuickBilling();
    await setValue('customerPhone', NEW_PHONE);
    await waitFor(`document.body.innerText.includes('${CLIENT_NAME}')`);
    assert(await evaluate(`document.body.innerText.includes('Existing client')`), 'existing client details appear immediately in the same UI');
    assert(await evaluate(`(() => { const h = document.querySelector('${qbFormSelector} [name="customerId"]'); return !!h && h.value.length > 0; })()`), 'customerId hidden field is populated for the found client');
    assert(await evaluate(`(() => { const n = document.querySelector('${qbFormSelector} [name="customerName"]'); return !!n && n.value === '${CLIENT_NAME}'; })()`), 'customer name is auto-populated for the found client');
    const dupCount = await evaluate(`(async () => {
        const { listCustomers } = await import('/js/services/customersRepository.js');
        return listCustomers().filter((c) => (c.phone || '').replace(/\\D/g, '').slice(-10) === '${NEW_PHONE}').length;
    })()`);
    assert(dupCount === 1, 're-entry of the same phone does not create a duplicate client');

    console.log('\n[11] Remove-service path keeps the breakdown correct');
    await openQuickBilling();
    await setValue('customerPhone', NEW_PHONE);
    await waitFor(`document.body.innerText.includes('${CLIENT_NAME}')`);
    await addService('Signature Facial');    // ₹95
    await addService('Balayage & Gloss');    // ₹160
    const afterAdd = await pollWithDebug(
        `(() => { const el = document.querySelector('${qbFormSelector} [data-quickbilling-selected-services]'); const h = document.querySelector('${qbFormSelector} [name="selectedServices"]'); return { ok: el && el.innerText.includes('Balayage & Gloss') && el.innerText.includes('255'), dump: JSON.stringify({ hidden: h && h.value, text: el && el.innerText }) }; })()`,
    );
    assert(afterAdd.ok, 'adding a service updates the subtotal to ₹255 (95 + 160)');
    await click('[data-action="quick-billing-remove-service"][data-name="Balayage & Gloss"]');
    const afterRemove = await pollWithDebug(
        `(() => { const el = document.querySelector('${qbFormSelector} [data-quickbilling-selected-services]'); const h = document.querySelector('${qbFormSelector} [name="selectedServices"]'); return { ok: el && !el.innerText.includes('Balayage & Gloss') && el.innerText.includes('95') && !el.innerText.includes('255'), dump: JSON.stringify({ hidden: h && h.value, text: el && el.innerText }) }; })()`,
    );
    assert(afterRemove.ok, 'removing a service drops it and restores the ₹95 subtotal');
    assert(await evaluate(`(() => { const el = document.querySelector('${qbFormSelector} [data-quickbilling-summary]'); return el && el.innerText.includes('₹95'); })()`), 'live summary follows the removal (₹95)');

    console.log('\n[12] Client created on the Customers page is searchable in Quick Billing (same backend source)');
    const CLIENTS_PHONE = '9000000001';
    const CLIENTS_NAME = 'Clients Page Client';
    await click('[data-action="tab"][data-tab="customers"]');
    await waitFor(`document.querySelector('[data-action="modal"][data-modal="customer"]') !== null`);
    await click('[data-action="modal"][data-modal="customer"]');
    await waitFor(`document.querySelector('form[data-action="submit-customer"]') !== null`);
    await evaluate(`(() => {
        const f = document.querySelector('form[data-action="submit-customer"]');
        const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        set('name', '${CLIENTS_NAME}');
        set('phone', '${CLIENTS_PHONE}');
        set('email', 'clients@example.com');
        f.requestSubmit();
        return true;
    })()`);
    await waitFor(`document.querySelector('form[data-action="submit-customer"]') === null`, 12000);
    const clientsCust = await evaluate(`(async () => {
        const { findCustomerByPhone } = await import('/js/services/customersRepository.js');
        const c = findCustomerByPhone('${CLIENTS_PHONE}');
        return c ? JSON.stringify({ id: c.id, name: c.name, phone: c.phone }) : 'null';
    })()`);
    const parsedCust = JSON.parse(clientsCust);
    assert(parsedCust && parsedCust.name === CLIENTS_NAME, 'Customers-page form created the contact');
    assert(parsedCust && parsedCust.phone === '+919000000001', 'Customers page stored the same E.164 phone format');
    assert(await evaluate(`(async () => {
        const { listCustomers } = await import('/js/services/customersRepository.js');
        return listCustomers().filter((c) => (c.phone || '').replace(/\\D/g, '').slice(-10) === '${CLIENTS_PHONE}').length;
    })()`) === 1, 'exactly one customer record exists for the number');
    await openQuickBilling();
    await setValue('customerPhone', CLIENTS_PHONE);
    await waitFor(`document.body.innerText.includes('${CLIENTS_NAME}')`);
    assert(await evaluate(`document.body.innerText.includes('Existing client')`), 'Clients-page client is found instantly in Quick Billing');
    const qbFound = await evaluate(`(() => {
        const h = document.querySelector('${qbFormSelector} [name="customerId"]');
        const n = document.querySelector('${qbFormSelector} [name="customerName"]');
        return JSON.stringify({ id: h ? h.value : null, name: n ? n.value : null });
    })()`);
    const found = JSON.parse(qbFound);
    assert(found.id === parsedCust.id, 'Quick Billing binds the SAME customerId that the Clients page created');
    assert(found.name === CLIENTS_NAME, 'Quick Billing auto-filled the Clients-page client name');
    await addService('Signature Facial'); // ₹95
    await setValue('paymentMethod', 'cash');
    await waitFor(`(() => { const btn = document.querySelector('${qbFormSelector} button[type="submit"]'); return btn && !btn.disabled; })()`);
    await evaluate(`document.querySelector('${qbFormSelector}').requestSubmit()`);
    await waitFor(`document.body.innerText.includes('Walk-in billed & paid')`);
    const linked = await evaluate(`(async () => {
        const { listAppointments } = await import('/js/services/appointmentsRepository.js');
        const rows = listAppointments().filter((a) => a.customerName === '${CLIENTS_NAME}');
        const a = rows[rows.length - 1];
        return a ? JSON.stringify({ customerId: a.customerId, customerName: a.customerName, paid: a.paid, amount: a.invoiceAmount }) : 'null';
    })()`);
    const bill = JSON.parse(linked);
    assert(bill && bill.customerId === parsedCust.id, 'appointment + invoice + payment record links the Clients-page customer ID');
    assert(bill && bill.customerName === CLIENTS_NAME && bill.paid === true && bill.amount === 95, 'billed walk-in uses the linked client, settles paid with the ₹95 invoice');
    assert(await evaluate(`(async () => {
        const { listCustomers } = await import('/js/services/customersRepository.js');
        return listCustomers().filter((c) => (c.phone || '').replace(/\\D/g, '').slice(-10) === '${CLIENTS_PHONE}').length;
    })()`) === 1, 'billing that existing client never duplicates the contact');

    console.log('\n[13] Type-ahead dropdown: search-as-you-type, pick, then re-edit the number');
    await openQuickBilling();
    // While still typing a PARTIAL number the matching contact must appear.
    await setValue('customerPhone', '900');
    await waitFor(`document.querySelector('${qbFormSelector} [data-action="quick-billing-select-customer"][data-id="${parsedCust.id}"]') !== null`);
    const rowText = await evaluate(`(document.querySelector('${qbFormSelector} [data-action="quick-billing-select-customer"][data-id="${parsedCust.id}"]') || { innerText: '' }).innerText`);
    assert(rowText.includes(CLIENTS_NAME), 'dropdown row shows the matching client name while typing');
    assert(rowText.includes('+91 90000 00001'), 'dropdown row shows the matching phone number in national form');
    // Picking the contact populates the SAME Quick Billing UI (no navigation).
    await click(`[data-action="quick-billing-select-customer"][data-id="${parsedCust.id}"]`);
    await waitFor(`(() => { const h = document.querySelector('${qbFormSelector} [name="customerId"]'); return h && h.value === '${parsedCust.id}'; })()`);
    assert(await evaluate(`document.body.innerText.includes('Existing client')`), 'selected contact shows as an existing client in the same page');
    assert(await evaluate(`document.querySelector('${qbFormSelector} [data-quickbilling-customer-dropdown] [data-action="quick-billing-select-customer"]') === null`), 'dropdown clears after picking a contact');
    assert(await evaluate(`document.querySelector('${qbFormSelector} [name="customerPhone"]').value === '${CLIENTS_PHONE}'`), 'phone field is filled with the picked record\'s 10-digit number');
    // Changing the number to one NOT on file re-runs the search and shows the
    // inline name field again — but the phone field stays editable throughout.
    await setValue('customerPhone', '9988776655');
    await waitFor(`document.querySelector('${qbFormSelector} [data-quickbilling-customer] [name="customerName"]') !== null`);
    assert(await evaluate(`document.body.innerText.includes('New client — 9988776655 not on file')`), 're-edited number (no match) re-runs the search and shows the name field');
    assert(await evaluate(`(() => {
        const p = document.querySelector('${qbFormSelector} [name="customerPhone"]');
        p.focus();
        return document.activeElement === p && p.value === '9988776655';
    })()`), 'phone field is still focusable/editable while the name field is shown');
    // Re-typing an EXISTING number hides the new-client name field again.
    await setValue('customerPhone', CLIENTS_PHONE);
    await waitFor(`(() => {
        const block = document.querySelector('${qbFormSelector} [data-quickbilling-customer]');
        return block && block.innerText.includes('${CLIENTS_NAME}') && block.querySelector('[name="customerName"]:not([type="hidden"])') === null;
    })()`);
    assert(true, 'editing the number to an existing client hides the name field and shows the existing details');
    assert(await evaluate(`(() => { const h = document.querySelector('${qbFormSelector} [name="customerId"]'); return h && h.value === '${parsedCust.id}'; })()`), 'existing-match bind keeps the same customer record');
    // A full 10-digit number with no backend match shows the no-results state.
    await setValue('customerPhone', '4444444444');
    await waitFor(`document.querySelector('${qbFormSelector} [data-quickbilling-customer-dropdown]').innerText.includes('No matching client')`);
    assert(await evaluate(`document.querySelector('${qbFormSelector} [data-quickbilling-customer] [name="customerName"]') !== null`), 'no-results dropdown state appears alongside the inline name field');
    await waitFor(`(() => { const btn = document.querySelector('${qbFormSelector} button[type="submit"]'); return btn && btn.disabled; })()`);
    assert(true, 'unfilled bill stays disabled (no accidental submit during search)');

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
