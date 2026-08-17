/**
 * store.js
 * Minimal observable central state. Single source of truth for the app.
 * Pure JS — no external dependency.
 */

function createStore(initialState) {
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
    isModalOpen: false,
    modalType: null,
    rewards: null, // { customerId, name, points } context for the rewards modal
    modalRecord: null, // { id, type } record being edited in an open modal
    deleteTarget: null, // { type, id, label } record awaiting delete confirmation
    notificationsEnabled: false,
    needsSalon: false, // salon_owner signed in but has no salon yet (bootstrap)
    salonsList: [],
    customersList: [],
    servicesList: [],
    staffList: [],
    appointmentsList: [],
    referralsList: [],
    referralsLoaded: false,
    referralsError: null,
    customerSearchQuery: '',
});

export default store;
