# SPACRM native Android migration — revised online-only plan

Revision: 22 October 2026, Asia/Kolkata. **Status: execution explicitly authorized by the subsequent conversion-and-build request.**

This document supersedes the offline-first requirements and implementation direction in `ANDROID-MIGRATION-ASSESSMENT.md` and the earlier pilot status. The user's latest requirements take precedence over the previous authorization to implement the offline plan. The subsequent execution request authorizes the separate native implementation and build. Deployment, production signing, database migrations and replacement of the fallback wrapper remain outside this execution. Current results and release blockers are recorded in NATIVE-MIGRATION-STATUS.md.

## 1. Revised objective and non-negotiable requirements

Build a native Kotlin/Jetpack Compose Android application that reproduces the existing SPACRM/Qvrix GlowOS interface and workflows, using the existing Firebase backend and existing APIs for online operations.

- No offline-first product, Room/SQLite business database, durable business command queue, offline entitlement grant, incremental business sync service or WorkManager business-data synchronization.
- No offline demo, Download Branches, Pending Sync, Sync Now, offline wallet spending or local-only billing replacement in the target product.
- Require reachable, authenticated server operations for loading authoritative data and accepting changes. Show appropriate loading, connection, permission, validation and service errors. Local rendering or a network-connected flag is never proof that a write succeeded.
- Preserve web Firebase caching/persistence, service worker, desktop styling, HTML, CSS, JavaScript, routing, rules, schema and API contracts. Native cache configuration is local to the separate Android process/project.
- Preserve all existing screens, fields, actions, permissions, navigation labels and workflows. No generic cards, abbreviated forms, placeholder tabs, mock data or “open the website” substitutes for migrated features. Public booking may remain a public web destination because that is its existing integration, not a replacement for native CRM screens.
- Preserve the current `twa/` WebView app as the supported fallback until feature parity is verified. Native code stays in `android-native/`.
- Any unavoidable shared change requires a specific justification, backward-compatibility evidence, web regression results and explicit approval of that exception. Approval of this plan must not be interpreted as blanket permission to redesign backend contracts.

## 2. Inspection performed and evidence limits

### Current project findings

The web application uses vanilla JavaScript ES modules and HTML template renderers, compiled Tailwind CSS and `public/styles/main.css`. It is not a React application. Screens and actions are split among `public/js/ui/views/*`, shared components, the central `main.js`, core calculation/validation modules and Firestore repositories. The wrapper remains a Java WebView loading the hosted HTTPS application, with native loading/error/back/file/payment integrations.

Current visible authentication is email/password, account creation and password reset. `public/js/ui/views/login.js` explicitly says Google sign-in was removed from the visible UI, and the live guest screen confirms no Google button. Older service code and the original assessment mention Google support; those are not authorization to add a Google button back. Native authentication must match the currently visible product and current backend permissions.

The existing native pilot has a different lavender theme, simplified generic lists/forms, downloaded snapshots, encrypted Room payloads, an outbox, offline grants, WorkManager and a local bill draft. **It is not an acceptable visual/functional foundation as delivered.** Some project wiring and platform scaffolding can be reused after approval, but its offline features and simplified UI must not be carried into the revised product.

### Actual visual inspection

Read-only browser inspection reached the production guest application at `https://spacrm-two.vercel.app/` and the Android query variant. No production login, account creation, booking, payment, record mutation or trial activation was performed.

Inspected the running, unchanged local web application in its existing demo mode at desktop 1440×1000 and mobile 412×915 viewports: dashboard, Clients, Quick Billing, Add New Client dialog and guided-tour overlay. Local demo data is only visual evidence; it is not proof of real backend functionality. Screenshots were generated from the existing application, not from a new design or mock native implementation.

Started the already-installed existing wrapper `com.luxeglow.crm`, version 1.0.5/code 6, on the API 37 emulator. Its observed state was **“Unable to load Qvrix GlowOS / A secure connection to Qvrix GlowOS could not be established / Retry.”** The WebView's production content could not be visually verified on that emulator because of the secure-connection failure. TLS validation was not bypassed and the wrapper was not modified/rebuilt/reinstalled. This observation does not establish that production is generally down: Chrome reached the production page.

Representative references:

- [Production desktop sign-in](docs/android-online-plan/reference/production-desktop-login.png) and [production Android-query sign-in in mobile Chrome](docs/android-online-plan/reference/production-android-query-login.png).
- [Existing source dashboard: desktop](docs/android-online-plan/reference/source-dashboard-desktop.png) and [mobile](docs/android-online-plan/reference/source-dashboard-mobile.png).
- [Existing source Quick Billing: desktop](docs/android-online-plan/reference/source-quickBilling-desktop.png) and [mobile](docs/android-online-plan/reference/source-quickBilling-mobile.png).
- [Existing source client dialog: desktop](docs/android-online-plan/reference/source-customer-modal-desktop.png) and [mobile](docs/android-online-plan/reference/source-customer-modal-mobile.png).
- [Existing wrapper connection-error state](docs/android-online-plan/reference/android-webview-tls-error.png).
- [Inspection metadata and labels](docs/android-online-plan/reference/inspection.json).

Before implementing an authenticated module, complete its visual/state baseline with an authorized real-backend test account on the current web app and existing wrapper. Resolve the emulator TLS issue through normal environment/certificate/network diagnosis or use a working authorized device; do not weaken certificate checking. No credentials were provided or accessed for this planning pass. Authenticated production/real-Firebase visual parity remains **unverified**, not “passed.”

## 3. Preserve the existing visual system and navigation

The source and screenshots establish the reference. Native Compose must reproduce it; default Material styling must not replace it.

| Element | Existing reference and native requirement |
|---|---|
| Branding/logo | “Qvrix GlowOS”; use the existing `public/logo.png` artwork and correct proportions. Retain salon-owner/super-admin context. No new mascot, logo or product name. |
| Colours | Tailwind brand palette: 400 `#fb6fb0`, 500 `#f43f8e`, 600 `#e11d74`; dark slate surfaces/borders and existing emerald/rose/indigo/amber/teal semantic accents. Extract actual values/opacity/gradients from compiled styles. Discard the pilot's lavender reinterpretation. |
| Typography | Plus Jakarta Sans, with existing weight hierarchy, label casing and numeric/currency treatment. Bundle appropriately licensed font assets after approval; do not depend on fetching a font at runtime or silently fall back to Roboto. Respect Android font scaling without losing content. |
| Icons | Existing Lucide names, geometry, stroke weight, semantic meaning and placement. Use native-compatible versions of the existing icons; no unrelated Material-icon substitutions. Record asset licensing/provenance. |
| Shell | Existing logo/header, branch selector, plan/trial indicator, help/guided tours and logout. Preserve feature/role-dependent visibility. |
| Navigation | Preserve labels/order: Home, Bookings, Clients, Referrals, Services, Staff, conditional Branches, Subscription; Quick Billing / Walk-in action. Admin has All Salons and Subscriptions. Attendance stays under the existing Staff flow. No new standalone Sync or Download tab. |
| Phone/large screen | Match current mobile bottom navigation and phone layout; preserve the sidebar on sufficiently wide windows. Existing web desktop breakpoint is 1024 CSS pixels and sidebar width is 17rem. Define Android thresholds through measured reference comparisons; do not substitute a new navigation rail/drawer without review. |
| Dashboard | “Overview / Your Salon at a Glance,” booking and estimated-revenue cards, Quick Bill/Book/Client/Service/Staff/Booking Link actions, Today/This Month/Last Month controls, appointment list and empty states. Preserve calculated metric definitions. |
| Cards/tables | Existing radii, borders, spacing, density, aligned amounts, badges, filters, row actions, responsive grids and card/table alternatives. Keep every column/action accessible when narrow; layout adaptation must not drop data. |
| Forms/dialogs | Existing names, field order, required/optional markers, placeholders, country prefix, validation, visibility toggles, selectors and disabled states. Match bottom-sheet vs centered-dialog treatment where practical, with Android keyboard/insets/focus support. |
| Workflow details | Preserve confirm-delete, customer/referral profile, receipt/refund dialogs, booking link/QR, catalog import, help/tours and exit confirmation. Quick Billing remains a complete page with receipt, not a simplified popup or local-only draft. |
| Connection feedback | Preserve branding and error styling, but use truthful **native-only** online-required messages. Do not copy the web's “changes will sync when you reconnect” banner into native, and do not change that existing banner on desktop. |

Create reusable native `GlowTheme`, header/sidebar/bottom-navigation, metric cards, badges, form controls, data tables, dialogs, toasts/banners and receipts traced to source components. They are implementation components, not a new design system to redesign the product. The current pilot chip-navigation, generic customer forms and Quick Billing draft are not parity-approved screens.

No screenshot is a complete specification: maintain a screen-state checklist including populated/empty/loading/error/permission/expired-plan states and every action. Preserve guide behaviour and help content, including locally stored non-business tutorial completion preferences if needed.

## 4. Proposed online architecture

```text
Compose screen (existing UI reproduced)
    -> ViewModel + transient StateFlow UI state
    -> online repository / existing-workflow adapter
       -> Firebase Auth (same identity and role documents)
       -> Firestore online reads / authenticated online transaction or REST commit
       -> existing /api/subscription/* endpoints
       -> Play Billing / supported existing alternative-billing flow

Server acknowledgement / verified provider status
    -> authoritative result and server refresh
    -> success, error, or outcome-unconfirmed UI
```

Use Firebase as the business source of truth. Do not add a second database, sync protocol, backend command service, device entitlement lease or new collection model. Existing tenant paths and invoice/wallet/subscription representations remain unchanged.

Suggested organization inside `android-native/app/src/main/...`:

```text
app/                    startup, identity/environment wiring, navigation
ui/theme/               existing branding, fonts, colours, spacing
ui/components/          matching header/nav/cards/forms/tables/dialogs
feature/auth/           signin, signup, reset and salon setup
feature/dashboard/      dashboard and existing report periods
feature/customers/      list, forms, customer/referral/history views
feature/staff/           roster and attendance flows/reports
feature/services/       catalog and import
feature/appointments/   list, create/edit/status/scheduling
feature/billing/        Quick Billing, collection, receipts, refunds
feature/referrals/      settings, code/link, balances and loyalty UI
feature/subscriptions/  plans, trial, checkout, verification/history
feature/branches/       branch management and selection
feature/admin/          current admin screens and permissions
feature/booking/        public link, settings, share/QR integration
data/auth/              native Firebase Auth adapter
data/firestore/         existing schema DTOs and online-only transport
data/api/               unchanged authenticated subscription APIs
domain/                 minimal parity adapters/fixtures for JS-only rules
testing/                visual, integration, navigation and parity fixtures
```

Use a small physical Gradle module set initially; these are responsibility boundaries. Do not add web-runtime/DOM screens to claim native parity. Platform/provider checkout surfaces may use their mandated native/browser component; the core CRM interface remains Compose.

## 5. Online-only operation contract

### Reads, cache and persistence

Native Firestore disk business caching must be explicitly disabled/configured as memory-only before the native Firestore instance is used. Reads requiring current data use server-source reads, or listeners whose metadata distinguishes authoritative server snapshots from cache snapshots. A remembered native Auth session is not permission to grant cached business entitlements; fetch role, branch and subscription authorization from the backend.

Already-rendered data may remain in transient memory during a connection failure, visibly marked as disconnected/stale and with dependent mutations blocked. No cold-start offline business mode is promised. Do not persist business lists, forms, invoices, payment instructions or unsent edits through Room, SQLite, preferences, files, SavedStateHandle or a custom queue. Ordinary Auth SDK session persistence and non-business preferences such as theme/tutorial completion are a separate concern.

The desktop web's `persistentLocalCache`, `persistentSingleTabManager`, Auth local persistence, service-worker registration and browser caches remain untouched. Android's Firebase instance/cache settings cannot be implemented by editing `public/js/services/firebase.js` or web initialization.

Firebase documents that its cache can supply offline data and manage queued writes; a server-source read is distinct from a default cache-fallback read. [Firebase offline/cache behaviour](https://firebase.google.com/docs/firestore/manage-data/enable-offline), [Android DocumentReference read-source API](https://firebase.google.com/docs/reference/kotlin/com/google/firebase/firestore/DocumentReference).

### Mutations must not become an SDK offline queue

A connectivity check is an early UI hint, not a guarantee that the server will be reachable. Disabling disk caching alone does not prevent an SDK write from being queued in memory after a mid-request disconnect. Coroutine cancellation/timeouts also do not prove a dispatched write was cancelled on the server.

Use a centralized native mutation adapter that **does not call the ordinary latency-compensated Firestore `set`/`update`/`delete`/batch-write path for business operations**. Prefer online Firestore transactions for supported existing workflows; their callbacks must be side-effect-free, bounded and apply the same data/validation rules. Firebase documents that client transactions fail offline. Where SDK transaction semantics/permissions are unsuitable, use authenticated direct Firestore REST transaction/commit requests against the existing project, with existing field masks/preconditions and rules. Do not create a new `/api/sync/*` dependency to implement this.

The adapter choice must be proven in the first approved implementation slice: disconnect before submission, disconnect after request dispatch, timeout, and reconnect while the process remains alive and after restart. No offline submission is accepted or replayed on reconnect. A request actually dispatched while connected may already have committed before its response is lost; that is **outcome unconfirmed**, not proof of a failed or deferred save. Reconcile it against existing server identities before offering a second mutation.

Firestore REST with a user's Firebase ID token is evaluated by existing Firestore security rules; native must never use service-account credentials. Reusing this existing Firebase interface does not require new backend endpoints/schema/rule changes. [Firebase transaction behaviour](https://firebase.google.com/docs/firestore/manage-data/transactions), [Firebase REST authentication and rules](https://firebase.google.com/docs/firestore/use-rest-api).

### User-visible states and success criteria

| State | Behaviour |
|---|---|
| Loading / submitting | Keep the existing branded layout; show scoped progress, disable duplicate submission and keep entered values in the current screen. Do not navigate away as if complete. |
| Server-confirmed success | Show existing success wording/receipt only after the relevant write/transaction or verified API outcome succeeds. Refresh authoritative values. A local snapshot, cache row or connectivity flag is insufficient. |
| No connection / server unavailable | Explain connection requirement; preserve current in-memory form for user retry. No local-success toast, queue badge or reconnect auto-submit. |
| Validation failure | Match field-level rules, messages and focus placement. Do not send invalid requests or reinterpret a server rejection as success. |
| Permission / expired entitlement | Match existing restricted/read-only/upgrade flows. Clear role/tenant-sensitive data on account changes and stop denied actions. |
| Outcome unconfirmed | Explain that confirmation could not be obtained; look up existing appointment/invoice/order/provider status. Do not say “not charged,” “booking failed,” or “saved” without evidence, and do not blindly submit a second financial operation. |
| Partial multi-step workflow | Show the confirmed stage and unresolved stage separately. Do not report the entire bill/refund/booking complete while required downstream work failed. Retry/recovery is online and user-initiated, using existing identifiers. |

There is no background business worker. Foreground lifecycle refresh can re-read server state; it must not replay stored commands. SDK-bounded transaction contention retries are different from a durable offline queue and must not include external payment/provider side effects.

## 6. Reuse existing backend, data and business rules

Keep current paths: `users/{uid}`, `salons/{salonId}`, branch subcollections, owner-scoped `subscriptions/{uid}`, its payment/event history, plan catalog, referral/wallet/loyalty representations and current appointment-backed invoice fields. Do not introduce normalized invoice tables, operation receipts, cursor/feed collections, tombstone migrations, new tenant hierarchies or native-only required fields from the previous offline plan.

Reuse existing subscription APIs with the same authentication, request/response shapes and server verification. Native billing must send the existing Android platform context so it cannot accidentally use a web-only checkout path. Preserve current Play user-choice/alternative-billing gates, restore/verification, RTDN/webhook reconciliation, web-only Razorpay mandates and native cancellation limits. Server secrets remain server-side.

Current web domain logic is JavaScript. Compose cannot import those ES modules as Kotlin source. **Approval of any minimal Kotlin translation of JavaScript-only pure rules must be explicit in this plan review.** Such adapters must be traced to the unchanged source and checked against shared input/output fixtures; they are not permission to invent a second set of discount, scheduling, revenue or referral policies. Existing server-owned calculations and verification must stay on the existing server rather than be duplicated in Kotlin. If literal runtime reuse is required instead of parity-checked translation, resolve that constraint before coding dependent screens; do not silently add a JavaScript engine or a new shared API.

Parity fixtures should cover `validate.js`, `discount.js`, `scheduling.js`, `revenue.js`, `wallet.js`, `referral.js`, `rewards.js`, `plans.js`, `subscriptionState.js`, `featureAccess.js`, `branches.js`, `attendance.js` and `bookingConfig.js`. Preserve field names, enum strings, date/time zone rules, price/rounding behaviour, source tags and legacy invoice identities.

The existing web is not to be “cleaned up” during the migration. Any inconsistency discovered by parity tests is reported with its impact. Do not fix it in shared files as an incidental native task.

## 7. Feature inventory and required acceptance

Every row requires a complete visual/state baseline plus real-backend workflow tests. Fixture/demo screenshots can guide rendering but cannot complete acceptance. No row may be replaced with a placeholder or an “open web app” button.

| Module | Existing reference | Native completeness criteria |
|---|---|---|
| Authentication | `views/login.js`, `authService.js` | Signin, signup, account creation/profile, reset request/code/password, show/hide password, loading/errors, automatic owner/admin routing. Preserve visible UI; no new Google button based solely on dormant service code. |
| Salon setup | `salonSetup.js`, salons repository | All setup fields, time zone/hours, owner binding, profile persistence and onboarding navigation using actual server data. No fabricated initial branch. |
| Dashboard | `dashboard.js`, `revenue.js` | Same metrics, quick actions, periods, sorting, empty states and branch scope; server-backed data, unchanged estimate definition. |
| Customers | `customers.js`, customer repository/modals | Exact Clients labels/cards, search, add/edit/delete confirmation, optional fields/referral code, duplicate handling and rewards access. Full form, not the pilot's three-field approximation. |
| Customer profile/history | `customerProfile.js`, related repositories | Visit/invoice history, referral code/balance/ledger, eligible redemption and existing actions. No downloaded-only balance substituted for current server state. |
| Services | `services.js`, predefined catalog | CRUD, prices/duration/category/active state, catalog import and current validation/feature gates. |
| Staff | `staff.js`, staff repository | Roster, add/edit/delete, role labels and contacts; roster labels do not become new authentication grants. |
| Attendance/reports | `attendance.js`, attendance core/repository | Unique staff/day records, statuses/times/notes, edit/delete, date navigation and monthly/staff filtering; same Staff-tab placement. |
| Appointments | `appointments.js`, modals/scheduling/repository | Complete forms/line items, customer lookup/create, staff/time selection, status/filter/edit/delete/cancel workflows and server-confirmed completion. No tentative offline booking state. |
| Public booking integration | `book.html`, `public-booking/*`, `publicBookingService.js` | Existing public URLs, published catalog, Any Staff, availability, referral/source behaviour and confirmations remain compatible. Test web/native booking interactions without rewriting public booking. |
| Quick Billing | `quickBilling.js`, `main.js` handlers | Phone-first lookup/inline client creation, multi-service add/edit/remove, assigned stylist, automatic salon date/time, discounts, wallet split, cash/UPI/card references, receipt and refund. Full page/workflow, not a local draft. |
| Invoices/payments/refunds | `payment.js`, wallet helpers, collection/refund handlers | Same invoice identity/totals, methods/references, discount preference persistence, completed/paid/refunded states and receipt. All required legs confirmed or clearly partially/unconfirmed; no invented gateway verification for manual tenders. |
| Referral programme | `referrals.js`, referral service/settings/code repositories | Code generation/linking/self-referral checks, settings, qualifying rules, expiry, filters, credit/redemption/allocation/reversal and balances. Preserve deterministic source identities. |
| Loyalty | `rewards.js`, customer redemption/reward ledger | Existing signup points, tier/voucher labels, progress, redemption and history with existing units. Do not conflate points with rupee referral balances. |
| Subscriptions/trial/plans | subscription views/state/access/service | Existing plan catalog/live overrides, 30-day trial activation, periods/grace, expiry/read-only/upgrade, limits, banners and histories; no trial success until transaction acknowledged. |
| Paid subscription checkout | `checkout.js`, payment modules, existing APIs/Play bridge | Current monthly/annual, quote/consent/tax-state, platform-specific provider paths, pending/cancel/fail/verified success, purchase restore and server reconciliation. No website redirect as a native subscription implementation. |
| Branches | `branches.js`, salons repository | Business-plan gate/limits, unique names, hours/time zones, add/edit/active guards and switch; never carry records/permissions across branches accidentally. |
| Roles/admin | admin/adminSubscriptions views, `users/{uid}`/rules | Existing salon-owner/super-admin capabilities, All Salons/Subscriptions, plan/status changes and payment filters. No newly invented cashier/staff role product. |
| Reports/settings | dashboard/attendance/referral/admin views and settings modals | Preserve every implemented report, filter, period and settings action in its current module. A Reports entitlement name alone is not evidence of a separate report screen. |
| Booking links/QR | `bookingLink.js`, booking settings/config, QR library | Link publishing/readiness/hours/notice/catalog, copy/share/WhatsApp source/QR generation/download and return navigation. No new messaging service implied. |
| Help/navigation/platform | tutorials, exit guard/dialog, wrapper Java classes | Matching tours/info, help menu, Back/exit, keyboard/focus, file/share/download, external payment-app return and loading/retry behaviour. |

Inventory/expenses/campaigns/advanced permissions and related labels previously found only in plan entitlements are not declared “migrated” without source/real behaviour. If further existing implementations are supplied, expand the matrix; do not add mock screens or drop them silently. This clarification does not remove any implemented module listed above.

## 8. Financial integrity and limitations of unchanged contracts

Removing offline sync does not by itself fix pre-existing concurrency or partial-failure behaviour. Preserve existing server payment verification, idempotency keys, payment claims, gateway signatures, webhook and subscription reconciliation. Retain the distinction between manual salon payment evidence and verified CRM-subscription gateway capture.

Inspection confirms Quick Billing/collection/refund currently span multiple operations in `main.js`, while referral subtransactions have their own identities/atomic checks. Internal appointment slot maintenance is best-effort in `appointmentsRepository.js`; the public-booking path uses transactional locks. Loyalty deduction also has existing client-side concurrency limitations. These are existing findings, not an approved backend redesign.

The native workflow must await each required acknowledged operation, use existing IDs to reconcile interruption and avoid a whole-workflow success message on partial failure. Where an existing transaction can be reused faithfully without changing shared state semantics/schema/rules, do so in the native adapter. Do not silently batch/reorder arbitrary legs if it changes eligibility, event order or rule validation.

If tests show that current contracts cannot provide safe duplicate prevention, booking concurrency or recovery after lost financial responses, record a **release blocker** for the affected feature and submit a minimal shared-change exception. That exception must identify the current failure, why native-only adaptation is insufficient, exact backward-compatible change, migration impact, existing-web regression evidence and proposed rollback. No new invoice ledger, sync receipt system or global booking rewrite is pre-approved.

Do not persist a recovery queue as a workaround. Existing server order/payment history and Play-managed purchase recovery can be re-read online. Any additional durable recovery-reference storage needed beyond existing SDK/server facilities must be disclosed separately; it must never become an offline mutation outbox.

## 9. Security and tenant isolation

- Use native Firebase Auth with the existing identity/project and owner/admin role documents. Require online profile/role/branch/entitlement confirmation for protected operations. Do not grant a demo fallback session when authentication/network initialization fails.
- Read/mutate only existing authorized tenant paths. Reattach listeners on account/branch changes and cancel obsolete screen requests; clear transient business state at logout/account switch. An old response must not render data under a new user's session.
- Keep Firebase rules authoritative. Native UI visibility is not authorization. Use user ID tokens for Firebase/REST/API calls; no Admin SDK/service account in APK.
- Refresh tokens appropriately; distinguish expired token, revoked/disabled account, permission rejection and network errors. Keep the current screen/form where safe while requesting reauthentication.
- Preserve HTTPS and certificate checks, billing platform context, safe app links and provider-return handling. The observed emulator TLS failure is a verification issue to diagnose, not permission to loosen security.
- Keep backend/provider secrets and production signing material outside source/APK. Logs/analytics must not expose customer data, credentials or payment tokens.
- Default to current permissions and plan enforcement. Do not expand staff access or weaken rules because native API calls are denied; report the mismatch and evaluate it within the approval boundary.

## 10. Dependencies and previous-pilot disposition after approval

| Dependency / artifact | Revised disposition |
|---|---|
| Kotlin, Compose, Activity, Lifecycle/ViewModel, coroutines | Retain necessary native platform tooling. Build theme/components from the existing UI; review versions/compatibility before approved implementation. |
| Firebase Auth | Retain; align with currently visible auth workflows and existing project configuration. |
| Native Firebase Firestore | Add only after approval for server-source reads/listeners and proven online-only transaction path. Memory-only business cache; no persistence shared with web. |
| HTTP/serialization | Minimal native adapter for existing APIs and, if required by mutation proof, existing authenticated Firestore REST. Version/DTO behaviour must preserve current wire contracts. |
| Play Billing / alternative provider | Integrate directly while preserving existing server verification/platform gates. Provider-mandated external/embedded checkout surfaces require validation; do not assume the web Razorpay widget is drop-in Compose UI. |
| Fonts/logo/Lucide assets | Reuse/bundle existing branding and appropriately licensed font/icon assets. No generated redesign assets. |
| Room runtime/compiler/KSP/database schemas | Remove pilot business-store dependencies/code from the target build after review. KSP can be removed if nothing else needs it. No replacement business SQLite store. |
| WorkManager / workers / scheduler | Remove pilot business synchronization and startup/foreground enqueuing from target app. No background mutation replay. |
| Vault/outbox/grants/snapshot-replication UI | Retire pilot-specific business persistence, encrypted queue, grants, download/demo/Sync UI and local billing-only flow. Normal Auth credential protection is separate. |
| `/api/sync/*`, `api/_lib/sync/*` | Not dependencies of the revised native app. Propose retiring only earlier pilot additions after checking deployment/consumers and approval; do not touch unrelated APIs. |
| Existing web/native fallback | `public/**`, `styles/**`, `twa/**`, routing/rules/schema remain protected. No dependency upgrade or CSS rebuild incidental to native migration. |

The previous pilot may contain unsynced local records. No database/app-data deletion or automatic upload is authorized. Before an approved cleanup, identify whether any real pilot data exists and how the owner wants it preserved; do not clear it to make the new build look clean. Use a fresh development install/profile or distinct online-development application ID when necessary to keep old pilot data intact. Production package/signing/version transition remains a release step after parity.

## 11. Affected files and protected boundaries

### Expected native-only implementation changes, after approval

- `android-native/app/src/main/java/com/qvrix/glowos/nativeapp/MainActivity.kt`, `PilotViewModel.kt`, `GlowApplication.kt`: replace pilot-specific theme/navigation/offline wiring with existing-UI native architecture.
- `android-native/.../data/{LocalDatabase,LocalRepository,RecordVault}.kt`, `.../sync/{SyncApi,SyncWorker}.kt`, `app/schemas/**`: retire only pilot offline business functionality, respecting the no-data-loss requirement. Create online repositories and operation-state models instead.
- `android-native/.../domain/Money.kt`: evaluate against existing JS calculation fixtures rather than treat pilot arithmetic as the reference specification.
- New `ui/theme`, matching components and feature files described in section 4; existing branding resources/fonts/icons under `android-native/app/src/main/res/**`.
- `android-native/app/build.gradle.kts`, root build/settings/Gradle properties/manifest/ProGuard: approved dependency removal/addition, app identity/environment, native auth/deep links, Internet permission and packaging. No production signing change without release review.
- `android-native/app/src/test/**`, `src/androidTest/**`: replace offline durability acceptance with online result, visual, permission and workflow tests. Preserve relevant historical tests until cleanup is reviewed.
- Native README/status and proposed native-only visual/backend test assets. New verification scripts should preferably live under `android-native/` so web/package scripts do not change unnecessarily.

### Earlier shared pilot additions requiring scoped cleanup review

Existing working-tree changes from the previous implementation include `api/_lib/adminDb.js` additions (`getAdminFirestore` and optional revocation argument), two native-sync scripts in `package.json`, native sync environment names in `.env.example`, `api/sync/**`, `api/_lib/sync/**`, and native offline/unit/integration scripts. This revision did **not** revert or modify them.

After approval, inspect exact diffs and callers before reverting only obsolete pilot hunks. Retain unrelated edits and any independently justified backward-compatible security behaviour. Confirm no deployed consumer depends on endpoints before removal. Do not reset whole shared files or use a broad repository rollback.

### Protected by default

`public/**`, `styles/**`, `tailwind.config.js`, web route/rendering/business modules, `firestore.rules`, `firestore.live.rules`, indexes/schema, `firebase*.json`, `vercel.json`, existing payment APIs/helpers/gateway/webhook/cron, `package-lock.json`, and all existing `twa/**` source/build/signing settings. These are read-only reference unless a separately justified, approved exception is necessary. Native compilation/tests must not regenerate desktop Tailwind CSS.

## 12. Phased implementation and review gates

| Phase | Work after approval | Exit criteria |
|---|---|---|
| 0 — Revised approval/reference completion | Review this plan, calculation-port interpretation, online transport proof, pilot-data disposition and access/test setup. Complete authenticated web/wrapper screen-state captures using authorized test data. | Approved revised scope; explicit record of unknowns/shared exceptions. No implementation before this gate. |
| 1 — Native online shell and UI foundations | Remove offline target dependencies safely; recreate theme/logo/fonts/icons/header/nav/dialog foundations; implement online auth and salon/role/branch loading. Prove no-queue mutation transport in isolation. | Visual shell/signin/setup match; real test Firebase access; correct failure behaviour; no business persistence/worker/queue dependency. |
| 2 — Complete operational screens | Customers/profile/history, services/catalog, staff/attendance, dashboard/reports and branch selection/management, one complete module at a time. | Each module has full actions, state coverage, live test-backend evidence and visual comparison. Unfinished module stays on fallback; no placeholder marked complete. |
| 3 — Appointments and booking integration | Existing scheduling/list/forms/status behaviour, server-confirmed native writes, existing public booking links/settings/QR and concurrency tests. | Cross-client booking behaviour documented; no premature confirmation; unresolved contract safety gaps treated as blockers/exceptions. |
| 4 — Billing/referrals/loyalty | Full Quick Billing, invoices/payment/discount/refund, referral settings/balances/allocations/loyalty and receipt parity. | Real-backend fixture workflow checks, calculations and partial/unknown outcome handling pass. No fake paid state. |
| 5 — Plans/subscriptions/admin | Full trial/entitlements/quotes/history, native provider purchase/restore/cancel/verify and admin/report functionality. | License/sandbox provider tests and authorization/plan parity; existing platform policy retained. |
| 6 — Regression and pilot | Screen/device/keyboard/back tests, authenticated parity matrix, desktop regressions, staging reconciliation and rollback exercise. | All implemented modules pass real backend/visual acceptance; shared exceptions approved/tested. Preserve wrapper until full release signoff. |

Do not shrink the full feature scope to make phase estimates look smaller. With two experienced Android engineers, backend consultation and QA/design review, a provisional range is **14–22 calendar weeks**, subject to authenticated inventory, provider readiness, test-account access and any required shared-change exception. This is a planning assumption, not a fixed commitment. Removing sync reduces infrastructure effort; complete visual/workflow parity is still substantial. Re-estimate after phases 0–1 with measured screen complexity.

## 13. Tests and acceptance criteria

### Visual parity

- Reference captures for each screen/state use the same authorized dataset, role, branch, locale, date/time context, window dimensions, font scale and keyboard state. Cover compact phones (for example 360/412dp widths), landscape where supported and wide tablet/desktop-like windows.
- Compare native screenshots against the existing mobile web/WebView reference and desktop layout where applicable. Check logo, font, colour/opacity, card radius/padding, icon alignment, label text, table columns/actions, dialog/sheet behaviour, scrolling and navigation order.
- Mask only documented platform system bars, dynamic time/text/data, antialiasing and truly necessary platform controls. Use image overlays/diffs plus human review; do not declare parity solely from a global similarity score. Record every material Android layout deviation with reason and approval.
- Verify accessibility/large-font behaviour, contrast, touch targets, screen reader labels, IME resizing/focus/next actions, password visibility, date/time selection and no clipped action buttons. Changes needed for usability preserve content and workflow.

### Real-backend functional acceptance

For every module in section 7, run against an authorized, isolated real Firebase test project and existing deployed API implementation, not demo arrays or fabricated successful responses. Record account role, branch, precondition, action, server document/result and expected UI state. Read-only production comparisons can be used when authorized; do not mutate production business data for testing. Emulators and mocks supplement these checks and cannot satisfy the real-backend acceptance gate alone.

Test authentication/account lifecycle, owner/admin routes, subscription expiry/trial, branch ownership, wrong-tenant IDs/references, disabled/revoked accounts, permissions denied by rules, listener cleanup and late-response isolation after switch/logout. Validate fields/types/unknown-field preservation against actual existing schema and rules.

Payment tests use provider sandbox/license testers and existing server verification: pending purchase, cancelled checkout, callback before HTTP response, lost acknowledgement, duplicate tap, restored purchase, signed webhook, refund timing and entitlement changes. A native/provider callback is not proof of captured payment or active subscription; server verification remains required. Manual salon cash/UPI/card fields must retain their existing meaning.

### Online-only failure acceptance

1. Disconnected cold start displays a branded connection-required/retry state, not a demo/dashboard populated from a business database.
2. Submitting disconnected does not enqueue, persist, report success or mutate backend data after reconnection, whether the process remains alive or restarts.
3. A mid-request disconnect/timeout shows failure or outcome-unconfirmed, never a false successful save/booking/payment/trial. Reconnection does not automatically replay the user action.
4. For a dispatched operation with a lost response, verify existing server identity/status before another submit. Exactly distinguish confirmed, failed and unknown; do not assert that HTTP cancellation rolled back a server commit.
5. Cached/listener-local data is never treated as current authorization, accepted write or current available wallet/slot. Test actual API failure as well as network callbacks/captive portal behaviour.
6. Partial Quick Billing/refund/referral operations expose their true stage and offer only safe online recovery using existing IDs. Duplicate taps/provider returns cannot silently double-charge or double-credit.
7. Dependency/source checks confirm no Room/SQLite business store, WorkManager business worker, offline grant, outbox, snapshot replication, durable form store or reconnect auto-submit remains in the target app. Auth SDK internal state and non-business preferences are documented exceptions.

### Desktop/fallback regression

Maintain separate baselines: (a) current working tree at the start of this revision, including previous pilot additions, and (b) approved production/release baseline. A clean `git diff` against HEAD alone cannot prove no changes when earlier work was already uncommitted.

For native-only phases, require zero changes to protected web assets/routing/cache/rules/schema/API contracts and compare protected-file hashes before/after. Run existing relevant unit, browser E2E, security-rule and payment tests against unchanged environments. Browser rendering regressions must use the same source baseline; native build steps must not regenerate web assets.

For any separately approved shared cleanup/fix, review the exact diff, run the existing `npm test`, `test:security`, payment/recurring/Play/rules/trial suites appropriate to the exception, and compare desktop screenshots/workflows on authorized test data. Isolate test projects and avoid production payment side effects. Preserve `twa/` build/install behaviour and access to current complete functionality throughout.

### Evidence from this planning pass

Live guest browser renders, local source demo renders and the wrapper error state were inspected and captured. A SHA-256 baseline of 207 protected implementation/reference files was recorded before document updates in `docs/android-online-plan/reference/protected-source-baseline.json`. The comparison in [protected-source-verification.json](docs/android-online-plan/reference/protected-source-verification.json) found no implementation/configuration changes or missing files; only the explicitly allowed native README status notice changed within that baseline. Screenshot reference links were also checked. This is documentation/inspection verification only. No revised native implementation, real-backend workflow acceptance, payment test, native build or new functionality test has been claimed as completed here. Previous offline-pilot test successes do not satisfy this revised plan.

## 14. Risks, dependencies and rollback

| Risk/dependency | Handling |
|---|---|
| Authenticated UI/test access is missing | Complete current-production/test-backend reference inventory before dependent screen implementation/acceptance; never infer parity from demo screenshots. |
| Existing wrapper TLS failure on emulator | Diagnose the environment or inspect on a working authorized device; retain SSL checks and record actual behaviour. |
| Visual parity drift from default Compose | Trace all components to source assets/tokens and screenshot states; no default theme/new navigation substitute. |
| JS-only calculations cannot literally import into Kotlin | Explicitly approve minimum fixture-verified ports or resolve shared-runtime/API policy before dependent coding. |
| SDK writes silently queue despite “online-only” UI | Prove the centralized online mutation transport under disconnect/reconnect; no normal SDK queued-write escape paths. |
| Existing multi-step/booking concurrency limitations | Record risks and blockers; justify minimal exceptions separately rather than changing desktop/backend silently. |
| Real provider/Play readiness and refund-reporting gaps | Verify current enrollment, products, API credentials, current reporting requirements and sandbox/restore/refund scenarios before release; no inferred readiness from config names. |
| Existing pilot may hold local unsent work | No clear-data/uninstall/database deletion or forced upload. Resolve ownership/disposition before retiring persistence code or choose an isolated online dev install. |
| Claimed feature not actually implemented in this checkout | Obtain source/spec/real behaviour; keep inventory honest and do not create placeholders. |
| Scope/time pressure | Deliver complete modules incrementally, keep current fallback and publish explicit parity evidence; do not label a partial native build as the replacement app. |

Rollback is predominantly native release control because the default scope makes no shared data migration. Keep the existing wrapper package/signing/update artifacts intact and keep production users on it until parity. Stop native rollout or ship a forward corrective update if needed; Android/Play downgrades are not assumed. Do not overwrite current Firebase data with a historic backup or reverse real payments by deleting records. Any approved shared change needs its own compatible rollback procedure and old/new-client tests before deployment.

## 15. Review items and approval boundary

Review this concrete plan before implementation resumes. Required decisions are the visual/functional inventory, online-only transport and its no-replay tests, minimal Kotlin parity translations for JS-only rules, access to an authorized real-backend test environment/current authenticated reference screens, and preservation of any previous pilot-only local data. Any specific shared-change exception is reviewed separately with evidence.

**Stop after planning.** This pass may update planning/status documentation and capture read-only visual evidence. It does not remove the existing pilot's code/dependencies/data, alter desktop behaviour, change APIs/rules/schema, deploy anything or begin the revised Compose implementation. The next implementation phase starts only after the user reviews and approves this revised plan.
