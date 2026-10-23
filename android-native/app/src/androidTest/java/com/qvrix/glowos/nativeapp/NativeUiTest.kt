package com.qvrix.glowos.nativeapp

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.qvrix.glowos.nativeapp.online.*
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.tasks.await
import org.junit.*
import org.junit.Assert.*
import java.io.File
import java.io.FileOutputStream

class NativeUiTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()
    private fun capture(name: String) {
        ui.waitForIdle()
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        Thread.sleep(500) // SurfaceFlinger presents after Compose's semantic tree is idle.
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        FileOutputStream(File(ui.activity.getExternalFilesDir(null), "$name.png")).use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }
    @Test fun nativeScreensRenderNavigateAndBack() = runBlocking {
        Assume.assumeTrue(BuildConfig.EMULATOR_HOST.isNotBlank())
        val app = ui.activity.application as GlowApplication
        app.auth.signOut(); ui.runOnUiThread { ui.activity.model.signOut() }; ui.waitForIdle()
        ui.onAllNodesWithText("Sign in").assertCountEquals(1); capture("native-login")
        val suffix = System.currentTimeMillis()
        app.auth.createUserWithEmailAndPassword("ui-$suffix@example.test", "Testing123!").await(); val repo = app.repository; repo.ensureProfile()
        var s = repo.load(); repo.saveBranch(s, json("name" to "Qvrix verification salon", "phone" to "9876543210", "address" to "Test branch", "timezone" to "Asia/Kolkata"), null)
        s = repo.load(); repo.trial(s); s = repo.load()
        repo.saveEntity(s, "customers", json("name" to "Verification client", "phone" to "9876543215", "email" to "client@example.test"), null)
        repo.saveEntity(s, "services", json("name" to "Facial", "category" to "Skin", "price" to 1000, "duration" to "30m"), null)
        repo.saveEntity(s, "staff", json("name" to "Verification stylist", "role" to "Therapist", "phone" to "9876543216"), null)
        ui.runOnUiThread { ui.activity.model.refresh() }; ui.waitUntil(60000) { ui.activity.model.snapshot != null && !ui.activity.model.busy }
        assertFalse(ui.activity.model.snapshot!!.locked)
        listOf("dashboard", "customers", "services", "staff", "appointments", "quickbill", "referrals", "subscription", "booking", "reports", "help").forEach { screen ->
            ui.runOnUiThread { ui.activity.model.navigate(screen) }; ui.waitForIdle()
            val title = mapOf("dashboard" to "Your Salon at a Glance", "customers" to "Clients", "services" to "Services", "staff" to "Staff", "appointments" to "Appointments", "quickbill" to "Quick Billing", "referrals" to "Referrals", "subscription" to "Subscription", "booking" to "Booking Link", "reports" to "Reports", "help" to "Help & tutorials").getValue(screen)
            assertTrue("Native $screen screen must be rendered", ui.onAllNodesWithText(title).fetchSemanticsNodes().isNotEmpty())
            capture("native-$screen")
        }
        ui.runOnUiThread { ui.activity.model.navigate("customers"); ui.activity.model.editor = EditorRequest("customers") }
        ui.onAllNodesWithText("Add Client").assertCountEquals(2); capture("native-client-dialog")
        InstrumentationRegistry.getInstrumentation().uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        ui.waitUntil(10000) { ui.activity.model.editor == null }
        ui.runOnUiThread { ui.activity.model.navigate("dashboard") }
        ui.waitForIdle(); assertEquals("dashboard", ui.activity.model.section)
        // App core must be Compose; provider checkout activities are outside this check.
        fun webViews(view: android.view.View): Int = (if (view is android.webkit.WebView) 1 else 0) + if (view is android.view.ViewGroup) (0 until view.childCount).sumOf { webViews(view.getChildAt(it)) } else 0
        ui.runOnUiThread { assertEquals(0, webViews(ui.activity.window.decorView)) }
        ui.runOnUiThread { ui.activity.model.signOut() }; ui.waitForIdle(); app.auth.signOut()
    }
}
