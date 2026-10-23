package com.qvrix.glowos.nativeapp.online

import org.json.JSONObject
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.*
import kotlin.math.*

object BusinessRules {
    val attendanceStatuses = listOf("Present", "Absent", "Late", "Half Day", "Leave")
    val appointmentStatuses = listOf("Pending", "Confirmed", "Completed", "Cancelled")
    fun round(value: Double) = floor((value + 2.220446049250313e-16) * 100 + 0.5) / 100
    fun currency(value: Double) = NumberFormat.getCurrencyInstance(Locale.forLanguageTag("en-IN")).apply { currency = Currency.getInstance("INR"); maximumFractionDigits = 2 }.format(value)
    fun digits(value: String) = value.filter(Char::isDigit).let { if (it.startsWith("91") && it.length > 10) it.drop(2) else it }
    fun phone(value: String, optional: Boolean = false): String {
        if (optional && value.isBlank()) return ""
        val digits = digits(value); require(digits.matches(Regex("[6-9]\\d{9}"))) { "Enter a valid 10-digit Indian mobile number." }; return "+91$digits"
    }
    fun discount(type: String, value: Double, gross: Double): Double {
        val amount = round(max(0.0, gross))
        return round(when (type) {
            "percentage" -> amount * value.coerceIn(0.0, 100.0) / 100
            "fixed" -> value.coerceIn(0.0, amount)
            else -> 0.0
        })
    }
    fun remaining(referral: JSONObject) = round(max(0.0, referral.num("rewardAmount") - referral.num("redeemedAmount") - referral.num("reversedAmount") - referral.num("expiredAmount")))
    fun duration(value: String): Int {
        val raw = value.trim().lowercase()
        raw.toDoubleOrNull()?.let { return if (it.isFinite()) it.roundToInt().coerceAtLeast(0) else 0 }
        Regex("^(\\d+):([0-5]\\d)$").matchEntire(raw)?.let { return it.groupValues[1].toInt() * 60 + it.groupValues[2].toInt() }
        val match = Regex("^(?:(\\d+(?:\\.\\d+)?)\\s*(?:h|hr|hrs|hour|hours))?\\s*(?:(\\d+(?:\\.\\d+)?)\\s*(?:m|min|mins|minute|minutes))?$").matchEntire(raw) ?: return 0
        return ((match.groupValues[1].toDoubleOrNull() ?: 0.0) * 60 + (match.groupValues[2].toDoubleOrNull() ?: 0.0)).roundToInt().coerceAtLeast(0)
    }
    fun minute(value: String): Int { require(value.matches(Regex("([01]\\d|2[0-3]):[0-5]\\d"))) { "Enter a valid time (HH:mm)." }; return value.take(2).toInt() * 60 + value.takeLast(2).toInt() }
    fun time(minute: Int) = "%02d:%02d".format(Locale.US, minute / 60, minute % 60)
    fun date(value: String) {
        require(value.matches(Regex("\\d{4}-\\d{2}-\\d{2}"))) { "Enter a valid date (YYYY-MM-DD)." }
        val parser = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { isLenient = false }
        require(runCatching { parser.parse(value) }.getOrNull() != null) { "Enter a valid date." }
    }
    fun now() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
    fun today(zone: String = "Asia/Kolkata") = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone(zone) }.format(Date())
    fun localTime(zone: String = "Asia/Kolkata") = SimpleDateFormat("HH:mm", Locale.US).apply { timeZone = TimeZone.getTimeZone(zone) }.format(Date())
    fun locks(staff: String, date: String, start: String, duration: Int): List<String> {
        val slug = staff.trim().lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(80).ifBlank { "staff" }
        val minute = minute(start)
        require(minute + duration <= 1440) { "The appointment must finish on the selected day." }
        return (minute / 5 * 5 until minute + max(5, duration) step 5).map { "${slug}_${date}_${time(it).replace(":", "")}" }
    }
    fun live(subscription: JSONObject?, now: Long = System.currentTimeMillis()): Boolean {
        if (subscription == null) return false
        val status = subscription.str("status"); if (status in listOf("SUSPENDED", "EXPIRED")) return false
        if (status == "TRIAL") return subscription.str("planId") == "trial" && now < FirestoreCodec.millis(subscription.opt("trialEndsAt"))
        if (status !in listOf("ACTIVE", "PAST_DUE", "GRACE_PERIOD", "CANCELLED")) return false
        val grace = if (status == "CANCELLED" || subscription.optBoolean("cancelAtPeriodEnd")) 0 else subscription.optInt("graceDays", 3).coerceIn(0, 30)
        return now < FirestoreCodec.millis(subscription.opt("currentPeriodEnd")) + grace * 86400000L
    }
    fun serviceAmount(row: JSONObject, catalog: List<CloudDocument>): Double {
        val lines = row.optJSONArray("services") ?: row.optJSONArray("serviceNames")
        if (lines != null && lines.length() > 0) return (0 until lines.length()).sumOf { index ->
            val item = lines.optJSONObject(index); val name = item?.str("name") ?: lines.optString(index)
            item?.num("price")?.takeIf { it > 0 } ?: catalog.find { it.str("name").equals(name, true) }?.num("price") ?: 0.0
        }
        return row.num("amount").takeIf { it > 0 } ?: catalog.find { it.str("name").equals(row.str("serviceName"), true) }?.num("price") ?: 0.0
    }
    fun lines(row: JSONObject, catalog: List<CloudDocument>): List<JSONObject> {
        val array = row.optJSONArray("services") ?: row.optJSONArray("serviceNames") ?: org.json.JSONArray().apply { if (row.str("serviceName").isNotBlank()) put(row.str("serviceName")) }
        return (0 until array.length()).map { index ->
            val line = array.optJSONObject(index); val name = line?.str("name")?.ifBlank { line.str("serviceName") } ?: array.optString(index)
            val service = catalog.find { it.str("name").trim().equals(name.trim(), true) }
            (line?.copyJson() ?: JSONObject()).put("name", name)
                .put("price", line?.num("price")?.takeIf { it > 0 } ?: if (array.length() == 1 && row.num("amount") > 0) row.num("amount") else service?.num("price") ?: 0)
                .put("duration", line?.str("duration")?.takeIf { it.isNotBlank() } ?: service?.str("duration").orEmpty())
        }
    }
}
