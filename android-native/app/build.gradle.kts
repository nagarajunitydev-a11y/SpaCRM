import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val existingConfig = JsonSlurper().parse(rootProject.file("../twa/app/google-services.json")) as Map<*, *>
val existingClient = (existingConfig["client"] as List<*>).first() as Map<*, *>
val clientInfo = existingClient["client_info"] as Map<*, *>
val projectInfo = existingConfig["project_info"] as Map<*, *>
val publicApiKey = ((existingClient["api_key"] as List<*>).first() as Map<*, *>)["current_key"].toString()

android {
    namespace = "com.qvrix.glowos.nativeapp"
    compileSdk = 36
    defaultConfig {
        buildConfigField("String", "EMULATOR_HOST", "\"${providers.gradleProperty("firebaseEmulatorHost").orElse("").get()}\"")
        // Deliberately separate from the current production wrapper during pilot.
        applicationId = "com.luxeglow.crm"
        minSdk = 23
        targetSdk = 36
        versionCode = 7
        versionName = "2.0.0-native"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        val apiUrl = providers.gradleProperty("nativeApiUrl").orElse("https://spacrm-two.vercel.app").get()
        require(apiUrl.startsWith("https://") && !apiUrl.contains('"') && !apiUrl.contains('\\')) { "Native API URL must use HTTPS" }
        buildConfigField("String", "API_URL", "\"${apiUrl.trimEnd('/')}\"")
        // Firebase app configuration is public. Override these for an isolated
        // staging Firebase project; never put service account credentials here.
        buildConfigField("String", "FIREBASE_API_KEY", "\"${providers.gradleProperty("firebaseApiKey").orElse(publicApiKey).get()}\"")
        buildConfigField("String", "FIREBASE_APP_ID", "\"${providers.gradleProperty("firebaseAppId").orElse(clientInfo["mobilesdk_app_id"].toString()).get()}\"")
        buildConfigField("String", "FIREBASE_PROJECT_ID", "\"${providers.gradleProperty("firebaseProjectId").orElse(projectInfo["project_id"].toString()).get()}\"")
    }
    buildTypes {
        debug { applicationIdSuffix = ".nativeonline"; versionNameSuffix = "-debug" }
        release { isMinifyEnabled = false }
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17; isCoreLibraryDesugaringEnabled = true }
}
dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
    implementation(platform("androidx.compose:compose-bom:2026.02.01"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation(platform("com.google.firebase:firebase-bom:34.10.0"))
    implementation("com.google.firebase:firebase-auth")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.10.2")
    implementation("com.android.billingclient:billing:8.0.0")
    implementation("com.razorpay:checkout:1.6.40")
    implementation("com.google.zxing:core:3.5.3")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.02.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
}
