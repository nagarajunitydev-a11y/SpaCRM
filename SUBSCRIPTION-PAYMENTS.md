# Qvrix GlowOS subscription payments

Implemented against the existing Firebase owner subscription at
`subscriptions/{uid}`, its `payments` and `events` subcollections, existing plan
catalog, feature gates and 30-day trial. No plan prices, features or limits were
changed. Website billing uses the existing gateway registry, extended for
Razorpay Orders (manual purchases) and Subscriptions (automatic mandates).

## Behavior

- Manual monthly/annual purchases retain the existing pricing, renewal and
  prorated immediate-upgrade rules. A lower manual plan remains available after
  the current paid period ends.
- Automatic monthly/annual billing requires explicit consent. Mandate setup
  does not activate paid features. The first plan charge is scheduled after the
  existing trial or paid period. Hosted Razorpay Checkout handles the mandate;
  supported mandate methods depend on the merchant account and provider rules.
- Automatic upgrades, downgrades and billing-cycle changes are scheduled at
  `cycle_end`; existing entitlements remain until a verified charge for the new
  plan. Unsupported provider changes fail without granting the requested plan.
- Cancelling automatic renewal retains the current paid period, prevents grace
  after voluntary cancellation, and cancels an unstarted mandate immediately.
  Pending authorisation can be resumed after reloading the website.
- Failed charges retain only the configured grace period. The default remains
  three days. The server accepts `SUBSCRIPTION_GRACE_DAYS` from 0 to 30 and
  snapshots it on paid subscriptions; Firestore and the client use the same
  boundaries. Administrative suspension cannot be lifted by a payment.
- Receipts/payment history retain safe IDs, amounts, currency, method, dates,
  outcome and service periods. Failed automatic attempts are recorded too.
  Existing receipt viewing/printing is reused. No raw gateway payment objects,
  card numbers, CVVs, UPI PINs or bank credentials are stored.

## Trusted processing and recovery

Firebase ID tokens identify the caller; the backend checks the owner role and
salon/subscription ownership. Prices come from the server plan catalog.
Checkout and webhook HMAC verification stay server-side; subscription checkout
uses `payment_id|server_subscription_id`. Automatic access additionally requires
a captured payment and a matching paid invoice with its own service period.
An authorisation/token charge alone never activates a subscription.

The existing injectable PaymentGateway registry remains the abstraction. The
Razorpay adapter documents its added plan, mandate, invoice, signature and
lifecycle contracts; another adapter can implement those same contracts.
Gateway keys/secrets and Firebase Admin credentials remain server environment
variables. Only the provider's public checkout key reaches the browser.

`checkoutRequests` and `checkoutLocks` reserve remote operations transactionally.
Repeated request keys replay the same result. Provider calls run outside
Firestore transactions so automatic transaction retries cannot create duplicate
orders/mandates. Ambiguous responses lock new operations until reconciliation;
signed provider notes can recover an accepted mandate after a lost HTTP response.
Known definitive rejections can be retried safely.

`paymentClaims` binds a captured payment once; `paidPeriods` under the owner
subscription deduplicates recurring billing periods. Late/out-of-order events
cannot regress a newer paid period. Separate manual orders based on an obsolete
quote, or a second captured invoice for one period, are recorded for support
review without extending access again. History explicitly shows that review.

Recurring webhook events are stored as normalized safe records in the private
`webhookInbox`. Signed-byte hashes prevent duplicate event processing. The
protected existing subscription cron replays unfinished events and reconciles
paid invoices, then reports failures without stopping other subscriptions.
Invoices with ambiguous historical plan identity require review rather than
guessing a plan. Refunds are processed from completed refund events; cumulative
gateway refund amounts prevent double-counting, and a refund arriving before
capture cannot later activate access.

All new billing control collections and the period ledger are server-only under
the existing default-deny Firestore rules. Owner/admin receipt reads remain;
client writes to payment records are denied. Existing tenant feature gates are
preserved. No database migration is required.

## Android and Google Play

The Android app is distributed on Google Play. Salon CRM subscriptions are
"cloud software / business productivity" purchases, which Play's Payments
policy requires to use Google Play billing; linking or steering to the website
checkout is not allowed. For users in India the app therefore uses
**alternative billing with user choice**: Google Play shows its choice screen
and the user picks Google Play billing or Razorpay (UPI, cards, net banking,
wallets).

Flow (server-authoritative in both branches):

1. `POST /api/subscription/play-prepare` checks the quote with the same rules
   as the website and returns the Play product (`glowos_<planId>`, base plan
   `monthly`/`annual`), an obfuscated account id and the launch mode
   (`choice`, `alt-upgrade`, `alt-topup` for a same-plan renewal of an in-app
   Razorpay series, or `play-upgrade`).
2. The wrapper (`PlayBillingBridge.java`, Play Billing Library 8 with
   `enableUserChoiceBilling`) launches Google Play. The bridge is exposed only
   to main-frame scripts from the configured origin.
3. **Razorpay chosen:** the external transaction token goes with the existing
   `create-order` → Razorpay → `verify` flow. The order stores a server-only
   `externalReports` record; once the payment is verified (or the webhook
   captures it) it is reported to `externalTransactions` (PREPAID, GST split,
   India state), retried by the daily cron. Renewals report against the
   initial transaction id; upgrades get a new token.
4. **Google Play chosen:** `POST /api/subscription/play-verify` re-reads the
   purchase from the Play Developer API, requires the caller's obfuscated
   account id, records the payment, updates the subscription and acknowledges
   it. Renewals, cancellation, grace and expiry arrive through RTDN at
   `POST /api/subscription/play-notify?secret=...` and are re-read from Google;
   the cron re-syncs live purchases.

Website checkout refuses to double-bill a live Google Play subscription.
Automatic Razorpay mandates stay web-only; the app can cancel one. Old app
builds without the bridge, and servers without the configuration below, keep
the previous purchase-free behaviour (API returns `PLAY_BILLING_REQUIRED`).

To go live: enroll in Play Console (**Settings → Alternative billing**, India),
create the subscriptions/base plans at the catalog prices, invite a service
account with financial and order permissions, create a Pub/Sub topic with a
push subscription to `play-notify` and set it for RTDN, set the
`GOOGLE_PLAY_*` variables in `.env.example`, then release the app update and
test with license testers (`npm run test:payments`,
`node scripts/e2e-android-billing.mjs` on a device). Refund reporting to
Google is not implemented.

Policy checked on 21 October 2026:
[Google Play Payments](https://support.google.com/googleplay/android-developer/answer/9858738),
[alternative billing for India](https://support.google.com/googleplay/android-developer/answer/13306652),
[user choice integration](https://developer.android.com/google/play/billing/alternative/alternative-billing-with-user-choice-in-app),
[external transaction reporting](https://developer.android.com/google/play/billing/outside-gpb-backend).
Provider contracts:
[Razorpay integration and signature verification](https://razorpay.com/docs/payments/subscriptions/integration-guide/),
[subscription webhooks](https://razorpay.com/docs/webhooks/subscriptions/),
[scheduled plan changes](https://razorpay.com/docs/api/payments/subscriptions/update-subscription/).

## Test-mode rollout

1. Use an isolated staging Firebase project/data and a staging/local website
   configured for that project. Configure server-only test keys, a separate test
   webhook secret, Firebase Admin credentials and cron secret from `.env.example`.
   Match the website's injected Firebase config to the staging backend. Do not
   use production customer data for simulated/test payments.
2. Keep `PAYMENTS_LIVE_ENABLED=false`. Test keys are rejected when
   `VERCEL_ENV=production`; live keys require explicit server enablement.
3. Enable Razorpay Subscriptions on the merchant test account. Configure the
   HTTPS `/api/subscription/webhook` for payment captures/failures,
   `refund.processed`, and subscription authenticated/activated/charged/pending/
   halted/cancelled/paused/resumed/completed events. Subscribe to charged events;
   authorization events do not grant access. Keep the protected cron configured.
4. Run the checks below and complete actual merchant-sandbox checkout, mandate,
   recurring charge, provider retry, cancellation and supported plan-change
   checks. Verify receipts and owner isolation with two accounts. Test replay,
   refund-before-capture and grace-end boundaries. No merchant test credentials
   were available during this implementation, so real Razorpay transactions
   and merchant-account eligibility remain **unverified**.
5. Only after merchant-sandbox acceptance, configure live credentials and their
   separate webhook secret, explicitly enable live payments server-side, deploy
   the API/web changes and `firestore.rules`, and verify the production callback
   and cron configuration. This work did not deploy or enable live billing.

For `RECONCILIATION_REQUIRED`, find the owner's private checkout lock/request and
its request hash in provider notes. Determine whether the remote operation
exists before releasing a lock or creating another mandate. For paid records
marked `requiresReview`, inspect the corresponding receipt/event, reconcile or
refund through the provider dashboard, and let the signed refund update history.
Do not retry a new payment or manually extend a period to resolve uncertainty.
These operator actions were not performed against a live account.

## Validation results

- `npm run test:payments`: 72 existing payment checks, 30 additional billing
  scenarios, and payment UI/mandate/native-policy checks passed with a scripted
  provider and real signature generation/verification.
- `npm run test:payments:emulator`: all 30 scenarios passed with real Firestore
  transactions, including concurrent attempts and payment claims.
- `npm run test:payments:rules`: 35 security/access checks passed.
- Existing subscription unit suite: 64 checks passed.
- `npm run check`: all 119 JavaScript modules passed syntax checks.
- Android Java compilation and debug lint passed: 0 errors, 23 warnings.
- `git diff --check`: passed.
- The broader existing browser smoke runner timed out waiting for
  `document.readyState === 'complete'`; it did not complete its UI scenarios.
  The new payment UI checks passed independently. No full live Firebase/Razorpay
  checkout or Play billing certification is claimed.

## Files changed for this task

- Configuration: `.env.example`, `package.json`, `firestore.rules`.
- Backend: `api/_lib/adminDb.js`, `api/_lib/billingPolicy.js`,
  `api/_lib/checkoutRequests.js`, `api/_lib/gateways/razorpay.js`,
  `api/_lib/handlers.js`, `api/_lib/http.js`, `api/_lib/recurringHandlers.js`,
  `api/cron/subscriptions.js`, `api/subscription/webhook.js`,
  `api/subscription/create-recurring.js`, `api/subscription/verify-recurring.js`,
  `api/subscription/manage-recurring.js`.
- Website: `public/js/core/platform.js`, `public/js/core/subscriptionState.js`,
  `public/js/main.js`, `public/js/services/payment/paymentService.js`,
  `public/js/services/payment/razorpayGateway.js`,
  `public/js/services/subscriptionService.js`, `public/js/ui/views/checkout.js`,
  `public/js/ui/views/subscription.js`.
- Android: `twa/app/src/main/java/com/luxeglow/crm/LauncherActivity.java`
  (native user-agent marker only for this task).
- Tests: `scripts/unit-payments.mjs`, `scripts/unit-recurring-payments.mjs`,
  `scripts/unit-payment-ui.mjs`, `scripts/security-payments.mjs`.
- Report: `SUBSCRIPTION-PAYMENTS.md`.

Earlier branding, WebView/production-URL and loading-image changes in the
workspace were retained separately. No commit, production deployment or new APK
release was made for this payment implementation.
