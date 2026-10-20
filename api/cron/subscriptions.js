import { createAdminDb } from '../_lib/adminDb.js';
import { createHandlers } from '../_lib/handlers.js';
import { json, failure } from '../_lib/http.js';
import { getGateway } from '../_lib/gateways/index.js';
import { GatewayNotConfigured } from '../_lib/gateways/razorpay.js';

/** Daily: persist trial-end / grace / expiry status changes. */
export async function GET(request) {
    const secret = process.env.CRON_SECRET;
    if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
        return json(401, { error: 'Unauthorized' });
    }
    try {
        const handlers = createHandlers({ db: createAdminDb(), gateway: getGateway() });
        const r = await handlers.syncStatuses();
        let reconciliation;
        try { reconciliation = await handlers.reconcileRecurring(); }
        catch (error) { if (!(error instanceof GatewayNotConfigured)) throw error; reconciliation = { skipped: 'gateway_not_configured' }; }
        if (reconciliation?.status >= 400) return json(reconciliation.status, { ...r.body, reconciliation: reconciliation.body });
        if (reconciliation?.failures?.length) return json(503, { ...r.body, reconciliation });
        return json(r.status, { ...r.body, reconciliation });
    } catch (err) {
        return failure(err);
    }
}
