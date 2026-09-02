/**
 * views/attendance.js
 * Staff attendance: a day-by-day roster (mark each staff member's status for
 * a chosen date) plus a searchable monthly history.
 *
 * The document id in Firestore is `{staffId}_{date}` (see
 * attendanceRepository.js), which is what actually prevents a duplicate
 * record — this view just reads what already exists to decide whether a
 * click should create or update.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { emptyState, badge, iconAction } from '../components.js';
import { initials, scopedBySalon, todayStr } from '../../core/utils.js';
import { ATTENDANCE_STATUSES } from '../../core/validate.js';

const STATUS_BADGE_CLASSES = {
    Present: 'bg-emerald-500/15 text-emerald-400',
    Absent: 'bg-rose-500/15 text-rose-400',
    Late: 'bg-amber-500/15 text-amber-400',
    'Half Day': 'bg-indigo-500/15 text-indigo-400',
    Leave: 'bg-slate-500/15 text-slate-300',
};

/** The active attendance date, defaulting to today. */
export function activeAttendanceDate(state) {
    return state.attendanceDate || todayStr();
}

/** The active history month (YYYY-MM), defaulting to the current month. */
export function activeAttendanceMonth(state) {
    return state.attendanceHistoryMonth || todayStr().slice(0, 7);
}

function rosterRow(staffMember, record) {
    const status = record?.status || '';
    return `
        <div class="bg-slate-900 border border-slate-800 p-3.5 rounded-2xl flex items-center gap-3">
            <div class="w-9 h-9 rounded-xl bg-brand-500/15 text-brand-400 flex items-center justify-center font-bold text-xs shrink-0" aria-hidden="true">
                ${esc(initials(staffMember.name))}
            </div>
            <div class="min-w-0 flex-1">
                <p class="text-xs font-bold text-slate-100 truncate">${esc(staffMember.name)}</p>
                <p class="text-[10px] text-slate-400 truncate">${esc(staffMember.role || '')}</p>
            </div>
            <div class="shrink-0 w-[124px]">
                <select data-action="mark-attendance-status" data-staff-id="${escAttr(staffMember.id)}" data-staff-name="${escAttr(staffMember.name)}" data-record-id="${escAttr(record?.id || '')}"
                    class="w-full bg-slate-950 border border-slate-800 px-2.5 py-2 rounded-xl text-[11px] text-slate-100 focus:outline-none focus:border-brand-500">
                    <option value="" ${status === '' ? 'selected' : ''}>Not marked</option>
                    ${ATTENDANCE_STATUSES.map((s) => `<option value="${escAttr(s)}" ${status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
                </select>
            </div>
            ${record
                ? `<div class="shrink-0">${iconAction('open-edit', { type: 'attendance', id: record.id }, 'Edit attendance', 'pencil', 'bg-slate-800 hover:bg-slate-700 text-slate-300')}</div>`
                : ''}
        </div>
    `;
}

function historyRow(row) {
    const times = [row.checkIn, row.checkOut].filter(Boolean).join(' – ');
    return `
        <div class="bg-slate-900 border border-slate-800 p-3.5 rounded-2xl flex items-center justify-between gap-3">
            <div class="min-w-0">
                <p class="text-xs font-bold text-slate-100 truncate">${esc(row.staffName)}</p>
                <p class="text-[10px] text-slate-400 mt-0.5">${esc(row.date)}${times ? ` • ${esc(times)}` : ''}</p>
                ${row.notes ? `<p class="text-[10px] text-slate-500 mt-0.5 truncate">${esc(row.notes)}</p>` : ''}
            </div>
            <div class="flex items-center gap-2 shrink-0">
                ${badge(row.status, STATUS_BADGE_CLASSES[row.status] || 'bg-slate-500/15 text-slate-300')}
                ${iconAction('open-edit', { type: 'attendance', id: row.id }, 'Edit attendance', 'pencil', 'bg-slate-800 hover:bg-slate-700 text-slate-300')}
                ${iconAction('request-delete', { type: 'attendance', id: row.id, label: `${row.staffName} — ${row.date}` }, 'Delete attendance', 'trash-2', 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400')}
            </div>
        </div>
    `;
}

export function renderAttendance(state) {
    const staff = scopedBySalon(state.staffList, state.currentSalonId);
    const attendance = scopedBySalon(state.attendanceList, state.currentSalonId);
    const date = activeAttendanceDate(state);
    const month = activeAttendanceMonth(state);
    const historyStaffId = state.attendanceHistoryStaffId || 'all';

    const byId = new Map(attendance.map((row) => [row.id, row]));
    const rosterRows = staff.map((s) => rosterRow(s, byId.get(`${s.id}_${date}`)));

    const historyRows = attendance
        .filter((row) => row.date.startsWith(month) && (historyStaffId === 'all' || row.staffId === historyStaffId))
        .sort((a, b) => b.date.localeCompare(a.date) || (a.staffName || '').localeCompare(b.staffName || ''));

    return `
        <div class="space-y-5">
            <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                <div class="flex items-center justify-between gap-3">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Mark Attendance</p>
                    <input type="date" data-action="attendance-date" value="${escAttr(date)}" max="${escAttr(todayStr())}"
                        class="bg-slate-950 border border-slate-800 px-3 py-2 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500">
                </div>
                ${staff.length === 0
                    ? emptyState('No staff members registered yet.')
                    : `<div class="space-y-2">${rosterRows.join('')}</div>`}
            </div>

            <div class="space-y-3">
                <div class="flex items-center justify-between gap-3">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">History</p>
                    <div class="flex items-center gap-2">
                        <input type="month" data-action="attendance-month" value="${escAttr(month)}"
                            class="bg-slate-950 border border-slate-800 px-2.5 py-1.5 rounded-xl text-[11px] text-slate-100 focus:outline-none focus:border-brand-500">
                    </div>
                </div>
                <select data-action="attendance-staff-filter" class="w-full bg-slate-950 border border-slate-800 px-4 py-2.5 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500">
                    <option value="all" ${historyStaffId === 'all' ? 'selected' : ''}>All staff</option>
                    ${staff.map((s) => `<option value="${escAttr(s.id)}" ${historyStaffId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
                </select>
                ${historyRows.length === 0
                    ? emptyState('No attendance recorded for this month.')
                    : `<div class="space-y-2">${historyRows.map(historyRow).join('')}</div>`}
            </div>
        </div>
    `;
}

export default renderAttendance;
