/**
 * views/services.js
 * Services & pricing view.
 */

import { esc } from '../../core/sanitize.js';
import { sectionHeader, actionButton, emptyState, iconAction } from '../components.js';
import { formatCurrency, scopedBySalon } from '../../core/utils.js';

export function renderServices(state) {
    const services = scopedBySalon(state.servicesList, state.currentSalonId);

    return `
        <div class="space-y-4">
            ${sectionHeader(
                'Services & Pricing',
                'Treatments and salon packages',
                actionButton('Add Service', { action: 'modal', data: { modal: 'service' }, iconName: 'plus' }),
            )}

            ${services.length === 0
                ? emptyState('No services in the catalog yet.')
                : `
                    <div class="grid grid-cols-1 gap-2.5">
                        ${services.map((s) => `
                            <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center justify-between gap-3">
                                <div class="min-w-0 flex-1">
                                    <h4 class="font-bold text-sm text-slate-100 truncate">${esc(s.name)}</h4>
                                    <p class="text-xs text-slate-400 mt-0.5 flex items-center gap-1"><i data-lucide="clock" class="w-3 h-3 shrink-0"></i><span class="truncate">${esc(s.duration)}</span></p>
                                </div>
                                <span class="text-base font-extrabold text-brand-400 shrink-0">${esc(formatCurrency(s.price))}</span>
                                <div class="flex items-center space-x-1.5 shrink-0">
                                    ${iconAction('open-edit', { type: 'service', id: s.id }, 'Edit service', 'pencil', 'bg-slate-800 hover:bg-slate-700 text-slate-300')}
                                    ${iconAction('request-delete', { type: 'service', id: s.id, label: s.name }, 'Delete service', 'trash-2', 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400')}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `}
        </div>
    `;
}

export default renderServices;
