/**
 * unit-subscription.mjs
 * Plan catalog, FeatureAccessService and the subscription state machine.
 *
 * Usage: node scripts/unit-subscription.mjs
 */
import {
    DEFAULT_PLANS, PLAN_IDS, FEATURES, mergePlans, annualSavings, requiredPlanFor, planPrice,
} from '../public/js/core/plans.js';
import { buildAccess, lockInfo, canAccessBranches } from '../public/js/core/featureAccess.js';
import {
    newTrial, effectiveStatus, accessPlanId, trialDaysLeft, DAY_MS, addPeriod,
    applyPaymentSuccess, applyPaymentFailure, applyPaymentCancelled, applyRefund, quotePurchase,
} from '../public/js/core/subscriptionState.js';

let pass = 0; let fail = 0;
const t = (c, l) => { if (c) { pass += 1; console.log('  PASS  ' + l); } else { fail += 1; console.log('  FAIL  ' + l); } };

const NOW = Date.UTC(2026, 9, 7, 10, 0, 0);
const paidSub = (planId, over = {}) => ({
    ownerId: 'o', planId, billingCycle: 'monthly', status: 'ACTIVE',
    currentPeriodStart: NOW - 5 * DAY_MS, currentPeriodEnd: NOW + 25 * DAY_MS, periodAmount: DEFAULT_PLANS[planId].priceMonthly, ...over,
});
const acc = (sub, usage = {}, now = NOW) => buildAccess({ subscription: sub, plans: DEFAULT_PLANS, usage, now });

/* ---------- pricing matches the brief ---------- */
const price = (id) => [DEFAULT_PLANS[id].priceMonthly, DEFAULT_PLANS[id].priceAnnual];
t(JSON.stringify(price('basic')) === '[399,3990]', 'Basic Rs 399 / Rs 3,990');
t(JSON.stringify(price('standard')) === '[799,7990]', 'Standard Rs 799 / Rs 7,990');
t(JSON.stringify(price('premium')) === '[1499,14990]', 'Premium Rs 1,499 / Rs 14,990');
t(JSON.stringify(price('business')) === '[2999,29990]', 'Business Rs 2,999 / Rs 29,990');
t(DEFAULT_PLANS.trial.priceMonthly === 0 && !DEFAULT_PLANS.trial.paid, 'trial is free and not purchasable');
t(annualSavings(DEFAULT_PLANS.basic) === 798 && annualSavings(DEFAULT_PLANS.standard) === 1598, 'annual savings = 2 months free');
t(DEFAULT_PLANS.standard.popular === true && PLAN_IDS.filter((i) => DEFAULT_PLANS[i].popular).length === 1, 'only Standard is Most Popular');
const lim = (id) => [DEFAULT_PLANS[id].maxStaff, DEFAULT_PLANS[id].maxCustomers];
t(JSON.stringify(lim('basic')) === '[2,100]' && JSON.stringify(lim('standard')) === '[10,1500]' && JSON.stringify(lim('premium')) === '[15,5000]' && JSON.stringify(lim('business')) === '[null,null]', 'staff/customer limits per plan (Business unlimited)');
t(DEFAULT_PLANS.trial.features.join() === DEFAULT_PLANS.standard.features.join(), 'trial has Standard-level features');
t(Object.keys(FEATURES).every((f) => DEFAULT_PLANS.business.features.includes(f)), 'Business includes every feature');
t(DEFAULT_PLANS.basic.features.every((f) => DEFAULT_PLANS.standard.features.includes(f)) && DEFAULT_PLANS.standard.features.every((f) => DEFAULT_PLANS.premium.features.includes(f)) && DEFAULT_PLANS.premium.features.every((f) => DEFAULT_PLANS.business.features.includes(f)), 'each tier includes the previous tier');

/* ---------- feature matrix ---------- */
const basic = acc(paidSub('basic'));
t(basic.can('appointments') && basic.can('billing') && basic.can('attendance'), 'Basic: appointments/billing/attendance');
t(!basic.can('onlineBooking') && !basic.can('referral') && !basic.can('loyalty'), 'Basic: no online booking / referral / loyalty');
const std = acc(paidSub('standard'));
t(std.can('onlineBooking') && std.can('referral') && std.can('loyalty') && std.can('inventory'), 'Standard: online booking, referral, loyalty, inventory');
t(!std.can('campaigns') && !std.can('multiBranch'), 'Standard: no campaigns / multi-branch');
const prem = acc(paidSub('premium'));
t(prem.can('campaigns') && prem.can('birthdayCampaigns') && prem.can('apiAccess') && !prem.can('multiBranch'), 'Premium: campaigns + API, not multi-branch');
const biz = acc(paidSub('business'));
t(biz.can('multiBranch') && biz.can('branchReports') && biz.can('rolesPermissions'), 'Business: multi-branch, branch reports, roles');
t(requiredPlanFor('referral').id === 'standard' && requiredPlanFor('campaigns').id === 'premium' && requiredPlanFor('multiBranch').id === 'business' && requiredPlanFor('billing').id === 'basic', 'requiredPlanFor names the cheapest plan');
t(lockInfo(basic, 'referral').requiredPlanName === 'Standard', 'lock info names the required plan for the upgrade CTA');

/* ---------- limits ---------- */
t(!acc(paidSub('basic'), { staff: 2 }).canCreate('staff').ok && acc(paidSub('basic'), { staff: 1 }).canCreate('staff').ok, 'Basic caps at 2 staff');
const capped = acc(paidSub('basic'), { customer: 100 }).canCreate('customer');
t(!capped.ok && capped.requiredPlan.id === 'standard' && /100 customers/.test(capped.reason), 'Basic caps at 100 customers and points to Standard');
t(acc(paidSub('standard'), { staff: 9, customer: 1499 }).canCreate('staff').ok && !acc(paidSub('standard'), { customer: 1500 }).canCreate('customer').ok, 'Standard caps at 10 staff / 1500 customers');
t(!acc(paidSub('premium'), { staff: 15 }).canCreate('staff').ok, 'Premium caps at 15 staff');
t(acc(paidSub('business'), { staff: 500, customer: 100000 }).canCreate('staff').ok && acc(paidSub('business'), { customer: 100000 }).canCreate('customer').ok, 'Business is unlimited');

/* ---------- multi-branch ---------- */
t(acc(paidSub('standard'), { branch: 0 }).canCreate('branch').ok, 'first branch always allowed');
const noMulti = acc(paidSub('premium'), { branch: 1 }).canCreate('branch');
t(!noMulti.ok && noMulti.requiredPlan.id === 'business', 'second branch needs Business');
t(acc(paidSub('business'), { branch: 3 }).canCreate('branch').ok, 'Business can add branches');
t(!acc(paidSub('business'), { branch: 10 }).canCreate('branch').ok, 'Business capped at maxBranches');
const grand = acc(paidSub('standard'), { branch: 3 });
t(grand.usage.branch === 3 && !grand.canCreate('branch').ok, 'existing multi-branch salon keeps its branches but cannot add more');
t(canAccessBranches(acc(paidSub('business'))), 'Branches UI shown on an active Business plan');
t(['basic', 'standard', 'premium'].every((id) => !canAccessBranches(acc(paidSub(id)))), 'Branches UI hidden on Basic / Standard / Premium');
t(!canAccessBranches(acc(newTrial('o', NOW))) && !canAccessBranches(acc(null)) && !canAccessBranches(null), 'Branches UI hidden for trial, missing or pending access');
t(!canAccessBranches(acc(paidSub('business', { currentPeriodEnd: NOW - 30 * DAY_MS }))), 'Branches UI hidden once the Business plan has expired');
t(canAccessBranches(buildAccess({ subscription: null, plans: DEFAULT_PLANS, now: NOW, unrestricted: true })), 'Branches UI shown in unrestricted demo mode');

/* ---------- trial ---------- */
const trial = newTrial('o', NOW);
t(acc(trial).isTrial && acc(trial).trialDaysLeft === 30, 'new trial shows 30 days left');
t(acc(trial, {}, NOW + 10 * DAY_MS).trialDaysLeft === 20, 'countdown after 10 days = 20');
t(acc(trial, {}, NOW + 29 * DAY_MS + 3600000).trialDaysLeft === 1, 'last day shows 1');
t(acc(trial).can('referral') && acc(trial).can('onlineBooking') && !acc(trial).can('campaigns'), 'trial = Standard-level access');
t(!acc(trial, { staff: 10 }).canCreate('staff').ok, 'trial capped like Standard (10 staff)');
const expired = acc(trial, {}, NOW + 31 * DAY_MS);
t(expired.status === 'EXPIRED' && expired.locked && !expired.can('appointments') && !expired.canCreate('customer').ok, 'expired trial: locked, read-only');
t(!acc(null).isTrial && acc(null).locked && acc(null).pending && !acc(null).can('billing'), 'missing subscription fails closed until persisted trial loads');
t(buildAccess({ subscription: null, unrestricted: true }).can('multiBranch'), 'demo/unrestricted allows everything');
t(trialDaysLeft(paidSub('basic'), NOW) === 0, 'paid subscription has no trial days');

/* ---------- paid lifecycle ---------- */
t(acc(paidSub('standard')).status === 'ACTIVE', 'ACTIVE within period');
const graceSub = paidSub('standard', { currentPeriodEnd: NOW - DAY_MS });
t(acc(graceSub).status === 'GRACE_PERIOD' && acc(graceSub).can('referral'), 'GRACE_PERIOD keeps access for a few days');
const lapsed = paidSub('standard', { currentPeriodEnd: NOW - 10 * DAY_MS });
t(acc(lapsed).locked && acc(lapsed).status === 'EXPIRED', 'EXPIRED after grace -> locked');
t(acc(paidSub('standard', { status: 'SUSPENDED' })).locked, 'SUSPENDED locks access');
t(accessPlanId(paidSub('standard', { status: 'CANCELLED' }), NOW) === 'standard', 'CANCELLED keeps access to period end');
t(effectiveStatus(paidSub('standard', { status: 'CANCELLED', currentPeriodEnd: NOW - 1 }), NOW) === 'EXPIRED', 'CANCELLED past period end is EXPIRED');
t(acc(paidSub('standard', { status: 'PAST_DUE' })).can('referral'), 'PAST_DUE retains access during the period');

/* ---------- catalog overrides ---------- */
const merged = mergePlans([{ id: 'basic', priceMonthly: 449, maxStaff: 3, features: ['appointments', 'bogus'] }, { id: 'ghost', priceMonthly: 1 }]);
t(merged.basic.priceMonthly === 449 && merged.basic.maxStaff === 3 && merged.basic.features.join() === 'appointments', 'admin plan overrides apply; unknown features dropped');
t(!merged.ghost && merged.standard.priceMonthly === 799, 'unknown plans ignored; others keep defaults');
t(mergePlans([{ id: 'business', maxStaff: null }]).business.maxStaff === null, 'null limit = unlimited override');
t(planPrice(merged.basic, 'annual') === 3990, 'annual price falls back to default');

/* ---------- reducers ---------- */
const order = (over = {}) => ({ orderId: 'order_1', ownerId: 'o', subscriptionId: 'o', planId: 'standard', billingCycle: 'monthly', kind: 'new', amount: 799, currency: 'INR', status: 'PENDING', ...over });
const ok1 = applyPaymentSuccess(trial, order(), NOW, { receiptNumber: 'R1', gatewayPaymentId: 'pay_1', method: 'upi' });
t(!ok1.duplicate && ok1.sub.status === 'ACTIVE' && ok1.payment.status === 'SUCCESS' && ok1.events.length === 2, 'success activates and emits events');
t(applyPaymentSuccess(ok1.sub, ok1.payment, NOW + 1).duplicate === true, 'applying the same payment again is a duplicate');
t(applyPaymentSuccess(trial, order({ planId: 'basic', billingCycle: 'annual' }), NOW).sub.currentPeriodEnd === addPeriod(NOW, 'annual'), 'annual period = +1 year');
t(addPeriod(Date.UTC(2026, 0, 31), 'monthly') === Date.UTC(2026, 1, 28), 'Jan 31 + 1 month clamps to Feb 28');
t(applyPaymentFailure(ok1.sub, order(), NOW).sub === ok1.sub, 'failure does not touch the active subscription');
t(applyPaymentFailure(ok1.sub, ok1.payment, NOW).duplicate === true, 'failure cannot overwrite a SUCCESS payment');
t(applyPaymentCancelled(trial, order(), NOW).payment.status === 'CANCELLED' && applyPaymentCancelled(trial, { ...order(), status: 'SUCCESS' }, NOW).duplicate, 'only PENDING can be cancelled');
const rf = applyRefund(ok1.sub, ok1.payment, NOW, 799);
t(rf.payment.status === 'REFUNDED' && rf.sub.status === 'CANCELLED', 'full refund -> REFUNDED + CANCELLED');
t(applyRefund(ok1.sub, ok1.payment, NOW, 100).payment.status === 'SUCCESS', 'partial refund keeps SUCCESS');
t(quotePurchase(trial, 'standard', 'monthly', DEFAULT_PLANS, NOW).kind === 'new', 'trial -> paid is a new purchase');

t(effectiveStatus({ ...trial, trialEndsAt: null }, NOW) === 'EXPIRED', 'missing trial expiry fails closed');
t(effectiveStatus(trial, trial.trialEndsAt) === 'EXPIRED', 'trial locks at exact expiry');
t(effectiveStatus(paidSub('basic', { status: 'UNKNOWN' }), NOW) === 'EXPIRED', 'unknown state fails closed');
t(effectiveStatus(paidSub('basic', { status: 'CANCELLED', currentPeriodEnd: NOW }), NOW) === 'EXPIRED', 'cancelled locks at exact period end');
t(effectiveStatus(paidSub('basic', { currentPeriodEnd: NOW - 3 * DAY_MS }), NOW) === 'EXPIRED', 'grace locks at exact grace end');

console.log(`\nUNIT SUBSCRIPTION: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
