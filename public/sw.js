/**
 * sw.js
 * Service worker: app-shell caching for offline / flaky-network support.
 * Strategy: cache-first for static assets, network-first with cache fallback
 * for the navigation request. Everything else (Firebase CDN, Google Fonts)
 * is allowed through the network only, so auth and Firestore are never served
 * stale from an unexpected origin.
 */

const CACHE_NAME = 'luxeglow-crm-v6';
const APP_SHELL = [
    '/',
    '/index.html',
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
    '/js/core/debug.js',
    '/js/core/validate.js',
    '/js/services/firebase.js',
    '/js/services/authService.js',
    '/js/services/db.js',
    '/js/services/scopedRepository.js',
    '/js/services/salonsRepository.js',
    '/js/services/customersRepository.js',
    '/js/services/servicesRepository.js',
    '/js/services/staffRepository.js',
    '/js/services/appointmentsRepository.js',
    '/js/services/referralCodesRepository.js',
    '/js/services/referralsRepository.js',
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
