package com.qvrix.glowos.nativeapp

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.qvrix.glowos.nativeapp.online.*
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.tasks.await
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Uses disposable Firebase emulators with the repository's unchanged production rules. */
@RunWith(AndroidJUnit4::class)
class OnlineIntegrationTest {
    private val app = ApplicationProvider.getApplicationContext<GlowApplication>()
    @Test fun sourceCalculationParity() {
        val fixtures = JSONArray(app.assets.open("calculation-fixtures.json").bufferedReader().use { it.readText() })
        for (i in 0 until fixtures.length()) { val f = fixtures.getJSONObject(i); assertEquals(f.toString(), f.num("expected"), BusinessRules.discount(f.str("type"), f.num("value"), f.num("gross")), .000001) }
        assertEquals(90, BusinessRules.duration("1 hr 30 mins")); assertEquals(90, BusinessRules.duration("1:30")); assertEquals(0, BusinessRules.duration("invalid"))
        assertEquals("+919876543210", BusinessRules.phone("9876543210"))
        assertEquals(0, BusinessRules.duration("unknown 30m")); assertEquals(0, BusinessRules.duration("NaN"))
    }
    private fun fixture(path: String, data: org.json.JSONObject) {
        check(BuildConfig.EMULATOR_HOST.isNotBlank() && BuildConfig.FIREBASE_PROJECT_ID.startsWith("demo-"))
        val connection = java.net.URI("http://${BuildConfig.EMULATOR_HOST}:8085/v1/projects/${BuildConfig.FIREBASE_PROJECT_ID}/databases/(default)/documents/$path").toURL().openConnection() as java.net.HttpURLConnection
        try {
            connection.requestMethod = "PATCH"; connection.doOutput = true; connection.setRequestProperty("Authorization", "Bearer owner"); connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(json("fields" to FirestoreCodec.fields(data)).toString().toByteArray()) }
            check(connection.responseCode in 200..299) { "Emulator fixture failed." }
        } finally { connection.disconnect() }
    }
    @Test fun adminCatalogAndCrossTenantHistory() = runBlocking {
        assumeTrue(BuildConfig.EMULATOR_HOST.isNotBlank())
        app.auth.signOut(); app.auth.createUserWithEmailAndPassword("admin-${UUID.randomUUID()}@example.test", "Testing123!").await(); app.repository.ensureProfile()
        val uid = app.auth.currentUser!!.uid
        fixture("users/$uid", json("role" to "super_admin", "email" to "admin@example.test"))
        fixture("subscriptions/$uid/payments/test", json("planId" to "basic", "status" to "FAILED", "amount" to 399, "orderId" to "test-order"))
        fixture("subscriptions/$uid/events/test", json("type" to "PAYMENT_FAILED", "detail" to "Test verification", "at" to FirestoreCodec.timestamp(System.currentTimeMillis())))
        val s = app.repository.load(); assertTrue(s.admin); assertTrue(s.adminPayments.any { it.str("orderId") == "test-order" }); assertTrue(s.adminEvents.any { it.str("type") == "PAYMENT_FAILED" })
        app.cloud.save("plans/basic", app.repository.catalog.getJSONObject("plans").getJSONObject("basic")); assertEquals(399.0, app.cloud.get("plans/basic")!!.num("priceMonthly"), .001)
        val forbidden = runCatching { app.cloud.save("subscriptions/$uid/payments/test", json("status" to "SUCCESS")) }.exceptionOrNull()
        assertTrue("Even admins cannot forge provider payments", forbidden is CloudFailure && forbidden.code == "PERMISSION_DENIED")
        app.auth.signOut()
    }
    @Test fun realAuthRulesAndBusinessWorkflow() = runBlocking {
        assumeTrue("Emulator configuration is required; production is never seeded.", BuildConfig.EMULATOR_HOST.isNotBlank() && BuildConfig.FIREBASE_PROJECT_ID.startsWith("demo-"))
        val repo = app.repository; val cloud = app.cloud; val suffix = UUID.randomUUID().toString().take(8)
        app.auth.signOut()
        app.auth.createUserWithEmailAndPassword("native-$suffix@example.test", "Testing123!").await(); repo.ensureProfile()
        var s = repo.load()
        repo.saveBranch(s, json("name" to "Native verification $suffix", "phone" to "+919876543210", "address" to "Emulator test salon", "timezone" to "Asia/Kolkata"), null)
        s = repo.load(); assertTrue(s.locked)
        assertTrue(runCatching { repo.saveEntity(s, "customers", json("name" to "Blocked", "phone" to "9876543211"), null) }.isFailure)
        repo.trial(s); s = repo.load(); assertFalse(s.locked); assertTrue(s.can("billing"))
        val staffId = repo.saveEntity(s, "staff", json("name" to "Stylist", "role" to "Therapist", "phone" to "9876543212"), null)
        repo.saveEntity(s, "services", json("name" to "Facial", "category" to "Skin", "price" to 1000, "duration" to "15m"), null)
        val referrerId = repo.saveEntity(s, "customers", json("name" to "Referrer", "phone" to "9876543213", "email" to ""), null)
        val clientId = repo.saveEntity(s, "customers", json("name" to "Client", "phone" to "9876543214", "email" to ""), null)
        s = repo.load()
        val referrer = s.rows("customers").first { it.id == referrerId }; val client = s.rows("customers").first { it.id == clientId }
        val code = repo.referralCode(s, referrer); repo.linkReferral(s, client, code)
        val date = BusinessRules.today()
        val appointment = json("customerId" to clientId, "staffName" to "Stylist", "serviceName" to "Facial", "services" to JSONArray().put(json("name" to "Facial", "price" to 1000, "duration" to "15m")), "date" to date, "time" to "12:00", "status" to "Confirmed", "amount" to 1000)
        val id = repo.appointment(s, appointment, null)
        assertTrue("Double booking must fail", runCatching { repo.appointment(s, appointment, null) }.isFailure)
        val paid = repo.collect(s, id, 1000.0, "percentage", 10.0, 0.0, "cash", "")
        assertTrue(paid.data.getBoolean("paid")); assertEquals(900.0, paid.num("amountDue"), .001)
        val duplicate = repo.collect(s, id, 1000.0, "percentage", 10.0, 0.0, "cash", "")
        assertEquals(paid.num("amountDue"), duplicate.num("amountDue"), .001)
        s = repo.load(); assertEquals(100.0, s.rows("customers").first { it.id == referrerId }.num("walletBalance"), .001)
        val walletBill = repo.appointment(s, appointment.copyJson().put("customerId", referrerId).put("time", "13:00"), null)
        val walletReceipt = repo.collect(s, walletBill, 1000.0, "", 0.0, 50.0, "upi", "TEST-UPI")
        assertEquals(950.0, walletReceipt.num("amountDue"), .001)
        assertEquals(50.0, cloud.get(referrer.path)!!.num("walletBalance"), .001)
        repo.refund(s, walletReceipt); assertEquals(100.0, cloud.get(referrer.path)!!.num("walletBalance"), .001)
        val ledger = cloud.list("${s.base}/walletTransactions").first()
        val ledgerChange = runCatching { cloud.save(ledger.path, json("amount" to 9999)) }.exceptionOrNull()
        assertTrue("Financial ledger is immutable", ledgerChange is CloudFailure && ledgerChange.code == "PERMISSION_DENIED")
        repo.refund(s, paid); assertTrue(cloud.get(paid.path)!!.data.getBoolean("refunded")); assertEquals(0.0, cloud.get(referrer.path)!!.num("walletBalance"), .001)
        repo.saveEntity(s, "attendance", json("staffId" to staffId, "staffName" to "Stylist", "date" to date, "status" to "Present", "checkIn" to "10:00", "checkOut" to "19:00", "notes" to "Verified"), null)
        repo.saveBooking(s, s.booking.copyJson().put("enabled", true))
        assertEquals(staffId, cloud.get("${s.base}/bookingSettings/config")!!.data.objects("publicStaff").first().str("id"))
        val ownerPath = s.base
        app.auth.signOut(); app.auth.createUserWithEmailAndPassword("other-$suffix@example.test", "Testing123!").await(); repo.ensureProfile()
        val denied = runCatching { cloud.list("$ownerPath/customers") }.exceptionOrNull()
        assertTrue("Another tenant cannot read clients", denied is CloudFailure && denied.code == "PERMISSION_DENIED")
        val privilege = runCatching { cloud.save("users/${app.auth.currentUser!!.uid}", json("role" to "super_admin")) }.exceptionOrNull()
        assertTrue("Self privilege escalation must fail", privilege is CloudFailure && privilege.code == "PERMISSION_DENIED")
        app.auth.signOut()
    }
}
