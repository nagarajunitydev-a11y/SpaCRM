package com.qvrix.glowos.nativeapp.domain

import org.junit.Assert.*
import org.junit.Test

class MoneyTest {
    @Test fun exactMinorUnitsAndDiscountClamp() {
        assertEquals(1001L, Money.minor("10.01"))
        assertEquals("10.01", Money.format(1001))
        assertEquals(0L, Money.total(listOf(100, 200), 500))
        assertEquals(250L, Money.total(listOf(100, 200), 50))
    }
    @Test fun rejectsInvalidAndFractionalMinorAmounts() {
        for (value in listOf("-1", "NaN", "Infinity", "1.001", "1000001", "")) {
            assertTrue(value, runCatching { Money.minor(value) }.isFailure)
        }
    }
    @Test fun overflowIsNeverSilentlyWrapped() {
        assertTrue(runCatching { Money.total(listOf(Long.MAX_VALUE, 1), 0) }.isFailure)
    }
}
