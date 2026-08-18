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
import { store } from './core/store.js';
import { switchTab, setRole, openModal, closeModal, openDeleteConfirm } from './core/router.js';
import { validateForm, toIndianE164 } from './core/validate.js';
import { sanitizeDOM, esc, escAttr } from './core/sanitize.js';
import { refreshIcons } from './ui/icons.js';
import showNotification from './ui/notification.js';
import { appHeader, bottomNav, networkBanner, emptyState } from './ui/components.js';
import { saveDraft, getDraft } from './core/draft.js';
import { debounce, scopedBySalon } from './core/utils.js';
import renderLogin from './ui/views/login.js';
import renderDashboard from './ui/views/dashboard.js';
import renderAppointments from './ui/views/appointments.js';
import renderCustomers, { renderCustomerCard } from './ui/views/customers.js';
import renderServices from './ui/views/services.js';
import renderStaff from './ui/views/staff.js';
import renderSuperAdmin from './ui/views/admin.js';
import renderSalonSetup from './ui/views/salonSetup.js';
import renderModalSheet, { renderCustomerSuggestions } from './ui/views/modals.js';

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
        transactionsList: [...rewardTransactionsRepository.seed],
        transactionsLoaded: true,
        transactionsError: null,
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
    rewardTransactionsRepository.resubscribeTransactions();
}

function syncSalonScope() {
    resolveSalonScope();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderOwnerTab(state) {
    switch (state.activeTab) {
        case 'appointments': return renderAppointments(state);
        case 'customers': return renderCustomers(state);
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
    showNotification(`New client "${created.name}" added & linked.`);
    return created;
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
        await deleter();
        const noun = { customer: 'Client', service: 'Service', staff: 'Staff member', appointment: 'Appointment' }[deleteTarget.type] || 'Record';
        showNotification(`${noun} deleted.`);
        closeModal();
    },

    async 'toggle-form-mode'(el) {
        store.setState({ authFormMode: el.dataset.mode === 'signin' ? 'signin' : 'signup' });
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
        const payload = { name: data.name, phone: toIndianE164(data.phone), email: data.email };
        if (id) {
            await customersRepository.updateCustomer(id, payload);
            showNotification('Client updated successfully!');
        } else {
            await customersRepository.addCustomer(payload);
            showNotification('Client added!');
        }
        closeModal();
    },

    async 'submit-service'(form, event, data) {
        const id = data.id;
        const payload = {
            name: data.name,
            price: parseFloat(data.price) || 0,
            duration: data.duration,
        };
        if (id) {
            await servicesRepository.updateService(id, payload);
            showNotification('Service updated!');
        } else {
            await servicesRepository.addService(payload);
            showNotification('Service catalog updated!');
        }
        closeModal();
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
        const payload = {
            customerId: customer.id || '',
            customerName: customer.name,
            serviceName: data.serviceName,
            staffName: data.staffName,
            date: data.date,
            time: data.time,
            status: data.status || 'Confirmed',
        };
        if (id) {
            await appointmentsRepository.updateAppointment(id, payload);
            showNotification('Appointment updated!');
        } else {
            await appointmentsRepository.addAppointment(payload);
            showNotification('Appointment booked successfully!');
        }
        closeModal();
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
        await appointmentsRepository.updateAppointment(id, { status });
        showNotification(`Appointment marked as ${status}!`);
    },

    async 'collect-payment'(el) {
        const id = el.dataset.id;
        if (!id) return;
        const state = store.getState();
        const appt = (state.appointmentsList || []).find((a) => a.id === id);
        if (!appt) return;
        store.setState({ modalType: 'appointment', modalRecord: appt, isModalOpen: true });
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

function attachDelegation() {
    if (!appEl) return;

    appEl.addEventListener('click', (event) => {
        const el = event.target.closest('[data-action]');
        if (!el) return;
        if (el.tagName === 'SELECT') return;
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
        if (!el || el.dataset.action !== 'salon') return;
        const handler = actions[el.dataset.action];
        if (!handler) return;
        Promise.resolve(handler(el, event)).catch((err) => console.warn(err));
    });

    appEl.addEventListener('input', (event) => {
        const picker = event.target.closest('[data-action="customer-search"]');
        if (picker) {
            const handler = actions['customer-search'];
            Promise.resolve(handler(picker, event)).catch((err) => console.warn(err));
        }
        const listSearch = event.target.closest('[data-action="customer-search-list"]');
        if (listSearch) {
            debouncedClientSearch(listSearch);
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
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch((err) => {
            console.warn('Service worker registration failed:', err);
        });
    }
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

async function bootstrap() {
    await initFirebase();

    if (isDemoMode()) {
        seedDemoData();
        store.setState({ authReady: true });
    } else {
        onAuthStateChanged(async (user) => {
            try {
                await authService.handleAuthStateChanged(user);
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

    salonsRepository.initSalons();
    customersRepository.initCustomers(null);
    servicesRepository.initServices(null);
    staffRepository.initStaff(null);
    appointmentsRepository.initAppointments(null);

    store.subscribe(renderApp);
    store.subscribe(() => resolveSalonScope());

    attachDelegation();
    renderApp();
    resolveSalonScope();
    registerServiceWorker();
}

bootstrap();
