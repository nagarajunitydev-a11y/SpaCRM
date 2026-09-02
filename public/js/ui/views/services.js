/**
 * views/services.js
 * Services & pricing view.
 */

import { esc } from '../../core/sanitize.js';
import { sectionHeader, actionButton, emptyState, iconAction, badge } from '../components.js';
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

            <button data-action="modal" data-modal="service-catalogue"
                class="w-full py-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-xs font-semibold rounded-xl transition active:scale-[0.98] touch-manipulation flex items-center justify-center gap-1.5">
                <i data-lucide="book-open" class="w-3.5 h-3.5"></i><span>Import From Catalogue</span>
            </button>

            ${services.length === 0
                ? emptyState('No services in the catalog yet.')
                : `
                    <div class="grid grid-cols-1 gap-2.5">
                        ${services.map((s) => {
                            const disabled = s.active === false;
                            return `
                            <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center justify-between gap-3 ${disabled ? 'opacity-60' : ''}">
                                <div class="min-w-0 flex-1">
                                    <h4 class="font-bold text-sm text-slate-100 truncate">${esc(s.name)}</h4>
                                    <p class="text-xs text-slate-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                                        ${s.category ? badge(s.category, 'bg-brand-500/15 text-brand-400') : ''}
                                        <span class="flex items-center gap-1"><i data-lucide="clock" class="w-3 h-3 shrink-0"></i><span class="truncate">${esc(s.duration)}</span></span>
                                        ${disabled ? badge('Disabled', 'bg-slate-700/40 text-slate-400') : ''}
                                    </p>
                                </div>
                                <span class="text-base font-extrabold text-brand-400 shrink-0">${esc(formatCurrency(s.price))}</span>
                                <div class="flex items-center space-x-1.5 shrink-0">
                                    ${iconAction('toggle-service-active', { id: s.id }, disabled ? 'Enable service' : 'Disable service', disabled ? 'eye' : 'eye-off', 'bg-slate-800 hover:bg-slate-700 text-slate-300')}
                                    ${iconAction('open-edit', { type: 'service', id: s.id }, 'Edit service', 'pencil', 'bg-slate-800 hover:bg-slate-700 text-slate-300')}
                                    ${iconAction('request-delete', { type: 'service', id: s.id, label: s.name }, 'Delete service', 'trash-2', 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400')}
                                </div>
                            </div>
                        `;
                        }).join('')}
                    </div>
                `}
        </div>
    `;
}

export default renderServices;
