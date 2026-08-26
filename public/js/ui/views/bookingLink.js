/**
 * views/bookingLink.js
 * Owner-facing "Booking Link" panel: the shareable public booking URL (copy /
 * open / WhatsApp share / QR code) plus the online-booking configuration
 * (enable toggle, working hours, slot interval, advance booking window,
 * minimum notice). Presentation only — every value shown/submitted here is
 * validated by core/bookingConfig.js and written through
 * bookingSettingsRepository.js; this module owns no business rules.
 */

import { esc, escAttr, escUrl } from '../../core/sanitize.js';
import { formField, textInput } from '../components.js';
import { WEEKDAY_KEYS, WEEKDAY_LABELS, sanitizeBookingSettings } from '../../core/bookingConfig.js';

/** The canonical, always-clean shareable link for a salon. */
export function bookingLinkFor(salonId, origin = window.location.origin) {
    return `${origin}/book/${encodeURIComponent(salonId)}`;
}

function toggleRow(name, label, hint, checked) {
    return `
        <label class="flex items-start justify-between gap-3 bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3.5 cursor-pointer">
            <span class="min-w-0">
                <span class="block text-xs font-bold text-slate-100">${esc(label)}</span>
                ${hint ? `<span class="block text-[10px] text-slate-400 mt-0.5">${esc(hint)}</span>` : ''}
            </span>
            <input type="checkbox" name="${escAttr(name)}" ${checked ? 'checked' : ''}
                class="mt-0.5 w-5 h-5 shrink-0 rounded-md bg-slate-950 border border-slate-700 accent-brand-500 cursor-pointer">
        </label>
    `;
}

function timeInput(name, value, disabled) {
    return `
        <input type="time" name="${escAttr(name)}" value="${escAttr(value)}" ${disabled ? 'disabled' : ''}
            class="w-full bg-slate-950 border border-slate-800 px-2.5 py-2 rounded-lg text-[11px] text-slate-100 focus:outline-none focus:border-brand-500 disabled:opacity-40">
    `;
}

function dayRow(key, day) {
    const closed = day.closed === true;
    return `
        <div class="flex items-center gap-2 bg-slate-950/60 border border-slate-800/60 rounded-xl p-2.5">
            <label class="flex items-center gap-1.5 w-20 shrink-0 cursor-pointer">
                <input type="checkbox" name="closed_${escAttr(key)}" ${closed ? 'checked' : ''} data-action="toggle-day-closed" data-day="${escAttr(key)}"
                    class="w-4 h-4 rounded bg-slate-950 border border-slate-700 accent-rose-500 cursor-pointer">
                <span class="text-[11px] font-semibold text-slate-300">${esc(WEEKDAY_LABELS[key].slice(0, 3))}</span>
            </label>
            <div class="flex-1 grid grid-cols-2 gap-1.5">
                ${timeInput(`start_${key}`, day.start, closed)}
                ${timeInput(`end_${key}`, day.end, closed)}
            </div>
        </div>
    `;
}

function linkActions(link) {
    // The WhatsApp button shares a variant carrying `src=whatsapp`, so a
    // booking made from a click on THIS link is honestly attributable to
    // WhatsApp; Copy/Open/QR share the plain, undecorated link and any
    // booking made through them is recorded as the generic `public_booking`
    // source instead (see publicBookingApp.js's source detection).
    const waLink = `${link}${link.includes('?') ? '&' : '?'}src=whatsapp`;
    const shareText = encodeURIComponent(`Book your appointment here: ${waLink}`);
    return `
        <div class="bg-brand-500/10 border border-brand-500/25 rounded-2xl p-4">
            <p class="text-[10px] font-bold text-brand-300 uppercase tracking-widest mb-1.5">Public Booking Link</p>
            <p class="text-[11px] text-slate-200 font-mono break-all bg-slate-950/60 rounded-xl p-2.5">${esc(link)}</p>
            <div class="grid grid-cols-2 gap-2 mt-3">
                <button type="button" data-action="copy-booking-link" data-link="${escAttr(link)}"
                    class="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 text-[11px] font-semibold rounded-xl transition active:scale-95 touch-manipulation">
                    <i data-lucide="copy" class="w-3.5 h-3.5"></i><span>Copy Link</span>
                </button>
                <a href="${escUrl(link)}" target="_blank" rel="noopener noreferrer"
                    class="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 text-[11px] font-semibold rounded-xl transition active:scale-95 touch-manipulation">
                    <i data-lucide="external-link" class="w-3.5 h-3.5"></i><span>Open Link</span>
                </a>
                <a href="${escUrl(`https://wa.me/?text=${shareText}`)}" target="_blank" rel="noopener noreferrer"
                    class="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold rounded-xl transition active:scale-95 touch-manipulation">
                    <i data-lucide="message-circle" class="w-3.5 h-3.5"></i><span>WhatsApp</span>
                </a>
                <button type="button" data-action="toggle-booking-qr"
                    class="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 text-[11px] font-semibold rounded-xl transition active:scale-95 touch-manipulation">
                    <i data-lucide="qr-code" class="w-3.5 h-3.5"></i><span>QR Code</span>
                </button>
            </div>
            <div id="booking-link-qr" class="hidden mt-3 bg-white rounded-2xl p-3 flex items-center justify-center"></div>
        </div>
    `;
}

export function renderBookingLinkModal(state) {
    const salonId = state.currentSalonId;
    const settings = sanitizeBookingSettings(state.bookingSettings);
    const link = bookingLinkFor(salonId);

    return `
        <form data-action="submit-booking-settings" class="space-y-4" novalidate>
            ${linkActions(link)}

            ${toggleRow('enabled', 'Online Booking', 'Let customers book appointments from this link without an account.', settings.enabled)}

            ${formField('Display Name', textInput('displayName', 'Your salon name', { required: false, value: settings.displayName }), 'Shown at the top of the booking page.')}

            <div class="grid grid-cols-3 gap-2.5">
                ${formField('Slot (min)', textInput('slotIntervalMinutes', '30', { type: 'number', className: 'input-number', value: settings.slotIntervalMinutes }))}
                ${formField('Book Ahead (days)', textInput('advanceBookingDays', '30', { type: 'number', className: 'input-number', value: settings.advanceBookingDays }))}
                ${formField('Min Notice (min)', textInput('minNoticeMinutes', '60', { type: 'number', className: 'input-number', value: settings.minNoticeMinutes }))}
            </div>

            <div>
                <label class="block text-[11px] font-semibold text-slate-400 uppercase mb-1.5">Working Hours</label>
                <div class="space-y-1.5">
                    ${WEEKDAY_KEYS.map((key) => dayRow(key, settings.workingHours[key])).join('')}
                </div>
            </div>

            <button type="submit" class="w-full py-3.5 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none">Save Booking Settings</button>
        </form>
    `;
}

export default renderBookingLinkModal;
