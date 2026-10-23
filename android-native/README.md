# Qvrix GlowOS native Android

The active application is Kotlin and Jetpack Compose. Its core screens do not embed a WebView. Business data is requested directly from Firestore's authenticated REST API; Firebase Auth uses the existing Firebase project. Billing providers use their native SDKs and existing server verification endpoints. No service credentials or gateway secrets are bundled.

`app/src/main/java/com/qvrix/glowos/nativeapp/` contains the native screens, ViewModel, online repository and provider integration. `archive/offline-pilot/` retains historical, excluded source. Room, the outbox and WorkManager are absent from the active app. The previous `twa/` app and desktop source are preserved.

Build on Windows with the installed Android Studio JBR and SDK:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
cd C:\Projects\QvrixGlowOS\SpaCRM\android-native
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest :app:lintDebug --console=plain
```

APK: `app/build/outputs/apk/debug/app-debug.apk`. It is debug-signed with application ID `com.luxeglow.crm.nativeonline`, allowing installation alongside `com.luxeglow.crm`. Release configuration retains `com.luxeglow.crm`; no production signing or replacement deployment has been performed.

Public Firebase configuration is read from the existing `twa/app/google-services.json`. Override using Gradle properties `firebaseProjectId`, `firebaseAppId`, and `firebaseApiKey` for an isolated staging project. `nativeApiUrl` defaults to `https://spacrm-two.vercel.app` and must be HTTPS. These are public application identifiers, never service account keys.

Implemented areas include email sign-in/sign-up/reset, salon setup, owner/admin navigation, dashboard periods, clients/history, services, staff/attendance, appointments/slot locks, walk-in billing, client discounts, split referral-wallet payments, receipts/printing, referral qualification and reversals, loyalty, branch switching, subscription catalog/trial/history, Play user-choice billing/Razorpay callbacks, plan administration, booking settings/public catalog/link/QR, tutorials and period reports. Forms use server data and confirmed writes. Errors and interrupted confirmations are surfaced; no offline business writes or automatic replay are available.

The logo and Plus Jakarta Sans font are reused; Lucide path data and catalog/tutorial/default settings are derived from the unchanged web source. `node scripts/generate-reference-assets.mjs` regenerates those assets from this directory. Font and icon license notices are retained in app assets.

For isolated Firebase tests, start the existing `firebase.trial.json` emulators from the repository root with project `demo-spacrm-trial` (Auth 9098, Firestore 8085). Put the JBR `bin` directory on PATH for Firebase CLI. Build/run native instrumentation using:

```powershell
.\gradlew.bat :app:connectedDebugAndroidTest '-PfirebaseProjectId=demo-spacrm-trial' '-PfirebaseApiKey=fake-api-key' '-PfirebaseAppId=1:123456789:android:123456789' '-PfirebaseEmulatorHost=10.0.2.2' --console=plain
```

The emulator setting is debug-only and rejects non-demo project IDs. Local HTTP is allowed only for explicit loopback/emulator host names in debug; production traffic retains TLS. Rebuild without emulator properties to produce the normal APK. Instrumentation seeds disposable emulator accounts and records, never production.

Razorpay's checkout/core dependencies share a vendor namespace; `android.uniquePackageNames=false` is required with AGP 9. See [AGP release notes](https://developer.android.com/build/releases/agp-9-0-0-release-notes). API 37 UI tests explicitly use Espresso 3.7.0 to avoid an older transitive dependency's removed InputManager API; see [AndroidX Test releases](https://developer.android.com/jetpack/androidx/releases/test).

The execution report is [NATIVE-MIGRATION-STATUS.md](../NATIVE-MIGRATION-STATUS.md). Production feature parity is not certified: authenticated production data, real provider purchases/restoration/webhooks, admin accounts, large tenants, additional Android versions and final visual acceptance require follow-up verification. At execution time the configured production `play-prepare` endpoint returned HTTP 404. Keep the existing wrapper as fallback until those release checks pass.
