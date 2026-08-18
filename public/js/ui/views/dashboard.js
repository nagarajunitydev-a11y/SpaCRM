/**
 * views/dashboard.js
 * Owner dashboard: overview stats, quick actions, and appointment views
 * filtered by Today / Current Month / Previous Month.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { statCard, quickAction, badge, emptyState, sectionHeader } from '../components.js';
import { formatCurrency, scopedBySalon } from '../../core/utils.js';

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

function computeRevenue(appointments) {
    const completed = appointments.filter((a) => a.status === 'Completed');
    const cancelled = appointments.filter((a) => a.status === 'Cancelled');
    const unpaidCompleted = completed.filter((a) => !a.paid);

    const grossServiceSales = completed.reduce((s, a) => s + (Number(a.amount) || 0), 0);
    const totalDiscounts = completed.reduce((s, a) => s + (Number(a.discount) || 0), 0);
    const totalLoyalty = completed.reduce((s, a) => s + (Number(a.loyaltyRedemption) || 0), 0);
    const totalTax = completed.reduce((s, a) => s + (Number(a.tax) || 0), 0);
    const totalRefunds = completed.reduce((s, a) => s + (Number(a.refund) || 0), 0);
    const totalCoupons = completed.filter((a) => a.couponCode).length;

    const paid = completed.filter((a) => a.paid);
    const cashReceived = paid.filter((a) => a.paymentMethod === 'cash').reduce((s, a) => s + (Number(a.amount) || 0), 0);
    const upiReceived = paid.filter((a) => a.paymentMethod === 'upi').reduce((s, a) => s + (Number(a.amount) || 0), 0);
    const cardReceived = paid.filter((a) => a.paymentMethod === 'card').reduce((s, a) => s + (Number(a.amount) || 0), 0);
    const otherReceived = paid.filter((a) => a.paymentMethod === 'other').reduce((s, a) => s + (Number(a.amount) || 0), 0);
    const totalReceived = paid.reduce((s, a) => s + (Number(a.amount) || 0), 0);

    const outstanding = unpaidCompleted.reduce((s, a) => s + (Number(a.amount) || 0), 0);
    const cancelledAmount = cancelled.reduce((s, a) => s + (Number(a.amount) || 0), 0);

    return {
        grossServiceSales, totalDiscounts, totalLoyalty, totalTax, totalRefunds,
        totalCoupons, cashReceived, upiReceived, cardReceived, otherReceived,
        totalReceived, outstanding, cancelledAmount,
        completedCount: completed.length,
        paidCount: paid.length,
        unpaidCount: unpaidCompleted.length,
        cancelledCount: cancelled.length,
    };
}

function revenueRow(label, value, valueClass = 'text-slate-200') {
    return `
        <div class="flex items-center justify-between py-1.5">
            <span class="text-[11px] text-slate-400">${esc(label)}</span>
            <span class="text-[11px] font-semibold ${escAttr(valueClass)}">${esc(value)}</span>
        </div>
    `;
}

function renderAppointmentCard(a) {
    return `
        <div class="bg-slate-900 border border-slate-800/80 p-3.5 rounded-2xl flex items-center justify-between shadow-sm">
            <div class="min-w-0 pr-3">
                <h4 class="font-bold text-xs text-slate-200 truncate">${esc(a.customerName)}</h4>
                <p class="text-[11px] text-slate-400 mt-0.5 truncate">${esc(a.serviceName)} <span class="text-brand-400 font-medium">• ${esc(a.staffName)}</span></p>
                ${a.amount ? `<p class="text-[10px] text-emerald-400 font-medium mt-1">${formatCurrency(a.amount)}${a.paid ? ' • Paid' : ' • Unpaid'}</p>` : ''}
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
    const activeTab = state.dashboardTab || 'today';
    const filtered = filterByPeriod(allAppointments, activeTab);
    const rev = computeRevenue(filtered);

    return `
        <div class="space-y-5">
            <div class="bg-gradient-to-br from-slate-900 to-slate-900/60 border border-slate-800/80 p-5 rounded-3xl relative overflow-hidden shadow-xl">
                <div class="absolute right-0 top-0 w-32 h-32 bg-brand-500/10 rounded-full blur-2xl pointer-events-none" aria-hidden="true"></div>
                <span class="text-[10px] font-bold text-brand-400 uppercase tracking-widest block mb-1">Overview</span>
                <h2 class="text-xl font-extrabold text-white">Your Salon at a Glance</h2>
                <div class="grid grid-cols-2 gap-3 mt-4">
                    ${statCard(`${periodLabel(activeTab)} Bookings`, filtered.length)}
                    ${statCard('Actual Revenue', formatCurrency(rev.totalReceived), 'text-emerald-400')}
                </div>
            </div>

            <div class="bg-slate-900 border border-slate-800/80 p-4 rounded-2xl space-y-1">
                <p class="text-[10px] font-bold text-brand-400 uppercase tracking-widest mb-2">${esc(periodLabel(activeTab))} Revenue Summary</p>
                ${revenueRow('Gross Service Sales', formatCurrency(rev.grossServiceSales))}
                ${revenueRow('Discounts', rev.totalDiscounts > 0 ? '-' + formatCurrency(rev.totalDiscounts) : formatCurrency(0), 'text-amber-400')}
                ${revenueRow('Coupons Applied', rev.totalCoupons > 0 ? rev.totalCoupons + ' coupon(s)' : '—')}
                ${revenueRow('Loyalty Redemptions', rev.totalLoyalty > 0 ? '-' + formatCurrency(rev.totalLoyalty) : formatCurrency(0), 'text-violet-400')}
                ${revenueRow('GST / Taxes', formatCurrency(rev.totalTax), 'text-slate-400')}
                ${revenueRow('Refunds', rev.totalRefunds > 0 ? '-' + formatCurrency(rev.totalRefunds) : formatCurrency(0), 'text-rose-400')}
                ${revenueRow('Cancelled / Unpaid', rev.cancelledCount > 0 ? rev.cancelledCount + ' (' + formatCurrency(rev.cancelledAmount) + ')' : '—', 'text-rose-400')}
                <div class="h-px bg-slate-800 my-1"></div>
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-2 mb-1">Payment Breakdown</p>
                ${revenueRow('Cash Received', formatCurrency(rev.cashReceived), 'text-emerald-400')}
                ${revenueRow('UPI Received', formatCurrency(rev.upiReceived), 'text-emerald-400')}
                ${revenueRow('Card Received', formatCurrency(rev.cardReceived), 'text-emerald-400')}
                ${revenueRow('Other Payments', formatCurrency(rev.otherReceived), 'text-emerald-400')}
                <div class="h-px bg-slate-800 my-1"></div>
                ${revenueRow('Total Actual Received', formatCurrency(rev.totalReceived), 'text-emerald-400 font-bold')}
                ${revenueRow('Outstanding Amount', formatCurrency(rev.outstanding), 'text-amber-400')}
                <div class="flex items-center gap-2 mt-2 pt-2 border-t border-slate-800">
                    <span class="text-[10px] text-slate-500">${rev.paidCount} paid</span>
                    <span class="text-[10px] text-slate-600">•</span>
                    <span class="text-[10px] text-slate-500">${rev.unpaidCount} unpaid</span>
                    <span class="text-[10px] text-slate-600">•</span>
                    <span class="text-[10px] text-slate-500">${rev.cancelledCount} cancelled</span>
                </div>
            </div>

            <div class="grid grid-cols-4 gap-2.5">
                ${quickAction('appointment', 'Book', 'calendar-plus', 'bg-brand-500/10 text-brand-400')}
                ${quickAction('customer', 'Client', 'user-plus', 'bg-indigo-500/10 text-indigo-400')}
                ${quickAction('service', 'Service', 'sparkle', 'bg-emerald-500/10 text-emerald-400')}
                ${quickAction('staff', 'Staff', 'user-check', 'bg-amber-500/10 text-amber-400')}
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
