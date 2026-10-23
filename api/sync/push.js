import { syncEndpoint } from '../_lib/sync/http.js';
export const POST = syncEndpoint(async (service, uid, request) => {
    const body = await request.text();
    if (Buffer.byteLength(body) > 32768) throw Object.assign(new Error('Command is too large.'), { httpStatus: 413 });
    let command;
    try { command = JSON.parse(body); } catch { throw Object.assign(new Error('A JSON command is required.'), { httpStatus: 400 }); }
    return service.push(uid, command);
});
