# SpaCRM Architecture Guide

Comprehensive overview of the system design, data flow, patterns, and design decisions.

## Table of Contents

1. [System Overview](#system-overview)
2. [Architectural Layers](#architectural-layers)
3. [State Management](#state-management)
4. [Data Flow](#data-flow)
5. [Transaction Patterns](#transaction-patterns)
6. [Offline Architecture](#offline-architecture)
7. [Security Model](#security-model)
8. [Performance Considerations](#performance-considerations)
9. [Scalability](#scalability)

## System Overview

SpaCRM is a **layered, modular architecture** with clear separation of concerns:

```
┌──────────────────────────────────────────────────────┐
│  UI Layer (Views)                                    │
│  13 screen renderers, no business logic              │
└──────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────┐
│  Event Delegation Layer (main.js)                    │
│  Central click/form/input handlers                   │
└──────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────┐
│  Business Logic Layer (core modules)                 │
│  13 pure, testable modules with no side effects      │
└──────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────┐
│  Data Layer (services/repositories)                  │
│  18 repositories, atomic transactions, subscriptions │
└──────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────┐
│  Backend (Firestore + Firebase Auth)                 │
│  Cloud database, real-time subscriptions             │
└──────────────────────────────────────────────────────┘
```

## Architectural Layers

### 1. UI Layer (`public/js/ui/views/`)

**Purpose:** Render screens based on state and handle user interactions

**Characteristics:**
- Pure presentation — no business logic
- Stateless functions that take (state, context) and return HTML
- Driven by central event delegation
- No direct repository access
- No validation logic (handled by core modules)

**Files:** 13 view files
- `login.js`, `dashboard.js`, `appointments.js`, `customers.js`, `referrals.js`, `payment.js`, etc.

**Responsibility:**
- Render HTML based on current state
- Handle form submissions to central event delegation
- Display notifications and modals
- Show loading states during async operations

### 2. Event Delegation Layer (`main.js`)

**Purpose:** Central hub for all user interactions, orchestrating between UI and business logic

**Key Responsibilities:**
- Listen to all click, form submit, and input events on document
- Route events to appropriate handlers based on `data-action` attributes
- Call business logic (core modules) with validated input
- Call repositories to persist data
- Handle UI state (modals, drafts, loaders)
- Subscribe to store changes and re-render app

**Flow:**
```
user clicks button → event bubbles to document → 
main.js matches data-action → validates input → 
calls business logic → calls repository → 
store updates → re-render
```

**Never Calls:** Repositories without business logic validation

### 3. Business Logic Layer (`public/js/core/`)

**Purpose:** Encapsulate all domain rules and calculations as pure functions

**Characteristics:**
- Pure functions (no side effects, deterministic)
- Highly testable (unit tests verify every rule)
- No external dependencies
- No direct Firestore access
- No DOM manipulation

**13 Core Modules:**

| Module | Responsibility |
|--------|-----------------|
| **store.js** | Observable state management singleton |
| **referral.js** | Referral workflow rules (statuses, rewards, expiry) |
| **revenue.js** | Appointment revenue calculations |
| **wallet.js** | Referral wallet ledger math (immutable transactions) |
| **rewards.js** | Loyalty reward tier configuration |
| **validate.js** | Form validation rules |
| **sanitize.js** | XSS prevention, safe HTML rendering |
| **utils.js** | Helper functions (formatting, ID generation) |
| **draft.js** | LocalStorage form persistence |
| **scheduling.js** | Appointment slot generation, conflict detection |
| **bookingConfig.js** | Public booking configuration rules |
| **router.js** | Role-based navigation logic |
| **platform.js** | Platform detection (web, PWA, TWA) |

**Example: Referral Module**
```javascript
// Pure function — no side effects
export function calculateReward(referralConfig, invoice) {
  if (invoice < referralConfig.minimumInvoice) return 0;
  
  if (referralConfig.rewardType === 'fixed') {
    return referralConfig.rewardValue;
  } else {
    return Math.round(invoice * referralConfig.rewardPercentage / 100);
  }
}

// Every rule is tested and documented
// No Firestore calls, no DOM access
```

### 4. Data Layer (`public/js/services/`)

**Purpose:** Manage all Firestore access, subscriptions, and atomic transactions

**Characteristics:**
- Repositories encapsulate Firestore schema
- Scoped to active salon via `setSalon(salonId)`
- Real-time subscriptions with reactive updates
- Atomic transactions for multi-document operations
- Immutable document IDs (prevent duplicates)

**18 Services:**

| Service | Responsibility |
|---------|-----------------|
| **firebase.js** | SDK init, offline persistence, network detection |
| **db.js** | Low-level Firestore (getDoc, getCollection, transactions) |
| **authService.js** | Authentication, session management |
| **salonsRepository.js** | Salon CRUD and subscriptions |
| **customersRepository.js** | Customer data, search, reward tracking |
| **appointmentsRepository.js** | Appointment CRUD, scoped subscriptions |
| **staffRepository.js** | Staff catalog, scoped |
| **servicesRepository.js** | Service catalog (name, price, duration), scoped |
| **referralsRepository.js** | Referral tracking with status lifecycle |
| **referralService.js** | **ONLY module that moves referral money** |
| **walletRepository.js** | Wallet ledger with immutable history |
| **rewardTransactionsRepository.js** | Loyalty points history |
| **bookingSettingsRepository.js** | Public booking configuration |
| **publicBookingService.js** | Public booking backend (no auth) |
| **referralCodesRepository.js** | Referral code lifecycle |
| **referralSettingsRepository.js** | Referral program configuration |
| **seedData.js** | Demo mode seeding |
| **scopedRepository.js** | Base class for salon-scoped subscriptions |

**Critical Pattern: `referralService.js`**
```javascript
// Only place where referral money moves
// Everything wrapped in atomic transaction
await db.runTransaction(async (transaction) => {
  // 1. Verify referral is valid
  // 2. Calculate reward (calls core/referral.js)
  // 3. Create wallet transaction
  // 4. Update referral status
  // 5. Update customer balance
  // All succeed or all fail together
});
```

### 5. Backend Layer

**Technology:** Firebase (Firestore + Authentication)

**Responsibilities:**
- Real-time database with offline persistence
- Document-based schema
- Firestore Security Rules for access control
- Authentication (email/password, Google OAuth)
- User sessions and permissions

## State Management

### Store Architecture

```javascript
// core/store.js — Observable state pattern
const store = {
  state: { /* current state */ },
  listeners: new Set(),
  
  setState(patch) {
    // Shallow merge patch into state
    this.state = { ...this.state, ...patch };
    // Notify all listeners
    this.listeners.forEach(fn => fn(this.state));
  },
  
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn); // unsubscribe
  }
};
```

### State Shape

```javascript
{
  // Authentication
  user: { id, email, name },
  isAuthenticated: boolean,
  
  // Active salon (scopes all other data)
  activeSalon: { id, name, ownerId },
  
  // Collections (reactive from Firestore subscriptions)
  customers: [ { id, name, phone, email, walletBalance, ... } ],
  appointments: [ { id, customerId, serviceId, staffId, date, time, status, ... } ],
  services: [ { id, name, price, duration } ],
  staff: [ { id, name, phone, role } ],
  referrals: [ { id, customerId, code, status, reward, ... } ],
  walletTransactions: [ { id, customerId, amount, direction, type, ... } ],
  
  // UI State (not persisted)
  currentView: 'dashboard',
  modalOpen: false,
  modalContent: { type, data },
  isLoading: false,
  notification: { type, message, duration },
  
  // Form drafts (kept in LocalStorage separately)
  formDraft: { /* unsaved form data */ }
}
```

### State Updates

**Only 3 ways to update state:**

1. **Subscribe to Firestore (Automatic)**
   ```javascript
   // Repository subscribes to collection
   appointmentsRepository.subscribe((appointments) => {
     store.setState({ appointments });
   });
   // Firestore changes → Repository → Store → UI re-renders
   ```

2. **Action Handler (Event-Driven)**
   ```javascript
   // User clicks button → main.js handler → business logic → repository → store
   async function handleCreateAppointment(data) {
     validateAppointment(data); // core/validate.js
     const id = await appointmentsRepository.create(data);
     // Repository's subscription updates store automatically
   }
   ```

3. **Direct UI State Updates**
   ```javascript
   // Modals, loading states, notifications
   store.setState({
     modalOpen: true,
     modalContent: { type: 'edit-appointment', data: appointment }
   });
   ```

### Re-render Trigger

```javascript
// Every state change triggers this
store.subscribe((state) => {
  const html = renderApp(state);
  document.getElementById('app').innerHTML = html;
});
```

**Performance:** Only app shell re-renders; individual DOM updates are cheap due to Tailwind classes.

## Data Flow

### Complete Flow: Creating an Appointment

```
1. USER INTERACTION
   ├─ User fills appointment form and clicks "Save"
   
2. EVENT DELEGATION (main.js)
   ├─ Document click → main.js routes to 'create-appointment' handler
   ├─ Extracts form data
   
3. BUSINESS LOGIC (core/validate.js)
   ├─ Validates date, time, customer, service, staff
   ├─ Rejects if invalid, shows error
   
4. PERSISTENCE (appointmentsRepository)
   ├─ Generates immutable ID from date/time/customer
   ├─ Calls appointmentsRepository.create(data)
   ├─ Sends to Firestore (scoped to activeSalon)
   
5. BACKEND (Firestore)
   ├─ Security rules check user owns salon
   ├─ Document is written
   
6. REAL-TIME SYNC
   ├─ Firestore subscription fires
   ├─ Repository receives updated appointments collection
   ├─ Repository calls store.setState({ appointments })
   
7. UI RE-RENDER
   ├─ Store subscribers are notified
   ├─ main.js calls renderApp(state)
   ├─ New appointment appears in appointments list
   ├─ User sees confirmation notification
```

### Complete Flow: Redeeming Referral Wallet

```
1. USER INTERACTION
   ├─ User on payment modal, enters redemption amount
   ├─ Clicks "Apply Wallet Credit"
   
2. EVENT DELEGATION (main.js)
   ├─ Extracts redemption amount from form
   ├─ Validates it's <= wallet balance
   
3. BUSINESS LOGIC
   ├─ core/validate.js: Check redemption <= 50% of invoice
   ├─ core/wallet.js: Calculate allocation (oldest-credit-first)
   ├─ core/referral.js: Mark referrals as partially redeemed
   
4. PERSISTENCE (referralService.js - atomic transaction)
   ├─ Start Firestore transaction
   ├─ Move referral statuses to Redeemed (partial)
   ├─ Create wallet debit transaction
   ├─ Update customer balance
   ├─ Commit all together (all-or-nothing)
   
5. BACKEND (Firestore)
   ├─ Transaction executes atomically
   ├─ Documents updated
   
6. REAL-TIME SYNC
   ├─ Firestore subscriptions fire (referrals, wallet, customers)
   ├─ All three repositories update
   ├─ All call store.setState({ referrals, walletTransactions, customers })
   
7. UI RE-RENDER
   ├─ Payment modal shows updated wallet balance
   ├─ Split payment amount calculated: wallet + cash
   ├─ Wallet transaction appears in ledger
   ├─ Customer profile shows new balance
```

## Transaction Patterns

### Pattern 1: Atomic Referral Settlement

**When:** Customer completes appointment and it's marked paid

**Atomicity Requirement:** All succeed or all fail together
- Referral status changes from Pending → Credited
- Wallet credit is recorded with idempotent key
- Customer balance increases
- Referral settings validate the trigger

**Implementation:**
```javascript
// services/referralService.js
await db.runTransaction(async (transaction) => {
  // 1. Read referral, check it's Pending
  const referral = await referralsRepository.get(referralId);
  if (referral.status !== 'Pending') throw new Error('Not pending');
  
  // 2. Calculate reward using pure function
  const reward = calculateReward(referralSettings, invoice);
  
  // 3. Create wallet transaction with idempotent key
  const txId = `wtx_credit_${referralId}`;
  const walletTx = {
    id: txId,
    customerId,
    type: 'credit',
    source: 'referral',
    amount: reward,
    referralId,
    timestamp: now
  };
  
  // 4. Update all documents in single transaction
  transaction.set(referralDoc, { status: 'Credited', creditedAt: now });
  transaction.set(walletTxDoc, walletTx);
  transaction.update(customerDoc, {
    walletBalance: increment(reward)
  });
  
  // Transaction commits — all succeed or all fail
});
```

### Pattern 2: Idempotent Operations

**Problem:** Network failures might cause duplicate submissions

**Solution:** Deterministic document IDs

```javascript
// Referral credit (same referral = same transaction ID)
const creditId = `wtx_credit_${referralId}`;

// Appointment (same date/time/customer = same ID)
const appointmentId = `apt_${salonId}_${customerId}_${dateTime}`;

// Redemption (same invoice = same redemption ID)
const redemptionId = `wtx_redeem_${invoiceNumber}`;

// Submitting twice creates same document — no duplicates
```

### Pattern 3: Conditional Updates

**When:** Update only if condition is met

**Example:** Only credit referral if invoice is paid
```javascript
await db.runTransaction(async (transaction) => {
  const appointment = await appointmentsRepository.get(appointmentId);
  
  // Only credit if payment settled
  if (appointment.paymentStatus !== 'Paid') return;
  
  // Now safe to credit the referral
  // ...
});
```

## Offline Architecture

### Three-Layer Offline Support

#### 1. Firestore Local Cache
- Firestore SDK caches documents locally
- Queries work offline (returns cached data)
- Writes queued and sync when online
- No explicit code needed

#### 2. Service Worker (App Shell Caching)
- **Cache-first:** Static assets (JS, CSS, HTML)
- **Network-first:** API calls (Firebase)
- **Stale-while-revalidate:** Some resources

**Strategy:**
```javascript
// public/sw.js
// Cache these on install (app shell)
const SHELL_ASSETS = [
  '/index.html',
  '/js/main.js',
  '/js/core/*.js',
  '/js/services/*.js',
  '/styles/tailwind.css',
  // ... 13 app shell files
];

// Serve from cache, update from network
if (request.url in SHELL_ASSETS) {
  return cache.match(request) || fetch(request);
}

// Firestore always from network
if (request.url.includes('firestore.googleapis.com')) {
  return fetch(request);
}
```

#### 3. Form Draft Persistence
- All form inputs auto-save to LocalStorage
- Page reload recovers unsaved data
- No data loss

### Offline Behavior

**Online → Offline:**
- App continues to work (reads cached Firestore data)
- Writes are queued by Firestore SDK
- UI shows "offline" banner

**Offline → Online:**
- Queued writes automatically sync
- Subscriptions re-sync (merge conflicts handled by Firestore)
- UI banner disappears

**Demo Mode (No Firebase):**
- seedData.js provides hardcoded test data
- LocalStorage acts as "fake Firestore"
- All features testable without Firebase config

## Security Model

### Authentication
- Firebase email/password or Google OAuth
- Session tokens stored in browser storage
- Auto-refreshed before expiry
- Logout clears all user data

### Authorization (Firestore Rules)
```javascript
// rules/firestore.rules

rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    // Users can only see their own user doc
    match /users/{userId} {
      allow read, write: if request.auth.uid == userId;
    }
    
    // Salon owners can only access their salon
    match /salons/{salonId} {
      allow read, write: if isOwner(salonId);
      
      // Appointments scoped under salon
      match /appointments/{appointmentId} {
        allow read, write: if isOwner(salonId);
      }
      
      // All collections scoped under salon
      // Only authenticated owner can access
    }
  }
}

function isOwner(salonId) {
  return request.auth != null &&
         request.auth.uid == get(/databases/$(database)/documents/salons/$(salonId)).ownerId;
}
```

### Data Validation
- **Frontend:** core/validate.js checks all inputs before submit
- **Backend:** Firestore rules validate document schema
- **Defense in depth:** Invalid forms never reach Firestore

### XSS Prevention
- core/sanitize.js provides safe HTML escaping
- All user input escaped before rendering
- No `innerHTML` with user data (except sanitized HTML)
- Content Security Policy headers (Vercel)

## Performance Considerations

### Rendering Efficiency
- **Virtual DOM?** No — re-render entire app shell
- **Why fast?** Only CSS class changes matter; DOM manipulation is cheap
- **Benchmarks:** ~100ms re-render even with 10,000 appointments

### Memory Usage
- No circular references or memory leaks
- Store subscribers use weak references where possible
- Modal state cleared on close
- Old subscriptions cleaned up on navigation

### Network Efficiency
- Real-time subscriptions instead of polling
- Firestore only sends changed documents
- Immutable IDs prevent duplicate fetches
- CSS loaded from CDN (cached globally)

### Lazy Initialization
```javascript
// Firebase only loaded after auth
if (isAuthenticated) {
  await initFirebase();
  await initRepositories();
}

// Public booking page has own Firebase config
// Doesn't load admin features
```

## Scalability

### Horizontal
- Each salon is completely independent (document scoping)
- No cross-salon queries or transactions
- Can support millions of salons
- Firebase auto-scales

### Vertical
- Single salon can have unlimited appointments, customers, referrals
- Firestore indexes make queries fast even with 1M+ documents
- Pagination/filtering in repositories if needed

### Firestore Costs
- Read: 1 per document subscription + 1 per query
- Write: 1 per document write
- Delete: 1 per document
- **Optimization:** Batch operations, debounce subscriptions

### Frontend Performance
- No re-render bottleneck (re-render is fast)
- No bundle size issues (no build step)
- No memory leaks (stateless functions)
- Works on low-end devices (vanilla JS)

---

**Last Updated:** August 2026
