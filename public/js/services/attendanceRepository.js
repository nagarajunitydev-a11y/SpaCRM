/**
 * attendanceRepository.js
 * Tenant-scoped staff attendance: `salons/{salonId}/attendance/{docId}`.
 *
 * The document id is deterministic — `{staffId}_{date}` — so a second
 * attendance record for the same staff member on the same day is impossible
 * at the database level, not just in the UI: `createIfAbsent` is an atomic
 * create-only transaction, so a duplicate `markAttendance` call simply fails
 * instead of racing a read-then-write check.
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { listenCollection, createIfAbsent, updateDocument, deleteDocument } from './db.js';

export const COLLECTION = 'attendance';

let unsub = null;
let subscribedId = null;

/** Attendance records for the active salon. */
export function listAttendance() {
    return store.getState().attendanceList || [];
}

function setAttendance(rows) {
    const byId = new Map();
    (rows || []).forEach((row) => {
        if (row && row.id) byId.set(row.id, row);
    });
    store.setState({ attendanceList: [...byId.values()] });
}

/** (Re)point the attendance registry at a salon. */
export function setSalon(salonId) {
    if (salonId === subscribedId && unsub) return;
    if (unsub) {
        unsub();
        unsub = null;
    }
    subscribedId = salonId;

    if (isDemoMode()) return;
    if (!salonId || !store.getState().currentUser) {
        setAttendance([]);
        return;
    }
    unsub = listenCollection(
        ['salons', salonId, COLLECTION],
        (rows) => setAttendance(rows),
        () => setAttendance([]),
    );
}

/** The deterministic record id for a staff member on a given date. */
export function attendanceId(staffId, date) {
    return `${staffId}_${date}`;
}

/** The attendance record for a staff member on a given date, if any. */
export function findAttendance(staffId, date) {
    const id = attendanceId(staffId, date);
    return listAttendance().find((row) => row.id === id) || null;
}

/**
 * Mark a staff member's attendance for a day. Rejected outright when a
 * record for that staff/date already exists — use `updateAttendance` to
 * change it instead.
 */
export async function markAttendance({ staffId, staffName, date, status, checkIn = '', checkOut = '', notes = '' }) {
    if (!staffId || !date) throw new Error('Staff member and date are required.');
    const id = attendanceId(staffId, date);
    const row = {
        staffId,
        staffName: staffName || '',
        date,
        status,
        checkIn: checkIn || '',
        checkOut: checkOut || '',
        notes: notes || '',
        createdAt: new Date().toISOString(),
    };

    if (isDemoMode()) {
        if (findAttendance(staffId, date)) {
            throw new Error(`Attendance for ${staffName || 'this staff member'} on ${date} is already recorded.`);
        }
        setAttendance([...listAttendance(), { id, ...row }]);
        return { id, ...row };
    }

    const salonId = subscribedId;
    if (!salonId) throw new Error('No salon selected. Please set up your salon first.');
    const result = await createIfAbsent(['salons', salonId, COLLECTION], id, row);
    if (!result || !result.created) {
        throw new Error(`Attendance for ${staffName || 'this staff member'} on ${date} is already recorded.`);
    }
    return result.row;
}

/** Update an existing attendance record (status, times, notes). */
export async function updateAttendance(id, patch) {
    if (isDemoMode()) {
        setAttendance(listAttendance().map((row) => (row.id === id ? { ...row, ...patch } : row)));
        return { id, ...patch };
    }
    const salonId = subscribedId;
    if (!salonId) throw new Error('No salon selected.');
    return updateDocument(['salons', salonId, COLLECTION], id, patch);
}

/** Delete an attendance record. */
export async function deleteAttendance(id) {
    if (isDemoMode()) {
        setAttendance(listAttendance().filter((row) => row.id !== id));
        return { id };
    }
    const salonId = subscribedId;
    if (!salonId) throw new Error('No salon selected.');
    await deleteDocument(['salons', salonId, COLLECTION], id);
    return { id };
}

export default {
    COLLECTION,
    setSalon,
    listAttendance,
    attendanceId,
    findAttendance,
    markAttendance,
    updateAttendance,
    deleteAttendance,
};
