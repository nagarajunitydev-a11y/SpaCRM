/**
 * unit-attendance.mjs
 * Node unit tests for core/attendance.js: working-hours maths, per-staff/day
 * consolidation (duplicate handling), the monthly attendance report and the
 * date helpers.
 *
 * Usage: node scripts/unit-attendance.mjs
 */

import {
    attendanceGroupKey,
    workingHoursMinutes,
    workingHoursLabel,
    consolidateAttendanceRecords,
    monthlyAttendanceReport,
    shiftDate,
    formatDayLabel,
    formatMonthLabel,
    formatAttendancePct,
} from '../public/js/core/attendance.js';

let pass = 0;
let fail = 0;

function t(cond, label) {
    if (cond) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; console.log('  FAIL  ' + label); }
}

console.log('\n[1] Working hours');
t(workingHoursMinutes('09:00', '18:00') === 540, '09:00-18:00 = 540 minutes');
t(workingHoursMinutes('09:30', '13:15') === 225, '09:30-13:15 = 225 minutes');
t(workingHoursLabel('09:00', '18:00') === '9h', 'whole hours label');
t(workingHoursLabel('09:30', '13:15') === '3h 45m', 'h + m label');
t(workingHoursLabel('', '') === '—', 'empty times show placeholder');
t(workingHoursLabel('18:00', '09:00') === '—', 'negative/overnight span treated as unknown');
t(workingHoursLabel('09:00', '09:00') === '—', 'zero-length span is unknown');
t(workingHoursMinutes('25:00', '26:00') === null, 'invalid hours rejected');
t(workingHoursMinutes('09:00', '18:30') === 570, 'check-out minutes counted');
t(workingHoursLabel(undefined, undefined) === '—', 'undefined times safe');

console.log('\n[2] Group identity');
t(attendanceGroupKey({ staffId: 'st1', date: '2026-09-01' }) === 'st1::2026-09-01', 'staffId+date group key');
t(attendanceGroupKey({ staffName: 'Nina', date: '2026-09-01' }) === 'Nina::2026-09-01', 'staffName fallback group key');
t(attendanceGroupKey({}) === '::', 'empty row yields a neutral key');

console.log('\n[3] Duplicate handling — consolidation');
const base = { staffId: 'st1', staffName: 'Nina', date: '2026-09-01', status: 'Late', checkIn: '10:00', notes: 'traffic' };
const dupes = [
    { ...base, id: 'st1_2026-09-01', createdAt: '2026-09-01T09:00:00Z', updatedAt: '2026-09-01T09:00:00Z' },
    { ...base, id: 'legacy_1', status: 'Absent', createdAt: '2026-09-01T08:00:00Z', updatedAt: '2026-09-01T08:50:00Z', checkIn: '', checkOut: '18:15', notes: '' },
];
const consolidated = consolidateAttendanceRecords(dupes);
t(consolidated.length === 1, 'duplicates collapse to a single display record');
t(consolidated[0].events === 2, 'record exposes how many entries were combined');
t(consolidated[0].status === 'Late', 'most recently updated row wins the status');
t(consolidated[0].checkIn === '10:00', 'newest check-in kept');
t(consolidated[0].checkOut === '18:15', 'missing check-out filled from the other row');
t(consolidated[0].notes === 'traffic', 'notes preserved from the newest row');
t(consolidated[0].id === 'st1_2026-09-01', 'primary document id preserved (delete/edit target)');
t(dupes.length === 2 && dupes[1].status === 'Absent', 'underlying records are never mutated');

const twoStaff = consolidateAttendanceRecords([
    { staffId: 'st1', staffName: 'Nina', date: '2026-09-01', status: 'Present' },
    { staffId: 'st2', staffName: 'Mia', date: '2026-09-01', status: 'Leave' },
    { staffId: 'st1', staffName: 'Nina', date: '2026-09-01', status: 'Present' },
]);
t(twoStaff.length === 2, 'different staff members stay as separate records');
t(twoStaff[0].staffId === 'st1' && twoStaff[1].staffId === 'st2', 'roster-like first-appearance order kept');
t(consolidateAttendanceRecords([]).length === 0, 'empty list yields empty result');
t(consolidateAttendanceRecords(null).length === 0, 'null list is safe');

console.log('\n[4] Monthly report — per-staff accuracy');
const month = '2026-09';
const roster = [
    { id: 'st1', name: 'Nina' },
    { id: 'st2', name: 'Mia' },
];
const records = [
    { staffId: 'st1', staffName: 'Nina', date: '2026-09-01', status: 'Present', checkIn: '09:00', checkOut: '18:00' },
    { staffId: 'st1', staffName: 'Nina', date: '2026-09-02', status: 'Late', checkIn: '10:30', checkOut: '18:00' },
    { staffId: 'st1', staffName: 'Nina', date: '2026-09-03', status: 'Present', checkIn: '09:00', checkOut: '13:00' },
    { staffId: 'st1', staffName: 'Nina', date: '2026-09-03', status: 'Present', checkIn: '09:00', checkOut: '13:00' },
    { staffId: 'st1', staffName: 'Nina', date: '2026-09-05', status: 'Absent' },
    { staffId: 'st1', staffName: 'Nina', date: '2026-09-15', status: 'Leave' },
    { staffId: 'st2', staffName: 'Mia', date: '2026-09-04', status: 'Present', checkIn: '09:00', checkOut: '18:00' },
    { staffId: 'st2', staffName: 'Mia', date: '2026-09-11', status: 'Half Day', checkIn: '11:00', checkOut: '14:00' },
    // Outside the month — must be ignored.
    { staffId: 'st1', staffName: 'Nina', date: '2026-08-31', status: 'Present', checkIn: '09:00', checkOut: '18:00' },
    { staffId: 'st1', staffName: 'Nina', date: '2026-10-01', status: 'Present', checkIn: '09:00', checkOut: '18:00' },
];
const report = monthlyAttendanceReport(records, { month, roster });

const nina = report.rows.find((r) => r.staffId === 'st1');
const mia = report.rows.find((r) => r.staffId === 'st2');
t(report.rows.length === 2, 'one row per staff member');
t(nina.present === 2 && nina.late === 1 && nina.halfDay === 0 && nina.absent === 1 && nina.leave === 1, 'Nina day counts correct (Present 2, Late 1, Absent 1, Leave 1)');
t(nina.days === 5, 'Nina covers 5 distinct days (duplicate day counted once)');
t(nina.records === 6, 'Nina recorded 6 underlying rows (dedupe did not destroy data)');
t(nina.workingDays === 3, 'Nina working days = Present + Late + Half Day = 3');
t(mia.present === 1 && mia.halfDay === 1, 'Mia counts correct (Present 1, Half Day 1)');
t(mia.workingDays === 2, 'Mia working days = 2');
t(nina.totalHours === 540 + 450 + 240, `Nina total hours sums worked-day spans (${nina.totalHours})`);
t(mia.totalHours === 540 + 180, `Mia total hours sums worked-day spans (${mia.totalHours})`);
t(nina.attendancePct === 60, `Nina attendance % = 3/5 = 60% (got ${nina.attendancePct})`);
t(mia.attendancePct === 100, `Mia attendance % = 2/2 = 100% (got ${mia.attendancePct})`);

t(report.totals.workingDays === 5, 'salon working days total = 5');
t(report.totals.present === 3, 'salon present total = 3');
t(report.totals.absent === 1 && report.totals.late === 1 && report.totals.leave === 1 && report.totals.halfDay === 1, 'salon status totals correct');
t(report.totals.totalHours === 540 + 450 + 240 + 540 + 180, 'salon total hours correct');
t(report.totals.attendancePct === 71.4, `salon attendance % = 5/7 = 71.4% (got ${report.totals.attendancePct})`);
t(report.totals.teamSize === 2, 'team size comes from the roster');

const filtered = monthlyAttendanceReport(records, { month, staffId: 'st2', roster });
t(filtered.rows.length === 2 && filtered.rows.find((r) => r.staffId === 'st2').days === 2 && filtered.rows.find((r) => r.staffId === 'st1').days === 0, 'staff filter keeps the roster row but zeroes the other member');
t(filtered.totals.workingDays === 2, 'staff-filtered totals reflect only that member');

const noRoster = monthlyAttendanceReport(records.slice(0, 7), { month });
t(noRoster.totals.teamSize === 2, 'team size falls back to distinct recorded staff when no roster given');

console.log('\n[5] Statuses & edge cases');
const halfDayReport = monthlyAttendanceReport(
    [{ staffId: 'st9', staffName: 'Zoe', date: '2026-09-02', status: 'Half Day', checkIn: '10:00', checkOut: '13:00' }],
    { month: '2026-09' });
t(halfDayReport.rows[0].workingDays === 1 && halfDayReport.rows[0].halfDay === 1, 'Half Day counts as a working day');
t(halfDayReport.rows[0].attendancePct === 100, 'single Half Day day = 100% over that day');

const leaveOnly = monthlyAttendanceReport(
    [{ staffId: 'st9', staffName: 'Zoe', date: '2026-09-02', status: 'Leave' }],
    { month: '2026-09' });
t(leaveOnly.rows[0].attendancePct === 0, 'Leave-only month reports 0%');
t(formatAttendancePct(leaveOnly.rows[0].attendancePct) === '0%', '0% formats cleanly');

const emptyMonth = monthlyAttendanceReport([], { month: '2026-09', roster });
t(emptyMonth.rows.length === 2 && emptyMonth.rows.every((r) => r.workingDays === 0 && r.attendancePct === null), 'no records -> zeros with unrated % rather than fake 0%');
t(emptyMonth.hasActivity === false, 'empty month reports no activity');
t(report.hasActivity === true, 'active month reports activity');
t(monthlyAttendanceReport([], { month: '2026-09' }).hasActivity === false, 'no-roster empty report has no activity');
t(formatAttendancePct(emptyMonth.rows[0].attendancePct) === '—', 'unrated % renders as em dash');
t(formatAttendancePct(77.84) === '77.8%', 'percent rounded to one decimal');

console.log('\n[6] Date helpers');
t(shiftDate('2026-09-01', -1) === '2026-08-31', 'shift back crosses month boundary');
t(shiftDate('2026-03-01', -1) === '2026-02-28', 'shift into a shorter month');
t(shiftDate('2026-01-01', -1) === '2025-12-31', 'shift into previous year');
t(shiftDate('2026-09-06', 1) === '2026-09-07', 'shift forward');
t(shiftDate('2028-02-28', 1) === '2028-02-29', 'leap year respected');
t(shiftDate('09-06-26', 1) === '09-06-26', 'malformed date left untouched');
t(formatDayLabel('2026-09-06') !== '', 'day label renders');
t(formatDayLabel('garbage') === '', 'bad day label is empty');
t(formatMonthLabel('2026-09') !== '', 'month label renders');
t(formatMonthLabel('2026-13') === '', 'bad month label is empty');

console.log(`\nUNIT ATTENDANCE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);