import { mergePlans, planPrice, GRACE_DAYS } from '../../public/js/core/plans.js';
import { receiptNumberFor, SUB_STATUS, PAY_STATUS } from '../../public/js/core/subscriptionState.js';
import { billingError, checkoutRequest, hash, requireOwner, validId } from './checkoutRequests.js';

const path = (uid) => `subscriptions/${uid}`;
const recurringPath = (id) => `recurringSubscriptions/${id}`;
const terminal = new Set(['cancelled', 'completed', 'expired']);
const response = (body, status = 200) => ({ status, body });
const ms = (seconds) => Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
export function configuredGrace(env = process.env) {
    const value = Number(env.SUBSCRIPTION_GRACE_DAYS ?? GRACE_DAYS);
    return Number.isInteger(value) && value >= 0 && value <= 30 ? value : GRACE_DAYS;
}

export function createRecurringHandlers({ db, gateway, now, currency, graceDays = configuredGrace() }) {
    async function planFor(planId, billingCycle) {
        const plan = mergePlans(await db.list('plans'))[planId];
        if (!plan?.paid || !['monthly', 'annual'].includes(billingCycle)) throw billingError('Choose a paid plan and billing cycle.', 400);
        const amountMinor = Math.round(planPrice(plan, billingCycle) * 100);
        if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw billingError('Invalid plan price.', 400);
        const catalogPath = `gatewayPlanCatalog/${hash(`${gateway.id}:${gateway.publicKey()}:${planId}:${billingCycle}:${amountMinor}:${currency}`)}`;
        let stored = await db.get(catalogPath);
        if (!stored) {
            const remote = await gateway.createPlan({ name: `Qvrix GlowOS ${plan.name}`, billingCycle, amountMinor, currency });
            if (!validId(remote.id)) throw new Error('Invalid provider plan response.');
            stored = { gatewayPlanId: remote.id, planId, billingCycle, amountMinor, currency };
            await db.set(`recurringPlans/${remote.id}`, stored);
            await db.set(catalogPath, stored);
        }
        return stored;
    }

    async function ownRecurring(uid, id) {
        if (!validId(id)) throw billingError('Invalid subscription id.', 400);
        const rec = await db.get(recurringPath(id));
        const sub = await requireOwner(db, uid);
        if (!rec || rec.uid !== uid || sub?.gatewaySubscriptionId !== id) throw billingError('Subscription not found.', 404);
        return { rec, sub };
    }

    async function ensureMapping(id) {
        const existing = await db.get(recurringPath(id));
        if (existing) return existing;
        // Recover a provider-accepted request whose HTTP response was lost.
        // Provider notes are checked against our own durable request and plan;
        // notes alone never authorise tenancy, pricing or paid access.
        const remote = await gateway.fetchSubscription(id);
        const uid = remote?.notes?.uid, requestId = remote?.notes?.requestId;
        if (remote?.id !== id || !validId(uid) || !/^[a-f0-9]{64}$/.test(requestId || '')) throw billingError('Recurring mapping needs reconciliation.', 503, 'RETRY_WEBHOOK');
        const request = await db.get(`checkoutRequests/${requestId}`);
        let fingerprint;
        try { fingerprint = JSON.parse(request?.fingerprint); } catch { /* Reject unknown provider notes. */ }
        const plan = await db.get(`recurringPlans/${remote.plan_id}`);
        if (request?.uid !== uid || fingerprint?.mode !== 'automatic' || !plan
            || plan.planId !== fingerprint.planId || plan.billingCycle !== fingerprint.billingCycle) throw billingError('Recurring mapping needs reconciliation.', 503, 'RETRY_WEBHOOK');
        const startAt = ms(remote.start_at) || remote.startAt || now();
        const record = { uid, ...plan, status: remote.status, requestId, providerPlans: [plan.gatewayPlanId], nextChargeAt: startAt, createdAt: request.createdAt };
        const result = { subscriptionId: id, gateway: gateway.id, keyId: gateway.publicKey(), amountMinor: plan.amountMinor,
            currency: plan.currency, startAt, description: `Qvrix GlowOS ${plan.planId} ${plan.billingCycle}` };
        return db.transaction(async (tx) => {
            const bound = await tx.get(recurringPath(id));
            const freshRequest = await tx.get(`checkoutRequests/${requestId}`);
            const sub = await tx.get(path(uid));
            const lock = await tx.get(`checkoutLocks/${uid}`);
            const previous = sub?.gatewaySubscriptionId && sub.gatewaySubscriptionId !== id
                ? await tx.get(recurringPath(sub.gatewaySubscriptionId)) : null;
            if (bound) return bound;
            if (!sub || sub.ownerId !== uid || (sub.gatewaySubscriptionId && sub.gatewaySubscriptionId !== id
                    && (!previous || (!terminal.has(previous.status) && !previous.cancelRequested)))
                || !['creating', 'unknown'].includes(freshRequest?.status) || lock?.requestId !== requestId) throw billingError('Recurring mapping needs reconciliation.', 503, 'RETRY_WEBHOOK');
            tx.set(recurringPath(id), record);
            tx.set(path(uid), { ...sub, gatewaySubscriptionId: id, renewalMode: 'automatic', autoRenew: !terminal.has(remote.status),
                mandateStatus: remote.status, cancelAtPeriodEnd: terminal.has(remote.status), nextChargeAt: startAt, updatedAt: now() });
            tx.set(`checkoutRequests/${requestId}`, { ...freshRequest, status: 'created', response: result, updatedAt: now() });
            tx.set(`checkoutLocks/${uid}`, { ...lock, status: 'created', updatedAt: now() });
            return record;
        });
    }

    /** Only a captured invoice for a real billing period grants paid access.
     * Mandate authorisation and token/auth charges NEVER activate a plan.
     * Signed event periods / invoice periods avoid using a newer remote period
     * when an old webhook is retried after a subsequent renewal.
     */
    async function charge({ subscription, paymentId, invoice: suppliedInvoice }) {
        const rec = await ensureMapping(subscription.id);
        const payment = await gateway.fetchPayment(paymentId);
        if (!payment?.invoiceId) throw billingError('Recurring charge has no invoice.', 409);
        const applied = await db.get(`${path(rec.uid)}/payments/recurring_${payment.invoiceId}`);
        if ([PAY_STATUS.SUCCESS, PAY_STATUS.REFUNDED].includes(applied?.status)) return { duplicate: true };
        if (payment.status !== 'captured') throw billingError('Recurring charge is not captured.', 409);
        const invoice = suppliedInvoice || await gateway.fetchInvoice(payment.invoiceId);
        const plan = await db.get(`recurringPlans/${subscription.planId}`);
        const start = subscription.periodStart, end = subscription.periodEnd;
        if (!plan || invoice.id !== payment.invoiceId || invoice.subscription_id !== subscription.id
            || invoice.payment_id !== paymentId || invoice.status !== 'paid'
            || invoice.order_id !== payment.orderId
            || payment.amountMinor !== plan.amountMinor || payment.currency !== plan.currency
            || invoice.amount_paid !== plan.amountMinor || invoice.currency !== plan.currency
            || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end <= start
            || (invoice.billing_start && ms(invoice.billing_start) !== start)
            || (invoice.billing_end && ms(invoice.billing_end) !== end)) {
            throw billingError('Recurring invoice does not match its paid billing period.', 409, 'INVOICE_MISMATCH');
        }
        const orderId = `recurring_${invoice.id}`;
        if (!validId(orderId) || !validId(paymentId)) throw billingError('Invalid provider reference.', 400);
        const uid = rec.uid;
        return db.transaction(async (tx) => {
            const sub = await tx.get(path(uid));
            const existing = await tx.get(`${path(uid)}/payments/${orderId}`);
            const claim = await tx.get(`paymentClaims/${paymentId}`);
            const periodPath = `${path(uid)}/paidPeriods/${subscription.id}_${start}`;
            const period = await tx.get(periodPath);
            const latestRec = await tx.get(recurringPath(subscription.id));
            if (!sub || !latestRec || latestRec.uid !== uid) throw billingError('Subscription ownership mismatch.', 403);
            if ([PAY_STATUS.SUCCESS, PAY_STATUS.REFUNDED].includes(existing?.status)) return { duplicate: true };
            if (claim) throw billingError('A payment was already applied to another invoice.', 409, 'DUPLICATE_CHARGE');
            const t = now();
            const requiresReview = !!period || (sub.gatewaySubscriptionId !== subscription.id && end > (sub.currentPeriodEnd || 0));
            const newer = !requiresReview && end > (sub.currentPeriodEnd || 0);
            const nextSub = newer ? {
                ...sub, planId: plan.planId, billingCycle: plan.billingCycle,
                currentPeriodStart: start, currentPeriodEnd: end, periodAmount: plan.amountMinor / 100,
                lastPaymentId: orderId, graceDays, updatedAt: t,
                status: sub.status === SUB_STATUS.SUSPENDED ? SUB_STATUS.SUSPENDED : SUB_STATUS.ACTIVE,
                cancelAtPeriodEnd: sub.gatewaySubscriptionId === subscription.id
                    ? (!!latestRec.cancelRequested || terminal.has(latestRec.status)) : sub.cancelAtPeriodEnd,
                nextChargeAt: end,
                ...(sub.scheduledPlanId === plan.planId && sub.scheduledBillingCycle === plan.billingCycle
                    ? { scheduledPlanId: null, scheduledBillingCycle: null, scheduledChangeAt: null } : {}),
            } : sub;
            tx.set(path(uid), nextSub);
            if (newer) tx.set(recurringPath(subscription.id), { ...latestRec, ...plan,
                providerPlans: [...new Set([...(latestRec.providerPlans || [latestRec.gatewayPlanId]), subscription.planId])], updatedAt: t });
            tx.set(`${path(uid)}/payments/${orderId}`, {
                orderId, ownerId: uid, subscriptionId: uid, gatewaySubscriptionId: subscription.id,
                invoiceId: invoice.id, gatewayPaymentId: paymentId, paymentGateway: gateway.id,
                planId: plan.planId, billingCycle: plan.billingCycle, kind: 'renewal',
                amount: plan.amountMinor / 100, currency: plan.currency, method: payment.method || null,
                status: PAY_STATUS.SUCCESS, createdAt: t, paidAt: t, periodStart: start, periodEnd: end,
                receiptNumber: receiptNumberFor(t, invoice.id), failureReason: null,
                requiresReview,
            });
            tx.set(`paymentClaims/${paymentId}`, { uid, orderId });
            tx.set(`paymentOrders/${payment.orderId}`, { uid, orderId, createdAt: t });
            if (!period) tx.set(periodPath, { paymentId, orderId, periodEnd: end });
            tx.set(`${path(uid)}/events/${orderId}_PAID`, { type: 'SUBSCRIPTION_RENEWED', at: t, planId: plan.planId, orderId });
            return { duplicate: false, requiresReview };
        });
    }

    async function recordFailure(subscriptionId, paymentId) {
        const rec = await ensureMapping(subscriptionId);
        const payment = await gateway.fetchPayment(paymentId);
        if (payment?.status !== 'failed' || !payment.invoiceId) return;
        const invoice = await gateway.fetchInvoice(payment.invoiceId);
        if (invoice.subscription_id !== subscriptionId || invoice.order_id !== payment.orderId) throw billingError('Failed invoice ownership mismatch.', 409);
        const orderId = `recurring_failed_${paymentId}`;
        await db.transaction(async (tx) => {
            const sub = await tx.get(path(rec.uid));
            const previous = await tx.get(`${path(rec.uid)}/payments/${orderId}`);
            const paid = await tx.get(`${path(rec.uid)}/payments/recurring_${invoice.id}`);
            const claim = await tx.get(`paymentClaims/${paymentId}`);
            if (previous || claim) return;
            const t = now();
            tx.set(`${path(rec.uid)}/payments/${orderId}`, {
                orderId, ownerId: rec.uid, subscriptionId: rec.uid, gatewaySubscriptionId: subscriptionId,
                gatewayPaymentId: paymentId, invoiceId: invoice.id, paymentGateway: gateway.id,
                planId: rec.planId, billingCycle: rec.billingCycle, kind: 'renewal', amount: payment.amountMinor / 100,
                currency: payment.currency, method: payment.method || null, status: PAY_STATUS.FAILED,
                createdAt: t, failedAt: t, receiptNumber: null, failureReason: 'Automatic renewal payment failed.',
            });
            if (!paid && sub?.status === SUB_STATUS.ACTIVE && t >= sub.currentPeriodEnd
                && ms(invoice.billing_start) >= sub.currentPeriodEnd) tx.set(path(rec.uid), { ...sub, status: SUB_STATUS.PAST_DUE, updatedAt: t });
        });
    }

    async function lifecycle(event) {
        const { subscription, createdAt } = event;
        if (!validId(subscription.id) || !Number.isFinite(createdAt)) throw billingError('Invalid subscription event.', 400);
        await ensureMapping(subscription.id);
        if (event.event === 'subscription.charged') {
            if (!validId(event.paymentId)) throw billingError('Missing recurring payment.', 400);
            await charge(event);
        } else if (event.paymentId && ['subscription.pending', 'subscription.halted'].includes(event.event)) {
            await recordFailure(subscription.id, event.paymentId);
        }
        await db.transaction(async (tx) => {
            const rec = await tx.get(recurringPath(subscription.id));
            if (!rec) throw billingError('Recurring subscription mapping not ready.', 503, 'RETRY_WEBHOOK');
            const sub = await tx.get(path(rec.uid));
            // Ignore old lifecycle deliveries and never resurrect a terminal mandate.
            if (createdAt < (rec.lastEventAt || 0) || (terminal.has(rec.status) && !terminal.has(subscription.status))) return;
            tx.set(recurringPath(subscription.id), { ...rec, status: subscription.status, lastEventAt: createdAt });
            if (!sub || sub.gatewaySubscriptionId !== subscription.id) return;
            const stopped = terminal.has(subscription.status) || !!rec.cancelRequested;
            const patch = {
                ...sub, mandateStatus: subscription.status, autoRenew: !stopped,
                cancelAtPeriodEnd: stopped, updatedAt: now(),
            };
            if (['pending', 'halted', 'paused'].includes(subscription.status) && sub.status === SUB_STATUS.ACTIVE) patch.status = SUB_STATUS.PAST_DUE;
            tx.set(path(rec.uid), patch);
        });
    }

    return {
        recurringEvent: lifecycle,
        recurringFailure: recordFailure,
        async createRecurring({ uid, body = {} }) {
            gateway.publicKey();
            const { planId, billingCycle, salonId = null } = body;
            const sub = await requireOwner(db, uid, salonId);
            if (!sub) throw billingError('Start your free trial before setting up renewal.', 409);
            if (sub.status === SUB_STATUS.SUSPENDED) throw billingError('Subscription suspended.', 403);
            if (body.consent !== true) throw billingError('Automatic renewal requires your explicit agreement.', 400);
            if (body.resumeSubscriptionId) {
                const { rec } = await ownRecurring(uid, body.resumeSubscriptionId);
                const remote = await gateway.fetchSubscription(body.resumeSubscriptionId);
                if (rec.cancelRequested || remote.status !== 'created') throw billingError('This mandate is already authorised or has ended. Check your subscription status.');
                return response({ subscriptionId: body.resumeSubscriptionId, gateway: gateway.id, keyId: gateway.publicKey(),
                    amountMinor: rec.amountMinor, currency: rec.currency, startAt: rec.nextChargeAt,
                    description: `Qvrix GlowOS ${rec.planId} ${rec.billingCycle}` });
            }
            const fingerprint = JSON.stringify({ planId, billingCycle, salonId, mode: 'automatic' });
            const result = await checkoutRequest({ db, uid, key: body.idempotencyKey, fingerprint, now: now(), execute: async (requestId) => {
                const current = await db.get(path(uid));
                if (current.gatewaySubscriptionId) {
                    const previous = await db.get(recurringPath(current.gatewaySubscriptionId));
                    if (previous && !terminal.has(previous.status) && !previous.cancelRequested) throw billingError('Manage your existing automatic renewal instead.', 409, 'AUTO_RENEW_EXISTS');
                }
                const plan = await planFor(planId, billingCycle);
                const startAt = Math.max(now() + 60000, current.trialEndsAt || 0, current.currentPeriodEnd || 0);
                const remote = await gateway.createSubscription({ planId: plan.gatewayPlanId, startAt, billingCycle, notes: { uid, requestId } });
                if (!validId(remote.id)) throw new Error('Invalid provider subscription response.');
                try { await db.transaction(async (tx) => {
                    const fresh = await tx.get(path(uid));
                    if ((fresh.lastPaymentId || null) !== (current.lastPaymentId || null)) throw new Error('Subscription changed while the mandate was being created. Reconciliation required.');
                    tx.set(recurringPath(remote.id), { uid, ...plan, status: remote.status, createdAt: now(), nextChargeAt: startAt, requestId, providerPlans: [plan.gatewayPlanId] });
                    tx.set(path(uid), { ...fresh, gatewaySubscriptionId: remote.id, renewalMode: 'automatic', autoRenew: true,
                        mandateStatus: remote.status, cancelAtPeriodEnd: false, nextChargeAt: startAt, updatedAt: now() });
                }); } catch (error) {
                    // We know the provider id: stop an orphaned mandate before
                    // permitting another checkout. A cancellation timeout leaves
                    // the durable checkout reservation UNKNOWN for recovery.
                    await gateway.cancelSubscription(remote.id, false);
                    await db.set(recurringPath(remote.id), { uid, ...plan, status: 'cancelled', cancelRequested: true, requestId });
                    throw billingError('Renewal setup was cancelled because the subscription changed. Refresh and try again.');
                }
                return { subscriptionId: remote.id, gateway: gateway.id, keyId: gateway.publicKey(),
                    amountMinor: plan.amountMinor, currency, startAt, description: `Qvrix GlowOS ${planId} ${billingCycle}` };
            } });
            return response(result);
        },
        async verifyRecurring({ uid, body = {} }) {
            const { subscriptionId, paymentId, signature } = body;
            await ownRecurring(uid, subscriptionId);
            if (!validId(paymentId) || !gateway.verifySubscriptionSignature(subscriptionId, paymentId, signature)) throw billingError('Invalid mandate signature.', 400);
            const remote = await gateway.fetchSubscription(subscriptionId);
            if (remote.id !== subscriptionId || !['authenticated', 'active', 'pending'].includes(remote.status)) throw billingError('Mandate is not authorised.', 409);
            await db.transaction(async (tx) => {
                const rec = await tx.get(recurringPath(subscriptionId));
                const sub = await tx.get(path(uid));
                if (rec.cancelRequested || sub.gatewaySubscriptionId !== subscriptionId) return;
                tx.set(recurringPath(subscriptionId), { ...rec, status: remote.status });
                tx.set(path(uid), { ...sub, mandateStatus: remote.status });
            });
            // A successful checkout authorises future billing, not paid access.
            return response({ status: 'PENDING', mandateStatus: remote.status, message: 'Automatic renewal authorised. Access updates only after a verified billing-period charge.' });
        },
        async manageRecurring({ uid, body = {} }) {
            gateway.publicKey();
            const { subscriptionId, action } = body;
            await ownRecurring(uid, subscriptionId);
            const result = await checkoutRequest({ db, uid, key: body.idempotencyKey,
                fingerprint: JSON.stringify({ subscriptionId, action, planId: body.planId || null, billingCycle: body.billingCycle || null }),
                now: now(), execute: async () => {
                const { rec, sub } = await ownRecurring(uid, subscriptionId);
                if (!['cancel', 'change'].includes(action)) throw billingError('Invalid renewal action.', 400);
                if (action === 'change' && sub.status === SUB_STATUS.SUSPENDED) throw billingError('Subscription suspended.', 403);
                const remote = await gateway.fetchSubscription(subscriptionId);
                if (remote.id !== subscriptionId) throw billingError('Provider subscription mismatch.', 409);
                let patch;
                let changedPlanId = null;
                if (action === 'cancel') {
                    if (!terminal.has(remote.status)) await gateway.cancelSubscription(subscriptionId, remote.status === 'active' && !!remote.current_end);
                    patch = { autoRenew: false, cancelAtPeriodEnd: true, scheduledPlanId: null, scheduledBillingCycle: null };
                } else {
                    if (rec.cancelRequested || terminal.has(remote.status)) throw billingError('This automatic renewal has ended.', 409);
                    if (remote.status === 'created') throw billingError('Complete automatic-renewal authorisation before scheduling a change.', 409);
                    const plan = await planFor(body.planId, body.billingCycle);
                    await gateway.updateSubscription(subscriptionId, plan.gatewayPlanId);
                    changedPlanId = plan.gatewayPlanId;
                    patch = { scheduledPlanId: plan.planId, scheduledBillingCycle: plan.billingCycle, scheduledChangeAt: sub.currentPeriodEnd || rec.nextChargeAt };
                }
                await db.transaction(async (tx) => {
                    const fresh = await tx.get(path(uid));
                    const latestRec = await tx.get(recurringPath(subscriptionId));
                    if (fresh.gatewaySubscriptionId !== subscriptionId) throw billingError('Renewal changed. Refresh and try again.');
                    tx.set(path(uid), { ...fresh, ...patch, updatedAt: now() });
                    tx.set(recurringPath(subscriptionId), { ...latestRec,
                        ...(changedPlanId ? { providerPlans: [...new Set([...(latestRec.providerPlans || [latestRec.gatewayPlanId]), changedPlanId])] } : {}),
                        ...(action === 'cancel' ? { cancelRequested: true } : {}), updatedAt: now() });
                    tx.set(`${path(uid)}/events/${subscriptionId}_${action}_${now()}`, { type: action === 'cancel' ? 'AUTO_RENEW_CANCELLED' : 'PLAN_CHANGE_SCHEDULED', at: now(), planId: body.planId || sub.planId });
                });
                return { status: 'SUCCESS', message: action === 'cancel' ? 'Automatic renewal cancelled. Current paid access is retained until its end date.' : 'Plan change scheduled for the next billing cycle.' };
            } });
            return response(result);
        },
        async reconcileRecurring() {
            gateway.publicKey(); // Missing keys must not silently turn reconciliation into a no-op.
            let replayed = 0;
            const failures = [];
            for (const item of await db.list('webhookInbox')) {
                if (item.processed) continue;
                try {
                    await lifecycle(item.event);
                    await db.set(`webhookInbox/${item.id}`, { event: item.event, processed: true, createdAt: item.createdAt });
                    replayed++;
                } catch { failures.push({ eventId: item.id }); }
            }
            let reconciled = 0;
            for (const rec of await db.list('recurringSubscriptions')) {
                try {
                for (let skip = 0; skip < 10000; skip += 100) {
                    const invoices = await gateway.fetchInvoices(rec.id, skip);
                    for (const invoice of invoices) {
                        if (invoice.status !== 'paid' || !invoice.payment_id || !invoice.billing_start || !invoice.billing_end) continue;
                        // Reconciliation needs invoice-specific plan identity; don't
                        // apply the newest plan to an old invoice after a change.
                        const candidates = (await db.list('recurringPlans')).filter(plan =>
                            (rec.providerPlans || [rec.gatewayPlanId]).includes(plan.gatewayPlanId)
                            && plan.amountMinor === invoice.amount_paid && plan.currency === invoice.currency);
                        const planId = invoice.line_items?.[0]?.plan_id || (candidates.length === 1 ? candidates[0].gatewayPlanId : null);
                        if (!planId) throw billingError('Historical invoice needs plan reconciliation.', 503, 'RECONCILIATION_REQUIRED');
                        await charge({ subscription: { id: rec.id, planId, periodStart: ms(invoice.billing_start), periodEnd: ms(invoice.billing_end) }, paymentId: invoice.payment_id, invoice });
                        reconciled++;
                    }
                    if (invoices.length < 100) break;
                }
                } catch { failures.push({ subscriptionId: rec.id }); }
            }
            return { reconciled, replayed, failures };
        },
    };
}
