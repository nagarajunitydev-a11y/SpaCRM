/**
 * firebase-config.dev.js
 * Local-development wiring for the Firebase project `crmapp-1299dddb`.
 *
 * Firebase web-app configs are intentionally public — access control is
 * enforced by Security Rules + Firebase Authentication, not by hiding keys.
 *
 * Activation is EXPLICIT so the default demo mode and the e2e suite remain
 * untouched: this script only injects the config when the page is opened with
 * `?firebase=1` (e.g. http://127.0.0.1:5500/?firebase=1). Hosts that already
 * injected `window.__firebase_config` (e.g. a preview/emulator layer) always
 * win and this script does nothing.
 */
(() => {
    if (typeof window === 'undefined') return;
    if (typeof window.__firebase_config !== 'undefined') return;
    if (!/(?:^|[?&])firebase=1(?:&|$)/.test(window.location.search || '')) return;

    window.__firebase_config = JSON.stringify({
        apiKey: 'AIzaSyAQ8LY9AWyVyfMbxOMGxoNSvjEqgXXu-eM',
        authDomain: 'crmapp-1299dddb.firebaseapp.com',
        projectId: 'crmapp-1299dddb',
        storageBucket: 'crmapp-1299dddb.firebasestorage.app',
        messagingSenderId: '886981548742',
        appId: '1:886981548742:web:a6686177a005ac42f415c7',
    });
})();
