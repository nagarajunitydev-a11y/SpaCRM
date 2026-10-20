# Qvrix GlowOS Android wrapper

This Android project is deliberately a thin native shell. It ships a WebView and
native loading, offline, upload, download, and navigation handling only; it does
not package the Qvrix GlowOS web application or its business logic.

## Production URL

The application URL is injected at build time. It must be HTTPS:

```powershell
$env:SPACRM_PRODUCTION_URL = 'https://spacrm-two.vercel.app/'
.\gradlew.bat :app:assembleRelease
```

Alternatively pass `-PspacrmProductionUrl=https://...` to Gradle. The supplied
value is compiled into `BuildConfig`, so release builds remain deterministic and
do not rely on a mutable remote configuration channel. Updating the hosted web
application is immediately visible the next time the app loads it; it does not
require another APK build.

The default is the stable Vercel production URL `https://spacrm-two.vercel.app/`,
also used by the web app's production Firebase auth configuration. The previous
`spacrm-ishari.vercel.app` address serves an older application. Do not use a
commit-specific preview URL or localhost in a release build. Remove any stale
`SPACRM_PRODUCTION_URL` environment override before building.

Push to the repository's production branch (the repository documents `main`),
wait for Vercel's production deployment to succeed, then open/reopen the app.
The repository contains Vercel configuration; the Git integration and production
branch must remain enabled in the existing Vercel project settings.

Cold starts load the hosted entry point. Returning from the background refreshes
an idle login/dashboard screen. Refresh waits until normal navigation returns
to an idle landing screen when a form, modal, checkout, other tab, or tutorial
is active. Returning from a file picker or an external/payment app does not
trigger a refresh. Browser/PWA offline behavior is retained.

The WebView bypasses its HTTP cache; the Vercel configuration sends `no-store`
for the root entry point, HTML, JavaScript and manifest once deployed, and
`platform=android` disables new PWA registrations.
Existing worker registrations and shell caches are removed once per origin,
with completion recorded only after cleanup succeeds. Cookies, DOM storage,
IndexedDB and Firebase sessions are not cleared.

Install the updated APK once to change the old embedded URL and native behavior.
Subsequent website deployments at this same production address need no new APK.
Moving from the old domain may require signing in once because browser auth
storage is scoped to its origin; subsequent sessions on the new domain persist.

## Release signing

For the full build and Google Play publishing procedure, see
[`ANDROID-RELEASE.md`](../ANDROID-RELEASE.md) in the repository root.

The existing release signing configuration reads `KEYSTORE_PASSWORD` and
`KEY_PASSWORD` from the build environment. Keep keystores and their password
files out of source control.

## Validation

Use a physical device or emulator with Android Platform Tools available:

```powershell
adb install -r app\build\outputs\apk\release\app-release.apk
```

The WebView only permits HTTPS navigation to the configured Qvrix GlowOS origin.
External web/contact/UPI links open in an external app; uploads and back handling
continue through the existing native callbacks.

Run `node scripts/unit-android-refresh.mjs` from the repository root and
`./gradlew :app:assembleDebug :app:lintDebug` from this directory for local checks.
With the debug APK running on an emulator/device, run
`node scripts/e2e-android-production.mjs` to verify native background/reopen
refresh against controlled responses at the configured production origin. This
checks multiple website versions with the same APK, cookie/DOM-storage retention,
and deferral during checkout. It does not publish or alter the live website.

For each production deployment, confirm the deployment succeeded at the stable
URL, open the Android app and check the changed text, background it, deploy a
second visible text change, and reopen it at the dashboard. Confirm the second
change appears, authentication persists, and no update interrupts checkout or
an unfinished form. Test Retry offline/online and returning from the file picker
and payment app on a device. Do not clear app data to perform this check.
