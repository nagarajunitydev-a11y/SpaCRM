/**
 * unit-referral-bonus.mjs
 * Unit tests for the server-side referral reward system.
 *
 * Tests the Cloud Function logic (onAppointmentStatusChange) via a
 * simulated demo-mode version. The production function runs as a
 * Firebase Cloud Function using Firestore Admin SDK transactions.
 *
 * Canonical data model under test:
 *   - customers/{id}.referredBy    → Client A's customer ID
 *   - customers/{id}.rewardPoints  → Canonical points field
 *   - referralRewards/{aptId}      → Server-created audit records
 *
 * Usage: node scripts/unit-referral-bonus.mjs
 */

import { store } from '../public/js/core/store.js';

const REFERRAL_SIGNUP_BONUS = 100;
const REFERRAL_BONUS_POINTS = 100;

let pass = 0;
let fail = 0;

function t(cond, label) {
    if (cond) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; console.log('  FAIL  ' + label); }
}

/* ------------------------------------------------------------------ */
/* Test harness: set up demo-mode stores                               */
/* ------------------------------------------------------------------ */

function resetStore() {
    store.setState({
        mode: 'demo',
        customersList: [],
        appointmentsList: [],
        referralsList: [],
        referralsLoaded: true,
        referralsError: null,
        transactionsList: [],
        transactionsLoaded: true,
        transactionsError: null,
        referralRewards: [],
        currentSalonId: 'salon_test_01',
    });
}

function seedReferrer(overrides = {}) {
    const customer = {
        id: 'client_a_01',
        salonId: 'salon_test_01',
        name: 'Alice Referrer',
        phone: '+919000000001',
        email: 'alice@test.com',
        rewardPoints: REFERRAL_SIGNUP_BONUS,
        referralCode: 'LG-ALICE1',
        ...overrides,
    };
    const list = store.getState().customersList || [];
    store.setState({ customersList: [...list, customer] });
    return customer;
}

function seedReferredCustomer(overrides = {}) {
    const customer = {
        id: 'client_b_01',
        salonId: 'salon_test_01',
        name: 'Bob Referred',
        phone: '+919000000002',
        email: 'bob@test.com',
        rewardPoints: REFERRAL_SIGNUP_BONUS,
        referralCode: 'LG-BOBBY1',
        referredBy: 'client_a_01',
        referredByCode: 'LG-ALICE1',
        ...overrides,
    };
    const list = store.getState().customersList || [];
    store.setState({ customersList: [...list, customer] });
    return customer;
}

function getCustomer(id) {
    return (store.getState().customersList || []).find((c) => c.id === id) || null;
}

function getReferralRewards() {
    return store.getState().referralRewards || [];
}

function updateCustomer(id, patch) {
    const list = store.getState().customersList || [];
    store.setState({
        customersList: list.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    });
}

/* ------------------------------------------------------------------ */
/* Simulated Cloud Function logic                                      */
/* Mirrors functions/index.js → onAppointmentStatusChange              */
/* ------------------------------------------------------------------ */

async function simulateOnAppointmentStatusChange(appointment) {
    const salonId = appointment.salonId;
    const appointmentId = appointment.id;
    const newStatus = appointment.status;
    const customerId = appointment.customerId;

    // Gate: only process "Completed"
    if (newStatus !== 'Completed') {
        return { action: 'skip', reason: 'not_completed' };
    }

    // Gate: must have customerId
    if (!customerId) {
        return { action: 'skip', reason: 'no_customer_id' };
    }

    // Step 1: Fetch the referred customer (Client B)
    const customer = getCustomer(customerId);
    if (!customer) {
        return { action: 'skip', reason: 'customer_not_found' };
    }

    // Gate: must have referredBy
    const referrerId = customer.referredBy;
    if (!referrerId) {
        return { action: 'skip', reason: 'no_referredBy' };
    }

    // Step 2: Fetch the referrer (Client A)
    const referrer = getCustomer(referrerId);
    if (!referrer) {
        return { action: 'skip', reason: 'referrer_not_found' };
    }

    const referrerSalonId = referrer.salonId || salonId;

    // Gate: idempotency — check referralRewards/{appointmentId}
    const existingRewards = getReferralRewards();
    if (existingRewards.some((r) => r.appointmentId === appointmentId)) {
        return { action: 'skip', reason: 'already_rewarded' };
    }

    // Transaction: create reward + increment points
    const reward = {
        appointmentId,
        salonId,
        referrerClientId: referrerId,
        referrerClientName: referrer.name || '',
        referrerSalonId,
        referredClientId: customerId,
        referredClientName: customer.name || '',
        points: REFERRAL_BONUS_POINTS,
        type: 'referral_bonus',
        status: 'credited',
        createdAt: new Date().toISOString(),
    };

    const rewardsList = getReferralRewards();
    store.setState({ referralRewards: [...rewardsList, reward] });

    // Credit referrer's points
    const prevPts = Number(referrer.rewardPoints) || 0;
    const newPts = prevPts + REFERRAL_BONUS_POINTS;
    updateCustomer(referrerId, { rewardPoints: newPts });

    return {
        action: 'credited',
        referrerId,
        prevPts,
        bonus: REFERRAL_BONUS_POINTS,
        newPts,
        reward,
    };
}

/* ================================================================== */
/* TEST SUITE                                                          */
/* ================================================================== */

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  REFERRAL REWARD CLOUD FUNCTION UNIT TESTS');
console.log('  (Simulated server-side logic)');
console.log('═══════════════════════════════════════════════════════════\n');

/* ── Test 1: Valid referral + Completed = +100 to referrer ───────── */
{
    console.log('▸ Test 1: Valid referral + Completed appointment → +100 pts to referrer');
    resetStore();
    seedReferrer();
    seedReferredCustomer();

    const appt = { id: 'apt_001', customerId: 'client_b_01', salonId: 'salon_test_01', status: 'Completed' };
    const result = await simulateOnAppointmentStatusChange(appt);

    t(result.action === 'credited', '  action is "credited"');
    t(result.bonus === 100, '  bonus is 100');
    t(result.prevPts === REFERRAL_SIGNUP_BONUS, '  prev pts = signup bonus (100)');
    t(result.newPts === REFERRAL_SIGNUP_BONUS + 100, '  new pts = 200');

    const referrer = getCustomer('client_a_01');
    t(referrer.rewardPoints === 200, '  Client A rewardPoints = 200');

    const rewards = getReferralRewards();
    t(rewards.length === 1, '  1 referralRewards record created');
    t(rewards[0].appointmentId === 'apt_001', '  reward linked to appointment');
    t(rewards[0].referrerClientId === 'client_a_01', '  reward referrer = Client A');
    t(rewards[0].referredClientId === 'client_b_01', '  reward referred = Client B');
    t(rewards[0].points === 100, '  reward points = 100');
    t(rewards[0].status === 'credited', '  reward status = credited');
    t(rewards[0].type === 'referral_bonus', '  reward type = referral_bonus');
    console.log('');
}

/* ── Test 2: No referral (no referredBy) = skip ──────────────────── */
{
    console.log('▸ Test 2: Customer without referredBy → skip (no points)');
    resetStore();
    seedReferrer();
    store.setState({
        customersList: [...store.getState().customersList, {
            id: 'client_c_01',
            salonId: 'salon_test_01',
            name: 'Charlie NoRef',
            phone: '+919000000003',
            rewardPoints: REFERRAL_SIGNUP_BONUS,
            referralCode: 'LG-CHARL1',
            // No referredBy — not a referred client
        }],
    });

    const appt = { id: 'apt_002', customerId: 'client_c_01', salonId: 'salon_test_01', status: 'Completed' };
    const result = await simulateOnAppointmentStatusChange(appt);

    t(result.action === 'skip', '  action is "skip"');
    t(result.reason === 'no_referredBy', '  reason = no_referredBy');
    t(getReferralRewards().length === 0, '  no referralRewards created');
    t(getCustomer('client_a_01').rewardPoints === REFERRAL_SIGNUP_BONUS, '  referrer points unchanged');
    console.log('');
}

/* ── Test 3: Cancelled appointment = skip ────────────────────────── */
{
    console.log('▸ Test 3: Cancelled appointment → skip (Cloud Function gate)');
    resetStore();
    seedReferrer();
    seedReferredCustomer();

    const appt = { id: 'apt_003', customerId: 'client_b_01', salonId: 'salon_test_01', status: 'Cancelled' };
    const result = await simulateOnAppointmentStatusChange(appt);

    t(result.action === 'skip', '  action is "skip"');
    t(result.reason === 'not_completed', '  reason = not_completed (Cloud Function gate)');
    t(getReferralRewards().length === 0, '  no referralRewards created');
    t(getCustomer('client_a_01').rewardPoints === REFERRAL_SIGNUP_BONUS, '  referrer points unchanged');
    console.log('');
}

/* ── Test 4: No-show / Confirmed appointment = skip ──────────────── */
{
    console.log('▸ Test 4: Confirmed (no-show) appointment → skip');
    resetStore();
    seedReferrer();
    seedReferredCustomer();

    const appt = { id: 'apt_004', customerId: 'client_b_01', salonId: 'salon_test_01', status: 'Confirmed' };
    const result = await simulateOnAppointmentStatusChange(appt);

    t(result.action === 'skip', '  action is "skip"');
    t(result.reason === 'not_completed', '  reason = not_completed');
    t(getReferralRewards().length === 0, '  no referralRewards');
    console.log('');
}

/* ── Test 5: In Progress appointment = skip ──────────────────────── */
{
    console.log('▸ Test 5: In Progress appointment → skip');
    resetStore();
    seedReferrer();
    seedReferredCustomer();

    const appt = { id: 'apt_005', customerId: 'client_b_01', salonId: 'salon_test_01', status: 'In Progress' };
    const result = await simulateOnAppointmentStatusChange(appt);

    t(result.action === 'skip', '  action is "skip"');
    t(result.reason === 'not_completed', '  reason = not_completed');
    console.log('');
}

/* ── Test 6: Duplicate processing = idempotent (still +100) ──────── */
{
    console.log('▸ Test 6: Duplicate processing → idempotent (still +100, not +200)');
    resetStore();
    seedReferrer();
    seedReferredCustomer();

    const appt = { id: 'apt_006', customerId: 'client_b_01', salonId: 'salon_test_01', status: 'Completed' };

    const result1 = await simulateOnAppointmentStatusChange(appt);
    t(result1.action === 'credited', '  first call: credited');
    t(getCustomer('client_a_01').rewardPoints === 200, '  after first call: 200 pts');

    const result2 = await simulateOnAppointmentStatusChange(appt);
    t(result2.action === 'skip', '  second call: skipped');
    t(result2.reason === 'already_rewarded', '  reason = already_rewarded (referralRewards exists)');
    t(getCustomer('client_a_01').rewardPoints === 200, '  after second call: still 200 pts (not 300)');

    const result3 = await simulateOnAppointmentStatusChange(appt);
    t(result3.action === 'skip', '  third call: still skipped');
    t(getCustomer('client_a_01').rewardPoints === 200, '  after third call: still 200 pts');

    t(getReferralRewards().length === 1, '  exactly 1 referralRewards record (no duplicates)');
    console.log('');
}

/* ── Test 7: Missing customerId = skip ───────────────────────────── */
{
    console.log('▸ Test 7: Missing customerId → skip');
    resetStore();
    seedReferrer();
    seedReferredCustomer();

    const appt = { id: 'apt_007', customerId: '', salonId: 'salon_test_01', status: 'Completed' };
    const result = await simulateOnAppointmentStatusChange(appt);

    t(result.action === 'skip', '  action is "skip"');
    t(result.reason === 'no_customer_id', '  reason = no_customer_id');
    console.log('');
}

/* ── Test 8: Customer not found in store = skip ──────────────────── */
{
    console.log('▸ Test 8: Customer not found in store → skip');
    resetStore();
    seedReferrer();

    const appt = { id: 'apt_008', customerId: 'nonexistent_client', salonId: 'salon_test_01', status: 'Completed' };
    const result = await simulateOnAppointmentStatusChange(appt);

    t(result.action === 'skip', '  action is "skip"');
    t(result.reason === 'customer_not_found', '  reason = customer_not_found');
    console.log('');
}

/* ── Test 9: Referrer not found = skip ───────────────────────────── */
{
    console.log('▸ Test 9: Referrer not found in store → skip');
    resetStore();
    seedReferredCustomer({ referredBy: 'nonexistent_referrer' });

    const appt = { id: 'apt_009', customerId: 'client_b_01', salonId: 'salon_test_01', status: 'Completed' };
    const result = await simulateOnAppointmentStatusChange(appt);

    t(result.action === 'skip', '  action is "skip"');
    t(result.reason === 'referrer_not_found', '  reason = referrer_not_found');
    console.log('');
}

/* ── Test 10: Referrer profile integrity after credit ────────────── */
{
    console.log('▸ Test 10: Referrer profile integrity preserved after credit');
    resetStore();
    seedReferrer();
    seedReferredCustomer();

    const appt = { id: 'apt_010', customerId: 'client_b_01', salonId: 'salon_test_01', status: 'Completed' };
    await simulateOnAppointmentStatusChange(appt);

    const referrer = getCustomer('client_a_01');
    t(referrer.rewardPoints === 200, '  rewardPoints = 200');
    t(referrer.name === 'Alice Referrer', '  name preserved');
    t(referrer.phone === '+919000000001', '  phone preserved');
    t(referrer.email === 'alice@test.com', '  email preserved');
    t(referrer.referralCode === 'LG-ALICE1', '  referralCode preserved');
    console.log('');
}

/* ── Test 11: referralRewards audit record has all required fields ── */
{
    console.log('▸ Test 11: referralRewards audit record contains all required fields');
    resetStore();
    seedReferrer({ id: 'ref_x', name: 'Xander Audit', salonId: 'salon_a' });
    seedReferredCustomer({
        id: 'ref_y',
        name: 'Yara Test',
        salonId: 'salon_b',
        referredBy: 'ref_x',
    });

    const appt = { id: 'apt_011', customerId: 'ref_y', salonId: 'salon_b', status: 'Completed' };
    await simulateOnAppointmentStatusChange(appt);

    const reward = getReferralRewards()[0];
    t(!!reward, '  reward record exists');
    t(reward.appointmentId === 'apt_011', '  appointmentId = apt_011');
    t(reward.salonId === 'salon_b', '  salonId = referred customer salon');
    t(reward.referrerClientId === 'ref_x', '  referrerClientId = referrer');
    t(reward.referrerClientName === 'Xander Audit', '  referrerClientName = referrer name');
    t(reward.referredClientId === 'ref_y', '  referredClientId = referred customer');
    t(reward.referredClientName === 'Yara Test', '  referredClientName = referred name');
    t(reward.points === 100, '  points = 100');
    t(reward.type === 'referral_bonus', '  type = referral_bonus');
    t(reward.status === 'credited', '  status = credited');
    t(typeof reward.createdAt === 'string' && reward.createdAt.length > 0, '  createdAt is non-empty string');
    console.log('');
}

/* ── Test 12: Cross-salon referral (referrer in different salon) ──── */
{
    console.log('▸ Test 12: Cross-salon referral (referrer in different salon) → credited');
    resetStore();
    seedReferrer({ id: 'referrer_cross', salonId: 'salon_alpha', name: 'Cross Referrer' });
    seedReferredCustomer({
        id: 'referred_cross',
        salonId: 'salon_beta',
        name: 'Cross Referred',
        referredBy: 'referrer_cross',
    });

    const appt = { id: 'apt_012', customerId: 'referred_cross', salonId: 'salon_beta', status: 'Completed' };
    const result = await simulateOnAppointmentStatusChange(appt);

    t(result.action === 'credited', '  cross-salon referral credited');
    t(result.referrerId === 'referrer_cross', '  referrer = Cross Referrer');
    t(getCustomer('referrer_cross').rewardPoints === 200, '  referrer in salon_alpha got +100 pts');

    const reward = getReferralRewards()[0];
    t(reward.referrerSalonId === 'salon_alpha', '  reward.referrerSalonId = referrer salon');
    t(reward.salonId === 'salon_beta', '  reward.salonId = referred salon');
    console.log('');
}

/* ── Test 13: Canonical referredBy field is used (not referredByCode) */
{
    console.log('▸ Test 13: Canonical referredBy field is the source of truth');
    resetStore();
    seedReferrer({ id: 'canonical_a', name: 'Canonical A' });
    seedReferredCustomer({
        id: 'canonical_b',
        name: 'Canonical B',
        referredBy: 'canonical_a',
        // referredByCode exists but referredBy is the canonical field
        referredByCode: 'LG-SOMECODE',
    });

    const appt = { id: 'apt_013', customerId: 'canonical_b', salonId: 'salon_test_01', status: 'Completed' };
    const result = await simulateOnAppointmentStatusChange(appt);

    t(result.action === 'credited', '  credited via referredBy field');
    t(result.referrerId === 'canonical_a', '  resolved referrer from referredBy (not referredByCode)');
    console.log('');
}

/* ── Test 14: Missing customerId = skip ────────────────────────────── */
{
    console.log('▸ Test 14: null appointment fields = skip');
    resetStore();
    seedReferrer();
    seedReferredCustomer();

    const result = await simulateOnAppointmentStatusChange({});
    t(result.action === 'skip', '  skips with null/empty appointment');

    const result2 = await simulateOnAppointmentStatusChange({ id: 'apt_x', status: 'Completed' });
    t(result2.action === 'skip', '  skips without customerId');
    console.log('');
}

/* ── Test 15: Multiple referrals, each idempotent ─────────────────── */
{
    console.log('▸ Test 15: Multiple different referrals each get exactly +100');
    resetStore();
    seedReferrer({ id: 'multi_a1', name: 'Referrer 1', rewardPoints: 0 });
    seedReferrer({ id: 'multi_a2', name: 'Referrer 2', rewardPoints: 0 });
    seedReferredCustomer({ id: 'multi_b1', referredBy: 'multi_a1', name: 'Referred 1' });
    seedReferredCustomer({ id: 'multi_b2', referredBy: 'multi_a2', name: 'Referred 2' });

    // Complete appointment for Referred 1
    await simulateOnAppointmentStatusChange({ id: 'apt_m1', customerId: 'multi_b1', salonId: 'salon_test_01', status: 'Completed' });
    t(getCustomer('multi_a1').rewardPoints === 100, '  Referrer 1 after Referred 1 completes: 100 pts');
    t(getCustomer('multi_a2').rewardPoints === 0, '  Referrer 2 unchanged: 0 pts');

    // Complete appointment for Referred 2
    await simulateOnAppointmentStatusChange({ id: 'apt_m2', customerId: 'multi_b2', salonId: 'salon_test_01', status: 'Completed' });
    t(getCustomer('multi_a1').rewardPoints === 100, '  Referrer 1 still 100 pts');
    t(getCustomer('multi_a2').rewardPoints === 100, '  Referrer 2 after Referred 2 completes: 100 pts');

    // Try to re-credit Referred 1 — should be skipped
    await simulateOnAppointmentStatusChange({ id: 'apt_m1', customerId: 'multi_b1', salonId: 'salon_test_01', status: 'Completed' });
    t(getCustomer('multi_a1').rewardPoints === 100, '  Referrer 1 still 100 pts (idempotent re-run)');

    t(getReferralRewards().length === 2, '  exactly 2 referralRewards records');
    console.log('');
}

/* ── Summary ─────────────────────────────────────────────────────── */
console.log('═══════════════════════════════════════════════════════════');
console.log(`  REFERRAL REWARD TESTS: ${pass} passed, ${fail} failed`);
console.log('═══════════════════════════════════════════════════════════\n');
process.exit(fail === 0 ? 0 : 1);
