/**
 * views/dashboard.js
 * Owner dashboard: overview stats, quick actions, recent appointments.
 */

import { esc } from '../../core/sanitize.js';
import { statCard, quickAction, badge, emptyState } from '../components.js';
import { formatCurrency, scopedBySalon } from '../../core/utils.js';

export function renderDashboard(state) {
    const appointments = scopedBySalon(state.appointmentsList, state.currentSalonId);
    const estRevenue = appointments.length * 85;

    return `
        <div class="space-y-5">
            <div class="bg-gradient-to-br from-slate-900 to-slate-900/60 border border-slate-800/80 p-5 rounded-3xl relative overflow-hidden shadow-xl">
                <div class="absolute right-0 top-0 w-32 h-32 bg-brand-500/10 rounded-full blur-2xl pointer-events-none" aria-hidden="true"></div>
                <span class="text-[10px] font-bold text-brand-400 uppercase tracking-widest block mb-1">Overview Today</span>
                <h2 class="text-xl font-extrabold text-white">Your Salon at a Glance</h2>
                <div class="grid grid-cols-2 gap-3 mt-4">
                    ${statCard('Bookings', appointments.length)}
                    ${statCard('Est. Revenue', formatCurrency(estRevenue), 'text-emerald-400')}
                </div>
            </div>

            <div class="grid grid-cols-4 gap-2.5">
                ${quickAction('appointment', 'Book', 'calendar-plus', 'bg-brand-500/10 text-brand-400')}
                ${quickAction('customer', 'Client', 'user-plus', 'bg-indigo-500/10 text-indigo-400')}
                ${quickAction('service', 'Service', 'sparkle', 'bg-emerald-500/10 text-emerald-400')}
                ${quickAction('staff', 'Staff', 'user-check', 'bg-amber-500/10 text-amber-400')}
            </div>

            <div class="space-y-3">
                <div class="flex items-center justify-between">
                    <h3 class="font-bold text-sm text-slate-200">Recent Appointments</h3>
                    <button data-action="tab" data-tab="appointments" class="text-xs text-brand-400 font-semibold active:scale-95 touch-manipulation">View All</button>
                </div>
                ${appointments.length === 0
                    ? emptyState('No active appointments yet.')
                    : `
                        <div class="space-y-2.5">
                            ${appointments.slice(0, 4).map((a) => `
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
                            `).join('')}
                        </div>
                    `}
            </div>
        </div>
    `;
}

export default renderDashboard;
