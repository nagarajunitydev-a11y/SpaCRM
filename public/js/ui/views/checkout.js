/**
 * views/checkout.js
 * Subscription checkout page: order summary, billing cycle, payment-method
 * selection and the payment result. The amount shown here is a preview from
 * the same pure quote function the server uses; the amount actually charged is
 * always recomputed by the server.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { DEFAULT_PLANS, planPrice, annualSavings, formatINR, INDIA_TAX_STATES } from '../../core/plans.js';
import { quotePurchase } from '../../core/subscriptionState.js';
import { PAYMENT_METHODS } from '../../services/payment/index.js';
import { isNativePaymentContext } from '../../core/platform.js';

function resultPanel(c) {
    const cfg = {
        SUCCESS: ['check-circle-2', 'text-emerald-400', 'bg-emerald-500/10', 'Payment successful'],
        PENDING: ['clock', 'text-amber-400', 'bg-amber-500/10', 'Confirming your payment'],
        FAILED: ['x-circle', 'text-rose-400', 'bg-rose-500/10', 'Payment failed'],
        CANCELLED: ['slash', 'text-slate-300', 'bg-slate-700/40', 'Payment cancelled'],
        UNAVAILABLE: ['wifi-off', 'text-amber-400', 'bg-amber-500/10', 'Payments unavailable'],
    }[c.step];
    if (!cfg) return '';
    const [ic, tone, bg, title] = cfg;
    const retry = ['FAILED', 'CANCELLED', 'UNAVAILABLE'].includes(c.step);
    return `
        <div data-checkout-result="${escAttr(c.step)}" class="${bg} border border-slate-800 rounded-2xl p-6 text-center space-y-3" role="alert">
            <i data-lucide="${ic}" class="w-10 h-10 ${tone} mx-auto"></i>
            <h3 class="font-bold text-base text-slate-100">${esc(title)}</h3>
            <p class="text-xs text-slate-300 max-w-sm mx-auto">${esc(c.message || '')}</p>
            <div class="flex flex-col sm:flex-row gap-2 justify-center pt-1">
                ${c.step === 'SUCCESS' || c.step === 'PENDING' ? `<button data-action="tab" data-tab="subscription" class="px-5 py-2.5 bg-brand-600 hover:bg-brand-500 text-white text-[13px] font-semibold rounded-xl active:scale-95 touch-manipulation">View my plan</button>` : ''}
                ${retry ? `<button data-action="checkout-reset" class="px-5 py-2.5 bg-brand-600 hover:bg-brand-500 text-white text-[13px] font-semibold rounded-xl active:scale-95 touch-manipulation">${c.step === 'UNAVAILABLE' ? 'Back' : 'Try again'}</button>` : ''}
                ${retry ? `<button data-action="tab" data-tab="subscription" class="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-[13px] font-semibold rounded-xl active:scale-95 touch-manipulation">Back to plans</button>` : ''}
            </div>
        </div>`;
}

export function renderCheckout(state) {
    // Android app: purchases go through Google Play's billing flow (with its
    // user-choice screen); older app versions without it stay purchase-free.
    const inApp = isNativePaymentContext();
    if (inApp && !state.nativeBillingReady) return '<p data-checkout-blocked class="text-xs text-slate-400">Subscription purchases are not available in this Android app. Existing subscriptions remain available.</p>';
    const c = state.checkout;
    const plans = state.plansCatalog || DEFAULT_PLANS;
    const plan = c && plans[c.planId];
    if (!c || !plan || !plan.paid) {
        return `<div class="text-center py-12 text-xs text-slate-400">Choose a plan first.<br><button data-action="tab" data-tab="subscription" class="mt-3 px-4 py-2 bg-brand-600 text-white rounded-xl font-semibold">View plans</button></div>`;
    }
    const cycle = c.billingCycle === 'annual' ? 'annual' : 'monthly';
    const automatic = !inApp && c.renewalMode === 'automatic';
    const existingAuto = !!state.subscription?.autoRenew;
    const quote = automatic ? { ok: true, plan, kind: 'automatic', price: planPrice(plan, cycle), credit: 0, amount: planPrice(plan, cycle) }
        : quotePurchase(state.subscription, c.planId, cycle, plans, Date.now());
    const busy = c.step === 'processing';
    const needsTaxState = inApp && !INDIA_TAX_STATES.includes(c.taxState);
    const showResult = ['SUCCESS', 'PENDING', 'FAILED', 'CANCELLED', 'UNAVAILABLE'].includes(c.step);

    const cycleBtn = (id, label, note = '') => `
        <button data-action="checkout-cycle" data-cycle="${id}" aria-pressed="${cycle === id}" ${busy ? 'disabled' : ''}
            class="flex-1 text-left p-3 rounded-xl border transition touch-manipulation ${cycle === id ? 'border-brand-500 bg-brand-500/10' : 'border-slate-800 bg-slate-950 hover:border-slate-700'}">
            <span class="block text-xs font-bold text-slate-100">${label}</span>
            <span class="block text-[11px] text-slate-400">${esc(formatINR(planPrice(plan, id)))} / ${id === 'annual' ? 'year' : 'month'}</span>
            ${note}
        </button>`;

    const methodBtn = (m) => `
        <button data-action="checkout-method" data-method="${m.id}" role="radio" aria-checked="${c.method === m.id}" ${busy ? 'disabled' : ''}
            class="w-full flex items-center gap-3 p-3 rounded-xl border text-left transition touch-manipulation ${c.method === m.id ? 'border-brand-500 bg-brand-500/10' : 'border-slate-800 bg-slate-950 hover:border-slate-700'}">
            <span class="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center shrink-0"><i data-lucide="${m.icon}" class="w-4 h-4 text-brand-300"></i></span>
            <span class="min-w-0"><span class="block text-xs font-bold text-slate-100">${esc(m.label)}</span><span class="block text-[10px] text-slate-500">${esc(m.hint)}</span></span>
            <span class="ml-auto w-4 h-4 rounded-full border ${c.method === m.id ? 'border-brand-400 bg-brand-500' : 'border-slate-600'}"></span>
        </button>`;

    const summary = quote.ok ? `
        <div class="space-y-1.5 text-xs">
            <div class="flex justify-between"><span class="text-slate-400">${esc(plan.name)} · ${cycle === 'annual' ? 'Annual' : 'Monthly'}</span><span class="text-slate-100">${esc(formatINR(quote.price))}</span></div>
            ${quote.credit > 0 ? `<div class="flex justify-between"><span class="text-emerald-400">Credit for unused time on current plan</span><span class="text-emerald-400">− ${esc(formatINR(quote.credit))}</span></div>` : ''}
            ${quote.kind === 'renewal' ? '<p class="text-[10px] text-slate-500">Renewal — your new period starts when the current one ends.</p>' : ''}
            ${cycle === 'annual' ? `<p class="text-[10px] text-emerald-400">You save ${esc(formatINR(annualSavings(plan)))} compared with paying monthly.</p>` : ''}
            <div class="flex justify-between border-t border-slate-800 pt-2 text-sm font-extrabold"><span class="text-slate-100">${automatic ? 'Recurring amount' : 'Total today'}</span><span data-checkout-total class="text-brand-300">${esc(formatINR(quote.amount))}</span></div>
        </div>` : `<p data-checkout-blocked class="text-xs text-amber-300">${esc(quote.error)}</p>`;

    return `
        <div class="space-y-4 max-w-3xl mx-auto" data-view="checkout">
            <button data-action="tab" data-tab="subscription" class="text-[11px] text-slate-400 hover:text-slate-200 flex items-center gap-1 touch-manipulation"><i data-lucide="arrow-left" class="w-3.5 h-3.5"></i> Back to plans</button>
            <h2 class="text-lg font-extrabold text-slate-100">Checkout</h2>
            ${showResult ? resultPanel(c) : `
            <div class="lg:grid lg:grid-cols-5 lg:gap-4 space-y-4 lg:space-y-0">
                <div class="lg:col-span-3 space-y-4">
                    <section class="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                        <h3 class="text-xs font-bold text-slate-100">1 · Billing cycle</h3>
                        <div class="flex gap-2">${cycleBtn('monthly', 'Monthly')}${cycleBtn('annual', 'Annual', annualSavings(plan) > 0 ? `<span class="block text-[10px] font-bold text-emerald-400">Save ${esc(formatINR(annualSavings(plan)))}</span>` : '')}</div>
                    </section>
                    ${inApp ? `<section class="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                        <h3 class="text-xs font-bold text-slate-100">2 · Billing state</h3>
                        <label class="block text-[11px] text-slate-400" for="checkout-tax-state">State for GST</label>
                        <select id="checkout-tax-state" data-action="checkout-tax-state" ${busy ? 'disabled' : ''} class="w-full p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-100">
                            <option value="">Select your state</option>
                            ${INDIA_TAX_STATES.map((st) => `<option value="${escAttr(st)}" ${c.taxState === st ? 'selected' : ''}>${esc(st)}</option>`).join('')}
                        </select>
                        <p class="text-xs text-slate-400">Google Play shows the available payment options next. Your plan activates only after the payment is verified.</p>
                    </section>` : `
                    <section class="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                        <h3 class="text-xs font-bold text-slate-100">Renewal</h3>
                        ${existingAuto ? '<p class="text-xs text-slate-300">Automatic renewal is enabled. Plan changes take effect at the next billing cycle. Cancel automatic renewal from your subscription page before making a manual payment.</p>' : `
                        <div class="flex gap-2">
                            ${['manual', 'automatic'].map((mode) => `<button data-action="checkout-renewal" data-mode="${mode}" aria-pressed="${c.renewalMode === mode || (!c.renewalMode && mode === 'manual')}" ${busy ? 'disabled' : ''} class="flex-1 p-3 rounded-xl border text-xs font-bold ${mode === (c.renewalMode || 'manual') ? 'border-brand-500 text-brand-300' : 'border-slate-800 text-slate-300'}">${mode === 'automatic' ? 'Automatic renewal' : 'Manual renewal'}</button>`).join('')}
                        </div>`}
                        ${automatic ? `<p class="text-xs text-slate-300">${existingAuto ? 'Your current paid plan stays unchanged until its end date.' : 'Authorise recurring billing now. Your first plan charge starts after your existing trial or paid period; the gateway may perform a refundable mandate-authorisation charge.'} Renews every ${cycle === 'annual' ? 'year' : 'month'} at ${esc(formatINR(quote.amount))}, for up to ${cycle === 'annual' ? '10 yearly' : '120 monthly'} charges. Cancel automatic renewal at any time. No card or banking credentials are stored by Qvrix GlowOS.</p>` : '<p class="text-xs text-slate-400">One payment only. Renew manually when your plan ends.</p>'}
                    </section>`}
                    ${!automatic && !inApp ? `<section class="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2" role="radiogroup" aria-label="Payment method">
                        <h3 class="text-xs font-bold text-slate-100">2 · Payment method</h3>
                        ${PAYMENT_METHODS.map(methodBtn).join('')}
                    </section>` : ''}
                </div>
                <aside class="lg:col-span-2">
                    <section class="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3 lg:sticky lg:top-0">
                        <h3 class="text-xs font-bold text-slate-100">3 · Confirm</h3>
                        ${summary}
                        <button data-action="confirm-payment" ${busy || !quote.ok || needsTaxState ? 'disabled' : ''} class="w-full py-3 bg-brand-600 hover:bg-brand-500 text-white text-[13px] font-bold rounded-xl shadow-lg shadow-brand-600/30 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed">
                            ${busy ? 'Processing…' : inApp ? (quote.ok ? 'Continue to payment' : 'Unavailable') : automatic ? (existingAuto ? 'Schedule plan change' : 'Agree and authorise automatic renewal') : quote.ok ? `Pay ${esc(formatINR(quote.amount))} securely` : 'Unavailable'}
                        </button>
                        ${inApp ? '' : `<p class="text-[10px] text-slate-500 flex items-start gap-1.5"><i data-lucide="shield-check" class="w-3.5 h-3.5 shrink-0 text-emerald-400"></i><span>Payments are processed by our gateway on its secure page. Card, UPI and bank details are never seen or stored by us. Your plan activates only after the payment is verified.</span></p>`}
                    </section>
                </aside>
            </div>`}
        </div>`;
}

export default renderCheckout;
