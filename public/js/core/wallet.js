/**
 * wallet.js
 * Pure ledger maths for the client REFERRAL wallet (rupee value).
 *
 * The referral wallet is deliberately separate from the loyalty scheme:
 * loyalty is measured in `rewardPoints` and audited in `rewardTransactions`,
 * the referral wallet is measured in rupees and audited in the per-salon
 * `walletTransactions` ledger. Keeping them apart means a referral rupee is
 * always traceable back to the referral that earned it and can never be
 * confused with a loyalty point.
 *
 * Every ledger row is immutable and carries `balanceBefore` / `balanceAfter`,
 * so the running balance can always be re-derived and audited.
 */

import { round2, num } from './referral.js';

/** Ledger sources. Referral rows are tagged so they stay filterable. */
export const WALLET_SOURCES = { REFERRAL: 'REFERRAL' };

/** Ledger entry types. Credits are positive, debits negative. */
export const WALLET_TX_TYPES = {
    /** Referral reward credited after a qualifying invoice. */
    REFERRAL_CREDIT: 'REFERRAL_CREDIT',
    /** Wallet money spent on an invoice. */
    REFERRAL_REDEEM: 'REFERRAL_REDEEM',
    /** Credit clawed back because the qualifying invoice was refunded/cancelled. */
    REFERRAL_REVERSAL: 'REFERRAL_REVERSAL',
    /** Unspent credit removed after the expiry window. */
    REFERRAL_EXPIRY: 'REFERRAL_EXPIRY',
    /** Redemption returned to the wallet when its invoice was refunded. */
    REFERRAL_REDEEM_REVERSAL: 'REFERRAL_REDEEM_REVERSAL',
};

/** Human labels for the transaction history UI. */
export const WALLET_TX_LABELS = {
    [WALLET_TX_TYPES.REFERRAL_CREDIT]: 'Referral reward credited',
    [WALLET_TX_TYPES.REFERRAL_REDEEM]: 'Redeemed on invoice',
    [WALLET_TX_TYPES.REFERRAL_REVERSAL]: 'Reward reversed (refund/cancellation)',
    [WALLET_TX_TYPES.REFERRAL_EXPIRY]: 'Reward expired',
    [WALLET_TX_TYPES.REFERRAL_REDEEM_REVERSAL]: 'Redemption returned (invoice refunded)',
};

/** Types that increase the balance. */
const CREDIT_TYPES = new Set([
    WALLET_TX_TYPES.REFERRAL_CREDIT,
    WALLET_TX_TYPES.REFERRAL_REDEEM_REVERSAL,
]);

/** True when a transaction type adds to the wallet. */
export function isCreditType(type) {
    return CREDIT_TYPES.has(type);
}

/** Signed delta a transaction applies to the balance. */
export function signedAmount(tx) {
    const amount = Math.abs(round2(tx && tx.amount));
    return isCreditType(tx && tx.type) ? amount : -amount;
}

/**
 * Re-derive a balance from the ledger. Used by the audit/self-check paths so a
 * denormalised `customer.walletBalance` can always be verified against the
 * immutable history.
 */
export function computeBalance(transactions, customerId = null) {
    const rows = (transactions || []).filter((tx) => !customerId || tx.customerId === customerId);
    return round2(rows.reduce((sum, tx) => sum + signedAmount(tx), 0));
}

/** Deterministic, collision-free ledger ids: the same event never posts twice. */
export const walletTxId = {
    credit: (referralId) => `wtx_credit_${referralId}`,
    reversal: (referralId) => `wtx_reversal_${referralId}`,
    expiry: (referralId) => `wtx_expiry_${referralId}`,
    redeem: (invoiceRef) => `wtx_redeem_${invoiceRef}`,
    redeemReversal: (invoiceRef) => `wtx_redeem_rev_${invoiceRef}`,
};

/**
 * Build an immutable ledger row. `balanceBefore` / `balanceAfter` are recorded
 * on every row so a redemption always states the wallet balance before it, the
 * amount taken, and the balance left after.
 */
export function buildTransaction({
    id,
    salonId,
    customerId,
    customerName,
    type,
    amount,
    balanceBefore,
    referralId = null,
    appointmentId = null,
    invoiceNo = null,
    allocations = [],
    note = '',
    createdAt = new Date().toISOString(),
}) {
    const magnitude = Math.abs(round2(amount));
    const before = round2(balanceBefore);
    const delta = isCreditType(type) ? magnitude : -magnitude;

    return {
        id,
        salonId: salonId || null,
        customerId,
        customerName: customerName || '',
        source: WALLET_SOURCES.REFERRAL,
        type,
        amount: magnitude,
        direction: isCreditType(type) ? 'credit' : 'debit',
        balanceBefore: before,
        balanceAfter: round2(before + delta),
        referralId,
        appointmentId,
        invoiceNo,
        allocations: allocations || [],
        note: note || WALLET_TX_LABELS[type] || '',
        createdAt,
    };
}

/** Invoice reference derived from an appointment id (the invoice identity). */
export function invoiceNoFor(appointmentId) {
    return appointmentId ? `INV-${String(appointmentId).toUpperCase()}` : '';
}

/**
 * Split of an invoice between a client discount, wallet money and the
 * cash/UPI/card leg. The discount is applied first (it reduces what the
 * wallet can be redeemed against), so `amountDue` is never negative even
 * when a discount and a full wallet redemption are combined.
 */
export function splitPayment({ invoiceAmount, walletRedeemed, discount = 0 }) {
    const invoice = Math.max(0, round2(invoiceAmount));
    const appliedDiscount = Math.max(0, Math.min(invoice, round2(discount)));
    const afterDiscount = round2(invoice - appliedDiscount);
    const wallet = Math.max(0, Math.min(afterDiscount, round2(walletRedeemed)));
    return {
        invoiceAmount: invoice,
        discount: appliedDiscount,
        walletRedeemed: wallet,
        amountDue: round2(afterDiscount - wallet),
        isSplit: wallet > 0 && round2(afterDiscount - wallet) > 0,
        isFullyWallet: wallet > 0 && round2(afterDiscount - wallet) === 0,
    };
}

/** Sum of `num` over a field - small helper shared by the reporting views. */
export function sumBy(rows, field) {
    return round2((rows || []).reduce((sum, row) => sum + num(row && row[field]), 0));
}

export default {
    WALLET_SOURCES,
    WALLET_TX_TYPES,
    WALLET_TX_LABELS,
    isCreditType,
    signedAmount,
    computeBalance,
    walletTxId,
    buildTransaction,
    invoiceNoFor,
    splitPayment,
    sumBy,
};
