/**
 * views/attendance.js
 * Staff attendance: a clean daily roster (one clear record/card per staff
 * member per day) plus a monthly attendance report (one row per staff member
 * with day counts, hours and attendance %).
 *
 * Daily cards consolidate any number of underlying records for the same
 * staff member on the same day into a single display record (see
 * core/attendance.js) — the stored data is never changed or removed.
 *
 * The document id in Firestore is `{staffId}_{date}` (see
 * attendanceRepository.js), which already prevents new duplicates; daily
 * consolidation makes the view robust to any historical duplicates too.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { emptyState } from '../components.js';
import { initials, scopedBySalon, todayStr } from '../../core/utils.js';
import {
    attendanceGroupKey,
    consolidateAttendanceRecords,
    workingHoursLabel,
    monthlyAttendanceReport,
    formatDayLabel,
    formatMonthLabel,
    formatAttendancePct,
} from '../../core/attendance.js';

const STATUS_STYLES = {
    Present: { label: 'Present', badge: 'bg-emerald-500/15 text-emerald-400', dot: 'bg-emerald-500', icon: 'check-circle-2' },
    Absent: { label: 'Absent', badge: 'bg-rose-500/15 text-rose-400', dot: 'bg-rose-500', icon: 'x-circle' },
    Late: { label: 'Late', badge: 'bg-amber-500/15 text-amber-400', dot: 'bg-amber-500', icon: 'clock' },
    'Half Day': { label: 'Half Day', badge: 'bg-indigo-500/15 text-indigo-400', dot: 'bg-indigo-500', icon: 'sunset' },
    Leave: { label: 'Leave', badge: 'bg-slate-500/15 text-slate-300', dot: 'bg-slate-400', icon: 'plane' },
};

function statusBadge(status) {
    const style = STATUS_STYLES[status] || { label: 'Not marked', badge: 'bg-slate-800/70 text-slate-400', dot: 'bg-slate-600', icon: 'calendar-days' };
    return `
        <span class="inline-flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-full ${escAttr(style.badge)} shrink-0" data-status="${escAttr(status || 'Not marked')}">
            <span class="w-1.5 h-1.5 rounded-full ${escAttr(style.dot)}"></span>
            <i data-lucide="${escAttr(style.icon)}" class="w-3 h-3"></i>
            <span class="text-[10px] font-bold">${esc(style.label)}</span>
        </span>
    `;
}

function metaPill(iconName, label, value) {
    return `
        <div class="bg-slate-950/60 border border-slate-800/60 rounded-xl px-2.5 py-2 min-w-0">
            <p class="flex items-center gap-1 text-[9px] font-bold text-slate-500 uppercase tracking-wider">
                <i data-lucide="${escAttr(iconName)}" class="w-3 h-3"></i>${esc(label)}
            </p>
            <p class="text-xs font-bold text-slate-100 mt-1 truncate">${esc(value)}</p>
        </div>
    `;
}

/** One clean, consolidated daily attendance card for a staff member. */
function dailyStaffCard(staffMember, record, date) {
    const status = record ? record.status : '';
    const dash = '—';
    return `
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4" data-attendance-staff-card data-staff-id="${escAttr(staffMember.id)}" data-date="${escAttr(date)}">
            <div class="flex items-start justify-between gap-3">
                <div class="flex items-center gap-3 min-w-0">
                    <div class="w-10 h-10 rounded-xl bg-brand-500/15 text-brand-400 flex items-center justify-center font-bold text-xs shrink-0" aria-hidden="true">
                        ${esc(initials(staffMember.name))}
                    </div>
                    <div class="min-w-0">
                        <p class="text-sm font-bold text-slate-100 truncate">${esc(staffMember.name)}</p>
                        <p class="text-[10px] text-slate-400 truncate">${esc(staffMember.role || '')}</p>
                    </div>
                </div>
                ${statusBadge(record ? status : '')}
            </div>

            <div class="grid grid-cols-3 gap-1.5 mt-3.5">
                ${metaPill('log-in', 'Check-in', record && record.checkIn ? record.checkIn : dash)}
                ${metaPill('log-out', 'Check-out', record && record.checkOut ? record.checkOut : dash)}
                ${metaPill('timer', 'Hours', record ? workingHoursLabel(record.checkIn, record.checkOut) : dash)}
            </div>

            ${record && record.notes
                ? `<div class="mt-2.5 bg-slate-950/60 border border-slate-800/60 rounded-xl px-3 py-2">
                        <p class="text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">Notes</p>
                        <p class="text-[11px] text-slate-300 leading-snug">${esc(record.notes)}</p>
                   </div>`
                : ''}

            <div class="flex items-center justify-between gap-3 mt-3.5 pt-3 border-t border-slate-800/70">
                <div class="flex items-center gap-2">
                    ${record
                        ? `<button data-action="open-edit" data-type="attendance" data-id="${escAttr(record.id)}"
                            class="inline-flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold rounded-xl transition active:scale-95 touch-manipulation">
                            <i data-lucide="pencil" class="w-3.5 h-3.5"></i><span>Edit record</span></button>`
                        : `<button data-action="attendance-mark" data-staff-id="${escAttr(staffMember.id)}" data-staff-name="${escAttr(staffMember.name)}"
                            class="inline-flex items-center gap-1.5 px-3 py-2 bg-brand-600 hover:bg-brand-500 text-white text-[11px] font-semibold rounded-xl shadow-lg shadow-brand-600/25 transition active:scale-95 touch-manipulation">
                            <i data-lucide="calendar-plus" class="w-3.5 h-3.5"></i><span>${esc(date === todayStr() ? 'Mark today' : 'Mark attendance')}</span></button>`}
                    ${record
                        ? `<button data-action="request-delete" data-type="attendance" data-id="${escAttr(record.id)}" data-label="${escAttr(`${staffMember.name} — ${date}`)}"
                            aria-label="Delete attendance" title="Delete attendance"
                            class="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 transition active:scale-95 touch-manipulation">
                            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>`
                        : ''}
                </div>
                ${record && record.events > 1
                    ? `<span data-consolidated title="This member has ${escAttr(record.events)} attendance entries for this date — shown as one consolidated record."
                        class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-indigo-500/10 text-indigo-300 text-[9px] font-bold uppercase tracking-wider">
                        <i data-lucide="layers" class="w-3 h-3"></i>${esc(record.events)} entries</span>`
                    : ''}
            </div>
        </div>
    `;
}

function dateNavigator(date) {
    const isToday = date === todayStr();
    const chevron = 'w-3.5 h-3.5';
    return `
        <div class="flex items-center gap-1.5 shrink-0" data-attendance-date-nav>
            <button data-action="attendance-day-prev" aria-label="Previous day" title="Previous day"
                class="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center transition active:scale-95 touch-manipulation">
                <i data-lucide="chevron-left" class="${chevron}"></i>
            </button>
            <button data-action="attendance-day-today"
                class="px-2.5 h-9 rounded-xl text-[10px] font-bold transition active:scale-95 touch-manipulation ${isToday ? 'bg-brand-600/20 text-brand-300' : 'bg-brand-600 hover:bg-brand-500 text-white shadow-lg shadow-brand-600/25'}">
                Today
            </button>
            <button data-action="attendance-day-next" aria-label="Next day" title="Next day" ${isToday ? 'disabled' : ''}
                class="w-9 h-9 rounded-xl flex items-center justify-center transition active:scale-95 touch-manipulation ${isToday ? 'bg-slate-900 text-slate-600 cursor-not-allowed' : 'bg-slate-800 hover:bg-slate-700 text-slate-200'}">
                <i data-lucide="chevron-right" class="${chevron}"></i>
            </button>
        </div>
    `;
}

function statusLegend() {
    return `
        <div class="flex flex-wrap items-center gap-1.5">
            ${Object.values(STATUS_STYLES).map((s) => `
                <span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-950/60 border border-slate-800/60">
                    <span class="w-1.5 h-1.5 rounded-full ${escAttr(s.dot)}"></span>
                    <span class="text-[9px] font-semibold text-slate-400">${esc(s.label)}</span>
                </span>`).join('')}
        </div>
    `;
}

function renderDailyAttendance(staff, attendance, date) {
    const consolidated = consolidateAttendanceRecords(attendance);
    const byKey = new Map(consolidated.map((row) => [attendanceGroupKey(row), row]));

    return `
        <div class="space-y-3.5">
            <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <p data-attendance-day class="text-sm font-extrabold text-slate-100 capitalize">${esc(formatDayLabel(date))}</p>
                    <p class="text-[10px] text-slate-400 mt-0.5">One clear record per staff member — multiple entries for the same day are consolidated.</p>
                </div>
                ${dateNavigator(date)}
            </div>

            <div class="lg:hidden">
                <input type="date" data-action="attendance-date" value="${escAttr(date)}" max="${escAttr(todayStr())}"
                    aria-label="Jump to a date"
                    class="w-full bg-slate-900 border border-slate-800 px-3 py-2.5 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500 lg:hidden">
            </div>

            ${statusLegend()}

            ${staff.length === 0
                ? emptyState('No staff members registered yet. Add staff from the Team tab to mark attendance.')
                : `<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5" data-attendance-daily-list>
                        ${staff.map((member) => dailyStaffCard(member, byKey.get(attendanceGroupKey({ staffId: member.id, staffName: member.name, date })) || null, date)).join('')}
                   </div>`}
        </div>
    `;
}

function summaryCard(label, value, accent) {
    return `
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-3">
            <p class="text-lg font-extrabold ${escAttr(accent)} leading-none">${esc(value)}</p>
            <p class="text-[9px] font-bold text-slate-400 uppercase tracking-wider mt-1.5">${esc(label)}</p>
        </div>
    `;
}

function reportDesktopTable(rows) {
    const cellCls = (count, color) => `<span class="text-[11px] font-bold ${escAttr(color)}">${esc(count)}</span>`;
    const colorFor = {
        present: 'text-emerald-400',
        late: 'text-amber-400',
        halfDay: 'text-indigo-400',
        absent: 'text-rose-400',
        leave: 'text-slate-300',
    };
    return `
        <div class="hidden md:block overflow-hidden border border-slate-800 rounded-2xl">
            <table class="w-full text-left text-xs">
                <thead>
                    <tr class="bg-slate-950/80 text-[9px] font-bold uppercase tracking-wider text-slate-400">
                        <th class="px-3 py-2.5">Staff member</th>
                        <th class="px-2 py-2.5 text-center">Working days</th>
                        <th class="px-2 py-2.5 text-center">Present</th>
                        <th class="px-2 py-2.5 text-center">Late</th>
                        <th class="px-2 py-2.5 text-center">Half day</th>
                        <th class="px-2 py-2.5 text-center">Absent</th>
                        <th class="px-2 py-2.5 text-center">Leave</th>
                        <th class="px-2 py-2.5 text-center">Hours</th>
                        <th class="px-3 py-2.5 text-right">%</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-slate-800/70">
                    ${rows.map((row) => `
                        <tr class="bg-slate-900/60" data-report-row data-report-staff="${escAttr(row.staffId)}">
                            <td class="px-3 py-2.5">
                                <p class="font-bold text-slate-100 truncate max-w-[180px]">${esc(row.staffName)}</p>
                                <p class="text-[9px] text-slate-500 capitalize">working days · total days ${esc(row.days)}</p>
                            </td>
                            <td class="px-2 py-2.5 text-center"><span class="text-[11px] font-bold text-slate-100">${esc(row.workingDays)}</span></td>
                            <td class="px-2 py-2.5 text-center">${cellCls(row.present, colorFor.present)}</td>
                            <td class="px-2 py-2.5 text-center">${cellCls(row.late, colorFor.late)}</td>
                            <td class="px-2 py-2.5 text-center">${cellCls(row.halfDay, colorFor.halfDay)}</td>
                            <td class="px-2 py-2.5 text-center">${cellCls(row.absent, colorFor.absent)}</td>
                            <td class="px-2 py-2.5 text-center">${cellCls(row.leave, colorFor.leave)}</td>
                            <td class="px-2 py-2.5 text-center">${esc(row.totalHours ? `${Math.floor(row.totalHours / 60)}h${row.totalHours % 60 ? ' ' + (row.totalHours % 60) + 'm' : ''}` : '—')}</td>
                            <td class="px-3 py-2.5 text-right">${esc(formatAttendancePct(row.attendancePct))}</td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function reportMobileCards(rows) {
    return `
        <div class="space-y-2.5 md:hidden" data-report-mobile>
            ${rows.map((row) => `
                <div class="bg-slate-900 border border-slate-800 rounded-2xl p-3.5" data-report-row data-report-staff="${escAttr(row.staffId)}">
                    <div class="flex items-center justify-between gap-2">
                        <p class="text-xs font-bold text-slate-100 truncate">${esc(row.staffName)}</p>
                        <span class="text-[11px] font-extrabold text-brand-300 shrink-0">${esc(formatAttendancePct(row.attendancePct))}</span>
                    </div>
                    <div class="grid grid-cols-3 gap-1.5 mt-3">
                        ${[['Working', row.workingDays, 'text-slate-100'], ['Present', row.present, 'text-emerald-400'], ['Late', row.late, 'text-amber-400'], ['Half', row.halfDay, 'text-indigo-400'], ['Absent', row.absent, 'text-rose-400'], ['Leave', row.leave, 'text-slate-300'], ['Hours', row.totalHours ? `${Math.floor(row.totalHours / 60)}h${row.totalHours % 60 ? ' ' + (row.totalHours % 60) + 'm' : ''}` : '—', 'text-brand-300']].map(([label, value, cls]) => `
                            <div class="bg-slate-950/60 rounded-xl py-2 text-center">
                                <p class="text-[13px] font-extrabold ${escAttr(cls)}">${esc(String(value))}</p>
                                <p class="text-[8px] font-bold text-slate-500 uppercase mt-0.5">${esc(label)}</p>
                            </div>`).join('')}
                    </div>
                </div>`).join('')}
        </div>
    `;
}

function renderMonthlyReport(staff, attendance, month, reportStaffId) {
    const report = monthlyAttendanceReport(attendance, { month, staffId: reportStaffId, roster: staff });
    const t = report.totals;

    return `
        <div class="space-y-3.5">
            <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <p class="text-sm font-extrabold text-slate-100 capitalize">${esc(formatMonthLabel(month) || month)}</p>
                    <p class="text-[10px] text-slate-400 mt-0.5">One row per staff member · summary for the salon.</p>
                </div>
                <div class="flex items-center gap-1.5">
                    <input type="month" data-action="attendance-month" value="${escAttr(month)}"
                        aria-label="Report month"
                        class="bg-slate-900 border border-slate-800 px-2.5 py-2 rounded-xl text-[11px] text-slate-100 focus:outline-none focus:border-brand-500">
                    <select data-action="attendance-staff-filter"
                        class="bg-slate-900 border border-slate-800 px-2.5 py-2 rounded-xl text-[11px] text-slate-100 focus:outline-none focus:border-brand-500">
                        <option value="all" ${reportStaffId === 'all' ? 'selected' : ''}>All staff</option>
                        ${staff.map((s) => `<option value="${escAttr(s.id)}" ${reportStaffId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
                    </select>
                </div>
            </div>

            <div class="grid grid-cols-3 md:grid-cols-6 gap-2" data-attendance-summary>
                ${summaryCard('Team', t.teamSize, 'text-slate-100')}
                ${summaryCard('Working days', t.workingDays, 'text-brand-300')}
                ${summaryCard('Total hours', t.totalHours ? `${Math.floor(t.totalHours / 60)}h${t.totalHours % 60 ? ' ' + (t.totalHours % 60) + 'm' : ''}` : '0h', 'text-slate-100')}
                ${summaryCard('Attendance', formatAttendancePct(t.attendancePct), 'text-emerald-400')}
                ${summaryCard('Late', t.late, 'text-amber-400')}
                ${summaryCard('Leave', t.leave, 'text-indigo-400')}
            </div>

            ${report.hasActivity
                ? `${reportDesktopTable(report.rows)}${reportMobileCards(report.rows)}`
                : emptyState('No attendance recorded for this month yet. Mark today\'s attendance in the daily view and check back here.')}
        </div>
    `;
}

export function renderAttendance(state) {
    const staff = scopedBySalon(state.staffList, state.currentSalonId);
    const attendance = scopedBySalon(state.attendanceList, state.currentSalonId);
    const date = state.attendanceDate || todayStr();
    const month = state.attendanceHistoryMonth || todayStr().slice(0, 7);
    const reportStaffId = state.attendanceHistoryStaffId || 'all';

    return `
        <div class="space-y-5 xl:grid xl:grid-cols-2 xl:gap-5 xl:items-start xl:space-y-0">
            <section data-attendance-daily>
                ${renderDailyAttendance(staff, attendance, date)}
            </section>
            <section data-attendance-monthly>
                ${renderMonthlyReport(staff, attendance, month, reportStaffId)}
            </section>
        </div>
    `;
}

export default renderAttendance;