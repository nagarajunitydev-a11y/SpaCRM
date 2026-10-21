/** Installed debug APK + running emulator/device required. No live deployment is modified.
 * CDP serves two controlled HTTPS responses at the configured production origin,
 * so deployment refresh and session storage can be tested without bypassing TLS.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const adbPath = process.env.ADB || join(process.env.LOCALAPPDATA || '', 'Android/Sdk/platform-tools/adb.exe');
const adb = (...args) => execFileSync(adbPath, args, { encoding: 'utf8' }).trim();
const origin = `https://${JSON.parse(readFileSync(new URL('../twa/twa-manifest.json', import.meta.url))).host}`;
const pid = adb('shell', 'pidof', 'com.luxeglow.crm').split(' ')[0];
assert(pid, 'Launch the installed debug APK before running this test');
const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
let socket;
let sequence = 0;
let version = 1;
let requests = 0;
let intercepting = true;
const pending = new Map();
const refreshSource = readFileSync(new URL('../public/js/core/androidRefresh.js', import.meta.url), 'utf8').replaceAll('export ', '');
const fixture = () => `<!doctype html><html><head><title>Deployment ${version}</title><link rel="icon" href="data:,"><script>
// Synthetic HTTPS responses have no real worker/cache state to migrate.
if(navigator.serviceWorker) navigator.serviceWorker.getRegistrations=async()=>[];
if(window.caches) caches.keys=async()=>[];
</script></head><body>
<div id="app"><p>Controlled production response ${version}</p></div><script type="module">
${refreshSource}
const listeners = new Set();
let state = {mode:'firebase',authReady:true,network:true,userRole:'salon_owner',activeTab:'dashboard'};
window.testStore = {getState:()=>state,subscribe:fn=>listeners.add(fn),setState:patch=>{
state={...state,...patch}; for(const fn of listeners) fn();}};
installAndroidRefresh({window,document,store:window.testStore,isTourActive:()=>false});
window.fixtureReady = true;
</script></body></html>`;

function send(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
        pending.set(id, {
            resolve: result => { clearTimeout(timer); resolve(result); },
            reject: error => { clearTimeout(timer); reject(error); },
        });
        socket.send(JSON.stringify({ id, method, params }));
    });
}
async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
}
async function until(expression) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        try { if (await evaluate(expression)) return; } catch { /* A reload replaces the JS context. */ }
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`Not observed: ${expression}`);
}
async function reopen() {
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    // Let Android finish stopping the Activity before bringing its task back.
    await new Promise(resolve => setTimeout(resolve, 1000));
    adb('shell', 'am', 'start', '-W', '-n', 'com.luxeglow.crm/.LauncherActivity');
    await new Promise(resolve => setTimeout(resolve, 500));
}

try {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            const callback = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
            else callback.resolve(message.result);
        } else if (message.method === 'Fetch.requestPaused' && intercepting) {
            const { requestId, request, resourceType } = message.params;
            if (new URL(request.url).origin === origin) {
                const isPage = resourceType === 'Document';
                if (isPage) requests++;
                send('Fetch.fulfillRequest', {
                    requestId, responseCode: 200,
                    responseHeaders: [{ name: 'Content-Type', value: isPage ? 'text/html' : 'text/plain' }, { name: 'Cache-Control', value: 'no-store' }],
                    body: Buffer.from(isPage ? fixture() : '').toString('base64'),
                }).catch(error => { if (!error.message.includes('Invalid InterceptionId')) console.error(error); });
            } else send('Fetch.continueRequest', { requestId }).catch(error => console.error(error));
        }
    };
    await send('Page.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/*`, requestStage: 'Request' }] });
    await send('Page.navigate', { url: `${origin}/?platform=android` });
    await until("window.fixtureReady && document.title === 'Deployment 1'");
    // Allow native cache migration's one-time reload to finish before setting markers.
    await new Promise(resolve => setTimeout(resolve, 1000));
    await until('window.fixtureReady');
    await evaluate("localStorage.setItem('qvrix_native_refresh_test','retained'); document.cookie='qvrix_native_refresh_test=retained; Secure; SameSite=Lax; path=/'; true");
    const initialRequests = requests;
    version = 2;
    await reopen();
    await until("window.fixtureReady && document.title === 'Deployment 2'");
    assert(requests > initialRequests, 'Reopen must request the new response without reinstalling the APK');
    assert.equal(await evaluate("localStorage.getItem('qvrix_native_refresh_test')"), 'retained');
    assert.equal(await evaluate("document.cookie.includes('qvrix_native_refresh_test=retained')"), true);
    console.log('PASS: same APK reopens to deployment 2; cookies and DOM storage persist.');

    await evaluate("window.testStore.setState({activeTab:'checkout'}); true");
    version = 3;
    await reopen();
    assert.equal(await evaluate('document.title'), 'Deployment 2', 'Returning during checkout must not reload');
    await evaluate("window.testStore.setState({activeTab:'dashboard'}); true");
    await until("window.fixtureReady && document.title === 'Deployment 3'");
    console.log('PASS: checkout survives reopening; deployment 3 loads after return to dashboard.');
    await evaluate("localStorage.removeItem('qvrix_native_refresh_test'); document.cookie='qvrix_native_refresh_test=; Max-Age=0; Secure; path=/'; true");
    console.log(`PASS: ${requests} document requests at ${origin}; controlled responses only, no production publish.`);
} finally {
    if (socket?.readyState === WebSocket.OPEN) {
        intercepting = false;
        await send('Fetch.disable').catch(() => {});
        await send('Page.navigate', { url: `${origin}/?platform=android` }).catch(() => {});
        socket.close();
    }
    adb('forward', '--remove', `tcp:${port}`);
}
