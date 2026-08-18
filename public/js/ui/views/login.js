/**
 * views/login.js
 * Sign-in screen: email/password (sign-up + sign-in).
 * Google Sign-In has been removed from all platforms.
 * There is no manual role selection — after sign-in the user's role is read
 * from their Firestore `users/{uid}` profile and the correct dashboard
 * (Salon Owner or Super Admin) is opened automatically.
 *
 * Android TWA adaptations (detected via platform=android query param):
 *  - Sign In is always the default mode.
 *  - A "Create Account" button is placed directly below the Sign In button.
 */

import { formField, textInput } from '../components.js';
import { isAndroidTwa } from '../../core/platform.js';

export function renderLogin(state) {
    const isTwa = isAndroidTwa();
    const isSignup = state.authFormMode === 'signup';

    // Demo mode has no real backend, so the Super Admin dashboard can be
    // previewed from a small link instead of a role-selection screen. In
    // production the role is granted only via the Firestore user profile.
    const demoPreview = state.mode === 'demo'
        ? `
            <p class="text-center text-[10px] text-slate-500 mt-6">
                Demo preview &mdash; <button data-action="role" data-role="super_admin" class="text-indigo-400 font-semibold active:scale-95 touch-manipulation">open the Super Admin dashboard</button>
            </p>
        `
        : '';

    return `
        <div class="flex-1 flex flex-col justify-center p-6 bg-gradient-to-b from-slate-900 via-slate-950 to-black text-slate-100 relative h-full overflow-y-auto no-scrollbar">
            <div class="absolute -top-24 -left-24 w-72 h-72 bg-brand-600/15 rounded-full blur-3xl pointer-events-none" aria-hidden="true"></div>

            <div class="text-center mb-8 mt-4">
                <div class="w-16 h-16 rounded-3xl bg-gradient-to-tr from-brand-600 to-brand-400 flex items-center justify-center shadow-2xl shadow-brand-500/40 mb-5 text-white mx-auto">
                    <i data-lucide="scissors" class="w-8 h-8"></i>
                </div>
                <h2 class="text-2xl font-extrabold text-white tracking-tight mb-2">Qvrix Luxe Salon CRM</h2>
                <p class="text-xs text-slate-400 max-w-xs mx-auto">${isSignup ? 'Create an account' : 'Sign in to your Qvrix Luxe account'}</p>
            </div>

            <div class="w-full space-y-4">
                <form data-action="email-auth" class="space-y-3.5">
                    ${isSignup
                        ? formField('Salon Name', textInput('salonName', 'Luxe Glow Downtown', { required: true }))
                        : ''}
                    ${formField('Email Address', textInput('email', 'owner@luxeglow.com', { type: 'email', autocomplete: 'email' }))}
                    ${formField('Password', textInput('password', '••••••••', { type: 'password', autocomplete: isSignup ? 'new-password' : 'current-password' }))}
                    <button type="submit" disabled class="w-full py-4 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none">
                        ${isSignup ? 'Create Account &amp; Login' : 'Sign In'}
                    </button>
                </form>

                ${isTwa && !isSignup ? `
                <button data-action="toggle-form-mode" data-mode="signup" class="w-full py-3.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs rounded-xl border border-slate-700 transition active:scale-[0.98] touch-manipulation">
                    Create Account
                </button>
                ` : ''}

                ${isTwa && isSignup ? `
                <button data-action="toggle-form-mode" data-mode="signin" class="w-full py-3.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs rounded-xl border border-slate-700 transition active:scale-[0.98] touch-manipulation">
                    Back to Sign In
                </button>
                ` : ''}

                ${!isTwa ? `
                <p class="text-center text-[10px] text-slate-500">
                    ${isSignup ? 'Already have an account?' : "Don't have an account?"}
                    <button data-action="toggle-form-mode" data-mode="${isSignup ? 'signin' : 'signup'}" class="text-brand-400 font-semibold active:scale-95 touch-manipulation">
                        ${isSignup ? 'Sign In' : 'Create New Account'}
                    </button>
                </p>
                ` : ''}
            </div>

            ${demoPreview}
        </div>
    `;
}

export default renderLogin;
