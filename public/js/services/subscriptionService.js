/**
 * subscriptionService.js
 * SubscriptionService — owns everything subscription-related on the client:
 *   - listens to the owner's `subscriptions/{uid}` record, its payments and
 *     events, and the plan catalog (`plans`)
 *   - starts a 30-day trial explicitly after the owner creates a salon
 *   - keeps `state.access` (the FeatureAccessService snapshot) current
 *   - for a super admin, loads every subscription / payment / event
 *
 * Writes from the browser are deliberately tiny: the trial record (once,
 * rule-enforced) and a `usage` snapshot. Plan, status and period fields are
 * written only by the server after a verified payment.
 *
 * Demo mode (no Firebase) has no billing: access is unrestricted, unless the
 * URL carries ?demoPlan=trial|basic|standard|premium|business|expired so the
 * gated UI can be exercised locally.
 */

import { store } from '../core/store.js';
import { isDemoMode, getFirebase } from './firebase.js';
import { listenCollection, listenDocument, listenCollectionGroup, runAtomic, updateDocument, toMillis, tsFromMillis } from './db.js';
import { mergePlans, DEFAULT_PLANS } from '../core/plans.js';
import { buildAccess } from '../core/featureAccess.js';
import { newTrial, effectiveStatus, SUB_STATUS, DAY_MS } from '../core/subscriptionState.js';

const DATE_FIELDS = ['startDate', 'endDate', 'trialStartedAt', 'trialEndsAt', 'currentPeriodStart', 'currentPeriodEnd', 'createdAt', 'updatedAt', 'usageUpdatedAt', 'paidAt', 'failedAt', 'cancelledAt', 'refundedAt', 'periodStart', 'periodEnd', 'at'];

/** Firestore row -> plain record with epoch-ms dates. */
export function normalizeRow(row) {
    if (!row) return null;
    const out = { ...row };
    DATE_FIELDS.forEach((k) => { if (k in out) out[k] = toMillis(out[k]); });
    return out;
}

let unsubs = [];
let listeningFor = null;
const trialRequests = new Map();
let tickTimer = null;
let usageTimer = null;
let lastAccessKey = '';
let lastUsageSent = '';

function stop() {
    unsubs.forEach((u) => { try { u(); } catch { /* noop */ } });
    unsubs = [];
    listeningFor = null;
}

/* ------------------------------------------------------------------ */
/* Demo-mode synthetic subscription                                    */
/* ------------------------------------------------------------------ */

let demoCache;
function demoRecord(now) {
    // Built once: a record that changed on every call would make every
    // refresh look like a new snapshot and loop through the store listeners.
    if (demoCache === undefined) demoCache = buildDemoRecord(now);
    return demoCache;
}

function buildDemoRecord(now) {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('demoPlan') : null;
    if (!q) return null; // unrestricted
    if (q === 'trial') return { ...newTrial('demo', now - 3 * DAY_MS), id: 'demo' };
    if (q === 'expired') return { ...newTrial('demo', now - 40 * DAY_MS), id: 'demo' };
    if (DEFAULT_PLANS[q] && DEFAULT_PLANS[q].paid) {
        return {
            id: 'demo', ownerId: 'demo', planId: q, billingCycle: 'monthly', status: SUB_STATUS.ACTIVE,
            currentPeriodStart: now - 5 * DAY_MS, currentPeriodEnd: now + 25 * DAY_MS, periodAmount: DEFAULT_PLANS[q].priceMonthly,
        };
    }
    return null;
}

/* ------------------------------------------------------------------ */
/* Access computation                                                  */
/* ------------------------------------------------------------------ */

export function currentUsage(state = store.getState()) {
    return {
        staff: (state.staffList || []).length,
        customer: (state.customersList || []).length,
        branch: (state.salonsList || []).length,
    };
}

/** Recompute `state.access`; only writes to the store when something changed. */
let refreshing = false;
export function refreshAccess() {
    // setState below re-enters store listeners that call this again.
    if (refreshing) return store.getState().access;
    refreshing = true;
    try {
        return computeAccess();
    } finally {
        refreshing = false;
    }
}

function computeAccess() {
    const state = store.getState();
    const now = Date.now();
    const plans = state.plansCatalog || DEFAULT_PLANS;
    const usage = currentUsage(state);

    let subscription = state.subscription || null;
    let unrestricted = false;
    if (isDemoMode()) {
        subscription = demoRecord(now);
        unrestricted = !subscription;
    }
    const access = buildAccess({ subscription, plans, usage, now, unrestricted });

    const key = [
        access.status, access.planId, access.locked, access.trialDaysLeft, access.billingCycle, access.periodEnd,
        usage.staff, usage.customer, usage.branch, state.plansCatalogVersion || 0, access.pending,
        subscription ? subscription.planId : '', subscription ? subscription.updatedAt : '',
    ].join('|');
    if (key === lastAccessKey && state.access) return state.access;
    lastAccessKey = key;
    store.setState({ access, effectiveSubscription: subscription });
    scheduleUsageSync(usage);
    return access;
}

/* ------------------------------------------------------------------ */
/* Trial + usage writes                                                */
/* ------------------------------------------------------------------ */

function trialError(error) {
    if (error.code === 'permission-denied' || error.code === 'firestore/permission-denied') {
        return new Error('Your account does not have permission to activate a trial for this salon. Sign in as its owner or contact support.');
    }
    if (['unavailable', 'deadline-exceeded', 'failed-precondition'].includes(error.code)) {
        return new Error('Could not activate your free trial. Check your connection and try again.');
    }
    return error;
}

async function ensureTrial(user, salonId) {
    const now = Date.now();
    const trial = newTrial(user.uid, now);
    const record = {
        ...trial,
        salonId,
        ownerEmail: user.email || '',
        startDate: tsFromMillis(trial.trialStartedAt),
        endDate: tsFromMillis(trial.trialEndsAt),
        trialStartedAt: tsFromMillis(trial.trialStartedAt),
        trialEndsAt: tsFromMillis(trial.trialEndsAt),
        createdAt: tsFromMillis(now),
        usage: currentUsage(),
    };
    const result = await runAtomic(async (tx) => {
        // One owner subscription, shared by all its branches and paid checkout.
        // Firestore retries contention; no duplicate trial or restarted clock.
        const existing = await tx.get(['subscriptions'], user.uid);
        if (existing) return existing;
        const salon = await tx.get(['salons'], salonId);
        if (!salon || salon.ownerId !== user.uid) throw new Error('Choose a salon owned by your signed-in account.');
        tx.set(['subscriptions'], user.uid, record);
        return { id: user.uid, ...record };
    });
    if (!result) throw new Error('Firebase is unavailable. Your free trial was not activated.');
    const subscription = normalizeRow(result);
    if (subscription.planId !== 'trial' || subscription.status !== SUB_STATUS.TRIAL) {
        throw new Error(subscription.planId === 'trial'
            ? 'Your free trial is no longer active. Choose a paid plan to continue.'
            : 'This account already has a subscription. Manage your existing plan instead.');
    }
    if (effectiveStatus(subscription, Date.now()) !== SUB_STATUS.TRIAL) {
        throw new Error('Your 30-day free trial has already expired. Choose a paid plan to continue.');
    }
    if (store.getState().currentUser?.uid !== user.uid || getFirebase()?.auth.currentUser?.uid !== user.uid) {
        throw new Error('Your sign-in changed during activation. Sign in again to continue.');
    }
    // Do not depend on the realtime listener arriving before navigation.
    store.setState({ subscription, subscriptionLoaded: true, subscriptionError: null });
    refreshAccess();
    return subscription;
}

function scheduleUsageSync(usage) {
    if (isDemoMode()) return;
    const state = store.getState();
    const rec = state.subscription;
    if (!rec || !state.currentUser || state.accountRole === 'super_admin') return;
    // Only sync once every list is loaded, otherwise zeros would be written.
    if (!state.salonsLoaded) return;
    const sig = JSON.stringify(usage);
    const stored = rec.usage ? JSON.stringify({ staff: rec.usage.staff, customer: rec.usage.customer, branch: rec.usage.branch }) : '';
    if (sig === stored || sig === lastUsageSent) return;
    clearTimeout(usageTimer);
    usageTimer = setTimeout(async () => {
        try {
            lastUsageSent = sig;
            await updateDocument(['subscriptions'], state.currentUser.uid, { usage, usageUpdatedAt: tsFromMillis(Date.now()) });
        } catch (err) {
            lastUsageSent = '';
            console.warn('[subscription] usage sync skipped:', err && err.message ? err.message : err);
        }
    }, 2500);
}

/* ------------------------------------------------------------------ */
/* Listeners                                                           */
/* ------------------------------------------------------------------ */

/** Call whenever auth / role changes (idempotent). */
export function syncSubscription() {
    if (isDemoMode()) {
        refreshAccess();
        startTick();
        return;
    }
    const state = store.getState();
    const user = state.currentUser;
    if (!user || state.userRole === 'guest') {
        if (listeningFor) {
            stop();
            store.setState({ subscription: null, subscriptionLoaded: false, subscriptionPayments: [], subscriptionEvents: [], access: null, trialStarting: false, trialError: null, subscriptionError: null });
            lastAccessKey = '';
        }
        return;
    }
    const isAdmin = state.accountRole === 'super_admin';
    const key = `${user.uid}|${isAdmin ? 'admin' : 'owner'}`;
    if (key === listeningFor) return;
    stop();
    listeningFor = key;

    // Plan catalog is readable by every signed-in user.
    unsubs.push(listenCollection(['plans'], (rows) => {
        store.setState({ plansCatalog: mergePlans(rows), plansRows: rows, plansCatalogVersion: (store.getState().plansCatalogVersion || 0) + 1 });
        refreshAccess();
    }, () => {}));

    if (isAdmin) {
        unsubs.push(listenCollection(['subscriptions'], (rows) => store.setState({ adminSubscriptions: rows.map(normalizeRow), adminSubscriptionsLoaded: true }), (e) => store.setState({ adminSubscriptionsLoaded: true, adminSubscriptionsError: e.message })));
        unsubs.push(listenCollectionGroup('payments', (rows) => store.setState({ adminPayments: rows.map(normalizeRow) }), () => {}));
        unsubs.push(listenCollectionGroup('events', (rows) => store.setState({ adminEvents: rows.map(normalizeRow).filter((r) => r._path && r._path.startsWith('subscriptions/')) }), () => {}));
        return;
    }

    unsubs.push(listenDocument(['subscriptions'], user.uid, (row) => {
        const rec = normalizeRow(row);
        store.setState({ subscription: rec, subscriptionLoaded: true, subscriptionError: null });
        refreshAccess();
    }, (error) => {
        store.setState({ subscription: null, subscriptionLoaded: true, subscriptionError: trialError(error).message });
        refreshAccess();
    }));
    unsubs.push(listenCollection(['subscriptions', user.uid, 'payments'], (rows) => {
        store.setState({ subscriptionPayments: rows.map(normalizeRow).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) });
    }, () => {}));
    unsubs.push(listenCollection(['subscriptions', user.uid, 'events'], (rows) => {
        store.setState({ subscriptionEvents: rows.map(normalizeRow).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 30) });
    }, () => {}));
    startTick();
}

/** Re-evaluate once a minute so trial countdowns / expiry advance with the clock. */
function startTick() {
    if (tickTimer) return;
    tickTimer = setInterval(() => refreshAccess(), 60 * 1000);
}

/* ------------------------------------------------------------------ */
/* Super admin: plan catalog editing                                   */
/* ------------------------------------------------------------------ */

export async function savePlan(planId, patch) {
    const fb = getFirebase();
    if (!fb) throw new Error('Plans can only be edited when connected to Firebase.');
    const { setDocument } = await import('./db.js');
    const current = (store.getState().plansCatalog || DEFAULT_PLANS)[planId];
    await setDocument(['plans'], planId, { ...current, ...patch, updatedAt: tsFromMillis(Date.now()) });
}

/** Super admin: suspend / reactivate a subscription. */
export async function setSubscriptionSuspended(ownerId, suspended) {
    const row = (store.getState().adminSubscriptions || []).find((s) => s.id === ownerId);
    if (!row) throw new Error('Subscription not found.');
    const status = suspended
        ? SUB_STATUS.SUSPENDED
        : (row.currentPeriodEnd && row.currentPeriodEnd > Date.now() ? SUB_STATUS.ACTIVE : (row.planId === 'trial' ? SUB_STATUS.TRIAL : SUB_STATUS.EXPIRED));
    await updateDocument(['subscriptions'], ownerId, { status, updatedAt: tsFromMillis(Date.now()) });
}

/** Activate a real trial, or resume the same active trial without extending it. */
export function startTrial() {
    const state = store.getState();
    const fb = getFirebase();
    const user = fb?.auth.currentUser;
    if (!user || user.isAnonymous || user.uid !== state.currentUser?.uid) {
        return Promise.reject(new Error('Sign in to your salon account before starting a free trial.'));
    }
    if (!state.currentSalonId) return Promise.reject(new Error('Set up your salon before starting your free trial.'));
    if (trialRequests.has(user.uid)) return trialRequests.get(user.uid);
    // Register the shared promise before any store update can re-enter listeners.
    const request = Promise.resolve().then(() => {
        store.setState({ trialStarting: true, trialError: null });
        return ensureTrial(user, state.currentSalonId);
    }).catch((error) => {
        const friendly = trialError(error);
        if (store.getState().currentUser?.uid === user.uid) store.setState({ trialError: friendly.message });
        throw friendly;
    }).finally(() => {
        trialRequests.delete(user.uid);
        if (store.getState().currentUser?.uid === user.uid) store.setState({ trialStarting: false });
    });
    trialRequests.set(user.uid, request);
    return request;
}

export default { startTrial, syncSubscription, refreshAccess, currentUsage, savePlan, setSubscriptionSuspended, normalizeRow };
