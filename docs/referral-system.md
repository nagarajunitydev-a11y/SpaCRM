# Client Referral System

## Overview

The referral system rewards salon owners and their clients for bringing in new business. Every client receives a unique referral code at signup. When a friend uses that code to join, a **Pending** referral is created. The referrer is credited with **100 bonus points** once the referred friend books their first appointment.

---

## Key Constants

| Constant | Value | File |
|---|---|---|
| `REFERRAL_SIGNUP_BONUS` | 100 pts | `core/rewards.js` |
| `REFERRAL_BONUS_POINTS` | 100 pts | `core/rewards.js` |
| `REWARD_TIERS` | 100 / 250 / 500 pts | `core/rewards.js` |

---

## Data Model

### Collections

| Collection | Scope | Purpose |
|---|---|---|
| `salons/{salonId}/customers` | Tenant-scoped | Customer profiles with `referralCode`, `referralPoints`, and referral linkage fields |
| `referralCodes` | Global | Registry mapping each code to its owning salon/customer |
| `referrals` | Global | Referral lifecycle records (Pending → Successful → Bonus Credited) |
| `rewardTransactions` | Global | Immutable audit ledger of every points movement |

### Customer Fields (referral-related)

```
referralCode          string   Unique code assigned to this client (e.g. "LG-ABCD12")
referralPoints        number   Current points balance
referredByCode        string   The code entered at signup (null if not referred)
referringSalonId      string   Salon that owns the referrer's code
referringCustomerId   string   ID of the customer who owns the referrer's code
referringCustomerName string   Display name of the referrer
```

### Referral Record Fields

```
id                    string   Deterministic: "<code>__<referredCustomerId>"
code                  string   Normalized referral code used
referringSalonId      string   Salon of the referrer
referringCustomerId   string   Customer who owns the code
referringCustomerName string   Display name of the referrer
referredSalonId       string   Salon where the referred customer signed up
referredCustomerId    string   The new customer's ID
referredCustomerName  string   The new customer's name
referredCustomerPhone string   Phone number
status                string   "Pending" | "Successful" | "Bonus Credited" | "Rejected"
bonusAmount           number   Always 100 (enforced by Firestore rules)
appointmentId         string   Set when status moves to Successful
firstAppointmentAt    timestamp Set when status moves to Successful
bonusCreditedAt       timestamp Set when status moves to Bonus Credited
createdAt             string   ISO timestamp
```

### Referral Code Registry Fields

```
code                  string   The referral code (document ID)
salonId               string   Owning salon
kind                  string   "salon" | "customer"
customerId            string|null Customer ID (null for salon codes)
customerName          string   Display name
createdAt             string   ISO timestamp
```

### Reward Transaction Fields

```
id                    string   "REFERRAL__<referralId>"
clientId              string   Referrer's customer ID
clientName            string   Referrer's display name
salonId               string   Salon context for the transaction
referralId            string   The referral record ID
points                number   100
type                  string   "REFERRAL_BONUS"
description           string   Human-readable description
createdAt             string   ISO timestamp
```

---

## Referral Lifecycle

### State Machine

```
  ┌─────────┐     First appointment booked     ┌────────────┐
  │ Pending  │ ──────────────────────────────►  │ Successful  │
  └────┬────┘                                   └─────┬──────┘
       │                                              │
       │ Reject (salon owner)                         │ Points credited
       ▼                                              ▼
  ┌──────────┐                              ┌──────────────────┐
  │ Rejected  │                              │ Bonus Credited   │
  └──────────┘                              └──────────────────┘
```

### Step-by-step Flow

#### 1. Customer A exists with referral code `LG-OLIVIA`

When Customer A is created (or their profile is viewed), a unique referral code is generated and registered in the global `referralCodes` collection. The code appears on their profile and can be shared.

**Code generation:** `referralCodesRepository.generateUniqueCode('LG')` — retries up to 8 times to avoid collisions, then falls back to a timestamp-suffixed code.

**Registration:** `referralCodesRepository.registerReferralCode()` writes to the `referralCodes` collection. In demo mode, this writes to an in-memory Map.

#### 2. Customer B signs up with code `LG-OLIVIA`

When a salon owner adds a new client and enters a referral code in the form:

1. **`addCustomer(payload)`** in `customersRepository.js` is called
2. The code is looked up: `referralCodesRepository.lookupReferralCode(code)` — resolves to `{ salonId, kind, customerId, customerName }`
3. Validation: rejects self-referral (`referringCustomerId === created.id`)
4. The new customer record is created with referral linkage fields:
   ```
   referredByCode: "LG-OLIVIA"
   referringSalonId: "salon_luxe_01"
   referringCustomerId: "c1"
   referringCustomerName: "Olivia Wilde"
   ```
5. Customer B's own referral code is generated and registered
6. A **Pending referral** record is created via `referralsRepository.createReferral()`

**Firestore rules for referral creation** (`firestore.rules:230-238`):
- Writer must have access to the referred salon
- `referringSalonId` must match the code's registered salon
- `referringCustomerId` must match the code's registered customer
- The referred customer must already exist in Firestore
- Status must be `Pending`

#### 3. Customer B books their first appointment

When any appointment is created for Customer B:

1. **`addAppointment(payload)`** in `appointmentsRepository.js` writes the appointment
2. `maybeCreditReferralBonus(created)` fires asynchronously (fire-and-forget)
3. The function fetches Customer B via `getCustomerFromSalon(customerId, salonId)` — reads directly from Firestore, bypassing the scoped store
4. Checks `customer.referredByCode` — if absent, exits early
5. Finds the referral via `referralsRepository.findReferral(code, customerId)` using a deterministic ID: `"LG-OLIVIA__c2"`
6. Verifies `referral.status === 'Pending'` — if already processed, exits early (idempotent)
7. **Mark Successful:** `referralsRepository.markReferralSuccessful(referral, appointmentId)`
   - Sets `status: 'Successful'`, `appointmentId`, `firstAppointmentAt: new Date()`
   - Firestore rule verifies the referenced appointment exists and its `customerId` matches
8. **Credit referrer:** Fetches Customer A via `getCustomerFromSalon(referringCustomerId, referringSalonId)`
   - Writes `referralPoints: currentPts + 100` via `updateCustomerInSalon()` to the correct salon subcollection
9. **Mark complete:** `referralsRepository.completeReferral(successful)` — sets `status: 'Bonus Credited'`, `bonusCreditedAt`
10. **Record transaction:** `rewardTransactionsRepository.recordReferralBonus()` — creates an audit record with deterministic ID `REFERRAL__<referralId>`

#### 4. Salon owner rejects a referral (optional)

From the referrals tab, the salon owner can reject a pending referral:

```
referralsRepository.rejectReferral(referral)
```

Sets `status: 'Rejected'`. No points are awarded. The referral is excluded from future processing.

---

## Code Architecture

### File Responsibilities

| File | Role |
|---|---|
| `customersRepository.js` | Customer CRUD + referral code generation at signup |
| `appointmentsRepository.js` | Appointment CRUD + referral bonus trigger on first booking |
| `referralsRepository.js` | Referral lifecycle (create, find, mark status, reject) |
| `referralCodesRepository.js` | Global code registry (register, lookup, generate, validate) |
| `rewardTransactionsRepository.js` | Immutable audit ledger for points movements |
| `core/rewards.js` | Constants, code generation, tier definitions |
| `services/scopedRepository.js` | Tenant-scoped CRUD factory (salon filtering) |
| `services/db.js` | Firestore read/write layer |
| `firestore.rules` | Server-side security rules + state machine enforcement |

### Key Functions

#### `customersRepository.addCustomer(payload)`
- Validates: duplicate phone/name, valid referral code, no self-referral
- Creates customer with `referralPoints: 100` (signup bonus)
- Registers the customer's own referral code in the global registry
- Creates a Pending referral if a valid code was entered

#### `appointmentsRepository.maybeCreditReferralBonus(appointment)`
- Fetches the referred customer directly from Firestore (cross-salon safe)
- Looks up the pending referral by deterministic ID
- Orchestrates the full Successful → credit → Bonus Credited → transaction flow
- Idempotent: safe to call multiple times for the same customer

#### `referralsRepository.createReferral(data)`
- Deterministic ID: `"<code>__<referredCustomerId>"` prevents duplicates
- In demo mode: appends to store (skip if ID exists)
- In Firebase mode: `setDocument()` (idempotent overwrite by ID)

#### `referralsRepository.markReferralSuccessful(referral, appointmentId)`
- Guards: only processes `Pending` referrals
- Writes `firstAppointmentAt` as a Firestore `Date` (converts to `Timestamp`)

#### `referralCodesRepository.lookupReferralCode(code)`
- Normalizes input (uppercase, strip non-alphanumeric)
- In demo mode: reads from in-memory Map
- In Firebase mode: reads from `referralCodes` collection

---

## Security (Firestore Rules)

### Referral Code Registry
```
read:  any signed-in user
create: admin or salon owner of the code's salon
update: admin or salon owner (salon must not change)
delete: admin only
```

### Referral Records
```
read:  admin, or access to referred/referring salon
create: must access referred salon, valid referral data, deterministic ID match,
        status == Pending, referrer matches code owner, customer exists
update: state machine enforced (Pending→Successful, Successful→Bonus Credited,
        Pending→Rejected)
delete: forbidden
```

### Reward Transactions
```
read:  admin, or access to the transaction's salon
create: admin or salon owner of the transaction's salon
update/delete: forbidden (append-only audit trail)
```

### State Machine Rules (`referralTransitionAllowed`)
- **Pending → Successful:** requires `appointmentId` (non-empty string), `firstAppointmentAt` (timestamp), and the referenced appointment's `customerId` must match `referredCustomerId`
- **Successful → Bonus Credited:** requires `bonusCreditedAt` (timestamp)
- **Pending → Rejected:** allowed without additional conditions

---

## Demo Mode

In demo mode (no Firebase backend):

- Referral codes live in an in-memory `Map` (`referralCodesRepository.demoRegistry`)
- Referral records and transactions live in the store
- `seedDemoRegistry()` pre-populates codes for seed customers (Olivia → LG-OLIVIA)
- Seed referral: Olivia (c1) referred Jessica (c2) — already "Bonus Credited" with 100 pts
- All operations are synchronous — no listener race conditions

---

## Cross-Salon Referrals

The system supports referrals across different salon branches:

- Customer A is in Salon 1 → shares code `LG-OLIVIA`
- Customer B signs up at Salon 2 with code `LG-OLIVIA`
- The referral record stores both `referringSalonId` (Salon 1) and `referredSalonId` (Salon 2)
- When Customer B books at Salon 2, `maybeCreditReferralBonus` fetches Customer A directly from Salon 1 using `getCustomerFromSalon()` and `updateCustomerInSalon()` — bypassing the salon-scoped store

---

## Idempotency

Every step is safe to retry:

| Operation | Idempotency mechanism |
|---|---|
| Referral creation | Deterministic ID (`code__customerId`), skip if exists |
| Mark Successful | Guard: only processes `Pending` referrals |
| Mark Bonus Credited | Guard: only processes `Successful` referrals |
| Transaction recording | Deterministic ID (`REFERRAL__<referralId>`), skip if exists |
| Points credit | Written after referral is marked Successful; re-runs produce same balance |

---

## UI Touchpoints

| Screen | Referral feature |
|---|---|
| **Add Client modal** | Optional "Referral Code" input field |
| **Client profile card** | Displays referral code and points balance |
| **Rewards modal** | Shows points, next tier, shareable referral message |
| **Referrals tab** | Lists all referrals with status, filter by Pending/Successful/Credited |
| **Dashboard** | Referral program overview card (points earned, referrals count) |
