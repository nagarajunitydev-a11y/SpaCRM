/**
 * views/referrals.js
 * Owner Referral Management: the referral list (with search, status filters
 * and a performance summary) and the Referral Settings form.
 *
 * Presentation only. Every number shown here comes from core/referral.js and
 * every write is dispatched through the central delegation in main.js — this
 * module contains no business rules of its own.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { sectionHeader, emptyState, badge, formField, textInput, selectControl } from '../components.js';
import { formatCurrency } from '../../core/utils.js';
import {
    REFERRAL_STATUS_ORDER,
    REFERRAL_STATUS_CLASSES,
    REWARD_TYPES,
    REWARD_TRIGGERS,
    REWARD_TRIGGER_LABELS,
    summarizeReferrals,
    remainingReward,
    sanitizeSettings,
} from '../../core/referral.js';

/**
 * Search text lives outside the store on purpose: writing it to the store on
 * every keystroke would re-render the shell and steal focus from the input
 * (the same reason core/draft.js exists for long forms).
 */
let searchQuery = '';

export function getReferralSearch() {
    return searchQuery;
}

export function setReferralSearch(value) {
    searchQuery = String(value || '');
}

/** Referrals of the active salon, newest first. */
export function referralRows(state) {
    return [...(state.referralsList || [])].sort((a, b) =>
        String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/** Apply the active status filter and the search query. */
export function filterReferrals(rows, { status = 'all', query = '' } = {}) {
    const q = String(query || '').trim().toLowerCase();
    return (rows || []).filter((r) => {
        if (status !== 'all' && r.status !== status) return false;
        if (!q) return true;
        return [r.referrerName, r.referredName, r.code, r.qualifyingInvoiceNo, r.status]
            .some((field) => String(field || '').toLowerCase().includes(q));
    });
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

function summaryPanel(rows) {
    const s = summarizeReferrals(rows);
    const tile = (label, value, cls = 'text-white') => `
        <div class="bg-slate-950/60 border border-slate-800/60 p-3 rounded-2xl">
            <p class="text-[10px] text-slate-400 font-medium">${esc(label)}</p>
            <p class="text-lg font-extrabold mt-0.5 ${escAttr(cls)}">${esc(value)}</p>
        </div>
    `;

    return `
        <div class="bg-gradient-to-br from-slate-900 to-slate-900/60 border border-slate-800/80 p-5 rounded-3xl relative overflow-hidden shadow-xl">
            <div class="absolute right-0 top-0 w-32 h-32 bg-brand-500/10 rounded-full blur-2xl pointer-events-none" aria-hidden="true"></div>
            <span class="text-[10px] font-bold text-brand-400 uppercase tracking-widest block mb-1">Performance</span>
            <h2 class="text-lg font-extrabold text-white">Referral Programme</h2>
            <div class="grid grid-cols-2 gap-2.5 mt-4">
                ${tile('Total referrals', s.total)}
                ${tile('Successful', s.successful, 'text-emerald-400')}
                ${tile('Pending', s.pending, 'text-amber-400')}
                ${tile('Conversion', `${s.conversionRate}%`, 'text-indigo-400')}
                ${tile('Rewards credited', formatCurrency(s.rewardCredited), 'text-emerald-400')}
                ${tile('Wallet outstanding', formatCurrency(s.rewardOutstanding), 'text-brand-400')}
            </div>
        </div>
    `;
}

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */

function dateOnly(iso) {
    return iso ? String(iso).slice(0, 10) : '';
}

export function referralCard(r) {
    const remaining = remainingReward(r);
    const reward = Number(r.rewardAmount) || 0;

    const money = reward > 0
        ? `<p class="text-[11px] text-emerald-400 font-semibold mt-1">${esc(formatCurrency(reward))} reward${remaining > 0 && remaining !== reward ? ` <span class="text-slate-400 font-medium">• ${esc(formatCurrency(remaining))} left</span>` : ''}</p>`
        : '<p class="text-[11px] text-slate-500 mt-1">Reward not earned yet</p>';

    const invoice = r.qualifyingInvoiceNo
        ? `<p class="text-[10px] text-slate-500 mt-0.5 truncate">Invoice ${esc(r.qualifyingInvoiceNo)} • ${esc(formatCurrency(r.qualifyingInvoiceAmount))}</p>`
        : '';

    const expiry = r.expiresAt && remaining > 0
        ? `<p class="text-[10px] text-amber-400/80 mt-0.5">Expires ${esc(dateOnly(r.expiresAt))}</p>`
        : '';

    const reversal = r.reversalReason
        ? `<p class="text-[10px] text-rose-400/80 mt-0.5 truncate">${esc(r.reversalReason)}</p>`
        : '';

    return `
        <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
            <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                    <h4 class="font-bold text-sm text-slate-100 truncate">${esc(r.referrerName || 'Unknown referrer')}</h4>
                    <p class="text-[11px] text-slate-400 mt-0.5 flex items-center gap-1 truncate">
                        <i data-lucide="arrow-right" class="w-3 h-3 shrink-0 text-brand-400"></i>
                        <span class="truncate">${esc(r.referredName || 'Unknown client')}</span>
                    </p>
                    <p class="text-[10px] text-slate-500 mt-0.5 font-mono tracking-wider">${esc(r.code || '')}</p>
                    ${money}
                    ${invoice}
                    ${expiry}
                    ${reversal}
                </div>
                <div class="text-right shrink-0">
                    ${badge(r.status, REFERRAL_STATUS_CLASSES[r.status] || 'bg-slate-500/15 text-slate-300')}
                    <span class="text-[10px] text-slate-500 block mt-1">${esc(dateOnly(r.createdAt))}</span>
                </div>
            </div>
        </div>
    `;
}

/** The filtered list body — re-rendered in place by the search handler. */
export function renderReferralListBody(rows) {
    if (!rows || rows.length === 0) {
        return emptyState('No referrals match the current filters.');
    }
    return `<div class="space-y-2.5">${rows.map((r) => referralCard(r)).join('')}</div>`;
}

function filterChips(active) {
    const options = [{ key: 'all', label: 'All' }, ...REFERRAL_STATUS_ORDER.map((s) => ({ key: s, label: s }))];
    return `
        <div class="flex items-center gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 py-0.5">
            ${options.map((o) => `
                <button data-action="referral-filter" data-status="${escAttr(o.key)}"
                    class="shrink-0 px-3 py-1.5 rounded-xl text-[11px] font-semibold transition touch-manipulation active:scale-95 ${active === o.key ? 'bg-brand-600 text-white shadow-lg shadow-brand-600/25' : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200'}">
                    ${esc(o.label)}
                </button>
            `).join('')}
        </div>
    `;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function toggleRow(name, label, hint, checked) {
    return `
        <label class="flex items-start justify-between gap-3 bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3.5 cursor-pointer">
            <span class="min-w-0">
                <span class="block text-xs font-bold text-slate-100">${esc(label)}</span>
                <span class="block text-[10px] text-slate-400 mt-0.5">${esc(hint)}</span>
            </span>
            <input type="checkbox" name="${escAttr(name)}" ${checked ? 'checked' : ''}
                class="mt-0.5 w-5 h-5 shrink-0 rounded-md bg-slate-950 border border-slate-700 accent-brand-500 cursor-pointer">
        </label>
    `;
}

export function renderReferralSettings(settings) {
    const s = sanitizeSettings(settings);
    const isPercent = s.rewardType === REWARD_TYPES.PERCENT;

    return `
        <form data-action="submit-referral-settings" class="space-y-3.5" novalidate>
            ${toggleRow('enabled', 'Referral programme', 'Turn the whole programme on or off for this salon.', s.enabled)}

            ${formField('Reward Type', selectControl('rewardType', [
                { value: REWARD_TYPES.FIXED, label: 'Fixed amount (₹)' },
                { value: REWARD_TYPES.PERCENT, label: 'Percentage of invoice (%)' },
            ], '', { value: s.rewardType }))}

            <div>
                <label class="block text-[11px] font-semibold text-slate-400 uppercase mb-1">
                    Reward Value <span data-reward-value-unit>${esc(isPercent ? '(%)' : '(₹)')}</span>
                </label>
                ${textInput('rewardValue', isPercent ? '10' : '100', { type: 'number', className: 'input-number', value: s.rewardValue })}
                <p class="mt-1 text-[10px] text-slate-500">A fixed reward is a flat amount; a percentage reward is a share of the qualifying invoice.</p>
            </div>

            ${formField('Reward Cap (₹)', textInput('maxRewardAmount', '0', { type: 'number', required: false, className: 'input-number', value: s.maxRewardAmount }), 'Upper limit for percentage rewards. 0 means no cap.')}

            ${formField('Minimum Qualifying Invoice (₹)', textInput('minInvoiceAmount', '500', { type: 'number', className: 'input-number', value: s.minInvoiceAmount }), 'Invoices below this total never earn a referral reward.')}

            ${formField('Reward Trigger', selectControl('rewardTrigger', [
                { value: REWARD_TRIGGERS.INVOICE_PAID, label: REWARD_TRIGGER_LABELS[REWARD_TRIGGERS.INVOICE_PAID] },
                { value: REWARD_TRIGGERS.APPOINTMENT_COMPLETED, label: REWARD_TRIGGER_LABELS[REWARD_TRIGGERS.APPOINTMENT_COMPLETED] },
            ], '', { value: s.rewardTrigger }))}

            ${formField('Reward Expiry (days)', textInput('expiryDays', '90', { type: 'number', className: 'input-number', value: s.expiryDays }), 'Unspent referral credit expires after this many days. 0 means never.')}

            ${formField('Max Redemption per Invoice (%)', textInput('maxRedemptionPercent', '50', { type: 'number', className: 'input-number', value: s.maxRedemptionPercent }), 'The largest share of any single invoice that may be paid from the referral wallet.')}

            <button type="submit" class="w-full py-3.5 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none">Save Referral Settings</button>
        </form>
    `;
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function renderReferrals(state) {
    const tab = state.referralTab === 'settings' ? 'settings' : 'list';
    const rows = referralRows(state);
    const activeFilter = state.referralStatusFilter || 'all';
    const filtered = filterReferrals(rows, { status: activeFilter, query: searchQuery });

    const tabs = [
        { key: 'list', label: 'Referrals', icon: 'users' },
        { key: 'settings', label: 'Settings', icon: 'settings' },
    ];

    const body = tab === 'settings'
        ? renderReferralSettings(state.referralSettings)
        : `
            ${summaryPanel(rows)}

            <div class="relative">
                <input type="text" data-action="referral-search" placeholder="Search referrer, client, code, invoice…"
                    value="${escAttr(searchQuery)}"
                    class="w-full bg-slate-900 border border-slate-800 pl-9 pr-3 py-2.5 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500 placeholder:text-slate-500">
                <i data-lucide="search" class="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"></i>
            </div>

            ${filterChips(activeFilter)}

            <div class="flex items-center justify-between">
                <h3 class="font-bold text-sm text-slate-200">Referral list</h3>
                <span class="text-[10px] text-slate-500 font-medium">${filtered.length} of ${rows.length}</span>
            </div>

            <div data-referral-list>${renderReferralListBody(filtered)}</div>
        `;

    return `
        <div class="space-y-4">
            ${sectionHeader('Referrals', 'Track referrals, rewards & programme rules')}

            <div class="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-2xl p-1">
                ${tabs.map((t) => `
                    <button data-action="referral-tab" data-referral-tab="${escAttr(t.key)}"
                        class="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-[11px] font-semibold transition touch-manipulation active:scale-[0.97] ${tab === t.key ? 'bg-brand-600 text-white shadow-lg shadow-brand-600/25' : 'text-slate-400 hover:text-slate-200'}">
                        <i data-lucide="${escAttr(t.icon)}" class="w-3.5 h-3.5"></i>
                        <span>${esc(t.label)}</span>
                    </button>
                `).join('')}
            </div>

            ${body}
        </div>
    `;
}

export default renderReferrals;
