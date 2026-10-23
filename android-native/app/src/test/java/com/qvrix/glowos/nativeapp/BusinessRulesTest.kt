package com.qvrix.glowos.nativeapp

import com.qvrix.glowos.nativeapp.online.BusinessRules
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class BusinessRulesTest {
    @Test fun discountsMatchExistingJavaScriptFixtures() {
        val source = File("src/main/assets/calculation-fixtures.json").readText()
        val rows = Regex("""\{"gross":([^,]+),"type":"([^"]*)","value":([^,]+),"expected":([^}]+)}""").findAll(source).toList()
        assertEquals("Every generated source fixture must be exercised", 96, rows.size)
        rows.forEach { row -> val g = row.groupValues; assertEquals(row.value, g[4].toDouble(), BusinessRules.discount(g[2], g[3].toDouble(), g[1].toDouble()), .000001) }
    }
    @Test fun durationsUseTheExistingCompleteInputGrammar() {
        mapOf("1h30m" to 90, "1 hr 30 mins" to 90, "1:30" to 90, "45" to 45, "90m" to 90, "unknown 30m" to 0, "NaN" to 0, "" to 0).forEach { (text, expected) -> assertEquals(text, expected, BusinessRules.duration(text)) }
    }
    @Test fun mobileIdentityAndDatesRejectInvalidInput() {
        assertEquals("+919876543210", BusinessRules.phone("+91 98765 43210"))
        assertThrows(IllegalArgumentException::class.java) { BusinessRules.phone("1234") }
        BusinessRules.date("2028-02-29")
        assertThrows(IllegalArgumentException::class.java) { BusinessRules.date("2026-02-29") }
    }
    @Test fun reservationKeysMatchTheWebFiveMinuteGrid() {
        assertEquals(listOf("victoria-sterling_2026-10-22_1200", "victoria-sterling_2026-10-22_1205"), BusinessRules.locks("Victoria Sterling", "2026-10-22", "12:03", 7))
        assertThrows(IllegalArgumentException::class.java) { BusinessRules.locks("Stylist", "2026-10-22", "23:55", 30) }
    }
}
