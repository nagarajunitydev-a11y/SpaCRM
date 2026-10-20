/** Refresh a resumed Android shell without interrupting an active workflow. */
export function canRefreshAndroidApp(state, document, tourActive) {
    if (state.mode !== 'firebase' || !state.authReady || state.network === false
        || state.isModalOpen || state.trialStarting || state.needsSalon || tourActive) return false;

    // Preserve the current screen and in-memory drafts. Refresh at the landing
    // screen, or defer until the user returns there through normal navigation.
    if (state.userRole === 'guest') {
        if (state.authView !== 'default' || state.authFormMode !== 'signin') return false;
    } else if (!['dashboard', 'admin_salons'].includes(state.activeTab)) return false;
    if (document.querySelector('.razorpay-container, iframe[src*="razorpay"], [role="dialog"]')) return false;

    return [...document.querySelectorAll('input, textarea, select')].every((field) => {
        if (field.type === 'file') return !field.files?.length;
        if (['checkbox', 'radio'].includes(field.type)) return field.checked === field.defaultChecked;
        if (field.tagName === 'SELECT') {
            const defaultIndex = [...field.options].findIndex((option) => option.defaultSelected);
            return field.selectedIndex === Math.max(0, defaultIndex);
        }
        return field.value === field.defaultValue;
    });
}

export function installAndroidRefresh({ window, document, store, isTourActive }) {
    let pending = false;
    const refreshIfIdle = () => {
        if (!pending || !canRefreshAndroidApp(store.getState(), document, isTourActive())) return;
        pending = false;
        window.location.reload();
    };
    window.addEventListener('qvrix:foreground', () => {
        pending = true;
        refreshIfIdle();
    });
    store.subscribe(refreshIfIdle);
}
