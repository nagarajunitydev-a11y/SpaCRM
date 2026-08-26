/**
 * appointmentsRepository.js
 * Tenant-scoped appointments / bookings.
 *
 * Also maintains the `appointmentSlots` lock documents (see
 * core/scheduling.js) whenever a staffed appointment is created, moved or
 * cancelled — the same atomic double-booking guard the public booking page
 * relies on, kept in sync for internally-created appointments too, so a
 * WhatsApp booking can never collide with a slot a staff member books
 * in-person and vice versa. Locking is best-effort and fire-and-forget: it
 * never blocks, delays or can fail an internal booking/edit/delete action —
 * only the public booking page's own writes are ever rejected by a lock.
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { createIfAbsent, deleteDocument } from './db.js';
import { totalDurationMinutes, lockKeysForBooking, ANY_STAFF } from '../core/scheduling.js';
import { createScopedRepository } from './scopedRepository.js';
import { appointmentSeed } from './seedData.js';

export const seed = appointmentSeed;

const repo = createScopedRepository({
    stateKey: 'appointmentsList',
    collectionName: 'appointments',
    seed,
});

export const initAppointments = repo.init;
export const setSalon = repo.setSalon;
export const listAppointments = repo.data;

/** The booked service names on an appointment, whatever shape they're stored in. */
function serviceNamesOf(appointment) {
    if (Array.isArray(appointment.services) && appointment.services.length) {
        return appointment.services.map((s) => (typeof s === 'string' ? s : s.name));
    }
    if (Array.isArray(appointment.serviceNames) && appointment.serviceNames.length) return appointment.serviceNames;
    return appointment.serviceName ? [appointment.serviceName] : [];
}

function resolvedDuration(appointment) {
    const catalog = store.getState().servicesList || [];
    return totalDurationMinutes(serviceNamesOf(appointment), catalog);
}

function eligibleForLocking(appointment) {
    return !!(appointment && appointment.staffName && appointment.staffName !== ANY_STAFF
        && appointment.date && appointment.time);
}

/**
 * Best-effort: acquire a lock for every 5-minute tick this appointment
 * occupies. Never throws — a lock failure only means a future booking
 * (internal or public) might not see this one reflected, it can never affect
 * the appointment that was just created/moved.
 */
async function tryLockSlot(salonId, appointment) {
    if (isDemoMode() || !salonId || !eligibleForLocking(appointment)) return;
    const duration = resolvedDuration(appointment);
    if (duration <= 0) return;
    const keys = lockKeysForBooking(appointment.staffName, appointment.date, appointment.time, duration);
    for (const key of keys) {
        try {
            await createIfAbsent(['salons', salonId, 'appointmentSlots'], key, {
                appointmentId: appointment.id,
                staffName: appointment.staffName,
                date: appointment.date,
                time: appointment.time,
                createdAt: new Date().toISOString(),
            });
        } catch (err) {
            console.warn('[appointments] Could not lock slot', key, err);
        }
    }
}

/** Best-effort: release every lock this appointment previously held. */
async function tryReleaseSlot(salonId, appointment) {
    if (isDemoMode() || !salonId || !eligibleForLocking(appointment)) return;
    const duration = resolvedDuration(appointment);
    if (duration <= 0) return;
    const keys = lockKeysForBooking(appointment.staffName, appointment.date, appointment.time, duration);
    for (const key of keys) {
        try {
            await deleteDocument(['salons', salonId, 'appointmentSlots'], key);
        } catch (err) {
            console.warn('[appointments] Could not release slot', key, err);
        }
    }
}

/** Add an appointment via the normal internal flow. */
export async function addAppointment(payload, opts = {}) {
    const row = await repo.add(payload, opts);
    tryLockSlot(row.salonId, row);
    return row;
}

/**
 * Update an appointment, keeping its slot lock in step: a cancellation or a
 * staff/date/time change releases the old lock, and a still-active
 * staff/date/time change acquires a fresh one for the new slot.
 */
export async function updateAppointment(id, patch) {
    const before = repo.data().find((a) => a.id === id) || null;
    const result = await repo.update(id, patch);

    if (before) {
        const salonId = before.salonId || store.getState().currentSalonId;
        const after = { ...before, ...patch };
        const slotChanged = patch.staffName !== undefined || patch.date !== undefined || patch.time !== undefined;
        const justCancelled = patch.status === 'Cancelled' && before.status !== 'Cancelled';

        if (salonId && (justCancelled || slotChanged)) {
            tryReleaseSlot(salonId, before);
        }
        if (salonId && !justCancelled && after.status !== 'Cancelled' && slotChanged) {
            tryLockSlot(salonId, after);
        }
    }
    return result;
}

/** Delete an appointment, releasing its slot lock. */
export async function deleteAppointment(id) {
    const before = repo.data().find((a) => a.id === id) || null;
    const result = await repo.remove(id);
    if (before) {
        const salonId = before.salonId || store.getState().currentSalonId;
        if (salonId) tryReleaseSlot(salonId, before);
    }
    return result;
}

export default {
    initAppointments,
    setSalon,
    addAppointment,
    updateAppointment,
    deleteAppointment,
    listAppointments,
    seed,
};
