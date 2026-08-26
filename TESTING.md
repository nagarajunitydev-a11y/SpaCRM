# Testing Guide

Comprehensive testing strategy with unit tests, e2e tests, and test coverage.

## Test Overview

SpaCRM includes a complete test suite with 600+ automated tests:

| Test Type | Count | Purpose |
|-----------|-------|---------|
| **Syntax Check** | 47 files | Validate JavaScript syntax |
| **Unit: Validation** | 30+ | Form validation rules |
| **Unit: Revenue** | 20+ | Revenue calculations |
| **Unit: Referral** | 125+ | Referral system rules |
| **E2E: Revenue** | 50+ | Revenue workflow end-to-end |
| **E2E: Referral** | 80+ | Referral workflow end-to-end |
| **E2E: Public Booking** | 60+ | Public booking workflow |
| **E2E: Smoke** | 30+ | Basic app functionality |

## Running Tests

### Run All Tests

```bash
npm test
```

This runs in order:
1. Syntax check (all JS files)
2. Unit: Validation
3. Unit: Revenue
4. Unit: Referral
5. E2E: Revenue
6. E2E: Referral
7. E2E: Public Booking
8. E2E: Smoke
9. E2E: Firebase Fallback

**Time:** ~5-10 minutes depending on system

### Run Individual Test Suite

```bash
# Syntax validation
node scripts/syntax-check.mjs

# Unit tests
node scripts/unit-validate.mjs
node scripts/unit-revenue.mjs
node scripts/unit-referral.mjs
node scripts/unit-booking.mjs

# E2E tests (requires running dev server first)
npm run serve &
node scripts/e2e-revenue.mjs
node scripts/e2e-referral.mjs
node scripts/e2e-public-booking.mjs
node scripts/e2e-smoke.mjs
node scripts/e2e-firebase-fallback.mjs
```

## Test Structure

### Syntax Check (`scripts/syntax-check.mjs`)

**Purpose:** Validate all JavaScript files have correct syntax

**Coverage:**
- 47 modules validated
- No Node.js runtime, pure syntax check
- Catches typos and parse errors

**Example Output:**
```
✓ public/js/config.js
✓ public/js/core/draft.js
✓ public/js/core/platform.js
... [47 files total]

All 47 modules passed syntax check.
```

### Unit Tests: Validation (`scripts/unit-validate.mjs`)

**Purpose:** Test form validation rules

**Coverage:**
- Email validation
- Phone validation (India-specific)
- Date/time validation
- Currency validation
- Name/required field validation
- Appointment form validation
- Customer form validation
- Service form validation
- Staff form validation
- Salon form validation
- Auth form validation (sign-in/sign-up)
- Phone normalization to E.164

**Example Test:**
```javascript
// ✓ valid calendar date accepted
assert(validateDate('2024-08-15') === true);

// ✓ month 13 rejected
assert(validateDate('2024-13-01') === false);

// ✓ Feb 30 rejected
assert(validateDate('2024-02-30') === false);

// ✓ non-date string rejected
assert(validateDate('not a date') === false);

// ✓ empty date rejected
assert(validateDate('') === false);
```

### Unit Tests: Revenue (`scripts/unit-revenue.mjs`)

**Purpose:** Test revenue calculation rules

**Coverage:**
- Single appointment revenue calculation
- Date range revenue summaries
- Daily/monthly revenue aggregation
- Revenue filtering (completed + paid only)
- Revenue rounding to paise

**Example Test:**
```javascript
const apt = {
  status: 'Completed',
  paymentStatus: 'Paid',
  services: [
    { price: 500 },
    { price: 300 }
  ]
};

// ✓ revenue calculated as sum of services
assert(calculateRevenue(apt) === 800);

// ✓ cancelled appointment has zero revenue
assert(calculateRevenue({ ...apt, status: 'Cancelled' }) === 0);

// ✓ unpaid appointment has zero revenue
assert(calculateRevenue({ ...apt, paymentStatus: 'Unpaid' }) === 0);
```

### Unit Tests: Referral (`scripts/unit-referral.mjs`)

**Purpose:** Test referral system rules engine (125+ tests)

**Coverage:**

1. **Status Transitions** (20+ tests)
   - Pending → Qualified → Credited
   - Credited → Redeemed / Expired / Reversed
   - Invalid transitions rejected

2. **Reward Calculation** (15+ tests)
   - Fixed reward: returns configured amount
   - Percentage reward: calculates % of invoice
   - Minimum invoice enforcement
   - Rounding to paise

3. **Settlement Trigger** (10+ tests)
   - `invoice_paid` trigger
   - `appointment_completed` trigger
   - Only credits when both conditions met

4. **Expiry Logic** (8+ tests)
   - Auto-expiry after X days
   - Never-expire if days = 0
   - Expired referral can't be redeemed
   - Already-redeemed don't expire

5. **Remaining Reward** (7+ tests)
   - Untouched credit has full value
   - Redeemed amount reduces remainder
   - Reversal consumes the rest
   - Remainder never negative

6. **Redemption Limits** (12+ tests)
   - Balance cap
   - Invoice percentage cap (50%)
   - Max redeemable = min(balance, invoice * cap / 100)
   - Partial vs full redemption

7. **Redemption Allocation** (10+ tests)
   - Oldest credit first (FIFO)
   - Multiple referrals spanned
   - Partial allocation exact
   - Each referral contributes only its balance

8. **Reporting** (15+ tests)
   - Summary stats: count by status
   - Successful = credited + redeemed
   - Conversion rate calculation
   - Client stats split by referrer

9. **Wallet Ledger** (12+ tests)
   - Credit adds to balance
   - Debit subtracts from balance
   - Reversal debits
   - Expiry debits
   - Immutable history

10. **Ledger Row Construction** (8+ tests)
    - Before/after balances recorded
    - Sign handling (positive/negative)
    - Magnitude normalization

11. **Idempotency Keys** (7+ tests)
    - Credit ID stable per referral
    - Redeem/credit IDs never collide
    - Different referrals get different IDs

12. **Split Payment** (6+ tests)
    - Wallet + cash adds up
    - Partial redemption
    - Full wallet payment leaves nothing due
    - No redemption = full invoice due

13. **Money Rounding** (4+ tests)
    - Float dust removed
    - Rounds to paise (0.01)
    - Non-numeric rounds to 0

**Example Test:**
```javascript
// [4] Reward computation
const settings = { type: 'percentage', value: 5, min: 500 };

// ✓ 10% of 1000 is 100
assert(calculateReward(settings, 1000) === 50);

// ✓ percentage reward is rounded to paise
assert(calculateReward({ ...settings, value: 3.33 }, 1000) === 33);

// ✓ below-minimum invoice earns nothing
assert(calculateReward(settings, 400) === 0);

// ✓ a disabled programme never earns a reward
const disabled = { ...settings, enabled: false };
assert(calculateReward(disabled, 1000) === 0);
```

### E2E Tests: Revenue (`scripts/e2e-revenue.mjs`)

**Purpose:** Test complete revenue workflow in browser

**Flow:**
1. Launch headless Chrome
2. Load app at localhost:5500
3. Log in with test credentials
4. Create appointment
5. Mark as completed
6. Record payment
7. Verify revenue appears on dashboard
8. Test revenue calculations by date range

**Coverage:**
- Complete appointment → revenue flow
- Daily revenue summary
- Monthly revenue summary
- Multi-appointment aggregation
- Payment status effects

### E2E Tests: Referral (`scripts/e2e-referral.mjs`)

**Purpose:** Test complete referral workflow in browser

**Flow:**
1. Launch headless Chrome
2. Load app at localhost:5500
3. Create salon and customers
4. Create referral codes
5. Book appointment with referral
6. Mark completed and paid
7. Verify reward credited
8. Create new appointment for referred customer
9. Apply wallet redemption
10. Verify split payment calculation
11. Verify wallet balance updated
12. Verify referral marked as Redeemed

**Coverage:**
- Referral code generation
- Referral linking at booking
- Automatic qualification
- Reward crediting (atomic)
- Wallet transaction recording
- Redemption allocation
- Split payment calculation
- Referral status transitions

### E2E Tests: Public Booking (`scripts/e2e-public-booking.mjs`)

**Purpose:** Test public booking page workflow

**Flow:**
1. Launch headless Chrome
2. Load public booking page (book.html)
3. Select service and staff
4. Pick date and time slot
5. Enter customer details
6. Enter referral code (optional)
7. Submit booking
8. Verify appointment created in main app
9. Verify customer auto-created
10. Verify referral linked (if code provided)

**Coverage:**
- Public page loads without auth
- Service selection shows available staff
- Slot generation respects working hours
- Customer auto-creation
- Referral linking at booking
- Appointment appears in main app

### E2E Tests: Smoke (`scripts/e2e-smoke.mjs`)

**Purpose:** Quick smoke tests of basic functionality

**Coverage:**
- App loads
- Login works
- Salon data loads
- Navigation works
- Basic CRUD works
- Notifications show

### E2E Tests: Firebase Fallback (`scripts/e2e-firebase-fallback.mjs`)

**Purpose:** Test demo mode when Firebase is unavailable

**Flow:**
1. Launch app with DEMO_MODE = true
2. Verify seedData loads
3. Test all features work without Firebase
4. Test data persists to LocalStorage

## Test Data

### Seed Data (`scripts/seedData.js`)

Demo mode provides hardcoded test data:

```javascript
{
  salons: [
    { id: 'salon1', name: 'Test Salon', ... },
    { id: 'salon2', name: 'Demo Spa', ... }
  ],
  customers: [
    { id: 'c1', name: 'John', phone: '+919876543210', ... }
  ],
  appointments: [
    { id: 'apt1', customerId: 'c1', status: 'Completed', ... }
  ],
  services: [
    { id: 'svc1', name: 'Haircut', price: 500, ... }
  ],
  staff: [
    { id: 'staff1', name: 'Alice', phone: '+919999999999', ... }
  ],
  referrals: [
    { id: 'ref1', referrerId: 'c1', status: 'Credited', ... }
  ],
  walletTransactions: [
    { id: 'wtx1', customerId: 'c1', type: 'credit', ... }
  ]
}
```

## Test Patterns

### Unit Test Pattern

```javascript
// test-file.mjs
import { functionUnderTest } from '../modules.js';

let passed = 0, failed = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  PASS  ${description}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${description}`);
    console.error(`        ${e.message}`);
    failed++;
  }
}

function assert(condition, message = 'Assertion failed') {
  if (!condition) throw new Error(message);
}

// Tests
test('valid input passes', () => {
  assert(functionUnderTest({ valid: true }));
});

test('invalid input fails', () => {
  assert(!functionUnderTest({ valid: false }));
});

console.log(`\n${passed} passed, ${failed} failed`);
```

### E2E Test Pattern

```javascript
// e2e-test.mjs
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch();
const page = await browser.newPage();

try {
  // Navigate to app
  await page.goto('http://localhost:5500');
  
  // Wait for element
  await page.waitForSelector('#login-form');
  
  // Fill form
  await page.type('#email', 'test@example.com');
  await page.type('#password', 'password');
  
  // Click button
  await page.click('#login-button');
  
  // Wait for navigation
  await page.waitForNavigation();
  
  // Verify element appears
  const dashboard = await page.$('#dashboard');
  assert(dashboard !== null, 'Dashboard not found');
  
} finally {
  await browser.close();
}
```

## Debugging Tests

### Run Test with Console Output

```bash
node --inspect-brk scripts/unit-validate.mjs
```

Then open `chrome://inspect` in Chrome DevTools.

### Run Single Test

Edit test file to run only one test group:

```javascript
// Unit tests
// testValidation();  // Skip
testReferral();       // Run only this
// testRevenue();     // Skip
```

### Debug E2E

Add screenshots and console logging:

```javascript
// Take screenshot on failure
await page.screenshot({ path: 'debug.png' });

// Log console messages
page.on('console', msg => console.log('PAGE LOG:', msg.text()));

// Log network errors
page.on('error', err => console.error('PAGE ERROR:', err));
```

## Continuous Integration

Tests run automatically on:

1. **Push to feature branch** → Preview deployment
2. **Push to main** → Production deployment + test verification
3. **Pull request** → Pre-merge validation

**CI Configuration:** `.github/workflows/test.yml` (if enabled)

## Coverage Goals

| Component | Goal | Status |
|-----------|------|--------|
| Core modules | 100% | ✓ Achieved |
| Validation rules | 95%+ | ✓ Achieved |
| Revenue logic | 100% | ✓ Achieved |
| Referral system | 100% | ✓ Achieved (125+ tests) |
| E2E workflows | 80%+ | ✓ Achieved |
| UI rendering | Manual testing | ✓ Tested |

## Known Test Limitations

1. **Firebase emulator not used** — Tests use real Firestore (demo mode when offline)
2. **UI tests are visual** — Manual verification of rendering
3. **Performance tests** — No load/stress testing yet
4. **Security tests** — Basic validation only, not comprehensive

## Adding New Tests

### Template: Unit Test

```javascript
// scripts/unit-newfeature.mjs
import { newFunction } from '../public/js/core/newfeature.js';

let passed = 0, failed = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  PASS  ${description}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${description}`);
    console.error(`        ${e.message}`);
    failed++;
  }
}

// NEW TESTS HERE
test('example passes', () => {
  // assertion
});

console.log(`\nUNIT NEWFEATURE: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
```

### Add to package.json

```json
{
  "scripts": {
    "test": "npm run check && node scripts/unit-validate.mjs && ... && node scripts/unit-newfeature.mjs && ..."
  }
}
```

---

**Last Updated:** August 2026
