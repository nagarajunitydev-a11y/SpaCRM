# Android production website connection

Production URL: **https://spacrm-two.vercel.app/**

This stable URL is already used by the project's production Firebase auth
configuration. Live HTTP checks returned 200 and the Qvrix GlowOS title/login.
The previous Android URL, https://spacrm-ishari.vercel.app/, still returned the
older Qvrix Luxe website. No localhost or preview URL is used in the APK.

## Changes

- `twa/app/build.gradle`: production URL default; version 1.0.4 / code 5.
- `twa/twa-manifest.json`: matching production host, icon URLs and version.
- `twa/app/src/main/res/values/strings.xml`: matching asset-statements origin.
- `twa/app/src/main/java/com/luxeglow/crm/LauncherActivity.java`: foreground
  refresh signal, external-link handoff, timeout handling, and retryable cache
  migration with success acknowledged by the page before recording completion.
- `public/js/core/androidRefresh.js`: refresh idle Android landing screens;
  defer while forms, other tabs, checkout, dialogs or tutorials are active.
- `public/js/main.js`: install that listener only for the Android platform.
- `public/sw.js`: include the new module in browser/PWA offline precaching.
- `vercel.json`: explicit no-store headers for `/` and the PWA manifest; existing
  no-store headers for index, JavaScript, styles and the worker are retained.
- `scripts/unit-android-refresh.mjs`: refresh and workflow protection checks.
- `scripts/e2e-android-production.mjs`: installed APK foreground/reopen test
  using controlled website versions at the production origin through CDP.
- `twa/README.md`, `ANDROID-RELEASE.md`: production URL, workflow and validation
  instructions. Existing unrelated documentation edits were retained.
- `twa/PRODUCTION-VERIFICATION.md`: this report.

The earlier `API.md` branding correction is separate from this task. No database
schema, payment business logic, subscription plans or UI layouts were changed.

## Results

- `:app:assembleDebug :app:lintDebug`: passed; lint has 0 errors and 23 warnings.
- `npm run check`: all 110 JavaScript modules passed.
- `node scripts/unit-android-refresh.mjs`: all 28 checks passed.
- `node scripts/e2e-android-production.mjs`: passed on the installed debug APK.
  The same APK fetched controlled website versions 1, 2 and 3. Cookies and DOM
  storage persisted. Checkout deferred refresh until return to the dashboard.
- Live production URL/title checks: passed through the host's HTTPS client.
- Direct live HTTPS inside the emulator: blocked by its certificate trust
  error (`ERR_CERT_AUTHORITY_INVALID`). The app displayed the secure-connection
  error and Retry. TLS checks were not disabled. A real two-deployment device
  test and live Firebase/payment/upload tests remain unverified in this environment.
- Deployment/Android JSON parsing and `git diff --check`: passed.

## Rollout

Push these web changes to the existing production branch and wait for the
production deployment at the stable URL. The repository documents `main` as
the automatic production branch; the Vercel Git integration is configured
outside this repository and was not independently inspected or changed.

Install the updated Android wrapper once to replace the old embedded URL.
The debug APK is `twa/app/build/outputs/apk/debug/app-debug.apk`; a signed store
release was not produced. Normal web deployments at the same origin subsequently
need no APK release. Cold starts fetch the hosted app, and foreground refresh
occurs when safe; returning from the file picker or an external app is exempt.

No cookies, DOM storage, IndexedDB or Firebase auth storage are cleared. Moving
from the old domain to the corrected domain may require signing in once because
sessions are origin-scoped. Subsequent sessions at the new origin are retained.
