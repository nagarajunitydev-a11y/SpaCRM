package com.qvrix.glowos.nativeapp

import android.graphics.Bitmap
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import com.qvrix.glowos.nativeapp.online.*
import org.json.JSONObject

@Composable fun ReferralsScreen(vm: OnlineViewModel, s: SalonSnapshot) {
    var status by remember { mutableStateOf("All") }; var settings by remember { mutableStateOf(false) }
    ScreenTitle("Referrals", "Track referrals, rewards and wallet balances")
    if (!s.can("referral")) { GCard { GText("Referrals are available with an eligible subscription.", color = Muted); GButton("View plans") { vm.navigate("subscription") } }; return }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { GButton("Settings", "settings", subtle = true) { settings = true }; GButton("Process expiry", "refresh-cw", !vm.busy) { vm.launch { vm.repo.expireReferrals(s); vm.refresh() } } }
    GCard { GText("Referral rewards", 18, bold = true); GText("${s.rows("referrals").size} referrals · ${BusinessRules.currency(s.rows("referrals").sumOf { it.num("rewardAmount") })} rewarded", color = Green); GText("Available balance: ${BusinessRules.currency(s.rows("customers").sumOf { it.num("walletBalance") })}", color = PinkLight) }
    GSelect("Status", status, listOf("All", "Pending", "Credited", "Qualified", "Redeemed", "Expired", "Reversed").map { it to it }) { status = it }
    val rows = s.rows("referrals").filter { status == "All" || it.str("status") == status }.sortedByDescending { it.str("createdAt") }
    if (rows.isEmpty()) GCard { GText("No referrals found.", color = Muted) }
    rows.forEach { d -> GCard { GText("${d.str("referrerName")} → ${d.str("referredName")}", 16, bold = true); GText("${d.str("code")} · ${d.str("status")}", 12, PinkLight); GText("Reward ${BusinessRules.currency(d.num("rewardAmount"))} · Remaining ${BusinessRules.currency(BusinessRules.remaining(d.data))}", 12, Green); GText("${d.str("createdAt")}\nExpires: ${d.str("expiresAt")}", 11, Muted) } }
    if (settings) {
        var values by remember { mutableStateOf(s.settings.copyJson()) }
        fun update(key: String, value: Any) { values = values.copyJson().put(key, value) }
        GDialog("Referral settings", { settings = false }) {
            GSwitch("Enable referrals", values.optBoolean("enabled", true)) { update("enabled", it) }
            GSelect("Reward type", values.str("rewardType"), listOf("fixed" to "Fixed amount", "percent" to "Percentage")) { update("rewardType", it) }
            listOf("rewardValue" to "Reward value", "maxRewardAmount" to "Maximum reward (₹)", "minInvoiceAmount" to "Minimum qualifying invoice (₹)", "expiryDays" to "Expiry days (0 = no expiry)", "maxRedemptionPercent" to "Maximum redemption per bill (%)").forEach { (key, label) -> GField(label, values.str(key), { update(key, it.toDoubleOrNull() ?: 0) }) }
            GSelect("Reward trigger", values.str("rewardTrigger"), listOf("invoice_paid" to "First appointment completed & invoice paid", "appointment_completed" to "First appointment completed")) { update("rewardTrigger", it) }
            Notices(vm); GButton("Save settings", enabled = !vm.busy) { vm.saveReferralSettings(values) }
        }
    }
}

@Composable fun BranchesScreen(vm: OnlineViewModel, s: SalonSnapshot) {
    ScreenTitle(if (s.admin) "All Salons Franchise" else "Branches", if (s.admin) "Super Admin Global Network Overview" else "Manage your locations", if (s.admin) "Add Salon" else "Add Branch", !vm.busy) { vm.editor = EditorRequest("branches") }
    var query by remember { mutableStateOf("") }; GField("Search branches", query, { query = it })
    s.branches.filter { query.isBlank() || it.data.toString().contains(query, true) }.forEach { d -> GCard {
        GText(d.str("name"), 20, bold = true); GText("${d.str("address")}\n${d.str("phone")}", 12, Muted); GText(if (d.data.optBoolean("active", true)) "Active" else "Inactive", 11, Green)
        if (s.admin) GText("Owner: ${d.str("ownerId")}\nStatus: ${d.str("status", "active")}", 11, Muted)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GButton(if (s.admin) "Manage" else if (d.id == s.branch?.id) "Selected" else "Open", enabled = !vm.busy && (s.admin || d.data.optBoolean("active", true)), subtle = true) { if (s.admin) vm.manageSalon(d.id) else vm.switchBranch(d.id) }
            GButton("Edit", "pencil", !vm.busy, true) { vm.editor = EditorRequest("branches", d) }
            GButton(if (d.data.optBoolean("active", true)) "Deactivate" else "Activate", enabled = !vm.busy, subtle = true) { vm.toggleBranch(d) }
        }
        if (s.admin) GButton(if (d.str("status") == "suspended") "Restore salon" else "Suspend salon", enabled = !vm.busy, subtle = true) { vm.launch { vm.app.cloud.save(d.path, json("status" to if (d.str("status") == "suspended") "active" else "suspended"), d.updateTime); }; }
    } }
}

@Composable fun SubscriptionScreen(vm: OnlineViewModel, s: SalonSnapshot) {
    var cycle by remember { mutableStateOf("monthly") }
    var receipt by remember { mutableStateOf<CloudDocument?>(null) }
    ScreenTitle("Subscription", "Choose the right plan for your salon")
    GCard {
        GText(s.plan?.str("name") ?: "Choose your plan", 24, PinkLight, true); GText(s.subscription?.str("status") ?: "No active subscription", color = Green)
        if (s.subscription != null) {
            val end = FirestoreCodec.millis(s.subscription.opt(if (s.subscription.str("status") == "TRIAL") "trialEndsAt" else "currentPeriodEnd"))
            if (end > 0) GText("Valid until ${java.text.DateFormat.getDateInstance().format(java.util.Date(end))}", 12, Muted)
            GText("${s.rows("staff").size} staff · ${s.rows("customers").size} clients · ${s.branches.size} branches", 12, Muted)
            if (s.subscription.optBoolean("autoRenew")) GButton("Cancel automatic renewal", enabled = !vm.busy, subtle = true) { vm.cancelAutomaticRenewal() }
        } else GButton("Start 30-day free trial", "gift", !vm.busy && s.branch != null) { vm.startTrial() }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) { FilterChip(cycle == "monthly", { cycle = "monthly" }, label = { GText("Monthly", 12) }); FilterChip(cycle == "annual", { cycle = "annual" }, label = { GText("Annual · save more", 12) }) }
    listOf("basic", "standard", "premium", "business").forEach { id -> s.plans.optJSONObject(id)?.let { plan -> PlanCard(vm, plan, cycle, s) } }
    GText("Payment history", 20, bold = true)
    if (s.payments.isEmpty()) GCard { GText("No subscription payments yet.", color = Muted) }
    val context = LocalContext.current
    s.payments.sortedByDescending { FirestoreCodec.millis(it.data.opt("createdAt")) }.forEach { d -> GCard { GText("${d.str("planId")} · ${d.str("status")}", 16, bold = true); GText("${BusinessRules.currency(d.num("amount"))} · ${d.str("billingCycle")}", color = PinkLight); GText("Order: ${d.str("orderId")}\nPayment: ${d.str("gatewayPaymentId")}", 11, Muted); GButton("View receipt", "receipt", subtle = true) { receipt = d } } }
    receipt?.let { d ->
        fun date(key: String) = FirestoreCodec.millis(d.data.opt(key)).takeIf { it > 0 }?.let { java.text.DateFormat.getDateInstance().format(java.util.Date(it)) } ?: "—"
        val fields = listOf("Receipt no." to d.str("receiptNumber", "—"), "Plan" to "${s.plans.optJSONObject(d.str("planId"))?.str("name") ?: d.str("planId")} (${d.str("billingCycle")})", "Paid on" to date("paidAt"), "Service period" to "${date("periodStart")} – ${date("periodEnd")}", "Method" to d.str("method", "—").uppercase(), "Gateway" to d.str("paymentGateway", "—"), "Order ID" to d.str("orderId"), "Payment ID" to d.str("gatewayPaymentId", "—")) + if (d.num("refundedAmount") > 0) listOf("Refunded" to BusinessRules.currency(d.num("refundedAmount"))) else emptyList()
        val text = "Qvrix GlowOS\nSubscription receipt\n${BusinessRules.currency(d.num("amount"))} · ${d.str("status")}\n" + fields.joinToString("\n") { "${it.first}: ${it.second}" }
        GDialog("Receipt", { receipt = null }) { GText(BusinessRules.currency(d.num("amount")), 28, PinkLight, true); GText(d.str("status"), color = Green); fields.forEach { (label, value) -> GText(label, 11, Muted); GText(value, 13) }; GButton("Print / Save PDF", "printer", subtle = true) { printReceipt(context, text) }; GButton("Share receipt", "share-2", subtle = true) { context.share(text) } }
    }
    if (s.events.isNotEmpty()) { GText("Subscription activity", 18, bold = true); s.events.sortedByDescending { FirestoreCodec.millis(it.data.opt("createdAt")) }.forEach { GText("${it.str("type")} · ${it.str("message")}", 12, Muted) } }
}
@Composable fun PlanCard(vm: OnlineViewModel, plan: JSONObject, cycle: String, s: SalonSnapshot) {
    GCard {
        GText(plan.str("name"), 22, bold = true); GText("${BusinessRules.currency(plan.num(if (cycle == "annual") "priceAnnual" else "priceMonthly"))} / ${if (cycle == "annual") "year" else "month"}", 24, PinkLight, true)
        GText("${plan.str("maxStaff")} staff · ${plan.str("maxCustomers")} clients · ${plan.str("maxBranches")} branches", 12, Muted)
        plan.optJSONArray("features")?.let { a -> for (i in 0 until a.length()) GText("✓ ${featureLabel(vm, a.getString(i))}", 12, Green) }
        GButton(if (s.subscription?.str("planId") == plan.str("id")) "Renew plan" else "Choose ${plan.str("name")}", "crown", !vm.busy && s.branch != null) { vm.selectPlan(plan, cycle) }
    }
}
fun featureLabel(vm: OnlineViewModel, key: String): String { val value = vm.repo.catalog.getJSONObject("features").opt(key); return (value as? JSONObject)?.str("label") ?: value?.toString() ?: key }

@Composable fun CheckoutDialog(vm: OnlineViewModel, plan: JSONObject, purchase: () -> Unit) {
    GDialog("Complete your subscription", { if (!vm.busy) vm.checkoutPlan = null }) {
        GText("${plan.str("name")} · ${vm.checkoutCycle}", 22, PinkLight, true)
        GText(BusinessRules.currency(plan.num(if (vm.checkoutCycle == "annual") "priceAnnual" else "priceMonthly")), 28, bold = true)
        val states = vm.repo.catalog.getJSONArray("taxStates")
        GSelect("Billing state", vm.taxState, (0 until states.length()).map { states.getString(it) to states.getString(it) }) { vm.taxState = it }
        GText("Google Play will show available payment options. Your plan changes only after the server verifies the purchase.", 12, Muted)
        Notices(vm); vm.checkoutResult?.let { GText("${it.str("status")}\n${it.str("message").ifBlank { it.str("reason") }}", color = if (it.str("status") == "SUCCESS") Green else PinkLight) }
        GButton("Continue to payment", "credit-card", !vm.busy && vm.taxState.isNotBlank(), onClick = purchase)
    }
}

@Composable fun AdminScreen(vm: OnlineViewModel, s: SalonSnapshot) {
    if (!s.admin) return
    var tab by remember(vm.section) { mutableStateOf(if (vm.section == "admin_plans") "Plans" else "Subscriptions") }
    var failed by remember { mutableStateOf(false) }
    ScreenTitle("Subscriptions", "Plans, payments and billing events")
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) { listOf("Subscriptions", "Payments", "Events", "Plans").forEach { value -> FilterChip(tab == value, { tab = value }, label = { GText(value, 11) }) } }
    when(tab) {
        "Plans" -> {
            GButton("Save all defaults", enabled = !vm.busy, subtle = true) { vm.saveDefaultPlans() }
            s.plans.keys().forEach { id -> val plan = s.plans.getJSONObject(id); GCard { GText(plan.str("name"), 22, bold = true); GText("${BusinessRules.currency(plan.num("priceMonthly"))} / month", color = PinkLight); GText("${plan.str("maxStaff", "Unlimited")} staff ? ${plan.str("maxCustomers", "Unlimited")} clients ? ${plan.str("maxBranches")} branches", 11, Muted); GButton("Edit plan", "pencil", !vm.busy, true) { vm.editor = EditorRequest("plans", CloudDocument("plans/$id", plan)) } } }
        }
        "Payments" -> {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { FilterChip(!failed, { failed = false }, label = { GText("All", 12) }); FilterChip(failed, { failed = true }, label = { GText("Failed", 12) }) }
            val rows = s.adminPayments.filter { !failed || it.str("status") == "FAILED" }.sortedByDescending { FirestoreCodec.millis(it.data.opt("createdAt")) }
            if (rows.isEmpty()) GCard { GText("No payments to show.", color = Muted) }
            rows.forEach { d -> GCard { GText("${d.str("planId")} ? ${d.str("billingCycle")} ? ${BusinessRules.currency(d.num("amount"))}", 15, bold = true); GText(d.str("status"), 11, PinkLight); GText("Owner ${d.path.split('/').getOrNull(1)} ? ${d.str("orderId")} ? ${d.str("method")}", 11, Muted); if (d.str("failureReason").isNotBlank()) GText(d.str("failureReason"), 12, PinkLight) } }
        }
        "Events" -> {
            val rows = s.adminEvents.sortedByDescending { FirestoreCodec.millis(it.data.opt("at")) }.take(200)
            if (rows.isEmpty()) GCard { GText("No events yet.", color = Muted) }
            rows.forEach { d -> GCard { GText(d.str("type"), 16, bold = true); GText("Owner ${d.path.split('/').getOrNull(1)} ? ${d.str("detail")}", 12, Muted); val at = FirestoreCodec.millis(d.data.opt("at")); if (at > 0) GText(java.text.DateFormat.getDateTimeInstance().format(java.util.Date(at)), 10, Muted) } }
        }
        else -> {
            var query by remember { mutableStateOf("") }; GField("Search subscriptions", query, { query = it })
            GCard { GText(listOf("TRIAL", "ACTIVE", "PAST_DUE", "EXPIRED", "SUSPENDED").joinToString(" ? ") { status -> "$status ${s.adminSubscriptions.count { it.str("status") == status }}" }, 11, Muted) }
            s.adminSubscriptions.filter { query.isBlank() || it.data.toString().contains(query, true) }.forEach { d -> GCard {
                GText(d.str("ownerEmail").ifBlank { d.id }, 16, bold = true); GText("${d.str("planId")} ? ${d.str("status")}", color = PinkLight)
                val usage = d.data.optJSONObject("usage"); GText("Usage: ${usage?.optInt("staff") ?: 0} staff ? ${usage?.optInt("customer") ?: 0} clients ? ${usage?.optInt("branch") ?: 0} branches", 11, Muted)
                val end = FirestoreCodec.millis(d.data.opt(if (d.str("planId") == "trial") "trialEndsAt" else "currentPeriodEnd")); if (end > 0) GText("Period ends ${java.text.DateFormat.getDateInstance().format(java.util.Date(end))}", 11, Muted)
                GButton(if (d.str("status") == "SUSPENDED") "Reactivate" else "Suspend", enabled = !vm.busy, subtle = true) { vm.suspendSubscription(d) }
                s.branches.find { it.id == d.str("salonId") }?.let { salon -> GButton("View salon & payment history", enabled = !vm.busy, subtle = true) { vm.switchBranch(salon.id, "subscription") } }
            } }
        }
    }
}

@Composable fun BookingSettings(vm: OnlineViewModel, s: SalonSnapshot) {
    var values by remember(s.branch?.id) { mutableStateOf(s.booking.copyJson()) }; var qr by remember { mutableStateOf(false) }
    fun update(key: String, value: Any) { values = values.copyJson().put(key, value) }
    val context = LocalContext.current; val link = "${BuildConfig.API_URL}/book/${s.branch?.id}"
    ScreenTitle("Booking Link", "Let clients book online using your salon's existing public booking page")
    if (!s.can("onlineBooking")) { GCard { GText("Online booking requires an eligible plan.", color = Muted); GButton("View plans") { vm.navigate("subscription") } }; return }
    GCard {
        GSwitch("Enable online booking", values.optBoolean("enabled")) { update("enabled", it) }; GField("Public salon name", values.str("displayName"), { update("displayName", it) })
        listOf("slotIntervalMinutes" to "Slot interval (minutes)", "advanceBookingDays" to "Advance booking (days)", "minNoticeMinutes" to "Minimum notice (minutes)").forEach { (key, label) -> GField(label, values.str(key), { update(key, it.toIntOrNull() ?: 0) }) }
        GText("Working hours", 18, bold = true)
        listOf("mon" to "Monday", "tue" to "Tuesday", "wed" to "Wednesday", "thu" to "Thursday", "fri" to "Friday", "sat" to "Saturday", "sun" to "Sunday").forEach { (key, label) ->
            val hours = values.getJSONObject("workingHours"); val day = hours.getJSONObject(key)
            fun hour(field: String, value: Any) { update("workingHours", hours.copyJson().put(key, day.copyJson().put(field, value))) }
            GText(label, 15, bold = true); GSwitch("Closed", day.optBoolean("closed")) { hour("closed", it) }; if (!day.optBoolean("closed")) { GField("Opening time (HH:mm)", day.str("start"), { hour("start", it) }); GField("Closing time (HH:mm)", day.str("end"), { hour("end", it) }) }
        }
        Notices(vm); GButton("Save & publish booking settings", "check", !vm.busy) { vm.saveBooking(values) }
    }
    val issues = bookingIssues(s, values)
    if (issues.isNotEmpty()) GCard { GText("Before sharing your booking link", 16, PinkLight, true); issues.forEach { GText(it, 12, Muted) } }
    else GCard { GText(link, 12, PinkLight); GButton("Copy booking link", "copy", subtle = true) { context.copy(link) }; GButton("Share booking link", "share-2", subtle = true) { context.share(link) }; GButton("Show QR code", "qr-code", subtle = true) { qr = true }; GButton("Open booking page", "external-link", subtle = true) { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(link))) } }
    if (qr) GDialog("Scan to book", { qr = false }) {
        val bitmap = remember(link) { val bits = MultiFormatWriter().encode(link, BarcodeFormat.QR_CODE, 600, 600); Bitmap.createBitmap(600, 600, Bitmap.Config.ARGB_8888).apply { for (y in 0 until 600) for (x in 0 until 600) setPixel(x, y, if (bits[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE) } }
        Image(bitmap.asImageBitmap(), "Salon booking QR code", Modifier.fillMaxWidth().aspectRatio(1f)); GButton("Share link", "share-2") { context.share(link) }
    }
}

fun bookingIssues(s: SalonSnapshot, draft: JSONObject): List<String> = buildList {
    val saved = s.booking
    if (!saved.optBoolean("enabled")) add("Turn on online booking and save its settings.")
    if (listOf("enabled", "displayName", "slotIntervalMinutes", "advanceBookingDays", "minNoticeMinutes", "workingHours").any { saved.opt(it)?.toString() != draft.opt(it)?.toString() }) add("Save your changes before sharing.")
    if (saved.objects("publicServices").isEmpty()) add("Add services, then save booking settings to publish them.")
    if (saved.objects("publicServices").any { BusinessRules.duration(it.str("duration")) <= 0 }) add("Each published service needs a valid duration.")
    if (saved.objects("publicStaff").isEmpty()) add("Add staff, then save booking settings to publish them.")
    val hours = saved.optJSONObject("workingHours")
    if (hours == null || hours.keys().asSequence().all { hours.getJSONObject(it).optBoolean("closed") }) add("Set working hours for at least one open day.")
    fun signature(rows: List<JSONObject>, fields: List<String>) = rows.map { row -> fields.joinToString("|") { if (it == "price") row.num(it).toString() else row.str(it) } }.sorted()
    val services = s.rows("services").take(200).map { it.data.copyJson().put("id", it.id) }
    val staff = s.rows("staff").take(200).map { it.data.copyJson().put("id", it.id) }
    if (signature(services, listOf("id", "name", "price", "duration")) != signature(saved.objects("publicServices"), listOf("id", "name", "price", "duration")) || signature(staff, listOf("id", "name")) != signature(saved.objects("publicStaff"), listOf("id", "name"))) add("Publish your latest service and staff catalog by saving booking settings.")
}

@Composable fun ReportsScreen(s: SalonSnapshot) {
    var start by remember { mutableStateOf(BusinessRules.today().take(7) + "-01") }; var end by remember { mutableStateOf(BusinessRules.today()) }
    ScreenTitle("Reports", "Appointments, collections and staff attendance")
    GField("From (YYYY-MM-DD)", start, { start = it }); GField("To (YYYY-MM-DD)", end, { end = it })
    val rows = s.rows("appointments").filter { it.str("date") >= start && it.str("date") <= end }; val paid = rows.filter { it.data.optBoolean("paid") }
    GCard { GText("${rows.size} appointments", 24, bold = true); GText("Collected ${BusinessRules.currency(paid.sumOf { it.num("amountDue") })}", 22, Green, true); GText("Discounts ${BusinessRules.currency(paid.sumOf { it.num("discountApplied") })} · Wallet ${BusinessRules.currency(paid.sumOf { it.num("walletRedeemed") })}", 12, Muted); BusinessRules.appointmentStatuses.forEach { status -> GText("$status: ${rows.count { it.str("status") == status }}", 12) } }
    s.rows("staff").forEach { staff -> GCard { GText(staff.str("name"), 18, bold = true); val appointments = rows.filter { it.str("staffName") == staff.str("name") }; GText("${appointments.size} bookings · ${BusinessRules.currency(appointments.filter { it.data.optBoolean("paid") }.sumOf { it.num("amountDue") })}", color = PinkLight); val attendance = s.rows("attendance").filter { it.str("staffId") == staff.id && it.str("date") >= start && it.str("date") <= end }; GText(BusinessRules.attendanceStatuses.joinToString(" · ") { status -> "$status ${attendance.count { it.str("status") == status }}" }, 11, Muted) } }
}
@Composable fun HelpScreen(vm: OnlineViewModel) {
    ScreenTitle("Help & tutorials", "Learn how to use Qvrix GlowOS")
    val tutorials = vm.repo.catalog.getJSONObject("tutorials")
    tutorials.keys().forEach { key -> val tutorial = tutorials.getJSONObject(key); GCard { GText(tutorial.str("label"), 20, PinkLight, true); GText(tutorial.getJSONObject("summary").str("body"), color = Muted); tutorial.objects("steps").forEachIndexed { i, step -> GText("${i + 1}. ${step.str("title")}", 15, bold = true); GText(step.str("body").ifBlank { step.str("description") }, 12, Muted) } } }
}
