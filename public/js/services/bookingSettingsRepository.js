/**
 * bookingSettingsRepository.js
 * Per-salon public online-booking configuration: `salons/{salonId}/bookingSettings/config`.
 *
 * Same shape as referralSettingsRepository.js: a single owner-writable
 * document, always read through `sanitizeBookingSettings` so a stale or
 * hand-edited document can never hand the app an out-of-range value.
 *
 * This document is the ONLY thing the public booking page ever reads, and it
 * is deliberately public-safe: it never contains the salon's ownerEmail/
 * ownerId, staff phone numbers, or anything else from the private `salons`,
 * `services` or `staff` documents. See core/bookingConfig.js for exactly what
 * gets denormalized into `publicServices` / `publicStaff` and why.
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { listenCollection, setDocument, updateDocument } from './db.js';
import { sanitizeBookingSettings, toPublicServices, toPublicStaff, DEFAULT_BOOKING_SETTINGS } from '../core/bookingConfig.js';

export const SETTINGS_DOC_ID = 'config';
export const COLLECTION = 'bookingSettings';

let unsub = null;
let subscribedId = null;

/** Effective booking settings for the active salon (defaults until saved). */
export function getSettings() {
    return sanitizeBookingSettings(store.getState().bookingSettings || DEFAULT_BOOKING_SETTINGS);
}

/** True when the owner has switched public online booking on. */
export function isOnlineBookingEnabled() {
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
        if (!store.getState().bookingSettings) {
            // Demo mode has no "does the doc exist" distinction; treat the
            // in-memory settings as already-configured so the catalog sync
            // below always has somewhere to write.
            store.setState({ bookingSettings: { ...DEFAULT_BOOKING_SETTINGS }, bookingSettingsDocExists: true });
        }
        return;
    }

    if (!salonId || !store.getState().currentUser) {
        store.setState({ bookingSettings: null, bookingSettingsDocExists: false });
        return;
    }

    unsub = listenCollection(
        ['salons', salonId, COLLECTION],
        (rows) => {
            const config = (rows || []).find((r) => r.id === SETTINGS_DOC_ID) || null;
            store.setState({
                bookingSettings: config ? sanitizeBookingSettings(config) : { ...DEFAULT_BOOKING_SETTINGS },
                // Distinguishes "no document saved yet" (defaults, nothing to
                // keep in sync) from "a real document exists" (safe to
                // updateDocument against). Local-state truthiness alone can't
                // tell these apart since both render the same default shape.
                bookingSettingsDocExists: !!config,
            });
        },
        () => store.setState({ bookingSettings: { ...DEFAULT_BOOKING_SETTINGS }, bookingSettingsDocExists: false }),
    );
}

/** Persist settings for the active salon. Values are sanitized before write. */
export async function saveSettings(patch) {
    const salonId = store.getState().currentSalonId;
    const current = getSettings();
    const next = sanitizeBookingSettings({ ...current, ...patch });
    const row = { ...next, updatedAt: new Date().toISOString() };

    if (isDemoMode()) {
        store.setState({ bookingSettings: next });
        return row;
    }
    if (!salonId) throw new Error('No salon selected.');

    await setDocument(['salons', salonId, COLLECTION], SETTINGS_DOC_ID, row);
    store.setState({ bookingSettingsDocExists: true });
    return row;
}

/**
 * Refresh the public-safe services/staff snapshot from the salon's real
 * catalogs. Called whenever services or staff change (see main.js) so the
 * public booking page never falls far behind the real catalog. A no-op when
 * online booking has never been configured (nothing to keep in sync yet).
 */
export async function syncPublicCatalog(servicesList, staffList) {
    const state = store.getState();
    if (!state.bookingSettingsDocExists) return; // owner has never saved Booking Link settings

    const current = state.bookingSettings || DEFAULT_BOOKING_SETTINGS;
    const publicServices = toPublicServices(servicesList);
    const publicStaff = toPublicStaff(staffList);

    if (isDemoMode()) {
        store.setState({ bookingSettings: sanitizeBookingSettings({ ...current, publicServices, publicStaff }) });
        return;
    }
    const salonId = state.currentSalonId;
    if (!salonId) return;
    await updateDocument(['salons', salonId, COLLECTION], SETTINGS_DOC_ID, {
        publicServices,
        publicStaff,
        updatedAt: new Date().toISOString(),
    });
}

export default {
    COLLECTION,
    SETTINGS_DOC_ID,
    getSettings,
    isOnlineBookingEnabled,
    setSalon,
    saveSettings,
    syncPublicCatalog,
};
