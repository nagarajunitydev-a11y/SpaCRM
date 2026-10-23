package com.qvrix.glowos.nativeapp

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.qvrix.glowos.nativeapp.online.*
import org.json.JSONObject

data class Destination(val id: String, val label: String, val icon: String)
val ownerNav = listOf(Destination("dashboard", "Home", "layout-dashboard"), Destination("appointments", "Bookings", "calendar"), Destination("customers", "Clients", "users"), Destination("referrals", "Referrals", "gift"), Destination("services", "Services", "sparkles"), Destination("staff", "Staff", "user-check"), Destination("branches", "Branches", "building-2"), Destination("subscription", "Subscription", "crown"))
val adminNav = listOf(Destination("admin_salons", "Salons", "building-2"), Destination("admin_subscriptions", "Subscriptions", "credit-card"), Destination("admin_plans", "Plans", "crown"))

@Composable fun GlowApp(vm: OnlineViewModel, purchase: () -> Unit) {
    var confirmExit by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<CloudDocument?>(null) }
    BackHandler(vm.authenticated) {
        val home = if (vm.snapshot?.admin == true && !vm.managingSalon) "admin_salons" else "dashboard"
        when { vm.receipt != null -> vm.receipt = null; vm.payment != null -> vm.payment = null; vm.editor != null -> vm.editor = null; vm.profile != null -> vm.profile = null; vm.checkoutPlan != null -> vm.checkoutPlan = null; vm.section != home -> vm.navigate(home); vm.managingSalon -> vm.leaveSalon(); else -> confirmExit = true }
    }
    val activity = androidx.activity.compose.LocalActivity.current as MainActivity
    Surface(Modifier.fillMaxSize(), color = Background) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
            if (!vm.authenticated) LoginScreen(vm) else {
                val s = vm.snapshot
                if (s == null) {
                    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
                        GText("Qvrix GlowOS", 28, PinkLight, true); GText(if (vm.busy) "Connecting to your salon…" else "Unable to load your account.", color = Muted)
                        Notices(vm); GButton("Retry", "refresh-cw", !vm.busy) { vm.refresh() }; GButton("Sign out", subtle = true) { vm.signOut() }
                    }
                } else BoxWithConstraints(Modifier.weight(1f)) {
                    val wide = maxWidth >= 1024.dp
                    val nav = if (s.admin && !vm.managingSalon) adminNav else ownerNav.filter { it.id != "branches" || s.can("multiBranch") }
                    Row(Modifier.fillMaxSize()) {
                        if (wide) Column(Modifier.width(272.dp).fillMaxHeight().background(Panel).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Brand(); GButton("Quick Billing / Walk-in", "receipt", !s.locked) { vm.navigate("quickbill") }; nav.forEach { d -> NavItem(d, vm, false) }; Spacer(Modifier.weight(1f)); GButton("Help & tutorials", "circle-help", subtle = true) { vm.navigate("help") }; GButton("Logout", "log-out", subtle = true) { vm.signOut() }
                        }
                        Column(Modifier.weight(1f)) {
                            Row(Modifier.fillMaxWidth().background(Panel).padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                if (s.admin && vm.managingSalon) IconButton({ vm.leaveSalon() }) { GIcon("arrow-left") }
                                Image(painterResource(R.drawable.glowos_logo), "Qvrix GlowOS logo", Modifier.size(30.dp)); Spacer(Modifier.width(10.dp)); Column(Modifier.weight(1f)) { GText("Qvrix GlowOS", 14, bold = true); GText(if (s.admin) "SUPER ADMIN" else "SALON OWNER", 9, PinkLight, true) }
                                IconButton({ vm.refresh() }, enabled = !vm.busy) { GIcon("refresh-cw") }
                                IconButton({ vm.navigate("help") }) { GIcon("circle-help") }
                                IconButton({ vm.signOut() }) { GIcon("log-out") }
                            }
                            if (s.branches.size > 1) Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) { GSelect("Branch", s.branch?.id.orEmpty(), s.branches.filter { it.data.optBoolean("active", true) }.map { it.id to it.str("name") }) { vm.switchBranch(it) } }
                            if (vm.busy) LinearProgressIndicator(Modifier.fillMaxWidth(), color = Pink, trackColor = Border)
                            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(if (wide) 32.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                                Notices(vm)
                                if (s.locked && s.branch != null) GCard { GText("Your data is safe and view-only. Choose a plan to continue working.", color = PinkLight); GButton("View plans", "crown") { vm.navigate("subscription") } }
                                if (s.branch == null && !s.admin) GCard { GText("Set up your salon", 24, bold = true); GText("Tell us about your business to get started.", color = Muted); GButton("Create salon", "plus") { vm.editor = EditorRequest("branches") } }
                                else when (vm.section) {
                                    "dashboard" -> Dashboard(vm, s)
                                    "customers", "services", "staff" -> Directory(vm, s, vm.section) { confirmDelete = it }
                                    "appointments" -> Appointments(vm, s) { confirmDelete = it }
                                    "quickbill" -> QuickBilling(vm, s)
                                    "referrals" -> ReferralsScreen(vm, s)
                                    "subscription" -> SubscriptionScreen(vm, s)
                                    "branches", "admin_salons" -> BranchesScreen(vm, s)
                                    "admin_subscriptions", "admin_plans" -> AdminScreen(vm, s)
                                    "booking" -> BookingSettings(vm, s)
                                    "reports" -> ReportsScreen(s)
                                    "help" -> HelpScreen(vm)
                                }
                                Spacer(Modifier.height(16.dp))
                            }
                            if (!wide) Row(Modifier.fillMaxWidth().background(Panel).horizontalScroll(rememberScrollState()).padding(vertical = 6.dp)) { nav.forEach { NavItem(it, vm, true) } }
                        }
                    }
                }
            }
        }
    }
    vm.snapshot?.let { s ->
        vm.editor?.let { EntityEditor(vm, s, it) }
        vm.profile?.let { CustomerProfile(vm, s, it) }
        vm.payment?.let { PaymentDialog(vm, s, it) }
        vm.receipt?.let { ReceiptDialog(vm, s, it) }
        vm.checkoutPlan?.let { CheckoutDialog(vm, it, purchase) }
    }
    if (confirmExit) AlertDialog(onDismissRequest = { confirmExit = false }, title = { GText("Exit Qvrix GlowOS?") }, confirmButton = { TextButton({ activity.finish() }) { GText("Exit", color = Pink) } }, dismissButton = { TextButton({ confirmExit = false }) { GText("Stay") } })
    confirmDelete?.let { doc -> AlertDialog(onDismissRequest = { confirmDelete = null }, title = { GText(if (doc.path.contains("/appointments/")) "Cancel this appointment?" else "Delete this record?") }, text = { GText("Review this action before continuing. It will be sent to your salon's server.", color = Muted) }, confirmButton = { TextButton({ vm.delete(doc); confirmDelete = null }) { GText("Confirm", color = Pink) } }, dismissButton = { TextButton({ confirmDelete = null }) { GText("Keep") } }) }
}

@Composable fun Brand() {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Image(painterResource(R.drawable.glowos_logo), "Qvrix GlowOS logo", Modifier.size(48.dp)); GText("Qvrix GlowOS", 20, PinkLight, true)
    }
}
@Composable private fun NavItem(d: Destination, vm: OnlineViewModel, compact: Boolean) {
    val selected = vm.section == d.id
    if (compact) Column(Modifier.widthIn(min = 56.dp).clickable { vm.navigate(d.id) }.padding(10.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) { GIcon(d.icon, if (selected) PinkLight else Muted); GText(d.label, 10, if (selected) PinkLight else Muted, selected) }
    else Row(Modifier.fillMaxWidth().background(if (selected) Pink.copy(alpha = .15f) else Color.Transparent, RoundedCornerShape(12.dp)).clickable { vm.navigate(d.id) }.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) { GIcon(d.icon, if (selected) PinkLight else Muted); GText(d.label, color = if (selected) PinkLight else Muted, bold = selected) }
}
@Composable fun Notices(vm: OnlineViewModel) {
    if (vm.error.isNotBlank()) GText(vm.error, 13, Color(0xfffda4af))
    if (vm.message.isNotBlank()) GText(vm.message, 13, Green)
}
@Composable fun LoginScreen(vm: OnlineViewModel) {
    var email by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var salonName by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf("") }
    var mode by remember { mutableStateOf("login") }
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Panel, Background, Color.Black))).background(Brush.radialGradient(listOf(Pink.copy(alpha = .12f), Color.Transparent), center = androidx.compose.ui.geometry.Offset.Zero, radius = 700f)).verticalScroll(rememberScrollState()).padding(24.dp), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 448.dp), verticalArrangement = Arrangement.spacedBy(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Image(painterResource(R.drawable.glowos_logo), "Qvrix GlowOS logo", Modifier.size(96.dp))
            Spacer(Modifier.height(8.dp))
            GText(if (mode == "forgot") "Reset Password" else "Qvrix GlowOS", 24, bold = true)
            GText(when(mode) { "signup" -> "Create an account"; "forgot" -> "Enter your registered email and we?ll send you a reset link."; else -> "Sign in to your Qvrix GlowOS account" }, 12, Muted)
            Spacer(Modifier.height(12.dp))
            if (mode == "signup") GField("Salon Name", salonName, { salonName = it })
            GField("Email Address", email, { email = it })
            if (mode != "forgot") {
                GField("Password", password, { password = it }, true)
                if (mode == "login") Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { TextButton({ mode = "forgot" }) { GText("Forgot Password?", 10, PinkLight, true) } }
            }
            Notices(vm)
            if (vm.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            Button(onClick = { if (mode == "forgot") vm.resetEmail(email) else { vm.onboardingName = salonName; vm.signIn(email, password, mode == "signup") } }, enabled = !vm.busy && email.isNotBlank() && (mode == "forgot" || password.isNotBlank()), modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Color(0xffe11d74))) {
                GText(when(mode) { "signup" -> "Create Account & Login"; "forgot" -> "Send Reset Link"; else -> "Sign in" }, 12, bold = true)
            }
            Button(onClick = { mode = if (mode == "login") "signup" else "login" }, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Border)) { GText(if (mode == "login") "Create Account" else "Back to Sign In", 12, bold = true) }
        }
    }
}

@Composable fun ScreenTitle(title: String, subtitle: String, action: String? = null, enabled: Boolean = true, onAction: () -> Unit = {}) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { GText(title, 26, bold = true); GText(subtitle, 12, Muted); if (action != null) GButton(action, "plus", enabled, onClick = onAction) }
}
@Composable fun Dashboard(vm: OnlineViewModel, s: SalonSnapshot) {
    var period by remember { mutableStateOf("Today") }
    val today = BusinessRules.today(); val month = today.take(7); val lastMonth = java.time.LocalDate.parse(today).minusMonths(1).toString().take(7)
    val rows = s.rows("appointments").filter { when(period) { "Today" -> it.str("date") == today; "This Month" -> it.str("date").startsWith(month); else -> it.str("date").startsWith(lastMonth) } }
    Column(Modifier.fillMaxWidth().background(Brush.linearGradient(listOf(Panel, Color(0xff141325), Panel)), RoundedCornerShape(24.dp)).border(1.dp, Border, RoundedCornerShape(24.dp)).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GText("OVERVIEW", 10, PinkLight, true)
        GText("Your Salon at a Glance", 20, bold = true)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f).background(Background.copy(alpha = .7f), RoundedCornerShape(16.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { GText("$period Bookings", 10, Muted); GText("${rows.size}", 24, bold = true) }
            Column(Modifier.weight(1f).background(Background.copy(alpha = .7f), RoundedCornerShape(16.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { GText("Est. Revenue", 10, Muted); GText(BusinessRules.currency(rows.filter { it.str("status") != "Cancelled" }.sumOf { BusinessRules.serviceAmount(it.data, s.rows("services")) }), 23, Green, true) }
        }
    }
    val actions = listOf("Quick Bill" to "quickbill", "Book" to "appointments", "Client" to "customers", "Service" to "services", "Staff" to "staff", "Booking Link" to "booking")
    actions.chunked(4).forEach { group ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            group.forEach { (label, tab) ->
                val tint = when(tab) { "quickbill", "services" -> Green; "staff" -> Color(0xfffbbf24); "booking" -> Color(0xff2dd4bf); "customers" -> Color(0xff818cf8); else -> PinkLight }
                Column(Modifier.weight(1f).background(Panel, RoundedCornerShape(16.dp)).border(1.dp, Border, RoundedCornerShape(16.dp)).clickable { if (tab in listOf("customers", "services", "staff", "appointments")) vm.editor = EditorRequest(tab) else vm.navigate(tab) }.padding(vertical = 16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.size(48.dp).background(tint.copy(alpha = .12f), RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) { GIcon(when(tab) { "quickbill" -> "zap"; "booking" -> "link"; "customers" -> "user-plus"; "services" -> "sparkle"; "staff" -> "user-check"; else -> "calendar-plus" }, tint, 24) }
                    GText(label, 10, bold = true)
                }
            }
            repeat(4 - group.size) { Spacer(Modifier.weight(1f)) }
        }
    }
    Row(Modifier.fillMaxWidth().background(Panel, RoundedCornerShape(16.dp)).padding(4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        listOf("Today", "This Month", "Last Month").forEach { value -> Box(Modifier.weight(1f).background(if (period == value) Pink else Color.Transparent, RoundedCornerShape(12.dp)).clickable { period = value }.padding(vertical = 10.dp), contentAlignment = Alignment.Center) { GText(value, 10, if (period == value) Color.White else Muted, true) } }
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { GText("$period Appointments", 14, bold = true); GText("${rows.size} bookings", 10, Muted) }
    if (rows.isEmpty()) GCard { GText("No appointments scheduled for ${period.lowercase()}.", 12, Muted) }

    rows.sortedBy { it.str("time") }.forEach { AppointmentCard(vm, s, it) }
    GButton("Reports", "chart-no-axes-combined", subtle = true) { vm.navigate("reports") }
}

@Composable fun Directory(vm: OnlineViewModel, s: SalonSnapshot, type: String, remove: (CloudDocument) -> Unit) {
    var search by remember(type) { mutableStateOf("") }; var attendance by remember { mutableStateOf(false) }
    val singular = when(type) { "customers" -> "Client"; "services" -> "Service"; else -> "Staff" }
    ScreenTitle(if (type == "customers") "Clients" else type.replaceFirstChar { it.uppercase() }, "Manage your ${if (type == "customers") "salon's client relationships" else type}", "Add $singular", !s.locked && !vm.busy) { vm.editor = EditorRequest(type) }
    if (type == "staff") {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { FilterChip(!attendance, { attendance = false }, label = { GText("Staff", 12) }); FilterChip(attendance, { attendance = true }, label = { GText("Attendance", 12) }) }
        if (attendance) { AttendanceScreen(vm, s, remove); return }
    }
    GField("Search ${if (type == "customers") "clients" else type}", search, { search = it })
    val rows = s.rows(type).filter { search.isBlank() || it.data.toString().contains(search, true) }.sortedBy { it.str("name").lowercase() }
    if (rows.isEmpty()) GCard { GText("No ${if (type == "customers") "clients" else type} found.", color = Muted) }
    rows.forEach { doc -> GCard {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(46.dp).background(Pink.copy(alpha = .12f), RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) { GText(doc.str("name").take(1).uppercase(), 20, PinkLight, true) }
            Column(Modifier.weight(1f)) { GText(doc.str("name"), 16, bold = true); GText(if (type == "services") "${doc.str("category")} · ${doc.str("duration")}" else doc.str(if (type == "staff") "role" else "phone"), 12, Muted) }
            if (type == "services") GText(BusinessRules.currency(doc.num("price")), 16, PinkLight, true)
        }
        if (type == "customers") { GText("${doc.num("rewardPoints").toInt()} points · Wallet ${BusinessRules.currency(doc.num("walletBalance"))}", 12, Green); if (doc.str("referralCode").isNotBlank()) GText("Referral code: ${doc.str("referralCode")}", 11, Muted); GButton("View profile & history", "user", subtle = true) { vm.profile = doc } }
        if (type == "staff") GText(doc.str("phone"), 12, Muted)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { GButton("Edit", "pencil", !s.locked && !vm.busy, true) { vm.editor = EditorRequest(type, doc) }; GButton("Delete", "trash-2", !s.locked && !vm.busy, true) { remove(doc) } }
    } }
}

@Composable fun AttendanceScreen(vm: OnlineViewModel, s: SalonSnapshot, remove: (CloudDocument) -> Unit) {
    var date by remember { mutableStateOf(BusinessRules.today()) }
    GField("Date (YYYY-MM-DD)", date, { date = it }); GButton("Mark attendance", "plus", !s.locked) { vm.editor = EditorRequest("attendance") }
    val records = s.rows("attendance").filter { it.str("date") == date }
    if (records.isEmpty()) GText("No attendance marked for this date.", color = Muted)
    records.forEach { d -> GCard { GText(d.str("staffName").ifBlank { s.rows("staff").find { it.id == d.str("staffId") }?.str("name").orEmpty() }, 16, bold = true); GText("${d.str("status")} · ${d.str("checkIn")} – ${d.str("checkOut")}", color = Green); GText(d.str("notes"), 12, Muted); Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { GButton("Edit", enabled = !s.locked, subtle = true) { vm.editor = EditorRequest("attendance", d) }; GButton("Delete", enabled = !s.locked, subtle = true) { remove(d) } } } }
}

@Composable fun Appointments(vm: OnlineViewModel, s: SalonSnapshot, remove: (CloudDocument) -> Unit) {
    var query by remember { mutableStateOf("") }; var status by remember { mutableStateOf("All") }; var date by remember { mutableStateOf("") }
    ScreenTitle("Appointments", "Manage bookings and your daily schedule", "New Appointment", !s.locked && !vm.busy) { vm.editor = EditorRequest("appointments") }
    GField("Search appointments", query, { query = it }); GField("Date (YYYY-MM-DD, leave blank for all)", date, { date = it })
    GSelect("Status", status, (listOf("All") + BusinessRules.appointmentStatuses).map { it to it }) { status = it }
    val rows = s.rows("appointments").filter { (status == "All" || it.str("status") == status) && (date.isBlank() || it.str("date") == date) && (query.isBlank() || it.data.toString().contains(query, true)) }.sortedByDescending { it.str("date") + it.str("time") }
    if (rows.isEmpty()) GCard { GText("No appointments found.", color = Muted) }
    rows.forEach { d -> AppointmentCard(vm, s, d); if (!s.locked && d.str("status") != "Cancelled") TextButton({ remove(d) }) { GText("Cancel appointment", 11, Muted) } }
}
@Composable fun AppointmentCard(vm: OnlineViewModel, s: SalonSnapshot, d: CloudDocument) {
    GCard {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { GText(d.str("customerName"), 16, bold = true); GText(d.str("status"), 10, if (d.str("status") == "Cancelled") Muted else Green, true) }
        GText(d.data.objects("services").joinToString(" + ") { it.str("name") }.ifBlank { d.str("serviceName") }, 13)
        GText("${d.str("date")} · ${d.str("time")} · ${d.str("staffName")}", 11, Muted)
        GText(BusinessRules.currency(if (d.data.optBoolean("paid")) d.num("amountDue") else BusinessRules.serviceAmount(d.data, s.rows("services"))), 18, PinkLight, true)
        if (d.str("notes").isNotBlank()) GText(d.str("notes"), 12, Muted)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GButton("Edit", "pencil", !s.locked && !vm.busy, true) { vm.editor = EditorRequest("appointments", d) }
            if (d.data.optBoolean("paid")) GButton("Receipt", "receipt", subtle = true) { vm.receipt = d }
            else if (d.str("status") != "Cancelled" && !d.data.optBoolean("refunded")) GButton("Collect payment", "credit-card", !s.locked && !vm.busy && s.can("billing")) { vm.payment = d }
        }
        if (!s.locked && !d.data.optBoolean("paid") && d.str("status") !in listOf("Cancelled", "Completed")) GSelect("Change status", d.str("status"), BusinessRules.appointmentStatuses.map { it to it }) { vm.status(d, it) }
        if (d.data.optBoolean("paid")) TextButton({ vm.settle(d) }, enabled = !vm.busy && !s.locked) { GText("Complete referral settlement", 10, Muted) }
    }
}
