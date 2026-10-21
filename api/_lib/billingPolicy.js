// There is deliberately no environment switch that bypasses Play enrollment.
// Native purchases are allowed only through Google Play's user-choice flow
// (alternative billing for India), which needs Play Console enrollment, Play
// products and a Play Developer API service account (see googlePlay.js).
export function isNativeCheckout(request) {
    const ua = request.headers.get('user-agent') || '';
    return /QvrixGlowOSAndroid|;\s*wv\)/i.test(ua)
        || request.headers.get('x-qvrix-platform') === 'android';
}

/** Server switch, set only after Play Console enrollment and product setup. */
export function altBillingEnabled(env = process.env) {
    return env.GOOGLE_PLAY_ALT_BILLING_ENABLED === 'true';
}

/**
 * Which authenticated endpoints a native (Play-distributed) client may call.
 * A Razorpay order from the app must carry Google's external transaction
 * token, or continue an in-app alternative-billing series (checked by the
 * handler). Automatic Razorpay mandates stay web-only.
 */
export function nativeCallAllowed(method, body, env = process.env) {
    if (method === 'createRecurring' || method === 'verifyRecurring') return false;
    if (method === 'manageRecurring') return body?.action === 'cancel';
    if (['createOrder', 'playPrepare', 'playVerify'].includes(method)) return altBillingEnabled(env);
    return true;
}
