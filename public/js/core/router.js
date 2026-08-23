/**
 * router.js
 * Lightweight UI router. Owns tab/role navigation state and decides which
 * view should render for the current role.
 */

import { store } from './store.js';
import { clearDraft } from './draft.js';

export const TABS = {
    salonOwner: ['dashboard', 'appointments', 'customers', 'referrals', 'services', 'staff'],
    superAdmin: ['admin_salons'],
};

export function switchTab(tab) {
    store.setState({ activeTab: tab });
}

export function setRole(role) {
    const patch = { userRole: role };
    if (role === 'super_admin') patch.activeTab = 'admin_salons';
    if (role === 'guest') patch.activeTab = 'login';
    store.setState(patch);
}

export function openModal(modalType, record = null) {
    // Start every fresh modal from a clean slate (edit forms seed from the
    // record instead of a stale draft).
    clearDraft('appointment');
    store.setState({ isModalOpen: true, modalType, modalRecord: record ? { ...record } : null });
}

export function closeModal() {
    clearDraft('appointment');
    store.setState({ isModalOpen: false, modalType: null, rewards: null, modalRecord: null, deleteTarget: null });
}

export function openDeleteConfirm(target) {
    store.setState({ deleteTarget: target, isModalOpen: true, modalType: 'confirm-delete' });
}

export function logout() {
    store.setState({
        userRole: 'guest',
        activeTab: 'login',
        currentUser: null,
        isModalOpen: false,
        modalType: null,
    });
}

/** Routes to the correct view module for the current state. */
export function route(state) {
    if (state.userRole === 'guest') return 'login';
    if (state.userRole === 'super_admin') return 'superAdmin';
    return state.activeTab;
}

export default {
    TABS,
    switchTab,
    setRole,
    openModal,
    closeModal,
    openDeleteConfirm,
    logout,
    route,
};
