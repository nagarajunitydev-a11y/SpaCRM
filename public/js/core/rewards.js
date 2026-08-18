/**
 * rewards.js
 * Reward tiers configuration and helpers.
 */

/** Reward tiers (points required -> label). Ordered ascending by points. */
export const REWARD_TIERS = [
    { points: 100, label: '₹25 Service Voucher' },
    { points: 250, label: '₹60 Service Voucher' },
    { points: 500, label: '₹125 Premium Voucher' },
];

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

export default {
    REWARD_TIERS,
    nextTierFor,
    progressFor,
};
