/**
 * playBilling.js
 * Browser side of Google Play billing in the Android app. The native wrapper
 * injects `AndroidBilling` only into frames from our own HTTPS origin
 * (androidx.webkit WebMessageListener); messages are JSON strings.
 *
 * Native -> web messages:
 *   { type: 'ready', available }                      after { type: 'init' }
 *   { requestId, type: 'alternative', token }         user chose Razorpay
 *   { requestId, type: 'purchase', purchaseToken, state }  user chose Google Play
 *   { requestId, type: 'cancelled' | 'error', message }
 *   { type: 'purchase', ... } without requestId       unfinished purchase found at startup
 */

let ready = false;
const waiting = new Map();

const bridge = () => (typeof window !== 'undefined' && window.AndroidBilling
    && typeof window.AndroidBilling.postMessage === 'function' ? window.AndroidBilling : null);

export function initPlayBilling({ onReady, onPurchase } = {}) {
    const b = bridge();
    if (!b) return false;
    b.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'ready') {
            ready = !!msg.available;
            if (onReady) onReady(ready);
            return;
        }
        const resolve = msg.requestId && waiting.get(msg.requestId);
        if (resolve) {
            waiting.delete(msg.requestId);
            resolve(msg);
        } else if (msg.type === 'purchase' && onPurchase) {
            onPurchase(msg);
        }
    };
    b.postMessage(JSON.stringify({ type: 'init' }));
    return true;
}

export const isPlayBillingReady = () => ready;

/** Open Google Play's billing flow (with the user-choice screen) for a server-prepared purchase. */
export function launchPlayBilling(prepared) {
    const b = bridge();
    if (!ready || !b) return Promise.reject(new Error('Google Play billing is not available on this device.'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
        waiting.set(requestId, resolve);
        b.postMessage(JSON.stringify({ type: 'launch', requestId, ...prepared }));
    });
}

/** Lets the wrapper show the payment provider's bank/3-D Secure windows while checkout is open. */
export function setNativeCheckoutActive(active) {
    const b = bridge();
    if (b) b.postMessage(JSON.stringify({ type: 'checkout', active: !!active }));
}
