/**
 * referral.js
 * Single source of truth for ALL referral-programme business rules.
 *
 * This module is pure: it performs no I/O, touches no store and imports no
 * repository. Every decision the referral feature makes (is a code valid, does
 * an invoice qualify, how much reward is earned, how much may be redeemed,
 * when does a credit expire) is computed here so the rules can be unit-tested
 * in Node and reused identically by the services, the UI and the test-suite.
 *
 * Lifecycle of a referral (see referralService.js for the orchestration):
 *
 *   Pending    a new client signed up with a referrer's code; nothing earned
 *   Qualified  the referred client's first qualifying invoice was settled
 *   Credited   the reward was written to the referrer's wallet ledger
 *   Redeemed   the whole credited reward has been spent on invoices
 *   Expired    the unspent remainder passed the configured expiry window
 *   Reversed   the qualifying invoice was refunded/cancelled; credit clawed back
 */

/** Referral lifecycle statuses. */
export const REFERRAL_STATUS = {
    PENDING: 'Pending',
    QUALIFIED: 'Qualified',
    CREDITED: 'Credited',
    REDEEMED: 'Redeemed',
    EXPIRED: 'Expired',
    REVERSED: 'Reversed',
};

/** Ordered list used by the owner filter chips. */
export const REFERRAL_STATUS_ORDER = [
    REFERRAL_STATUS.PENDING,
    REFERRAL_STATUS.QUALIFIED,
    REFERRAL_STATUS.CREDITED,
    REFERRAL_STATUS.REDEEMED,
    REFERRAL_STATUS.EXPIRED,
    REFERRAL_STATUS.REVERSED,
];

/** Tailwind classes per status (the view reads these; no logic in the view). */
export const REFERRAL_STATUS_CLASSES = {
    [REFERRAL_STATUS.PENDING]: 'bg-slate-500/15 text-slate-300',
    [REFERRAL_STATUS.QUALIFIED]: 'bg-blue-500/15 text-blue-400',
    [REFERRAL_STATUS.CREDITED]: 'bg-emerald-500/15 text-emerald-400',
    [REFERRAL_STATUS.REDEEMED]: 'bg-indigo-500/15 text-indigo-400',
    [REFERRAL_STATUS.EXPIRED]: 'bg-amber-500/15 text-amber-400',
    [REFERRAL_STATUS.REVERSED]: 'bg-rose-500/15 text-rose-400',
};

/** Reward shapes the owner can configure. */
export const REWARD_TYPES = { FIXED: 'fixed', PERCENT: 'percent' };

/**
 * When the reward becomes payable.
 *  invoice_paid          - appointment Completed AND the invoice is settled
 *  appointment_completed - appointment Completed (payment not required)
 */
export const REWARD_TRIGGERS = {
    INVOICE_PAID: 'invoice_paid',
    APPOINTMENT_COMPLETED: 'appointment_completed',
};

export const REWARD_TRIGGER_LABELS = {
    [REWARD_TRIGGERS.INVOICE_PAID]: 'First appointment completed & invoice paid',
    [REWARD_TRIGGERS.APPOINTMENT_COMPLETED]: 'First appointment completed',
};

/** Programme defaults applied when a salon has never saved settings. */
export const DEFAULT_REFERRAL_SETTINGS = Object.freeze({
    enabled: true,
    rewardType: REWARD_TYPES.FIXED,
    rewardValue: 100,
    maxRewardAmount: 0, // 0 = uncapped (only meaningful for percentage rewards)
    minInvoiceAmount: 500,
    rewardTrigger: REWARD_TRIGGERS.INVOICE_PAID,
    expiryDays: 90, // 0 = never expires
    maxRedemptionPercent: 50,
});

/** Referral codes are 8 characters from an unambiguous alphabet. */
export const CODE_LENGTH = 8;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, zero, one
export const CODE_RE = new RegExp('^[' + CODE_ALPHABET + ']{' + CODE_LENGTH + '}$');

/* ------------------------------------------------------------------ */
/* Money helpers                                                       */
/* ------------------------------------------------------------------ */

/** Coerce anything to a finite number (0 otherwise). */
export function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/** Round to paise. Money is never stored with float dust. */
export function round2(value) {
    return Math.round((num(value) + Number.EPSILON) * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Referral codes                                                      */
/* ------------------------------------------------------------------ */

/** Uppercase + strip everything that is not part of the code alphabet. */
export function normalizeCode(value) {
    return String(value == null ? '' : value)
        .toUpperCase()
        .split('')
        .filter((ch) => CODE_ALPHABET.includes(ch))
        .join('');
}

/** True when the value is a syntactically valid referral code. */
export function isValidCodeFormat(value) {
    return CODE_RE.test(normalizeCode(value));
}

function randomChar(rng) {
    return CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
}

/**
 * Build a unique referral code. The first characters are seeded from the
 * client's name so the code stays recognisable, the remainder is random.
 * `taken` is any Set/array of codes already used inside the salon; generation
 * retries until it finds a free one, then falls back to a fully random code so
 * it can never loop forever.
 */
export function generateReferralCode(name, taken = [], rng = Math.random) {
    const takenSet = taken instanceof Set ? taken : new Set((taken || []).map(normalizeCode));
    const seed = normalizeCode(name).slice(0, 4);

    for (let attempt = 0; attempt < 40; attempt += 1) {
        const prefix = attempt < 20 ? seed : '';
        let code = prefix;
        while (code.length < CODE_LENGTH) code += randomChar(rng);
        code = code.slice(0, CODE_LENGTH);
        if (!takenSet.has(code)) return code;
    }

    let code = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) code += randomChar(rng);
    return code;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/**
 * Coerce a raw (possibly partial, possibly hostile) settings object into a
 * complete, in-range settings record. Every consumer reads settings through
 * this function, so an out-of-range value can never reach the reward maths.
 */
export function sanitizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const rewardType = src.rewardType === REWARD_TYPES.PERCENT ? REWARD_TYPES.PERCENT : REWARD_TYPES.FIXED;
    const rewardTrigger = src.rewardTrigger === REWARD_TRIGGERS.APPOINTMENT_COMPLETED
        ? REWARD_TRIGGERS.APPOINTMENT_COMPLETED
        : REWARD_TRIGGERS.INVOICE_PAID;

    return {
        enabled: src.enabled !== false,
        rewardType,
        rewardValue: rewardType === REWARD_TYPES.PERCENT
            ? clampNumber(src.rewardValue, 0, 100, DEFAULT_REFERRAL_SETTINGS.rewardValue)
            : clampNumber(src.rewardValue, 0, 1000000, DEFAULT_REFERRAL_SETTINGS.rewardValue),
        maxRewardAmount: clampNumber(src.maxRewardAmount, 0, 1000000, DEFAULT_REFERRAL_SETTINGS.maxRewardAmount),
        minInvoiceAmount: clampNumber(src.minInvoiceAmount, 0, 1000000, DEFAULT_REFERRAL_SETTINGS.minInvoiceAmount),
        rewardTrigger,
        expiryDays: Math.round(clampNumber(src.expiryDays, 0, 3650, DEFAULT_REFERRAL_SETTINGS.expiryDays)),
        maxRedemptionPercent: clampNumber(src.maxRedemptionPercent, 0, 100, DEFAULT_REFERRAL_SETTINGS.maxRedemptionPercent),
    };
}

/* ------------------------------------------------------------------ */
/* Qualification and reward maths                                      */
/* ------------------------------------------------------------------ */

/** True when an invoice total clears the configured minimum. */
export function isQualifyingInvoice(invoiceAmount, settings) {
    const s = sanitizeSettings(settings);
    const invoice = round2(invoiceAmount);
    return invoice > 0 && invoice >= s.minInvoiceAmount;
}

/**
 * Reward earned for a qualifying invoice. Percentage rewards honour the
 * optional cap. Returns 0 for a non-qualifying invoice, so a caller can never
 * accidentally credit an unqualified referral.
 */
export function computeRewardAmount(invoiceAmount, settings) {
    const s = sanitizeSettings(settings);
    if (!s.enabled) return 0;
    if (!isQualifyingInvoice(invoiceAmount, s)) return 0;

    let reward = s.rewardType === REWARD_TYPES.PERCENT
        ? (round2(invoiceAmount) * s.rewardValue) / 100
        : s.rewardValue;

    if (s.maxRewardAmount > 0) reward = Math.min(reward, s.maxRewardAmount);
    return round2(Math.max(0, reward));
}

/**
 * Whether an appointment settles the referral, given the configured trigger.
 * Cancelled appointments and refunded/unpaid invoices never qualify.
 */
export function isSettlingAppointment(appointment, settings) {
    const s = sanitizeSettings(settings);
    const a = appointment || {};
    if (a.status === 'Cancelled') return false;
    if (a.refunded === true) return false;
    if (a.status !== 'Completed') return false;
    if (s.rewardTrigger === REWARD_TRIGGERS.INVOICE_PAID && a.paid !== true) return false;
    return true;
}

/** ISO expiry timestamp for a credit, or null when expiry is disabled. */
export function computeExpiryAt(creditedAtISO, settings) {
    const s = sanitizeSettings(settings);
    if (!s.expiryDays) return null;
    const base = creditedAtISO ? new Date(creditedAtISO) : new Date();
    if (Number.isNaN(base.getTime())) return null;
    return new Date(base.getTime() + s.expiryDays * 24 * 60 * 60 * 1000).toISOString();
}

/** True when a credited referral's unspent remainder is past its expiry. */
export function isExpired(referral, nowISO = new Date().toISOString()) {
    if (!referral || referral.status !== REFERRAL_STATUS.CREDITED) return false;
    if (!referral.expiresAt) return false;
    return String(referral.expiresAt) <= String(nowISO);
}

/** Unspent reward still attached to a referral. */
export function remainingReward(referral) {
    const r = referral || {};
    if (r.status !== REFERRAL_STATUS.CREDITED && r.status !== REFERRAL_STATUS.REDEEMED) return 0;
    const remaining = num(r.rewardAmount)
        - num(r.redeemedAmount)
        - num(r.reversedAmount)
        - num(r.expiredAmount);
    return round2(Math.max(0, remaining));
}

/* ------------------------------------------------------------------ */
/* Redemption                                                          */
/* ------------------------------------------------------------------ */

/**
 * Largest amount that may be taken off THIS invoice: never more than the
 * wallet holds, never more than the invoice itself, and never more than the
 * configured share of the invoice.
 */
export function maxRedeemable({ walletBalance, invoiceAmount, settings }) {
    const s = sanitizeSettings(settings);
    const balance = Math.max(0, round2(walletBalance));
    const invoice = Math.max(0, round2(invoiceAmount));
    const capByPercent = round2((invoice * s.maxRedemptionPercent) / 100);
    return round2(Math.max(0, Math.min(balance, invoice, capByPercent)));
}

/**
 * Validate a requested redemption. Returns `{ ok, amount, error }` - `amount`
 * is the exact value that may be debited (never silently inflated).
 */
export function validateRedemption({ requested, walletBalance, invoiceAmount, settings }) {
    const s = sanitizeSettings(settings);
    const cap = maxRedeemable({ walletBalance, invoiceAmount, settings: s });

    if (requested === '' || requested === null || requested === undefined) {
        return { ok: true, amount: 0, error: null };
    }
    if (!Number.isFinite(Number(requested))) {
        return { ok: false, amount: 0, error: 'Enter a valid redemption amount.' };
    }

    const amount = round2(requested);
    if (amount < 0) return { ok: false, amount: 0, error: 'Redemption cannot be negative.' };
    if (amount === 0) return { ok: true, amount: 0, error: null };
    if (round2(walletBalance) <= 0) return { ok: false, amount: 0, error: 'No referral balance available.' };
    if (amount > round2(walletBalance)) return { ok: false, amount: 0, error: 'Redemption exceeds the available referral balance.' };
    if (amount > round2(invoiceAmount)) return { ok: false, amount: 0, error: 'Redemption cannot exceed the invoice amount.' };
    if (amount > cap) {
        return {
            ok: false,
            amount: 0,
            error: 'Only ' + s.maxRedemptionPercent + '% of an invoice can be paid from the referral wallet.',
        };
    }
    return { ok: true, amount, error: null };
}

/**
 * Split a redemption across the referrer's credited referrals, oldest first,
 * so every rupee spent stays traceable to the referral that earned it.
 * Returns `{ allocations: [{ referralId, amount }], allocated, shortfall }`.
 */
export function allocateRedemption(amount, credited) {
    let left = round2(amount);
    const allocations = [];

    const pool = (credited || [])
        .filter((r) => remainingReward(r) > 0)
        .sort((a, b) => String(a.creditedAt || a.createdAt || '').localeCompare(String(b.creditedAt || b.createdAt || '')));

    for (const referral of pool) {
        if (left <= 0) break;
        const take = round2(Math.min(remainingReward(referral), left));
        if (take <= 0) continue;
        allocations.push({ referralId: referral.id, amount: take });
        left = round2(left - take);
    }

    return { allocations, allocated: round2(round2(amount) - left), shortfall: round2(Math.max(0, left)) };
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

/** Counts per status plus reward totals, for the owner summary panel. */
export function summarizeReferrals(referrals) {
    const rows = referrals || [];
    const byStatus = {};
    REFERRAL_STATUS_ORDER.forEach((s) => { byStatus[s] = 0; });

    let rewardCredited = 0;
    let rewardRedeemed = 0;
    let rewardOutstanding = 0;

    for (const r of rows) {
        if (byStatus[r.status] !== undefined) byStatus[r.status] += 1;
        if (r.status === REFERRAL_STATUS.CREDITED || r.status === REFERRAL_STATUS.REDEEMED) {
            rewardCredited += num(r.rewardAmount);
            rewardRedeemed += num(r.redeemedAmount);
            rewardOutstanding += remainingReward(r);
        }
    }

    const successful = byStatus[REFERRAL_STATUS.CREDITED] + byStatus[REFERRAL_STATUS.REDEEMED];
    const total = rows.length;

    return {
        total,
        byStatus,
        successful,
        pending: byStatus[REFERRAL_STATUS.PENDING] + byStatus[REFERRAL_STATUS.QUALIFIED],
        rewardCredited: round2(rewardCredited),
        rewardRedeemed: round2(rewardRedeemed),
        rewardOutstanding: round2(rewardOutstanding),
        conversionRate: total > 0 ? Math.round((successful / total) * 100) : 0,
    };
}

/** Per-client referral figures shown on the customer profile. */
export function customerReferralStats(customerId, referrals) {
    const mine = (referrals || []).filter((r) => r.referrerId === customerId);
    const summary = summarizeReferrals(mine);
    return {
        referrals: mine,
        total: summary.total,
        successful: summary.successful,
        pending: summary.pending,
        rewardsEarned: summary.rewardCredited,
        rewardsRedeemed: summary.rewardRedeemed,
        availableBalance: summary.rewardOutstanding,
    };
}

export default {
    REFERRAL_STATUS,
    REFERRAL_STATUS_ORDER,
    REFERRAL_STATUS_CLASSES,
    REWARD_TYPES,
    REWARD_TRIGGERS,
    REWARD_TRIGGER_LABELS,
    DEFAULT_REFERRAL_SETTINGS,
    CODE_LENGTH,
    CODE_RE,
    num,
    round2,
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
};
