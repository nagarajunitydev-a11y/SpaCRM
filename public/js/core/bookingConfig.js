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

import { parseDurationMinutes } from './scheduling.js';

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

/** Order-insensitive fingerprint of a public catalog snapshot, for staleness checks. */
function catalogSignature(rows, fields) {
    return JSON.stringify((rows || []).map((r) => fields.map((f) => r[f])).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

const SETTINGS_FORM_FIELDS = ['enabled', 'displayName', 'slotIntervalMinutes', 'advanceBookingDays', 'minNoticeMinutes', 'workingHours'];

/**
 * Everything that would make the public booking link unusable for a
 * customer, judged against the settings document AS PERSISTED in Firestore
 * (`saved`: the raw stored document, or null when it was never saved).
 * Returns [] when the link is safe to share; otherwise one
 * `{ code, message, fix }` per problem, where `fix` names where the owner
 * resolves it: 'settings' (this Booking Link form), 'services' or 'staff'.
 *
 * Optional context:
 *   catalogServices / catalogStaff - the salon's live catalog; when the
 *     published snapshot no longer matches it, the latest changes have not
 *     reached the booking page yet.
 *   draft - the settings currently entered in the (possibly unsaved) form;
 *     when it differs from what is stored, the owner has unsaved changes.
 */
export function bookingReadinessIssues(saved, { catalogServices, catalogStaff, draft } = {}) {
    if (!saved || typeof saved !== 'object') {
        return [{ code: 'not-saved', message: 'Booking settings have not been saved yet. Review them and tap Save Booking Settings.', fix: 'settings' }];
    }
    const s = sanitizeBookingSettings(saved);
    const issues = [];

    if (draft) {
        const d = sanitizeBookingSettings({ ...s, ...draft });
        // A closed day's times are disabled (never submitted) in the form, so
        // only its closed flag is meaningful when comparing.
        const comparable = (x) => SETTINGS_FORM_FIELDS.map((k) => (k === 'workingHours'
            ? WEEKDAY_KEYS.map((day) => (x.workingHours[day].closed ? 'closed' : `${x.workingHours[day].start}-${x.workingHours[day].end}`))
            : x[k]));
        const changed = JSON.stringify(comparable(d)) !== JSON.stringify(comparable(s));
        if (changed) issues.push({ code: 'unsaved', message: 'You have unsaved changes to the booking settings. Tap Save Booking Settings first.', fix: 'settings' });
    }
    if (!s.enabled) {
        issues.push({ code: 'disabled', message: 'Online Booking is switched off. Turn it on and save.', fix: 'settings' });
    }
    if (WEEKDAY_KEYS.every((k) => s.workingHours[k].closed)) {
        issues.push({ code: 'no-hours', message: 'Working hours: every day is closed (or has an end time before its start time). Set at least one open day and save.', fix: 'settings' });
    }
    if (s.publicServices.length === 0) {
        issues.push({ code: 'no-services', message: 'No bookable services are published. Add services, then save the booking settings.', fix: 'services' });
    } else {
        const noDuration = s.publicServices.filter((svc) => parseDurationMinutes(svc.duration) <= 0).map((svc) => svc.name);
        if (noDuration.length) {
            issues.push({ code: 'no-duration', message: `These services need a valid duration (e.g. 45m or 1h30m): ${noDuration.join(', ')}.`, fix: 'services' });
        }
    }
    if (s.publicStaff.length === 0) {
        issues.push({ code: 'no-staff', message: 'No staff members are published, so customers cannot see any available times. Add staff, then save the booking settings.', fix: 'staff' });
    }
    const servicesStale = Array.isArray(catalogServices)
        && catalogSignature(toPublicServices(catalogServices), ['id', 'name', 'price', 'duration']) !== catalogSignature(s.publicServices, ['id', 'name', 'price', 'duration']);
    const staffStale = Array.isArray(catalogStaff)
        && catalogSignature(toPublicStaff(catalogStaff), ['id', 'name']) !== catalogSignature(s.publicStaff, ['id', 'name']);
    if (servicesStale || staffStale) {
        issues.push({ code: 'stale-catalog', message: `Your latest ${servicesStale && staffStale ? 'service and staff' : servicesStale ? 'service' : 'staff'} changes are not on the booking page yet. Tap Save Booking Settings to publish them.`, fix: 'settings' });
    }
    return issues;
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
    bookingReadinessIssues,
};
