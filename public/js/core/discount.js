/**
 * discount.js
 * Pure maths for the per-client discount applied at checkout.
 *
 * A client's discount lives on their own record (`discountType` /
 * `discountValue`) and is computed fresh against the invoice amount every
 * time — the result is always clamped so it can never exceed the amount it
 * is being applied to, whichever discount type is configured.
 */

import { round2, num } from './referral.js';

export const DISCOUNT_TYPES = { PERCENTAGE: 'percentage', FIXED: 'fixed' };

/** Human label for a client's configured discount, or '' when none is set. */
export function discountLabel(customer) {
    if (!customer) return '';
    if (customer.discountType === DISCOUNT_TYPES.PERCENTAGE) {
        return `${num(customer.discountValue)}% off`;
    }
    if (customer.discountType === DISCOUNT_TYPES.FIXED) {
        return `Flat discount`;
    }
    return '';
}

/**
 * The discount amount a client is eligible for against a given invoice
 * amount. Always non-negative and never larger than the invoice amount
 * itself, regardless of how the discount is configured.
 */
export function customerDiscountFor(customer, invoiceAmount) {
    const amount = Math.max(0, round2(invoiceAmount));
    if (!customer || amount <= 0) return 0;

    const value = Math.max(0, num(customer.discountValue));
    if (customer.discountType === DISCOUNT_TYPES.PERCENTAGE) {
        const pct = Math.min(value, 100);
        return round2(Math.min(amount, (amount * pct) / 100));
    }
    if (customer.discountType === DISCOUNT_TYPES.FIXED) {
        return round2(Math.min(amount, value));
    }
    return 0;
}

export default { DISCOUNT_TYPES, discountLabel, customerDiscountFor };
