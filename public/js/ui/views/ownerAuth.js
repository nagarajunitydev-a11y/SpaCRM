/**
 * views/ownerAuth.js
 * Owner access screen: Google Sign-In or email/password (sign-up + sign-in).
 */

import { formField, textInput } from '../components.js';
import { esc } from '../../core/sanitize.js';

export function renderOwnerAuth(state) {
    const isSignup = (state.authFormMode || 'signup') !== 'signin';

    return `
        <div class="flex-1 flex flex-col justify-center p-6 bg-slate-950 text-slate-100 relative h-full overflow-y-auto no-scrollbar">
            <button data-action="role" data-role="guest" aria-label="Back" class="absolute top-6 left-6 w-9 h-9 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-white transition active:scale-95 touch-manipulation">
                <i data-lucide="arrow-left" class="w-4 h-4"></i>
            </button>

            <div class="text-center mb-8 mt-6">
                <h2 class="text-xl font-extrabold text-white">Owner Access</h2>
                <p class="text-xs text-slate-400 mt-1">${isSignup ? 'Sign in with Google or create an account' : 'Sign in to your LuxeGlow account'}</p>
            </div>

            <div class="space-y-4">
                <button data-action="google-signin" class="w-full py-3.5 px-4 bg-white hover:bg-slate-100 text-slate-900 font-bold text-xs rounded-xl shadow-lg transition flex items-center justify-center space-x-3 active:scale-[0.98] touch-manipulation">
                    <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                        <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"/>
                        <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.13 0-5.78-2.11-6.73-4.96H1.2v3.15C3.18 21.34 7.22 24 12 24z"/>
                        <path fill="#FBBC05" d="M5.27 14.24c-.25-.72-.38-1.49-.38-2.24s.13-1.52.38-2.24V6.6H1.2C.43 8.14 0 9.87 0 12s.43 3.86 1.2 5.4l4.07-3.16z"/>
                        <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.22 0 3.18 2.66 1.2 6.6l4.07 3.15c.95-2.85 3.6-4.96 6.73-4.96z"/>
                    </svg>
                    <span>Continue with Google</span>
                </button>

                <div class="flex items-center my-4">
                    <div class="flex-1 border-t border-slate-800"></div>
                    <span class="px-3 text-[10px] uppercase font-semibold text-slate-500">Or email account</span>
                    <div class="flex-1 border-t border-slate-800"></div>
                </div>

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

                <p class="text-center text-[10px] text-slate-500">
                    ${isSignup ? 'Already have an account?' : 'New to LuxeGlow?'}
                    <button data-action="toggle-form-mode" data-mode="${isSignup ? 'signin' : 'signup'}" class="text-brand-400 font-semibold">
                        ${isSignup ? 'Sign in' : 'Create account'}
                    </button>
                </p>
            </div>
        </div>
    `;
}

export default renderOwnerAuth;
