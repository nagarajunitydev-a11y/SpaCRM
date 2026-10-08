/**
 * unit-branches.mjs
 * Node unit tests for multi-branch rules (core/branches.js + the branch
 * additions to core/validate.js).
 *
 * Usage: node scripts/unit-branches.mjs
 */
import {
    isBranchActive, activeBranches, findDuplicateName, validateBranchHours, validateBranch,
} from '../public/js/core/branches.js';
import { validateForm } from '../public/js/core/validate.js';

let pass = 0; let fail = 0;
function t(cond, label) {
    if (cond) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; console.log('  FAIL  ' + label); }
}
const b = (id, name, extra = {}) => ({ id, name, ...extra });

// ---- active state ----
t(isBranchActive(b('a', 'A')) && isBranchActive(b('a', 'A', { active: true })), 'default / true = active');
t(!isBranchActive(b('a', 'A', { active: false })), 'active:false = inactive');
t(activeBranches([b('a', 'A'), b('b', 'B', { active: false })]).length === 1, 'activeBranches filters inactive');

// ---- duplicate names ----
const list = [b('a', 'Luxe  Glow Flagship'), b('b', 'SoHo')];
t(findDuplicateName(list, 'luxe glow flagship')?.id === 'a', 'duplicate is case/whitespace-insensitive');
t(findDuplicateName(list, 'SoHo', 'b') === null, 'editing a branch ignores its own name');
t(findDuplicateName(list, 'Downtown') === null, 'unique name accepted');
t(findDuplicateName(list, '   ') === null, 'blank name is not a duplicate (required-check handles it)');

// ---- hours ----
t(Object.keys(validateBranchHours('10:00', '19:00')).length === 0, 'valid hours');
t(validateBranchHours('', '19:00').openTime === 'Opening time is required.', 'missing opening time');
t(validateBranchHours('10:00', '').closeTime === 'Closing time is required.', 'missing closing time');
t(validateBranchHours('19:00', '10:00').closeTime === 'Closing time must be after opening time.', 'inverted hours');
t(validateBranchHours('10:00', '10:00').closeTime !== undefined, 'zero-length hours rejected');
t(validateBranchHours('25:00', '26:00').openTime === 'Enter a valid opening time.', 'invalid time format');

// ---- validateBranch ----
const good = { name: 'Downtown', phone: '9876543210', address: '1 Main St', openTime: '09:00', closeTime: '20:00' };
t(Object.keys(validateBranch(good, list)).length === 0, 'valid branch passes');
t(validateBranch({ ...good, name: ' ' }, list).name === 'Branch name is required.', 'name required');
t(validateBranch({ ...good, name: 'soho' }, list).name === 'A branch with this name already exists.', 'duplicate name rejected');
t(validateBranch({ ...good, phone: '' }, list).phone === 'Phone number is required.', 'phone required');
t(validateBranch({ ...good, phone: '123' }, list).phone?.startsWith('Enter a valid'), 'bad phone rejected');
t(validateBranch({ ...good, address: '' }, list).address === 'Location address is required.', 'address required');

// ---- validateForm('submit-salon') branch ctx ----
const salon = { name: 'SoHo2', email: 'o@t.com', phone: '9876543210', address: '1 Ave' };
t(Object.keys(validateForm('submit-salon', salon)).length === 0, 'legacy salon form (no hours) still valid');
t(validateForm('submit-salon', salon, { branch: true }).openTime === 'Opening time is required.', 'branch form requires hours');
t(Object.keys(validateForm('submit-salon', { ...salon, openTime: '10:00', closeTime: '18:00' }, { branch: true })).length === 0, 'branch form with hours valid');
t(validateForm('submit-salon', { ...salon, openTime: '18:00', closeTime: '10:00' }, { branch: true }).closeTime === 'Closing time must be after opening time.', 'branch form rejects inverted hours');
t(validateForm('submit-salon', { ...salon, openTime: '10:00', closeTime: '18:00' }, { branch: true, isDuplicateName: () => true }).name === 'A branch with this name already exists.', 'branch form flags duplicate via ctx');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
