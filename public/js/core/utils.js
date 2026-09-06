/**
 * utils.js
 * Small shared helpers.
 */

export function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const inrFormatter = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
});

export function formatCurrency(value) {
    const num = Number(value) || 0;
    return inrFormatter.format(num);
}

export function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/** Today's date as a local YYYY-MM-DD string. */
export function todayStr() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Curated IANA timezones offered on the salon provisioning form. */
export const TIMEZONE_OPTIONS = [
    { value: 'UTC', label: 'UTC (Coordinated Universal Time)' },
    { value: 'Asia/Kolkata', label: 'India (Asia/Kolkata)' },
    { value: 'Asia/Dubai', label: 'UAE (Asia/Dubai)' },
    { value: 'Asia/Singapore', label: 'Singapore (Asia/Singapore)' },
    { value: 'Asia/Tokyo', label: 'Japan (Asia/Tokyo)' },
    { value: 'Australia/Sydney', label: 'Australia (Australia/Sydney)' },
    { value: 'Europe/London', label: 'UK (Europe/London)' },
    { value: 'Europe/Paris', label: 'Central Europe (Europe/Paris)' },
    { value: 'America/New_York', label: 'US Eastern (America/New_York)' },
    { value: 'America/Chicago', label: 'US Central (America/Chicago)' },
    { value: 'America/Los_Angeles', label: 'US Pacific (America/Los_Angeles)' },
];

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * The salon's current wall-clock date/time. A salon configured with a
 * `timezone` (IANA) is rendered in that timezone; otherwise the device's own
 * local time is the salon time (legacy behaviour). Returns the record-shaped
 * `{ date, time }` pair (YYYY-MM-DD / HH:mm) plus a human label and ISO stamp.
 */
export function currentSalonDateTime(salon, now = new Date()) {
    const tz = salon && salon.timezone ? salon.timezone : '';

    if (!tz) {
        const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
        const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
        return {
            date,
            time,
            label: `${date} · ${time}`,
            iso: now.toISOString(),
        };
    }

    const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const fmtLabel = new Intl.DateTimeFormat('en-IN', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
    const fmtLabelTime = new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: '2-digit', minute: '2-digit' });

    const [year, month, day] = fmtDate.format(now).split('-');
    // Some engines render midnight in en-GB as "24:xx" — normalise to "00:xx".
    const time = fmtTime.format(now).replace(/^24:/, '00:');
    const date = `${year}-${month}-${day}`;
    const label = `${fmtLabel.format(now)}, ${fmtLabelTime.format(now)}`;
    return { date, time, label, iso: now.toISOString() };
}

/** Debounce a function. */
export function debounce(fn, wait = 150) {
    let timer = null;
    return function debounced(...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), wait);
    };
}

/** Read the current URL origin path prefix (handles non-root hosting). */
export function basePath() {
    const path = (globalThis.location?.pathname || '/');
    const lastSlash = path.lastIndexOf('/');
    return lastSlash > 0 ? path.slice(0, lastSlash + 1) : '/';
}

/**
 * Live-sanitize a phone-number `<input>` as the user types: strips every
 * non-digit character and truncates to `maxLength` digits, preserving the
 * cursor position. Used on every `type="tel"` field in the app so a phone
 * number can never be typed with letters/symbols or beyond the digit cap —
 * the same 10-digit rule `core/validate.js` enforces again before any save.
 * No-ops (and returns false) for anything that isn't a phone input.
 */
export function sanitizePhoneInputLive(el, maxLength = 10) {
    if (!el || el.tagName !== 'INPUT' || el.type !== 'tel') return false;
    const original = el.value;
    const selStart = el.selectionStart ?? original.length;
    const digitsBeforeCursor = original.slice(0, selStart).replace(/\D/g, '').length;
    const digitsOnly = original.replace(/\D/g, '').slice(0, maxLength);
    if (digitsOnly === original) return false;
    el.value = digitsOnly;
    const newPos = Math.min(digitsBeforeCursor, digitsOnly.length);
    try { el.setSelectionRange(newPos, newPos); } catch (e) { /* some input states don't support selection */ }
    return true;
}

/**
 * Keep only records that belong to the active salon. Records without a
 * `salonId` (legacy) pass through; anything explicitly tagged to another salon
 * is dropped. This is a render-layer defence-in-depth on top of the scoped
 * Firestore subscription.
 */
export function scopedBySalon(rows, salonId) {
    const list = rows || [];
    if (!salonId) return list;
    return list.filter((row) => !row.salonId || row.salonId === salonId);
}

export default {
    makeId,
    formatCurrency,
    initials,
    clamp,
    debounce,
    basePath,
    scopedBySalon,
    todayStr,
    currentSalonDateTime,
    TIMEZONE_OPTIONS,
    sanitizePhoneInputLive,
};
