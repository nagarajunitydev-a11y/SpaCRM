/**
 * discount.js
 * Pure maths for the per-client discount applied at checkout.
 *
 * A client's discount (`discountType` / `discountValue`) is configured from
 * the Payment window (see ui/views/payment.js) and persisted onto their own
 * customer record so it carries forward to future invoices. It is computed
 * fresh against the invoice amount every time — the result is always
 * clamped so it can never exceed the amount it is being applied to,
 * whichever discount type is configured.
 */

import { round2, num } from './referral.js';

export const DISCOUNT_TYPES = { PERCENTAGE: 'percentage', FIXED: 'fixed' };

/** Human label for a `{ type, value }` discount, or '' when none is set. */
export function discountLabel({ type, value } = {}) {
    if (type === DISCOUNT_TYPES.PERCENTAGE) return `${num(value)}% off`;
    if (type === DISCOUNT_TYPES.FIXED) return 'Flat discount';
    return '';
}

/**
 * The discount amount eligible against a given invoice amount, for a
 * `{ type, value }` discount configuration. Always non-negative and never
 * larger than the invoice amount itself, regardless of how the discount is
 * configured — a percentage is capped at 100%, a fixed amount at the
 * invoice total, so it can never exceed the bill it is applied to.
 */
export function discountAmountFor({ type, value } = {}, invoiceAmount) {
    const amount = Math.max(0, round2(invoiceAmount));
    if (amount <= 0) return 0;

    const v = Math.max(0, num(value));
    if (type === DISCOUNT_TYPES.PERCENTAGE) {
        const pct = Math.min(v, 100);
        return round2(Math.min(amount, (amount * pct) / 100));
    }
    if (type === DISCOUNT_TYPES.FIXED) {
        return round2(Math.min(amount, v));
    }
    return 0;
}

export default { DISCOUNT_TYPES, discountLabel, discountAmountFor };
