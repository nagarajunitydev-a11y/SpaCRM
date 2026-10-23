import { syncEndpoint } from '../_lib/sync/http.js';
export const GET = syncEndpoint((service, uid, request) => service.snapshot(uid, new URL(request.url).searchParams.get('salonId')));
