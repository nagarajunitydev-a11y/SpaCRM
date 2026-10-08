/**
 * views/subscription.js
 * Subscription UI: plans page, current-plan summary (usage / renewal / trial
 * countdown / onboarding), payment history, locked-feature screen and the
 * trial / renewal reminder banner. Pure presentation — all gating decisions
 * come from `state.access` (core/featureAccess.js), all writes from main.js.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { sectionHeader } from '../components.js';
import { DEFAULT_PLANS, PLAN_IDS, FEATURES, planPrice, annualSavings, formatINR } from '../../core/plans.js';
import { lockInfo } from '../../core/featureAccess.js';

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

const STATUS_STYLE = {
    TRIAL: ['Free trial', 'bg-brand-500/15 text-brand-300'],
    ACTIVE: ['Active', 'bg-emerald-500/15 text-emerald-400'],
    PAST_DUE: ['Payment due', 'bg-amber-500/15 text-amber-400'],
    GRACE_PERIOD: ['Grace period', 'bg-amber-500/15 text-amber-400'],
    EXPIRED: ['Expired', 'bg-rose-500/15 text-rose-400'],
    SUSPENDED: ['Suspended', 'bg-rose-500/15 text-rose-400'],
    CANCELLED: ['Cancelled', 'bg-slate-700/50 text-slate-300'],
};

export const PAYMENT_STATUS_STYLE = {
    SUCCESS: 'bg-emerald-500/15 text-emerald-400',
    PENDING: 'bg-amber-500/15 text-amber-400',
    FAILED: 'bg-rose-500/15 text-rose-400',
    CANCELLED: 'bg-slate-700/50 text-slate-300',
    REFUNDED: 'bg-indigo-500/15 text-indigo-300',
};

function statusBadge(status) {
    const [label, cls] = STATUS_STYLE[status] || [status, 'bg-slate-700/50 text-slate-300'];
    return `<span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${cls}">${esc(label)}</span>`;
}

/* ------------------------------------------------------------------ */
/* Banner (rendered in the app shell)                                  */
/* ------------------------------------------------------------------ */

export function subscriptionBanner(state) {
    const a = state.access;
    if (!a || a.unrestricted || state.userRole !== 'salon_owner' || state.needsSalon) return '';
    let tone = null;
    let text = '';
    let cta = 'Upgrade';

    if (a.isTrial) {
        if (a.trialDaysLeft > 7) return '';
        tone = a.trialDaysLeft <= 3 ? 'rose' : 'amber';
        text = a.trialDaysLeft <= 1 ? 'Your free trial ends today.' : `Your free trial ends in ${a.trialDaysLeft} days.`;
    } else if (a.status === 'GRACE_PERIOD' || a.status === 'PAST_DUE') {
        tone = 'rose';
        text = 'Your subscription payment is overdue. Renew now to avoid losing access.';
        cta = 'Renew';
    } else if (a.status === 'EXPIRED') {
        tone = 'rose';
        text = 'Your plan has expired. Your data is safe and view-only — upgrade to keep working.';
    } else if (a.status === 'SUSPENDED') {
        tone = 'rose';
        text = 'This subscription is suspended. Please contact support.';
        cta = '';
    } else if (a.status === 'ACTIVE' && a.periodEnd) {
        const days = Math.ceil((a.periodEnd - Date.now()) / 86400000);
        if (days > 7) return '';
        tone = 'amber';
        text = days <= 0 ? 'Your plan renews today.' : `Your plan expires in ${days} day${days === 1 ? '' : 's'}.`;
        cta = 'Renew';
    } else {
        return '';
    }
    const cls = tone === 'rose' ? 'bg-rose-500/10 border-rose-500/30 text-rose-200' : 'bg-amber-500/10 border-amber-500/30 text-amber-100';
    return `
        <div data-subscription-banner class="${cls} border-b px-4 py-2 flex items-center justify-between gap-3 text-xs" role="status">
            <span class="min-w-0">${esc(text)}</span>
            ${cta ? `<button data-action="tab" data-tab="subscription" class="shrink-0 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-semibold active:scale-95 touch-manipulation">${esc(cta)}</button>` : ''}
        </div>
    `;
}

/* ------------------------------------------------------------------ */
/* Locked feature                                                      */
/* ------------------------------------------------------------------ */

export function lockedFeatureView(state, feature) {
    const info = lockInfo(state.access, feature);
    const title = info.expired ? 'Subscription expired' : `${info.label} is locked`;
    const body = info.expired
        ? 'Your data is safe. Upgrade your plan to use this feature again.'
        : `Available on the ${info.requiredPlanName} plan and above.`;
    return `
        <div data-locked-feature="${escAttr(feature)}" class="flex flex-col items-center justify-center text-center py-14 px-6">
            <div class="w-14 h-14 rounded-2xl bg-brand-500/10 text-brand-400 flex items-center justify-center mb-4"><i data-lucide="lock" class="w-7 h-7"></i></div>
            <h3 class="font-bold text-base text-slate-100 mb-1">${esc(title)}</h3>
            <p class="text-xs text-slate-400 mb-5 max-w-xs">${esc(body)}</p>
            <button data-action="select-plan" data-plan="${escAttr(info.requiredPlanId || 'standard')}"
                class="px-5 py-2.5 bg-brand-600 hover:bg-brand-500 text-white text-[13px] font-semibold rounded-xl shadow-lg shadow-brand-600/30 active:scale-95 touch-manipulation">
                ${info.requiredPlanId ? `Upgrade to ${esc(info.requiredPlanName)}` : 'View plans'}
            </button>
            <button data-action="tab" data-tab="subscription" class="mt-3 text-[11px] text-slate-400 hover:text-slate-200 underline">Compare all plans</button>
        </div>
    `;
}

/* ------------------------------------------------------------------ */
/* Onboarding progress (trial growth)                                  */
/* ------------------------------------------------------------------ */

export function onboardingSteps(state) {
    const sid = state.currentSalonId;
    const mine = (rows) => (rows || []).filter((r) => !r.salonId || r.salonId === sid);
    return [
        { key: 'staff', label: 'Add your staff', done: mine(state.staffList).length > 0, tab: 'staff' },
        { key: 'services', label: 'Add your services', done: mine(state.servicesList).length > 0, tab: 'services' },
        { key: 'customers', label: 'Add your first customers', done: mine(state.customersList).length > 0, tab: 'customers' },
        { key: 'appointments', label: 'Book an appointment', done: mine(state.appointmentsList).length > 0, tab: 'appointments' },
    ];
}

export function onboardingCard(state) {
    const a = state.access;
    if (state.mode === 'firebase' && state.currentUser && !state.subscription && !state.needsSalon) {
        return `<div data-trial-onboarding class="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-4 space-y-3">
            <p class="text-sm font-bold text-slate-100">Start your 30-day free trial</p>
            <p class="text-xs text-slate-400">Standard plan features. No payment or credit card required.</p>
            ${trialActivationButton(state)}
            ${trialActivationError(state)}
        </div>`;
    }
    if (!a || !a.isTrial || a.unrestricted) return '';
    const steps = onboardingSteps(state);
    const done = steps.filter((s) => s.done).length;
    if (done === steps.length) return '';
    return `
        <div data-onboarding class="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-4">
            <div class="flex items-center justify-between mb-2">
                <p class="text-xs font-bold text-slate-100">Get set up · ${done}/${steps.length}</p>
                <span class="text-[10px] text-brand-300 font-semibold">${a.trialDaysLeft} day${a.trialDaysLeft === 1 ? '' : 's'} left in trial</span>
            </div>
            <div class="h-1.5 bg-slate-800 rounded-full overflow-hidden mb-3"><div class="h-full bg-brand-500 rounded-full" style="width:${Math.round((done / steps.length) * 100)}%"></div></div>
            <div class="grid grid-cols-2 gap-2">
                ${steps.map((s) => `
                    <button data-action="tab" data-tab="${escAttr(s.tab)}" class="flex items-center gap-2 text-left text-[11px] ${s.done ? 'text-emerald-400' : 'text-slate-300 hover:text-white'} touch-manipulation">
                        <i data-lucide="${s.done ? 'check-circle-2' : 'circle'}" class="w-4 h-4 shrink-0"></i><span class="truncate">${esc(s.label)}</span>
                    </button>`).join('')}
            </div>
        </div>
    `;
}

function trialActivationButton(state) {
    return `<button type="button" data-action="start-trial" ${state.trialStarting ? 'disabled aria-busy="true"' : ''}
        class="w-full py-2.5 bg-brand-600 hover:bg-brand-500 text-white text-[13px] font-bold rounded-xl disabled:opacity-50 disabled:cursor-wait">
        ${state.trialStarting ? 'Activating free trial…' : 'Start 30 Days Free Trial'}</button>`;
}

function trialActivationError(state) {
    const error = state.trialError || state.subscriptionError;
    return error ? `<p data-trial-error role="alert" class="text-xs text-rose-400">${esc(error)}</p>` : '';
}

/* ------------------------------------------------------------------ */
/* Plans page                                                          */
/* ------------------------------------------------------------------ */

function usageBar(label, used, max) {
    const unlimited = max === null;
    const pct = unlimited ? 8 : Math.min(100, Math.round((used / Math.max(1, max)) * 100));
    const warn = !unlimited && pct >= 90;
    return `
        <div>
            <div class="flex justify-between text-[10px] text-slate-400 mb-1"><span>${esc(label)}</span><span>${used} / ${unlimited ? 'Unlimited' : max}</span></div>
            <div class="h-1.5 bg-slate-800 rounded-full overflow-hidden"><div class="h-full ${warn ? 'bg-rose-500' : 'bg-brand-500'} rounded-full" style="width:${pct}%"></div></div>
        </div>`;
}

function currentPlanCard(state) {
    const a = state.access;
    if (!a) return '';
    const plan = a.plan;
    const planName = a.unrestricted ? 'Demo (all features)' : (plan ? plan.name : 'No active plan');
    let line = '';
    if (a.isTrial) line = `${a.trialDaysLeft} day${a.trialDaysLeft === 1 ? '' : 's'} remaining in your free trial`;
    else if (a.periodEnd && ['ACTIVE', 'CANCELLED', 'PAST_DUE', 'GRACE_PERIOD'].includes(a.status)) line = `${a.billingCycle === 'annual' ? 'Annual' : 'Monthly'} · ${a.status === 'CANCELLED' ? 'ends' : 'renews'} ${fmtDate(a.periodEnd)}`;
    else if (a.status === 'EXPIRED') line = 'Your data is safe and view-only until you upgrade.';
    const limit = (k) => (plan ? a.limit(k) : 0);
    return `
        <div data-current-plan class="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                    <p class="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Current plan</p>
                    <h3 class="text-lg font-extrabold text-slate-100">${esc(planName)}</h3>
                    ${line ? `<p class="text-xs text-slate-400 mt-0.5">${esc(line)}</p>` : ''}
                </div>
                ${statusBadge(a.status)}
            </div>
            ${a.unrestricted ? '' : `
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                ${usageBar('Staff', a.usage.staff, limit('staff'))}
                ${usageBar('Customers', a.usage.customer, limit('customer'))}
                ${usageBar('Branches', a.usage.branch, plan && plan.features.includes('multiBranch') ? limit('branch') : 1)}
            </div>`}
        </div>`;
}

function featureList(plan) {
    // "Everything in <previous paid plan>, plus:" — Basic and the trial list everything.
    const prev = plan.paid ? Object.values(state_plans_cache).find((p) => p.paid && p.order === plan.order - 1) : null;
    const inherited = prev ? new Set(prev.features) : new Set();
    const mine = plan.features.filter((f) => !inherited.has(f));
    const shown = mine.slice(0, 9);
    return `
        <ul class="space-y-1.5 text-[11px] text-slate-300">
            ${prev ? `<li class="text-slate-500 font-semibold">Everything in ${esc(prev.name)}, plus:</li>` : ''}
            ${shown.map((f) => `<li class="flex items-start gap-1.5"><i data-lucide="check" class="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-px"></i><span>${esc(FEATURES[f] || f)}</span></li>`).join('')}
            ${mine.length > shown.length ? `<li class="text-slate-500">+ ${mine.length - shown.length} more</li>` : ''}
        </ul>`;
}
let state_plans_cache = DEFAULT_PLANS;

function limitsLine(plan) {
    const staff = plan.maxStaff === null ? 'Unlimited staff' : `${plan.maxStaff} staff`;
    const cust = plan.maxCustomers === null ? 'unlimited customers' : `${plan.maxCustomers.toLocaleString('en-IN')} customers`;
    return `${staff} · ${cust}`;
}

function planCard(plan, state, cycle) {
    const a = state.access;
    const isCurrent = a && !a.unrestricted && a.planId === plan.id && a.status !== 'EXPIRED' && a.status !== 'SUSPENDED';
    const popular = !!plan.popular;
    const price = planPrice(plan, cycle);
    const sub = state.subscription || state.effectiveSubscription;
    let priceHtml;
    if (!plan.paid) {
        priceHtml = `<span class="text-2xl font-extrabold text-slate-100">₹0</span><span class="text-[11px] text-slate-400"> · 30 days</span>`;
    } else {
        priceHtml = `<span class="text-2xl font-extrabold text-slate-100">${esc(formatINR(price))}</span><span class="text-[11px] text-slate-400"> / ${cycle === 'annual' ? 'year' : 'month'}</span>`;
    }
    const savings = plan.paid && cycle === 'annual' ? `<p class="text-[11px] text-emerald-400 font-semibold mt-0.5">Save ${esc(formatINR(annualSavings(plan)))} a year</p>` : (plan.paid ? `<p class="text-[11px] text-slate-500 mt-0.5">or ${esc(formatINR(plan.priceAnnual))}/year</p>` : `<p class="text-[11px] text-slate-500 mt-0.5">No credit card required</p>`);

    let cta;
    if (!plan.paid) {
        if (!sub) cta = trialActivationButton(state) + trialActivationError(state);
        else if (a && a.isTrial) cta = `<button disabled class="w-full py-2.5 bg-slate-800 text-slate-400 text-[13px] font-semibold rounded-xl">Trial active · ${a.trialDaysLeft}d left</button>`;
        else cta = `<button disabled class="w-full py-2.5 bg-slate-800 text-slate-500 text-[13px] font-semibold rounded-xl">Trial used</button>`;
    } else if (isCurrent) {
        cta = `<button data-action="select-plan" data-plan="${escAttr(plan.id)}" class="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-[13px] font-semibold rounded-xl active:scale-95 touch-manipulation">Renew</button>`;
    } else {
        const higher = a && a.plan && !a.isTrial && plan.order > a.plan.order;
        const label = !a || a.isTrial || a.locked || !a.plan ? 'Upgrade' : (higher ? 'Upgrade' : 'Switch plan');
        cta = `<button data-action="select-plan" data-plan="${escAttr(plan.id)}" class="w-full py-2.5 ${popular ? 'bg-brand-600 hover:bg-brand-500 shadow-lg shadow-brand-600/30 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-100'} text-[13px] font-bold rounded-xl active:scale-95 touch-manipulation">${esc(label)}</button>`;
    }

    return `
        <div data-plan-card="${escAttr(plan.id)}" class="relative bg-slate-900 border ${popular ? 'border-brand-500/70 shadow-xl shadow-brand-600/10' : isCurrent ? 'border-emerald-500/40' : 'border-slate-800'} rounded-2xl p-4 flex flex-col gap-3">
            ${popular ? '<span class="absolute -top-2.5 left-4 bg-brand-600 text-white text-[10px] font-bold px-2.5 py-0.5 rounded-full">⭐ Most Popular</span>' : ''}
            ${isCurrent ? '<span class="absolute -top-2.5 right-4 bg-emerald-500 text-slate-950 text-[10px] font-bold px-2.5 py-0.5 rounded-full">Current</span>' : ''}
            <div>
                <h4 class="font-extrabold text-sm text-slate-100">${esc(plan.name)}</h4>
                <p class="text-[11px] text-slate-500">${esc(plan.tagline || '')}</p>
            </div>
            <div>${priceHtml}${savings}</div>
            <p class="text-[11px] font-semibold text-slate-200">${esc(limitsLine(plan))}</p>
            ${cta}
            ${featureList(plan)}
        </div>`;
}

function paymentHistory(state) {
    const rows = state.subscriptionPayments || [];
    if (state.mode === 'demo' || (state.access && state.access.unrestricted)) return '';
    return `
        <section class="space-y-2">
            <h3 class="text-sm font-bold text-slate-100">Payment history</h3>
            ${rows.length === 0 ? '<p class="text-xs text-slate-500 bg-slate-900 border border-slate-800 rounded-2xl p-4">No subscription payments yet.</p>' : `
            <div class="bg-slate-900 border border-slate-800 rounded-2xl divide-y divide-slate-800" data-payment-history>
                ${rows.map((p) => `
                    <div class="p-3 flex items-center justify-between gap-3 text-xs" data-payment-row="${escAttr(p.id)}">
                        <div class="min-w-0">
                            <p class="font-semibold text-slate-100 truncate">${esc((DEFAULT_PLANS[p.planId] || {}).name || p.planId)} · ${p.billingCycle === 'annual' ? 'Annual' : 'Monthly'}</p>
                            <p class="text-[10px] text-slate-500 truncate">${esc(fmtDate(p.paidAt || p.createdAt))}${p.method ? ` · ${esc(String(p.method).toUpperCase())}` : ''}${p.receiptNumber ? ` · ${esc(p.receiptNumber)}` : ''}</p>
                            ${p.status === 'FAILED' && p.failureReason ? `<p class="text-[10px] text-rose-400 truncate">${esc(p.failureReason)}</p>` : ''}
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                            <span class="font-bold text-slate-100">${esc(formatINR(p.amount))}</span>
                            <span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full ${PAYMENT_STATUS_STYLE[p.status] || ''}">${esc(p.status)}</span>
                            ${p.status === 'SUCCESS' || p.status === 'REFUNDED' ? `<button data-action="view-receipt" data-id="${escAttr(p.id)}" class="text-brand-300 hover:text-brand-200 underline text-[10px]">Receipt</button>` : ''}
                        </div>
                    </div>`).join('')}
            </div>`}
        </section>`;
}

export function renderSubscription(state) {
    state_plans_cache = state.plansCatalog || DEFAULT_PLANS;
    const plans = state_plans_cache;
    const cycle = state.billingCycle === 'annual' ? 'annual' : 'monthly';
    const toggleBtn = (id, label, extra = '') => `<button data-action="billing-cycle" data-cycle="${id}" aria-pressed="${cycle === id}" class="px-4 py-1.5 rounded-lg text-xs font-semibold transition touch-manipulation ${cycle === id ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-slate-200'}">${label}${extra}</button>`;
    return `
        <div class="space-y-5" data-view="subscription">
            ${sectionHeader('Subscription', 'Plans built for salons in Tamil Nadu')}
            ${currentPlanCard(state)}
            ${onboardingCard(state)}
            <div class="flex justify-center">
                <div class="inline-flex bg-slate-900 border border-slate-800 rounded-xl p-1" role="group" aria-label="Billing cycle">
                    ${toggleBtn('monthly', 'Monthly')}${toggleBtn('annual', 'Annual', ' <span class="text-[9px] font-bold text-emerald-400 ml-1">2 months free</span>')}
                </div>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 pt-2">
                ${PLAN_IDS.map((id) => planCard(plans[id], state, cycle)).join('')}
            </div>
            ${paymentHistory(state)}
        </div>`;
}

/* ------------------------------------------------------------------ */
/* Receipt modal body                                                  */
/* ------------------------------------------------------------------ */

export function renderReceipt(state) {
    const p = state.modalRecord;
    if (!p) return '<p class="text-xs text-slate-400">Receipt not found.</p>';
    const row = (k, v) => `<div class="flex justify-between gap-3 py-1.5 border-b border-slate-800 text-xs"><span class="text-slate-400">${esc(k)}</span><span class="text-slate-100 font-semibold text-right break-all">${esc(v)}</span></div>`;
    return `
        <div data-receipt class="space-y-3">
            <div class="text-center pb-2">
                <p class="text-[10px] uppercase tracking-widest text-slate-500">Receipt</p>
                <p class="text-xl font-extrabold text-slate-100">${esc(formatINR(p.amount))}</p>
                <span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded-full ${PAYMENT_STATUS_STYLE[p.status] || ''}">${esc(p.status)}</span>
            </div>
            ${row('Receipt no.', p.receiptNumber || '—')}
            ${row('Plan', `${(DEFAULT_PLANS[p.planId] || {}).name || p.planId} (${p.billingCycle})`)}
            ${row('Paid on', fmtDate(p.paidAt))}
            ${row('Service period', `${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)}`)}
            ${row('Method', p.method ? String(p.method).toUpperCase() : '—')}
            ${row('Gateway', p.paymentGateway || '—')}
            ${row('Order ID', p.orderId)}
            ${row('Payment ID', p.gatewayPaymentId || '—')}
            ${p.refundedAmount ? row('Refunded', formatINR(p.refundedAmount)) : ''}
            <button type="button" data-action="print-receipt" class="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-semibold rounded-xl active:scale-95 touch-manipulation">Print / Save PDF</button>
        </div>`;
}

export default renderSubscription;
