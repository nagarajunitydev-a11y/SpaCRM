/**
 * branches.js
 * Pure multi-branch rules. A "branch" is a `salons/{id}` document: every
 * tenant record (customers, services, staff, appointments, billing, referral
 * wallet, attendance, booking settings) already lives under that document's
 * path, so the document id IS the branchId and isolation is structural.
 *
 * This module holds the owner-level rules that sit on top of that (how many
 * branches a plan allows is answered by core/featureAccess.js):
 *   - active / inactive state
 *   - duplicate-name detection within one owner's branches
 *   - branch form validation
 *
 * No I/O, no store access — fully unit-testable.
 */

import { isBlank, isValidIndianPhone } from './validate.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Inactive only when explicitly deactivated — legacy docs default to active. */
export function isBranchActive(branch) {
    return !branch || branch.active !== false;
}

export function activeBranches(branches) {
    return (branches || []).filter(isBranchActive);
}

function normName(name) {
    return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The existing branch (other than `excludeId`) that already uses this name. */
export function findDuplicateName(branches, name, excludeId = null) {
    const wanted = normName(name);
    if (!wanted) return null;
    return (branches || []).find((b) => b.id !== excludeId && normName(b.name) === wanted) || null;
}

/** Returns an `{ field: message }` map; empty when valid. */
export function validateBranchHours(openTime, closeTime) {
    const errors = {};
    if (isBlank(openTime)) errors.openTime = 'Opening time is required.';
    else if (!TIME_RE.test(openTime)) errors.openTime = 'Enter a valid opening time.';
    if (isBlank(closeTime)) errors.closeTime = 'Closing time is required.';
    else if (!TIME_RE.test(closeTime)) errors.closeTime = 'Enter a valid closing time.';
    if (!errors.openTime && !errors.closeTime && openTime >= closeTime) {
        errors.closeTime = 'Closing time must be after opening time.';
    }
    return errors;
}

/**
 * Full branch validation including cross-record rules.
 * `existing` = the owner's current branches; `excludeId` = the branch being edited.
 */
export function validateBranch(data, existing, excludeId = null) {
    const errors = {};
    if (isBlank(data.name)) errors.name = 'Branch name is required.';
    else if (findDuplicateName(existing, data.name, excludeId)) {
        errors.name = 'A branch with this name already exists.';
    }
    if (isBlank(data.phone)) errors.phone = 'Phone number is required.';
    else if (!isValidIndianPhone(data.phone)) errors.phone = 'Enter a valid 10-digit Indian mobile number (e.g. 98765 43210).';
    if (isBlank(data.address)) errors.address = 'Location address is required.';
    Object.assign(errors, validateBranchHours(data.openTime, data.closeTime));
    return errors;
}

export default {
    isBranchActive,
    activeBranches,
    findDuplicateName,
    validateBranchHours,
    validateBranch,
};
