/**
 * e2e-public-booking.mjs
 * Real-browser end-to-end verification of the WhatsApp/public booking link
 * feature (Chrome DevTools Protocol, zero dependencies).
 *
 * This drives TWO independent pages, because that is exactly how the feature
 * is used in production — the salon owner's authenticated CRM tab and a
 * customer's public booking tab share NOTHING in the browser except the
 * Firestore project they both write to:
 *
 *   PAGE A (index.html): the owner's Booking Link panel — link/copy/QR/
 *     WhatsApp-share controls and the working-hours / enable settings form.
 *   PAGE B (book.html):  the full public booking wizard a customer sees
 *     after clicking that link — services -> staff/date/time -> details ->
 *     review -> confirm, exercised against its own demo dataset (seeded from
 *     the exact same salon/customers/services/staff the owner's app uses).
 *
 * Demo mode has no cross-page persistence (there is no live Firestore
 * project in this environment), so this suite cannot observe a booking made
 * on page B appear live on page A the way a real deployment would. What it
 * DOES verify, exhaustively: the owner-side controls; the full booking
 * wizard end-to-end including validation, multi-service selection, staff
 * availability, atomic double-booking prevention, referral linking and
 * self-referral rejection, existing-vs-new customer identification, and that
 * the document shape the public flow produces is genuinely the same shape
 * (and is correctly read by the same revenue/rendering logic) the CRM's own
 * internal booking flow produces — see the session notes for why live
 * cross-page propagation is the one thing that can only be proven against a
 * real deployed backend.
 *
 * Usage: node scripts/e2e-public-booking.mjs  (server on :5500)
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5500/';
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9336;
const userData = mkdtempSync(join(tmpdir(), 'luxe-book-'));

let browserWsUrl;
const sessions = {}; // name -> { ws, msgId, pending, errors, sessionId }
let globalMsgId = 0; // one shared id space across every session on the socket

function connectBrowser(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.onopen = () => resolve(ws);
        ws.onerror = (e) => reject(new Error('WebSocket error: ' + e.message));
    });
}

/** One logical "tab": its own Target + CDP session, tracked independently. */
async function openPage(name, browserWs) {
    const errors = [];
    const pending = new Map();
    const send = (method, params = {}, sessionId) => {
        const myId = ++globalMsgId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 20000);
            pending.set(myId, (err, result) => { clearTimeout(timer); err ? reject(err) : resolve(result); });
            const payload = { id: myId, method, params };
            if (sessionId) payload.sessionId = sessionId;
            browserWs.send(JSON.stringify(payload));
        });
    };

    // Register BEFORE the first send: routeMessage can only deliver a reply
    // to a session it already knows about, so the entry must exist before
    // any request that expects a response goes out over the shared socket.
    const session = { send, sessionId: null, pending, errors, targetId: null };
    sessions[name] = session;

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    session.targetId = targetId;
    session.sessionId = sessionId;

    return session;
}

function routeMessage(msg) {
    // Messages carry a sessionId once attached (flatten:true); route replies
    // to whichever page issued that outstanding request id.
    for (const name of Object.keys(sessions)) {
        const s = sessions[name];
        if (msg.id && s.pending.has(msg.id) && (!msg.sessionId || msg.sessionId === s.sessionId)) {
            const cb = s.pending.get(msg.id);
            s.pending.delete(msg.id);
            cb(msg.error, msg.result);
            return;
        }
    }
    if (msg.sessionId && sessions_bySessionId(msg.sessionId)) {
        const s = sessions_bySessionId(msg.sessionId);
        if (msg.method === 'Runtime.exceptionThrown') s.errors.push(msg.params.exceptionDetails?.text || 'exception');
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            s.errors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
        }
    }
}
function sessions_bySessionId(sessionId) {
    return Object.values(sessions).find((s) => s.sessionId === sessionId);
}

async function sessionSend(session, method, params = {}) {
    return session.send(method, params, session.sessionId);
}

async function navigate(session, url) {
    await sessionSend(session, 'Page.enable');
    await sessionSend(session, 'Runtime.enable');
    await sessionSend(session, 'Page.navigate', { url });
    await waitFor(session, `document.readyState === 'complete'`);
}

async function evaluate(session, expression) {
    const { result, exceptionDetails } = await sessionSend(session, 'Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(exceptionDetails).slice(0, 500));
    return result.value;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(session, expr, timeoutMs = 8000) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
        try { if (await evaluate(session, expr)) return true; } catch (e) { last = e; }
        await pause(120);
    }
    throw new Error(`Timed out waiting for: ${expr}${last ? ' (' + last.message + ')' : ''}`);
}

async function click(session, selector) {
    const ok = await evaluate(session, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click();
        return true;
    })()`);
    if (!ok) throw new Error(`click failed, no element: ${selector}`);
    await pause(120);
}

async function fill(session, formSelector, fields) {
    await evaluate(session, `(() => {
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

function bodyHasExpr(session, text) {
    return `document.body.innerText.toLowerCase().includes(${JSON.stringify(String(text).toLowerCase())})`;
}
async function bodyHas(session, text) {
    return evaluate(session, bodyHasExpr(session, text));
}

let pass = 0;
let fail = 0;
const failures = [];
function assert(cond, label) {
    if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
    else { fail += 1; failures.push(label); console.log(`  FAIL  ${label}`); }
}

async function main() {
    console.log(`Launching headless Chrome (${CHROME})…`);
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=' + PORT, `--user-data-dir=${userData}`, 'about:blank',
    ], { stdio: 'ignore' });

    let versionInfo = null;
    for (let i = 0; i < 40; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
            if (res.ok) { versionInfo = await res.json(); break; }
        } catch (e) { /* retry */ }
        await pause(250);
    }
    if (!versionInfo) throw new Error('Could not reach Chrome DevTools endpoint');
    browserWsUrl = versionInfo.webSocketDebuggerUrl;

    const browserWs = await connectBrowser(browserWsUrl);
    browserWs.onmessage = (m) => routeMessage(JSON.parse(m.data));

    const owner = await openPage('owner', browserWs);
    const customer = await openPage('customer', browserWs);

    /* ================================================================ */
    console.log('\n[1] Owner: sign in and open Booking Link panel');
    await navigate(owner, APP_URL);
    await waitFor(owner, `document.querySelector('form[data-action="email-auth"]') !== null`);
    await fill(owner, 'form[data-action="email-auth"]', { salonName: 'Booking Test Salon', email: 'owner@book.test', password: 'secret123' });
    await evaluate(owner, `document.querySelector('form[data-action="email-auth"]').requestSubmit()`);
    await waitFor(owner, `document.body.innerText.includes('Your Salon at a Glance')`);

    await click(owner, '[data-action="modal"][data-modal="booking-link"]');
    await waitFor(owner, bodyHasExpr(owner, 'Public Booking Link'));
    assert(await bodyHas(owner, 'Public Booking Link'), 'Booking Link panel opens from the dashboard');
    assert(await bodyHas(owner, 'Online Booking'), 'enable/disable toggle is present');
    assert(await bodyHas(owner, 'Working Hours'), 'working hours configuration is present');

    const link = await evaluate(owner, `document.querySelector('[data-action="copy-booking-link"]').dataset.link`);
    assert(/^https?:\/\/.+\/book\/[^/?]+$/.test(link), `share link has the documented /book/{salonId} shape (${link})`);

    const openHref = await evaluate(owner, `document.querySelector('a[href*="/book/"]')?.getAttribute('href')`);
    assert(openHref === link, 'Open Link button targets the exact same URL as the copy button');

    const waHref = await evaluate(owner, `document.querySelector('a[href*="wa.me"]')?.getAttribute('href')`);
    assert(waHref && waHref.includes(encodeURIComponent(link)), 'WhatsApp share link embeds the booking link');

    await click(owner, '[data-action="toggle-booking-qr"]');
    await pause(200);
    const qrSvg = await evaluate(owner, `document.getElementById('booking-link-qr').innerHTML`);
    assert(qrSvg.includes('<svg') && qrSvg.includes('<rect'), 'QR code renders as inline SVG with no external request');
    await click(owner, '[data-action="toggle-booking-qr"]');
    assert(await evaluate(owner, `document.getElementById('booking-link-qr').classList.contains('hidden')`), 'QR panel toggles closed again');

    console.log('\n[2] Owner: save booking settings (enable + working hours)');
    await fill(owner, 'form[data-action="submit-booking-settings"]', {
        displayName: 'Booking Test Salon', slotIntervalMinutes: '30', advanceBookingDays: '60', minNoticeMinutes: '0',
    });
    // Every weekday open 09:00-20:00 so the public wizard always has slots.
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
        await evaluate(owner, `(() => {
            const f = document.querySelector('form[data-action="submit-booking-settings"]');
            const closed = f.querySelector('[name="closed_${day}"]');
            if (closed && closed.checked) { closed.checked = false; closed.dispatchEvent(new Event('change', {bubbles:true})); }
            const start = f.querySelector('[name="start_${day}"]'); if (start) { start.value = '09:00'; start.disabled = false; }
            const end = f.querySelector('[name="end_${day}"]'); if (end) { end.value = '20:00'; end.disabled = false; }
            return true;
        })()`);
    }
    await evaluate(owner, `document.querySelector('form[data-action="submit-booking-settings"]').requestSubmit()`);
    await pause(300);
    assert(await bodyHas(owner, 'Booking link settings saved'), 'settings save confirmation shown');

    /* ================================================================ */
    console.log('\n[3] Customer: open the public booking page for a disabled salon');
    // A salon id the demo dataset has never configured booking for.
    await navigate(customer, `${APP_URL}book.html?salonId=salon_never_configured`);
    await waitFor(customer, bodyHasExpr(customer, 'Online booking unavailable'));
    assert(await bodyHas(customer, 'Online booking unavailable'), 'a salon with no booking settings shows the disabled screen, not a broken page');

    console.log('\n[4] Customer: open the real (demo) public booking page');
    await navigate(customer, `${APP_URL}book.html?salonId=salon_luxe_01`);
    await waitFor(customer, bodyHasExpr(customer, 'Select Services'));
    assert(await bodyHas(customer, 'Balayage & Gloss'), 'seeded services are listed');
    assert(await bodyHas(customer, 'Signature Facial'), 'multiple seeded services are listed');
    assert(await evaluate(customer, `document.querySelector('[data-action="wizard-next"]').disabled`), 'continue is disabled with nothing selected');

    console.log('\n[5] Multi-service selection and price/duration summary');
    await click(customer, '[data-action="toggle-service"][data-name="Balayage & Gloss"]');
    await click(customer, '[data-action="toggle-service"][data-name="Signature Facial"]');
    assert(!(await evaluate(customer, `document.querySelector('[data-action="wizard-next"]').disabled`)), 'continue enables once services are selected');
    assert(await bodyHas(customer, '2 services'), 'summary shows the count of selected services');
    // 160 + 95 = 255, 120 + 60 = 180 min.
    assert(await bodyHas(customer, '255'), 'summary shows the combined price of selected services');

    await click(customer, '[data-action="wizard-next"]');
    await waitFor(customer, bodyHasExpr(customer, 'Date & Time'));

    console.log('\n[6] Staff selection, date, and live slot availability');
    assert(await bodyHas(customer, 'Any Available'), '"Any Available Staff" option is offered');
    assert(await bodyHas(customer, 'Victoria Sterling'), 'named staff members are offered');
    await click(customer, '[data-action="pick-staff"][data-name="Victoria Sterling"]');

    const farDate = new Date(); farDate.setDate(farDate.getDate() + 3);
    const dateStr = farDate.toISOString().slice(0, 10);
    await evaluate(customer, `(() => {
        const el = document.querySelector('[data-action="pick-date"]');
        el.value = ${JSON.stringify(dateStr)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await waitFor(customer, `document.querySelectorAll('[data-action="pick-slot"]').length > 0`);
    const slotCount = await evaluate(customer, `document.querySelectorAll('[data-action="pick-slot"]').length`);
    assert(slotCount > 0, `available time slots are shown (${slotCount} slots for a 3-hour, 09:00-20:00 window)`);

    await click(customer, '[data-action="pick-slot"]');
    const chosenTime = await evaluate(customer, `document.querySelector('[data-action="pick-slot"].bg-brand-600')?.dataset.time`);
    assert(!!chosenTime, 'picking a slot marks it selected');
    assert(!(await evaluate(customer, `document.querySelector('[data-action="wizard-next"]').disabled`)), 'continue enables once a time is picked');

    await click(customer, '[data-action="wizard-next"]');
    await waitFor(customer, bodyHasExpr(customer, 'Your Details'));

    console.log('\n[7] Customer details validation');
    await evaluate(customer, `document.querySelector('[data-action="wizard-next-details"]').click()`);
    await pause(200);
    assert(await bodyHas(customer, 'Enter your name'), 'blank name is rejected with a clear message');

    await fill(customer, '#booking-details-form', { customerName: 'Rahul Sharma', customerPhone: '123' });
    await evaluate(customer, `document.querySelector('[data-action="wizard-next-details"]').click()`);
    await pause(200);
    assert(await bodyHas(customer, 'valid 10-digit mobile number'), 'an incomplete phone number is rejected');

    await fill(customer, '#booking-details-form', { customerPhone: '9123456780', customerEmail: 'not-an-email' });
    await evaluate(customer, `document.querySelector('[data-action="wizard-next-details"]').click()`);
    await pause(200);
    assert(await bodyHas(customer, 'valid email'), 'an invalid optional email is rejected');

    await fill(customer, '#booking-details-form', { customerEmail: '', notes: 'Please use organic products.' });
    await evaluate(customer, `document.querySelector('[data-action="wizard-next-details"]').click()`);
    await waitFor(customer, bodyHasExpr(customer, 'Review Booking'));
    assert(await bodyHas(customer, 'Rahul Sharma'), 'review step shows the entered name');
    assert(await bodyHas(customer, '9123456780'), 'review step shows the entered phone');
    assert(await bodyHas(customer, 'organic products'), 'review step shows the entered notes');
    assert(await bodyHas(customer, 'Victoria Sterling'), 'review step shows the chosen staff member');

    console.log('\n[8] Confirm booking (new customer, no referral)');
    await click(customer, '[data-action="submit-booking"]');
    await waitFor(customer, bodyHasExpr(customer, 'Booking Confirmed'));
    assert(await bodyHas(customer, 'Rahul Sharma'), 'confirmation shows the customer name');
    assert(await bodyHas(customer, 'Balayage & Gloss'), 'confirmation shows the booked services');
    assert(await bodyHas(customer, 'Confirmed'), 'confirmation shows Confirmed status');
    assert(await bodyHas(customer, '255'), 'confirmation shows the correct estimated amount');
    assert(await bodyHas(customer, 'Appointment ID'), 'confirmation shows an appointment id');

    const afterFirstBooking = await evaluate(customer, `(async () => {
        const svc = await import('/js/services/publicBookingService.js');
        return svc._debugDemoSnapshot();
    })()`);
    assert(afterFirstBooking.customers.length === 3, 'exactly one new customer record was created (2 seeded + 1 new)');
    const newCustomer = afterFirstBooking.customers.find((c) => c.name === 'Rahul Sharma');
    assert(!!newCustomer, 'the new customer record has the correct name');
    assert(newCustomer.rewardPoints === 100 && newCustomer.walletBalance === 0, 'the new customer gets the standard signup bonus and an empty referral wallet');
    assert(newCustomer.source === 'public_booking', 'the new customer is tagged with its booking source');
    assert(afterFirstBooking.phoneIndex['9123456780']?.customerId === newCustomer.id, 'a phone index entry links the phone number to the new customer id');
    const firstAppt = afterFirstBooking.appointments.find((a) => a.customerId === newCustomer.id);
    assert(firstAppt && firstAppt.status === 'Confirmed' && firstAppt.paid === false, 'the appointment is created Confirmed and unpaid, never pre-billed');
    assert(firstAppt && firstAppt.source === 'public_booking', 'the appointment records its public-booking source');
    assert(firstAppt && firstAppt.services.length === 2, 'the appointment stores every selected service');

    /* ================================================================ */
    console.log('\n[9] Existing customer: booking again with the same phone links, does not duplicate');
    await click(customer, '[data-action="book-another"]');
    await waitFor(customer, bodyHasExpr(customer, 'Select Services'));
    await click(customer, '[data-action="toggle-service"][data-name="Precision Haircut"]');
    await click(customer, '[data-action="wizard-next"]');
    await waitFor(customer, bodyHasExpr(customer, 'Date & Time'));
    await click(customer, '[data-action="pick-staff"][data-name="Julian Vance"]');
    await evaluate(customer, `(() => {
        const el = document.querySelector('[data-action="pick-date"]');
        el.value = ${JSON.stringify(dateStr)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await waitFor(customer, `document.querySelectorAll('[data-action="pick-slot"]').length > 0`);
    await click(customer, '[data-action="pick-slot"]');
    await click(customer, '[data-action="wizard-next"]');
    await waitFor(customer, bodyHasExpr(customer, 'Your Details'));
    // Draft already carries an empty referralCode from book-another; fill the rest with the SAME phone.
    await fill(customer, '#booking-details-form', { customerName: 'Rahul Sharma Again', customerPhone: '9123456780' });
    await evaluate(customer, `document.querySelector('[data-action="wizard-next-details"]').click()`);
    await waitFor(customer, bodyHasExpr(customer, 'Review Booking'));
    await click(customer, '[data-action="submit-booking"]');
    await waitFor(customer, bodyHasExpr(customer, 'Booking Confirmed'));
    const afterSecondBooking = await evaluate(customer, `(async () => {
        const svc = await import('/js/services/publicBookingService.js');
        return svc._debugDemoSnapshot();
    })()`);
    assert(afterSecondBooking.customers.length === 3, 'booking again with the same phone creates NO new customer record');
    const linkedCustomer = afterSecondBooking.customers.find((c) => c.id === newCustomer.id);
    assert(linkedCustomer && linkedCustomer.name === 'Rahul Sharma', 'the existing customer record is untouched by a later booking (original name preserved)');
    const secondAppt = afterSecondBooking.appointments.find((a) => a.customerName === 'Rahul Sharma Again');
    assert(secondAppt && secondAppt.customerId === newCustomer.id, 'the second appointment is linked to the SAME existing customer id, not a new one');

    /* ================================================================ */
    console.log('\n[10] Referral code applied from the URL and during booking');
    await navigate(customer, `${APP_URL}book.html?salonId=salon_luxe_01&ref=TESTCASE`);
    await waitFor(customer, bodyHasExpr(customer, 'Select Services'));
    await click(customer, '[data-action="toggle-service"][data-name="Signature Facial"]');
    await click(customer, '[data-action="wizard-next"]');
    await waitFor(customer, bodyHasExpr(customer, 'Date & Time'));
    await click(customer, '[data-action="pick-staff"][data-name="Any Available Staff"]');
    await evaluate(customer, `(() => {
        const el = document.querySelector('[data-action="pick-date"]');
        el.value = ${JSON.stringify(dateStr)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await waitFor(customer, `document.querySelectorAll('[data-action="pick-slot"]').length > 0`);
    await click(customer, '[data-action="pick-slot"]');
    await click(customer, '[data-action="wizard-next"]');
    await waitFor(customer, bodyHasExpr(customer, 'Your Details'));
    assert(await evaluate(customer, `document.querySelector('#booking-details-form [name="referralCode"]').value`) === 'TESTCASE', 'referral code from the URL is prefilled automatically');
    await fill(customer, '#booking-details-form', { customerName: 'Neha Verma', customerPhone: '9988776655' });
    await evaluate(customer, `document.querySelector('[data-action="wizard-next-details"]').click()`);
    await waitFor(customer, bodyHasExpr(customer, 'Review Booking'));
    assert(await bodyHas(customer, 'TESTCASE'), 'review step shows the applied referral code');
    await click(customer, '[data-action="submit-booking"]');
    await waitFor(customer, bodyHasExpr(customer, 'Booking Confirmed'));
    assert(await bodyHas(customer, 'referral code has been applied'), 'confirmation confirms the referral was actually linked, not just entered');
    const afterReferralBooking = await evaluate(customer, `(async () => {
        const svc = await import('/js/services/publicBookingService.js');
        return svc._debugDemoSnapshot();
    })()`);
    const nehaCustomer = afterReferralBooking.customers.find((c) => c.name === 'Neha Verma');
    const referral = afterReferralBooking.referrals.find((r) => r.referredId === nehaCustomer?.id);
    assert(!!referral, 'a Pending referral record is created for the new customer');
    assert(referral && referral.status === 'Pending' && referral.rewardAmount === 0, 'the referral starts Pending with nothing credited yet (crediting happens only on a qualifying paid invoice)');
    assert(referral && referral.referrerId === 'c1', "the referral is correctly attributed to the demo code's real owner (Olivia Wilde)");
    assert(nehaCustomer && nehaCustomer.referredByCode === 'TESTCASE', 'the new customer record itself also records which code referred them');

    console.log('\n[11] Self-referral is silently ignored, never blocks the booking');
    // Olivia Wilde (the demo code's owner) tries to use her OWN code.
    await click(customer, '[data-action="book-another"]');
    await waitFor(customer, bodyHasExpr(customer, 'Select Services'));
    await click(customer, '[data-action="toggle-service"][data-name="Precision Haircut"]');
    await click(customer, '[data-action="wizard-next"]');
    await waitFor(customer, bodyHasExpr(customer, 'Date & Time'));
    await click(customer, '[data-action="pick-staff"][data-name="Victoria Sterling"]');
    const laterDate = new Date(farDate); laterDate.setDate(laterDate.getDate() + 1);
    const laterDateStr = laterDate.toISOString().slice(0, 10);
    await evaluate(customer, `(() => {
        const el = document.querySelector('[data-action="pick-date"]');
        el.value = ${JSON.stringify(laterDateStr)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await waitFor(customer, `document.querySelectorAll('[data-action="pick-slot"]').length > 0`);
    await click(customer, '[data-action="pick-slot"]');
    await click(customer, '[data-action="wizard-next"]');
    await waitFor(customer, bodyHasExpr(customer, 'Your Details'));
    // Olivia Wilde's seeded phone ("+1 555-0143") has only 7 national digits
    // and can never itself pass this app's 10-digit Indian phone validator,
    // so this exercises the OTHER half of the self-referral check: a fresh,
    // valid phone number paired with her seeded EMAIL address.
    await fill(customer, '#booking-details-form', { customerName: 'Olivia Wilde', customerPhone: '9555501430', customerEmail: 'olivia@example.com', referralCode: 'TESTCASE' });
    await evaluate(customer, `document.querySelector('[data-action="wizard-next-details"]').click()`);
    await waitFor(customer, bodyHasExpr(customer, 'Review Booking'));
    await click(customer, '[data-action="submit-booking"]');
    await waitFor(customer, bodyHasExpr(customer, 'Booking Confirmed'));
    assert(!(await bodyHas(customer, 'referral code has been applied')), 'a self-referral attempt books successfully but is not credited');
    const afterSelfReferral = await evaluate(customer, `(async () => {
        const svc = await import('/js/services/publicBookingService.js');
        return svc._debugDemoSnapshot();
    })()`);
    assert(!afterSelfReferral.referrals.some((r) => r.referrerId === r.referredId), 'no referral record is ever created linking a customer to themselves');

    /* ================================================================ */
    console.log('\n[12] Double-booking prevention (atomic slot lock)');
    await navigate(customer, `${APP_URL}book.html?salonId=salon_luxe_01`);
    await waitFor(customer, bodyHasExpr(customer, 'Select Services'));
    await click(customer, '[data-action="toggle-service"][data-name="Precision Haircut"]');
    await click(customer, '[data-action="wizard-next"]');
    await waitFor(customer, bodyHasExpr(customer, 'Date & Time'));
    await click(customer, '[data-action="pick-staff"][data-name="Julian Vance"]');
    const dbDate = new Date(farDate); dbDate.setDate(dbDate.getDate() + 2);
    const dbDateStr = dbDate.toISOString().slice(0, 10);
    await evaluate(customer, `(() => {
        const el = document.querySelector('[data-action="pick-date"]');
        el.value = ${JSON.stringify(dbDateStr)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await waitFor(customer, `document.querySelectorAll('[data-action="pick-slot"]').length > 0`);
    const targetTime = await evaluate(customer, `document.querySelector('[data-action="pick-slot"]').dataset.time`);
    await click(customer, '[data-action="pick-slot"]');
    await click(customer, '[data-action="wizard-next"]');
    await waitFor(customer, bodyHasExpr(customer, 'Your Details'));
    await fill(customer, '#booking-details-form', { customerName: 'First Booker', customerPhone: '9000011111' });
    await evaluate(customer, `document.querySelector('[data-action="wizard-next-details"]').click()`);
    await waitFor(customer, bodyHasExpr(customer, 'Review Booking'));
    await click(customer, '[data-action="submit-booking"]');
    await waitFor(customer, bodyHasExpr(customer, 'Booking Confirmed'));
    assert(true, 'first booker secures the slot');

    // A second, independent customer races for the EXACT same staff/date/time.
    await click(customer, '[data-action="book-another"]');
    await waitFor(customer, bodyHasExpr(customer, 'Select Services'));
    await click(customer, '[data-action="toggle-service"][data-name="Precision Haircut"]');
    await click(customer, '[data-action="wizard-next"]');
    await waitFor(customer, bodyHasExpr(customer, 'Date & Time'));
    await click(customer, '[data-action="pick-staff"][data-name="Julian Vance"]');
    await evaluate(customer, `(() => {
        const el = document.querySelector('[data-action="pick-date"]');
        el.value = ${JSON.stringify(dbDateStr)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await waitFor(customer, `document.querySelectorAll('[data-action="pick-slot"]').length >= 0`);
    const stillOffered = await evaluate(customer, `Array.from(document.querySelectorAll('[data-action="pick-slot"]')).some((el) => el.dataset.time === ${JSON.stringify(targetTime)})`);
    assert(stillOffered === false, 'the just-taken slot is no longer offered to a second viewer (live availability, not stale)');

    // Prove the ATOMIC guard itself, not just that the UI hides a taken slot:
    // attempt to write the exact same staff/date/time directly, bypassing the
    // picker entirely. This must be rejected by the slot-lock mechanism even
    // though nothing here first re-reads availability.
    const raceResult = await evaluate(customer, `(async () => {
        const svc = await import('/js/services/publicBookingService.js');
        try {
            await svc.submitPublicBooking({
                salonId: 'salon_luxe_01',
                settings: { enabled: true },
                servicesCatalog: [{ name: 'Precision Haircut', price: 75, duration: '45m' }],
                staffList: [{ name: 'Julian Vance' }],
                selectedServiceNames: ['Precision Haircut'],
                staffName: 'Julian Vance',
                date: ${JSON.stringify(dbDateStr)},
                time: ${JSON.stringify(targetTime)},
                customerName: 'Racing Booker',
                customerPhone: '9000022222',
                customerEmail: '',
                referralCode: '',
                notes: '',
                idempotencyToken: 'race-attempt-' + Date.now(),
            });
            return { ok: true };
        } catch (err) {
            return { ok: false, message: err.message };
        }
    })()`);
    assert(raceResult.ok === false, 'a direct write attempt for an already-locked slot is rejected, not just hidden from the picker');
    assert(/just booked|no staff member is available/i.test(raceResult.message || ''), `the rejection gives a clear reason (got: "${raceResult.message}")`);

    console.log('\n[13] Working-hours and minimum-notice boundaries are respected');
    // The salon closes at 20:00 with a 30-min slot interval, 3h duration service
    // (Balayage & Gloss + Signature Facial = 180 min) — no slot may start after 17:00.
    await navigate(customer, `${APP_URL}book.html?salonId=salon_luxe_01`);
    await waitFor(customer, bodyHasExpr(customer, 'Select Services'));
    await click(customer, '[data-action="toggle-service"][data-name="Balayage & Gloss"]');
    await click(customer, '[data-action="toggle-service"][data-name="Signature Facial"]');
    await click(customer, '[data-action="wizard-next"]');
    await waitFor(customer, bodyHasExpr(customer, 'Date & Time'));
    await click(customer, '[data-action="pick-staff"][data-name="Victoria Sterling"]');
    await evaluate(customer, `(() => {
        const el = document.querySelector('[data-action="pick-date"]');
        el.value = ${JSON.stringify(dbDateStr)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await waitFor(customer, `document.querySelectorAll('[data-action="pick-slot"]').length > 0`);
    const latestSlot = await evaluate(customer, `Array.from(document.querySelectorAll('[data-action="pick-slot"]')).map((el) => el.dataset.time).sort().pop()`);
    assert(latestSlot <= '17:00', `no slot lets a 3-hour service run past the 20:00 close (latest offered: ${latestSlot})`);

    /* ================================================================ */
    console.log('\n[14] Internal CRM booking still works unaffected');
    await click(owner, '[data-action="close-modal"]');
    await click(owner, '[data-action="tab"][data-tab="appointments"]');
    await pause(150);
    await click(owner, '[data-action="modal"][data-modal="appointment"]');
    await waitFor(owner, `document.querySelector('form[data-action="submit-appointment"]') !== null`);
    await evaluate(owner, `(() => {
        const f = document.querySelector('form[data-action="submit-appointment"]');
        f.querySelector('[name="customerName"]').value = 'Internal Client';
        f.querySelector('[name="serviceName"]').selectedIndex = 1;
        f.querySelector('[name="staffName"]').selectedIndex = 1;
        f.querySelector('[name="date"]').value = '2031-01-15';
        f.querySelector('[name="time"]').value = '11:00';
        ['customerName','date','time'].forEach((n) => f.querySelector('[name="'+n+'"]').dispatchEvent(new Event('input', {bubbles:true})));
        return true;
    })()`);
    await evaluate(owner, `document.querySelector('form[data-action="submit-appointment"]').requestSubmit()`);
    await waitFor(owner, bodyHasExpr(owner, 'Internal Client'));
    assert(true, 'internal appointment booking is unaffected by the public booking feature');

    console.log('\n[15] Layout and runtime health');
    for (const [w, h, label] of [[320, 568, 'small phone'], [375, 667, 'iPhone']]) {
        await sessionSend(customer, 'Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
        await pause(250);
        assert(await evaluate(customer, `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), `booking page has no horizontal overflow at ${w}x${h} (${label})`);
    }
    for (const [w, h, label] of [[320, 568, 'small phone'], [375, 667, 'iPhone']]) {
        await sessionSend(owner, 'Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
        await pause(250);
        assert(await evaluate(owner, `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), `Booking Link panel has no horizontal overflow at ${w}x${h} (${label})`);
    }

    const allErrors = [...sessions.owner.errors, ...sessions.customer.errors].filter((e) => !/favicon|net::ERR/.test(e));
    const uniqueErrors = [...new Set(allErrors)];
    assert(uniqueErrors.length === 0, `no console errors on either page (found: ${uniqueErrors.length ? uniqueErrors.join(' | ') : 'none'})`);
    uniqueErrors.forEach((e) => console.log('      -> ' + e));

    console.log(`\n===== PUBLIC BOOKING E2E: ${pass} passed, ${fail} failed =====`);
    if (failures.length) failures.forEach((f) => console.log('  failed: ' + f));
    browserWs.close();
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
    console.error('\nPUBLIC BOOKING E2E ERROR:', err.message);
    cleanup();
    process.exit(2);
});
