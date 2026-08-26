/**
 * scheduling.js
 * Pure appointment-scheduling rules: service duration parsing, working-hours
 * slot generation, staff-conflict detection and "any available staff"
 * selection.
 *
 * This module has no I/O and no dependency on the store or Firestore, so the
 * exact same conflict/availability rules can be shared by the public booking
 * page and unit-tested in isolation. Every existing appointment passed in here
 * is expected to already carry a precomputed `durationMinutes` (see
 * `withDuration` below) — this module never re-derives duration from a
 * service catalog itself, so callers stay in full control of pricing/catalog
 * lookups.
 */

const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

/**
 * Parse a service duration string into whole minutes. Handles every shape the
 * catalog already uses ("90m", "45m") plus common variants ("1h", "1h30m",
 * "1:30", a bare number meaning minutes). Unparseable input is 0 minutes
 * rather than a fabricated default, matching this project's "no invented
 * numbers" convention (see core/revenue.js).
 */
export function parseDurationMinutes(duration) {
    if (duration == null) return 0;
    if (typeof duration === 'number') return Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0;

    const raw = String(duration).trim().toLowerCase();
    if (!raw) return 0;

    // "1:30" -> 1h30m
    const colon = raw.match(/^(\d+):([0-5]\d)$/);
    if (colon) return Number(colon[1]) * 60 + Number(colon[2]);

    // "1h30m", "1h", "90m", "45"
    const hm = raw.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?$/);
    if (hm && (hm[1] || hm[2])) {
        const hours = hm[1] ? Number(hm[1]) : 0;
        const minutes = hm[2] ? Number(hm[2]) : 0;
        return Math.max(0, Math.round(hours * 60 + minutes));
    }

    const bare = Number(raw);
    return Number.isFinite(bare) ? Math.max(0, Math.round(bare)) : 0;
}

/** Total duration (minutes) of a set of selected service names against a catalog. */
export function totalDurationMinutes(selectedNames, catalog) {
    const key = (v) => String(v || '').trim().toLowerCase();
    const byName = new Map((catalog || []).map((s) => [key(s.name), s]));
    return (selectedNames || []).reduce((sum, name) => {
        const svc = byName.get(key(name));
        return sum + (svc ? parseDurationMinutes(svc.duration) : 0);
    }, 0);
}

/** Total catalog price of a set of selected service names. */
export function totalServicePrice(selectedNames, catalog) {
    const key = (v) => String(v || '').trim().toLowerCase();
    const byName = new Map((catalog || []).map((s) => [key(s.name), s]));
    return (selectedNames || []).reduce((sum, name) => {
        const svc = byName.get(key(name));
        return sum + (svc ? Math.max(0, num(svc.price)) : 0);
    }, 0);
}

/**
 * Annotate a list of appointments with a precomputed `durationMinutes`,
 * resolved against a services catalog. This is the shape every function below
 * expects for `existingAppointments` — computing it once per render/submit
 * (instead of per-comparison) keeps conflict checks a plain, fast, pure
 * function of already-known numbers.
 */
export function withDuration(appointments, catalog) {
    return (appointments || []).map((a) => {
        const names = Array.isArray(a.services) ? a.services.map((s) => (typeof s === 'string' ? s : s.name))
            : Array.isArray(a.serviceNames) ? a.serviceNames
                : a.serviceName ? [a.serviceName] : [];
        const minutes = totalDurationMinutes(names, catalog);
        // An appointment whose duration cannot be resolved (unknown/renamed
        // service) still occupies real staff time — treat it as a minimal
        // 1-minute placeholder rather than 0, so it can never be silently
        // double-booked over.
        return { ...a, durationMinutes: minutes > 0 ? minutes : 1 };
    });
}

/* ------------------------------------------------------------------ */
/* Time helpers ("HH:MM" <-> minutes since midnight)                   */
/* ------------------------------------------------------------------ */

export function timeToMinutes(hhmm) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ''));
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesToTime(mins) {
    const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(mins)));
    const h = String(Math.floor(clamped / 60)).padStart(2, '0');
    const m = String(clamped % 60).padStart(2, '0');
    return `${h}:${m}`;
}

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Weekday key ('mon'..'sun') for a YYYY-MM-DD date string, timezone-safe. */
export function weekdayKeyFor(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return WEEKDAY_KEYS[d.getDay()];
}

/**
 * The day's open/close range from a workingHours map (one range per weekday:
 * `{ mon: { closed, start, end }, ... }`), or null when the salon is closed
 * that day / the day is misconfigured.
 */
export function rangeForDate(workingHours, dateStr) {
    const key = weekdayKeyFor(dateStr);
    if (!key || !workingHours) return null;
    const day = workingHours[key];
    if (!day || day.closed) return null;
    const start = timeToMinutes(day.start);
    const end = timeToMinutes(day.end);
    if (start === null || end === null || start >= end) return null;
    return { start, end };
}

/* ------------------------------------------------------------------ */
/* Conflict detection                                                  */
/* ------------------------------------------------------------------ */

/** True for an appointment that occupies a real slot (not cancelled). */
function isBlocking(appointment) {
    return !!appointment && appointment.status !== 'Cancelled';
}

/**
 * True when a candidate [start, start+duration) slot overlaps an existing
 * appointment for the same staff member on the same date. Half-open interval
 * comparison, so back-to-back bookings (one ends exactly when the next
 * starts) are allowed. `existingAppointments` must already carry a numeric
 * `durationMinutes` (see `withDuration`).
 */
export function hasConflict({ existingAppointments, staffName, date, startTime, durationMinutes }) {
    const start = timeToMinutes(startTime);
    if (start === null) return true; // an unparseable time can never be booked
    const end = start + Math.max(0, num(durationMinutes));

    return (existingAppointments || []).some((a) => {
        if (!isBlocking(a)) return false;
        if (a.date !== date) return false;
        if (String(a.staffName || '').trim().toLowerCase() !== String(staffName || '').trim().toLowerCase()) return false;
        const aStart = timeToMinutes(a.time);
        if (aStart === null) return false;
        const aDuration = num(a.durationMinutes) > 0 ? num(a.durationMinutes) : 1;
        const aEnd = aStart + aDuration;
        return start < aEnd && aStart < end;
    });
}

/**
 * Every available start time for one staff member on one date, given the
 * salon's working hours, a slot interval and the total service duration.
 * `nowMinutes` (only relevant when `date` is today) hides past/too-soon slots.
 */
export function availableSlotsForStaff({
    workingHours,
    date,
    slotIntervalMinutes,
    durationMinutes,
    staffName,
    existingAppointments,
    isToday = false,
    nowMinutes = 0,
    minNoticeMinutes = 0,
}) {
    const range = rangeForDate(workingHours, date);
    if (!range) return [];

    const interval = Math.max(5, num(slotIntervalMinutes) || 30);
    const duration = Math.max(0, num(durationMinutes));
    const cutoff = isToday ? nowMinutes + Math.max(0, num(minNoticeMinutes)) : -Infinity;

    const slots = [];
    for (let t = range.start; t + duration <= range.end; t += interval) {
        if (t < cutoff) continue;
        const startTime = minutesToTime(t);
        if (hasConflict({ existingAppointments, staffName, date, startTime, durationMinutes: duration })) continue;
        slots.push(startTime);
    }
    return slots;
}

/**
 * Slots available when the customer picks "Any Available Staff": the union of
 * every staff member's free slots, each entry naming the first staff member
 * who is actually free at that time (a stable, deterministic assignment).
 */
export function availableSlotsAnyStaff({
    workingHours,
    date,
    slotIntervalMinutes,
    durationMinutes,
    staffList,
    existingAppointments,
    isToday = false,
    nowMinutes = 0,
    minNoticeMinutes = 0,
}) {
    const byTime = new Map();
    for (const staff of staffList || []) {
        const mine = availableSlotsForStaff({
            workingHours, date, slotIntervalMinutes, durationMinutes,
            staffName: staff.name, existingAppointments, isToday, nowMinutes, minNoticeMinutes,
        });
        for (const t of mine) {
            if (!byTime.has(t)) byTime.set(t, staff.name);
        }
    }
    return [...byTime.entries()]
        .sort((a, b) => timeToMinutes(a[0]) - timeToMinutes(b[0]))
        .map(([time, staffName]) => ({ time, staffName }));
}

/**
 * Resolve "Any Available Staff" to one concrete staff member for a specific
 * chosen time, or null when nobody is actually free (re-checked at submit
 * time so a stale slot list can never silently double-book).
 */
export function pickAnyAvailableStaff({ staffList, existingAppointments, date, startTime, durationMinutes }) {
    for (const staff of staffList || []) {
        if (!hasConflict({ existingAppointments, staffName: staff.name, date, startTime, durationMinutes })) {
            return staff.name;
        }
    }
    return null;
}

export const ANY_STAFF = 'Any Available Staff';

/* ------------------------------------------------------------------ */
/* Slot locks — the atomic double-booking guard                        */
/* ------------------------------------------------------------------ */

/**
 * Fine-grained lock granularity (minutes). Deliberately fixed and NOT the
 * same as the owner-configurable `slotIntervalMinutes` (which only controls
 * how far apart SELECTABLE start times are shown): a fixed 5-minute grid lets
 * appointments of any duration be locked precisely, regardless of what
 * display interval the salon happens to be using.
 */
export const LOCK_GRANULARITY_MINUTES = 5;

/** URL/doc-id-safe slug for a staff name ("Victoria Sterling" -> "victoria-sterling"). */
export function slugifyStaffName(staffName) {
    return String(staffName || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'staff';
}

/** Deterministic lock document id for one staff member at one 5-minute tick. */
export function slotLockKey(staffName, date, time) {
    return `${slugifyStaffName(staffName)}_${date}_${String(time).replace(':', '')}`;
}

/**
 * Every 5-minute tick a [startTime, startTime+durationMinutes) span occupies,
 * as "HH:MM" strings. An appointment must hold a lock on EVERY tick it spans
 * for a conflicting appointment (at any other grid-aligned start time) to be
 * reliably detected — this is what makes the guarantee correct for services
 * of differing durations, not just identical back-to-back slot picks.
 */
export function ticksForSpan(startTime, durationMinutes) {
    const start = timeToMinutes(startTime);
    if (start === null) return [];
    const alignedStart = Math.floor(start / LOCK_GRANULARITY_MINUTES) * LOCK_GRANULARITY_MINUTES;
    const end = start + Math.max(LOCK_GRANULARITY_MINUTES, num(durationMinutes));
    const ticks = [];
    for (let t = alignedStart; t < end; t += LOCK_GRANULARITY_MINUTES) {
        ticks.push(minutesToTime(t));
    }
    return ticks;
}

/** The full set of lock document ids one booking must acquire. */
export function lockKeysForBooking(staffName, date, startTime, durationMinutes) {
    return ticksForSpan(startTime, durationMinutes).map((t) => slotLockKey(staffName, date, t));
}

export default {
    parseDurationMinutes,
    totalDurationMinutes,
    totalServicePrice,
    withDuration,
    timeToMinutes,
    minutesToTime,
    weekdayKeyFor,
    rangeForDate,
    hasConflict,
    availableSlotsForStaff,
    availableSlotsAnyStaff,
    pickAnyAvailableStaff,
    ANY_STAFF,
    LOCK_GRANULARITY_MINUTES,
    slugifyStaffName,
    slotLockKey,
    ticksForSpan,
    lockKeysForBooking,
};
