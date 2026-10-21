# Android startup loading screen

The startup overlay is native, in `LauncherActivity`; the hosted web application
initially contains an empty `#app`. There is no added web splash, activity, timer
to prolong startup, or change to the login screen.

`LoadingScreenView` draws the existing official transparent `public/logo.png`
(copied unchanged to `drawable-nodpi/glowos_logo.png`), the product name, subtle
navy/purple/magenta gradients. It is a static branded splash: there is no
progress bar, spinner, "Loading…" caption or other loading animation. The
composition scales to the available width and height without cropping the logo.
Drawing resources are reused.
The obsolete full-screen PNG with its baked-in progress bar was removed.
Android 12+ also has an existing system launch splash. Its theme now uses the
same navy and transparent official logo instead of the launcher icon's white
background; the original full-screen theme is retained as its parent. No system
splash retention or extra splash activity is added.

The existing overlay stays visible across the one-time PWA cache migration and
reload. After HTML finishes loading, native code checks for rendered `#app`
content and uses WebView's visual-state callback before a 180 ms fade. It does
not wait for an animation cycle or impose a minimum display duration. Navigation
generations invalidate stale callbacks. The existing 30-second initialization
timeout remains active until content is drawable, including when JavaScript
initialization stalls after HTML loads. Errors hide the splash and offer native
Retry; late readiness callbacks cannot dismiss an error.

Firebase/authentication code, cookies, IndexedDB, DOM storage, login markup,
foreground refresh rules, external links, uploads, payments, download handling
and Back handling were not changed. Production URL remains
`https://spacrm-two.vercel.app/`.

## Files

- `twa/app/src/main/java/com/luxeglow/crm/LauncherActivity.java`: overlay lifecycle,
  rendered-content readiness and transition/error handling.
- `twa/app/src/main/java/com/luxeglow/crm/LoadingScreenView.java`: native design.
- `twa/app/src/main/res/drawable-nodpi/glowos_logo.png`: exact existing logo copy.
- `twa/app/src/main/res/drawable-nodpi/loading_screen.png`: removed obsolete image.
- `twa/app/src/main/AndroidManifest.xml`, `twa/app/src/main/res/values/styles.xml`
  and `twa/app/src/main/res/values-v31/styles.xml`: consistent system launch theme.
- `twa/app/src/main/res/drawable-anydpi/glowos_splash_icon.xml`: inset for the
  existing logo to prevent system splash icon masking from cropping its tips.
- `scripts/e2e-android-loading.mjs`: native visibility, migration, delayed-content,
  session-storage, network-error, retry and stalled-initialization checks.
- `scripts/e2e-android-production.mjs`: fixture now supplies the same `#app`
  container as the real site; simulated worker/cache state is explicitly empty.
- This verification report.

## Validation environment

Android API 37 emulator; no physical phone connected. Debug and minified release
APK builds and `:app:lintRelease` pass. Remaining lint warnings concern existing
orientation/icon/resources and pre-existing hard-coded native UI text; the new
drawing code has no draw-allocation warnings. Official logo hashes match.
`apksigner verify` passes; release-mode APK is signed with the previously
authorized Android test key, not the production keystore.

The emulator rejects the production site's certificate chain. TLS validation is
preserved. Controlled HTTPS responses supplied through debug WebView DevTools
exercise native transitions without modifying production or bypassing TLS.
Login/dashboard fixtures verify overlay behavior and storage retention; they do
not constitute a live Firebase sign-in or complete payment/upload regression.
The original web login and authentication files are unchanged.

Passed loading checks: first-install migration, subsequent loads, delayed shell
rendering, login/dashboard fixture transitions, storage/cookie retention,
migration reload coverage, connection failure, native Retry recovery, stalled
initialization timeout, and protection against late callbacks hiding errors.
Installed release APK offline check passes: immediate offline message with Retry
and no stuck loading overlay. Emulator network settings were restored afterward.
The installed minified release's native logo/name/indicator design was also
visually confirmed from a cold-start screenshot under emulated network latency
(`twa/app/build/release-loading-preview.png`). The secure-connection error and
Retry remain available when the emulator rejects the production certificate.
Layout was visually checked at 1080×2400 and 720×1280; logo, title and indicator
remain proportional and within the screen. Display-size overrides were reset.

Run `node scripts/e2e-android-loading.mjs` against the running debug APK.
`ANDROID_TEST_APP_ID` can target an isolated installation (the verification used
`com.luxeglow.crm.loadingtest` with the same native code, keeping the existing
app's data intact). `ANDROID_TEST_FIRST_LAUNCH=1` additionally checks the first
cache-migration reload on a fresh installation. Fixtures only use test storage
keys, removed on completion.
`ANDROID_LOADING_PREVIEW_ONLY=1` captures the initial loading composition without
running the remaining scenarios, useful for checking alternate display sizes.

The foreground-refresh integration check passes: the same installed APK sees
successive controlled deployments, retains cookies/local storage, defers refresh
during checkout, and refreshes upon return to the dashboard. All 28 Android
refresh unit checks pass. JavaScript syntax and `git diff --check` pass.

Reference: [WebView visual-state callback](https://developer.android.com/reference/android/webkit/WebView#postVisualStateCallback(long,%20android.webkit.WebView.VisualStateCallback)).

## Update: static splash

The animated indeterminate indicator and "Loading…" caption were later removed
from `LoadingScreenView`; the overlay now shows only the official logo and the
"Qvrix GlowOS" name on the brand background. Screenshots referenced above that
show the indicator predate this change.
