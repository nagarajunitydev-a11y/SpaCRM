/**
 * publicBookingApp.js
 * Bootstrap + event delegation for the public, no-login booking page
 * (public/book.html). Independent runtime from the authenticated CRM SPA —
 * shares no state with core/store.js's app singleton, main.js's bootstrap or
 * router.js — but reuses the same observable-store primitive (createStore),
 * the same sanitize/validate/scheduling/referral pure modules, and writes
 * through services/publicBookingService.js, which targets the exact same
 * Firestore collections/shapes the CRM's own repositories use.
 */

import { createStore } from '../core/store.js';
import { sanitizeDOM, esc } from '../core/sanitize.js';
import { refreshIcons } from '../ui/icons.js';
import { isValidIndianPhone, isBlank, EMAIL_RE } from '../core/validate.js';
import { sanitizePhoneInputLive } from '../core/utils.js';
import { installExitGuard } from '../core/exitGuard.js';
import { isValidCodeFormat, normalizeCode } from '../core/referral.js';
import { isBookableDate, localDateStr } from '../core/bookingConfig.js';
import { totalDurationMinutes } from '../core/scheduling.js';
import renderPublicBooking from './publicBookingView.js';
import * as bookingService from '../services/publicBookingService.js';

const appEl = document.getElementById('app');

const store = createStore({
    phase: 'loading', // loading | not-found | disabled | error | booking | confirmed
    errorMessage: '',
    salonId: '',
    salonDisplayName: '',
    settings: null,
    step: 1,
    today: localDateStr(),
    maxDate: localDateStr(),
    selectedServices: [],
    staffChoice: '',
    date: '',
    time: '',
    slotsLoading: false,
    availableSlots: [],
    draft: { customerName: '', customerPhone: '', customerEmail: '', referralCode: '', notes: '' },
    referralApplied: false,
    submitting: false,
    formError: '',
    confirmation: null,
});

/* ------------------------------------------------------------------ */
/* URL parsing                                                         */
/* ------------------------------------------------------------------ */

/**
 * Resolve the salon id from the clean `/book/{salonId}` path (the shape the
 * owner's Copy Link/QR/WhatsApp share always produces, served via the
 * hosting rewrite in vercel.json / firebase.json) with a `?salonId=`
 * fallback for local development against a bare static server, which cannot
 * rewrite arbitrary paths.
 */
function resolveSalonId() {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('salonId');
    if (fromQuery) return fromQuery.trim();

    const match = /\/book\/([^/?#]+)/.exec(window.location.pathname);
    return match ? decodeURIComponent(match[1]) : '';
}

/**
 * Booking source, honestly attributed: the owner's WhatsApp share button
 * appends `src=whatsapp` to the link it shares (see ui/views/bookingLink.js);
 * every other entry point (Copy Link, Open Link, QR code, a bare pasted URL)
 * carries no such marker and is recorded as the generic `public_booking`
 * source instead — matching the spec's "whatsapp or public_booking" values
 * without ever guessing.
 */
function resolveBookingSource() {
    const params = new URLSearchParams(window.location.search);
    return params.get('src') === 'whatsapp' ? 'whatsapp' : 'public_booking';
}

function resolveReferralCodeFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return normalizeCode(params.get('ref') || '');
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */

function render() {
    if (!appEl) return;
    let html;
    try {
        html = renderPublicBooking(store.getState());
    } catch (err) {
        console.error('[booking] Render error:', err);
        html = `<div class="p-8 text-center text-xs text-rose-400">${esc(err.message || String(err))}</div>`;
    }
    appEl.innerHTML = html;
    sanitizeDOM(appEl);
    refreshIcons(appEl);
    restoreDraftIntoForm();
}

/** Re-apply in-memory draft values into the (freshly re-rendered) details form. */
function restoreDraftIntoForm() {
    const form = document.getElementById('booking-details-form');
    if (!form) return;
    const draft = store.getState().draft || {};
    Object.entries(draft).forEach(([name, value]) => {
        const el = form.querySelector(`[name="${name}"]`);
        if (el && value) el.value = value;
    });
}

/* ------------------------------------------------------------------ */
/* Slot fetching                                                       */
/* ------------------------------------------------------------------ */

let slotRequestId = 0;

async function refreshSlots() {
    const state = store.getState();
    if (!state.staffChoice || !state.date || state.selectedServices.length === 0) {
        store.setState({ availableSlots: [] });
        return;
    }

    const requestId = ++slotRequestId;
    store.setState({ slotsLoading: true, availableSlots: [] });

    try {
        // Fetch the public configuration for every availability calculation.
        // This keeps an already-open booking page in step with working-hours
        // changes without caching an obsolete weekly schedule in the client.
        const settings = await bookingService.fetchBookingSettings(state.salonId);
        if (requestId !== slotRequestId) return;
        if (!settings || settings.enabled !== true) {
            store.setState({ slotsLoading: false, availableSlots: [], time: '' });
            return;
        }
        const services = settings.publicServices || [];
        const staffList = settings.publicStaff || [];
        const durationMinutes = totalDurationMinutes(state.selectedServices, services);

        const slots = await bookingService.fetchAvailableSlots({
            salonId: state.salonId,
            settings,
            date: state.date,
            durationMinutes,
            staffName: state.staffChoice,
            staffList,
        });

        if (requestId !== slotRequestId) return; // a newer request superseded this one
        store.setState({
            settings,
            slotsLoading: false,
            availableSlots: slots,
            time: slots.some((s) => s.time === state.time) ? state.time : '',
        });
    } catch (err) {
        if (requestId !== slotRequestId) return;
        console.warn('[booking] Could not load slots:', err);
        store.setState({ slotsLoading: false, availableSlots: [] });
    }
}

/* ------------------------------------------------------------------ */
/* Form helpers                                                        */
/* ------------------------------------------------------------------ */

function readDetailsForm() {
    const form = document.getElementById('booking-details-form');
    if (!form) return null;
    const fd = new FormData(form);
    const data = {};
    for (const [key, value] of fd.entries()) data[key] = typeof value === 'string' ? value.trim() : value;
    return data;
}

function showDetailsError(message) {
    const el = document.getElementById('booking-details-error');
    if (!el) return;
    if (!message) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    el.textContent = message;
    el.classList.remove('hidden');
}

function validateDetails(data) {
    if (isBlank(data.customerName)) return 'Enter your name.';
    if (!isValidIndianPhone(data.customerPhone)) return 'Enter a valid 10-digit mobile number.';
    if (!isBlank(data.customerEmail) && !EMAIL_RE.test(data.customerEmail)) return 'Enter a valid email address.';
    if (!isBlank(data.referralCode) && !isValidCodeFormat(data.referralCode)) return 'That referral code looks incorrect.';
    return null;
}

/* ------------------------------------------------------------------ */
/* Actions                                                              */
/* ------------------------------------------------------------------ */

const actions = {
    async 'toggle-service'(el) {
        const name = el.dataset.name;
        const state = store.getState();
        const set = new Set(state.selectedServices);
        if (set.has(name)) set.delete(name); else set.add(name);
        store.setState({ selectedServices: [...set] });
    },

    async 'pick-staff'(el) {
        store.setState({ staffChoice: el.dataset.name, time: '' });
        await refreshSlots();
    },

    async 'pick-date'(el) {
        const value = el.value;
        if (!isBookableDate(value, store.getState().settings, store.getState().today)) {
            store.setState({ date: value, time: '', availableSlots: [] });
            return;
        }
        store.setState({ date: value, time: '' });
        await refreshSlots();
    },

    async 'pick-slot'(el) {
        store.setState({ time: el.dataset.time });
    },

    async 'wizard-next'() {
        const leavingServicesStep = store.getState().step === 1;
        store.setState({ step: store.getState().step + 1 });
        // Service selection (and therefore total duration) may have changed
        // since the schedule step was last shown — refresh so a stale slot
        // list (computed against a different duration) is never displayed.
        if (leavingServicesStep) await refreshSlots();
    },

    async 'wizard-back'() {
        store.setState({ step: Math.max(1, store.getState().step - 1) });
    },

    async 'wizard-next-details'() {
        const data = readDetailsForm();
        if (!data) return;
        const error = validateDetails(data);
        if (error) {
            showDetailsError(error);
            return;
        }
        showDetailsError(null);
        store.setState({
            draft: { ...data },
            referralApplied: !isBlank(data.referralCode),
            step: 4,
            formError: '',
        });
    },

    async 'submit-booking'() {
        const state = store.getState();
        if (state.submitting) return;
        store.setState({ submitting: true, formError: '' });

        try {
            const confirmation = await bookingService.submitPublicBooking({
                salonId: state.salonId,
                settings: state.settings,
                servicesCatalog: state.settings.publicServices,
                staffList: state.settings.publicStaff,
                selectedServiceNames: state.selectedServices,
                staffName: state.staffChoice,
                date: state.date,
                time: state.time,
                customerName: state.draft.customerName,
                customerPhone: state.draft.customerPhone,
                customerEmail: state.draft.customerEmail,
                referralCode: state.draft.referralCode,
                notes: state.draft.notes,
                idempotencyToken: bookingService.getIdempotencyToken(),
                source: resolveBookingSource(),
            });
            store.setState({ submitting: false, phase: 'confirmed', confirmation });
        } catch (err) {
            console.warn('[booking] Submit failed:', err);
            store.setState({ submitting: false, formError: err.message || 'Could not complete the booking. Please try again.' });
        }
    },

    async 'book-another'() {
        const state = store.getState();
        store.setState({
            phase: 'booking',
            step: 1,
            selectedServices: [],
            staffChoice: '',
            date: '',
            time: '',
            availableSlots: [],
            draft: { customerName: '', customerPhone: '', customerEmail: '', referralCode: state.draft.referralCode, notes: '' },
            formError: '',
            confirmation: null,
        });
    },
};

function attachDelegation() {
    if (!appEl) return;

    appEl.addEventListener('click', (event) => {
        const el = event.target.closest('[data-action]');
        if (!el || el.disabled) return;
        // A native date input opens its picker on click. Processing it here
        // reads the old (usually empty) value and immediately re-renders the
        // schedule, which replaces the input before the browser can show the
        // picker. Date changes are intentionally handled below, after a value
        // has actually been selected.
        if (el.dataset.action === 'pick-date') return;
        const handler = actions[el.dataset.action];
        if (!handler) return;
        event.preventDefault();
        Promise.resolve(handler(el, event)).catch((err) => {
            console.warn(`[booking] Action "${el.dataset.action}" failed:`, err);
        });
    });

    appEl.addEventListener('change', (event) => {
        const el = event.target.closest('[data-action="pick-date"]');
        if (!el) return;
        const handler = actions['pick-date'];
        Promise.resolve(handler(el, event)).catch((err) => console.warn(err));
    });

    // Digits-only, 10-digit cap on the mobile number field, enforced as the
    // visitor types (not just at submit).
    appEl.addEventListener('input', (event) => {
        sanitizePhoneInputLive(event.target);
    });
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                            */
/* ------------------------------------------------------------------ */

async function bootstrap() {
    store.subscribe(render);
    attachDelegation();
    render();
    installExitGuard();

    const salonId = resolveSalonId();
    if (!salonId) {
        store.setState({ phase: 'not-found' });
        return;
    }

    try {
        await bookingService.ensureBackend();
        const settings = await bookingService.fetchBookingSettings(salonId);

        if (!settings || settings.enabled !== true) {
            store.setState({ phase: 'disabled', salonDisplayName: settings ? settings.displayName : '' });
            return;
        }

        const refCode = resolveReferralCodeFromUrl();
        const maxDate = (() => {
            const d = new Date();
            d.setDate(d.getDate() + settings.advanceBookingDays);
            return localDateStr(d);
        })();

        store.setState({
            phase: 'booking',
            salonId,
            salonDisplayName: settings.displayName,
            settings,
            maxDate,
            draft: {
                customerName: '', customerPhone: '', customerEmail: '',
                referralCode: isValidCodeFormat(refCode) ? refCode : '',
                notes: '',
            },
            referralApplied: isValidCodeFormat(refCode),
        });
    } catch (err) {
        console.error('[booking] Bootstrap failed:', err);
        store.setState({ phase: 'error', errorMessage: err.message || 'Could not load this booking page.' });
    }
}

bootstrap();
