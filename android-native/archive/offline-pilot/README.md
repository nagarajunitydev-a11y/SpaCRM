# GlowOS native Android pilot

> **Historical offline pilot — superseded requirements.** The new target is online-only and must reproduce the existing SPACRM UI. Implementation is stopped until [the revised plan](../ANDROID-ONLINE-MIGRATION-PLAN.md) is reviewed and approved. This README and existing APK describe the earlier pilot, not an approved implementation of the revised requirements. No offline code/data/dependencies are removed during planning.

This is the first implementation slice of the approved [migration plan](../ANDROID-MIGRATION-ASSESSMENT.md). It is an independently installable Kotlin/Compose app using Room and WorkManager. It is **not yet a replacement release for the existing Android wrapper**. The application ID is `com.luxeglow.crm.nativepilot`; the production wrapper remains `com.luxeglow.crm`.

## Available now

- Explicit offline demo that never connects to the backend.
- Native email/password sign-in when configured for an isolated staging Firebase project.
- Owner branch discovery and a consistent downloaded snapshot, including legacy web changes/deletions.
- Local customer, service, staff and attendance creation/editing; an entity and its outbox command commit together before local success.
- Room-backed data surviving process termination/reopen; encrypted business payloads, outbox intents, server copies, grants and bill drafts using account-specific Android Keystore AES-GCM keys.
- Background sync with connectivity constraints, exponential retry, immutable command identities, recoverable response loss, account isolation and per-record pending/synced/failed states.
- Server-checked ownership, current subscription/branch access, plan limits, normalized customer phone uniqueness, attendance identity and content-revision conflicts, including concurrent legacy edits without a version field.
- Review saved changes and conflicts; retry unknown outcomes with the same identity; explicitly restore server state for terminal rejection/conflict while retaining local intent in encrypted audit history.
- Read-only downloaded appointments/referrals/customer balances and subscription state. A local billing draft uses integer minor-unit arithmetic and survives reopening.

## Deliberate pilot boundaries

No deployment, production backfill, database migration or production purchase was performed. New APIs default to disabled and require an explicit owner allowlist. Financial/appointment mutation endpoints are not implemented in this slice. Use the existing app for full workflows.

Remaining parity work includes Google sign-in/reset/signup/onboarding, common authoritative appointment reservation, public booking adaptation, invoice issue and payment/referral/loyalty transactions, native Play Billing and subscription management, administration, full reports, advanced booking settings/QR flows and all remaining parity details from the assessment. Inventory/expenses and other advertised-but-unimplemented modules remain discovery scope.

The pilot uses full consistent bounded snapshots instead of the proposed incremental cursor/feed. This includes changes made by the existing direct-write web app without incorrectly claiming that it participates in a change feed. Limit: **2,000 documents per collection**, with a visible failure rather than truncation. Large branch snapshots/pagination and feed retention/resnapshot need implementation before production scale. Customer/staff quota checks read the relevant collection transactionally; upgrading all writers is still needed for global limit enforcement against legacy clients.

Only one unresolved command per record is allowed for now; unrelated records and branches can continue. This prevents later edits from silently replacing an unsent command. Conflicts require review and a deliberate new edit after restoring the server state. There is no automatic financial merge.

Encryption covers business payloads, not SQLite IDs, state or indexes. Backup/device transfer are excluded. Do not uninstall/clear app data with unsynced work: remote recovery/export and key-loss recovery are not implemented. The 72-hour offline access cache is bounded by the server entitlement deadline and anchored to server time plus elapsed time; clock/reboot inconsistencies require a refresh. It is a locally protected cached server grant, not the later proposed externally verifiable signed-grant protocol.

WorkManager can be delayed by Android restrictions/force-stop. Pending data stays in Room and sync resumes when execution is permitted or the app is reopened. Auth/API permission failures pause commands without deleting them. Retrying a terminal conflict as a new request requires explicit user review; a Retry action never changes an existing command's ID.

## Build and try the offline demo

Use Android Studio with a JDK supported by AGP 9.3.1, Android SDK 36, and the checked-in Gradle wrapper. No Firebase configuration is required for the demo.

```powershell
cd android-native
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
.\gradlew.bat :app:assembleDebug
```

APK: `app/build/outputs/apk/debug/app-debug.apk`. Install alongside the existing app and select **Open offline demo**. Demo records remain Pending Sync because they are deliberately never sent to a server.

For a staging build, put public Firebase Android app configuration for the pilot package and the staging API URL in user-local Gradle properties (not service account credentials):

```properties
nativeApiUrl=https://YOUR-STAGING-HOST
firebaseApiKey=YOUR-STAGING-PUBLIC-API-KEY
firebaseAppId=YOUR-STAGING-ANDROID-APP-ID
firebaseProjectId=YOUR-STAGING-PROJECT-ID
```

Register the pilot package in the staging Firebase project and configure email/password authentication. An existing owner profile, branch and active subscription/trial must already exist in the staging dataset. This pilot does not create them or activate a trial silently. The existing repository does not include a staging deployment's credentials or URL.

Server-only staging configuration:

```dotenv
NATIVE_SYNC_ENABLED=true
NATIVE_SYNC_OWNER_IDS=comma-separated-staging-owner-uids
FIREBASE_SERVICE_ACCOUNT=staging-service-account-json-or-base64
```

Keep these endpoints disabled in production until pilot release gates are met. The API denies an empty/wildcard cohort, checks revoked Firebase tokens, and rechecks ownership before serving a receipt. Existing rules deny client access to the new `nativeSyncAccounts/{uid}/receipts` namespace by default; no rules relaxation is needed.

## Protocol v1

- `GET /api/sync/branches` returns the authenticated owner's branches.
- `GET /api/sync/snapshot?salonId=...` returns a single consistent bounded snapshot and cached-access metadata.
- `POST /api/sync/push` accepts one validated command. Collections supported: customers/services/staff/attendance; no arbitrary document paths or financial fields.
- `GET /api/sync/receipt?salonId=...&commandId=...` recovers an outcome without creating another command.

```json
{
  "protocolVersion": 1,
  "commandId": "stable-offline-uuid",
  "salonId": "existing-branch-id",
  "entityId": "stable-record-uuid",
  "collection": "customers",
  "baseRevision": null,
  "payload": { "name": "Client", "phone": "+919876543210", "email": "" }
}
```

`baseRevision: null` means create-only; edits require the revision from the last canonical snapshot/receipt. The server atomically commits the effect and receipt. Same key/payload returns the original result; key reuse with different content is rejected. A different command ID cannot bypass phone or entity uniqueness. Accepted/rejected/conflict outcomes are durable. Legacy unknown fields/timestamp types are preserved through merge writes, not rewritten from the transport representation.

## Verification

From the repository root:

```powershell
npm run test:native-sync
npm run test:native-sync:emulator
```

The emulator integration command is restricted to a disposable local `demo-spacrm-audit` project and refuses a non-local Firestore endpoint. It tests actual concurrent transactions, duplicate delivery, unique phone arbitration, conflicting edits and preservation of timestamp types.

From `android-native`:

```powershell
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest :app:connectedDebugAndroidTest :app:lintDebug
```

Connected tests require a booted dedicated Android emulator. They verify transaction rollback, database reopen/outbox durability, payload encryption/account/purpose/tamper checks and identity-preserving retry/atomic acceptance. Room v1 schema is exported under `app/schemas/`; future versions require non-destructive migrations and migration fixtures.

After installing the debug APK on a dedicated emulator, from repository root:

```powershell
node scripts/e2e-native-offline.mjs
```

The smoke script refuses physical-device serials, temporarily disables emulator connectivity, adds a unique demo customer, force-stops/reopens the app and verifies the name and Pending Sync persist. Connectivity settings are restored in `finally`; app data is never cleared.
