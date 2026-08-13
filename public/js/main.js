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
import { store } from './core/store.js';
import { switchTab, setRole, openModal, closeModal, openDeleteConfirm } from './core/router.js';
import { validateForm, toIndianE164 } from './core/validate.js';
import { sanitizeDOM, esc } from './core/sanitize.js';
import { refreshIcons } from './ui/icons.js';
import showNotification from './ui/notification.js';
import { appHeader, bottomNav, networkBanner } from './ui/components.js';
import { saveDraft, getDraft } from './core/draft.js';
import * as rewards from './core/rewards.js';
import renderLogin from './ui/views/login.js';
import renderOwnerAuth from './ui/views/ownerAuth.js';
import renderDashboard from './ui/views/dashboard.js';
import renderAppointments from './ui/views/appointments.js';
import renderCustomers from './ui/views/customers.js';
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
    });
}

/* ------------------------------------------------------------------ */
/* Repository / salon-scope synchronisation                            */
/* ------------------------------------------------------------------ */

let lastSalonScopeKey = null;

/**
 * Resolve the salon scope for the current auth/role state and keep the
 * repositories pointed at it. Guarded so it only re-subscribes listeners when
 * the scope actually changes (salon list, role, user, or active salon id).
 *
 * Multi-salon security: tenant data lives under `salons/{salonId}/…` and is
 * only ever subscribed when the active salon is provably one of the current
 * user's own salons. Until an owner's salons have loaded (salonsLoaded), no
 * tenant subscription is opened — this prevents a stale/default salon id from
 * ever leaking another salon's data. Super admins never subscribe to tenant
 * data.
 */
function resolveSalonScope() {
    const state = store.getState();
    const isOwner = state.userRole === 'salon_owner';

    // An owner with zero salons must provision their first branch before any
    // tenant-scoped data (Firestore subcollections) can exist. Only evaluate
    // this once the salons list has actually been fetched.
    const needsSalon = isOwner && state.salonsLoaded && state.salonsList.length === 0;
    if (needsSalon !== state.needsSalon) store.setState({ needsSalon });

    // Resolve the active salon id for this role. Owners are pinned to a salon
    // they own; everyone else (guest, super_admin) gets no tenant scope.
    let target = null;
    if (isOwner && state.salonsLoaded && state.salonsList.length > 0) {
        const owned = state.salonsList;
        target = state.currentSalonId;
        if (!owned.some((s) => s.id === target)) {
            target = owned[0].id;
        }
    }
    if (target !== store.getState().currentSalonId) store.setState({ currentSalonId: target });

    // Re-point listeners only when the scope genuinely changed.
    const key = `${state.userRole}|${state.accountRole}|${state.currentUser ? state.currentUser.uid : 'anon'}|${target}|${state.salonsLoaded}`;
    if (key === lastSalonScopeKey) return;
    lastSalonScopeKey = key;

    salonsRepository.resubscribeSalons();
    customersRepository.setSalon(target);
    servicesRepository.setSalon(target);
    staffRepository.setSalon(target);
    appointmentsRepository.setSalon(target);
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
    if (state.userRole === 'guest') return renderLogin();
    if (state.userRole === 'auth_select') return renderOwnerAuth(state);
    if (state.userRole === 'super_admin') return renderSuperAdmin(state);
    if (state.needsSalon) return renderSalonSetup(state);
    return renderOwnerTab(state);
}

function buildShell(state) {
    const viewHtml = buildView(state);

    // Auth / entry screens render standalone.
    if (state.userRole === 'guest' || state.userRole === 'auth_select') {
        return viewHtml;
    }

    // A brand-new owner is on the bootstrap screen — hide the empty tab bar.
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
        console.error('Render error:', err);
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

    // Freshly rendered forms start with empty required fields: reflect their
    // real state so Save/Submit is immediately disabled until valid.
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
        // Trim every text input before validation and before saving.
        data[key] = typeof value === 'string' ? value.trim() : value;
    }
    return data;
}

/** Look up a record by entity type + id from the current store state. */
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

/** Resolve the repository delete call for a confirmed delete target. */
function deleteRecord(target) {
    const deleters = {
        customer: () => customersRepository.deleteCustomer(target.id),
        service: () => servicesRepository.deleteService(target.id),
        staff: () => staffRepository.deleteStaff(target.id),
        appointment: () => appointmentsRepository.deleteAppointment(target.id),
    };
    return deleters[target.type] || null;
}

/**
 * Resolve the client for an appointment being booked/edited.
 * Priority: the picked `customerId` → an exact name match → the typed phone →
 * auto-create a new client (deduped within the salon) so the appointment is
 * always linked to a real customer record.
 */
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

/** Remove stale inline errors and invalid-field styling from a form. */
function clearFieldErrors(form) {
    if (!form) return;
    form.querySelectorAll('.field-error').forEach((el) => el.remove());
    form.querySelectorAll('.field-invalid').forEach((el) => {
        el.classList.remove('field-invalid');
        el.removeAttribute('aria-invalid');
    });
}

/**
 * Render an inline error message beneath each invalid field and focus the
 * first one. Messages are developer-authored constants (never user data) and
 * are inserted with textContent — no unsafe HTML.
 */
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

/** True when the form is an email-auth signup (has a salon name field). */
function formContext(form) {
    return { signup: form.querySelector('[name="salonName"]') !== null };
}

/**
 * Validate a form against its current DOM values and sync the submit button:
 * disabled while any required field is empty/invalid, enabled when the whole
 * form is valid. Optionally clears the error on the field that was just edited.
 * Returns the error map.
 */
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
        // Clear only the field the user just fixed; leave others untouched.
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

/** Sync every data-entry form currently in the DOM (fresh renders included). */
function syncAllFormButtons(root = appEl) {
    root.querySelectorAll('form[data-action]').forEach((form) => {
        syncFormValidity(form);
    });
}

/** Live re-validation as the user types/picks — blocks empty saves at the UI. */
function handleFormInput(event) {
    const form = event.target.closest('form[data-action]');
    if (!form) return;
    syncFormValidity(form, event.target.name);
    // Preserve the in-progress appointment form across reactive re-renders
    // (e.g. a quick-added customer refreshing the list). Written outside the
    // store so saving a draft never triggers a re-render itself.
    if (form.dataset.action === 'submit-appointment') {
        saveDraft('appointment', readFormData(form));
    }
}

/**
 * Fill the appointment picker's suggestion dropdown for a typed query.
 * Rendered imperatively into `[data-customer-suggestions]` so the modal is not
 * re-rendered (and the input keeps focus).
 */
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
    // Already picked this exact client — keep the dropdown closed.
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
        if (role === 'auth_select') store.setState({ authFormMode: el.dataset.mode === 'signin' ? 'signin' : 'signup' });
        setRole(role);
        syncSalonScope();
    },

    async 'tab'(el) {
        switchTab(el.dataset.tab);
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

    /** Open the entity modal pre-filled with the record being edited. */
    async 'open-edit'(el) {
        const { type, id } = el.dataset;
        const record = findRecord(type, id);
        if (!record) {
            showNotification('Record not found.', 'error');
            return;
        }
        openModal(type, record);
    },

    /** Show the destructive-action confirmation sheet for a record. */
    async 'request-delete'(el) {
        openDeleteConfirm({
            type: el.dataset.type,
            id: el.dataset.id,
            label: el.dataset.label || '',
        });
    },

    /** Actually delete the record the user confirmed. */
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
        // Remember the owner's active salon so the same one resumes next time.
        authService.setUserSalon(value).catch((err) => console.warn('Salon persist failed:', err));
    },

    /** Typeahead for the appointment client field — fills the suggestions. */
    async 'customer-search'(el) {
        updateCustomerSuggestions(el);
    },

    /** Select an existing client for the appointment. */
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

    /** Add a brand-new client from the appointment picker and link it. */
    async 'quick-add-customer'(el) {
        const name = (el.dataset.name || '').trim();
        if (!name) return;
        const form = el.closest('form');
        // Persist the typed name immediately so a re-render keeps it visible.
        saveDraft('appointment', { ...getDraft('appointment'), customerName: name, customerId: '' });

        // Dedupe within the salon: reuse an existing client if name/phone match.
        let customer = customersRepository.findCustomerByName(name)
            || customersRepository.findCustomerByPhone(name);
        if (customer) {
            showNotification(`Linked existing client "${customer.name}".`);
        } else {
            customer = await customersRepository.addCustomerQuick({ name });
            showNotification(`New client "${customer.name}" added & linked.`);
        }

        // The store may have re-rendered during the write — always target the
        // live form so the selection sticks.
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
        const result = await authService.signInWithGoogle();
        if (result.ok && result.redirecting) {
            showNotification('Redirecting to Google…');
            return;
        }
        if (!result.ok) {
            showNotification(result.error || 'Sign-in failed.', 'error');
            return;
        }
        // The auth-state change already routed the owner to their dashboard;
        // re-resolve the salon scope so tenant data loads as soon as their
        // salons arrive (never a stale/default salon id).
        syncSalonScope();
        const name = store.getState().currentUser?.displayName;
        showNotification(name ? `Signed in as ${name}!` : 'Signed in successfully!');
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
        const referralCode = customersRepository.getReferralCode(customer);
        store.setState({
            rewards: {
                customerId: customer.id,
                name: customer.name,
                points: Number(customer.referralPoints) || 0,
                referralCode,
            },
        });
        openModal('rewards');
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

    async 'share-referral'(el) {
        const customer = customersRepository.getCustomer(el.dataset.id);
        if (!customer) {
            showNotification('Client not found.', 'error');
            return;
        }
        const referralCode = customersRepository.getReferralCode(customer);
        const text = rewards.buildReferralMessage(customer);

        // Native share sheet on mobile; clipboard fallback everywhere else.
        if (navigator.share) {
            try {
                await navigator.share({ title: 'LuxeGlow Referral', text });
                return;
            } catch (err) {
                if (err.name === 'AbortError') return; // user closed the sheet
                // fall through to clipboard
            }
        }
        try {
            await navigator.clipboard.writeText(text);
            showNotification(`Referral code ${referralCode} copied to clipboard!`);
        } catch (err) {
            showNotification(`Referral code: ${referralCode}`, 'error');
        }
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
        // Validation already guarantees 10 digits; store the full +91 number.
        const payload = { name: data.name, phone: toIndianE164(data.phone), email: data.email };
        if (id) {
            await customersRepository.updateCustomer(id, payload);
            showNotification('Client updated successfully!');
        } else {
            await customersRepository.addCustomer(payload);
            showNotification('Client added! 100 referral points credited.');
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
        // Resolve the client: use the one picked in the searchable dropdown; if
        // none was picked, link by exact name; otherwise create one (deduped).
        const customer = await resolveAppointmentCustomer(data);
        const payload = {
            customerId: customer.id,
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

function attachDelegation() {
    if (!appEl) return;

    appEl.addEventListener('click', (event) => {
        const el = event.target.closest('[data-action]');
        if (!el) return;
        // Native <select> controls are handled via the change delegation only —
        // running them on click would re-render and close the dropdown.
        if (el.tagName === 'SELECT') return;
        // Forms are submit targets, not click actions. Clicking a submit
        // button bubbles up to the nearest [data-action] element — the form
        // itself — which would call the handler as `handler(form, event)`
        // (no `data`) and cancel the real submission. Skip forms here; the
        // submit delegation below owns all form actions.
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

    // Live validation: revalidate + disable/enable the submit button on every
    // keystroke and on every select change. Keeps an incomplete form from ever
    // being saved (Enter-key submission is still blocked by the submit guard).
    appEl.addEventListener('input', (event) => {
        // The appointment client picker reacts live to typing (name/phone).
        const picker = event.target.closest('[data-action="customer-search"]');
        if (picker) {
            const handler = actions['customer-search'];
            Promise.resolve(handler(picker, event)).catch((err) => console.warn(err));
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

        // Root-cause validation: every entity form is validated here, before
        // any handler runs. Invalid forms are blocked — nothing is written.
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
            await authService.handleAuthStateChanged(user);
            syncSalonScope();
            renderApp();
        });
        await authService.restoreSession();
        // Consume any pending Google OAuth redirect callback (mobile flow).
        // onAuthStateChanged is the source of truth for state; real callback
        // failures are surfaced to the user by authService itself.
        authService.handleRedirectResult().catch((err) => {
            console.warn('Redirect result handling failed:', err);
        });
    }

    salonsRepository.initSalons();
    // Tenant repositories start un-scoped; resolveSalonScope points each one at
    // the active owner salon once the salons list arrives (never a default id).
    customersRepository.initCustomers(null);
    servicesRepository.initServices(null);
    staffRepository.initStaff(null);
    appointmentsRepository.initAppointments(null);

    store.subscribe(renderApp);

    // Re-derive salon scope whenever the store changes (auth transitions, the
    // salons list arriving asynchronously from Firestore, salon switching…).
    // resolveSalonScope no-ops unless the scope actually changed.
    store.subscribe(() => resolveSalonScope());

    attachDelegation();
    renderApp();
    resolveSalonScope();
    registerServiceWorker();
}

bootstrap();
