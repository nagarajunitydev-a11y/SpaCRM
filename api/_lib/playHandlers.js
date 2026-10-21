/**
 * playHandlers.js
 * Alternative billing with user choice (Google Play, India) for the Android
 * app. Two outcomes of Google's choice screen:
 *
 *  - Razorpay chosen: the app gets an external transaction token, then runs
 *    the existing create-order -> Razorpay -> verify flow (handlers.js). The
 *    order carries a server-only report record; once the payment is verified
 *    it is reported to Google within 24h (retried by the cron).
 *  - Google Play chosen: the purchase token is verified with the Play
 *    Developer API, bound to the caller's obfuscated account id, mapped onto
 *    the same subscription document and acknowledged. Renewals, cancellation
 *    and expiry arrive as RTDN notifications and are re-read from Google.
 *
 * Collections written here (externalReports, externalSeries, playAccounts,
 * playSubscriptions) are server-only under the default-deny Firestore rules.
 */
import { mergePlans, planPrice } from '../../public/js/core/plans.js';
import { PAY_STATUS, SUB_STATUS, newTrial, quotePurchase, receiptNumberFor } from '../../public/js/core/subscriptionState.js';
import { billingError, hash, requireOwner } from './checkoutRequests.js';
import { INDIA_TAX_STATES, PlayNotConfigured } from './googlePlay.js';

const subPath = (uid) => `subscriptions/${uid}`;
const reportPath = (orderId) => `externalReports/${orderId}`;
const seriesPath = (uid) => `externalSeries/${uid}`;
const accountPath = (accountId) => `playAccounts/${accountId}`;
const playSubPath = (tokenId) => `playSubscriptions/${tokenId}`;
const LIVE = new Set(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_CANCELED', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD']);
const STATUS = {
    SUBSCRIPTION_STATE_ACTIVE: SUB_STATUS.ACTIVE,
    SUBSCRIPTION_STATE_CANCELED: SUB_STATUS.CANCELLED,
    SUBSCRIPTION_STATE_IN_GRACE_PERIOD: SUB_STATUS.PAST_DUE,
    SUBSCRIPTION_STATE_ON_HOLD: SUB_STATUS.PAST_DUE,
    SUBSCRIPTION_STATE_PAUSED: SUB_STATUS.PAST_DUE,
    SUBSCRIPTION_STATE_EXPIRED: SUB_STATUS.EXPIRED,
};
// Google tokens are opaque; accept printable, whitespace-free strings only.
const validToken = (v) => typeof v === 'string' && /^[\x21-\x7e]{8,4096}$/.test(v);
const ok = (body, status = 200) => ({ status, body });

const unconfigured = { configured: () => false };

export function createPlayHandlers({ db, play = unconfigured, now, graceDays }) {
    const requirePlay = () => { if (!play.configured()) throw new PlayNotConfigured(); return play; };
    const accountIdFor = (uid) => hash(`play-account:${uid}`);
    const loadPlans = async () => mergePlans(await db.list('plans'));

    /** An in-app Razorpay series continues only while its last paid order is the live period. */
    const seriesLive = (series, sub, t) => !!series && !!sub && series.lastOrderId === sub.lastPaymentId
        && (sub.currentPeriodEnd || 0) > t && series.planId === sub.planId
        && series.billingCycle === sub.billingCycle && sub.status !== SUB_STATUS.SUSPENDED;

    async function livePlay(sub, t) {
        if (sub?.billingSource !== 'google_play' || !sub.playSubscriptionId || (sub.currentPeriodEnd || 0) <= t) return null;
        const ps = await db.get(playSubPath(sub.playSubscriptionId));
        return ps && LIVE.has(ps.state) ? ps : null;
    }

    /** Re-read a Play purchase from Google and mirror it onto the subscription. */
    async function syncPlay(purchaseToken, { uid: expectedUid = null } = {}) {
        const remote = await requirePlay().getSubscription(purchaseToken);
        const line = remote.lineItems?.[0];
        const mapped = line && play.planFor(line.productId, line.offerDetails?.basePlanId);
        const plan = mapped && (await loadPlans())[mapped.planId];
        if (!plan?.paid) throw billingError('Unknown Google Play product.', 400, 'UNKNOWN_PRODUCT');
        const accountId = remote.externalAccountIdentifiers?.obfuscatedExternalAccountId;
        const owner = accountId ? await db.get(accountPath(accountId)) : null;
        if (!owner?.uid || (expectedUid && owner.uid !== expectedUid)) {
            throw billingError('This Google Play purchase belongs to another account.', 403, 'PLAY_ACCOUNT_MISMATCH');
        }
        const state = remote.subscriptionState;
        if (state === 'SUBSCRIPTION_STATE_PENDING') return { status: 'PENDING' };
        if (!STATUS[state]) return { status: 'FAILED' };

        const uid = owner.uid;
        const tokenId = hash(purchaseToken);
        const linkedId = remote.linkedPurchaseToken ? hash(remote.linkedPurchaseToken) : null;
        const expiry = Date.parse(line.expiryTime);
        const started = Date.parse(remote.startTime) || now();
        if (!Number.isFinite(expiry)) throw billingError('Google Play purchase has no expiry.', 409);
        const orderRef = line.latestSuccessfulOrderId || remote.latestOrderId || null;
        const orderId = orderRef ? `play_${orderRef.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 128) : null;
        const autoRenew = state === 'SUBSCRIPTION_STATE_ACTIVE' && !!line.autoRenewingPlan?.autoRenewEnabled;
        const price = planPrice(plan, mapped.billingCycle);

        const result = await db.transaction(async (tx) => {
            const sub = await tx.get(subPath(uid));
            const prev = await tx.get(playSubPath(tokenId));
            const claim = await tx.get(`paymentClaims/play_${tokenId}`);
            const linked = linkedId ? await tx.get(playSubPath(linkedId)) : null;
            const existing = orderId ? await tx.get(`${subPath(uid)}/payments/${orderId}`) : null;
            if (claim && claim.uid !== uid) throw billingError('Purchase was already applied to another account.', 409, 'PAYMENT_ALREADY_USED');
            const t = now();
            const renewal = !!prev && !!orderRef && prev.lastOrderId !== orderRef;
            const periodStart = renewal && prev.expiry < expiry ? prev.expiry : (prev?.periodStart || started);
            // A newly bought Play subscription takes over; later updates apply only
            // while the subscription is still billed by this purchase (or its predecessor).
            const follows = (!prev && LIVE.has(state)) || (!!sub?.playSubscriptionId && [tokenId, linkedId].includes(sub.playSubscriptionId));
            const base = sub || newTrial(uid, t);
            const otherPaidLive = !prev && sub && sub.billingSource !== 'google_play' && sub.planId !== 'trial'
                && (sub.currentPeriodEnd || 0) > t;

            tx.set(playSubPath(tokenId), {
                uid, purchaseToken, productId: line.productId, planId: mapped.planId, billingCycle: mapped.billingCycle,
                state, expiry, periodStart, lastOrderId: orderRef, linkedTo: linkedId,
                acknowledged: remote.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_PENDING',
                testPurchase: !!remote.testPurchase, updatedAt: t,
            });
            tx.set(`paymentClaims/play_${tokenId}`, { uid, orderId: tokenId });
            if (linked && !linked.supersededBy) tx.set(playSubPath(linkedId), { ...linked, supersededBy: tokenId, updatedAt: t });
            if (follows && base.status !== SUB_STATUS.SUSPENDED) {
                tx.set(subPath(uid), {
                    ...base, ownerId: uid, planId: mapped.planId, billingCycle: mapped.billingCycle, status: STATUS[state],
                    currentPeriodStart: periodStart, currentPeriodEnd: expiry, periodAmount: price,
                    lastPaymentId: orderId && LIVE.has(state) ? orderId : base.lastPaymentId || null,
                    billingSource: 'google_play', playSubscriptionId: tokenId, playProductId: line.productId,
                    renewalMode: 'google_play', autoRenew, cancelAtPeriodEnd: !autoRenew, graceDays,
                    gatewaySubscriptionId: null, mandateStatus: null, nextChargeAt: autoRenew ? expiry : null,
                    scheduledPlanId: null, scheduledBillingCycle: null, scheduledChangeAt: null, updatedAt: t,
                });
            }
            if (orderId && !existing && LIVE.has(state)) {
                const kind = renewal ? 'renewal' : linked ? 'upgrade' : 'new';
                tx.set(`${subPath(uid)}/payments/${orderId}`, {
                    orderId, subscriptionId: uid, ownerId: uid, salonId: base.salonId || null,
                    planId: mapped.planId, billingCycle: mapped.billingCycle, kind, amount: price, credit: 0,
                    currency: 'INR', paymentGateway: 'google_play', status: PAY_STATUS.SUCCESS,
                    gatewayPaymentId: orderRef, method: 'google_play', receiptNumber: receiptNumberFor(t, orderId),
                    createdAt: t, paidAt: t, periodStart, periodEnd: expiry, failureReason: null,
                    testPurchase: !!remote.testPurchase,
                });
                tx.set(`${subPath(uid)}/events/${orderId}_PAID`, {
                    type: kind === 'renewal' ? 'SUBSCRIPTION_RENEWED' : kind === 'upgrade' ? 'SUBSCRIPTION_UPGRADED' : 'SUBSCRIPTION_ACTIVATED',
                    at: t, planId: mapped.planId, orderId, detail: 'Google Play',
                });
            }
            if (otherPaidLive) {
                tx.set(`${subPath(uid)}/events/${tokenId.slice(0, 32)}_OVERLAP`, {
                    type: 'PAYMENT_REVIEW_REQUIRED', at: t, planId: mapped.planId,
                    detail: 'Google Play subscription started while a separately paid period was still active.',
                });
            }
            return { live: LIVE.has(state), needsAck: LIVE.has(state) && remote.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING' };
        });
        if (result.needsAck) {
            // After the record is durable; a failed acknowledgement is retried by the cron.
            await play.acknowledge(line.productId, purchaseToken);
            const fresh = await db.get(playSubPath(tokenId));
            await db.set(playSubPath(tokenId), { ...fresh, acknowledged: true, updatedAt: now() });
        }
        return { status: result.live ? PAY_STATUS.SUCCESS : 'EXPIRED' };
    }

    /** Report a verified in-app Razorpay payment to Google (idempotent). */
    async function reportOrder(orderId) {
        const rep = await db.get(reportPath(orderId));
        if (!rep || ['reported', 'not_paid'].includes(rep.status)) return rep?.status || null;
        const payment = await db.get(`${subPath(rep.uid)}/payments/${orderId}`);
        if (!payment) return rep.status;
        if ([PAY_STATUS.FAILED, PAY_STATUS.CANCELLED].includes(payment.status)) {
            await db.set(reportPath(orderId), { ...rep, status: 'not_paid', token: null, updatedAt: now() });
            return 'not_paid';
        }
        if (![PAY_STATUS.SUCCESS, PAY_STATUS.REFUNDED].includes(payment.status) || !payment.paidAt) return rep.status;
        const taxPercent = requirePlay().taxPercent;
        const externalTransactionId = `glowos_${orderId}`;
        const totalMicros = Math.round(payment.amount * 1e6);
        const taxMicros = Math.round(totalMicros * taxPercent / (100 + taxPercent));
        const price = (micros) => ({ priceMicros: String(micros), currency: payment.currency });
        await play.reportExternal(externalTransactionId, {
            originalPreTaxAmount: price(totalMicros - taxMicros),
            originalTaxAmount: price(taxMicros),
            transactionTime: new Date(payment.paidAt).toISOString(),
            recurringTransaction: {
                ...(rep.kind === 'initial' ? { externalTransactionToken: rep.token } : { initialExternalTransactionId: rep.initialId }),
                externalSubscription: { subscriptionType: 'PREPAID' },
            },
            userTaxAddress: { regionCode: 'IN', administrativeArea: rep.taxState },
        });
        await db.transaction(async (tx) => {
            const fresh = await tx.get(reportPath(orderId));
            const series = await tx.get(seriesPath(rep.uid));
            tx.set(reportPath(orderId), { ...fresh, status: 'reported', externalTransactionId, token: null, reportedAt: now() });
            if (!series || (series.paidAt || 0) <= payment.paidAt) {
                tx.set(seriesPath(rep.uid), {
                    initialId: rep.kind === 'initial' ? externalTransactionId : rep.initialId,
                    planId: payment.planId, billingCycle: payment.billingCycle, lastOrderId: orderId, paidAt: payment.paidAt,
                });
            }
        });
        return 'reported';
    }

    return {
        syncPlay,
        reportOrder,

        /** Any Razorpay checkout (web or app) must not double-bill a live Play subscription. */
        async assertNotPlayManaged(sub) {
            if (await livePlay(sub, now())) throw billingError('This subscription is billed through Google Play. Manage it in your Google Play subscriptions.', 409, 'MANAGED_BY_GOOGLE_PLAY');
        },

        /**
         * Validate a native Razorpay order: it needs Google's token for this
         * choice, or it continues the live in-app series (a same-plan renewal).
         * Returns the report record that create-order stores with the order.
         */
        async nativeOrderPlan({ uid, sub, body, planId, billingCycle }) {
            requirePlay();
            if (!INDIA_TAX_STATES.includes(body.taxState)) throw billingError('Choose your state for GST.', 400, 'TAX_STATE_REQUIRED');
            const t = now();
            if (await livePlay(sub, t)) throw billingError('This subscription is billed through Google Play.', 409, 'MANAGED_BY_GOOGLE_PLAY');
            if (body.externalTransactionToken != null) {
                if (!validToken(body.externalTransactionToken)) throw billingError('Invalid Google Play choice token.', 400);
                return { kind: 'initial', token: body.externalTransactionToken, initialId: null, taxState: body.taxState };
            }
            const series = await db.get(seriesPath(uid));
            if (seriesLive(series, sub, t) && series.planId === planId && series.billingCycle === billingCycle) {
                return { kind: 'topup', token: null, initialId: series.initialId, taxState: body.taxState };
            }
            throw billingError('Choose a payment option in Google Play first.', 409, 'PLAY_CHOICE_REQUIRED');
        },

        /** POST play-prepare: which Play Billing flow the app should launch. */
        async playPrepare({ uid, body = {} }) {
            requirePlay();
            const { planId, billingCycle, salonId = null } = body;
            const sub = await requireOwner(db, uid, salonId);
            if (sub?.autoRenew && sub.billingSource !== 'google_play') {
                throw billingError('Cancel automatic renewal before buying in the app.', 409, 'AUTO_RENEW_EXISTS');
            }
            const t = now();
            const quote = quotePurchase(sub, planId, billingCycle, await loadPlans(), t);
            if (!quote.ok) throw billingError(quote.error, quote.code === 'DOWNGRADE_BLOCKED' ? 409 : 400, quote.code);
            const accountId = accountIdFor(uid);
            await db.set(accountPath(accountId), { uid, createdAt: t });
            const target = { ...play.productFor(planId, billingCycle), accountId };
            const ps = await livePlay(sub, t);
            if (ps) {
                if (quote.kind !== 'upgrade') throw billingError('This plan renews through Google Play. Manage it in your Google Play subscriptions.', 409, 'MANAGED_BY_GOOGLE_PLAY');
                return ok({ mode: 'play-upgrade', ...target, oldProductId: ps.productId });
            }
            const series = await db.get(seriesPath(uid));
            if (seriesLive(series, sub, t)) {
                if (series.planId === planId && series.billingCycle === billingCycle) return ok({ mode: 'alt-topup', ...target });
                return ok({ mode: 'alt-upgrade', ...target, originalExternalTransactionId: series.initialId });
            }
            return ok({ mode: 'choice', ...target });
        },

        /** POST play-verify: the user chose Google Play and the purchase completed. */
        async playVerify({ uid, body = {} }) {
            if (!validToken(body.purchaseToken)) throw billingError('Missing Google Play purchase.', 400);
            const r = await syncPlay(body.purchaseToken, { uid });
            if (r.status === 'PENDING') return ok({ status: 'PENDING', message: 'Google Play is still processing this payment. Your plan activates when it completes.' }, 202);
            if (r.status === PAY_STATUS.SUCCESS) return ok({ status: PAY_STATUS.SUCCESS });
            return ok({ status: PAY_STATUS.FAILED, reason: 'Google Play did not complete this purchase.' });
        },

        /** Pub/Sub push (RTDN). Authorised by a shared secret; state is always re-read from Google. */
        async playNotify({ secret, rawBody }) {
            if (!requirePlay().rtdnSecretMatches(secret)) return ok({ error: 'Unauthorized' }, 401);
            let note;
            try { note = JSON.parse(Buffer.from(JSON.parse(rawBody).message.data, 'base64').toString('utf8')); }
            catch { return ok({ error: 'Malformed notification.' }, 400); }
            if (note.packageName !== play.packageName) return ok({ error: 'Unknown package.' }, 400);
            const token = note.subscriptionNotification?.purchaseToken;
            if (!validToken(token)) return ok({ received: true });
            try { await syncPlay(token); }
            catch (error) {
                // Purchases not started from this app (no account binding) are acknowledged and ignored.
                if (!['PLAY_ACCOUNT_MISMATCH', 'UNKNOWN_PRODUCT'].includes(error.code)) throw error;
            }
            return ok({ received: true });
        },

        /** Cron: retry pending Google reports and re-read live Play purchases. */
        async playReconcile() {
            if (!play.configured()) return { skipped: 'google_play_not_configured' };
            const failures = [];
            let reported = 0, synced = 0;
            for (const rep of await db.list('externalReports')) {
                if (['reported', 'not_paid'].includes(rep.status)) continue;
                try { if (await reportOrder(rep.id) === 'reported') reported++; }
                catch { failures.push({ orderId: rep.id }); }
            }
            for (const ps of await db.list('playSubscriptions')) {
                if (ps.supersededBy || (!LIVE.has(ps.state) && ps.acknowledged)) continue;
                try { await syncPlay(ps.purchaseToken); synced++; }
                catch { failures.push({ playSubscription: ps.id }); }
            }
            return { reported, synced, failures };
        },
    };
}
