import { createAdminDb } from '../_lib/adminDb.js';
import { createHandlers } from '../_lib/handlers.js';
import { json, failure } from '../_lib/http.js';

/** Daily: persist trial-end / grace / expiry status changes. */
export async function GET(request) {
    const secret = process.env.CRON_SECRET;
    if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
        return json(401, { error: 'Unauthorized' });
    }
    try {
        const r = await createHandlers({ db: createAdminDb(), gateway: null }).syncStatuses();
        return json(r.status, r.body);
    } catch (err) {
        return failure(err);
    }
}
