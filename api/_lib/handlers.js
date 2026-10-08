/**
 * handlers.js
 * Gateway-agnostic subscription payment logic, written against two injected
 * interfaces so it can be unit tested with in-memory fakes and run in
 * production on firebase-admin + a real gateway:
 *
 *   db: {
 *     get(path)            -> object | null        (dates as epoch ms)
 *     list(collectionPath) -> [{ id, ...data }]
 *     set(path, data)
 *     transaction(fn)      -> fn({ get(path), set(path, data) })
 *   }
 *   gateway: see gateways/razorpay.js for the contract.
 *
 * Every handler returns `{ status, body }`. Nothing here trusts the browser:
 * amounts are recomputed from the plan catalog, success is only ever derived
 * from the gateway (signature check + a server-side fetch of the payment, or
 * a signed webhook), and every transition is idempotent so repeated
 * callbacks, double verifies and page refreshes cannot extend a period twice.
 */

import { mergePlans, formatINR } from '../../public/js/core/plans.js';
import {
    PAY_STATUS, quotePurchase, applyPaymentSuccess, applyPaymentFailure,
    applyPaymentCancelled, applyRefund, receiptNumberFor, effectiveStatus, SUB_STATUS,
} from '../../public/js/core/subscriptionState.js';

const subPath = (uid) => `subscriptions/${uid}`;
const payPath = (uid, orderId) => `subscriptions/${uid}/payments/${orderId}`;
const evPath = (uid, id) => `subscriptions/${uid}/events/${id}`;

const ok = (body, status = 200) => ({ status, body });
const fail = (status, error, code) => ({ status, body: { error, ...(code ? { code } : {}) } });

export function createHandlers({ db, gateway, now = () => Date.now(), currency = 'INR' }) {
    async function loadPlans() {
        return mergePlans(await db.list('plans'));
    }

    function writeEvents(tx, uid, orderId, events) {
        events.forEach((e) => tx.set(evPath(uid, `${orderId}_${e.type}`), { ...e, orderId }));
    }

    /** Apply a reducer result inside the transaction; returns the outcome. */
    async function transition(uid, orderId, reducer) {
        return db.transaction(async (tx) => {
            const payment = await tx.get(payPath(uid, orderId));
            if (!payment) return { missing: true };
            const sub = await tx.get(subPath(uid));
            const res = reducer(sub, payment);
            if (!res.duplicate) {
                tx.set(payPath(uid, orderId), res.payment);
                if (res.sub) tx.set(subPath(uid), res.sub);
                writeEvents(tx, uid, orderId, res.events);
            }
            return { duplicate: res.duplicate, payment: res.payment, sub: res.sub };
        });
    }

    function publicSub(sub) {
        if (!sub) return null;
        return {
            planId: sub.planId, billingCycle: sub.billingCycle, status: sub.status,
            currentPeriodEnd: sub.currentPeriodEnd,
        };
    }

    /** Verified-capture -> activation. Shared by /verify and the webhook. */
    async function activate(uid, orderId, info) {
        const t = now();
        return transition(uid, orderId, (sub, payment) => {
            if (info.amountMinor !== Math.round(payment.amount * 100) || info.currency !== payment.currency) {
                const err = new Error('Paid amount does not match the order.');
                err.code = 'AMOUNT_MISMATCH';
                throw err;
            }
            return applyPaymentSuccess(sub, payment, t, {
                receiptNumber: receiptNumberFor(t, orderId),
                gatewayPaymentId: info.paymentId,
                method: info.method,
            });
        });
    }

    return {
        /* ---------------------------------------------------------- */
        /** POST create-order — price comes from the server catalog.   */
        async createOrder({ uid, email, body }) {
            const { planId, billingCycle, salonId = null } = body || {};
            const plans = await loadPlans();
            const sub = await db.get(subPath(uid));
            const t = now();
            const quote = quotePurchase(sub, planId, billingCycle, plans, t);
            if (!quote.ok) return fail(quote.code === 'DOWNGRADE_BLOCKED' ? 409 : 400, quote.error, quote.code);

            if (salonId) {
                const salon = await db.get(`salons/${salonId}`);
                if (!salon || salon.ownerId !== uid) return fail(403, 'That salon does not belong to your account.');
            }

            const order = await gateway.createOrder({
                amountMinor: quote.amount * 100,
                currency,
                receipt: `sub_${uid.slice(0, 10)}_${t}`.slice(0, 40),
                notes: { uid, planId, billingCycle, salonId: salonId || '' },
            });

            const payment = {
                orderId: order.id,
                subscriptionId: uid,
                ownerId: uid,
                salonId,
                planId,
                billingCycle,
                kind: quote.kind,
                amount: quote.amount,
                credit: quote.credit,
                currency,
                paymentGateway: gateway.id,
                status: PAY_STATUS.PENDING,
                gatewayPaymentId: null,
                method: null,
                receiptNumber: null,
                createdAt: t,
                paidAt: null,
                failureReason: null,
            };
            await db.set(payPath(uid, order.id), payment);
            await db.set(`paymentOrders/${order.id}`, { uid, createdAt: t });

            return ok({
                orderId: order.id,
                amountMinor: order.amountMinor,
                currency,
                gateway: gateway.id,
                keyId: gateway.publicKey(),
                kind: quote.kind,
                credit: quote.credit,
                description: `${quote.plan.name} — ${billingCycle === 'annual' ? 'annual' : 'monthly'}`,
                prefill: { email: email || '' },
            });
        },

        /* ---------------------------------------------------------- */
        /** POST verify — called by the browser after checkout returns. */
        async verifyPayment({ uid, body }) {
            const { orderId, paymentId, signature } = body || {};
            if (!orderId || !paymentId || !signature) return fail(400, 'Missing payment details.');
            const payment = await db.get(payPath(uid, orderId));
            if (!payment) return fail(404, 'Order not found.');
            // Already applied (refresh / double click / webhook got there first).
            if (payment.status === PAY_STATUS.SUCCESS) {
                return ok({ status: PAY_STATUS.SUCCESS, duplicate: true, subscription: publicSub(await db.get(subPath(uid))) });
            }
            if (!gateway.verifyCheckoutSignature(orderId, paymentId, signature)) {
                return fail(400, 'Payment signature could not be verified.', 'BAD_SIGNATURE');
            }
            // Never trust the browser: ask the gateway what actually happened.
            let gp = await gateway.fetchPayment(paymentId);
            if (gp.orderId !== orderId) return fail(400, 'Payment does not belong to this order.', 'ORDER_MISMATCH');
            if (gp.status === 'authorized') {
                await gateway.capturePayment(paymentId, gp.amountMinor, gp.currency);
                gp = await gateway.fetchPayment(paymentId);
            }
            if (gp.status === 'captured') {
                try {
                    const r = await activate(uid, orderId, {
                        paymentId, amountMinor: gp.amountMinor, currency: gp.currency, method: gp.method,
                    });
                    return ok({ status: PAY_STATUS.SUCCESS, duplicate: !!r.duplicate, subscription: publicSub(r.sub || await db.get(subPath(uid))) });
                } catch (err) {
                    if (err.code === 'AMOUNT_MISMATCH') return fail(409, err.message, err.code);
                    throw err;
                }
            }
            if (gp.status === 'failed') {
                const r = await transition(uid, orderId, (sub, p) => applyPaymentFailure(sub, p, now(), gp.errorDescription || 'Payment failed'));
                return ok({ status: PAY_STATUS.FAILED, duplicate: !!r.duplicate, reason: gp.errorDescription || 'Payment failed' }, 200);
            }
            return ok({ status: PAY_STATUS.PENDING }, 202);
        },

        /* ---------------------------------------------------------- */
        /** POST cancel — the owner closed checkout without paying.    */
        async cancelOrder({ uid, body }) {
            const { orderId } = body || {};
            if (!orderId) return fail(400, 'Missing order id.');
            const r = await transition(uid, orderId, (sub, p) => applyPaymentCancelled(sub, p, now()));
            if (r.missing) return fail(404, 'Order not found.');
            return ok({ status: r.payment.status, duplicate: !!r.duplicate });
        },

        /* ---------------------------------------------------------- */
        /** POST webhook — signed by the gateway; the authoritative path. */
        async webhook({ rawBody, signature, eventId }) {
            if (!gateway.verifyWebhookSignature(rawBody, signature)) return fail(401, 'Invalid webhook signature.');
            let json;
            try { json = JSON.parse(rawBody); } catch { return fail(400, 'Malformed webhook body.'); }

            const dedupeId = String(eventId || `${json.event}_${json.created_at || ''}_${rawBody.length}`).replace(/[/\s]/g, '_');
            if (await db.get(`webhookEvents/${dedupeId}`)) return ok({ received: true, duplicate: true });

            const ev = gateway.parseWebhook(json);
            if (ev) {
                if (ev.kind === 'PAYMENT_CAPTURED' || ev.kind === 'PAYMENT_FAILED') {
                    const map = ev.orderId ? await db.get(`paymentOrders/${ev.orderId}`) : null;
                    if (map) {
                        if (ev.kind === 'PAYMENT_CAPTURED') {
                            try {
                                await activate(map.uid, ev.orderId, {
                                    paymentId: ev.paymentId, amountMinor: ev.amountMinor, currency: ev.currency, method: ev.method,
                                });
                            } catch (err) {
                                if (err.code !== 'AMOUNT_MISMATCH') throw err;
                                // Never activate on a mismatched amount; log it for the admin.
                                await db.set(evPath(map.uid, `${ev.orderId}_AMOUNT_MISMATCH`), {
                                    type: 'AMOUNT_MISMATCH', at: now(), planId: null, detail: ev.paymentId, orderId: ev.orderId,
                                });
                            }
                        } else {
                            await transition(map.uid, ev.orderId, (sub, p) => applyPaymentFailure(sub, p, now(), ev.reason));
                        }
                    }
                } else if (ev.kind === 'REFUND') {
                    const gp = await gateway.fetchPayment(ev.paymentId);
                    const map = gp.orderId ? await db.get(`paymentOrders/${gp.orderId}`) : null;
                    if (map) {
                        await transition(map.uid, gp.orderId, (sub, p) => applyRefund(sub, p, now(), ev.refundAmountMinor / 100));
                    }
                }
            }
            await db.set(`webhookEvents/${dedupeId}`, { at: now(), event: json.event || null });
            return ok({ received: true });
        },

        /* ---------------------------------------------------------- */
        /** Cron — persist time-based status changes (trial end, grace…). */
        async syncStatuses() {
            const t = now();
            const rows = await db.list('subscriptions');
            let changed = 0;
            for (const sub of rows) {
                const eff = effectiveStatus(sub, t);
                const want = eff === SUB_STATUS.ACTIVE ? sub.status : eff;
                if (eff === 'NONE' || want === sub.status) continue;
                if (sub.status === SUB_STATUS.SUSPENDED) continue;
                const marker = sub.currentPeriodEnd || sub.trialEndsAt || 0;
                await db.set(`subscriptions/${sub.id}`, { ...stripId(sub), status: want, updatedAt: t });
                await db.set(evPath(sub.id, `${want}_${marker}`), {
                    type: `STATUS_${want}`, at: t, planId: sub.planId, detail: `${sub.status} -> ${want}`,
                });
                changed += 1;
            }
            return ok({ scanned: rows.length, changed });
        },
    };
}

function stripId(o) {
    const { id, ...rest } = o;
    return rest;
}

export { formatINR };
