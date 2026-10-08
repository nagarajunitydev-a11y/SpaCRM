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
    return { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' };
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
export async function purchase({ planId, billingCycle, method = 'any', salonId = null, user = {} }) {
    if (isDemoMode()) throw new PaymentsUnavailable('Payments are disabled in demo mode.');

    const created = await api('create-order', { planId, billingCycle, salonId });
    if (created.status !== 200) {
        const err = new Error(created.body.error || 'Could not start the payment.');
        err.code = created.body.code;
        throw err;
    }
    const order = created.body;
    const gateway = getBrowserGateway(order.gateway);
    const result = await gateway.openCheckout(order, { method, user });

    if (result.status === 'dismissed') {
        await api('cancel', { orderId: order.orderId }).catch(() => {});
        return { status: 'CANCELLED', orderId: order.orderId, message: 'Payment cancelled. You have not been charged.' };
    }
    if (result.status === 'failed') {
        return { status: 'FAILED', orderId: order.orderId, message: result.reason || 'Payment failed. You have not been charged.' };
    }

    const verified = await api('verify', {
        orderId: result.orderId,
        paymentId: result.paymentId,
        signature: result.signature,
    });
    const b = verified.body;
    if (verified.status === 200 && b.status === 'SUCCESS') {
        return { status: 'SUCCESS', orderId: order.orderId, duplicate: !!b.duplicate, message: 'Payment successful. Your plan is active.' };
    }
    if (verified.status === 200 && b.status === 'FAILED') {
        return { status: 'FAILED', orderId: order.orderId, message: b.reason || 'Payment failed.' };
    }
    if (verified.status === 202) {
        return { status: 'PENDING', orderId: order.orderId, message: 'Your payment is being confirmed. This page will update automatically.' };
    }
    return { status: 'FAILED', orderId: order.orderId, message: b.error || 'We could not verify your payment. If money was deducted it will be confirmed or refunded automatically.' };
}

export default { purchase, PaymentsUnavailable };
