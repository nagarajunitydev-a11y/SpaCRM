package com.qvrix.glowos.nativeapp

import com.android.billingclient.api.*
import com.razorpay.Checkout
import com.qvrix.glowos.nativeapp.online.*
import org.json.JSONObject

/** Provider UI only; entitlement always comes from our authenticated server. */
class NativeBilling(private val activity: MainActivity, private val vm: OnlineViewModel) : PurchasesUpdatedListener, UserChoiceBillingListener {
    private val client = BillingClient.newBuilder(activity).setListener(this)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .enableUserChoiceBilling(this).build()
    private var opening = false
    init { connect() }
    private fun connect() {
        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                if (result.responseCode == BillingClient.BillingResponseCode.OK) client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build()) { r, purchases ->
                    if (r.responseCode == BillingClient.BillingResponseCode.OK) purchases.filter { !it.isAcknowledged && it.purchaseState == Purchase.PurchaseState.PURCHASED }.forEach { p -> activity.runOnUiThread { vm.verifyPlay(p.purchaseToken) } }
                }
            }
            override fun onBillingServiceDisconnected() { opening = false }
        })
    }
    fun purchase() {
        if (opening || vm.busy) return
        if (!client.isReady) { connect(); vm.providerFailure("Google Play Billing is not connected. Check the Play Store account and try again."); return }
        opening = true
        vm.launch {
            try {
                val prepared = vm.preparePurchase()
                if (prepared.str("mode") == "alt-topup") { opening = false; alternative(null); return@launch }
                val query = QueryProductDetailsParams.newBuilder().setProductList(listOf(QueryProductDetailsParams.Product.newBuilder().setProductId(prepared.str("productId")).setProductType(BillingClient.ProductType.SUBS).build())).build()
                client.queryProductDetailsAsync(query) { result, details -> activity.runOnUiThread {
                    val product = details.productDetailsList.firstOrNull()
                    val offer = product?.subscriptionOfferDetails?.find { it.basePlanId == prepared.str("basePlanId") && it.offerId == null }
                    if (result.responseCode != BillingClient.BillingResponseCode.OK || product == null || offer == null) { fail("This plan is not available in Google Play yet."); return@runOnUiThread }
                    val flow = BillingFlowParams.newBuilder().setProductDetailsParamsList(listOf(BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(product).setOfferToken(offer.offerToken).build())).setObfuscatedAccountId(prepared.str("accountId"))
                    when (prepared.str("mode")) {
                        "alt-upgrade" -> { flow.setSubscriptionUpdateParams(BillingFlowParams.SubscriptionUpdateParams.newBuilder().setOriginalExternalTransactionId(prepared.str("originalExternalTransactionId")).build()); launch(flow) }
                        "play-upgrade" -> client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build()) { r, purchases -> activity.runOnUiThread {
                            val old = purchases.find { it.products.contains(prepared.str("oldProductId")) }
                            if (r.responseCode != BillingClient.BillingResponseCode.OK || old == null) fail("Your current subscription was not found in this Google account.")
                            else { flow.setSubscriptionUpdateParams(BillingFlowParams.SubscriptionUpdateParams.newBuilder().setOldPurchaseToken(old.purchaseToken).setSubscriptionReplacementMode(BillingFlowParams.SubscriptionUpdateParams.ReplacementMode.WITH_TIME_PRORATION).build()); launch(flow) }
                        } }
                        else -> launch(flow)
                    }
                } }
            } catch (e: Exception) { opening = false; throw e }
        }
    }
    private fun launch(flow: BillingFlowParams.Builder) { if (client.launchBillingFlow(activity, flow.build()).responseCode != BillingClient.BillingResponseCode.OK) fail("Google Play could not start the purchase.") }
    private fun fail(message: String) { opening = false; vm.providerFailure(message) }
    override fun onPurchasesUpdated(result: BillingResult, purchases: MutableList<Purchase>?) {
        opening = false
        activity.runOnUiThread {
            if (result.responseCode == BillingClient.BillingResponseCode.OK && !purchases.isNullOrEmpty()) purchases.forEach { p ->
                if (p.purchaseState == Purchase.PurchaseState.PURCHASED) vm.verifyPlay(p.purchaseToken) else vm.providerFailure("Payment is pending. Access will update after server verification.")
            } else vm.providerFailure(if (result.responseCode == BillingClient.BillingResponseCode.USER_CANCELED) "Checkout closed. Check payment history before retrying." else "Google Play could not complete the purchase. ${result.debugMessage}")
        }
    }
    override fun userSelectedAlternativeBilling(details: UserChoiceDetails) { opening = false; activity.runOnUiThread { alternative(details.externalTransactionToken) } }
    private fun alternative(token: String?) {
        // Launch on the next main-thread cycle so the prepare request can release its busy state.
        activity.window.decorView.post {
            vm.launch {
                val plan = requireNotNull(vm.checkoutPlan)
                val order = vm.subscriptionApi.call("create-order", json("planId" to plan.str("id"), "billingCycle" to vm.checkoutCycle,
                    "salonId" to vm.snapshot?.branch?.id, "idempotencyKey" to vm.checkoutKey, "taxState" to vm.taxState,
                    "externalTransactionToken" to token))
                check(order.str("gateway") == "razorpay") { "The configured payment gateway is not supported by this Android build." }
                vm.pendingOrder = order
                val checkout = Checkout(); checkout.setKeyID(order.str("keyId"))
                checkout.open(activity, json("name" to "Qvrix GlowOS", "description" to plan.str("name"), "order_id" to order.str("orderId"),
                    "amount" to order.num("amountMinor"), "currency" to order.str("currency", "INR"), "prefill" to json("email" to vm.app.auth.currentUser?.email), "theme" to json("color" to "#e11d74")))
            }
        }
    }
    fun close() { client.endConnection() }
}
