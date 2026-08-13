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
};
