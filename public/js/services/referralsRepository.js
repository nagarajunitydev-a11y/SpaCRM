/**
 * referralsRepository.js
 * The referral records themselves: `salons/{salonId}/referrals/{referralId}`.
 *
 * The document id is derived from the REFERRED client (`ref_<referredId>`),
 * which is what makes "only one referrer per new client" a database guarantee
 * rather than an application convention: a second referral for the same client
 * simply cannot be created.
 *
 * This module is a thin data-access layer. All lifecycle decisions live in
 * core/referral.js (rules) and referralService.js (orchestration).
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { listenCollection, createIfAbsent } from './db.js';
import { REFERRAL_STATUS, normalizeCode } from '../core/referral.js';

export const COLLECTION = 'referrals';

let unsub = null;
let subscribedId = null;

/** Deterministic referral id — one referral per referred client, forever. */
export function referralIdFor(referredCustomerId) {
    return `ref_${referredCustomerId}`;
}

/** Referrals belonging to the active salon. */
export function listReferrals() {
    return store.getState().referralsList || [];
}

function setReferrals(rows) {
    const byId = new Map();
    (rows || []).forEach((row) => {
        if (row && row.id) byId.set(row.id, row);
    });
    store.setState({
        referralsList: [...byId.values()],
        referralsLoaded: true,
        referralsError: null,
    });
}

/** (Re)point the referrals listener at a salon. */
export function setSalon(salonId) {
    if (salonId === subscribedId && unsub) return;
    if (unsub) {
        unsub();
        unsub = null;
    }
    subscribedId = salonId;

    if (isDemoMode()) {
        store.setState({ referralsLoaded: true });
        return;
    }
    if (!salonId || !store.getState().currentUser) {
        store.setState({ referralsList: [], referralsLoaded: !!salonId, referralsError: null });
        return;
    }
    unsub = listenCollection(
        ['salons', salonId, COLLECTION],
        (rows) => setReferrals(rows),
        (err) => store.setState({
            referralsList: [],
            referralsLoaded: true,
            referralsError: (err && err.message) || 'Failed to load referrals.',
        }),
    );
}

/** The referral attached to a referred client, if any. */
export function findByReferred(referredCustomerId) {
    if (!referredCustomerId) return null;
    return listReferrals().find((r) => r.referredId === referredCustomerId) || null;
}

/** Every referral a client has made. */
export function listByReferrer(referrerCustomerId) {
    if (!referrerCustomerId) return [];
    return listReferrals().filter((r) => r.referrerId === referrerCustomerId);
}

/** Credited referrals with unspent balance, oldest first (redemption pool). */
export function listCreditedFor(referrerCustomerId) {
    return listByReferrer(referrerCustomerId)
        .filter((r) => r.status === REFERRAL_STATUS.CREDITED || r.status === REFERRAL_STATUS.REDEEMED);
}

/** Referrals whose reward came from a given appointment/invoice. */
export function findByQualifyingAppointment(appointmentId) {
    if (!appointmentId) return null;
    return listReferrals().find((r) => r.qualifyingAppointmentId === appointmentId) || null;
}

/** Referrals holding a live credit (used by the expiry sweep). */
export function listCredited() {
    return listReferrals().filter((r) => r.status === REFERRAL_STATUS.CREDITED);
}

/**
 * Create a referral, but only when the referred client has none. Returns
 * `{ created, row }`; `created === false` means a referrer was already linked.
 */
export async function createReferral(payload) {
    const salonId = store.getState().currentSalonId || payload.salonId || null;
    const id = referralIdFor(payload.referredId);
    const row = {
        salonId,
        code: normalizeCode(payload.code),
        referrerId: payload.referrerId,
        referrerName: payload.referrerName || '',
        referredId: payload.referredId,
        referredName: payload.referredName || '',
        status: REFERRAL_STATUS.PENDING,
        // Terms are snapshotted at link time so a later settings change can
        // never retroactively alter what a client was promised.
        rewardType: payload.rewardType,
        rewardValue: payload.rewardValue,
        minInvoiceAmount: payload.minInvoiceAmount,
        maxRewardAmount: payload.maxRewardAmount,
        rewardTrigger: payload.rewardTrigger,
        expiryDays: payload.expiryDays,
        rewardAmount: 0,
        redeemedAmount: 0,
        reversedAmount: 0,
        expiredAmount: 0,
        qualifyingAppointmentId: null,
        qualifyingInvoiceNo: null,
        qualifyingInvoiceAmount: 0,
        qualifiedAt: null,
        creditedAt: null,
        expiresAt: null,
        reversedAt: null,
        reversalReason: null,
        walletTxnId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };

    if (isDemoMode()) {
        const existing = listReferrals().find((r) => r.id === id);
        if (existing) return { created: false, row: existing };
        setReferrals([...listReferrals(), { id, ...row }]);
        return { created: true, row: { id, ...row } };
    }

    if (!salonId) throw new Error('No salon selected.');
    return createIfAbsent(['salons', salonId, COLLECTION], id, row);
}

export default {
    COLLECTION,
    referralIdFor,
    setSalon,
    listReferrals,
    findByReferred,
    listByReferrer,
    listCreditedFor,
    findByQualifyingAppointment,
    listCredited,
    createReferral,
};
