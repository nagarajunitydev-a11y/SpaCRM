/**
 * publicBookingView.js
 * Pure render functions for the public, no-login booking wizard.
 *
 * Reuses the CRM's existing form/UI primitives (ui/components.js) and
 * escaping helpers (core/sanitize.js) for visual and security consistency
 * with the authenticated app — this module contains no business rules of its
 * own; every number/decision it displays was computed by
 * services/publicBookingService.js or core/scheduling.js.
 */

import { esc, escAttr } from '../core/sanitize.js';
import {
    logoMark, sectionHeader, formField, textInput, phoneInput, emptyState, badge,
} from '../ui/components.js';
import { formatCurrency } from '../core/utils.js';
import { totalDurationMinutes, totalServicePrice, ANY_STAFF } from '../core/scheduling.js';

const STEP_LABELS = ['Services', 'Date & Time', 'Your Details', 'Review'];

function shell(innerHtml) {
    return `
        <div class="app-shell h-full flex flex-col w-full max-w-md mx-auto bg-slate-950 shadow-2xl overflow-hidden relative border-x border-slate-800">
            ${innerHtml}
        </div>
    `;
}

function centered(iconName, title, message, extra = '') {
    return shell(`
        <div class="flex-1 flex flex-col items-center justify-center text-center p-6">
            <div class="w-16 h-16 rounded-3xl bg-slate-900 border border-slate-800 flex items-center justify-center mb-5 text-brand-400">
                <i data-lucide="${escAttr(iconName)}" class="w-8 h-8"></i>
            </div>
            <h2 class="text-lg font-extrabold text-white mb-2">${esc(title)}</h2>
            <p class="text-xs text-slate-400 max-w-xs">${esc(message)}</p>
            ${extra}
        </div>
    `);
}

export function renderLoading() {
    return centered('loader', 'Loading…', 'Fetching booking availability.');
}

export function renderNotFound() {
    return centered('search-x', 'Booking link not found', 'This booking link is invalid. Please double-check the link you were sent.');
}

export function renderDisabled(salonName) {
    return centered('calendar-off', 'Online booking unavailable', `${salonName || 'This salon'} isn't taking online bookings right now. Please contact them directly to book an appointment.`);
}

export function renderFatalError(message) {
    return centered('alert-triangle', 'Something went wrong', message || 'Please refresh the page and try again.');
}

function header(state) {
    return `
        <header class="bg-slate-900/80 backdrop-blur-xl border-b border-slate-800/80 px-4 py-3.5 flex items-center gap-2.5 sticky top-0 z-30">
            ${logoMark()}
            <div class="min-w-0">
                <h1 class="font-bold text-xs text-slate-100 tracking-tight truncate">${esc(state.settings.displayName || 'Book an Appointment')}</h1>
                <p class="text-[9px] text-brand-400 font-semibold uppercase tracking-wider truncate">Online Booking</p>
            </div>
        </header>
    `;
}

function stepper(step) {
    return `
        <div class="flex items-center gap-1.5 px-4 pt-4">
            ${STEP_LABELS.map((label, i) => {
                const n = i + 1;
                const state = n < step ? 'done' : n === step ? 'active' : 'todo';
                const dot = state === 'done'
                    ? '<i data-lucide="check" class="w-3 h-3"></i>'
                    : `<span>${n}</span>`;
                const cls = state === 'todo' ? 'bg-slate-900 border border-slate-800 text-slate-500' : 'bg-brand-600 text-white';
                return `
                    <div class="flex-1 flex flex-col items-center gap-1">
                        <div class="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${cls}">${dot}</div>
                        <span class="text-[9px] font-semibold ${state === 'todo' ? 'text-slate-500' : 'text-slate-300'} text-center leading-tight">${esc(label)}</span>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function footerNav({ backLabel = 'Back', nextLabel = 'Continue', nextAction = 'wizard-next', nextDisabled = false, showBack = true, nextData = {} }) {
    const dataAttrs = Object.entries(nextData).map(([k, v]) => `data-${escAttr(k)}="${escAttr(v)}"`).join(' ');
    return `
        <div class="sticky bottom-0 bg-slate-950/95 backdrop-blur border-t border-slate-800/80 p-4 flex gap-2.5">
            ${showBack ? `
                <button data-action="wizard-back" class="px-4 py-3.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-xs font-bold rounded-xl transition active:scale-95 touch-manipulation">
                    ${esc(backLabel)}
                </button>
            ` : ''}
            <button data-action="${escAttr(nextAction)}" ${dataAttrs} ${nextDisabled ? 'disabled' : ''}
                class="flex-1 py-3.5 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none">
                ${esc(nextLabel)}
            </button>
        </div>
    `;
}

/* ------------------------------------------------------------------ */
/* Step 1 — services                                                   */
/* ------------------------------------------------------------------ */

function serviceCard(service, selected) {
    return `
        <button type="button" data-action="toggle-service" data-name="${escAttr(service.name)}"
            class="w-full flex items-center justify-between gap-3 p-3.5 rounded-2xl border text-left transition active:scale-[0.98] touch-manipulation ${selected ? 'bg-brand-600/15 border-brand-500/40' : 'bg-slate-900 border-slate-800 hover:border-slate-700'}">
            <div class="min-w-0">
                <p class="text-xs font-bold ${selected ? 'text-brand-300' : 'text-slate-100'} truncate">${esc(service.name)}</p>
                <p class="text-[10px] text-slate-400 mt-0.5">${esc(service.duration || '')}${service.duration ? ' • ' : ''}${esc(formatCurrency(service.price))}</p>
            </div>
            <div class="w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${selected ? 'bg-brand-600 text-white' : 'bg-slate-800 text-transparent'}">
                <i data-lucide="check" class="w-3.5 h-3.5"></i>
            </div>
        </button>
    `;
}

export function renderStepServices(state) {
    const services = state.settings.publicServices || [];
    const selected = new Set(state.selectedServices);
    const totalPrice = totalServicePrice(state.selectedServices, services);
    const totalMinutes = totalDurationMinutes(state.selectedServices, services);

    const body = services.length === 0
        ? emptyState('No services are available to book right now.')
        : `<div class="space-y-2">${services.map((s) => serviceCard(s, selected.has(s.name))).join('')}</div>`;

    const summary = selected.size > 0 ? `
        <div class="flex items-center justify-between bg-slate-900/60 border border-slate-800/60 rounded-2xl p-3 mt-3">
            <span class="text-[11px] text-slate-400">${selected.size} service${selected.size !== 1 ? 's' : ''} • ${totalMinutes} min</span>
            <span class="text-sm font-extrabold text-emerald-400">${esc(formatCurrency(totalPrice))}</span>
        </div>
    ` : '';

    return `
        <main class="flex-1 overflow-y-auto p-4 pb-6 no-scrollbar">
            ${sectionHeader('Select Services', 'Choose one or more services')}
            <div class="mt-4">${body}${summary}</div>
        </main>
        ${footerNav({ showBack: false, nextDisabled: selected.size === 0 })}
    `;
}

/* ------------------------------------------------------------------ */
/* Step 2 — staff, date & time                                         */
/* ------------------------------------------------------------------ */

function staffChip(name, label, active) {
    return `
        <button type="button" data-action="pick-staff" data-name="${escAttr(name)}"
            class="shrink-0 px-3.5 py-2.5 rounded-xl text-[11px] font-semibold border transition touch-manipulation active:scale-95 ${active ? 'bg-brand-600 border-brand-500 text-white' : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'}">
            ${esc(label)}
        </button>
    `;
}

function slotButton(slot, activeTime) {
    const active = slot.time === activeTime;
    return `
        <button type="button" data-action="pick-slot" data-time="${escAttr(slot.time)}" data-staff="${escAttr(slot.staffName)}"
            class="px-2 py-2.5 rounded-xl text-[11px] font-bold border transition touch-manipulation active:scale-95 ${active ? 'bg-brand-600 border-brand-500 text-white' : 'bg-slate-900 border-slate-800 text-slate-200 hover:border-slate-700'}">
            ${esc(slot.time)}
        </button>
    `;
}

export function renderStepSchedule(state) {
    const staff = state.settings.publicStaff || [];
    const today = state.today;
    const maxDate = state.maxDate;

    const staffRow = `
        <div class="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
            ${staffChip(ANY_STAFF, 'Any Available', state.staffChoice === ANY_STAFF)}
            ${staff.map((s) => staffChip(s.name, s.name, state.staffChoice === s.name)).join('')}
        </div>
    `;

    const dateRow = formField('Date', `
        <input type="date" name="date" value="${escAttr(state.date)}" min="${escAttr(today)}" max="${escAttr(maxDate)}"
            data-action="pick-date"
            class="w-full bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500">
    `);

    let slotsBlock = '';
    if (!state.staffChoice || !state.date) {
        slotsBlock = `<p class="text-[11px] text-slate-500 text-center py-6">Choose a staff member and date to see available times.</p>`;
    } else if (state.slotsLoading) {
        slotsBlock = `<p class="text-[11px] text-slate-500 text-center py-6 flex items-center justify-center gap-2"><i data-lucide="loader" class="w-4 h-4 animate-spin"></i>Checking availability…</p>`;
    } else if (state.availableSlots.length === 0) {
        slotsBlock = emptyState('No available times on this date. Try another date or staff member.');
    } else {
        slotsBlock = `<div class="grid grid-cols-4 gap-2">${state.availableSlots.map((s) => slotButton(s, state.time)).join('')}</div>`;
    }

    return `
        <main class="flex-1 overflow-y-auto p-4 pb-6 no-scrollbar space-y-4">
            ${sectionHeader('Date & Time', 'Pick a staff member, date and time')}
            <div>
                <label class="block text-[11px] font-semibold text-slate-400 uppercase mb-1.5">Staff Member</label>
                ${staffRow}
            </div>
            ${dateRow}
            <div>
                <label class="block text-[11px] font-semibold text-slate-400 uppercase mb-1.5">Available Times</label>
                ${slotsBlock}
            </div>
        </main>
        ${footerNav({ nextDisabled: !state.staffChoice || !state.date || !state.time })}
    `;
}

/* ------------------------------------------------------------------ */
/* Step 3 — customer details                                           */
/* ------------------------------------------------------------------ */

function textareaField(name, placeholder, value) {
    return `
        <textarea name="${escAttr(name)}" rows="3" placeholder="${escAttr(placeholder)}"
            class="w-full bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500 resize-none">${esc(value || '')}</textarea>
    `;
}

export function renderStepDetails(state) {
    const d = state.draft || {};
    return `
        <main class="flex-1 overflow-y-auto p-4 pb-6 no-scrollbar">
            ${sectionHeader('Your Details', 'So we can confirm your booking')}
            <form id="booking-details-form" class="space-y-3.5 mt-4" novalidate>
                ${formField('Full Name', textInput('customerName', 'Your name', { value: d.customerName }))}
                ${formField('Mobile Number', phoneInput('customerPhone', { value: d.customerPhone }), 'Enter exactly 10 digits — e.g. 98765 43210.')}
                ${formField('Email (optional)', textInput('customerEmail', 'you@example.com', { type: 'email', required: false, autocomplete: 'email', value: d.customerEmail }))}
                ${formField('Referral Code (optional)', textInput('referralCode', 'e.g. PRIY4K7M', { required: false, className: 'uppercase tracking-widest font-mono', value: d.referralCode }), state.referralApplied ? 'Referral code applied from your link.' : '')}
                ${formField('Notes (optional)', textareaField('notes', 'Anything we should know?', d.notes))}
            </form>
            <p id="booking-details-error" class="text-[11px] text-rose-400 font-semibold mt-3 hidden"></p>
        </main>
        ${footerNav({ nextAction: 'wizard-next-details', nextLabel: 'Continue' })}
    `;
}

/* ------------------------------------------------------------------ */
/* Step 4 — review                                                     */
/* ------------------------------------------------------------------ */

function reviewRow(label, value, cls = 'text-slate-200') {
    return `
        <div class="flex items-center justify-between gap-3">
            <span class="text-[11px] text-slate-400">${esc(label)}</span>
            <span class="text-xs font-bold ${escAttr(cls)} text-right">${esc(value)}</span>
        </div>
    `;
}

export function renderStepReview(state) {
    const services = state.settings.publicServices || [];
    const totalPrice = totalServicePrice(state.selectedServices, services);
    const totalMinutes = totalDurationMinutes(state.selectedServices, services);
    const d = state.draft || {};

    return `
        <main class="flex-1 overflow-y-auto p-4 pb-6 no-scrollbar space-y-3">
            ${sectionHeader('Review Booking', 'Confirm the details below')}

            <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2">
                ${reviewRow('Services', state.selectedServices.join(', '))}
                ${reviewRow('Duration', `${totalMinutes} min`)}
                ${reviewRow('Staff', state.staffChoice)}
                ${reviewRow('Date', state.date)}
                ${reviewRow('Time', state.time)}
                <div class="h-px bg-slate-800 my-1"></div>
                ${reviewRow('Estimated Amount', formatCurrency(totalPrice), 'text-emerald-400')}
            </div>

            <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2">
                ${reviewRow('Name', d.customerName)}
                ${reviewRow('Mobile', d.customerPhone)}
                ${d.customerEmail ? reviewRow('Email', d.customerEmail) : ''}
                ${d.referralCode ? reviewRow('Referral Code', d.referralCode.toUpperCase()) : ''}
                ${d.notes ? reviewRow('Notes', d.notes) : ''}
            </div>

            ${state.formError ? `<p class="text-[11px] text-rose-400 font-semibold text-center">${esc(state.formError)}</p>` : ''}
        </main>
        ${footerNav({ nextAction: 'submit-booking', nextLabel: state.submitting ? 'Booking…' : 'Confirm Booking', nextDisabled: state.submitting })}
    `;
}

/* ------------------------------------------------------------------ */
/* Confirmation                                                        */
/* ------------------------------------------------------------------ */

export function renderConfirmation(state) {
    const c = state.confirmation;
    return `
        <main class="flex-1 overflow-y-auto p-6 no-scrollbar flex flex-col">
            <div class="text-center py-4">
                <div class="w-16 h-16 mx-auto rounded-3xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center mb-4">
                    <i data-lucide="check-circle-2" class="w-8 h-8"></i>
                </div>
                <h2 class="text-lg font-extrabold text-white">Booking Confirmed!</h2>
                <p class="text-xs text-slate-400 mt-1">We look forward to seeing you.</p>
            </div>

            <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2 mt-2">
                ${reviewRow('Appointment ID', c.appointmentId.slice(-10).toUpperCase())}
                ${reviewRow('Name', c.customerName)}
                ${reviewRow('Services', c.services.map((s) => s.name).join(', '))}
                ${reviewRow('Date', c.date)}
                ${reviewRow('Time', c.time)}
                ${reviewRow('Staff', c.staffName)}
                <div class="h-px bg-slate-800 my-1"></div>
                ${reviewRow('Estimated Amount', formatCurrency(c.estimatedAmount), 'text-emerald-400')}
                <div class="flex items-center justify-between">
                    <span class="text-[11px] text-slate-400">Status</span>
                    ${badge(c.status, 'bg-blue-500/15 text-blue-400')}
                </div>
            </div>

            ${c.referralApplied ? `<p class="text-[11px] text-brand-400 text-center mt-3">Your referral code has been applied 🎉</p>` : ''}

            <button data-action="book-another" class="mt-6 w-full py-3.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 text-xs font-bold rounded-xl transition active:scale-[0.98] touch-manipulation">
                Book Another Appointment
            </button>
        </main>
    `;
}

/* ------------------------------------------------------------------ */
/* Root dispatcher                                                     */
/* ------------------------------------------------------------------ */

export function renderPublicBooking(state) {
    if (state.phase === 'loading') return renderLoading();
    if (state.phase === 'not-found') return renderNotFound();
    if (state.phase === 'disabled') return renderDisabled(state.salonDisplayName);
    if (state.phase === 'error') return renderFatalError(state.errorMessage);

    if (state.phase === 'confirmed') {
        return shell(`${header(state)}${renderConfirmation(state)}`);
    }

    const stepBody = state.step === 1 ? renderStepServices(state)
        : state.step === 2 ? renderStepSchedule(state)
            : state.step === 3 ? renderStepDetails(state)
                : renderStepReview(state);

    return shell(`${header(state)}${stepper(state.step)}${stepBody}`);
}

export default renderPublicBooking;
