/**
 * validate.js
 * Shared, reusable client-side validation for data-entry forms.
 *
 * The central submit delegation in main.js runs `validateForm` for every
 * entity form before any handler executes. A failing form is never submitted,
 * so invalid data can never reach the repository layer or Firestore.
 *
 * All validation operates on already-trimmed values (readFormData trims).
 */

import { isValidCodeFormat, normalizeCode, REWARD_TYPES, REWARD_TRIGGERS, num, round2 } from './referral.js';
import { todayStr } from './utils.js';
import { discountAmountFor } from './discount.js';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Default country dial code (India). */
export const IN_DIAL_CODE = '91';

/** Valid staff attendance statuses. */
export const ATTENDANCE_STATUSES = ['Present', 'Absent', 'Late', 'Half Day', 'Leave'];

/**
 * Reduce any phone input to its national digits. Non-digit characters are
 * stripped and a leading +91 country code is removed when it is followed by
 * more than the expected 10 digits (a bare national number that merely starts
 * with 91 is left untouched).
 */
export function normalizePhoneDigits(value) {
    let digits = String(value == null ? '' : value).replace(/\D/g, '');
    if (digits.startsWith(IN_DIAL_CODE) && digits.length > 10) {
        digits = digits.slice(IN_DIAL_CODE.length);
    }
    return digits;
}

/** True when the value is a valid 10-digit Indian mobile number. */
export function isValidIndianPhone(value) {
    return normalizePhoneDigits(value).length === 10;
}

/**
 * Normalise a valid input to the +91XXXXXXXXXX E.164 form so records always
 * store the full international number. Returns '' when the input is invalid.
 */
export function toIndianE164(value) {
    const digits = normalizePhoneDigits(value);
    return digits.length === 10 ? `+${IN_DIAL_CODE}${digits}` : '';
}

/** True for empty, null, undefined, or whitespace-only values. */
export function isBlank(value) {
    return value === null || value === undefined || String(value).trim() === '';
}

/** Validate a YYYY-MM-DD calendar date (rejects 2026-13-45, 2026-02-30…). */
export function isValidDate(value) {
    if (!DATE_RE.test(String(value))) return false;
    const [y, m, d] = String(value).split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function nowHM() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const required = (msg) => (v) => (isBlank(v) ? msg : null);
const email = (msg) => (v) => (isBlank(v) ? null : EMAIL_RE.test(v) ? null : msg);
const dateValid = (msg) => (v) => (isBlank(v) ? null : isValidDate(v) ? null : msg);
const timeValid = (msg) => (v) => (isBlank(v) ? null : TIME_RE.test(v) ? null : msg);
const numberMin = (min, msg) => (v) => {
    if (isBlank(v)) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? null : msg;
};
const indianPhone = (msg) => (v) => (isBlank(v) ? null : isValidIndianPhone(v) ? null : msg);
const numberMax = (max, msg) => (v) => {
    if (isBlank(v)) return null;
    const n = Number(v);
    return Number.isFinite(n) && n <= max ? null : msg;
};
/** Optional referral code: blank is fine, anything present must be well-formed. */
const referralCode = (msg) => (v) => (isBlank(v) ? null : isValidCodeFormat(v) ? null : msg);
/** A date that must not fall after today (used for date of birth). */
const dateNotFuture = (msg) => (v) => (isBlank(v) || !isValidDate(v) ? null : String(v) > todayStr() ? msg : null);
/** A birth year within a plausible human lifespan. */
const plausibleBirthYear = (msg) => (v) => {
    if (isBlank(v) || !isValidDate(v)) return null;
    const year = Number(String(v).slice(0, 4));
    return year >= new Date().getFullYear() - 120 ? null : msg;
};

/** Runs every validator for a field, stopping at the first failure. */
function check(errors, field, value, validators) {
    for (const fn of validators) {
        const err = fn(value);
        if (err) {
            errors[field] = err;
            return;
        }
    }
}

/**
 * Validates form data by form action key. Returns a map of
 * `{ field: message }` for invalid fields (empty when valid).
 *
 * `ctx` carries context only the caller knows (e.g. `{ signup: true }` for the
 * email-auth form). Every schema rejects blank, whitespace-only, null and
 * undefined values, so a fully trimmed form can never pass with an empty
 * required field.
 */
export function validateForm(formKey, data, ctx = {}) {
    const errors = {};
    const v = (k) => data[k];

    if (formKey === 'submit-appointment') {
        check(errors, 'customerName', v('customerName'), [required('Client name is required.')]);
        let selectedServices = [];
        try { selectedServices = JSON.parse(v('selectedServices') || '[]'); } catch { selectedServices = []; }
        const hasSelectedService = Array.isArray(selectedServices) && selectedServices.some((name) => String(name || '').trim());
        if (!hasSelectedService) check(errors, 'serviceName', v('serviceName'), [required('Select a service.')]);
        check(errors, 'staffName', v('staffName'), [required('Select a staff member.')]);

        const date = v('date');
        check(errors, 'date', date, [required('Date is required.'), dateValid('Enter a valid date.')]);
        if (!errors.date && String(date) < todayStr()) {
            errors.date = 'Date must be today or later.';
        }

        const time = v('time');
        check(errors, 'time', time, [required('Time is required.'), timeValid('Enter a valid time (e.g. 14:30).')]);
        if (!errors.time && String(date) === todayStr() && String(time) < nowHM()) {
            errors.time = 'This time has already passed today.';
        }

        if (v('paid') === 'on' || v('paid') === true) {
            check(errors, 'amount', v('amount'), [required('Amount is required when marking as paid.'), numberMin(0, 'Enter a valid amount.')]);
            check(errors, 'paymentMethod', v('paymentMethod'), [required('Select a payment method.')]);
        }

        check(errors, 'amount', v('amount'), [numberMin(0, 'Amount must be zero or more.')]);
        check(errors, 'discount', v('discount'), [numberMin(0, 'Discount must be zero or more.')]);
        check(errors, 'tax', v('tax'), [numberMin(0, 'Tax must be zero or more.')]);
        check(errors, 'refund', v('refund'), [numberMin(0, 'Refund must be zero or more.')]);
        check(errors, 'loyaltyRedemption', v('loyaltyRedemption'), [numberMin(0, 'Loyalty redemption must be zero or more.')]);

        return errors;
    }

    if (formKey === 'submit-customer') {
        check(errors, 'name', v('name'), [required('Name is required.')]);
        check(errors, 'phone', v('phone'), [required('Phone number is required.'), indianPhone('Enter a valid 10-digit Indian mobile number (e.g. 98765 43210).')]);
        check(errors, 'email', v('email'), [email('Enter a valid email address.')]);
        // The referral code is optional; when supplied it must be a valid code.
        // Whether it actually resolves to another client (and is not a
        // self-referral) is decided by referralService.validateReferralCode.
        check(errors, 'referralCode', v('referralCode'), [referralCode('Enter a valid 8-character referral code.')]);
        check(errors, 'dob', v('dob'), [
            dateValid('Enter a valid date.'),
            dateNotFuture('Date of birth cannot be in the future.'),
            plausibleBirthYear('Enter a valid date of birth.'),
        ]);
        return errors;
    }

    if (formKey === 'collect-payment') {
        check(errors, 'invoiceAmount', v('invoiceAmount'), [
            required('Invoice amount is required.'),
            numberMin(0.01, 'Enter a valid invoice amount.'),
        ]);
        check(errors, 'walletRedeem', v('walletRedeem'), [numberMin(0, 'Redemption must be zero or more.')]);

        const discountType = v('discountType');
        if (!isBlank(discountType) && discountType !== 'percentage' && discountType !== 'fixed') {
            errors.discountType = 'Select a valid discount type.';
        }
        if (!isBlank(discountType)) {
            const discountRules = [numberMin(0, 'Discount value must be zero or more.')];
            if (discountType === 'percentage') discountRules.push(numberMax(100, 'A percentage discount cannot exceed 100%.'));
            check(errors, 'discountValue', v('discountValue'), discountRules);
        }

        const invoice = round2(num(v('invoiceAmount')));
        const redeem = round2(num(v('walletRedeem')));
        const discount = errors.discountType || errors.discountValue
            ? 0
            : discountAmountFor({ type: discountType, value: v('discountValue') }, invoice);
        if (!errors.walletRedeem && redeem > round2(invoice - discount)) {
            errors.walletRedeem = 'Redemption cannot exceed the invoice amount.';
        }
        // A cash/UPI/card leg is only required when the discount + wallet don't
        // already cover the whole invoice (a fully covered invoice needs no method).
        if (!errors.walletRedeem && round2(invoice - discount - redeem) > 0) {
            check(errors, 'paymentMethod', v('paymentMethod'), [required('Select a payment method.')]);
        }
        return errors;
    }

    if (formKey === 'submit-referral-settings') {
        const rewardType = v('rewardType');
        if (rewardType !== REWARD_TYPES.FIXED && rewardType !== REWARD_TYPES.PERCENT) {
            errors.rewardType = 'Select a reward type.';
        }

        const valueRules = [required('Reward value is required.'), numberMin(0, 'Reward value must be zero or more.')];
        if (rewardType === REWARD_TYPES.PERCENT) valueRules.push(numberMax(100, 'A percentage reward cannot exceed 100%.'));
        check(errors, 'rewardValue', v('rewardValue'), valueRules);

        check(errors, 'maxRewardAmount', v('maxRewardAmount'), [numberMin(0, 'Reward cap must be zero or more.')]);
        check(errors, 'minInvoiceAmount', v('minInvoiceAmount'), [
            required('Minimum invoice amount is required.'),
            numberMin(0, 'Minimum invoice amount must be zero or more.'),
        ]);
        check(errors, 'expiryDays', v('expiryDays'), [
            required('Expiry period is required.'),
            numberMin(0, 'Expiry period must be zero or more days.'),
            numberMax(3650, 'Expiry period cannot exceed 3650 days.'),
        ]);
        check(errors, 'maxRedemptionPercent', v('maxRedemptionPercent'), [
            required('Maximum redemption percentage is required.'),
            numberMin(0, 'Maximum redemption must be zero or more.'),
            numberMax(100, 'Maximum redemption cannot exceed 100%.'),
        ]);

        const trigger = v('rewardTrigger');
        if (trigger !== REWARD_TRIGGERS.INVOICE_PAID && trigger !== REWARD_TRIGGERS.APPOINTMENT_COMPLETED) {
            errors.rewardTrigger = 'Select when the reward is credited.';
        }
        return errors;
    }

    if (formKey === 'submit-service') {
        check(errors, 'name', v('name'), [required('Service title is required.')]);
        check(errors, 'price', v('price'), [required('Price is required.'), numberMin(0, 'Enter a valid price.')]);
        check(errors, 'duration', v('duration'), [required('Duration is required.')]);
        return errors;
    }

    if (formKey === 'submit-staff') {
        check(errors, 'name', v('name'), [required('Staff name is required.')]);
        check(errors, 'role', v('role'), [required('Role / specialization is required.')]);
        check(errors, 'phone', v('phone'), [required('Phone number is required.'), indianPhone('Enter a valid 10-digit Indian mobile number (e.g. 98765 43210).')]);
        return errors;
    }

    if (formKey === 'submit-attendance') {
        check(errors, 'staffId', v('staffId'), [required('Select a staff member.')]);
        check(errors, 'date', v('date'), [required('Date is required.'), dateValid('Enter a valid date.')]);
        if (!ATTENDANCE_STATUSES.includes(v('status'))) {
            errors.status = 'Select a valid status.';
        }
        check(errors, 'checkIn', v('checkIn'), [timeValid('Enter a valid check-in time.')]);
        check(errors, 'checkOut', v('checkOut'), [timeValid('Enter a valid check-out time.')]);
        return errors;
    }

    if (formKey === 'submit-salon') {
        check(errors, 'name', v('name'), [required('Salon name is required.')]);
        const salonEmail = data.ownerEmail ?? data.email;
        check(errors, 'email', salonEmail, [required('Owner email is required.'), email('Enter a valid email address.')]);
        check(errors, 'phone', v('phone'), [required('Phone number is required.'), indianPhone('Enter a valid 10-digit Indian mobile number (e.g. 98765 43210).')]);
        check(errors, 'address', v('address'), [required('Location address is required.')]);
        return errors;
    }

    if (formKey === 'email-auth') {
        if (ctx.signup) {
            check(errors, 'salonName', v('salonName'), [required('Salon name is required.')]);
        }
        check(errors, 'email', v('email'), [required('Email is required.'), email('Enter a valid email address.')]);
        check(errors, 'password', v('password'), [required('Password is required.')]);
        return errors;
    }

    return errors;
}

export default { validateForm, isBlank, isValidDate, isValidIndianPhone, toIndianE164, normalizePhoneDigits, normalizeCode, EMAIL_RE, TIME_RE, DATE_RE };
