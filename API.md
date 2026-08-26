# API Reference

Quick reference for the most important APIs in SpaCRM.

## Table of Contents

1. [State Management](#state-management)
2. [Repositories](#repositories)
3. [Core Modules](#core-modules)
4. [Services](#services)
5. [UI Rendering](#ui-rendering)

---

## State Management

### store.js

```javascript
import { store } from 'js/core/store.js';

// READ: Get current state
const state = store.state;
console.log(state.currentView);  // 'dashboard'
console.log(state.customers);    // []

// WRITE: Update state
store.setState({
  currentView: 'appointments',
  isLoading: true
});

// SUBSCRIBE: Listen to changes
const unsubscribe = store.subscribe((newState) => {
  console.log('State changed:', newState);
  render(newState);  // Re-render UI
});

// UNSUBSCRIBE: Stop listening
unsubscribe();
```

---

## Repositories

Repositories manage data persistence to Firestore. All are auto-scoped to active salon.

### salonsRepository

```javascript
import { salonsRepository } from 'js/services/salonsRepository.js';

// READ
const salon = await salonsRepository.get(salonId);

// SUBSCRIBE (real-time updates)
const unsubscribe = salonsRepository.subscribe((salons) => {
  store.setState({ salons });
});

// CREATE
const newSalon = {
  id: generateId(),
  name: 'My Salon',
  email: 'salon@example.com',
  phone: '+919876543210',
  address: '123 Main St',
  ownerId: userId
};
await salonsRepository.create(newSalon);

// UPDATE
await salonsRepository.update({ id: salonId, name: 'Updated Name' });

// SET SCOPE (for queries)
salonsRepository.setSalon(salonId);
```

### customersRepository

```javascript
import { customersRepository } from 'js/services/customersRepository.js';

// READ
const customer = await customersRepository.get(customerId);

// SUBSCRIBE (real-time)
const unsub = customersRepository.subscribe((customers) => {
  store.setState({ customers });
});

// CREATE
const customer = {
  id: generateId(),
  salonId: activeSalon.id,
  name: 'John Doe',
  phone: '+919876543210',
  email: 'john@email.com',
  walletBalance: 0,
  referralCode: 'JOHNDOE123'
};
await customersRepository.create(customer);

// UPDATE
await customersRepository.update({
  id: customerId,
  walletBalance: 100,
  email: 'newemail@example.com'
});

// SEARCH
const results = await customersRepository.search('John');
const byPhone = await customersRepository.getByPhone('+919876543210');

// SET SCOPE
customersRepository.setSalon(salonId);
```

### appointmentsRepository

```javascript
import { appointmentsRepository } from 'js/services/appointmentsRepository.js';

// READ
const apt = await appointmentsRepository.get(appointmentId);

// SUBSCRIBE (real-time)
const unsub = appointmentsRepository.subscribe((appointments) => {
  store.setState({ appointments });
});

// CREATE
const appointment = {
  id: generateId(),
  salonId: activeSalon.id,
  customerId: 'customer123',
  serviceId: 'service123',
  staffId: 'staff123',
  date: '2024-08-20',
  time: '14:30',
  status: 'Confirmed',
  invoice: 1000,
  paymentStatus: 'Unpaid',
  notes: 'First time customer'
};
await appointmentsRepository.create(appointment);

// UPDATE
await appointmentsRepository.update({
  id: appointmentId,
  status: 'Completed',
  invoice: 1000,
  paymentStatus: 'Paid'
});

// GET BY DATE
const today = appointments.filter(a => a.date === '2024-08-20');

// SET SCOPE
appointmentsRepository.setSalon(salonId);
```

### referralsRepository

```javascript
import { referralsRepository } from 'js/services/referralsRepository.js';

// READ
const referral = await referralsRepository.get(referralId);

// SUBSCRIBE (real-time)
const unsub = referralsRepository.subscribe((referrals) => {
  store.setState({ referrals });
});

// CREATE
const referral = {
  id: generateId(),
  salonId: activeSalon.id,
  referrerId: 'customer1',
  referrerCode: 'CUSTOMER1',
  referredCustomerId: 'customer2',
  status: 'Pending',
  createdAt: new Date(),
  reward: 0
};
await referralsRepository.create(referral);

// UPDATE
await referralsRepository.update({
  id: referralId,
  status: 'Credited',
  creditedAt: new Date(),
  reward: 100
});

// GET BY CUSTOMER
const referrals = await referralsRepository.getByCustomer(customerId);

// GET BY CODE
const referral = await referralsRepository.getByCode('CUSTOMER123');

// SET SCOPE
referralsRepository.setSalon(salonId);
```

### walletRepository

```javascript
import { walletRepository } from 'js/services/walletRepository.js';

// READ
const transaction = await walletRepository.get(txId);

// SUBSCRIBE
const unsub = walletRepository.subscribe((ledger) => {
  store.setState({ walletTransactions: ledger });
});

// CREATE (credit transaction)
const creditTx = {
  id: `wtx_credit_${referralId}`,
  customerId: 'customer123',
  type: 'credit',
  source: 'referral',
  amount: 100,
  direction: 'positive',
  referralId: referralId,
  timestamp: new Date(),
  balanceBefore: 50,
  balanceAfter: 150
};
await walletRepository.create(creditTx);

// CREATE (debit transaction)
const debitTx = {
  id: `wtx_redeem_${invoiceNo}`,
  customerId: 'customer123',
  type: 'debit',
  source: 'redemption',
  amount: 100,
  direction: 'negative',
  timestamp: new Date(),
  balanceBefore: 150,
  balanceAfter: 50
};
await walletRepository.create(debitTx);

// GET CUSTOMER LEDGER
const ledger = await walletRepository.getCustomerLedger(customerId);

// SET SCOPE
walletRepository.setSalon(salonId);
```

### servicesRepository

```javascript
import { servicesRepository } from 'js/services/servicesRepository.js';

// READ
const service = await servicesRepository.get(serviceId);

// SUBSCRIBE
const unsub = servicesRepository.subscribe((services) => {
  store.setState({ services });
});

// CREATE
const service = {
  id: generateId(),
  salonId: activeSalon.id,
  name: 'Haircut',
  price: 500,
  duration: '1 hour',
  description: 'Professional haircut'
};
await servicesRepository.create(service);

// UPDATE
await servicesRepository.update({
  id: serviceId,
  price: 600,
  duration: '1.5 hours'
});

// DELETE
await servicesRepository.delete(serviceId);

// SET SCOPE
servicesRepository.setSalon(salonId);
```

### staffRepository

```javascript
import { staffRepository } from 'js/services/staffRepository.js';

// READ
const staff = await staffRepository.get(staffId);

// SUBSCRIBE
const unsub = staffRepository.subscribe((staffList) => {
  store.setState({ staff: staffList });
});

// CREATE
const staff = {
  id: generateId(),
  salonId: activeSalon.id,
  name: 'Alice',
  phone: '+919999999999',
  role: 'Stylist',
  email: 'alice@salon.com'
};
await staffRepository.create(staff);

// UPDATE
await staffRepository.update({
  id: staffId,
  role: 'Senior Stylist'
});

// DELETE
await staffRepository.delete(staffId);

// SET SCOPE
staffRepository.setSalon(salonId);
```

---

## Core Modules

### referral.js

```javascript
import {
  calculateReward,
  canQualify,
  canRedeem,
  isExpired,
  remainingBalance,
  computeReferralSummary,
  computeClientStats
} from 'js/core/referral.js';

// CALCULATE REWARD
const reward = calculateReward({
  rewardType: 'fixed',
  rewardValue: 100,
  minimumInvoice: 500
}, 1000);
// → 100

const percentReward = calculateReward({
  rewardType: 'percentage',
  rewardValue: 5,
  minimumInvoice: 500
}, 1000);
// → 50

// CHECK STATUS TRANSITIONS
const canQ = canQualify(referral, invoice, settings);
// → true if invoice >= minimumInvoice

const canR = canRedeem(referral);
// → true if status is Credited or Redeemed

const expired = isExpired(referral, settings, new Date());
// → true if past expiry window

// GET REMAINING BALANCE
const remaining = remainingBalance(referral);
// → reward - redeemedAmount

// SUMMARY STATS
const summary = computeReferralSummary(referrals);
// → { total, pending, credited, redeemed, expired, convertedAmount, outstandingBalance, conversionRate }

// CLIENT STATS
const stats = computeClientStats(referrals, customerId);
// → { earned, redeemed, available, total, successful, pending, conversionRate }
```

### revenue.js

```javascript
import {
  calculateAppointmentRevenue,
  calculateRevenueForDateRange,
  getRevenueByDay,
  getRevenueByMonth
} from 'js/core/revenue.js';

// SINGLE APPOINTMENT
const apt = {
  status: 'Completed',
  paymentStatus: 'Paid',
  services: [
    { price: 500 },
    { price: 300 }
  ]
};
const revenue = calculateAppointmentRevenue(apt);
// → 800

// DATE RANGE
const rangeRevenue = calculateRevenueForDateRange(
  appointments,
  new Date('2024-08-01'),
  new Date('2024-08-31')
);
// → 5000

// BY DAY
const dayRevenue = getRevenueByDay(appointments, new Date('2024-08-20'));
// → 2500

// BY MONTH
const monthRevenue = getRevenueByMonth(appointments, 2024, 8);
// → 25000
```

### wallet.js

```javascript
import {
  getBalance,
  createCreditTransaction,
  createDebitTransaction,
  getCustomerLedger,
  allocateRedemption,
  canRedeem
} from 'js/core/wallet.js';

// GET BALANCE
const balance = getBalance(ledger, customerId);
// → 150 (sum of all transactions)

// CREATE CREDIT
const credit = createCreditTransaction(
  customerId,
  100,
  'referral',
  referralId
);
// → { id, customerId, type: 'credit', direction: 'positive', ... }

// CREATE DEBIT
const debit = createDebitTransaction(
  customerId,
  100,
  'redemption'
);
// → { id, customerId, type: 'debit', direction: 'negative', ... }

// GET CUSTOMER LEDGER
const transactions = getCustomerLedger(ledger, customerId);
// → array of transactions, newest first

// ALLOCATE REDEMPTION (oldest-first)
const plan = allocateRedemption(
  referrals,
  150,  // amount to redeem
  1000,  // invoice amount
  50    // cap percentage
);
// → { allocation: [ { referralId, amount }, ... ], shortfall: 0 }

// CAN REDEEM
const can = canRedeem(ledger, customerId, 100, 1000, 50);
// → true if within balance and cap limits
```

### validate.js

```javascript
import {
  isValidEmail,
  isValidPhone,
  isValidDate,
  isValidCurrency,
  normalizePhone,
  validateAppointment,
  validateCustomer
} from 'js/core/validate.js';

// VALIDATORS
isValidEmail('test@example.com');
// → true

isValidPhone('+919876543210');
// → true

isValidDate('2024-08-20');
// → true

isValidCurrency(100.50);
// → true

// NORMALIZE
const normalized = normalizePhone('9876543210');
// → '+919876543210'

// VALIDATE FORM
const result = validateAppointment({
  customerName: 'John',
  serviceId: 'svc1',
  date: '2024-08-20',
  time: '14:30'
});
// → { isValid: true, errors: {} }

const badResult = validateAppointment({
  customerName: '',
  serviceId: 'svc1'
});
// → { isValid: false, errors: { customerName: '...', date: '...' } }

const custResult = validateCustomer({
  name: 'John Doe',
  phone: '+919876543210',
  email: 'john@email.com'
});
// → { isValid: true, errors: {} }
```

### scheduling.js

```javascript
import {
  generateSlotsForDate,
  isSlotAvailable,
  parseDuration,
  addMinutes
} from 'js/core/scheduling.js';

// GENERATE SLOTS
const slots = generateSlotsForDate(
  new Date('2024-08-20'),
  selectedStaff,
  appointments,
  {
    workingHours: { monday: { start: '09:00', end: '18:00' } },
    slotIntervalMinutes: 30,
    advanceBookingDays: 30
  }
);
// → [ { time: '09:00', availableStaff: [...] }, ... ]

// CHECK SLOT AVAILABLE
const available = isSlotAvailable(
  new Date('2024-08-20'),
  '14:30',
  selectedStaff,
  appointments
);
// → true if no conflicts

// PARSE DURATION
const minutes = parseDuration('1.5 hours');
// → 90

const mins2 = parseDuration('45 minutes');
// → 45

// ADD MINUTES
const endTime = addMinutes(new Date('2024-08-20 14:00'), 90);
// → Date('2024-08-20 15:30')
```

### sanitize.js

```javascript
import { esc, escAttr, escUrl, renderSafeHtml } from 'js/core/sanitize.js';

// ESCAPE FOR HTML TEXT
const safe = esc('<script>alert("xss")</script>');
// → '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'

// ESCAPE FOR ATTRIBUTE
const attrSafe = escAttr('data with "quotes"');
// → 'data with &quot;quotes&quot;'
// Use in: <div data-value="${attrSafe}">

// ESCAPE FOR URL
const urlSafe = escUrl('javascript:alert("xss")');
// → '' (unsafe URL returns empty)

const goodUrl = escUrl('https://example.com');
// → 'https://example.com'

// RENDER SAFE HTML
const html = renderSafeHtml('<p>Hello</p><script>alert("no")</script>', ['p', 'br']);
// → '<p>Hello</p>' (script removed)
```

### router.js

```javascript
import { router } from 'js/core/router.js';

// GET CURRENT VIEW
const view = router.getCurrentView(state);
// → 'dashboard'

// GET NAV ITEMS
const nav = router.getNavItems(state);
// → [ { view: 'dashboard', label: 'Dashboard', icon: 'home' }, ... ]

// CHECK ACCESS
const access = router.canAccess('referrals', state);
// → true if user role has access

// NAVIGATE
router.navigateTo('appointments', state);
store.setState({ currentView: 'appointments' });
```

---

## Services

### referralService.js

```javascript
import { referralService } from 'js/services/referralService.js';

// CREDIT REFERRAL (atomic transaction)
await referralService.creditReferralOnPayment(
  appointmentId,
  referralSettings
);
// Atomically updates: referral status, wallet, customer balance

// REDEEM WALLET (atomic transaction)
await referralService.redeemWallet(
  customerId,
  invoiceNo,
  redemptionAmount,
  referralSettings
);
// Atomically updates: referral statuses, wallet transactions, customer balance

// HANDLE REFERRAL EXPIRY
await referralService.expireReferrals(referralSettings);
// Auto-expires old credits, removes from wallet
```

### publicBookingService.js

```javascript
import { publicBookingService } from 'js/services/publicBookingService.js';

// BOOK APPOINTMENT (no auth required)
const result = await publicBookingService.bookAppointment({
  salonId: 'salon456',
  serviceId: 'service1',
  staffId: 'staff1',
  date: '2024-08-20',
  time: '14:30',
  customerName: 'John Doe',
  customerPhone: '+919876543210',
  customerEmail: 'john@email.com',
  referralCode: 'CUSTOMER123'
});
// → { appointmentId, customerId, referralId }
// Creates appointment in main app (atomic)
// Auto-creates customer if new
// Links referral if code provided
```

### authService.js

```javascript
import { authService } from 'js/services/authService.js';

// SIGN UP
await authService.signUp({
  email: 'user@example.com',
  password: 'password123'
});

// SIGN IN
await authService.signIn({
  email: 'user@example.com',
  password: 'password123'
});

// SIGN OUT
await authService.signOut();

// GET CURRENT USER
const user = authService.getCurrentUser();
// → { uid, email, ... }

// ON AUTH CHANGE
authService.onAuthStateChanged((user) => {
  if (user) {
    store.setState({ user, isAuthenticated: true });
  } else {
    store.setState({ user: null, isAuthenticated: false });
  }
});
```

---

## UI Rendering

### Main App Shell

```javascript
// main.js - Central bootstrap
import { store } from 'js/core/store.js';
import { renderApp } from 'js/ui/app.js';

// Subscribe to store changes
store.subscribe((state) => {
  const html = renderApp(state);
  document.getElementById('app').innerHTML = html;
});

// Render initial view
store.setState({ currentView: 'login' });
```

### View Rendering

```javascript
// Each view is a pure function
// views/dashboard.js
export function renderDashboard(state) {
  return `
    <div class="dashboard">
      <h1>Dashboard</h1>
      <div class="stats">
        <div class="stat">Today: ₹${state.todayRevenue}</div>
        <div class="stat">Month: ₹${state.monthRevenue}</div>
      </div>
      <div class="appointments">
        ${state.appointments.map(a => `
          <div data-appointment-id="${a.id}">
            ${a.customerId} - ${a.time}
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// views/modals.js
export function renderModal(state) {
  if (!state.modalOpen) return '';
  
  const { type, data } = state.modalContent;
  
  switch (type) {
    case 'edit-appointment':
      return renderEditAppointmentModal(data);
    case 'payment':
      return renderPaymentModal(data);
    default:
      return '';
  }
}
```

### Event Delegation

```javascript
// main.js - Centralized event handler
document.addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  
  if (action === 'create-appointment') {
    const form = e.target.closest('form[data-form="appointment"]');
    const data = new FormData(form);
    
    validateAppointment(Object.fromEntries(data));
    await appointmentsRepository.create(data);
    
    store.setState({ modalOpen: false });
  }
  
  if (action === 'redeem-wallet') {
    const form = e.target.closest('form[data-form="payment"]');
    const data = new FormData(form);
    
    await referralService.redeemWallet(
      state.activeSalon.id,
      data.get('invoiceNo'),
      data.get('redemptionAmount')
    );
  }
});

// In HTML
<button data-action="create-appointment">Save</button>
<button data-action="redeem-wallet">Apply Credit</button>
```

---

**Last Updated:** August 2026
