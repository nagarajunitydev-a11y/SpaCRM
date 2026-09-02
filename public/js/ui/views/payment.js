/**
 * views/payment.js
 * Billing sheet: settle an appointment's invoice, optionally paying part (or
 * all) of it from the client's referral wallet.
 *
 * Supports full and partial redemption and a split payment (wallet + one of
 * cash / UPI / card). The redemption ceiling shown here is computed by
 * core/referral.js, the same function the write path re-checks inside its
 * transaction — the UI can suggest a number but never decides one.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { formField, textInput, selectControl } from '../components.js';
import { formatCurrency, scopedBySalon } from '../../core/utils.js';
import { serviceAmountFor } from '../../core/revenue.js';
import { sanitizeSettings, maxRedeemable, round2, num } from '../../core/referral.js';
import { splitPayment, invoiceNoFor } from '../../core/wallet.js';
import { DISCOUNT_TYPES, discountAmountFor, discountLabel } from '../../core/discount.js';

export const PAYMENT_METHODS = [
    { value: 'cash', label: 'Cash' },
    { value: 'upi', label: 'UPI' },
    { value: 'card', label: 'Card' },
    { value: 'other', label: 'Other' },
];

const DISCOUNT_TYPE_OPTIONS = [
    { value: DISCOUNT_TYPES.PERCENTAGE, label: 'Percentage (%)' },
    { value: DISCOUNT_TYPES.FIXED, label: 'Fixed Amount (₹)' },
];

/** Default invoice total for an appointment: recorded invoice, else catalog. */
export function defaultInvoiceAmount(appointment, services) {
    const recorded = num(appointment && appointment.invoiceAmount);
    if (recorded > 0) return round2(recorded);
    return round2(serviceAmountFor(appointment, services));
}

/** The live discount / wallet / due breakdown shown under the inputs. */
export function renderPaymentSummary({ invoiceAmount, walletRedeem, walletBalance, cap, discount = 0, discountText = '' }) {
    const split = splitPayment({ invoiceAmount, walletRedeemed: walletRedeem, discount });
    const row = (label, value, cls = 'text-slate-200') => `
        <div class="flex items-center justify-between">
            <span class="text-[11px] text-slate-400">${esc(label)}</span>
            <span class="text-xs font-bold ${escAttr(cls)}">${esc(value)}</span>
        </div>
    `;

    return `
        ${row('Invoice total', formatCurrency(split.invoiceAmount))}
        ${split.discount > 0 ? row(`Client discount${discountText ? ` (${discountText})` : ''}`, `- ${formatCurrency(split.discount)}`, 'text-amber-400') : ''}
        ${row('Referral wallet', `- ${formatCurrency(split.walletRedeemed)}`, 'text-brand-400')}
        <div class="h-px bg-slate-800 my-1"></div>
        ${row('Amount due', formatCurrency(split.amountDue), split.amountDue > 0 ? 'text-emerald-400' : 'text-slate-400')}
        ${row('Wallet balance after', formatCurrency(round2(Math.max(0, walletBalance - split.walletRedeemed))), 'text-slate-300')}
        <p class="text-[10px] text-slate-500 mt-1.5">Maximum redeemable on this invoice: ${esc(formatCurrency(cap))}</p>
    `;
}

/** Read-only receipt shown once an invoice has been settled. */
function renderSettledInvoice(appointment) {
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

    return `
        <div class="space-y-4">
            <div class="text-center">
                <div class="w-14 h-14 mx-auto rounded-2xl ${appointment.refunded ? 'bg-rose-500/10 text-rose-400' : 'bg-emerald-500/10 text-emerald-400'} flex items-center justify-center" aria-hidden="true">
                    <i data-lucide="${appointment.refunded ? 'undo-2' : 'check-circle-2'}" class="w-6 h-6"></i>
                </div>
                <p class="text-sm font-extrabold text-slate-100 mt-2">${appointment.refunded ? 'Invoice refunded' : 'Invoice settled'}</p>
                <p class="text-[10px] text-slate-500 mt-0.5 font-mono">${esc(invoiceNoFor(appointment.id))}</p>
            </div>

            <div class="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3.5 space-y-1.5">
                ${line('Client', appointment.customerName || '—')}
                ${line('Invoice total', formatCurrency(split.invoiceAmount))}
                ${split.discount > 0 ? line('Client discount', `- ${formatCurrency(split.discount)}`, 'text-amber-400') : ''}
                ${line('Paid from wallet', formatCurrency(split.walletRedeemed), 'text-brand-400')}
                ${line('Paid by ' + methodLabel, formatCurrency(split.amountDue), 'text-emerald-400')}
                ${appointment.walletBalanceBefore !== undefined ? line('Wallet before', formatCurrency(appointment.walletBalanceBefore), 'text-slate-300') : ''}
                ${appointment.walletBalanceAfter !== undefined ? line('Wallet after', formatCurrency(appointment.walletBalanceAfter), 'text-slate-300') : ''}
                ${appointment.paymentReference ? line('Reference', appointment.paymentReference, 'text-slate-300') : ''}
            </div>

            ${appointment.refunded
                ? `<p class="text-[10px] text-rose-400/80 text-center">Refunded on ${esc(String(appointment.refundedAt || '').slice(0, 10))}. Referral rewards earned by this invoice have been reversed.</p>`
                : `<button data-action="refund-invoice" data-id="${escAttr(appointment.id)}"
                        class="w-full py-3.5 bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-rose-600/30 transition active:scale-[0.98] touch-manipulation">Refund this invoice</button>`}
        </div>
    `;
}

/**
 * Billing form for the appointment currently held in `state.modalRecord`.
 */
export function renderPaymentForm(state) {
    const record = state.modalRecord || {};
    const appointment = (state.appointmentsList || []).find((a) => a.id === record.id) || record;
    if (!appointment || !appointment.id) {
        return '<p class="text-xs text-slate-400">This appointment is no longer available.</p>';
    }
    if (appointment.paid === true) {
        return renderSettledInvoice(appointment);
    }

    const services = scopedBySalon(state.servicesList, state.currentSalonId);
    const customer = (state.customersList || []).find((c) => c.id === appointment.customerId) || null;
    const settings = sanitizeSettings(state.referralSettings);
    const invoiceAmount = defaultInvoiceAmount(appointment, services);
    const walletBalance = round2(Math.max(0, num(customer && customer.walletBalance)));
    const canEditDiscount = state.userRole === 'salon_owner';
    const discountType = customer?.discountType || '';
    const discountValue = customer?.discountValue || '';
    const discount = discountAmountFor({ type: discountType, value: discountValue }, invoiceAmount);
    const discountText = discountLabel({ type: discountType, value: discountValue });
    const cap = settings.enabled
        ? maxRedeemable({ walletBalance, invoiceAmount: round2(invoiceAmount - discount), settings })
        : 0;

    const walletBlock = cap > 0
        ? `
            <div class="bg-brand-500/10 border border-brand-500/25 rounded-2xl p-3.5 space-y-2.5">
                <div class="flex items-center justify-between gap-3">
                    <div class="min-w-0">
                        <p class="text-[11px] font-bold text-brand-300 flex items-center gap-1.5">
                            <i data-lucide="wallet" class="w-3.5 h-3.5 shrink-0"></i>
                            <span>Referral wallet</span>
                        </p>
                        <p class="text-[10px] text-slate-400 mt-0.5">Available ${esc(formatCurrency(walletBalance))}</p>
                    </div>
                    <button type="button" data-action="wallet-use-max" data-amount="${escAttr(cap)}"
                        class="px-3 py-1.5 bg-brand-600 hover:bg-brand-500 text-white text-[10px] font-semibold rounded-xl transition active:scale-95 touch-manipulation shrink-0">Use max</button>
                </div>
                ${formField('Redeem from wallet (₹)', textInput('walletRedeem', '0', { type: 'number', required: false, className: 'input-number', value: '' }))}
            </div>
        `
        : `
            <div class="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3.5">
                <p class="text-[11px] text-slate-400 flex items-center gap-1.5">
                    <i data-lucide="wallet" class="w-3.5 h-3.5 shrink-0"></i>
                    <span>${esc(settings.enabled ? `No referral balance available (${formatCurrency(walletBalance)})` : 'Referral programme is disabled')}</span>
                </p>
                <input type="hidden" name="walletRedeem" value="0">
            </div>
        `;

    return `
        <form data-action="collect-payment" class="space-y-3.5" novalidate>
            <input type="hidden" name="id" value="${escAttr(appointment.id)}">

            <div class="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3.5">
                <p class="text-xs font-bold text-slate-100 truncate">${esc(appointment.customerName)}</p>
                <p class="text-[11px] text-slate-400 mt-0.5 truncate">${esc(appointment.serviceName)} • ${esc(appointment.date)} ${esc(appointment.time)}</p>
                <p class="text-[10px] text-slate-500 mt-0.5 font-mono">${esc(invoiceNoFor(appointment.id))}</p>
            </div>

            ${formField('Invoice Amount (₹)', textInput('invoiceAmount', '0', { type: 'number', className: 'input-number', value: invoiceAmount }))}

            ${walletBlock}

            ${formField('Payment Method', selectControl('paymentMethod', PAYMENT_METHODS, 'Choose a method', { required: false, value: appointment.paymentMethod || '' }))}
            ${formField('Reference (optional)', textInput('paymentReference', 'UPI ref / last 4 digits', { required: false, value: '' }))}

            <div class="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3.5 space-y-3">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                    <i data-lucide="badge-percent" class="w-3.5 h-3.5 shrink-0"></i><span>Customer Discount</span>
                </p>
                ${canEditDiscount
                    ? `
                        ${formField('Discount Type', selectControl('discountType', DISCOUNT_TYPE_OPTIONS, 'No discount', { required: false, value: discountType }))}
                        ${formField('Discount Value', textInput('discountValue', '10', { type: 'number', required: false, className: 'input-number', value: discountValue }), 'Applied to this bill and saved for this client\'s future invoices. Capped so it can never exceed the bill amount.')}
                    `
                    : `<p class="text-[11px] text-slate-400">${esc(discountText || 'No discount configured for this client.')}</p>
                       <input type="hidden" name="discountType" value="${escAttr(discountType)}">
                       <input type="hidden" name="discountValue" value="${escAttr(discountValue)}">`}
            </div>

            <div data-payment-summary class="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3.5 space-y-1.5">
                ${renderPaymentSummary({ invoiceAmount, walletRedeem: 0, walletBalance, cap, discount, discountText })}
            </div>

            <button type="submit" class="w-full py-3.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-emerald-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none">Collect Payment</button>
        </form>
    `;
}

export default renderPaymentForm;
