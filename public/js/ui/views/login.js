/**
 * views/login.js
 * Guest landing screen: choose Salon Owner Portal or Super Admin Oversight.
 */

import { esc } from '../../core/sanitize.js';
import { icon } from '../icons.js';

export function renderLogin() {
    return `
        <div class="flex-1 flex flex-col justify-center items-center p-6 bg-gradient-to-b from-slate-900 via-slate-950 to-black text-center relative overflow-hidden h-full">
            <div class="absolute -top-24 -left-24 w-72 h-72 bg-brand-600/15 rounded-full blur-3xl pointer-events-none" aria-hidden="true"></div>

            <div class="w-16 h-16 rounded-3xl bg-gradient-to-tr from-brand-600 to-brand-400 flex items-center justify-center shadow-2xl shadow-brand-500/40 mb-6 text-white mx-auto">
                <i data-lucide="scissors" class="w-8 h-8"></i>
            </div>

            <h2 class="text-2xl font-extrabold text-white tracking-tight mb-2">LuxeGlow Salon CRM</h2>
            <p class="text-xs text-slate-400 mb-8 max-w-xs mx-auto">Elevated beauty business management, cloud referrals, and live scheduling.</p>

            <div class="w-full space-y-3.5">
                <button data-action="role" data-role="auth_select"
                    class="w-full py-4 px-5 bg-gradient-to-r from-brand-600 to-brand-500 hover:from-brand-500 hover:to-brand-600 text-white font-bold text-sm rounded-2xl shadow-lg shadow-brand-600/30 transition flex items-center justify-between group active:scale-[0.98] touch-manipulation">
                    <div class="flex items-center space-x-3">
                        <div class="p-2 bg-white/20 rounded-xl"><i data-lucide="store" class="w-4 h-4"></i></div>
                        <span class="text-left">Salon Owner Portal</span>
                    </div>
                    <i data-lucide="chevron-right" class="w-4 h-4 text-white/70 group-hover:translate-x-0.5 transition"></i>
                </button>

                <button data-action="role" data-role="super_admin"
                    class="w-full py-4 px-5 bg-slate-900 hover:bg-slate-800/80 border border-slate-800 text-white font-bold text-sm rounded-2xl transition flex items-center justify-between group active:scale-[0.98] touch-manipulation">
                    <div class="flex items-center space-x-3">
                        <div class="p-2 bg-slate-800 text-indigo-400 rounded-xl"><i data-lucide="shield-check" class="w-4 h-4"></i></div>
                        <span class="text-left">Super Admin Oversight</span>
                    </div>
                    <i data-lucide="chevron-right" class="w-4 h-4 text-slate-500 group-hover:translate-x-0.5 transition"></i>
                </button>
            </div>
        </div>
    `;
}

export default renderLogin;
