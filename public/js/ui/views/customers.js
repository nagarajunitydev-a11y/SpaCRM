/**
 * views/customers.js
 * Clients & referrals view: referral bonus program, reward tiers, progress
 * toward the next reward, and per-client share/redeem actions.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { sectionHeader, actionButton, emptyState, iconAction } from '../components.js';
import { scopedBySalon } from '../../core/utils.js';
import {
    REWARD_TIERS,
    REFERRAL_SIGNUP_BONUS,
    nextTierFor,
    progressFor,
} from '../../core/rewards.js';

export function renderCustomers(state) {
    const customers = scopedBySalon(state.customersList, state.currentSalonId);

    return `
        <div class="space-y-4">
            ${sectionHeader(
                'Clients & Referrals',
                `${REFERRAL_SIGNUP_BONUS} bonus pts given on signup`,
                actionButton('Add Client', { action: 'modal', data: { modal: 'customer' }, iconName: 'user-plus' }),
            )}

            ${renderRewardsProgram()}

            ${customers.length === 0
                ? emptyState('No clients registered.')
                : `
                    <div class="space-y-2.5">
                        ${customers.map((c) => renderCustomerCard(c)).join('')}
                    </div>
                `}
        </div>
    `;
}

/** Compact program overview: the reward tiers as chips. */
function renderRewardsProgram() {
    return `
        <div class="bg-gradient-to-br from-brand-900/40 to-slate-900 border border-brand-500/20 p-4 rounded-2xl">
            <div class="flex items-center justify-between mb-3">
                <h3 class="font-bold text-xs text-slate-100 flex items-center space-x-1.5">
                    <i data-lucide="gift" class="w-3.5 h-3.5 text-brand-400"></i>
                    <span>Referral Rewards Program</span>
                </h3>
                <span class="text-[10px] text-slate-400 font-medium">Redeem anytime</span>
            </div>
            <div class="grid grid-cols-3 gap-2">
                ${REWARD_TIERS.map((t) => `
                    <div class="bg-slate-950/60 border border-slate-800/60 rounded-xl px-2 py-2.5 text-center">
                        <p class="text-[10px] font-extrabold text-brand-400">${esc(t.points)} pts</p>
                        <p class="text-[9px] text-slate-300 leading-tight mt-0.5">${esc(t.label)}</p>
                    </div>
                `).join('')}
            </div>
            <p class="text-[10px] text-slate-500 mt-2.5">Clients earn ${esc(REFERRAL_SIGNUP_BONUS)} points on signup and more for every successful referral.</p>
        </div>
    `;
}

function renderCustomerCard(c) {
    const pts = Number(c.referralPoints) || 0;
    const next = nextTierFor(pts);
    const progress = progressFor(pts);
    const ptsToNext = next ? next.points - pts : 0;

    return `
        <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
            <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                    <h4 class="font-bold text-sm text-slate-100 truncate">${esc(c.name)}</h4>
                    <p class="text-xs text-slate-400 mt-0.5 truncate">${esc(c.phone)}</p>
                    <p class="text-[10px] text-slate-500 mt-0.5 truncate">${esc(c.email)}</p>
                </div>
                <div class="bg-brand-500/15 text-brand-400 px-2.5 py-1 rounded-xl text-xs font-bold shrink-0">${esc(pts)} pts</div>
            </div>

            <div class="mt-3">
                <div class="flex items-center justify-between mb-1">
                    <span class="text-[10px] text-slate-400 font-medium">
                        ${next ? `Next reward: <span class="text-brand-400 font-semibold">${esc(next.label)}</span>` : 'Max reward reached!'}
                    </span>
                    <span class="text-[10px] text-slate-500">${next ? `${esc(ptsToNext)} pts to go` : ''}</span>
                </div>
                <div class="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden" role="progressbar" aria-valuenow="${escAttr(progress)}" aria-valuemin="0" aria-valuemax="100">
                    <div class="h-full bg-gradient-to-r from-brand-600 to-brand-400 rounded-full transition-all" style="width:${escAttr(progress)}%"></div>
                </div>
            </div>

            <div class="flex items-center gap-2 mt-3.5">
                <button data-action="redeem" data-id="${escAttr(c.id)}" data-name="${escAttr(c.name)}"
                    class="flex-1 px-3 py-2 bg-brand-600 hover:bg-brand-500 text-white text-[10px] font-semibold rounded-xl transition active:scale-95 touch-manipulation flex items-center justify-center space-x-1.5">
                    <i data-lucide="gift" class="w-3.5 h-3.5"></i><span>Redeem Reward</span>
                </button>
                <button data-action="share-referral" data-id="${escAttr(c.id)}" aria-label="Share referral"
                    class="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-semibold rounded-xl transition active:scale-95 touch-manipulation flex items-center space-x-1.5">
                    <i data-lucide="share-2" class="w-3.5 h-3.5"></i><span>Share</span>
                </button>
                ${iconAction('open-edit', { type: 'customer', id: c.id }, 'Edit client', 'pencil', 'bg-slate-800 hover:bg-slate-700 text-slate-300')}
                ${iconAction('request-delete', { type: 'customer', id: c.id, label: c.name }, 'Delete client', 'trash-2', 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400')}
            </div>
        </div>
    `;
}

export default renderCustomers;