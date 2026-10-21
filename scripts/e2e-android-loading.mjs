/** Debug APK + connected emulator. Controlled HTTPS fixtures, no TLS bypass or live writes.
 * Exercises native loading/error visibility independently of external Firebase availability.
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
let socket, sequence = 0, failure = false, documents = 0;
const pending = new Map();
const fixture = '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Loading fixture</title><link rel="icon" href="data:,"><script>if(navigator.serviceWorker)navigator.serviceWorker.getRegistrations=async()=>[]; if(window.caches)caches.keys=async()=>[];</script></head><body style="background:#020617;color:white"><div id="app"></div></body></html>';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function send(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(method)); }, 15000);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });
}
async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
}
function hierarchy() {
    adb('shell', 'uiautomator', 'dump', '/sdcard/qvrix-loading-test.xml');
    return adb('shell', 'cat', '/sdcard/qvrix-loading-test.xml');
}
function loaderVisible() { return hierarchy().includes('content-desc="Qvrix GlowOS is loading"'); }
async function navigate() {
    await send('Page.navigate', { url: `${origin}/?platform=android&loading-test=1` });
    await sleep(700);
}
async function render(label) {
    await evaluate(`document.getElementById('app').innerHTML=${JSON.stringify(`<h1>${label}</h1><input aria-label="Email">`)}; true`);
    await sleep(400);
}

async function run() {
    try {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        socket.onmessage = event => {
            const message = JSON.parse(event.data);
            if (message.id && pending.has(message.id)) {
                const callback = pending.get(message.id); pending.delete(message.id);
                if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
                else callback.resolve(message.result);
            } else if (message.method === 'Fetch.requestPaused') {
                const { requestId, resourceType } = message.params;
                if (resourceType === 'Document') documents++;
                if (failure) {
                    send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }).catch(error => console.error(error.message));
                    return;
                }
                send('Fetch.fulfillRequest', { requestId, responseCode: 200,
                    responseHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'Cache-Control', value: 'no-store' }],
                    body: Buffer.from(fixture).toString('base64'),
                }).catch(error => console.error(error.message));
            }
        };
        await send('Page.enable');
        await send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/*`, requestStage: 'Request' }] });
        await navigate();
        if (process.env.ANDROID_TEST_FIRST_LAUNCH) {
            for (let i = 0; i < 20 && documents < 2; i++) await sleep(250);
            assert(documents >= 2, 'Fresh installation performs its initial cache migration reload');
            console.log('PASS: first launch completes the one-time cache migration.');
        }
        assert(loaderVisible(), 'Keep native logo visible while the asynchronous shell is empty');
        adb('shell', 'screencap', '-p', '/sdcard/qvrix-loading-preview.png');
        adb('pull', '/sdcard/qvrix-loading-preview.png', 'twa/app/build/loading-preview.png');
        if (process.env.ANDROID_LOADING_PREVIEW_ONLY) return;
        await render('Login fixture');
        assert(!loaderVisible(), 'Reveal rendered login without another splash');
        assert(hierarchy().includes('Login fixture'));
        console.log('PASS: delayed shell retains loader; rendered login is revealed.');

        // Model an existing session without changing real Firebase or application data.
        await evaluate("localStorage.setItem('qvrix_loading_test','retained'); document.cookie='qvrix_loading_test=retained; Secure; path=/'; true");
        await navigate();
        assert(loaderVisible());
        assert.equal(await evaluate("localStorage.getItem('qvrix_loading_test')"), 'retained');
        assert.equal(await evaluate("document.cookie.includes('qvrix_loading_test=retained')"), true);
        await render('Dashboard fixture');
        assert(!loaderVisible());
        assert(hierarchy().includes('Dashboard fixture'));
        console.log('PASS: subsequent navigation reveals dashboard; session storage/cookies retained.');

        // The migration reload must stay covered rather than briefly exposing an empty page.
        const beforeMigration = documents;
        await navigate();
        await evaluate('AndroidNative.cacheMigrationComplete(true); true');
        await sleep(700);
        assert(documents > beforeMigration + 1, 'Migration reload observed');
        assert(loaderVisible(), 'Migration does not dismiss the overlay');
        await render('Login after migration');
        assert(!loaderVisible());
        console.log('PASS: cache migration reload remains covered by the same overlay.');

        failure = true;
        await navigate();
        assert(!loaderVisible());
        assert(hierarchy().includes('Check your internet connection'));
        failure = false;
        // Tap the actual native Retry button from its reported bounds.
        const retry = hierarchy().match(/text="Retry"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        assert(retry, 'Native Retry is available');
        adb('shell', 'input', 'tap', String((+retry[1] + +retry[3]) / 2), String((+retry[2] + +retry[4]) / 2));
        await sleep(700);
        assert(loaderVisible());
        await render('Recovered login');
        assert(!loaderVisible());
        console.log('PASS: network failure dismisses loader; native Retry recovers.');

        await navigate();
        assert(loaderVisible());
        await sleep(30500);
        assert(!loaderVisible());
        assert(hierarchy().includes('Loading took too long'));
        await render('Late content');
        assert(hierarchy().includes('Loading took too long'), 'Late content cannot override an error');
        console.log('PASS: stalled initialization times out with Retry; late callbacks do not hide errors.');
    } finally {
        if (socket?.readyState === WebSocket.OPEN) {
            await evaluate("localStorage.removeItem('qvrix_loading_test'); document.cookie='qvrix_loading_test=; Max-Age=0; path=/'; true").catch(() => {});
            await send('Fetch.disable').catch(() => {});
            await send('Page.navigate', { url: `${origin}/?platform=android` }).catch(() => {});
            socket.close();
        }
        adb('forward', '--remove', `tcp:${port}`);
    }
}
await run();
