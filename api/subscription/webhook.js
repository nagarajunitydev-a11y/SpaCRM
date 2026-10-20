import { buildHandlers, json, failure } from '../_lib/http.js';

/** Gateway -> server notification. Signature is verified over the RAW body. */
export async function POST(request) {
    try {
        const rawBody = await request.text();
        if (Buffer.byteLength(rawBody) > 262144) return json(413, { error: 'Webhook body too large.' });
        const r = await buildHandlers().webhook({
            rawBody,
            signature: request.headers.get('x-razorpay-signature'),
            eventId: request.headers.get('x-razorpay-event-id'),
        });
        return json(r.status, r.body);
    } catch (err) {
        // 5xx makes the gateway retry; handlers are idempotent so retries are safe.
        return failure(err);
    }
}
