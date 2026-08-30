/**
 * views/dashboard.js
 * Owner dashboard: overview stats, quick actions, and appointment views
 * filtered by Today / Current Month / Previous Month.
 */

import { esc } from '../../core/sanitize.js';
import { statCard, quickAction, badge, emptyState, sectionHeader } from '../components.js';
import { formatCurrency, scopedBySalon } from '../../core/utils.js';
import { computeEstimatedRevenue } from '../../core/revenue.js';

function createdAtValue(value) {
    if (typeof value?.toDate === 'function') return value.toDate().getTime();
    if (value && typeof value === 'object' && Number.isFinite(value.seconds)) return value.seconds * 1000;
    const time = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
    return Number.isFinite(time) ? time : null;
}

function newestFirst(rows) {
    return (rows || []).map((row, index) => ({ row, index, createdAt: createdAtValue(row.createdAt) }))
        .sort((a, b) => {
            if (a.createdAt !== null && b.createdAt !== null && a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
            if (a.createdAt !== null && b.createdAt === null) return -1;
            if (a.createdAt === null && b.createdAt !== null) return 1;
            return a.index - b.index;
        })
        .map(({ row }) => row);
}

/** Local YYYY-MM-DD string (no timezone shift). */
function localDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** First day of month as YYYY-MM-01 string. */
function monthStart(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/** Last day of month as YYYY-MM-DD string. */
function monthEnd(d) {
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return localDateStr(last);
}

function filterByPeriod(appointments, period) {
    const now = new Date();
    const today = localDateStr(now);

    if (period === 'today') {
        return appointments.filter((a) => a.date === today);
    }

    if (period === 'current') {
        const start = monthStart(now);
        const end = monthEnd(now);
        return appointments.filter((a) => a.date >= start && a.date <= end);
    }

    if (period === 'previous') {
        const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const start = monthStart(prev);
        const end = monthEnd(prev);
        return appointments.filter((a) => a.date >= start && a.date <= end);
    }

    return appointments;
}

function periodLabel(period) {
    if (period === 'today') return 'Today';
    if (period === 'current') {
        const now = new Date();
        return now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    }
    if (period === 'previous') {
        const prev = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
        return prev.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    }
    return '';
}

const PERIODS = [
    { key: 'today', label: 'Today', icon: 'sun' },
    { key: 'current', label: 'This Month', icon: 'calendar' },
    { key: 'previous', label: 'Last Month', icon: 'calendar-clock' },
];

function renderAppointmentCard(a) {
    return `
        <div class="bg-slate-900 border border-slate-800/80 p-3.5 rounded-2xl flex items-center justify-between shadow-sm">
            <div class="min-w-0 pr-3">
                <h4 class="font-bold text-xs text-slate-200 truncate">${esc(a.customerName)}</h4>
                <p class="text-[11px] text-slate-400 mt-0.5 truncate">${esc(a.serviceName)} <span class="text-brand-400 font-medium">• ${esc(a.staffName)}</span></p>
            </div>
            <div class="text-right shrink-0">
                ${badge(a.status)}
                <span class="text-[10px] text-slate-400 block mt-1">${esc(a.date)} (${esc(a.time)})</span>
            </div>
        </div>
    `;
}

export function renderDashboard(state) {
    const allAppointments = scopedBySalon(state.appointmentsList, state.currentSalonId);
    const services = scopedBySalon(state.servicesList, state.currentSalonId);
    const activeTab = state.dashboardTab || 'today';
    const filtered = newestFirst(filterByPeriod(allAppointments, activeTab));
    const { total: totalRevenue } = computeEstimatedRevenue(filtered, services);

    return `
        <div class="space-y-5">
            <div class="bg-gradient-to-br from-slate-900 to-slate-900/60 border border-slate-800/80 p-5 rounded-3xl relative overflow-hidden shadow-xl">
                <div class="absolute right-0 top-0 w-32 h-32 bg-brand-500/10 rounded-full blur-2xl pointer-events-none" aria-hidden="true"></div>
                <span class="text-[10px] font-bold text-brand-400 uppercase tracking-widest block mb-1">Overview</span>
                <h2 class="text-xl font-extrabold text-white">Your Salon at a Glance</h2>
                <div class="grid grid-cols-2 gap-3 mt-4">
                    ${statCard(`${periodLabel(activeTab)} Bookings`, filtered.length)}
                    ${statCard('Est. Revenue', formatCurrency(totalRevenue), 'text-emerald-400')}
                </div>
            </div>

            <div class="grid grid-cols-4 gap-2.5">
                ${quickAction('appointment', 'Book', 'calendar-plus', 'bg-brand-500/10 text-brand-400')}
                ${quickAction('customer', 'Client', 'user-plus', 'bg-indigo-500/10 text-indigo-400')}
                ${quickAction('service', 'Service', 'sparkle', 'bg-emerald-500/10 text-emerald-400')}
                ${quickAction('staff', 'Staff', 'user-check', 'bg-amber-500/10 text-amber-400')}
                ${quickAction('booking-link', 'Booking Link', 'link', 'bg-teal-500/10 text-teal-400')}
            </div>

            <div class="space-y-3">
                <div class="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-2xl p-1">
                    ${PERIODS.map((p) => `
                        <button data-action="dashboard-tab" data-period="${esc(p.key)}"
                            class="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-[11px] font-semibold transition touch-manipulation active:scale-[0.97] ${activeTab === p.key ? 'bg-brand-600 text-white shadow-lg shadow-brand-600/25' : 'text-slate-400 hover:text-slate-200'}">
                            <i data-lucide="${esc(p.icon)}" class="w-3.5 h-3.5"></i>
                            <span>${esc(p.label)}</span>
                        </button>
                    `).join('')}
                </div>

                <div class="flex items-center justify-between">
                    <h3 class="font-bold text-sm text-slate-200">${esc(periodLabel(activeTab))} Appointments</h3>
                    <span class="text-[10px] text-slate-500 font-medium">${filtered.length} booking${filtered.length !== 1 ? 's' : ''}</span>
                </div>

                ${filtered.length === 0
                    ? emptyState(activeTab === 'today' ? 'No appointments scheduled for today.' : `No appointments in ${esc(periodLabel(activeTab).toLowerCase())}.`)
                    : `
                        <div class="space-y-2.5">
                            ${filtered.map((a) => renderAppointmentCard(a)).join('')}
                        </div>
                    `}
            </div>
        </div>
    `;
}

export default renderDashboard;
