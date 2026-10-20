/** Shared plumbing for the /api entry points (no business logic here). */
import { createAdminDb, verifyRequestUser, AdminNotConfigured } from './adminDb.js';
import { getGateway } from './gateways/index.js';
import { GatewayNotConfigured } from './gateways/razorpay.js';
import { createHandlers } from './handlers.js';
import { isNativeCheckout } from './billingPolicy.js';

export const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export function buildHandlers() {
    return createHandlers({ db: createAdminDb(), gateway: getGateway() });
}

/** Wrap an authenticated JSON endpoint. */
export function authedEndpoint(method) {
    return async (request) => {
        try {
            const user = await verifyRequestUser(request);
            if (!user) return json(401, { error: 'Sign in required.' });
            if (['createOrder', 'createRecurring', 'verifyRecurring', 'manageRecurring'].includes(method) && isNativeCheckout(request)) {
                return json(403, { error: 'Subscription purchases are not available in this Android app.', code: 'PLAY_BILLING_REQUIRED' });
            }
            const body = await request.json().catch(() => null);
            if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'A JSON object is required.' });
            const r = await buildHandlers()[method]({ uid: user.uid, email: user.email, body });
            return json(r.status, r.body);
        } catch (err) {
            return failure(err);
        }
    };
}

export function failure(err) {
    if (err.httpStatus) return json(err.httpStatus, { error: err.message, code: err.code });
    if (err instanceof GatewayNotConfigured || err instanceof AdminNotConfigured) {
        // Never pretend a payment worked when the server cannot talk to the gateway.
        return json(503, { error: 'Payments are not available right now.', code: 'NOT_CONFIGURED' });
    }
    console.error('[subscription-api]', err);
    return json(500, { error: 'Something went wrong. Please try again.' });
}
