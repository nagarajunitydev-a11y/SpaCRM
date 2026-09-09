/**
 * views/quickBilling.js
 * Fast walk-in POS flow: bill a client immediately without a pre-booked
 * appointment. Rendered as a full page/view (not a popup) inside the app's
 * active tab. Reuses the exact billing architecture as the Payment sheet —
 * the same discount / referral-wallet / split payment maths, the same summary
 * renderer and the same ledger rules — but drives a dedicated `submit-quick-
 * billing` form whose handler in main.js writes a Completed + paid appointment
 * in one step.
 *
 * The flow is phone-first: the receptionist types a 10-digit mobile number,
 * the client is looked up automatically, an existing client's details appear
 * immediately, and a brand-new number reveals an inline "Customer Name" field
 * in the same page (no navigation). Date/time are never picked — every walk-in
 * is stamped with the salon's current date & time automatically.
 *
 * Values are live-updated in place (never a full app re-render), so an
 * in-progress walk-in bill keeps its typed input while the breakdown below it
 * recomputes.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { formField, textInput, selectControl } from '../components.js';
import { formatCurrency, scopedBySalon } from '../../core/utils.js';
import { round2, num } from '../../core/referral.js';
import { splitPayment, invoiceNoFor } from '../../core/wallet.js';
import { DISCOUNT_TYPES } from '../../core/discount.js';
import { renderPaymentSummary, PAYMENT_METHODS } from './payment.js';
import { normalizePhoneDigits } from '../../core/validate.js';

const DISCOUNT_TYPE_OPTIONS = [
    { value: DISCOUNT_TYPES.PERCENTAGE, label: 'Percentage (%)' },
    { value: DISCOUNT_TYPES.FIXED, label: 'Fixed Amount (₹)' },
];

/** Digits-only, capped at 10 (mirrors the live phone input rule). */
const digitsOf = (value) => String(value || '').replace(/\D/g, '').slice(0, 10);

/** Current local date/time in the record format plus a human label. */
function currentDateTime() {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
        + ', '
        + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    return { date, time, label };
}

/** Selected services list + subtotal card, re-rendered in place on change. */
export function renderSelectedServices(lineItems, catalog, { staffName = '', discount = 0 } = {}) {
    const rows = (lineItems || []).map((line, index) => {
        const item = typeof line === 'string' ? { id: `legacy-${index}`, name: line } : line;
        const service = catalog.find((s) => s.id === item.serviceId) || catalog.find((s) => s.name === item.name);
        return service ? { ...item, service } : null;
    }).filter(Boolean);
    const subtotal = round2(rows.reduce((sum, line) => sum + (Number(line.service.price) || 0), 0));

    return `
        <div class="flex items-center justify-between">
            <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Selected Services</p>
            <span class="text-[10px] text-slate-500">${rows.length}</span>
        </div>
        ${rows.length === 0
            ? '<p class="text-[11px] text-slate-500">Add one or more services to this bill.</p>'
            : rows.map((line, index) => {
                const { service } = line;
                const price = round2(Number(service.price) || 0);
                const lineDiscount = index === rows.length - 1
                    ? round2(discount - rows.slice(0, index).reduce((sum, row) => sum + round2(discount * (Number(row.service.price) || 0) / subtotal), 0))
                    : round2(subtotal > 0 ? discount * price / subtotal : 0);
                return `
                <div class="flex items-center justify-between gap-2 text-xs">
                    <div class="min-w-0">
                        <select data-action="quick-billing-edit-service" data-line-id="${escAttr(line.id)}"
                            class="max-w-full bg-transparent text-xs font-semibold text-slate-200 focus:outline-none focus:text-brand-300">
                            ${catalog.map((option) => `<option value="${escAttr(option.id || '')}" ${String(option.id || '') === String(line.serviceId || '') || (!line.serviceId && option.name === service.name) ? 'selected' : ''}>${esc(option.name)}</option>`).join('')}
                        </select>
                        <p class="text-[10px] text-slate-500 truncate">${esc(staffName || 'No staff assigned')}</p>
                        <p class="text-[10px] text-slate-500">${esc(service.duration || '—')} • ${esc(formatCurrency(service.price))}</p>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                        <span class="text-[10px] text-right text-slate-300">${esc(formatCurrency(price))}<br>${lineDiscount > 0 ? `-${esc(formatCurrency(lineDiscount))}` : 'No discount'}<br><b>${esc(formatCurrency(round2(price - lineDiscount)))}</b></span>
                        <button type="button" data-action="quick-billing-remove-service" data-line-id="${escAttr(line.id)}"
                            class="w-7 h-7 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 flex items-center justify-center transition" aria-label="Remove ${escAttr(service.name)}">
                            <i data-lucide="x" class="w-3.5 h-3.5"></i>
                        </button>
                    </div>
                </div>
            `;
            }).join('')}
        <div class="border-t border-slate-800 pt-2 flex items-center justify-between">
            <span class="text-[11px] font-semibold text-slate-300">Subtotal</span>
            <span class="text-sm font-extrabold text-brand-300">${esc(formatCurrency(subtotal))}</span>
        </div>
    `;
}

/** Live search dropdown of catalog services, one suggestion per row. */
export function renderQuickBillingServiceSuggestions(matches) {
    if (!matches || matches.length === 0) {
        return '<p class="text-[10px] text-slate-500">No matching services in your catalog.</p>';
    }
    return `
        <div class="space-y-1.5">
            ${matches.map((svc) => {
                return `
                    <button type="button" data-action="quick-billing-add-service" data-service-id="${escAttr(svc.id || '')}" data-name="${escAttr(svc.name)}"
                        class="w-full flex items-center justify-between gap-3 bg-slate-950 border border-slate-800 px-4 py-2.5 rounded-xl text-left transition hover:border-emerald-500/40 active:scale-[0.98] touch-manipulation">
                        <span class="min-w-0">
                            <span class="block text-xs font-semibold text-slate-100 truncate">${esc(svc.name)}</span>
                            <span class="block text-[10px] text-slate-400 truncate">${esc(svc.category || 'Service')} • ${esc(svc.duration || '—')}</span>
                        </span>
                        <span class="text-emerald-400 shrink-0 flex items-center gap-1">
                            <span class="text-[10px] font-bold">${esc(formatCurrency(svc.price))}</span>
                            <i data-lucide="plus-circle" class="w-4 h-4"></i>
                        </span>
                    </button>
                `;
            }).join('')}
        </div>
    `;
}

/** Referral-wallet block - identical rules to the Payment sheet. */
export function renderWalletBlock({ walletBalance, cap, settingsEnabled }) {
    const balance = round2(Math.max(0, num(walletBalance)));
    if (cap > 0) {
        return `
            <div class="bg-brand-500/10 border border-brand-500/25 rounded-2xl p-3.5 space-y-2.5">
                <div class="flex items-center justify-between gap-3">
                    <div class="min-w-0">
                        <p class="text-[11px] font-bold text-brand-300 flex items-center gap-1.5">
                            <i data-lucide="wallet" class="w-3.5 h-3.5 shrink-0"></i>
                            <span>Referral wallet</span>
                        </p>
                        <p class="text-[10px] text-slate-400 mt-0.5">Available ${esc(formatCurrency(balance))}</p>
                    </div>
                    <button type="button" data-action="wallet-use-max" data-amount="${escAttr(cap)}"
                        class="px-3 py-1.5 bg-brand-600 hover:bg-brand-500 text-white text-[10px] font-semibold rounded-xl transition active:scale-95 touch-manipulation shrink-0">Use max</button>
                </div>
                ${formField('Redeem from wallet (₹)', textInput('walletRedeem', '0', { type: 'number', required: false, className: 'input-number', value: '' }))}
            </div>
        `;
    }
    return `
        <div class="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3.5">
            <p class="text-[11px] text-slate-400 flex items-center gap-1.5">
                <i data-lucide="wallet" class="w-3.5 h-3.5 shrink-0"></i>
                <span>${esc(settingsEnabled ? `No referral balance available (${formatCurrency(balance)})` : 'Referral programme is disabled')}</span>
            </p>
            <input type="hidden" name="walletRedeem" value="0">
        </div>
    `;
}

/**
 * The inline client block under the phone field.
 *  - `customer` set  -> existing client found, details shown (read-only confirmation).
 *  - 10 digits, no   -> brand-new number: an inline "Customer Name" field appears
 *    customer            right here, still inside the same Quick Billing page.
 *  - anything else    -> short hint while the number is being typed.
 *
 * Hidden `customerId` / `customerName` fields carry the resolved record to the
 * write handler exactly like the old search picker did, and the phone input
 * itself carries `customerPhone`.
 */
export function renderQuickBillingCustomer(customer, { phone = '', name = '', checking = false } = {}) {
    if (customer) {
        return `
            <div class="bg-emerald-500/10 border border-emerald-500/25 rounded-2xl p-3.5 flex items-center gap-3">
                <span class="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0"><i data-lucide="user-check" class="w-5 h-5"></i></span>
                <div class="min-w-0 flex-1">
                    <p class="text-xs font-bold text-slate-100 truncate">${esc(customer.name)}</p>
                    <p class="text-[10px] text-slate-400 mt-0.5 truncate">${esc(customer.phone || '')} • Existing client${num(customer.rewardPoints) > 0 ? ` • ${Math.round(num(customer.rewardPoints))} pts` : ''}</p>
                </div>
                <span class="text-[9px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-300 px-2 py-1 rounded-full shrink-0">Found</span>
            </div>
            <input type="hidden" name="customerId" value="${escAttr(customer.id)}">
            <input type="hidden" name="customerName" value="${escAttr(customer.name)}">
        `;
    }

    // The salon's customer list has not delivered its first snapshot yet, so an
    // empty result is not evidence the number is new — hold judgement until the
    // backend data arrives.
    if (checking) {
        return `
            <div class="bg-slate-900/70 border border-slate-800 rounded-2xl p-3.5 flex items-center gap-3">
                <span class="w-9 h-9 rounded-xl bg-slate-800 text-slate-400 flex items-center justify-center shrink-0"><i data-lucide="loader" class="w-4 h-4 animate-spin"></i></span>
                <div class="min-w-0">
                    <p class="text-xs font-semibold text-slate-300">Checking existing clients…</p>
                    <p class="text-[10px] text-slate-500 mt-0.5">Syncing with the client list…</p>
                </div>
            </div>
            <input type="hidden" name="customerId" value="">
            <input type="hidden" name="customerName" value="">
        `;
    }

    if (phone.length === 10) {
        return `
            <div class="bg-brand-500/10 border border-brand-500/30 rounded-2xl p-3.5 space-y-2.5">
                <p class="text-[11px] font-semibold text-brand-300 flex items-center gap-1.5">
                    <i data-lucide="user-plus" class="w-3.5 h-3.5 shrink-0"></i>
                    <span>New client — ${esc(phone)} not on file</span>
                </p>
                ${formField('Customer Name', textInput('customerName', 'Client name', { required: true, value: name }))}
            </div>
            <input type="hidden" name="customerId" value="">
        `;
    }

    return `
        <p class="text-[10px] text-slate-500 leading-relaxed">Enter the client's 10-digit mobile number. Existing clients are looked up automatically; a new number shows an inline name field right here.</p>
        <input type="hidden" name="customerId" value="">
        <input type="hidden" name="customerName" value="">
    `;
}

/** Format a stored number as the human "+91 XXXXX XXXXX" national form. */
function phoneLabel(phone) {
    const national = normalizePhoneDigits(phone);
    return national.length === 10 ? `+91 ${national.slice(0, 5)} ${national.slice(5)}` : (phone || '');
}

/**
 * Type-ahead matches derived from the CURRENT rendered customer list (the same
 * backend source as the Clients module). Deriving them from state on every
 * render — not just imperatively — is what lets the dropdown survive a
 * background store update (e.g. booking-settings seeding) that re-creates the
 * whole form mid-typing: the draft restores the entered number, and the
 * dropdown is recomputed right back, exactly like the rest of the form.
 */
function phoneTypeaheadMatches(customers, phone) {
    const digits = digitsOf(phone);
    if (!digits) return [];
    return (customers || [])
        .map((c) => ({ c, national: normalizePhoneDigits(c.phone) }))
        .filter(({ national }) => national && national.startsWith(digits))
        .sort((a, b) => a.national.length - b.national.length)
        .slice(0, 6)
        .map(({ c }) => c);
}

/**
 * The live phone type-ahead dropdown under the phone field.
 *  - `loading`          -> brief "searching" card while the debounced lookup runs.
 *  - matches available  -> tappable rows (name + phone) that select the contact.
 *  - no matches + 10 digits -> a no-results state (the inline name field below
 *                              then handles the new-client path).
 *  - no matches + fewer digits -> nothing (keep typing).
 *
 * Rendered in-flow (never absolutely positioned) so it can never cover the
 * phone input — that field must stay reachable by mouse/touch at all times.
 */
export function renderQuickBillingCustomerSuggestions(matches, phone, opts = {}) {
    const { loading = false } = opts || {};
    const digits = digitsOf(phone);

    if (loading) {
        return `
            <div class="bg-slate-950/70 border border-slate-800/70 rounded-xl p-3 flex items-center gap-2.5">
                <i data-lucide="loader" class="w-4 h-4 text-brand-400 animate-spin shrink-0"></i>
                <p class="text-[11px] text-slate-400">Searching clients…</p>
            </div>
        `;
    }

    const list = (matches || [])
        .slice(0, 6)
        .map((c) => `
            <button type="button" data-action="quick-billing-select-customer"
                data-id="${escAttr(c.id)}" data-name="${escAttr(c.name)}" data-phone="${escAttr(c.phone || '')}"
                class="w-full flex items-center justify-between gap-3 bg-slate-950 border border-slate-800/80 px-3.5 py-2.5 rounded-xl text-left transition active:scale-[0.98] touch-manipulation">
                <span class="min-w-0">
                    <span class="block text-xs font-semibold text-slate-100 truncate">${esc(c.name)}</span>
                    <span class="block text-[10px] text-slate-400 mt-0.5">${esc(phoneLabel(c.phone))}</span>
                </span>
                <span class="text-brand-400 shrink-0"><i data-lucide="user-check" class="w-4 h-4"></i></span>
            </button>
        `).join('');

    if (list) {
        return `
            <div class="space-y-1.5">
                <p class="text-[9px] font-bold uppercase tracking-widest text-slate-500 px-0.5">Matching clients</p>
                ${list}
            </div>
        `;
    }

    if (digits.length === 10) {
        return `
            <div class="bg-slate-950/70 border border-slate-800/70 rounded-xl p-3 flex items-center gap-2.5">
                <i data-lucide="search-x" class="w-4 h-4 text-slate-500 shrink-0"></i>
                <p class="text-[11px] text-slate-400">No matching client — enter their name below.</p>
            </div>
        `;
    }

    return '';
}

/**
 * The walk-in billing page. Phone-number driven client resolution happens in a
 * live block below the phone field; date/time are automatic (now) and shown
 * read-only; services are added from the live catalog via search. All state
 * needed by the write handler is carried on hidden inputs / named fields so the
 * central submit delegation handles it exactly like any other entity form.
 */
export function renderQuickBillingForm(state, draft = null) {
    const services = scopedBySalon(state.servicesList, state.currentSalonId);
    const staff = scopedBySalon(state.staffList, state.currentSalonId);
    const customers = scopedBySalon(state.customersList, state.currentSalonId);
    const isOwner = state.userRole === 'salon_owner';
    const now = currentDateTime();

    // A full app re-render (any store change) rebuilds the whole view, so an
    // in-progress walk-in bill is restored from the non-reactive draft (see
    // core/draft.js) instead of being wiped mid-entry.
    const draftData = draft || {};
    let draftLineItems = [];
    if (Array.isArray(draftData.selectedServices)) draftLineItems = draftData.selectedServices.filter(Boolean);
    else if (typeof draftData.selectedServices === 'string') {
        try { draftLineItems = JSON.parse(draftData.selectedServices || '[]'); } catch { draftLineItems = []; }
    }

    const phone = digitsOf(draftData.customerPhone);
    const dropdownMatches = phoneTypeaheadMatches(customers, phone);
    let customer = null;
    const pickedId = draftData.customerId;
    if (pickedId) customer = customers.find((c) => c.id === pickedId) || null;
    if (!customer && phone.length === 10) customer = customers.find((c) => digitsOf(c.phone) === phone) || null;

    const staffOptions = [
        { value: '', label: 'Not assigned' },
        ...staff.map((st) => ({ value: st.name, label: `${st.name} (${st.role})` })),
    ];

    const discountBlock = isOwner
        ? `
            ${formField('Discount Type', selectControl('discountType', DISCOUNT_TYPE_OPTIONS, 'No discount', { required: false, value: draftData.discountType || '' }))}
            ${formField('Discount Value', textInput('discountValue', '10', { type: 'number', required: false, className: 'input-number', value: draftData.discountValue || '' }), 'Applied to this bill and saved for this client\'s future invoices. Capped so it can never exceed the bill amount.')}
        `
        : `
            <p class="text-[11px] text-slate-400">Any client-level discount is applied automatically at payment.</p>
            <input type="hidden" name="discountType" value="">
            <input type="hidden" name="discountValue" value="">
        `;

    return `
        <div class="max-w-xl mx-auto">
            <div class="flex items-center gap-3 mb-4">
                <button type="button" data-action="tab" data-tab="dashboard" aria-label="Back to dashboard" title="Back to dashboard"
                    class="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition active:scale-95 touch-manipulation shrink-0">
                    <i data-lucide="arrow-left" class="w-4 h-4"></i>
                </button>
                <div class="min-w-0">
                    <h2 class="font-bold text-sm text-slate-100 truncate">Quick Billing / Walk-in</h2>
                    <p class="text-[10px] text-slate-500 truncate">Fast POS for walk-in clients</p>
                </div>
            </div>

            <div class="bg-emerald-500/10 border border-emerald-500/25 rounded-2xl p-3.5 flex items-center gap-3 mb-4">
                <span class="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0"><i data-lucide="zap" class="w-4 h-4"></i></span>
                <div class="min-w-0">
                    <p class="text-xs font-bold text-emerald-300">Billing at ${esc(now.label)}</p>
                    <p class="text-[10px] text-slate-400 mt-0.5">Date & time are recorded automatically — no selection needed.</p>
                </div>
            </div>

            <form data-action="submit-quick-billing" class="space-y-3.5" novalidate>
                <div>
                    ${formField('Phone Number', `
                        <div class="flex w-full bg-slate-950 border border-slate-800 rounded-xl focus-within:border-brand-500 overflow-hidden">
                            <span class="px-3.5 border-r border-slate-800 bg-slate-900/40 flex items-center text-xs font-bold text-slate-300 select-none" aria-hidden="true">+91</span>
                            <input type="tel" inputmode="numeric" pattern="[0-9]{10}" maxlength="10" required name="customerPhone" autocomplete="tel-national" placeholder="98765 43210" data-action="quick-billing-phone" value="${escAttr(phone)}"
                                class="w-full min-w-0 bg-transparent px-4 py-3 text-base tracking-widest text-slate-100 focus:outline-none">
                        </div>
                    `, 'Digits only, up to 10. Matching clients appear below as you type.')}
                    <div data-quickbilling-customer-dropdown class="mt-2">${renderQuickBillingCustomerSuggestions(dropdownMatches, phone)}</div>
                    <div data-quickbilling-customer class="mt-2">${renderQuickBillingCustomer(customer, { phone, name: draftData.customerName || '' })}</div>
                </div>

                <div>
                    <label class="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Add Services</label>
                    <div class="relative">
                        <input type="text" autocomplete="off" placeholder="Search service name or category…"
                            data-action="quick-billing-service-search"
                            class="w-full bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500 pr-9">
                        <i data-lucide="search" class="w-4 h-4 text-slate-500 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none"></i>
                    </div>
                    <div data-quickbilling-service-suggestions class="mt-2"></div>
                    <input type="hidden" name="selectedServices" value="${escAttr(JSON.stringify(draftLineItems))}">
                    <div class="mt-2 bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3 space-y-2" data-quickbilling-selected-services>
                        ${renderSelectedServices(draftLineItems, services)}
                    </div>
                </div>

                <div>
                    <label class="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Assigned Stylist (optional)</label>
                    ${selectControl('staffName', staffOptions, 'Not assigned', { required: false, value: draftData.staffName || '' })}
                </div>

                <div class="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3.5 space-y-3">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                        <i data-lucide="badge-percent" class="w-3.5 h-3.5 shrink-0"></i><span>Discount</span>
                    </p>
                    ${discountBlock}
                </div>

                <div data-quickbilling-wallet>
                    ${renderWalletBlock({ walletBalance: 0, cap: 0, settingsEnabled: true })}
                </div>

                ${formField('Payment Method', selectControl('paymentMethod', PAYMENT_METHODS, 'Select a method', { required: true, value: draftData.paymentMethod || '' }))}
                ${formField('Reference (optional)', textInput('paymentReference', 'UPI ref / last 4 digits', { required: false, value: draftData.paymentReference || '' }))}

                <div data-quickbilling-summary class="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3.5 space-y-1.5">
                    ${renderPaymentSummary({ invoiceAmount: 0, walletRedeem: 0, walletBalance: 0, cap: 0, discount: 0, discountText: '' })}
                </div>

                <button type="submit" disabled class="w-full py-3.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-emerald-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none">Complete Payment</button>
            </form>
        </div>
    `;
}

/** Receipt shown right after a walk-in is billed (rendered in the same view). */
export function renderQuickBillingReceipt(state) {
    const appointment = state.quickBillingReceipt || state.modalRecord || {};
    const invoiceNo = appointment.invoiceNo || invoiceNoFor(appointment.id);
    const split = splitPayment({
        invoiceAmount: appointment.invoiceAmount,
        walletRedeemed: appointment.walletRedeemed,
        discount: appointment.discountApplied,
    });
    const methodLabel = (PAYMENT_METHODS.find((m) => m.value === appointment.paymentMethod) || {}).label
        || appointment.paymentMethod
        || '—';

    const line = (label, value, cls = 'text-slate-200') => `
        <div class="flex items-center justify-between">
            <span class="text-[11px] text-slate-400">${esc(label)}</span>
            <span class="text-xs font-bold ${escAttr(cls)}">${esc(value)}</span>
        </div>
    `;

    const serviceRows = Array.isArray(appointment.services) && appointment.services.length
        ? appointment.services
        : (appointment.serviceNames || (appointment.serviceName ? [appointment.serviceName] : []));

    return `
        <div class="max-w-xl mx-auto">
            <div class="flex items-center gap-3 mb-4">
                <button type="button" data-action="tab" data-tab="dashboard" aria-label="Back to dashboard" title="Back to dashboard"
                    class="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition active:scale-95 touch-manipulation shrink-0">
                    <i data-lucide="arrow-left" class="w-4 h-4"></i>
                </button>
                <div class="min-w-0">
                    <h2 class="font-bold text-sm text-slate-100 truncate">Invoice / Receipt</h2>
                    <p class="text-[10px] text-slate-500 truncate">Quick Billing / Walk-in</p>
                </div>
            </div>

            <div class="space-y-4">
                <div class="text-center">
                    <div class="w-14 h-14 mx-auto rounded-2xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center" aria-hidden="true">
                        <i data-lucide="check-circle-2" class="w-6 h-6"></i>
                    </div>
                    <p class="text-sm font-extrabold text-slate-100 mt-2">Walk-in billed & paid</p>
                    <p class="text-[10px] text-slate-500 mt-0.5 font-mono">${esc(invoiceNo)}</p>
                </div>

                <div class="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3.5 space-y-1.5">
                    ${line('Client', appointment.customerName || '—')}
                    ${appointment.customerPhone ? line('Phone', appointment.customerPhone, 'text-slate-300') : ''}
                    ${line('Date & time', `${appointment.date || ''} ${appointment.time || ''}`)}
                    <div class="h-px bg-slate-800 my-1"></div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Services</p>
                    ${serviceRows.map((s, index) => {
                        const name = typeof s === 'string' ? s : (s?.name || '');
                        const price = typeof s === 'string' ? 0 : Number(s?.price) || 0;
                        const subtotal = serviceRows.reduce((sum, row) => sum + (typeof row === 'string' ? 0 : Number(row?.price) || 0), 0);
                        const discount = Number(appointment.discountApplied) || 0;
                        const priorDiscount = serviceRows.slice(0, index).reduce((sum, row) => {
                            const rowPrice = typeof row === 'string' ? 0 : Number(row?.price) || 0;
                            return sum + round2(subtotal > 0 ? discount * rowPrice / subtotal : 0);
                        }, 0);
                        const lineDiscount = index === serviceRows.length - 1
                            ? round2(discount - priorDiscount)
                            : round2(subtotal > 0 ? discount * price / subtotal : 0);
                        return `
                            <div class="flex items-center justify-between gap-2">
                                <span class="text-[11px] text-slate-300 truncate">${esc(name)}<small class="block text-slate-500">${esc(appointment.staffName || 'No staff assigned')}</small></span>
                                <span class="text-[10px] text-right text-slate-400 shrink-0">${esc(formatCurrency(price))}<br>${lineDiscount > 0 ? `-${esc(formatCurrency(lineDiscount))}` : 'No discount'}<br><b class="text-slate-200">${esc(formatCurrency(round2(price - lineDiscount)))}</b></span>
                            </div>
                        `;
                    }).join('')}
                    <div class="h-px bg-slate-800 my-1"></div>
                    ${line('Invoice total', formatCurrency(split.invoiceAmount))}
                    ${split.discount > 0 ? line('Client discount', `- ${formatCurrency(split.discount)}`, 'text-amber-400') : ''}
                    ${line('Paid from wallet', formatCurrency(split.walletRedeemed), 'text-brand-400')}
                    ${line(`Paid by ${methodLabel}`, formatCurrency(split.amountDue), 'text-emerald-400')}
                    ${appointment.walletBalanceBefore !== undefined ? line('Wallet before', formatCurrency(appointment.walletBalanceBefore), 'text-slate-300') : ''}
                    ${appointment.walletBalanceAfter !== undefined ? line('Wallet after', formatCurrency(appointment.walletBalanceAfter), 'text-slate-300') : ''}
                    ${appointment.paymentReference ? line('Reference', appointment.paymentReference, 'text-slate-300') : ''}
                </div>

                ${appointment.refunded
                    ? `<p class="text-[10px] text-rose-400/80 text-center">Refunded on ${esc(String(appointment.refundedAt || '').slice(0, 10))}. Referral rewards earned by this invoice have been reversed.</p>`
                    : `<button data-action="refund-invoice" data-id="${escAttr(appointment.id)}"
                        class="w-full py-3 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-rose-600/30 transition active:scale-95 touch-manipulation">Refund this bill</button>`}

                <div class="flex gap-2.5">
                    <button type="button" data-action="tab" data-tab="quickBilling"
                        class="flex-1 py-3 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-emerald-600/30 transition active:scale-95 touch-manipulation">
                        <i data-lucide="zap" class="w-3.5 h-3.5 inline mr-1"></i>New Billing
                    </button>
                    ${appointment.customerId
                        ? `<button type="button" data-action="customer-profile" data-id="${escAttr(appointment.customerId)}"
                            class="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-xl transition active:scale-95 touch-manipulation">
                            <i data-lucide="user-round" class="w-3.5 h-3.5 inline mr-1"></i>View Client
                        </button>`
                        : ''}
                </div>
                <button type="button" data-action="tab" data-tab="dashboard"
                    class="w-full py-3 bg-slate-950/60 border border-slate-800 text-slate-300 text-xs font-bold rounded-xl transition active:scale-95 touch-manipulation">Done</button>
            </div>
        </div>
    `;
}

export default {
    renderQuickBillingForm,
    renderQuickBillingReceipt,
    renderQuickBillingServiceSuggestions,
    renderSelectedServices,
    renderWalletBlock,
    renderQuickBillingCustomer,
    renderQuickBillingCustomerSuggestions,
};
