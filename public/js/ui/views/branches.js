/**
 * views/branches.js
 * Owner "Branches" page: list, add, edit, activate/deactivate and switch.
 * Pure presentation — rules live in core/branches.js, writes in main.js.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { sectionHeader, actionButton, emptyState } from '../components.js';
import { isBranchActive } from '../../core/branches.js';

function planSummary(branches, access) {
    if (!access || access.unrestricted) return `${branches.length} branch${branches.length === 1 ? '' : 'es'}`;
    const plan = access.plan;
    const multi = plan && plan.features.includes('multiBranch');
    const limit = multi ? access.limit('branch') : 1;
    return `${plan ? plan.name : 'No active'} plan · ${branches.length} of ${limit === null ? 'unlimited' : limit} branch${limit === 1 ? '' : 'es'} used`;
}

function branchCard(branch, state) {
    const active = isBranchActive(branch);
    const current = branch.id === state.currentSalonId;
    const hours = branch.openTime && branch.closeTime ? `${branch.openTime} – ${branch.closeTime}` : 'Hours not set';
    const btn = 'px-3 py-2 text-[10px] font-semibold rounded-xl transition shrink-0 active:scale-95 touch-manipulation';
    return `
        <div class="bg-slate-900 border ${current ? 'border-brand-500/60' : 'border-slate-800'} p-4 rounded-2xl space-y-3" data-branch-id="${escAttr(branch.id)}">
            <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                    <h4 class="font-bold text-sm text-slate-100 truncate">${esc(branch.name)}</h4>
                    <p class="text-xs text-slate-400 mt-0.5 flex items-center gap-1 truncate"><i data-lucide="map-pin" class="w-3 h-3 shrink-0"></i><span class="truncate">${esc(branch.address || '—')}</span></p>
                    <p class="text-[10px] text-slate-500 mt-0.5">${esc(branch.phone || '—')} · ${esc(hours)}</p>
                </div>
                <div class="flex flex-col items-end gap-1 shrink-0">
                    <span class="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${active ? 'bg-emerald-500/15 text-emerald-400' : 'bg-slate-700/40 text-slate-400'}">${active ? 'Active' : 'Inactive'}</span>
                    ${current ? '<span class="text-[9px] font-bold uppercase tracking-wider text-brand-400">Current</span>' : ''}
                </div>
            </div>
            <div class="flex flex-wrap gap-2">
                ${active && !current ? `<button data-action="switch-branch" data-id="${escAttr(branch.id)}" class="${btn} bg-brand-600 hover:bg-brand-500 text-white">Switch</button>` : ''}
                <button data-action="open-edit" data-type="salon" data-id="${escAttr(branch.id)}" class="${btn} bg-slate-800 hover:bg-slate-700 text-slate-200">Edit</button>
                <button data-action="toggle-branch" data-id="${escAttr(branch.id)}" class="${btn} ${active ? 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400' : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400'}">${active ? 'Deactivate' : 'Activate'}</button>
            </div>
        </div>
    `;
}

export function renderBranches(state) {
    const branches = state.salonsList || [];
    const gate = state.access ? state.access.canCreate('branch') : { ok: true };
    const canAdd = gate.ok;
    // The button stays visible after the first branch exists. At the plan's
    // limit it still renders (so the owner learns why) and explains on click.
    const addBtn = actionButton('Add Branch', {
        action: 'add-branch',
        iconName: 'plus',
        kind: canAdd ? 'primary' : 'ghost',
    });

    return `
        <div class="space-y-4">
            ${sectionHeader('Branches', planSummary(branches, state.access), addBtn)}
            ${branches.length === 0
                ? emptyState('No branches yet.')
                : `<div class="space-y-2.5 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0">${branches.map((b) => branchCard(b, state)).join('')}</div>`}
            ${canAdd ? '' : `<p data-branch-limit class="text-[11px] text-amber-400/90">${esc(gate.reason)} <button data-action="select-plan" data-plan="${escAttr(gate.requiredPlan ? gate.requiredPlan.id : 'business')}" class="underline font-semibold">Upgrade</button></p>`}
        </div>
    `;
}

export default renderBranches;
