/**
 * Cloud Functions for LuxeGlow Salon CRM
 *
 * onAppointmentStatusChange — Server-side referral reward trigger.
 *
 * When a salon appointment document is updated to status "Completed",
 * this function checks if the customer was referred by another client.
 * If so, it atomically:
 *   1. Creates a referralRewards/{appointmentId} record (idempotency gate)
 *   2. Increments the referrer's rewardPoints by 100
 *
 * Uses Firestore Admin SDK (bypasses security rules) inside a transaction
 * so either both writes succeed or neither does — no partial credits.
 */

const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const REFERRAL_BONUS_POINTS = 100;
const COMPLETED_STATUS = "Completed";

/**
 * Triggered when any appointment document under salons/{salonId}/appointments/{appointmentId}
 * is updated. Only processes when status changes to "Completed".
 */
exports.onAppointmentStatusChange = onDocumentUpdated(
  "salons/{salonId}/appointments/{appointmentId}",
  async (event) => {
    const { salonId, appointmentId } = event.params;
    const before = event.data?.data?.before?.data?.();
    const after = event.data?.data?.after?.data?.();

    // ── Gate 1: Only process status transitions TO "Completed" ──────
    if (!after || !before) {
      console.log(`[REWARD] No data in event for ${appointmentId} — skipping.`);
      return;
    }

    const prevStatus = before.status;
    const newStatus = after.status;

    if (prevStatus === COMPLETED_STATUS && newStatus === COMPLETED_STATUS) {
      console.log(`[REWARD] Appointment ${appointmentId} was already Completed — skipping (no change).`);
      return;
    }

    if (newStatus !== COMPLETED_STATUS) {
      console.log(`[REWARD] Appointment ${appointmentId} status is "${newStatus}" (not Completed) — skipping.`);
      return;
    }

    console.log(`[REWARD] ─── Processing referral reward for appointment ${appointmentId} in salon ${salonId} ───`);

    // ── Gate 2: Appointment must have a linked customer ────────────
    const customerId = after.customerId;
    if (!customerId) {
      console.log(`[REWARD] Appointment ${appointmentId} has no customerId — skipping.`);
      return;
    }

    // ── Step 1: Fetch the referred customer (Client B) ─────────────
    const customerRef = db.collection("salons").doc(salonId).collection("customers").doc(customerId);
    const customerSnap = await customerRef.get();

    if (!customerSnap.exists) {
      console.warn(`[REWARD] Customer ${customerId} not found in salon ${salonId} — skipping.`);
      return;
    }

    const customer = customerSnap.data();

    // ── Gate 3: Customer must have a canonical referredBy field ─────
    const referrerId = customer.referredBy;
    if (!referrerId) {
      console.log(`[REWARD] Customer ${customerId} (${customer.name}) has no referredBy — not a referred client. Skipping.`);
      return;
    }

    console.log(`[REWARD] Client B: ${customerId} (${customer.name}) | referredBy: ${referrerId}`);

    // ── Step 2: Fetch the referrer (Client A) ──────────────────────
    // The referrer could be in the same salon or a different one.
    // First, look in the same salon.
    let referrerSalonId = salonId;
    let referrerSnap = await db
      .collection("salons")
      .doc(referrerSalonId)
      .collection("customers")
      .doc(referrerId)
      .get();

    // If not found in the same salon, search all salons (owner might be super admin).
    if (!referrerSnap.exists) {
      console.log(`[REWARD] Referrer ${referrerId} not found in salon ${salonId} — searching other salons...`);
      const salonsSnap = await db.collection("salons").get();
      for (const salonDoc of salonsSnap.docs) {
        if (salonDoc.id === salonId) continue;
        const candidate = await db
          .collection("salons")
          .doc(salonDoc.id)
          .collection("customers")
          .doc(referrerId)
          .get();
        if (candidate.exists) {
          referrerSnap = candidate;
          referrerSalonId = salonDoc.id;
          console.log(`[REWARD] Found referrer ${referrerId} in salon ${referrerSalonId}`);
          break;
        }
      }
    }

    if (!referrerSnap.exists) {
      console.warn(`[REWARD] Referrer ${referrerId} not found in any salon — cannot credit points.`);
      return;
    }

    const referrer = referrerSnap.data();
    console.log(`[REWARD] Client A: ${referrerId} (${referrer.name}) | salon: ${referrerSalonId}`);

    // ── Step 3: IDEMPOTENCY — check referralRewards/{appointmentId} ─
    const rewardRef = db.collection("referralRewards").doc(appointmentId);
    const existingReward = await rewardRef.get();

    if (existingReward.exists) {
      console.log(`[REWARD] Reward already exists for appointment ${appointmentId} — already credited. Skipping.`);
      return;
    }

    // ── Step 4: Atomic transaction — create reward + credit points ─
    try {
      await db.runTransaction(async (tx) => {
        // Re-check inside transaction (double-check after lock acquired)
        const rewardSnap = await tx.get(rewardRef);
        if (rewardSnap.exists) {
          console.log(`[REWARD] Reward for ${appointmentId} created concurrently — aborting.`);
          return;
        }

        const now = admin.firestore.FieldValue.serverTimestamp();

        // 4a: Create the auditable reward record
        tx.set(rewardRef, {
          appointmentId,
          salonId,
          referrerClientId: referrerId,
          referrerClientName: referrer.name || "",
          referrerSalonId,
          referredClientId: customerId,
          referredClientName: customer.name || "",
          points: REFERRAL_BONUS_POINTS,
          type: "referral_bonus",
          status: "credited",
          createdAt: now,
        });

        // 4b: Increment the referrer's rewardPoints
        const referrerRef = db
          .collection("salons")
          .doc(referrerSalonId)
          .collection("customers")
          .doc(referrerId);

        tx.set(
          referrerRef,
          {
            rewardPoints: admin.firestore.FieldValue.increment(REFERRAL_BONUS_POINTS),
            updatedAt: now,
          },
          { merge: true }
        );

        console.log(
          `[REWARD] Transaction committed — ${REFERRAL_BONUS_POINTS} pts credited to ${referrerId} (${referrer.name}) for appointment ${appointmentId}`
        );
      });
    } catch (err) {
      console.error(`[REWARD] Transaction FAILED for appointment ${appointmentId}:`, err);
      throw err;
    }

    // ── Step 5: Write audit log to rewardTransactions ──────────────
    // Append-only audit ledger (deterministic ID for idempotency)
    try {
      const txId = `REFERRAL__${salonId}__${appointmentId}`;
      const txRef = db.collection("rewardTransactions").doc(txId);
      const txSnap = await txRef.get();

      if (!txSnap.exists) {
        await txRef.set({
          id: txId,
          clientId: referrerId,
          clientName: referrer.name || "",
          salonId: referrerSalonId,
          points: REFERRAL_BONUS_POINTS,
          type: "REFERRAL_BONUS",
          description: `Referral bonus: ${customer.name || customerId} completed appointment ${appointmentId}`,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`[REWARD] Audit transaction recorded: ${txId}`);
      }
    } catch (err) {
      // Non-critical — points were already credited. Log for manual reconciliation.
      console.error(`[REWARD] WARNING: Audit transaction write failed for ${appointmentId} — points were credited but audit trail incomplete.`, err);
    }

    console.log(`[REWARD] ─── Referral reward flow COMPLETE for appointment ${appointmentId} ───`);
  }
);
