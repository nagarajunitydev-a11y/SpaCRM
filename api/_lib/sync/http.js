import { verifyRequestUser } from '../adminDb.js';
import { failure, json } from '../http.js';
import { createSyncStore } from './store.js';
import { createSyncService } from './service.js';

export function syncEndpoint(action) {
    return async request => {
        try {
            // Pilot activation is deliberate and server-side. Existing clients and
            // payment endpoints are unaffected. Never enable with an empty cohort.
            if (process.env.NATIVE_SYNC_ENABLED !== 'true') return json(503, { error: 'Native sync pilot is not enabled.', code: 'PILOT_DISABLED' });
            const user = await verifyRequestUser(request, true);
            if (!user) return json(401, { error: 'Sign in again to synchronise.', code: 'AUTH_REQUIRED' });
            const cohort = (process.env.NATIVE_SYNC_OWNER_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean);
            if (!cohort.includes(user.uid)) return json(403, { error: 'This account is not in the native pilot.', code: 'PILOT_ACCESS_DENIED' });
            return json(200, await action(createSyncService({ db: createSyncStore() }), user.uid, request));
        } catch (error) { return failure(error); }
    };
}
