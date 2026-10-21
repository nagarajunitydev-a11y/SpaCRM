/**
 * featureAccess.js
 * FeatureAccessService — the ONE place that answers "may this salon do X?".
 * UI and action handlers ask this object; none of them inspect plan names,
 * statuses or limits themselves.
 *
 * `buildAccess()` is pure: give it the subscription record, the (merged)
 * plan catalog, current usage and the clock, and it returns an immutable
 * access snapshot.
 */

import { DEFAULT_PLANS, FEATURES, requiredPlanFor } from './plans.js';
import { effectiveStatus, accessPlanId, trialDaysLeft, SUB_STATUS } from './subscriptionState.js';

const LIMIT_KEYS = { staff: 'maxStaff', customer: 'maxCustomers', branch: 'maxBranches' };
const NOUN = { staff: 'staff members', customer: 'customers', branch: 'branches' };

/**
 * @param {object} p
 * @param {object|null} p.subscription  record with epoch-ms dates (null = none yet)
 * @param {object}      p.plans         merged plan catalog
 * @param {{staff:number,customer:number,branch:number}} p.usage
 * @param {number}      p.now
 * @param {boolean}     [p.unrestricted]  demo mode: everything allowed
 */
export function buildAccess({ subscription, plans = DEFAULT_PLANS, usage = {}, now = Date.now(), unrestricted = false }) {
    const used = { staff: 0, customer: 0, branch: 0, ...usage };

    if (unrestricted) {
        return makeAccess({ status: 'ACTIVE', planId: 'business', plans, used, subscription, now, locked: false, unrestricted: true });
    }
    const status = subscription ? effectiveStatus(subscription, now) : 'NONE';
    // Wait for the persisted trial. Missing/failed subscription reads must
    // never grant entitlements.
    if (status === 'NONE') {
        return makeAccess({ status: 'NONE', planId: null, plans, used, subscription, now, locked: true, pending: true });
    }
    const planId = accessPlanId(subscription, now);
    return makeAccess({ status, planId, plans, used, subscription, now, locked: planId === null });
}

function makeAccess({ status, planId, plans, used, subscription, now, locked, unrestricted = false, pending = false }) {
    const plan = planId ? plans[planId] : null;
    const featureSet = new Set(plan ? plan.features : []);

    function can(feature) {
        if (unrestricted) return true;
        return !locked && featureSet.has(feature);
    }

    function limit(kind) {
        if (!plan) return 0;
        const v = plan[LIMIT_KEYS[kind]];
        return v === undefined ? null : v;
    }

    /** { ok, reason, requiredPlan } — may one more `kind` record be created? */
    function canCreate(kind) {
        if (unrestricted) return { ok: true };
        if (locked) {
            return { ok: false, reason: 'Your subscription has expired. Your data is safe — upgrade to continue adding records.', requiredPlan: null };
        }
        if (kind === 'branch') {
            if (!featureSet.has('multiBranch') && used.branch >= 1) {
                const req = requiredPlanFor('multiBranch', plans);
                return { ok: false, reason: `Multiple branches need the ${req ? req.name : 'Business'} plan.`, requiredPlan: req };
            }
        }
        const max = limit(kind);
        if (max !== null && used[kind] >= max) {
            const next = Object.values(plans)
                .filter((p) => p.paid && (p[LIMIT_KEYS[kind]] === null || p[LIMIT_KEYS[kind]] > max))
                .sort((a, b) => a.order - b.order)[0] || null;
            return {
                ok: false,
                reason: `Your ${plan.name} plan allows ${max} ${NOUN[kind]}.${next ? ` Upgrade to ${next.name} for ${next[LIMIT_KEYS[kind]] === null ? 'unlimited' : next[LIMIT_KEYS[kind]]}.` : ''}`,
                requiredPlan: next,
            };
        }
        return { ok: true };
    }

    function requiredPlan(feature) {
        return requiredPlanFor(feature, plans);
    }

    return Object.freeze({
        status,
        planId,
        plan,
        locked,
        readOnly: locked,
        unrestricted,
        pending,
        isTrial: status === SUB_STATUS.TRIAL,
        trialDaysLeft: subscription ? trialDaysLeft(subscription, now) : 0,
        periodEnd: subscription ? subscription.currentPeriodEnd : null,
        billingCycle: subscription ? subscription.billingCycle : null,
        usage: used,
        can,
        limit,
        canCreate,
        requiredPlan,
        featureLabel: (f) => FEATURES[f] || f,
    });
}

/** Branch management is shown only to salons on an active Business plan (or the demo). */
export function canAccessBranches(access) {
    if (!access) return false;
    return access.unrestricted || (!access.locked && access.planId === 'business');
}

/** Locked-feature descriptor used by every "upgrade to unlock" screen. */
export function lockInfo(access, feature) {
    const req = access.requiredPlan(feature);
    return {
        feature,
        label: FEATURES[feature] || feature,
        requiredPlanId: req ? req.id : null,
        requiredPlanName: req ? req.name : 'a paid plan',
        expired: access.locked,
    };
}

export default { buildAccess, canAccessBranches, lockInfo };
