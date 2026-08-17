/**
 * views/modals.js
 * Modal bottom-sheet with all entity forms (client, service, staff,
 * appointment, salon). Forms use `data-action` and are read via FormData by
 * the central submit delegation — no inline scripts, all values escaped.
 */

import { esc, escAttr } from '../../core/sanitize.js';
import { formField, textInput, phoneInput, selectControl, dateTimeInput } from '../components.js';
import { REWARD_TIERS } from '../../core/rewards.js';
import { getDraft } from '../../core/draft.js';
import { scopedBySalon } from '../../core/utils.js';

const TITLES = {
    customer: 'Add New Client',
    service: 'Add New Service',
    staff: 'Register Staff',
    appointment: 'Book Appointment',
    salon: 'Provision New Salon',
    rewards: 'Client Rewards',
    'referral-info': 'Referral Rewards Program',
    'confirm-delete': 'Confirm Deletion',
};

const EDIT_TITLES = {
    customer: 'Edit Client',
    service: 'Edit Service',
    staff: 'Edit Staff Details',
    appointment: 'Edit Appointment',
    salon: 'Edit Salon',
};

export function renderModalSheet(state) {
    const type = state.modalType;
    const isEditing = !!(state.modalRecord && state.modalRecord.id);
    const title = isEditing ? (EDIT_TITLES[type] || TITLES[type] || 'Details') : (TITLES[type] || 'Details');

    return `
        <div class="absolute inset-0 bg-black/85 backdrop-blur-sm z-50 flex flex-col justify-end" data-action="modal-backdrop">
            <div class="bg-slate-900 border-t border-slate-800 rounded-t-3xl p-6 max-h-[85vh] overflow-y-auto shadow-2xl no-scrollbar" role="dialog" aria-modal="true" aria-label="${escAttr(title)}">
                <div class="flex items-center justify-between mb-5">
                    <h3 class="font-bold text-base text-slate-100 capitalize">${esc(title)}</h3>
                    <button data-action="close-modal" aria-label="Close" class="w-8 h-8 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center hover:bg-slate-700 transition active:scale-95 touch-manipulation">
                        <i data-lucide="x" class="w-4 h-4"></i>
                    </button>
                </div>

                ${renderForm(state, type)}
            </div>
        </div>
    `;
}

/** Look up the record being edited (if any) for the current modal type. */
function editingRecord(state, type) {
    const id = state.modalRecord && state.modalRecord.id;
    if (!id) return null;
    const key = { customer: 'customersList', service: 'servicesList', staff: 'staffList', appointment: 'appointmentsList' }[type];
    return (key && (state[key] || []).find((r) => r.id === id)) || null;
}

function renderForm(state, type) {
    const services = scopedBySalon(state.servicesList, state.currentSalonId);
    const staff = scopedBySalon(state.staffList, state.currentSalonId);

    if (type === 'rewards') {
        return renderRewardsModal(state);
    }

    if (type === 'referral-info') {
        return renderReferralInfo();
    }

    if (type === 'confirm-delete') {
        return renderDeleteConfirm(state);
    }

    if (type === 'customer') {
        const rec = editingRecord(state, 'customer');
        return `
            <form data-action="submit-customer" class="space-y-3.5" novalidate>
                ${rec ? `<input type="hidden" name="id" value="${escAttr(rec.id)}">` : ''}
                ${formField('Full Name', textInput('name', 'Olivia Wilde', { value: rec?.name }))}
                ${formField('Phone', phoneInput('phone', { value: rec?.phone }), 'Enter exactly 10 digits — e.g. 98765 43210.')}
                ${formField('Email', textInput('email', 'olivia@example.com', { type: 'email', autocomplete: 'email', value: rec?.email }))}
                ${rec ? '' : formField('Referral Code (optional)', textInput('referralCode', 'LG-XXXXXX', { required: false }), 'The friend or salon who referred this client.')}
                <button type="submit" disabled class="w-full py-3.5 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none">${rec ? 'Save Changes' : 'Save Client (100 Bonus Pts)'}</button>
            </form>
        `;
    }

    if (type === 'service') {
        const rec = editingRecord(state, 'service');
        return `
            <form data-action="submit-service" class="space-y-3.5" novalidate>
                ${rec ? `<input type="hidden" name="id" value="${escAttr(rec.id)}">` : ''}
                ${formField('Service Title', textInput('name', 'Keratin Treatment', { value: rec?.name }))}
                ${formField('Price (₹)', textInput('price', '140', { type: 'number', className: 'input-number', value: rec?.price }))}
                ${formField('Duration', textInput('duration', '90m', { value: rec?.duration }))}
                <button type="submit" disabled class="w-full py-3.5 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none">${rec ? 'Save Changes' : 'Add Service'}</button>
            </form>
        `;
    }

    if (type === 'staff') {
        const rec = editingRecord(state, 'staff');
        return `
            <form data-action="submit-staff" class="space-y-3.5" novalidate>
                ${rec ? `<input type="hidden" name="id" value="${escAttr(rec.id)}">` : ''}
                ${formField('Staff Name', textInput('name', 'Chloe Grace', { value: rec?.name }))}
                ${formField('Role / Specialization', textInput('role', 'Senior Hair Stylist', { value: rec?.role }))}
                ${formField('Phone', phoneInput('phone', { value: rec?.phone }), 'Enter exactly 10 digits — e.g. 98765 43210.')}
                <button type="submit" disabled class="w-full py-3.5 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none">${rec ? 'Save Changes' : 'Register Staff'}</button>
            </form>
        `;
    }

    if (type === 'appointment') {
        const rec = editingRecord(state, 'appointment');
        // Seed from the record being edited, merged with any live draft so a
        // background store refresh (e.g. a quick-added customer) never wipes
        // in-progress edits. New bookings seed purely from the draft.
        const draft = getDraft('appointment') || {};
        const pre = rec ? { ...rec, ...draft } : draft;
        const statusOptions = [
            { value: 'Confirmed', label: 'Confirmed' },
            { value: 'Cancelled', label: 'Cancelled' },
        ];
        return `
            <form data-action="submit-appointment" class="space-y-3.5" novalidate>
                ${rec ? `<input type="hidden" name="id" value="${escAttr(rec.id)}">` : ''}
                ${renderCustomerPicker(pre)}
                ${formField('Select Service', selectControl('serviceName', services.map((s) => ({ value: s.name, label: `${s.name} (₹${s.price})` })), 'Choose a service', { value: pre?.serviceName }))}
                ${formField('Assigned Stylist', selectControl('staffName', staff.map((st) => ({ value: st.name, label: `${st.name} (${st.role})` })), 'Choose a stylist', { value: pre?.staffName }))}
                <div class="grid grid-cols-2 gap-3">
                    <div>${formField('Date', dateTimeInput('date', 'date', '', { value: pre?.date }))}</div>
                    <div>${formField('Time', dateTimeInput('time', 'time', '', { value: pre?.time }))}</div>
                </div>
                ${rec ? formField('Status', selectControl('status', statusOptions, '', { value: pre?.status || 'Confirmed' })) : ''}
                <button type="submit" disabled class="w-full py-3.5 bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none">${rec ? 'Save Changes' : 'Confirm Booking'}</button>
            </form>
        `;
    }

    // Default: provision new salon.
    const rec = editingRecord(state, 'salon');
    return `
        <form data-action="submit-salon" class="space-y-3.5" novalidate>
            ${rec ? `<input type="hidden" name="id" value="${escAttr(rec.id)}">` : ''}
            ${formField('Salon Branch Name', textInput('name', 'Luxe Glow SoHo', { value: rec?.name }))}
            ${formField('Owner Email', textInput('email', 'owner@sohostudio.com', { type: 'email', autocomplete: 'email', value: rec?.ownerEmail ?? rec?.email }))}
            ${formField('Phone', phoneInput('phone', { value: rec?.phone }), 'Enter exactly 10 digits — e.g. 98765 43210.')}
            ${formField('Location Address', textInput('address', '78 Mercer St, New York', { value: rec?.address }))}
            <button type="submit" disabled class="w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-indigo-600/30 transition mt-2 active:scale-[0.98] touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none">${rec ? 'Save Changes' : 'Provision Branch'}</button>
        </form>
    `;
}

/**
 * Searchable client picker for the appointment form.
 * - `customerName`: free-text input (name OR phone) that drives suggestions.
 * - `customerId`: hidden link to the chosen customer row (the appointment is
 *   stored against this id, keeping a stable reference).
 * Suggestions are rendered imperatively by main.js (customer-search action)
 * into the `[data-customer-suggestions]` container so typing never re-renders
 * the whole modal and loses focus.
 */
function renderCustomerPicker(pre) {
    const name = pre?.customerName || '';
    const id = pre?.customerId || '';
    return `
        <div>
            <label class="block text-[11px] font-semibold text-slate-400 uppercase mb-1">Client</label>
            <div class="relative">
                <input type="text" name="customerName" required autocomplete="off"
                    value="${escAttr(name)}" placeholder="Search name or phone…"
                    data-action="customer-search"
                    class="w-full bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl text-xs text-slate-100 focus:outline-none focus:border-brand-500 pr-9">
                <i data-lucide="search" class="w-4 h-4 text-slate-500 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none"></i>
            </div>
            <input type="hidden" name="customerId" value="${escAttr(id)}">
            <div data-customer-suggestions class="mt-2"></div>
            <p class="mt-1 text-[10px] text-slate-500">Start typing to find an existing client, or add a new one below.</p>
        </div>
    `;
}

/**
 * Render the suggestion list (matching clients + "add new") for the customer
 * picker. `matches` are already-filtered client rows; `query` is the typed
 * value; `opts.exactName` / `opts.selectedId` tune which rows show. Exported so
 * main.js can fill the dropdown imperatively without re-rendering the modal.
 */
export function renderCustomerSuggestions(matches, query, opts = {}) {
    const { exactName, selectedId } = opts || {};
    const q = (query || '').trim();
    const list = (matches || [])
        .filter((c) => c.id !== selectedId)
        .slice(0, 6)
        .map((c) => `
            <button type="button" data-action="pick-customer" data-id="${escAttr(c.id)}" data-name="${escAttr(c.name)}"
                class="w-full flex items-center justify-between gap-3 bg-slate-950 border border-slate-800 px-4 py-2.5 rounded-xl text-left transition active:scale-[0.98] touch-manipulation">
                <span class="min-w-0">
                    <span class="block text-xs font-semibold text-slate-100 truncate">${esc(c.name)}</span>
                    <span class="block text-[10px] text-slate-400 truncate">${esc(c.phone || 'No phone on file')}</span>
                </span>
                <span class="text-brand-400 shrink-0"><i data-lucide="user-check" class="w-4 h-4"></i></span>
            </button>
        `).join('');

    const addNew = q.length > 0 && !exactName ? `
        <button type="button" data-action="quick-add-customer" data-name="${escAttr(q)}"
            class="w-full flex items-center gap-3 bg-brand-600/15 border border-brand-500/30 px-4 py-2.5 rounded-xl text-left transition active:scale-[0.98] touch-manipulation">
            <span class="text-brand-400 shrink-0"><i data-lucide="user-plus" class="w-4 h-4"></i></span>
            <span class="text-xs font-semibold text-brand-300 min-w-0">
                <span class="block truncate">Add new client: ${esc(q)}</span>
            </span>
        </button>
    ` : '';

    if (!list && !addNew) return '';
    return `
        <div class="space-y-1.5">
            ${list}
            ${list && addNew ? '<div class="h-px bg-slate-800 my-1"></div>' : ''}
            ${addNew}
        </div>
    `;
}

/** Destructive-action confirmation dialog. */
function renderDeleteConfirm(state) {
    const t = state.deleteTarget || {};
    const noun = { customer: 'client', service: 'service', staff: 'staff member', appointment: 'appointment', salon: 'salon' }[t.type] || 'record';
    return `
        <div class="text-center space-y-4">
            <div class="w-14 h-14 mx-auto rounded-2xl bg-rose-500/10 text-rose-400 flex items-center justify-center" aria-hidden="true">
                <i data-lucide="trash-2" class="w-6 h-6"></i>
            </div>
            <div>
                <p class="text-base font-extrabold text-slate-100">Delete ${esc(noun)}?</p>
                <p class="text-xs text-slate-400 mt-1.5 max-w-[280px] mx-auto">"${esc(t.label || 'this record')}" will be permanently removed. This cannot be undone.</p>
            </div>
            <div class="flex gap-2.5">
                <button data-action="close-modal" class="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-xl transition active:scale-95 touch-manipulation">Cancel</button>
                <button data-action="confirm-delete" class="flex-1 py-3 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-rose-600/30 transition active:scale-95 touch-manipulation">Delete</button>
            </div>
        </div>
    `;
}

export default renderModalSheet;

/**
 * Informational modal: explains how the Referral Rewards Program works.
 * Rendered inside the standard modal bottom-sheet shell — no form, no state.
 */
function renderReferralInfo() {
    return `
        <div class="space-y-4">

            <div class="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-4 space-y-2.5">
                <h4 class="text-[11px] font-bold text-brand-400 uppercase tracking-widest">How Referrals Work</h4>
                <div class="flex items-start gap-3">
                    <span class="w-6 h-6 rounded-lg bg-brand-500/15 text-brand-400 flex items-center justify-center shrink-0 mt-0.5"><i data-lucide="share-2" class="w-3.5 h-3.5"></i></span>
                    <p class="text-xs text-slate-300 leading-relaxed">Share your salon's unique referral code with friends. When a new client signs up and enters your code, they are linked to your salon.</p>
                </div>
                <div class="flex items-start gap-3">
                    <span class="w-6 h-6 rounded-lg bg-brand-500/15 text-brand-400 flex items-center justify-center shrink-0 mt-0.5"><i data-lucide="user-plus" class="w-3.5 h-3.5"></i></span>
                    <p class="text-xs text-slate-300 leading-relaxed">The referred friend automatically becomes a client of your salon and is added to your client list.</p>
                </div>
            </div>

            <div class="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-4 space-y-2.5">
                <h4 class="text-[11px] font-bold text-brand-400 uppercase tracking-widest">Earning Reward Points</h4>
                <div class="flex items-start gap-3">
                    <span class="w-6 h-6 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0 mt-0.5"><i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i></span>
                    <div>
                        <p class="text-xs text-slate-300 leading-relaxed"><span class="font-semibold text-slate-100">100 pts</span> — credited when a referred friend first signs up as a new client.</p>
                    </div>
                </div>
                <div class="flex items-start gap-3">
                    <span class="w-6 h-6 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0 mt-0.5"><i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i></span>
                    <div>
                        <p class="text-xs text-slate-300 leading-relaxed"><span class="font-semibold text-slate-100">100 pts</span> — additional bonus when the referred friend completes their first successful appointment.</p>
                    </div>
                </div>
                <div class="flex items-start gap-3">
                    <span class="w-6 h-6 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0 mt-0.5"><i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i></span>
                    <div>
                        <p class="text-xs text-slate-300 leading-relaxed"><span class="font-semibold text-slate-100">100 pts</span> — new client sign-up bonus for every client added to your salon (no referral needed).</p>
                    </div>
                </div>
            </div>

            <div class="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-4 space-y-2.5">
                <h4 class="text-[11px] font-bold text-brand-400 uppercase tracking-widest">Reward Tiers & Redemption</h4>
                <div class="space-y-2">
                    ${REWARD_TIERS.map((t) => `
                        <div class="flex items-center justify-between gap-3">
                            <div class="flex items-center gap-2.5">
                                <span class="w-6 h-6 rounded-lg bg-brand-500/15 text-brand-400 flex items-center justify-center shrink-0"><i data-lucide="star" class="w-3.5 h-3.5"></i></span>
                                <div>
                                    <p class="text-xs font-semibold text-slate-100">${esc(t.label)}</p>
                                    <p class="text-[10px] text-slate-500">${esc(t.points)} points required</p>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
                <p class="text-xs text-slate-300 leading-relaxed pt-1">Tap <span class="font-semibold text-slate-100">Redeem Reward</span> on any client card to exchange points for a voucher. Once redeemed, the corresponding points are deducted from the client's balance.</p>
            </div>

            <div class="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-4 space-y-2.5">
                <h4 class="text-[11px] font-bold text-brand-400 uppercase tracking-widest">Eligibility & Conditions</h4>
                <ul class="space-y-1.5">
                    <li class="flex items-start gap-2">
                        <i data-lucide="dot" class="w-4 h-4 text-brand-400 shrink-0 mt-0.5"></i>
                        <span class="text-xs text-slate-300">Referral codes are unique per client and valid across all salon branches.</span>
                    </li>
                    <li class="flex items-start gap-2">
                        <i data-lucide="dot" class="w-4 h-4 text-brand-400 shrink-0 mt-0.5"></i>
                        <span class="text-xs text-slate-300">A referred client must be <span class="font-semibold text-slate-100">new</span> (not already registered) to earn referral points.</span>
                    </li>
                    <li class="flex items-start gap-2">
                        <i data-lucide="dot" class="w-4 h-4 text-brand-400 shrink-0 mt-0.5"></i>
                        <span class="text-xs text-slate-300">Points are <span class="font-semibold text-slate-100">non-transferable</span> and tied to the individual client account.</span>
                    </li>
                    <li class="flex items-start gap-2">
                        <i data-lucide="dot" class="w-4 h-4 text-brand-400 shrink-0 mt-0.5"></i>
                        <span class="text-xs text-slate-300">Pending referrals can be reviewed and rejected by the salon owner before points are credited.</span>
                    </li>
                </ul>
            </div>

            <div class="bg-slate-950/60 border border-slate-800/60 rounded-2xl p-4 space-y-2.5">
                <h4 class="text-[11px] font-bold text-brand-400 uppercase tracking-widest">Reward Status</h4>
                <div class="space-y-1.5">
                    <div class="flex items-center gap-2">
                        <span class="inline-block text-[10px] px-2 py-0.5 bg-amber-500/15 text-amber-400 font-semibold rounded-full">Pending</span>
                        <span class="text-xs text-slate-300">Referral registered, awaiting first appointment.</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="inline-block text-[10px] px-2 py-0.5 bg-brand-500/15 text-brand-400 font-semibold rounded-full">Successful</span>
                        <span class="text-xs text-slate-300">First appointment completed, bonus points pending.</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="inline-block text-[10px] px-2 py-0.5 bg-emerald-500/15 text-emerald-400 font-semibold rounded-full">Bonus Credited</span>
                        <span class="text-xs text-slate-300">Points added to the client's balance — ready to redeem.</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="inline-block text-[10px] px-2 py-0.5 bg-rose-500/15 text-rose-400 font-semibold rounded-full">Rejected</span>
                        <span class="text-xs text-slate-300">Referral declined by salon owner — no points awarded.</span>
                    </div>
                </div>
            </div>

        </div>
    `;
}

/**
 * Rewards bottom sheet: redeem a tier or share the client's referral code.
 */
function renderRewardsModal(state) {
    const r = (state && state.rewards) || {};
    const pts = Number(r.points) || 0;
    const code = r.referralCode || '';

    const tierRows = REWARD_TIERS.map((tier) => {
        const affordable = pts >= tier.points;
        const missing = tier.points - pts;
        return `
            <div class="flex items-center justify-between gap-3 bg-slate-950/60 border border-slate-800/60 rounded-2xl p-3.5 ${affordable ? '' : 'opacity-60'}">
                <div class="min-w-0">
                    <p class="text-xs font-bold text-slate-100">${esc(tier.label)}</p>
                    <p class="text-[10px] text-slate-400 mt-0.5">${esc(tier.points)} pts</p>
                    ${!affordable ? `<p class="text-[10px] text-amber-400/90 mt-0.5 font-semibold">${esc(missing)} more pts needed</p>` : ''}
                </div>
                ${affordable
                    ? `<button data-action="redeem-reward" data-id="${escAttr(r.customerId)}" data-points="${escAttr(tier.points)}" data-label="${escAttr(tier.label)}"
                        class="px-3 py-2 bg-brand-600 hover:bg-brand-500 text-white text-[10px] font-semibold rounded-xl transition active:scale-95 touch-manipulation shrink-0">Redeem</button>`
                    : `<span class="px-3 py-2 bg-slate-800/60 text-slate-500 text-[10px] font-semibold rounded-xl shrink-0"><i data-lucide="lock" class="w-3 h-3 inline mr-1"></i>Locked</span>`}
            </div>
        `;
    }).join('');

    return `
        <div class="space-y-4">
            <div class="text-center">
                <p class="text-xs font-semibold text-slate-400">${esc(r.name || 'Client')}</p>
                <p class="text-2xl font-extrabold text-brand-400 mt-1">${esc(pts)} <span class="text-xs font-semibold text-slate-400">pts</span></p>
                ${code ? `<p class="text-[10px] text-slate-500 mt-2">Referral code: <span class="font-mono font-bold text-slate-200">${esc(code)}</span></p>` : ''}
            </div>

            <div class="space-y-2.5">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Reward tiers</p>
                ${tierRows}
            </div>

            <button data-action="share-referral" data-id="${escAttr(r.customerId)}"
                class="w-full py-3.5 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs rounded-xl transition active:scale-[0.98] touch-manipulation flex items-center justify-center space-x-2">
                <i data-lucide="share-2" class="w-4 h-4"></i>
                <span>Share Referral Link</span>
            </button>
            <p class="text-[10px] text-slate-500 text-center">Friends get rewards on their visit — ${esc(r.name || 'the client')} earns bonus points per referral.</p>
        </div>
    `;
}
