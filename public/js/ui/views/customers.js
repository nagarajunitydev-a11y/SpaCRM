/**
 * views/customers.js
 * Clients & referrals view: salon referral code, referral bonus program, reward
 * tiers, progress toward the next reward, and per-client share/redeem actions.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { sectionHeader, actionButton, emptyState, iconAction, statCard, badge } from '../components.js';
import { scopedBySalon } from '../../core/utils.js';
import {
    REWARD_TIERS,
    REFERRAL_SIGNUP_BONUS,
    REFERRAL_BONUS_POINTS,
    nextTierFor,
    progressFor,
} from '../../core/rewards.js';

const REFERRAL_STATUS_CLASSES = {
    'Bonus Credited': 'bg-emerald-500/15 text-emerald-400',
    Successful: 'bg-brand-500/15 text-brand-400',
    Pending: 'bg-amber-500/15 text-amber-400',
    Rejected: 'bg-rose-500/15 text-rose-400',
};

export function renderCustomers(state) {
    const customers = scopedBySalon(state.customersList, state.currentSalonId);

    return `
        <div class="space-y-4">
            ${sectionHeader(
                'Clients & Referrals',
                `${REFERRAL_SIGNUP_BONUS} bonus pts given on signup`,
                actionButton('Add Client', { action: 'modal', data: { modal: 'customer' }, iconName: 'user-plus' }),
            )}

            ${renderReferralSection(state)}

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

/** Salon owner referral overview: code, stats and activity for this salon. */
function renderReferralSection(state) {
    const salon = (state.salonsList || []).find((s) => s.id === state.currentSalonId);
    if (!salon) return '';
    const code = salon.referralCode || '';

    const referrals = (state.referralsList || []).filter((r) => r.referredSalonId === state.currentSalonId);
    const total = referrals.length;
    const successful = referrals.filter((r) => r.status === 'Successful' || r.status === 'Bonus Credited').length;
    const pending = referrals.filter((r) => r.status === 'Pending').length;
    const earned = referrals
        .filter((r) => r.status === 'Bonus Credited')
        .reduce((sum, r) => sum + (Number(r.bonusAmount) || 0), 0);

    return `
        <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
            <div class="flex items-center justify-between gap-3 mb-3">
                <h3 class="font-bold text-xs text-slate-100 flex items-center space-x-1.5">
                    <i data-lucide="megaphone" class="w-3.5 h-3.5 text-brand-400"></i>
                    <span>Referral Program</span>
                </h3>
                <div class="flex items-center gap-2 shrink-0">
                    <button data-action="show-referral-info" aria-label="How referrals work" title="How referrals work"
                        class="w-6 h-6 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center hover:bg-slate-700 transition active:scale-95 touch-manipulation">
                        <i data-lucide="info" class="w-3.5 h-3.5"></i>
                    </button>
                    <span class="text-[10px] text-slate-400 font-medium">Friends earn ${esc(REFERRAL_BONUS_POINTS)} bonus pts</span>
                </div>
            </div>

            <div class="flex items-center gap-3 bg-slate-950 border border-slate-800 rounded-xl p-3">
                <div class="min-w-0 flex-1">
                    <p class="text-[10px] text-slate-400 uppercase tracking-wider">Salon referral code</p>
                    <p class="font-mono font-bold text-base text-brand-400 mt-0.5 truncate">${esc(code)}</p>
                </div>
                <button data-action="copy-salon-code" data-code="${escAttr(code)}"
                    class="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-semibold rounded-xl transition active:scale-95 touch-manipulation flex items-center space-x-1.5 shrink-0">
                    <i data-lucide="copy" class="w-3.5 h-3.5"></i><span>Copy</span>
                </button>
                <button data-action="share-salon-code" data-code="${escAttr(code)}"
                    class="px-3 py-2 bg-brand-600 hover:bg-brand-500 text-white text-[10px] font-semibold rounded-xl transition active:scale-95 touch-manipulation flex items-center space-x-1.5 shrink-0">
                    <i data-lucide="share-2" class="w-3.5 h-3.5"></i><span>Share</span>
                </button>
            </div>

            <div class="grid grid-cols-2 gap-2 mt-3">
                ${statCard('Total Referrals', total)}
                ${statCard('Successful', successful, 'text-emerald-400')}
                ${statCard('Pending', pending, 'text-amber-400')}
                ${statCard('Bonus Earned (pts)', earned, 'text-brand-400')}
            </div>

            ${renderReferralActivity(referrals)}
        </div>
    `;
}

function renderReferralActivity(referrals) {
    if (referrals.length === 0) {
        return `<p class="text-[10px] text-slate-500 mt-3">No referrals yet — share your salon code so friends can earn bonus points.</p>`;
    }
    return `
        <div class="mt-3">
            <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Referral activity</p>
            <div class="space-y-2">
                ${referrals.map((r) => `
                    <div class="flex items-center justify-between gap-3 bg-slate-950/60 border border-slate-800/60 rounded-xl px-3 py-2.5">
                        <div class="min-w-0">
                            <p class="text-xs font-semibold text-slate-100 truncate">${esc(r.referredCustomerName || 'A friend')}</p>
                            <p class="text-[10px] text-slate-500 truncate">Referred by ${esc(r.referringCustomerName || 'a salon')} · ${esc(r.code)}</p>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                            ${badge(r.status, REFERRAL_STATUS_CLASSES[r.status] || 'bg-slate-500/15 text-slate-400')}
                            ${r.status === 'Pending'
                                ? `<button data-action="reject-referral" data-id="${escAttr(r.id)}" aria-label="Reject referral"
                                    class="px-2.5 py-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-[10px] font-semibold rounded-lg transition active:scale-95 touch-manipulation">Reject</button>`
                                : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
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
                <div class="flex items-center gap-2 shrink-0">
                    <button data-action="show-referral-info" aria-label="How rewards work" title="How rewards work"
                        class="w-6 h-6 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center hover:bg-slate-700 transition active:scale-95 touch-manipulation">
                        <i data-lucide="info" class="w-3.5 h-3.5"></i>
                    </button>
                    <span class="text-[10px] text-slate-400 font-medium">Redeem anytime</span>
                </div>
            </div>
            <div class="grid grid-cols-3 gap-2">
                ${REWARD_TIERS.map((t) => `
                    <div class="bg-slate-950/60 border border-slate-800/60 rounded-xl px-2 py-2.5 text-center">
                        <p class="text-[10px] font-extrabold text-brand-400">${esc(t.points)} pts</p>
                        <p class="text-[9px] text-slate-300 leading-tight mt-0.5">${esc(t.label)}</p>
                    </div>
                `).join('')}
            </div>
            <p class="text-[10px] text-slate-500 mt-2.5">Clients earn ${esc(REFERRAL_SIGNUP_BONUS)} points on signup and ${esc(REFERRAL_BONUS_POINTS)} more for every successful referral.</p>
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
                    ${c.referredByCode ? `<p class="text-[10px] text-brand-400/80 mt-0.5 truncate">Referred by ${esc(c.referringCustomerName || 'a salon')}</p>` : ''}
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