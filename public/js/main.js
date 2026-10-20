/**
 * main.js
 * Application bootstrap + orchestration.
 *
 * - Initialises Firebase (or demo mode) and repositories.
 * - Listens to auth state and routes role decisions.
 * - Central event delegation: all `data-action` clicks, change and form submits
 *   are handled here — no inline event handlers are ever rendered.
 */

import { initFirebase, isDemoMode, onAuthStateChanged } from './services/firebase.js';
import * as authService from './services/authService.js';
import * as salonsRepository from './services/salonsRepository.js';
import * as customersRepository from './services/customersRepository.js';
import * as servicesRepository from './services/servicesRepository.js';
import * as staffRepository from './services/staffRepository.js';
import * as appointmentsRepository from './services/appointmentsRepository.js';
import * as rewardTransactionsRepository from './services/rewardTransactionsRepository.js';
import * as referralsRepository from './services/referralsRepository.js';
import * as referralCodesRepository from './services/referralCodesRepository.js';
import * as referralSettingsRepository from './services/referralSettingsRepository.js';
import * as walletRepository from './services/walletRepository.js';
import * as referralService from './services/referralService.js';
import * as bookingSettingsRepository from './services/bookingSettingsRepository.js';
import { store } from './core/store.js';
import { switchTab, setRole, openModal, closeModal, openDeleteConfirm } from './core/router.js';
import { validateForm, toIndianE164, normalizePhoneDigits } from './core/validate.js';
import { sanitizeDOM, esc, escAttr } from './core/sanitize.js';
import { refreshIcons, icon } from './ui/icons.js';
import showNotification from './ui/notification.js';
import { appHeader, bottomNav, desktopSidebar, networkBanner, emptyState } from './ui/components.js';
import { saveDraft, getDraft, clearDraft } from './core/draft.js';
import { debounce, scopedBySalon, formatCurrency, makeId, sanitizePhoneInputLive, currentSalonDateTime, todayStr } from './core/utils.js';
import { shiftDate } from './core/attendance.js';
import renderLogin, { renderForgotPassword, renderResetPassword } from './ui/views/login.js';
import renderDashboard from './ui/views/dashboard.js';
import renderAppointments, {
    DEFAULT_APPOINTMENT_FILTERS,
    setAppointmentSearch,
    filterAppointments,
    renderAppointmentListBody,
    filterFooter,
    activeFilterCount,
    markAppointmentAsNew,
    clearNewAppointment,
} from './ui/views/appointments.js';
import renderCustomers, { renderCustomerCard, sortCustomersByCreation } from './ui/views/customers.js';
import renderServices, { renderServiceListBody } from './ui/views/services.js';
import renderStaff from './ui/views/staff.js';
import renderSuperAdmin from './ui/views/admin.js';
import renderSalonSetup from './ui/views/salonSetup.js';
import renderBranches from './ui/views/branches.js';
import { findDuplicateName, activeBranches, isBranchActive } from './core/branches.js';
import renderSubscription, { subscriptionBanner, onboardingCard, lockedFeatureView } from './ui/views/subscription.js';
import renderCheckout from './ui/views/checkout.js';
import renderAdminSubscriptions from './ui/views/adminSubscriptions.js';
import * as subscriptionService from './services/subscriptionService.js';
import { purchase as purchasePlan, manageAutomaticRenewal, PaymentsUnavailable } from './services/payment/paymentService.js';
import { DEFAULT_PLANS, FEATURES } from './core/plans.js';
import renderModalSheet, { renderCustomerSuggestions } from './ui/views/modals.js';
import renderReferrals, {
    setReferralSearch,
    referralRows,
    filterReferrals,
    renderReferralListBody,
} from './ui/views/referrals.js';
import { renderPaymentSummary, defaultInvoiceAmount } from './ui/views/payment.js';
import { renderBookingLinkModal, bookingLinkFor } from './ui/views/bookingLink.js';
import {
    renderQuickBillingForm,
    renderQuickBillingReceipt,
    renderQuickBillingCustomer,
    renderQuickBillingCustomerSuggestions,
    renderQuickBillingServiceSuggestions,
    renderSelectedServices,
    renderWalletBlock,
} from './ui/views/quickBilling.js';
import { ANY_STAFF, totalDurationMinutes, withDuration, hasConflict, rangeForDate, timeToMinutes } from './core/scheduling.js';
import { sanitizeBookingSettings, bookingReadinessIssues } from './core/bookingConfig.js';
import { round2, num, sanitizeSettings, maxRedeemable, REWARD_TYPES } from './core/referral.js';
import { splitPayment, invoiceNoFor } from './core/wallet.js';
import { serviceAmountFor } from './core/revenue.js';
import { discountAmountFor, discountLabel } from './core/discount.js';
import * as attendanceRepository from './services/attendanceRepository.js';
import { PREDEFINED_SERVICES } from './core/predefinedServices.js';
import { installExitGuard } from './core/exitGuard.js';
import { TUTORIAL_ORDER } from './core/tutorialContent.js';
import { hasSeenSetupGuide, markSetupGuideSeen } from './core/tutorialProgress.js';
import { startTour, dismissTour, isTourActive, showSectionInfo } from './ui/tutorialOverlay.js';
import { isAndroidTwa, isNativePaymentContext } from './core/platform.js';
import { installAndroidRefresh } from './core/androidRefresh.js';

const appEl = document.getElementById('app');

/* ------------------------------------------------------------------ */
/* Demo-mode data seeding (preserves original preview behaviour)       */
/* ------------------------------------------------------------------ */

function seedDemoData() {
    store.setState({
        salonsList: [...salonsRepository.seed],
        customersList: [...customersRepository.seed],
        servicesList: [...servicesRepository.seed],
        staffList: [...staffRepository.seed],
        appointmentsList: [...appointmentsRepository.seed],
        attendanceList: [],
        transactionsList: [...rewardTransactionsRepository.seed],
        transactionsLoaded: true,
        transactionsError: null,
        referralsList: [],
        referralsLoaded: true,
        referralsError: null,
        referralCodesList: [],
        walletTransactionsList: [],
    });
}

/* ------------------------------------------------------------------ */
/* Repository / salon-scope synchronisation                            */
/* ------------------------------------------------------------------ */

let lastSalonScopeKey = null;

function resolveSalonScope() {
    const state = store.getState();
    const isOwner = state.userRole === 'salon_owner';

    const needsSalon = isOwner && state.salonsLoaded && !state.salonsError && state.salonsList.length === 0;
    if (needsSalon !== state.needsSalon) store.setState({ needsSalon });

    let target = null;
    if (isOwner && state.salonsLoaded && state.salonsList.length > 0) {
        const owned = state.salonsList;
        // Only active branches can be worked in; fall back to the first
        // active one (or, if every branch is inactive, the first branch so
        // the owner can still open Branches and re-activate one).
        const usable = activeBranches(owned);
        target = state.currentSalonId;
        if (!usable.some((s) => s.id === target)) {
            target = (usable[0] || owned[0]).id;
        }
    }
    if (target !== store.getState().currentSalonId) store.setState({ currentSalonId: target });

    const key = `${state.userRole}|${state.accountRole}|${state.currentUser ? state.currentUser.uid : 'anon'}|${target}|${state.salonsLoaded}`;
    if (key === lastSalonScopeKey) return;
    lastSalonScopeKey = key;

    if (state.mode === 'firebase') {
        // Do not display the previous branch while new snapshots are loading.
        store.setState({ customersList: [], servicesList: [], staffList: [], appointmentsList: [],
            attendanceList: [], referralsList: [], referralsLoaded: false, referralCodesList: [],
            walletTransactionsList: [], transactionsList: [], referralSettings: null, bookingSettings: null });
    }

    salonsRepository.resubscribeSalons();
    customersRepository.setSalon(target);
    servicesRepository.setSalon(target);
    staffRepository.setSalon(target);
    appointmentsRepository.setSalon(target);
    attendanceRepository.setSalon(target);
    rewardTransactionsRepository.resubscribeTransactions();
    referralsRepository.setSalon(target);
    referralCodesRepository.setSalon(target);
    walletRepository.setSalon(target);
    referralSettingsRepository.setSalon(target);
    bookingSettingsRepository.setSalon(target);
}

/**
 * One-off referral housekeeping per salon: give pre-programme clients a code
 * and sweep credits that have passed their expiry window. Guarded by a
 * per-salon flag so the store subscription that triggers it can never loop.
 */
const referralMaintenanceDone = new Set();

function maybeRunReferralMaintenance() {
    const state = store.getState();
    const salonId = state.currentSalonId;
    if (!salonId || referralMaintenanceDone.has(salonId)) return;
    if (state.userRole !== 'salon_owner') return;
    if (state.access && !state.access.can('referral')) return;
    if (!state.referralsLoaded || (state.customersList || []).length === 0) return;

    referralMaintenanceDone.add(salonId);
    Promise.resolve()
        .then(() => referralService.backfillReferralCodes())
        .then(() => referralService.expireDueReferrals())
        .catch((err) => console.warn('[referral] Maintenance pass failed:', err));
}

function syncSalonScope() {
    resolveSalonScope();
}

/**
 * Start (or restart) a guided tour session. If the Staff tour is included,
 * the roster sub-tab is selected first — the tour's steps target the Team
 * roster, not Attendance, so a returning owner replaying it from wherever
 * they last left the Staff screen still lands on the right elements.
 */
function startTutorialSession(tourIds) {
    if (tourIds.includes('staff')) store.setState({ staffTab: 'roster' });
    startTour(tourIds, { onNavigateTab: switchTab });
}

/**
 * Offer the Initial Setup Guide once per browser, right after a brand-new
 * owner finishes their first salon setup (see resolveSalonScope: `needsSalon`
 * just became false). Guarded so this session can only ever offer it once,
 * on top of core/tutorialProgress.js's own persistent "already seen" flag.
 */
let hasOfferedSetupTutorialThisSession = false;

function maybeOfferSetupTutorial() {
    if (hasOfferedSetupTutorialThisSession || hasSeenSetupGuide()) return;
    const state = store.getState();
    if (state.userRole !== 'salon_owner' || state.needsSalon || !state.salonsLoaded) return;
    if ((state.salonsList || []).length === 0) return;

    hasOfferedSetupTutorialThisSession = true;
    markSetupGuideSeen();
    // Short and fixed, not the arbitrary 500ms this used to be: long enough
    // for the fresh dashboard to actually paint, short enough that it can't
    // realistically race a real user who has already tapped elsewhere by
    // the time it fires — the tour forces its own tab on start, so firing
    // late would otherwise yank an already-navigating user back to Staff.
    setTimeout(() => startTutorialSession([...TUTORIAL_ORDER]), 200);
}

/**
 * Keep the public-safe services/staff snapshot (see
 * bookingSettingsRepository.syncPublicCatalog) in step with the real catalog
 * whenever it changes while the owner's app is open. Cheaply skips when
 * nothing relevant changed (the store fires on every unrelated state change
 * too), and debounces the actual write so a burst of edits only syncs once.
 *
 * Writing the sync's result calls store.setState, which re-renders the WHOLE
 * app — including wiping any transient, imperatively-inserted DOM (inline
 * form field-error messages are never part of store state, only inserted
 * directly into the DOM by renderFieldErrors). A background sync landing
 * while a modal is open would silently erase whatever the user is looking
 * at mid-interaction, so it defers — never skips — until no modal is open.
 */
function runSyncPublicCatalog() {
    const state = store.getState();
    if (state.isModalOpen) {
        setTimeout(runSyncPublicCatalog, 500);
        return;
    }
    if (!state.currentSalonId || (state.access && !state.access.can('onlineBooking'))) return;
    bookingSettingsRepository
        .syncPublicCatalog(
            scopedBySalon(state.servicesList, state.currentSalonId),
            scopedBySalon(state.staffList, state.currentSalonId),
        )
        .catch((err) => console.warn('[booking] Public catalog sync failed:', err));
}
const debouncedSyncPublicCatalog = debounce(runSyncPublicCatalog, 800);

let lastCatalogSignature = null;

function maybeSyncPublicCatalog() {
    const state = store.getState();
    const signature = JSON.stringify([
        state.currentSalonId,
        (state.servicesList || []).map((s) => [s.id, s.name, s.price, s.duration]),
        (state.staffList || []).map((s) => [s.id, s.name, s.role]),
    ]);
    if (signature === lastCatalogSignature) return;
    lastCatalogSignature = signature;
    debouncedSyncPublicCatalog();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderOwnerTab(state) {
    switch (state.activeTab) {
        case 'quickBilling':
            return state.quickBillingReceipt
                ? renderQuickBillingReceipt(state)
                : renderQuickBillingForm(state, getDraft('quickBilling'));
        case 'appointments': return renderAppointments(state);
        case 'customers': return renderCustomers(state);
        case 'referrals':
            return !state.access || state.access.can('referral') ? renderReferrals(state) : lockedFeatureView(state, 'referral');
        case 'subscription': return renderSubscription(state);
        case 'checkout': return renderCheckout(state);
        case 'services': return renderServices(state);
        case 'staff': return renderStaff(state);
        case 'branches': return renderBranches(state);
        default: return onboardingCard(state) + renderDashboard(state);
    }
}

function buildView(state) {
    if (state.userRole === 'guest') {
        if (state.authView === 'forgot') return renderForgotPassword(state);
        if (state.authView === 'reset') return renderResetPassword(state);
        return renderLogin(state);
    }
    if (state.userRole === 'super_admin' && state.accountRole === 'super_admin') {
        return state.activeTab === 'admin_subscriptions' ? renderAdminSubscriptions(state) : renderSuperAdmin(state);
    }
    if (state.needsSalon) {
        return renderSalonSetup(state);
    }
    return renderOwnerTab(state);
}

function buildShell(state) {
    const viewHtml = buildView(state);

    if (state.userRole === 'guest') {
        return viewHtml;
    }

    const showNav = !state.needsSalon;
    const isOwner = state.userRole === 'salon_owner';

    return `
        ${networkBanner(state)}
        ${subscriptionBanner(state)}
        <div class="flex flex-1 min-h-0 w-full desktop-container">
            ${desktopSidebar(state)}
            <div class="flex-1 flex flex-col min-w-0">
                ${appHeader(state)}
                <main class="flex-1 overflow-y-auto p-5 pb-24 no-scrollbar">${viewHtml}</main>
                ${isOwner && showNav && state.activeTab !== 'checkout' ? `
                    <button data-action="tab" data-tab="quickBilling" aria-label="Quick Billing" title="Quick Billing"
                        class="fixed bottom-24 right-4 z-40 lg:hidden w-14 h-14 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 flex items-center justify-center shadow-xl shadow-emerald-500/40 active:scale-95 transition touch-manipulation">
                        <i data-lucide="zap" class="w-6 h-6"></i>
                    </button>
                ` : ''}
                ${showNav ? bottomNav(state) : ''}
            </div>
        </div>
        ${state.isModalOpen ? renderModalSheet(state) : ''}
    `;
}

function renderApp() {
    const state = store.getState();

    if (!appEl) return;

    let html;
    try {
        html = buildShell(state);
    } catch (err) {
        console.error('[MAIN] Render error:', err);
        html = `
            <div class="flex-1 flex items-center justify-center p-8">
                <div class="bg-slate-900 border border-rose-500/30 rounded-2xl p-6 text-center max-w-xs">
                    <p class="text-sm font-bold text-rose-400 mb-2">Something went wrong</p>
                    <p class="text-xs text-slate-400">${esc(err.message || String(err))}</p>
                </div>
            </div>
        `;
    }

    appEl.innerHTML = html;
    sanitizeDOM(appEl);
    refreshIcons(appEl);

    syncAllFormButtons(appEl);

    // A store change just rebuilt the shell (and any open modal) from scratch.
    // Recompose the walk-in bill's live summary/wallet from its restored draft
    // so the rendered totals match the seeded form; saveDraft is non-reactive,
    // so this cannot re-trigger the render.
    const qbForm = appEl.querySelector('form[data-action="submit-quick-billing"]');
    if (qbForm) updateQuickBilling(qbForm);

    if (state.isModalOpen) {
        focusModal();
    }
}

function focusModal() {
    const input = appEl.querySelector('form input, form select');
    if (input) input.focus();
}

/* ------------------------------------------------------------------ */
/* Action handlers (event delegation)                                  */
/* ------------------------------------------------------------------ */

function readFormData(form) {
    const data = {};
    const fd = new FormData(form);
    for (const [key, value] of fd.entries()) {
        data[key] = typeof value === 'string' ? value.trim() : value;
    }
    return data;
}

/** Booking Link settings form values -> a bookingSettingsRepository.saveSettings patch. */
function bookingSettingsPatchFromForm(data) {
    const workingHours = {};
    for (const key of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
        workingHours[key] = {
            closed: data[`closed_${key}`] === 'on' || data[`closed_${key}`] === true,
            start: data[`start_${key}`] || '10:00',
            end: data[`end_${key}`] || '19:00',
        };
    }
    return {
        enabled: data.enabled === 'on' || data.enabled === true,
        displayName: data.displayName || '',
        slotIntervalMinutes: Number(data.slotIntervalMinutes),
        advanceBookingDays: Number(data.advanceBookingDays),
        minNoticeMinutes: Number(data.minNoticeMinutes),
        workingHours,
    };
}

/**
 * Problems that would make the shared booking link unusable, checked against
 * the settings as persisted on the Firestore server (never the in-memory
 * copy), the live services/staff catalog, and any unsaved edits still in the
 * open settings form. Throws when the persisted settings can't be verified.
 */
async function bookingLinkReadinessIssues(form) {
    const saved = await bookingSettingsRepository.fetchPersistedSettings();
    const state = store.getState();
    return bookingReadinessIssues(saved, {
        catalogServices: scopedBySalon(state.servicesList, state.currentSalonId),
        catalogStaff: scopedBySalon(state.staffList, state.currentSalonId),
        draft: form ? bookingSettingsPatchFromForm(readFormData(form)) : undefined,
    });
}

const BOOKING_FIX_LABELS = { settings: 'Review settings', services: 'Open Services', staff: 'Open Staff' };

/** Show (or clear, with []) the booking-link readiness problems in the Booking Link panel. */
function showBookingReadinessIssues(issues) {
    const panel = appEl.querySelector('#booking-readiness-issues');
    if (!panel) {
        if (issues.length) showNotification(issues.map((i) => i.message).join(' '), 'error');
        return;
    }
    if (!issues.length) {
        panel.classList.add('hidden');
        panel.innerHTML = '';
        return;
    }
    const fixes = [...new Set(issues.map((i) => i.fix).filter((f) => BOOKING_FIX_LABELS[f]))];
    panel.innerHTML = `
        <div class="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3">
            <p class="text-[11px] font-bold text-rose-300 mb-1.5">Booking link not sent. Complete these first:</p>
            <ul class="list-disc pl-4 space-y-1 text-[11px] text-rose-200">
                ${issues.map((i) => `<li>${esc(i.message)}</li>`).join('')}
            </ul>
            ${fixes.length ? `<div class="flex flex-wrap gap-2 mt-2.5">${fixes.map((f) => `
                <button type="button" data-action="booking-fix" data-fix="${escAttr(f)}"
                    class="px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 text-[11px] font-semibold rounded-xl transition active:scale-95 touch-manipulation">${esc(BOOKING_FIX_LABELS[f])}</button>`).join('')}</div>` : ''}
        </div>
    `;
    panel.classList.remove('hidden');
}

function findRecord(type, id) {
    const lists = {
        customer: () => customersRepository.getCustomer(id),
        service: () => (store.getState().servicesList || []).find((r) => r.id === id),
        staff: () => (store.getState().staffList || []).find((r) => r.id === id),
        appointment: () => (store.getState().appointmentsList || []).find((r) => r.id === id),
        attendance: () => (store.getState().attendanceList || []).find((r) => r.id === id),
        salon: () => (store.getState().salonsList || []).find((r) => r.id === id),
    };
    const get = lists[type];
    return get ? get() || null : null;
}

function currentSalon() {
    const state = store.getState();
    return (state.salonsList || []).find((s) => s.id === state.currentSalonId) || null;
}

function deleteRecord(target) {
    const deleters = {
        customer: () => customersRepository.deleteCustomer(target.id),
        service: () => servicesRepository.deleteService(target.id),
        staff: () => staffRepository.deleteStaff(target.id),
        appointment: () => appointmentsRepository.deleteAppointment(target.id),
        attendance: () => attendanceRepository.deleteAttendance(target.id),
    };
    return deleters[target.type] || null;
}

async function resolveAppointmentCustomer(data) {
    // Never create a contact on the strength of a pre-snapshot read: wait for
    // the salon's customer list to load (a no-op in demo mode), then look up
    // the SAME data the Customers module reads and writes.
    try {
        await customersRepository.ensureCustomersLoaded();
    } catch (err) {
        console.warn('[customer] Customer list sync unavailable:', err);
    }
    if (data.customerId) {
        const picked = customersRepository.getCustomer(data.customerId);
        if (picked) return picked;
    }
    // The phone number is the contact's identity key whenever one is present
    // (Quick Billing always has one): an unmatched number is a NEW contact even
    // if another client happens to share the typed name. Name matching only
    // kicks in when no phone was provided at all.
    const byPhone = String(data.customerPhone || '').trim()
        ? customersRepository.findCustomerByPhone(data.customerPhone)
        : null;
    if (byPhone) return byPhone;
    const byName = String(data.customerPhone || '').trim()
        ? null
        : customersRepository.findCustomerByName(data.customerName);
    if (byName) return byName;
    const created = await customersRepository.addCustomerQuick({
        name: data.customerName,
        phone: data.customerPhone || '',
        email: data.customerEmail || '',
    });
    referralService.ensureReferralCode(created).catch((err) => console.warn('[referral] Code allocation failed:', err));
    showNotification(`New client "${created.name}" added & linked.`);
    return created;
}

/**
 * Evaluate an appointment against the referral programme after its status or
 * payment changed. Never throws into the caller: a settlement problem must not
 * roll back the booking/billing action the user actually performed.
 */
async function runReferralSettlement(appointment) {
    const access = store.getState().access;
    if (access && !access.can('referral')) return { credited: false, reason: 'Plan excludes referrals' };
    try {
        const result = await referralService.settleAppointment(appointment);
        if (result && result.credited) {
            showNotification(`Referral reward ${formatCurrency(result.amount)} credited to ${result.referrerName || 'the referrer'}.`);
            console.log('[referral] Settlement succeeded:', {
                appointmentId: appointment?.id,
                referrerId: appointment?.customerId,
                amount: result.amount,
                referral: result.referral?.id
            });
        } else if (result && !result.credited) {
            console.log('[referral] Settlement did not credit (expected in many cases):', {
                appointmentId: appointment?.id,
                reason: result.reason
            });
        }
        return result;
    } catch (err) {
        console.warn('[referral] Settlement failed:', err);
        showNotification(`Settlement error: ${err.message}`, 'error');
        return null;
    }
}

/**
 * Undo the referral money attached to an invoice that was refunded or whose
 * appointment was cancelled: return any wallet amount redeemed on it, then
 * claw back the reward it earned.
 */
async function runReferralReversal(appointment, reason) {
    if (!appointment || !appointment.id) return;
    try {
        const restored = await referralService.reverseRedemptionForAppointment(appointment, reason);
        if (restored && restored.restored > 0) {
            showNotification(`${formatCurrency(restored.restored)} returned to the client's referral wallet.`);
        }
        const reversal = await referralService.reverseRewardForAppointment(appointment.id, reason);
        if (reversal && reversal.reversed && reversal.amount > 0) {
            showNotification(`Referral reward of ${formatCurrency(reversal.amount)} reversed.`);
        }
    } catch (err) {
        console.warn('[referral] Reversal failed:', err);
    }
}

/** The appointment row currently in the store. */
function findAppointment(id) {
    return (store.getState().appointmentsList || []).find((a) => a.id === id) || null;
}

function clearFieldErrors(form) {
    if (!form) return;
    form.querySelectorAll('.field-error').forEach((el) => el.remove());
    form.querySelectorAll('.field-invalid').forEach((el) => {
        el.classList.remove('field-invalid');
        el.removeAttribute('aria-invalid');
    });
}

function renderFieldErrors(form, errors) {
    clearFieldErrors(form);
    const fields = Object.keys(errors);
    if (fields.length === 0) return;

    for (const name of fields) {
        const control = form.querySelector(`[name="${name}"]`);
        if (!control) continue;
        control.classList.add('field-invalid');
        control.setAttribute('aria-invalid', 'true');

        const errorEl = document.createElement('p');
        errorEl.className = 'field-error mt-1.5 text-[10px] font-semibold text-rose-400 flex items-center space-x-1';

        const iconEl = document.createElement('i');
        iconEl.setAttribute('data-lucide', 'alert-circle');
        iconEl.className = 'w-3 h-3 shrink-0';

        const text = document.createElement('span');
        text.textContent = errors[name];

        errorEl.appendChild(iconEl);
        errorEl.appendChild(text);
        control.insertAdjacentElement('afterend', errorEl);
    }

    refreshIcons(form);

    const firstControl = form.querySelector(`[name="${fields[0]}"]`);
    if (firstControl) firstControl.focus();
}

/* ------------------------------------------------------------------ */
/* Live validation helpers                                             */
/* ------------------------------------------------------------------ */

function formContext(form) {
    return {
        signup: form.querySelector('[name="salonName"]') !== null,
        branch: form.querySelector('[name="openTime"]') !== null,
        isDuplicateName: (name) => !!findDuplicateName(store.getState().salonsList, name, form.querySelector('[name="id"]')?.value || null),
        // Validation of appointment date/time always compares against the
        // salon's current date/time (not the device's local clock).
        nowDateTime: currentSalonDateTime(currentSalon()),
        originalDateTime: appointmentOriginalDateTime(form),
    };
}

/** Saved date/time of the appointment being edited, or null for a new booking. */
function appointmentOriginalDateTime(form) {
    if (form.dataset.action !== 'submit-appointment') return null;
    const id = form.querySelector('[name="id"]')?.value;
    const rec = id ? findAppointment(id) : null;
    return rec ? { date: rec.date, time: rec.time } : null;
}

function syncFormValidity(form, changedName = null) {
    if (!form || !form.dataset.action) return {};

    const data = readFormData(form);
    const errors = validateForm(form.dataset.action, data, formContext(form));
    const hasErrors = Object.keys(errors).length > 0;

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
        submitBtn.disabled = hasErrors;
        submitBtn.setAttribute('aria-disabled', String(hasErrors));
    }

    if (changedName) {
        const control = form.querySelector(`[name="${changedName}"]`);
        const errorEl = control && control.nextElementSibling;
        if (errorEl && errorEl.classList.contains('field-error')) errorEl.remove();
        if (control) {
            control.classList.remove('field-invalid');
            control.removeAttribute('aria-invalid');
        }
    }

    if (!hasErrors) {
        clearFieldErrors(form);
    }
    return errors;
}

function syncAllFormButtons(root = appEl) {
    // querySelectorAll only searches descendants, so include `root` itself
    // when a single form is passed in.
    const forms = root.matches?.('form[data-action]') ? [root] : root.querySelectorAll('form[data-action]');
    forms.forEach((form) => {
        syncFormValidity(form);
    });
}

function handleFormInput(event) {
    const form = event.target.closest('form[data-action]');
    if (!form) return;
    syncFormValidity(form, event.target.name);
    if (form.dataset.action === 'submit-appointment') {
        saveDraft('appointment', readFormData(form));
    }
    if (form.dataset.action === 'collect-payment') {
        updatePaymentSummary(form);
    }
    if (form.dataset.action === 'submit-quick-billing') {
        updateQuickBilling(form, event.target.name);
    }
    if (form.dataset.action === 'submit-referral-settings' && event.target.name === 'rewardType') {
        const unit = form.querySelector('[data-reward-value-unit]');
        if (unit) unit.textContent = event.target.value === REWARD_TYPES.PERCENT ? '(%)' : '(\u20B9)';
    }
}

/**
 * Recompute the wallet/due breakdown under the billing form. Purely a preview:
 * the redemption is re-validated against freshly read balances inside the
 * transaction that actually moves the money.
 */
function updatePaymentSummary(form) {
    const container = form.querySelector('[data-payment-summary]');
    if (!container) return;

    const state = store.getState();
    const data = readFormData(form);
    const appointment = findAppointment(data.id);
    if (!appointment) return;

    const customer = customersRepository.getCustomer(appointment.customerId);
    const settings = sanitizeSettings(state.referralSettings);
    const invoiceAmount = round2(num(data.invoiceAmount));
    const walletBalance = referralService.walletBalanceOf(customer);
    // The owner can edit the discount fields inline in this same form, so the
    // live preview always reads their current (possibly unsaved) values —
    // not the customer's last-saved discount.
    const discountConfig = { type: state.access && !state.access.can('customerDiscounts') ? '' : (data.discountType || ''), value: data.discountValue };
    const discount = discountAmountFor(discountConfig, invoiceAmount);
    const cap = settings.enabled ? maxRedeemable({ walletBalance, invoiceAmount: round2(invoiceAmount - discount), settings }) : 0;

    container.innerHTML = renderPaymentSummary({
        invoiceAmount,
        walletRedeem: round2(num(data.walletRedeem)),
        walletBalance,
        cap,
        discount,
        discountText: discountLabel(discountConfig),
    });
    sanitizeDOM(container);

    const useMax = form.querySelector('[data-action="wallet-use-max"]');
    if (useMax) useMax.dataset.amount = String(cap);
}

/* ------------------------------------------------------------------ */
/* Quick Billing / Walk-in helpers                                     */
/* ------------------------------------------------------------------ */

/**
 * Line items currently on a walk-in bill. A line id identifies an occurrence,
 * never the service itself, so the same service can be billed repeatedly.
 */
function getQuickBillingLineItems(form) {
    const input = form && form.querySelector('[name="selectedServices"]');
    if (!input) return [];
    try {
        const value = JSON.parse(input.value || '[]');
        return (Array.isArray(value) ? value : []).map((line, index) => {
            // Legacy drafts stored service names only. Position gives each
            // legacy occurrence a stable migration id until the next update.
            if (typeof line === 'string') return { id: `legacy_bill_line_${index}`, name: line.trim(), serviceId: '' };
            return {
                id: String(line?.id || `legacy_bill_line_${index}`),
                name: String(line?.name || '').trim(),
                serviceId: String(line?.serviceId || ''),
            };
        }).filter((line) => line.name);
    } catch {
        return [];
    }
}

/** Appointment editor line items retain every occurrence, including customs. */
function getAppointmentLineItems(value) {
    let parsed = value;
    if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed || '[]'); } catch { parsed = []; }
    }
    return (Array.isArray(parsed) ? parsed : []).map((line, index) => {
        if (typeof line === 'string') return {
            id: `legacy_appointment_line_${index}`,
            serviceId: '', name: line.trim(), price: null, duration: '', custom: false,
        };
        return {
            id: String(line?.lineItemId || `legacy_appointment_line_${index}`),
            serviceId: String(line?.serviceId || ''),
            name: String(line?.name || line?.serviceName || '').trim(),
            price: Number.isFinite(Number(line?.price)) ? Number(line.price) : null,
            duration: line?.duration || '',
            custom: line?.custom === true,
        };
    }).filter((line) => line.name || line.custom);
}

/** Digits-only phone, capped at 10 — matches the live input sanitisation. */
function digitsOf(value) {
    return String(value || '').replace(/\D/g, '').slice(0, 10);
}

/** Bumps on every phone keystroke so the newest lookup always wins. */
let qbPhoneLookupSeq = 0;

/** Debounce timer for the phone type-ahead search. */
let qbCustomerSearchTimer = null;

/**
 * Phone-first client resolution for the walk-in bill: as soon as a valid
 * 10-digit number is typed, look the client up. Existing clients are shown
 * immediately (id + name hidden fields set); a brand-new number reveals the
 * inline "Customer Name" field in the same page. Called from the live
 * `quick-billing-phone` input handler.
 *
 * The lookup runs against the SAME customer data as the main Clients module
 * (customersRepository). While that backend list is still loading its first
 * snapshot, an empty result is not proof the number is new, so a neutral
 * "checking…" block is shown instead of a premature new-client card.
 *
 * NB: the inline name field is NEVER auto-focused. Pulling focus into it on
 * every keystroke is what made the phone field feel locked / unreachable —
 * the caret was yanked away and small screens scrolled the name field into
 * view. The phone input stays in control (mouse, touch and keyboard); the
 * user can move freely between the two fields and any re-typed number re-runs
 * this lookup and re-swaps the inline block.
 */
function updateQuickBillingCustomer(el) {
    const form = el.closest('form[data-action="submit-quick-billing"]');
    const container = form && form.querySelector('[data-quickbilling-customer]');
    if (!form || !container) return;

    const phone = digitsOf(el.value);
    const ready = customersRepository.isCustomersLoaded();
    const customer = ready && phone.length === 10 ? customersRepository.findCustomerByPhone(phone) : null;

    // Preserve the name already typed for a new client while this block
    // re-renders (e.g. after a re-typed number), so nothing is lost.
    const priorName = container.querySelector('[name="customerName"]:not([type="hidden"])');
    const keptName = !customer && priorName ? priorName.value : '';

    container.innerHTML = renderQuickBillingCustomer(customer, {
        phone,
        name: String(keptName || ''),
        checking: !ready && phone.length === 10,
    });
    sanitizeDOM(container);
    refreshIcons(container);

    // No focus is taken from the phone field: let the user stay in the number
    // or move to the name field at their own pace.

    scheduleQuickBillingCustomerSearch(el);
    updateQuickBilling(form);
    syncFormValidity(form, 'customerPhone');
}

/**
 * Debounced type-ahead for the phone field. Shows a loading card immediately,
 * then swaps in the matching contacts (searched against the same customers
 * repository as the Clients module) once typing pauses. The keystroke sequence
 * token discards stale results, so a slow lookup can never overwrite a newer
 * one, and the dropdown renders in-flow so it never covers the phone input.
 */
function scheduleQuickBillingCustomerSearch(el) {
    const form = el.closest('form[data-action="submit-quick-billing"]');
    const dropdown = form && form.querySelector('[data-quickbilling-customer-dropdown]');
    if (!form || !dropdown) return;

    const phone = digitsOf(el.value);
    clearTimeout(qbCustomerSearchTimer);
    if (!phone) {
        dropdown.innerHTML = '';
        return;
    }

    const token = qbPhoneLookupSeq;
    dropdown.innerHTML = renderQuickBillingCustomerSuggestions(null, phone, { loading: true });
    sanitizeDOM(dropdown);
    refreshIcons(dropdown);

    qbCustomerSearchTimer = setTimeout(() => {
        const settle = () => {
            clearTimeout(qbCustomerSearchTimer);
            if (token !== qbPhoneLookupSeq) return;
            // Re-locate the container in the LIVE document instead of rendering
            // into the node captured above: any background store snapshot
            // (booking-settings seeding, a repo update, a new realtime doc)
            // re-renders the whole view mid-typing, which DETACHES that old
            // node. Rendering into it would silently vanish.
            const liveForm = document.querySelector('form[data-action="submit-quick-billing"]');
            const liveDropdown = liveForm && liveForm.querySelector('[data-quickbilling-customer-dropdown]');
            const livePhone = liveForm ? digitsOf((liveForm.querySelector('[name="customerPhone"]') || { value: '' }).value) : '';
            if (!liveDropdown || livePhone !== phone) return;
            liveDropdown.innerHTML = renderQuickBillingCustomerSuggestions(customersRepository.searchCustomersByPhone(phone), phone, {});
            sanitizeDOM(liveDropdown);
            refreshIcons(liveDropdown);
        };
        // Wait for the first backend snapshot when needed; an already-loaded
        // list resolves immediately, so the debounce is the only real delay.
        customersRepository.ensureCustomersLoaded().then(settle).catch(settle);
    }, 180);
}

/**
 * Recompute the live quick-billing breakdown (selected list, wallet block,
 * summary) in place, so typing never triggers a full re-render. The wallet
 * input is left untouched while it is the focused field to keep focus.
 */
function updateQuickBilling(form, changedName = null) {
    if (!form) return;
    const state = store.getState();
    const data = readFormData(form);
    const catalog = scopedBySalon(state.servicesList, state.currentSalonId);
    const lineItems = getQuickBillingLineItems(form);
    const selectedServices = lineItems.map((line) => catalog.find((s) => s.id === line.serviceId) || catalog.find((s) => s.name === line.name)).filter(Boolean);
    const invoiceAmount = round2(selectedServices.reduce((sum, s) => sum + (Number(s.price) || 0), 0));

    // Same identity rules as resolveAppointmentCustomer: id, then phone (the
    // contact key whenever present), and only then an exact-name fallback.
    const customer = customersRepository.getCustomer(data.customerId)
        || (String(data.customerPhone || '').trim() ? customersRepository.findCustomerByPhone(data.customerPhone) : null)
        || (String(data.customerPhone || '').trim() ? null : customersRepository.findCustomerByName(data.customerName));
    const walletBalance = referralService.walletBalanceOf(customer);
    const settings = sanitizeSettings(state.referralSettings);

    const isOwner = state.userRole === 'salon_owner';
    const discountType = state.access && !state.access.can('customerDiscounts') ? '' : (isOwner ? (data.discountType || '') : (customer?.discountType || ''));
    const discountValue = discountType ? (isOwner ? num(data.discountValue) : num(customer?.discountValue)) : 0;
    const discount = discountAmountFor({ type: discountType, value: discountValue }, invoiceAmount);
    const discountText = discountLabel({ type: discountType, value: discountValue });
    const cap = settings.enabled ? maxRedeemable({ walletBalance, invoiceAmount: round2(invoiceAmount - discount), settings }) : 0;
    const walletRedeem = round2(num(data.walletRedeem));

    const walletContainer = form.querySelector('[data-quickbilling-wallet]');
    if (walletContainer && changedName !== 'walletRedeem') {
        const current = walletContainer.querySelector('[name="walletRedeem"]');
        const typed = current && current.type !== 'hidden' ? current.value : data.walletRedeem;
        walletContainer.innerHTML = renderWalletBlock({ walletBalance, cap, settingsEnabled: settings.enabled });
        const next = walletContainer.querySelector('[name="walletRedeem"]');
        if (next && next.type !== 'hidden') next.value = String(typed || '');
    }

    const summaryContainer = form.querySelector('[data-quickbilling-summary]');
    if (summaryContainer) {
        summaryContainer.innerHTML = renderPaymentSummary({
            invoiceAmount,
            walletRedeem,
            walletBalance,
            cap,
            discount,
            discountText,
        });
    }

    const selectedContainer = form.querySelector('[data-quickbilling-selected-services]');
    if (selectedContainer) selectedContainer.innerHTML = renderSelectedServices(lineItems, catalog, {
        staffName: data.staffName,
        discount,
    });

    sanitizeDOM(form);
    refreshIcons(form);

    // Snapshot the in-progress bill so a full app re-render (any store change)
    // rebuilds this page with the entered values intact instead of wiping them.
    saveDraft('quickBilling', { ...data, selectedServices: JSON.stringify(lineItems) });
}

/** Live service-search dropdown inside the quick-billing form. */
function updateQuickBillingServiceSuggestions(el) {
    const form = el.closest('form');
    const container = form && form.querySelector('[data-quickbilling-service-suggestions]');
    if (!container) return;

    const value = (el.value || '').trim();
    if (value.length === 0) {
        container.innerHTML = '';
        return;
    }

    const catalog = scopedBySalon(store.getState().servicesList, store.getState().currentSalonId)
        .filter((s) => s.active !== false);
    const q = value.toLowerCase();
    const matches = catalog
        .filter((s) => (s.name || '').toLowerCase().includes(q) || (s.category || '').toLowerCase().includes(q))
        .slice(0, 8);

    container.innerHTML = renderQuickBillingServiceSuggestions(matches);
    sanitizeDOM(container);
    refreshIcons(container);
}

function updateCustomerSuggestions(el) {
    const form = el.closest('form');
    const container = form && form.querySelector('[data-customer-suggestions]');
    if (!container) return;

    const value = (el.value || '').trim();
    if (value.length === 0) {
        container.innerHTML = '';
        return;
    }

    const customers = customersRepository.listCustomers();
    const q = value.toLowerCase();
    const matches = customers.filter((c) =>
        (c.name || '').toLowerCase().includes(q)
        || (c.phone || '').toLowerCase().includes(q),
    );

    const hidden = form.querySelector('[name="customerId"]');
    const selectedId = hidden ? hidden.value : '';
    if (selectedId) {
        const picked = customers.find((c) => c.id === selectedId);
        if (picked && (picked.name || '').trim().toLowerCase() === q) {
            container.innerHTML = '';
            return;
        }
    }

    const exactName = customers.some((c) => (c.name || '').trim().toLowerCase() === q);
    container.innerHTML = renderCustomerSuggestions(matches, value, { exactName, selectedId });
    refreshIcons(container);
}

const actions = {
    async 'role'(el) {
        const role = el.dataset.role;
        if (role === 'super_admin') store.setState({ accountRole: 'super_admin' });
        if (role === 'guest') store.setState({ accountRole: 'salon_owner' });
        setRole(role);
        syncSalonScope();
    },

    async 'tab'(el) {
        const tab = el.dataset.tab;
        switchTab(tab);
    },

    async 'staff-tab'(el) {
        store.setState({ staffTab: el.dataset.staffTab === 'attendance' ? 'attendance' : 'roster' });
    },

    async 'attendance-date'(el) {
        store.setState({ attendanceDate: el.value || null });
    },

    async 'attendance-day-prev'() {
        store.setState({ attendanceDate: shiftDate(store.getState().attendanceDate || todayStr(), -1) });
    },

    async 'attendance-day-next'() {
        const today = todayStr();
        const current = store.getState().attendanceDate || today;
        if (current < today) store.setState({ attendanceDate: shiftDate(current, 1) });
    },

    async 'attendance-day-today'() {
        store.setState({ attendanceDate: null });
    },

    /** Mark attendance for a staff member on the active daily date. */
    async 'attendance-mark'(el) {
        openModal('attendance', {
            staffId: el.dataset.staffId,
            staffName: el.dataset.staffName,
            date: store.getState().attendanceDate || todayStr(),
        });
    },

    async 'attendance-month'(el) {
        store.setState({ attendanceHistoryMonth: el.value || null });
    },

    async 'attendance-staff-filter'(el) {
        store.setState({ attendanceHistoryStaffId: el.value || 'all' });
    },

    async 'submit-attendance'(form, event, data) {
        const id = data.id;
        const payload = {
            status: data.status,
            checkIn: data.checkIn || '',
            checkOut: data.checkOut || '',
            notes: data.notes || '',
        };
        if (id) {
            await attendanceRepository.updateAttendance(id, payload);
            showNotification('Attendance updated!');
        } else {
            const staffMember = (store.getState().staffList || []).find((s) => s.id === data.staffId);
            await attendanceRepository.markAttendance({
                staffId: data.staffId,
                staffName: staffMember?.name || '',
                date: data.date,
                ...payload,
            });
            showNotification('Attendance recorded!');
        }
        closeModal();
    },

    async 'modal'(el) {
        openModal(el.dataset.modal);
    },

    async 'open-help-menu'() {
        openModal('help-menu');
    },

    async 'replay-tutorial'(el) {
        closeModal();
        const tour = el.dataset.tour;
        startTutorialSession(tour === 'all' ? [...TUTORIAL_ORDER] : [tour]);
    },

    async 'section-info'(el) {
        showSectionInfo(el.dataset.section);
    },

    async 'close-modal'() {
        closeModal();
    },

    async 'modal-backdrop'(el, event) {
        if (event.target === el) closeModal();
    },

    async 'open-edit'(el) {
        const { type, id } = el.dataset;
        const record = findRecord(type, id);
        if (!record) {
            showNotification('Record not found.', 'error');
            return;
        }
        openModal(type, record);
    },

    async 'request-delete'(el) {
        openDeleteConfirm({
            type: el.dataset.type,
            id: el.dataset.id,
            label: el.dataset.label || '',
        });
    },

    async 'confirm-delete'() {
        const { deleteTarget } = store.getState();
        if (!deleteTarget || !deleteTarget.id) {
            closeModal();
            return;
        }
        const deleter = deleteRecord(deleteTarget);
        if (!deleter) {
            closeModal();
            return;
        }
        if (deleteTarget.type === 'customer') {
            await referralCodesRepository.deactivateCodeFor(deleteTarget.id)
                .catch((err) => console.warn('[referral] Could not retire referral code:', err));
        }
        await deleter();
        const noun = { customer: 'Client', service: 'Service', staff: 'Staff member', appointment: 'Appointment', attendance: 'Attendance record' }[deleteTarget.type] || 'Record';
        showNotification(`${noun} deleted.`);
        closeModal();
    },

    async 'toggle-form-mode'(el) {
        store.setState({ authFormMode: el.dataset.mode === 'signin' ? 'signin' : 'signup' });
    },

    async 'show-forgot-password'() {
        store.setState({ authView: 'forgot', forgotSent: false, resetError: null });
    },

    async 'back-to-login'() {
        store.setState({
            authView: 'default',
            forgotSent: false,
            resetDone: false,
            resetError: null,
            resetOobCode: null,
            resetEmail: '',
        });
        // Drop the one-time reset params from the URL so refreshing or
        // re-sharing it can never re-trigger the (now consumed) reset flow.
        if (window.location.search) {
            window.history.replaceState({}, '', window.location.pathname);
        }
    },

    async 'toggle-password-visibility'(el) {
        const input = el.closest('[data-password-wrapper]')?.querySelector('input');
        if (!input) return;
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        el.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
        el.innerHTML = icon(showing ? 'eye' : 'eye-off', 'w-4 h-4');
        refreshIcons(el);
    },

    async 'salon'(el) {
        const value = el.value;
        if (!value) return;
        const target = (store.getState().salonsList || []).find((s) => s.id === value);
        if (target && !isBranchActive(target)) {
            showNotification('This branch is inactive. Activate it from Branches first.', 'error');
            return;
        }
        store.setState({ currentSalonId: value });
        syncSalonScope();
        authService.setUserSalon(value).catch((err) => console.warn('Salon persist failed:', err));
    },

    async 'customer-search'(el) {
        updateCustomerSuggestions(el);
    },

    /**
     * Live phone lookup for the walk-in bill. Waits for the customer list's
     * first backend snapshot before declaring a number is new — but fast by
     * default: demo mode (and an already-loaded Firebase snapshot) resolves
     * immediately, and the sequence guard makes every keystroke supersede the
     * previous one so an older lookup can never overwrite a newer result.
     */
    async 'quick-billing-phone'(el) {
        const seq = ++qbPhoneLookupSeq;
        try {
            await customersRepository.ensureCustomersLoaded();
        } catch (err) {
            // Offline/unreachable: fall through and resolve against whatever
            // the local list holds — a stale cache is still better than none.
            console.warn('[quick-billing] Customer list sync unavailable:', err);
        }
        if (seq !== qbPhoneLookupSeq) return;
        updateQuickBillingCustomer(el);
    },

    /**
     * Pick a contact from the live phone type-ahead dropdown. Fills the phone
     * field with the record's 10-digit national number, renders the "existing
     * client" card inline in the same page, and clears the dropdown. The write
     * later flows through the same hidden fields + customers repository as the
     * Customers module — no separate contact store.
     */
    async 'quick-billing-select-customer'(el) {
        const form = el.closest('form[data-action="submit-quick-billing"]');
        if (!form) return;
        let customer = customersRepository.getCustomer(el.dataset.id);
        if (!customer && el.dataset.phone) customer = customersRepository.findCustomerByPhone(el.dataset.phone);
        if (!customer) {
            showNotification('That client could not be resolved.', 'error');
            return;
        }

        const phone = normalizePhoneDigits(customer.phone);
        const phoneInput = form.querySelector('[name="customerPhone"]');
        if (phoneInput && phoneInput.value !== phone) phoneInput.value = phone;

        const container = form.querySelector('[data-quickbilling-customer]');
        if (container) {
            container.innerHTML = renderQuickBillingCustomer(customer, { phone });
            sanitizeDOM(container);
            refreshIcons(container);
        }
        const dropdown = form.querySelector('[data-quickbilling-customer-dropdown]');
        if (dropdown) dropdown.innerHTML = '';

        updateQuickBilling(form);
        syncFormValidity(form, 'customerPhone');
    },

    async 'pick-customer'(el) {
        const form = el.closest('form');
        if (!form) return;
        const input = form.querySelector('[name="customerName"]');
        const hidden = form.querySelector('[name="customerId"]');
        if (input) input.value = el.dataset.name || '';
        if (hidden) hidden.value = el.dataset.id || '';
        const container = form.querySelector('[data-customer-suggestions]');
        if (container) container.innerHTML = '';
        saveDraft('appointment', readFormData(form));
        syncAllFormButtons(form);
        if (form.dataset.action === 'submit-quick-billing') updateQuickBilling(form);
    },

    async 'quick-add-customer'(el) {
        const name = (el.dataset.name || '').trim();
        if (!name) return;
        const form = el.closest('form');
        saveDraft('appointment', { ...getDraft('appointment'), customerName: name, customerId: '' });

        let customer = customersRepository.findCustomerByName(name)
            || customersRepository.findCustomerByPhone(name);
        if (customer) {
            showNotification(`Linked existing client "${customer.name}".`);
        } else {
            customer = await customersRepository.addCustomerQuick({ name });
            if (!store.getState().access || store.getState().access.can('referral')) referralService.ensureReferralCode(customer).catch((err) => console.warn('[referral] Code allocation failed:', err));
            showNotification(`New client "${customer.name}" added & linked.`);
        }

        const liveForm = appEl.querySelector('form[data-action="submit-appointment"]') || form;
        const input = liveForm.querySelector('[name="customerName"]');
        const hidden = liveForm.querySelector('[name="customerId"]');
        if (input) input.value = customer.name;
        if (hidden) hidden.value = customer.id || '';
        const container = liveForm.querySelector('[data-customer-suggestions]');
        if (container) container.innerHTML = '';
        saveDraft('appointment', { ...getDraft('appointment'), customerName: customer.name, customerId: customer.id || '' });
        syncAllFormButtons(liveForm);
        if (liveForm.dataset.action === 'submit-quick-billing') updateQuickBilling(liveForm);
    },

    async 'logout'() {
        await authService.signOut();
        syncSalonScope();
        showNotification('Logged out securely');
    },

    async 'google-signin'() {
        showNotification('Google Sign-In is not available. Please use email sign-in.', 'error');
    },

    async 'email-auth'(form) {
        const data = readFormData(form);
        const email = data.email || '';
        const password = data.password || '';
        if (!email || !password) {
            showNotification('Please enter your email and password.', 'error');
            return;
        }
        const mode = store.getState().authFormMode;
        const result = mode === 'signin'
            ? await authService.signInWithEmail(email, password)
            : await authService.signUpWithEmail(email, password);

        if (result.ok) {
            showNotification(`Successfully authenticated as ${email}!`);
        } else {
            showNotification(result.error || 'Authentication failed.', 'error');
        }
    },

    async 'forgot-password'(form) {
        const { email } = readFormData(form);
        const result = await authService.sendPasswordResetEmail(email);
        // Generic confirmation on success — and when enumeration protection
        // is off and the address is unknown — so the UI never reveals
        // whether an account exists for the email.
        if (result.ok || result.code === 'auth/user-not-found') {
            store.setState({ forgotSent: true });
            return;
        }
        // Actionable failures only: none of these disclose account existence.
        const actionable = {
            'auth/invalid-email': 'Enter a valid email address.',
            'auth/missing-email': 'Enter your email address.',
            'auth/too-many-requests': 'Too many attempts. Please wait a few minutes and try again.',
            'auth/network-request-failed': 'Network error. Check your connection and try again.',
            'auth/unauthorized-continue-uri': 'This site is not authorized to send reset links. Please use the production site or contact support.',
            'auth/unavailable': 'Password reset requires Firebase Authentication.',
        };
        showNotification(actionable[result.code] || 'Could not send the reset email. Please try again.', 'error');
    },

    async 'reset-password'(form) {
        const { password } = readFormData(form);
        const { resetOobCode } = store.getState();
        const result = await authService.confirmPasswordReset(resetOobCode, password);
        if (result.ok) {
            store.setState({ resetDone: true, resetOobCode: null });
        } else {
            showNotification(result.error || 'Password reset failed.', 'error');
        }
    },

    async 'redeem'(el) {
        const customer = customersRepository.getCustomer(el.dataset.id);
        if (!customer) {
            showNotification('Client not found.', 'error');
            return;
        }
        openModal('rewards', {
            customerId: customer.id,
            name: customer.name,
            points: Number(customer.rewardPoints) || 0,
        });
    },

    async 'redeem-reward'(el) {
        const id = el.dataset.id;
        const tierPoints = Number(el.dataset.points) || 0;
        const label = el.dataset.label || 'reward';
        try {
            await customersRepository.redeemReward(id, tierPoints);
            showNotification(`Reward redeemed: ${label}!`);
            closeModal();
        } catch (err) {
            showNotification(err.message || 'Redemption failed.', 'error');
        }
    },

    async 'customer-search-list'(el) {
        const query = (el.value || '').trim();
        const state = store.getState();
        let customers = scopedBySalon(state.customersList, state.currentSalonId);
        const q = query.toLowerCase();
        if (q) {
            customers = customers.filter((c) =>
                (c.name || '').toLowerCase().includes(q)
                || (c.phone || '').toLowerCase().includes(q)
                || (c.email || '').toLowerCase().includes(q),
            );
        }
        customers = sortCustomersByCreation(customers);
        const clearBtn = appEl.querySelector('[data-action="clear-customer-search"]');
        if (clearBtn) clearBtn.classList.toggle('hidden', !query);
        const container = appEl.querySelector('[data-customer-list]');
        if (!container) return;
        container.innerHTML = customers.length === 0
            ? emptyState(q ? `No clients found for "${esc(query)}"` : 'No clients registered.')
            : `<div class="space-y-2.5 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0">${customers.map((c) => renderCustomerCard(c)).join('')}</div>`;
        refreshIcons(container);
    },

    async 'clear-customer-search'() {
        const input = appEl.querySelector('[data-action="customer-search-list"]');
        if (input) {
            input.value = '';
            input.focus();
        }
        actions['customer-search-list'](input);
    },

    async 'service-search-list'(el) {
        // Patch the list in place instead of writing to the store: a re-render
        // would move focus out of the input mid-typing.
        const query = (el.value || '').trim();
        const state = store.getState();
        let services = scopedBySalon(state.servicesList, state.currentSalonId);
        const q = query.toLowerCase();
        if (q) {
            services = services.filter((s) =>
                (s.name || '').toLowerCase().includes(q)
                || (s.category || '').toLowerCase().includes(q),
            );
        }
        const clearBtn = appEl.querySelector('[data-action="clear-service-search"]');
        if (clearBtn) clearBtn.classList.toggle('hidden', !query);
        const container = appEl.querySelector('[data-service-list]');
        if (!container) return;
        container.innerHTML = services.length === 0
            ? emptyState(q ? `No services found for "${esc(query)}"` : 'No services in the catalog yet.')
            : renderServiceListBody(services);
        sanitizeDOM(container);
        refreshIcons(container);
    },

    async 'clear-service-search'() {
        const input = appEl.querySelector('[data-action="service-search-list"]');
        if (input) {
            input.value = '';
            input.focus();
        }
        actions['service-search-list'](input);
    },

    async 'dashboard-tab'(el) {
        store.setState({ dashboardTab: el.dataset.period });
    },

    /* -------------------- Subscription & checkout -------------------- */

    async 'select-plan'(el) {
        if (isNativePaymentContext()) return;
        const state = store.getState();
        const planId = el.dataset.plan;
        const plan = (state.plansCatalog || DEFAULT_PLANS)[planId];
        if (!plan || !plan.paid) return;
        store.setState({
            checkout: { planId, billingCycle: state.billingCycle === 'annual' ? 'annual' : 'monthly', method: 'upi', step: 'select', message: '',
                renewalMode: state.subscription?.autoRenew ? 'automatic' : 'manual', idempotencyKey: crypto.randomUUID() },
            activeTab: 'checkout',
            isModalOpen: false,
        });
    },

    async 'billing-cycle'(el) {
        store.setState({ billingCycle: el.dataset.cycle === 'annual' ? 'annual' : 'monthly' });
    },

    async 'checkout-cycle'(el) {
        const c = store.getState().checkout;
        if (!c || c.step === 'processing') return;
        const cycle = el.dataset.cycle === 'annual' ? 'annual' : 'monthly';
        store.setState({ checkout: { ...c, billingCycle: cycle, idempotencyKey: crypto.randomUUID() }, billingCycle: cycle });
    },

    async 'checkout-renewal'(el) {
        const c = store.getState().checkout;
        if (!c || c.step === 'processing') return;
        store.setState({ checkout: { ...c, renewalMode: el.dataset.mode === 'automatic' ? 'automatic' : 'manual', idempotencyKey: crypto.randomUUID() } });
    },

    async 'cancel-auto-renewal'() {
        const sub = store.getState().subscription;
        if (!sub?.gatewaySubscriptionId) return;
        const result = await manageAutomaticRenewal({ subscriptionId: sub.gatewaySubscriptionId, action: 'cancel' });
        showNotification(result.message);
    },

    async 'resume-auto-renewal'() {
        const state = store.getState();
        if (state.renewalBusy || !state.subscription?.gatewaySubscriptionId) return;
        store.setState({ renewalBusy: true });
        try {
            const result = await purchasePlan({ renewalMode: 'automatic', resumeSubscriptionId: state.subscription.gatewaySubscriptionId,
                user: { email: state.currentUser?.email } });
            showNotification(result.message, result.status === 'FAILED' ? 'error' : 'success');
        } finally { store.setState({ renewalBusy: false }); }
    },

    async 'checkout-method'(el) {
        const c = store.getState().checkout;
        if (!c || c.step === 'processing') return;
        store.setState({ checkout: { ...c, method: el.dataset.method } });
    },

    async 'checkout-reset'() {
        const c = store.getState().checkout;
        if (c) store.setState({ checkout: { ...c, step: 'select', message: '', idempotencyKey: c.step === 'CANCELLED' ? crypto.randomUUID() : c.idempotencyKey } });
    },

    async 'confirm-payment'() {
        if (isNativePaymentContext()) return;
        const state = store.getState();
        const c = state.checkout;
        if (!c || c.step === 'processing') return; // guards double-click / duplicate submit
        store.setState({ checkout: { ...c, step: 'processing', message: '' } });
        try {
            if (c.renewalMode === 'automatic' && state.subscription?.autoRenew) {
                const result = await manageAutomaticRenewal({ subscriptionId: state.subscription.gatewaySubscriptionId,
                    action: 'change', planId: c.planId, billingCycle: c.billingCycle, idempotencyKey: c.idempotencyKey });
                store.setState({ checkout: { ...c, step: 'PENDING', message: result.message } });
                return;
            }
            const result = await purchasePlan({
                planId: c.planId,
                billingCycle: c.billingCycle,
                method: c.method,
                renewalMode: c.renewalMode,
                idempotencyKey: c.idempotencyKey,
                salonId: state.currentSalonId || null,
                user: { email: state.currentUser && state.currentUser.email },
            });
            store.setState({ checkout: { ...store.getState().checkout, step: result.status, message: result.message, orderId: result.orderId } });
            if (result.status === 'SUCCESS') showNotification('Subscription activated!');
        } catch (err) {
            const unavailable = err instanceof PaymentsUnavailable;
            store.setState({ checkout: { ...store.getState().checkout, step: unavailable ? 'UNAVAILABLE' : 'FAILED', message: err.message || 'Could not start the payment.' } });
        }
    },

    async 'start-trial'() {
        await subscriptionService.startTrial();
        switchTab('dashboard');
        showNotification('Your 30-day free trial has started.');
    },

    async 'view-receipt'(el) {
        const row = (store.getState().subscriptionPayments || []).find((p) => p.id === el.dataset.id);
        if (row) openModal('receipt', row);
    },

    async 'print-receipt'() {
        window.print();
    },

    async 'admin-sub-tab'(el) {
        store.setState({ adminSubTab: el.dataset.subTab });
    },

    async 'admin-payment-filter'(el) {
        store.setState({ adminPaymentFilter: el.dataset.filter });
    },

    async 'admin-toggle-suspend'(el) {
        const suspended = el.dataset.suspended === 'true';
        await subscriptionService.setSubscriptionSuspended(el.dataset.id, !suspended);
        showNotification(suspended ? 'Subscription reactivated.' : 'Subscription suspended.');
    },

    async 'admin-seed-plans'() {
        for (const id of Object.keys(DEFAULT_PLANS)) await subscriptionService.savePlan(id, {});
        showNotification('Default plans saved.');
    },

    async 'open-plan-editor'(el) {
        openModal('plan-editor', { planId: el.dataset.plan });
    },

    /** "Add Branch": opens the form unless the plan's branch limit is reached. */
    async 'add-branch'() {
        const access = store.getState().access;
        const gate = access ? access.canCreate('branch') : { ok: true };
        if (!gate.ok) {
            showNotification(gate.reason, 'error');
            return;
        }
        openModal('salon');
    },

    async 'toggle-branch'(el) {
        const state = store.getState();
        const list = state.salonsList || [];
        const branch = list.find((s) => s.id === el.dataset.id);
        if (!branch) return;
        const nextActive = !isBranchActive(branch);
        if (!nextActive && activeBranches(list).length <= 1) {
            showNotification('At least one branch must stay active.', 'error');
            return;
        }
        await salonsRepository.setBranchActive(branch.id, nextActive);
        showNotification(`${branch.name} ${nextActive ? 'activated' : 'deactivated'}.`);
        syncSalonScope();
    },

    async 'switch-branch'(el) {
        const branch = (store.getState().salonsList || []).find((s) => s.id === el.dataset.id);
        if (!branch || !isBranchActive(branch)) return;
        store.setState({ currentSalonId: branch.id, activeTab: 'dashboard' });
        syncSalonScope();
        authService.setUserSalon(branch.id).catch((err) => console.warn('Salon persist failed:', err));
        showNotification(`Switched to ${branch.name}`);
    },

    async 'manage-salon'(el) {
        store.setState({
            currentSalonId: el.dataset.id,
            userRole: 'salon_owner',
            activeTab: 'dashboard',
        });
        syncSalonScope();
        showNotification(`Switched to ${el.dataset.name || 'salon'}`);
    },

    async 'submit-customer'(form, event, data) {
        const id = data.id;
        // Discount is configured from the Payment window (see 'collect-payment'
        // below), not this form — editing a client here never touches it.
        const payload = {
            name: data.name,
            phone: toIndianE164(data.phone),
            email: data.email,
            dob: data.dob || '',
        };

        if (id) {
            await customersRepository.updateCustomer(id, payload);
            showNotification('Client updated successfully!');
            closeModal();
            return;
        }

        // Reject an unusable referral code BEFORE the client is created, so a
        // typo never leaves a half-finished registration behind. Self-referral
        // is caught here too (same phone/email as the code's owner).
        const enteredCode = data.referralCode || '';
        if (enteredCode) {
            const precheck = referralService.validateReferralCode(enteredCode, {
                id: null,
                phone: payload.phone,
                email: payload.email,
            });
            if (!precheck.ok) throw new Error(precheck.error);
        }

        const created = await customersRepository.addCustomer(payload);
        showNotification('Client added!');
        closeModal();

        try {
            if (!store.getState().access || store.getState().access.can('referral')) await referralService.ensureReferralCode(created);
        } catch (err) {
            console.warn('[referral] Code allocation failed:', err);
        }

        if (enteredCode) {
            try {
                const { referrer } = await referralService.linkReferral(created, enteredCode);
                showNotification(`Referral linked: referred by ${referrer.name}.`);
            } catch (err) {
                // The client exists; only the referral link failed.
                showNotification(err.message || 'Referral code could not be applied.', 'error');
            }
        }
    },

    async 'submit-service'(form, event, data) {
        const id = data.id;
        const payload = {
            name: data.name,
            category: data.category || '',
            price: parseFloat(data.price) || 0,
            duration: data.duration,
        };
        if (id) {
            await servicesRepository.updateService(id, payload);
            showNotification('Service updated!');
        } else {
            await servicesRepository.addService({ ...payload, active: true });
            showNotification('Service catalog updated!');
        }
        closeModal();
    },

    async 'submit-service-catalogue'(form, event, data) {
        const existingNames = new Set(scopedBySalon(store.getState().servicesList, store.getState().currentSalonId)
            .map((s) => (s.name || '').trim().toLowerCase()));
        const toImport = PREDEFINED_SERVICES.filter((svc, index) =>
            data[`import_${index}`] === 'on' && !existingNames.has(svc.name.trim().toLowerCase()));

        if (toImport.length === 0) {
            showNotification('No services selected.', 'error');
            return;
        }
        for (const svc of toImport) {
            await servicesRepository.addService({
                name: svc.name,
                category: svc.category,
                duration: svc.duration,
                price: svc.price,
                active: true,
            });
        }
        showNotification(`${toImport.length} service${toImport.length === 1 ? '' : 's'} imported from the catalogue.`);
        closeModal();
    },

    async 'toggle-service-active'(el) {
        const id = el.dataset.id;
        const service = (store.getState().servicesList || []).find((s) => s.id === id);
        if (!service) return;
        const nextActive = service.active === false;
        await servicesRepository.updateService(id, { active: nextActive });
        showNotification(nextActive ? 'Service enabled.' : 'Service disabled.');
    },

    async 'submit-staff'(form, event, data) {
        const id = data.id;
        const payload = { name: data.name, role: data.role, phone: toIndianE164(data.phone) };
        if (id) {
            await staffRepository.updateStaff(id, payload);
            showNotification('Staff details updated!');
        } else {
            await staffRepository.addStaff(payload);
            showNotification('Staff member registered successfully!');
        }
        closeModal();
    },

    async 'submit-appointment'(form, event, data) {
        const id = data.id;
        const customer = await resolveAppointmentCustomer(data);
        const selectedLineItems = getAppointmentLineItems(data.selectedServices);
        const catalog = scopedBySalon(store.getState().servicesList, store.getState().currentSalonId);
        for (const line of selectedLineItems.filter((item) => item.custom)) {
            if (!line.name || !Number.isFinite(Number(line.price)) || Number(line.price) < 0) {
                throw new Error('Each Other Service needs a name and an amount of ₹0 or more.');
            }
        }
        // Preserve the existing one-click booking behavior: a currently
        // selected service is accepted even if the Add button was not used.
        if (selectedLineItems.length === 0 && data.serviceName) {
            if (data.serviceName === 'Other Service') {
                const amount = Number(data.otherServiceAmount);
                const name = String(data.otherServiceName || '').trim();
                if (!name || !Number.isFinite(amount) || amount < 0) {
                    throw new Error('Enter an Other Service name and an amount of ₹0 or more.');
                }
                selectedLineItems.push({ id: makeId('appointment_line'), serviceId: '', name, price: amount, duration: '', custom: true });
            } else {
                const service = catalog.find((row) => row.name === data.serviceName);
                if (service) selectedLineItems.push({ id: makeId('appointment_line'), serviceId: service.id || '', name: service.name, price: service.price, duration: service.duration || '', custom: false });
            }
        }
        const selectedServices = selectedLineItems.map((line) => {
            if (line.custom) return {
                lineItemId: line.id,
                serviceId: '',
                name: line.name,
                price: Math.max(0, Number(line.price) || 0),
                duration: line.duration || '',
                custom: true,
            };
            const service = catalog.find((row) => row.id === line.serviceId) || catalog.find((row) => row.name === line.name);
            return service ? {
                lineItemId: line.id,
                serviceId: service.id || '',
                name: service.name,
                price: Number(service.price) || 0,
                duration: service.duration || '',
                custom: false,
            } : null;
        }).filter(Boolean);
        if (selectedServices.length === 0) throw new Error('Select at least one service.');

        // Normal appointments must fit the salon's configured hours and may
        // never overlap another active appointment for the chosen staff.
        // Walk-ins bypass this branch entirely: their current timestamp is a
        // POS record, not a scheduled slot.
        const durationMinutes = Math.max(1, totalDurationMinutes(selectedServices.filter((line) => !line.custom).map((line) => line.name), catalog));
        const settings = sanitizeBookingSettings(store.getState().bookingSettings);
        const range = rangeForDate(settings.workingHours, data.date);
        const startMinutes = timeToMinutes(data.time);
        if (!range || startMinutes === null || startMinutes + durationMinutes > range.end || startMinutes < range.start) {
            throw new Error('Choose a time within the salon’s working hours for all selected services.');
        }
        const existingAppointments = withDuration(
            scopedBySalon(store.getState().appointmentsList, store.getState().currentSalonId).filter((appointment) => appointment.id !== id),
            catalog,
        );
        if (hasConflict({
            existingAppointments,
            staffName: data.staffName,
            date: data.date,
            startTime: data.time,
            durationMinutes,
        })) {
            throw new Error('This staff member is already booked for the selected time.');
        }
        const payload = {
            customerId: customer.id || '',
            customerName: customer.name,
            serviceName: selectedServices[0]?.name || data.serviceName,
            services: selectedServices,
            amount: round2(selectedServices.reduce((sum, service) => sum + service.price, 0)),
            staffName: data.staffName,
            date: data.date,
            time: data.time,
            status: data.status || 'Confirmed',
        };
        if (id) {
            const before = findAppointment(id);
            await appointmentsRepository.updateAppointment(id, payload);
            showNotification('Appointment updated!');
            const merged = { ...(before || {}), ...payload };
            if (payload.status === 'Cancelled' && before && before.status !== 'Cancelled') {
                await runReferralReversal(merged, 'Appointment cancelled');
            } else {
                await runReferralSettlement(merged);
            }
        } else {
            const appointment = await appointmentsRepository.addAppointment(payload);
            markAppointmentAsNew(appointment?.id);
            showNotification('Appointment booked successfully!');
        }
        closeModal();
    },

    async 'add-appointment-service'(el) {
        const form = el.closest('form[data-action="submit-appointment"]');
        const picker = form?.querySelector('[name="serviceName"]');
        const selected = form?.querySelector('[name="selectedServices"]');
        if (!form || !picker || !selected || !picker.value) return;
        const lineItems = getAppointmentLineItems(selected.value);
        if (picker.value === 'Other Service') {
            const name = String(form.querySelector('[name="otherServiceName"]')?.value || '').trim();
            const amount = Number(form.querySelector('[name="otherServiceAmount"]')?.value);
            if (!name) throw new Error('Enter a name or description for the other service.');
            if (!Number.isFinite(amount) || amount < 0) throw new Error('Other service amount must be ₹0 or more.');
            lineItems.push({ id: makeId('appointment_line'), serviceId: '', name, price: amount, duration: '', custom: true });
        } else {
            const service = scopedBySalon(store.getState().servicesList, store.getState().currentSalonId)
                .find((row) => row.name === picker.value);
            if (!service) throw new Error('Choose a valid service.');
            lineItems.push({ id: makeId('appointment_line'), serviceId: service.id || '', name: service.name, price: service.price, duration: service.duration || '', custom: false });
        }
        selected.value = JSON.stringify(lineItems);
        // Reset before saving the editor draft. The subsequent modal render
        // therefore starts with an empty picker while preserving the hidden
        // line-item list above.
        picker.value = '';
        picker.selectedIndex = 0;
        const otherName = form.querySelector('[name="otherServiceName"]');
        const otherAmount = form.querySelector('[name="otherServiceAmount"]');
        if (otherName) otherName.value = '';
        if (otherAmount) otherAmount.value = '';
        const other = form.querySelector('[data-other-appointment-service]');
        if (other) other.classList.add('hidden');
        saveDraft('appointment', readFormData(form));
        store.setState({});
    },

    async 'remove-appointment-service'(el) {
        const form = el.closest('form[data-action="submit-appointment"]');
        const selected = form?.querySelector('[name="selectedServices"]');
        if (!form || !selected) return;
        const lineItems = getAppointmentLineItems(selected.value);
        const lineId = String(el.dataset.lineId || '');
        selected.value = JSON.stringify(lineItems.filter((line) => line.id !== lineId));
        const picker = form.querySelector('[name="serviceName"]');
        if (picker) picker.value = '';
        saveDraft('appointment', readFormData(form));
        store.setState({});
    },

    async 'appointment-service-picker'(el) {
        const form = el.closest('form[data-action="submit-appointment"]');
        const other = form?.querySelector('[data-other-appointment-service]');
        if (other) other.classList.toggle('hidden', el.value !== 'Other Service');
        if (form) saveDraft('appointment', readFormData(form));
    },

    async 'edit-appointment-line-service'(el) {
        const form = el.closest('form[data-action="submit-appointment"]');
        const selected = form?.querySelector('[name="selectedServices"]');
        if (!form || !selected) return;
        const lineItems = getAppointmentLineItems(selected.value);
        const line = lineItems.find((item) => item.id === String(el.dataset.lineId || ''));
        if (!line) return;
        if (el.value === 'Other Service') {
            line.custom = true;
            line.serviceId = '';
            line.name = line.name || 'Other Service';
            line.price = Math.max(0, Number(line.price) || 0);
            line.duration = '';
        } else {
            const service = scopedBySalon(store.getState().servicesList, store.getState().currentSalonId)
                .find((row) => row.name === el.value);
            if (!service) return;
            line.custom = false;
            line.serviceId = service.id || '';
            line.name = service.name;
            line.price = Number(service.price) || 0;
            line.duration = service.duration || '';
        }
        selected.value = JSON.stringify(lineItems);
        saveDraft('appointment', readFormData(form));
        store.setState({});
    },

    async 'edit-appointment-custom-name'(el) {
        const form = el.closest('form[data-action="submit-appointment"]');
        const selected = form?.querySelector('[name="selectedServices"]');
        const line = getAppointmentLineItems(selected?.value).find((item) => item.id === String(el.dataset.lineId || ''));
        if (!form || !selected || !line) return;
        line.name = String(el.value || '').trim();
        selected.value = JSON.stringify(getAppointmentLineItems(selected.value).map((item) => item.id === line.id ? line : item));
        saveDraft('appointment', readFormData(form));
        store.setState({});
    },

    async 'edit-appointment-custom-amount'(el) {
        const form = el.closest('form[data-action="submit-appointment"]');
        const selected = form?.querySelector('[name="selectedServices"]');
        const lineItems = getAppointmentLineItems(selected?.value);
        const line = lineItems.find((item) => item.id === String(el.dataset.lineId || ''));
        if (!form || !selected || !line) return;
        // Preserve the raw value for submit-time validation rather than
        // silently retaining an old amount after an invalid edit.
        line.price = el.value;
        selected.value = JSON.stringify(lineItems);
        saveDraft('appointment', readFormData(form));
        store.setState({});
    },

    async 'quick-billing-service-search'(el) {
        updateQuickBillingServiceSuggestions(el);
    },

    async 'quick-billing-add-service'(el) {
        const form = el.closest('form[data-action="submit-quick-billing"]');
        const name = (el.dataset.name || '').trim();
        if (!form || !name) return;
        const lineItems = getQuickBillingLineItems(form);
        lineItems.push({
            id: makeId('bill_line'),
            serviceId: String(el.dataset.serviceId || ''),
            name,
        });
        form.querySelector('[name="selectedServices"]').value = JSON.stringify(lineItems);

        const searchInput = form.querySelector('[data-action="quick-billing-service-search"]');
        if (searchInput) searchInput.value = '';
        const suggestions = form.querySelector('[data-quickbilling-service-suggestions]');
        if (suggestions) suggestions.innerHTML = '';

        updateQuickBilling(form);
        syncFormValidity(form, 'selectedServices');
    },

    async 'quick-billing-remove-service'(el) {
        const form = el.closest('form[data-action="submit-quick-billing"]');
        if (!form) return;
        const lineId = String(el.dataset.lineId || '');
        const lineItems = getQuickBillingLineItems(form);
        const index = lineItems.findIndex((line) => line.id === lineId);
        if (index >= 0) lineItems.splice(index, 1);
        form.querySelector('[name="selectedServices"]').value = JSON.stringify(lineItems);
        updateQuickBilling(form);
        syncFormValidity(form, 'selectedServices');
    },

    async 'quick-billing-edit-service'(el) {
        const form = el.closest('form[data-action="submit-quick-billing"]');
        if (!form) return;
        const serviceId = String(el.value || '');
        const service = scopedBySalon(store.getState().servicesList, store.getState().currentSalonId)
            .find((row) => String(row.id || '') === serviceId);
        const lineItems = getQuickBillingLineItems(form);
        const line = lineItems.find((item) => item.id === String(el.dataset.lineId || ''));
        if (!service || !line) return;
        line.serviceId = service.id || '';
        line.name = service.name;
        form.querySelector('[name="selectedServices"]').value = JSON.stringify(lineItems);
        updateQuickBilling(form);
    },

    async 'submit-quick-billing'(form, event, data) {
        const state = store.getState();
        const salonId = state.currentSalonId;
        if (!salonId) throw new Error('No salon selected.');

        const customer = await resolveAppointmentCustomer(data);

        const lineItems = getQuickBillingLineItems(form);
        const catalog = scopedBySalon(state.servicesList, salonId);
        const selectedServices = lineItems.map((line) => {
            const service = catalog.find((row) => row.id === line.serviceId) || catalog.find((row) => row.name === line.name);
            return service ? {
                lineItemId: line.id,
                serviceId: service.id || '',
                name: service.name,
                price: Number(service.price) || 0,
                duration: service.duration || '',
            } : null;
        }).filter(Boolean);
        if (selectedServices.length === 0) throw new Error('Select at least one service.');

        const gross = round2(selectedServices.reduce((sum, svc) => sum + svc.price, 0));

        // Owner edits the discount right here in this form; staff read the
        // client's saved discount. Same rules as 'collect-payment'.
        const isOwner = state.userRole === 'salon_owner';
        const discountType = state.access && !state.access.can('customerDiscounts') ? '' : (isOwner ? (data.discountType || '') : (customer?.discountType || ''));
        const discountValue = discountType ? (isOwner ? num(data.discountValue) : num(customer?.discountValue)) : 0;
        const discount = discountAmountFor({ type: discountType, value: discountValue }, gross);

        if (customer && ((customer.discountType || '') !== discountType || num(customer.discountValue) !== discountValue)) {
            await customersRepository.updateCustomer(customer.id, { discountType: discountType || '', discountValue: discountValue || 0 }).catch((err) => {
                console.warn('[discount] Could not save client discount:', err);
            });
        }

        // Walk-in date/time are automatic (the salon's current time).
        const salonNow = currentSalonDateTime(currentSalon());
        const date = salonNow.date;
        const time = salonNow.time;

        const staffName = data.staffName || ANY_STAFF;
        const appointment = await appointmentsRepository.addAppointment({
            customerId: customer.id || '',
            customerName: customer.name,
            customerPhone: customer.phone || '',
            serviceName: selectedServices[0].name,
            services: selectedServices,
            staffName,
            date,
            time,
            status: 'Completed',
            source: 'walkin',
            amount: gross,
            notes: 'Quick billing / walk-in',
        }, { skipValidation: true });

        // Wallet leg runs first because it must be atomic (see 'collect-payment').
        const walletBalance = referralService.walletBalanceOf(customer);
        const settings = sanitizeSettings(state.referralSettings);
        const requested = state.access && !state.access.can('referral') ? 0 : round2(num(data.walletRedeem));
        let redemption = { redeemed: 0, balanceBefore: walletBalance, balanceAfter: walletBalance };
        if (requested > 0) {
            if (!customer) throw new Error('A client record is required to redeem referral rewards.');
            redemption = await referralService.redeem({
                customer,
                appointment,
                invoiceAmount: round2(gross - discount),
                requestedAmount: requested,
            });
        }

        const split = splitPayment({ invoiceAmount: gross, walletRedeemed: redemption.redeemed, discount });
        const patch = {
            invoiceNo: invoiceNoFor(appointment.id),
            invoiceAmount: split.invoiceAmount,
            amount: split.invoiceAmount,
            discountType,
            discountValue,
            discountApplied: split.discount,
            walletRedeemed: split.walletRedeemed,
            walletBalanceBefore: redemption.balanceBefore,
            walletBalanceAfter: redemption.balanceAfter,
            amountDue: split.amountDue,
            paid: true,
            paymentMethod: split.amountDue > 0
                ? (data.paymentMethod || 'cash')
                : (split.walletRedeemed > 0 ? 'wallet' : 'discount'),
            paymentReference: data.paymentReference || '',
            paidAt: new Date().toISOString(),
            refunded: false,
            status: 'Completed',
        };

        await appointmentsRepository.updateAppointment(appointment.id, patch);
        showNotification(split.walletRedeemed > 0
            ? `Walk-in billed: ${formatCurrency(split.walletRedeemed)} wallet + ${formatCurrency(split.amountDue)}.`
            : `Walk-in billed: ${formatCurrency(split.amountDue)} received.`);

        // Completed + paid satisfies the referral qualifying trigger.
        const appointmentForSettlement = { ...appointment, ...patch };
        const settlementResult = await runReferralSettlement(appointmentForSettlement);
        if (settlementResult && settlementResult.credited) {
            await new Promise((resolve) => setTimeout(resolve, 150));
        }

        markAppointmentAsNew(appointment.id);
        clearDraft('quickBilling');
        // The receipt is part of the Quick Billing page/view (never a popup).
        store.setState({ quickBillingReceipt: appointmentForSettlement, activeTab: 'quickBilling' });
    },

    async 'update-appointment-status'(el) {
        const id = el.dataset.id;
        const status = el.dataset.status;
        if (!id || !status) return;
        const validStatuses = ['Confirmed', 'In Progress', 'Completed'];
        if (!validStatuses.includes(status)) {
            showNotification('Invalid status.', 'error');
            return;
        }
        const appointment = findAppointment(id);
        await appointmentsRepository.updateAppointment(id, { status });
        showNotification(`Appointment marked as ${status}!`);
        if (appointment) {
            await runReferralSettlement({ ...appointment, status });
        }
    },

    /* ---------------- Appointment filters ---------------- */

    async 'appointment-filter'(el) {
        const field = el.dataset.field;
        if (!field || !(field in DEFAULT_APPOINTMENT_FILTERS)) return;
        const current = { ...DEFAULT_APPOINTMENT_FILTERS, ...(store.getState().appointmentFilters || {}) };
        store.setState({ appointmentFilters: { ...current, [field]: el.value } });
    },

    async 'appointment-search'(el) {
        // Patch the list in place instead of writing to the store: a re-render
        // would move focus out of the input mid-typing.
        setAppointmentSearch(el.value);
        const state = store.getState();
        const appointments = scopedBySalon(state.appointmentsList, state.currentSalonId);
        const filters = { ...DEFAULT_APPOINTMENT_FILTERS, ...(state.appointmentFilters || {}) };
        const filtered = filterAppointments(appointments, { ...filters, query: el.value });
        const container = appEl.querySelector('[data-appointment-list]');
        if (container) {
            container.innerHTML = renderAppointmentListBody(filtered, appointments.length);
            sanitizeDOM(container);
            refreshIcons(container);
        }
        const footer = appEl.querySelector('[data-appointment-filter-footer]');
        if (footer) {
            footer.innerHTML = filterFooter(activeFilterCount(filters, el.value));
            sanitizeDOM(footer);
            refreshIcons(footer);
        }
    },

    async 'clear-appointment-filters'() {
        setAppointmentSearch('');
        store.setState({ appointmentFilters: { ...DEFAULT_APPOINTMENT_FILTERS } });
    },

    async 'open-payment'(el) {
        const id = el.dataset.id;
        if (!id) return;
        const appt = findAppointment(id);
        if (!appt) {
            showNotification('Appointment not found.', 'error');
            return;
        }
        openModal('payment', appt);
    },

    /* ---------------- Referral programme ---------------- */

    async 'referral-tab'(el) {
        store.setState({ referralTab: el.dataset.referralTab === 'settings' ? 'settings' : 'list' });
    },

    async 'referral-filter'(el) {
        store.setState({ referralStatusFilter: el.dataset.status || 'all' });
    },

    async 'referral-search'(el) {
        // Patch the list in place instead of writing to the store: a re-render
        // would move focus out of the input mid-typing.
        setReferralSearch(el.value);
        const state = store.getState();
        const rows = filterReferrals(referralRows(state), {
            status: state.referralStatusFilter || 'all',
            query: el.value,
        });
        const container = appEl.querySelector('[data-referral-list]');
        if (!container) return;
        container.innerHTML = renderReferralListBody(rows);
        sanitizeDOM(container);
        refreshIcons(container);
    },

    async 'submit-referral-settings'(form, event, data) {
        await referralSettingsRepository.saveSettings({
            enabled: data.enabled === 'on' || data.enabled === true,
            rewardType: data.rewardType,
            rewardValue: Number(data.rewardValue),
            maxRewardAmount: Number(data.maxRewardAmount || 0),
            minInvoiceAmount: Number(data.minInvoiceAmount),
            rewardTrigger: data.rewardTrigger,
            expiryDays: Number(data.expiryDays),
            maxRedemptionPercent: Number(data.maxRedemptionPercent),
        });
        showNotification('Referral settings saved.');
    },

    async 'customer-profile'(el) {
        const customer = customersRepository.getCustomer(el.dataset.id);
        if (!customer) {
            showNotification('Client not found.', 'error');
            return;
        }
        // Make sure the client actually owns a code before the profile shows it.
        if (!store.getState().access || store.getState().access.can('referral')) referralService.ensureReferralCode(customer).catch((err) => console.warn('[referral] Code allocation failed:', err));
        openModal('customer-profile', { id: customer.id });
    },

    async 'generate-referral-code'(el) {
        const customer = customersRepository.getCustomer(el.dataset.id);
        if (!customer) return;
        const code = await referralService.ensureReferralCode(customer);
        showNotification(code ? `Referral code ${code} generated.` : 'Could not generate a code.', code ? 'success' : 'error');
    },

    async 'copy-referral-code'(el) {
        const code = el.dataset.code || '';
        if (!code) return;
        try {
            await navigator.clipboard.writeText(code);
            showNotification(`Referral code ${code} copied.`);
        } catch (err) {
            // Clipboard access can be denied (permissions, insecure context).
            showNotification(`Referral code: ${code}`);
        }
    },

    async 'redeem-referral-balance'(el) {
        const state = store.getState();
        const customerId = el.dataset.id;
        // The action is only valid from this customer's open profile; never
        // trust a DOM id to select a different client's wallet.
        if (state.modalType !== 'customer-profile' || state.modalRecord?.id !== customerId) {
            showNotification('Open the client profile to redeem its referral balance.', 'error');
            return;
        }
        const customer = customersRepository.getCustomer(customerId);
        if (!customer || referralService.walletBalanceOf(customer) <= 0) {
            showNotification('No referral balance is available for this client.', 'error');
            return;
        }
        if (!sanitizeSettings(state.referralSettings).enabled) {
            showNotification('The referral programme is currently disabled.', 'error');
            return;
        }
        openModal('referral-redemption', { customerId });
    },

    async 'redeem-referral-balance-on-appointment'(el) {
        const state = store.getState();
        const { customerId, appointmentId } = el.dataset;
        if (state.modalType !== 'referral-redemption' || state.modalRecord?.customerId !== customerId) {
            showNotification('Invalid referral redemption request.', 'error');
            return;
        }
        const customer = customersRepository.getCustomer(customerId);
        const appointment = findAppointment(appointmentId);
        if (!customer || referralService.walletBalanceOf(customer) <= 0
            || !appointment || appointment.customerId !== customer.id
            || appointment.paid === true || appointment.status === 'Cancelled') {
            showNotification('This referral balance cannot be redeemed against that appointment.', 'error');
            return;
        }
        // Payment remains the sole place that redeems referral funds: it
        // applies the configured cap and runs referralService.redeem atomically.
        openModal('payment', { ...appointment, returnToCustomerProfileId: customer.id });
    },

    async 'wallet-use-max'(el) {
        const form = el.closest('form');
        const input = form && form.querySelector('[name="walletRedeem"]');
        if (!input) return;
        input.value = el.dataset.amount || '0';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    },

    /* ---------------- Public booking link ---------------- */

    async 'copy-booking-link'(el) {
        const link = el.dataset.link || '';
        if (!link) return;
        try {
            await navigator.clipboard.writeText(link);
            showNotification('Booking link copied.');
        } catch (err) {
            showNotification(`Booking link: ${link}`);
        }
    },

    /**
     * WhatsApp share of the booking link, gated on the salon's booking
     * settings being complete AND persisted: re-verified from the Firestore
     * server on every click, so a broken link is never sent.
     */
    async 'share-booking-whatsapp'(el) {
        const shareUrl = el.dataset.shareUrl || '';
        if (!shareUrl.startsWith('https://wa.me/')) return;
        // Open the tab now, inside the click gesture, so popup blockers allow
        // it; it is only pointed at WhatsApp once the re-check passes.
        const win = window.open('', '_blank');
        let issues;
        try {
            issues = await bookingLinkReadinessIssues(el.closest('form'));
        } catch (err) {
            console.warn('[booking] Could not verify booking settings:', err);
            issues = [{ code: 'unverified', message: 'Could not confirm your saved booking settings with the server. Check your connection and try again.', fix: '' }];
        }
        if (issues.length) {
            if (win) win.close();
            showBookingReadinessIssues(issues);
            return;
        }
        showBookingReadinessIssues([]);
        if (win) {
            win.opener = null;
            win.location.href = shareUrl;
        } else {
            window.open(shareUrl, '_blank', 'noopener,noreferrer');
        }
    },

    async 'booking-fix'(el) {
        const fix = el.dataset.fix;
        if (fix === 'services' || fix === 'staff') {
            closeModal();
            switchTab(fix);
            return;
        }
        const field = appEl.querySelector('form[data-action="submit-booking-settings"] [name="enabled"]');
        if (field) {
            field.scrollIntoView({ behavior: 'smooth', block: 'center' });
            field.focus({ preventScroll: true });
        }
    },

    async 'toggle-booking-qr'() {
        const container = appEl.querySelector('#booking-link-qr');
        if (!container) return;
        const hidden = container.classList.contains('hidden');
        if (!hidden) {
            container.classList.add('hidden');
            return;
        }
        if (!container.dataset.rendered) {
            const link = bookingLinkFor(store.getState().currentSalonId);
            try {
                if (!window.QRCode) throw new Error('QR generator unavailable.');
                container.innerHTML = window.QRCode.toSVG(link, { size: 220 });
                container.dataset.rendered = '1';
            } catch (err) {
                console.warn('[booking] QR generation failed:', err);
                showNotification('Could not generate a QR code for this link.', 'error');
                return;
            }
        }
        container.classList.remove('hidden');
    },

    async 'toggle-day-closed'(el) {
        const day = el.dataset.day;
        const row = el.closest('.flex.items-center.gap-2');
        if (!row) return;
        row.querySelectorAll(`[name="start_${day}"], [name="end_${day}"]`).forEach((input) => {
            input.disabled = el.checked;
        });
    },

    async 'submit-booking-settings'(form, event, data) {
        await bookingSettingsRepository.saveSettings(bookingSettingsPatchFromForm(data));
        await bookingSettingsRepository.syncPublicCatalog(
            scopedBySalon(store.getState().servicesList, store.getState().currentSalonId),
            scopedBySalon(store.getState().staffList, store.getState().currentSalonId),
        );
        showNotification('Booking link settings saved.');
    },

    async 'collect-payment'(form, event, data) {
        const state = store.getState();
        const returnToCustomerProfileId = store.getState().modalRecord?.returnToCustomerProfileId || '';
        const appointment = findAppointment(data.id);
        if (!appointment) throw new Error('Appointment not found.');
        if (appointment.paid === true) throw new Error('This invoice has already been settled.');
        if (appointment.status === 'Cancelled') throw new Error('A cancelled appointment cannot be billed.');

        const invoiceAmount = round2(num(data.invoiceAmount));
        const requested = state.access && !state.access.can('referral') ? 0 : round2(num(data.walletRedeem));
        const customer = customersRepository.getCustomer(appointment.customerId);
        const balance = referralService.walletBalanceOf(customer);

        // The discount is configured right here in the Payment window (owner-only
        // fields; see payment.js) rather than on the client record's own form —
        // whatever is in the form is this bill's discount, clamped so it can
        // never exceed the invoice amount.
        const isOwner = store.getState().userRole === 'salon_owner';
        const discountType = state.access && !state.access.can('customerDiscounts') ? '' : (isOwner ? (data.discountType || '') : (customer?.discountType || ''));
        const discountValue = discountType ? (isOwner ? num(data.discountValue) : num(customer?.discountValue)) : 0;
        const discount = discountAmountFor({ type: discountType, value: discountValue }, invoiceAmount);

        // The wallet leg runs first because it is the part that must be atomic.
        // If it fails nothing is billed and the error surfaces to the user.
        let redemption = { redeemed: 0, balanceBefore: balance, balanceAfter: balance };
        if (requested > 0) {
            if (!customer) throw new Error('A client record is required to redeem referral rewards.');
            redemption = await referralService.redeem({
                customer,
                appointment,
                invoiceAmount: round2(invoiceAmount - discount),
                requestedAmount: requested,
            });
        }

        // Persist the (possibly edited) discount back onto the client record so
        // it carries forward to their future invoices, same as before it moved
        // into this screen — only the entry point changed.
        if (customer && ((customer.discountType || '') !== discountType || num(customer.discountValue) !== discountValue)) {
            await customersRepository.updateCustomer(customer.id, { discountType, discountValue }).catch((err) => {
                console.warn('[discount] Could not save client discount:', err);
            });
        }

        const split = splitPayment({ invoiceAmount, walletRedeemed: redemption.redeemed, discount });
        const patch = {
            invoiceNo: invoiceNoFor(appointment.id),
            invoiceAmount: split.invoiceAmount,
            // `amount` is what the shared revenue rules read as the booked
            // service amount; once billing has happened the settled invoice
            // total is the authoritative figure for that appointment.
            amount: split.invoiceAmount,
            discountType,
            discountValue,
            discountApplied: split.discount,
            walletRedeemed: split.walletRedeemed,
            walletBalanceBefore: redemption.balanceBefore,
            walletBalanceAfter: redemption.balanceAfter,
            amountDue: split.amountDue,
            paid: true,
            paymentMethod: split.amountDue > 0
                ? (data.paymentMethod || 'cash')
                : (split.walletRedeemed > 0 ? 'wallet' : 'discount'),
            paymentReference: data.paymentReference || '',
            paidAt: new Date().toISOString(),
            refunded: false,
            status: 'Completed',
        };

        await appointmentsRepository.updateAppointment(appointment.id, patch);
        showNotification(split.walletRedeemed > 0
            ? `Payment collected: ${formatCurrency(split.walletRedeemed)} wallet + ${formatCurrency(split.amountDue)}.`
            : `Payment of ${formatCurrency(split.amountDue)} collected.`);

        // Ensure appointment has status='Completed' AND paid=true for settlement.
        // Both conditions are required by the default trigger (invoice_paid).
        // Build the appointment object with all updates for settlement.
        const appointmentForSettlement = { ...appointment, ...patch };
        const settlementResult = await runReferralSettlement(appointmentForSettlement);

        // After settlement completes successfully, give Firestore listeners a moment
        // to fire and update the store. Listeners are scoped per salon and already
        // subscribed, so they will automatically receive Firestore changes to referrals,
        // customers, and wallet transactions. The timeout allows the real-time updates
        // to propagate before the modal closes.
        if (settlementResult && settlementResult.credited) {
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (returnToCustomerProfileId && requested > 0) {
            // Give the already-active realtime listeners a moment to publish
            // the wallet debit and referral allocation before reopening it.
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (returnToCustomerProfileId) {
            // The wallet/customer/referral listeners update this profile as
            // the atomic redemption is committed, including its ledger row.
            openModal('customer-profile', { id: returnToCustomerProfileId });
        } else {
            closeModal();
        }
    },

    async 'refund-invoice'(el) {
        const appointment = findAppointment(el.dataset.id);
        if (!appointment) throw new Error('Appointment not found.');
        if (appointment.paid !== true) throw new Error('This invoice has not been settled.');
        if (appointment.refunded === true) throw new Error('This invoice has already been refunded.');

        await runReferralReversal(appointment, 'Invoice refunded');
        await appointmentsRepository.updateAppointment(appointment.id, {
            paid: false,
            refunded: true,
            refundedAt: new Date().toISOString(),
            refund: round2(num(appointment.invoiceAmount)),
        });
        showNotification('Invoice refunded.');
        // Refunding from the walk-in receipt page refreshes that page in place;
        // refunding from the Payment sheet (modal) still closes it as before.
        const refundState = store.getState();
        if (refundState.isModalOpen) closeModal();
        else if (refundState.activeTab === 'quickBilling') {
            store.setState({ quickBillingReceipt: findAppointment(String(appointment.id)) });
        }
    },

    async 'submit-plan'(form, event, data) {
        const optNum = (v) => (v === '' || v === undefined ? null : Math.max(0, Math.floor(Number(v))));
        const patch = {
            name: data.name || undefined,
            tagline: data.tagline || '',
            priceMonthly: Math.max(0, Math.round(Number(data.priceMonthly) || 0)),
            priceAnnual: Math.max(0, Math.round(Number(data.priceAnnual) || 0)),
            maxStaff: optNum(data.maxStaff),
            maxCustomers: optNum(data.maxCustomers),
            maxBranches: optNum(data.maxBranches),
            features: Object.keys(FEATURES).filter((k) => data[`feature_${k}`] !== undefined),
        };
        await subscriptionService.savePlan(data.planId, patch);
        showNotification('Plan saved.');
        closeModal();
    },

    async 'submit-salon'(form, event, data) {
        const payload = {
            name: data.name,
            ownerEmail: data.email,
            phone: toIndianE164(data.phone),
            address: data.address,
            timezone: data.timezone || 'Asia/Kolkata',
        };
        // Branch form carries working hours; the legacy super-admin form does not.
        if (data.openTime !== undefined) {
            payload.openTime = data.openTime;
            payload.closeTime = data.closeTime;
        }
        if (data.id) {
            await salonsRepository.updateSalon(data.id, payload);
            showNotification('Branch updated.');
        } else {
            await salonsRepository.addSalon(payload);
            showNotification('New salon branch provisioned!');
        }
        closeModal();
        syncSalonScope();
    },
};

const debouncedClientSearch = debounce((el) => {
    const handler = actions['customer-search-list'];
    Promise.resolve(handler(el)).catch((err) => console.warn(err));
}, 200);

const debouncedReferralSearch = debounce((el) => {
    const handler = actions['referral-search'];
    Promise.resolve(handler(el)).catch((err) => console.warn(err));
}, 200);

const debouncedAppointmentSearch = debounce((el) => {
    const handler = actions['appointment-search'];
    Promise.resolve(handler(el)).catch((err) => console.warn(err));
}, 200);

const debouncedServiceSearch = debounce((el) => {
    const handler = actions['service-search-list'];
    Promise.resolve(handler(el)).catch((err) => console.warn(err));
}, 200);

function attachDelegation() {
    if (!appEl) return;

    appEl.addEventListener('click', (event) => {
        const card = event.target.closest('[data-appointment-card]');
        if (card && clearNewAppointment(card.dataset.id)) {
            // Render once to remove the transient marker. It is never stored,
            // so reopening the app cannot mark an older booking as new.
            store.setState({});
        }
        const el = event.target.closest('[data-action]');
        if (!el) return;
        if (el.tagName === 'SELECT') return;
        // Date/month pickers commit via `change`; preventDefault() on their
        // click (below) would block the native picker from opening.
        if (el.tagName === 'INPUT' && (el.type === 'date' || el.type === 'month')) return;
        // Checkbox state is committed by the browser's default click action.
        // Handle the working-hours toggle from `change` below so preventing
        // this delegated click can never revert the checked state.
        if (el.dataset.action === 'toggle-day-closed') return;
        if (el.tagName === 'FORM') return;
        const handler = actions[el.dataset.action];
        if (!handler) return;
        event.preventDefault();
        Promise.resolve(handler(el, event)).catch((err) => {
            console.warn(`Action "${el.dataset.action}" failed:`, err);
            showNotification(err.message || 'Something went wrong.', 'error');
        });
    });

    appEl.addEventListener('change', (event) => {
        const el = event.target.closest('[data-action]');
        if (!el || !['salon', 'appointment-filter', 'toggle-day-closed', 'attendance-date', 'attendance-month', 'attendance-staff-filter', 'quick-billing-edit-service', 'appointment-service-picker', 'edit-appointment-line-service', 'edit-appointment-custom-name', 'edit-appointment-custom-amount'].includes(el.dataset.action)) return;
        const handler = actions[el.dataset.action];
        if (!handler) return;
        Promise.resolve(handler(el, event)).catch((err) => console.warn(err));
    });

    appEl.addEventListener('input', (event) => {
        // Digits-only, 10-digit cap on every phone field, enforced as the
        // user types (not just at submit).
        sanitizePhoneInputLive(event.target);
        const picker = event.target.closest('[data-action="customer-search"]');
        if (picker) {
            const handler = actions['customer-search'];
            Promise.resolve(handler(picker, event)).catch((err) => console.warn(err));
        }
        const quickBillingServiceSearch = event.target.closest('[data-action="quick-billing-service-search"]');
        if (quickBillingServiceSearch) {
            const handler = actions['quick-billing-service-search'];
            Promise.resolve(handler(quickBillingServiceSearch, event)).catch((err) => console.warn(err));
        }
        const qbPhone = event.target.closest('[data-action="quick-billing-phone"]');
        if (qbPhone) {
            const handler = actions['quick-billing-phone'];
            Promise.resolve(handler(qbPhone, event)).catch((err) => console.warn(err));
        }
        const listSearch = event.target.closest('[data-action="customer-search-list"]');
        if (listSearch) {
            debouncedClientSearch(listSearch);
        }
        const serviceListSearch = event.target.closest('[data-action="service-search-list"]');
        if (serviceListSearch) {
            debouncedServiceSearch(serviceListSearch);
        }
        const referralSearch = event.target.closest('[data-action="referral-search"]');
        if (referralSearch) {
            debouncedReferralSearch(referralSearch);
        }
        const appointmentSearch = event.target.closest('[data-action="appointment-search"]');
        if (appointmentSearch) {
            debouncedAppointmentSearch(appointmentSearch);
        }
        handleFormInput(event);
    });
    appEl.addEventListener('change', handleFormInput);

    appEl.addEventListener('submit', (event) => {
        const form = event.target.closest('form[data-action]');
        if (!form) return;
        event.preventDefault();
        const handler = actions[form.dataset.action];
        if (!handler) return;

        const data = readFormData(form);
        const errors = validateForm(form.dataset.action, data, formContext(form));
        if (Object.keys(errors).length > 0) {
            renderFieldErrors(form, errors);
            return;
        }
        clearFieldErrors(form);

        Promise.resolve(handler(form, event, data)).catch((err) => {
            console.warn(`Form "${form.dataset.action}" failed:`, err);
            showNotification(err.message || 'Something went wrong.', 'error');
        });
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && store.getState().isModalOpen) {
            closeModal();
        }
    });
}

/* ------------------------------------------------------------------ */
/* Service worker (PWA offline support)                                */
/* ------------------------------------------------------------------ */

function registerServiceWorker() {
    // The native wrapper always fetches the hosted application live. Keeping a
    // second PWA app-shell cache inside Android System WebView can leave that
    // container behind a Vercel deployment even when Chrome is current.
    // This does not affect browser/PWA users, Firebase persistence, IndexedDB,
    // local storage, or cookies.
    if (isAndroidTwa()) return;

    if ('serviceWorker' in navigator) {
        let controllerChanged = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            // skipWaiting()/clients.claim() makes a newly deployed worker take
            // control immediately. Reload once so its fresh app shell and
            // modules are used together. Firebase and app sessions remain in
            // their existing browser storage; no user data is cleared.
            // Never reload in demo mode: the offline preview keeps its whole
            // session in memory, so a mid-session reload would discard a
            // just-submitted sign-in or an in-progress walk-in bill for no
            // benefit (the network-first SW strategy already serves freshly
            // fetched modules). Signed-out visitors never trigger it either.
            if (!controllerChanged && !isDemoMode() && store.getState().userRole !== 'guest') {
                controllerChanged = true;
                window.location.reload();
            }
        });
        navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
            .then((registration) => registration.update())
            .catch((err) => {
                console.warn('Service worker registration failed:', err);
            });
    }
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

/**
 * Detect a Firebase password-reset link (?mode=resetPassword&oobCode=...)
 * and validate the code up front, so the reset screen opens straight into
 * either the new-password form or a clear expired/invalid message — never a
 * form that's guaranteed to fail on submit.
 */
async function maybeHandlePasswordResetLink() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') !== 'resetPassword' || !params.get('oobCode')) return;

    const result = await authService.verifyPasswordResetCode(params.get('oobCode'));
    store.setState({
        authView: 'reset',
        resetOobCode: result.ok ? params.get('oobCode') : null,
        resetEmail: result.ok ? result.email : '',
        resetError: result.ok ? null : result.error,
    });
}

async function bootstrap() {
    await initFirebase();
    await maybeHandlePasswordResetLink();

    // Scoped repos are safe to "prime" with no salon before auth/salon
    // resolves: with a null id, scopedRepository.subscribe() returns
    // immediately without ever touching Firestore (see scopedRepository.js).
    // The real, salon-scoped listeners are only created later by
    // resolveSalonScope() once a signed-in user AND a resolved salon id are
    // both available.
    customersRepository.initCustomers(null);
    servicesRepository.initServices(null);
    staffRepository.initStaff(null);
    appointmentsRepository.initAppointments(null);

    if (isDemoMode()) {
        seedDemoData();
        // Firestore is never touched in demo mode; initSalons() only marks
        // salonsLoaded so the rest of the app's bootstrap logic behaves the
        // same as the live-Firebase path.
        salonsRepository.initSalons();
        store.setState({ authReady: true });
    } else {
        onAuthStateChanged(async (user) => {
            try {
                await authService.handleAuthStateChanged(user);
                if (!store.getState().authReady) store.setState({ authReady: true });
                // The single place that (re)establishes the salons and
                // rewardTransactions listeners once auth is ready.
                // IMPORTANT: this must be the ONLY call that triggers those
                // subscriptions on a fresh sign-in — resolveSalonScope()'s
                // own scope-key guard (see below) already dedupes repeated
                // calls, but calling salonsRepository.initSalons() /
                // rewardTransactionsRepository.resubscribeTransactions()
                // directly here (in addition to this) previously caused a
                // subscribe -> unsubscribe -> resubscribe churn on the same
                // Firestore watch target within a single tick, right as
                // persistence was still settling. That rapid churn is a
                // known trigger for the Firestore SDK's internal
                // WatchChangeAggregator/TargetState assertion failure
                // ("INTERNAL ASSERTION FAILED: Unexpected state (ID: b815)"),
                // so repository (re)subscription must only ever happen
                // through resolveSalonScope()/syncSalonScope().
                syncSalonScope();
                renderApp();
            } catch (err) {
                console.error('[MAIN] Error in auth state change handler:', err);
                renderApp();
            }
        });
        await authService.restoreSession();
        authService.handleRedirectResult().catch((err) => {
            console.warn('[MAIN] Redirect result handling failed:', err);
        });
    }

    store.subscribe(renderApp);
    store.subscribe(() => resolveSalonScope());
    store.subscribe(() => maybeRunReferralMaintenance());
    store.subscribe(() => maybeSyncPublicCatalog());
    store.subscribe(() => maybeOfferSetupTutorial());
    // Subscription listeners + the central FeatureAccess snapshot (state.access).
    store.subscribe(() => { subscriptionService.syncSubscription(); subscriptionService.refreshAccess(); });
    subscriptionService.syncSubscription();

    attachDelegation();
    renderApp();
    resolveSalonScope();
    registerServiceWorker();
    if (isAndroidTwa()) installAndroidRefresh({ window, document, store, isTourActive });
    installExitGuard({
        hasOpenModal: () => store.getState().isModalOpen || isTourActive(),
        closeModal: () => {
            if (isTourActive()) dismissTour();
            else closeModal();
        },
    });
    window.addEventListener('spacrm:replay-tutorial', (event) => {
        const tourId = event.detail?.tourId;
        if (tourId) startTutorialSession([tourId]);
    });
}

bootstrap();
