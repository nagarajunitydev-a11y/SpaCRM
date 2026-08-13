/**
 * sanitize.js
 * Reusable sanitization / escaping wrappers for every dynamic or interpolated
 * value rendered into the DOM.
 *
 * - `esc`    escapes text interpolated into element body content.
 * - `escAttr`escapes values placed inside HTML attributes.
 * - `escUrl` allows only safe URL schemes / relative paths.
 * - `escStyle` neutralises dangerous CSS values.
 * - `sanitizeDOM` is a belt-and-suspenders pass that strips scripts, event
 *   handler attributes, and unsafe URL attributes from any rendered node.
 */

const ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;',
};

function escapeString(value) {
    return String(value).replace(/[&<>"'`]/g, (ch) => ESCAPE_MAP[ch]);
}

/**
 * Escape a value for use in element text content or HTML attributes.
 * `null`/`undefined` render as an empty string.
 */
export function esc(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
        try {
            return escapeString(JSON.stringify(value));
        } catch (e) {
            return '';
        }
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return escapeString(value);
}

/** Escape a value placed inside an HTML attribute (including quotes). */
export function escAttr(value) {
    return esc(value);
}

/** Scheme allow-list for URLs (protects href/src against javascript:). */
const SAFE_URL_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];

/**
 * Allow only safe absolute URLs or relative paths. Returns '#' for anything
 * unsafe so navigation can never execute script.
 */
export function escUrl(value) {
    if (value === null || value === undefined || value === '') return '#';
    const raw = String(value).trim();
    if (raw === '' || raw === '#') return '#';
    // Relative URLs (no scheme, not starting with '//').
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
        if (raw.startsWith('//')) return '#';
        return raw;
    }
    try {
        const url = new URL(raw, 'https://localhost');
        return SAFE_URL_SCHEMES.includes(url.protocol) ? url.href : '#';
    } catch (e) {
        return '#';
    }
}

/** Escape a value used inside a CSS style context. */
export function escStyle(value) {
    if (value === null || value === undefined) return '';
    const raw = String(value);
    if (raw.length > 512) return '';
    if (/(expression|javascript:|url\(|@import|behavior)/i.test(raw)) return '';
    return raw.replace(/['"\\;]/g, '');
}

/** A safe wrapper for building trusted static HTML with escaped interpolation. */
export function html(strings, ...values) {
    return strings.reduce((acc, str, i) => acc + str + (i < values.length ? esc(values[i]) : ''), '');
}

const DANGEROUS_ATTR_RE = /^on[a-z]/i;

function sanitizeNode(node) {
    if (node.nodeType === 1) {
        const el = node;
        const attrs = Array.from(el.attributes || []);
        for (const attr of attrs) {
            const name = attr.name;
            const value = attr.value || '';
            if (DANGEROUS_ATTR_RE.test(name) || name.toLowerCase() === 'srcdoc') {
                el.removeAttribute(name);
                continue;
            }
            if ((name === 'href' || name === 'src' || name === 'action' || name === 'xlink:href') && !isSafeUrl(value)) {
                el.removeAttribute(name);
            }
            if (name === 'style') {
                el.setAttribute('style', escStyle(value));
            }
        }
        // Remove dangerous elements entirely.
        if (el.tagName === 'SCRIPT' || el.tagName === 'IFRAME' || el.tagName === 'OBJECT' || el.tagName === 'EMBED') {
            el.remove();
            return;
        }
    }
    // Recurse children.
    const children = Array.from(node.childNodes || []);
    for (const child of children) {
        sanitizeNode(child);
    }
}

function isSafeUrl(value) {
    const raw = String(value || '').trim();
    if (raw === '' || raw === '#') return true;
    if (/^\s*(javascript|vbscript|data):/i.test(raw)) return false;
    return true;
}

/**
 * Post-render guard. Runs after `innerHTML` is set to remove any remaining
 * executable attributes / elements that might have slipped through.
 */
export function sanitizeDOM(root) {
    if (!root) return;
    const children = Array.from(root.childNodes || []);
    for (const child of children) {
        sanitizeNode(child);
    }
}

export default {
    esc,
    escAttr,
    escUrl,
    escStyle,
    html,
    sanitizeDOM,
};
