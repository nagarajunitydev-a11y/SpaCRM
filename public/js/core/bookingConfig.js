/**
 * bookingConfig.js
 * Pure rules for the public online-booking configuration: defaults,
 * sanitization/clamping, and the public-safe service/staff snapshot shape
 * that gets denormalized for anonymous readers.
 *
 * Firestore security rules cannot do field-level projection — a `read` rule
 * is all-or-nothing per document. Exposing the real `services`/`staff`
 * collections to anonymous visitors would also expose internal-only fields
 * (a staff member's phone number, for instance). So the salon owner's app
 * publishes a deliberately minimal, public-safe COPY of the bookable catalog
 * into `bookingSettings/config` (see bookingSettingsRepository.js) every time
 * services/staff change, and that is the only document the public booking
 * page ever reads. This module defines exactly what that copy contains.
 */

export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export const WEEKDAY_LABELS = {
    mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
    fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

const DEFAULT_DAY_OPEN = { closed: false, start: '10:00', end: '19:00' };
const DEFAULT_DAY_CLOSED = { closed: true, start: '10:00', end: '19:00' };

export const DEFAULT_WORKING_HOURS = Object.freeze({
    mon: { ...DEFAULT_DAY_OPEN }, tue: { ...DEFAULT_DAY_OPEN }, wed: { ...DEFAULT_DAY_OPEN },
    thu: { ...DEFAULT_DAY_OPEN }, fri: { ...DEFAULT_DAY_OPEN }, sat: { ...DEFAULT_DAY_OPEN },
    sun: { ...DEFAULT_DAY_CLOSED },
});

/** Programme defaults applied when a salon has never saved booking settings. */
export const DEFAULT_BOOKING_SETTINGS = Object.freeze({
    enabled: false,
    displayName: '',
    slotIntervalMinutes: 30,
    advanceBookingDays: 30,
    minNoticeMinutes: 60,
    workingHours: DEFAULT_WORKING_HOURS,
    publicServices: [],
    publicStaff: [],
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function sanitizeDay(raw, fallback) {
    const src = raw && typeof raw === 'object' ? raw : fallback;
    const start = TIME_RE.test(src.start) ? src.start : fallback.start;
    const end = TIME_RE.test(src.end) ? src.end : fallback.end;
    const closed = src.closed === true;
    // A malformed or inverted range is treated as closed rather than silently
    // opening the salon at an unintended time.
    if (!closed && start >= end) return { closed: true, start, end };
    return { closed, start, end };
}

/** Coerce a raw workingHours object into a complete, valid week. */
export function sanitizeWorkingHours(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const key of WEEKDAY_KEYS) {
        out[key] = sanitizeDay(src[key], DEFAULT_WORKING_HOURS[key]);
    }
    return out;
}

const trimTo = (value, max) => String(value == null ? '' : value).trim().slice(0, max);

/** Public-safe service snapshot: id, name, price, duration only. */
export function toPublicServices(servicesList) {
    return (servicesList || [])
        .filter((s) => s && s.id && s.name)
        .slice(0, 200)
        .map((s) => ({
            id: trimTo(s.id, 64),
            name: trimTo(s.name, 120),
            price: Math.max(0, Number(s.price) || 0),
            duration: trimTo(s.duration, 20),
        }));
}

/** Public-safe staff snapshot: id, name, role only (no phone). */
export function toPublicStaff(staffList) {
    return (staffList || [])
        .filter((s) => s && s.id && s.name)
        .slice(0, 200)
        .map((s) => ({
            id: trimTo(s.id, 64),
            name: trimTo(s.name, 120),
            role: trimTo(s.role, 120),
        }));
}

/**
 * Coerce a raw (possibly partial, possibly hostile) settings object into a
 * complete, in-range settings record. Every consumer — the owner's settings
 * form, the public booking page, and the security rules' mirrored limits —
 * reads settings through equivalent bounds, so an out-of-range value can
 * never reach the slot-generation maths.
 */
export function sanitizeBookingSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
        enabled: src.enabled === true,
        displayName: trimTo(src.displayName, 120),
        slotIntervalMinutes: Math.round(clampNumber(src.slotIntervalMinutes, 5, 120, DEFAULT_BOOKING_SETTINGS.slotIntervalMinutes)),
        advanceBookingDays: Math.round(clampNumber(src.advanceBookingDays, 1, 180, DEFAULT_BOOKING_SETTINGS.advanceBookingDays)),
        minNoticeMinutes: Math.round(clampNumber(src.minNoticeMinutes, 0, 1440, DEFAULT_BOOKING_SETTINGS.minNoticeMinutes)),
        workingHours: sanitizeWorkingHours(src.workingHours),
        publicServices: toPublicServices(src.publicServices),
        publicStaff: toPublicStaff(src.publicStaff),
    };
}

/** Local YYYY-MM-DD for a Date (no timezone shift), matching dashboard.js. */
export function localDateStr(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** True when a candidate date string is within the salon's public booking window. */
export function isBookableDate(dateStr, settings, today = localDateStr()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return false;
    if (dateStr < today) return false;
    const s = sanitizeBookingSettings(settings);
    const max = new Date();
    max.setDate(max.getDate() + s.advanceBookingDays);
    return dateStr <= localDateStr(max);
}

export default {
    WEEKDAY_KEYS,
    WEEKDAY_LABELS,
    DEFAULT_WORKING_HOURS,
    DEFAULT_BOOKING_SETTINGS,
    sanitizeWorkingHours,
    toPublicServices,
    toPublicStaff,
    sanitizeBookingSettings,
    localDateStr,
    isBookableDate,
};
