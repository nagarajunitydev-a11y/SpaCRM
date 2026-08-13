/**
 * rewards.js
 * Referral rewards program configuration and helpers.
 *
 * Reward tiers are configurable here and drive the referral bonus UI.
 */

export const REFERRAL_SIGNUP_BONUS = 100;

/** Reward tiers (points required -> label). Ordered ascending by points. */
export const REWARD_TIERS = [
    { points: 100, label: '₹25 Service Voucher' },
    { points: 250, label: '₹60 Service Voucher' },
    { points: 500, label: '₹125 Premium Voucher' },
];

/** Fallback code prefix for pre-existing customers without a referral code. */
const CODE_PREFIX = 'LG';

/** Generate a fresh, human-friendly referral code. */
export function generateReferralCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i += 1) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return `${CODE_PREFIX}-${code}`;
}

/**
 * Return a stable referral code for a customer row: their stored code if
 * present, otherwise a deterministic code derived from their id.
 */
export function referralCodeFor(customer) {
    if (customer && customer.referralCode) return customer.referralCode;
    if (!customer) return '';
    const base = String(customer.id || '').replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase();
    return `${CODE_PREFIX}-${base || 'GUEST'}`;
}

/** The next achievable tier at-or-above a points total (or null when maxed). */
export function nextTierFor(points) {
    return REWARD_TIERS.find((t) => points < t.points) || null;
}

/** Progress (0-100) toward the tier currently being accumulated to. */
export function progressFor(points) {
    const next = nextTierFor(points);
    if (!next) return 100;
    const prev = [...REWARD_TIERS].reverse().find((t) => t.points <= points) || { points: 0 };
    const span = next.points - prev.points;
    return Math.min(100, Math.round(((points - prev.points) / span) * 100));
}

/** Human message shared to referred friends, including their code. */
export function buildReferralMessage(customer) {
    const code = referralCodeFor(customer);
    const name = (customer && customer.name) || 'a client';
    return `Get rewards at LuxeGlow Salon & Spa! You were referred by ${name}. Book your visit and mention referral code ${code} to earn points on your next appointment.`;
}

export default {
    REWARD_TIERS,
    REFERRAL_SIGNUP_BONUS,
    generateReferralCode,
    referralCodeFor,
    nextTierFor,
    progressFor,
    buildReferralMessage,
};