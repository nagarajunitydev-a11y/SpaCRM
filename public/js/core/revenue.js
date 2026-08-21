/**
 * revenue.js
 * Single source of truth for appointment money math ("Est. Revenue").
 *
 * Business definition: Estimated Revenue is the FULL booked service amount —
 * gross, before GST/tax, before discounts/coupons, before wallet/referral/
 * loyalty redemptions, and before payment adjustments (refunds, part-payments).
 * A ₹100 booked service contributes exactly ₹100.
 *
 * Rules:
 * - Per appointment, revenue = sum of its booked service amounts:
 *     * a recorded `amount` (> 0) on the appointment record wins;
 *     * otherwise each booked service is priced from the salon catalog
 *       (`serviceName`, or `services`/`serviceNames` arrays for
 *       multi-service bookings) by case-insensitive name match;
 *     * unknown services without a recorded amount contribute ₹0 — never a
 *       fabricated placeholder.
 * - Tax, discount, couponCode, loyaltyRedemption, refund and payment fields
 *   are deliberately NOT applied here.
 * - Cancelled appointments are excluded entirely.
 * - Rows are de-duplicated by document id so a late snapshot or optimistic
 *   append can never double-count revenue.
 */

const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

const norm = (value) => String(value || '').trim().toLowerCase();

/** Catalog price for a service name (case-insensitive), ₹0 when absent. */
function catalogPrice(name, services) {
    const key = norm(name);
    if (!key) return 0;
    const service = (services || []).find((s) => norm(s && s.name) === key);
    return service ? Math.max(0, num(service.price)) : 0;
}

/**
 * Total booked service amount for one appointment. Handles single-service
 * records (`serviceName`) and multi-service records (`services` array of
 * names or {name, price} objects, or `serviceNames` array of names).
 */
export function serviceAmountFor(appointment, services = []) {
    if (!appointment) return 0;

    // Multi-service bookings: sum every booked service.
    const multi = appointment.services || appointment.serviceNames;
    if (Array.isArray(multi) && multi.length > 0) {
        return multi.reduce((sum, entry) => {
            if (entry && typeof entry === 'object') {
                // Explicit per-item price when present, else catalog lookup.
                const priced = num(entry.price);
                return sum + (priced > 0 ? priced : catalogPrice(entry.name || entry.serviceName, services));
            }
            return sum + catalogPrice(entry, services);
        }, 0);
    }

    // Single-service booking: recorded amount wins over the catalog price.
    const recorded = num(appointment.amount);
    if (recorded > 0) return recorded;
    return catalogPrice(appointment.serviceName, services);
}

/** Gross revenue contribution of a single non-cancelled appointment. */
export function netRevenueFor(appointment, services = []) {
    return Math.max(0, serviceAmountFor(appointment, services));
}

/**
 * Estimated revenue across a period-filtered set of appointments.
 * Returns `{ total, counted }` — counted excludes cancelled/duplicate rows.
 */
export function computeEstimatedRevenue(appointments, services = []) {
    const seen = new Set();
    let total = 0;
    let counted = 0;

    for (const a of appointments || []) {
        if (!a) continue;
        if (a.id !== undefined && a.id !== null) {
            if (seen.has(a.id)) continue;
            seen.add(a.id);
        }
        if (a.status === 'Cancelled') continue;
        total += netRevenueFor(a, services);
        counted += 1;
    }

    return { total, counted };
}

export default {
    serviceAmountFor,
    netRevenueFor,
    computeEstimatedRevenue,
};
