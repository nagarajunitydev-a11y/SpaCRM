/**
 * referralService.js
 * Orchestration for the referral programme.
 *
 * This is the ONLY module that moves referral money. It composes the pure
 * rules (core/referral.js, core/wallet.js) with the repositories and performs
 * every multi-document mutation inside a single atomic operation, so a
 * referral record, its wallet ledger row and the client's cached balance can
 * never drift apart.
 *
 * The complete flow it implements:
 *
 *   existing client -> unique referral code -> new client uses code
 *   -> referral Pending -> first qualifying appointment completed
 *   -> invoice paid -> referral Qualified -> reward credited (Credited)
 *   -> available in the client's wallet -> redeemed on a future invoice
 *
 * Plus the paths that undo it: refund/cancellation reversal and expiry.
 *
 * Idempotency strategy (no reward is ever paid twice):
 *   1. referral ids are derived from the referred client  -> one referrer only;
 *   2. wallet ledger ids are derived from the event       -> one posting only;
 *   3. every mutation re-reads and re-checks status inside the transaction.
 */

import { store } from '../core/store.js';
import { isDemoMode } from './firebase.js';
import { runAtomic } from './db.js';
import * as customersRepository from './customersRepository.js';
import * as referralsRepository from './referralsRepository.js';
import * as referralCodesRepository from './referralCodesRepository.js';
import * as referralSettingsRepository from './referralSettingsRepository.js';
import { serviceAmountFor } from '../core/revenue.js';
import { scopedBySalon } from '../core/utils.js';
import {
    REFERRAL_STATUS,
    normalizeCode,
    isValidCodeFormat,
    sanitizeSettings,
    computeRewardAmount,
    isQualifyingInvoice,
    isSettlingAppointment,
    computeExpiryAt,
    isExpired,
    remainingReward,
    validateRedemption,
    allocateRedemption,
    round2,
    num,
} from '../core/referral.js';
import { WALLET_TX_TYPES, walletTxId, invoiceNoFor, buildTransaction } from '../core/wallet.js';

/* ------------------------------------------------------------------ */
/* Atomic context                                                      */
/* ------------------------------------------------------------------ */

const PATHS = {
    customers: (salonId) => ['salons', salonId, 'customers'],
    referrals: (salonId) => ['salons', salonId, 'referrals'],
    wallet: (salonId) => ['salons', salonId, 'walletTransactions'],
};

/**
 * Demo-mode stand-in for a Firestore transaction. Writes are buffered and
 * flushed together at the end so a failed operation leaves no partial state,
 * mirroring the real transaction semantics the Firebase path gets for free.
 */
function demoContext() {
    const writes = [];
    const state = () => store.getState();

    return {
        salonId: state().currentSalonId,
        async getCustomer(id) {
            return (state().customersList || []).find((c) => c.id === id) || null;
        },
        async getReferral(id) {
            return (state().referralsList || []).find((r) => r.id === id) || null;
        },
        async getWalletTx(id) {
            return (state().walletTransactionsList || []).find((t) => t.id === id) || null;
        },
        setWalletTx(row) {
            writes.push(() => store.setState({
                walletTransactionsList: [...(state().walletTransactionsList || []), row],
            }));
        },
        updateReferral(id, patch) {
            writes.push(() => store.setState({
                referralsList: (state().referralsList || []).map((r) => (r.id === id ? { ...r, ...patch } : r)),
            }));
        },
        updateCustomer(id, patch) {
            writes.push(() => store.setState({
                customersList: (state().customersList || []).map((c) => (c.id === id ? { ...c, ...patch } : c)),
            }));
        },
        commit() {
            writes.forEach((apply) => apply());
        },
    };
}

/** Firestore-backed context. Firestore requires all reads before any write. */
function firebaseContext(tx, salonId) {
    return {
        salonId,
        getCustomer: (id) => tx.get(PATHS.customers(salonId), id),
        getReferral: (id) => tx.get(PATHS.referrals(salonId), id),
        getWalletTx: (id) => tx.get(PATHS.wallet(salonId), id),
        setWalletTx: (row) => {
            const { id, ...data } = row;
            tx.set(PATHS.wallet(salonId), id, data);
        },
        updateReferral: (id, patch) => tx.update(PATHS.referrals(salonId), id, patch),
        updateCustomer: (id, patch) => tx.update(PATHS.customers(salonId), id, patch),
        commit: () => {},
    };
}

/**
 * Run `work` atomically in either mode. `work` must perform every read before
 * its first write so it is valid inside a real Firestore transaction.
 */
async function atomic(work) {
    if (isDemoMode()) {
        const ctx = demoContext();
        const result = await work(ctx);
        ctx.commit();
        return result;
    }
    const salonId = store.getState().currentSalonId;
    if (!salonId) throw new Error('No salon selected.');
    return runAtomic((tx) => work(firebaseContext(tx, salonId)));
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const nowISO = () => new Date().toISOString();

/** Effective programme settings for the active salon. */
export function settings() {
    return referralSettingsRepository.getSettings();
}

/**
 * The terms a referral was created under. Snapshotted terms win so a later
 * settings change never rewrites what an existing referral promised; missing
 * fields (legacy rows) fall back to the salon's current configuration.
 */
function termsFor(referral) {
    const current = settings();
    if (!referral) return current;
    return sanitizeSettings({
        enabled: true,
        rewardType: referral.rewardType ?? current.rewardType,
        rewardValue: referral.rewardValue ?? current.rewardValue,
        maxRewardAmount: referral.maxRewardAmount ?? current.maxRewardAmount,
        minInvoiceAmount: referral.minInvoiceAmount ?? current.minInvoiceAmount,
        rewardTrigger: referral.rewardTrigger ?? current.rewardTrigger,
        expiryDays: referral.expiryDays ?? current.expiryDays,
        maxRedemptionPercent: current.maxRedemptionPercent,
    });
}

/** Gross invoice total for an appointment (recorded amount wins). */
export function invoiceAmountFor(appointment) {
    if (!appointment) return 0;
    const recorded = num(appointment.invoiceAmount);
    if (recorded > 0) return round2(recorded);
    const state = store.getState();
    const services = scopedBySalon(state.servicesList, state.currentSalonId);
    return round2(serviceAmountFor(appointment, services));
}

/** Referral wallet balance of a client (cached value, floored at zero). */
export function walletBalanceOf(customer) {
    return round2(Math.max(0, num(customer && customer.walletBalance)));
}

/* ------------------------------------------------------------------ */
/* 1. Referral codes                                                   */
/* ------------------------------------------------------------------ */

/**
 * Guarantee the client owns a referral code and that the code is mirrored on
 * the client record (so the profile can render it without a second read).
 * Idempotent and safe to call on every render path.
 */
export async function ensureReferralCode(customer) {
    if (!customer || !customer.id) return null;
    if (isValidCodeFormat(customer.referralCode)) return normalizeCode(customer.referralCode);

    const code = await referralCodesRepository.allocateCode(customer);
    if (!code) return null;
    await customersRepository.updateCustomer(customer.id, { referralCode: code });
    return code;
}

const backfilledSalons = new Set();

/**
 * Backfill codes for clients created before the programme existed. Runs at
 * most once per salon per session and is bounded, so it can never turn into a
 * write storm on a large client list.
 */
export async function backfillReferralCodes(limit = 40) {
    const salonId = store.getState().currentSalonId;
    if (!salonId || backfilledSalons.has(salonId)) return 0;
    backfilledSalons.add(salonId);

    const pending = customersRepository.listCustomers()
        .filter((c) => !isValidCodeFormat(c.referralCode))
        .slice(0, limit);

    let created = 0;
    for (const customer of pending) {
        try {
            await ensureReferralCode(customer);
            created += 1;
        } catch (err) {
            console.warn('[referral] Could not allocate a code for', customer.id, err);
        }
    }
    return created;
}

/** Resolve a typed code to the client who owns it. */
export function resolveReferrer(code) {
    const key = normalizeCode(code);
    if (!key) return null;

    const registryRow = referralCodesRepository.findByCode(key);
    if (registryRow && registryRow.active !== false) {
        const owner = customersRepository.getCustomer(registryRow.customerId);
        if (owner) return owner;
    }
    // Fallback for records whose registry row has not synced yet.
    return customersRepository.listCustomers().find((c) => normalizeCode(c.referralCode) === key) || null;
}

/* ------------------------------------------------------------------ */
/* 2. Linking a new client to a referrer                               */
/* ------------------------------------------------------------------ */

const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

/**
 * Validate a referral code for a (possibly not-yet-created) client without
 * writing anything. Returns `{ ok, referrer, error }` so both the form and the
 * write path share one rule set.
 */
export function validateReferralCode(code, referredCustomer = null) {
    const config = settings();
    if (!config.enabled) return { ok: false, referrer: null, error: 'The referral programme is currently disabled.' };

    const key = normalizeCode(code);
    if (!key) return { ok: false, referrer: null, error: 'Enter a referral code.' };
    if (!isValidCodeFormat(key)) return { ok: false, referrer: null, error: 'That referral code is not valid.' };

    const referrer = resolveReferrer(key);
    if (!referrer) return { ok: false, referrer: null, error: 'No client owns that referral code.' };

    if (referredCustomer) {
        // Self-referral: same record, or the same person re-entered under a
        // different row (identical phone or email).
        if (referrer.id === referredCustomer.id) {
            return { ok: false, referrer: null, error: 'A client cannot refer themselves.' };
        }
        const samePhone = digitsOnly(referrer.phone) && digitsOnly(referrer.phone) === digitsOnly(referredCustomer.phone);
        const sameEmail = (referrer.email || '').toLowerCase() && (referrer.email || '').toLowerCase() === (referredCustomer.email || '').toLowerCase();
        if (samePhone || sameEmail) {
            return { ok: false, referrer: null, error: 'A client cannot refer themselves.' };
        }
        if (referredCustomer.referredBy) {
            return { ok: false, referrer: null, error: 'This client already has a referrer.' };
        }
        if (referralsRepository.findByReferred(referredCustomer.id)) {
            return { ok: false, referrer: null, error: 'This client already has a referrer.' };
        }
    }

    return { ok: true, referrer, error: null };
}

/**
 * Link a newly registered client to the owner of `code` and open the referral
 * in `Pending`. The referral document id is derived from the referred client,
 * so a duplicate attempt is rejected by the database itself.
 */
export async function linkReferral(referredCustomer, code) {
    const check = validateReferralCode(code, referredCustomer);
    if (!check.ok) throw new Error(check.error);

    const config = settings();
    const referrer = check.referrer;

    const { created, row } = await referralsRepository.createReferral({
        code: normalizeCode(code),
        referrerId: referrer.id,
        referrerName: referrer.name || '',
        referredId: referredCustomer.id,
        referredName: referredCustomer.name || '',
        rewardType: config.rewardType,
        rewardValue: config.rewardValue,
        maxRewardAmount: config.maxRewardAmount,
        minInvoiceAmount: config.minInvoiceAmount,
        rewardTrigger: config.rewardTrigger,
        expiryDays: config.expiryDays,
        salonId: store.getState().currentSalonId,
    });

    if (!created) throw new Error('This client already has a referrer.');

    await customersRepository.updateCustomer(referredCustomer.id, {
        referredBy: referrer.id,
        referredByCode: normalizeCode(code),
    });

    return { referral: row, referrer };
}

/* ------------------------------------------------------------------ */
/* 3-4. Qualification and wallet credit                                */
/* ------------------------------------------------------------------ */

/**
 * Evaluate an appointment as the referred client's qualifying invoice and, if
 * it qualifies, credit the referrer's wallet — atomically and exactly once.
 *
 * Returns `{ credited, reason, amount, referral }`. `credited === false` with a
 * reason is the normal outcome for the many appointments that do not qualify;
 * it is never an error.
 */
export async function settleAppointment(appointment) {
    if (!appointment || !appointment.customerId) {
        console.log('[referral] settle: missing appointment or customerId', appointment);
        return { credited: false, reason: 'no-client' };
    }

    const referral = referralsRepository.findByReferred(appointment.customerId);
    if (!referral) {
        console.log('[referral] settle: no referral found for customer', appointment.customerId);
        return { credited: false, reason: 'no-referral' };
    }
    if (referral.status !== REFERRAL_STATUS.PENDING) {
        console.log('[referral] settle: referral not pending', { referralId: referral.id, status: referral.status });
        return { credited: false, reason: 'already-settled' };
    }

    const terms = termsFor(referral);
    if (!settings().enabled) return { credited: false, reason: 'programme-disabled' };
    if (!isSettlingAppointment(appointment, terms)) return { credited: false, reason: 'not-completed-or-paid' };

    const invoiceAmount = invoiceAmountFor(appointment);
    if (!isQualifyingInvoice(invoiceAmount, terms)) return { credited: false, reason: 'below-minimum' };

    const rewardAmount = computeRewardAmount(invoiceAmount, terms);
    if (rewardAmount <= 0) return { credited: false, reason: 'zero-reward' };

    const txId = walletTxId.credit(referral.id);
    const invoiceNo = invoiceNoFor(appointment.id);
    const at = nowISO();

    const result = await atomic(async (ctx) => {
        // ---- reads ----
        const freshReferral = await ctx.getReferral(referral.id);
        if (!freshReferral || freshReferral.status !== REFERRAL_STATUS.PENDING) {
            return { credited: false, reason: 'already-settled' };
        }
        const existingTx = await ctx.getWalletTx(txId);
        if (existingTx) return { credited: false, reason: 'already-credited' };

        const referrer = await ctx.getCustomer(freshReferral.referrerId);
        if (!referrer) return { credited: false, reason: 'referrer-missing' };

        // ---- writes ----
        const balanceBefore = walletBalanceOf(referrer);
        const balanceAfter = round2(balanceBefore + rewardAmount);

        ctx.setWalletTx(buildTransaction({
            id: txId,
            salonId: ctx.salonId,
            customerId: referrer.id,
            customerName: referrer.name || '',
            type: WALLET_TX_TYPES.REFERRAL_CREDIT,
            amount: rewardAmount,
            balanceBefore,
            referralId: freshReferral.id,
            appointmentId: appointment.id,
            invoiceNo,
            note: `Referral reward for ${freshReferral.referredName || 'a referred client'}`,
            createdAt: at,
        }));

        ctx.updateReferral(freshReferral.id, {
            status: REFERRAL_STATUS.CREDITED,
            rewardAmount,
            redeemedAmount: 0,
            reversedAmount: 0,
            expiredAmount: 0,
            qualifyingAppointmentId: appointment.id,
            qualifyingInvoiceNo: invoiceNo,
            qualifyingInvoiceAmount: invoiceAmount,
            qualifiedAt: at,
            creditedAt: at,
            expiresAt: computeExpiryAt(at, terms),
            walletTxnId: txId,
            updatedAt: at,
        });

        ctx.updateCustomer(referrer.id, { walletBalance: balanceAfter });

        return { credited: true, amount: rewardAmount, referral: freshReferral, referrerName: referrer.name || '' };
    });

    return result || { credited: false, reason: 'no-backend' };
}

/* ------------------------------------------------------------------ */
/* 5. Redemption                                                       */
/* ------------------------------------------------------------------ */

/**
 * Redeem referral wallet money against an invoice. Full or partial, capped by
 * the configured share of the invoice, never beyond the available balance and
 * never beyond the invoice total.
 *
 * The debit is allocated across the client's credited referrals oldest-first,
 * so every redeemed rupee stays traceable to the referral that earned it, and
 * the ledger row records the balance before, the amount and the balance after.
 */
export async function redeem({ customer, appointment, invoiceAmount, requestedAmount }) {
    if (!customer || !customer.id) throw new Error('A client is required to redeem referral rewards.');
    if (!appointment || !appointment.id) throw new Error('An invoice is required to redeem referral rewards.');

    const config = settings();
    const balance = walletBalanceOf(customer);
    const invoice = round2(invoiceAmount);

    const check = validateRedemption({
        requested: requestedAmount,
        walletBalance: balance,
        invoiceAmount: invoice,
        settings: config,
    });
    if (!check.ok) throw new Error(check.error);
    if (check.amount <= 0) {
        return { redeemed: 0, balanceBefore: balance, balanceAfter: balance, allocations: [] };
    }

    const pool = referralsRepository.listCreditedFor(customer.id);
    const { allocations, shortfall } = allocateRedemption(check.amount, pool);
    if (shortfall > 0) {
        throw new Error('Redemption exceeds the available referral balance.');
    }

    const invoiceNo = invoiceNoFor(appointment.id);
    const txId = walletTxId.redeem(appointment.id);
    const at = nowISO();

    const result = await atomic(async (ctx) => {
        // ---- reads ----
        const existingTx = await ctx.getWalletTx(txId);
        if (existingTx) {
            return {
                duplicate: true,
                redeemed: num(existingTx.amount),
                balanceBefore: num(existingTx.balanceBefore),
                balanceAfter: num(existingTx.balanceAfter),
                allocations: existingTx.allocations || [],
            };
        }

        const freshCustomer = await ctx.getCustomer(customer.id);
        if (!freshCustomer) throw new Error('Client not found.');

        const freshReferrals = [];
        for (const allocation of allocations) {
            const referral = await ctx.getReferral(allocation.referralId);
            if (!referral) throw new Error('A referral reward could not be verified. Please retry.');
            freshReferrals.push({ allocation, referral });
        }

        // ---- verify against the freshly read state ----
        const balanceBefore = walletBalanceOf(freshCustomer);
        const recheck = validateRedemption({
            requested: check.amount,
            walletBalance: balanceBefore,
            invoiceAmount: invoice,
            settings: config,
        });
        if (!recheck.ok) throw new Error(recheck.error);

        for (const { allocation, referral } of freshReferrals) {
            if (remainingReward(referral) < allocation.amount) {
                throw new Error('The referral balance changed. Please retry the redemption.');
            }
        }

        // ---- writes ----
        const balanceAfter = round2(balanceBefore - check.amount);

        ctx.setWalletTx(buildTransaction({
            id: txId,
            salonId: ctx.salonId,
            customerId: freshCustomer.id,
            customerName: freshCustomer.name || '',
            type: WALLET_TX_TYPES.REFERRAL_REDEEM,
            amount: check.amount,
            balanceBefore,
            referralId: allocations.length === 1 ? allocations[0].referralId : null,
            appointmentId: appointment.id,
            invoiceNo,
            allocations,
            note: `Redeemed on invoice ${invoiceNo}`,
            createdAt: at,
        }));

        for (const { allocation, referral } of freshReferrals) {
            const redeemedAmount = round2(num(referral.redeemedAmount) + allocation.amount);
            const exhausted = round2(num(referral.rewardAmount) - redeemedAmount - num(referral.reversedAmount) - num(referral.expiredAmount)) <= 0;
            ctx.updateReferral(referral.id, {
                redeemedAmount,
                status: exhausted ? REFERRAL_STATUS.REDEEMED : REFERRAL_STATUS.CREDITED,
                lastRedeemedAt: at,
                updatedAt: at,
            });
        }

        ctx.updateCustomer(freshCustomer.id, { walletBalance: balanceAfter });

        return { redeemed: check.amount, balanceBefore, balanceAfter, allocations };
    });

    return result || { redeemed: 0, balanceBefore: balance, balanceAfter: balance, allocations: [] };
}

/* ------------------------------------------------------------------ */
/* 6. Reversal (refund / cancellation) and expiry                      */
/* ------------------------------------------------------------------ */

/**
 * Claw back the reward that an appointment's invoice earned, because the
 * invoice was refunded or the appointment cancelled.
 *
 * Only the UNSPENT remainder can be removed — money already redeemed on
 * another invoice has left the wallet, so the shortfall is recorded on the
 * referral instead of driving the balance negative.
 */
export async function reverseRewardForAppointment(appointmentId, reason = 'Invoice refunded') {
    if (!appointmentId) return { reversed: false, reason: 'no-appointment' };

    const referral = referralsRepository.findByQualifyingAppointment(appointmentId);
    if (!referral) return { reversed: false, reason: 'no-referral' };
    if (referral.status !== REFERRAL_STATUS.CREDITED && referral.status !== REFERRAL_STATUS.REDEEMED) {
        return { reversed: false, reason: 'not-credited' };
    }

    const txId = walletTxId.reversal(referral.id);
    const at = nowISO();

    const result = await atomic(async (ctx) => {
        const freshReferral = await ctx.getReferral(referral.id);
        if (!freshReferral) return { reversed: false, reason: 'no-referral' };
        if (freshReferral.status !== REFERRAL_STATUS.CREDITED && freshReferral.status !== REFERRAL_STATUS.REDEEMED) {
            return { reversed: false, reason: 'not-credited' };
        }
        const existingTx = await ctx.getWalletTx(txId);
        if (existingTx) return { reversed: false, reason: 'already-reversed' };

        const referrer = await ctx.getCustomer(freshReferral.referrerId);
        if (!referrer) return { reversed: false, reason: 'referrer-missing' };

        const recoverable = remainingReward(freshReferral);
        const alreadySpent = round2(num(freshReferral.redeemedAmount));
        const balanceBefore = walletBalanceOf(referrer);
        const debit = round2(Math.min(recoverable, balanceBefore));
        const balanceAfter = round2(balanceBefore - debit);

        if (debit > 0) {
            ctx.setWalletTx(buildTransaction({
                id: txId,
                salonId: ctx.salonId,
                customerId: referrer.id,
                customerName: referrer.name || '',
                type: WALLET_TX_TYPES.REFERRAL_REVERSAL,
                amount: debit,
                balanceBefore,
                referralId: freshReferral.id,
                appointmentId,
                invoiceNo: freshReferral.qualifyingInvoiceNo || invoiceNoFor(appointmentId),
                note: reason,
                createdAt: at,
            }));
        }

        ctx.updateReferral(freshReferral.id, {
            status: REFERRAL_STATUS.REVERSED,
            reversedAmount: round2(num(freshReferral.reversedAmount) + debit),
            reversedAt: at,
            reversalReason: alreadySpent > 0
                ? `${reason} (${alreadySpent} already redeemed and not recovered)`
                : reason,
            updatedAt: at,
        });

        if (debit > 0) ctx.updateCustomer(referrer.id, { walletBalance: balanceAfter });

        return { reversed: true, amount: debit, unrecovered: alreadySpent, referrerName: referrer.name || '' };
    });

    return result || { reversed: false, reason: 'no-backend' };
}

/**
 * Return wallet money that was redeemed on an invoice which has now been
 * refunded. The client gets their referral balance back; the ledger keeps both
 * the original debit and this credit.
 */
export async function reverseRedemptionForAppointment(appointment, reason = 'Invoice refunded') {
    const redeemed = round2(num(appointment && appointment.walletRedeemed));
    if (!appointment || !appointment.id || redeemed <= 0) return { restored: 0 };

    const txId = walletTxId.redeemReversal(appointment.id);
    const invoiceNo = invoiceNoFor(appointment.id);
    const at = nowISO();

    const result = await atomic(async (ctx) => {
        const existingTx = await ctx.getWalletTx(txId);
        if (existingTx) return { restored: 0, duplicate: true };

        const originalTx = await ctx.getWalletTx(walletTxId.redeem(appointment.id));
        const customer = await ctx.getCustomer(appointment.customerId);
        if (!customer) return { restored: 0, reason: 'client-missing' };

        const allocations = (originalTx && originalTx.allocations) || [];
        const freshReferrals = [];
        for (const allocation of allocations) {
            const referral = await ctx.getReferral(allocation.referralId);
            if (referral) freshReferrals.push({ allocation, referral });
        }

        const balanceBefore = walletBalanceOf(customer);
        const balanceAfter = round2(balanceBefore + redeemed);

        ctx.setWalletTx(buildTransaction({
            id: txId,
            salonId: ctx.salonId,
            customerId: customer.id,
            customerName: customer.name || '',
            type: WALLET_TX_TYPES.REFERRAL_REDEEM_REVERSAL,
            amount: redeemed,
            balanceBefore,
            appointmentId: appointment.id,
            invoiceNo,
            allocations,
            note: reason,
            createdAt: at,
        }));

        // Put the allocated amounts back on the referrals they came from.
        for (const { allocation, referral } of freshReferrals) {
            const redeemedAmount = round2(Math.max(0, num(referral.redeemedAmount) - allocation.amount));
            const stillCredited = referral.status === REFERRAL_STATUS.REDEEMED || referral.status === REFERRAL_STATUS.CREDITED;
            ctx.updateReferral(referral.id, {
                redeemedAmount,
                status: stillCredited ? REFERRAL_STATUS.CREDITED : referral.status,
                updatedAt: at,
            });
        }

        ctx.updateCustomer(customer.id, { walletBalance: balanceAfter });
        return { restored: redeemed, balanceBefore, balanceAfter };
    });

    return result || { restored: 0 };
}

/**
 * Expire the unspent remainder of credits that have passed their window.
 * Safe to call repeatedly: an already-expired referral is skipped, and the
 * ledger id makes a second posting impossible.
 */
export async function expireDueReferrals() {
    const due = referralsRepository.listCredited().filter((r) => isExpired(r) && remainingReward(r) > 0);
    let expired = 0;

    for (const referral of due) {
        const txId = walletTxId.expiry(referral.id);
        const at = nowISO();
        try {
            const result = await atomic(async (ctx) => {
                const fresh = await ctx.getReferral(referral.id);
                if (!fresh || fresh.status !== REFERRAL_STATUS.CREDITED) return { expired: false };
                const existingTx = await ctx.getWalletTx(txId);
                if (existingTx) return { expired: false };
                const referrer = await ctx.getCustomer(fresh.referrerId);
                if (!referrer) return { expired: false };

                const remainder = remainingReward(fresh);
                if (remainder <= 0) return { expired: false };

                const balanceBefore = walletBalanceOf(referrer);
                const debit = round2(Math.min(remainder, balanceBefore));
                const balanceAfter = round2(balanceBefore - debit);

                if (debit > 0) {
                    ctx.setWalletTx(buildTransaction({
                        id: txId,
                        salonId: ctx.salonId,
                        customerId: referrer.id,
                        customerName: referrer.name || '',
                        type: WALLET_TX_TYPES.REFERRAL_EXPIRY,
                        amount: debit,
                        balanceBefore,
                        referralId: fresh.id,
                        invoiceNo: fresh.qualifyingInvoiceNo || null,
                        note: 'Referral reward expired',
                        createdAt: at,
                    }));
                }

                ctx.updateReferral(fresh.id, {
                    status: REFERRAL_STATUS.EXPIRED,
                    expiredAmount: round2(num(fresh.expiredAmount) + remainder),
                    expiredAt: at,
                    updatedAt: at,
                });

                if (debit > 0) ctx.updateCustomer(referrer.id, { walletBalance: balanceAfter });
                return { expired: true };
            });
            if (result && result.expired) expired += 1;
        } catch (err) {
            console.warn('[referral] Expiry sweep failed for', referral.id, err);
        }
    }

    return expired;
}

export default {
    settings,
    invoiceAmountFor,
    walletBalanceOf,
    ensureReferralCode,
    backfillReferralCodes,
    resolveReferrer,
    validateReferralCode,
    linkReferral,
    settleAppointment,
    redeem,
    reverseRewardForAppointment,
    reverseRedemptionForAppointment,
    expireDueReferrals,
};
