/**
 * views/customerProfile.js
 * Client profile sheet: referral code, referral performance, wallet balance
 * and the full referral + wallet history for one client.
 *
 * Every figure is derived by the pure helpers in core/referral.js and
 * core/wallet.js from the records already in the store, so this view never
 * computes money of its own.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { emptyState, badge } from '../components.js';
import { formatCurrency } from '../../core/utils.js';
import {
    REFERRAL_STATUS_CLASSES,
    customerReferralStats,
    remainingReward,
    round2,
    num,
    sanitizeSettings,
} from '../../core/referral.js';
import { WALLET_TX_LABELS } from '../../core/wallet.js';

function statTile(label, value, cls = 'text-white') {
    return `
        <div class="bg-slate-950/60 border border-slate-800/60 p-3 rounded-2xl">
            <p class="text-[10px] text-slate-400 font-medium">${esc(label)}</p>
            <p class="text-base font-extrabold mt-0.5 ${escAttr(cls)}">${esc(value)}</p>
        </div>
    `;
}

function referralRow(r) {
    const remaining = remainingReward(r);
    return `
        <div class="flex items-center justify-between gap-3 bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3">
            <div class="min-w-0">
                <p class="text-xs font-bold text-slate-100 truncate">${esc(r.referredName || 'Referred client')}</p>
                <p class="text-[10px] text-slate-500 mt-0.5">${esc(String(r.createdAt || '').slice(0, 10))}${r.qualifyingInvoiceNo ? ` • ${esc(r.qualifyingInvoiceNo)}` : ''}</p>
                ${remaining > 0 ? `<p class="text-[10px] text-brand-400 mt-0.5 font-semibold">${esc(formatCurrency(remaining))} available</p>` : ''}
            </div>
            <div class="text-right shrink-0">
                ${badge(r.status, REFERRAL_STATUS_CLASSES[r.status] || 'bg-slate-500/15 text-slate-300')}
                <span class="text-[10px] text-emerald-400 block mt-1 font-semibold">${esc(formatCurrency(r.rewardAmount || 0))}</span>
            </div>
        </div>
    `;
}

function walletRow(tx) {
    const credit = tx.direction === 'credit';
    return `
        <div class="flex items-center justify-between gap-3 bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3">
            <div class="min-w-0">
                <p class="text-[11px] font-semibold text-slate-200 truncate">${esc(WALLET_TX_LABELS[tx.type] || tx.type)}</p>
                <p class="text-[10px] text-slate-500 mt-0.5 truncate">${esc(String(tx.createdAt || '').slice(0, 10))}${tx.invoiceNo ? ` • ${esc(tx.invoiceNo)}` : ''}</p>
                <p class="text-[10px] text-slate-500 mt-0.5">${esc(formatCurrency(tx.balanceBefore))} → ${esc(formatCurrency(tx.balanceAfter))}</p>
            </div>
            <span class="text-xs font-extrabold shrink-0 ${credit ? 'text-emerald-400' : 'text-rose-400'}">${credit ? '+' : '−'}${esc(formatCurrency(tx.amount))}</span>
        </div>
    `;
}

export function renderCustomerProfile(state) {
    const record = state.modalRecord || {};
    const customer = (state.customersList || []).find((c) => c.id === record.id) || record;
    if (!customer || !customer.id) {
        return '<p class="text-xs text-slate-400">This client is no longer available.</p>';
    }

    const stats = customerReferralStats(customer.id, state.referralsList || []);
    const walletRows = (state.walletTransactionsList || [])
        .filter((tx) => tx.customerId === customer.id)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    const balance = round2(Math.max(0, num(customer.walletBalance)));
    const canRedeem = balance > 0 && sanitizeSettings(state.referralSettings).enabled;
    const code = customer.referralCode || '';
    const referredBy = customer.referredByCode
        ? `<p class="text-[10px] text-slate-500 mt-2">Referred with code <span class="font-mono text-slate-400">${esc(customer.referredByCode)}</span></p>`
        : '';

    const codeBlock = code
        ? `
            <div class="bg-brand-500/10 border border-brand-500/25 rounded-2xl p-4 text-center">
                <p class="text-[10px] font-bold text-brand-300 uppercase tracking-widest">Referral code</p>
                <p class="text-2xl font-extrabold text-white font-mono tracking-[0.2em] mt-1">${esc(code)}</p>
                <button type="button" data-action="copy-referral-code" data-code="${escAttr(code)}"
                    class="mt-2.5 px-3 py-1.5 bg-brand-600 hover:bg-brand-500 text-white text-[10px] font-semibold rounded-xl transition active:scale-95 touch-manipulation inline-flex items-center gap-1.5">
                    <i data-lucide="copy" class="w-3 h-3"></i><span>Copy code to share</span>
                </button>
                ${referredBy}
            </div>
        `
        : `
            <div class="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-4 text-center">
                <p class="text-[11px] text-slate-400">No referral code yet.</p>
                <button type="button" data-action="generate-referral-code" data-id="${escAttr(customer.id)}"
                    class="mt-2.5 px-3 py-1.5 bg-brand-600 hover:bg-brand-500 text-white text-[10px] font-semibold rounded-xl transition active:scale-95 touch-manipulation">Generate referral code</button>
                ${referredBy}
            </div>
        `;

    return `
        <div class="space-y-4">
            <div class="text-center">
                <p class="text-sm font-extrabold text-slate-100">${esc(customer.name)}</p>
                <p class="text-[11px] text-slate-400 mt-0.5">${esc(customer.phone || 'No phone on file')}</p>
            </div>

            ${codeBlock}

            <div class="grid grid-cols-2 gap-2.5">
                ${statTile('Total referrals', stats.total)}
                ${statTile('Successful', stats.successful, 'text-emerald-400')}
                ${statTile('Pending', stats.pending, 'text-amber-400')}
                ${statTile('Referral balance', formatCurrency(balance), 'text-brand-400')}
                ${statTile('Rewards earned', formatCurrency(stats.rewardsEarned), 'text-emerald-400')}
                ${statTile('Rewards redeemed', formatCurrency(stats.rewardsRedeemed), 'text-slate-300')}
            </div>

            <button type="button" data-action="redeem-referral-balance" data-id="${escAttr(customer.id)}" ${canRedeem ? '' : 'disabled'}
                class="w-full py-3 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/25 transition active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none">
                Redeem Referral Balance
            </button>
            ${canRedeem ? '<p class="-mt-2 text-center text-[10px] text-slate-500">Apply this balance to one of this client\'s unpaid appointments.</p>' : '<p class="-mt-2 text-center text-[10px] text-slate-500">A referral balance is required before it can be redeemed.</p>'}

            <div class="space-y-2">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Referral history</p>
                ${stats.referrals.length === 0
                    ? emptyState('This client has not referred anyone yet.')
                    : `<div class="space-y-2">${[...stats.referrals]
                        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
                        .map((r) => referralRow(r)).join('')}</div>`}
            </div>

            <div class="space-y-2">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Wallet transactions</p>
                ${walletRows.length === 0
                    ? emptyState('No referral wallet activity yet.')
                    : `<div class="space-y-2">${walletRows.map((tx) => walletRow(tx)).join('')}</div>`}
            </div>
        </div>
    `;
}

export default renderCustomerProfile;
