/**
 * notification.js
 * Lightweight toast notifications. Content is escaped before rendering.
 */

import { esc } from '../core/sanitize.js';

let timer = null;

export function showNotification(message, type = 'success') {
    const existing = document.getElementById('toast-notification');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'toast-notification';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.className = `fixed top-6 left-1/2 transform -translate-x-1/2 z-[999] px-5 py-3 rounded-2xl text-white text-xs font-semibold shadow-2xl flex items-center space-x-2.5 transition-all duration-300 max-w-[90vw] ${type === 'success' ? 'bg-emerald-600/95 border border-emerald-500/30' : 'bg-rose-600/95 border border-rose-500/30'} backdrop-blur-md`;

    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', type === 'success' ? 'check-circle-2' : 'alert-circle');
    icon.className = 'w-4 h-4 shrink-0';

    const span = document.createElement('span');
    span.textContent = esc(message);

    toast.appendChild(icon);
    toast.appendChild(span);
    document.body.appendChild(toast);

    if (window.lucide) window.lucide.createIcons();

    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        toast.classList.add('opacity-0', '-translate-y-4');
        setTimeout(() => toast.remove(), 300);
    }, 3200);
}

export default showNotification;
