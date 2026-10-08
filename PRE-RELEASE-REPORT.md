# SPACRM pre-release subscription and feature verification

Audit date: 8 October 2026 (Asia/Calcutta). **Overall status: NOT READY.**

This report describes the local source and local test results after the fixes listed below. It does not certify the deployed Firebase project or payment gateway. Required features remain missing, and actual Firestore emulator requests still bypass advertised quotas and branch entitlements. The requested remediation is **not complete**.

## 1. Overall status and verification scope

Inspected the application entry point, router/store, plan catalog, entitlement/state helpers, views, repositories, public booking, Firebase/Auth wiring, Firestore rules/index configuration, payment adapter/handlers/endpoints, hosting configuration and test scripts. The app is a vanilla JavaScript PWA with Firebase client SDK imports from Google's CDN, Vercel subscription APIs using Firebase Admin, and an Android TWA wrapper.

Evidence is deliberately separated:

- **Static inspection:** identifies missing implementations and code/rules mismatches. It cannot establish successful production execution.
- **Browser regression:** drives the actual UI in local **demo mode**, using existing seeded application behavior. These passing tests do not prove Firebase workflows.
- **Firestore integration/security tests:** use actual Firestore emulator persistence and rule evaluation with separate authenticated contexts. They exercise direct database operations, not the full browser → repository → Firebase path.
- **Payment tests:** execute the real handlers, reducers and HMAC implementation against a scripted gateway and in-memory database. No real gateway charge, webhook delivery, deployment, renewal debit or receipt delivery was performed.

No production data or paid subscriptions were modified, and nothing was deployed. No Firebase Admin or gateway credentials were supplied in workspace configuration; only a secrets template exists. No production Auth accounts were created. `TEST_FREE_TRIAL`, `TEST_BASIC`, `TEST_STANDARD`, `TEST_PREMIUM`, and `TEST_BUSINESS` are isolated emulator tenants/authenticated contexts, not real Firebase Auth logins. Their trial/paid records are deliberately provisioned as fixtures with rules disabled; security checks themselves run with rules enabled. They are disposable and not exported after emulator shutdown.

The emulator approach follows [Firebase's rules-testing guidance](https://firebase.google.com/docs/firestore/security/test-rules-emulator). Linked-document guards use [getAfter validation for atomic writes](https://firebase.google.com/docs/firestore/manage-data/transactions). Admin SDK access bypasses rules and therefore needs its own authorization checks, as Firebase documents in the first link.

## 2. Plan verification

| Plan | Result | Catalog price/month | Catalog price/year | Staff / customers | Principal blockers |
|---|---|---:|---:|---|---|
| FREE TRIAL | **FAIL** | ₹0 | ₹0 | 10 / 1,500, inherited Standard caps | Standard functionality incomplete; quota and extra-branch writes bypassed |
| BASIC | **FAIL** | ₹399 | ₹3,990 | 2 / 100 | Expenses/daily tally absent; backend caps bypassed; reports/history incomplete |
| STANDARD | **FAIL** | ₹799 | ₹7,990 | 10 / 1,500 | Inventory/marketing/reports missing; public booking fails for existing customers/referrals; caps bypassed |
| PREMIUM | **FAIL** | ₹1,499 | ₹14,990 | 15 / 5,000 | Premium inventory/campaign/AI/analytics/API capabilities absent; caps/branches bypassed |
| BUSINESS | **FAIL** | ₹2,999 | ₹29,990 | Unlimited / unlimited | Roles, branch reports and enterprise integrations absent; financial integrity unresolved |

Default prices and inherited feature arrays match the requested catalog. Standard is marked `popular: true` and the subscription view displays its Most Popular badge. Trial is 30 days, costs zero and does not use checkout/card collection. Trial has Standard entitlements in the catalog, but cannot deliver all Standard features because several do not exist.

Business has an additional **10-branch catalog cap**. The request specifies unlimited staff/customers, not unlimited branches; this branch cap needs explicit product documentation. Live `plans/{planId}` documents can override prices/features/limits. Their production contents were unavailable and have **not** been verified against these defaults.

## 3. Feature matrix and application inventory

The complete **160-row Plan × Feature matrix**, with the requested columns and statuses, is [audit/plan-feature-matrix.csv](audit/plan-feature-matrix.csv). It covers all 29 advertised feature keys plus staff capacity, customer capacity and pricing for each of the five plans.

The route/component/service/Firestore inventory is [audit/FEATURE-INVENTORY.md](audit/FEATURE-INVENTORY.md); structured equivalent: [audit/feature-inventory.json](audit/feature-inventory.json). Evidence paths in these files are repository-relative. `PARTIAL` means implementation or proof is incomplete; a catalog entitlement is never counted as a working feature. `NOT APPLICABLE` for a non-entitled absent feature is not an implementation pass.

Additional requested module/workflow inventory:

| Module | Actual application path/data | Result |
|---|---|---|
| Dashboard | `ui/views/dashboard.js`, appointments/services repositories; branch appointments | PARTIAL: real estimated booked-revenue cards; no daily expense/net-profit ledger or advanced analytics |
| Customers/Clients | `customers` tab, customer form, `customersRepository` → `salons/{id}/customers` | PARTIAL: CRUD/search/quick-add exist; duplicate/limit decisions use snapshots; full Firebase-browser proof pending |
| Staff | `staff` tab, staff form, `staffRepository` → `salons/{id}/staff` | PARTIAL: CRUD exists; backend quota absent; specialization text is not an application permission |
| Services | `services` tab, service/catalogue forms, `servicesRepository` → branch services | PARTIAL: CRUD/import existing service catalogue; no independently managed category collection |
| Categories | Service `category` text and list filters | PARTIAL: categorization, no category CRUD lifecycle |
| Appointments | `appointments` tab/modal, `appointmentsRepository`, branch appointments/slots | PARTIAL: scheduling and status exist; booking/lock mutation not atomic for internal appointments |
| Quick Billing | `quickBilling` full page, `main.js` submit handler, existing customer/appointment/wallet repositories | PARTIAL: multi-line/repeated service billing works in demo; multi-step Firebase writes can partially succeed |
| Billing/Invoices | Payment modal and Quick Billing receipt, invoice fields on appointment | PARTIAL: no separate invoice repository; no transactional commit across invoice/wallet/customer changes |
| Payments | Appointment payment fields and referral ledger | PARTIAL: records cash/UPI/card/reference; does not externally validate salon UPI/card collection |
| Expenses | No page, handler, repository or rules | NOT IMPLEMENTED |
| Daily revenue / expenses / net profit | `core/revenue.js` computes gross booked estimate; unpaid bookings contribute | NOT IMPLEMENTED for required daily financial tally |
| Staff attendance | Staff attendance UI, `attendanceRepository`, deterministic branch attendance document | PARTIAL: browser demo and rules/persistence checks pass; full Firebase-browser workflow pending |
| Memberships | No membership lifecycle/data service | NOT IMPLEMENTED |
| Loyalty | Reward tiers/modal and client points; `redeemReward` client-side | PARTIAL: non-atomic points and some retained loyalty UI |
| Referral | Referral UI/profile/payment, referral service and branch repositories | FAIL: ledger consistency bypass reproduced |
| Offers/Coupons | Some historical money fields/comments only | NOT IMPLEMENTED as a usable offer/coupon workflow |
| Inventory | Catalog feature only | NOT IMPLEMENTED |
| Online booking | `/book/{id}`, public booking service/settings | FAIL: private reads required by returning-customer/referral paths |
| WhatsApp booking | URL/QR/share UI uses public booking | PARTIAL: sharing exists; linked workflow inherits booking defects |
| Marketing/Campaigns/Birthdays/Reactivation | DOB storage and share link only | NOT IMPLEMENTED as campaign workflows |
| Reports | Dashboard period selection; monthly attendance | PARTIAL: no Standard/branch/advanced report modules |
| Analytics/AI growth | No provider/analysis endpoint or workflow | NOT IMPLEMENTED |
| Notifications | Toasts, network banner and notification preference | PARTIAL: no verified durable notification delivery/push backend |
| Settings | Booking/referral/branch configuration | PARTIAL: no complete global settings module; working-hours source is booking settings |
| User profile | `authService.ensureUserProfile` → `users/{uid}` | PARTIAL: Auth profile provisioning exists; no complete profile editing workflow |
| Roles/permissions | Owner vs platform super-admin; users profile role | NOT IMPLEMENTED for Business staff/branch permissions |
| Branch management | `branches` tab/modal/selector; `salonsRepository`; one salon document per branch | FAIL: lower-plan creation bypass; branch reporting/financial/inventory modules incomplete |
| Subscription management | Subscription/checkout/admin pages, subscription service, state machine and API | PARTIAL: local checks pass; deployed gateway lifecycle unverified and edge cases remain |
| Payment history | `subscriptions/{uid}/payments`, receipt modal | PARTIAL: server-owned history/receipt fields tested locally; real receipt/reference delivery unverified |

## 4. Missing features and recommended implementation

These are missing deliverables, not hidden menu entries. None were replaced with mock screens or parallel data systems.

| Feature | Affected plans | Expected / current | Affected files | Recommended implementation | Priority |
|---|---|---|---|---|---|
| Expenses and daily tally | All | Expense CRUD and daily revenue/expense/net profit / no implementation | `core/plans.js`, `core/revenue.js`, `ui/views/dashboard.js`, `main.js`, `firestore.rules` | Use existing branch-scoped repository factory; implement validated expense ledger, payment-based daily totals and matching rules | P0 advertised core gap |
| Inventory / advanced inventory | Trial/Standard+; advanced Premium+ | Stock ledger, adjustments; advanced purchasing/valuation / entitlement only | `core/plans.js`, `main.js`, `firestore.rules` | Branch-scoped stock items/movement ledger, atomic stock changes, tier gates; build advanced layer on same ledger | P1 release blocker for advertised tiers |
| Standard and branch reports / advanced analytics | Standard+ / Business / Premium+ | Real finance/branch/retention reports / only estimate and attendance | `ui/views/dashboard.js`, `core/revenue.js`, `core/plans.js` | Define financial semantics, aggregate existing paid invoices and expense ledger by branch; permission-check server aggregates | P1 |
| Marketing, birthday/reactivation campaigns | Standard+ / Premium+ | Segments, campaign lifecycle, scheduling/delivery/results / no service | `core/plans.js`, `api/`, `main.js` | Add consent-aware recipient segmentation and authenticated campaign APIs; choose/configure delivery provider; persist job state | P1 |
| AI marketing/growth | Premium+ | Usable AI workflow with real data / no provider or endpoint | `core/plans.js`, `api/` | Configure provider server-side; authorized tenant-scoped input, usage controls, persisted output and failure handling | P1 |
| API / enterprise integrations | Premium+ / Business | Authenticated integration API/keys/connectors / internal subscription API only | `api/`, `core/plans.js`, `firestore.rules` | Explicit integration contracts, tenant/branch scope, server-managed credentials, revocation, audit and throttling | P1 |
| Advanced roles/permissions | Business | Staff invitations/logins, role assignments, permission checks / owner/admin only | `authService.js`, `staffRepository.js`, `main.js`, `firestore.rules` | Add authoritative memberships and permission policy shared by UI/API/rules; branch assignments cannot be self-edited | P0 authorization scope |
| Priority/dedicated support | Premium+ / Business | Support entitlement with operational fulfillment / no evidence | `core/plans.js`, subscription UI | Implement support entry/routing and verify operational service commitments | P1 product/service blocker |
| Memberships, offers/coupons, contact import | Existing-feature requirements | Usable business workflows / absent | `main.js`, customer/service views/repositories | Extend existing customer/billing architecture; validate imports and run every imported row through authoritative quotas | P1 |
| Full customer visit/invoice history | Basic+ | Chronological real customer visits/payments / referral profile only | `ui/views/customerProfile.js`, appointments/customers repositories | Join existing branch appointments by customer ID and show real visit/invoice history | P1 |

## 5. Broken features / workflow defects

1. **Public booking existing customers and referrals:** `publicBookingService.submitPublicBooking` reads `salons/{id}/customers/{customerId}` after the phone index and reads a referrer's customer record inside the transaction. Anonymous customer reads are denied. Emulator tests confirm index lookup succeeds and customer lookup fails. This is a real-code/rules contradiction even though demo booking passes. Fix through a server-controlled booking transaction with limited public response, server identity/referral validation and quota enforcement; do not expose customer records to anonymous readers.
2. **Internal double-booking:** appointment creation commits before best-effort, fire-and-forget lock acquisition. Existing lock collisions are ignored; cancellation releases locks without verifying their appointment owner. Move booking/reschedule/cancel and ownership-checked locks into one authoritative transaction. Simultaneous internal/public collision behavior is not certified.
3. **Billing/wallet partial failure:** Quick Billing creates a Completed appointment, then redeems wallet, then updates invoice paid fields. Payment collection also debits wallet before the invoice update. Failures can leave an invoice and wallet inconsistent. Commit the invoice/customer/referral/ledger effects atomically using the existing repositories and transaction layer/server.
4. **Customer creation can precede later validation:** normal appointment submission resolves/creates its customer before checking working hours/conflicts. A rejected appointment can still create a client. Validate before any mutation and commit dependent creations together.
5. **Money reports:** estimated revenue is deliberately gross booked value, including unpaid appointments. It cannot stand in for collected daily revenue or profit.
6. **Contact duplication:** duplicate checks operate on frontend snapshots; concurrent creation is not protected by a unique database identity. Internal customer creation does not consistently maintain the public phone index, making repeat customer matching unreliable.
7. **Loyalty:** points redemption uses a non-atomic client read/update; documented directly in `customersRepository.js`. The Quick Billing existing-customer card still displays loyalty points. The requirement to remove loyalty UI is not fully met; exact permitted surfaces need a product decision because Standard also advertises loyalty.

## 6. Feature gating

Fixed server/database enforcement covers active/expired/suspended subscription writes, Standard referral/discount operations, online-booking settings and public booking eligibility. An expired subscription can still read its historical tenant data intentionally; no downgrade deletion was added.

Remaining gaps:

- Extra branches can be created directly by lower plans; frontend `canCreate('branch')` is not sufficient.
- `renderOwnerTab` gates the referrals tab but most routes render without a feature check; staff attendance mutations and other specialized repositories rely on rules for production denial. Some forbidden controls/history remain visible instead of a consistent locked state.
- The same dashboard is rendered for all tiers, despite an advertised Standard advanced dashboard.
- Owner profile/referral surfaces remain available on Basic and can show inactive referral information. Mutations now have stronger rules, but UI consistency is incomplete.
- Missing feature modules have no successful allowed-path implementation. Merely being denied by default rules is not proof of a completed plan.
- Client `access === null` and demo/unrestricted states still bypass some repository-side guards. Updated rules protect covered production writes; frontend state is never an authority.
- Plan override documents and deployed rules are unverified. Catalog overrides must remain aligned with authoritative enforcement.

## 7. Usage-limit verification

The emulator persists records up to each actual boundary and then issues the next write as the owner. Fixture population uses disabled rules to avoid conflating setup with the operation under test; final allowed and forbidden writes use rules.

| Account | Allowed boundary tested | Required next result | Actual next result | Verdict |
|---|---|---|---|---|
| Trial | Staff 10; customers 1,500 | Staff 11 / customer 1,501 BLOCK | Both accepted | FAIL |
| Basic | Staff 1, 2; customers 100 | Staff 3 / customer 101 BLOCK | Both accepted | FAIL |
| Standard | Staff 10; customers 1,500 | Staff 11 / customer 1,501 BLOCK | Both accepted | FAIL |
| Premium | Staff 15; customers 5,000 | Staff 16 / customer 5,001 BLOCK | Both accepted | FAIL |
| Business | Staff 16 and 17; customers 5,001 and 5,002 | PASS | Accepted | PASS for these boundaries; not proof of every scale |

Frontend pure tests check capped `canCreate` responses. Real database enforcement is absent. `subscriptions/{uid}.usage` is an owner-editable informational snapshot, and `currentUsage` counts only the loaded active branch staff/customers. It is unsafe for enforcement, races concurrent tabs/imports and undercounts multi-branch usage.

Required remediation: migrate/reconcile existing tenant usage with a dry-run report, establish authoritative owner-wide counters or quota allocations, serialize create/delete/update with quota changes in one server/rules-verifiable transaction, and route **all** creation paths—including public booking, quick-add and imports—through that policy. Preserve above-limit data after downgrade and block new additions until compliant. This migration and backend quota implementation remain undone.

## 8. Security issues

**Fixed locally, not deployed:**

- A user could set its own `users/{uid}.role` to `super_admin` and gain cross-tenant access. Profile creation is now owner-only; updates can change only email/display name; deletion cannot reset the role.
- Salon owners could change the tenancy `ownerId`. It is now immutable for owners.
- Rules previously allowed tenant writes after subscription expiry/suspension and public bookings after downgrade/expiry. Added authoritative subscription/time/feature checks; public booking also checks salon suspension.
- Legacy global reward documents without `salonId` were readable by any signed-in user. Removed that fallback; legacy unscoped records now need an admin migration to become owner-visible.
- Attendance uniqueness depended only on repository convention. Rules now enforce `{staffId}_{date}` keys.
- Public phone indices accepted arbitrary linkage. Rules now require a 10-digit key and the linked customer's matching E.164 phone using `getAfter`.
- Public slot locks could reserve a nonexistent appointment. Rules now require the referenced appointment's staff/date/time to match; valid atomic new-customer/index/appointment/slot writes are tested.

**Remaining:**

- **P0:** quota and multi-branch authorization bypasses, reproduced by 12 database probes.
- **P0:** Standard owner can change a customer's wallet balance to ₹999,999 without posting any ledger row. Rules validate shapes/non-negativity but not financial invariants. Entitled owners can also write qualifying referral status/reward fields. Financial consistency requires authoritative transaction enforcement, not client helper conventions.
- **P0:** no advanced staff permissions or branch membership authorization; owner access spans all owned branch paths. Owner-wide access can be intentional, but there is no restricted staff/branch role to test.
- **P1:** anonymous booking writes do not authoritatively validate service catalog prices, booking date/window/hours, allowed staff, customer identity, rate limits or the full deterministic slot set. The new linked-document guard does not solve all of these.
- **P1:** phone digits/10-digit limits are frontend validated; Firestore customer/staff/salon validators still accept strings up to 40 characters. Direct invalid-phone writes remain possible.
- **P1:** inactive branch business writes are not universally blocked by rules. Public bookings are blocked, but an owner can still target an inactive branch directly.
- **P1:** rule migrations were not deployed; live tenant isolation and any existing illegally granted super-admin profiles require an administrative audit before rollout. Tightened rules prevent new escalation, not cleanup of already compromised roles.

Tenant read denial is tested across the five emulator owners and an unrelated authenticated context. The five tenants' customer/staff/service/appointment/attendance paths are exercised. No broad production penetration test, Storage rules test, production index test or Android permission test was performed.

## 9. Subscription and payment issues

| Scenario | Local verification | Remaining limit |
|---|---|---|
| Trial creation/expiry | Exact 30-day rule, one-time create, cannot restart, exact expiry locks | Production signup/browser clock tolerance unverified |
| ACTIVE | Core writes allowed while paid | Real gateway activation unverified |
| PAST_DUE / GRACE_PERIOD | Access retained within 3-day grace; locked after it | Automated payment retry/auto-debit not implemented |
| EXPIRED / SUSPENDED | Covered tenant writes denied; reads preserved | Some settings/branch UI pathways remain inconsistent |
| CANCELLED | Access retained until period end, then denied without grace | UI cancel endpoint cancels an order, not recurring subscription renewal |
| Reactivation | Reducer/admin status paths exist; old payment cannot lift suspension after fix | Real admin/customer reactivation flow not certified |
| Upgrade | Trusted quote/credit and activation unit tests pass | Stale/concurrent order sequencing and quote freshness unresolved |
| Downgrade | Mid-period lower-tier purchase is blocked; can buy after period ends; no customer/business deletion | No scheduled downgrade workflow or authoritative post-downgrade quotas |
| Renewal | Same-plan purchase extends period; calendar month/year clamp tested | Manual purchase model; no tested recurring gateway plan/subscription ID |
| All eight plan/cycle prices | Server ignores browser amount, INR paise and renewal period tested | Live plan overrides, real charge/capture and deployed endpoint behavior unverified |
| History/receipt | Server-only write rules, receipt/reference fields and duplicate-payment handling tested | Actual email/receipt delivery and production history not verified |

Frontend checkout does **not** activate a paid plan. `/verify` validates HMAC, fetches/captures payment server-side, checks order ID and validates amount/currency. Signed webhooks also activate. Added strict 64-character hex signature checking, webhook currency preservation and mismatch rejection, and suspension preservation when an already-issued order is captured.

Unresolved payment risks from code inspection:

- Previously issued orders can activate their recorded plan/kind against a later subscription without revalidating the purchase quote/current plan. Out-of-order orders and concurrent upgrades/renewals need integration tests and a defined reconciliation/refund policy.
- Repeated partial refunds overwrite `refundedAmount` rather than reconcile cumulative gateway refunds; a later full cumulative refund may not revoke access correctly. Refund-created and refund-processed events share processing logic. Refund identity/cumulative semantics need authoritative gateway reconciliation.
- Webhook fallback deduplication uses event name/time/body length, which can collide if event IDs are absent. Use authenticated event IDs or a digest of the exact signed body.
- A Vercel Node deployment is configured for APIs; Firebase Hosting configuration only serves static files and `/book/**`. Deploying only Firebase Hosting does not provide these payment endpoints.
- No real gateway credentials or deployed network checks were available. Payment configuration failure must remain a failure, never be presented as activation.

## 10. Multi-branch verification

Business Branch 1, 2 and 3 creation, edit, deactivate/reactivate and independently persisted customer documents pass emulator checks. The existing model is `salons/{branchId}` with a common owner, not a separate branch system. Staff/customers/appointments/billing/attendance/referrals are scoped under each branch. A local fix clears previous branch lists/settings while new Firebase snapshots load, reducing transient cross-branch display. This fix needs a real Firebase browser switch regression before certification.

Lower-tier direct second-branch creation still succeeds for Trial, Basic, Standard and Premium. Advanced branch roles, branch reports, branch expenses and inventory are missing. Branch-specific customer documents do not establish tested isolation for nonexistent modules. Cross-branch staff authorization, all-branch reporting, migration handling, aggregate usage and branch switch races have not been certified. Owner-wide cross-branch reads are intentional with the current ownership model.

## 11. Existing-feature requirements and final regression

| Requirement | Result / evidence |
|---|---|
| Quick Billing full page | PASS in browser demo; not a dialog |
| One customer/multiple services; repeated service | PASS in browser demo; independent line IDs and totals verified |
| Other Service | PARTIAL: normal appointment supports custom service; Quick Billing resolves only catalog services |
| Normal appointment date/time selection | PASS in browser demo; corrected obsolete tests that expected hidden automatic fields |
| Quick Billing independent time behavior | PASS in browser demo; walk-ins stamp current salon time |
| Queue management | PARTIAL: appointment status changes exist; no dedicated queue ordering/token/dispatch workflow found |
| One attendance record per staff/day | PASS for demo flow and emulator deterministic key; device/full Firebase browser pending |
| Digits-only max-10 phone | PASS in UI demo; FAIL for equivalent backend enforcement |
| Customer contact import | NOT IMPLEMENTED; existing import is predefined services, not contacts |
| Referral balance/redemption | PASS demo calculations/flow; FAIL financial invariants in database |
| Loyalty UI removed where required | FAIL/PARTIAL: point labels and reward modal remain; removal scope unresolved |
| Customer discount at end of payment | PARTIAL: normal payment-end block exists; Quick Billing discount block precedes wallet/method section |
| Expenses/daily tally | NOT IMPLEMENTED |
| Forgot password | PARTIAL: real Firebase Auth reset/verify/confirm calls exist; actual reset email and completion not exercised |
| Multi-branch by plan | FAIL: direct lower-tier branch creation succeeds |
| Role permissions | FAIL: advanced staff/branch permission system absent |
| Back exit confirmation/internal navigation | PARTIAL: exitGuard/modal handling implemented; Android TWA bridge/hardware exit not tested |

Final local automated results:

| Check | Result | Evidence |
|---|---|---|
| Build (`npm run build:css`) | PASS | `audit/build.log`; this static project has no separate JS bundle build |
| Syntax (`npm run check`) | PASS: 106 JS/MJS modules, including API and test scripts | `audit/regression-final.log` |
| Type checking | NOT APPLICABLE to configured tooling: no TS configuration/typecheck script; not substituted with syntax checking | `package.json` |
| Lint | NOT IMPLEMENTED in tooling: no lint script/config; no lint pass claimed | `package.json` |
| Unit suites | PASS: 517 assertions across validation, branches, subscriptions, payments, revenue, referral, attendance, booking | `audit/regression-final.log` |
| Browser suites | PASS: 318 assertions across revenue, Quick Billing, attendance, referral, public booking, smoke; fallback suite also passes | `audit/regression-final.log` |
| Firebase rules/integration checks | PASS: 138 checks, plus 2 fixed-vulnerability probes; **13 unresolved probes FAIL** | `audit/security-results.json`, `audit/security-final.log` |
| Browser console | No console errors in attendance/referral/public booking/smoke demo suites; fallback no fatal JS errors | Same regression log; not a production console pass |
| Firebase/network errors | Expected permission denials captured in emulator negative tests; no production network/Firebase error capture | `audit/security-final.log` |
| Dependency audit | FAIL: 22 advisories (16 high, 6 moderate), including runtime Firebase-related and build/test tooling dependencies | `audit/dependencies.json`; no unreviewed force-upgrade applied |
| Full Firebase browser workflow / gateway sandbox | NOT VERIFIED | No production/sandbox sign-in or secrets supplied |

`npm test` now includes the previously omitted booking unit and public-booking browser suites. `npm run test:security` deliberately returns **nonzero** while release probes fail. `npm run test:release` chains regression and security and therefore must remain red. Passing demo tests cannot override it.

Reproduction in PowerShell (Java 21+ available; this machine's Java is Android Studio's JBR):

```powershell
$env:JAVA_HOME='C:/Program Files/Android/Android Studio/jbr'
$env:Path="$env:JAVA_HOME/bin;$env:Path"
$env:DEBUG=''
# Start in a separate terminal:
python -m http.server 5500 --directory public
# Run in the repository terminal:
npm run build:css
npm test
npm run test:security
node audit/generate-matrix.mjs
```

Emulator project: `demo-spacrm-audit`, Firestore port 8085. Test fixtures are local; never point this script at a real project. Generated log files are ignored by the repository's existing `*.log` rule; structured JSON evidence and this report are retained.

## 12. Files changed by this audit

The workspace already contained substantial subscription/branch changes and untracked files before this audit; those were preserved. This list identifies files edited/added during this audit, not every pre-existing Git difference:

- `firestore.rules`: profile/owner protection, subscription lifecycle/entitlement writes, public booking eligibility, linked index/slot guards, attendance identity, scoped reward reads.
- `public/js/core/featureAccess.js`: missing subscription fails closed until the persisted record loads.
- `public/js/core/subscriptionState.js`: malformed states/expiry boundaries fail closed; verified payment preserves administrative suspension.
- `public/js/services/scopedRepository.js`: delete operations also respect subscription read-only state.
- `public/js/main.js`: discount/referral plan checks, skip forbidden automatic referral/public-catalog writes, clear old branch data while loading, persist numeric zero discount instead of invalid empty string.
- `public/js/ui/views/payment.js`, `public/js/ui/views/quickBilling.js`: apply discount eligibility to payment controls/calculation.
- `api/_lib/gateways/razorpay.js`, `api/_lib/handlers.js`: strict HMAC shape and signed webhook currency checks.
- `scripts/unit-subscription.mjs`, `scripts/unit-payments.mjs`: expiry, missing data, eight plan/cycle purchases, malformed signature, wrong/missing currency and suspension regressions.
- `scripts/security-rules.mjs`, `firebase.audit.json`: isolated Firestore emulator integration/security tests and failing release probes.
- `scripts/e2e-revenue.mjs`, `scripts/e2e-quick-billing.mjs`, `scripts/e2e-smoke.mjs`, `scripts/e2e-public-booking.mjs`: align assertions/fixtures with selectable appointment times, independent repeated lines, real removal buttons and closed Sundays; assertions retained for actual workflow behavior.
- `scripts/syntax-check.mjs`: include server APIs and test scripts in syntax verification.
- `package.json`, `package-lock.json`: compatible Firebase rules testing/CLI dev dependencies, missing existing suites, security and release commands.
- `public/styles/tailwind.css`: generated CSS build output; no unrelated UI redesign.
- `PRE-RELEASE-REPORT.md`, `audit/generate-matrix.mjs`, `audit/FEATURE-INVENTORY.md`, `audit/feature-inventory.json`, `audit/plan-feature-matrix.csv`, `audit/security-results.json`, `audit/dependencies.json`: audit artifacts.

## 13. Remaining blockers

Release requires all of the following, not just green demo tests:

1. Enforce owner-wide staff/customer/branch quotas atomically across every write path, with safe existing-data reconciliation and downgrade handling.
2. Enforce wallet/referral/invoice invariants and commit payment effects atomically.
3. Fix public booking without granting anonymous access to customer PII; test actual new/returning/referral bookings through Firebase.
4. Implement the advertised missing plan workflows or revise the product offering explicitly before sale. This audit has not changed or concealed the advertised catalog.
5. Implement Business permission/branch/report capabilities and verify branch switching/isolation for every module.
6. Resolve stale order/refund/webhook sequencing risks and complete sandbox payment/deployment verification for all billing cycles and lifecycle transitions.
7. Add and execute full browser tests against Firebase Auth/Firestore emulators or a dedicated sandbox, covering network failures, concurrent tabs, imports, upgrades/downgrades and atomicity.
8. Review dependency advisories, deployed rule/catalog state and any previously escalated admin profiles; then repeat the release gate after controlled deployment.

## 14. Final recommendation

**Do not release these subscription plans to production.** All five plan certifications are FAIL. The local fixes close several serious vulnerabilities, but 13 direct database probes still demonstrate critical authorization/financial defects, numerous advertised capabilities are absent, and live Firebase/payment execution has not been certified. Keep the release gate failing until the remaining implementation and verification are complete.
