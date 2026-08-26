# Core Modules Documentation

Pure business logic modules with no side effects. All testable and framework-independent.

## Table of Contents

1. [store.js](#storejs) — State management
2. [router.js](#routerjs) — Navigation logic
3. [referral.js](#referraljs) — Referral workflow
4. [revenue.js](#revenuejs) — Revenue calculations
5. [wallet.js](#walletjs) — Wallet ledger math
6. [rewards.js](#rewardsjs) — Loyalty rewards
7. [validate.js](#validatejs) — Form validation
8. [sanitize.js](#sanitizejs) — XSS prevention
9. [utils.js](#utilsjs) — Helper functions
10. [draft.js](#draftjs) — Form persistence
11. [scheduling.js](#schedulingjs) — Appointment slots
12. [bookingConfig.js](#bookingconfigjs) — Public booking rules
13. [platform.js](#platformjs) — Platform detection

---

## store.js

**Purpose:** Observable state management singleton with reactive updates.

**Size:** ~80 lines | **No dependencies**

### API

```javascript
// Get current state
store.state

// Update state (shallow merge)
store.setState({ key: value })

// Subscribe to changes
const unsubscribe = store.subscribe((state) => {
  console.log('State changed:', state);
});

// Unsubscribe
unsubscribe();
```

### Usage Example

```javascript
// main.js bootstrap
const unsubscribe = store.subscribe((state) => {
  const html = renderApp(state);
  document.getElementById('app').innerHTML = html;
});

// Event handler
function handleCreateCustomer(name, phone) {
  const customer = { id: generateId(), name, phone };
  customersRepository.create(customer);
  // Repository subscription updates store → re-render
}
```

### State Shape

```javascript
{
  user: { id, email, name },
  isAuthenticated: boolean,
  activeSalon: { id, name, ownerId },
  currentView: 'dashboard',
  
  // Collections (synced from Firestore)
  customers: [],
  appointments: [],
  services: [],
  staff: [],
  referrals: [],
  walletTransactions: [],
  
  // UI state
  modalOpen: false,
  modalContent: { type, data },
  isLoading: false,
  notification: { type, message, duration }
}
```

### Key Characteristics

- **Shallow merge** — setState merges top-level keys only
- **Synchronous updates** — no async state changes
- **Notify-all pattern** — all subscribers notified on any change
- **No middleware** — pure state + listeners

---

## router.js

**Purpose:** Navigate between views based on user role and authentication.

**Size:** ~120 lines | **No dependencies**

### API

```javascript
// Get current view name
const view = router.getCurrentView(state);

// Get nav items for current role
const navItems = router.getNavItems(state);

// Navigate to view
router.navigateTo(view, state);

// Check if user has access to view
const hasAccess = router.canAccess(view, state);
```

### Views by Role

**Guest (Not Authenticated)**
- `login` — Sign-in/sign-up screen

**Salon Owner (Authenticated)**
- `dashboard` — Overview, revenue, appointments
- `appointments` — Manage appointments
- `customers` — Customer list and profiles
- `services` — Service catalog
- `staff` — Staff management
- `referrals` — Referral program settings
- `bookingLink` — Public booking link management

**Super Admin**
- `admin` — Manage all salons

### Usage Example

```javascript
// In view selector
const currentView = router.getCurrentView(state);
const view = renderView(currentView, state);

// In event handler
function handleNavigate(viewName) {
  if (router.canAccess(viewName, state)) {
    store.setState({ currentView: viewName });
  }
}
```

### Nav Items Structure

```javascript
[
  { view: 'dashboard', label: 'Dashboard', icon: 'home' },
  { view: 'appointments', label: 'Appointments', icon: 'calendar' },
  { view: 'customers', label: 'Customers', icon: 'users' },
  { view: 'services', label: 'Services', icon: 'settings' },
  { view: 'staff', label: 'Staff', icon: 'user-check' },
  { view: 'referrals', label: 'Referrals', icon: 'gift' },
  { view: 'bookingLink', label: 'Public Booking', icon: 'link' }
]
```

---

## referral.js

**Purpose:** Referral workflow rules engine with status lifecycle, calculations, and validations.

**Size:** ~450 lines | **No dependencies** | **125+ unit tests**

### Data Model

```javascript
// Referral statuses
Pending      → Qualified → Credited ──→ Redeemed
              └────────────────────→ Expired
                                    → Reversed

// Referral object
{
  id: "ref_customer123_2024-08-01",
  customerId: "customer123",
  code: "CUSTOMER123",
  status: "Credited",
  reward: 100,  // Amount credited to wallet
  invoice: 1000,  // Invoice that triggered qualification
  createdAt: "2024-08-01T10:00:00Z",
  qualifiedAt: "2024-08-15T14:30:00Z",  // Became Qualified
  creditedAt: "2024-08-16T09:00:00Z",   // Moved to Credited
  redeemedAmount: 50,  // How much has been redeemed
  expiredAt: null,
  reversedAt: null
}
```

### Key APIs

#### Status Transitions

```javascript
// Check if referral can move to Qualified
canQualify(referral, invoice, referralSettings)
  → true if invoice >= minimumInvoice
  → false otherwise

// Check if referral should be credited
shouldCredit(referral, invoice, trigger)
  → true if trigger is 'invoice_paid' or 'appointment_completed'
  → checks appointment status and payment status

// Check if referral can be redeemed
canRedeem(referral)
  → false if already Redeemed, Reversed, or Expired
  → true otherwise

// Check if referral is expired
isExpired(referral, referralSettings, now)
  → true if (now - creditedAt) > expiryDays
  → false if expiryDays is 0 (never expires)
```

#### Reward Calculations

```javascript
// Calculate reward amount for an invoice
calculateReward(referralSettings, invoice)
  → 0 if invoice < minimumInvoice
  → returns fixed amount if rewardType='fixed'
  → returns percentage if rewardType='percentage'
  → applies cap if specified

// Get remaining balance in a referral
remainingBalance(referral)
  → 0 if Pending, Reversed, or Expired
  → reward - redeemedAmount if Credited or Redeemed
  → 0 if status is Reversed
```

#### Redemption

```javascript
// Check if amount can be redeemed from referral
canRedeemAmount(referral, amount)
  → false if referral.status not in [Credited, Redeemed]
  → false if amount > remainingBalance(referral)
  → true otherwise

// Get maximum redeemable percentage of invoice
getRedemptionCap(referralSettings, invoice)
  → returns percentage (e.g., 50 for 50% cap)
  → checks if cap is enforced (0 = uncapped)

// Calculate max amount that can be redeemed
maxRedeemable(referral, invoice, cap)
  → Math.min(remainingBalance, invoice * cap / 100)
```

### Validation Rules

```javascript
// Validate referral settings configuration
validateReferralSettings(settings)
  → checks rewardType is 'fixed' or 'percentage'
  → checks minimumInvoice >= 0
  → checks expiryDays >= 0
  → checks rewardValue > 0
  → checks cap is 0-100 if specified

// Validate referral code format
validateReferralCode(code)
  → must be uppercase alphanumeric
  → must be 3-20 characters
  → typically generated as CUSTOMERNAME + timestamp
```

### Reporting

```javascript
// Summary stats for all referrals
computeReferralSummary(referrals)
  → { total, pending, qualified, credited, redeemed, expired, reversed }
  → { convertedAmount, redeemedAmount, outstandingBalance }
  → { conversionRate: (credited / total) * 100 }

// Stats for a specific customer
computeClientStats(referrals, customerId)
  → { earned, redeemed, available }
  → { total, successful, pending }
  → { conversionRate }
```

### Usage Example

```javascript
// services/referralService.js
async function creditReferralOnPayment(appointmentId) {
  const appointment = await appointmentsRepository.get(appointmentId);
  const referral = await referralsRepository.getByCustomer(appointment.customerId);
  
  // Check if referral should be credited
  if (!referral.shouldCredit(appointment, 'invoice_paid')) return;
  
  // Calculate reward
  const settings = await referralSettingsRepository.get();
  const reward = calculateReward(settings, appointment.invoice);
  
  // Credit the referral (atomic)
  await db.runTransaction(async (transaction) => {
    transaction.update(referralDoc, {
      status: 'Credited',
      creditedAt: now,
      reward
    });
    // ...
  });
}
```

---

## revenue.js

**Purpose:** Calculate appointment revenue (gross booked service amount).

**Size:** ~40 lines | **No dependencies** | **Tests included**

### Key Formula

```javascript
// Revenue = sum of all services booked
// No deductions (discounts, refunds, taxes handled elsewhere)
// Only counts completed/paid appointments

const revenue = appointment.services
  .map(s => s.price)
  .reduce((a, b) => a + b, 0);
```

### API

```javascript
// Calculate revenue for single appointment
calculateAppointmentRevenue(appointment)
  → returns sum of service prices
  → returns 0 if appointment is cancelled/refunded

// Calculate total revenue for date range
calculateRevenueForDateRange(appointments, startDate, endDate)
  → filters appointments by date
  → sums revenue of all matching
  → only counts completed + paid

// Calculate daily/monthly summaries
getRevenueByDay(appointments, date)
getRevenueByMonth(appointments, year, month)
getTotalRevenue(appointments)
```

### Usage Example

```javascript
// Dashboard stats
const today = new Date();
const todayRevenue = getRevenueByDay(appointments, today);
const monthRevenue = getRevenueByMonth(appointments, 2024, 8);

// Display on dashboard
{
  todayRevenue,
  monthRevenue,
  averageTransactionValue: monthRevenue / appointmentCount
}
```

---

## wallet.js

**Purpose:** Immutable referral wallet ledger with transaction tracking.

**Size:** ~200 lines | **No dependencies** | **45+ unit tests**

### Data Model

```javascript
// Wallet transaction (immutable)
{
  id: "wtx_credit_ref_customer123",
  customerId: "customer123",
  type: "credit",  // or "debit"
  source: "referral",  // 'referral', 'reversal', 'expiry', 'returned_redemption'
  amount: 100,  // Always positive magnitude
  direction: "positive",  // or "negative" (for sign)
  referralId: "ref_customer123",  // Source document
  timestamp: "2024-08-16T09:00:00Z",
  balanceBefore: 50,  // Balance before this transaction
  balanceAfter: 150   // Balance after this transaction
}

// Wallet ledger = array of these immutable transactions
```

### Transaction Types

| Type | Source | Direction | When |
|------|--------|-----------|------|
| credit | referral | positive | Referral qualified and credited |
| debit | reversal | negative | Referral is reversed |
| debit | expiry | negative | Referral expired |
| debit | redemption | negative | Customer redeems wallet for invoice |
| credit | returned_redemption | positive | Redemption reversed/refunded |

### Key APIs

```javascript
// Calculate current balance from ledger
getBalance(ledger, customerId)
  → sums all transactions for customer
  → credits are positive, debits are negative

// Create a credit transaction
createCreditTransaction(customerId, amount, source, referralId)
  → returns immutable transaction object
  → includes balanceBefore/balanceAfter

// Create a debit transaction
createDebitTransaction(customerId, amount, source)
  → negative direction
  → includes before/after balances

// Get all transactions for customer
getCustomerLedger(ledger, customerId)
  → returns array of transactions, most recent first
  → used for wallet history view

// Allocate redemption (oldest-credit-first)
allocateRedemption(ledger, customerId, amount)
  → returns allocation plan: which referrals to draw from
  → respects referral boundaries (each contributes only its balance)
  → returns shortfall if not enough balance
```

### Validation

```javascript
// Check if customer can redeem amount
canRedeem(ledger, customerId, amount, invoiceAmount, cap)
  → false if amount > balance
  → false if amount > (invoiceAmount * cap / 100)
  → true otherwise

// Validate transaction structure
isValidTransaction(tx)
  → checks required fields: id, customerId, type, amount, direction
  → checks amount is positive
  → checks direction is 'positive' or 'negative'
```

### Reporting

```javascript
// Summary stats
getWalletSummary(ledger, customerId)
  → { balance, credited, redeemed, outstanding }
  → { creditCount, debitCount }
  → { lastTransaction: date }
```

### Usage Example

```javascript
// Calculate wallet balance
const ledger = await walletRepository.getAll();
const balance = getBalance(ledger, customerId);

// Redeem wallet on payment
const redemptionPlan = allocateRedemption(
  ledger, 
  customerId, 
  redemptionAmount,
  invoiceAmount,
  50  // 50% cap
);

// Create debit transactions for each referral
for (const [referralId, debitAmount] of redemptionPlan) {
  const tx = createDebitTransaction(customerId, debitAmount, 'redemption');
  await walletRepository.create(tx);
}
```

---

## rewards.js

**Purpose:** Loyalty rewards tier configuration (points → vouchers).

**Size:** ~50 lines | **No dependencies**

### Data Model

```javascript
// Default reward tiers
const REWARD_TIERS = [
  { points: 100, value: 25, label: '₹25 Voucher' },
  { points: 250, value: 60, label: '₹60 Voucher' },
  { points: 500, value: 125, label: '₹125 Voucher' }
];

// Customer reward account
{
  customerId: "customer123",
  totalPoints: 350,
  redeemedPoints: 100,
  availablePoints: 250
}
```

### API

```javascript
// Get all tiers
getTiers()
  → returns array of { points, value, label }

// Find tier by points
getTierByPoints(points)
  → returns tier object or null
  → exact match required

// Add points to customer
addPoints(customer, points)
  → returns updated customer with points added

// Redeem points
redeemTier(customer, tierPoints)
  → checks customer has enough points
  → returns updated customer with points deducted
  → returns error if insufficient points

// Get redemption options for customer
getRedeemableOptions(customer)
  → returns tiers customer can redeem
  → based on availablePoints
```

### Usage Example

```javascript
// Earn points on appointment completion
if (appointment.status === 'completed') {
  const customer = await customersRepository.get(customerId);
  const updated = addPoints(customer, 10);
  await customersRepository.update(updated);
}

// Show redemption modal
const options = getRedeemableOptions(customer);
// [ { points: 100, value: 25 }, { points: 250, value: 60 } ]

// Redeem selected tier
const updated = redeemTier(customer, 100);
await customersRepository.update(updated);
```

---

## validate.js

**Purpose:** Form validation rules for all inputs.

**Size:** ~200 lines | **No dependencies** | **50+ unit tests**

### Validation Rules

```javascript
// Generic validators
isBlank(value)
  → true if null, undefined, or whitespace-only

isValidDate(dateString)
  → format: YYYY-MM-DD
  → checks valid calendar date (no Feb 30)
  → checks not in past

isValidTime(timeString)
  → format: HH:MM (24-hour)
  → checks 00:00 to 23:59

isValidEmail(email)
  → basic email format check
  → not strict (allows most email formats)

isValidPhone(phone)
  → supports Indian numbers: +91 or national
  → 10-digit national or 12-digit with country code
  → returns E.164 normalized (+91XXXXXXXXXX)

isValidCurrency(amount)
  → positive number
  → 2 decimal places max

// Appointment validation
validateAppointment(data)
  → checks customerName not blank
  → checks serviceId provided
  → checks staffId provided
  → checks date is valid
  → checks time is valid
  → returns { isValid: boolean, errors: {} }

// Customer validation
validateCustomer(data)
  → checks name not blank
  → checks phone is valid
  → checks email format if provided
  → returns validation result

// Service validation
validateService(data)
  → checks name not blank
  → checks price is positive currency
  → checks duration not blank

// Referral code validation
validateReferralCode(code)
  → checks format: 3-20 uppercase alphanumeric
  → checks not already used

// Payment validation
validatePaymentAmount(amount, invoiceAmount, walletBalance, cap)
  → checks amount is valid currency
  → checks amount <= invoiceAmount
  → checks amount <= (walletBalance * cap / 100)
```

### API

```javascript
// Validate single field
isValidEmail(value) → boolean

// Validate form (all fields)
validateAppointment(data) → { isValid, errors }

// Normalize input
normalizePhone(phone) → "+91XXXXXXXXXX"
normalizeDate(date) → "YYYY-MM-DD"
```

### Error Messages

```javascript
// Returns structured errors
{
  isValid: false,
  errors: {
    customerName: "Customer name is required",
    serviceId: "Service must be selected",
    date: "Date must be in the future",
    phone: "Phone must be 10 digits"
  }
}
```

---

## sanitize.js

**Purpose:** XSS prevention and safe HTML rendering.

**Size:** ~80 lines | **No dependencies**

### API

```javascript
// Escape for HTML text context
esc(text)
  → replaces <, >, &, ", ' with HTML entities
  → safe for use in element content

// Escape for HTML attribute context
escAttr(text)
  → escapes quotes and special chars
  → safe for use in data-* attributes

// Escape for URL context
escUrl(url)
  → checks protocol is safe (http, https, mailto)
  → prevents javascript: URLs
  → safe for href attributes

// Render safe HTML (whitelist)
renderSafeHtml(html, allowedTags)
  → only allows specific tags: p, br, strong, em, a
  → strips script tags and event handlers
  → used for customer notes/descriptions
```

### Usage Example

```javascript
// Safe text display
const name = "<script>alert('xss')</script>";
const safe = esc(name);  // "&lt;script&gt;..."

// Safe attribute
const note = 'data with "quotes"';
const html = `<div data-note="${escAttr(note)}">...</div>`;

// Safe URL
const userUrl = "javascript:alert('xss')";
const safeUrl = escUrl(userUrl) || '#';  // returns '' if unsafe

// Safe HTML content
const noteHtml = renderSafeHtml(userInput, ['p', 'br', 'strong']);
```

---

## utils.js

**Purpose:** General helper functions.

**Size:** ~150 lines | **No dependencies**

### API

```javascript
// ID generation
generateId()
  → returns unique ID like "id_1691234567890_random"

// Currency formatting
formatCurrency(amount)
  → converts number to ₹ with 2 decimals
  → "₹100.00"

currencyToNumber(formatted)
  → "₹100.00" → 100

// Date/time formatting
formatDate(date)
  → "01 Aug 2024"

formatTime(date)
  → "2:30 PM"

formatDateRange(startDate, endDate)
  → "01 - 15 Aug 2024"

// Debounce
debounce(fn, delay)
  → returns debounced function
  → waits `delay`ms before executing
  → used for search, input handlers

// Salon scoping
setSalonScope(salonId)
  → global state for queries
  → all repositories use this

getSalonScope()
  → returns current salonId

// User initials
getInitials(name)
  → "John Doe" → "JD"

// Duration parsing
parseDuration(duration)
  → "1.5 hours" → 90 minutes
  → "30 mins" → 30 minutes
```

---

## draft.js

**Purpose:** Auto-save form drafts to LocalStorage.

**Size:** ~60 lines | **No dependencies**

### API

```javascript
// Save draft
saveDraft(formName, data)
  → localStorage[`draft_${formName}`] = JSON.stringify(data)

// Load draft
loadDraft(formName)
  → returns saved data or null
  → JSON.parse(localStorage[`draft_${formName}`])

// Clear draft
clearDraft(formName)
  → deletes localStorage entry

// Check if draft exists
hasDraft(formName)
  → returns boolean
```

### Usage Example

```javascript
// main.js event handler
document.addEventListener('input', (e) => {
  if (e.target.form?.id === 'appointment-form') {
    const data = new FormData(e.target.form);
    saveDraft('appointment', Object.fromEntries(data));
  }
});

// On page load
const draft = loadDraft('appointment');
if (draft) {
  // Pre-fill form with draft data
  form.elements.namedItem('customerId').value = draft.customerId;
  form.elements.namedItem('serviceId').value = draft.serviceId;
  // ...
}

// On successful submit
function handleSubmit() {
  // ... submit ...
  clearDraft('appointment');
}
```

---

## scheduling.js

**Purpose:** Generate available appointment slots based on working hours and staff conflicts.

**Size:** ~250 lines | **No dependencies**

### API

```javascript
// Generate slots for a date
generateSlotsForDate(date, staff, appointments, config)
  → config = { workingHours, slotIntervalMinutes, advanceBookingDays }
  → returns array of { time, availableStaff: [] }
  → only slots not already booked by staff

// Check if time slot is available
isSlotAvailable(date, time, staff, appointments)
  → false if staff has existing appointment at that time
  → true if slot is free

// Get staff conflict
getStaffConflict(staffId, date, time, appointments)
  → returns conflicting appointment or null
  → used to show why slot is unavailable

// Parse duration string
parseDuration(durationStr)
  → "1.5 hours" → 90
  → "45 minutes" → 45
  → returns minutes

// Calculate end time
addMinutes(date, minutes)
  → date + duration = end time
```

### Configuration

```javascript
// Booking config (from bookingConfig.js)
{
  workingHours: {
    monday: { start: '09:00', end: '18:00' },
    tuesday: { start: '09:00', end: '18:00' },
    // ... closed on Sunday
  },
  slotIntervalMinutes: 30,
  advanceBookingDays: 30,
  minNoticeMinutes: 60
}
```

### Usage Example

```javascript
// Get available slots for service date
const slots = generateSlotsForDate(
  new Date('2024-08-20'),
  selectedStaff,
  appointments,
  bookingConfig
);

// Filter by staff
const staffSlots = slots.filter(slot =>
  slot.availableStaff.includes(selectedStaff.id)
);

// Display to user
// 09:00 AM, 09:30 AM, 10:00 AM, ...
```

---

## bookingConfig.js

**Purpose:** Public booking configuration rules and validation.

**Size:** ~120 lines | **No dependencies**

### Data Model

```javascript
{
  bookingEnabled: true,
  workingHours: {
    monday: { start: '09:00', end: '18:00' },
    tuesday: { start: '09:00', end: '18:00' },
    // ... etc
    sunday: null  // closed
  },
  slotIntervalMinutes: 30,
  advanceBookingDays: 30,
  minNoticeMinutes: 60,
  syncPublicCatalog: true,
  publicServices: ['service1', 'service2']  // Only these visible publicly
}
```

### API

```javascript
// Check if booking is enabled
isBookingEnabled(config)
  → returns boolean

// Get working hours for date
getWorkingHoursForDate(date, config)
  → { start: '09:00', end: '18:00' } or null if closed

// Check if date is bookable
isBookableDate(date, config)
  → false if more than advanceBookingDays away
  → false if closed that day
  → true otherwise

// Check if time is within hours
isWithinWorkingHours(time, hours)
  → checks time is between start and end

// Get available services for public booking
getPublicServices(allServices, config)
  → filters to syncPublicCatalog entries
  → used for public booking page
```

---

## platform.js

**Purpose:** Detect platform (web, PWA, Android TWA) and adjust behavior.

**Size:** ~40 lines | **No dependencies**

### API

```javascript
// Get platform type
getPlatform()
  → returns 'web' | 'pwa' | 'android_twa'

// Check platform
isPWA()
isPlatformWeb()
isAndroidTWA()

// Check if standalone (installed)
isStandalone()
  → returns boolean
  → true if PWA installed or Android TWA

// Get user agent info
getUserAgentInfo()
  → returns { platform, isChrome, isSafari, version }
```

### Usage Example

```javascript
// Adjust for Android TWA (no browser UI)
if (isAndroidTWA()) {
  // Add back button
  // Adjust layout for mobile
  // Disable some web APIs
}

// Show install prompt for PWA
if (isPlatformWeb() && !isStandalone()) {
  // Show "Install App" button
}

// Firebase TWA config
if (isAndroidTWA()) {
  // Use specific Firebase config
}
```

---

**Last Updated:** August 2026
