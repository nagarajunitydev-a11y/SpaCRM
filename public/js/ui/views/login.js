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

import { formField, textInput, passwordInput } from '../components.js';
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
                <div class="mb-5 mx-auto flex items-center justify-center">
                    <img src="/logo.png" alt="Qvrix GlowOS" class="w-24 h-24 object-contain">
                </div>
                <h2 class="text-2xl font-extrabold text-white tracking-tight mb-2">Qvrix GlowOS</h2>
                <p class="text-xs text-slate-400 max-w-xs mx-auto">${isSignup ? 'Create an account' : 'Sign in to your Qvrix GlowOS account'}</p>
            </div>

            <div class="w-full space-y-4">
                <form data-action="email-auth" class="space-y-3.5">
                    ${isSignup
                        ? formField('Salon Name', textInput('salonName', 'Luxe Glow Downtown', { required: true }))
                        : ''}
                    ${formField('Email Address', textInput('email', 'owner@luxeglow.com', { type: 'email', autocomplete: 'email' }))}
                    ${formField('Password', passwordInput('password', '••••••••', { autocomplete: isSignup ? 'new-password' : 'current-password' }))}
                    ${!isSignup ? `
                    <p class="text-right -mt-1.5">
                        <button type="button" data-action="show-forgot-password" class="text-[10px] text-brand-400 font-semibold active:scale-95 touch-manipulation">
                            Forgot Password?
                        </button>
                    </p>
                    ` : ''}
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

/** Shared shell (logo + heading) so the auth screens look like one flow. */
function authShell(heading, subhead, bodyHtml) {
    return `
        <div class="flex-1 flex flex-col justify-center p-6 bg-gradient-to-b from-slate-900 via-slate-950 to-black text-slate-100 relative h-full overflow-y-auto no-scrollbar">
            <div class="absolute -top-24 -left-24 w-72 h-72 bg-brand-600/15 rounded-full blur-3xl pointer-events-none" aria-hidden="true"></div>

            <div class="text-center mb-8 mt-4">
                <div class="mb-5 mx-auto flex items-center justify-center">
                    <img src="/logo.png" alt="Qvrix GlowOS" class="w-24 h-24 object-contain">
                </div>
                <h2 class="text-2xl font-extrabold text-white tracking-tight mb-2">${heading}</h2>
                <p class="text-xs text-slate-400 max-w-xs mx-auto">${subhead}</p>
            </div>

            <div class="w-full space-y-4">
                ${bodyHtml}
            </div>
        </div>
    `;
}

/**
 * Forgot Password screen: collects an email and requests a reset link.
 * `state.forgotSent` switches the form for a generic confirmation message —
 * this never reveals whether the address is actually registered.
 */
export function renderForgotPassword(state) {
    if (state.forgotSent) {
        return authShell('Check Your Email', 'If an account exists for this email, a password reset link has been sent.', `
            <button data-action="back-to-login" class="w-full py-4 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition active:scale-[0.98] touch-manipulation">
                Back to Sign In
            </button>
        `);
    }

    return authShell('Reset Password', 'Enter your registered email and we’ll send you a reset link.', `
        <form data-action="forgot-password" class="space-y-3.5">
            ${formField('Email Address', textInput('email', 'owner@luxeglow.com', { type: 'email', autocomplete: 'email' }))}
            <button type="submit" disabled class="w-full py-4 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none">
                Send Reset Link
            </button>
        </form>
        <p class="text-center text-[10px] text-slate-500">
            <button data-action="back-to-login" class="text-brand-400 font-semibold active:scale-95 touch-manipulation">Back to Sign In</button>
        </p>
    `);
}

/**
 * Reset Password screen, reached via the emailed Firebase reset link.
 * `state.resetError` (an expired/invalid oobCode) shows a dead-end message
 * instead of a form nobody could submit successfully. `state.resetDone`
 * shows a success message pointing back to sign-in.
 */
export function renderResetPassword(state) {
    if (state.resetError) {
        return authShell('Reset Link Invalid', state.resetError, `
            <button data-action="show-forgot-password" class="w-full py-4 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition active:scale-[0.98] touch-manipulation">
                Request a New Link
            </button>
            <p class="text-center text-[10px] text-slate-500">
                <button data-action="back-to-login" class="text-brand-400 font-semibold active:scale-95 touch-manipulation">Back to Sign In</button>
            </p>
        `);
    }

    if (state.resetDone) {
        return authShell('Password Updated', 'Your password has been reset. Sign in with your new password.', `
            <button data-action="back-to-login" class="w-full py-4 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition active:scale-[0.98] touch-manipulation">
                Back to Sign In
            </button>
        `);
    }

    const subhead = state.resetEmail ? `Set a new password for ${state.resetEmail}.` : 'Set a new password for your account.';
    return authShell('Set New Password', subhead, `
        <form data-action="reset-password" class="space-y-3.5">
            ${formField('New Password', passwordInput('password', '••••••••', { autocomplete: 'new-password' }))}
            ${formField('Confirm New Password', passwordInput('confirmPassword', '••••••••', { autocomplete: 'new-password' }))}
            <button type="submit" disabled class="w-full py-4 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none">
                Reset Password
            </button>
        </form>
    `);
}

export default renderLogin;
