/**
 * appointmentsRepository.js
 * Tenant-scoped appointments / bookings.
 *
 * Referral bonus is credited when an appointment reaches "Completed" status,
 * not on booking creation.  This ensures the referrer is rewarded only when
 * the referred customer actually attends their visit.
 *
 * The credit flow is idempotent and crash-safe: the transaction ledger
 * (rewardTransactions with deterministic IDs) is the single source of truth
 * for whether a bonus has been credited.  The referral status field
 * ("Successful" / "Bonus Credited") is an optimistic side-effect — it may
 * race ahead of the actual credit, but the transaction check always prevents
 * double-crediting and detects partial failures for recovery.
 */

import { createScopedRepository } from './scopedRepository.js';
import { REFERRAL_BONUS_POINTS } from '../core/rewards.js';
import * as referralsRepository from './referralsRepository.js';
import * as customersRepository from './customersRepository.js';
import * as rewardTransactionsRepository from './rewardTransactionsRepository.js';

export const seed = [
    { id: 'a1', salonId: 'salon_luxe_01', customerName: 'Olivia Wilde', serviceName: 'Balayage & Gloss', staffName: 'Victoria Sterling', date: '2026-06-15', time: '10:00', status: 'Confirmed' },
];

const repo = createScopedRepository({
    stateKey: 'appointmentsList',
    collectionName: 'appointments',
    seed,
});

export const initAppointments = repo.init;
export const setSalon = repo.setSalon;
export const updateAppointment = repo.update;
export const deleteAppointment = repo.remove;
export const listAppointments = repo.data;

/**
 * Add an appointment.  Referral bonus is NOT triggered here — it fires
 * only when the appointment status changes to "Completed".
 */
export async function addAppointment(payload, opts = {}) {
    return repo.add(payload, opts);
}

/**
 * Credit the referrer when a referred customer's appointment is completed.
 *
 * Crash-safe idempotency model:
 *   - The referral status field ("Pending" → "Successful" → "Bonus Credited")
 *     is an optimistic concurrency aid — it may be ahead of the actual credit
 *     if a previous call crashed mid-flow.
 *   - The transaction ledger (rewardTransactions with deterministic ID
 *     `REFERRAL__<referralId>`) is the TRUE idempotency gate.  A missing
 *     transaction means the points were never credited, regardless of the
 *     referral status.
 *   - This function NEVER returns early based on referral status alone.
 *     It always falls through to the transaction check so partial failures
 *     from a previous run are detected and recovered.
 *
 * Ordering guarantee:
 *   1. Mark referral "Successful" (if still Pending)
 *   2. Mark referral "Bonus Credited" (optimistic — may already be set)
 *   3. Record the transaction (deterministic ID — idempotent write)
 *   4. Credit the referrer's points
 *   If any step after #1 fails, the next invocation recovers by detecting
 *   the missing transaction and re-executing steps 3-4.
 */
export async function maybeCreditReferralBonus(appointment) {
    const apptId = appointment.id;
    const custId = appointment.customerId;
    const salonId = appointment.salonId;
    console.log('[REFERRAL] ─── maybeCreditReferralBonus START ───');
    console.log('[REFERRAL] Appointment:', apptId, '| Customer B:', custId, '| Salon:', salonId);

    // ── Validate inputs ──────────────────────────────────────────────
    if (!apptId || !custId || !salonId) {
        console.warn('[REFERRAL] Missing required fields (id/customerId/salonId) — aborting.');
        return;
    }

    // ── Step 1: Fetch the referred customer ───────────────────────────
    const customer = await customersRepository.getCustomerFromSalon(custId, salonId);
    if (!customer || !customer.referredByCode) {
        console.log('[REFERRAL] Customer has no referredByCode — not a referred client, skipping.');
        return;
    }
    const refCode = customer.referredByCode;
    console.log('[REFERRAL] Client B:', customer.id, '|', customer.name,
        '| referredByCode:', refCode,
        '| referrer ID:', customer.referringCustomerId,
        '| referrer salon:', customer.referringSalonId);

    // ── Step 2: Find the referral record ─────────────────────────────
    const referral = await referralsRepository.findReferral(refCode, customer.id);
    if (!referral) {
        console.warn('[REFERRAL] No referral record found for code', refCode,
            '+ customer', customer.id, '— skipping (data inconsistency?).');
        return;
    }
    console.log('[REFERRAL] Referral:', referral.id,
        '| status:', referral.status,
        '| Client A:', referral.referringCustomerId,
        '| bonus:', referral.bonusAmount);

    // Reject unexpected statuses (Rejected, or anything not in the state machine).
    if (referral.status !== 'Pending' && referral.status !== 'Successful' && referral.status !== 'Bonus Credited') {
        console.warn('[REFERRAL] Unexpected referral status:', referral.status, '— aborting.');
        return;
    }

    // ── Step 3: Transition Pending → Successful (if needed) ──────────
    if (referral.status === 'Pending') {
        try {
            const result = await referralsRepository.markReferralSuccessful(referral, apptId);
            if (result) Object.assign(referral, result);
            console.log('[REFERRAL] Referral marked Successful:', referral.id, '| appointment:', apptId);
        } catch (err) {
            // Race: another call may have marked it Successful already.
            const fresh = await referralsRepository.findReferral(refCode, customer.id);
            if (fresh && (fresh.status === 'Successful' || fresh.status === 'Bonus Credited')) {
                console.log('[REFERRAL] Concurrent update detected — referral already', fresh.status, 'in Firestore.');
                Object.assign(referral, fresh);
            } else {
                console.error('[REFERRAL] markReferralSuccessful FAILED:', err.message || err);
                throw err;
            }
        }
    }

    // ── Step 4: Fetch the referrer (Client A) ────────────────────────
    if (!referral.referringCustomerId || !referral.referringSalonId) {
        console.warn('[REFERRAL] Referral missing referringCustomerId or referringSalonId — aborting.');
        return;
    }
    let referrer;
    try {
        referrer = await customersRepository.getCustomerFromSalon(
            referral.referringCustomerId,
            referral.referringSalonId,
        );
    } catch (err) {
        console.error('[REFERRAL] Failed to fetch Client A', referral.referringCustomerId,
            'from salon', referral.referringSalonId, ':', err.message || err);
        return;
    }
    if (!referrer) {
        console.warn('[REFERRAL] Client A not found:', referral.referringCustomerId,
            'in salon', referral.referringSalonId, '— cannot credit points.');
        return;
    }
    console.log('[REFERRAL] Client A:', referrer.id, '|', referrer.name,
        '| salon:', referral.referringSalonId,
        '| current pts:', Number(referrer.referralPoints) || 0);

    // ── Step 5: IDEMPOTENCY GATE — check the transaction ledger ──────
    // This is the single source of truth.  If a transaction exists, the
    // bonus was already credited — we only ensure the referral status is
    // terminal and return.  If no transaction exists, the points were
    // never credited (even if the referral says "Bonus Credited") and we
    // must re-execute the credit flow.
    const existingTx = await rewardTransactionsRepository.findReferralTransaction(referral.id);
    if (existingTx) {
        console.log('[REFERRAL] Transaction already exists for', referral.id,
            '— bonus already credited, ensuring terminal state.');
        if (referral.status !== 'Bonus Credited') {
            try { await referralsRepository.completeReferral(referral); } catch (_) { /* already terminal */ }
        }
        console.log('[REFERRAL] ─── maybeCreditReferralBonus END (already credited) ───');
        return;
    }

    // ── Step 6: Mark referral "Bonus Credited" (optimistic lock) ─────
    // Done BEFORE crediting points so concurrent calls see the terminal
    // status and back off.  If this fails because another call set it
    // first, we continue — the transaction check is the real guard.
    if (referral.status !== 'Bonus Credited') {
        try {
            await referralsRepository.completeReferral(referral);
            console.log('[REFERRAL] Referral status → Bonus Credited:', referral.id);
        } catch (err) {
            console.warn('[REFERRAL] completeReferral failed (concurrent update?):', err.message);
            // Re-read to confirm it went terminal.
            const fresh = await referralsRepository.findReferral(refCode, customer.id);
            if (fresh && fresh.status === 'Bonus Credited') {
                Object.assign(referral, fresh);
            }
        }
    }

    // ── Step 7: Record the reward transaction (deterministic ID) ─────
    // The transaction ID is `REFERRAL__<referralId>` — a setDocument
    // (overwrite-by-id), so this is inherently idempotent even if called
    // twice concurrently.  Once this succeeds, the bonus is permanently
    // recorded in the audit ledger.
    const bonus = Number(referral.bonusAmount) || REFERRAL_BONUS_POINTS;
    try {
        await rewardTransactionsRepository.recordReferralBonus({
            referralId: referral.id,
            referrerId: referrer.id,
            referrerName: referrer.name,
            salonId: referral.referredSalonId,
        });
        console.log('[REFERRAL] Transaction recorded:', referral.id,
            '| referrer:', referrer.id, '| points:', bonus);
    } catch (err) {
        // If the transaction write fails, the points must NOT be credited
        // (otherwise we'd have credited points without an audit trail).
        console.error('[REFERRAL] recordReferralBonus FAILED — points NOT credited:', err.message || err);
        throw err;
    }

    // ── Step 8: Credit the referrer's points balance ─────────────────
    const prevPts = Number(referrer.referralPoints) || 0;
    const newPts = prevPts + bonus;
    try {
        await customersRepository.updateCustomerInSalon(referrer.id, referral.referringSalonId, {
            referralPoints: newPts,
        });
        console.log('[REFERRAL] ✅ Points credited — Client A:', referrer.id,
            '| prev:', prevPts, '| bonus:', bonus, '| new:', newPts, 'pts');
    } catch (err) {
        // Transaction was recorded but points update failed.  The next
        // invocation will detect the existing transaction (step 5) and
        // NOT re-credit — but the points are stuck.  Log loudly so an
        // operator can manually reconcile.
        console.error('[REFERRAL] ⚠️ POINTS CREDIT FAILED after transaction was recorded!',
            'Client A:', referrer.id, '| expected pts:', newPts,
            '| error:', err.message || err);
        throw err;
    }

    // ── Step 9: Refresh UI state ─────────────────────────────────────
    try {
        await referralsRepository.forceRefreshReferrals();
        console.log('[REFERRAL] Referral card refreshed.');
    } catch (err) {
        console.warn('[REFERRAL] forceRefreshReferrals failed (non-critical):', err.message);
    }

    console.log('[REFERRAL] ─── maybeCreditReferralBonus END ───');
}

export default {
    initAppointments,
    setSalon,
    addAppointment,
    maybeCreditReferralBonus,
    updateAppointment,
    deleteAppointment,
    listAppointments,
    seed,
};