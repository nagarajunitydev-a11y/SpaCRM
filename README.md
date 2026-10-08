# SpaCRM - Qvrix Luxe Salon & Spa CRM

A modern, offline-capable Progressive Web App (PWA) for salon and spa management with advanced features including customer management, appointment scheduling, referral programs, and public online booking.

**Version:** 2.2.0

## Quick Facts

- **No build step** — vanilla ES modules, Tailwind CDN
- **No runtime dependencies in the browser** — only the Firebase SDK (the `api/` payment functions use `firebase-admin`)
- **Offline-first** — works completely offline with Firestore local cache
- **Multi-platform** — Web PWA + Android TWA (Trusted Web Activity)
- **Atomic transactions** — referral wallet, payment redemption, and booking operations
- **Demo mode** — test without Firebase configuration

## Key Features

### 👥 Customer Management
- Customer profiles with phone, email, referral codes
- Search and filter capabilities
- Reward points and referral wallet tracking

### 📅 Appointment Scheduling
- Full appointment lifecycle management
- Staff scheduling with conflict detection
- Service catalog with pricing and duration
- Appointment status tracking (pending, confirmed, completed, cancelled)

### 💰 Referral System
- Unique referral codes per customer
- Configurable reward programs (fixed or percentage-based)
- Automatic reward crediting on qualifying invoices
- Atomic wallet transactions with immutable ledger history
- Redemption with invoice percentage caps
- Automatic expiry management

### 💳 Payment & Revenue Tracking
- Invoice payment collection with wallet redemption preview
- Referral wallet balance management
- Revenue analytics (daily, monthly)
- Payment method tracking and refund reversal

### 🏢 Multi-Branch
- Owners manage branches from the **Branches** tab: add, edit, activate/deactivate and switch. **Add Branch** stays available after the first branch is created.
- A branch is a `salons/{branchId}` document; customers, services, staff, appointments, billing, referral wallets, attendance and booking settings live under it, so branch data is isolated by path.
- Required fields: name (unique per owner, case-insensitive), phone, address, opening/closing time.
- Plan limits (`core/branches.js`): Basic = 1 branch, Pro = 3, Premium = unlimited. Deactivated branches still count toward the limit. Only a super admin can change a salon's plan (Plan dropdown on the All Salons screen).
- Existing single-branch salons need no migration: missing `plan`/`active`/hours fields default to Basic / active / unset.
- Deactivated branches disappear from the switcher and stop accepting public bookings; their data is kept.

### 💎 Subscriptions & Payments
Plans: **Free Trial** (30 days, no card, Standard-level), **Basic** ₹399/mo · ₹3,990/yr, **Standard** ₹799/mo · ₹7,990/yr (most popular), **Premium** ₹1,499/mo · ₹14,990/yr, **Business** ₹2,999/mo · ₹29,990/yr (multiple branches, unlimited staff/customers). Prices, limits and features live in `core/plans.js` and can be overridden by a super admin (Subscriptions → Plans), stored in Firestore `plans/{planId}`.

How it fits together:
- `core/subscriptionState.js` — status state machine (`TRIAL / ACTIVE / PAST_DUE / GRACE_PERIOD / EXPIRED / SUSPENDED / CANCELLED`) and idempotent payment transitions (`PENDING / SUCCESS / FAILED / CANCELLED / REFUNDED`). Shared by browser and server.
- `core/featureAccess.js` — **FeatureAccessService**: the single `can(feature)` / `canCreate('staff'|'customer'|'branch')` the UI and repositories ask. `state.access` holds the live snapshot.
- `services/subscriptionService.js` — **SubscriptionService**: listeners, automatic 30-day trial, access refresh.
- `services/payment/` — browser **PaymentGateway** abstraction (`razorpayGateway.js`) and `paymentService.js`.
- `api/` (Vercel Functions) — `create-order`, `verify`, `cancel`, `webhook`, plus a daily cron. Gateway modules live in `api/_lib/gateways/`; switch gateways with `PAYMENT_GATEWAY`.
- Firestore: `subscriptions/{ownerUid}` with `payments/` and `events/` subcollections, `plans/{planId}`. Browsers can only create a ~30-day TRIAL once and update usage counters; everything else is written by the server (see `firestore.rules`).

Security properties: the amount is computed server-side from the plan catalog; a plan is activated only after the gateway signature is verified **and** the payment is fetched from the gateway (or a signed webhook arrives); repeated callbacks/refreshes are no-ops; failures and cancellations never change an active subscription; card/UPI details are entered on the gateway's own page and never stored.

Setup (once):
1. Create a Razorpay account, copy **test** keys, and add a webhook to `https://<domain>/api/subscription/webhook` for `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`.
2. Set the variables from `.env.example` in Vercel (including a Firebase service account) and redeploy.
3. `npm run deploy:rules` to publish the new Firestore rules.
4. Local testing of payments needs the API routes: use `vercel dev` (the plain `npm run serve` has no `/api`, so checkout shows "Payments unavailable").

Renewals are prepaid: each period is one payment and the owner is reminded in-app (banner from 7 days before) — there is no automatic card/UPI auto-debit. Downgrades take effect once the paid period ends; upgrades start immediately with credit for unused time. Expired accounts become **view-only** — no data is ever deleted.

Demo mode has no billing (everything unlocked). Append `?demoPlan=trial|basic|standard|premium|business|expired` to the URL to preview a plan's gating.

### 🎁 Public Booking
- Public, no-login booking page
- Shareable links and QR codes
- Service selection → staff assignment → date/time → customer details workflow
- Referral code application at booking
- Availability slots based on working hours and staff conflicts

### 🏆 Loyalty Rewards
- Tiered reward programs (100/250/500 points → vouchers)
- Transaction history tracking
- Redemption management

### 📱 Platform Support
- PWA (Progressive Web App) for web browsers
- Android TWA for Play Store distribution
- Complete offline functionality
- Network status detection

## Technology Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Vanilla JavaScript (ES modules), Tailwind CSS |
| **Backend** | Firebase (Firestore + Authentication) |
| **Hosting** | Vercel (preview & production deployments) |
| **Database** | Firestore with offline persistence |
| **Service Worker** | Cache-first for app shell, network-first for API |
| **PWA** | Web manifest, app shell architecture |

## Project Structure

```
public/
├── index.html                          # Main SPA entry point
├── book.html                           # Public booking page
├── js/
│   ├── main.js                         # Bootstrap & central event delegation
│   ├── config.js                       # Configuration constants
│   ├── firebase-config.dev.js          # Firebase development config
│   ├── sw.js                           # Service worker (caching, offline)
│   ├── core/                           # Pure business logic modules (13 modules)
│   │   ├── store.js                    # Observable state management
│   │   ├── router.js                   # Navigation & role-based routing
│   │   ├── referral.js                 # Referral rules engine
│   │   ├── revenue.js                  # Revenue calculation
│   │   ├── wallet.js                   # Wallet ledger math
│   │   ├── rewards.js                  # Loyalty rewards configuration
│   │   ├── validate.js                 # Form validation rules
│   │   ├── sanitize.js                 # XSS prevention
│   │   ├── utils.js                    # Helper utilities
│   │   ├── draft.js                    # Form draft persistence
│   │   ├── scheduling.js               # Appointment slot generation
│   │   ├── bookingConfig.js            # Public booking rules
│   │   └── platform.js                 # Platform detection
│   ├── services/                       # Data layer repositories (18 services)
│   │   ├── firebase.js                 # Firebase SDK initialization
│   │   ├── db.js                       # Low-level Firestore access
│   │   ├── authService.js              # Authentication
│   │   ├── salonsRepository.js         # Salon data
│   │   ├── customersRepository.js      # Customer data
│   │   ├── appointmentsRepository.js   # Appointment CRUD
│   │   ├── staffRepository.js          # Staff management
│   │   ├── servicesRepository.js       # Service catalog
│   │   ├── referralsRepository.js      # Referral tracking
│   │   ├── referralService.js          # Referral orchestration
│   │   ├── walletRepository.js         # Wallet transactions
│   │   ├── rewardTransactionsRepository.js # Loyalty rewards
│   │   └── [other repositories...]
│   ├── ui/
│   │   ├── views/                      # Screen renderers (13 views)
│   │   │   ├── login.js                # Sign-in/sign-up
│   │   │   ├── dashboard.js            # Salon overview
│   │   │   ├── appointments.js         # Appointment management
│   │   │   ├── customers.js            # Customer list
│   │   │   ├── referrals.js            # Referral dashboard
│   │   │   ├── payment.js              # Payment collection
│   │   │   └── [other views...]
│   │   ├── components.js               # Shared UI components
│   │   ├── icons.js                    # Lucide icon definitions
│   │   └── notification.js             # Toast notifications
│   └── public-booking/                 # Public booking app
│       ├── publicBookingApp.js         # Booking bootstrap
│       └── publicBookingView.js        # Booking wizard UI
├── styles/
│   ├── tailwind.css                    # Generated (run: npm run build:css)
│   └── main.css                        # Custom styles
└── vendor/
    ├── lucide.min.js                   # Icon library
    └── qrcode.js                       # QR code generation
```

## Getting Started

### Prerequisites
- Node.js 14+ (for Tailwind build and tests)
- Python 3 (for local dev server)
- Firebase project (for production)

### Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/nagarajunitydev-a11y/SpaCRM.git
   cd SpaCRM
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build Tailwind CSS (if styles changed)**
   ```bash
   npm run build:css
   ```

4. **Start dev server**
   ```bash
   npm run serve
   ```
   App runs at `http://localhost:5500`

5. **Run tests**
   ```bash
   npm test
   ```

### Running in the Browser with Firestore (real backend)

By default the app opens in demo mode. To run it against the real Firebase project (Auth + Firestore):

1. Start the dev server: `npm run serve`
2. Open **http://127.0.0.1:5500/?firebase=1** in a browser.

The `?firebase=1` flag makes `public/js/firebase-config.dev.js` inject the web config for project `crmapp-1299dddb`. Without the flag, the app stays in demo mode (this keeps the e2e tests unaffected).

Verify it worked: the browser console shows `[AUTH] Auth state changed: user is null` and there is no "running in demo mode" warning. Then sign in or choose **Create New Account**.

Notes:
- Use `127.0.0.1` (or `localhost`) exactly as listed under Firebase Console → Authentication → Settings → **Authorized domains**. Otherwise sign-in fails with `auth/unauthorized-domain`.
- Firestore access is governed by `firestore.rules`. After editing it, run `npm run deploy:rules`.
- Data is cached offline in IndexedDB. Use a single tab per browser profile (single-tab persistence).
- To use a different Firebase project, edit the config object in `public/js/firebase-config.dev.js`.

### Demo Mode
To test without Firebase configuration, just open `http://127.0.0.1:5500/` (no `?firebase=1`).

## Development Workflow

### Branch Strategy
- **Main branch** → Automatically deploys to production on every push
- **Feature branches** (e.g., `referralsystem`) → Preview deployments only

**⚠️ CRITICAL:** Never push to main. Always work on feature branches and create PRs for review.

### Testing
The project includes comprehensive unit and e2e tests:
```bash
npm test  # Runs all tests: syntax check, unit tests, e2e tests
```

For specific test suites:
- `node scripts/syntax-check.mjs` — Validate JavaScript syntax
- `node scripts/unit-validate.mjs` — Validation rule tests
- `node scripts/unit-revenue.mjs` — Revenue calculation tests
- `node scripts/unit-referral.mjs` — Referral system tests (125+ tests)
- `node scripts/e2e-revenue.mjs` — Revenue e2e tests
- `node scripts/e2e-referral.mjs` — Referral workflow e2e tests
- `node scripts/e2e-public-booking.mjs` — Public booking e2e tests
- `node scripts/e2e-smoke.mjs` — Basic smoke tests

### Deployment
```bash
# Deploy only Firestore rules
npm run deploy:rules

# Deploy only hosting
npm run deploy:hosting

# Deploy everything
npm run deploy:all
```

## Architecture Patterns

### State Management
Minimal observable store with no external dependencies:
- Central `store` singleton in `core/store.js`
- State patches trigger subscribers which re-render app shell
- Modal and draft state kept outside store to prevent mid-interaction re-renders

### Data Flow (Unidirectional)
```
View → Event Delegation (main.js) → Action Handler → Repository → Firestore
Firestore subscription → Repository → Store → Re-render
```

### Transaction Safety
Atomic Firestore transactions ensure multi-document consistency:
- Referral settlement: referral + wallet + customer updates together
- Public booking: customer find-or-create + appointment + referral credit together

### Offline-First Architecture
- Firestore local cache for automatic offline persistence
- Service Worker for app shell caching (cache-first strategy)
- Draft forms saved to LocalStorage
- Network status detection and UI feedback

## Documentation Files

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — System design, data flow, and patterns
- **[MODULES.md](./MODULES.md)** — Core business logic modules
- **[SERVICES.md](./SERVICES.md)** — Data layer repositories and services
- **[VIEWS.md](./VIEWS.md)** — UI screens and views
- **[FEATURES.md](./FEATURES.md)** — Feature deep-dives (referrals, public booking, payments)
- **[API.md](./API.md)** — Key module APIs and usage examples
- **[SETUP.md](./SETUP.md)** — Firebase configuration and deployment
- **[TESTING.md](./TESTING.md)** — Testing guide and test suites

## Key Code Files

### Core Business Logic
- [core/referral.js](./public/js/core/referral.js) — Referral workflow and validation (350+ lines)
- [core/revenue.js](./public/js/core/revenue.js) — Revenue calculation rules
- [core/wallet.js](./public/js/core/wallet.js) — Wallet ledger math and redemption logic
- [core/validate.js](./public/js/core/validate.js) — Form validation rules
- [core/scheduling.js](./public/js/core/scheduling.js) — Appointment slot generation

### Data Layer
- [services/referralService.js](./public/js/services/referralService.js) — Referral orchestration (only module that moves money)
- [services/appointmentsRepository.js](./public/js/services/appointmentsRepository.js) — Appointment CRUD
- [services/publicBookingService.js](./public/js/services/publicBookingService.js) — Public booking backend

### UI Screens
- [ui/views/referrals.js](./public/js/ui/views/referrals.js) — Referral dashboard and settings
- [ui/views/payment.js](./public/js/ui/views/payment.js) — Payment collection and wallet redemption
- [ui/views/dashboard.js](./public/js/ui/views/dashboard.js) — Salon overview and analytics

## Performance

- **No build step** — modules load directly, no bundler overhead
- **Minimal CSS** — Tailwind CSS loaded from CDN, production CSS is 45KB minified
- **Efficient re-renders** — Observable store only re-renders on state changes
- **Service Worker** — App shell cached, static assets served from cache
- **Lazy initialization** — Firebase only loaded when authenticated
- **Offline-first** — Works completely without network

## Browser Support

- Modern browsers with ES2020+ support
- Chrome/Edge (recommended)
- Firefox, Safari
- Android Chrome (PWA)

## Contributing

1. Create a feature branch from `main`
2. Make changes and test locally
3. Create a PR with clear description
4. Verify preview deployment works
5. After review, merge to main
6. Main is automatically deployed to production

## License

Proprietary — Qvrix Luxe

## Support

For issues, questions, or feature requests, please open an issue on GitHub.

---

**Last Updated:** August 2026
