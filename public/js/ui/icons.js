/**
 * icons.js
 * Thin wrapper around the Lucide icon renderer.
 */

import { escAttr } from '../core/sanitize.js';

/** Returns an `<i>` element for a lucide icon. Names are developer-controlled. */
export function icon(name, cls = 'w-4 h-4') {
    return `<i data-lucide="${escAttr(name)}" class="${escAttr(cls)}"></i>`;
}

/** Re-render all lucide icons inside a root element. */
export function refreshIcons(root) {
    if (window.lucide && window.lucide.createIcons) {
        window.lucide.createIcons({ root });
    }
}

export default icon;
