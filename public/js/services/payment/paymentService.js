/**
 * paymentService.js
 * Orchestrates a subscription purchase. Gateway-agnostic: it talks to our own
 * /api/subscription/* endpoints (the server holds the secrets and verifies
 * every payment) and to whichever browser gateway the server names.
 *
 * Success is NEVER decided here. A paid result only triggers the server's
 * verify call; the subscription changes when the server (or the signed
 * webhook) says so, and the Firestore listener then refreshes access.
 */

import { getFirebase, isDemoMode } from '../firebase.js';
import { getBrowserGateway } from './index.js';
import { isNativePaymentContext } from '../../core/platform.js';
import { isPlayBillingReady, launchPlayBilling, setNativeCheckoutActive } from './playBilling.js';

export class PaymentsUnavailable extends Error {
    constructor(msg = 'Online payments are not available right now.') {
        super(msg);
        this.name = 'PaymentsUnavailable';
    }
}

async function authHeader() {
    const fb = getFirebase();
    const user = fb && fb.auth.currentUser;
    if (!user) throw new Error('Please sign in again to continue.');
    return { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json',
        'X-Qvrix-Platform': isNativePaymentContext() ? 'android' : 'web' };
}

async function api(path, body) {
    let res;
    try {
        res = await fetch(`/api/subscription/${path}`, { method: 'POST', headers: await authHeader(), body: JSON.stringify(body) });
    } catch {
        throw new PaymentsUnavailable('Could not reach the payment server. Check your connection.');
    }
    // A non-JSON reply means the /api routes are not deployed behind this host.
    const json = await res.json().catch(() => null);
    if (!json) throw new PaymentsUnavailable('The payment service is not deployed on this host.');
    if (res.status === 503) throw new PaymentsUnavailable(json.error);
    return { status: res.status, body: json };
}

/**
 * Run a full purchase. Resolves to one of:
 *   { status: 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'PENDING', message, ... }
 * and throws PaymentsUnavailable / Error for setup problems.
 */
export async function purchase(options) {
    if (isDemoMode()) throw new PaymentsUnavailable('Payments are disabled in demo mode.');
    if (isNativePaymentContext()) return purchaseInApp(options);
    return gatewayCheckout(options);
}

/**
 * Android app (Google Play distribution): Google Play's user-choice screen
 * comes first. Google Play billing is verified by our server; choosing the
 * alternative continues with the same gateway checkout as the website,
 * carrying Google's token so the server can report the transaction.
 */
async function purchaseInApp({ planId, billingCycle, salonId = null, user = {}, renewalMode = 'manual', idempotencyKey, taxState }) {
    if (renewalMode !== 'manual' || !isPlayBillingReady()) throw new PaymentsUnavailable('Subscription purchases are not available in this Android app.');
    const prepared = await api('play-prepare', { planId, billingCycle, salonId });
    if (prepared.status !== 200) throw Object.assign(new Error(prepared.body.error || 'Could not start the purchase.'), { code: prepared.body.code });
    const play = prepared.body;
    let externalTransactionToken;
    if (play.mode !== 'alt-topup') {
        const choice = await launchPlayBilling(play);
        if (choice.type === 'cancelled') return { status: 'CANCELLED', message: 'Purchase cancelled. You have not been charged.' };
        if (choice.type === 'purchase') return verifyPlayPurchase(choice.purchaseToken);
        if (choice.type !== 'alternative') return { status: 'FAILED', message: choice.message || 'Google Play could not start the purchase.' };
        externalTransactionToken = choice.token;
    }
    setNativeCheckoutActive(true);
    try {
        return await gatewayCheckout({ planId, billingCycle, salonId, user, idempotencyKey, method: 'any',
            extra: { taxState, ...(externalTransactionToken ? { externalTransactionToken } : {}) } });
    } finally {
        setNativeCheckoutActive(false);
    }
}

/** Server-side verification of a Google Play purchase token (also used to recover unfinished purchases). */
export async function verifyPlayPurchase(purchaseToken) {
    const verified = await api('play-verify', { purchaseToken });
    const b = verified.body;
    if (verified.status === 200 && b.status === 'SUCCESS') return { status: 'SUCCESS', message: 'Payment successful. Your plan is active.' };
    if (verified.status === 202) return { status: 'PENDING', message: b.message };
    return { status: 'FAILED', message: b.reason || b.error || 'We could not verify this Google Play purchase.' };
}

async function gatewayCheckout({ planId, billingCycle, method = 'any', salonId = null, user = {}, renewalMode = 'manual', idempotencyKey, resumeSubscriptionId, extra = {} }) {
    const automatic = renewalMode === 'automatic';
    const created = await api(automatic ? 'create-recurring' : 'create-order', {
        planId, billingCycle, salonId, idempotencyKey, ...(automatic ? { consent: true, resumeSubscriptionId } : extra),
    });
    if (created.status !== 200) {
        const err = new Error(created.body.error || 'Could not start the payment.');
        err.code = created.body.code;
        throw err;
    }
    const order = created.body;
    const gateway = getBrowserGateway(order.gateway);
    const result = await gateway.openCheckout(order, { method: automatic ? 'any' : method, user, inApp: isNativePaymentContext() });

    if (result.status === 'dismissed') {
        await api(automatic ? 'manage-recurring' : 'cancel', automatic ? { subscriptionId: order.subscriptionId, action: 'cancel' } : { orderId: order.orderId }).catch(() => {});
        return { status: 'CANCELLED', orderId: order.orderId, message: 'Checkout closed. Any completed payment will appear in your payment history.' };
    }
    if (result.status === 'failed') {
        return { status: 'FAILED', orderId: order.orderId, message: result.reason || 'Payment failed. You have not been charged.' };
    }

    const verified = await api(automatic ? 'verify-recurring' : 'verify', {
        orderId: result.orderId,
        ...(automatic ? { subscriptionId: order.subscriptionId } : {}),
        paymentId: result.paymentId,
        signature: result.signature,
    });
    const b = verified.body;
    if (automatic && verified.status === 200 && b.status === 'PENDING') return { status: 'PENDING', message: b.message };
    if (verified.status === 200 && b.status === 'SUCCESS') {
        return { status: 'SUCCESS', orderId: order.orderId, duplicate: !!b.duplicate, message: 'Payment successful. Your plan is active.' };
    }
    if (verified.status === 200 && b.status === 'FAILED') {
        return { status: 'FAILED', orderId: order.orderId, message: b.reason || 'Payment failed.' };
    }
    if (verified.status === 202) {
        return { status: 'PENDING', orderId: order.orderId, message: b.message || 'Your payment is being confirmed. This page will update automatically.' };
    }
    return { status: 'FAILED', orderId: order.orderId, message: b.error || 'We could not verify your payment. If money was deducted it will be confirmed or refunded automatically.' };
}

export async function manageAutomaticRenewal(body) {
    if (isDemoMode() || (isNativePaymentContext() && body.action !== 'cancel')) throw new PaymentsUnavailable('Subscription changes are not available in this app.');
    const result = await api('manage-recurring', body);
    if (result.status !== 200) throw new Error(result.body.error || 'Could not update automatic renewal.');
    return result.body;
}

export default { purchase, verifyPlayPurchase, PaymentsUnavailable };
