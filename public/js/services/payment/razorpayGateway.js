/**
 * razorpayGateway.js
 * Browser side of the Razorpay integration: opens the hosted Checkout sheet.
 * Card numbers, CVV and UPI PINs are typed into Razorpay's own secure sheet —
 * they never touch this app, our servers or Firestore.
 *
 * Contract (shared by every browser gateway module):
 *   id
 *   openCheckout(order, { method, user }) ->
 *       { status: 'paid', orderId, paymentId, signature }
 *     | { status: 'dismissed' }
 *     | { status: 'failed', reason }
 */

const SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
const ALL_METHODS = ['upi', 'card', 'netbanking', 'wallet'];

let loading = null;
function loadScript() {
    if (typeof window !== 'undefined' && window.Razorpay) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = SCRIPT_SRC;
        el.async = true;
        el.onload = () => resolve();
        el.onerror = () => { loading = null; reject(new Error('Could not load the payment window. Check your connection and try again.')); };
        document.head.appendChild(el);
    });
    return loading;
}

export const razorpayGateway = {
    id: 'razorpay',

    async openCheckout(order, { method = 'any', user = {} } = {}) {
        await loadScript();
        return new Promise((resolve) => {
            let settled = false;
            let lastFailure = null;
            const done = (result) => {
                if (settled) return;
                settled = true;
                resolve(result);
            };
            // Narrow the sheet to the method the owner picked on our screen by
            // hiding the others; "any" shows everything the account supports.
            const hide = method === 'any' ? [] : ALL_METHODS.filter((m) => m !== method).map((m) => ({ method: m }));

            const rzp = new window.Razorpay({
                key: order.keyId,
                order_id: order.orderId,
                amount: order.amountMinor,
                currency: order.currency,
                name: 'Qvrix GlowOS',
                description: order.description,
                prefill: { email: user.email || '', name: user.name || '' },
                theme: { color: '#db2777' },
                config: { display: { hide } },
                handler: (resp) => done({
                    status: 'paid',
                    orderId: resp.razorpay_order_id,
                    paymentId: resp.razorpay_payment_id,
                    signature: resp.razorpay_signature,
                }),
                modal: {
                    ondismiss: () => done(lastFailure ? { status: 'failed', reason: lastFailure } : { status: 'dismissed' }),
                },
            });
            // A failed attempt leaves the sheet open so the customer can retry.
            rzp.on('payment.failed', (resp) => {
                lastFailure = (resp && resp.error && resp.error.description) || 'Payment failed';
            });
            rzp.open();
        });
    },
};

export default razorpayGateway;
