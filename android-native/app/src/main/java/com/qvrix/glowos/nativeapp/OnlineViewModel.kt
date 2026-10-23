package com.qvrix.glowos.nativeapp

import android.app.Application
import androidx.compose.runtime.*
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.qvrix.glowos.nativeapp.online.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await
import org.json.JSONObject

data class EditorRequest(val type: String, val record: CloudDocument? = null)

class OnlineViewModel(application: Application) : AndroidViewModel(application) {
    val app = application as GlowApplication
    val repo get() = app.repository
    val subscriptionApi by lazy { SubscriptionApi(app.auth) }
    var snapshot by mutableStateOf<SalonSnapshot?>(null); private set
    var authenticated by mutableStateOf(app.auth.currentUser != null); private set
    var busy by mutableStateOf(false); private set
    var message by mutableStateOf(""); private set
    var error by mutableStateOf(""); private set
    var section by mutableStateOf("dashboard"); private set
    var managingSalon by mutableStateOf(false); private set
    var editor by mutableStateOf<EditorRequest?>(null)
    var profile by mutableStateOf<CloudDocument?>(null)
    var receipt by mutableStateOf<CloudDocument?>(null)
    var payment by mutableStateOf<CloudDocument?>(null)
    var checkoutPlan by mutableStateOf<JSONObject?>(null)
    var onboardingName by mutableStateOf("")
    var taxState by mutableStateOf("")
    var checkoutCycle by mutableStateOf("monthly")
    var checkoutResult by mutableStateOf<JSONObject?>(null)
    var pendingOrder by mutableStateOf<JSONObject?>(null)
    var checkoutKey: String = java.util.UUID.randomUUID().toString(); private set
    private var generation = 0
    private val lock = Mutex()
    init { if (authenticated) refresh() }

    fun launch(action: suspend () -> Unit) = viewModelScope.launch {
        if (busy) return@launch
        lock.withLock {
            busy = true; error = ""; message = ""
            try { action() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (exception: Exception) { error = exception.message ?: "The request failed. Check your connection and retry." }
            finally { busy = false }
        }
    }
    private fun verification(action: suspend () -> Unit) = viewModelScope.launch {
        lock.withLock {
            busy = true; error = ""
            try { action() } catch (e: CancellationException) { throw e }
            catch (e: Exception) { error = e.message ?: "Payment verification failed. Check payment history." }
            finally { busy = false }
        }
    }
    private suspend fun reload(branch: String? = snapshot?.branch?.id) {
        val run = generation
        val result = repo.load(branch)
        if (run == generation && app.auth.currentUser?.uid == result.uid) {
            snapshot = result; authenticated = true
            if (result.admin && !managingSalon && section == "dashboard") section = "admin_salons"
        }
    }
    fun refresh() = launch { reload() }
    fun signIn(email: String, password: String, signup: Boolean = false) = launch {
        require(email.isNotBlank() && password.length >= 6) { "Enter your email and a password of at least 6 characters." }
        if (signup) app.auth.createUserWithEmailAndPassword(email.trim(), password).await() else app.auth.signInWithEmailAndPassword(email.trim(), password).await()
        authenticated = true; repo.ensureProfile(); reload()
    }
    fun resetEmail(email: String) = launch { require(email.isNotBlank()) { "Enter your registered email." }; app.auth.sendPasswordResetEmail(email.trim()).await(); message = "If an account exists for this email, a password reset link has been sent." }
    fun confirmPassword(code: String, password: String) = launch { require(password.length >= 6); app.auth.confirmPasswordReset(code, password).await(); message = "Password updated. Sign in with your new password." }
    fun signOut() { generation++; app.auth.signOut(); snapshot = null; authenticated = false; managingSalon = false; profile = null; receipt = null; payment = null; editor = null; checkoutPlan = null; pendingOrder = null; section = "dashboard"; error = ""; message = "" }
    fun manageSalon(id: String) { managingSalon = true; switchBranch(id, "dashboard") }
    fun leaveSalon() { managingSalon = false; navigate("admin_salons") }
    fun navigate(next: String) { section = next; editor = null; profile = null; payment = null; receipt = null; error = "" }
    fun switchBranch(id: String, destination: String? = null) = launch {
        val old = snapshot ?: error("Sign in again."); check(old.branches.any { it.id == id && (old.admin || it.data.optBoolean("active", true)) })
        if (!old.admin) app.cloud.save("users/${old.uid}", json("salonId" to id))
        profile = null; receipt = null; payment = null; editor = null; generation++; snapshot = null
        reload(id); section = destination ?: if (snapshot?.admin == true && !managingSalon) "admin_salons" else "dashboard"
    }
    private suspend fun completed(label: String, work: suspend () -> Unit) {
        work(); message = label
        try { reload() } catch (e: Exception) { error = "$label Current data could not be refreshed. ${e.message}" }
    }
    fun saveEntity(type: String, input: JSONObject, original: CloudDocument?, referral: String = "") = launch {
        val s = requireNotNull(snapshot)
        completed("${if (type == "customers") "Client" else type.replaceFirstChar { it.uppercase() }} saved.") {
            val id = repo.saveEntity(s, type, input, original)
            if (type in listOf("services", "staff")) try { repo.publishCatalog(s) } catch (e: Exception) { error("Record saved. Public booking catalog could not be published. Open Booking Link and save its settings. ${e.message}") }
            if (type == "customers" && referral.isNotBlank()) {
                val customer = app.cloud.get("${s.base}/customers/$id") ?: error("Client saved but referral linking requires a refresh.")
                try { repo.linkReferral(s, customer, referral) } catch (e: Exception) { error("Client saved. Referral was not linked: ${e.message}") }
            }
            editor = null
        }
    }
    fun saveBranch(input: JSONObject, original: CloudDocument?) = launch { completed("Branch saved.") { repo.saveBranch(requireNotNull(snapshot), input, original); editor = null } }
    fun toggleBranch(doc: CloudDocument) = launch { completed("Branch updated.") { repo.activateBranch(requireNotNull(snapshot), doc) } }
    fun startTrial() = launch { completed("Your 30-day free trial has started.") { repo.trial(requireNotNull(snapshot)) } }
    fun delete(doc: CloudDocument) = launch { completed("Record updated.") { val s = requireNotNull(snapshot); repo.deleteEntity(s, doc); if (doc.path.contains("/services/") || doc.path.contains("/staff/")) repo.publishCatalog(s) } }
    fun code(customer: CloudDocument) = launch { val code = repo.referralCode(requireNotNull(snapshot), customer); reload(); profile = snapshot?.rows("customers")?.find { it.id == customer.id }; message = "Referral code: $code" }
    fun redeemPoints(customer: CloudDocument, points: Int) = launch { completed("Reward redeemed.") { repo.loyalty(requireNotNull(snapshot), customer, points) }; profile = snapshot?.rows("customers")?.find { it.id == customer.id } }
    fun link(customer: CloudDocument, code: String) = launch { completed("Referral linked.") { repo.linkReferral(requireNotNull(snapshot), customer, code) }; profile = snapshot?.rows("customers")?.find { it.id == customer.id } }
    fun saveReferralSettings(data: JSONObject) = launch { completed("Referral settings saved.") { repo.saveReferralSettings(requireNotNull(snapshot), data) } }
    fun saveBooking(data: JSONObject) = launch { completed("Booking link settings saved.") { repo.saveBooking(requireNotNull(snapshot), data) } }
    fun appointment(data: JSONObject, original: CloudDocument?) = launch { completed("Appointment saved.") { repo.appointment(requireNotNull(snapshot), data, original); editor = null } }
    fun status(doc: CloudDocument, status: String) = appointment(doc.data.copyJson().put("status", status), doc)
    fun collect(doc: CloudDocument, gross: Double, type: String, value: Double, wallet: Double, method: String, reference: String) = launch {
        val s = requireNotNull(snapshot)
        receipt = repo.collect(s, doc.id, gross, type, value, wallet, method, reference); payment = null; message = "Payment collected."
        runCatching { reload() }.onFailure { error = "Payment recorded. Refresh to load current data." }
    }
    fun quickBill(customerPhone: String, customerName: String, lines: List<JSONObject>, staff: String, discountType: String, discount: Double, wallet: Double, method: String, reference: String, billId: String) = launch {
        val s = requireNotNull(snapshot); require(lines.isNotEmpty()) { "Select at least one service." }
        require(lines.all { it.str("name").isNotBlank() && it.str("price").toDoubleOrNull()?.let { price -> price.isFinite() && price >= 0 } == true }) { "Review each service's name and price." }
        val normalized = BusinessRules.phone(customerPhone)
        var customer = s.rows("customers").find { BusinessRules.digits(it.str("phone")) == BusinessRules.digits(normalized) }
        if (customer == null) {
            require(customerName.isNotBlank()) { "Enter the new client's name." }
            val id = repo.saveEntity(s, "customers", json("name" to customerName, "phone" to normalized, "email" to ""), null, quick = true)
            customer = app.cloud.get("${s.base}/customers/$id") ?: error("Client was saved. Refresh before continuing.")
        }
        val path = "${s.base}/appointments/$billId"
        val existing = app.cloud.get(path)
        if (existing == null) {
            val zone = s.branch?.str("timezone", "Asia/Kolkata") ?: "Asia/Kolkata"
            // Walk-in billing has no future reservation or staff/time picker.
            app.cloud.save(path, json("salonId" to s.branch!!.id, "customerId" to customer.id, "customerName" to customer.str("name"), "customerPhone" to customer.str("phone"),
                "services" to org.json.JSONArray(lines.map { it.copyJson().put("price", it.num("price")) }), "serviceName" to lines.first().str("name"), "staffName" to staff.ifBlank { "Unassigned" }, "date" to BusinessRules.today(zone), "time" to BusinessRules.localTime(zone),
                "status" to "Completed", "amount" to BusinessRules.round(lines.sumOf { it.num("price") }), "paid" to false, "source" to "walk_in", "createdAt" to BusinessRules.now()), createOnly = true)
        } else check(existing.str("customerId") == customer.id) { "Bill identity changed. Refresh and check recent receipts." }
        receipt = repo.collect(s, billId, BusinessRules.round(lines.sumOf { it.num("price") }), discountType, discount, wallet, method, reference)
        message = "Walk-in billed."; reload()
    }
    fun refund(doc: CloudDocument) = launch { completed("Invoice refunded.") { repo.refund(requireNotNull(snapshot), doc); receipt = null; payment = null } }
    fun settle(doc: CloudDocument) = launch { completed("Referral settlement completed.") { repo.settleReferral(requireNotNull(snapshot), doc.id) } }
    fun selectPlan(plan: JSONObject, cycle: String) { checkoutPlan = plan; checkoutCycle = cycle; checkoutResult = null; checkoutKey = java.util.UUID.randomUUID().toString() }
    suspend fun preparePurchase(): JSONObject {
        val s = requireNotNull(snapshot); val plan = requireNotNull(checkoutPlan)
        return subscriptionApi.call("play-prepare", json("planId" to plan.str("id"), "billingCycle" to checkoutCycle, "salonId" to s.branch?.id))
    }
    fun verifyPlay(token: String) = verification { checkoutResult = subscriptionApi.call("play-verify", json("purchaseToken" to token)); reload() }
    fun verifyRazorpay(paymentId: String, orderId: String, signature: String) = verification {
        check(pendingOrder?.str("orderId") == orderId) { "Checkout identity could not be restored. Refresh payment history before retrying." }
        checkoutResult = subscriptionApi.call("verify", json("paymentId" to paymentId, "orderId" to orderId, "signature" to signature)); pendingOrder = null; reload()
    }
    fun providerFailure(message: String) { error = message }
    fun cancelAutomaticRenewal() = launch { val s = requireNotNull(snapshot); checkoutResult = subscriptionApi.call("manage-recurring", json("subscriptionId" to s.subscription?.str("gatewaySubscriptionId"), "action" to "cancel")); reload() }
    fun savePlan(id: String, patch: JSONObject) = launch {
        check(snapshot?.admin == true)
        val clean = patch.copyJson()
        listOf("priceMonthly", "priceAnnual", "maxStaff", "maxCustomers", "maxBranches").forEach { key ->
            if (clean.isNull(key) || clean.str(key).equals("unlimited", true) || clean.str(key).isBlank()) { require(key.startsWith("max")); clean.put(key, JSONObject.NULL) }
            else { val value = clean.str(key).toDoubleOrNull(); require(value != null && value.isFinite() && value >= 0) { "Enter a valid $key." }; clean.put(key, kotlin.math.round(value).toLong()) }
        }
        completed("Plan saved.") { app.cloud.save("plans/$id", clean); editor = null }
    }
    fun saveDefaultPlans() = launch { check(snapshot?.admin == true); completed("Default plans saved.") { val plans = repo.catalog.getJSONObject("plans"); plans.keys().forEach { id -> app.cloud.save("plans/$id", plans.getJSONObject(id)) } } }
    fun suspendSubscription(doc: CloudDocument) = launch {
        check(snapshot?.admin == true)
        val status = if (doc.str("status") != "SUSPENDED") "SUSPENDED" else if (FirestoreCodec.millis(doc.data.opt("currentPeriodEnd")) > System.currentTimeMillis()) "ACTIVE" else if (doc.str("planId") == "trial") "TRIAL" else "EXPIRED"
        completed("Subscription updated.") { app.cloud.save(doc.path, json("status" to status, "updatedAt" to FirestoreCodec.timestamp(System.currentTimeMillis())), doc.updateTime) }
    }
}

