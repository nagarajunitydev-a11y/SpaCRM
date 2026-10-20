// There is deliberately no environment switch that bypasses Play enrollment.
// Enable native purchases only through a reviewed Play Billing / enrolled
// alternative-billing implementation with its required reporting and UX.
export function isNativeCheckout(request) {
    const ua = request.headers.get('user-agent') || '';
    return /QvrixGlowOSAndroid|;\s*wv\)/i.test(ua)
        || request.headers.get('x-qvrix-platform') === 'android';
}
