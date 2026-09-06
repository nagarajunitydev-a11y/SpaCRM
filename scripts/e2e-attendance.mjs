/**
 * e2e-attendance.mjs
 * Real-browser end-to-end verification of the redesigned Staff Attendance
 * module: consolidated daily cards, date navigation, monthly report
 * (per-staff rows + salon summary), duplicate protection, edit/delete,
 * staff filter and responsive layout.
 *
 * Drives the demo-mode UI via CDP on headless Chrome (port 9340).
 *
 * Usage: node scripts/e2e-attendance.mjs  (server on :5500)
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killChromeTree } from './e2e-helpers.mjs';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5500/';
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9340;
const userData = mkdtempSync(join(tmpdir(), 'luxe-att-'));

let ws;
let msgId = 0;
const pending = new Map();
const errors = [];
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

async function waitFor(expr, timeoutMs = 10000) {
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

async function pause(ms) {
    await new Promise((r) => setTimeout(r, ms));
}

const cardStatus = (staffId) => `document.querySelector('[data-attendance-staff-card][data-staff-id="${staffId}"]')?.querySelector('[data-status]')?.getAttribute('data-status') || null`;
const cardText = (staffId) => `document.querySelector('[data-attendance-staff-card][data-staff-id="${staffId}"]')?.innerText || ''`;

/** Open the mark-attendance modal for the card of the given staff member. */
async function openMarkModal(staffId) {
    await evaluate(`(() => {
        const card = document.querySelector('[data-attendance-staff-card][data-staff-id=${JSON.stringify(staffId)}]');
        const btn = card && card.querySelector('[data-action="attendance-mark"]');
        if (btn) btn.click();
        return !!btn;
    })()`);
    await waitFor(`document.querySelector('form[data-action="submit-attendance"]') !== null`);
}

/** Fill the open attendance modal and submit. Excludes staffId/date (preset). */
async function submitAttendance({ status, checkIn = '', checkOut = '', notes = '' }) {
    const fields = { status };
    if (checkIn) fields.checkIn = checkIn;
    if (checkOut) fields.checkOut = checkOut;
    if (notes) fields.notes = notes;
    await evaluate(`(() => {
        const f = document.querySelector('form[data-action="submit-attendance"]');
        for (const [n, v] of Object.entries(${JSON.stringify(fields)})) {
            const el = f.querySelector('[name="' + n + '"]');
            if (!el) continue;
            el.value = v;
            el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
        }
        return true;
    })()`);
    await evaluate(`document.querySelector('form[data-action="submit-attendance"]').requestSubmit()`);
    await waitFor(`!document.querySelector('form[data-action="submit-attendance"]')`);
    await pause(200);
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
        } else if (msg.method === 'Runtime.exceptionThrown') {
            errors.push('exception: ' + (msg.params.exceptionDetails?.text || 'unknown'));
        } else if (msg.method === 'Runtime.consoleAPICalled') {
            if (msg.params.type === 'error' || msg.params.type === 'warning') {
                const text = (msg.params.args || []).map((a) => a.value || a.description || '').join(' ');
                if (text) errors.push(text);
            }
        }
    };
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: APP_URL });
    await waitFor(`document.readyState === 'complete'`);

    // Sign in (demo mode) with the guided tour suppressed.
    await waitFor(`document.querySelector('form[data-action="email-auth"]') !== null`);
    await evaluate(`localStorage.setItem('spacrm_tutorial_progress_v1', JSON.stringify({ completedTours: {}, setupGuideSeen: true })); true`);
    await evaluate(`(() => {
        const f = document.querySelector('form[data-action="email-auth"]');
        const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } };
        set('salonName', 'Attendance Test Salon');
        set('email', 'att@test.com');
        set('password', 'secret123');
        return true;
    })()`);
    await evaluate(`document.querySelector('form[data-action="email-auth"]').requestSubmit()`);
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance') || document.querySelector('[aria-label="SPACRM guided tour"]') !== null`, 20000);
    if (await evaluate(`document.querySelector('[aria-label="SPACRM guided tour"]') !== null`)) {
        await click('[data-tutorial-action="skip"]');
        await click('[data-action="tab"][data-tab="dashboard"]');
    }
    await waitFor(`document.body.innerText.includes('Your Salon at a Glance')`, 20000);

    const todayStr = await evaluate(`(() => {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    })()`);

    console.log('\n[1] Open Staff > Attendance (the redesigned daily view)');
    await click('[data-action="tab"][data-tab="staff"]');
    await waitFor(`document.querySelector('[data-action="staff-tab"][data-staff-tab="attendance"]') !== null`);
    await click('[data-action="staff-tab"][data-staff-tab="attendance"]');
    await waitFor(`document.querySelectorAll('[data-attendance-staff-card]').length === 2`);
    assert(await evaluate(`document.querySelectorAll('[data-attendance-staff-card]').length === 2`), 'two staff attendance cards render (one per member, not per record)');
    assert(await evaluate(`${cardStatus('st1')} === 'Not marked'`), 'Victoria card starts marked as not attended');
    assert(await evaluate(`${cardStatus('st2')} === 'Not marked'`), 'Julian card starts marked as not attended');
    assert(await evaluate(`${cardText('st1')}.includes('—')`), 'Victoria meta pills show placeholders (no times)');
    assert(await evaluate(`document.querySelector('[data-attendance-staff-card]').dataset.date === '${todayStr}'`), 'daily cards are for today');
    assert(await evaluate(`document.querySelector('[data-action="attendance-day-next"]').disabled === true`), 'Next-day nav disabled on today');
    assert(await evaluate(`document.querySelector('[data-attendance-day]').textContent.trim().length > 0`), 'day label renders');

    console.log('\n[2] Mark Victoria Present via the modal (with times + notes)');
    await openMarkModal('st1');
    assert(await evaluate(`document.querySelector('form[data-action="submit-attendance"] [name="staffId"]').value === 'st1'`), 'modal staff is preselected to Victoria');
    assert(await evaluate(`document.querySelector('form[data-action="submit-attendance"] [name="date"]').value === '${todayStr}'`), 'modal date is preselected to the active day');
    assert(await evaluate(`document.querySelector('form[data-action="submit-attendance"] [name="status"]').value === 'Present'`), 'modal defaults to Present status');
    await submitAttendance({ status: 'Present', checkIn: '09:00', checkOut: '18:00', notes: 'great day' });
    assert(await evaluate(`${cardStatus('st1')} === 'Present'`), 'Victoria card shows Present');
    assert(await evaluate(`${cardText('st1')}.includes('09:00') && ${cardText('st1')}.includes('18:00')`), 'check-in / check-out shown on the card');
    assert(await evaluate(`${cardText('st1')}.includes('9h')`), 'working hours "9h" computed and shown');
    assert(await evaluate(`${cardText('st1')}.includes('great day')`), 'notes shown on the card');
    assert(await evaluate(`document.querySelectorAll('[data-attendance-staff-card][data-staff-id="st1"]').length === 1`), 'still exactly one consolidated card for Victoria');

    console.log('\n[3] Mark Julian Late');
    await openMarkModal('st2');
    await submitAttendance({ status: 'Late', checkIn: '10:30' });
    assert(await evaluate(`${cardStatus('st2')} === 'Late'`), 'Julian card shows Late');
    assert(await evaluate(`document.querySelectorAll('[data-attendance-staff-card]').length === 2`), 'two cards total, never more');

    console.log('\n[4] Date navigation (prev / today / next)');
    const dayLabelToday = await evaluate(`document.querySelector('[data-attendance-day]').textContent.trim()`);
    await click('[data-action="attendance-day-prev"]');
    await waitFor(`!(${cardStatus('st1')}).includes('Present')`);
    assert(await evaluate(`${cardStatus('st1')} === 'Not marked'`), 'previous day shows a clean unmarked roster');
    assert(await evaluate(`document.querySelector('[data-attendance-day]').textContent.trim() !== ${JSON.stringify(dayLabelToday)}`), 'date label moved back a day');
    assert(await evaluate(`document.querySelector('[data-action="attendance-day-next"]').disabled === false`), 'Next-day nav re-enabled off today');
    await click('[data-action="attendance-day-today"]');
    await waitFor(`${cardStatus('st1')} === 'Present'`);
    assert(await evaluate(`${cardStatus('st2')} === 'Late'`), 'jumping back to Today restores both records');
    assert(await evaluate(`document.querySelector('[data-action="attendance-day-next"]').disabled === true`), 'Next-day nav disabled again on today');

    console.log('\n[5] Monthly report reflects the day');
    const collapsedSummary = await evaluate(`(() => {
        const el = document.querySelector('[data-attendance-summary]');
        return (el ? el.innerText : '').toUpperCase().replace(/\\s+/g, ' ');
    })()`);
    assert(collapsedSummary.includes('TEAM') && collapsedSummary.includes('2 TEAM'), `salon team size = 2 (got "${collapsedSummary}")`);
    assert(collapsedSummary.includes('2 WORKING DAYS'), `working days total = 2 (got "${collapsedSummary}")`);
    assert(collapsedSummary.includes('1 LATE'), `late total = 1 (got "${collapsedSummary}")`);
    assert(collapsedSummary.includes('0 LEAVE'), `leave total = 0 (got "${collapsedSummary}")`);
    assert(collapsedSummary.includes('100% ATTENDANCE'), `attendance % = 100 (got "${collapsedSummary}")`);
    assert(await evaluate(`document.querySelector('[data-report-row][data-report-staff="st1"]')?.innerText.includes('working days · total days 1')`), 'Victoria report row covers exactly 1 day');

    console.log('\n[6] Repository-level duplicate protection still holds');
    const dupMsg = await evaluate(`(async () => {
        try {
            const m = await import('/js/services/attendanceRepository.js');
            await m.markAttendance({ staffId: 'st2', staffName: 'Julian Vance', date: ${JSON.stringify(todayStr)}, status: 'Leave' });
            return 'NO-THROW';
        } catch (e) { return e.message; }
    })()`);
    assert(dupMsg !== 'NO-THROW', 'duplicate mark throws instead of writing a second row');
    assert(await evaluate(`document.querySelectorAll('[data-attendance-staff-card]').length === 2`), 'no duplicate card rendered after blocked write');

    console.log('\n[7] Edit a record (hours recalc)');
    await evaluate(`(() => {
        const card = document.querySelector('[data-attendance-staff-card][data-staff-id="st1"]');
        const btn = card && card.querySelector('[data-action="open-edit"][data-type="attendance"]');
        if (btn) btn.click();
        return !!btn;
    })()`);
    await waitFor(`document.querySelector('form[data-action="submit-attendance"] [name="id"]') !== null`);
    await submitAttendance({ status: 'Present', checkIn: '09:00', checkOut: '18:30', notes: 'great day' });
    assert(await evaluate(`${cardText('st1')}.includes('9h 30m')`), 'edited check-out recomputes hours to 9h 30m');

    console.log('\n[8] Delete a record');
    await evaluate(`(() => {
        const card = document.querySelector('[data-attendance-staff-card][data-staff-id="st2"]');
        const btn = card && card.querySelector('[data-action="request-delete"]');
        if (btn) btn.click();
        return !!btn;
    })()`);
    await waitFor(`document.querySelector('[data-action="confirm-delete"]') !== null`);
    await click('[data-action="confirm-delete"]');
    await waitFor(`${cardStatus('st2')} === 'Not marked'`);
    assert(await evaluate(`document.querySelectorAll('[data-attendance-staff-card]').length === 2`), 'Julian card clears to unmarked after delete');
    const collapsedAfterDelete = await evaluate(`(() => {
        const el = document.querySelector('[data-attendance-summary]');
        return (el ? el.innerText : '').toUpperCase().replace(/\\s+/g, ' ');
    })()`);
    assert(collapsedAfterDelete.includes('1 WORKING DAYS'), `delete reduces working-days total to 1 (got "${collapsedAfterDelete}")`);
    assert(collapsedAfterDelete.includes('0 LATE'), `delete clears the late total (got "${collapsedAfterDelete}")`);

    console.log('\n[9] Empty month + staff filter');
    const prevMonth = await evaluate(`(() => {
        const d = new Date();
        d.setMonth(d.getMonth() - 1);
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1);
    })()`);
    await evaluate(`(() => {
        const el = document.querySelector('[data-action="attendance-month"]');
        if (!el) return false;
        el.value = ${JSON.stringify(prevMonth)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await waitFor(`document.body.innerText.includes('No attendance recorded for this month yet')`);
    assert(true, 'empty previous month shows the empty state');

    await evaluate(`(() => {
        const el = document.querySelector('[data-action="attendance-month"]');
        if (!el) return false;
        el.value = ${JSON.stringify(todayStr.slice(0, 7))};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await waitFor(`document.querySelector('[data-report-row][data-report-staff="st1"]') !== null`);

    await evaluate(`(() => {
        const el = document.querySelector('[data-action="attendance-staff-filter"]');
        if (!el) return false;
        el.value = 'st1';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await waitFor(`document.querySelector('[data-report-row][data-report-staff="st1"]')?.innerText.includes('working days · total days 1')`);
    const filteredSummary = await evaluate(`(() => {
        const el = document.querySelector('[data-attendance-summary]');
        return (el ? el.innerText : '').toUpperCase().replace(/\\s+/g, ' ');
    })()`);
    assert(filteredSummary.includes('1 WORKING DAYS'), `staff filter restricts summary to Victoria only (got "${filteredSummary}")`);

    await evaluate(`(() => {
        const el = document.querySelector('[data-action="attendance-staff-filter"]');
        if (!el) return false;
        el.value = 'all';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await waitFor(`document.querySelector('[data-report-row][data-report-staff="st2"]') !== null`);

    console.log('\n[10] Layout and runtime health');
    for (const [w, h, label] of [[320, 568, 'small phone'], [375, 667, 'iPhone'], [768, 1024, 'tablet']]) {
        await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 768 });
        await pause(300);
        assert(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), `no horizontal overflow at ${w}x${h} (${label})`);
    }
    await click('[data-action="staff-tab"][data-staff-tab="roster"]');
    await pause(250);
    assert(await evaluate(`document.body.innerText.includes('Victoria Sterling')`), 'Team roster still renders after view swap');
    assert(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), 'roster fits a small phone');
    assert(await evaluate(`document.querySelectorAll('#app script, #app [onclick], #app img[onerror]').length === 0`), 'no executable attributes in the rendered DOM');

    const uniqueErrors = [...new Set(errors)].filter((e) => !/favicon|net::ERR|No Firebase configuration provided/.test(e));
    assert(uniqueErrors.length === 0, `no console errors (found: ${uniqueErrors.length ? uniqueErrors.join(' | ') : 'none'})`);
    uniqueErrors.forEach((e) => console.log('      -> ' + e));

    console.log(`\n===== ATTENDANCE E2E: ${pass} passed, ${fail} failed =====`);
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
    console.error('\nATTENDANCE E2E ERROR:', err.message);
    if (ws) try { ws.close(); } catch (e) { /* ignore */ }
    killChromeTree(chromeProc && chromeProc.pid);
    cleanup();
    process.exit(2);
});