/**
 * store.js
 * Minimal observable central state. Single source of truth for the app.
 * Pure JS — no external dependency.
 */

/**
 * Factory for the same minimal observable store the app singleton below is
 * built from. Exported so any other independent runtime in this codebase
 * (the public booking page, which shares no state with the authenticated
 * SPA) can reuse the identical, already-tested primitive instead of
 * reimplementing it.
 */
export function createStore(initialState) {
    let state = { ...initialState };
    const listeners = new Set();

    return {
        getState() {
            return state;
        },
        setState(patch) {
            const next = typeof patch === 'function' ? patch(state) : patch;
            if (!next || typeof next !== 'object') return;
            state = { ...state, ...next };
            listeners.forEach((listener) => {
                try {
                    listener(state);
                } catch (err) {
                    console.warn('Store listener error:', err);
                }
            });
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

/** Shared application store instance. */
export const store = createStore({
    mode: 'demo', // 'demo' | 'firebase'
    network: navigator.onLine !== false,
    authReady: false,
    authFormMode: 'signin', // 'signup' | 'signin'
    authView: 'default', // guest auth screen: 'default' (sign-in/sign-up) | 'forgot' | 'reset'
    resetOobCode: null, // one-time reset code from the Firebase email link (held in memory only — never persisted)
    resetEmail: '', // account email bound to the reset code, when known
    resetError: null, // message shown when the reset code is invalid/expired/unavailable
    forgotSent: false, // true once a reset-link request has been submitted (shows the generic confirmation)
    resetDone: false, // true once a new password has been saved via the reset link
    accountRole: 'salon_owner', // persistent role from the user profile (Firestore)
    currentUser: null,
    trialStarting: false,
    trialError: null,
    subscriptionError: null,
    userRole: 'guest', // 'guest' | 'salon_owner' | 'super_admin'
    currentSalonId: null, // the active salon the tenant repos are scoped to
    salonsLoaded: false, // true once the owner's salons have been fetched
    activeTab: 'dashboard',
    dashboardTab: 'today',
    isModalOpen: false,
    modalType: null,
    modalRecord: null, // { id, type } record being edited in an open modal
    deleteTarget: null, // { type, id, label } record awaiting delete confirmation
    notificationsEnabled: false,
    needsSalon: false, // salon_owner signed in but has no salon yet (bootstrap)
    salonsList: [],
    customersList: [],
    servicesList: [],
    staffList: [],
    appointmentsList: [],
    appointmentFilters: { status: 'all', staffName: 'all', serviceName: 'all', paymentStatus: 'all' },

    // ---- Staff attendance ----
    attendanceList: [],
    staffTab: 'roster', // 'roster' | 'attendance'
    attendanceDate: null, // null = today (see ui/views/attendance.js)
    attendanceHistoryMonth: null, // null = current month
    attendanceHistoryStaffId: 'all',

    // ---- Referral programme ----
    referralsList: [],
    referralsLoaded: false,
    referralsError: null,
    referralCodesList: [],
    walletTransactionsList: [],
    referralSettings: null, // null until loaded; DEFAULT_REFERRAL_SETTINGS applies
    referralTab: 'list', // 'list' | 'settings'
    referralStatusFilter: 'all',

    // ---- Public online booking ----
    bookingSettings: null, // null until loaded; DEFAULT_BOOKING_SETTINGS applies
    bookingSettingsDocExists: false, // true once a real bookingSettings/config doc has been saved
});

export default store;
