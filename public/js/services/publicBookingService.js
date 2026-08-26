/**
 * publicBookingService.js
 * All Firestore access for the public, no-login booking page.
 *
 * This is a companion to — not a replacement for — the CRM's own
 * repositories. It writes to the EXACT same collections, in the EXACT same
 * document shapes, that customersRepository.js / appointmentsRepository.js
 * produce (see the inline comments below for the precise field-for-field
 * mapping), so a booking made here is indistinguishable, once written, from
 * one made inside the CRM. It cannot reuse those repositories' functions
 * directly because they are bound to the authenticated app's global `store`
 * and single active-salon session (see scopedRepository.js) — a public page
 * has no session and must be able to target ANY salon by id from a URL.
 *
 * Every write below goes through `runAtomic` (a single Firestore
 * transaction): the referrer lookup, the customer find-or-create, the phone
 * index, the slot locks and the appointment (and, if applicable, the
 * referral) all commit together or not at all. Combined with the
 * deterministic ids used throughout (appointment id, phone index id, slot
 * lock ids, referral id), a duplicate submit — a double-click, a retried
 * network request, a customer re-opening the same tab — can never create two
 * bookings or credit a referral twice.
 */

import { getFirebase, isDemoMode, initFirebase } from './firebase.js';
import { getDocument, getCollection, runAtomic, newDocId } from './db.js';
import { seed as customerSeed } from './customersRepository.js';
import { seed as serviceSeedList } from './servicesRepository.js';
import { seed as staffSeedList } from './staffRepository.js';
import { sanitizeBookingSettings, toPublicServices, toPublicStaff, DEFAULT_BOOKING_SETTINGS } from '../core/bookingConfig.js';
import {
    normalizeCode,
    isValidCodeFormat,
    sanitizeSettings,
    round2,
    DEFAULT_REFERRAL_SETTINGS,
} from '../core/referral.js';
import {
    totalDurationMinutes,
    totalServicePrice,
    lockKeysForBooking,
    availableSlotsForStaff,
    availableSlotsAnyStaff,
    ANY_STAFF,
} from '../core/scheduling.js';
import { normalizePhoneDigits, toIndianE164 } from '../core/validate.js';
import { makeId } from '../core/utils.js';

/** Boot Firestore for the public page (idempotent, safe to call repeatedly). */
export async function ensureBackend() {
    if (getFirebase()) return true;
    return initFirebase();
}

/* ------------------------------------------------------------------ */
/* Demo mode                                                            */
/*                                                                      */
/* The public booking page is a separate document/runtime from the CRM  */
/* SPA — it shares no in-memory state with core/store.js at all — so it */
/* keeps its own tiny demo dataset, seeded from the SAME seed exports   */
/* the main app uses (same salon, same demo clients/services/staff),   */
/* purely so this feature can be exercised end-to-end (unit + e2e       */
/* tests) without a live Firebase project, exactly like the rest of     */
/* this repo's test suite already does for the authenticated app.       */
/* Real deployments always have a Firebase config injected, so this     */
/* branch never runs in production.                                     */
/* ------------------------------------------------------------------ */

const DEMO_REFERRAL_CODE = 'TESTCASE';
// The only salon id demo mode has any data for (matches the seed exports).
// Any other salonId behaves like a real, never-configured salon — the
// public page correctly shows "unavailable" rather than fabricating data
// for an id that doesn't exist.
const DEMO_SALON_ID = customerSeed[0]?.salonId || 'salon_luxe_01';

let demo = null;

function demoStore() {
    if (demo) return demo;
    const customers = new Map(customerSeed.map((c) => [c.id, { ...c }]));
    demo = {
        customers,
        phoneIndex: new Map(),
        appointments: new Map(),
        referrals: new Map(),
        slots: new Map(),
        bookingSettings: sanitizeBookingSettings({
            ...DEFAULT_BOOKING_SETTINGS,
            enabled: true,
            publicServices: toPublicServices(serviceSeedList),
            publicStaff: toPublicStaff(staffSeedList),
        }),
        referralSettings: { ...DEFAULT_REFERRAL_SETTINGS },
        // A known, fixed demo code so the referral path is exercisable
        // without needing the authenticated app to have allocated one first.
        referralCodes: new Map([[DEMO_REFERRAL_CODE, { customerId: customerSeed[0].id, customerName: customerSeed[0].name, active: true }]]),
    };
    return demo;
}

const DEMO_COLLECTIONS = {
    customers: (d) => d.customers,
    customerPhoneIndex: (d) => d.phoneIndex,
    appointments: (d) => d.appointments,
    referrals: (d) => d.referrals,
    appointmentSlots: (d) => d.slots,
};

/** In-memory stand-in for a Firestore transaction, backed by `demoStore()`. */
function demoAtomic(work) {
    const d = demoStore();
    const writes = [];
    const ctx = {
        async get(segments, id) {
            const collectionName = segments[2];
            const map = DEMO_COLLECTIONS[collectionName] && DEMO_COLLECTIONS[collectionName](d);
            if (!map) return null;
            const row = map.get(id);
            return row ? { id, ...row } : null;
        },
        set(segments, id, data) {
            const collectionName = segments[2];
            writes.push(() => {
                const map = DEMO_COLLECTIONS[collectionName] && DEMO_COLLECTIONS[collectionName](d);
                if (map) map.set(id, { ...data });
            });
        },
    };
    return Promise.resolve(work(ctx)).then((result) => {
        writes.forEach((apply) => apply());
        return result;
    });
}

/** Run `work` against either a real Firestore transaction or the demo store. */
function atomic(work) {
    return isDemoMode() ? demoAtomic(work) : runAtomic(work);
}

/* ------------------------------------------------------------------ */
/* Reads                                                                */
/* ------------------------------------------------------------------ */

/** The salon's public booking configuration, or null when never configured. */
export async function fetchBookingSettings(salonId) {
    if (isDemoMode()) return salonId === DEMO_SALON_ID ? { ...demoStore().bookingSettings } : null;
    const row = await getDocument(['salons', salonId, 'bookingSettings'], 'config');
    return row ? sanitizeBookingSettings(row) : null;
}

/** The salon's public (marketing) referral terms, or null when unset/disabled. */
export async function fetchReferralSettings(salonId) {
    if (isDemoMode()) return { ...demoStore().referralSettings };
    return getDocument(['salons', salonId, 'referralSettings'], 'config');
}

/** Resolve a referral code to the client who owns it (public get-by-code only). */
export async function resolveReferralCode(salonId, code) {
    const key = normalizeCode(code);
    if (!key || !isValidCodeFormat(key)) return null;
    if (isDemoMode()) {
        const row = demoStore().referralCodes.get(key);
        if (!row || row.active === false) return null;
        return { customerId: row.customerId, customerName: row.customerName || '' };
    }
    const row = await getDocument(['salons', salonId, 'referralCodes'], key);
    if (!row || row.active === false) return null;
    return { customerId: row.customerId, customerName: row.customerName || '' };
}

/** Every slot-lock document for one date (zero PII — see firestore.rules). */
export async function fetchSlotLocks(salonId, date) {
    if (isDemoMode()) {
        return [...demoStore().slots.values()].filter((row) => row.date === date);
    }
    return getCollection(['salons', salonId, 'appointmentSlots'], { where: [['date', '==', date]] });
}

/**
 * Available start times for a candidate service selection on one date, for
 * either a named staff member or "Any Available Staff". Locks are fetched
 * fresh for this call — never cached across a session — so the picker always
 * reflects the live database, not a stale in-memory snapshot.
 */
export async function fetchAvailableSlots({ salonId, settings, date, durationMinutes, staffName, staffList, now = new Date() }) {
    const locks = await fetchSlotLocks(salonId, date);
    // Slot generation treats a lock as a same-staff appointment occupying a
    // single 5-minute tick — reusing hasConflict's overlap math for free.
    const asAppointments = locks.map((l) => ({ staffName: l.staffName, date: l.date, time: l.time, durationMinutes: 5, status: 'Confirmed' }));

    const today = now.toISOString().slice(0, 10);
    const isToday = date === today;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const common = {
        workingHours: settings.workingHours,
        date,
        slotIntervalMinutes: settings.slotIntervalMinutes,
        durationMinutes,
        existingAppointments: asAppointments,
        isToday,
        nowMinutes,
        minNoticeMinutes: settings.minNoticeMinutes,
    };

    if (staffName && staffName !== ANY_STAFF) {
        return availableSlotsForStaff({ ...common, staffName }).map((time) => ({ time, staffName }));
    }
    return availableSlotsAnyStaff({ ...common, staffList });
}

/* ------------------------------------------------------------------ */
/* Booking submission                                                   */
/* ------------------------------------------------------------------ */

const SIGNUP_BONUS = 100; // must match customersRepository.js exactly
const STARTING_WALLET_BALANCE = 0;

/** A stable per-attempt id, persisted so a page refresh mid-submit reuses it. */
export function getIdempotencyToken(storageKey = 'qvrix_booking_attempt') {
    try {
        const existing = sessionStorage.getItem(storageKey);
        if (existing) return existing;
        const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
        sessionStorage.setItem(storageKey, token);
        return token;
    } catch (e) {
        // Private-browsing / storage-denied fallback: still unique per page load.
        return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    }
}

/** Clear the idempotency token after a booking succeeds (a NEW booking gets a new one). */
export function clearIdempotencyToken(storageKey = 'qvrix_booking_attempt') {
    try { sessionStorage.removeItem(storageKey); } catch (e) { /* ignore */ }
}

/**
 * Submit a public booking. `input` shape:
 *   salonId, settings (sanitized bookingSettings), servicesCatalog, staffList,
 *   selectedServiceNames[], staffName (or ANY_STAFF), date, time,
 *   customerName, customerPhone (national digits), customerEmail, referralCode,
 *   notes, idempotencyToken
 *
 * Returns a plain confirmation object (never a live Firestore reference) —
 * everything the confirmation screen needs, computed from data the caller
 * already has plus what the transaction decided (assigned staff, final ids).
 */
export async function submitPublicBooking(input) {
    const {
        salonId, settings, servicesCatalog, staffList,
        selectedServiceNames, staffName, date, time,
        customerName, customerPhone, customerEmail, referralCode, notes,
        idempotencyToken,
    } = input;

    if (!salonId) throw new Error('Missing salon.');
    if (!settings || settings.enabled !== true) throw new Error('Online booking is not available for this salon right now.');
    if (!Array.isArray(selectedServiceNames) || selectedServiceNames.length === 0) {
        throw new Error('Select at least one service.');
    }
    if (!date || !time) throw new Error('Select a date and time.');
    if (!customerName || !customerName.trim()) throw new Error('Enter your name.');
    const phoneDigits = normalizePhoneDigits(customerPhone);
    if (phoneDigits.length !== 10) throw new Error('Enter a valid 10-digit mobile number.');
    const phoneE164 = toIndianE164(customerPhone);

    const durationMinutes = totalDurationMinutes(selectedServiceNames, servicesCatalog);
    if (durationMinutes <= 0) throw new Error('Selected services could not be resolved.');
    const estimatedAmount = round2(totalServicePrice(selectedServiceNames, servicesCatalog));

    const appointmentId = `pub_${idempotencyToken}`;
    const phoneIndexId = phoneDigits;

    // Referral code + the salon's CURRENT reward terms are both resolved
    // BEFORE the transaction (plain reads — neither is mutated by booking).
    // The terms are snapshotted onto the new referral exactly like the
    // authenticated referralService.linkReferral() does, so this referral
    // pays out under the real configured rules rather than a placeholder.
    let referrer = null;
    let referralTerms = null;
    if (referralCode) {
        referralTerms = sanitizeSettings(await fetchReferralSettings(salonId));
        if (referralTerms.enabled) {
            referrer = await resolveReferralCode(salonId, referralCode);
        }
    }

    const result = await atomic(async (tx) => {
        // ---- 1. Find or create the customer (all reads first) ----
        const existingIndex = await tx.get(['salons', salonId, 'customerPhoneIndex'], phoneIndexId);
        let customerId = existingIndex ? existingIndex.customerId : null;
        let existingCustomer = customerId ? await tx.get(['salons', salonId, 'customers'], customerId) : null;

        const isNewCustomer = !existingCustomer;
        if (isNewCustomer) {
            customerId = newDocId('salons', salonId, 'customers') || makeId('cus');
        }

        // ---- 2. Resolve staff assignment + acquire slot locks ----
        // Every candidate's lock ticks are checked with tx.get (not the
        // separate, non-transactional fetchSlotLocks used for the slot
        // picker) so the final decision is made against this transaction's
        // own consistent read snapshot — the same guarantee "Any Available
        // Staff" and a specific staff pick both get.
        let finalStaff = staffName;
        let finalKeys = [];
        if (!finalStaff || finalStaff === ANY_STAFF) {
            for (const candidate of staffList) {
                const keys = lockKeysForBooking(candidate.name, date, time, durationMinutes);
                const rows = await Promise.all(keys.map((k) => tx.get(['salons', salonId, 'appointmentSlots'], k)));
                if (rows.every((r) => !r)) {
                    finalStaff = candidate.name;
                    finalKeys = keys;
                    break;
                }
            }
            if (!finalStaff || finalStaff === ANY_STAFF) {
                throw new Error('No staff member is available for this time. Please choose another slot.');
            }
        } else {
            finalKeys = lockKeysForBooking(finalStaff, date, time, durationMinutes);
            const rows = await Promise.all(finalKeys.map((k) => tx.get(['salons', salonId, 'appointmentSlots'], k)));
            if (rows.some((r) => !!r)) {
                throw new Error('This time was just booked by someone else. Please choose another slot.');
            }
        }

        // ---- 3. Referral: re-verify self-referral against the resolved customer ----
        let referralWrite = null;
        if (referrer && referrer.customerId) {
            const samePerson = referrer.customerId === customerId;
            const referrerCustomer = !samePerson ? await tx.get(['salons', salonId, 'customers'], referrer.customerId) : null;
            const sameEmail = referrerCustomer && customerEmail
                && String(referrerCustomer.email || '').trim().toLowerCase() === String(customerEmail).trim().toLowerCase();
            const samePhone = referrerCustomer
                && normalizePhoneDigits(referrerCustomer.phone) === phoneDigits;

            if (samePerson || sameEmail || samePhone) {
                // Silently ignore a self-referral rather than failing the whole
                // booking over it — the appointment itself is still valid.
            } else if (!isNewCustomer && existingCustomer && existingCustomer.referredBy) {
                // Already has a referrer from a previous booking — ignore.
            } else {
                referralWrite = {
                    id: `ref_${customerId}`,
                    referrerId: referrer.customerId,
                    referrerName: referrer.customerName || '',
                };
            }
        }

        // ---- 4. Writes ----
        if (isNewCustomer) {
            tx.set(['salons', salonId, 'customers'], customerId, {
                salonId,
                name: customerName.trim(),
                phone: phoneE164,
                email: (customerEmail || '').trim(),
                rewardPoints: SIGNUP_BONUS,
                walletBalance: STARTING_WALLET_BALANCE,
                source: 'public_booking',
                ...(referralWrite ? { referredBy: referralWrite.referrerId, referredByCode: normalizeCode(referralCode) } : {}),
                createdAt: new Date().toISOString(),
            });
            tx.set(['salons', salonId, 'customerPhoneIndex'], phoneIndexId, { customerId, createdAt: new Date().toISOString() });
        }

        if (referralWrite) {
            tx.set(['salons', salonId, 'referrals'], referralWrite.id, {
                salonId,
                code: normalizeCode(referralCode),
                referrerId: referralWrite.referrerId,
                referrerName: referralWrite.referrerName,
                referredId: customerId,
                referredName: customerName.trim(),
                status: 'Pending',
                rewardType: referralTerms.rewardType,
                rewardValue: referralTerms.rewardValue,
                minInvoiceAmount: referralTerms.minInvoiceAmount,
                maxRewardAmount: referralTerms.maxRewardAmount,
                rewardTrigger: referralTerms.rewardTrigger,
                expiryDays: referralTerms.expiryDays,
                rewardAmount: 0, redeemedAmount: 0, reversedAmount: 0, expiredAmount: 0,
                qualifyingAppointmentId: null, qualifyingInvoiceNo: null, qualifyingInvoiceAmount: 0,
                qualifiedAt: null, creditedAt: null, expiresAt: null,
                reversedAt: null, reversalReason: null, walletTxnId: null,
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            });
        }

        for (const key of finalKeys) {
            tx.set(['salons', salonId, 'appointmentSlots'], key, {
                appointmentId,
                staffName: finalStaff,
                date,
                time,
                createdAt: new Date().toISOString(),
            });
        }

        const appointmentRow = {
            salonId,
            customerId,
            customerName: customerName.trim(),
            customerPhone: phoneE164,
            serviceName: selectedServiceNames[0],
            services: selectedServiceNames.map((name) => {
                const svc = (servicesCatalog || []).find((s) => s.name === name);
                return { name, price: svc ? Number(svc.price) || 0 : 0 };
            }),
            staffName: finalStaff,
            date,
            time,
            status: 'Confirmed',
            amount: estimatedAmount,
            paid: false,
            source: input.source === 'whatsapp' ? 'whatsapp' : 'public_booking',
            notes: (notes || '').trim().slice(0, 500),
            createdAt: new Date().toISOString(),
        };
        tx.set(['salons', salonId, 'appointments'], appointmentId, appointmentRow);

        return {
            appointmentId,
            customerId,
            customerName: appointmentRow.customerName,
            services: appointmentRow.services,
            staffName: finalStaff,
            date,
            time,
            estimatedAmount,
            status: 'Confirmed',
            referralApplied: !!referralWrite,
        };
    });

    clearIdempotencyToken();
    return result;
}

/**
 * Read-only snapshot of the demo dataset, for the e2e test suite to verify
 * writes landed correctly (customer identification, referral linking, slot
 * locks) without a live Firestore project to inspect. No-op — returns null —
 * outside demo mode, so this can never expose anything in production.
 */
export function _debugDemoSnapshot() {
    if (!isDemoMode()) return null;
    const d = demoStore();
    // Map values never carry their own key (matching real Firestore, where
    // the id is the document's path segment, not a data field) — re-attach
    // it here so a snapshot consumer can identify each row.
    const withIds = (map) => [...map.entries()].map(([id, data]) => ({ id, ...data }));
    return {
        customers: withIds(d.customers),
        appointments: withIds(d.appointments),
        referrals: withIds(d.referrals),
        slots: withIds(d.slots),
        phoneIndex: Object.fromEntries(d.phoneIndex),
    };
}

export default {
    ensureBackend,
    fetchBookingSettings,
    fetchReferralSettings,
    resolveReferralCode,
    fetchSlotLocks,
    fetchAvailableSlots,
    getIdempotencyToken,
    clearIdempotencyToken,
    submitPublicBooking,
    _debugDemoSnapshot,
};
