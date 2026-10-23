package com.qvrix.glowos.nativeapp

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.qvrix.glowos.nativeapp.online.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

@Composable fun EntityEditor(vm: OnlineViewModel, s: SalonSnapshot, request: EditorRequest) {
    val type = request.type; val original = request.record
    var values by remember(request) { mutableStateOf(original?.data?.copyJson()?.apply { if (type == "appointments") put("services", JSONArray(BusinessRules.lines(this, s.rows("services")))) } ?: json("name" to if (type == "branches" && s.branch == null) vm.onboardingName else "", "date" to BusinessRules.today(), "status" to if (type == "appointments") "Confirmed" else "Present", "timezone" to "Asia/Kolkata")) }
    fun update(key: String, value: Any?) { values = values.copyJson().put(key, value) }
    var referral by remember { mutableStateOf("") }
    val title = when(type) { "customers" -> "Client"; "services" -> "Service"; "staff" -> "Staff"; "attendance" -> "Attendance"; "appointments" -> "Appointment"; "branches" -> if (s.branch == null) "Salon setup" else "Branch"; else -> "Plan" }
    GDialog("${if (original == null) "Add" else "Edit"} $title", { if (!vm.busy) vm.editor = null }) {
        if (type in listOf("customers", "services", "staff", "branches")) GField(if (type == "branches") "Salon / branch name" else "Name", values.str("name"), { update("name", it) })
        when (type) {
            "customers" -> {
                GField("Phone (+91)", values.str("phone"), { update("phone", it) }); GField("Email (optional)", values.str("email"), { update("email", it) }); GField("Date of birth (YYYY-MM-DD)", values.str("dob"), { update("dob", it) }); if (original == null) GField("Referral code (optional)", referral, { referral = it.uppercase() })
            }
            "services" -> {
                GSelect("Choose from service catalog", "", listOf("" to "Custom service") + vm.repo.catalog.objects("services").mapIndexed { i, row -> i.toString() to "${row.str("category")} · ${row.str("name")}" }) { key -> key.toIntOrNull()?.let { i -> val item = vm.repo.catalog.objects("services")[i]; values = values.copyJson().put("name", item.str("name")).put("category", item.str("category")).put("price", item.num("price")).put("duration", item.str("duration")) } }
                GField("Category", values.str("category"), { update("category", it) }); GField("Price (₹)", values.str("price"), { update("price", it) }); GField("Duration (e.g. 45m)", values.str("duration"), { update("duration", it) })
            }
            "staff" -> { GField("Role", values.str("role"), { update("role", it) }); GField("Phone (+91, optional)", values.str("phone"), { update("phone", it) }) }
            "branches" -> { GField("Owner Email", values.str("ownerEmail", vm.app.auth.currentUser?.email.orEmpty()), { update("ownerEmail", it) }); GField("Address", values.str("address"), { update("address", it) }, lines = 2); GField("Phone (+91)", values.str("phone"), { update("phone", it) }); GField("Opening time (HH:mm)", values.str("openTime", "10:00"), { update("openTime", it) }); GField("Closing time (HH:mm)", values.str("closeTime", "19:00"), { update("closeTime", it) }); GSelect("Timezone", values.str("timezone", "Asia/Kolkata"), listOf("Asia/Kolkata", "Asia/Dubai", "Europe/London", "America/New_York", "Asia/Singapore").map { it to it }) { update("timezone", it) } }
            "attendance" -> {
                GSelect("Staff", values.str("staffId"), s.rows("staff").map { it.id to it.str("name") }) { key -> update("staffId", key); update("staffName", s.rows("staff").find { it.id == key }?.str("name").orEmpty()) }
                GField("Date (YYYY-MM-DD)", values.str("date"), { update("date", it) }); GSelect("Status", values.str("status"), BusinessRules.attendanceStatuses.map { it to it }) { update("status", it) }; GField("Check in (HH:mm)", values.str("checkIn"), { update("checkIn", it) }); GField("Check out (HH:mm)", values.str("checkOut"), { update("checkOut", it) }); GField("Notes", values.str("notes"), { update("notes", it) }, lines = 2)
            }
            "appointments" -> {
                GSelect("Client", values.str("customerId"), s.rows("customers").map { it.id to "${it.str("name")} · ${it.str("phone")}" }) { key -> val customer = s.rows("customers").find { it.id == key }; update("customerId", key); update("customerName", customer?.str("name")); update("customerPhone", customer?.str("phone")) }
                ServiceLines(s, values.objects("services")) { rows -> update("services", JSONArray(rows)); update("serviceName", rows.firstOrNull()?.str("name").orEmpty()); update("amount", rows.sumOf { it.num("price") }) }
                GSelect("Staff", values.str("staffName"), s.rows("staff").map { it.str("name") to it.str("name") }) { update("staffName", it) }
                GField("Date (YYYY-MM-DD)", values.str("date"), { update("date", it) }); GField("Time (HH:mm)", values.str("time"), { update("time", it) }); GSelect("Status", values.str("status"), BusinessRules.appointmentStatuses.map { it to it }) { update("status", it) }; GField("Notes", values.str("notes"), { update("notes", it) }, lines = 2)
            }
            "plans" -> {
                listOf("name" to "Plan name", "priceMonthly" to "Monthly price", "priceAnnual" to "Annual price", "maxStaff" to "Maximum staff", "maxCustomers" to "Maximum clients", "maxBranches" to "Maximum branches").forEach { (key, label) -> GField(label, values.str(key), { update(key, it) }) }
                vm.repo.catalog.getJSONObject("features").keys().forEach { key -> val features = values.optJSONArray("features") ?: JSONArray(); val selected = (0 until features.length()).map { features.getString(it) }; GSwitch(key, key in selected) { checked -> update("features", JSONArray(if (checked) selected + key else selected - key)) } }
            }
        }
        Notices(vm)
        GButton("Save $title", "check", !vm.busy && (!s.locked || type == "branches" || s.admin)) {
            when(type) { "branches" -> vm.saveBranch(values, original); "appointments" -> vm.appointment(values, original); "plans" -> vm.savePlan(original!!.id, values); else -> vm.saveEntity(type, values, original, referral) }
        }
    }
}

@Composable fun ServiceLines(s: SalonSnapshot, lines: List<JSONObject>, change: (List<JSONObject>) -> Unit) {
    GText("SERVICES", 10, Muted, true)
    GSelect("Add a service", "", listOf("" to "Select a service") + s.rows("services").map { it.id to "${it.str("name")} · ${BusinessRules.currency(it.num("price"))}" }) { id -> s.rows("services").find { it.id == id }?.let { change(lines + json("name" to it.str("name"), "price" to it.num("price"), "duration" to it.str("duration"))) } }
    lines.forEachIndexed { index, line -> GCard {
        GField("Service", line.str("name"), { value -> change(lines.mapIndexed { i, row -> if (i == index) row.copyJson().put("name", value) else row }) })
        GField("Price (₹)", line.str("price"), { value -> change(lines.mapIndexed { i, row -> if (i == index) row.copyJson().put("price", value) else row }) })
        GButton("Remove", "x", subtle = true) { change(lines.filterIndexed { i, _ -> i != index }) }
    } }
    GButton("Add custom service", "plus", subtle = true) { change(lines + json("name" to "", "price" to 0, "duration" to "30m")) }
}

@Composable fun QuickBilling(vm: OnlineViewModel, s: SalonSnapshot) {
    var phone by remember { mutableStateOf("") }; var name by remember { mutableStateOf("") }; var lines by remember { mutableStateOf(emptyList<JSONObject>()) }; var staff by remember { mutableStateOf("") }
    val billId = remember { UUID.randomUUID().toString() }
    val customer = s.rows("customers").find { phone.length >= 10 && BusinessRules.digits(it.str("phone")) == BusinessRules.digits(phone) }
    ScreenTitle("Quick Billing", "Walk-in billing · date and time are set automatically")
    GCard {
        GField("Client phone (+91)", phone, { phone = it }); if (customer == null) GField("New client name", name, { name = it }) else GText(customer.str("name"), 18, Green, true)
        ServiceLines(s, lines) { lines = it }
        GSelect("Staff (optional)", staff, listOf("" to "Unassigned") + s.rows("staff").map { it.str("name") to it.str("name") }) { staff = it }
        PaymentFields(vm, s, lines.sumOf { it.num("price") }, customer) { type, discount, wallet, method, reference -> vm.quickBill(phone, customer?.str("name") ?: name, lines, staff, type, discount, wallet, method, reference, billId) }
    }
}
@Composable fun PaymentFields(vm: OnlineViewModel, s: SalonSnapshot, gross: Double, customer: CloudDocument?, collect: (String, Double, Double, String, String) -> Unit) {
    var type by remember(customer?.id) { mutableStateOf(customer?.str("discountType").orEmpty()) }; var discount by remember(customer?.id) { mutableStateOf(customer?.str("discountValue", "0") ?: "0") }; var wallet by remember { mutableStateOf("0") }; var method by remember { mutableStateOf("cash") }; var reference by remember { mutableStateOf("") }
    if (s.can("customerDiscounts")) { GSelect("Discount", type, listOf("" to "No discount", "percentage" to "Percentage (%)", "fixed" to "Fixed amount (₹)")) { type = it }; if (type.isNotBlank()) GField("Discount value", discount, { discount = it }) }
    val afterDiscount = (gross - BusinessRules.discount(type, discount.toDoubleOrNull() ?: 0.0, gross)).coerceAtLeast(0.0)
    val maximum = minOf(customer?.num("walletBalance") ?: 0.0, afterDiscount * s.settings.num("maxRedemptionPercent") / 100).coerceAtLeast(0.0)
    if (s.can("referral") && maximum > 0) { GText("Referral wallet: ${BusinessRules.currency(customer?.num("walletBalance") ?: 0.0)} · Maximum ${BusinessRules.currency(maximum)}", 12, Green); GField("Wallet redemption (₹)", wallet, { wallet = it }) }
    GSelect("Payment method", method, listOf("cash" to "Cash", "upi" to "UPI", "card" to "Card", "other" to "Other")) { method = it }; if (method != "cash") GField("Payment reference", reference, { reference = it })
    GText("Subtotal: ${BusinessRules.currency(gross)}", color = Muted)
    GText("Total payable: ${BusinessRules.currency((afterDiscount - (wallet.toDoubleOrNull() ?: 0.0)).coerceAtLeast(0.0))}", 24, PinkLight, true)
    Notices(vm)
    GButton("Collect payment", "credit-card", !vm.busy && !s.locked && s.can("billing")) { collect(type, discount.toDoubleOrNull() ?: 0.0, wallet.toDoubleOrNull() ?: 0.0, method, reference) }
}
@Composable fun PaymentDialog(vm: OnlineViewModel, s: SalonSnapshot, d: CloudDocument) {
    GDialog("Collect Payment", { if (!vm.busy) vm.payment = null }) {
        GText(d.str("customerName"), 20, bold = true)
        val gross = BusinessRules.serviceAmount(d.data, s.rows("services"))
        PaymentFields(vm, s, gross, s.rows("customers").find { it.id == d.str("customerId") }) { type, discount, wallet, method, reference -> vm.collect(d, gross, type, discount, wallet, method, reference) }
    }
}
@Composable fun ReceiptDialog(vm: OnlineViewModel, s: SalonSnapshot, d: CloudDocument) {
    val context = LocalContext.current; var confirm by remember { mutableStateOf(false) }
    val text = "${s.branch?.str("name")}\n${d.str("invoiceNo")}\n${d.str("customerName")}\n${d.str("date")} ${d.str("time")}\n${d.data.objects("services").joinToString("\n") { "${it.str("name")}: ${BusinessRules.currency(it.num("price"))}" }}\nTotal: ${BusinessRules.currency(d.num("amountDue"))}\n${if (d.data.optBoolean("refunded")) "REFUNDED" else if (d.data.optBoolean("paid")) "PAID" else "UNPAID"} · ${d.str("paymentMethod")}"
    GDialog("Invoice receipt", { vm.receipt = null }) {
        Brand(); GText(text, 14); GText("Discount: ${BusinessRules.currency(d.num("discountApplied"))} · Wallet: ${BusinessRules.currency(d.num("walletRedeemed"))}", 12, Muted)
        GButton("Share receipt", "share-2") { context.share(text) }; GButton("Print receipt", "printer", subtle = true) { printReceipt(context, text) }
        if (d.data.optBoolean("paid") && !s.locked) { GSwitch("Confirm full refund", confirm, { confirm = it }); GButton("Refund invoice", enabled = confirm && !vm.busy, subtle = true) { vm.refund(d) } }
        Notices(vm)
    }
}

@Composable fun CustomerProfile(vm: OnlineViewModel, s: SalonSnapshot, customer: CloudDocument) {
    val context = LocalContext.current; var code by remember { mutableStateOf("") }
    GDialog(customer.str("name"), { vm.profile = null }) {
        GText("${customer.str("phone")}\n${customer.str("email")}\nBirthday: ${customer.str("dob")}", color = Muted)
        GText("${customer.num("rewardPoints").toInt()} reward points", 24, PinkLight, true); GText("Referral balance ${BusinessRules.currency(customer.num("walletBalance"))}", 18, Green, true)
        if (s.can("loyalty")) listOf(100, 250, 500).forEach { points -> GButton("Redeem $points points", "gift", customer.num("rewardPoints") >= points && !vm.busy, true) { vm.redeemPoints(customer, points) } }
        if (s.can("referral")) {
            if (customer.str("referralCode").isBlank()) GButton("Generate referral code", "gift", !vm.busy) { vm.code(customer) }
            else { GText("Referral code: ${customer.str("referralCode")}", 20, PinkLight, true); GButton("Copy code", "copy", subtle = true) { context.copy(customer.str("referralCode")) }; GButton("Share referral", "share-2", subtle = true) { context.share("${s.branch?.str("name")}: Use my referral code ${customer.str("referralCode")} when booking your visit.") } }
            if (customer.str("referredBy").isBlank()) { GField("Link a referrer's code", code, { code = it.uppercase() }); GButton("Link referral", enabled = !vm.busy) { vm.link(customer, code) } }
        }
        Notices(vm); GText("Visit history", 18, bold = true)
        val history = s.rows("appointments").filter { it.str("customerId") == customer.id }.sortedByDescending { it.str("date") + it.str("time") }
        if (history.isEmpty()) GText("No visits yet.", color = Muted)
        history.forEach { AppointmentCard(vm, s, it) }
        GText("Referral wallet history", 18, bold = true)
        s.rows("walletTransactions").filter { it.str("customerId") == customer.id }.sortedByDescending { it.str("createdAt") }.forEach { GCard { GText("${it.str("type")} · ${BusinessRules.currency(it.num("amount"))}"); GText("${it.str("description")}\n${it.str("createdAt")}", 11, Muted) } }
    }
}

fun printReceipt(context: android.content.Context, text: String) {
    val manager = context.getSystemService(android.content.Context.PRINT_SERVICE) as android.print.PrintManager
    manager.print("Qvrix GlowOS receipt", object : android.print.PrintDocumentAdapter() {
        private var attributes: android.print.PrintAttributes? = null
        override fun onLayout(old: android.print.PrintAttributes?, new: android.print.PrintAttributes?, cancellation: android.os.CancellationSignal?, callback: LayoutResultCallback, extras: android.os.Bundle?) {
            attributes = new; callback.onLayoutFinished(android.print.PrintDocumentInfo.Builder("receipt.pdf").setContentType(android.print.PrintDocumentInfo.CONTENT_TYPE_DOCUMENT).setPageCount(1).build(), true)
        }
        override fun onWrite(pages: Array<out android.print.PageRange>?, destination: android.os.ParcelFileDescriptor?, cancellation: android.os.CancellationSignal?, callback: WriteResultCallback) {
            try { val pdf = android.print.pdf.PrintedPdfDocument(context, attributes!!); val page = pdf.startPage(0); val paint = android.graphics.Paint().apply { color = android.graphics.Color.BLACK; textSize = 12f }; text.lines().forEachIndexed { i, line -> page.canvas.drawText(line, 40f, 50f + i * 20f, paint) }; pdf.finishPage(page); java.io.FileOutputStream(destination!!.fileDescriptor).use { pdf.writeTo(it) }; pdf.close(); callback.onWriteFinished(arrayOf(android.print.PageRange.ALL_PAGES)) } catch (e: Exception) { callback.onWriteFailed(e.message) }
        }
    }, null)
}
