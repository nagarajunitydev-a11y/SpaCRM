# Features Documentation

Deep-dive into SpaCRM's major features with workflows, data models, and implementation details.

## Table of Contents

1. [Referral System](#referral-system)
2. [Payment & Revenue](#payment--revenue)
3. [Public Booking](#public-booking)
4. [Loyalty Rewards](#loyalty-rewards)
5. [Appointment Management](#appointment-management)
6. [Customer Management](#customer-management)

---

## Referral System

### Overview

A complete referral program where customers earn rewards (wallet credits) for successful referrals. Features include:
- Unique referral codes per customer
- Configurable reward programs (fixed or percentage-based)
- Automatic reward crediting on qualifying invoices
- Atomic wallet transactions with immutable history
- Client-side redemption with invoice caps
- Automatic expiry management

### Workflow

```
1. CUSTOMER SHARES CODE
   └─ Get unique code: CUSTOMERX123
      Share via link, WhatsApp, in-salon

2. REFERRED CUSTOMER BOOKS
   └─ At booking: enter referral code CUSTOMERX123
   └─ Appointment created with referral link

3. APPOINTMENT COMPLETED
   └─ Status: Pending (waiting for payment)

4. INVOICE PAID
   └─ Payment received for appointment
   └─ Referral status: Pending → Qualified
   └─ Check minimum invoice amount
   
5. REWARD CALCULATED
   └─ Based on referral settings:
      - Fixed amount (e.g., ₹100 per referral)
      - Or percentage (e.g., 5% of invoice)
   └─ Amount credited to referrer's wallet
   └─ Referral status: Qualified → Credited

6. REFERRER REDEEMS
   └─ On next appointment, apply wallet credit
   └─ Redemption capped at 50% of invoice
   └─ Wallet balance decreases
   └─ Referral marked as Redeemed

7. EXPIRY (Automatic)
   └─ If not redeemed within X days
   └─ Referral status: Credited → Expired
   └─ Credit removed from wallet
```

### Referral Statuses

```
┌─────────────────────────────────────────────────────────┐
│                    Referral Lifecycle                    │
└─────────────────────────────────────────────────────────┘

1. PENDING
   └─ Referral created, waiting for customer to spend
   └─ No money in wallet yet
   └─ Status trigger: "invoice_paid" trigger fires
   
2. QUALIFIED
   └─ Customer spent minimum invoice amount
   └─ Waiting to be credited
   └─ Auto-transitions to Credited (by referralService)
   
3. CREDITED ✓
   └─ Reward credited to wallet
   └─ Money available for redemption
   └─ Can expire, be reversed, or redeemed
   
4a. REDEEMED ✓
   └─ Customer used credit on invoice
   └─ May be partial or full redemption
   └─ Status stays Redeemed (partial) or Fully Redeemed
   
4b. EXPIRED ✗
   └─ Credit not used within expiry window
   └─ Money removed from wallet
   └─ Automatic via expiry cron
   
4c. REVERSED ✗
   └─ Manual reversal (admin action)
   └─ Money restored to wallet if partial redemption
   └─ Used for refunds or corrections
```

### Data Model

```javascript
// Referral document
{
  id: "ref_customer123_2024-08-01",  // Immutable ID
  salonId: "salon456",
  
  // Source
  referrerId: "customer123",  // Who gets the reward
  referrerCode: "CUSTOMER123",  // Their unique code
  referredCustomerId: "customer789",  // Who was referred
  
  // Lifecycle
  status: "Credited",  // Pending → Qualified → Credited → Redeemed/Expired/Reversed
  createdAt: "2024-08-01T10:00:00Z",
  qualifiedAt: "2024-08-15T14:30:00Z",  // When invoice reached minimum
  creditedAt: "2024-08-16T09:00:00Z",   // When reward was credited
  redeemedAt: "2024-09-20T15:00:00Z",   // When credit was redeemed
  redeemedAmount: 50,  // How much was redeemed
  expiredAt: null,  // When credit expired (auto)
  reversedAt: null,  // When manually reversed
  
  // Amounts
  reward: 100,  // Amount credited to wallet
  invoice: 1000,  // Invoice amount that triggered reward
  
  // Configuration
  rewardType: "fixed",  // or "percentage"
  rewardValue: 100,  // Fixed amount or percentage
  minimumInvoice: 500,  // Minimum to qualify
  expiryDays: 30,  // Days until auto-expiry (0 = never)
}
```

### Referral Settings

Each salon can configure their referral program:

```javascript
// Referral program config
{
  salonId: "salon456",
  
  // Reward configuration
  rewardType: "fixed",  // or "percentage"
  rewardValue: 100,  // ₹100 per referral, or 5% of invoice
  minimumInvoice: 500,  // Invoice must be >= this
  
  // Expiry
  expiryDays: 30,  // Auto-expire after 30 days (0 = never)
  
  // Trigger
  creditTrigger: "invoice_paid",  // or "appointment_completed"
  
  // Redemption cap
  redemptionCap: 50,  // Max 50% of invoice can be paid from wallet
  
  // Status
  enabled: true
}
```

### Key Calculations

#### Reward Calculation

```javascript
// From core/referral.js
function calculateReward(referralSettings, invoice) {
  // Check minimum
  if (invoice < referralSettings.minimumInvoice) {
    return 0;  // Doesn't qualify
  }
  
  // Fixed reward
  if (referralSettings.rewardType === 'fixed') {
    return referralSettings.rewardValue;
  }
  
  // Percentage reward
  const reward = invoice * referralSettings.rewardValue / 100;
  return Math.round(reward);  // Round to paise
}

// Examples:
calculateReward({ type: 'fixed', value: 100, min: 500 }, 1000)
  → 100

calculateReward({ type: 'percentage', value: 5, min: 500 }, 1000)
  → 50 (5% of 1000)

calculateReward({ type: 'percentage', value: 5, min: 500 }, 400)
  → 0 (below minimum)
```

#### Wallet Balance Calculation

```javascript
// From wallet.js
function getBalance(ledger, customerId) {
  return ledger
    .filter(tx => tx.customerId === customerId)
    .reduce((sum, tx) => {
      const amount = tx.direction === 'positive' ? tx.amount : -tx.amount;
      return sum + amount;
    }, 0);
}

// Example ledger:
[
  { id: 'wtx_1', customerId: 'c1', direction: 'positive', amount: 100 },  // +100
  { id: 'wtx_2', customerId: 'c1', direction: 'negative', amount: 50 },   // -50
  { id: 'wtx_3', customerId: 'c1', direction: 'negative', amount: 20 }    // -20
]
// Balance = 100 - 50 - 20 = 30
```

#### Redemption Allocation (Oldest-First)

```javascript
// From wallet.js
function allocateRedemption(referrals, amount, invoice, cap) {
  const maxFromInvoice = invoice * cap / 100;
  let toAllocate = Math.min(amount, maxFromInvoice);
  const allocation = [];
  
  // Sort by creditedAt (oldest first)
  const sorted = referrals.sort((a, b) => 
    new Date(a.creditedAt) - new Date(b.creditedAt)
  );
  
  // Allocate from oldest to newest
  for (const ref of sorted) {
    if (toAllocate <= 0) break;
    
    const available = ref.reward - ref.redeemedAmount;
    const allocating = Math.min(available, toAllocate);
    
    if (allocating > 0) {
      allocation.push({ referralId: ref.id, amount: allocating });
      toAllocate -= allocating;
    }
  }
  
  return {
    allocation,
    shortfall: toAllocate > 0 ? toAllocate : 0
  };
}

// Example:
// Customer has 3 referral credits:
//  - Ref1: ₹100 (credited 2024-08-01), never redeemed
//  - Ref2: ₹100 (credited 2024-08-15), redeemed ₹50
//  - Ref3: ₹100 (credited 2024-08-20), never redeemed
//
// Want to redeem: ₹150 from ₹1000 invoice (50% cap)
//
// Allocation:
//  - Ref1: ₹100 (oldest, take all 100)
//  - Ref2: ₹0 (only has 50 left, take 0)
//  - Ref3: ₹50 (50 remaining of 150)
// Total: 150
```

#### Expiry Calculation

```javascript
// From core/referral.js
function isExpired(referral, expiryDays, now) {
  if (expiryDays === 0) return false;  // Never expires
  if (referral.status !== 'Credited') return false;  // Only credited can expire
  
  const creditedDate = new Date(referral.creditedAt);
  const expiryDate = new Date(creditedDate);
  expiryDate.setDate(expiryDate.getDate() + expiryDays);
  
  return now > expiryDate;
}

// Example: expiryDays = 30
// Credited: 2024-08-01
// Expires: 2024-08-31 23:59:59
// Today: 2024-09-15 → EXPIRED
```

### Atomic Transaction: Crediting Reward

```javascript
// services/referralService.js
async function creditReferralOnPayment(appointmentId, referralSettings) {
  const appointment = await appointmentsRepository.get(appointmentId);
  
  // Find referral
  const referral = await referralsRepository.getByCustomer(
    appointment.referrerId
  );
  
  // Verify conditions
  if (!referral || referral.status !== 'Pending') return;
  if (appointment.paymentStatus !== 'Paid') return;
  if (appointment.invoice < referralSettings.minimumInvoice) return;
  
  // Calculate reward
  const reward = calculateReward(referralSettings, appointment.invoice);
  
  // Atomic transaction: all or nothing
  await db.runTransaction(async (transaction) => {
    // 1. Update referral status
    const referralRef = referralsRepository.doc(referral.id);
    transaction.update(referralRef, {
      status: 'Credited',
      creditedAt: new Date(),
      reward,
      invoice: appointment.invoice
    });
    
    // 2. Create wallet transaction (immutable, idempotent key)
    const walletTxId = `wtx_credit_${referral.id}`;
    const walletTxRef = walletRepository.doc(walletTxId);
    const oldBalance = await getBalance(ledger, appointment.referrerId);
    
    transaction.set(walletTxRef, {
      id: walletTxId,
      customerId: appointment.referrerId,
      type: 'credit',
      source: 'referral',
      amount: reward,
      direction: 'positive',
      referralId: referral.id,
      timestamp: new Date(),
      balanceBefore: oldBalance,
      balanceAfter: oldBalance + reward
    });
    
    // 3. Update customer balance
    const customerRef = customersRepository.doc(appointment.referrerId);
    transaction.update(customerRef, {
      walletBalance: increment(reward),
      lastRewardDate: new Date()
    });
  });
  
  // If we get here, all 3 updates succeeded
  // If exception, all 3 are rolled back
}
```

### UI Features

#### Referral Dashboard (views/referrals.js)

- List all referrals for salon
- Filter by status (Pending, Qualified, Credited, Redeemed, Expired, Reversed)
- Search by customer name or referral code
- Summary stats:
  - Total referrals, successful referrals, conversion rate
  - Earned total, redeemed total, outstanding balance
  - Per-customer stats

#### Referral Settings Form

- Edit reward type (fixed/percentage)
- Set reward value
- Set minimum invoice
- Set expiry days (0 = never)
- Select credit trigger (invoice_paid or appointment_completed)
- Set redemption cap (%)
- Enable/disable program

#### Customer Profile Referral Section

- Display customer's unique referral code
- Share button (copy, WhatsApp, email)
- QR code for easy sharing
- Referral stats:
  - Total successful referrals
  - Earned vs redeemed
  - Current wallet balance

#### Payment Modal Wallet Section

- Show wallet balance
- Show redemption cap (50% of invoice)
- Input field for redemption amount
- Live calculation:
  - Max redeemable = min(balance, invoice * cap / 100)
  - Split payment: wallet + cash remaining
- Apply/clear button
- Wallet transaction history preview

---

## Payment & Revenue

### Payment Workflow

```
APPOINTMENT
├─ Service booked: ₹1000
├─ Status: Pending (waiting for customer)
├─ No revenue yet

CUSTOMER ARRIVES
└─ Service completed
└─ Status: Completed
└─ Still no revenue (waiting for payment)

PAYMENT COLLECTION
├─ Staff collects payment
├─ Modal opens:
│  ├─ Show invoice: ₹1000
│  ├─ Show customer wallet: ₹150
│  ├─ Show redemption cap: 50% = ₹500
│  ├─ Input redemption amount: ₹150
│  ├─ Split payment:
│  │  ├─ From wallet: ₹150
│  │  ├─ Due in cash/card: ₹850
│  ├─ Enter payment reference
│  └─ Mark as paid
├─ Wallet redemption recorded (immutable ledger entry)
├─ Referrals marked as Redeemed
└─ Referral reward calculated

REVENUE RECORDED
├─ Appointment status: Paid
├─ Revenue: ₹1000 (gross, before redemption)
├─ Appears on dashboard
└─ Customer receives receipt
```

### Revenue Calculation

**Revenue = Gross Booked Service Amount** (before discounts/refunds)

```javascript
// core/revenue.js
function calculateAppointmentRevenue(appointment) {
  return appointment.services
    .map(s => s.price)
    .reduce((a, b) => a + b, 0);
}

// Example:
{
  appointmentId: 'apt_123',
  services: [
    { id: 'svc1', name: 'Haircut', price: 500 },
    { id: 'svc2', name: 'Styling', price: 300 }
  ],
  walletRedemption: 100,  // Doesn't affect revenue
  paymentMethod: 'cash'
}

// Revenue = 500 + 300 = 800 ✓
// (Wallet redemption not subtracted)
```

### Revenue Reporting

```
DASHBOARD STATS
├─ Today's Revenue: sum of all completed + paid appointments today
├─ Month Revenue: sum of all completed + paid appointments this month
├─ Last Month Revenue: sum of all from last month
├─ Average Transaction: month revenue / appointment count
└─ Growth: this month vs last month %
```

### Data Model

```javascript
// Appointment payment fields
{
  appointmentId: 'apt_123',
  customerId: 'c1',
  status: 'Completed',
  paymentStatus: 'Unpaid',  // Unpaid → Paid
  
  // Invoice
  invoice: 800,  // Total amount due
  paymentMethod: 'cash',  // cash, card, upi, wallet, split
  walletRedemption: 150,  // Amount from wallet
  cashDue: 650,  // invoice - walletRedemption
  paymentReference: 'REF12345',  // Receipt number
  
  // Referral link
  referrerId: 'customer123',  // If this is a referred appointment
  referralCode: 'CUSTOMER123'
}
```

---

## Public Booking

### Overview

A public-facing, no-login booking system that allows customers to book appointments via a shareable link or QR code. Features:
- Service selection → staff assignment → date/time → customer details workflow
- Referral code application at booking
- Automatic customer creation if new
- Integration with salon's main app
- Complete offline support

### Workflow

```
1. CUSTOMER VISITS LINK
   └─ https://spacrm.vercel.app/book.html?salonId=salon456
   └─ Loads public booking page (independent app)

2. SELECT SERVICE
   ├─ Show only publicly listed services
   ├─ Choose 1 service with available staff
   └─ Display price, duration, staff list

3. SELECT STAFF & SLOT
   ├─ Pick staff member
   ├─ System generates available slots:
   │  ├─ Working hours: 09:00 - 18:00
   │  ├─ Slot interval: 30 minutes
   │  ├─ Exclude staff's booked times
   │  ├─ Respect minimum notice (e.g., 60 min ahead)
   └─ Choose date and time
   
4. ENTER CUSTOMER DETAILS
   ├─ Name (required)
   ├─ Phone (required, normalized)
   ├─ Email (optional)
   └─ Referral code (optional)

5. CONFIRM & BOOK
   ├─ Show summary: Service, staff, date, time, name
   ├─ If referral code: show reward preview
   └─ Book button (atomic transaction)

6. CONFIRMATION
   ├─ Show confirmation message
   ├─ Send SMS/email receipt (future)
   ├─ Display appointment details
   └─ Show cancellation options (future)
```

### Data Model

```javascript
// Public booking request
{
  salonId: "salon456",
  serviceId: "svc1",
  staffId: "staff123",
  date: "2024-08-20",
  time: "14:30",
  
  // Customer (new or existing)
  customerName: "John Doe",
  customerPhone: "+919876543210",
  customerEmail: "john@email.com",
  
  // Referral (optional)
  referralCode: "CUSTOMER123",
  
  // Source tracking
  bookingSource: "public_booking",
  bookingDate: "2024-08-15T10:00:00Z",
  
  // Staff notes
  notes: "First time customer"
}

// Creates appointment in main app with same structure
```

### Architecture

**Two separate apps, same data:**

```
PUBLIC BOOKING (No Auth)
├─ public/book.html
├─ public/js/public-booking/publicBookingApp.js
├─ public/js/public-booking/publicBookingView.js
└─ Separate Firebase config
   └─ Read-only access to salon services
   └─ Write-only access to create appointments
   └─ No access to customer/payment data

MAIN APP (Authenticated)
├─ public/index.html
├─ public/js/main.js
└─ Full access to all features
```

### Firestore Rules for Public Booking

```javascript
// Allow public to create appointments
match /salons/{salonId}/appointments {
  // Salon owners can read/write (main app)
  allow read, write: if isOwner(salonId);
  
  // Public users can only create new appointments
  allow create: if request.auth == null &&
                   validatePublicBooking(request.resource.data);
}

function validatePublicBooking(data) {
  return data.customerName != null &&
         data.customerPhone != null &&
         data.date != null &&
         data.time != null &&
         data.salonId != null &&
         data.bookingSource == 'public_booking';
}
```

### Implementation Details

#### Auto-create Customer

```javascript
// publicBookingService.js
async function bookAppointment(bookingData, salonId) {
  const { customerPhone, customerName, customerEmail, referralCode } = bookingData;
  
  await db.runTransaction(async (transaction) => {
    // 1. Find or create customer
    let customer = await findCustomerByPhone(customerPhone, salonId);
    
    if (!customer) {
      const customerId = generateId();
      customer = {
        id: customerId,
        name: customerName,
        phone: customerPhone,
        email: customerEmail,
        salonId,
        createdVia: 'public_booking',
        createdAt: new Date()
      };
      transaction.set(customersRef.doc(customerId), customer);
    }
    
    // 2. Create appointment
    const appointmentId = generateId();
    const appointment = {
      id: appointmentId,
      salonId,
      customerId: customer.id,
      serviceId: bookingData.serviceId,
      staffId: bookingData.staffId,
      date: bookingData.date,
      time: bookingData.time,
      status: 'Confirmed',
      bookingSource: 'public_booking',
      createdAt: new Date()
    };
    transaction.set(appointmentsRef.doc(appointmentId), appointment);
    
    // 3. If referral code, create referral link
    if (referralCode) {
      const referral = {
        id: generateId(),
        salonId,
        referrerCode: referralCode,
        referredCustomerId: customer.id,
        appointmentId,
        status: 'Pending',
        createdAt: new Date()
      };
      transaction.set(referralsRef.doc(referral.id), referral);
    }
  });
}
```

### UI Features

#### Booking Link Management (views/bookingLink.js)

- Copy link (auto-generated from salon ID)
- Generate QR code (shows publicly)
- Share via WhatsApp
- Configure working hours
- Select public services
- Toggle booking enabled/disabled

#### Public Booking Page (publicBookingView.js)

- Step 1: Service & Staff Selection
  - Display only public services
  - Show staff availability
  - Price and duration display

- Step 2: Date & Time Selection
  - Calendar showing available dates
  - Time slots based on staff schedule
  - Slot interval (30 min, 1 hour, etc.)

- Step 3: Customer Details
  - Name input
  - Phone input
  - Email input (optional)
  - Referral code input (optional)

- Step 4: Confirmation
  - Review all details
  - Show referral reward if applicable
  - Book button

---

## Loyalty Rewards

### Overview

Separate from referral wallet. Legacy loyalty points system where customers earn points on every appointment, which can be redeemed for vouchers.

### Tiers

```
Points    → Value      → Label
100pts    → ₹25        → "₹25 Voucher"
250pts    → ₹60        → "₹60 Voucher"
500pts    → ₹125       → "₹125 Voucher"
```

### Workflow

```
1. APPOINTMENT COMPLETED
   └─ Customer earns X points

2. CUSTOMER ACCUMULATES
   ├─ 100 points → can redeem ₹25 voucher
   ├─ 250 points → can redeem ₹60 voucher
   └─ 500 points → can redeem ₹125 voucher

3. REDEEM TIER
   ├─ Customer selects tier (e.g., 250 points)
   ├─ Points deducted
   ├─ Transaction recorded
   └─ Voucher value applied to next appointment
```

### Data Model

```javascript
// Customer rewards account
{
  customerId: "c1",
  salonId: "salon456",
  totalPoints: 350,
  redeemedPoints: 100,
  availablePoints: 250,
  tier1Redeemed: 0,  // count of ₹25 vouchers
  tier2Redeemed: 1,  // count of ₹60 vouchers
  tier3Redeemed: 0   // count of ₹125 vouchers
}

// Reward transaction
{
  id: "rwtx_1",
  customerId: "c1",
  type: "earn",  // or "redeem"
  points: 10,
  tier: null,  // only set if redeem
  reason: "appointment_completed",
  appointmentId: "apt_123",
  timestamp: "2024-08-01T10:00:00Z"
}
```

---

## Appointment Management

### Statuses

```
Pending → Confirmed → Completed → Paid ✓
  ↓
Cancelled ✗
```

### Features

- Create appointment with customer, service, staff, date, time
- Edit pending appointments
- Mark as completed when customer finishes
- Record payment (cash, card, wallet, split)
- Cancel with reason
- Customer notifications (booking, reminder, completion)
- SMS integration (future)

### Scoped Queries

All appointments filtered to active salon automatically via `setSalon(salonId)`.

---

## Customer Management

### Features

- Customer database with name, phone, email
- Search by name or phone
- Customer profiles with:
  - Referral code (unique)
  - Wallet balance
  - Loyalty points
  - Appointment history
  - Reward history
- Edit customer details
- Soft-delete (archive) customer

### Scoped Queries

All customers filtered to active salon automatically.

---

**Last Updated:** August 2026
