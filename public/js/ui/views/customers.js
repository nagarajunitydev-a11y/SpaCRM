/**
 * views/customers.js
 * Clients view with per-client edit/delete actions.
 */

import { esc } from '../../core/sanitize.js';
import { sectionHeader, actionButton, emptyState, iconAction } from '../components.js';
import { scopedBySalon } from '../../core/utils.js';

export function renderCustomers(state) {
    const customers = scopedBySalon(state.customersList, state.currentSalonId);

    return `
        <div class="space-y-4">
            ${sectionHeader(
                'Clients',
                '',
                actionButton('Add Client', { action: 'modal', data: { modal: 'customer' }, iconName: 'user-plus' }),
            )}

            <div class="relative">
                <input type="text" data-action="customer-search-list" placeholder="Search clients by name, phone, email…"
                    value=""
                    class="w-full bg-slate-900 border border-slate-800 pl-9 pr-9 py-2.5 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500 placeholder:text-slate-500">
                <i data-lucide="search" class="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"></i>
                <button data-action="clear-customer-search" aria-label="Clear search"
                    class="hidden absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-slate-800 text-slate-400 items-center justify-center hover:bg-slate-700 transition active:scale-95 touch-manipulation">
                    <i data-lucide="x" class="w-3 h-3"></i>
                </button>
            </div>

            <div data-customer-list>
                ${customers.length === 0
                    ? emptyState('No clients registered.')
                    : `
                        <div class="space-y-2.5">
                            ${customers.map((c) => renderCustomerCard(c)).join('')}
                        </div>
                    `}
            </div>
        </div>
    `;
}

export function renderCustomerCard(c) {
    return `
        <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
            <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                    <h4 class="font-bold text-sm text-slate-100 truncate">${esc(c.name)}</h4>
                    <p class="text-xs text-slate-400 mt-0.5 truncate">${esc(c.phone)}</p>
                    <p class="text-[10px] text-slate-500 mt-0.5 truncate">${esc(c.email)}</p>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                    ${iconAction('open-edit', { type: 'customer', id: c.id }, 'Edit client', 'pencil', 'bg-slate-800 hover:bg-slate-700 text-slate-300')}
                    ${iconAction('request-delete', { type: 'customer', id: c.id, label: c.name }, 'Delete client', 'trash-2', 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400')}
                </div>
            </div>
        </div>
    `;
}

export default renderCustomers;
