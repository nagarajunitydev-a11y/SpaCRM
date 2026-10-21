import { buildHandlers, json, failure } from '../_lib/http.js';

/** Google Play RTDN via Pub/Sub push: https://<host>/api/subscription/play-notify?secret=<GOOGLE_PLAY_RTDN_SECRET> */
export async function POST(request) {
    try {
        const rawBody = await request.text();
        if (Buffer.byteLength(rawBody) > 65536) return json(413, { error: 'Notification too large.' });
        const r = await buildHandlers().playNotify({ secret: new URL(request.url).searchParams.get('secret'), rawBody });
        return json(r.status, r.body);
    } catch (err) {
        // 5xx makes Pub/Sub retry; the handler only re-reads state from Google, so retries are safe.
        return failure(err);
    }
}
