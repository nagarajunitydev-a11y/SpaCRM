/**
 * unit-revenue.mjs
 * Node unit tests for the shared revenue calculation (core/revenue.js).
 *
 * Business rule under test: Estimated Revenue is the FULL booked service
 * amount — gross, before GST/tax, discounts, wallet/referral/loyalty
 * redemptions and payment adjustments. A ₹100 booked service contributes
 * exactly ₹100.
 *
 * Verifies against real record shapes: the demo seed documents (identical
 * schema to Firestore) plus synthetic multi-appointment / multi-service
 * scenarios covering cancellations, duplicates and payment fields that must
 * NOT affect the estimate.
 *
 * Usage: node scripts/unit-revenue.mjs
 */

import { computeEstimatedRevenue, netRevenueFor, serviceAmountFor } from '../public/js/core/revenue.js';
import { appointmentSeed, serviceSeed } from '../public/js/services/seedData.js';

let pass = 0;
let fail = 0;

function t(cond, label) {
    if (cond) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; console.log('  FAIL  ' + label); }
}

const close = (a, b) => Math.abs(a - b) < 1e-9;

// ---- 1. Seed records (actual document shapes) ------------------------------
{
    const { total, counted } = computeEstimatedRevenue(appointmentSeed, serviceSeed);
    // a1: Completed booking of "Balayage & Gloss" recorded at ₹160 (tax etc.
    // on the record must be ignored — gross service amount only).
    t(close(total, 160), `seed appointment a1 -> ₹160 gross (tax/discount ignored), got ${total}`);
    t(counted === 1, 'seed: one counted appointment');
}

// ---- 2. A ₹100 booked service contributes exactly ₹100 ---------------------
{
    const booking = { id: 'r100', serviceName: 'Hair Spa', status: 'Completed', amount: 100 };
    t(serviceAmountFor(booking, []) === 100, '₹100 booked service -> ₹100');
    t(close(netRevenueFor(booking, []), 100), 'net contribution of ₹100 booking is ₹100');

    // Even with every payment adjustment present, still ₹100.
    const adjusted = { ...booking, discount: 10, couponCode: 'SAVE', loyaltyRedemption: 5, tax: 18, refund: 20, paid: true, paymentMethod: 'upi' };
    t(close(netRevenueFor(adjusted, []), 100), 'GST/discount/loyalty/refund do NOT reduce Est. Revenue');
}

// ---- 3. Multiple appointments across multiple services ---------------------
{
    const appts = [
        { id: 'x1', serviceName: 'Balayage & Gloss', status: 'Completed', amount: 160 },
        { id: 'x2', serviceName: 'Signature Facial', status: 'Completed', amount: 95 },
        { id: 'x3', serviceName: 'Precision Haircut', status: 'Completed', amount: 75 },
    ];
    const { total } = computeEstimatedRevenue(appts, serviceSeed);
    t(close(total, 330), `three booked services sum to ₹330, got ${total}`);
}

// ---- 4. Cancelled appointments are excluded --------------------------------
{
    const appts = [
        { id: 'c1', serviceName: 'Balayage & Gloss', status: 'Completed', amount: 160 },
        { id: 'c2', serviceName: 'Signature Facial', status: 'Cancelled', amount: 95 },
        { id: 'c3', serviceName: 'Precision Haircut', status: 'Cancelled' },
    ];
    const { total, counted } = computeEstimatedRevenue(appts, serviceSeed);
    t(close(total, 160) && counted === 1, `cancelled bookings excluded (₹160 / 1 counted), got ${total} / ${counted}`);
}

// ---- 5. Catalog fallback when booking has no recorded amount ---------------
{
    // New-style booking (payment fields stripped since 8b487a3): no amount.
    const fresh = { id: 'f1', customerName: 'Jessica Alba', serviceName: 'Signature Facial', staffName: 'Chloe', date: '2026-08-21', time: '14:30', status: 'Confirmed' };
    t(serviceAmountFor(fresh, serviceSeed) === 95, 'missing amount falls back to catalog price (₹95)');
    const { total } = computeEstimatedRevenue([fresh], serviceSeed);
    t(close(total, 95), `fresh booking estimates from catalog price, got ${total}`);

    // Recorded amount always wins over the catalog price.
    const overridden = { ...fresh, amount: 120 };
    t(serviceAmountFor(overridden, serviceSeed) === 120, 'recorded amount takes precedence over catalog price');

    // Case-insensitive service name match.
    const sloppy = { id: 'f2', serviceName: 'signature facial', status: 'Confirmed' };
    t(serviceAmountFor(sloppy, serviceSeed) === 95, 'service name matched case-insensitively');

    // Unknown service with no amount contributes nothing (never fabricated).
    const unknown = { id: 'f3', serviceName: 'Ghost Ritual', status: 'Confirmed' };
    t(serviceAmountFor(unknown, serviceSeed) === 0, 'unknown service without amount estimates ₹0');
}

// ---- 6. Multiple services in a single appointment --------------------------
{
    // Array of {name, price} objects.
    const priced = { id: 'm1', status: 'Completed', services: [{ name: 'A', price: 100 }, { name: 'B', price: 40 }] };
    t(serviceAmountFor(priced, serviceSeed) === 140, 'multi-service appointment sums item prices (100 + 40)');

    // Array of names resolved through the catalog.
    const named = { id: 'm2', status: 'Completed', services: ['Signature Facial', 'Precision Haircut'] };
    t(serviceAmountFor(named, serviceSeed) === 170, 'multi-service appointment resolves names via catalog (95 + 75)');

    // serviceNames variant.
    const variant = { id: 'm3', status: 'Completed', serviceNames: ['Balayage & Gloss'] };
    t(serviceAmountFor(variant, serviceSeed) === 160, 'serviceNames array supported (160)');

    // Mixed explicit + catalog-priced items.
    const mixed = { id: 'm4', status: 'Completed', services: [{ name: 'A', price: 50 }, 'Precision Haircut'] };
    t(serviceAmountFor(mixed, serviceSeed) === 125, 'mixed items sum correctly (50 + 75)');
}

// ---- 7. Duplicate counting is prevented ------------------------------------
{
    const row = { id: 'dup', serviceName: 'Balayage & Gloss', status: 'Completed', amount: 160 };
    const { total, counted } = computeEstimatedRevenue([row, { ...row }, { ...row }], serviceSeed);
    t(close(total, 160) && counted === 1, `duplicate ids counted once (₹160 / 1), got ${total} / ${counted}`);
}

// ---- 8. Malformed data cannot produce negative or NaN totals ---------------
{
    t(close(netRevenueFor({ id: 'n1', status: 'Completed', amount: -50 }, serviceSeed), 0), 'negative recorded amount treated as absent -> catalog lookup');
    t(close(netRevenueFor({ id: 'n2', status: 'Completed', amount: 'abc' }, serviceSeed), 0), 'non-numeric amount treated as 0');
    t(close(netRevenueFor(null, serviceSeed), 0), 'null appointment contributes 0');
    const empty = computeEstimatedRevenue([], serviceSeed);
    t(empty.total === 0 && empty.counted === 0, 'empty period -> ₹0 / 0 counted');
    const noServices = computeEstimatedRevenue([{ id: 'z', serviceName: 'X', status: 'Completed' }], []);
    t(noServices.total === 0, 'no catalog + no amount -> ₹0');
}

// ---- 9. Full mixed-period scenario (dashboard-style) -----------------------
{
    const appts = [
        { id: 'g1', serviceName: 'Balayage & Gloss', status: 'Completed', amount: 160, discount: 10, loyaltyRedemption: 5, tax: 28.8, paid: true, paymentMethod: 'cash' },
        { id: 'g2', serviceName: 'Signature Facial', status: 'Completed', amount: 95, refund: 20, paid: true, paymentMethod: 'upi' },
        { id: 'g3', serviceName: 'Precision Haircut', status: 'In Progress' }, // catalog fallback 75
        { id: 'g4', serviceName: 'Signature Facial', status: 'Cancelled', amount: 95 },
        { id: 'g1', serviceName: 'Balayage & Gloss', status: 'Completed', amount: 160 }, // duplicate snapshot
        { id: 'g5', serviceName: 'Unknown Service', status: 'Completed' }, // no amount, not in catalog
        { id: 'g6', status: 'Confirmed', services: [{ name: 'A', price: 100 }] }, // multi-service ₹100
    ];
    // g1: 160 | g2: 95 | g3: 75 | g6: 100  (adjustments & cancelled & dupes ignored)
    const { total, counted } = computeEstimatedRevenue(appts, serviceSeed);
    t(close(total, 430), `mixed scenario total ₹430, got ${total}`);
    t(counted === 5, `mixed scenario counts 5 valid appointments, got ${counted}`);
}

console.log(`\nUNIT REVENUE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
