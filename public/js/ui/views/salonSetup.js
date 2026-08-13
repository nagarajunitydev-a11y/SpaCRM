/**
 * views/salonSetup.js
 * First-run view for a salon owner whose account has no salon yet. Reuses the
 * existing 'salon' provisioning modal so the owner can bootstrap their first
 * branch against real Firestore (the reservation path enforces ownerId).
 */

import { actionButton } from '../components.js';

export function renderSalonSetup() {
    return `
        <div class="flex-1 flex flex-col items-center justify-center text-center p-6 min-h-[50vh]">
            <div class="w-16 h-16 rounded-3xl bg-gradient-to-tr from-brand-600 to-brand-400 flex items-center justify-center shadow-2xl shadow-brand-500/40 mb-5 text-white">
                <i data-lucide="store" class="w-8 h-8"></i>
            </div>
            <h2 class="text-lg font-extrabold text-white mb-2">Set up your salon</h2>
            <p class="text-xs text-slate-400 mb-6 max-w-xs">Welcome! Your account has no salon yet. Create your first branch to start managing clients, services, staff and bookings.</p>
            ${actionButton('Create My Salon Branch', { action: 'modal', data: { modal: 'salon' }, iconName: 'plus' })}
        </div>
    `;
}

export default renderSalonSetup;