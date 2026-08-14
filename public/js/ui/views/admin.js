/**
 * views/admin.js
 * Super Admin: global salon network overview + branch provisioning.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { sectionHeader, actionButton, emptyState, statCard, badge } from '../components.js';

/** Sign-in required: the salon list only loads for an authenticated admin. */
function signInRequired() {
    return `
        <div class="bg-slate-900/50 border border-slate-800 p-6 rounded-2xl text-center">
            <i data-lucide="shield-check" class="w-8 h-8 text-indigo-400 mx-auto mb-3"></i>
            <p class="text-sm font-bold text-slate-100 mb-1">Sign in required</p>
            <p class="text-xs text-slate-400 mb-4 max-w-xs mx-auto">Sign in with your Super Admin account to view every registered salon.</p>
            <div class="flex justify-center">
                ${actionButton('Sign In', { action: 'role', data: { role: 'guest' }, kind: 'indigo', iconName: 'log-in' })}
            </div>
        </div>
    `;
}

/** Loading state while the salon list is being fetched from Firestore. */
function loadingState() {
    return `
        <div class="bg-slate-900/50 border border-slate-800 p-6 rounded-2xl text-center text-slate-500 text-xs">
            <i data-lucide="loader" class="w-5 h-5 mx-auto mb-2 animate-spin"></i>
            <span>Loading salons...</span>
        </div>
    `;
}

/** Error state when the salon list could not be fetched. */
function errorState(message) {
    return `
        <div class="bg-slate-900/50 border border-rose-500/30 p-6 rounded-2xl text-center">
            <i data-lucide="alert-circle" class="w-8 h-8 text-rose-400 mx-auto mb-3"></i>
            <p class="text-sm font-bold text-slate-100 mb-1">Could not load salons</p>
            <p class="text-xs text-rose-400/80 max-w-xs mx-auto">${esc(message)}</p>
        </div>
    `;
}

export function renderSuperAdmin(state) {
    const salons = state.salonsList || [];
    // The Super Admin view can be opened before authentication (guest landing →
    // "Super Admin Oversight"). Only a signed-in admin's Firestore subscription
    // can populate the salon list; in demo mode the seeded preview is shown.
    const signedIn = state.mode === 'demo' || !!state.currentUser;

    const salonsBody = (() => {
        if (!signedIn) return signInRequired();
        if (state.salonsError) return errorState(state.salonsError);
        if (!state.salonsLoaded) return loadingState();
        if (salons.length === 0) return emptyState('No salons have been provisioned yet.');
        return `
            <div class="space-y-2.5">
                ${salons.map((salon) => `
                    <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center justify-between gap-3">
                        <div class="min-w-0">
                            <h4 class="font-bold text-sm text-slate-100 truncate">${esc(salon.name)}</h4>
                            <p class="text-xs text-slate-400 mt-0.5 flex items-center gap-1 truncate"><i data-lucide="map-pin" class="w-3 h-3 shrink-0"></i><span class="truncate">${esc(salon.address || 'Online Studio')}</span></p>
                            <p class="text-[10px] text-slate-500 mt-0.5 truncate">${esc(salon.ownerEmail)}</p>
                        </div>
                        <button data-action="manage-salon" data-id="${escAttr(salon.id)}" data-name="${escAttr(salon.name)}"
                            class="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-semibold rounded-xl transition shadow shrink-0 active:scale-95 touch-manipulation">
                            Manage
                        </button>
                    </div>
                `).join('')}
            </div>
        `;
    })();

    // Provisioning requires a signed-in admin; hide the action before auth.
    const trailing = signedIn
        ? actionButton('Add Salon', { action: 'modal', data: { modal: 'salon' }, iconName: 'plus', kind: 'ghost' })
        : '';

    return `
        <div class="space-y-4">
            ${sectionHeader(
                'All Salons Franchise',
                'Super Admin Global Network Overview',
                trailing,
            )}
            ${salonsBody}
            ${renderReferralOverview(state)}
        </div>
    `;
}

const REFERRAL_STATUS_CLASSES = {
    'Bonus Credited': 'bg-emerald-500/15 text-emerald-400',
    Successful: 'bg-brand-500/15 text-brand-400',
    Pending: 'bg-amber-500/15 text-amber-400',
    Rejected: 'bg-rose-500/15 text-rose-400',
};

/** Super Admin: cross-salon referral activity overview. */
function renderReferralOverview(state) {
    if (state.mode !== 'demo' && !state.currentUser) return '';
    const referrals = state.referralsList || [];
    const total = referrals.length;
    const successful = referrals.filter((r) => r.status === 'Successful' || r.status === 'Bonus Credited').length;
    const pending = referrals.filter((r) => r.status === 'Pending').length;
    const bonus = referrals
        .filter((r) => r.status === 'Bonus Credited')
        .reduce((sum, r) => sum + (Number(r.bonusAmount) || 0), 0);
    const salonName = (id) => (state.salonsList || []).find((s) => s.id === id)?.name || id || '—';

    return `
        <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
            <h3 class="font-bold text-xs text-slate-100 flex items-center space-x-1.5 mb-3">
                <i data-lucide="megaphone" class="w-3.5 h-3.5 text-brand-400"></i>
                <span>Referral Activity</span>
            </h3>
            <div class="grid grid-cols-2 gap-2">
                ${statCard('Total Referrals', total)}
                ${statCard('Successful', successful, 'text-emerald-400')}
                ${statCard('Pending', pending, 'text-amber-400')}
                ${statCard('Bonus Earned (pts)', bonus, 'text-brand-400')}
            </div>
            ${referrals.length === 0
                ? `<p class="text-[10px] text-slate-500 mt-3">No referral activity across the network yet.</p>`
                : `
                    <div class="mt-3 space-y-2">
                        ${referrals.map((r) => `
                            <div class="flex items-center justify-between gap-3 bg-slate-950/60 border border-slate-800/60 rounded-xl px-3 py-2.5">
                                <div class="min-w-0">
                                    <p class="text-xs font-semibold text-slate-100 truncate">${esc(r.referredCustomerName || 'A friend')}</p>
                                    <p class="text-[10px] text-slate-500 truncate">${esc(salonName(r.referredSalonId))} · referred by ${esc(r.referringCustomerName || 'a salon')}</p>
                                </div>
                                ${badge(r.status, REFERRAL_STATUS_CLASSES[r.status] || 'bg-slate-500/15 text-slate-400')}
                            </div>
                        `).join('')}
                    </div>
                `}
        </div>
    `;
}

export default renderSuperAdmin;
