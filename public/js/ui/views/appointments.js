/**
 * views/appointments.js
 * Appointments list view.
 */

import { esc } from '../../core/sanitize.js';
import { sectionHeader, actionButton, badge, emptyState, iconAction } from '../components.js';
import { icon } from '../icons.js';
import { formatCurrency, scopedBySalon } from '../../core/utils.js';

const STATUS_CLASSES = {
    'Confirmed': 'bg-blue-500/15 text-blue-400',
    'In Progress': 'bg-amber-500/15 text-amber-400',
    'Completed': 'bg-emerald-500/15 text-emerald-400',
    'Cancelled': 'bg-rose-500/15 text-rose-400',
};

const PAYMENT_METHOD_LABELS = { cash: 'Cash', upi: 'UPI', card: 'Card', other: 'Other' };

function quickStatusButton(id, from, to, label, colors) {
    return `<button data-action="update-appointment-status" data-id="${esc(id)}" data-status="${esc(to)}"
        class="px-2 py-1 ${colors} text-[10px] font-semibold rounded-lg hover:opacity-80 transition active:scale-95 touch-manipulation">${esc(label)}</button>`;
}

export function renderAppointments(state) {
    const appointments = scopedBySalon(state.appointmentsList, state.currentSalonId);

    return `
        <div class="space-y-4">
            ${sectionHeader(
                'Appointments',
                'Manage client schedules & timings',
                actionButton('Book', { action: 'modal', data: { modal: 'appointment' }, iconName: 'plus' }),
            )}

            ${appointments.length === 0
                ? emptyState('No appointments found.')
                : `
                    <div class="space-y-2.5">
                        ${appointments.map((a) => `
                            <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center justify-between gap-3">
                                <div class="min-w-0 flex-1">
                                    <h4 class="font-bold text-sm text-slate-100 truncate">${esc(a.customerName)}</h4>
                                    <p class="text-xs text-slate-400 mt-0.5 truncate">${esc(a.serviceName)}</p>
                                    <p class="text-[11px] text-brand-400 font-medium mt-1 flex items-center gap-1"><i data-lucide="user" class="w-3 h-3 shrink-0"></i><span class="truncate">${esc(a.staffName)}</span></p>
                                    ${a.amount ? `<p class="text-[11px] text-emerald-400 font-semibold mt-1">${formatCurrency(a.amount)}${a.paid ? ' <span class="text-emerald-500/60">• Paid</span>' : ' <span class="text-amber-400/60">• Unpaid</span>'}</p>` : ''}
                                    ${a.paymentMethod ? `<p class="text-[10px] text-slate-500 mt-0.5">${PAYMENT_METHOD_LABELS[a.paymentMethod] || a.paymentMethod}</p>` : ''}
                                </div>
                                <div class="text-right shrink-0">
                                    <span class="text-xs font-bold text-slate-200 block">${esc(a.date)}</span>
                                    <span class="text-[11px] text-slate-400 block">${esc(a.time)}</span>
                                    <span class="inline-block mt-1">${badge(a.status, STATUS_CLASSES[a.status])}</span>
                                </div>
                                <div class="flex items-center flex-wrap gap-1 shrink-0">
                                    ${a.status === 'Confirmed' ? quickStatusButton(a.id, 'Confirmed', 'In Progress', 'Start', 'bg-blue-500/15 text-blue-400') : ''}
                                    ${a.status === 'In Progress' ? quickStatusButton(a.id, 'In Progress', 'Completed', 'Complete', 'bg-emerald-500/15 text-emerald-400') : ''}
                                    ${a.status !== 'Completed' && a.status !== 'Cancelled' ? iconAction('collect-payment', { id: a.id }, 'Collect Payment', 'indian-rupee', 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400') : ''}
                                    ${iconAction('open-edit', { type: 'appointment', id: a.id }, 'Edit appointment', 'pencil', 'bg-slate-800 hover:bg-slate-700 text-slate-300')}
                                    ${iconAction('request-delete', { type: 'appointment', id: a.id, label: a.customerName }, 'Delete appointment', 'trash-2', 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400')}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `}
        </div>
    `;
}

export default renderAppointments;
