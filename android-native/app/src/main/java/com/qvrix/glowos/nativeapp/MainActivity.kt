package com.qvrix.glowos.nativeapp

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import com.razorpay.PaymentData
import com.razorpay.PaymentResultWithDataListener

class MainActivity : ComponentActivity(), PaymentResultWithDataListener {
    val model: OnlineViewModel by viewModels()
    private lateinit var billing: NativeBilling
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        billing = NativeBilling(this, model)
        setContent { GlowTheme { GlowApp(model) { billing.purchase() } } }
    }
    override fun onDestroy() { billing.close(); super.onDestroy() }
    override fun onResume() { super.onResume(); if (model.authenticated && !model.busy) model.refresh() }
    override fun onPaymentSuccess(id: String?, data: PaymentData?) {
        if (id != null && data?.orderId != null && data.signature != null) model.verifyRazorpay(id, data.orderId, data.signature)
        else model.providerFailure("Payment result is incomplete. Check payment history before retrying.")
    }
    override fun onPaymentError(code: Int, message: String?, data: PaymentData?) {
        model.providerFailure("Payment was not verified. ${message.orEmpty()}")
    }
}
