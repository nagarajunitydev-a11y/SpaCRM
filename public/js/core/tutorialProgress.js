/**
 * tutorialProgress.js
 * Per-browser tracking of Initial Setup Guide completion, so a finished (or
 * explicitly skipped) tour is never shown automatically again. Deliberately
 * localStorage-only — no Firestore/user-profile schema touch — so it resets
 * only if the owner clears site data or switches browser/device, at which
 * point a fresh guided setup is arguably useful again anyway.
 */

const STORAGE_KEY = 'spacrm_tutorial_progress_v1';

function readState() {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' ? parsed : { completedTours: {}, setupGuideSeen: false };
    } catch (e) {
        // Private-browsing / storage-disabled contexts: behave as "nothing
        // completed yet" rather than throwing.
        return { completedTours: {}, setupGuideSeen: false };
    }
}

function writeState(state) {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
        // Storage unavailable — the tour still works for this session, it
        // just won't be remembered next time.
    }
}

/** True once the given tour id (e.g. 'staff') has been completed or skipped. */
export function isTourCompleted(tourId) {
    return !!readState().completedTours?.[tourId];
}

/** Mark a single tour as completed/skipped so it won't auto-repeat. */
export function markTourCompleted(tourId) {
    const state = readState();
    state.completedTours = { ...(state.completedTours || {}), [tourId]: true };
    writeState(state);
}

/** True once the automatic Initial Setup Guide has ever been shown. */
export function hasSeenSetupGuide() {
    return !!readState().setupGuideSeen;
}

/** Mark the automatic Initial Setup Guide as offered, so it never auto-shows again. */
export function markSetupGuideSeen() {
    const state = readState();
    state.setupGuideSeen = true;
    writeState(state);
}

export default { isTourCompleted, markTourCompleted, hasSeenSetupGuide, markSetupGuideSeen };
