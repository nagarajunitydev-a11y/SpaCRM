import assert from 'node:assert/strict';
import { createStore } from '../public/js/core/store.js';
import { canRefreshAndroidApp, installAndroidRefresh } from '../public/js/core/androidRefresh.js';

const idle = {
    mode: 'firebase', authReady: true, network: true, userRole: 'salon_owner',
    activeTab: 'dashboard', authView: 'default', authFormMode: 'signin',
};
let fields = [];
let dialog = null;
const document = { querySelector: () => dialog, querySelectorAll: () => fields };
let checks = 0;
function expect(state, expected, tour = false) {
    assert.equal(canRefreshAndroidApp({ ...idle, ...state }, document, tour), expected);
    checks++;
}
expect({}, true);
expect({ mode: 'demo' }, false);
expect({ authReady: false }, false);
expect({ network: false }, false);
expect({ isModalOpen: true }, false);
expect({ trialStarting: true }, false);
expect({ needsSalon: true }, false);
expect({}, false, true);
for (const activeTab of ['appointments', 'customers', 'checkout', 'quickBilling', 'subscription']) {
    expect({ activeTab }, false);
}
expect({ userRole: 'super_admin', activeTab: 'admin_salons' }, true);
expect({ userRole: 'guest' }, true);
expect({ userRole: 'guest', authFormMode: 'signup' }, false);
expect({ userRole: 'guest', authView: 'reset' }, false);
dialog = {};
expect({}, false);
dialog = null;
fields = [{ type: 'email', value: 'owner@example.com', defaultValue: '' }];
expect({ userRole: 'guest' }, false);
fields = [{ type: 'file', files: [{}] }];
expect({}, false);
fields = [{ type: 'checkbox', checked: true, defaultChecked: false }];
expect({}, false);
fields = [{ tagName: 'SELECT', selectedIndex: 1, options: [{}, {}] }];
expect({}, false);
fields = [{ tagName: 'SELECT', selectedIndex: 1, options: [{}, { defaultSelected: true }] }];
expect({}, true);
fields = [];

const store = createStore({ ...idle, activeTab: 'checkout' });
const listeners = new Map();
let reloads = 0;
installAndroidRefresh({
    window: { addEventListener: (name, callback) => listeners.set(name, callback), location: { reload: () => reloads++ } },
    document, store, isTourActive: () => false,
});
listeners.get('qvrix:foreground')();
assert.equal(reloads, 0, 'foreground must preserve checkout');
store.setState({ activeTab: 'customers' });
assert.equal(reloads, 0, 'foreground must preserve navigation');
store.setState({ activeTab: 'dashboard' });
assert.equal(reloads, 1, 'deferred refresh runs on return to idle dashboard');
store.setState({ network: true });
assert.equal(reloads, 1, 'store updates must not cause a reload loop');
listeners.get('qvrix:foreground')();
assert.equal(reloads, 2, 'another reopen fetches the current deployed code');
checks += 5;
console.log(`All ${checks} Android refresh checks passed.`);
