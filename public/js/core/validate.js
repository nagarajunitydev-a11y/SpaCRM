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

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

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

function todayStr() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
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
        check(errors, 'serviceName', v('serviceName'), [required('Select a service.')]);
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

        return errors;
    }

    if (formKey === 'submit-customer') {
        check(errors, 'name', v('name'), [required('Name is required.')]);
        check(errors, 'phone', v('phone'), [required('Phone number is required.')]);
        check(errors, 'email', v('email'), [required('Email is required.'), email('Enter a valid email address.')]);
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
        check(errors, 'phone', v('phone'), [required('Phone number is required.')]);
        return errors;
    }

    if (formKey === 'submit-salon') {
        check(errors, 'name', v('name'), [required('Salon name is required.')]);
        // Forms post `email`; the stored field is `ownerEmail` (ownerAuth seed).
        const salonEmail = data.ownerEmail ?? data.email;
        check(errors, 'email', salonEmail, [required('Owner email is required.'), email('Enter a valid email address.')]);
        check(errors, 'phone', v('phone'), [required('Phone number is required.')]);
        check(errors, 'address', v('address'), [required('Location address is required.')]);
        return errors;
    }

    if (formKey === 'email-auth') {
        // During signup a salon name is mandatory; sign-in has no salon field.
        if (ctx.signup) {
            check(errors, 'salonName', v('salonName'), [required('Salon name is required.')]);
        }
        check(errors, 'email', v('email'), [required('Email is required.'), email('Enter a valid email address.')]);
        check(errors, 'password', v('password'), [required('Password is required.')]);
        return errors;
    }

    return errors;
}

export default { validateForm, isBlank, isValidDate, EMAIL_RE, TIME_RE, DATE_RE };
