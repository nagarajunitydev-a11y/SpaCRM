/**
 * draft.js
 * Non-reactive draft storage for in-progress forms.
 *
 * The app re-renders from the store on every state change (e.g. when a realtime
 * listener delivers a new document). Long forms like "Book Appointment" would
 * lose their entered values whenever such a background refresh happens. Drafts
 * are kept OUTSIDE the store so writing to them never triggers a re-render, but
 * the view renderers can still read them to restore a form after one.
 */

const drafts = {};

/** Persist a snapshot of a form's current values under `key`. */
export function saveDraft(key, data) {
    drafts[key] = { ...data };
}

/** Read the saved draft for a form key, or null when none exists. */
export function getDraft(key) {
    return drafts[key] || null;
}

/** Clear the draft for a form key (open/close/submit). */
export function clearDraft(key) {
    delete drafts[key];
}

export default { saveDraft, getDraft, clearDraft };
