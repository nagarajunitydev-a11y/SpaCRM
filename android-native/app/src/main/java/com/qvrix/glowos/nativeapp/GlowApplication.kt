package com.qvrix.glowos.nativeapp

import android.app.Application
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.qvrix.glowos.nativeapp.online.*

class GlowApplication : Application() {
    val firebase by lazy {
        FirebaseApp.getApps(this).firstOrNull { it.name == "native-online" } ?: FirebaseApp.initializeApp(this,
            FirebaseOptions.Builder().setApiKey(BuildConfig.FIREBASE_API_KEY).setApplicationId(BuildConfig.FIREBASE_APP_ID)
                .setProjectId(BuildConfig.FIREBASE_PROJECT_ID).build(), "native-online")
    }
    val auth: FirebaseAuth by lazy { FirebaseAuth.getInstance(firebase).also {
        if (BuildConfig.DEBUG && BuildConfig.EMULATOR_HOST.isNotBlank()) {
            check(BuildConfig.FIREBASE_PROJECT_ID.startsWith("demo-")) { "Emulators require a disposable demo project" }
            it.useEmulator(BuildConfig.EMULATOR_HOST, 9098)
        }
    } }
    val cloud by lazy { FirestoreOnline(auth) }
    val repository by lazy { GlowRepository(this, auth, cloud) }
}
