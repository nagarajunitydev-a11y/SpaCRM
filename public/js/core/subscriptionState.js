/**
 * subscriptionState.js
 * The subscription / payment state machine. Pure functions only: every
 * transition takes plain objects (timestamps as epoch milliseconds) and
 * returns new ones, so the exact same code decides outcomes in the browser
 * (what to show) and on the server (what to persist) and is fully unit
 * testable without Firebase or a payment gateway.
 *
 * Subscription statuses
 *   TRIAL         30-day free trial, Standard-level features
 *   ACTIVE        paid period running
 *   PAST_DUE      renewal payment failed; access continues through grace
 *   GRACE_PERIOD  paid period ended; short grace before locking
 *   EXPIRED       trial or paid period over; read-only, nothing deleted
 *   SUSPENDED     blocked by a super admin
 *   CANCELLED     renewal cancelled / refunded; access until period end
 *
 * Payment statuses: PENDING, SUCCESS, FAILED, CANCELLED, REFUNDED
 */

import { DEFAULT_PLANS, TRIAL_DAYS, GRACE_DAYS, planPrice } from './plans.js';

export const SUB_STATUS = {
    TRIAL: 'TRIAL', ACTIVE: 'ACTIVE', PAST_DUE: 'PAST_DUE', GRACE_PERIOD: 'GRACE_PERIOD',
    EXPIRED: 'EXPIRED', SUSPENDED: 'SUSPENDED', CANCELLED: 'CANCELLED',
};
export const PAY_STATUS = {
    PENDING: 'PENDING', SUCCESS: 'SUCCESS', FAILED: 'FAILED', CANCELLED: 'CANCELLED', REFUNDED: 'REFUNDED',
};

export const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/** Calendar-correct (UTC) month/year addition, clamping e.g. Jan 31 + 1 month. */
export function addPeriod(startMs, cycle) {
    const d = new Date(startMs);
    const months = cycle === 'annual' ? 12 : 1;
    const day = d.getUTCDate();
    const target = new Date(Date.UTC(
        d.getUTCFullYear(), d.getUTCMonth() + months, 1,
        d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(),
    ));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return target.getTime();
}

export function trialEndFrom(startMs) {
    return startMs + TRIAL_DAYS * DAY_MS;
}

/** A brand-new trial subscription record. */
export function newTrial(ownerId, now, extra = {}) {
    return {
        ownerId,
        planId: 'trial',
        billingCycle: null,
        status: SUB_STATUS.TRIAL,
        trialStartedAt: now,
        trialEndsAt: trialEndFrom(now),
        currentPeriodStart: null,
        currentPeriodEnd: null,
        periodAmount: 0,
        lastPaymentId: null,
        cancelAtPeriodEnd: false,
        createdAt: now,
        ...extra,
    };
}

/* ------------------------------------------------------------------ */
/* Effective status & access                                           */
/* ------------------------------------------------------------------ */

/**
 * The status that actually applies right now. Stored status can lag behind
 * the clock (nothing runs at the exact second a trial ends), so every
 * consumer derives from this instead of trusting `sub.status` alone.
 */
export function effectiveStatus(sub, now) {
    if (!sub) return 'NONE';
    const s = sub.status;
    if (!Object.values(SUB_STATUS).includes(s)) return SUB_STATUS.EXPIRED;
    if (s === SUB_STATUS.SUSPENDED) return SUB_STATUS.SUSPENDED;
    if (s === SUB_STATUS.EXPIRED) return SUB_STATUS.EXPIRED;
    if (s === SUB_STATUS.TRIAL) {
        return Number.isFinite(sub.trialEndsAt) && now < sub.trialEndsAt ? SUB_STATUS.TRIAL : SUB_STATUS.EXPIRED;
    }
    const end = sub.currentPeriodEnd;
    if (!Number.isFinite(end)) return SUB_STATUS.EXPIRED;
    if (now < end) return s === SUB_STATUS.GRACE_PERIOD ? SUB_STATUS.ACTIVE : s;
    // Period over.
    if (s === SUB_STATUS.CANCELLED || sub.cancelAtPeriodEnd) return SUB_STATUS.EXPIRED;
    const graceDays = Number.isInteger(sub.graceDays) && sub.graceDays >= 0 && sub.graceDays <= 30 ? sub.graceDays : GRACE_DAYS;
    return now < end + graceDays * DAY_MS ? SUB_STATUS.GRACE_PERIOD : SUB_STATUS.EXPIRED;
}

/** Plan id whose entitlements apply now, or null when access is locked. */
export function accessPlanId(sub, now) {
    const eff = effectiveStatus(sub, now);
    if (eff === SUB_STATUS.TRIAL) return 'trial';
    if (['ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'CANCELLED'].includes(eff)) return sub.planId;
    return null;
}

export function trialDaysLeft(sub, now) {
    if (!sub || sub.status !== SUB_STATUS.TRIAL || sub.trialEndsAt == null) return 0;
    return Math.max(0, Math.ceil((sub.trialEndsAt - now) / DAY_MS));
}

/* ------------------------------------------------------------------ */
/* Quote: what a purchase costs and what kind of change it is          */
/* ------------------------------------------------------------------ */

/**
 * Decide whether `planId`/`cycle` can be bought now and for how much.
 *   kind: 'new'      trial / expired / lapsed -> new period starts now
 *         'renewal'  same plan again -> extends from the current period end
 *         'upgrade'  higher plan mid-period -> starts now, unused value credited
 * A lower plan while a higher paid period is still running is refused
 * (downgrades take effect once the paid period ends — no refunds mid-period).
 */
export function quotePurchase(sub, planId, cycle, plans, now) {
    const plan = (plans || DEFAULT_PLANS)[planId];
    if (!plan || !plan.paid) return { ok: false, error: 'Choose a paid plan.' };
    if (cycle !== 'monthly' && cycle !== 'annual') return { ok: false, error: 'Choose monthly or annual billing.' };
    const price = planPrice(plan, cycle);
    if (!(price > 0)) return { ok: false, error: 'This plan has no price configured.' };

    const eff = effectiveStatus(sub, now);
    if (eff === SUB_STATUS.SUSPENDED) return { ok: false, error: 'This subscription is suspended. Contact support.' };

    const livePaid = sub && sub.planId && sub.planId !== 'trial'
        && sub.currentPeriodEnd != null && sub.currentPeriodEnd > now
        && ['ACTIVE', 'CANCELLED', 'PAST_DUE'].includes(eff);

    if (!livePaid) return { ok: true, kind: 'new', plan, price, credit: 0, amount: price };

    const current = (plans || DEFAULT_PLANS)[sub.planId];
    if (planId === sub.planId) return { ok: true, kind: 'renewal', plan, price, credit: 0, amount: price };
    if (current && plan.order > current.order) {
        const total = Math.max(1, sub.currentPeriodEnd - (sub.currentPeriodStart || now));
        const remaining = Math.max(0, sub.currentPeriodEnd - now);
        const credit = Math.min(price - 1, Math.round((sub.periodAmount || 0) * (remaining / total)));
        return { ok: true, kind: 'upgrade', plan, price, credit, amount: Math.max(1, price - credit) };
    }
    return {
        ok: false,
        code: 'DOWNGRADE_BLOCKED',
        error: `Your ${current ? current.name : 'current'} plan is paid until ${new Date(sub.currentPeriodEnd).toISOString().slice(0, 10)}. You can switch to a lower plan after it ends.`,
    };
}

/* ------------------------------------------------------------------ */
/* Payment transitions (all idempotent)                                */
/* ------------------------------------------------------------------ */

function event(type, now, planId, detail = '') {
    return { type, at: now, planId: planId || null, detail };
}

/**
 * Verified payment success. Returns { duplicate:true } when this payment was
 * already applied (repeated webhook / page refresh / double verify call) so
 * the caller writes nothing and the period is never extended twice.
 */
export function applyPaymentSuccess(sub, payment, now, { receiptNumber, gatewayPaymentId, method } = {}) {
    if (payment.status === PAY_STATUS.SUCCESS) return { duplicate: true, sub, payment, events: [] };
    if (payment.status === PAY_STATUS.REFUNDED) return { duplicate: true, sub, payment, events: [] };

    const current = sub || newTrial(payment.ownerId || payment.subscriptionId, now);
    const stillPaid = current.currentPeriodEnd != null && current.currentPeriodEnd > now
        && current.planId === payment.planId
        && ['ACTIVE', 'CANCELLED', 'PAST_DUE'].includes(current.status);
    const start = payment.kind === 'renewal' && stillPaid ? current.currentPeriodEnd : now;
    const end = addPeriod(start, payment.billingCycle);

    const nextSub = {
        ...current,
        planId: payment.planId,
        billingCycle: payment.billingCycle,
        status: current.status === SUB_STATUS.SUSPENDED ? SUB_STATUS.SUSPENDED : SUB_STATUS.ACTIVE,
        currentPeriodStart: start,
        currentPeriodEnd: end,
        periodAmount: payment.amount,
        lastPaymentId: payment.orderId,
        cancelAtPeriodEnd: false,
        updatedAt: now,
    };
    const nextPayment = {
        ...payment,
        status: PAY_STATUS.SUCCESS,
        paidAt: now,
        gatewayPaymentId: gatewayPaymentId || payment.gatewayPaymentId || null,
        method: method || payment.method || null,
        receiptNumber: payment.receiptNumber || receiptNumber || null,
        failureReason: null,
        periodStart: start,
        periodEnd: end,
    };
    const label = payment.kind === 'renewal' ? 'SUBSCRIPTION_RENEWED'
        : payment.kind === 'upgrade' ? 'SUBSCRIPTION_UPGRADED' : 'SUBSCRIPTION_ACTIVATED';
    return {
        duplicate: false,
        sub: nextSub,
        payment: nextPayment,
        events: [
            event('PAYMENT_SUCCESS', now, payment.planId, payment.orderId),
            event(label, now, payment.planId, `${payment.billingCycle} until ${new Date(end).toISOString()}`),
        ],
    };
}

/** Gateway reported a failed attempt. Never touches an active subscription. */
export function applyPaymentFailure(sub, payment, now, reason = 'Payment failed') {
    if ([PAY_STATUS.SUCCESS, PAY_STATUS.REFUNDED, PAY_STATUS.FAILED].includes(payment.status)) {
        return { duplicate: true, sub, payment, events: [] };
    }
    let nextSub = sub;
    // A failed renewal after the paid period already ended flags PAST_DUE.
    if (sub && payment.kind === 'renewal' && sub.status === SUB_STATUS.ACTIVE
        && sub.currentPeriodEnd != null && now > sub.currentPeriodEnd) {
        nextSub = { ...sub, status: SUB_STATUS.PAST_DUE, updatedAt: now };
    }
    return {
        duplicate: false,
        sub: nextSub,
        payment: { ...payment, status: PAY_STATUS.FAILED, failureReason: String(reason).slice(0, 200), failedAt: now },
        events: [event('PAYMENT_FAILED', now, payment.planId, String(reason).slice(0, 200))],
    };
}

/** Customer closed the checkout without paying. Only a PENDING payment can be cancelled. */
export function applyPaymentCancelled(sub, payment, now) {
    if (payment.status !== PAY_STATUS.PENDING) return { duplicate: true, sub, payment, events: [] };
    return {
        duplicate: false,
        sub,
        payment: { ...payment, status: PAY_STATUS.CANCELLED, cancelledAt: now },
        events: [event('PAYMENT_CANCELLED', now, payment.planId, payment.orderId)],
    };
}

/** Gateway refund. A full refund of the current period's payment ends access. */
export function applyRefund(sub, payment, now, refundedAmount) {
    if (payment.status === PAY_STATUS.REFUNDED) return { duplicate: true, sub, payment, events: [] };
    const amount = Number.isFinite(refundedAmount) ? refundedAmount : payment.amount;
    if (payment.status !== PAY_STATUS.SUCCESS) return {
        duplicate: false, sub,
        payment: { ...payment, status: PAY_STATUS.REFUNDED, refundedAmount: Math.min(amount, payment.amount), refundedAt: now,
            requiresReview: amount < payment.amount },
        events: [event('PAYMENT_REFUNDED', now, payment.planId, 'Refund received before activation')],
    };
    const full = amount >= payment.amount;
    const nextPayment = {
        ...payment,
        status: full ? PAY_STATUS.REFUNDED : PAY_STATUS.SUCCESS,
        refundedAmount: Math.min(amount, payment.amount),
        refundedAt: now,
    };
    let nextSub = sub;
    if (full && sub && sub.lastPaymentId === payment.orderId) {
        nextSub = { ...sub, status: SUB_STATUS.CANCELLED, currentPeriodEnd: Math.min(sub.currentPeriodEnd || now, now), updatedAt: now };
    }
    return {
        duplicate: false,
        sub: nextSub,
        payment: nextPayment,
        events: [event(full ? 'PAYMENT_REFUNDED' : 'PAYMENT_PARTIALLY_REFUNDED', now, payment.planId, `₹${nextPayment.refundedAmount}`)],
    };
}

export function receiptNumberFor(now, orderId) {
    const d = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
    return `RCPT-${d}-${String(orderId).replace(/^order_/, '').slice(-6).toUpperCase()}`;
}

export default {
    SUB_STATUS, PAY_STATUS, effectiveStatus, accessPlanId, trialDaysLeft, quotePurchase,
    applyPaymentSuccess, applyPaymentFailure, applyPaymentCancelled, applyRefund, addPeriod, newTrial,
};
