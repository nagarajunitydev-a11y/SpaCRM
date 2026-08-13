/**
 * components.js
 * Lightweight, reusable UI components. All dynamic values are escaped.
 * No framework — plain functions that return HTML strings.
 *
 * Components never emit inline `on*` handlers. Interactions are wired through
 * `data-action` attributes consumed by the central event delegation in main.js
 * (also works with mouse and touch out of the box).
 */

import { esc, escAttr } from '../core/sanitize.js';
import { icon } from './icons.js';

/** Lucide icon element. */
export function iconEl(name, cls = 'w-4 h-4') {
    return icon(name, cls);
}

/** Brand logo mark. */
export function logoMark(size = 'w-8 h-8', iconClass = 'w-3.5 h-3.5') {
    return `
        <div class="${escAttr(size)} rounded-xl bg-gradient-to-tr from-brand-600 to-brand-500 flex items-center justify-center shadow-lg shadow-brand-500/30 text-white font-bold shrink-0">
            <i data-lucide="scissors" class="${escAttr(iconClass)}"></i>
        </div>
    `;
}

/** App header (role label, salon selector, logout). */
export function appHeader(state, { onLogoutLabel } = {}) {
    const isOwner = state.userRole === 'salon_owner';
    const roleLabel = state.userRole === 'super_admin' ? 'Super Admin' : 'Salon Owner';

    const salonSelector = isOwner && (state.salonsList || []).length > 0
        ? `
            <div class="flex items-center bg-slate-900 border border-slate-800 rounded-xl px-2.5 py-1 text-[11px] text-slate-300 max-w-[46vw]">
                <i data-lucide="store" class="w-3 h-3 text-brand-500 mr-1.5 shrink-0"></i>
                <select data-action="salon" class="bg-transparent font-medium text-slate-200 focus:outline-none cursor-pointer w-full min-w-0 text-ellipsis" aria-label="Select salon">
                    ${(state.salonsList || []).map((s) => `
                        <option value="${escAttr(s.id)}" ${s.id === state.currentSalonId ? 'selected' : ''} class="bg-slate-900">${esc(s.name)}</option>
                    `).join('')}
                </select>
            </div>
        `
        : '';

    return `
        <header class="bg-slate-900/80 backdrop-blur-xl border-b border-slate-800/80 px-4 py-3.5 flex items-center justify-between sticky top-0 z-30 gap-2">
            <div class="flex items-center space-x-2.5 min-w-0">
                ${logoMark()}
                <div class="min-w-0">
                    <h1 class="font-bold text-xs text-slate-100 tracking-tight truncate">LuxeGlow CRM</h1>
                    <p class="text-[9px] text-brand-400 font-semibold uppercase tracking-wider truncate">${esc(roleLabel)}</p>
                </div>
            </div>
            <div class="flex items-center space-x-2 shrink-0">
                ${salonSelector}
                <button data-action="logout" aria-label="Logout" title="Logout" class="w-9 h-9 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-400 flex items-center justify-center transition active:scale-95 touch-manipulation">
                    <i data-lucide="log-out" class="w-4 h-4"></i>
                </button>
            </div>
        </header>
    `;
}

/** Bottom navigation bar. */
export function bottomNav(state) {
    const isOwner = state.userRole === 'salon_owner';

    const ownerItems = [
        { tab: 'dashboard', label: 'Home', icon: 'layout-dashboard' },
        { tab: 'appointments', label: 'Bookings', icon: 'calendar' },
        { tab: 'customers', label: 'Clients', icon: 'users' },
        { tab: 'services', label: 'Services', icon: 'sparkles' },
        { tab: 'staff', label: 'Staff', icon: 'user-check' },
    ];

    const items = isOwner
        ? ownerItems
        : [
              { tab: 'admin_salons', label: 'All Salons', icon: 'building-2' },
              { action: 'logout', label: 'Sign Out', icon: 'log-out', logout: true },
          ];

    return `
        <nav class="absolute bottom-0 left-0 right-0 bg-slate-900/90 backdrop-blur-xl border-t border-slate-800/80 px-2 py-2.5 flex items-center justify-around z-30 shadow-2xl safe-bottom" aria-label="Main navigation">
            ${items.map((item) => {
                const active = item.tab && item.tab === state.activeTab;
                const isLogout = item.logout;
                const cls = active ? 'text-brand-500' : isLogout ? 'text-rose-400' : 'text-slate-400 hover:text-slate-200';
                const attrs = item.tab ? `data-action="tab" data-tab="${escAttr(item.tab)}"` : `data-action="logout"`;
                return `
                    <button ${attrs} aria-current="${active ? 'page' : 'false'}" class="flex flex-col items-center space-y-1 transition min-w-[52px] py-1 touch-manipulation active:scale-95 ${escAttr(cls)}">
                        <i data-lucide="${escAttr(item.icon)}" class="w-5 h-5"></i>
                        <span class="text-[10px] font-semibold">${esc(item.label)}</span>
                    </button>
                `;
            }).join('')}
        </nav>
    `;
}

/** Stat card. */
export function statCard(label, value, valueClass = 'text-white') {
    return `
        <div class="bg-slate-950/60 border border-slate-800/60 p-3.5 rounded-2xl">
            <p class="text-[10px] text-slate-400 font-medium">${esc(label)}</p>
            <p class="text-xl font-extrabold mt-0.5 ${escAttr(valueClass)}">${esc(value)}</p>
        </div>
    `;
}

/** Quick action button (dashboard). */
export function quickAction(modalType, label, iconName, accent = 'text-brand-400 bg-brand-500/10') {
    return `
        <button data-action="modal" data-modal="${escAttr(modalType)}" class="flex flex-col items-center justify-center p-3 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-2xl transition text-center group active:scale-95 touch-manipulation" aria-label="${escAttr(label)}">
            <div class="w-10 h-10 rounded-xl ${escAttr(accent)} flex items-center justify-center mb-1.5 group-hover:scale-105 transition"><i data-lucide="${escAttr(iconName)}" class="w-5 h-5"></i></div>
            <span class="text-[10px] font-semibold text-slate-300">${esc(label)}</span>
        </button>
    `;
}

/** Primary or secondary action button with delegated data-action. */
export function actionButton(label, { action, data = {}, kind = 'primary', iconName = null, className = '' }) {
    const dataAttrs = Object.entries(data)
        .map(([k, v]) => `data-${escAttr(k)}="${escAttr(v)}"`)
        .join(' ');
    const cls = kind === 'ghost'
        ? 'px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl transition'
        : kind === 'indigo'
            ? 'px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl shadow-lg shadow-indigo-600/30 transition'
            : 'px-3.5 py-2 bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold rounded-xl shadow-lg shadow-brand-600/30 transition';
    const iconHtml = iconName ? `<i data-lucide="${escAttr(iconName)}" class="w-3.5 h-3.5"></i>` : '';
    return `
        <button data-action="${escAttr(action)}" ${dataAttrs} class="${escAttr(cls)} flex items-center space-x-1.5 active:scale-95 touch-manipulation ${escAttr(className)}">
            ${iconHtml}${iconHtml ? '<span>' + esc(label) + '</span>' : esc(label)}
        </button>
    `;
}

/** Section header row with optional trailing action. */
export function sectionHeader(title, subtitle, trailingHtml = '') {
    return `
        <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
                <h2 class="text-lg font-extrabold text-slate-100 truncate">${esc(title)}</h2>
                ${subtitle ? `<p class="text-xs text-slate-400">${esc(subtitle)}</p>` : ''}
            </div>
            ${trailingHtml}
        </div>
    `;
}

/** Empty-state placeholder. */
export function emptyState(message) {
    return `<div class="bg-slate-900/50 border border-slate-800 p-6 rounded-2xl text-center text-slate-500 text-xs">${esc(message)}</div>`;
}

/** Small pill badge. */
export function badge(text, cls = 'bg-emerald-500/15 text-emerald-400') {
    return `<span class="inline-block text-[10px] px-2 py-0.5 bg-emerald-500/15 ${escAttr(cls)} font-semibold rounded-full">${esc(text)}</span>`;
}

/** Network / offline banner. */
export function networkBanner(state) {
    if (state.network) return '';
    return `
        <div class="bg-amber-500/15 border-b border-amber-500/20 px-4 py-2 text-[10px] font-semibold text-amber-400 flex items-center space-x-2">
            <i data-lucide="wifi-off" class="w-3.5 h-3.5 shrink-0"></i>
            <span>Offline — showing saved data. Changes will sync when you reconnect.</span>
        </div>
    `;
}

/** Label + control form field. */
export function formField(label, controlHtml, hint = '') {
    return `
        <div>
            <label class="block text-[11px] font-semibold text-slate-400 uppercase mb-1">${esc(label)}</label>
            ${controlHtml}
            ${hint ? `<p class="mt-1 text-[10px] text-slate-500">${esc(hint)}</p>` : ''}
        </div>
    `;
}

/** Text input control. */
export function textInput(name, placeholder, opts = {}) {
    const { type = 'text', required = true, className = '', autocomplete = '', value = '' } = opts;
    const val = value !== null && value !== undefined ? escAttr(String(value)) : '';
    return `
        <input type="${escAttr(type)}" name="${escAttr(name)}" ${required ? 'required' : ''} placeholder="${escAttr(placeholder)}"
            ${val ? `value="${val}"` : ''}
            ${autocomplete ? `autocomplete="${escAttr(autocomplete)}"` : ''}
            class="w-full bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500 ${escAttr(className)}">
    `;
}

/** Select control. `value` marks the currently selected option. */
export function selectControl(name, options, placeholder, opts = {}) {
    const { required = true, className = '', value = '' } = opts;
    return `
        <select name="${escAttr(name)}" ${required ? 'required' : ''} class="w-full bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500 ${escAttr(className)}">
            ${placeholder ? `<option value="" disabled ${value === '' || value == null ? 'selected' : ''}>${esc(placeholder)}</option>` : ''}
            ${options.map((o) => `<option value="${escAttr(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
    `;
}

/** Date/time input control. */
export function dateTimeInput(name, type = 'date', placeholder = '', opts = {}) {
    const { value = '' } = opts;
    const val = value !== null && value !== undefined ? escAttr(String(value)) : '';
    const ph = placeholder ? `placeholder="${escAttr(placeholder)}"` : '';
    return `
        <input type="${escAttr(type)}" name="${escAttr(name)}" required ${ph} ${val ? `value="${val}"` : ''} class="w-full bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500">
    `;
}

/** Standard card wrapper. */
export function card(contentHtml, cls = '') {
    return `<div class="bg-slate-900 border border-slate-800 ${escAttr(cls)}">${contentHtml}</div>`;
}

/** Compact icon action button (edit/delete etc.) for card rows. */
export function iconAction(action, data, label, iconName, cls = 'bg-slate-800 hover:bg-slate-700 text-slate-300') {
    const dataAttrs = Object.entries(data)
        .map(([k, v]) => `data-${escAttr(k)}="${escAttr(v)}"`)
        .join(' ');
    return `
        <button data-action="${escAttr(action)}" ${dataAttrs} aria-label="${escAttr(label)}" title="${escAttr(label)}"
            class="w-8 h-8 rounded-xl ${escAttr(cls)} flex items-center justify-center transition active:scale-95 touch-manipulation">
            <i data-lucide="${escAttr(iconName)}" class="w-3.5 h-3.5"></i>
        </button>
    `;
}

export default {
    logoMark,
    appHeader,
    bottomNav,
    statCard,
    quickAction,
    actionButton,
    sectionHeader,
    emptyState,
    badge,
    networkBanner,
    formField,
    textInput,
    selectControl,
    dateTimeInput,
    card,
    iconAction,
};
