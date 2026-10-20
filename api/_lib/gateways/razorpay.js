/**
 * Razorpay implementation of the server-side PaymentGateway contract.
 *
 * Contract (every gateway module exports createGateway(env) returning):
 *   id                                          'razorpay'
 *   publicKey()                                 key the browser checkout needs
 *   createOrder({amountMinor,currency,receipt,notes}) -> { id, amountMinor, currency }
 *   verifyCheckoutSignature(orderId,paymentId,signature) -> boolean
 *   fetchPayment(paymentId) -> { id, orderId, status, amountMinor, currency, method, errorDescription }
 *   capturePayment(paymentId, amountMinor, currency)
 *   verifyWebhookSignature(rawBody, signature) -> boolean
 *   parseWebhook(json) -> { kind, orderId, paymentId, amountMinor, method, reason, refundAmountMinor } | null
 *   createPlan({name,amountMinor,currency,billingCycle}) -> {id}
 *   createSubscription({planId,startAt,billingCycle,notes}) -> mandate
 *   fetchSubscription(id), cancelSubscription(id,atCycleEnd), updateSubscription(id,planId)
 *   fetchInvoice(id), fetchInvoices(subscriptionId,skip) -> trusted invoice(s)
 *   verifySubscriptionSignature(subscriptionId,paymentId,signature) -> boolean
 * Recurring invoice contract: id, subscription_id, payment_id, order_id,
 * status, amount_paid (minor units), currency, billing_start/billing_end
 * (Unix seconds), line_items. Alternative adapters map their invoice entities
 * to this contract; raw payment/bank/card details never leave this adapter.
 *
 * Handlers only use this contract, so swapping gateways means adding a file
 * next to this one and changing PAYMENT_GATEWAY — no handler/UI changes.
 */

import crypto from 'node:crypto';

const API = 'https://api.razorpay.com/v1';

export class GatewayNotConfigured extends Error {
    constructor(msg = 'Payment gateway is not configured on the server.') {
        super(msg);
        this.name = 'GatewayNotConfigured';
    }
}

function safeEqualHex(a, b) {
    try {
        if (!/^[a-f0-9]{64}$/i.test(String(a)) || !/^[a-f0-9]{64}$/i.test(String(b))) return false;
        const x = Buffer.from(String(a), 'hex');
        const y = Buffer.from(String(b), 'hex');
        return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
    } catch {
        return false;
    }
}

export function hmacSha256Hex(secret, payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function createGateway(env = process.env, fetchImpl = fetch) {
    const keyId = env.RAZORPAY_KEY_ID;
    const keySecret = env.RAZORPAY_KEY_SECRET;
    const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;

    function requireKeys() {
        if (!keyId || !keySecret) throw new GatewayNotConfigured();
        if (env.VERCEL_ENV === 'production' && /^rzp_test_/.test(keyId)) {
            throw new GatewayNotConfigured('Test billing must run in an isolated staging environment.');
        }
        if (!/^rzp_test_/.test(keyId) && !(env.PAYMENTS_LIVE_ENABLED === 'true' && /^rzp_live_/.test(keyId))) {
            throw new GatewayNotConfigured('Live payments require an explicit server-side enablement.');
        }
    }

    async function call(method, path, body) {
        requireKeys();
        const res = await fetchImpl(`${API}${path}`, {
            method,
            headers: {
                Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = json && json.error && json.error.description ? json.error.description : `Gateway error ${res.status}`;
            const err = new Error(msg);
            err.gatewayStatus = res.status;
            throw err;
        }
        return json;
    }

    return {
        id: 'razorpay',
        publicKey() {
            requireKeys();
            return keyId;
        },
        async createOrder({ amountMinor, currency, receipt, notes }) {
            const o = await call('POST', '/orders', { amount: amountMinor, currency, receipt, notes });
            return { id: o.id, amountMinor: o.amount, currency: o.currency };
        },
        async createPlan({ name, amountMinor, currency, billingCycle }) {
            return call('POST', '/plans', {
                period: billingCycle === 'annual' ? 'yearly' : 'monthly', interval: 1,
                item: { name, amount: amountMinor, currency },
            });
        },
        createSubscription({ planId, startAt, billingCycle, notes }) {
            return call('POST', '/subscriptions', {
                plan_id: planId, quantity: 1, total_count: billingCycle === 'annual' ? 10 : 120,
                start_at: Math.ceil(startAt / 1000), customer_notify: true, notes,
            });
        },
        fetchSubscription(id) { return call('GET', `/subscriptions/${encodeURIComponent(id)}`); },
        cancelSubscription(id, atCycleEnd = true) {
            return call('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atCycleEnd });
        },
        updateSubscription(id, planId) {
            return call('PATCH', `/subscriptions/${encodeURIComponent(id)}`, { plan_id: planId, schedule_change_at: 'cycle_end', customer_notify: true });
        },
        async fetchInvoices(id, skip = 0) {
            const response = await call('GET', `/invoices?subscription_id=${encodeURIComponent(id)}&count=100&skip=${skip}`);
            return response.items || [];
        },
        fetchInvoice(id) { return call('GET', `/invoices/${encodeURIComponent(id)}`); },
        verifySubscriptionSignature(subscriptionId, paymentId, signature) {
            requireKeys();
            return !!subscriptionId && !!paymentId && safeEqualHex(hmacSha256Hex(keySecret, `${paymentId}|${subscriptionId}`), signature);
        },
        verifyCheckoutSignature(orderId, paymentId, signature) {
            requireKeys();
            if (!orderId || !paymentId || !signature) return false;
            return safeEqualHex(hmacSha256Hex(keySecret, `${orderId}|${paymentId}`), signature);
        },
        async fetchPayment(paymentId) {
            const p = await call('GET', `/payments/${encodeURIComponent(paymentId)}`);
            return {
                id: p.id,
                orderId: p.order_id,
                status: p.status, // created | authorized | captured | refunded | failed
                amountMinor: p.amount,
                currency: p.currency,
                method: p.method || null,
                errorDescription: p.error_description || null,
                invoiceId: p.invoice_id || null,
                refundedAmountMinor: p.amount_refunded || 0,
            };
        },
        async capturePayment(paymentId, amountMinor, currency) {
            return call('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, { amount: amountMinor, currency });
        },
        verifyWebhookSignature(rawBody, signature) {
            if (!webhookSecret) throw new GatewayNotConfigured('Webhook secret is not configured.');
            if (!signature) return false;
            return safeEqualHex(hmacSha256Hex(webhookSecret, rawBody), signature);
        },
        parseWebhook(json) {
            const ev = json && json.event;
            const payload = (json && json.payload) || {};
            const pay = payload.payment && payload.payment.entity;
            const ref = payload.refund && payload.refund.entity;
            const subscription = payload.subscription && payload.subscription.entity;
            if (ev?.startsWith('subscription.') && subscription) {
                return { kind: 'RECURRING', event: ev, createdAt: json.created_at * 1000,
                    subscription: {
                        id: subscription.id, planId: subscription.plan_id, status: subscription.status,
                        periodStart: subscription.current_start * 1000, periodEnd: subscription.current_end * 1000,
                    }, paymentId: pay?.id || null };
            }
            if ((ev === 'payment.captured' || ev === 'order.paid') && pay) {
                return { kind: 'PAYMENT_CAPTURED', orderId: pay.order_id, paymentId: pay.id, invoiceId: pay.invoice_id || null, amountMinor: pay.amount, currency: pay.currency, method: pay.method || null };
            }
            if (ev === 'payment.failed' && pay) {
                return { kind: 'PAYMENT_FAILED', orderId: pay.order_id, paymentId: pay.id, invoiceId: pay.invoice_id || null, reason: pay.error_description || 'Payment failed' };
            }
            if (ev === 'refund.processed' && ref) {
                return { kind: 'REFUND', paymentId: ref.payment_id, refundAmountMinor: ref.amount };
            }
            return null;
        },
    };
}

export default createGateway;
