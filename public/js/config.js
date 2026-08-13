/**
 * config.js
 * Runtime configuration.
 *
 * Firebase configuration may be injected at runtime by the hosting layer via
 * the globals `__app_id`, `__firebase_config`, and `__initial_auth_token`.
 * No secrets are committed to this repository. When configuration is absent
 * the app runs in a self-contained DEMO MODE backed by local state, so the
 * original preview behaviour is preserved.
 */

const ROOT = typeof globalThis !== 'undefined' ? globalThis : window;

const injected = {
    appId: typeof ROOT.__app_id !== 'undefined' ? ROOT.__app_id : null,
    firebaseConfig: typeof ROOT.__firebase_config !== 'undefined' ? ROOT.__firebase_config : null,
    initialAuthToken: typeof ROOT.__initial_auth_token !== 'undefined' ? ROOT.__initial_auth_token : null,
};

export const APP_ID = injected.appId || 'salon-crm-pro-default';

/**
 * Resolves the Firebase configuration object.
 * Returns null when no real configuration is available (demo mode).
 */
export function resolveFirebaseConfig() {
    if (injected.firebaseConfig) {
        try {
            const config = JSON.parse(injected.firebaseConfig);
            if (config && typeof config === 'object' && config.projectId) {
                return config;
            }
        } catch (e) {
            console.warn('Invalid __firebase_config provided; falling back to demo mode.', e);
        }
    }
    return null;
}

export function getInitialAuthToken() {
    return injected.initialAuthToken || null;
}

/** True when the app should run against real Firebase services. */
export function hasFirebaseConfig() {
    return resolveFirebaseConfig() !== null;
}

export const DEMO = {
    projectId: 'demo-preview',
    defaultSalonId: 'salon_luxe_01',
};
