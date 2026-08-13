/**
 * views/staff.js
 * Staff team view.
 */

import { esc } from '../../core/sanitize.js';
import { sectionHeader, actionButton, emptyState, iconAction } from '../components.js';
import { initials, scopedBySalon } from '../../core/utils.js';

export function renderStaff(state) {
    const staff = scopedBySalon(state.staffList, state.currentSalonId);

    return `
        <div class="space-y-4">
            ${sectionHeader(
                'Staff Team',
                'Beauty experts & stylists',
                actionButton('Add Staff', { action: 'modal', data: { modal: 'staff' }, iconName: 'user-plus' }),
            )}

            ${staff.length === 0
                ? emptyState('No staff members registered yet.')
                : `
                    <div class="grid grid-cols-1 gap-2.5">
                        ${staff.map((st) => `
                            <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center space-x-3.5">
                                <div class="w-11 h-11 rounded-2xl bg-brand-500/15 text-brand-400 flex items-center justify-center font-bold text-base shrink-0" aria-hidden="true">
                                    ${esc(initials(st.name))}
                                </div>
                                <div class="min-w-0 flex-1">
                                    <h4 class="font-bold text-sm text-slate-100 truncate">${esc(st.name)}</h4>
                                    <p class="text-xs text-brand-400 font-medium truncate">${esc(st.role)}</p>
                                    <p class="text-[10px] text-slate-400 mt-0.5 truncate">${esc(st.phone)}</p>
                                </div>
                                <div class="flex items-center space-x-1.5 shrink-0">
                                    ${iconAction('open-edit', { type: 'staff', id: st.id }, 'Edit staff', 'pencil', 'bg-slate-800 hover:bg-slate-700 text-slate-300')}
                                    ${iconAction('request-delete', { type: 'staff', id: st.id, label: st.name }, 'Delete staff', 'trash-2', 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400')}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `}
        </div>
    `;
}

export default renderStaff;
