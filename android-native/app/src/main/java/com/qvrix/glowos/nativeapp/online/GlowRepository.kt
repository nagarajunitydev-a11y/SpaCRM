package com.qvrix.glowos.nativeapp.online

import android.content.Context
import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class SalonSnapshot(
    val uid: String, val role: String, val profile: JSONObject,
    val branches: List<CloudDocument>, val branch: CloudDocument?,
    val collections: Map<String, List<CloudDocument>>, val subscription: JSONObject?,
    val plans: JSONObject, val settings: JSONObject, val booking: JSONObject,
    val payments: List<CloudDocument> = emptyList(), val events: List<CloudDocument> = emptyList(),
    val adminSubscriptions: List<CloudDocument> = emptyList(),
    val adminPayments: List<CloudDocument> = emptyList(), val adminEvents: List<CloudDocument> = emptyList(),
) {
    fun rows(name: String) = collections[name] ?: emptyList()
    val admin get() = role == "super_admin"
    val locked get() = !admin && (!BusinessRules.live(subscription) || branch?.str("status") == "suspended")
    val plan get() = plans.optJSONObject(subscription?.str("planId") ?: "")
    fun can(feature: String) = admin || (!locked && plan?.optJSONArray("features")?.let { a -> (0 until a.length()).any { a.optString(it) == feature } } == true)
    val base get() = "salons/${requireNotNull(branch).id}"
}

class GlowRepository(context: Context, val auth: FirebaseAuth, val cloud: FirestoreOnline) {
    val catalog = JSONObject(context.assets.open("reference-catalog.json").bufferedReader().use { it.readText() })
    private fun identity() = auth.currentUser?.uid ?: error("Sign in to continue.")
    suspend fun ensureProfile() {
        val user = auth.currentUser ?: error("Sign in to continue.")
        cloud.atomic { val old = get("users/${user.uid}"); if (old == null) set("users/${user.uid}", json("role" to "salon_owner", "email" to user.email, "displayName" to user.displayName.orEmpty(), "createdAt" to BusinessRules.now()), false) }
    }
    suspend fun load(branchId: String? = null): SalonSnapshot = coroutineScope {
        val uid = identity(); val profile = cloud.get("users/$uid")?.data ?: error("Your account profile is missing.")
        val admin = profile.str("role") == "super_admin"
        val salons = if (admin) cloud.list("salons") else cloud.query("salons", "ownerId", uid)
        val selected = salons.find { it.id == branchId } ?: salons.find { it.id == profile.str("salonId") && it.data.optBoolean("active", true) } ?: salons.firstOrNull { it.data.optBoolean("active", true) } ?: salons.firstOrNull()
        val plans = catalog.getJSONObject("plans").copyJson()
        cloud.list("plans").forEach { plan -> plans.optJSONObject(plan.id)?.let { base -> plan.data.keys().forEach { base.put(it, plan.data.get(it)) } } }
        val owner = selected?.str("ownerId") ?: uid
        val subscription = cloud.get("subscriptions/$owner")?.data
        val names = listOf("customers", "services", "staff", "attendance", "appointments", "referrals", "walletTransactions", "referralCodes")
        val rows = if (selected == null) emptyMap() else names.map { name -> name to async { cloud.list("salons/${selected.id}/$name") } }.associate { it.first to it.second.await() }
        val settings = if (selected == null) null else cloud.get("salons/${selected.id}/referralSettings/config")?.data
        val booking = if (selected == null) null else cloud.get("salons/${selected.id}/bookingSettings/config")?.data
        val payments = if (admin || subscription != null) cloud.list("subscriptions/$owner/payments") else emptyList()
        val events = if (admin || subscription != null) cloud.list("subscriptions/$owner/events") else emptyList()
        val adminSubs = if (admin) cloud.list("subscriptions") else emptyList()
        val adminPayments = if (admin) cloud.group("payments") else emptyList()
        val adminEvents = if (admin) cloud.group("events") else emptyList()
        check(identity() == uid) { "Your account changed. Sign in again." }
        SalonSnapshot(uid, profile.str("role"), profile, salons, selected, rows, subscription, plans,
            settings ?: catalog.getJSONObject("referral").copyJson(), booking ?: catalog.getJSONObject("booking").copyJson(), payments, events, adminSubs, adminPayments, adminEvents)
    }
    private suspend fun FirestoreOnline.Transaction.authorize(s: SalonSnapshot, feature: String? = null) {
        check(identity() == s.uid)
        val user = get("users/${s.uid}") ?: error("Account profile unavailable.")
        if (user.str("role") == "super_admin") return
        val branch = get(s.base) ?: error("Branch no longer exists.")
        check(branch.str("ownerId") == s.uid && branch.str("status") != "suspended" && branch.data.optBoolean("active", true)) { "You cannot modify this branch." }
        val subscription = get("subscriptions/${s.uid}")?.data
        check(BusinessRules.live(subscription)) { "Your subscription has expired. Your data is safe and view-only." }
        val plan = get("plans/${subscription!!.str("planId")}")?.data ?: s.plans.getJSONObject(subscription.str("planId"))
        if (feature != null) check(plan.optJSONArray("features")?.let { a -> (0 until a.length()).any { a.optString(it) == feature } } == true) { "Upgrade your plan to use this feature." }
    }
    suspend fun saveEntity(s: SalonSnapshot, type: String, input: JSONObject, original: CloudDocument?, newId: String = UUID.randomUUID().toString(), quick: Boolean = false): String {
        require(type in listOf("customers", "services", "staff", "attendance"))
        val data = input.copyJson(); val id = original?.id ?: if (type == "attendance") "${data.str("staffId")}_${data.str("date")}" else newId
        if (type != "attendance") require(data.str("name").trim().isNotBlank()) { "Name is required." }
        if (type == "customers" || type == "staff") data.put("phone", BusinessRules.phone(data.str("phone")))
        if (type == "customers") {
            require(data.str("email").isBlank() || data.str("email").matches(Regex("[^\\s@]+@[^\\s@]+\\.[^\\s@]+"))) { "Enter a valid email." }
            if (data.str("dob").isNotBlank()) BusinessRules.date(data.str("dob"))
        }
        if (type == "services") { require(data.str("price").toDoubleOrNull()?.let { it.isFinite() && it >= 0 } == true) { "Enter a valid non-negative price." }; data.put("price", data.num("price")); require(BusinessRules.duration(data.str("duration")) > 0) { "Enter a valid duration." } }
        if (type == "staff") require(data.str("role").isNotBlank()) { "Staff role is required." }
        if (type == "attendance") { BusinessRules.date(data.str("date")); require(data.str("status") in BusinessRules.attendanceStatuses) }
        val savedId = cloud.atomic {
            authorize(s)
            val path = "${s.base}/$type/$id"; val old = get(path)
            check(if (original != null) old?.updateTime == original.updateTime else old == null) { "This record already exists or changed. Refresh and review." }
            if (type in listOf("customers", "staff")) {
                val all = query(type, parent = s.base)
                if (type == "customers" && original == null && quick) all.find { BusinessRules.digits(it.str("phone")) == BusinessRules.digits(data.str("phone")) }?.let { return@atomic it.id }
                if (original == null) {
                    val limit = s.plan?.opt(if (type == "customers") "maxCustomers" else "maxStaff")
                    if (limit is Number) check(all.size < limit.toInt()) { "Your plan's $type limit has been reached." }
                }
                if (type == "customers") check(all.none { it.id != id && (BusinessRules.digits(it.str("phone")) == BusinessRules.digits(data.str("phone")) || (!quick && it.str("name").equals(data.str("name"), true))) }) { "A matching client already exists in this branch." }
            }
            if (type == "attendance") check(get("${s.base}/staff/${data.str("staffId")}") != null) { "Select a current staff member." }
            data.put("salonId", s.branch!!.id).put("updatedAt", BusinessRules.now())
            if (old == null) { data.put("createdAt", BusinessRules.now()); if (type == "customers") data.put("rewardPoints", 100).put("walletBalance", 0) }
            set(path, data)
            id
        }
        return savedId
    }
    suspend fun saveBranch(s: SalonSnapshot, input: JSONObject, original: CloudDocument?, id: String = UUID.randomUUID().toString()) {
        require(input.str("name").isNotBlank() && input.str("address").isNotBlank()) { "Branch name and address are required." }
        val phone = BusinessRules.phone(input.str("phone")); val branchId = original?.id ?: id
        cloud.atomic {
            val profile = get("users/${s.uid}") ?: error("Sign in again.")
            // Missing salon documents cannot be read under the existing owner rule.
            // A create-only precondition lets setup keep those rules unchanged.
            val old = if (original == null) null else get("salons/$branchId")
            check(old == null || profile.str("role") == "super_admin" || old.str("ownerId") == s.uid)
            if (original != null) check(old?.updateTime == original.updateTime) { "This branch changed. Refresh before saving." }
            val owned = query("salons", "ownerId", s.uid)
            if (profile.str("role") != "super_admin") {
                check(owned.none { it.id != branchId && it.str("name").trim().equals(input.str("name").trim(), true) }) { "A branch with this name exists." }
                if (old == null && owned.isNotEmpty()) check(s.can("multiBranch") && (s.plan?.optInt("maxBranches", 10) ?: 1) > owned.size) { "Your plan does not allow another branch." }
            }
            val data = input.copyJson().put("phone", phone).put("updatedAt", BusinessRules.now()).put("openTime", input.str("openTime", "10:00")).put("closeTime", input.str("closeTime", "19:00"))
            if (old == null) data.put("ownerEmail", auth.currentUser?.email.orEmpty())
            if (old == null) data.put("ownerId", s.uid).put("active", true).put("createdAt", BusinessRules.now())
            if (old == null) create("salons/$branchId", data) else set("salons/$branchId", data)
        }
    }
    suspend fun activateBranch(s: SalonSnapshot, branch: CloudDocument) {
        val active = !branch.data.optBoolean("active", true)
        check(active || s.branches.count { it.data.optBoolean("active", true) } > 1) { "At least one branch must stay active." }
        cloud.save(branch.path, json("active" to active), branch.updateTime)
    }
    suspend fun trial(s: SalonSnapshot) {
        val branch = requireNotNull(s.branch) { "Set up your salon first." }
        cloud.atomic {
            val old = get("subscriptions/${s.uid}"); val salon = get(branch.path)
            check(salon?.str("ownerId") == s.uid)
            if (old != null) { check(BusinessRules.live(old.data) && old.str("planId") == "trial") { "Your trial was already used. Choose a paid plan." }; return@atomic }
            val now = System.currentTimeMillis(); val start = FirestoreCodec.timestamp(now); val end = FirestoreCodec.timestamp(now + 30 * 86400000L)
            set("subscriptions/${s.uid}", json("ownerId" to s.uid, "ownerEmail" to auth.currentUser?.email, "salonId" to branch.id,
                "planId" to "trial", "status" to "TRIAL", "billingCycle" to null, "trialStartedAt" to start, "trialEndsAt" to end,
                "startDate" to start, "endDate" to end, "currentPeriodStart" to null, "currentPeriodEnd" to null, "periodAmount" to 0,
                "lastPaymentId" to null, "cancelAtPeriodEnd" to false, "createdAt" to start,
                "usage" to json("staff" to s.rows("staff").size, "customer" to s.rows("customers").size, "branch" to s.branches.size)), false)
        }
    }
    suspend fun deleteEntity(s: SalonSnapshot, doc: CloudDocument) {
        val type = doc.path.substringBeforeLast('/').substringAfterLast('/')
        if (type == "appointments") { appointment(s, doc.data.copyJson().put("status", "Cancelled"), doc); return }
        cloud.atomic { authorize(s); check(get(doc.path)?.updateTime == doc.updateTime) { "Record changed. Refresh before deleting." }; delete(doc.path) }
    }
    suspend fun loyalty(s: SalonSnapshot, customer: CloudDocument, points: Int) {
        require(points in listOf(100, 250, 500))
        cloud.atomic { authorize(s, "loyalty"); val fresh = get(customer.path) ?: error("Client no longer exists."); check(fresh.num("rewardPoints") >= points) { "Not enough reward points." }; set(customer.path, json("rewardPoints" to fresh.num("rewardPoints") - points)) }
    }
    suspend fun referralCode(s: SalonSnapshot, customer: CloudDocument): String {
        val alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; val random = java.security.SecureRandom()
        val code = customer.str("referralCode").ifBlank { (1..8).map { alphabet[random.nextInt(alphabet.length)] }.joinToString("") }
        return cloud.atomic {
            authorize(s, "referral"); val fresh = get(customer.path) ?: error("Client missing."); val existing = get("${s.base}/referralCodes/$code")
            if (fresh.str("referralCode").isNotBlank()) return@atomic fresh.str("referralCode")
            check(existing == null) { "Code collision. Please generate again." }
            set("${s.base}/referralCodes/$code", json("code" to code, "customerId" to customer.id, "customerName" to fresh.str("name"), "active" to true, "createdAt" to BusinessRules.now()), false)
            set(customer.path, json("referralCode" to code)); code
        }
    }
    suspend fun linkReferral(s: SalonSnapshot, customer: CloudDocument, rawCode: String) {
        val code = rawCode.trim().uppercase(); require(code.matches(Regex("[A-HJ-NP-Z2-9]{8}"))) { "Enter a valid referral code." }
        cloud.atomic {
            authorize(s, "referral"); val fresh = get(customer.path) ?: error("Client missing.")
            val codeDoc = get("${s.base}/referralCodes/$code") ?: error("Referral code not found.")
            val referrer = get("${s.base}/customers/${codeDoc.str("customerId")}") ?: error("Referrer missing.")
            val id = "ref_${customer.id}"; val old = get("${s.base}/referrals/$id")
            val settings = get("${s.base}/referralSettings/config")?.data ?: s.settings
            check(settings.optBoolean("enabled", true) && codeDoc.data.optBoolean("active", true)) { "Referral programme is disabled." }
            check(old == null && fresh.str("referredBy").isBlank()) { "This client already has a referrer." }
            check(referrer.id != customer.id && BusinessRules.digits(referrer.str("phone")) != BusinessRules.digits(fresh.str("phone")) && (fresh.str("email").isBlank() || !referrer.str("email").equals(fresh.str("email"), true))) { "Self-referral is not allowed." }
            val data = settings.copyJson().apply { remove("enabled"); remove("maxRedemptionPercent") }
            data.put("salonId", s.branch!!.id).put("code", code).put("referrerId", referrer.id).put("referrerName", referrer.str("name"))
                .put("referredId", customer.id).put("referredName", fresh.str("name")).put("status", "Pending")
            listOf("rewardAmount", "redeemedAmount", "reversedAmount", "expiredAmount", "qualifyingInvoiceAmount").forEach { data.put(it, 0) }
            listOf("qualifyingAppointmentId", "qualifyingInvoiceNo", "qualifiedAt", "creditedAt", "expiresAt", "reversedAt", "reversalReason", "walletTxnId").forEach { data.put(it, JSONObject.NULL) }
            data.put("createdAt", BusinessRules.now()).put("updatedAt", BusinessRules.now())
            set("${s.base}/referrals/$id", data, false); set(customer.path, json("referredBy" to referrer.id, "referredByCode" to code))
        }
    }
    suspend fun saveReferralSettings(s: SalonSnapshot, data: JSONObject) { require(data.num("maxRedemptionPercent") in 0.0..100.0 && data.num("expiryDays") in 0.0..3650.0); cloud.atomic { authorize(s, "referral"); set("${s.base}/referralSettings/config", data.copyJson().put("updatedAt", BusinessRules.now())) } }
    suspend fun saveBooking(s: SalonSnapshot, data: JSONObject) {
        require(data.optInt("slotIntervalMinutes") in 5..120 && data.optInt("advanceBookingDays") in 1..180 && data.optInt("minNoticeMinutes") in 0..1440) { "Review the booking interval, advance window and notice period." }
        val hours = data.getJSONObject("workingHours")
        listOf("mon", "tue", "wed", "thu", "fri", "sat", "sun").forEach { key -> val day = hours.getJSONObject(key); BusinessRules.minute(day.str("start")); BusinessRules.minute(day.str("end")); require(day.optBoolean("closed") || day.str("end") > day.str("start")) { "Closing time must follow opening time for $key." } }
        val published = data.copyJson().put("publicServices", JSONArray(s.rows("services").filter { it.str("name").isNotBlank() }.take(200).map { json("id" to it.id, "name" to it.str("name"), "price" to it.num("price"), "duration" to it.str("duration")) }))
            .put("publicStaff", JSONArray(s.rows("staff").take(200).map { json("id" to it.id, "name" to it.str("name").take(120), "role" to it.str("role").take(120)) })).put("updatedAt", BusinessRules.now())
        cloud.atomic { authorize(s, "onlineBooking"); set("${s.base}/bookingSettings/config", published) }
    }
    suspend fun publishCatalog(s: SalonSnapshot) {
        if (!s.can("onlineBooking")) return
        val config = cloud.get("${s.base}/bookingSettings/config") ?: return
        val rows = s.collections.toMutableMap()
        rows["services"] = cloud.list("${s.base}/services"); rows["staff"] = cloud.list("${s.base}/staff")
        saveBooking(s.copy(collections = rows), config.data)
    }
    suspend fun appointment(s: SalonSnapshot, input: JSONObject, original: CloudDocument?, newId: String = UUID.randomUUID().toString()): String {
        val data = input.copyJson(); val id = original?.id ?: newId
        val lines = BusinessRules.lines(data, s.rows("services"))
        require(lines.isNotEmpty() && lines.all { it.str("name").isNotBlank() && it.num("price") >= 0 }) { "Select at least one service with a valid name and price." }
        data.put("services", JSONArray(lines)).put("serviceName", lines.first().str("name"))
        BusinessRules.date(data.str("date")); BusinessRules.minute(data.str("time"))
        require(data.str("customerId").isNotBlank() && data.str("staffName").isNotBlank()) { "Select a client and staff member." }
        require(data.str("status") in BusinessRules.appointmentStatuses)
        val duration = data.objects("services").sumOf { BusinessRules.duration(it.str("duration")).takeIf { d -> d > 0 } ?: s.rows("services").find { row -> row.str("name") == it.str("name") }?.let { row -> BusinessRules.duration(row.str("duration")) } ?: 1 }.coerceAtLeast(1)
        val keys = BusinessRules.locks(data.str("staffName"), data.str("date"), data.str("time"), duration)
        cloud.atomic {
            authorize(s)
            val old = get("${s.base}/appointments/$id")
            check(if (original == null) old == null else old?.updateTime == original.updateTime) { "This appointment changed. Refresh before submitting again." }
            val customer = get("${s.base}/customers/${data.str("customerId")}") ?: error("Client not found.")
            val oldDuration = old?.data?.let { BusinessRules.lines(it, s.rows("services")).sumOf { line -> BusinessRules.duration(line.str("duration")).coerceAtLeast(1) } } ?: duration
            val oldKeys = old?.let { BusinessRules.locks(it.str("staffName"), it.str("date"), it.str("time"), oldDuration) } ?: emptyList()
            val locks = (keys + oldKeys).distinct().associateWith { get("${s.base}/appointmentSlots/$it") }
            if (data.str("status") != "Cancelled") check(keys.none { locks[it] != null && locks[it]?.str("appointmentId") != id }) { "This staff/time was just booked. Choose another slot." }
            data.put("salonId", s.branch!!.id).put("customerName", customer.str("name")).put("customerPhone", customer.str("phone")).put("updatedAt", BusinessRules.now())
            if (old == null) data.put("createdAt", BusinessRules.now()).put("paid", false)
            set("${s.base}/appointments/$id", data)
            for (key in oldKeys) if ((key !in keys || data.str("status") == "Cancelled") && locks[key]?.str("appointmentId") == id) delete("${s.base}/appointmentSlots/$key")
            if (data.str("status") != "Cancelled") for (key in keys) if (locks[key] == null) set("${s.base}/appointmentSlots/$key", json("appointmentId" to id, "staffName" to data.str("staffName"), "date" to data.str("date"), "time" to data.str("time"), "createdAt" to BusinessRules.now()), false)
        }
        if (data.str("status") == "Completed") settleReferral(s, id)
        if (data.str("status") == "Cancelled") reverseBenefits(s, id)
        return id
    }

    private fun wallet(s: SalonSnapshot, customer: CloudDocument, type: String, amount: Double, before: Double, appointmentId: String,
        referralId: String? = null, allocations: JSONArray = JSONArray(), note: String = type): JSONObject {
        val credit = type in listOf("REFERRAL_CREDIT", "REFERRAL_REDEEM_REVERSAL")
        return json("salonId" to s.branch!!.id, "customerId" to customer.id, "customerName" to customer.str("name"), "source" to "REFERRAL",
            "type" to type, "amount" to BusinessRules.round(amount), "direction" to if (credit) "credit" else "debit", "balanceBefore" to before,
            "balanceAfter" to BusinessRules.round(before + if (credit) amount else -amount), "referralId" to referralId, "appointmentId" to appointmentId,
            "invoiceNo" to "INV-${appointmentId.uppercase()}", "allocations" to allocations, "note" to note, "createdAt" to BusinessRules.now())
    }
    suspend fun collect(s: SalonSnapshot, appointmentId: String, gross: Double, discountType: String, discountValue: Double,
        requestedWallet: Double, method: String, reference: String): CloudDocument {
        require(gross >= 0 && requestedWallet >= 0 && method in listOf("cash", "upi", "card", "other")) { "Enter a valid amount and payment method." }
        cloud.atomic {
            authorize(s, "billing")
            val path = "${s.base}/appointments/$appointmentId"
            val appointment = get(path) ?: error("Appointment not found.")
            if (appointment.data.optBoolean("paid")) return@atomic
            check(appointment.str("status") != "Cancelled" && !appointment.data.optBoolean("refunded")) { "Cancelled/refunded invoices cannot be collected again." }
            val customer = get("${s.base}/customers/${appointment.str("customerId")}") ?: error("Client not found.")
            val settings = get("${s.base}/referralSettings/config")?.data ?: s.settings
            val priorRedemption = get("${s.base}/walletTransactions/wtx_redeem_$appointmentId")
            val refs = if (requestedWallet > 0) query("referrals", "referrerId", customer.id, s.base) else emptyList()
            if (discountValue > 0) check(s.can("customerDiscounts")) { "Your plan does not include client discounts." }
            val appliedDiscount = BusinessRules.discount(discountType, discountValue, gross)
            val discounted = BusinessRules.round(gross - appliedDiscount)
            val amount = BusinessRules.round(requestedWallet)
            val balance = customer.num("walletBalance")
            if (amount > 0) {
                check(s.can("referral") && settings.optBoolean("enabled", true)) { "Referral redemption is unavailable." }
                val cap = BusinessRules.round(minOf(balance, discounted * settings.num("maxRedemptionPercent") / 100))
                check(amount <= cap) { "Wallet redemption exceeds the available balance or invoice limit." }
                check(priorRedemption == null) { "This invoice has an existing wallet posting. Refresh its payment status before retrying." }
            }
            var remaining = amount; val allocations = JSONArray(); val updates = mutableListOf<Pair<CloudDocument, Double>>()
            refs.filter { it.str("status") == "Credited" && (FirestoreCodec.millis(it.data.opt("expiresAt")) == 0L || FirestoreCodec.millis(it.data.opt("expiresAt")) > System.currentTimeMillis()) }
                .sortedBy { FirestoreCodec.millis(it.data.opt("creditedAt")) }.forEach { referral ->
                    val use = BusinessRules.round(minOf(remaining, BusinessRules.remaining(referral.data)))
                    if (use > 0) { allocations.put(json("referralId" to referral.id, "amount" to use)); updates.add(referral to use); remaining = BusinessRules.round(remaining - use) }
                }
            check(remaining <= 0) { "Referral allocations no longer cover that amount. Refresh and retry." }
            val due = BusinessRules.round(discounted - amount)
            if (amount > 0) {
                set("${s.base}/walletTransactions/wtx_redeem_$appointmentId", wallet(s, customer, "REFERRAL_REDEEM", amount, balance, appointmentId, allocations = allocations, note = "Redeemed on invoice INV-${appointmentId.uppercase()}"), false)
                for ((referral, used) in updates) {
                    val newRedeemed = BusinessRules.round(referral.num("redeemedAmount") + used)
                    set(referral.path, json("redeemedAmount" to newRedeemed, "status" to if (BusinessRules.remaining(referral.data) <= used) "Redeemed" else "Credited", "lastRedeemedAt" to BusinessRules.now(), "updatedAt" to BusinessRules.now()))
                }
            }
            set(customer.path, json("discountType" to discountType, "discountValue" to discountValue, "walletBalance" to BusinessRules.round(balance - amount)))
            set(path, json("invoiceNo" to "INV-${appointmentId.uppercase()}", "invoiceAmount" to BusinessRules.round(gross), "amount" to BusinessRules.round(gross),
                "discountType" to discountType, "discountValue" to discountValue, "discountApplied" to appliedDiscount, "walletRedeemed" to amount,
                "walletBalanceBefore" to balance, "walletBalanceAfter" to BusinessRules.round(balance - amount), "amountDue" to due, "paid" to true,
                "paymentMethod" to if (due > 0) method else if (amount > 0) "wallet" else "discount", "paymentReference" to reference,
                "paidAt" to BusinessRules.now(), "refunded" to false, "status" to "Completed"))
        }
        // If this second existing business leg fails, report the partial state;
        // retry is idempotent and does not repeat cash/wallet collection.
        try { settleReferral(s, appointmentId) }
        catch (e: Exception) { throw IllegalStateException("Payment is recorded; referral qualification could not finish. Refresh and use Complete referral settlement. ${e.message}", e) }
        return cloud.get("${s.base}/appointments/$appointmentId") ?: error("Payment was recorded but its receipt could not be loaded. Refresh before retrying.")
    }
    suspend fun settleReferral(s: SalonSnapshot, appointmentId: String) {
        cloud.atomic {
            authorize(s)
            val appointment = get("${s.base}/appointments/$appointmentId") ?: error("Appointment missing.")
            val found = query("referrals", "referredId", appointment.str("customerId"), s.base).firstOrNull { it.str("status") == "Pending" } ?: return@atomic
            val settings = get("${s.base}/referralSettings/config")?.data ?: s.settings
            if (!settings.optBoolean("enabled", true) || appointment.str("status") != "Completed") return@atomic
            if (found.str("rewardTrigger", settings.str("rewardTrigger")) == "invoice_paid" && !appointment.data.optBoolean("paid")) return@atomic
            val invoiceAmount = appointment.num("invoiceAmount").takeIf { it > 0 } ?: appointment.num("amount")
            if (invoiceAmount < found.num("minInvoiceAmount")) return@atomic
            val referrer = get("${s.base}/customers/${found.str("referrerId")}") ?: error("Referrer missing.")
            val ledgerPath = "${s.base}/walletTransactions/wtx_credit_${found.id}"; if (get(ledgerPath) != null) return@atomic
            var reward = if (found.str("rewardType") == "percent") invoiceAmount * found.num("rewardValue") / 100 else found.num("rewardValue")
            if (found.num("maxRewardAmount") > 0) reward = minOf(reward, found.num("maxRewardAmount"))
            reward = BusinessRules.round(reward); if (reward <= 0) return@atomic
            val now = System.currentTimeMillis(); val expiry = found.num("expiryDays").toLong()
            set(ledgerPath, wallet(s, referrer, "REFERRAL_CREDIT", reward, referrer.num("walletBalance"), appointmentId, found.id), false)
            set(found.path, json("status" to "Credited", "rewardAmount" to reward, "redeemedAmount" to 0, "reversedAmount" to 0, "expiredAmount" to 0,
                "qualifyingAppointmentId" to appointmentId, "qualifyingInvoiceNo" to "INV-${appointmentId.uppercase()}", "qualifyingInvoiceAmount" to invoiceAmount,
                "qualifiedAt" to BusinessRules.now(), "creditedAt" to BusinessRules.now(), "expiresAt" to if (expiry > 0) FirestoreCodec.timestamp(now + expiry * 86400000L).str("__firestoreTimestamp") else null,
                "walletTxnId" to ledgerPath.substringAfterLast('/'), "updatedAt" to BusinessRules.now()))
            set(referrer.path, json("walletBalance" to BusinessRules.round(referrer.num("walletBalance") + reward)))
        }
    }
    suspend fun reverseBenefits(s: SalonSnapshot, appointmentId: String) {
        cloud.atomic {
            authorize(s)
            val appointment = get("${s.base}/appointments/$appointmentId") ?: error("Appointment missing.")
            val original = get("${s.base}/walletTransactions/wtx_redeem_$appointmentId")
            val restored = get("${s.base}/walletTransactions/wtx_redeem_rev_$appointmentId")
            val customer = get("${s.base}/customers/${appointment.str("customerId")}")
            val allocated = original?.data?.objects("allocations")?.mapNotNull { allocation -> get("${s.base}/referrals/${allocation.str("referralId")}")?.let { it to allocation.num("amount") } } ?: emptyList()
            val reward = query("referrals", "qualifyingAppointmentId", appointmentId, s.base).firstOrNull { it.str("status") in listOf("Credited", "Redeemed") }
            val referrer = reward?.let { get("${s.base}/customers/${it.str("referrerId")}") }
            val reversed = reward?.let { get("${s.base}/walletTransactions/wtx_reversal_${it.id}") }
            val updates = mutableMapOf<String, Double>()
            if (customer != null && restored == null && original != null) {
                val amount = original.num("amount"); updates[customer.path] = customer.num("walletBalance") + amount
                set("${s.base}/walletTransactions/wtx_redeem_rev_$appointmentId", wallet(s, customer, "REFERRAL_REDEEM_REVERSAL", amount, customer.num("walletBalance"), appointmentId, allocations = original.data.optJSONArray("allocations") ?: JSONArray()), false)
                for ((referral, amountUsed) in allocated) set(referral.path, json("redeemedAmount" to maxOf(0.0, BusinessRules.round(referral.num("redeemedAmount") - amountUsed)), "status" to if (referral.str("status") in listOf("Credited", "Redeemed")) "Credited" else referral.str("status"), "updatedAt" to BusinessRules.now()))
            }
            if (reward != null && referrer != null && reversed == null) {
                val before = updates[referrer.path] ?: referrer.num("walletBalance"); val debit = minOf(before, BusinessRules.remaining(reward.data))
                if (debit > 0) set("${s.base}/walletTransactions/wtx_reversal_${reward.id}", wallet(s, referrer, "REFERRAL_REVERSAL", debit, before, appointmentId, reward.id), false)
                updates[referrer.path] = before - debit
                set(reward.path, json("status" to "Reversed", "reversedAmount" to BusinessRules.round(reward.num("reversedAmount") + debit), "reversedAt" to BusinessRules.now(), "reversalReason" to "Invoice refunded or appointment cancelled", "updatedAt" to BusinessRules.now()))
            }
            updates.forEach { (path, balance) -> set(path, json("walletBalance" to BusinessRules.round(balance))) }
        }
    }
    suspend fun refund(s: SalonSnapshot, appointment: CloudDocument) {
        check(appointment.data.optBoolean("paid") && !appointment.data.optBoolean("refunded")) { "This invoice is not eligible for refund." }
        reverseBenefits(s, appointment.id)
        cloud.atomic {
            authorize(s); val fresh = get(appointment.path) ?: error("Invoice missing.")
            if (fresh.data.optBoolean("refunded")) return@atomic
            check(fresh.data.optBoolean("paid")) { "Invoice state changed. Refresh before refunding." }
            set(appointment.path, json("paid" to false, "refunded" to true, "refundedAt" to BusinessRules.now(), "refund" to fresh.num("invoiceAmount")))
        }
    }
    suspend fun expireReferrals(s: SalonSnapshot) {
        for (candidate in s.rows("referrals").filter { it.str("status") == "Credited" && FirestoreCodec.millis(it.data.opt("expiresAt")) in 1..System.currentTimeMillis() }) cloud.atomic {
            authorize(s, "referral"); val fresh = get(candidate.path) ?: return@atomic
            val owner = get("${s.base}/customers/${fresh.str("referrerId")}") ?: return@atomic
            val path = "${s.base}/walletTransactions/wtx_expiry_${fresh.id}"
            if (get(path) != null || fresh.str("status") != "Credited") return@atomic
            val remainder = BusinessRules.remaining(fresh.data); val debit = minOf(remainder, owner.num("walletBalance"))
            if (debit > 0) set(path, wallet(s, owner, "REFERRAL_EXPIRY", debit, owner.num("walletBalance"), fresh.str("qualifyingAppointmentId"), fresh.id), false)
            set(fresh.path, json("status" to "Expired", "expiredAmount" to BusinessRules.round(fresh.num("expiredAmount") + remainder), "expiredAt" to BusinessRules.now(), "updatedAt" to BusinessRules.now()))
            if (debit > 0) set(owner.path, json("walletBalance" to BusinessRules.round(owner.num("walletBalance") - debit)))
        }
    }
}
