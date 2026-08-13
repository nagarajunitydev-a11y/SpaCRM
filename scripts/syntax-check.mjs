/**
 * syntax-check.mjs
 * Runs `node --check` against every JS module in public/js (and sw.js) to
 * catch syntax errors without a browser. Zero dependencies.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [join(root, 'public', 'js'), join(root, 'public')];

const files = [];
const seen = new Set();
for (const dir of dirs) {
    walk(dir);
}

function walk(dir) {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            walk(full);
        } else if (/\.(js|mjs)$/.test(entry) && !seen.has(full)) {
            seen.add(full);
            files.push(full);
        }
    }
}

let failed = 0;
for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
        failed += 1;
        console.error(`✗ ${file}\n${result.stderr}`);
    } else {
        console.log(`✓ ${file}`);
    }
}

console.log(failed === 0 ? `\nAll ${files.length} modules passed syntax check.` : `\n${failed} file(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
