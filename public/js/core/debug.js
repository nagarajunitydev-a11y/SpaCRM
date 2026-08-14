/**
 * debug.js
 * Structured debug logging for the Google Sign-In → Dashboard flow.
 *
 * Logs are grouped by pipeline stage so a failure can be traced end-to-end:
 *   auth step N        — the 8 auth/session checkpoints (see authService.js /
 *                        main.js instrumentation)
 *   navigation         — route/salon-scope decisions that decide which view
 *                        actually renders
 *   error              — any thrown failure, always with message + stack
 *
 * The logger is console-only; it never touches the store and never changes
 * application behaviour. It can be removed wholesale without side effects.
 */

function log(group, level, ...args) {
    // eslint-disable-next-line no-console
    console[level](`[debug:${group}]`, ...args);
}

/** Trace an auth checkpoint (steps 1-8 of the sign-in pipeline). */
export function authLog(step, ...args) {
    log('auth', 'info', `step ${step}`, ...args);
}

/** Trace a routing / salon-scope decision that selects the rendered view. */
export function routeLog(...args) {
    log('navigation', 'info', ...args);
}

/** Log a failure with its full message + stack for exact root-cause capture. */
export function errorLog(stage, err) {
    if (!err) {
        log('error', 'error', stage, 'no error object');
        return;
    }
    log('error', 'error', stage, { message: err.message || String(err), code: err.code || null, stack: err.stack || '(no stack)' });
}

export default { authLog, routeLog, errorLog };