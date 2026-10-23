# SPACRM: Android migration assessment and implementation plan

> **Superseded on 22 October 2026.** The user replaced the offline-first direction with online-only native Android and preservation of the existing UI. The authoritative proposal is now [ANDROID-ONLINE-MIGRATION-PLAN.md](ANDROID-ONLINE-MIGRATION-PLAN.md), pending review and approval. This document remains historical evidence; its offline requirements and earlier implementation authorization no longer apply.

Assessment date: 22 October 2026, Asia/Kolkata. Repository baseline: `889abe6`.

Status: analysis and proposal only. No migration is approved or started. This report is the only project file added for this assessment; source, dependencies, configuration, database contents and existing functionality are unchanged.

## 1. Decision and assessment boundaries

**Recommend Option A: a Kotlin Android application with Jetpack Compose, Room and WorkManager, keeping Firebase and the existing web application.** Introduce a server-authoritative command/synchronisation API shared by the new Android app and affected web workflows. Do not rebuild Firebase, replace Razorpay, discard the web app, or remove existing modules.

The reason is specific to this repository: the UI is vanilla JavaScript rendering HTML strings, not React. Both Kotlin and React Native require a new mobile UI. React Native could reuse selected pure JavaScript rules, but cannot directly reuse DOM rendering, event delegation, browser Firebase imports or the current store/repository infrastructure. Android is the stated target, and durable local transactions, lifecycle recovery and platform billing are central requirements. Kotlin offers a direct implementation of those requirements. This is an engineering judgement, not a measured performance comparison or a claim that React Native cannot meet them.

The wrapper remains the current product during migration. Preserve it as a release fallback until native feature parity and data recovery have been demonstrated. Keep public booking and web administration available throughout.

### Evidence classification

- **Confirmed** means present in the checked-out source/configuration, or observed in the local checks below. Source takes precedence over older README claims.
- **Proposed** means target design, including new server APIs, tables and operational policies. None exists merely because it appears in this report.
- **Unverified** means deployment state, live data, provider configuration, business policy or device behaviour that this assessment did not establish.

Reviewed the application entry points, core/service/view modules, public booking application, all API route families and backend helpers, Java wrapper and Gradle/manifest configuration, Firestore rules/indexes, environment template, deployment configuration, test scripts and project documentation. Generated dependencies/build output and image binaries are not application logic and were not audited line by line. This is an architectural/source assessment, not a penetration test or production data audit. No live database reads/writes, payment requests, deployments, package installation, emulator data operations or Android builds were performed.

## 2. Confirmed current architecture

| Area | Finding and repository evidence |
|---|---|
| Frontend | Vanilla JavaScript ES modules, HTML/CSS, template strings and DOM event delegation. `public/index.html`, `public/js/main.js`, `public/js/ui/views/*`, `core/store.js`, `core/router.js`. No React, React Native, Vue, TypeScript or frontend bundler is configured. |
| Rendering/state | Observable in-memory store; views rerender from state. `main.js` contains authentication orchestration, tenant changes, forms, booking, Quick Billing, payment and refund handlers. `core/draft.js` keeps form drafts in memory; router actions clear drafts. |
| Build | `package.json` version 2.2.0; ES module package. Tailwind CSS 3.4.19 declaration, compiled by `build:css`; browser JavaScript is served as modules. Python static server for local preview. The package description's “no runtime dependencies” wording is stale: Firebase and Firebase Admin are declared dependencies. |
| Firebase client | Browser modules imported from `www.gstatic.com/firebasejs/12.18.0`; `services/firebase.js` initializes Auth and Firestore. Persistent single-tab local cache is requested, with a fallback when initialization fails. Auth uses browser local persistence. |
| Configuration | Production web Firebase configuration is injected in `index.html`; local opt-in wiring is in `firebase-config.dev.js`/`config.js`. Public project/app identifiers are configuration, not server credentials. No secret values are reproduced here. |
| Authentication | Email signup/signin, password reset, Google redirect flow, custom-token and anonymous support. `authService.js` reads/creates `users/{uid}`. Actual CRM roles are `salon_owner` and `super_admin`, plus guest UI state. |
| Tenant/branch model | Each branch is a `salons/{salonId}` document with `ownerId`; owner queries filter by owner. Operational data sits below that branch. The current subscription identity is the owner UID, not a separate subscription per branch. Active branch is stored in user/application state. |
| Data access | `services/db.js` wraps Firestore CRUD, listeners and transactions; `scopedRepository.js` powers customers/services/staff/appointments. Other repositories handle attendance, referrals, wallet, settings and subscriptions. Realtime collection listeners populate arrays. |
| Backend | JavaScript server endpoints in `api/subscription/*` and `api/cron/subscriptions.js`, Firebase Admin adapter and provider clients under `api/_lib/*`. No Firebase Cloud Functions source or functions deployment configuration was found. A comment suggesting a future Cloud Function is not an implemented backend. |
| Payments | Razorpay order, verification, signed webhook, recurring mandates and reconciliation; Google Play preparation, purchase verification, RTDN and external transaction reporting. Gateway secrets remain server-side. Salon customer collection of cash/UPI/card is a different workflow from purchasing a CRM subscription. |
| Hosting | Vercel serves `public`, subscription APIs, auth-helper proxy, booking rewrite and daily cron. Firebase Hosting configuration serves static content and booking rewrite; it does not route `/api/*` to these Vercel endpoints. A Firebase-only deployment is not equivalent to the Vercel deployment for payments. |
| Security | `firestore.rules` is selected by `firebase.json`; separate `firestore.live.rules` also exists, but its name does not prove it is deployed. Rules check owner/admin access, subscription status/features and public booking constraints. Admin API writes bypass rules, so handlers must enforce access themselves. |
| Android | Despite directory/utility names referring to TWA, executable code is a Java `WebView` container. `twa/app/src/main/java/com/luxeglow/crm/LauncherActivity.java`, `PlayBillingBridge.java`, `LoadingScreenView.java`, `LuxeGlowApp.java`. |
| Android build | Package `com.luxeglow.crm`, min SDK 23, compile/target SDK 36, versionCode 6/versionName 1.0.5. Gradle wrapper declares 9.5.0 and Android Gradle plugin 9.3.1; WebKit 1.14.0 and Play Billing 8.0.0. These are source declarations, not a verified build/toolchain compatibility claim. |
| Notifications | `ui/notification.js` implements UI toasts. A `notificationsEnabled` state field exists. No implemented FCM delivery service, scheduled reminder service or notification campaign pipeline was found. Play RTDN concerns subscriptions, not appointment reminders. |

### Existing data layout

Current collections include `users`, `salons`, `plans`, owner-scoped `subscriptions/{uid}` with `payments` and `events`, global `rewardTransactions`, and `adminAuditLogs`. Branch subcollections include `customers`, `services`, `staff`, `attendance`, `appointments`, `appointmentSlots`, `customerPhoneIndex`, `bookingSettings`, `referralSettings`, `referralCodes`, `referrals` and `walletTransactions`.

Server helpers also use payment-control collections such as `paymentClaims`, `checkoutRequests`, `checkoutLocks`, `webhookEvents`, `webhookInbox`, recurring subscription/period records, `playSubscriptions`, Play account mappings and `externalReports`. Keep these server-owned; do not copy their secrets/provider tokens into a general offline business-data cache.

Invoices currently reside as fields on appointments; there is no separate implemented salon invoice/payment ledger equivalent to the subscription payment ledger. Existing IDs and historical invoice references must remain valid when introducing a normalized model.

### What is reusable

| Classification | Assets/functionality |
|---|---|
| Shared business semantics | Validation, phone normalization, discount calculations, appointment duration/overlap rules, revenue definitions, referral qualification, wallet allocation/reversal, plan catalog and subscription state transitions. Pure JS tests can become cross-language golden fixtures. |
| Shared backend | Firebase identity/project, Firestore data, Razorpay and Google Play server verification, subscription lifecycle, idempotency reservations, webhooks and reconciliation. Extend with versioned contracts rather than fork mobile billing logic. |
| Web-specific | HTML templates, CSS/Tailwind, DOM listeners, browser store/router, service worker, browser auth redirect and checkout script. Preserve these for the web application. |
| Android-specific | Activity/lifecycle, back/exit flow, splash/loading, file chooser/downloads, app links/payment-app handoff, user-choice Play Billing bridge. Replace or adapt deliberately in native UI. |
| Third-party-dependent | Firebase authentication/database, Vercel API/cron, Razorpay checkout/capture, Google Play billing/Developer API/Pub/Sub; fonts and browser SDK CDNs. Local QR generation is self-hosted and does not require a QR service. |

## 3. Existing offline and Android limitations

1. **No self-contained Android business UI.** The wrapper loads the HTTPS production URL on entry; no CRM HTML/JS is packaged. `LauncherActivity.java:134` configures `LOAD_NO_CACHE`; `removeLegacyPwaCacheOnce` unregisters service workers and deletes Cache Storage while preserving cookies and IndexedDB. `main.js:2726` skips service-worker registration for Android. Cached Firestore records cannot render a hosted UI that fails to load.
2. **Browser app-shell caching is incomplete as an offline guarantee.** `public/sw.js` uses network-first shell/assets, leaves cross-origin Firebase modules network-only, and excludes public booking navigation. Several newer imported modules are not in its explicit install list. Dynamically visited same-origin files may enter the cache, but installation does not guarantee the whole module graph. Cold/offline launch is therefore not established even in the PWA.
3. **Firestore cache is not the requested business database.** It contains previously accessed documents, not necessarily the entire operational dataset. `firebase.js` attempts persistence but permits fallback. `db.js` maps snapshots to rows and discards cache/pending-write metadata. There is no durable domain outbox, per-record Pending Sync/Synced/Sync Failed state, conflict inbox or recovery console.
4. **Local acceptance is not explicit.** Repositories await Firestore write completion; listeners may reflect local pending writes, but UI success is not based on a dedicated local business transaction. Some read errors become `[]`/`null`, and listener errors clear lists, obscuring the difference between no records and failed/incomplete reads.
5. **Transactions need connectivity.** Attendance creation, referral wallet operations and public booking use Firestore transactions. SDK persistence does not turn these into offline business transactions. Firebase documents both offline transaction failure and last-write-wins behaviour for document changes; those defaults cannot protect bookings or financial balances. [Firebase transactions](https://firebase.google.com/docs/firestore/manage-data/transactions), [Firebase offline persistence](https://firebase.google.com/docs/firestore/manage-data/enable-offline).
6. **Internal booking locks are best-effort.** `appointmentsRepository.js:1` explicitly makes slot maintenance fire-and-forget; failures do not fail internal bookings. Public booking checks 5-minute lock documents in a transaction, but that does not guarantee conflict safety against every internal write. Locks currently use staff names; duration resolution depends on the current catalog. Release deletes are not conditional on lock ownership. These paths require one common server scheduling invariant before claiming no duplicate bookings.
7. **Public booking token is insufficient for durable replay.** `publicBookingService.js:241` uses session storage and a time/random attempt token. Although the appointment ID is derived from that token, `submitPublicBooking` checks occupied slots without first returning an existing completed result for that appointment. An acknowledged-lost retry can conflict with its own locks. Deterministic IDs alone do not provide complete idempotency.
8. **Financial operations span multiple commits.** `main.js:2035` creates a Quick Billing appointment, then redeems a wallet, then updates paid invoice fields, then settles referrals. `main.js:2430` similarly handles collection; refunds reverse referral effects separately from appointment fields. A crash can leave a partially completed workflow. Referral subtransactions do protect their own balances with deterministic ledger IDs; preserve that strength while closing the wider workflow gap.
9. **Loyalty concurrency differs from referral safety.** `customersRepository.js` reads cached points and writes a replacement balance in `redeemReward`; its comment acknowledges client-side deduction. The global reward ledger repository exists, but current redemption does not establish atomic points-and-ledger posting. Do not assume loyalty is as safe as the referral wallet.
10. **No Room, SQLite domain store or WorkManager.** Android persistence belongs to WebView/Firebase; no native local business database, local sync worker or database upgrade tests were found.
11. **Security/release gaps need validation.** WebView enables DOM storage and third-party cookies, with restricted navigation and SSL cancellation. Billing bridge is origin/main-frame constrained; the separate `AndroidNative` JavaScript interface uses a different exposure mechanism and merits iframe/origin review. Manifest currently allows backup and release lint checks are disabled. These findings do not prove an exploit, but must be revisited when durable PII is introduced.

The current app provides useful online functionality and partial caching. It does not meet the seven requested offline-first guarantees as a complete system.

## 4. Options comparison

Relative effort reflects this codebase and the requested reliability level; no implementation benchmark or monetary quote is available.

| Criterion | A: Kotlin / Room / WorkManager | B: React Native / TypeScript / SQLite | C: Improved current wrapper |
|---|---|---|---|
| Initial cost | High: new UI and Kotlin rules/fixtures | Medium-high: new UI, TS adaptation and native integration | Low for caching fixes; medium-high for full durable sync |
| Code reuse | Backend/contracts/assets; port pure rules | Backend plus selected pure JS rules; DOM UI still rewritten | Highest UI reuse |
| Performance | Direct native rendering and indexed local reads; validate on low-end devices | Native UI, with JS/native execution and integration tuning | DOM/WebView overhead and hosted dependency sensitivity |
| Offline storage | Room transactions, schema migrations and observable queries | SQLite transactions/migrations through a selected maintained library | Needs a native SQLite/Room bridge for the stated storage requirement; browser caching alone is insufficient |
| Background work | Direct WorkManager integration | Android native worker integration still required for reliable scheduled sync | Also needs native worker plus carefully designed bridge |
| Firebase | Native Android SDK for identity/read integration; server commands for critical writes | Native Firebase integration/provider selection and module compatibility validation | Existing browser SDK integration mostly retained |
| Maintenance | Kotlin Android app plus existing web app; explicit semantic parity tests | React Native upgrades, SQLite/Firebase/billing modules plus web app | Web plus Java bridge/lifecycle and cache-version coordination |
| Security | Removes business UI bridge boundary; still needs DB/key/tenant protection | Requires native module and JS dependency auditing | Retains XSS-to-native boundary; a broad database bridge increases exposure |
| Testing | JVM domain tests, Room/worker/instrumentation and Compose tests | JS/domain/component tests plus native SQLite/worker/billing tests | Browser and device tests across two storage/runtime boundaries |
| Scaling | Strong Android operational fit; server/feed design governs multi-device scale | Strong if future iOS becomes a requirement; same server design needed | Adequate as transitional client; durability adds substantial custom native infrastructure |
| Main risk | Rewrite/parity and Android expertise | Overestimating JS reuse; native dependencies still necessary | Mistaking cached screens for reliable offline business operations |

Option B is a credible alternative if near-term iOS delivery or strong React Native team capacity is confirmed. TypeScript is supported directly by React Native, but does not convert browser code into native views. [React Native TypeScript documentation](https://reactnative.dev/docs/typescript).

Option C is appropriate for limited wrapper reliability improvements while migration proceeds. To meet this brief fully, it would need packaged/versioned assets, a transaction-safe native database API, durable workers and the same server conflict/idempotency layer. At that point it is a substantial hybrid product, with bridge complexity rather than simply better caching. No such wrapper changes are authorized by this report.

## 5. Target architecture and project structure — proposed

Use Room as the single observable source of business data for Android. UI reads never depend on a fresh HTTP response. A repository commits the local entity change and an outbox command in one database transaction, then reports **“Saved on this device — Pending Sync.”** Server acceptance is a separate outcome.

Data flow:

```text
Compose screen -> ViewModel -> domain command -> Room transaction
                                            -> entity/draft + outbox
Room queries -> screen + sync status
WorkManager / foreground sync -> authenticated command API
                               -> Firestore transaction + receipt + change feed
Pull feed -> Room transaction (canonical state + cursor + pending overlay)
Provider callback -> verified server billing workflow -> same change feed
```

The local-source-of-truth approach follows Android's offline-first guidance; the exact protocol and business policies below are project-specific proposals. [Android offline-first architecture](https://developer.android.com/topic/architecture/data-layer/offline-first).

Keep a separate proposed `android-native/` project initially, leaving `twa/` available as reference/fallback. Use a different application ID for development; production must preserve `com.luxeglow.crm`, signing identity and an increasing versionCode for an upgrade path. Do not install two production variants with the same identity.

```text
android-native/
  app/                        startup, navigation, dependency wiring
  core/model/                 money, IDs, tenant scope, timestamps
  core/database/              Room entities, DAOs, migrations, transactions
  core/network/               authenticated API, protocol DTOs
  core/auth/                  Firebase identity, device unlock, offline grants
  core/sync/                  outbox, workers, pull feed, conflict recovery
  core/designsystem/          theme, components, accessibility
  domain/                     validation and business use cases
  feature/{auth,setup,dashboard,customers,services,staff,attendance}/
  feature/{appointments,quickbilling,billing,referrals,branches}/
  feature/{subscriptions,admin,bookinglink,sync}/
  testing/                    golden fixtures, fake server, migration fixtures
api/sync/                     proposed push, pull, receipt/status endpoints
api/_lib/sync/                authorization, validators, command handlers
contracts/                    proposed versioned schemas and parity fixtures
```

These are responsibility boundaries, not a requirement to create dozens of Gradle modules immediately. Begin with a small physical module set. Keep Node backend pure rules usable independently of DOM code; extracting shared server contracts can happen later under approval.

Native Firebase Auth replaces WebView session handling. A user signs in again during first native setup; do not scrape WebView cookies or copy Firebase browser tokens into native storage. Existing server-side data remains bound to the same UID. Cached native access requires prior successful provisioning; first-ever login and initial dataset download need a network.

## 6. Local database and storage strategy — proposed

### Common record envelope

Every branch business record has `(ownerUid, salonId, entityId)` scope, canonical `serverVersion`, `serverUpdatedAt`, optional `deletedAt`, local modification time and a local sync projection. Retain legacy Firestore IDs verbatim. Generate new IDs using cryptographically random UUIDs offline; use stable command and business IDs for the whole operation lifetime. Never regenerate an ID after timeout or application restart.

Use separate canonical server snapshots and pending local overlays/commands so a pull cannot overwrite unsynchronised work. Entity sync status is derived from all dependent commands; one accepted earlier command does not mark a later edit synced.

### Schema sketch

All branch tables use scope columns in primary/foreign keys. Owner-global tables explicitly omit branch scope rather than silently defaulting to the active branch.

| Table | Key / important fields and constraints |
|---|---|
| `accounts`, `branch_memberships` | UID; branch ownership/membership, role, permission revision; no role inferred from UI selection. |
| `branches` | Owner + salon ID; name, active/suspended state, working hours, IANA time zone. Preserve existing branch identities. |
| `customers` | Scope + customer ID; name, normalized phone/email, discount preferences, referral links, derived loyalty/wallet balances. Index normalized phone within branch; possible duplicate candidates remain reviewable. |
| `customer_aliases` | Temporary/local customer ID -> canonical ID, including dependent-command remapping and audit. No destructive automatic merge based only on name. |
| `services`, `staff` | Scoped IDs; service price in minor units, duration, active flag; staff profile/role label. Staff role label is not an authentication grant. |
| `appointments`, `appointment_lines` | IDs, customer/staff IDs and legacy names, local date, time zone, start/end instants, duration/price snapshots, source, business status, reservation status, base version. Index branch/date/staff. |
| `attendance` | Unique scoped `(staffId, localDate)`; status, check-in/out, notes and revision. |
| `invoice_drafts`, `invoice_draft_lines` | Durable editable bills, including Quick Billing, client/catalog snapshots, discounts and intended tenders. Draft ID survives navigation and process death. |
| `invoices`, `invoice_lines` | Immutable issued snapshot; appointment link, legacy invoice number, totals, tax/discount/wallet allocation, currency and version. Unique issued invoice per bill/appointment according to current one-invoice model. Corrections use explicit adjustments. |
| `payment_entries` | Stable payment ID, invoice, amount/method/reference, provenance and status: local cash record / externally verified / awaiting verification / reversed. Unique provider references only where supplied by a trusted provider. |
| `referrals`, `wallet_entries`, `loyalty_entries` | Qualification terms snapshot, expiry/allocation details; deterministic source-event IDs; immutable postings and compensating reversals. Keep rupees and points as different units. |
| `booking_settings`, `referral_settings` | Scoped settings revision and sanitized public catalog. Published settings and local edits remain distinguishable. |
| `plans`, `subscription_snapshot` | Plan catalog and owner UID subscription, source, trial/period/grace dates and last verified time. Read-only from offline UI. |
| `outbox_commands` | Scoped command UUID, aggregate ID/type, schema version, payload/hash, expected/base version, actor/device IDs, sequence, dependency IDs, status, attempt count, next retry time, lease expiry, error code, receipt reference. Unique command key. |
| `server_snapshots`, `sync_cursors` | Canonical version/payload; branch feed generation and committed cursor. Index pending/available commands. |
| `sync_conflicts`, `sync_audit` | Local intent/base/server versions, resolution, sanitized error history, operator action and timestamps. |
| `offline_grants`, `device_state` | Signed limited grant, known server time anchor, local account lock state, schema/protocol version and last successful sync. |

Inventory and expense tables are **conditional new scope**, because no operational modules were found: `inventory_items`, `stock_movements`, `stock_reservations`, `expense_entries`, `day_closures`. If confirmed as required, use the same envelope and immutable-event principles. Do not silently count them as migrated features or implement them under this assessment.

### Durability and data quality

- Enable foreign keys and tested Room migrations; no destructive fallback migration. Commit bill/entity changes and outbox together, and surface disk-full/constraint/I/O failures before reporting local success.
- Use integer minor currency units and explicit currency; points remain integers, inventory quantities use a declared fixed precision/unit. Convert legacy rupee numbers with audited rounding; never silently change stored totals. Version calculation rules and keep golden fixtures for historical behaviour.
- Store UTC server timestamps plus branch local date/time zone for scheduling and daily reports. Device time is evidence of entry time, never the source of server ordering or financial authority. Preserve legacy ISO-string and Firestore Timestamp values through explicit adapters.
- Establish a complete initial operational snapshot and a visible downloaded-history range; offline search cannot promise data that was never downloaded. Proposed minimum: full authorized customer/catalog/staff/settings data and an agreed appointment/history window, with demand-loaded older history. Storage sizing must be measured against real branch volume before fixing retention.
- Encrypt sensitive local data with a reviewed SQLite encryption integration or equivalent design, backed by Android Keystore-protected keys; Room does not itself provide database encryption. Exclude business DB, tokens and encryption keys from general backup. Define an explicitly authorized encrypted recovery/export flow for pending work.
- Device storage survives normal app close/restart/reboot; uninstall, clear-data, hardware loss and key invalidation require a separate backup/recovery policy and cannot be solved by Room alone. Warn only when those destructive actions are actually requested and pending data is at risk.

## 7. Synchronisation protocol — proposed

### Local write and scheduling

1. Check authenticated local account, branch scope and the permitted offline operation set. Validate payload and current local constraints.
2. In one Room transaction, write the domain draft/optimistic projection, immutable command payload and dependencies. Only after commit show local success and Pending Sync.
3. Schedule unique WorkManager work scoped to account/device; serialize commands for the same aggregate, while allowing unrelated branches/entities to progress independently. Foreground sync and a Sync Now action use the same coordinator and lease rules.
4. Require network connectivity, but treat it as a scheduling hint: actual authenticated API success determines availability. Schedule on new work, foreground entry, reconnection and bounded periodic reconciliation. Room remains the queue if scheduling crashes between commit and enqueue; startup/periodic scanning recovers it.

WorkManager supplies constraints, persistent scheduling and backoff, not immediate execution guarantees. Doze, battery restrictions and force-stop can delay processing; the app must retain pending work and catch up when execution is allowed or on next open. [Work request constraints and retries](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work).

### Command contract

An envelope contains `protocolVersion`, `commandId`, `entityId`, `commandType`, `ownerUid`, `salonId`, `actorUid`, `deviceId`, `baseVersion`, `createdLocallyAt`, `dependencies`, `payload`, `payloadHash` and, where relevant, the offline grant reference. Server derives actor identity from the Firebase token; supplied scope/role is never trusted.

Proposed endpoints:

- `POST /api/sync/push`: bounded commands, each returning a durable accepted/rejected/conflict/dependency-blocked result. A batch is not implicitly atomic. One business command is atomic within its supported transaction scope.
- `GET /api/sync/receipts/{commandId}`: recover an ambiguous response without issuing a new command or payment.
- `GET /api/sync/pull?branch=...&cursor=...`: paginated authorized change feed, including deletions, server versions and next cursor.
- Provisioning/snapshot endpoint: grants and a consistent initial dataset/feed watermark, resumable under a snapshot generation.

Do not use a generic arbitrary-Firestore-write endpoint. Each business command has a validator, authorization rule, state-transition handler and expected-version checks.

### Server acceptance and idempotency

Use a receipt namespace scoped to actor/account and command UUID. In one Firestore transaction, check any existing receipt and payload hash, validate current authorization and expected aggregate version, apply the canonical business updates, write immutable postings, append change-feed entries, and save the accepted result/versions. Same ID + same payload returns the original outcome; same ID + different payload is rejected. Permanent conflict/rejection outcomes must also be recoverable and must not later become accidental duplicate effects.

Transport is at least once; the goal is effectively-once business effects through durable deduplication and invariants, not a claim of exactly-once network delivery. Use unique business constraints in addition to command deduplication: one issue per bill ID, one wallet posting per source event, one booking reservation per occupied interval, and one provider payment claim per provider reference. Two different command IDs must not bypass these constraints.

Never call a payment provider inside a retried Firestore transaction. Reserve provider work durably, execute with supported provider idempotency/reference semantics, then reconcile its result into Firestore. Unknown provider outcomes stay awaiting reconciliation. Preserve the existing `checkoutRequests`/`checkoutLocks` pattern and extend carefully rather than retrying a new charge.

For very large multi-record workflows, enforce command size limits and explicit server workflow states. Any unavoidable asynchronous effects use a durable server outbox, deterministic event IDs and a recoverable saga; the client sees processing until the promised business boundary is complete. Do not report a whole bill complete after only one of several financial legs commits.

### Retry and interruption policy

| Outcome | Client action |
|---|---|
| Network timeout, temporary DNS, 408/429/5xx | Reuse command ID; recover receipt if response is ambiguous. Exponential backoff with jitter, proposed 30-second start and 6-hour cap; respect Retry-After and OS scheduling. |
| 401 | Refresh Firebase ID token once, then pause affected account work for reauthentication. Never relabel auth failure as data loss or switch to demo mode. |
| 403 | Preserve local record and command; stop automatic retry, refresh membership/entitlement and show actionable access failure. |
| Version/resource conflict | Store base/server/local intent in conflict inbox. Resolve according to entity policy, creating a new command referencing the old outcome when changed intent is submitted. |
| Validation/schema/client-too-old | Keep failed intent; require correction or supported upgrade. No infinite blind retry. |
| Missing dependency | Block only descendants, retaining their local drafts; retry after parent acknowledgement or explicit remapping. |
| Process death while in flight | Expired local lease returns command to retryable state; fetch receipt/resend same identity. Server outcome remains authoritative. |

Use durable attempt timestamps and health alerts; do not discard commands after a retry-count limit. After prolonged failure, show Sync Failed with Retry/View Details, while preserving whether an outcome is unknown, rejected or conflicted. Retry must never silently generate a new invoice/payment identity.

### Pull, ordering and deletes

Every accepted writer, including web booking, web billing, provider callbacks, cron and admin actions, must participate in the canonical version/change protocol. Otherwise optimistic concurrency cannot detect all edits. Avoid routing Android through a safe API while leaving incompatible web writes unrestricted.

Propose a per-branch ordered sequence/feed, with server transactions incrementing the branch sequence and recording each affected canonical version/tombstone. Owner-wide subscriptions/catalog need a separate owner/global feed. A single branch counter is an initial simplicity tradeoff: load-test contention and shard/redesign if required. Existing subscription handlers must publish owner-feed events atomically or through a durable repairable server outbox before native clients depend on that feed.

Initial sync uses a consistent snapshot generation/watermark and replays changes after it. A naive paginated collection scan plus a final timestamp can miss concurrent edits. Apply each downloaded page and its cursor in one Room transaction; dedupe feed entries and ignore stale versions. Rebase pending overlays rather than overwrite them. After server acknowledgement, retain the canonical returned result even if its feed event arrives again.

Deletion creates a versioned tombstone. Keep financial records as void/reversal events rather than physical deletes. A delete-versus-edit conflict requires review; an obsolete edit must not resurrect a deleted record. Proposed tombstone retention is at least 180 days, subject to approved maximum offline duration and device acknowledgement policy. A device with an expired cursor must resnapshot with its unsent outbox preserved and rebased. Never hard-delete needed tombstones while supported offline devices can still replay against them.

## 8. Conflict and financial safety rules — proposed

| Entity / action | Safe rule |
|---|---|
| Customer contact edits | Three-way field merge only for disjoint, non-sensitive fields. Concurrent changes to the same phone/email/name require review. Phone uniqueness is enforced server-side within branch, with local duplicate candidates retained until resolved. Do not merge two people automatically by name. |
| Customer duplicates created offline | Server returns existing candidate/conflict, not a second signup reward. Explicitly authorized identity resolution creates an alias; remap dependent unsent commands transactionally and preserve source IDs/audit. |
| Discounts | Snapshot applied rule/amount on the bill. Concurrent preference edits do not reprice issued bills; server validates actor permission, feature entitlement, cap and pricing-version rules. |
| Service catalog / staff | Expected-version updates. Archive referenced staff/services rather than lose historical names/prices/durations. Catalog updates never silently change issued invoices or existing reservation duration. |
| Appointment creation/move | Offline slot is tentative. Server transaction checks all affected staff/branch/time resources and acquires/releases locks atomically; release only locks owned by that appointment. Competing requests return alternatives/conflict. Never confirm both via last-write-wins. |
| Appointment status / queue | Explicit allowed transitions with expected version; cancelled/completed versus reschedule conflicts need review. Walk-in progress may be recorded locally as pending. Global queue positions require server confirmation; a local ordering is visibly provisional. |
| Attendance | Unique `(branch, staffId, date)`; identical duplicate may return prior result. Divergent times/status require review/versioned correction, not a second row. |
| Invoice issue | Stable bill ID, unique invoice identity, immutable line/tax/discount snapshots. Same command replays original result. Different commands for the same bill cannot issue twice. Concurrent drafts produce a conflict; no automatic financial field merge. |
| Invoice correction/refund | Authorized reversal/credit adjustment tied to original IDs and prior version. Do not overwrite paid history. Provider refund requires verified provider outcome; a local “refund requested” is not “refunded”. |
| Payment | Append-only tender posting with stable ID and provider claim where applicable. Cash record is a local cashier assertion until accepted. UPI/card reference entered manually is unverified evidence, not gateway capture. Unknown online results are reconciled; no automatic second charge. |
| Referral wallet and loyalty | Server-authoritative balance, eligibility, ledger and allocation checks. Offline balances are informational; requests may be drafted, but spend/credit/reversal is confirmed only by server. No cached-balance double spend across devices. Keep current deterministic referral ledger identities. |
| Inventory, if authorized | Append stock movements with unique source-event IDs; never overwrite an absolute stock balance from cache. Concurrent consumption checks available stock/reservations transactionally. Offline consumption is provisional and may be short/conflicted. Guaranteed offline allocation would need server-issued device quotas, explicitly designed later. |
| Expenses, if authorized | Durable local entries, append-only accepted postings; corrections/reversals reference original. Match IDs on retry, and flag suspected same-receipt duplicates without silently deleting legitimate expenses. |
| Daily totals / reports | Derived from accepted ledger events; local pending figures shown separately. No synchronization of a cached aggregate total by overwrite. Server-approved day close/version; late entries create a reopen/adjustment workflow. |
| Subscription | Provider/server state wins. Offline UI cannot start/extend trial, purchase, upgrade, resume mandate or grant paid entitlement. Cached verified entitlement can authorize only the bounded offline operation set. |

### Appointment invariants across clients

Use stable staff IDs and immutable duration snapshots, branch time zone and the same interval definition for public/internal/native booking. Continue adapting existing name/tick lock data during transition; never rename/delete locks blindly. Validate longest service durations and Firestore transaction/rule limits: public client transactions involving many tick documents may be constrained. A server command can use validated bounded locking or a redesigned day/staff reservation aggregate after contention testing. All entry points must use the same mechanism before conflict safety is an acceptance claim.

### Offline capability boundary

**Works locally after provisioning:** downloaded records and history; customer/contact drafts; authorized service/staff edits; attendance; tentative appointments; Quick Billing drafts; bill calculations; local cash collection evidence; cached reports and booking-link/QR generation from cached published settings. Every mutation persists before success and shows pending status.

**Requires server confirmation:** globally reserved slots/queue order, issued canonical invoice, referral/loyalty spend, definitive stock availability, cross-device day closure, branch creation/activation affecting plan limits, role changes, public booking acceptance, settings publication, trial activation, all subscription/provider charges/refunds and entitlement changes.

For offline cash sales, retain a provisional receipt with stable bill/payment IDs and clear local status; it may record that cash was physically received, but must not say the server verified an online payment. Whether a provisional receipt can serve as a legal invoice requires an approved business/accounting decision. If official numbered invoices must issue offline, design server-preallocated device number ranges and reconciliation rules before implementing that capability. Existing `INV-<APPOINTMENT-ID>` references must continue resolving.

Default wallet policy is online-only confirmation because offline multi-device spending cannot safely rely on cached balances. This is a proposed approval decision, not permission to remove referral redemption: preserve the existing online flow and allow durable offline requests with explicit pending status. If offline guaranteed redemption is mandatory, evaluate preallocated spend allowances separately.

## 9. Security, authentication and Firebase integration — proposed

- Continue Firebase Authentication and verify ID tokens on every sync/payment endpoint. Derive UID server-side; validate branch ownership/membership, active/suspended state, feature access and resource references for every command. For new sensitive endpoints, define revocation/disabled-account checks explicitly; current `verifyIdToken` usage does not establish revocation checking.
- Preserve owner/admin boundaries. Staff profile `role` labels are not implemented staff logins or permission grants. If cashier/manager/staff accounts are required, add an explicit membership/permission model under approved scope and test it in both API and rules.
- Provision a signed offline grant tied to UID/device/allowed branches, permissions, plan limits/revision and expiry. Proposed default offline authorization is at most 72 hours and never beyond the verified paid/trial/grace access deadline. The duration is a business/security decision; longer offline availability trades off delayed revocation.
- Anchor expiry to last verified server time and monotonic elapsed time during a boot. Across reboot use persisted anchors and conservative clock rollback detection; suspicious/unverifiable time requires refresh for mutations. There is no perfect revocation or trusted-clock guarantee on an indefinitely disconnected or compromised device.
- A still-valid grant permits limited local captures; server revalidates current permissions at replay. Revocation/plan expiry can reject old offline intents, which remain recoverable for owner review without applying financial effects. Preserve read-only access policy where authorized. Clearly distinguish recorded business evidence from server-accepted transactions.
- Use separate per-account encrypted databases or equivalently enforced account isolation, with all DAOs/worker queries scoped. Branch switching must not retarget queued commands. Workers carry immutable scope; never infer tenant from the currently visible screen.
- On logout, lock local data, cancel account work and remove active token access. Preserve encrypted pending records for the same user's reauthentication/recovery; do not silently delete them or upload under the next user. Shared-device retention and device-unlock rules need approval.
- Firebase SDK disk cache, if retained for read listeners, is not a second business write queue. Critical domain writes go exclusively through command API; canonical reads are persisted into Room. Never replay the same mutation through both Firestore offline writes and the custom outbox.
- Introduce default-deny rules for new server-owned ledgers/receipts/feed, with authorized read models only. Phase out direct critical web writes after upgrading those web paths. Preserve public booking through a sanitized server endpoint/public projection; add abuse controls without exposing customer lists, balances or memberships.
- Keep `.env.example` names as deployment documentation: Firebase Admin, Razorpay, cron and Google Play credentials stay on the server. `SPACRM_PRODUCTION_URL` and Android signing variables remain release concerns. Review least-privilege service accounts, App Check/Play Integrity where appropriate, secret rotation, backup exclusions and log redaction; none substitutes for authorization.
- Secure sync diagnostics must omit names/phones, credentials, full payment tokens and payloads. Use command IDs, pseudonymous device IDs, error categories and versions for operational correlation.

## 10. Payment and subscription preservation

Existing server code already provides useful protections: checkout reservation/fingerprinting, payment claims, verified Razorpay signatures and capture checks, webhook deduplication/recovery, recurring period checks, Play account/purchase verification and reconciliation. Reuse these; do not move authority to the mobile client.

Preserve all catalog plans and live admin overrides. Built-in defaults, in rupees, are:

| Plan | Monthly / annual | Staff / customers / branches |
|---|---|---|
| Trial | Free, 30 days | 10 / 1,500 / 1 |
| Basic | 399 / 3,990 | 2 / 100 / 1 |
| Standard | 799 / 7,990 | 10 / 1,500 / 1 |
| Premium | 1,499 / 14,990 | 15 / 5,000 / 1 |
| Business | 2,999 / 29,990 | Unlimited / unlimited / 10 |

These are code defaults in `core/plans.js`, not verified live prices. Feature lists, trial persistence, period dates, grace (default three days, server-configurable), suspension, read-only expiry, cancellation-at-period-end, upgrades/downgrades, proration and payment/event histories require parity fixtures. Owner subscription coverage across branches must remain consistent.

Current Android policy path uses Play user choice and Razorpay alternative reporting when enabled; web supports manual and automatic Razorpay purchases, while native creation/verification of automatic Razorpay mandates is blocked and cancellation is allowed. Preserve those deliberate platform differences until current provider/program requirements and product decisions justify approved changes. The environment flag being present does not prove enrollment or production readiness.

Native application should use Play Billing directly, restore/query outstanding purchases on resume, persist only necessary protected recovery references, and submit them to existing server verification. Pending purchase states remain pending; activation and acknowledgement follow verified server logic. App closure or connectivity loss after checkout must not prompt a fresh purchase until provider/server state is reconciled.

For alternative billing, keep external transaction tokens/report records server protected and monitor deadlines/retries. The repository's `SUBSCRIPTION-PAYMENTS.md` explicitly identifies missing Google refund reporting; treat it as a release gap to resolve/validate, not a feature already covered by tests. Recheck current eligible markets, enrollment, reporting and SDK requirements for the release: program policy is external to this repository. [Google's user-choice integration guidance](https://developer.android.com/google/play/billing/alternative/alternative-billing-with-user-choice-in-app).

Salon service bills are separate from selling the CRM's digital subscription. Existing cash/UPI/card fields are manual payment records; the inspected API does not establish provider settlement for those salon invoices. Requirements for a future verified salon checkout integration must be specified separately.

## 11. Feature-by-feature preservation inventory

“Preserve” includes current validation, error states, filters, historical links and feature gates. Offline semantics below are proposed; no capability is being removed by this assessment.

| Module / source | Confirmed behaviour to preserve | Target handling |
|---|---|---|
| Auth / `authService.js`, login view | Email signin/signup, Google flow, reset links, session/role restoration, signout; custom/anonymous support paths | Native Firebase identity and app-link/reset handling; prior provisioned session for offline access; server-required account changes. |
| Salon setup / salons repository/setup view | Initial branch creation/profile and onboarding | Preserve flow; local setup draft, server confirms ownership/limits and provisioning. |
| Dashboard / dashboard view, `revenue.js` | Today/current/previous month bookings, estimated revenue, quick actions, newest-first display | Room projections; distinguish pending vs accepted. Preserve revenue fixtures rather than replace estimate with cash totals. |
| Customers / customers/profile views | Normalized phone search, add/edit/delete, shared client source, visit/invoice history, referral balance, saved discount | Durable local CRUD intent/history; server duplicate checks and archive rules; preserve legacy IDs. |
| Services / services view, predefined catalog | Catalog CRUD, import, enable/disable, prices/durations, selection | Local catalog and edits; server validation, versioned pricing and duration snapshots. |
| Staff / staff view/repository | Roster CRUD, role labels and contacts | Preserve roster labels; do not imply staff authentication exists. |
| Attendance / attendance modules | Unique staff/day mark, edit/delete, date navigation, monthly/filter reports | Local capture + unique key, conflict review, archival history and report parity. |
| Appointments / views/repository/scheduling | Create/edit/delete, customer resolution, service line items, staff/date/time, statuses, filters, conflicts checked in UI | Persistent tentative actions; common server lock/transition invariant for confirmation; maintain history. |
| Quick Billing / quickBilling view, `main.js:2035` | Walk-in customer reuse/creation, multi-service lines, editable selections, discounts, wallet/cash split, receipt/refund | Durable draft and stable bill ID; single issue command, local provisional receipt; server-only wallet confirmation. Existing draft-reset navigation behaviour needs review before adopting restore-on-open UX. |
| Invoice collection / payment view, `wallet.js` | Gross amount, discount type/value, capped wallet amount, remaining due, cash/UPI/card reference, paid/completed status, refund | Immutable issued snapshot and ledger; preserve calculations/receipt references; provisional offline capture distinctly labelled. |
| Customer discounts / `discount.js` | Amount/percent calculation, clamp, feature gate and persistence from payment window | Golden-rule parity, recorded applied snapshot and permission validation. |
| Referral / referrals views, referral service/repositories | Code generation/linking, self-referral checks, terms, qualification, caps, expiry, status filters and settings | Preserve all states/terms; server qualification, idempotent postings and reviewable offline requests. |
| Referral wallet / wallet repository/core | Credits, allocations, redemption, expiry/reversal, returned redemption, balances/history | Immutable server ledger mirrored locally; no offline double spend. |
| Loyalty / rewards core, customer redemption, reward ledger | Signup points, voucher tiers, progress, redemption and transaction repository | Keep point units/tier behaviour; close atomicity/ledger integration gap through server commands. |
| Branches / branches core/view, salons repository | Owner branches, Business gate, limits, unique names, hours, activate/deactivate, last-active guard, branch switch | Cache authorized branches; branch configuration/limits server-confirmed; commands retain origin branch. |
| Subscription / plans/state/access/service/views | Trial, five plan entries, monthly/annual choice, live overrides, quotas, expired read-only, grace and plan changes | Shared backend authority and cached verified entitlements; no offline activation or expiry extension. |
| Paid checkout / checkout/payment modules/API | Manual/automatic web purchase, native choice, consent, tax-state selection, scheduling/cancellation, histories, recovery | Preserve platform differences, provider verification and pending states; native recovery across process death. |
| Super admin / admin views | Salon management/status, plan editing, subscription/payment views/filters and suspension | Preserve web administration and plan native equivalent for existing Android access before parity release; sensitive mutations online. |
| Public booking / `book.html`, public-booking modules | Published catalog/hours, slot picker, Any Staff, customer phone index, referral input, notes, confirmation and source | Retain public web URL and UI; move acceptance to shared server command with replay-safe receipt; no offline public confirmation. |
| Booking link / bookingLink view/settings | Enable/configure published catalog/hours/notice, readiness checks, copy, WhatsApp link/source, QR download | Preserve public routes and generated links; cached link/QR local; publication server-confirmed. This is link sharing, not an implemented WhatsApp messaging backend. |
| Notifications | Toast feedback and errors | Native feedback parity. FCM/reminders are new scope unless external implementation is supplied. |
| Tutorials / tutorial content/progress/overlay | Setup guidance and locally stored completion | Preserve equivalent onboarding/progress; no financial data in tutorial preferences. |
| Android shell / Java classes, core platform/refresh/exit | Splash, loading/error/retry, foreground refresh rules, Back/exit, downloads/uploads, external payment intents | Native lifecycle/navigation, local launch, file/share flows and purchase recovery; test accessibility and device integration. |
| Reports | Revenue/dashboard periods, customer history, attendance monthly reports, referral reporting and admin payment summaries | Matching fixtures and date boundaries, scoped Room queries, accepted/pending labeling; historical coverage visible. |
| Inventory/advanced inventory | Feature names in plan catalog; no operational UI/repository/API/stock ledger found | Discovery gap. Obtain any missing implementation/spec; preserve entitlement names, estimate new module separately if required. |
| Expenses/daily tally | Plan feature name; no operational expense/day-close module found | Discovery gap; preserve advertised entitlement and define module acceptance before implementation. |
| Advanced roles/marketing/campaigns/analytics/API access/support | Entitlement labels exist; complete corresponding operational products not established | Record as advertised/unspecified capabilities, not completed migration scope. Do not substitute mock screens. |
| Queue management | Appointment status/list behaviour exists; no independent authoritative queue module found | Preserve current status workflows; specify queue rules/cross-device order if an additional queue is required. |

## 12. Implementation phases, dependencies and estimates

Planning ranges assume two experienced Android engineers, one backend/web engineer and a QA engineer, with product/design review available. They are not a fixed delivery commitment; current team skills, production scale and missing-module requirements are unknown. Work streams may overlap only after their contracts/invariants are fixed.

| Phase | Deliverable / dependency | Indicative elapsed time and exit gate |
|---|---|---|
| 0: Approval/discovery | Approve option, inventory and offline boundaries; verify live rules/schema/providers/signing; define missing capabilities and accounting policy | 1–2 weeks. Signed parity matrix and answered critical questions. |
| 1: Contracts/server foundations | Versioned commands/receipts, authorization, common booking/financial invariants, feed/snapshot and fixture adapters; coexistence plan for web writes | 3–5 weeks. Replay/concurrency/security tests pass on isolated backend. |
| 2: Native foundation | Kotlin shell/theme/auth, Room schema/encryption/migrations, provisioning, scoped repositories/outbox/worker, diagnostics | 3–5 weeks, overlapping phase 1 after contract agreement. Process-death/offline/reboot evidence. |
| 3: Operational parity | Customers/services/staff/attendance/dashboard/branches, appointment UI and booking-link workflows | 4–6 weeks. Feature fixtures and tentative-to-confirmed appointment conflicts pass. |
| 4: Financial/subscription parity | Quick Billing, invoice/tenders, discounts/referrals/loyalty/refunds, all plan states, Play/Razorpay paths and admin parity | 4–6 weeks. No duplicate business effects under fault injection; provider sandbox/license testing complete. |
| 5: Pilot/hardening | Data reconciliation, device/performance/accessibility testing, support runbooks, staged rollout and rollback exercise | 3–4 weeks. Pilot signoff and rollback/data-recovery rehearsal pass. |

A reasonable initial envelope is **18–26 calendar weeks with overlap, approximately 55–90 engineering person-weeks plus QA/design/release effort**. Add capacity/time if missing inventory/expense/campaign/role modules are required. A single engineer should not be promised the same calendar schedule. Re-estimate after phase 0 and a vertical slice; costing requires actual staffing/rates.

Complexity: native screen rewrite medium-high; rule parity high; durable sync and cross-client concurrency very high; financial/provider recovery very high; ordinary catalog CRUD medium. Server correctness and coexistence, not just Android screens, are the critical path.

### Major risks and mitigations

| Risk | Mitigation / release gate |
|---|---|
| Old web/wrapper/direct writes bypass versions or locks | Upgrade all affected writers and enforce compatible rules/protocol before native financial pilot. Define supported client versions and rollout order. |
| Historical invoice semantics differ from normalized schema | Non-destructive adapters, stored original values/references, branch-level reconciliation and accounting review. |
| Duplicate or partial financial effects | Atomic commands, business uniqueness keys, durable provider reservations and receipt reconciliation; crash injection at every boundary. |
| Offline entitlement revoked or expires | Bounded grant, current authorization at acceptance, preserved rejected intent and owner resolution. |
| Database upgrade/key/storage failure | Tested migrations, no destructive fallback, encrypted pending-work recovery and disk-full acceptance tests. |
| Play program/configuration not production ready | Verify Console enrollment/products, test accounts, service account, RTDN/reporting and refund gap in a release-specific checklist. |
| Multi-device stock/wallet/booking overcommit | Server arbitration; tentative offline operations; optional allocation model only if explicitly required. |
| Whole-collection listeners/scans grow expensive | Paginated snapshots/feed, indexed local queries, bounded API batches and measured Firestore costs/contention. |
| Documentation overstates existing capabilities | Use this inventory as baseline; obtain missing source/spec before committing estimates or parity claims. |

## 13. Testing evidence and acceptance criteria

### Checks performed in this assessment

Executed existing syntax checks and all 13 `scripts/unit-*.mjs` suites using installed tooling. All exited successfully. Recurring payment tests ran with the emulator environment unset, using their in-memory adapter. No dependency/configuration changes were made.

| Existing check | Observed result |
|---|---|
| Syntax | All 128 JS/MJS modules passed. |
| Validation / branches / subscription | 54 / 24 / 69 passed. |
| Payments / recurring / Play billing | 72 checks / 30 in-memory scenarios / 58 checks passed. |
| Payment UI | Passed its checkout, consent, schedule, mandate and native-policy assertions. |
| Revenue / referral | 24 / 125 passed. |
| Attendance / booking / Android refresh | 65 / 114 / 28 passed. |

The Play test emitted an unavailable-report diagnostic while still exiting successfully; this is test output, not evidence of a live provider failure or successful production reporting.

Browser E2E scripts exist for smoke, revenue, Quick Billing, attendance, referral, public booking, Firebase fallback and trial; Android scripts exist for production loading, loading overlay and billing bridge. Security scripts use disposable Firebase emulator projects. Package release scripts combine tests/security; not every Android/refresh/payment-rules/trial script is included in the default `npm test` chain. No checked-in CI workflow was found. No Android native instrumentation/Room/worker test suite currently exists.

Browser/device E2E, security emulators, Gradle builds, deployed functions/routes, provider sandbox and production health were **not run** for this assessment. Passing pure/mocked suites does not establish rules deployment, network recovery, true transaction concurrency, payment settlement, feature completeness or durable storage.

### Required target verification

- Preserve domain behaviour through shared golden fixtures for normalization, discounts/rounding, revenue, wallet/referral qualification/allocation/reversal, loyalty, attendance, date boundaries and every subscription transition/quote.
- Test Room entity+outbox transaction atomicity, disk-full failures, process death before/after commit, every schema migration and cursor updates. Kill the app between commit and worker scheduling; work must recover without a new mutation.
- Inject lost requests/responses, intermittent connectivity, duplicate/out-of-order commands and feed pages, expired leases, app upgrade during queued work and stale protocol versions. Confirm no loss of local intent or duplicate business effects.
- Use concurrent clients against an emulator/staging backend, not only serialized in-memory transaction mocks: same staff slot, duplicate bill issue, competing wallet spend, customer phone duplicates, attendance edits and refund/collection races.
- Rules/API tests: forged tenant/actor IDs, role escalation, cross-branch references, disabled/revoked users, expired grants, suspended/expired subscriptions, direct writes to server-owned ledgers, public PII/list access and admin boundary.
- Provider tests: sandbox/license purchases, pending Play purchase, app killed after purchase, webhook before HTTP response, webhook duplicate/out-of-order, capture/refund timing, mandate authorization without paid period, external report retry and restored purchase. No production charge is needed to prove protocol logic.
- Device coverage includes supported min/current Android levels, low-memory devices, reboot, Doze/background restrictions, force-stop followed by reopen, key invalidation, storage pressure, network transitions, timezone/DST and clock rollback. Validate native Google signin/reset, payment-app handoff, file sharing/downloads, Back and accessibility.

### Release acceptance gates

1. After initial provisioning, cold launch in airplane mode shows downloaded business data and functional local workflows without a hosted HTML/CDN dependency.
2. Every locally accepted business mutation is committed to Room with its command before showing success. After process kill and reboot, all acknowledged local entries/drafts still exist with correct sync state. Local storage errors do not show success.
3. Users can distinguish Pending Sync, Synced and Sync Failed per operation/record, inspect actionable errors and retry. A visibly synced business operation has a durable server result, not merely a network-online flag.
4. Replaying a command at least 100 times, losing its acknowledgement and resuming after restart creates exactly one intended invoice/payment posting/wallet entry/stock movement/reservation, as applicable. Different command IDs cannot evade business uniqueness constraints.
5. Two devices attempting the same slot or limited balance produce an explicit losing/conflicted request. No last-write-wins double booking, wallet double spend or silently replaced invoice.
6. A partial push failure does not roll back accepted unrelated commands or lose dependent drafts. Cursor replay/deletes/resnapshot never resurrect removed data or overwrite pending intent.
7. Offline cash/manual tender evidence is distinct from verified online capture. No subscription or online tender becomes confirmed based on an offline assertion.
8. Every implemented feature in section 11 has signed parity evidence; gaps remain explicitly unresolved. No promotional entitlement is claimed as an implemented module without demonstration.
9. At the agreed pilot data volume, proposed targets are local save p95 under 300 ms, warm local list/search p95 under 200 ms and provisioned offline launch under two seconds on an agreed reference device. Measure and agree final thresholds during phase 0; these are targets, not results.
10. A proposed 500-command offline backlog drains correctly under a controlled reconnect test, including interruptions; eligible foreground sync begins promptly (target within 10 seconds on a stable test network). Background completion is measured under OS constraints, without an unconditional timing promise.
11. Every pilot branch reconciles accepted invoice/payment/referral totals, counts and source IDs against server data. Pending/rejected work is accounted for separately, with no unexplained discrepancies.
12. Staged release rollback preserves pending native data and prevents renewed acceptance of unsafe legacy writes.

## 14. Rollout and rollback strategy

1. Before approved implementation touches production data, inventory live schema/rules, take an authorized backup/export and record baseline counts/balances. This assessment has not done so.
2. Ship additive server contracts, canonical versioning and compatible web paths first. Backfill versions in resumable audited batches only after approval; preserve legacy IDs and unknown fields. Do not drop old fields/collections or rewrite history in place.
3. Native internal testing uses isolated data and a distinct dev identity. Read-only shadow comparisons can validate projections, but never dual-submit real financial mutations to old and new paths.
4. Enable a pilot cohort/branch through server feature flags after provisioning and parity gates. Record app/schema/protocol versions and sync health. Continue established web/public booking functionality through compatible commands.
5. Stage production adoption and retain the previous implementation/build artifacts. Keep backwards-readable server representations until retention and support requirements are satisfied.
6. On incident, pause affected command types/cohorts server-side; keep local durable capture only where authorized and safe. Preserve outboxes/receipts and reconcile unknown provider outcomes. Do not clear app data, reset queues or roll back a database backup over newer financial events.
7. Play users cannot simply receive a lower-version APK downgrade. Roll back behaviour by flags or ship a forward update with the prior UI/compatible fallback. Retain the Room schema, encryption keys and a recovery/sync component so pending native work remains accessible even if the visible UI returns to the wrapper/web workflow.
8. Do not restore an old wrapper's unrestricted direct-write path if it bypasses newly enforced invariants. Fallback clients must use compatible APIs/rules or remain read-only for the affected mutation.
9. Reverse incorrect business events with audited compensation entries, not deletion. Re-enable one cohort after reconciliation and repeat failure/recovery acceptance tests. Only later consider any destructive retirement under separate explicit approval.

Monitor oldest pending command age, retry/failure categories, conflict counts, receipt replay rate, feed lag/gaps, duplicate business-key attempts, provider reconciliation backlog, external reporting age and local migration failures. Proposed alerts: online-eligible commands pending over 15 minutes, repeated auth/permission failures, and any unexplained financial mismatch. Provide owner/operator tools to inspect receipt/status, retry safe work, resolve conflicts with audit and export protected recovery data. New monitoring infrastructure is proposed, not confirmed present.

## 15. Files and modules affected by a future approved implementation

No changes listed here have been made by this assessment.

| Area | Likely files / reason |
|---|---|
| New native product | `android-native/**` as proposed; Kotlin UI/domain/Room/sync/auth/billing/tests. |
| Existing Android shell | `twa/app/src/main/java/com/luxeglow/crm/{LauncherActivity,PlayBillingBridge,LuxeGlowApp,LoadingScreenView}.java`, manifest, Gradle, ProGuard and resource files; reference/migration/fallback and release identity, without premature deletion. |
| Shared rule contracts | `public/js/core/{validate,scheduling,discount,revenue,referral,wallet,rewards,plans,subscriptionState,featureAccess,bookingConfig,branches,attendance}.js`; fixture extraction and server parity. Avoid unnecessary rule rewrites. |
| Data access | `public/js/services/{db,scopedRepository,firebase,authService,salonsRepository,customersRepository,servicesRepository,staffRepository,appointmentsRepository,attendanceRepository,subscriptionService}.js`; compatible command/version/read adapters. |
| Benefits/settings | Referral, referral-code/settings, wallet and reward transaction repositories/services; booking settings/catalog publishing. |
| Web orchestration/UI | `public/js/main.js`, `core/{store,draft,router,platform,androidRefresh,exitGuard}.js`, affected views/components; remove unsafe financial orchestration only after equivalent commands exist, expose pending/conflict/recovery states where web is affected. |
| Public booking | `public/book.html`, `public/js/public-booking/*`, `services/publicBookingService.js`; common booking acceptance and durable replay contract. Preserve URL/link semantics. |
| Billing server | `api/subscription/*`, `api/cron/subscriptions.js`, `api/_lib/{handlers,recurringHandlers,playHandlers,checkoutRequests,adminDb,http,billingPolicy,googlePlay}.js`, gateway adapter; feed publication, recovery and reviewed refund-reporting gap. |
| New sync server | Proposed `api/sync/*`, `api/_lib/sync/*`, contract schemas, command receipts/change feed/worker reconciliation. |
| Rules/indexes/config | `firestore.rules`, `firestore.indexes.json`, relevant archived rule documentation, Firebase/Vercel routing/cron/environment template; narrow server ownership and new indexes/routes after approval. |
| Web packaging | `public/{index.html,sw.js,manifest.webmanifest}`, CSS/assets only if a separately approved coexistence/fallback change requires them. Native Room architecture does not automatically fix PWA offline behaviour. |
| Validation/release | `scripts/*`, `package.json` test scripts, future CI and Android tests, `README.md`, `ARCHITECTURE.md`, `FEATURES.md`, `MODULES.md`, `API.md`, `TESTING.md`, `ANDROID-RELEASE.md`, `SUBSCRIPTION-PAYMENTS.md`; align documentation and release gates with actual implementation. |

## 16. Assumptions and open decisions before implementation

Assumptions used for the recommendation: Android is the only committed native target; Firebase/Vercel and current payment providers stay; web and public booking remain supported; initial provisioning may require connectivity; global scarce-resource decisions can remain tentative offline; prior-authenticated access can be time-bounded. If any assumption is wrong, revisit the option/cost and offline boundary before implementation.

Critical questions to resolve during phase 0:

1. What is the maximum required disconnected period: 72 hours, weeks, or indefinitely? Which reads/captures must remain permitted after subscription expiry or staff revocation?
2. Must an official invoice issue offline, or is a provisional receipt acceptable? What numbering, tax, rounding, accounting period/day-close and refund policies apply? Obtain accounting requirements rather than infer law from current fields.
3. Is referral/loyalty redemption allowed to wait for server confirmation? If guaranteed offline spend is required, what per-device allocation and customer communication are acceptable?
4. Are inventory, expenses, queue, staff login/permissions, notifications and campaigns implemented outside this checkout? Supply the missing source/specs; otherwise scope them as separate new work.
5. What are the current production data volumes, device count per branch, maximum history needed offline, low-end target hardware and actual deployment regions? These determine provisioning, storage and feed strategy.
6. Which Firebase rules/indexes are deployed, which hosting path is active, and are all webhooks/cron/provider credentials configured and monitored? Source filenames and old verification reports are not deployment evidence.
7. Are Play enrollment, app signing/update access, products/base plans and service accounts ready? What release-specific refund/reporting requirements remain unresolved?
8. Are iOS delivery or an existing React Native-skilled team business commitments? Either could change the A-versus-B decision.
9. What is the approved shared-device/offline grant/database backup/key-recovery policy? Who may resolve rejected offline cash records, duplicate customer identities and booking conflicts?
10. Must offline drafts restore on navigation automatically? The request calls for durability, while the current Quick Billing flow deliberately clears drafts on navigation. Preserve durable recoverability and approve the exact UX rather than silently changing expected navigation behaviour.

**Approval boundary:** review the recommendation, offline confirmation limits, parity inventory, unresolved scope and implementation ranges. Stop here. Implementation, package/configuration changes, database migration and release/deployment require the plan to be reviewed and approved.
