/**
 * sw.js
 * Service worker: app-shell caching for offline / flaky-network support.
 * Strategy: cache-first for static assets, network-first with cache fallback
 * for the navigation request. Everything else (Firebase CDN, Google Fonts)
 * is allowed through the network only, so auth and Firestore are never served
 * stale from an unexpected origin.
 */

const CACHE_NAME = 'qvrix-luxe-v4';
const APP_SHELL = [
    '/',
    '/index.html',
    '/logo.png',
    '/styles/tailwind.css',
    '/styles/main.css',
    '/vendor/lucide.min.js',
    '/manifest.webmanifest',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/js/main.js',
    '/js/config.js',
    '/js/firebase-config.dev.js',
    '/js/core/sanitize.js',
    '/js/core/store.js',
    '/js/core/router.js',
    '/js/core/utils.js',
    '/js/core/rewards.js',
    '/js/core/revenue.js',
    '/js/core/validate.js',
    '/js/core/referral.js',
    '/js/core/wallet.js',
    '/js/core/scheduling.js',
    '/js/core/bookingConfig.js',
    '/js/services/firebase.js',
    '/js/services/authService.js',
    '/js/services/db.js',
    '/js/services/scopedRepository.js',
    '/js/services/salonsRepository.js',
    '/js/services/customersRepository.js',
    '/js/services/servicesRepository.js',
    '/js/services/staffRepository.js',
    '/js/services/appointmentsRepository.js',
    '/js/services/referralsRepository.js',
    '/js/services/referralCodesRepository.js',
    '/js/services/referralSettingsRepository.js',
    '/js/services/walletRepository.js',
    '/js/services/referralService.js',
    '/js/services/bookingSettingsRepository.js',
    '/js/services/seedData.js',
    '/js/ui/notification.js',
    '/js/ui/icons.js',
    '/js/ui/components.js',
    '/js/ui/views/login.js',
    '/js/ui/views/dashboard.js',
    '/js/ui/views/appointments.js',
    '/js/ui/views/customers.js',
    '/js/ui/views/services.js',
    '/js/ui/views/staff.js',
    '/js/ui/views/admin.js',
    '/js/ui/views/salonSetup.js',
    '/js/ui/views/modals.js',
    '/js/ui/views/referrals.js',
    '/js/ui/views/payment.js',
    '/js/ui/views/customerProfile.js',
    '/js/ui/views/bookingLink.js',
    '/vendor/qrcode.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys
                .filter((key) => key !== CACHE_NAME)
                .map((key) => caches.delete(key)),
            ),
        ).then(() => self.clients.claim()),
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;

    // Only handle GET.
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Cross-origin (Firebase CDN, Google Fonts, Tailwind, Lucide):
    // network-only. Never cache, never block offline (fail through).
    if (url.origin !== self.location.origin) {
        return;
    }

    // Public booking page: network-only, never cached. Availability (slots,
    // working hours, catalog) is time-sensitive and must always be read
    // live — and falling back to the cached CRM index.html here (this
    // service worker's own offline behaviour for every OTHER path) would
    // silently show a customer the wrong page instead of a clear error.
    if (url.pathname === '/book.html' || url.pathname.startsWith('/book/')) {
        return;
    }

    // Navigation requests: network-first, fall back to cached index.html.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
                    return response;
                })
                .catch(() =>
                    caches.match('/index.html').then((cached) => cached || caches.match('/')),
                ),
        );
        return;
    }

    // Static assets: cache-first with background refresh.
    event.respondWith(
        caches.match(request).then((cached) => {
            const network = fetch(request)
                .then((response) => {
                    if (response && response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => cached);
            return cached || network;
        }),
    );
});
