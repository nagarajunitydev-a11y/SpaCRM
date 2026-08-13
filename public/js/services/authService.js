/**
 * authService.js
 * Authentication service. All Firebase auth interaction lives here — UI
 * components never touch the auth SDK directly.
 *
 * Modes:
 *  - demo:  no real backend; the local preview can simulate an owner session
 *           for offline browsing. Google Sign-In NEVER fabricates a session in
 *           demo mode — it requires real Firebase OAuth and returns a clear
 *           error instead. Anonymous sign-in is likewise never faked.
 *  - firebase: email/password, real Google OAuth (popup on desktop, redirect
 *    on mobile), anonymous, custom token and sign-out against the injected
 *    Firebase project. The user's real profile (uid, email, displayName) is
 *    stored in Firestore `users/{uid}` (protected by security rules), never in
 *    localStorage. The role is read from that profile (grant super_admin via
 *    Firestore).
 */

import { getFirebase, isDemoMode } from './firebase.js';
import { getInitialAuthToken } from '../config.js';
import { store } from '../core/store.js';
import { makeId } from '../core/utils.js';
import showNotification from '../ui/notification.js';
import {
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    signInWithCustomToken,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signInAnonymously,
    GoogleAuthProvider,
    signOut as fbSignOut,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import {
    doc as fbDoc,
    getDoc,
    setDoc as fbSetDoc,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

/** Google OAuth provider configured for real account sign-in. */
function googleProvider() {
    const provider = new GoogleAuthProvider();
    // Always let the user choose which Google account to sign in with.
    provider.setCustomParameters({ prompt: 'select_account' });
    provider.addScope('email');
    provider.addScope('profile');
    return provider;
}

/**
 * Popup sign-in is unreliable on mobile browsers (iOS Safari blocks new
 * windows). Use the full-page redirect flow there; keep the smoother popup on
 * desktop.
 */
function isMobileDevice() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    return /Android|iPhone|iPad|iPod|Mobile|SamsungBrowser|Tablet/i.test(ua)
        || (navigator.maxTouchPoints > 0 && window.innerWidth <= 900);
}

/** Map a Firebase User to a plain safe object for the store. */
function toSafeUser(user) {
    if (!user) return null;
    return {
        uid: user.uid,
        email: user.email || '',
        displayName: user.displayName || user.email || 'Salon Owner',
        isAnonymous: user.isAnonymous === true,
    };
}

/** In-flight profile loads, keyed by uid, so concurrent auth-state events (a
 * popup result plus the onAuthStateChanged listener) share one Firestore read
 * and can never race two profile creations. */
const profileLoads = new Map();

/** Ensure a users/{uid} profile document exists for the signed-in user. */
export function ensureUserProfile(user) {
    const uid = user && user.uid;
    if (!uid) return Promise.resolve(null);
    if (profileLoads.has(uid)) return profileLoads.get(uid);
    const pending = doEnsureUserProfile(user).finally(() => profileLoads.delete(uid));
    profileLoads.set(uid, pending);
    return pending;
}

async function doEnsureUserProfile(user) {
    const fb = getFirebase();
    if (!fb || !user) return null;

    const profileRef = fbDoc(fb.db, 'users', user.uid);
    try {
        const snap = await getDoc(profileRef);
        if (snap.exists()) {
            const data = snap.data();
            return {
                uid: user.uid,
                role: data.role === 'super_admin' ? 'super_admin' : 'salon_owner',
                ...data,
            };
        }
        const profile = {
            role: 'salon_owner',
            email: user.email || '',
            displayName: user.displayName || user.email || '',
            createdAt: new Date().toISOString(),
        };
        await fbSetDoc(profileRef, profile);
        return { uid: user.uid, ...profile };
    } catch (err) {
        console.warn('Could not read/create user profile:', err);
        return { uid: user.uid, role: 'salon_owner' };
    }
}

export async function handleAuthStateChanged(user) {
    const fb = getFirebase();
    if (!fb) {
        store.setState({ authReady: true, currentUser: null });
        return;
    }

    if (!user) {
        store.setState({ authReady: true, currentUser: null, userRole: 'guest' });
        return;
    }

    // A signed-in but unidentified session (anonymous, no verified identity)
    // is not a real account — keep these users on the login screen instead of
    // fabricating an owner dashboard for them.
    if (user.isAnonymous && !user.email && !user.phoneNumber) {
        store.setState({ authReady: true, currentUser: null, userRole: 'guest' });
        return;
    }

    // Resolve the authenticated user's profile BEFORE any dashboard render so
    // navigation is always driven by a verified identity and role.
    const profile = await ensureUserProfile(user);
    store.setState({
        authReady: true,
        accountRole: profile && profile.role === 'super_admin' ? 'super_admin' : 'salon_owner',
        currentUser: toSafeUser(user),
        userRole: profile && profile.role === 'super_admin' ? 'super_admin' : 'salon_owner',
        // Resume the salon the user last worked in (falls back to whatever is
        // currently active). resolveSalonScope validates it against the salons
        // the user actually owns before any tenant data is subscribed.
        currentSalonId: profile && profile.salonId ? profile.salonId : store.getState().currentSalonId,
    });
}

/**
 * Persist the salon an owner is currently working in onto their profile, so
 * the same salon is resumed on their next sign-in.
 */
export async function setUserSalon(salonId) {
    const fb = getFirebase();
    const user = fb && fb.auth.currentUser;
    if (!fb || !user || !salonId) return;
    try {
        await fbSetDoc(fbDoc(fb.db, 'users', user.uid), { salonId }, { merge: true });
    } catch (err) {
        console.warn('Could not persist preferred salon:', err);
    }
}

/**
 * Real Google OAuth Sign-In.
 *
 * Uses the configured Firebase project's Google provider. Never falls back to
 * a fabricated/demo account:
 *  - Desktop: popup flow, falling back to the redirect flow if the popup is
 *    blocked or cancelled by the browser.
 *  - Mobile: redirect flow (full-page navigation to Google).
 *
 * Returns { ok, redirecting } on success, { ok: false, error } on failure.
 * The OAuth callback is consumed by `handleRedirectResult()` on the next load.
 */
export async function signInWithGoogle() {
    const fb = getFirebase();
    if (!fb) {
        return {
            ok: false,
            error: 'Google Sign-In requires Firebase Authentication. Configure the Firebase project or use email sign-in.',
        };
    }

    try {
        if (isMobileDevice()) {
            await signInWithRedirect(fb.auth, googleProvider());
            return { ok: true, redirecting: true };
        }
        const result = await signInWithPopup(fb.auth, googleProvider());
        await handleAuthStateChanged(result.user);
        return { ok: true };
    } catch (err) {
        // Popups may be blocked inside restricted preview iframes — fall back
        // to the redirect flow instead of simulating a session.
        if (err.code === 'auth/popup-blocked' || err.code === 'auth/cancelled-popup-request') {
            try {
                await signInWithRedirect(fb.auth, googleProvider());
                return { ok: true, redirecting: true };
            } catch (redirectErr) {
                console.warn('Google redirect sign-in error:', redirectErr.code || redirectErr.message);
                return { ok: false, error: friendlyAuthError(redirectErr) };
            }
        }
        console.warn('Google sign-in error:', err.code || err.message);
        return { ok: false, error: friendlyAuthError(err) };
    }
}

/**
 * Consume a Google OAuth redirect callback. Call once on every app load when
 * Firebase is configured: after the user returns from the Google login page,
 * this resolves the pending sign-in and triggers the auth-state listener.
 * Safe to call when no redirect is pending (resolves to { ok: true, noop: true }).
 *
 * Real failures (e.g. an unauthorised domain) are surfaced to the user instead
 * of silently leaving them on the login screen.
 */
export async function handleRedirectResult() {
    const fb = getFirebase();
    if (!fb) return { ok: true, noop: true };
    try {
        const result = await getRedirectResult(fb.auth);
        if (result && result.user) {
            await handleAuthStateChanged(result.user);
            return { ok: true };
        }
        return { ok: true, noop: true };
    } catch (err) {
        if (err.code === 'auth/redirect-cancelled-by-user') {
            return { ok: false, error: 'Google sign-in was cancelled.' };
        }
        const message = friendlyAuthError(err);
        console.warn('Google redirect callback error:', err.code || err.message);
        showNotification(message, 'error');
        return { ok: false, error: message };
    }
}

/** Email + password sign-in. Demo-mode fallback exists only for the offline
 * local preview (no backend is configured); it never runs against real
 * Firebase. */
export async function signInWithEmail(email, password) {
    const fb = getFirebase();
    if (!fb) return demoSignIn();

    try {
        const cred = await signInWithEmailAndPassword(fb.auth, email, password);
        await handleAuthStateChanged(cred.user);
        return { ok: true };
    } catch (err) {
        console.warn('Email sign-in error:', err.code || err.message);
        return { ok: false, error: friendlyAuthError(err) };
    }
}

/** Create an account (email + password) then sign in. */
export async function signUpWithEmail(email, password) {
    const fb = getFirebase();
    if (!fb) return demoSignIn();

    try {
        const cred = await createUserWithEmailAndPassword(fb.auth, email, password);
        await handleAuthStateChanged(cred.user);
        return { ok: true };
    } catch (err) {
        console.warn('Account creation error:', err.code || err.message);
        return { ok: false, error: friendlyAuthError(err) };
    }
}

/** Anonymous sign-in against real Firebase. Never fabricates a session. */
export async function signInAnonymouslyNow() {
    const fb = getFirebase();
    if (!fb) {
        return { ok: false, error: 'Anonymous sign-in requires Firebase Authentication.' };
    }
    try {
        await signInAnonymously(fb.auth);
        return { ok: true };
    } catch (err) {
        console.warn('Anonymous sign-in error:', err.code || err.message);
        return { ok: false, error: friendlyAuthError(err) };
    }
}

/** Sign-out — clears the session in both modes. */
export async function signOut() {
    const fb = getFirebase();
    try {
        if (fb) await fbSignOut(fb.auth);
    } catch (err) {
        console.warn('Sign-out error:', err.code || err.message);
    }
    store.setState({
        userRole: 'guest',
        activeTab: 'login',
        currentUser: null,
        isModalOpen: false,
        modalType: null,
    });
}

/** Restore a session from an injected custom token (hosting layer). */
export async function restoreSession() {
    const token = getInitialAuthToken();
    const fb = getFirebase();
    if (fb && token) {
        try {
            await signInWithCustomToken(fb.auth, token);
        } catch (err) {
            console.warn('Custom token sign-in failed:', err.code || err.message);
        }
    }
}

/** Demo-mode sign-in: simulate an owner session with local state. */
function demoSignIn() {
    store.setState({
        currentUser: {
            uid: 'demo-' + makeId('u'),
            email: 'owner@luxeglow.com',
            displayName: 'Salon Owner',
            isAnonymous: true,
        },
        userRole: 'salon_owner',
    });
    return { ok: true };
}

export function friendlyAuthError(err) {
    const code = (err && err.code) || 'auth/unknown';
    const map = {
        'auth/user-not-found': 'No account found with this email.',
        'auth/wrong-password': 'Incorrect password. Please try again.',
        'auth/invalid-credential': 'Incorrect email or password.',
        'auth/email-already-in-use': 'An account already exists for this email.',
        'auth/invalid-email': 'Please enter a valid email address.',
        'auth/weak-password': 'Password must be at least 6 characters.',
        'auth/too-many-requests': 'Too many attempts. Please try again later.',
        'auth/network-request-failed': 'Network error. Check your connection.',
        'auth/popup-closed-by-user': 'Sign-in popup was closed.',
        'auth/cancelled-popup-request': 'The sign-in popup was cancelled.',
        'auth/popup-blocked': 'Pop-up blocked. Enable pop-ups for this site and try again.',
        'auth/redirect-cancelled-by-user': 'Google sign-in was cancelled.',
        'auth/operation-not-allowed': 'This sign-in method is not enabled.',
        'auth/account-exists-with-different-credential': 'This email is linked to a different sign-in method. Sign in with that method first.',
        'auth/unauthorized-domain': 'This domain is not authorized. Add it in Firebase Console → Authentication → Settings → Authorized domains.',
    };
    return map[code] || 'Authentication failed. Please try again.';
}

export default {
    handleAuthStateChanged,
    signInWithGoogle,
    handleRedirectResult,
    signInWithEmail,
    signUpWithEmail,
    signInAnonymouslyNow,
    signOut,
    restoreSession,
    setUserSalon,
    friendlyAuthError,
};
