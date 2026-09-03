/**
 * tutorialOverlay.js
 * The Initial Setup Guide's visual engine: a spotlight around one live UI
 * element plus a tooltip with Previous/Next/Skip controls, and the simpler
 * single-card "info" popover used by each section's ⓘ icon.
 *
 * Rendered straight onto `document.body` (like exitConfirmDialog.js) so an
 * unrelated store-driven re-render of `#app` can never wipe it mid-step.
 * While a guided tour is active it fully blocks interaction with the page
 * underneath — this is a guided, read-and-tap-Next walkthrough, not a
 * "try it yourself while we watch" one, which keeps the implementation (and
 * the beginner experience) simple.
 */

import { esc, escAttr } from '../core/sanitize.js';
import { refreshIcons } from './icons.js';
import { TUTORIALS, TUTORIAL_ORDER } from '../core/tutorialContent.js';
import { markTourCompleted } from '../core/tutorialProgress.js';

let session = null; // { tourIds, tourIndex, stepIndex, onNavigateTab, overlayEl, resizeHandler, lastTourId }

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function currentTour() {
    return TUTORIALS[session.tourIds[session.tourIndex]];
}

function currentStep() {
    return currentTour().steps[session.stepIndex];
}

function isFirstStepOverall() {
    return session.tourIndex === 0 && session.stepIndex === 0;
}

function isLastStepOverall() {
    return session.tourIndex === session.tourIds.length - 1
        && session.stepIndex === currentTour().steps.length - 1;
}

function teardownDom() {
    if (session?.overlayEl) session.overlayEl.remove();
}

function teardown() {
    if (!session) return;
    teardownDom();
    if (session.resizeHandler) window.removeEventListener('resize', session.resizeHandler);
    session = null;
}

/** End the active guided tour, marking every tour it covered as completed. */
export function dismissTour() {
    if (!session) return;
    session.tourIds.forEach((id) => markTourCompleted(id));
    teardown();
}

/** True while a guided tour overlay is showing (used by the Back-button exit guard). */
export function isTourActive() {
    return session !== null;
}

function goNext() {
    if (isLastStepOverall()) {
        dismissTour();
        return;
    }
    const tour = currentTour();
    if (session.stepIndex < tour.steps.length - 1) {
        session.stepIndex += 1;
    } else {
        markTourCompleted(tour.id);
        session.tourIndex += 1;
        session.stepIndex = 0;
    }
    render();
}

function goPrevious() {
    if (isFirstStepOverall()) return;
    if (session.stepIndex > 0) {
        session.stepIndex -= 1;
    } else {
        session.tourIndex -= 1;
        session.stepIndex = TUTORIALS[session.tourIds[session.tourIndex]].steps.length - 1;
    }
    render();
}

function render() {
    if (!session) return;
    teardownDom();

    const tour = currentTour();
    const step = currentStep();

    if (tour.id !== session.lastTourId) {
        session.lastTourId = tour.id;
        session.onNavigateTab?.(tour.tab);
    }

    const targetEl = document.querySelector(step.target);
    const rect = targetEl ? targetEl.getBoundingClientRect() : null;
    const pad = 8;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const cardWidth = Math.min(300, viewportW - 32);
    const cardLeft = rect
        ? clamp(rect.left, 16, Math.max(16, viewportW - cardWidth - 16))
        : (viewportW - cardWidth) / 2;

    let cardPositionStyle;
    if (rect) {
        const spaceBelow = viewportH - rect.bottom;
        const spaceAbove = rect.top;
        const placeAbove = spaceBelow < 190 && spaceAbove > spaceBelow;
        cardPositionStyle = placeAbove
            ? `bottom:${Math.max(16, viewportH - rect.top + pad + 10)}px; left:${cardLeft}px;`
            : `top:${Math.min(viewportH - 16, rect.bottom + pad + 10)}px; left:${cardLeft}px;`;
    } else {
        cardPositionStyle = `top:50%; left:${cardLeft}px; transform:translateY(-50%);`;
    }

    const spotlightHtml = rect
        ? `<div class="absolute rounded-2xl pointer-events-none" style="left:${rect.left - pad}px; top:${rect.top - pad}px; width:${rect.width + pad * 2}px; height:${rect.height + pad * 2}px; box-shadow:0 0 0 9999px rgba(2,6,23,0.85); border:2px solid rgba(129,140,248,0.9);"></div>`
        : `<div class="absolute inset-0 bg-slate-950/85"></div>`;

    const stepNum = session.stepIndex + 1;
    const stepTotal = tour.steps.length;
    const isLast = isLastStepOverall();
    const isFirst = isFirstStepOverall();

    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'SPACRM guided tour');
    overlay.className = 'fixed inset-0 z-[998]';
    overlay.innerHTML = `
        ${spotlightHtml}
        <div class="absolute bg-slate-900 border border-brand-500/40 rounded-2xl p-4 shadow-2xl space-y-3" style="${cardPositionStyle} width:${cardWidth}px;">
            <div class="flex items-center justify-between gap-2">
                <span class="text-[10px] font-bold text-brand-400 uppercase tracking-widest">${esc(tour.label)} • Step ${stepNum} of ${stepTotal}</span>
                <button type="button" data-tutorial-action="skip" aria-label="Skip tour" class="text-slate-500 hover:text-slate-300 transition">
                    <i data-lucide="x" class="w-4 h-4"></i>
                </button>
            </div>
            <div>
                <p class="text-sm font-extrabold text-slate-100">${esc(step.title)}</p>
                <p class="text-xs text-slate-400 mt-1 leading-relaxed">${esc(step.body)}</p>
            </div>
            <div class="flex items-center gap-2 pt-1">
                <button type="button" data-tutorial-action="previous" ${isFirst ? 'disabled' : ''}
                    class="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-bold rounded-xl transition active:scale-95 touch-manipulation disabled:opacity-30 disabled:pointer-events-none">Previous</button>
                <button type="button" data-tutorial-action="skip"
                    class="px-3 py-2 text-slate-400 hover:text-slate-200 text-[11px] font-semibold transition">Skip</button>
                <button type="button" data-tutorial-action="next"
                    class="flex-1 px-3 py-2 bg-brand-600 hover:bg-brand-500 text-white text-[11px] font-bold rounded-xl shadow-lg shadow-brand-600/30 transition active:scale-95 touch-manipulation">${isLast ? 'Finish' : 'Next'}</button>
            </div>
        </div>
    `;

    overlay.addEventListener('click', (event) => {
        const actionEl = event.target.closest('[data-tutorial-action]');
        if (!actionEl) return;
        const action = actionEl.dataset.tutorialAction;
        if (action === 'skip') dismissTour();
        if (action === 'next') goNext();
        if (action === 'previous') goPrevious();
    });

    document.body.appendChild(overlay);
    refreshIcons(overlay);
    session.overlayEl = overlay;
}

/**
 * Start a guided tour session. `tourIds` defaults to the full Initial Setup
 * Guide order; pass a single-element array to replay just one section.
 * `onNavigateTab(tab)` is called by the caller's router whenever a step
 * needs a different tab active.
 */
export function startTour(tourIds = TUTORIAL_ORDER, { onNavigateTab } = {}) {
    teardown();
    const validIds = tourIds.filter((id) => TUTORIALS[id]);
    if (validIds.length === 0) return;
    session = { tourIds: validIds, tourIndex: 0, stepIndex: 0, onNavigateTab, overlayEl: null, lastTourId: null };
    session.resizeHandler = () => render();
    window.addEventListener('resize', session.resizeHandler);
    render();
}

/** The simpler, single-card "what is this for" popover used by ⓘ icons. */
export function showSectionInfo(sectionId) {
    const tour = TUTORIALS[sectionId];
    if (!tour) return;
    const { title, body } = tour.summary;

    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', `About ${title}`);
    overlay.className = 'fixed inset-0 bg-black/80 backdrop-blur-sm z-[998] flex items-center justify-center p-6';
    overlay.innerHTML = `
        <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 max-w-xs w-full shadow-2xl space-y-4">
            <div class="flex items-center gap-3">
                <div class="w-11 h-11 rounded-2xl bg-brand-500/15 text-brand-400 flex items-center justify-center shrink-0" aria-hidden="true">
                    <i data-lucide="info" class="w-5 h-5"></i>
                </div>
                <p class="text-base font-extrabold text-slate-100">${esc(title)}</p>
            </div>
            <p class="text-xs text-slate-400 leading-relaxed">${esc(body)}</p>
            <div class="flex items-center justify-between gap-2 pt-1">
                <button type="button" data-info-action="replay" class="text-[11px] font-semibold text-brand-400 hover:text-brand-300 transition">Show me how &rarr;</button>
                <button type="button" data-info-action="close" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-xl transition active:scale-95 touch-manipulation">Got it</button>
            </div>
        </div>
    `;

    const close = () => overlay.remove();
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close();
        const actionEl = event.target.closest('[data-info-action]');
        if (!actionEl) return;
        if (actionEl.dataset.infoAction === 'close') close();
        if (actionEl.dataset.infoAction === 'replay') {
            close();
            window.dispatchEvent(new CustomEvent('spacrm:replay-tutorial', { detail: { tourId: sectionId } }));
        }
    });

    document.body.appendChild(overlay);
    refreshIcons(overlay);
}

export default { startTour, dismissTour, isTourActive, showSectionInfo };
