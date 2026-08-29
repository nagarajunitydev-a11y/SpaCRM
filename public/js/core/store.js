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
    accountRole: 'salon_owner', // persistent role from the user profile (Firestore)
    currentUser: null,
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
    appointmentFilters: { dateFrom: '', dateTo: '', status: 'all', staffName: 'all', customerId: 'all', serviceName: 'all', paymentStatus: 'all', source: 'all' },

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
