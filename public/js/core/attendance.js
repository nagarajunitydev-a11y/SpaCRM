/**
 * core/attendance.js
 * Pure, unit-testable staff attendance logic: consolidation of per-staff/day
 * records into single display records, working-hours maths, and the monthly
 * attendance report (one row per staff member + salon-wide totals).
 *
 * The Firestore model stays untouched — one document per staff/day keyed
 * `{staffId}_{date}` (see attendanceRepository.js). Consolidation here is a
 * display-time concern and only ever READS: if several underlying rows exist
 * for a staff member on the same day, they collapse into one record for the
 * roster/report without mutating or deleting anything. The original rows are
 * never modified.
 */

import { ATTENDANCE_STATUSES } from './validate.js';

const TIME_RE = /^(\d{1,2}):([0-5]\d)$/;

/** Stable key identifying a staff member on a given day. */
export function attendanceGroupKey(row) {
    const staff = String((row && (row.staffId || row.staffName)) || '').trim();
    const date = String(row && row.date || '');
    return `${staff}::${date}`;
}

/** "HH:mm" -> minutes since midnight, or null when not a valid time. */
function timeToMinutes(value) {
    const match = TIME_RE.exec(String(value || '').trim());
    if (!match) return null;
    const hh = Number(match[1]);
    if (hh > 23) return null;
    return hh * 60 + Number(match[2]);
}

/** Working minutes between check-in and check-out (same day), or null. */
export function workingHoursMinutes(checkIn, checkOut) {
    const from = timeToMinutes(checkIn);
    const to = timeToMinutes(checkOut);
    if (from == null || to == null || to <= from) return null;
    return to - from;
}

/** Human label for working hours: "8h", "8h 30m", or "—" when unavailable. */
export function workingHoursLabel(checkIn, checkOut) {
    const minutes = workingHoursMinutes(checkIn, checkOut);
    if (minutes == null) return '—';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Collapse every record for the same staff member on the same day into one
 * display record. The most recently updated underlying row wins the status
 * (ties resolve to the later `createdAt`); check-in/out and notes fall back to
 * the earliest other non-empty value so no detail is lost. `events` records
 * how many underlying rows were combined.
 */
export function consolidateAttendanceRecords(records) {
    const list = records || [];
    const groups = new Map();

    list.forEach((row) => {
        if (!row || !row.date) return;
        const key = attendanceGroupKey(row);
        if (!key || key === '::') return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    });

    const order = [...groups.keys()];
    order.sort((a, b) => list.findIndex((r) => attendanceGroupKey(r) === a) - list.findIndex((r) => attendanceGroupKey(r) === b));

    return order.map((key) => {
        const rows = groups.get(key);
        const sorted = [...rows].sort((a, b) =>
            String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
        const primary = sorted[0];
        const fallback = sorted.find((r) => r !== primary) || primary;

        const pickTime = (field) => {
            const own = timeToMinutes(primary[field]) != null ? primary[field] : '';
            return own !== '' ? String(own).trim() : String(fallback[field] || '').trim();
        };

        return {
            ...primary,
            checkIn: pickTime('checkIn'),
            checkOut: pickTime('checkOut'),
            notes: primary.notes || fallback.notes || '',
            events: rows.length,
        };
    });
}

/** Map an attendance status to its report counter. */
function statusCounter(status) {
    switch (status) {
        case 'Present': return 'present';
        case 'Absent': return 'absent';
        case 'Late': return 'late';
        case 'Half Day': return 'halfDay';
        case 'Leave': return 'leave';
        default: return null;
    }
}

const WORKED = new Set(['present', 'late', 'halfDay']);

/** 0–100 attendance %, or null when no day was eligible. */
function attendedPct(workingDays, absent, leave) {
    const base = workingDays + absent + leave;
    if (!(base > 0)) return null;
    return Math.round((workingDays / base) * 1000) / 10;
}

function freshStaffRow(staffId, staffName) {
    return {
        staffId: staffId || '',
        staffName: staffName || 'Unnamed staff',
        present: 0,
        absent: 0,
        late: 0,
        halfDay: 0,
        leave: 0,
        workingDays: 0,
        totalHours: 0,
        attendancePct: null,
        days: 0,
        records: 0,
    };
}

/**
 * Monthly attendance report.
 *
 * @param {Array} records  Attendance rows for the active salon.
 * @param {Object} opts    { month: 'YYYY-MM', staffId: 'all' | id, roster: [] }
 * @returns {{ rows: Array, totals: Object }}
 *
 * rows — one per staff member (roster order first, then any others), each with
 * Present/Absent/Late/Half Day/Leave day counts, Total Working Days
 * (Present + Late + Half Day), Total Hours (computed from check-in/out on
 * worked days) and Attendance % = workingDays / (workingDays + absent + leave).
 *
 * totals — salon-wide equivalents plus team size, for the summary cards.
 */
export function monthlyAttendanceReport(records, { month, staffId = 'all', roster = null } = {}) {
    const monthKey = String(month || '');
    const scoped = (records || []).filter((row) =>
        row && String(row.date || '').startsWith(monthKey)
        && (staffId === 'all' || !staffId || String(row.staffId) === String(staffId)));

    const byStaff = new Map();
    consolidateAttendanceRecords(scoped).forEach((row) => {
        const id = row.staffId || row.staffName || 'unknown';
        if (!byStaff.has(id)) {
            byStaff.set(id, freshStaffRow(row.staffId, row.staffName));
        }
        const tally = byStaff.get(id);
        const counter = statusCounter(row.status);
        tally.days += 1;
        tally.records += row.events || 1;
        if (counter) {
            tally[counter] += 1;
            if (WORKED.has(counter)) {
                tally.workingDays += 1;
                const minutes = workingHoursMinutes(row.checkIn, row.checkOut);
                if (minutes != null) tally.totalHours += minutes;
            }
        }
    });

    byStaff.forEach((tally) => {
        tally.attendancePct = attendedPct(tally.workingDays, tally.absent, tally.leave);
    });

    const rows = [];
    const seen = new Set();
    (roster || []).forEach((member) => {
        if (!member) return;
        const id = member.id || member.staffId || member.name;
        rows.push(byStaff.get(id) || freshStaffRow(id, member.name));
        seen.add(id);
    });
    byStaff.forEach((tally) => {
        if (!seen.has(tally.staffId) && !seen.has(tally.staffName)) rows.push(tally);
    });

    const totals = rows.reduce((acc, tally) => {
        acc.present += tally.present;
        acc.absent += tally.absent;
        acc.late += tally.late;
        acc.halfDay += tally.halfDay;
        acc.leave += tally.leave;
        acc.workingDays += tally.workingDays;
        acc.totalHours += tally.totalHours;
        return acc;
    }, {
        teamSize: roster && roster.length ? roster.length : rows.length,
        present: 0, absent: 0, late: 0, halfDay: 0, leave: 0,
        workingDays: 0, totalHours: 0, attendancePct: null,
    });
    totals.attendancePct = attendedPct(totals.workingDays, totals.absent, totals.leave);

    return {
        month: monthKey,
        rows,
        totals,
        hasActivity: rows.some((row) => row.days > 0),
    };
}

/** Shift a YYYY-MM-DD date by whole days (UTC-safe). */
export function shiftDate(dateStr, deltaDays) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
    if (!match) return String(dateStr || '').trim();
    const [, y, m, d] = match;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + (Number(deltaDays) || 0)));
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${date.getUTCFullYear()}-${mm}-${dd}`;
}

/** Short label for a day, e.g. "Sun, 6 Sep 2026". */
export function formatDayLabel(dateStr) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
    if (!match) return '';
    const [, y, m, d] = match;
    return new Date(Number(y), Number(m) - 1, Number(d))
        .toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/** Label for a month, e.g. "September 2026". */
export function formatMonthLabel(monthStr) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(monthStr || '').trim());
    if (!match) return '';
    const [, y, m] = match;
    if (Number(m) < 1 || Number(m) > 12) return '';
    return new Date(Number(y), Number(m) - 1, 1)
        .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

/** Render an attendance % (0–100 with one decimal, or "—" when null). */
export function formatAttendancePct(value) {
    if (value == null || Number.isNaN(value)) return '—';
    return `${Math.round(value * 10) / 10}%`;
}

/**
 * SALON_WEEKDAYS_COUNT / STATUS list refs used elsewhere (kept for tests).
 */
export const WORKED_STATUSES = Object.freeze(['Present', 'Late', 'Half Day']);

export default {
    ATTENDANCE_STATUSES,
    attendanceGroupKey,
    workingHoursMinutes,
    workingHoursLabel,
    consolidateAttendanceRecords,
    monthlyAttendanceReport,
    shiftDate,
    formatDayLabel,
    formatMonthLabel,
    formatAttendancePct,
    WORKED_STATUSES,
};