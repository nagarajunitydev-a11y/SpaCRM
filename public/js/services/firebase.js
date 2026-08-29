/**
 * firebase.js
 * Firebase bootstrap and connection layer.
 *
 * - Initialises the SDK only when a real configuration was injected
 *   (`window.__firebase_config`); otherwise the app runs in demo mode.
 * - Enables Firestore offline persistence so the app works without a network.
 * - Tracks online/offline status and surfaces it to the store.
 *
 * No secrets are hard-coded in this file. Never log the raw config.
 */

import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import { getAuth as fbGetAuth, setPersistence as fbSetPersistence, browserLocalPersistence, onAuthStateChanged as fbOnAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import {
    initializeFirestore,
    persistentLocalCache,
    persistentSingleTabManager,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

import { resolveFirebaseConfig, hasFirebaseConfig } from '../config.js';
import { store } from '../core/store.js';

let fb = null;
let networkStatusAttached = false;

/** Returns the live Firebase handle or null when in demo mode. */
export function getFirebase() {
    return fb;
}

export function isDemoMode() {
    return !fb;
}

/**
 * Attempts to initialise Firebase. Any failure falls back to demo mode so the
 * app remains usable offline / without configuration. Idempotent: a second
 * call (there should never be one, but this guards against it — e.g. a
 * future hot-reload path) reuses the already-initialised handle instead of
 * creating a second Firebase App / Firestore instance.
 */
export async function initFirebase() {
    // Online/offline tracking works in every mode.
    attachNetworkStatus();

    if (fb) return true;

    if (!hasFirebaseConfig()) {
        console.warn('No Firebase configuration provided — running in demo mode.');
        store.setState({ mode: 'demo' });
        return false;
    }

    try {
        const firebaseConfig = resolveFirebaseConfig();
        // Reuse an existing [DEFAULT] app instead of calling initializeApp()
        // a second time, which throws ("Firebase App named '[DEFAULT]'
        // already exists"). Guards against ever accidentally standing up a
        // second Firebase App / Firestore instance.
        const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
        const auth = fbGetAuth(app);

        // Persist the signed-in session in local storage so it survives the
        // Google OAuth redirect round-trip and every reload. This is the
        // default on most platforms but is set explicitly so mobile Safari /
        // ITP storage restrictions can never downgrade the session.
        try {
            await fbSetPersistence(auth, browserLocalPersistence);
        } catch (e) {
            console.warn('[auth] Could not set local auth persistence; using default.', e);
        }

        let db;
        try {
            db = initializeFirestore(app, {
                localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
            });
        } catch (e) {
            console.warn('Firestore persistence unavailable, using default settings.', e);
            const { getFirestore } = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
            db = getFirestore(app);
        }

        fb = { app, auth, db };
        store.setState({ mode: 'firebase' });

        return true;
    } catch (err) {
        console.warn('Firebase initialisation failed — running in demo mode.', err);
        fb = null;
        store.setState({ mode: 'demo' });
        return false;
    }
}

function attachNetworkStatus() {
    // Never stack duplicate window listeners if initFirebase() is ever
    // called more than once (see the idempotency guard above).
    if (networkStatusAttached) return;
    networkStatusAttached = true;
    // Network tracking is independent of the backend (works in demo mode too).
    const updateOnline = (online) => store.setState({ network: online });
    window.addEventListener('online', () => updateOnline(true));
    window.addEventListener('offline', () => updateOnline(false));
}

export function onAuthStateChanged(callback) {
    if (!fb) return () => {};
    return fbOnAuthStateChanged(fb.auth, callback);
}

export default {
    initFirebase,
    getFirebase,
    isDemoMode,
    onAuthStateChanged,
};
