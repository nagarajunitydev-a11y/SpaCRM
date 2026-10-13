/**
 * views/modals.js
 * Modal bottom-sheet with all entity forms (client, service, staff,
 * appointment, salon, rewards). Forms use `data-action` and are read via
 * FormData by the central submit delegation — no inline scripts, all values
 * escaped.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { formField, textInput, phoneInput, selectControl, dateTimeInput } from '../components.js';
import { ATTENDANCE_STATUSES, APPOINTMENT_PAST_GRACE_MINUTES, hmToMinutes } from '../../core/validate.js';
import { PREDEFINED_SERVICES } from '../../core/predefinedServices.js';
import { TUTORIAL_ORDER, TUTORIALS } from '../../core/tutorialContent.js';
import { REWARD_TIERS } from '../../core/rewards.js';
import { getDraft } from '../../core/draft.js';
import { scopedBySalon, formatCurrency, currentSalonDateTime, TIMEZONE_OPTIONS } from '../../core/utils.js';
import { sanitizeSettings, round2, num } from '../../core/referral.js';
import renderPaymentForm from './payment.js';
import renderCustomerProfile from './customerProfile.js';
import renderBookingLinkModal from './bookingLink.js';
import { renderReceipt, lockedFeatureView } from './subscription.js';
import { renderPlanEditor } from './adminSubscriptions.js';

/** Modals that belong to a plan feature; locked plans see an upgrade prompt instead. */
const MODAL_FEATURES = { 'booking-link': 'onlineBooking', rewards: 'loyalty' };

const TITLES = {
    customer: 'Add New Client',
    service: 'Add New Service',
    staff: 'Register Staff',
    appointment: 'Book Appointment',
    salon: 'Add Branch',
    rewards: 'Client Rewards',
    payment: 'Collect Payment',
    'customer-profile': 'Client Profile',
    'referral-redemption': 'Redeem Referral Balance',
    'booking-link': 'Booking Link',
    'confirm-delete': 'Confirm Deletion',
    'service-catalogue': 'Import From Catalogue',
    attendance: 'Mark Attendance',
    receipt: 'Payment Receipt',
    'plan-editor': 'Edit Plan',
    'help-menu': 'Help & Guided Tours',
};

const EDIT_TITLES = {
    customer: 'Edit Client',
    service: 'Edit Service',
    staff: 'Edit Staff Details',
    appointment: 'Edit Appointment',
    salon: 'Edit Branch',
    attendance: 'Edit Attendance',
};

export function renderModalSheet(state) {
    const type = state.modalType;
    const isEditing = !!(state.modalRecord && state.modalRecord.id);
    const title = isEditing ? (EDIT_TITLES[type] || TITLES[type] || 'Details') : (TITLES[type] || 'Details');

    return `
        <div class="absolute inset-0 bg-black/85 backdrop-blur-sm z-50 flex flex-col justify-end lg:items-center lg:justify-center lg:p-6" data-action="modal-backdrop">
            <div class="bg-slate-900 border-t border-slate-800 rounded-t-3xl p-6 max-h-[85vh] overflow-y-auto shadow-2xl no-scrollbar lg:rounded-3xl lg:border lg:border-slate-800 lg:max-w-2xl lg:w-full lg:max-h-[85vh]" role="dialog" aria-modal="true" aria-label="${escAttr(title)}">
                <div class="flex items-center justify-between mb-5">
                    <h3 class="font-bold text-base text-slate-100 capitalize">${esc(title)}</h3>
                    <button data-action="close-modal" aria-label="Close" class="w-8 h-8 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center hover:bg-slate-700 transition active:scale-95 touch-manipulation">
                        <i data-lucide="x" class="w-4 h-4"></i>
                    </button>
                </div>

                ${renderForm(state, type)}
            </div>
        </div>
    `;
}

function editingRecord(state, type) {
    const id = state.modalRecord && state.modalRecord.id;
    if (!id) return null;
    const key = { customer: 'customersList', service: 'servicesList', staff: 'staffList', appointment: 'appointmentsList', attendance: 'attendanceList', salon: 'salonsList' }[type];
    return (key && (state[key] || []).find((r) => r.id === id)) || null;
}

function appointmentLineItems(record) {
    let selected = record?.selectedServices;
    if (typeof selected === 'string') {
        try { selected = JSON.parse(selected); } catch { selected = []; }
    }
    if (!Array.isArray(selected) || selected.length === 0) {
        selected = record?.services || record?.serviceNames || (record?.serviceName ? [record.serviceName] : []);
    }
    return (selected || []).map((service, index) => {
        if (typeof service === 'string') {
            return { id: `legacy_appointment_line_${index}`, serviceId: '', name: service.trim(), price: null, duration: '', custom: false };
        }
        return {
            // `id` on a stored service can be its catalog id. It must never
            // become the line id because repeated catalog services need
            // independent controls.
            id: String(service?.lineItemId || `legacy_appointment_line_${index}`),
            serviceId: String(service?.serviceId || ''),
            name: String(service?.name || service?.serviceName || '').trim(),
            price: Number.isFinite(Number(service?.price)) ? Number(service.price) : null,
            duration: service?.duration || '',
            custom: service?.custom === true,
        };
    }).filter((line) => line.name || line.custom);
}

function renderForm(state, type) {
    const services = scopedBySalon(state.servicesList, state.currentSalonId);
    const staff = scopedBySalon(state.staffList, state.currentSalonId);

    if (type === 'help-menu') {
        return renderHelpMenu();
    }

    if (type === 'receipt') return renderReceipt(state);
    if (type === 'plan-editor') return renderPlanEditor(state);

    // Plan-gated modals show an upgrade prompt instead of the feature.
    const gatedFeature = MODAL_FEATURES[type];
    if (gatedFeature && state.access && !state.access.can(gatedFeature)) {
        return lockedFeatureView(state, gatedFeature);
    }

    if (type === 'rewards') {
        return renderRewardsModal(state);
    }

    if (type === 'confirm-delete') {
        return renderDeleteConfirm(state);
    }

    if (type === 'payment') {
        return renderPaymentForm(state);
    }

    if (type === 'customer-profile') {
        return renderCustomerProfile(state);
    }

    if (type === 'referral-redemption') {
        return renderReferralRedemptionPicker(state);
    }

    if (type === 'booking-link') {
        return renderBookingLinkModal(state);
    }

    if (type === 'customer') {
        const rec = editingRecord(state, 'customer');
        return `
            <form data-action="submit-customer" class="space-y-3.5 lg:grid lg:grid-cols-2 lg:gap-3.5 lg:space-y-0" novalidate>
                ${rec ? `<input type="hidden" name="id" value="${escAttr(rec.id)}">` : ''}
                <div class="lg:col-span-2">${formField('Full Name', textInput('name', 'Olivia Wilde', { value: rec?.name }))}</div>
                ${formField('Phone', phoneInput('phone', { value: rec?.phone }), 'Enter exactly 10 digits — e.g. 98765 43210.')}
                ${formField('Email', textInput('email', 'olivia@example.com', { type: 'email', autocomplete: 'email', value: rec?.email }))}
                ${formField('Date of Birth (optional)', dateTimeInput('dob', 'date', '', { value: rec?.dob, required: false }))}
                <div></div>
                ${!rec && sanitizeSettings(state.referralSettings).enabled
                    ? `<div class="lg:col-span-2">${formField(
                        'Referral Code (optional)',
                        textInput('referralCode', 'e.g. PRIY4K7M', { required: false, className: 'uppercase tracking-widest font-mono' }),
                        'Enter the code of the client who referred them. The reward is credited after their first qualifying paid appointment.',
                    )}</div>`
                    : ''}
                <button type="submit" disabled class="w-full py-3.5 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none lg:col-span-2 lg:mt-1">${rec ? 'Save Changes' : 'Save Client'}</button>
            </form>
        `;
    }

    if (type === 'service') {
        const rec = editingRecord(state, 'service');
        return `
            <form data-action="submit-service" class="space-y-3.5 lg:grid lg:grid-cols-2 lg:gap-3.5 lg:space-y-0" novalidate>
                ${rec ? `<input type="hidden" name="id" value="${escAttr(rec.id)}">` : ''}
                <div class="lg:col-span-2">${formField('Service Title', textInput('name', 'Keratin Treatment', { value: rec?.name }))}</div>
                ${formField('Category (optional)', textInput('category', 'Hair, Skin, Nails…', { required: false, value: rec?.category }))}
                <div></div>
                ${formField('Price (₹)', textInput('price', '140', { type: 'number', className: 'input-number', value: rec?.price }))}
                ${formField('Duration', textInput('duration', '90m', { value: rec?.duration }))}
                <button type="submit" disabled class="w-full py-3.5 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none lg:col-span-2 lg:mt-1">${rec ? 'Save Changes' : 'Add Service'}</button>
            </form>
        `;
    }

    if (type === 'service-catalogue') {
        return renderServiceCatalogueModal(state);
    }

    if (type === 'attendance') {
        return renderAttendanceForm(state);
    }

    if (type === 'staff') {
        const rec = editingRecord(state, 'staff');
        return `
            <form data-action="submit-staff" class="space-y-3.5 lg:grid lg:grid-cols-2 lg:gap-3.5 lg:space-y-0" novalidate>
                ${rec ? `<input type="hidden" name="id" value="${escAttr(rec.id)}">` : ''}
                <div class="lg:col-span-2">${formField('Staff Name', textInput('name', 'Chloe Grace', { value: rec?.name }))}</div>
                ${formField('Role / Specialization', textInput('role', 'Senior Hair Stylist', { value: rec?.role }))}
                ${formField('Phone', phoneInput('phone', { value: rec?.phone }), 'Enter exactly 10 digits — e.g. 98765 43210.')}
                <div></div>
                <button type="submit" disabled class="w-full py-3.5 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none lg:col-span-2 lg:mt-1">${rec ? 'Save Changes' : 'Register Staff'}</button>
            </form>
        `;
    }

    if (type === 'appointment') {
        const rec = editingRecord(state, 'appointment');
        const draft = getDraft('appointment') || {};
        const pre = rec ? { ...rec, ...draft } : draft;
        // Appointment Booking uses explicit schedule controls. Quick Billing
        // remains independent and continues to timestamp walk-ins automatically.
        const salon = (state.salonsList || []).find((s) => s.id === state.currentSalonId) || null;
        const salonNow = currentSalonDateTime(salon);
        // A draft left open for a while carries a time that has since passed;
        // re-stamp new bookings so the form doesn't open already invalid.
        const draftIsStale = !rec && !!pre.date && !!pre.time && (pre.date < salonNow.date
            || (pre.date === salonNow.date && hmToMinutes(pre.time) < hmToMinutes(salonNow.time) - APPOINTMENT_PAST_GRACE_MINUTES));
        const stampDate = draftIsStale ? salonNow.date : (pre.date || salonNow.date);
        const stampTime = draftIsStale ? salonNow.time : (pre.time || salonNow.time);
        const appointmentStamp = {
            date: stampDate,
            time: stampTime,
            label: [stampDate, stampTime].join(' · '),
        };
        const selectedLineItems = appointmentLineItems(pre);
        const selectedServices = selectedLineItems.map((line) => {
            if (line.custom) return line;
            const service = services.find((item) => item.id === line.serviceId) || services.find((item) => item.name === line.name);
            return service ? { ...line, serviceId: service.id || '', name: service.name, price: service.price, duration: service.duration, custom: false } : line;
        });
        const subtotal = selectedServices.reduce((sum, service) => sum + (Number(service.price) || 0), 0);
        // Disabled services can still appear on an existing booking (looked up
        // above from the full catalog) but are never offered for new picks.
        const pickableServices = [
            ...services.filter((s) => s.active !== false),
            { id: '__other_service__', name: 'Other Service', price: 0, duration: '', custom: true },
        ];
        const statusOptions = [
            { value: 'Confirmed', label: 'Confirmed' },
            { value: 'In Progress', label: 'In Progress' },
            { value: 'Completed', label: 'Completed' },
            { value: 'Cancelled', label: 'Cancelled' },
        ];
        return `
            <form data-action="submit-appointment" class="space-y-3.5 lg:grid lg:grid-cols-2 lg:gap-3.5 lg:space-y-0" novalidate>
                ${rec ? `<input type="hidden" name="id" value="${escAttr(rec.id)}">` : ''}
                <div class="lg:col-span-2">${renderCustomerPicker(pre)}</div>
                <input type="hidden" name="selectedServices" value="${escAttr(JSON.stringify(selectedServices))}">
                ${formField('Select Service', selectControl('serviceName', pickableServices.map((s) => ({ value: s.name, label: `${s.name} (₹${s.price})` })), 'Choose a service', { value: pre?.serviceName, dataAction: 'appointment-service-picker' }))}
                <div class="flex items-end">
                    <button type="button" data-action="add-appointment-service" class="w-full py-2.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-bold rounded-xl transition active:scale-[0.98] touch-manipulation">Add selected service</button>
                </div>
                <div class="lg:col-span-2 ${pre?.serviceName === 'Other Service' ? '' : 'hidden'}" data-other-appointment-service>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        ${formField('Other Service Name / Description', textInput('otherServiceName', 'e.g. Hair Coloring', { required: false, value: pre?.otherServiceName || '' }))}
                        ${formField('Other Service Amount (₹)', textInput('otherServiceAmount', '0', { type: 'number', required: false, className: 'input-number', value: pre?.otherServiceAmount || '', min: 0, step: '0.01' }))}
                    </div>
                </div>
                <div class="lg:col-span-2 bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3 space-y-2">
                    <div class="flex items-center justify-between"><p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Selected Services</p><span class="text-[10px] text-slate-500">${selectedServices.length}</span></div>
                    ${selectedServices.length === 0 ? '<p class="text-[11px] text-slate-500">Add one or more services to this appointment.</p>' : selectedServices.map((service) => `<div class="flex items-center justify-between gap-2 text-xs"><div class="min-w-0 space-y-1"><select data-action="edit-appointment-line-service" data-line-id="${escAttr(service.id)}" class="max-w-full bg-transparent text-xs font-semibold text-slate-200 focus:outline-none focus:text-brand-300"><option value="Other Service" ${service.custom ? 'selected' : ''}>Other Service</option>${pickableServices.filter((option) => !option.custom).map((option) => `<option value="${escAttr(option.name)}" ${!service.custom && option.name === service.name ? 'selected' : ''}>${esc(option.name)}</option>`).join('')}</select>${service.custom ? `<div class="flex gap-1.5"><input data-action="edit-appointment-custom-name" data-line-id="${escAttr(service.id)}" value="${escAttr(service.name)}" aria-label="Other service name" class="min-w-0 w-28 bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-[10px] text-slate-100"><input data-action="edit-appointment-custom-amount" data-line-id="${escAttr(service.id)}" type="number" min="0" step="0.01" value="${escAttr(service.price)}" aria-label="Other service amount" class="w-20 bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-[10px] text-slate-100"></div>` : `<p class="text-[10px] text-slate-500">${esc(service.duration || '—')} • ${esc(formatCurrency(service.price))}</p>`}</div><button type="button" data-action="remove-appointment-service" data-line-id="${escAttr(service.id)}" class="w-7 h-7 shrink-0 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 flex items-center justify-center transition" aria-label="Remove ${escAttr(service.name)}"><i data-lucide="x" class="w-3.5 h-3.5"></i></button></div>`).join('')}
                    <div class="border-t border-slate-800 pt-2 flex items-center justify-between"><span class="text-[11px] font-semibold text-slate-300">Subtotal</span><span class="text-sm font-extrabold text-brand-300">${esc(formatCurrency(subtotal))}</span></div>
                    <div class="flex items-center justify-between text-[10px] text-slate-500"><span>Discount / credit</span><span>Applied at payment</span></div>
                    <div class="flex items-center justify-between text-[11px] font-bold text-slate-200"><span>Final total</span><span>${esc(formatCurrency(subtotal))}</span></div>
                </div>
                <div class="lg:col-span-2">${formField('Assigned Stylist', selectControl('staffName', staff.map((st) => ({ value: st.name, label: `${st.name} (${st.role})` })), 'Choose a stylist', { value: pre?.staffName }))}</div>
                ${formField('Appointment Date', `<input type="date" name="date" required min="${escAttr(salonNow.date)}" value="${escAttr(appointmentStamp.date)}" class="w-full bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500">`)}
                ${formField('Appointment Time', `<input type="time" name="time" required value="${escAttr(appointmentStamp.time)}" class="w-full bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500">`)}
                ${rec ? `<div class="lg:col-span-2">${formField('Status', selectControl('status', statusOptions, '', { value: pre?.status || 'Confirmed' }))}</div>` : ''}
                <button type="submit" disabled class="w-full py-3.5 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none lg:col-span-2 lg:mt-1">${rec ? 'Save Changes' : 'Confirm Booking'}</button>
            </form>
        `;
    }

    const rec = editingRecord(state, 'salon');
    return `
        <form data-action="submit-salon" class="space-y-3.5 lg:grid lg:grid-cols-2 lg:gap-3.5 lg:space-y-0" novalidate>
            ${rec ? `<input type="hidden" name="id" value="${escAttr(rec.id)}">` : ''}
            <div class="lg:col-span-2">${formField('Branch Name', textInput('name', 'Luxe Glow SoHo', { value: rec?.name }))}</div>
            ${formField('Owner Email', textInput('email', 'owner@sohostudio.com', { type: 'email', autocomplete: 'email', value: rec?.ownerEmail ?? rec?.email ?? state.currentUser?.email ?? (state.salonsList || [])[0]?.ownerEmail }))}
            ${formField('Phone', phoneInput('phone', { value: rec?.phone }), 'Enter exactly 10 digits — e.g. 98765 43210.')}
            <div></div>
            ${formField('Opening Time', `<input type="time" name="openTime" required value="${escAttr(rec?.openTime || '10:00')}" class="w-full bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500">`)}
            ${formField('Closing Time', `<input type="time" name="closeTime" required value="${escAttr(rec?.closeTime || '19:00')}" class="w-full bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500">`)}
            <div class="lg:col-span-2">${formField('Location Address', textInput('address', '78 Mercer St, New York', { value: rec?.address }))}</div>
            <div class="lg:col-span-2">${formField('Timezone', selectControl('timezone', TIMEZONE_OPTIONS.map((t) => ({ value: t.value, label: t.label })), '', { value: rec?.timezone || 'Asia/Kolkata' }))}</div>
            <button type="submit" disabled class="w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-indigo-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none lg:col-span-2 lg:mt-1">${rec ? 'Save Changes' : 'Add Branch'}</button>
        </form>
    `;
}

/** Select an invoice for the profile customer's existing referral-wallet flow. */
function renderReferralRedemptionPicker(state) {
    const customerId = state.modalRecord?.customerId;
    const customer = (state.customersList || []).find((row) => row.id === customerId);
    const balance = round2(Math.max(0, num(customer?.walletBalance)));
    const appointments = scopedBySalon(state.appointmentsList, state.currentSalonId)
        .filter((appointment) => appointment.customerId === customerId && appointment.paid !== true && appointment.status !== 'Cancelled');

    if (!customer || balance <= 0) {
        return '<p class="text-xs text-slate-400">No referral balance is available for this client.</p>';
    }

    return `
        <div class="space-y-3.5">
            <div class="bg-brand-500/10 border border-brand-500/25 rounded-2xl p-3.5">
                <p class="text-xs font-bold text-brand-200">${esc(customer.name)}</p>
                <p class="text-[11px] text-slate-400 mt-0.5">Available referral balance: ${esc(formatCurrency(balance))}</p>
            </div>
            <p class="text-[11px] text-slate-400">Choose an unpaid appointment. The existing invoice payment flow will validate and apply the eligible amount.</p>
            ${appointments.length === 0
                ? '<p class="text-xs text-slate-500 text-center py-5">No unpaid appointments are available for this client.</p>'
                : `<div class="space-y-2">${appointments.map((appointment) => `
                    <button type="button" data-action="redeem-referral-balance-on-appointment" data-customer-id="${escAttr(customerId)}" data-appointment-id="${escAttr(appointment.id)}"
                        class="w-full text-left bg-slate-950/60 border border-slate-800 hover:border-brand-500/40 rounded-2xl p-3 transition touch-manipulation active:scale-[0.98]">
                        <p class="text-xs font-bold text-slate-100">${esc(appointment.serviceName || 'Appointment')}</p>
                        <p class="text-[10px] text-slate-400 mt-0.5">${esc(appointment.date || '')} ${esc(appointment.time || '')}</p>
                    </button>
                `).join('')}</div>`}
        </div>
    `;
}

function renderCustomerPicker(pre) {
    const name = pre?.customerName || '';
    const id = pre?.customerId || '';
    return `
        <div>
            <label class="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Client</label>
            <div class="relative">
                <input type="text" name="customerName" required autocomplete="off"
                    value="${escAttr(name)}" placeholder="Search name or phone…"
                    data-action="customer-search"
                    class="w-full bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500 pr-9">
                <i data-lucide="search" class="w-4 h-4 text-slate-500 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none"></i>
            </div>
            <input type="hidden" name="customerId" value="${escAttr(id)}">
            <div data-customer-suggestions class="mt-2"></div>
            <p class="mt-1 text-[10px] text-slate-500">Start typing to find an existing client, or add a new one below.</p>
        </div>
    `;
}

export function renderCustomerSuggestions(matches, query, opts = {}) {
    const { exactName, selectedId } = opts || {};
    const q = (query || '').trim();
    const list = (matches || [])
        .filter((c) => c.id !== selectedId)
        .slice(0, 6)
        .map((c) => `
            <button type="button" data-action="pick-customer" data-id="${escAttr(c.id)}" data-name="${escAttr(c.name)}"
                class="w-full flex items-center justify-between gap-3 bg-slate-950 border border-slate-800 px-4 py-2.5 rounded-xl text-left transition active:scale-[0.98] touch-manipulation">
                <span class="min-w-0">
                    <span class="block text-xs font-semibold text-slate-100 truncate">${esc(c.name)}</span>
                    <span class="block text-[10px] text-slate-400 truncate">${esc(c.phone || 'No phone on file')}</span>
                </span>
                <span class="text-brand-400 shrink-0"><i data-lucide="user-check" class="w-4 h-4"></i></span>
            </button>
        `).join('');

    const addNew = q.length > 0 && !exactName ? `
        <button type="button" data-action="quick-add-customer" data-name="${escAttr(q)}"
            class="w-full flex items-center gap-3 bg-brand-600/15 border border-brand-500/30 px-4 py-2.5 rounded-xl text-left transition active:scale-[0.98] touch-manipulation">
            <span class="text-brand-400 shrink-0"><i data-lucide="user-plus" class="w-4 h-4"></i></span>
            <span class="text-xs font-semibold text-brand-300 min-w-0">
                <span class="block truncate">Add new client: ${esc(q)}</span>
            </span>
        </button>
    ` : '';

    if (!list && !addNew) return '';
    return `
        <div class="space-y-1.5">
            ${list}
            ${list && addNew ? '<div class="h-px bg-slate-800 my-1"></div>' : ''}
            ${addNew}
        </div>
    `;
}

const TOUR_ICONS = { staff: 'users', services: 'sparkles', customers: 'user-round', appointments: 'calendar' };

/** Help menu: replay the full Initial Setup Guide, or just one section's tour. */
function renderHelpMenu() {
    return `
        <div class="space-y-4">
            <button type="button" data-action="replay-tutorial" data-tour="all"
                class="w-full flex items-center gap-3 bg-brand-600/15 border border-brand-500/30 px-4 py-3.5 rounded-2xl text-left transition active:scale-[0.98] touch-manipulation">
                <span class="w-10 h-10 rounded-xl bg-brand-600 text-white flex items-center justify-center shrink-0"><i data-lucide="sparkles" class="w-5 h-5"></i></span>
                <span class="min-w-0">
                    <span class="block text-xs font-bold text-brand-200">Restart Full Setup Guide</span>
                    <span class="block text-[10px] text-slate-400 mt-0.5">Staff → Services → Clients → Booking, step by step</span>
                </span>
            </button>

            <div class="space-y-2">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Or replay just one section</p>
                ${TUTORIAL_ORDER.map((id) => `
                    <button type="button" data-action="replay-tutorial" data-tour="${escAttr(id)}"
                        class="w-full flex items-center gap-3 bg-slate-950/60 border border-slate-800 hover:border-brand-500/40 px-4 py-3 rounded-2xl text-left transition active:scale-[0.98] touch-manipulation">
                        <span class="w-9 h-9 rounded-xl bg-slate-800 text-slate-300 flex items-center justify-center shrink-0"><i data-lucide="${escAttr(TOUR_ICONS[id] || 'info')}" class="w-4 h-4"></i></span>
                        <span class="text-xs font-semibold text-slate-100">${esc(TUTORIALS[id].label)}</span>
                    </button>
                `).join('')}
            </div>
        </div>
    `;
}

function renderDeleteConfirm(state) {
    const t = state.deleteTarget || {};
    const noun = { customer: 'client', service: 'service', staff: 'staff member', appointment: 'appointment', salon: 'salon', attendance: 'attendance record' }[t.type] || 'record';
    return `
        <div class="text-center space-y-4">
            <div class="w-14 h-14 mx-auto rounded-2xl bg-rose-500/10 text-rose-400 flex items-center justify-center" aria-hidden="true">
                <i data-lucide="trash-2" class="w-6 h-6"></i>
            </div>
            <div>
                <p class="text-base font-extrabold text-slate-100">Delete ${esc(noun)}?</p>
                <p class="text-xs text-slate-400 mt-1.5 max-w-[280px] mx-auto">"${esc(t.label || 'this record')}" will be permanently removed. This cannot be undone.</p>
            </div>
            <div class="flex gap-2.5">
                <button data-action="close-modal" class="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-xl transition active:scale-95 touch-manipulation">Cancel</button>
                <button data-action="confirm-delete" class="flex-1 py-3 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-rose-600/30 transition active:scale-95 touch-manipulation">Delete</button>
            </div>
        </div>
    `;
}

/**
 * Predefined service catalogue: a checklist the owner selectively imports
 * from. Existing services are never touched — this only ever adds new rows,
 * and an entry already present in the salon's catalog (by name) is skipped.
 */
function renderServiceCatalogueModal(state) {
    const existingNames = new Set(scopedBySalon(state.servicesList, state.currentSalonId).map((s) => (s.name || '').trim().toLowerCase()));

    return `
        <form data-action="submit-service-catalogue" class="space-y-3.5" novalidate>
            <p class="text-[11px] text-slate-400">Pick services to add to your catalog. Your existing services are never changed.</p>
            <div class="space-y-2 max-h-[50vh] overflow-y-auto no-scrollbar pr-0.5">
                ${PREDEFINED_SERVICES.map((svc, index) => {
                    const already = existingNames.has(svc.name.trim().toLowerCase());
                    return `
                        <label class="flex items-center gap-3 bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3 ${already ? 'opacity-50' : ''}">
                            <input type="checkbox" name="import_${index}" ${already ? 'disabled' : ''} class="w-4 h-4 accent-brand-600 shrink-0">
                            <div class="min-w-0 flex-1">
                                <p class="text-xs font-bold text-slate-100 truncate">${esc(svc.name)}</p>
                                <p class="text-[10px] text-slate-400 mt-0.5">${esc(svc.category)} • ${esc(svc.duration)} • ${esc(formatCurrency(svc.price))}${already ? ' • already in your catalog' : ''}</p>
                            </div>
                        </label>
                    `;
                }).join('')}
            </div>
            <button type="submit" class="w-full py-3.5 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition mt-2 active:scale-[0.98] touch-manipulation">Import Selected</button>
        </form>
    `;
}

/**
 * Full attendance record form: staff, date, status and check-in/out times.
 * The staff member and date are fixed once a record exists (they form its
 * document id) — editing only ever changes status/times/notes.
 */
function renderAttendanceForm(state) {
    const rec = editingRecord(state, 'attendance');
    const staff = scopedBySalon(state.staffList, state.currentSalonId);
    const preselect = state.modalRecord || {};
    const staffId = rec?.staffId || preselect.staffId || '';
    const date = rec?.date || preselect.date || '';
    const staffName = staff.find((s) => s.id === staffId)?.name || rec?.staffName || '';

    const staffAndDateFields = rec
        ? `
            <input type="hidden" name="staffId" value="${escAttr(staffId)}">
            <input type="hidden" name="date" value="${escAttr(date)}">
            <div class="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3.5">
                <p class="text-xs font-bold text-slate-100">${esc(staffName)}</p>
                <p class="text-[11px] text-slate-400 mt-0.5">${esc(date)}</p>
            </div>
        `
        : `
            ${formField('Staff Member', selectControl('staffId', staff.map((s) => ({ value: s.id, label: s.name })), 'Choose a staff member', { value: staffId }))}
            ${formField('Date', dateTimeInput('date', 'date', '', { value: date }))}
        `;

    return `
        <form data-action="submit-attendance" class="space-y-3.5" novalidate>
            ${rec ? `<input type="hidden" name="id" value="${escAttr(rec.id)}">` : ''}
            ${staffAndDateFields}
            ${formField('Status', selectControl('status', ATTENDANCE_STATUSES.map((s) => ({ value: s, label: s })), 'Select status', { value: rec?.status || 'Present' }))}
            <div class="grid grid-cols-2 gap-3">
                <div>${formField('Check-in (optional)', dateTimeInput('checkIn', 'time', '', { value: rec?.checkIn, required: false }))}</div>
                <div>${formField('Check-out (optional)', dateTimeInput('checkOut', 'time', '', { value: rec?.checkOut, required: false }))}</div>
            </div>
            ${formField('Notes (optional)', textInput('notes', 'Late due to traffic…', { required: false, value: rec?.notes }))}
            <button type="submit" disabled class="w-full py-3.5 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none">${rec ? 'Save Changes' : 'Save Attendance'}</button>
        </form>
    `;
}

/**
 * Rewards bottom sheet: redeem a tier.
 */
function renderRewardsModal(state) {
    const r = (state && state.modalRecord) || {};
    const pts = Number(r.points) || 0;

    const tierRows = REWARD_TIERS.map((tier) => {
        const affordable = pts >= tier.points;
        const missing = tier.points - pts;
        return `
            <div class="flex items-center justify-between gap-3 bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3.5 ${affordable ? '' : 'opacity-60'}">
                <div class="min-w-0">
                    <p class="text-xs font-bold text-slate-100">${esc(tier.label)}</p>
                    <p class="text-[10px] text-slate-400 mt-0.5">${esc(tier.points)} pts</p>
                    ${!affordable ? `<p class="text-[10px] text-amber-400/90 mt-0.5 font-semibold">${esc(missing)} more pts needed</p>` : ''}
                </div>
                ${affordable
                    ? `<button data-action="redeem-reward" data-id="${escAttr(r.customerId)}" data-points="${escAttr(tier.points)}" data-label="${escAttr(tier.label)}"
                        class="px-3 py-2 bg-brand-600 hover:bg-brand-500 text-white text-[10px] font-semibold rounded-xl transition active:scale-95 touch-manipulation shrink-0">Redeem</button>`
                    : `<span class="px-3 py-2 bg-slate-800/60 text-slate-500 text-[10px] font-semibold rounded-xl shrink-0"><i data-lucide="lock" class="w-3 h-3 inline mr-1"></i>Locked</span>`}
            </div>
        `;
    }).join('');

    return `
        <div class="space-y-4">
            <div class="text-center">
                <p class="text-xs font-semibold text-slate-400">${esc(r.name || 'Client')}</p>
                <p class="text-2xl font-extrabold text-brand-400 mt-1">${esc(pts)} <span class="text-xs font-semibold text-slate-400">pts</span></p>
            </div>

            <div class="space-y-2.5">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Reward tiers</p>
                ${tierRows}
            </div>
        </div>
    `;
}

export default renderModalSheet;
