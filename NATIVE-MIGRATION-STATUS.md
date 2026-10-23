# Native migration implementation status

> **Revised direction — implementation stopped pending approval.** The latest request requires online-only operation, existing-UI parity, and no Room/SQLite business storage, outbox, offline grants or WorkManager business synchronization. Review [ANDROID-ONLINE-MIGRATION-PLAN.md](ANDROID-ONLINE-MIGRATION-PLAN.md). The previously built APK implements the old offline pilot and is not the revised target. No implementation cleanup or revised native code changes have been made in this planning pass. The remainder below records historical pilot work, not authorization to continue it.

Updated 22 October 2026. The user approved proceeding with the assessment plan. Implementation is underway; the full migration is **not complete or production-ready**.

## Implemented first slice

The independent `android-native/` project provides a real native Compose application, encrypted Room payload storage, transactionally coupled local records/outbox, durable draft storage and WorkManager synchronisation. It can be built and tried in offline demo mode without configuring a backend. Configured staging owners can download branches and sync customer/service/staff/attendance changes through new gated server APIs.

The backend adds durable idempotency receipts, content-based optimistic concurrency compatible with legacy web writes, tenant/current-access validation, customer uniqueness/plan limits and canonical attendance identity. It does not alter existing payment endpoints, web workflows or Firestore rules. Legacy timestamp types/unknown fields are preserved on updates.

The original `twa/` application is retained. The pilot uses a distinct app ID and no production signing configuration. No production release, deployment, live data migration or provider charge has been performed.

## Verification evidence

- All existing JavaScript unit suites pass; native-sync unit coverage adds 17 scenarios, including the default-closed HTTP gate.
- Five Firestore emulator scenarios pass with real concurrent transactions, including duplicate delivery and competing updates.
- Android debug APK builds; three JVM money tests and four connected Room/encryption/retry tests pass on the API 37 emulator.
- Android lint runs with zero errors. Remaining warnings concern pinned dependency versions/target SDK and minor suggestions; they are not suppressed to force a pass.
- The offline device smoke script passed: with emulator connectivity disabled, a new demo customer and Pending Sync state survived force-stop/reopen. It restored the emulator connectivity settings afterward.

See `android-native/README.md` for exact build/staging setup, protocol and pilot limitations. APK location is `android-native/app/build/outputs/apk/debug/app-debug.apk`.

## Remaining work in the approved plan

1. Complete phase-0 production/staging verification and business decisions for accounting/numbering, offline duration, staff accounts and missing advertised modules.
2. Add the canonical cross-client change feed, resumable snapshots, tombstones and large-dataset pagination; upgrade affected web writers before enabling new financial/scheduling invariants.
3. Implement shared server-authoritative booking/rescheduling/cancellation and migrate public booking acceptance to the same invariant.
4. Implement atomic bill issue, payment evidence/provider verification, wallet/referral/loyalty posting/reversal and reconciliation commands with golden parity fixtures.
5. Complete native feature parity: authentication/onboarding, complete appointment and Quick Billing UIs, billing/referrals/loyalty, branch/settings/QR, reports, admin and direct Play Billing/subscription management.
6. Extend conflict resolution and sequential edits for the same offline record; implement signed grants, protected recovery/export, full migration/OS-version tests and observability.
7. Run isolated end-to-end authenticated staging/provider tests, then pilot/reconciliation/rollback gates before a production release.

These items retain the original authorization to proceed. They are recorded as incomplete work, not silently excluded from the migration scope. The pilot's current local billing draft is additional infrastructure, not a replacement for the existing full Quick Billing flow.
