/**
 * referralSettingsRepository.js
 * Per-salon referral programme configuration.
 *
 * Stored as a single document `salons/{salonId}/referralSettings/config` so the
 * owner's settings are tenant-scoped exactly like every other salon record and
 * are covered by the same security rules. Reads always pass through
 * `sanitizeSettings`, so callers can never observe an out-of-range value even
 * if a stale/hand-edited document exists.
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { listenCollection, setDocument } from './db.js';
import { sanitizeSettings, DEFAULT_REFERRAL_SETTINGS } from '../core/referral.js';

export const SETTINGS_DOC_ID = 'config';
export const COLLECTION = 'referralSettings';

let unsub = null;
let subscribedId = null;

/** Effective settings for the active salon (defaults until one is saved). */
export function getSettings() {
    return sanitizeSettings(store.getState().referralSettings || DEFAULT_REFERRAL_SETTINGS);
}

/** True when the owner has switched the programme on. */
export function isProgrammeEnabled() {
    return getSettings().enabled === true;
}

/** (Re)point the settings listener at a salon. */
export function setSalon(salonId) {
    if (salonId === subscribedId && unsub) return;
    if (unsub) {
        unsub();
        unsub = null;
    }
    subscribedId = salonId;

    if (isDemoMode()) {
        // Demo mode keeps whatever the owner configured during the session and
        // otherwise falls back to the documented defaults.
        if (!store.getState().referralSettings) {
            store.setState({ referralSettings: { ...DEFAULT_REFERRAL_SETTINGS } });
        }
        return;
    }

    if (!salonId || !store.getState().currentUser) {
        store.setState({ referralSettings: null });
        return;
    }

    // A one-document collection is still cheapest to watch as a collection:
    // it reuses the shared listener plumbing and needs no extra read path.
    unsub = listenCollection(
        ['salons', salonId, COLLECTION],
        (rows) => {
            const config = (rows || []).find((r) => r.id === SETTINGS_DOC_ID) || null;
            store.setState({ referralSettings: config ? sanitizeSettings(config) : { ...DEFAULT_REFERRAL_SETTINGS } });
        },
        () => store.setState({ referralSettings: { ...DEFAULT_REFERRAL_SETTINGS } }),
    );
}

/** Persist settings for the active salon. Values are sanitized before write. */
export async function saveSettings(patch) {
    const salonId = store.getState().currentSalonId;
    const next = sanitizeSettings({ ...getSettings(), ...patch });
    const row = { ...next, updatedAt: new Date().toISOString() };

    if (isDemoMode()) {
        store.setState({ referralSettings: next });
        return row;
    }
    if (!salonId) throw new Error('No salon selected.');

    await setDocument(['salons', salonId, COLLECTION], SETTINGS_DOC_ID, row);
    // The listener delivers the authoritative document; state is set there.
    return row;
}

export default {
    COLLECTION,
    SETTINGS_DOC_ID,
    getSettings,
    isProgrammeEnabled,
    setSalon,
    saveSettings,
};
