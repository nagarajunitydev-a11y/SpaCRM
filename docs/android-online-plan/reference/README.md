# Existing UI reference evidence

Captured 22 October 2026 for the revised planning pass. These are references to the existing product, not proposed native designs or proof of completed native functionality.

- `production-desktop-login.png`: actual production guest page in desktop Chrome, 1440×1000.
- `production-android-query-login.png`: actual production guest page with `?platform=android`, mobile Chrome viewport 412×915. This is not a WebView capture.
- `source-*-desktop.png` / `source-*-mobile.png`: actual unchanged local web application, existing demo signin/seed data, correct UTF-8/font loading, desktop/mobile viewports. The existing guide-seen preference was set in the disposable browser profile to expose unobstructed screens. No Firebase authentication/data operations were used for these reference renders.
- `source-guided-tour-mobile.png`: existing guided-tour overlay in the same local demo app. The transient demo-signin toast is also visible; its wording is not evidence of Firebase authentication.
- `android-webview-tls-error.png`: actual installed existing wrapper `com.luxeglow.crm`, version 1.0.5/code 6, API 37 emulator at 1080×2400. It shows the secure-connection failure. This does not establish what authenticated production WebView screens look like. TLS was not bypassed and no app build/source change was performed.
- `inspection.json`: source of each screenshot, viewport, visible labels and observed font/encoding where available. Localhost ports are inspection artifacts, not application configuration.
- `protected-source-baseline.json`: SHA-256 hashes of implementation/configuration files at the beginning of this planning pass, excluding generated native/Gradle output. This includes previous uncommitted pilot additions; it is not a claim that the repository was clean against HEAD.
- `protected-source-verification.json`: comparison of 207 baseline files; no implementation/configuration changes or missing files. The native README's planning/status notice is the single allowed documentation change within that baseline.

Authenticated real-backend screenshots and complete state/action baselines remain required before implementing/accepting the corresponding native features. Demo images are only visual references. Desktop/native production data was not modified and no real purchase was made.
