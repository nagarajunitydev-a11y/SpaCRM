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

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import { getAuth as fbGetAuth, onAuthStateChanged as fbOnAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import {
    initializeFirestore,
    persistentLocalCache,
    persistentSingleTabManager,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

import { resolveFirebaseConfig, hasFirebaseConfig } from '../config.js';
import { store } from '../core/store.js';

let fb = null;

/** Returns the live Firebase handle or null when in demo mode. */
export function getFirebase() {
    return fb;
}

export function isDemoMode() {
    return !fb;
}

/**
 * Attempts to initialise Firebase. Any failure falls back to demo mode so the
 * app remains usable offline / without configuration.
 */
export async function initFirebase() {
    // Online/offline tracking works in every mode.
    attachNetworkStatus();

    if (!hasFirebaseConfig()) {
        console.warn('No Firebase configuration provided — running in demo mode.');
        store.setState({ mode: 'demo' });
        return false;
    }

    try {
        const firebaseConfig = resolveFirebaseConfig();
        const app = initializeApp(firebaseConfig);
        const auth = fbGetAuth(app);

        let db;
        try {
            db = initializeFirestore(app, {
                localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
            });
        } catch (e) {
            console.warn('Firestore persistence unavailable, using default settings.', e);
            const { getFirestore } = await import('https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js');
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
