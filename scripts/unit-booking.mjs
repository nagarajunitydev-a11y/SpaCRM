/**
 * unit-booking.mjs
 * Node unit tests for the public-booking rules: core/scheduling.js (duration
 * parsing, working-hours slot generation, conflict detection, the atomic
 * slot-lock key scheme) and core/bookingConfig.js (settings sanitization,
 * the public-safe catalog snapshot, bookable-date bounds).
 *
 * Usage: node scripts/unit-booking.mjs
 */

import {
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
    slugifyStaffName,
    slotLockKey,
    ticksForSpan,
    lockKeysForBooking,
    ANY_STAFF,
} from '../public/js/core/scheduling.js';

import {
    DEFAULT_WORKING_HOURS,
    DEFAULT_BOOKING_SETTINGS,
    sanitizeWorkingHours,
    toPublicServices,
    toPublicStaff,
    sanitizeBookingSettings,
    localDateStr,
    isBookableDate,
} from '../public/js/core/bookingConfig.js';

let pass = 0;
let fail = 0;

function t(cond, label) {
    if (cond) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; console.log('  FAIL  ' + label); }
}

/* ---------------- Duration parsing ---------------- */
console.log('\n[1] Duration parsing');
t(parseDurationMinutes('90m') === 90, '"90m" -> 90');
t(parseDurationMinutes('120m') === 120, '"120m" -> 120');
t(parseDurationMinutes('1h') === 60, '"1h" -> 60');
t(parseDurationMinutes('1h30m') === 90, '"1h30m" -> 90');
t(parseDurationMinutes('1:30') === 90, '"1:30" -> 90');
t(parseDurationMinutes('45') === 45, 'bare number -> minutes');
t(parseDurationMinutes('') === 0, 'empty string -> 0');
t(parseDurationMinutes(null) === 0, 'null -> 0');
t(parseDurationMinutes('garbage') === 0, 'unparseable text -> 0 (never fabricated)');
t(parseDurationMinutes(60) === 60, 'numeric input passes through');

const catalog = [
    { name: 'Haircut', price: 200, duration: '45m' },
    { name: 'Facial', price: 500, duration: '1h' },
    { name: 'Manicure', price: 150, duration: '30m' },
];
t(totalDurationMinutes(['Haircut', 'Facial'], catalog) === 105, 'multi-service duration sums correctly');
t(totalDurationMinutes(['Unknown Service'], catalog) === 0, 'unknown service contributes 0 duration');
t(totalDurationMinutes([], catalog) === 0, 'no services selected -> 0 duration');
t(totalDurationMinutes(['HAIRCUT'], catalog) === 45, 'service lookup is case-insensitive');

t(totalServicePrice(['Haircut', 'Manicure'], catalog) === 350, 'multi-service price sums correctly');
t(totalServicePrice(['Unknown'], catalog) === 0, 'unknown service contributes 0 price');

/* ---------------- withDuration ---------------- */
console.log('\n[2] withDuration annotation');
{
    const appts = [
        { id: 'a1', serviceName: 'Haircut' },
        { id: 'a2', services: [{ name: 'Facial' }] },
        { id: 'a3', serviceNames: ['Manicure'] },
        { id: 'a4', serviceName: 'Made Up Service' },
    ];
    const annotated = withDuration(appts, catalog);
    t(annotated[0].durationMinutes === 45, 'single serviceName resolves duration');
    t(annotated[1].durationMinutes === 60, 'services array of objects resolves duration');
    t(annotated[2].durationMinutes === 30, 'serviceNames array resolves duration');
    t(annotated[3].durationMinutes === 1, 'unresolvable duration floors to 1 minute (never 0 -> never un-lockable)');
}

/* ---------------- Time helpers ---------------- */
console.log('\n[3] Time helpers');
t(timeToMinutes('09:30') === 570, '09:30 -> 570 minutes');
t(timeToMinutes('23:59') === 1439, '23:59 -> 1439 minutes');
t(timeToMinutes('24:00') === null, '24:00 is invalid');
t(timeToMinutes('9:30') === null, 'unpadded hour is invalid');
t(timeToMinutes('') === null, 'empty string is invalid');
t(minutesToTime(570) === '09:30', '570 minutes -> "09:30"');
t(minutesToTime(0) === '00:00', '0 minutes -> "00:00"');
t(minutesToTime(1439) === '23:59', '1439 minutes -> "23:59"');

t(weekdayKeyFor('2026-08-24') === 'mon', '2026-08-24 is a Monday');
t(weekdayKeyFor('2026-08-23') === 'sun', '2026-08-23 is a Sunday');
t(weekdayKeyFor('not-a-date') === null, 'invalid date string -> null weekday');

/* ---------------- Working-hours range ---------------- */
console.log('\n[4] Working-hours range resolution');
{
    const hours = sanitizeWorkingHours({ mon: { closed: false, start: '10:00', end: '18:00' }, sun: { closed: true } });
    const monRange = rangeForDate(hours, '2026-08-24'); // Monday
    t(monRange && monRange.start === 600 && monRange.end === 1080, 'Monday range resolves to 10:00-18:00');
    const sunRange = rangeForDate(hours, '2026-08-23'); // Sunday
    t(sunRange === null, 'a closed day has no range');
    t(rangeForDate(hours, 'garbage') === null, 'invalid date has no range');

    const inverted = sanitizeWorkingHours({ tue: { closed: false, start: '18:00', end: '10:00' } });
    t(inverted.tue.closed === true, 'an inverted start/end range is coerced to closed rather than silently opening');
}

/* ---------------- Conflict detection ---------------- */
console.log('\n[5] Conflict detection');
{
    const existing = [
        { staffName: 'Victoria', date: '2026-08-24', time: '10:00', durationMinutes: 60, status: 'Confirmed' },
        { staffName: 'Victoria', date: '2026-08-24', time: '14:00', durationMinutes: 30, status: 'Cancelled' },
    ];
    t(hasConflict({ existingAppointments: existing, staffName: 'Victoria', date: '2026-08-24', startTime: '10:30', durationMinutes: 30 }) === true, 'overlapping slot for the same staff conflicts');
    t(hasConflict({ existingAppointments: existing, staffName: 'Victoria', date: '2026-08-24', startTime: '11:00', durationMinutes: 30 }) === false, 'a slot starting exactly when the prior one ends does not conflict');
    t(hasConflict({ existingAppointments: existing, staffName: 'Julian', date: '2026-08-24', startTime: '10:00', durationMinutes: 30 }) === false, 'a different staff member never conflicts');
    t(hasConflict({ existingAppointments: existing, staffName: 'Victoria', date: '2026-08-25', startTime: '10:00', durationMinutes: 30 }) === false, 'a different date never conflicts');
    t(hasConflict({ existingAppointments: existing, staffName: 'Victoria', date: '2026-08-24', startTime: '14:00', durationMinutes: 30 }) === false, 'a cancelled appointment never blocks a slot');
    t(hasConflict({ existingAppointments: existing, staffName: 'victoria', date: '2026-08-24', startTime: '10:30', durationMinutes: 30 }) === true, 'staff name comparison is case-insensitive');
    t(hasConflict({ existingAppointments: existing, staffName: 'Victoria', date: '2026-08-24', startTime: 'bad-time', durationMinutes: 30 }) === true, 'an unparseable candidate time is always treated as conflicting');
}

/* ---------------- Slot generation ---------------- */
console.log('\n[6] Slot generation');
{
    const hours = sanitizeWorkingHours({ mon: { closed: false, start: '10:00', end: '12:00' } });
    const slots = availableSlotsForStaff({
        workingHours: hours, date: '2026-08-24', slotIntervalMinutes: 30, durationMinutes: 30,
        staffName: 'Victoria', existingAppointments: [],
    });
    t(JSON.stringify(slots) === JSON.stringify(['10:00', '10:30', '11:00', '11:30']), 'a clean 2-hour window at 30-min intervals yields 4 slots');

    const busy = [{ staffName: 'Victoria', date: '2026-08-24', time: '10:30', durationMinutes: 30, status: 'Confirmed' }];
    const withBusy = availableSlotsForStaff({
        workingHours: hours, date: '2026-08-24', slotIntervalMinutes: 30, durationMinutes: 30,
        staffName: 'Victoria', existingAppointments: busy,
    });
    t(!withBusy.includes('10:30'), 'a booked slot is excluded from availability');
    t(withBusy.length === 3, 'exactly the booked slot is removed, nothing else');

    const closedHours = sanitizeWorkingHours({ tue: { closed: true } });
    const closedDay = availableSlotsForStaff({
        workingHours: closedHours, date: '2026-08-25', slotIntervalMinutes: 30, durationMinutes: 30,
        staffName: 'Victoria', existingAppointments: [],
    });
    t(closedDay.length === 0, 'a closed day yields no slots');

    // A 90-minute service in a 2-hour window only leaves room to start at 10:00 or 10:30.
    const longService = availableSlotsForStaff({
        workingHours: hours, date: '2026-08-24', slotIntervalMinutes: 30, durationMinutes: 90,
        staffName: 'Victoria', existingAppointments: [],
    });
    t(JSON.stringify(longService) === JSON.stringify(['10:00', '10:30']), 'slots that would run past closing time are excluded');

    // Today + minimum notice hides near-term slots.
    const todaySlots = availableSlotsForStaff({
        workingHours: hours, date: '2026-08-24', slotIntervalMinutes: 30, durationMinutes: 30,
        staffName: 'Victoria', existingAppointments: [], isToday: true, nowMinutes: 600, minNoticeMinutes: 60,
    });
    t(!todaySlots.includes('10:00') && !todaySlots.includes('10:30') && todaySlots.includes('11:00'), 'minimum notice hides slots that are too soon');
}

/* ---------------- Any Available Staff ---------------- */
console.log('\n[7] Any Available Staff');
{
    const hours = sanitizeWorkingHours({ mon: { closed: false, start: '10:00', end: '11:00' } });
    const staffList = [{ name: 'Victoria' }, { name: 'Julian' }];
    const busy = [{ staffName: 'Victoria', date: '2026-08-24', time: '10:00', durationMinutes: 30, status: 'Confirmed' }];

    const any = availableSlotsAnyStaff({
        workingHours: hours, date: '2026-08-24', slotIntervalMinutes: 30, durationMinutes: 30,
        staffList, existingAppointments: busy,
    });
    t(any.find((s) => s.time === '10:00').staffName === 'Julian', 'Any-Staff suggests whichever staff member is actually free at a busy time');
    t(any.find((s) => s.time === '10:30').staffName === 'Victoria' || any.find((s) => s.time === '10:30').staffName === 'Julian', 'a slot free for everyone suggests a valid staff member');
    t(any.length === 2, 'the union of both staff members covers every slot in the window');

    t(pickAnyAvailableStaff({ staffList, existingAppointments: busy, date: '2026-08-24', startTime: '10:00', durationMinutes: 30 }) === 'Julian', 'pickAnyAvailableStaff skips the busy staff member');
    const bothBusy = [...busy, { staffName: 'Julian', date: '2026-08-24', time: '10:00', durationMinutes: 30, status: 'Confirmed' }];
    t(pickAnyAvailableStaff({ staffList, existingAppointments: bothBusy, date: '2026-08-24', startTime: '10:00', durationMinutes: 30 }) === null, 'pickAnyAvailableStaff returns null when nobody is free');
}

/* ---------------- Slot locks (atomic double-booking guard) ---------------- */
console.log('\n[8] Slot locks');
t(slugifyStaffName('Victoria Sterling') === 'victoria-sterling', 'staff name slugified for use in a doc id');
t(slugifyStaffName('') === 'staff', 'empty staff name falls back to a safe slug');
t(slotLockKey('Victoria Sterling', '2026-08-24', '10:00') === 'victoria-sterling_2026-08-24_1000', 'lock key format is deterministic');
t(slotLockKey('Victoria', '2026-08-24', '10:00') === slotLockKey('Victoria', '2026-08-24', '10:00'), 'the same booking always produces the same lock key');
t(slotLockKey('Victoria', '2026-08-24', '10:00') !== slotLockKey('Victoria', '2026-08-24', '10:05'), 'different times produce different lock keys');

t(JSON.stringify(ticksForSpan('10:00', 15)) === JSON.stringify(['10:00', '10:05', '10:10']), 'a 15-minute span covers three 5-minute ticks');
t(ticksForSpan('10:00', 5).length === 1, 'a 5-minute span covers exactly one tick');
t(ticksForSpan('10:03', 10).length === ticksForSpan('10:00', 13).length, 'a non-grid-aligned start still rounds down to the covering ticks');
t(ticksForSpan('bad', 30).length === 0, 'an unparseable start time yields no ticks');

{
    const keys = lockKeysForBooking('Victoria', '2026-08-24', '10:00', 90);
    t(keys.length === 18, 'a 90-minute booking acquires 18 five-minute locks');
    t(new Set(keys).size === keys.length, 'every lock key in one booking is unique');
    t(keys[0] === 'victoria_2026-08-24_1000' && keys[keys.length - 1] === 'victoria_2026-08-24_1125', 'lock keys span exactly the booked interval (10:00 + 90min, last 5-min tick before 11:30 is 11:25)');

    // Two overlapping bookings (different start times, same staff) must share
    // at least one lock key — this is what makes the write-time guard work
    // for variable-duration services, not just identical time picks.
    const other = lockKeysForBooking('Victoria', '2026-08-24', '10:15', 30);
    const overlap = keys.filter((k) => other.includes(k));
    t(overlap.length > 0, 'overlapping (not identical) bookings for the same staff share at least one lock tick');

    const nonOverlapping = lockKeysForBooking('Victoria', '2026-08-24', '11:30', 30);
    const noOverlap = keys.filter((k) => nonOverlapping.includes(k));
    t(noOverlap.length === 0, 'genuinely non-overlapping bookings share no lock ticks');
}

/* ---------------- Booking settings sanitization ---------------- */
console.log('\n[9] Booking settings sanitization');
{
    const d = sanitizeBookingSettings(null);
    t(d.enabled === false, 'booking is disabled by default until an owner explicitly enables it');
    t(JSON.stringify(d.workingHours) === JSON.stringify(DEFAULT_WORKING_HOURS), 'null settings fall back to default working hours');
    t(sanitizeBookingSettings({ enabled: true }).enabled === true, 'enabled can be turned on');
    t(sanitizeBookingSettings({ slotIntervalMinutes: 2 }).slotIntervalMinutes === 5, 'slot interval clamped to the 5-minute floor');
    t(sanitizeBookingSettings({ slotIntervalMinutes: 999 }).slotIntervalMinutes === 120, 'slot interval clamped to the 120-minute ceiling');
    t(sanitizeBookingSettings({ advanceBookingDays: 0 }).advanceBookingDays === 1, 'advance booking window clamped to at least 1 day');
    t(sanitizeBookingSettings({ advanceBookingDays: 9999 }).advanceBookingDays === 180, 'advance booking window clamped to at most 180 days');
    t(sanitizeBookingSettings({ minNoticeMinutes: -10 }).minNoticeMinutes === 0, 'minimum notice cannot be negative');
    t(sanitizeBookingSettings({ displayName: 'x'.repeat(500) }).displayName.length === 120, 'display name is length-capped');

    const messyDay = sanitizeBookingSettings({ workingHours: { mon: { closed: false, start: 'bad', end: 'bad' } } }).workingHours.mon;
    t(messyDay.start === DEFAULT_WORKING_HOURS.mon.start, 'a malformed day time falls back to the default rather than crashing');
}

console.log('\n[10] Public catalog snapshot');
{
    const services = [
        { id: 's1', name: 'Haircut', price: 200, duration: '45m', internalCost: 999 },
        { id: null, name: 'Should be dropped', price: 100, duration: '30m' },
    ];
    const pub = toPublicServices(services);
    t(pub.length === 1, 'a service with no id is dropped from the public snapshot');
    t(pub[0].internalCost === undefined, 'only the public-safe fields survive');
    t(Object.keys(pub[0]).sort().join(',') === 'duration,id,name,price', 'public service shape is exactly id/name/price/duration');

    const staff = [{ id: 'st1', name: 'Victoria', role: 'Stylist', phone: '9876543210' }];
    const pubStaff = toPublicStaff(staff);
    t(pubStaff[0].phone === undefined, 'staff phone number is never included in the public snapshot');
    t(Object.keys(pubStaff[0]).sort().join(',') === 'id,name,role', 'public staff shape is exactly id/name/role');

    const many = Array.from({ length: 250 }, (_, i) => ({ id: 's' + i, name: 'S' + i, price: 1, duration: '10m' }));
    t(toPublicServices(many).length === 200, 'the public snapshot is capped at 200 entries');
}

console.log('\n[11] Bookable date window');
{
    const today = '2026-08-23';
    t(isBookableDate(today, { advanceBookingDays: 30 }, today) === true, "today itself is bookable");
    t(isBookableDate('2026-08-22', { advanceBookingDays: 30 }, today) === false, 'a past date is never bookable');
    t(isBookableDate('2099-01-01', { advanceBookingDays: 30 }, today) === false, 'a date far beyond the advance window is not bookable');
    t(isBookableDate('garbage', {}, today) === false, 'a malformed date string is never bookable');
    t(localDateStr(new Date(2026, 7, 23)) === '2026-08-23', 'localDateStr formats without a timezone shift');
}

t(ANY_STAFF === 'Any Available Staff', 'ANY_STAFF sentinel is stable');

console.log(`\nUNIT BOOKING: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
