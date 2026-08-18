/**
 * e2e-firebase-fallback.mjs
 * Verifies graceful degradation when a real (but unreachable) Firebase config
 * is injected — the app must still boot to the login screen without uncaught
 * exceptions. Zero dependencies (Node 22+ WebSocket + fetch + spawn).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9338;
const userData = mkdtempSync(join(tmpdir(), 'luxe-fb-'));

const chrome = spawn(
    process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + PORT, `--user-data-dir=${userData}`, 'about:blank'],
    { stdio: 'ignore' },
);

let ws;
const pending = new Map();
const errors = [];
let msgId = 0;

function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('CDP timeout: ' + method)), 15000);
        pending.set(id, (err, res) => { clearTimeout(t); err ? reject(err) : resolve(res); });
        ws.send(JSON.stringify({ id, method, params }));
    });
}

async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('evaluate failed');
    return r.result.value;
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

async function main() {
    // Wait for CDP.
    let list = null;
    for (let i = 0; i < 40; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/json`);
            if (res.ok) { list = await res.json(); break; }
        } catch (e) { /* retry */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    if (!list) throw new Error('could not reach CDP');

    const page = list.find((t) => t.type === 'page');
    await new Promise((resolve, reject) => {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        ws.onopen = resolve;
        ws.onerror = reject;
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

    await send('Runtime.enable');
    await send('Page.enable');

    const injectedConfig = {
        apiKey: 'DEMO-KEY-do-not-use',
        authDomain: 'demo-project-unreachable.firebaseapp.com',
        projectId: 'demo-project-unreachable',
        storageBucket: 'demo-project-unreachable.appspot.com',
        messagingSenderId: '0',
        appId: '1:0:web:0',
    };

    await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.__app_id = 'fake-app'; window.__firebase_config = ${JSON.stringify(JSON.stringify(injectedConfig))};`,
    });
    await send('Page.navigate', { url: process.env.APP_URL || 'http://127.0.0.1:5500/' });
    await new Promise((r) => setTimeout(r, 7000));

    const loginShown = await evaluate(`document.body.innerText.includes('Qvrix Luxe Salon CRM')`);
    const shell = await evaluate(`!!document.querySelector('#app')`);
    const fatal = errors.filter((e) => !/net::|auth\/|failed to fetch/i.test(e));

    console.log('login screen renders:', loginShown ? 'PASS' : 'FAIL');
    console.log('app shell present:  ', shell ? 'PASS' : 'FAIL');
    console.log('no fatal JS errors: ', fatal.length === 0 ? 'PASS' : `FAIL -> ${JSON.stringify(fatal)}`);

    const ok = loginShown && shell && fatal.length === 0;
    console.log(ok ? '\nFALLBACK TEST RESULT: PASS' : '\nFALLBACK TEST RESULT: FAIL');
    try { ws.close(); } catch (e) { /* ignore */ }
    chrome.kill('SIGKILL');
    cleanup();
    process.exit(ok ? 0 : 1);
}

main().catch((err) => {
    console.error('FALLBACK TEST ERROR:', err.message);
    if (ws) try { ws.close(); } catch (e) { /* ignore */ }
    cleanup();
    process.exit(2);
});