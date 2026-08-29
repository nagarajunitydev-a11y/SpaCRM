/**
 * views/appointments.js
 * Appointments list view, with a client-side filter bar (date range, status,
 * staff, customer, service, payment status, booking source, search) layered
 * over the existing scoped appointment list. No new Firestore reads: the
 * salon's appointments are already fully subscribed via appointmentsRepository,
 * exactly as before this filter bar existed — filtering only narrows what is
 * already in the store.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { sectionHeader, actionButton, badge, emptyState, iconAction } from '../components.js';
import { icon } from '../icons.js';
import { formatCurrency, scopedBySalon } from '../../core/utils.js';

const STATUS_CLASSES = {
    'Confirmed': 'bg-blue-500/15 text-blue-400',
    'In Progress': 'bg-amber-500/15 text-amber-400',
    'Completed': 'bg-emerald-500/15 text-emerald-400',
    'Cancelled': 'bg-rose-500/15 text-rose-400',
};
const STATUS_OPTIONS = Object.keys(STATUS_CLASSES);

const PAYMENT_METHOD_LABELS = { cash: 'Cash', upi: 'UPI', card: 'Card', other: 'Other' };

const PAYMENT_STATUS_OPTIONS = [
    { value: 'paid', label: 'Paid' },
    { value: 'unpaid', label: 'Unpaid' },
    { value: 'refunded', label: 'Refunded' },
];

/** `source` is only stamped by the public booking page; an internal booking has none. */
const BOOKING_SOURCE_LABELS = {
    in_salon: 'In Salon',
    whatsapp: 'WhatsApp',
    public_booking: 'Public Booking',
};
const BOOKING_SOURCE_OPTIONS = Object.entries(BOOKING_SOURCE_LABELS).map(([value, label]) => ({ value, label }));

export const DEFAULT_APPOINTMENT_FILTERS = Object.freeze({
    dateFrom: '',
    dateTo: '',
    status: 'all',
    staffName: 'all',
    customerId: 'all',
    serviceName: 'all',
    paymentStatus: 'all',
    source: 'all',
});

/**
 * Free-text search lives outside the store on purpose: writing it to the
 * store on every keystroke would re-render the shell and steal focus from the
 * input (same reason referrals.js and core/draft.js keep search state local).
 */
let searchQuery = '';

export function getAppointmentSearch() {
    return searchQuery;
}

export function setAppointmentSearch(value) {
    searchQuery = String(value || '');
}

function bookingSourceOf(appointment) {
    return appointment.source === 'whatsapp' || appointment.source === 'public_booking'
        ? appointment.source
        : 'in_salon';
}

function paymentStatusOf(appointment) {
    if (appointment.refunded) return 'refunded';
    return appointment.paid ? 'paid' : 'unpaid';
}

/** Apply every active filter (AND'ed together) plus the free-text search. */
export function filterAppointments(rows, filters = {}) {
    const f = { ...DEFAULT_APPOINTMENT_FILTERS, ...filters };
    const q = String(f.query || '').trim().toLowerCase();

    return (rows || []).filter((a) => {
        if (f.dateFrom && String(a.date || '') < f.dateFrom) return false;
        if (f.dateTo && String(a.date || '') > f.dateTo) return false;
        if (f.status !== 'all' && a.status !== f.status) return false;
        if (f.staffName !== 'all' && a.staffName !== f.staffName) return false;
        if (f.customerId !== 'all' && a.customerId !== f.customerId) return false;
        if (f.serviceName !== 'all' && a.serviceName !== f.serviceName) return false;
        if (f.paymentStatus !== 'all' && paymentStatusOf(a) !== f.paymentStatus) return false;
        if (f.source !== 'all' && bookingSourceOf(a) !== f.source) return false;
        if (q) {
            const haystack = [a.customerName, a.serviceName, a.staffName, a.invoiceNo].map((v) => String(v || '').toLowerCase());
            if (!haystack.some((v) => v.includes(q))) return false;
        }
        return true;
    });
}

/** How many filters differ from their default — shown as a badge on the bar. */
export function activeFilterCount(filters = {}, query = '') {
    const f = { ...DEFAULT_APPOINTMENT_FILTERS, ...filters };
    let count = Object.keys(DEFAULT_APPOINTMENT_FILTERS).reduce(
        (n, key) => n + (f[key] !== DEFAULT_APPOINTMENT_FILTERS[key] ? 1 : 0),
        0,
    );
    if (String(query || '').trim()) count += 1;
    return count;
}

function quickStatusButton(id, from, to, label, colors) {
    return `<button data-action="update-appointment-status" data-id="${esc(id)}" data-status="${esc(to)}"
        class="px-2 py-1 ${colors} text-[10px] font-semibold rounded-lg hover:opacity-80 transition active:scale-95 touch-manipulation">${esc(label)}</button>`;
}

function appointmentCard(a) {
    return `
        <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center justify-between gap-3">
            <div class="min-w-0 flex-1">
                <h4 class="font-bold text-sm text-slate-100 truncate">${esc(a.customerName)}</h4>
                <p class="text-xs text-slate-400 mt-0.5 truncate">${esc(a.serviceName)}</p>
                <p class="text-[11px] text-brand-400 font-medium mt-1 flex items-center gap-1"><i data-lucide="user" class="w-3 h-3 shrink-0"></i><span class="truncate">${esc(a.staffName)}</span></p>
                ${a.amount ? `<p class="text-[11px] text-emerald-400 font-semibold mt-1">${formatCurrency(a.amount)}${a.paid ? ' <span class="text-emerald-500/60">• Paid</span>' : ' <span class="text-amber-400/60">• Unpaid</span>'}</p>` : ''}
                ${a.paymentMethod ? `<p class="text-[10px] text-slate-500 mt-0.5">${PAYMENT_METHOD_LABELS[a.paymentMethod] || a.paymentMethod}</p>` : ''}
                ${a.walletRedeemed > 0 ? `<p class="text-[10px] text-brand-400 mt-0.5">Wallet ${formatCurrency(a.walletRedeemed)}${a.amountDue > 0 ? ` + ${formatCurrency(a.amountDue)}` : ''}</p>` : ''}
                ${a.refunded ? '<p class="text-[10px] text-rose-400 mt-0.5 font-semibold">Refunded</p>' : ''}
            </div>
            <div class="text-right shrink-0">
                <span class="text-xs font-bold text-slate-200 block">${esc(a.date)}</span>
                <span class="text-[11px] text-slate-400 block">${esc(a.time)}</span>
                <span class="inline-block mt-1">${badge(a.status, STATUS_CLASSES[a.status])}</span>
            </div>
            <div class="flex items-center flex-wrap gap-1 shrink-0">
                ${a.status === 'Confirmed' ? quickStatusButton(a.id, 'Confirmed', 'In Progress', 'Start', 'bg-blue-500/15 text-blue-400') : ''}
                ${a.status === 'In Progress' ? quickStatusButton(a.id, 'In Progress', 'Completed', 'Complete', 'bg-emerald-500/15 text-emerald-400') : ''}
                ${a.status !== 'Cancelled' ? iconAction('open-payment', { id: a.id }, a.paid ? 'View invoice' : 'Collect Payment', 'indian-rupee', a.paid ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400') : ''}
                ${iconAction('open-edit', { type: 'appointment', id: a.id }, 'Edit appointment', 'pencil', 'bg-slate-800 hover:bg-slate-700 text-slate-300')}
                ${iconAction('request-delete', { type: 'appointment', id: a.id, label: a.customerName }, 'Delete appointment', 'trash-2', 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400')}
            </div>
        </div>
    `;
}

/** The filtered list body — re-rendered in place by the search/filter handlers. */
export function renderAppointmentListBody(rows, totalCount) {
    if (!rows || rows.length === 0) {
        return emptyState(totalCount > 0 ? 'No appointments match the current filters.' : 'No appointments found.');
    }
    return `<div class="space-y-2.5">${rows.map((a) => appointmentCard(a)).join('')}</div>`;
}

/** A <select> wired directly for the appointment-filter change handler. */
function filterSelect(field, options, value) {
    return `
        <select data-action="appointment-filter" data-field="${escAttr(field)}"
            class="w-full bg-slate-950 border border-slate-800 px-3 py-2.5 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500">
            ${options.map((o) => `<option value="${escAttr(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
    `;
}

function filterBar(state, filters, query) {
    const appointments = scopedBySalon(state.appointmentsList, state.currentSalonId);
    const staffNames = [...new Set(appointments.map((a) => a.staffName).filter(Boolean))].sort();
    const serviceNames = [...new Set(appointments.map((a) => a.serviceName).filter(Boolean))].sort();
    const customers = scopedBySalon(state.customersList, state.currentSalonId)
        .slice()
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    const count = activeFilterCount(filters, query);

    return `
        <div class="bg-slate-900/60 border border-slate-800/60 p-3.5 rounded-2xl space-y-2.5">
            <div class="relative">
                <input type="text" data-action="appointment-search" placeholder="Search customer, service, staff, invoice…"
                    value="${escAttr(query)}"
                    class="w-full bg-slate-950 border border-slate-800 pl-9 pr-3 py-2.5 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500 placeholder:text-slate-500">
                <i data-lucide="search" class="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"></i>
            </div>

            <div class="grid grid-cols-2 gap-2">
                <input type="date" data-action="appointment-filter" data-field="dateFrom" value="${escAttr(filters.dateFrom)}"
                    class="w-full bg-slate-950 border border-slate-800 px-3 py-2.5 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500">
                <input type="date" data-action="appointment-filter" data-field="dateTo" value="${escAttr(filters.dateTo)}"
                    class="w-full bg-slate-950 border border-slate-800 px-3 py-2.5 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500">
            </div>

            <div class="grid grid-cols-2 gap-2">
                ${filterSelect('status', [{ value: 'all', label: 'All statuses' }, ...STATUS_OPTIONS.map((s) => ({ value: s, label: s }))], filters.status)}
                ${filterSelect('paymentStatus', [{ value: 'all', label: 'All payments' }, ...PAYMENT_STATUS_OPTIONS], filters.paymentStatus)}
            </div>

            <div class="grid grid-cols-2 gap-2">
                ${filterSelect('staffName', [{ value: 'all', label: 'All staff' }, ...staffNames.map((s) => ({ value: s, label: s }))], filters.staffName)}
                ${filterSelect('serviceName', [{ value: 'all', label: 'All services' }, ...serviceNames.map((s) => ({ value: s, label: s }))], filters.serviceName)}
            </div>

            <div class="grid grid-cols-2 gap-2">
                ${filterSelect('customerId', [{ value: 'all', label: 'All customers' }, ...customers.map((c) => ({ value: c.id, label: c.name }))], filters.customerId)}
                ${filterSelect('source', [{ value: 'all', label: 'All sources' }, ...BOOKING_SOURCE_OPTIONS], filters.source)}
            </div>

            <div data-appointment-filter-footer>${filterFooter(count)}</div>
        </div>
    `;
}

/**
 * The active-count badge + Clear Filters button. Rendered separately so the
 * search handler (which patches only the list, to keep focus in the input)
 * can also refresh this in place when a search term changes the active count.
 */
export function filterFooter(count) {
    return `
        <div class="flex items-center justify-between pt-0.5">
            <span class="text-[10px] text-slate-500 font-medium">
                ${count > 0 ? `<span class="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 bg-brand-600 text-white rounded-full text-[10px] font-bold mr-1">${count}</span>${count === 1 ? 'filter' : 'filters'} active` : 'No filters active'}
            </span>
            ${count > 0 ? `<button data-action="clear-appointment-filters" class="text-[11px] font-semibold text-brand-400 hover:text-brand-300 transition flex items-center gap-1"><i data-lucide="x" class="w-3 h-3"></i>Clear filters</button>` : ''}
        </div>
    `;
}

export function renderAppointments(state) {
    const appointments = scopedBySalon(state.appointmentsList, state.currentSalonId);
    const filters = { ...DEFAULT_APPOINTMENT_FILTERS, ...(state.appointmentFilters || {}) };
    const filtered = filterAppointments(appointments, { ...filters, query: searchQuery });

    return `
        <div class="space-y-4">
            ${sectionHeader(
                'Appointments',
                'Manage client schedules & timings',
                actionButton('Book', { action: 'modal', data: { modal: 'appointment' }, iconName: 'plus' }),
            )}

            ${appointments.length > 0 ? filterBar(state, filters, searchQuery) : ''}

            ${appointments.length > 0 ? `
                <div class="flex items-center justify-between">
                    <h3 class="font-bold text-sm text-slate-200">Appointment list</h3>
                    <span class="text-[10px] text-slate-500 font-medium">${filtered.length} of ${appointments.length}</span>
                </div>
            ` : ''}

            <div data-appointment-list>${renderAppointmentListBody(filtered, appointments.length)}</div>
        </div>
    `;
}

export default renderAppointments;
