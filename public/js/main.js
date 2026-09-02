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
import { validateForm, toIndianE164 } from './core/validate.js';
import { sanitizeDOM, esc, escAttr } from './core/sanitize.js';
import { refreshIcons, icon } from './ui/icons.js';
import showNotification from './ui/notification.js';
import { appHeader, bottomNav, networkBanner, emptyState } from './ui/components.js';
import { saveDraft, getDraft } from './core/draft.js';
import { debounce, scopedBySalon, formatCurrency, sanitizePhoneInputLive } from './core/utils.js';
import renderLogin from './ui/views/login.js';
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
import renderServices from './ui/views/services.js';
import renderStaff from './ui/views/staff.js';
import renderSuperAdmin from './ui/views/admin.js';
import renderSalonSetup from './ui/views/salonSetup.js';
import renderModalSheet, { renderCustomerSuggestions } from './ui/views/modals.js';
import renderReferrals, {
    setReferralSearch,
    referralRows,
    filterReferrals,
    renderReferralListBody,
} from './ui/views/referrals.js';
import { renderPaymentSummary, defaultInvoiceAmount } from './ui/views/payment.js';
import { renderBookingLinkModal, bookingLinkFor } from './ui/views/bookingLink.js';
import { round2, num, sanitizeSettings, maxRedeemable, REWARD_TYPES } from './core/referral.js';
import { splitPayment, invoiceNoFor } from './core/wallet.js';
import { serviceAmountFor } from './core/revenue.js';
import { discountAmountFor, discountLabel } from './core/discount.js';
import * as attendanceRepository from './services/attendanceRepository.js';
import { PREDEFINED_SERVICES } from './core/predefinedServices.js';
import { isAndroidTwa } from './core/platform.js';

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
        target = state.currentSalonId;
        if (!owned.some((s) => s.id === target)) {
            target = owned[0].id;
        }
    }
    if (target !== store.getState().currentSalonId) store.setState({ currentSalonId: target });

    const key = `${state.userRole}|${state.accountRole}|${state.currentUser ? state.currentUser.uid : 'anon'}|${target}|${state.salonsLoaded}`;
    if (key === lastSalonScopeKey) return;
    lastSalonScopeKey = key;

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
    if (!state.currentSalonId) return;
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
        case 'appointments': return renderAppointments(state);
        case 'customers': return renderCustomers(state);
        case 'referrals': return renderReferrals(state);
        case 'services': return renderServices(state);
        case 'staff': return renderStaff(state);
        default: return renderDashboard(state);
    }
}

function buildView(state) {
    if (state.userRole === 'guest') {
        return renderLogin(state);
    }
    if (state.userRole === 'super_admin' && state.accountRole === 'super_admin') {
        return renderSuperAdmin(state);
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

    return `
        ${networkBanner(state)}
        ${appHeader(state)}
        <main class="flex-1 overflow-y-auto p-5 pb-24 no-scrollbar">${viewHtml}</main>
        ${showNav ? bottomNav(state) : ''}
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

function findRecord(type, id) {
    const lists = {
        customer: () => customersRepository.getCustomer(id),
        service: () => (store.getState().servicesList || []).find((r) => r.id === id),
        staff: () => (store.getState().staffList || []).find((r) => r.id === id),
        appointment: () => (store.getState().appointmentsList || []).find((r) => r.id === id),
        attendance: () => (store.getState().attendanceList || []).find((r) => r.id === id),
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
    if (data.customerId) {
        const picked = customersRepository.getCustomer(data.customerId);
        if (picked) return picked;
    }
    const byName = customersRepository.findCustomerByName(data.customerName);
    if (byName) return byName;
    const byPhone = customersRepository.findCustomerByPhone(data.customerPhone);
    if (byPhone) return byPhone;
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
    return { signup: form.querySelector('[name="salonName"]') !== null };
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
    root.querySelectorAll('form[data-action]').forEach((form) => {
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
    const discountConfig = { type: data.discountType || '', value: data.discountValue };
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

    async 'attendance-month'(el) {
        store.setState({ attendanceHistoryMonth: el.value || null });
    },

    async 'attendance-staff-filter'(el) {
        store.setState({ attendanceHistoryStaffId: el.value || 'all' });
    },

    async 'mark-attendance-status'(el) {
        const { staffId, staffName, recordId } = el.dataset;
        const date = store.getState().attendanceDate || new Date().toISOString().slice(0, 10);
        const status = el.value;

        if (!status) {
            if (recordId) await attendanceRepository.deleteAttendance(recordId);
            return;
        }
        try {
            if (recordId) {
                await attendanceRepository.updateAttendance(recordId, { status });
            } else {
                await attendanceRepository.markAttendance({ staffId, staffName, date, status });
            }
            showNotification(`${staffName} marked ${status} for ${date}.`);
        } catch (err) {
            showNotification(err.message || 'Could not save attendance.', 'error');
        }
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
        store.setState({ currentSalonId: value });
        syncSalonScope();
        authService.setUserSalon(value).catch((err) => console.warn('Salon persist failed:', err));
    },

    async 'customer-search'(el) {
        updateCustomerSuggestions(el);
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
            referralService.ensureReferralCode(customer).catch((err) => console.warn('[referral] Code allocation failed:', err));
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
            : `<div class="space-y-2.5">${customers.map((c) => renderCustomerCard(c)).join('')}</div>`;
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

    async 'dashboard-tab'(el) {
        store.setState({ dashboardTab: el.dataset.period });
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
            await referralService.ensureReferralCode(created);
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
        let selectedServiceNames = [];
        try { selectedServiceNames = JSON.parse(data.selectedServices || '[]'); } catch { selectedServiceNames = []; }
        selectedServiceNames = [...new Set([...selectedServiceNames, data.serviceName]
            .map((name) => String(name || '').trim()).filter(Boolean))];
        const catalog = scopedBySalon(store.getState().servicesList, store.getState().currentSalonId);
        const selectedServices = selectedServiceNames.map((name) => {
            const service = catalog.find((row) => row.name === name);
            return service ? { name: service.name, price: Number(service.price) || 0, duration: service.duration || '' } : null;
        }).filter(Boolean);
        const payload = {
            customerId: customer.id || '',
            customerName: customer.name,
            serviceName: selectedServices[0]?.name || data.serviceName,
            services: selectedServices,
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
        let names = [];
        try { names = JSON.parse(selected.value || '[]'); } catch { names = []; }
        selected.value = JSON.stringify([...new Set([...names, picker.value])]);
        picker.value = '';
        saveDraft('appointment', readFormData(form));
        store.setState({});
    },

    async 'remove-appointment-service'(el) {
        const form = el.closest('form[data-action="submit-appointment"]');
        const selected = form?.querySelector('[name="selectedServices"]');
        if (!form || !selected) return;
        let names = [];
        try { names = JSON.parse(selected.value || '[]'); } catch { names = []; }
        names = names.filter((name) => name !== el.dataset.name);
        selected.value = JSON.stringify(names);
        const picker = form.querySelector('[name="serviceName"]');
        if (picker) picker.value = '';
        saveDraft('appointment', readFormData(form));
        store.setState({});
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
        if (appointment) await runReferralSettlement({ ...appointment, status });
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
        referralService.ensureReferralCode(customer).catch((err) => console.warn('[referral] Code allocation failed:', err));
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
        const workingHours = {};
        for (const key of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
            workingHours[key] = {
                closed: data[`closed_${key}`] === 'on' || data[`closed_${key}`] === true,
                start: data[`start_${key}`] || '10:00',
                end: data[`end_${key}`] || '19:00',
            };
        }
        await bookingSettingsRepository.saveSettings({
            enabled: data.enabled === 'on' || data.enabled === true,
            displayName: data.displayName || '',
            slotIntervalMinutes: Number(data.slotIntervalMinutes),
            advanceBookingDays: Number(data.advanceBookingDays),
            minNoticeMinutes: Number(data.minNoticeMinutes),
            workingHours,
        });
        await bookingSettingsRepository.syncPublicCatalog(
            scopedBySalon(store.getState().servicesList, store.getState().currentSalonId),
            scopedBySalon(store.getState().staffList, store.getState().currentSalonId),
        );
        showNotification('Booking link settings saved.');
    },

    async 'collect-payment'(form, event, data) {
        const returnToCustomerProfileId = store.getState().modalRecord?.returnToCustomerProfileId || '';
        const appointment = findAppointment(data.id);
        if (!appointment) throw new Error('Appointment not found.');
        if (appointment.paid === true) throw new Error('This invoice has already been settled.');
        if (appointment.status === 'Cancelled') throw new Error('A cancelled appointment cannot be billed.');

        const invoiceAmount = round2(num(data.invoiceAmount));
        const requested = round2(num(data.walletRedeem));
        const customer = customersRepository.getCustomer(appointment.customerId);
        const balance = referralService.walletBalanceOf(customer);

        // The discount is configured right here in the Payment window (owner-only
        // fields; see payment.js) rather than on the client record's own form —
        // whatever is in the form is this bill's discount, clamped so it can
        // never exceed the invoice amount.
        const isOwner = store.getState().userRole === 'salon_owner';
        const discountType = isOwner ? (data.discountType || '') : (customer?.discountType || '');
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
        closeModal();
    },

    async 'submit-salon'(form, event, data) {
        await salonsRepository.addSalon({
            name: data.name,
            ownerEmail: data.email,
            phone: toIndianE164(data.phone),
            address: data.address,
        });
        showNotification('New salon branch provisioned!');
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
        if (!el || !['salon', 'appointment-filter', 'toggle-day-closed', 'attendance-date', 'attendance-month', 'attendance-staff-filter', 'mark-attendance-status'].includes(el.dataset.action)) return;
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
        const listSearch = event.target.closest('[data-action="customer-search-list"]');
        if (listSearch) {
            debouncedClientSearch(listSearch);
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
        const ctx = { signup: form.querySelector('[name="salonName"]') !== null };
        const errors = validateForm(form.dataset.action, data, ctx);
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
            if (!controllerChanged) {
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

async function bootstrap() {
    await initFirebase();

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

    attachDelegation();
    renderApp();
    resolveSalonScope();
    registerServiceWorker();
}

bootstrap();
