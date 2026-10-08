/**
 * views/adminSubscriptions.js
 * Super Admin: every subscription (status, usage), payments (with a failed
 * filter), subscription events, and the editable plan catalog.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { sectionHeader } from '../components.js';
import { DEFAULT_PLANS, PLAN_IDS, FEATURES, formatINR } from '../../core/plans.js';
import { effectiveStatus } from '../../core/subscriptionState.js';
import { PAYMENT_STATUS_STYLE } from './subscription.js';

const fmt = (ms) => (ms ? new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtD = (ms) => (ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const uidOfPath = (p) => (p || '').split('/')[1] || '—';

const STATUS_CLS = {
    TRIAL: 'bg-brand-500/15 text-brand-300', ACTIVE: 'bg-emerald-500/15 text-emerald-400',
    PAST_DUE: 'bg-amber-500/15 text-amber-400', GRACE_PERIOD: 'bg-amber-500/15 text-amber-400',
    EXPIRED: 'bg-rose-500/15 text-rose-400', SUSPENDED: 'bg-rose-500/15 text-rose-400', CANCELLED: 'bg-slate-700/50 text-slate-300',
};
const badge = (s) => `<span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full ${STATUS_CLS[s] || 'bg-slate-700/50 text-slate-300'}">${esc(s)}</span>`;

function tabs(active) {
    const t = [['subscriptions', 'Subscriptions'], ['payments', 'Payments'], ['events', 'Events'], ['plans', 'Plans']];
    return `<div class="flex gap-1 bg-slate-900 border border-slate-800 rounded-xl p-1 overflow-x-auto no-scrollbar" role="tablist">
        ${t.map(([id, label]) => `<button role="tab" aria-selected="${active === id}" data-action="admin-sub-tab" data-sub-tab="${id}" class="px-3.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap touch-manipulation ${active === id ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}">${label}</button>`).join('')}
    </div>`;
}

function subscriptionsTab(state) {
    const rows = state.adminSubscriptions || [];
    if (!state.adminSubscriptionsLoaded) return '<p class="text-xs text-slate-400 p-4">Loading subscriptions…</p>';
    if (state.adminSubscriptionsError) return `<p class="text-xs text-rose-400 p-4">${esc(state.adminSubscriptionsError)}</p>`;
    const now = Date.now();
    const withStatus = rows.map((r) => ({ ...r, eff: effectiveStatus(r, now) }));
    const count = (s) => withStatus.filter((r) => r.eff === s).length;
    const tile = (label, n) => `<div class="bg-slate-900 border border-slate-800 rounded-xl p-3"><p class="text-[10px] text-slate-500 uppercase tracking-wider">${label}</p><p class="text-xl font-extrabold text-slate-100">${n}</p></div>`;
    return `
        <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
            ${tile('Trial', count('TRIAL'))}${tile('Active', count('ACTIVE'))}${tile('Overdue', count('GRACE_PERIOD') + count('PAST_DUE'))}${tile('Expired', count('EXPIRED'))}${tile('Suspended', count('SUSPENDED'))}
        </div>
        ${withStatus.length === 0 ? '<p class="text-xs text-slate-500 p-4">No subscriptions yet.</p>' : `
        <div class="space-y-2" data-admin-subscriptions>
            ${withStatus.map((r) => `
                <div class="bg-slate-900 border border-slate-800 rounded-2xl p-3 flex items-center justify-between gap-3 text-xs" data-subscription-row="${escAttr(r.id)}">
                    <div class="min-w-0">
                        <p class="font-bold text-slate-100 truncate">${esc(r.ownerEmail || r.id)}</p>
                        <p class="text-[10px] text-slate-500 truncate">${esc((DEFAULT_PLANS[r.planId] || {}).name || r.planId)}${r.billingCycle ? ` · ${esc(r.billingCycle)}` : ''} · ${r.planId === 'trial' ? `trial ends ${fmtD(r.trialEndsAt)}` : `period ends ${fmtD(r.currentPeriodEnd)}`}</p>
                        <p class="text-[10px] text-slate-500">Usage: ${r.usage ? `${r.usage.staff || 0} staff · ${r.usage.customer || 0} customers · ${r.usage.branch || 0} branches` : 'n/a'}</p>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        ${badge(r.eff)}
                        <button data-action="admin-toggle-suspend" data-id="${escAttr(r.id)}" data-suspended="${r.status === 'SUSPENDED'}" class="px-2.5 py-1.5 rounded-lg text-[10px] font-semibold ${r.status === 'SUSPENDED' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'} touch-manipulation">${r.status === 'SUSPENDED' ? 'Reactivate' : 'Suspend'}</button>
                    </div>
                </div>`).join('')}
        </div>`}`;
}

function paymentsTab(state) {
    const filter = state.adminPaymentFilter || 'all';
    let rows = [...(state.adminPayments || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (filter === 'failed') rows = rows.filter((p) => p.status === 'FAILED');
    const fbtn = (id, label) => `<button data-action="admin-payment-filter" data-filter="${id}" aria-pressed="${filter === id}" class="px-3 py-1 rounded-lg text-[11px] font-semibold touch-manipulation ${filter === id ? 'bg-slate-700 text-white' : 'bg-slate-900 border border-slate-800 text-slate-400'}">${label}</button>`;
    return `
        <div class="flex gap-2">${fbtn('all', 'All')}${fbtn('failed', 'Failed')}</div>
        ${rows.length === 0 ? '<p class="text-xs text-slate-500 p-4">No payments to show.</p>' : `
        <div class="bg-slate-900 border border-slate-800 rounded-2xl divide-y divide-slate-800" data-admin-payments>
            ${rows.map((p) => `
                <div class="p-3 flex items-center justify-between gap-3 text-xs">
                    <div class="min-w-0">
                        <p class="font-semibold text-slate-100 truncate">${esc((DEFAULT_PLANS[p.planId] || {}).name || p.planId)} · ${esc(p.billingCycle || '')} · ${esc(formatINR(p.amount))}</p>
                        <p class="text-[10px] text-slate-500 truncate">${esc(fmt(p.createdAt))} · owner ${esc(uidOfPath(p._path))} · ${esc(p.orderId)}${p.method ? ` · ${esc(p.method)}` : ''}</p>
                        ${p.failureReason ? `<p class="text-[10px] text-rose-400 truncate">${esc(p.failureReason)}</p>` : ''}
                    </div>
                    <span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full shrink-0 ${PAYMENT_STATUS_STYLE[p.status] || ''}">${esc(p.status)}</span>
                </div>`).join('')}
        </div>`}`;
}

function eventsTab(state) {
    const rows = [...(state.adminEvents || [])].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 200);
    return rows.length === 0 ? '<p class="text-xs text-slate-500 p-4">No events yet.</p>' : `
        <div class="bg-slate-900 border border-slate-800 rounded-2xl divide-y divide-slate-800" data-admin-events>
            ${rows.map((e) => `<div class="p-3 text-xs flex items-center justify-between gap-3"><div class="min-w-0"><p class="font-semibold text-slate-100">${esc(e.type)}</p><p class="text-[10px] text-slate-500 truncate">owner ${esc(uidOfPath(e._path))} · ${esc(e.detail || '')}</p></div><span class="text-[10px] text-slate-500 shrink-0">${esc(fmt(e.at))}</span></div>`).join('')}
        </div>`;
}

function plansTab(state) {
    const plans = state.plansCatalog || DEFAULT_PLANS;
    const seeded = (state.plansRows || []).length;
    return `
        <div class="flex items-center justify-between gap-2">
            <p class="text-[11px] text-slate-400">${seeded ? `${seeded} plan(s) customised in Firestore.` : 'Using built-in defaults. Edit a plan to save it to Firestore.'}</p>
            <button data-action="admin-seed-plans" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold rounded-lg touch-manipulation">Save all defaults</button>
        </div>
        <div class="grid gap-2 sm:grid-cols-2" data-admin-plans>
            ${PLAN_IDS.map((id) => {
                const p = plans[id];
                const lim = (v) => (v === null ? '∞' : v);
                return `<div class="bg-slate-900 border border-slate-800 rounded-2xl p-3 flex items-center justify-between gap-3 text-xs">
                    <div class="min-w-0"><p class="font-bold text-slate-100">${esc(p.name)}</p>
                    <p class="text-[10px] text-slate-500">${p.paid ? `${esc(formatINR(p.priceMonthly))}/mo · ${esc(formatINR(p.priceAnnual))}/yr` : 'Free'} · ${lim(p.maxStaff)} staff · ${lim(p.maxCustomers)} customers · ${lim(p.maxBranches)} branch(es) · ${p.features.length} features</p></div>
                    <button data-action="open-plan-editor" data-plan="${escAttr(id)}" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-semibold rounded-lg touch-manipulation shrink-0">Edit</button>
                </div>`;
            }).join('')}
        </div>`;
}

export function renderAdminSubscriptions(state) {
    const tab = state.adminSubTab || 'subscriptions';
    const body = { subscriptions: subscriptionsTab, payments: paymentsTab, events: eventsTab, plans: plansTab }[tab](state);
    return `
        <div class="space-y-4" data-view="admin-subscriptions">
            ${sectionHeader('Subscriptions', 'Plans, payments and billing events')}
            ${tabs(tab)}
            ${body}
        </div>`;
}

/** Modal body for editing one plan. */
export function renderPlanEditor(state) {
    const plans = state.plansCatalog || DEFAULT_PLANS;
    const p = plans[state.modalRecord && state.modalRecord.planId];
    if (!p) return '<p class="text-xs text-slate-400">Plan not found.</p>';
    const num = (name, label, v, hint = '') => `<label class="block text-[11px] text-slate-400">${label}<input name="${name}" type="number" min="0" step="1" value="${v === null || v === undefined ? '' : escAttr(v)}" placeholder="${hint}" class="mt-1 w-full bg-slate-950 border border-slate-800 px-3 py-2.5 rounded-xl text-xs text-slate-100"></label>`;
    return `
        <form data-action="submit-plan" class="space-y-3" novalidate>
            <input type="hidden" name="planId" value="${escAttr(p.id)}">
            <label class="block text-[11px] text-slate-400">Name<input name="name" value="${escAttr(p.name)}" class="mt-1 w-full bg-slate-950 border border-slate-800 px-3 py-2.5 rounded-xl text-xs text-slate-100"></label>
            <label class="block text-[11px] text-slate-400">Tagline<input name="tagline" value="${escAttr(p.tagline || '')}" class="mt-1 w-full bg-slate-950 border border-slate-800 px-3 py-2.5 rounded-xl text-xs text-slate-100"></label>
            <div class="grid grid-cols-2 gap-3">
                ${num('priceMonthly', 'Monthly price (₹)', p.priceMonthly)}${num('priceAnnual', 'Annual price (₹)', p.priceAnnual)}
                ${num('maxStaff', 'Max staff', p.maxStaff, 'blank = unlimited')}${num('maxCustomers', 'Max customers', p.maxCustomers, 'blank = unlimited')}
                ${num('maxBranches', 'Max branches', p.maxBranches, 'blank = unlimited')}
            </div>
            <fieldset class="space-y-1"><legend class="text-[11px] text-slate-400 mb-1">Features</legend>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-52 overflow-y-auto no-scrollbar">
                    ${Object.entries(FEATURES).map(([k, label]) => `<label class="flex items-center gap-2 text-[11px] text-slate-300"><input type="checkbox" name="feature_${k}" ${p.features.includes(k) ? 'checked' : ''}> ${esc(label)}</label>`).join('')}
                </div>
            </fieldset>
            <button type="submit" class="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs rounded-xl active:scale-[0.98] touch-manipulation">Save plan</button>
        </form>`;
}

export default renderAdminSubscriptions;
