/**
 * e2e-helpers.mjs
 * Shared helpers for the real-browser e2e scripts.
 *
 * Chrome is spawned as a tree of processes; node's `child.kill('SIGKILL')`
 * only signals the top-level browser process and on Windows its child
 * processes routinely survive it (and keep the CDP debugging port bound).
 * A leftover instance then answers the next test's `http://127.0.0.1:<port>/json`
 * probe, so the following run silently drives a zombie and fails at sign-in.
 * `killChromeTree` tears the whole process tree down (taskkill /T on Windows).
 */

import { execFileSync } from 'node:child_process';

export function killChromeTree(pid) {
    if (!pid) return;
    try {
        if (process.platform === 'win32') {
            execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
            process.kill(pid, 'SIGKILL');
        }
    } catch (e) {
        // Already exited — nothing to clean up.
    }
}

export default { killChromeTree };