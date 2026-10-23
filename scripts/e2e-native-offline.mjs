// Dedicated Android emulator smoke test. Never targets a physical device or
// clears app data. Adds a uniquely named DEMO record, force-stops and reopens.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const adb = process.env.ADB || join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe');
const serial = process.env.ANDROID_TEST_SERIAL || 'emulator-5554';
assert(/^emulator-\d+$/.test(serial), 'Only a dedicated emulator is allowed.');
const appId = 'com.luxeglow.crm.nativepilot';
const activity = `${appId}/com.qvrix.glowos.nativeapp.MainActivity`;
const call = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function hierarchy() {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const status = call('shell', 'uiautomator', 'dump', '/sdcard/glowos-native-smoke.xml');
            if (status.includes('dumped to:')) return call('shell', 'cat', '/sdcard/glowos-native-smoke.xml');
        } catch { /* The accessibility tree may be briefly unavailable during launch. */ }
        await delay(500);
    }
    throw new Error('The emulator accessibility tree is unavailable. Wake and unlock the emulator.');
}
async function find(label, click = false) {
    const end = Date.now() + 25000;
    while (Date.now() < end) {
        const xml = await hierarchy();
        const node = [...xml.matchAll(/<node\b[^>]+>/g)].map(m => m[0]).find(node => node.includes(`text="${label}"`));
        if (node) {
            if (click) {
                const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
                assert(bounds, `No bounds for ${label}`);
                call('shell', 'input', 'tap', String(Math.round((+bounds[1] + +bounds[3]) / 2)), String(Math.round((+bounds[2] + +bounds[4]) / 2)));
            }
            return;
        }
        await delay(500);
    }
    throw new Error(`Native UI did not show: ${label}`);
}

const airplane = call('shell', 'settings', 'get', 'global', 'airplane_mode_on');
const wifi = call('shell', 'settings', 'get', 'global', 'wifi_on');
const mobile = call('shell', 'settings', 'get', 'global', 'mobile_data');
try {
    call('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
    call('shell', 'wm', 'dismiss-keyguard');
    call('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable');
    call('shell', 'svc', 'wifi', 'disable');
    call('shell', 'svc', 'data', 'disable');
    call('shell', 'am', 'start', '-W', '-n', activity);
    const initial = await hierarchy();
    if (initial.includes('text="Open offline demo"')) await find('Open offline demo', true);
    await find('Offline demo • no cloud uploads');
    await find('Customers', true);
    await find('Add customer', true);
    await find('Name', true);
    const name = `OfflineSmoke${Date.now()}`;
    call('shell', 'input', 'text', name);
    call('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await find('Save locally', true);
    await find(name);
    await find('Pending Sync');
    call('shell', 'am', 'force-stop', appId);
    call('shell', 'am', 'start', '-W', '-n', activity);
    await find('Customers', true);
    await find(name);
    await find('Pending Sync');
    console.log('PASS native cold launch, local customer save and Pending Sync survive force-stop/reopen with network disabled');
} finally {
    call('shell', 'cmd', 'connectivity', 'airplane-mode', airplane === '1' ? 'enable' : 'disable');
    if (wifi === '1') call('shell', 'svc', 'wifi', 'enable');
    if (mobile === '1') call('shell', 'svc', 'data', 'enable');
}
