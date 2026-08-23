/**
 * unit-referral.mjs
 * Node unit tests for the referral programme rules (core/referral.js) and the
 * wallet ledger maths (core/wallet.js).
 *
 * These two modules decide every rupee the feature moves: whether an invoice
 * qualifies, how much reward is earned, how much may be redeemed, how a
 * redemption is allocated across referrals, and what a ledger row looks like.
 * The service layer only sequences them, so this suite is where the money
 * rules are actually proven.
 *
 * Usage: node scripts/unit-referral.mjs
 */

import {
    REFERRAL_STATUS,
    REWARD_TYPES,
    REWARD_TRIGGERS,
    DEFAULT_REFERRAL_SETTINGS,
    normalizeCode,
    isValidCodeFormat,
    generateReferralCode,
    sanitizeSettings,
    isQualifyingInvoice,
    computeRewardAmount,
    isSettlingAppointment,
    computeExpiryAt,
    isExpired,
    remainingReward,
    maxRedeemable,
    validateRedemption,
    allocateRedemption,
    summarizeReferrals,
    customerReferralStats,
    round2,
} from '../public/js/core/referral.js';

import {
    WALLET_TX_TYPES,
    isCreditType,
    signedAmount,
    computeBalance,
    walletTxId,
    buildTransaction,
    invoiceNoFor,
    splitPayment,
} from '../public/js/core/wallet.js';

let pass = 0;
let fail = 0;

function t(cond, label) {
    if (cond) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; console.log('  FAIL  ' + label); }
}

const close = (a, b) => Math.abs(a - b) < 1e-9;

/* ---------------- 1. Referral codes ---------------- */
console.log('\n[1] Referral codes');
t(normalizeCode('  priy-4k7m ') === 'PRY4K7M', 'normalize uppercases and drops out-of-alphabet chars');
t(normalizeCode(null) === '' && normalizeCode(undefined) === '', 'null/undefined normalize to empty');
t(isValidCodeFormat('PRIY4K7M') === false, 'code containing I (ambiguous) is rejected');
t(isValidCodeFormat('PRYA4K7M') === true, '8-char code from the alphabet is valid');
t(isValidCodeFormat('PRYA4K7') === false, 'short code rejected');
t(isValidCodeFormat('PRYA4K7MM') === false, 'long code rejected');
t(isValidCodeFormat('') === false, 'empty code rejected');

{
    // A deterministic rng makes collisions certain, proving the retry path.
    let calls = 0;
    const rng = () => { calls += 1; return 0; }; // always picks 'A'
    // 'Priya' normalises to PRYA - the ambiguous I is dropped from the alphabet.
    const first = generateReferralCode('Priya', [], rng);
    t(first.length === 8 && isValidCodeFormat(first), 'generated code is well-formed');
    t(first.startsWith('PRYA'), 'code is seeded from the client name');
    const second = generateReferralCode('Priya', [first], rng);
    t(second !== first, 'a taken code is never handed out twice');
    t(calls > 0, 'generator consumed the injected rng');
}

{
    const codes = new Set();
    for (let i = 0; i < 300; i += 1) codes.add(generateReferralCode('Test Client', codes));
    t(codes.size === 300, '300 sequential allocations are all unique');
}

/* ---------------- 2. Settings ---------------- */
console.log('\n[2] Settings sanitization');
{
    const d = sanitizeSettings(null);
    t(d.rewardType === DEFAULT_REFERRAL_SETTINGS.rewardType && d.rewardValue === 100, 'null settings fall back to defaults');
    t(sanitizeSettings({ enabled: false }).enabled === false, 'programme can be disabled');
    t(sanitizeSettings({}).enabled === true, 'programme is enabled by default');
    t(sanitizeSettings({ rewardType: 'percent', rewardValue: 150 }).rewardValue === 100, 'percentage reward clamped to 100');
    t(sanitizeSettings({ rewardValue: -50 }).rewardValue === 0, 'negative reward clamped to 0');
    t(sanitizeSettings({ maxRedemptionPercent: 400 }).maxRedemptionPercent === 100, 'redemption cap clamped to 100%');
    t(sanitizeSettings({ maxRedemptionPercent: -5 }).maxRedemptionPercent === 0, 'negative redemption cap clamped to 0');
    t(sanitizeSettings({ expiryDays: 99999 }).expiryDays === 3650, 'expiry clamped to 10 years');
    t(sanitizeSettings({ expiryDays: 'abc' }).expiryDays === 90, 'non-numeric expiry falls back to the default');
    t(sanitizeSettings({ rewardTrigger: 'nonsense' }).rewardTrigger === REWARD_TRIGGERS.INVOICE_PAID, 'unknown trigger falls back to invoice_paid');
    t(sanitizeSettings({ rewardType: 'nonsense' }).rewardType === REWARD_TYPES.FIXED, 'unknown reward type falls back to fixed');
}

/* ---------------- 3. Qualification ---------------- */
console.log('\n[3] Qualifying invoices');
{
    const s = sanitizeSettings({ minInvoiceAmount: 500 });
    t(isQualifyingInvoice(500, s) === true, 'invoice exactly at the minimum qualifies');
    t(isQualifyingInvoice(499.99, s) === false, 'invoice one paisa below the minimum does not qualify');
    t(isQualifyingInvoice(0, s) === false, 'zero invoice never qualifies');
    t(isQualifyingInvoice(-100, s) === false, 'negative invoice never qualifies');
    t(isQualifyingInvoice(5000, sanitizeSettings({ minInvoiceAmount: 0 })) === true, 'no minimum means any positive invoice qualifies');
}

/* ---------------- 4. Reward amount ---------------- */
console.log('\n[4] Reward computation');
{
    const fixed = sanitizeSettings({ rewardType: 'fixed', rewardValue: 100, minInvoiceAmount: 500 });
    t(computeRewardAmount(1000, fixed) === 100, 'fixed reward pays the flat value');
    t(computeRewardAmount(400, fixed) === 0, 'below-minimum invoice earns nothing');

    const percent = sanitizeSettings({ rewardType: 'percent', rewardValue: 10, minInvoiceAmount: 500 });
    t(computeRewardAmount(1000, percent) === 100, '10% of 1000 is 100');
    t(close(computeRewardAmount(1234.56, percent), 123.46), 'percentage reward is rounded to paise');

    const capped = sanitizeSettings({ rewardType: 'percent', rewardValue: 10, maxRewardAmount: 50, minInvoiceAmount: 0 });
    t(computeRewardAmount(1000, capped) === 50, 'percentage reward honours the cap');

    const disabled = sanitizeSettings({ enabled: false, rewardValue: 100, minInvoiceAmount: 0 });
    t(computeRewardAmount(1000, disabled) === 0, 'a disabled programme never earns a reward');
}

/* ---------------- 5. Settlement trigger ---------------- */
console.log('\n[5] Settlement trigger');
{
    const paidTrigger = sanitizeSettings({ rewardTrigger: REWARD_TRIGGERS.INVOICE_PAID });
    const completedTrigger = sanitizeSettings({ rewardTrigger: REWARD_TRIGGERS.APPOINTMENT_COMPLETED });

    t(isSettlingAppointment({ status: 'Completed', paid: true }, paidTrigger) === true, 'completed + paid settles');
    t(isSettlingAppointment({ status: 'Completed', paid: false }, paidTrigger) === false, 'completed but unpaid does NOT settle');
    t(isSettlingAppointment({ status: 'Confirmed', paid: true }, paidTrigger) === false, 'paid but not completed does NOT settle');
    t(isSettlingAppointment({ status: 'Cancelled', paid: true }, paidTrigger) === false, 'cancelled never settles');
    t(isSettlingAppointment({ status: 'Completed', paid: true, refunded: true }, paidTrigger) === false, 'refunded invoice never settles');
    t(isSettlingAppointment({ status: 'Completed', paid: false }, completedTrigger) === true, 'completion alone settles under the completed trigger');
    t(isSettlingAppointment({ status: 'Cancelled', paid: false }, completedTrigger) === false, 'cancelled never settles under either trigger');
    t(isSettlingAppointment(null, paidTrigger) === false, 'missing appointment never settles');
}

/* ---------------- 6. Expiry ---------------- */
console.log('\n[6] Expiry');
{
    const s = sanitizeSettings({ expiryDays: 30 });
    const at = '2026-01-01T00:00:00.000Z';
    const expiry = computeExpiryAt(at, s);
    t(expiry.slice(0, 10) === '2026-01-31', '30-day expiry lands 30 days later');
    t(computeExpiryAt(at, sanitizeSettings({ expiryDays: 0 })) === null, 'zero expiry days means never expires');

    const credited = { status: REFERRAL_STATUS.CREDITED, expiresAt: expiry, rewardAmount: 100 };
    t(isExpired(credited, '2026-02-01T00:00:00.000Z') === true, 'credit past its window is expired');
    t(isExpired(credited, '2026-01-15T00:00:00.000Z') === false, 'credit inside its window is not expired');
    t(isExpired({ ...credited, expiresAt: null }, '2030-01-01T00:00:00.000Z') === false, 'a credit with no expiry never expires');
    t(isExpired({ ...credited, status: REFERRAL_STATUS.REDEEMED }, '2026-02-01T00:00:00.000Z') === false, 'already-redeemed referrals are not expired');
}

/* ---------------- 7. Remaining reward ---------------- */
console.log('\n[7] Remaining reward');
{
    const base = { status: REFERRAL_STATUS.CREDITED, rewardAmount: 100 };
    t(remainingReward(base) === 100, 'untouched credit has its full value');
    t(remainingReward({ ...base, redeemedAmount: 40 }) === 60, 'redeemed amount reduces the remainder');
    t(remainingReward({ ...base, redeemedAmount: 40, reversedAmount: 60 }) === 0, 'reversal consumes the rest');
    t(remainingReward({ ...base, redeemedAmount: 200 }) === 0, 'remainder never goes negative');
    t(remainingReward({ ...base, status: REFERRAL_STATUS.PENDING }) === 0, 'a pending referral holds no money');
    t(remainingReward({ ...base, status: REFERRAL_STATUS.REVERSED }) === 0, 'a reversed referral holds no money');
    t(remainingReward(null) === 0, 'null referral holds no money');
}

/* ---------------- 8. Redemption limits ---------------- */
console.log('\n[8] Redemption limits');
{
    const s = sanitizeSettings({ maxRedemptionPercent: 50 });
    t(maxRedeemable({ walletBalance: 500, invoiceAmount: 1000, settings: s }) === 500, 'balance below the cap is fully redeemable');
    t(maxRedeemable({ walletBalance: 900, invoiceAmount: 1000, settings: s }) === 500, 'the 50% invoice cap wins over a larger balance');
    t(maxRedeemable({ walletBalance: 900, invoiceAmount: 200, settings: s }) === 100, 'the cap follows the invoice, not the balance');
    t(maxRedeemable({ walletBalance: 0, invoiceAmount: 1000, settings: s }) === 0, 'empty wallet redeems nothing');
    t(maxRedeemable({ walletBalance: -50, invoiceAmount: 1000, settings: s }) === 0, 'negative balance redeems nothing');
    t(maxRedeemable({ walletBalance: 900, invoiceAmount: 1000, settings: sanitizeSettings({ maxRedemptionPercent: 100 }) }) === 900, '100% cap allows a full-wallet redemption');

    const v = (requested, walletBalance = 500, invoiceAmount = 1000) =>
        validateRedemption({ requested, walletBalance, invoiceAmount, settings: s });

    t(v(200).ok === true && v(200).amount === 200, 'partial redemption inside every limit is accepted');
    t(v(500).ok === true && v(500).amount === 500, 'full-balance redemption at the cap is accepted');
    t(v(0).ok === true && v(0).amount === 0, 'redeeming nothing is valid');
    t(v('').ok === true && v('').amount === 0, 'an empty field means no redemption');
    t(v(-10).ok === false, 'negative redemption rejected');
    t(v('abc').ok === false, 'non-numeric redemption rejected');
    t(v(600).ok === false, 'redemption beyond the balance rejected');
    t(v(400, 400, 300).ok === false, 'redemption beyond the invoice rejected');
    t(v(400, 900, 500).ok === false, 'redemption beyond the percentage cap rejected');
    t(/50%/.test(v(400, 900, 500).error), 'percentage-cap error names the configured limit');
    t(v(100, 0, 1000).ok === false, 'redemption from an empty wallet rejected');
}

/* ---------------- 9. Redemption allocation ---------------- */
console.log('\n[9] Redemption allocation (traceability)');
{
    const credited = [
        { id: 'r2', status: REFERRAL_STATUS.CREDITED, rewardAmount: 100, redeemedAmount: 0, creditedAt: '2026-02-01' },
        { id: 'r1', status: REFERRAL_STATUS.CREDITED, rewardAmount: 50, redeemedAmount: 0, creditedAt: '2026-01-01' },
        { id: 'r3', status: REFERRAL_STATUS.REVERSED, rewardAmount: 80, redeemedAmount: 0, creditedAt: '2026-01-15' },
    ];

    const partial = allocateRedemption(30, credited);
    t(partial.allocations.length === 1 && partial.allocations[0].referralId === 'r1', 'oldest credit is spent first');
    t(partial.allocated === 30 && partial.shortfall === 0, 'partial allocation is exact');

    const spanning = allocateRedemption(120, credited);
    t(spanning.allocations.length === 2, 'a large redemption spans several referrals');
    t(spanning.allocations[0].amount === 50 && spanning.allocations[1].amount === 70, 'each referral contributes only what it holds');
    t(spanning.allocations.every((a) => a.referralId !== 'r3'), 'reversed referrals are never drawn from');

    const over = allocateRedemption(500, credited);
    t(over.shortfall === 350 && over.allocated === 150, 'a redemption beyond the pool reports the shortfall');
    t(allocateRedemption(10, []).shortfall === 10, 'an empty pool allocates nothing');
}

/* ---------------- 10. Reporting ---------------- */
console.log('\n[10] Reporting');
{
    const referrals = [
        { id: 'a', referrerId: 'c1', status: REFERRAL_STATUS.PENDING },
        { id: 'b', referrerId: 'c1', status: REFERRAL_STATUS.CREDITED, rewardAmount: 100, redeemedAmount: 40 },
        { id: 'c', referrerId: 'c1', status: REFERRAL_STATUS.REDEEMED, rewardAmount: 50, redeemedAmount: 50 },
        { id: 'd', referrerId: 'c2', status: REFERRAL_STATUS.REVERSED, rewardAmount: 100, reversedAmount: 100 },
        { id: 'e', referrerId: 'c1', status: REFERRAL_STATUS.EXPIRED, rewardAmount: 70, expiredAmount: 70 },
    ];

    const s = summarizeReferrals(referrals);
    t(s.total === 5, 'summary counts every referral');
    t(s.byStatus[REFERRAL_STATUS.PENDING] === 1 && s.byStatus[REFERRAL_STATUS.REVERSED] === 1, 'summary counts each status');
    t(s.successful === 2, 'successful = credited + redeemed');
    t(s.rewardCredited === 150, 'credited total covers live rewards only');
    t(s.rewardRedeemed === 90, 'redeemed total sums the spent amounts');
    t(s.rewardOutstanding === 60, 'outstanding is the unspent remainder');
    t(s.conversionRate === 40, 'conversion rate is successful/total as a percentage');
    t(summarizeReferrals([]).conversionRate === 0, 'empty list has a 0% conversion rate');

    const c1 = customerReferralStats('c1', referrals);
    t(c1.total === 4, 'client stats only count that client\'s referrals');
    t(c1.successful === 2 && c1.pending === 1, 'client stats split successful and pending');
    t(c1.rewardsEarned === 150 && c1.rewardsRedeemed === 90, 'client stats report earned and redeemed');
    t(c1.availableBalance === 60, 'client available balance is the unspent remainder');
    t(customerReferralStats('nobody', referrals).total === 0, 'a client with no referrals reports zeros');
}

/* ---------------- 11. Wallet ledger ---------------- */
console.log('\n[11] Wallet ledger');
{
    t(isCreditType(WALLET_TX_TYPES.REFERRAL_CREDIT) === true, 'a reward credit adds to the wallet');
    t(isCreditType(WALLET_TX_TYPES.REFERRAL_REDEEM) === false, 'a redemption debits the wallet');
    t(isCreditType(WALLET_TX_TYPES.REFERRAL_REVERSAL) === false, 'a reversal debits the wallet');
    t(isCreditType(WALLET_TX_TYPES.REFERRAL_EXPIRY) === false, 'an expiry debits the wallet');
    t(isCreditType(WALLET_TX_TYPES.REFERRAL_REDEEM_REVERSAL) === true, 'a returned redemption credits the wallet');

    t(signedAmount({ type: WALLET_TX_TYPES.REFERRAL_CREDIT, amount: 100 }) === 100, 'credit is signed positive');
    t(signedAmount({ type: WALLET_TX_TYPES.REFERRAL_REDEEM, amount: 100 }) === -100, 'debit is signed negative');
    t(signedAmount({ type: WALLET_TX_TYPES.REFERRAL_REDEEM, amount: -100 }) === -100, 'a stored negative amount cannot flip a debit into a credit');

    const ledger = [
        { customerId: 'c1', type: WALLET_TX_TYPES.REFERRAL_CREDIT, amount: 100 },
        { customerId: 'c1', type: WALLET_TX_TYPES.REFERRAL_CREDIT, amount: 50 },
        { customerId: 'c1', type: WALLET_TX_TYPES.REFERRAL_REDEEM, amount: 60 },
        { customerId: 'c2', type: WALLET_TX_TYPES.REFERRAL_CREDIT, amount: 999 },
    ];
    t(computeBalance(ledger, 'c1') === 90, 'balance re-derives from the ledger per client');
    t(computeBalance(ledger) === 1089, 'balance across all clients sums every row');
    t(computeBalance([]) === 0, 'an empty ledger balances at zero');
}

console.log('\n[12] Ledger row construction');
{
    const credit = buildTransaction({
        id: 'wtx_1',
        salonId: 's1',
        customerId: 'c1',
        customerName: 'Priya',
        type: WALLET_TX_TYPES.REFERRAL_CREDIT,
        amount: 100,
        balanceBefore: 20,
        referralId: 'ref_x',
    });
    t(credit.balanceBefore === 20 && credit.balanceAfter === 120, 'credit records balance before and after');
    t(credit.direction === 'credit' && credit.source === 'REFERRAL', 'credit row is tagged as referral money');

    const debit = buildTransaction({
        id: 'wtx_2',
        customerId: 'c1',
        type: WALLET_TX_TYPES.REFERRAL_REDEEM,
        amount: 45.5,
        balanceBefore: 120,
    });
    t(debit.balanceBefore === 120 && debit.balanceAfter === 74.5, 'debit records balance before and after');
    t(debit.amount === 45.5 && debit.direction === 'debit', 'debit stores a positive magnitude with a direction');

    const negative = buildTransaction({
        id: 'wtx_3',
        customerId: 'c1',
        type: WALLET_TX_TYPES.REFERRAL_REDEEM,
        amount: -30,
        balanceBefore: 50,
    });
    t(negative.amount === 30 && negative.balanceAfter === 20, 'a negative input is normalised to a magnitude + direction');
}

console.log('\n[13] Idempotency keys');
{
    t(walletTxId.credit('ref_abc') === walletTxId.credit('ref_abc'), 'the credit id for a referral is stable');
    t(walletTxId.credit('ref_a') !== walletTxId.credit('ref_b'), 'different referrals get different credit ids');
    t(walletTxId.redeem('appt1') !== walletTxId.credit('appt1'), 'redeem and credit ids never collide');
    t(walletTxId.reversal('r') !== walletTxId.expiry('r'), 'reversal and expiry ids never collide');
    t(walletTxId.redeemReversal('a1') !== walletTxId.redeem('a1'), 'a returned redemption has its own id');
    t(invoiceNoFor('abc123') === 'INV-ABC123', 'invoice number derives from the appointment id');
    t(invoiceNoFor('') === '', 'no appointment means no invoice number');
}

/* ---------------- 14. Split payment ---------------- */
console.log('\n[14] Split payment');
{
    const split = splitPayment({ invoiceAmount: 1000, walletRedeemed: 300 });
    t(split.amountDue === 700 && split.walletRedeemed === 300, 'wallet + cash split adds up to the invoice');
    t(split.isSplit === true && split.isFullyWallet === false, 'a partial redemption is a split payment');

    const full = splitPayment({ invoiceAmount: 500, walletRedeemed: 500 });
    t(full.amountDue === 0 && full.isFullyWallet === true, 'a full-wallet invoice leaves nothing due');

    const none = splitPayment({ invoiceAmount: 500, walletRedeemed: 0 });
    t(none.amountDue === 500 && none.isSplit === false, 'no redemption means the whole invoice is due');

    const over = splitPayment({ invoiceAmount: 500, walletRedeemed: 900 });
    t(over.walletRedeemed === 500 && over.amountDue === 0, 'wallet can never exceed the invoice');

    const negative = splitPayment({ invoiceAmount: 500, walletRedeemed: -100 });
    t(negative.walletRedeemed === 0 && negative.amountDue === 500, 'a negative redemption is treated as none');
}

/* ---------------- 15. Money rounding ---------------- */
console.log('\n[15] Money rounding');
{
    t(round2(0.1 + 0.2) === 0.3, 'float dust is rounded away');
    t(round2(123.456) === 123.46, 'rounds to paise');
    t(round2('abc') === 0, 'non-numeric rounds to zero');
    t(round2(null) === 0, 'null rounds to zero');
}

console.log(`\nUNIT REFERRAL: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
