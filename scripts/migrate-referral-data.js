#!/usr/bin/env node
/**
 * migrate-referral-data.js
 *
 * One-time data migration script for the referral reward system rebuild.
 *
 * This script migrates the existing referral data to the new canonical schema:
 *   1. Maps `referralPoints` → `rewardPoints` on customer documents
 *   2. Sets `referredBy` field from `referringCustomerId` (or looks up from referralCodes)
 *   3. Creates `referralRewards/{appointmentId}` records for already-credited referrals
 *
 * Usage:
 *   node scripts/migrate-referral-data.js --dry-run   (preview changes)
 *   node scripts/migrate-referral-data.js              (apply changes)
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS or Firebase Admin SDK credentials.
 * Project: crmapp-1299dddb
 */

const admin = require('firebase-admin');

// ── Configuration ──────────────────────────────────────────────────
const PROJECT_ID = 'crmapp-1299dddb';
const DRY_RUN = process.argv.includes('--dry-run');

// ── Initialize Firebase Admin ──────────────────────────────────────
function initAdmin() {
    try {
        // Try GOOGLE_APPLICATION_CREDENTIALS first
        admin.initializeApp({ projectId: PROJECT_ID });
        console.log('[MIGRATE] Firebase Admin initialized with default credentials.');
        return admin.firestore();
    } catch (err) {
        console.error('[MIGRATE] Failed to initialize Firebase Admin SDK.');
        console.error('[MIGRATE] Set GOOGLE_APPLICATION_CREDENTIALS environment variable');
        console.error('[MIGRATE] or run: gcloud auth application-default login');
        process.exit(1);
    }
}

// ── Migration: referralPoints → rewardPoints ───────────────────────
async function migrateRewardPoints(db) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('STEP 1: Migrate referralPoints → rewardPoints');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const salonsSnap = await db.collection('salons').get();
    let totalCustomers = 0;
    let migrated = 0;
    let skipped = 0;
    let errors = 0;

    for (const salonDoc of salonsSnap.docs) {
        const salonId = salonDoc.id;
        const customersSnap = await db
            .collection('salons').doc(salonId)
            .collection('customers').get();

        for (const custDoc of customersSnap.docs) {
            totalCustomers++;
            const data = custDoc.data();
            const custId = custDoc.id;

            // Already has rewardPoints? Skip.
            if (data.rewardPoints !== undefined && data.rewardPoints !== null) {
                skipped++;
                continue;
            }

            // Migrate referralPoints → rewardPoints
            const points = Number(data.referralPoints) || 0;
            console.log(`  [${salonId}/${custId}] ${data.name}: referralPoints=${points} → rewardPoints=${points}`);

            if (!DRY_RUN) {
                try {
                    await custDoc.ref.update({
                        rewardPoints: points,
                    });
                    migrated++;
                } catch (err) {
                    console.error(`  ❌ FAILED: ${custId} — ${err.message}`);
                    errors++;
                }
            } else {
                migrated++;
            }
        }
    }

    console.log(`\n  Summary: ${totalCustomers} customers, ${migrated} migrated, ${skipped} skipped, ${errors} errors`);
    return { totalCustomers, migrated, skipped, errors };
}

// ── Migration: Set referredBy field ────────────────────────────────
async function migrateReferredBy(db) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('STEP 2: Set referredBy field from referringCustomerId');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const salonsSnap = await db.collection('salons').get();
    let totalReferred = 0;
    let migrated = 0;
    let skipped = 0;
    let errors = 0;

    for (const salonDoc of salonsSnap.docs) {
        const salonId = salonDoc.id;
        const customersSnap = await db
            .collection('salons').doc(salonId)
            .collection('customers').get();

        for (const custDoc of customersSnap.docs) {
            const data = custDoc.data();
            const custId = custDoc.id;

            // Skip if not a referred customer
            if (!data.referredByCode) {
                skipped++;
                continue;
            }

            totalReferred++;

            // Already has canonical referredBy? Skip.
            if (data.referredBy) {
                console.log(`  [${salonId}/${custId}] ${data.name}: already has referredBy=${data.referredBy}`);
                skipped++;
                continue;
            }

            // If referringCustomerId exists, use it directly
            if (data.referringCustomerId) {
                console.log(`  [${salonId}/${custId}] ${data.name}: referredBy=${data.referringCustomerId} (from referringCustomerId)`);

                if (!DRY_RUN) {
                    try {
                        await custDoc.ref.update({
                            referredBy: data.referringCustomerId,
                        });
                        migrated++;
                    } catch (err) {
                        console.error(`  ❌ FAILED: ${custId} — ${err.message}`);
                        errors++;
                    }
                } else {
                    migrated++;
                }
                continue;
            }

            // Look up from referralCodes collection
            console.log(`  [${salonId}/${custId}] ${data.name}: looking up referrer from code "${data.referredByCode}"...`);
            try {
                const codeSnap = await db.collection('referralCodes').doc(data.referredByCode).get();
                if (codeSnap.exists) {
                    const codeData = codeSnap.data();
                    if (codeData.customerId) {
                        console.log(`  → Found referrer: ${codeData.customerId} (${codeData.customerName || 'unknown'})`);

                        if (!DRY_RUN) {
                            await custDoc.ref.update({
                                referredBy: codeData.customerId,
                                referringSalonId: codeData.salonId,
                                referringCustomerName: codeData.customerName || '',
                            });
                        }
                        migrated++;
                    } else {
                        console.log(`  → Code is salon-level (no customerId) — cannot set referredBy`);
                        skipped++;
                    }
                } else {
                    console.log(`  → Code "${data.referredByCode}" not found in registry`);
                    errors++;
                }
            } catch (err) {
                console.error(`  ❌ FAILED: ${custId} — ${err.message}`);
                errors++;
            }
        }
    }

    console.log(`\n  Summary: ${totalReferred} referred customers, ${migrated} migrated, ${skipped} skipped, ${errors} errors`);
    return { totalReferred, migrated, skipped, errors };
}

// ── Migration: Create referralRewards records ──────────────────────
async function migrateReferralRewards(db) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('STEP 3: Create referralRewards for already-credited referrals');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Find all rewardTransactions with REFERRAL_BONUS type
    const txSnap = await db
        .collection('rewardTransactions')
        .where('type', '==', 'REFERRAL_BONUS')
        .get();

    let total = 0;
    let created = 0;
    let skipped = 0;
    let errors = 0;

    for (const txDoc of txSnap.docs) {
        total++;
        const tx = txDoc.data();
        const txId = txDoc.id;

        // Extract appointmentId from txId: REFERRAL__<referralId>
        // We need to find the referral to get the appointmentId
        const referralId = tx.referralId;
        if (!referralId) {
            console.log(`  [${txId}] No referralId — skipping`);
            skipped++;
            continue;
        }

        // Look up the referral record
        try {
            const referralSnap = await db.collection('referrals').doc(referralId).get();
            if (!referralSnap.exists) {
                console.log(`  [${txId}] Referral ${referralId} not found — skipping`);
                skipped++;
                continue;
            }

            const referral = referralSnap.data();
            const appointmentId = referral.appointmentId;

            if (!appointmentId) {
                console.log(`  [${txId}] Referral ${referralId} has no appointmentId — skipping`);
                skipped++;
                continue;
            }

            // Check if referralRewards already exists
            const rewardSnap = await db.collection('referralRewards').doc(appointmentId).get();
            if (rewardSnap.exists) {
                console.log(`  [${txId}] referralRewards/${appointmentId} already exists — skipping`);
                skipped++;
                continue;
            }

            console.log(`  [${txId}] Creating referralRewards/${appointmentId}`);
            console.log(`    Referrer: ${referral.referringCustomerId} @ ${referral.referringSalonId}`);
            console.log(`    Referred: ${referral.referredCustomerId} @ ${referral.referredSalonId}`);

            if (!DRY_RUN) {
                await db.collection('referralRewards').doc(appointmentId).set({
                    appointmentId,
                    salonId: referral.referredSalonId,
                    referrerClientId: referral.referringCustomerId,
                    referrerClientName: referral.referringCustomerName || '',
                    referrerSalonId: referral.referringSalonId,
                    referredClientId: referral.referredCustomerId,
                    referredClientName: referral.referredCustomerName || '',
                    points: Number(referral.bonusAmount) || 100,
                    type: 'referral_bonus',
                    status: 'credited',
                    createdAt: referral.bonusCreditedAt || tx.createdAt || new Date().toISOString(),
                    migratedFrom: txId,
                });
            }
            created++;
        } catch (err) {
            console.error(`  ❌ FAILED: ${txId} — ${err.message}`);
            errors++;
        }
    }

    console.log(`\n  Summary: ${total} referral transactions, ${created} rewards created, ${skipped} skipped, ${errors} errors`);
    return { total, created, skipped, errors };
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║   LuxeGlow CRM — Referral Data Migration                     ║');
    console.log(`║   Mode: ${DRY_RUN ? 'DRY RUN (no changes will be written)' : 'LIVE (changes will be applied)'}          ║`);
    console.log(`║   Project: ${PROJECT_ID}                              ║`);
    console.log('╚═══════════════════════════════════════════════════════════════╝');

    if (!DRY_RUN) {
        console.log('\n⚠️  LIVE MODE: Changes will be written to Firestore.');
        console.log('   Press Ctrl+C within 5 seconds to abort...\n');
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const db = initAdmin();

    const results = {
        rewardPoints: await migrateRewardPoints(db),
        referredBy: await migrateReferredBy(db),
        referralRewards: await migrateReferralRewards(db),
    };

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('MIGRATION COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(JSON.stringify(results, null, 2));
    console.log(`\nMode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

    process.exit(0);
}

main().catch((err) => {
    console.error('[MIGRATE] Fatal error:', err);
    process.exit(1);
});
