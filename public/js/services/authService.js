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
import { authLog, errorLog } from '../core/debug.js';
import showNotification from '../ui/notification.js';
import {
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    setPersistence,
    browserLocalPersistence,
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
 * desktop. Detects real phones/tablets plus iPadOS Safari, which reports a
 * desktop MacIntel user-agent but is still a touch device.
 */
function isMobileDevice() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobile|SamsungBrowser|Tablet|Windows Phone/i.test(ua)) return true;
    // iPadOS Safari ("request desktop site" or recent iOS) reports MacIntel.
    if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1 && window.innerWidth <= 1200) return true;
    // Any other small, touch-capable screen (foldables, in-app browsers…).
    return navigator.maxTouchPoints > 0 && window.innerWidth <= 900;
}

/**
 * True on Android browsers (Chrome, Samsung Internet, WebViews…). Android is
 * the only platform where the OAuth redirect result must be explicitly
 * captured with getRedirectResult during app initialisation (signInWithRedirect
 * reloads the page there). Desktop keeps its popup flow untouched.
 */
export function isAndroidBrowser() {
    if (typeof navigator === 'undefined') return false;
    return /Android/i.test(navigator.userAgent || '');
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
    // Step 5 — Firestore user/profile lookup started for the verified user.
    authLog(5, `profile lookup started for uid=${user.uid} email=${user.email || '(none)'}`);
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
        errorLog('user-profile-lookup', err);
        console.warn('Could not read/create user profile:', err);
        return { uid: user.uid, role: 'salon_owner' };
    }
}

export function handleAuthStateChanged(user) {
    const fb = getFirebase();
    if (!fb) {
        store.setState({ authReady: true, currentUser: null });
        return;
    }

    if (!user) {
        // Step 4 — no authenticated user; session ended.
        authLog(4, 'no authenticated user — session ended / guest state');
        store.setState({ authReady: true, currentUser: null, userRole: 'guest', accountRole: 'salon_owner' });
        return;
    }

    // A signed-in but unidentified session (anonymous, no verified identity)
    // is not a real account — keep these users on the login screen instead of
    // fabricating an owner dashboard for them.
    if (user.isAnonymous && !user.email && !user.phoneNumber) {
        authLog(4, `anonymous unidentified session blocked uid=${user.uid}`);
        store.setState({ authReady: true, currentUser: null, userRole: 'guest', accountRole: 'salon_owner' });
        return;
    }

    // Step 4 — verified Firebase identity retrieved.
    authLog(4, `verified user uid=${user.uid} email=${user.email || '(none)'} displayName=${user.displayName || '(none)'}`);

    // Step 3 — auth session confirmed: Firebase reports a real signed-in
    // session (fires for popup, redirect callback, and restored sessions).
    authLog(3, `auth session confirmed for uid=${user.uid}`);

    // Navigate immediately: the Firebase identity is already verified, so the
    // owner proceeds straight to their dashboard. The Firestore profile read is
    // reconciled in the background, so a slow or denied read can never leave the
    // user stuck on the login screen after a successful sign-in.
    store.setState({
        authReady: true,
        accountRole: 'salon_owner',
        currentUser: toSafeUser(user),
        userRole: 'salon_owner',
    });

    ensureUserProfile(user)
        .then((profile) => {
            if (!profile) return;
            const role = profile.role === 'super_admin' ? 'super_admin' : 'salon_owner';
            // Step 6 — role identified from the Firestore profile.
            authLog(6, `role identified role=${role} salonId=${profile.salonId || '(none)'}`);
            store.setState({
                accountRole: role,
                userRole: role,
                // Resume the salon the user last worked in (falls back to the
                // current one). resolveSalonScope validates ownership against
                // the salons the user actually owns before any tenant data is
                // subscribed.
                currentSalonId: profile.salonId ? profile.salonId : store.getState().currentSalonId,
            });
        })
        .catch((err) => {
            errorLog('role-reconciliation', err);
            console.warn('Could not reconcile user profile after sign-in:', err);
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
 *  - Mobile: full-page redirect flow (`signInWithRedirect`). Popup OAuth is
 *    blocked or mis-handled on iOS Safari / Android, so mobile never uses it.
 *  - Desktop: popup flow, falling back to the redirect flow if the popup is
 *    blocked or cancelled by the browser.
 *
 * Returns { ok, redirecting } on success, { ok: false, error } on failure.
 * The OAuth callback is consumed by `handleRedirectResult()` on the next load.
 */
export async function signInWithGoogle() {
    const fb = getFirebase();
    if (!fb) {
        errorLog('google-signin-no-firebase', new Error('Firebase not initialised; Google Sign-In unavailable in this mode.'));
        return {
            ok: false,
            error: 'Google Sign-In requires Firebase Authentication. Configure the Firebase project or use email sign-in.',
        };
    }

    if (isMobileDevice()) {
        console.info('[auth] Google sign-in: mobile device detected, using redirect flow.');
        return signInWithGoogleRedirect(fb);
    }
    console.info('[auth] Google sign-in: desktop device detected, using popup flow.');
    return signInWithGooglePopup(fb);
}

/** Mobile Google OAuth: full-page redirect. Safe under strict storage/cookie
 * policies and popup blockers. Session persists in local storage. */
async function signInWithGoogleRedirect(fb) {
    try {
        // Ensure the signed-in session survives the redirect round-trip and
        // every subsequent reload (mobile Safari / ITP friendly).
        await setPersistence(fb.auth, browserLocalPersistence);
        // Step 1 — Google Sign-In initiated via full-page redirect.
        authLog(1, 'Google Sign-In initiated via redirect flow');
        await signInWithRedirect(fb.auth, googleProvider());
        return { ok: true, redirecting: true };
    } catch (err) {
        errorLog('google-redirect-signin', err);
        console.error('[auth] Google redirect sign-in failed:', err.code || err.message, err.message);
        return { ok: false, error: friendlyAuthError(err) };
    }
}

/** Desktop Google OAuth: popup, with redirect as the blocked-popup fallback. */
async function signInWithGooglePopup(fb) {
    try {
        // Step 1 — Google Sign-In completed via popup flow.
        const result = await signInWithPopup(fb.auth, googleProvider());
        authLog(1, 'Google Sign-In completed via popup flow');
        // Step 2 — Firebase user received from the OAuth popup.
        authLog(2, `Firebase user received uid=${result.user ? result.user.uid : '(none)'}`);
        handleAuthStateChanged(result.user);
        return { ok: true, redirecting: false };
    } catch (err) {
        // Popups may be blocked inside restricted preview iframes — fall back
        // to the redirect flow instead of simulating a session.
        if (err.code === 'auth/popup-blocked' || err.code === 'auth/cancelled-popup-request') {
            console.warn('[auth] Popup blocked/cancelled — falling back to redirect flow:', err.code);
            return signInWithGoogleRedirect(fb);
        }
        errorLog('google-popup-signin', err);
        console.error('[auth] Google popup sign-in failed:', err.code || err.message, err.message);
        return { ok: false, error: friendlyAuthError(err) };
    }
}

/**
 * Consume a Google OAuth redirect callback. Called once during app
 * initialisation on Android browsers, where signInWithRedirect reloads the
 * page and the login result must be captured explicitly via getRedirectResult.
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
            const u = result.user;
            // Step 2 — Firebase user received from the OAuth redirect callback.
            authLog(2, `Firebase user received from redirect uid=${u.uid} email=${u.email || '(none)'}`);
            console.info(`[auth] Redirect sign-in completed for ${u.email || u.uid}.`);
            // Navigate straight to the owner dashboard with the verified identity.
            handleAuthStateChanged(u);
            return { ok: true };
        }
        // No pending redirect (a normal cold load) — the auth-state listener is
        // the source of truth for any restored session.
        console.info(`[auth] No pending redirect result.`);
        return { ok: true, noop: true };
    } catch (err) {
        if (err.code === 'auth/redirect-cancelled-by-user') {
            console.info('[auth] Redirect sign-in cancelled by user.');
            return { ok: false, error: 'Google sign-in was cancelled.' };
        }
        const message = friendlyAuthError(err);
        errorLog('google-redirect-callback', err);
        console.error('[auth] Google redirect callback failed:', err.code || err.message, err.message);
        showNotification(message, 'error');
        return { ok: false, error: message, code: err.code || null };
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
        accountRole: 'salon_owner',
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
        accountRole: 'salon_owner',
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
    isAndroidBrowser,
    signInWithEmail,
    signUpWithEmail,
    signInAnonymouslyNow,
    signOut,
    restoreSession,
    setUserSalon,
    friendlyAuthError,
};
