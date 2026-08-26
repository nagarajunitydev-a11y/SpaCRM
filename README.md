# SpaCRM - Qvrix Luxe Salon & Spa CRM

A modern, offline-capable Progressive Web App (PWA) for salon and spa management with advanced features including customer management, appointment scheduling, referral programs, and public online booking.

**Version:** 2.2.0

## Quick Facts

- **No build step** — vanilla ES modules, Tailwind CDN
- **No runtime dependencies** — only Firebase SDK
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

### Demo Mode
To test without Firebase configuration, set `DEMO_MODE = true` in `public/js/config.js`.

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
