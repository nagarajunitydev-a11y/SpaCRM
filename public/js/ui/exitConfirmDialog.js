/**
 * exitConfirmDialog.js
 * Standalone "Do you want to exit SPACRM?" confirmation, used by the
 * Android/mobile Back-button exit guard (core/exitGuard.js).
 *
 * Deliberately rendered straight onto `document.body` — NOT into the SPA's
 * `#app` root — so an unrelated store update mid-decision can never wipe it
 * out from under the user (main.js re-renders `#app` on every state change).
 * Native `window.confirm()` was considered but rejected: its button labels
 * ("OK"/"Cancel") can't be customized, and the product spec calls for exact
 * "Cancel" / "Exit" wording.
 */

let activeDialog = null; // { overlay, resolve } — at most one at a time

/**
 * Show the exit-confirmation overlay. Resolves `true` if the user taps
 * "Exit", `false` if they tap "Cancel" or the backdrop. If one is already
 * showing, a second call is a no-op that resolves alongside the first
 * (never stacks a duplicate dialog).
 */
export function showExitConfirmDialog() {
    if (activeDialog) {
        return new Promise((resolve) => {
            const previousResolve = activeDialog.resolve;
            activeDialog.resolve = (value) => { previousResolve(value); resolve(value); };
        });
    }

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Exit SPACRM');
        overlay.className = 'fixed inset-0 bg-black/85 backdrop-blur-sm z-[999] flex items-center justify-center p-6';
        overlay.innerHTML = `
            <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 max-w-xs w-full shadow-2xl text-center space-y-4">
                <div class="w-14 h-14 mx-auto rounded-2xl bg-amber-500/10 text-amber-400 flex items-center justify-center" aria-hidden="true">
                    <i data-lucide="log-out" class="w-6 h-6"></i>
                </div>
                <div>
                    <p class="text-base font-extrabold text-slate-100">Exit SPACRM?</p>
                    <p class="text-xs text-slate-400 mt-1.5">Do you want to exit SPACRM?</p>
                </div>
                <div class="flex gap-2.5">
                    <button type="button" data-exit-choice="cancel" class="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-xl transition active:scale-95 touch-manipulation">Cancel</button>
                    <button type="button" data-exit-choice="exit" class="flex-1 py-3 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-rose-600/30 transition active:scale-95 touch-manipulation">Exit</button>
                </div>
            </div>
        `;

        const finish = (value) => {
            overlay.remove();
            document.removeEventListener('keydown', onKeydown, true);
            activeDialog = null;
            resolve(value);
        };
        const onKeydown = (event) => {
            if (event.key === 'Escape') finish(false);
        };

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) finish(false);
            const choiceEl = event.target.closest('[data-exit-choice]');
            if (choiceEl) finish(choiceEl.dataset.exitChoice === 'exit');
        });
        document.addEventListener('keydown', onKeydown, true);

        document.body.appendChild(overlay);
        if (window.lucide && window.lucide.createIcons) {
            window.lucide.createIcons({ root: overlay });
        }

        activeDialog = { overlay, resolve: finish };
    });
}

export default showExitConfirmDialog;
