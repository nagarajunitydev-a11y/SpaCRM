import { syncEndpoint } from '../_lib/sync/http.js';
export const GET = syncEndpoint((service, uid) => service.branches(uid));
