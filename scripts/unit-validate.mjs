/**
 * unit-validate.mjs
 * Node unit tests for the shared validator (core/validate.js).
 * Covers format/cross-field logic that is hard to reach through browser native
 * controls (e.g. invalid date/time strings get sanitized by type=date inputs).
 *
 * Usage: node scripts/unit-validate.mjs
 */

import { validateForm, isValidDate, isBlank } from '../public/js/core/validate.js';

let pass = 0;
let fail = 0;

function t(cond, label) {
    if (cond) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; console.log('  FAIL  ' + label); }
}

// ---- isBlank ----
t(isBlank('') === true, 'blank string is blank');
t(isBlank('   ') === true, 'whitespace-only is blank');
t(isBlank(null) === true && isBlank(undefined) === true, 'null/undefined are blank');
t(isBlank('A') === false, 'non-blank value is not blank');

// ---- isBlank/date format ----
t(isValidDate('2026-08-20') === true, 'valid calendar date accepted');
t(isValidDate('2030-13-45') === false, 'month 13 rejected');
t(isValidDate('2026-02-30') === false, 'Feb 30 rejected');
t(isValidDate('2026-4-1') === false, 'non-padded date rejected');
t(isValidDate('not-a-date') === false, 'non-date string rejected');
t(isValidDate('') === false, 'empty date rejected');

// ---- Appointment ----
const ok = {
    customerName: 'Olivia',
    serviceName: 'Balayage & Gloss',
    staffName: 'Victoria',
    date: '2030-08-20',
    time: '14:30',
};
t(Object.keys(validateForm('submit-appointment', ok)).length === 0, 'valid appointment passes');

const empty = validateForm('submit-appointment', { customerName: '', serviceName: '', staffName: '', date: '', time: '' });
t(empty.customerName === 'Client name is required.', 'empty customer name rejected');
t(empty.serviceName === 'Select a service.', 'empty service rejected');
t(empty.staffName === 'Select a staff member.', 'empty staff rejected');
t(empty.date === 'Date is required.', 'empty date rejected');
t(empty.time === 'Time is required.', 'empty time rejected');

const whitespace = validateForm('submit-appointment', { customerName: '   ', serviceName: '  ', staffName: '\t ', date: ' ', time: '  ' });
t(whitespace.customerName === 'Client name is required.', 'whitespace-only name rejected');
t(whitespace.serviceName === 'Select a service.', 'whitespace-only service rejected');

const badFormat = validateForm('submit-appointment', { ...ok, date: '2030-13-45', time: '25:99' });
t(badFormat.date === 'Enter a valid date.', 'invalid date format rejected');
t(badFormat.time === 'Enter a valid time (e.g. 14:30).', 'invalid time format rejected');

const past = validateForm('submit-appointment', { ...ok, date: '2020-01-01' });
t(past.date === 'Date must be today or later.', 'past date rejected');

// ---- Customer ----
const nocust = validateForm('submit-customer', { name: '  ', phone: '', email: 'not-an-email' });
t(nocust.name === 'Name is required.', 'blank customer name rejected');
t(nocust.phone === 'Phone number is required.', 'blank phone rejected');
t(nocust.email === 'Enter a valid email address.', 'invalid email rejected');
t(Object.keys(validateForm('submit-customer', { name: 'Olivia', phone: '+1 555-0143', email: 'olivia@example.com' })).length === 0, 'valid customer passes');

// ---- Service ----
const nosvc = validateForm('submit-service', { name: 'x', price: '-5', duration: '' });
t(nosvc.price === 'Enter a valid price.', 'negative price rejected');
t(nosvc.duration === 'Duration is required.', 'blank duration rejected');
t(Object.keys(validateForm('submit-service', { name: 'Facial', price: '95', duration: '60m' })).length === 0, 'valid service passes');

// ---- Staff / Salon ----
t(Object.keys(validateForm('submit-staff', { name: 'Julian', role: 'Stylist', phone: '555' })).length === 0, 'valid staff passes');
const nosalon = validateForm('submit-salon', { name: ' ', email: 'a@b', phone: '', address: '' });
t(nosalon.name === 'Salon name is required.', 'blank salon name rejected');
t(Object.keys(validateForm('submit-salon', { name: 'SoHo', email: 'soho@test.com', phone: '555', address: '1 Ave' })).length === 0, 'valid salon passes (email key)');
t(Object.keys(validateForm('submit-salon', { name: 'SoHo', ownerEmail: 'soho@test.com', phone: '555', address: '1 Ave' })).length === 0, 'valid salon passes (ownerEmail key)');
t(validateForm('submit-salon', { name: 'SoHo', ownerEmail: 'not-an-email', phone: '555', address: '1 Ave' }).email === 'Enter a valid email address.', 'salon ownerEmail format checked');

// ---- Email auth (sign-in has no salon field; signup requires it) ----
t(Object.keys(validateForm('email-auth', { email: 'o@example.com', password: 'secret' }, {})).length === 0, 'sign-in with valid creds passes');
const sn = validateForm('email-auth', { email: '   ', password: null }, { signup: true });
t(sn.salonName === 'Salon name is required.', 'sign-up blank salon name rejected');
t(sn.email === 'Email is required.', 'blank email rejected');
t(sn.password === 'Password is required.', 'null password rejected');
t(Object.keys(validateForm('email-auth', { salonName: 'LV', email: 'o@example.com', password: 'secret' }, { signup: true })).length === 0, 'sign-up with all fields passes');

console.log(`\nUNIT VALIDATE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);