/**
 * exitGuard.js
 * Android/mobile Back-button exit protection.
 *
 * This SPA never touches browser history for its own internal navigation
 * (tabs/modals are plain in-memory state, see router.js) — so, left alone,
 * the very first hardware/browser Back press would fall straight through to
 * whatever the platform does by default (closing the tab, or — in the
 * Android TWA wrapper — finishing the Activity immediately; see
 * LauncherActivity.java's `handleBackNavigation`).
 *
 * The fix: keep exactly one dummy history entry pushed at all times. A Back
 * press pops it and fires `popstate`, which we catch and *immediately*
 * re-push before the user can see anything change. If a modal/dialog is
 * open, Back closes that first (matches how the visible X / backdrop tap
 * already works, and stops a stray Back press from skipping straight past
 * an in-progress form/payment/booking to a full app exit). Only when
 * nothing is open does Back show the "Exit SPACRM?" confirmation.
 */

import { isAndroidTwa } from './platform.js';
import showExitConfirmDialog from '../ui/exitConfirmDialog.js';

let installed = false;
let dialogOpen = false;
let handlePopState = null;

function pushGuardState() {
    try {
        history.pushState({ spacrmExitGuard: true }, '', location.href);
    } catch (e) {
        // Some sandboxed/embedded webviews restrict the History API — the
        // guard simply can't engage there, which is no worse than today.
    }
}

function makePopStateHandler({ hasOpenModal, closeModal }) {
    return async function onPopState() {
        pushGuardState();

        if (hasOpenModal && hasOpenModal()) {
            closeModal();
            return;
        }

        if (dialogOpen) return; // never stack a second confirmation
        dialogOpen = true;
        const shouldExit = await showExitConfirmDialog();
        dialogOpen = false;
        if (shouldExit) performExit();
    };
}

/** Leave the app: the native bridge in the Android TWA wrapper, else a best-effort browser exit. */
function performExit() {
    if (isAndroidTwa() && window.AndroidNative && typeof window.AndroidNative.exitApp === 'function') {
        window.AndroidNative.exitApp();
        return;
    }
    // Plain mobile browser: no way to force a tab closed or guarantee a page
    // before this one exists — best effort, "as supported by the platform".
    window.removeEventListener('popstate', handlePopState);
    try { window.close(); } catch (e) { /* not opened via script - ignore */ }
    history.go(-2);
}

/**
 * Install the Back-button exit guard once. Safe to call more than once.
 *
 * `hasOpenModal` / `closeModal` are optional — a host app with no modal
 * overlay concept (e.g. the public booking wizard) can simply omit them and
 * every Back press goes straight to the exit confirmation.
 */
export function installExitGuard(opts = {}) {
    if (installed) return;
    installed = true;
    handlePopState = makePopStateHandler(opts);
    pushGuardState();
    window.addEventListener('popstate', handlePopState);
}

export default installExitGuard;
