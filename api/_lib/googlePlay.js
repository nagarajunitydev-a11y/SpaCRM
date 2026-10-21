/**
 * googlePlay.js
 * Server-side Google Play Developer API client for alternative billing with
 * user choice (India). Secrets stay on the server:
 *   GOOGLE_PLAY_SERVICE_ACCOUNT   service-account JSON (raw or base64) with
 *                                 Play Console "View financial data" and
 *                                 "Manage orders and subscriptions" access
 *   GOOGLE_PLAY_PACKAGE_NAME      e.g. com.luxeglow.crm
 *   GOOGLE_PLAY_TAX_PERCENT       GST percent included in catalog prices (0 when not registered)
 *   GOOGLE_PLAY_PRODUCT_PREFIX    Play subscription id prefix (default glowos_)
 *   GOOGLE_PLAY_RTDN_SECRET       shared secret on the Pub/Sub push URL
 *
 * Play products follow one convention: subscription `<prefix><planId>` with
 * base plans `monthly` and `annual`, priced in Play Console to match the
 * catalog. Nothing here grants access by itself; callers re-read purchase
 * state from Google before changing a subscription.
 */
import { createSign, timingSafeEqual } from 'node:crypto';
import { INDIA_TAX_STATES } from '../../public/js/core/plans.js';

export { INDIA_TAX_STATES };

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const CYCLES = ['monthly', 'annual'];

export class PlayNotConfigured extends Error {
    constructor(detail = 'Google Play billing is not configured on the server.') {
        super(detail);
        this.name = 'PlayNotConfigured';
    }
}

const b64url = (v) => Buffer.from(v).toString('base64url');

export function createPlayClient(env = process.env, fetchImpl = globalThis.fetch) {
    const packageName = env.GOOGLE_PLAY_PACKAGE_NAME || '';
    const prefix = env.GOOGLE_PLAY_PRODUCT_PREFIX || 'glowos_';
    const taxPercent = Number(env.GOOGLE_PLAY_TAX_PERCENT);
    let account = null;
    let token = null;

    function credentials() {
        if (account) return account;
        const raw = env.GOOGLE_PLAY_SERVICE_ACCOUNT;
        if (!raw || !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(packageName)) throw new PlayNotConfigured();
        if (!(Number.isFinite(taxPercent) && taxPercent >= 0 && taxPercent <= 40)) throw new PlayNotConfigured('GOOGLE_PLAY_TAX_PERCENT must be set (0-40).');
        const parsed = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
        if (!parsed.client_email || !parsed.private_key) throw new PlayNotConfigured();
        account = parsed;
        return account;
    }

    async function accessToken() {
        const sa = credentials();
        const t = Math.floor(Date.now() / 1000);
        if (token && token.exp - 60 > t) return token.value;
        const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
            iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: t, exp: t + 3600,
        }))}`;
        const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
        const res = await fetchImpl(sa.token_uri || 'https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.access_token) throw Object.assign(new Error('Google Play authorisation failed.'), { playStatus: res.status });
        token = { value: json.access_token, exp: t + (json.expires_in || 3600) };
        return token.value;
    }

    async function call(method, path, body) {
        const res = await fetchImpl(`${API}/${encodeURIComponent(packageName)}${path}`, {
            method,
            headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const text = await res.text();
        const json = text ? JSON.parse(text) : {};
        if (!res.ok) throw Object.assign(new Error(json?.error?.message || `Google Play API error ${res.status}.`), { playStatus: res.status });
        return json;
    }

    return {
        id: 'google_play',
        get packageName() { return packageName; },
        get taxPercent() { credentials(); return taxPercent; },
        configured() { try { credentials(); return true; } catch { return false; } },
        productFor(planId, billingCycle) {
            return { productId: `${prefix}${planId}`, basePlanId: billingCycle };
        },
        planFor(productId, basePlanId) {
            if (typeof productId !== 'string' || !productId.startsWith(prefix) || !CYCLES.includes(basePlanId)) return null;
            return { planId: productId.slice(prefix.length), billingCycle: basePlanId };
        },
        rtdnSecretMatches(secret) {
            const want = env.GOOGLE_PLAY_RTDN_SECRET || '';
            if (want.length < 16 || typeof secret !== 'string' || secret.length !== want.length) return false;
            return timingSafeEqual(Buffer.from(secret), Buffer.from(want));
        },
        /** purchases.subscriptionsv2.get */
        getSubscription(purchaseToken) {
            return call('GET', `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);
        },
        /** purchases.subscriptions.acknowledge (Play refunds unacknowledged purchases after 3 days). */
        acknowledge(productId, purchaseToken) {
            return call('POST', `/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`, {});
        },
        /** externaltransactions.createexternaltransaction; an existing id means it was already reported. */
        async reportExternal(externalTransactionId, body) {
            try {
                return await call('POST', `/externalTransactions?externalTransactionId=${encodeURIComponent(externalTransactionId)}`, body);
            } catch (error) {
                if (error.playStatus === 409) return { alreadyReported: true };
                throw error;
            }
        },
    };
}
