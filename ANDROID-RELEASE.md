# Android Release Guide — Google Play Store

How to build a signed release of the Qvrix GlowOS Android app and publish it on
Google Play.

| Item | Value |
| --- | --- |
| Android project | `twa/` (open this folder in Android Studio, not the repo root) |
| Application ID | `com.luxeglow.crm` (permanent once published) |
| App name | Qvrix GlowOS |
| Version config | `twa/app/build.gradle` → `versionCode` / `versionName` |
| Min / target SDK | 23 / 36 |
| Release output | Android App Bundle (`.aab`) — Play does not accept APKs for new apps |
| Hosted web app | `https://spacrm-two.vercel.app/` (default) |

## How the app works

The Android app is a thin native shell. It hosts a WebView that loads the
hosted web app. It does **not** package the web app's code (see
`twa/README.md`). As a result:

- **Web-only changes** (UI, bugs, features in `public/`) go live when the site
  is deployed. They need **no** new Android build or Play release.
- **A new Android release is needed only** when something in `twa/` changes:
  app name, icon, permissions, production URL, SDK levels, or native code.

---

## 1. One-time setup

### 1.1 Tools

- **Android Studio** (current stable). Its bundled JDK
  (`C:\Program Files\Android\Android Studio\jbr`) is the JDK used for builds.
- **Android SDK Platform 36** — install it from **Tools → SDK Manager**.
  Gradle also installs it automatically on the first build.
- A **Google Play Console** developer account (one-time US$25 fee) at
  <https://play.google.com/console>.

### 1.2 Upload keystore

Play requires every release to be signed with your **upload key**. Play App
Signing then re-signs the app with Google's **app signing key**.

> **Never commit a keystore or its passwords.** `twa/.gitignore` already
> excludes `keys/`, `*.jks` and `*.keystore`. Back up the keystore file and its
> passwords to a password manager or other secure storage outside this PC. If
> they are lost, you cannot publish updates until Google resets the upload key.

The Gradle release config expects:

| Setting | Value |
| --- | --- |
| Keystore file | `twa/keys/luxeglow-release.keystore` |
| Key alias | `luxeglow` |
| Store password | `KEYSTORE_PASSWORD` environment variable |
| Key password | `KEY_PASSWORD` environment variable |

**Which keystore to use:**

- **App already on Play.** Use the same upload key as before. To check it,
  open Play Console → app → **Test and release → App integrity → App signing**
  and compare the **Upload key certificate** SHA-1 with the output of:

  ```powershell
  & 'C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe' -list -v -keystore <path-to-keystore>
  ```

  If the key is lost, use **Request upload key reset** on that same page.
- **New app.** Use an existing keystore, such as
  `C:\Users\<you>\.android-keystores\qvrix-release.jks`, or create a new one in
  the Android Studio wizard (section 3, step 3). If its alias isn't `luxeglow`,
  update `keyAlias` in `twa/app/build.gradle` before building from the command
  line. The Android Studio wizard lets you enter the alias directly.

To create a keystore from the command line instead:

```powershell
mkdir twa\keys
& 'C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe' -genkeypair -v `
  -keystore twa\keys\luxeglow-release.keystore -alias luxeglow `
  -keyalg RSA -keysize 2048 -validity 10000
```

---

## 2. Pre-release checklist

- [ ] **Web app deployed and verified** at the production URL. The Android app
      shows whatever is live there.
- [ ] **Version bumped** in `twa/app/build.gradle`. `versionCode` must be higher
      than every build ever uploaded to Play, in any track:

      ```gradle
      versionCode 5          // +1 for every upload
      versionName "1.0.4"    // shown to users
      ```

- [ ] **Production URL is correct.** The build uses `SPACRM_PRODUCTION_URL`, or
      `-PspacrmProductionUrl=...`, and falls back to
      `https://spacrm-two.vercel.app/`. It must be HTTPS or the build fails.
      To override it in Android Studio, set the environment variable **before**
      launching Studio:

      ```powershell
      [Environment]::SetEnvironmentVariable('SPACRM_PRODUCTION_URL', 'https://your-domain/', 'User')
      ```

- [ ] **`twa/app/google-services.json`** matches the production Firebase
      project, if Firebase features are used natively.
- [ ] **Web tests pass:** `npm test` from the repo root.

---

## 3. Build the signed bundle — Android Studio

1. **File → Open** → select `SpaCRM\twa`. Wait for **Gradle sync** to finish.
   If prompted, install missing SDK components.
2. **Build → Generate Signed App Bundle or APK…** → choose **Android App
   Bundle** → **Next**.
3. Fill in the key details:
   - **Key store path:** choose your keystore (`.jks` or `.keystore`), or click
     **Create new…** for a new app.
   - **Key store password**, **Key alias**, **Key password**.
   - **Remember passwords** is optional. It stores them in Studio's password
     safe, not in the project.
   - **Export encrypted key**: leave unticked unless Play asks you to upload
     the key during Play App Signing enrolment.
4. **Next** → **Build Variants:** choose **release** → **Create**.
5. When the "Generate Signed Bundle" notification appears, click **locate**.
   The output is:

   ```
   twa\app\release\app-release.aab
   ```

   It may instead be under `twa\app\build\outputs\bundle\release\`.

## 3b. Build the signed bundle — command line (alternative)

Copy your keystore to `twa\keys\luxeglow-release.keystore`, then run:

```powershell
cd twa
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:KEYSTORE_PASSWORD = '<store password>'
$env:KEY_PASSWORD = '<key password>'
.\gradlew.bat clean :app:bundleRelease
```

Output: `twa\app\build\outputs\bundle\release\app-release.aab`

Close the terminal afterwards so the passwords don't stay in the session.

### Optional: test the release on a device

An `.aab` cannot be installed directly. Either build a signed APK with
`.\gradlew.bat :app:assembleRelease` and install it:

```powershell
adb install -r app\build\outputs\apk\release\app-release.apk
```

Or use Play's **Internal testing** track (section 4.2), which is the most
realistic test.

Check that the app opens, login works, booking and billing load, and file
upload and download work. Also check that the offline screen appears in
airplane mode.

---

## 4. Publish on Google Play

### 4.1 First release only — create the app

1. Play Console → **Create app**.
   - App name: **Qvrix GlowOS**
   - Default language
   - **App** (not Game)
   - **Free** or **Paid** — this cannot be changed from Free to Paid later.
   - Accept the declarations.
2. Under **Grow users → Store presence → Main store listing**, add:
   - Short description (up to 80 characters) and full description (up to 4000)
   - **App icon** 512×512 PNG (`twa/store_icon.png`)
   - **Feature graphic** 1024×500 PNG/JPG
   - **Phone screenshots** — at least 2. Optionally add 7" and 10" tablet
     screenshots.
3. Complete **Policy and programs → App content**:
   - **Privacy policy URL** (required)
   - **App access**: give reviewers a demo login. The app is behind sign-in, so
     without one the review will be rejected.
   - **Ads**: declare whether the app shows ads.
   - **Content rating** questionnaire
   - **Target audience** (18+ business users)
   - **Data safety**: declare collected data (account email, customer names
     and phone numbers, payment info handled by Razorpay, etc.)
   - **Financial features** declaration (the app handles billing and payments)
   - **Government apps**: No
4. **App signing:** on the first upload, accept **Play App Signing** with a
   Google-generated key (recommended).

> **New personal developer accounts:** Google requires a **closed test with at
> least 12 testers who stay opted in for 14 continuous days** before you can
> apply for Production access. Plan for this before your launch date.

### 4.2 Upload a release

1. **Test and release** → choose a track:
   - **Internal testing** — up to 100 testers, available within minutes.
     Recommended first.
   - **Closed testing** — invite testers by list or Google Group.
   - **Production** — public.
2. **Create new release** → upload `app-release.aab`.
3. **Release name** defaults to `versionCode (versionName)`. Add **release
   notes** for each language.
4. **Next** → fix any errors shown. Warnings such as "no deobfuscation file"
   are fine. → **Save** → **Send for review** / **Start rollout**.
5. For production, a **staged rollout** (for example 20% → 50% → 100%) is
   safer. Increase it under **Production → Releases**.

Review usually takes a few hours to a few days. The first review is often
longer.

### 4.3 Promote a tested build

A build that has passed internal or closed testing can be promoted without
rebuilding: open the release → **Promote release → Production**.

---

## 5. Digital Asset Links (`public/.well-known/assetlinks.json`)

This file links the website to the Android app. It is served from
`https://<domain>/.well-known/assetlinks.json`. It must list the **SHA-256 of
Play's app signing key**, not just your upload key.

1. Play Console → **Test and release → App integrity → App signing** → copy the
   **App signing key certificate SHA-256**.
2. Add it to `sha256_cert_fingerprints` in `public/.well-known/assetlinks.json`.
   Keep the upload-key fingerprint too if you sideload builds signed with it.
3. Deploy the web app and check
   `https://<domain>/.well-known/assetlinks.json` in a browser.

Play Console also shows a ready-made `assetlinks.json` snippet on the same
page.

---

## 6. Updating the app later

| Change | What to do |
| --- | --- |
| Web app only (`public/`, `api/`) | Deploy the site. **No Play release.** |
| Anything in `twa/` | Bump `versionCode`/`versionName` → build signed `.aab` (section 3) → upload (section 4.2) |
| Production domain change | Rebuild with the new `SPACRM_PRODUCTION_URL`, update `assetlinks.json` on the new domain, release |

---

## 7. Troubleshooting

| Problem | Fix |
| --- | --- |
| `Keystore file ... luxeglow-release.keystore not found` (command line) | Copy the keystore to `twa/keys/` or use the Android Studio wizard, which uses the keystore you pick. |
| `Keystore was tampered with, or password was incorrect` | Wrong store password. Check `KEYSTORE_PASSWORD`. |
| `Cannot recover key` | Wrong key password or alias. Check `KEY_PASSWORD` and `keyAlias`. |
| Play: "Version code N has already been used" | Increase `versionCode` and rebuild. |
| Play: "signed with the wrong key" | Sign with the original upload key (section 1.2) or request an upload key reset. |
| `Qvrix GlowOS production URL must use HTTPS` | `SPACRM_PRODUCTION_URL` is not `https://…`. |
| Gradle sync: "SDK location not found" | Open the project in Android Studio once (it creates `twa/local.properties`) or set `ANDROID_HOME`. |
| `Unsupported class file major version` / JDK errors | Use Android Studio's bundled JDK: **Settings → Build → Gradle → Gradle JDK → jbr**. |
| App shows an old version of the site | Clear app data/cache on the device. The web deployment controls content, not the APK. |
