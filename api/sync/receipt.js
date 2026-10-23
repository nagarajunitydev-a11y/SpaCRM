import { syncEndpoint } from '../_lib/sync/http.js';
export const GET = syncEndpoint(async (service, uid, request) => {
    const params = new URL(request.url).searchParams;
    return { result: await service.receipt(uid, params.get('salonId'), params.get('commandId')) };
});
