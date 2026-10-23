package com.qvrix.glowos.nativeapp.domain

import java.math.BigDecimal
import java.math.RoundingMode

object Money {
    fun minor(value: String): Long {
        val number = value.trim().toBigDecimalOrNull() ?: error("Enter a valid amount.")
        require(number.signum() >= 0 && number <= BigDecimal("1000000")) { "Amount must be between 0 and 1,000,000." }
        return number.movePointRight(2).setScale(0, RoundingMode.UNNECESSARY).longValueExact()
    }
    fun format(value: Long): String = BigDecimal.valueOf(value, 2).setScale(2).toPlainString()
    fun total(amounts: List<Long>, discount: Long): Long {
        require(amounts.all { it >= 0 } && discount >= 0)
        val gross = amounts.fold(0L) { sum, value -> Math.addExact(sum, value) }
        return gross - discount.coerceAtMost(gross)
    }
}
