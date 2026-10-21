package com.luxeglow.crm;

import android.app.Activity;
import android.net.Uri;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;

import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.android.billingclient.api.UserChoiceBillingListener;
import com.android.billingclient.api.UserChoiceDetails;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Collections;
import java.util.List;

/**
 * Google Play Billing for the hosted web app, with alternative billing user
 * choice enabled (Google Play shows its choice screen where the user's Play
 * country supports it). Exposed as `AndroidBilling` only to main-frame scripts
 * from the configured HTTPS origin via a WebMessageListener. This class never
 * grants access: purchase tokens and choice tokens go to the server, which
 * verifies or reports them.
 */
final class PlayBillingBridge implements WebViewCompat.WebMessageListener, PurchasesUpdatedListener, UserChoiceBillingListener {
    interface CheckoutWindows { void setCheckoutActive(boolean active); }

    private final Activity activity;
    private final CheckoutWindows checkoutWindows;
    private final BillingClient client;
    private JavaScriptReplyProxy reply;
    private String activeRequestId;
    private boolean connecting;

    PlayBillingBridge(Activity activity, CheckoutWindows checkoutWindows) {
        this.activity = activity;
        this.checkoutWindows = checkoutWindows;
        client = BillingClient.newBuilder(activity)
                .setListener(this)
                .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
                .enableUserChoiceBilling(this)
                .build();
    }

    void destroy() { client.endConnection(); }

    @Override
    public void onPostMessage(@NonNull WebView view, @NonNull WebMessageCompat message, @NonNull Uri sourceOrigin,
                              boolean isMainFrame, @NonNull JavaScriptReplyProxy replyProxy) {
        if (!isMainFrame || message.getData() == null) return;
        reply = replyProxy;
        try {
            JSONObject msg = new JSONObject(message.getData());
            switch (msg.optString("type")) {
                case "init": connect(); break;
                case "launch": launch(msg); break;
                case "checkout": checkoutWindows.setCheckoutActive(msg.optBoolean("active")); break;
                default: break;
            }
        } catch (JSONException ignored) {
            // Malformed messages are ignored.
        }
    }

    private void connect() {
        if (client.isReady()) { onConnected(); return; }
        if (connecting) return;
        connecting = true;
        client.startConnection(new BillingClientStateListener() {
            @Override public void onBillingSetupFinished(@NonNull BillingResult result) {
                connecting = false;
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) onConnected();
                else send(new JSONObjectBuilder().put("type", "ready").put("available", false).build());
            }
            @Override public void onBillingServiceDisconnected() { connecting = false; }
        });
    }

    private void onConnected() {
        boolean subscriptions = client.isFeatureSupported(BillingClient.FeatureType.SUBSCRIPTIONS).getResponseCode()
                == BillingClient.BillingResponseCode.OK;
        send(new JSONObjectBuilder().put("type", "ready").put("available", subscriptions).build());
        if (!subscriptions) return;
        // Unacknowledged purchases (e.g. the app closed before verification) are handed to the web app.
        client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build(),
                (result, purchases) -> {
                    if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) return;
                    for (Purchase p : purchases) {
                        if (!p.isAcknowledged() && p.getPurchaseState() == Purchase.PurchaseState.PURCHASED) sendPurchase(null, p);
                    }
                });
    }

    private void launch(JSONObject msg) {
        String requestId = msg.optString("requestId");
        if (activeRequestId != null) { sendError(requestId, "Another purchase is already open."); return; }
        if (!client.isReady()) { sendError(requestId, "Google Play billing is not connected. Try again."); return; }
        String productId = msg.optString("productId");
        String basePlanId = msg.optString("basePlanId");
        activeRequestId = requestId;
        QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
                .setProductList(Collections.singletonList(QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(productId).setProductType(BillingClient.ProductType.SUBS).build()))
                .build();
        client.queryProductDetailsAsync(params, (result, details) -> activity.runOnUiThread(() -> {
            List<ProductDetails> list = details.getProductDetailsList();
            ProductDetails product = list.isEmpty() ? null : list.get(0);
            String offerToken = product == null ? null : baseOfferToken(product, basePlanId);
            if (result.getResponseCode() != BillingClient.BillingResponseCode.OK || offerToken == null) {
                finishWithError("This plan is not available in Google Play yet.");
                return;
            }
            BillingFlowParams.Builder flow = BillingFlowParams.newBuilder()
                    .setProductDetailsParamsList(Collections.singletonList(BillingFlowParams.ProductDetailsParams.newBuilder()
                            .setProductDetails(product).setOfferToken(offerToken).build()))
                    .setObfuscatedAccountId(msg.optString("accountId"));
            String mode = msg.optString("mode");
            if ("alt-upgrade".equals(mode)) {
                // Plan change of a subscription bought through the alternative: no choice screen, new token.
                flow.setSubscriptionUpdateParams(BillingFlowParams.SubscriptionUpdateParams.newBuilder()
                        .setOriginalExternalTransactionId(msg.optString("originalExternalTransactionId")).build());
                launchFlow(flow);
            } else if ("play-upgrade".equals(mode)) {
                upgradePlaySubscription(flow, msg.optString("oldProductId"));
            } else {
                launchFlow(flow);
            }
        }));
    }

    private void upgradePlaySubscription(BillingFlowParams.Builder flow, String oldProductId) {
        client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build(),
                (result, purchases) -> activity.runOnUiThread(() -> {
                    for (Purchase p : purchases) {
                        if (p.getProducts().contains(oldProductId)) {
                            flow.setSubscriptionUpdateParams(BillingFlowParams.SubscriptionUpdateParams.newBuilder()
                                    .setOldPurchaseToken(p.getPurchaseToken())
                                    .setSubscriptionReplacementMode(BillingFlowParams.SubscriptionUpdateParams.ReplacementMode.WITH_TIME_PRORATION)
                                    .build());
                            launchFlow(flow);
                            return;
                        }
                    }
                    finishWithError("Your current Google Play subscription was not found on this device's Google account.");
                }));
    }

    private void launchFlow(BillingFlowParams.Builder flow) {
        BillingResult result = client.launchBillingFlow(activity, flow.build());
        if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) finishWithError("Google Play could not start the purchase.");
    }

    private static String baseOfferToken(ProductDetails product, String basePlanId) {
        List<ProductDetails.SubscriptionOfferDetails> offers = product.getSubscriptionOfferDetails();
        if (offers == null) return null;
        for (ProductDetails.SubscriptionOfferDetails offer : offers) {
            // The base-plan offer only, so the price matches the catalog (no trials or discounts).
            if (basePlanId.equals(offer.getBasePlanId()) && offer.getOfferId() == null) return offer.getOfferToken();
        }
        return null;
    }

    /** Google Play choice screen: the user picked the alternative (Razorpay) billing system. */
    @Override
    public void userSelectedAlternativeBilling(@NonNull UserChoiceDetails details) {
        String requestId = activeRequestId;
        activeRequestId = null;
        send(new JSONObjectBuilder().put("requestId", requestId).put("type", "alternative")
                .put("token", details.getExternalTransactionToken()).build());
    }

    /** Google Play billing result (the user picked Google Play, cancelled, or it failed). */
    @Override
    public void onPurchasesUpdated(@NonNull BillingResult result, List<Purchase> purchases) {
        String requestId = activeRequestId;
        activeRequestId = null;
        int code = result.getResponseCode();
        if (code == BillingClient.BillingResponseCode.OK && purchases != null && !purchases.isEmpty()) {
            for (Purchase p : purchases) sendPurchase(requestId, p);
        } else if (code == BillingClient.BillingResponseCode.USER_CANCELED) {
            send(new JSONObjectBuilder().put("requestId", requestId).put("type", "cancelled").build());
        } else if (code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) {
            sendError(requestId, "This Google account already has this subscription. Manage it in Google Play.");
        } else {
            sendError(requestId, "Google Play could not complete the purchase.");
        }
    }

    private void sendPurchase(String requestId, Purchase p) {
        send(new JSONObjectBuilder().put("requestId", requestId).put("type", "purchase")
                .put("purchaseToken", p.getPurchaseToken())
                .put("state", p.getPurchaseState() == Purchase.PurchaseState.PENDING ? "PENDING" : "PURCHASED").build());
    }

    private void finishWithError(String message) {
        String requestId = activeRequestId;
        activeRequestId = null;
        sendError(requestId, message);
    }

    private void sendError(String requestId, String message) {
        send(new JSONObjectBuilder().put("requestId", requestId).put("type", "error").put("message", message).build());
    }

    // A reply proxy exists only after a message arrived through the listener,
    // which LauncherActivity registers only when WEB_MESSAGE_LISTENER is supported.
    @android.annotation.SuppressLint("RequiresFeature")
    private void send(String json) {
        activity.runOnUiThread(() -> { if (reply != null) reply.postMessage(json); });
    }

    /** JSONObject.put throws only for non-finite numbers, which are never used here. */
    private static final class JSONObjectBuilder {
        private final JSONObject o = new JSONObject();
        JSONObjectBuilder put(String k, Object v) {
            try { o.put(k, v == null ? JSONObject.NULL : v); } catch (JSONException ignored) { }
            return this;
        }
        String build() { return o.toString(); }
    }
}
