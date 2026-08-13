/**
 * views/admin.js
 * Super Admin: global salon network overview + branch provisioning.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { sectionHeader, actionButton, emptyState } from '../components.js';
import { icon } from '../icons.js';

export function renderSuperAdmin(state) {
    const salons = state.salonsList || [];

    return `
        <div class="space-y-4">
            ${sectionHeader(
                'All Salons Franchise',
                'Super Admin Global Network Overview',
                actionButton('Add Salon', { action: 'modal', data: { modal: 'salon' }, iconName: 'plus', kind: 'ghost' }),
            )}

            ${salons.length === 0
                ? emptyState('No salons have been provisioned yet.')
                : `
                    <div class="space-y-2.5">
                        ${salons.map((salon) => `
                            <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center justify-between gap-3">
                                <div class="min-w-0">
                                    <h4 class="font-bold text-sm text-slate-100 truncate">${esc(salon.name)}</h4>
                                    <p class="text-xs text-slate-400 mt-0.5 flex items-center gap-1 truncate"><i data-lucide="map-pin" class="w-3 h-3 shrink-0"></i><span class="truncate">${esc(salon.address || 'Online Studio')}</span></p>
                                    <p class="text-[10px] text-slate-500 mt-0.5 truncate">${esc(salon.ownerEmail)}</p>
                                </div>
                                <button data-action="manage-salon" data-id="${escAttr(salon.id)}" data-name="${escAttr(salon.name)}"
                                    class="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-semibold rounded-xl transition shadow shrink-0 active:scale-95 touch-manipulation">
                                    Manage
                                </button>
                            </div>
                        `).join('')}
                    </div>
                `}
        </div>
    `;
}

export default renderSuperAdmin;
