/**
 * plans.js
 * Subscription plan catalog: prices, limits and feature entitlements.
 *
 * This is the built-in default catalog. The live catalog is the Firestore
 * `plans/{planId}` collection (editable by a super admin); whenever a plan
 * document is absent the entry below is used, so a fresh project works with
 * no seeding. The same module is imported by the payment API so the amount
 * charged is always computed server-side from trusted data, never from the
 * client.
 *
 * Pure data + helpers — no I/O, no browser globals.
 */

/** Every gate-able capability. `label` is shown on locked-feature screens. */
export const FEATURES = {
    // Basic
    appointments: 'Appointments',
    services: 'Services',
    customerHistory: 'Customer history',
    billing: 'Billing & payments',
    expenses: 'Expenses & daily tally',
    attendance: 'Staff attendance',
    basicReports: 'Basic reports',
    // Standard
    onlineBooking: 'Online booking',
    bookingLink: 'WhatsApp booking link / QR',
    referral: 'Referral program',
    loyalty: 'Loyalty rewards',
    customerDiscounts: 'Customer discounts',
    inventory: 'Inventory',
    standardReports: 'Standard reports',
    advancedDashboard: 'Advanced dashboard',
    marketingTools: 'Marketing tools',
    // Premium
    advancedInventory: 'Advanced inventory',
    birthdayCampaigns: 'Birthday campaigns',
    reactivation: 'Customer reactivation',
    campaigns: 'Campaign management',
    aiGrowth: 'AI marketing & growth tools',
    advancedAnalytics: 'Advanced analytics',
    apiAccess: 'API & integrations',
    prioritySupport: 'Priority support',
    // Business
    multiBranch: 'Multiple branches',
    branchReports: 'Branch-wise reports',
    rolesPermissions: 'Advanced roles & permissions',
    dedicatedSupport: 'Dedicated support',
    enterpriseIntegrations: 'Enterprise integrations',
};

const BASIC = ['appointments', 'services', 'customerHistory', 'billing', 'expenses', 'attendance', 'basicReports'];
const STANDARD = [...BASIC, 'onlineBooking', 'bookingLink', 'referral', 'loyalty', 'customerDiscounts', 'inventory', 'standardReports', 'advancedDashboard', 'marketingTools'];
const PREMIUM = [...STANDARD, 'advancedInventory', 'birthdayCampaigns', 'reactivation', 'campaigns', 'aiGrowth', 'advancedAnalytics', 'apiAccess', 'prioritySupport'];
const BUSINESS = [...PREMIUM, 'multiBranch', 'branchReports', 'rolesPermissions', 'dedicatedSupport', 'enterpriseIntegrations'];

/** `null` limit = unlimited. Prices are whole rupees. */
export const DEFAULT_PLANS = {
    trial: {
        id: 'trial', name: 'Free Trial', tagline: '30 days, no credit card', order: 0, paid: false,
        priceMonthly: 0, priceAnnual: 0, maxStaff: 10, maxCustomers: 1500, maxBranches: 1,
        features: STANDARD,
    },
    basic: {
        id: 'basic', name: 'Basic', tagline: 'For solo and small salons', order: 1, paid: true,
        priceMonthly: 399, priceAnnual: 3990, maxStaff: 2, maxCustomers: 100, maxBranches: 1,
        features: BASIC,
    },
    standard: {
        id: 'standard', name: 'Standard', tagline: 'Grow with online booking & loyalty', order: 2, paid: true, popular: true,
        priceMonthly: 799, priceAnnual: 7990, maxStaff: 10, maxCustomers: 1500, maxBranches: 1,
        features: STANDARD,
    },
    premium: {
        id: 'premium', name: 'Premium', tagline: 'Campaigns, analytics & priority support', order: 3, paid: true,
        priceMonthly: 1499, priceAnnual: 14990, maxStaff: 15, maxCustomers: 5000, maxBranches: 1,
        features: PREMIUM,
    },
    business: {
        id: 'business', name: 'Business', tagline: 'Multiple branches, unlimited team', order: 4, paid: true,
        priceMonthly: 2999, priceAnnual: 29990, maxStaff: null, maxCustomers: null, maxBranches: 10,
        features: BUSINESS,
    },
};

export const PLAN_IDS = Object.keys(DEFAULT_PLANS);
export const PAID_PLAN_IDS = PLAN_IDS.filter((id) => DEFAULT_PLANS[id].paid);
export const BILLING_CYCLES = ['monthly', 'annual'];
export const TRIAL_DAYS = 30;
/** Days of continued access after a paid period ends without renewal. */
export const GRACE_DAYS = 3;

/** Valid `userTaxAddress.administrativeArea` values for India (Google Play Developer API; used for in-app GST reporting). */
export const INDIA_TAX_STATES = [
    'ANDAMAN AND NICOBAR ISLANDS', 'ANDHRA PRADESH', 'ARUNACHAL PRADESH', 'ASSAM', 'BIHAR', 'CHANDIGARH',
    'CHHATTISGARH', 'DADRA AND NAGAR HAVELI AND DAMAN AND DIU', 'DELHI', 'GOA', 'GUJARAT', 'HARYANA',
    'HIMACHAL PRADESH', 'JAMMU AND KASHMIR', 'JHARKHAND', 'KARNATAKA', 'KERALA', 'LADAKH', 'LAKSHADWEEP',
    'MADHYA PRADESH', 'MAHARASHTRA', 'MANIPUR', 'MEGHALAYA', 'MIZORAM', 'NAGALAND', 'ODISHA', 'PUDUCHERRY',
    'PUNJAB', 'RAJASTHAN', 'SIKKIM', 'TAMIL NADU', 'TELANGANA', 'TRIPURA', 'UTTAR PRADESH', 'UTTARAKHAND',
    'WEST BENGAL',
];


/** Merge Firestore overrides (rows from `plans`) over the defaults. */
export function mergePlans(rows) {
    const merged = {};
    PLAN_IDS.forEach((id) => { merged[id] = { ...DEFAULT_PLANS[id] }; });
    (rows || []).forEach((row) => {
        if (!row || !merged[row.id]) return;
        const base = merged[row.id];
        merged[row.id] = {
            ...base,
            ...pickPlanFields(row),
            id: base.id,
            paid: base.paid,
            features: Array.isArray(row.features) ? row.features.filter((f) => f in FEATURES) : base.features,
        };
    });
    return merged;
}

function pickPlanFields(row) {
    const out = {};
    ['name', 'tagline'].forEach((k) => { if (typeof row[k] === 'string' && row[k]) out[k] = row[k]; });
    ['priceMonthly', 'priceAnnual'].forEach((k) => { if (Number.isFinite(row[k]) && row[k] >= 0) out[k] = Math.round(row[k]); });
    ['maxStaff', 'maxCustomers', 'maxBranches'].forEach((k) => {
        if (row[k] === null) out[k] = null;
        else if (Number.isFinite(row[k]) && row[k] >= 0) out[k] = Math.floor(row[k]);
    });
    return out;
}

export function planPrice(plan, cycle) {
    if (!plan) return 0;
    return cycle === 'annual' ? plan.priceAnnual : plan.priceMonthly;
}

/** Rupees saved by paying annually instead of 12 monthly payments. */
export function annualSavings(plan) {
    return Math.max(0, plan.priceMonthly * 12 - plan.priceAnnual);
}

/** Cheapest paid plan that includes `feature`, or null. */
export function requiredPlanFor(feature, plans = DEFAULT_PLANS) {
    return Object.values(plans)
        .filter((p) => p.paid && p.features.includes(feature))
        .sort((a, b) => a.order - b.order)[0] || null;
}

export function formatINR(rupees) {
    return `₹${Number(rupees || 0).toLocaleString('en-IN')}`;
}

export default { FEATURES, DEFAULT_PLANS, mergePlans, planPrice, annualSavings, requiredPlanFor };
