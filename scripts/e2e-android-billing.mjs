/** Debug APK + connected emulator. Controlled HTTPS fixtures at the app origin, no live writes.
 * Checks the native Google Play billing bridge wiring:
 *  - `AndroidBilling` exists for our origin's main frame and answers `init`;
 *  - it is NOT injected into a cross-origin frame (e.g. the payment provider's);
 *  - a launch for a product Play cannot sell returns an error instead of hanging;
 *  - payment pop-ups (bank / 3-D Secure) open in-app only while checkout is active.
 * Real purchases need Play Console products, a license tester and enrollment.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const adbPath = process.env.ADB || join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe');
const adb = (...args) => execFileSync(adbPath, args, { encoding: 'utf8' }).trim();
const origin = `https://${JSON.parse(readFileSync(new URL('../twa/twa-manifest.json', import.meta.url))).host}`;
const appId = process.env.ANDROID_TEST_APP_ID || 'com.luxeglow.crm';
const pid = adb('shell', 'pidof', appId).split(' ')[0];
assert(pid, 'Launch the debug APK first');
const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="icon" href="data:,"></head>
<body style="background:#020617;color:white"><div id="app"><h1>Billing fixture</h1></div>
<script>
window.__msgs = []; window.__frame = null;
addEventListener('message', (e) => { if (e.data && e.data.frameSees) window.__frame = e.data.frameSees; });
if (window.AndroidBilling) { AndroidBilling.onmessage = (e) => __msgs.push(JSON.parse(e.data)); AndroidBilling.postMessage(JSON.stringify({ type: 'init' })); }
</script><iframe src="https://payments.invalid/frame" style="width:1px;height:1px"></iframe></body></html>`;
const frame = '<!doctype html><script>parent.postMessage({ frameSees: typeof AndroidBilling }, "*")</script>';
let socket, sequence = 0;
const pending = new Map();
function send(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(method)); }, 15000);
        pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });
}
async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
}
async function until(expression, ms = 10000) {
    for (let waited = 0; waited < ms; waited += 250) { const v = await evaluate(expression); if (v) return v; await sleep(250); }
    return evaluate(expression);
}
const windows = () => adb('shell', 'dumpsys', 'window', 'windows').split('\n').filter((l) => /Window #\d+ Window\{/.test(l) && l.includes(appId)).length;

try {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = (event) => {
        const m = JSON.parse(event.data);
        if (m.id && pending.has(m.id)) {
            const cb = pending.get(m.id); pending.delete(m.id);
            if (m.error) cb.reject(new Error(JSON.stringify(m.error))); else cb.resolve(m.result);
        } else if (m.method === 'Fetch.requestPaused') {
            const body = m.params.request.url.startsWith(origin) ? page : frame;
            send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200,
                responseHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'Cache-Control', value: 'no-store' }],
                body: Buffer.from(body).toString('base64') }).catch((e) => console.error(e.message));
        }
    };
    await send('Page.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/*` }, { urlPattern: 'https://payments.invalid/*' }] });
    await send('Page.navigate', { url: `${origin}/?platform=android&billing-test=1` });
    await sleep(1500);

    assert.equal(await evaluate('typeof AndroidBilling.postMessage'), 'function');
    const ready = await until("__msgs.find((m) => m.type === 'ready') || null");
    assert(ready, 'Native bridge answers init');
    console.log(`PASS: AndroidBilling injected for ${origin}; Play Billing ready=${ready.available}.`);
    assert.equal(await until('__frame'), 'undefined', 'Cross-origin frames must not see the billing bridge');
    console.log('PASS: bridge is not exposed to a cross-origin frame.');

    if (ready.available) {
        await evaluate(`AndroidBilling.postMessage(JSON.stringify({ type: 'launch', requestId: 'r1', mode: 'choice',
            productId: 'glowos_not_a_product', basePlanId: 'monthly', accountId: '${'a'.repeat(64)}' })); true`);
        const reply = await until("__msgs.find((m) => m.requestId === 'r1') || null");
        assert(reply?.type === 'error', `Unknown product reports an error: ${JSON.stringify(reply)}`);
        console.log(`PASS: launch for an unsellable product returns "${reply.message}".`);
    } else {
        console.log('SKIP: launch check (Play Billing unavailable on this device/account).');
    }

    const before = windows();
    await evaluate("AndroidBilling.postMessage(JSON.stringify({ type: 'checkout', active: true })); true");
    await sleep(300);
    await evaluate("window.__popup = window.open('https://example.com/', '_blank'); !!window.__popup");
    await sleep(2500);
    assert(windows() > before, 'Payment window opens in-app while checkout is active');
    assert.equal(await evaluate('location.search.includes("billing-test=1")'), true, 'Main page stays in place');
    await evaluate('window.__popup.close(); true');
    await sleep(1000);
    assert.equal(windows(), before, 'Closing the payment window dismisses it');
    await evaluate("AndroidBilling.postMessage(JSON.stringify({ type: 'checkout', active: false })); true");
    console.log('PASS: payment pop-up opens in-app during checkout and closes cleanly.');
} finally {
    if (socket?.readyState === WebSocket.OPEN) {
        await send('Fetch.disable').catch(() => {});
        socket.close();
    }
    adb('forward', '--remove', `tcp:${port}`);
}
