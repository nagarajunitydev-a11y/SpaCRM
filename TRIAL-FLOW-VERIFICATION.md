# Free Trial activation fix

Verified locally on 8 October 2026. This is a trial-flow verification, not a production-readiness certification. The broader blockers in `PRE-RELEASE-REPORT.md` remain.

## Cause

`subscriptionService.ensureTrial` swallowed Firestore errors and returned no result. Its global boolean also caused concurrent callers to return immediately while another activation was unfinished. The button then announced success unconditionally without navigating or waiting for subscription state. Trial records lacked the salon association and the requested `startDate`/`endDate` fields. Automatic creation could consume the trial before the owner clicked the button.

## Behavior after the fix

- An authenticated, non-anonymous Firebase owner first creates/selects its salon, then explicitly chooses **Start 30 Days Free Trial**. The dashboard and subscription page offer activation when no subscription exists.
- The existing transaction layer reads `subscriptions/{ownerUid}` and the selected `salons/{salonId}` document. It verifies ownership and creates the subscription only if it does not already exist.
- A single in-flight promise is shared by repeated clicks. Cross-tab concurrency is protected by Firestore's transaction contention/retry semantics and the same deterministic subscription document ID.
- The persisted subscription includes `ownerId`, `salonId`, `planId: 'trial'`, `status: 'TRIAL'`, `startDate`, `endDate`, and the existing `trialStartedAt`/`trialEndsAt` timestamps. The two date pairs match exactly; the duration is 30 × 24 hours. `trial` is the application's existing **Free Trial** catalog ID; no parallel `FREE_TRIAL` plan or subscription collection was introduced.
- The existing trial catalog supplies Standard-level entitlements. Amount is zero; billing cycle and last payment are null. Activation makes no payment API call and creates no payment history entry.
- Successful server acknowledgement updates subscription/access state before redirecting to the dashboard. The button shows a busy state while pending, and failures show a persistent error plus the existing notification. Failure re-enables retry and does not announce success.
- Existing active trials resume without extending dates. Expired, inactive or paid subscriptions are not overwritten or restarted. Signed-out attempts fail clearly.
- Rules require the authenticated owner, an owned salon, the canonical trial plan/status, matching date aliases and an exact 30-day duration. A five-minute clock tolerance prevents minor device clock skew from rejecting an otherwise valid signup. Owners cannot update trial dates/status/plan after creation.
- Profile salon preference writes are allowed only for owned salons; role changes remain forbidden.

No paid checkout, gateway or payment handler was changed for this task. Existing owner-level subscription storage is preserved, including paid upgrade/renewal paths.

## Verification

`npm run test:trial`: **21 passed**, using the actual browser application, Firebase Auth emulator and Firestore emulator with the real rules. The test creates a fresh account and salon through the UI; it does not fabricate an active trial in frontend state.

The test verifies rejected writes/error/retry, foreign salon denial, correct saved fields and 30-day timestamps, zero payment, Standard entitlements, dashboard navigation, repeated clicks, existing active trial, refresh/Auth restoration, expired trial preservation, paid-plan preservation, signed-out rejection and absence of unhandled runtime errors. Node Admin SDK reads independently confirm the saved Firestore document. Expired/paid scenarios are subsequent administrator changes to the disposable fixture, not public mutations permitted by rules.

Regression: build and syntax checks pass; subscription unit tests **64 passed**, payment unit tests **72 passed**. Full existing regression passes **517 unit** and **318 browser** assertions, plus the Firebase fallback suite. Those older browser suites use demo mode; the new trial test specifically uses Firebase emulators.

The broader emulator security suite retains **138 passing checks**, two passing fixed-vulnerability probes and **13 pre-existing failing release probes** concerning quotas, lower-plan branch creation and wallet integrity. The new trial create/restart checks pass. Its nonzero release-gate result is not concealed.

Logs: `audit/trial-e2e.log`, `audit/trial-regression.log`, `audit/trial-security.log`, `audit/trial-build.log` (ignored by the existing `*.log` Git rule).

## Reproduction and deployment

```powershell
$env:JAVA_HOME='C:/Program Files/Android/Android Studio/jbr'
$env:Path="$env:JAVA_HOME/bin;$env:Path"
$env:DEBUG=''
npm run test:trial
```

The test starts its own local HTTP server and headless Chrome. It requires Chrome (or `CHROME_BIN`) and Java. It uses disposable project `demo-spacrm-trial`, Auth port 9098, and Firestore port 8085. The local emulator flag is accepted only on localhost with a `demo-` project; deployed production origins keep their normal Firebase connection.

Files changed: `public/js/services/subscriptionService.js`, `public/js/main.js`, `public/js/ui/views/subscription.js`, `public/js/core/store.js`, `public/js/services/firebase.js`, `firestore.rules`, `scripts/e2e-trial.mjs`, `scripts/security-rules.mjs` (trial fixture schema), `firebase.trial.json`, `package.json`, generated `public/styles/tailwind.css`, and this document.

The application changes and matching Firestore rules must be deployed together for the live fix. **Nothing was deployed and no live Firebase account was created during this task.** Production activation remains unverified until the deployed flow is exercised with a dedicated live/sandbox account.
