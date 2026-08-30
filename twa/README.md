# SPACRM Android wrapper

This Android project is deliberately a thin native shell. It ships a WebView and
native loading, offline, upload, download, and navigation handling only; it does
not package the SPACRM web application or its business logic.

## Production URL

The application URL is injected at build time. It must be HTTPS:

```powershell
$env:SPACRM_PRODUCTION_URL = 'https://spacrm-ishari.vercel.app/'
.\gradlew.bat :app:assembleRelease
```

Alternatively pass `-PspacrmProductionUrl=https://...` to Gradle. The supplied
value is compiled into `BuildConfig`, so release builds remain deterministic and
do not rely on a mutable remote configuration channel. Updating the hosted web
application is immediately visible the next time the app loads it; it does not
require another APK build.

## Release signing

The existing release signing configuration reads `KEYSTORE_PASSWORD` and
`KEY_PASSWORD` from the build environment. Keep keystores and their password
files out of source control.

## Validation

Use a physical device or emulator with Android Platform Tools available:

```powershell
adb install -r app\build\outputs\apk\release\app-release.apk
```

The WebView only permits HTTPS navigation to the configured SPACRM origin.
