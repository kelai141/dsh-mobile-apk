/**
 * The `subscriptions-auth` host RPC endpoints the web Settings page drives.
 * They are mounted as exact POST Fetch routes on the shared `/api` channel
 * (`/api/subscriptions-auth.<endpoint>`) and registered only when a host
 * `connection` service exists (the web profile); headless compositions load
 * the plugin without it. All business outcomes are returned as RpcResult
 * values; handlers never throw.
 */
import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import { PROVIDER_IDS } from './store.js';
/**
 * Endpoint-name prefix under the shared `/api` channel: endpoint `status`
 * is served at `/api/subscriptions-auth.status`. The browser half calls
 * `rpc.call('/api', 'subscriptions-auth.status', payload)`.
 */
export const SUBSCRIPTIONS_AUTH_PREFIX = 'subscriptions-auth.';
/**
 * Every endpoint {@link dispatch} answers; each gets one exact Fetch route.
 * Kept in one place so the route table and the switch cannot drift apart.
 */
export const SUBSCRIPTIONS_AUTH_ENDPOINTS = [
    'providerSettings', 'setProviderSettings',
    'status', 'login', 'manual', 'cancel', 'logout', 'setDefault', 'usage',
    'image', 'video', 'prepareReset', 'consumeReset',
    'speed', 'setSpeed',
    'proxyGet', 'proxySet', 'proxyTest',
    'modelDefaults', 'setModelDefault',
];
/** Media types the attachment store accepts (ImageMediaType). */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** Bare MP4 file names the `video` endpoint accepts (no path separators). */
const VIDEO_NAME_PATTERN = /^[\w.-]+\.mp4$/;
/** Payload carried no usable provider id — an RPC client bug, not a server failure. */
export class BadRequest extends Error {
}
function readEnvelope(body) {
    if (typeof body !== 'object' || body === null)
        return undefined;
    const record = body;
    if (record.type !== 'client-request' || typeof record.rpcId !== 'string' || typeof record.method !== 'string')
        return undefined;
    return { type: 'client-request', rpcId: record.rpcId, method: record.method, payload: record.payload };
}
function serverResponse(rpcId, result) {
    return Response.json({ type: 'server-response', rpcId, result });
}
/**
 * Wrap one endpoint's RPC handler as an exact Fetch route: decode the
 * `client-request` envelope the browser rpc caller posts, run the handler,
 * and answer with the matching `server-response` envelope — the same wire
 * contract the dedicated-channel bridge used to apply, reproduced here so
 * `rpc.call('/api', 'subscriptions-auth.<endpoint>', payload)` keeps working
 * unchanged on the browser side.
 */
function fetchRouteFor(endpoint, handler) {
    const method = `${SUBSCRIPTIONS_AUTH_PREFIX}${endpoint}`;
    return {
        path: `/api/${method}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
            if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
                return new Response('content type must be application/json', { status: 415 });
            }
            let body;
            try {
                body = await request.json();
            }
            catch {
                return new Response('body is not JSON', { status: 400 });
            }
            const envelope = readEnvelope(body);
            if (envelope === undefined) {
                const rawId = body?.rpcId;
                return serverResponse(typeof rawId === 'string' ? rawId : 'invalid-request', {
                    ok: false,
                    error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } },
                });
            }
            if (envelope.method !== method) {
                return serverResponse(envelope.rpcId, {
                    ok: false,
                    error: {
                        code: 'gateway/bad-request',
                        message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(method)}`,
                        details: { issues: [] },
                    },
                });
            }
            return serverResponse(envelope.rpcId, await handler(endpoint, envelope.payload, request.signal));
        },
    };
}
function ok(value) {
    return { ok: true, value };
}
function failure(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof BadRequest) {
        // The issues array is zod-shaped upstream; this channel validates by hand.
        return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } };
    }
    return { ok: false, error: { code: 'internal', message, details: {} } };
}
function readProvider(payload) {
    if (typeof payload !== 'object' || payload === null)
        throw new BadRequest('payload must be an object');
    const provider = payload.provider;
    if (typeof provider !== 'string' || !PROVIDER_IDS.includes(provider)) {
        throw new BadRequest(`payload.provider must be one of ${PROVIDER_IDS.join(', ')}`);
    }
    return provider;
}
function readString(payload, field) {
    const value = payload[field];
    if (typeof value !== 'string' || value.length === 0) {
        throw new BadRequest(`payload.${field} must be a non-empty string`);
    }
    return value;
}
/** Validate the `setModelDefault` endpoint's payload. */
function readModelDefaultInput(payload) {
    const provider = readProvider(payload);
    const model = readString(payload, 'model');
    const record = payload;
    let effort;
    if (record.effort !== undefined) {
        if (typeof record.effort !== 'string' || record.effort.length === 0) {
            throw new BadRequest('payload.effort must be a non-empty string when present');
        }
        effort = record.effort;
    }
    return {
        provider,
        model,
        ...(effort === undefined ? {} : { effort }),
    };
}
/** Validate the optional Claude login method. */
function readLoginMethod(payload, provider) {
    const method = payload.method;
    if (method === undefined)
        return undefined;
    if (provider !== 'claude')
        throw new BadRequest('payload.method is only valid for claude');
    if (method !== 'oauth' && method !== 'keychain') {
        throw new BadRequest('payload.method must be "oauth" or "keychain"');
    }
    return method;
}
/** Validate the `setSpeed` endpoint's tier. */
function readSpeedTier(payload) {
    const tier = payload.tier;
    if (tier !== 'standard' && tier !== 'fast') {
        throw new BadRequest('payload.tier must be "standard" or "fast"');
    }
    return tier;
}
/** Validate the `image` endpoint's payload into a full attachment reference. */
function readImageRef(payload) {
    if (typeof payload !== 'object' || payload === null)
        throw new BadRequest('payload must be an object');
    const record = payload;
    const attachmentId = record.attachmentId;
    if (typeof attachmentId !== 'string' || attachmentId.length === 0) {
        throw new BadRequest('payload.attachmentId must be a non-empty string');
    }
    const mediaType = record.mediaType;
    if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.includes(mediaType)) {
        throw new BadRequest(`payload.mediaType must be one of ${IMAGE_MEDIA_TYPES.join(', ')}`);
    }
    for (const field of ['bytes', 'width', 'height']) {
        const value = record[field];
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
            throw new BadRequest(`payload.${field} must be a positive integer`);
        }
    }
    const name = record.name;
    if (name !== undefined && typeof name !== 'string') {
        throw new BadRequest('payload.name must be a string when present');
    }
    return {
        attachmentId: AttachmentId(attachmentId),
        mediaType: mediaType,
        bytes: record.bytes,
        width: record.width,
        height: record.height,
        ...name === undefined ? {} : { name: name },
    };
}
/**
 * Validate the `video` endpoint's payload into a bare file name. Rejecting
 * anything with a path separator (the pattern allows none) pins every read
 * inside the plugin's videos directory.
 */
function readVideoName(payload) {
    if (typeof payload !== 'object' || payload === null)
        throw new BadRequest('payload must be an object');
    const name = payload.name;
    if (typeof name !== 'string' || !VIDEO_NAME_PATTERN.test(name)) {
        throw new BadRequest('payload.name must be a bare .mp4 file name');
    }
    return name;
}
/** Validate the usage/model catalog endpoints' optional force flag. */
function readForce(payload) {
    if (typeof payload !== 'object' || payload === null)
        return false;
    const force = payload.force;
    if (force === undefined)
        return false;
    if (typeof force !== 'boolean')
        throw new BadRequest('payload.force must be a boolean when present');
    return force;
}
/** Validate the session id both speed endpoints carry. */
function readSessionId(payload) {
    if (typeof payload !== 'object' || payload === null)
        throw new BadRequest('payload must be an object');
    return readString(payload, 'sessionId');
}
/** Validate a `proxySet` payload into a shape `ProxyInput` accepts. */
function readProxyInput(payload) {
    if (typeof payload !== 'object' || payload === null)
        throw new BadRequest('payload must be an object');
    const record = payload;
    if (typeof record.enabled !== 'boolean')
        throw new BadRequest('payload.enabled must be a boolean');
    if (typeof record.url !== 'string')
        throw new BadRequest('payload.url must be a string');
    let username;
    if (record.username !== undefined) {
        if (typeof record.username !== 'string')
            throw new BadRequest('payload.username must be a string when present');
        username = record.username;
    }
    let password;
    if (record.password !== undefined) {
        if (record.password !== null && typeof record.password !== 'string') {
            throw new BadRequest('payload.password must be a string or null when present');
        }
        password = record.password;
    }
    let bypass;
    if (record.bypass !== undefined) {
        if (!Array.isArray(record.bypass) || record.bypass.some(entry => typeof entry !== 'string')) {
            throw new BadRequest('payload.bypass must be an array of strings when present');
        }
        bypass = record.bypass;
    }
    return {
        enabled: record.enabled,
        url: record.url,
        ...username === undefined ? {} : { username },
        ...password === undefined ? {} : { password },
        ...bypass === undefined ? {} : { bypass },
    };
}
/** Validate a `proxyTest` payload (the destination URL and an optional draft). */
function readProxyTestPayload(payload) {
    if (typeof payload !== 'object' || payload === null)
        return {};
    const record = payload;
    const url = record.url;
    if (url === undefined && record.proxy === undefined)
        return {};
    if (url !== undefined && (typeof url !== 'string' || url.length === 0)) {
        throw new BadRequest('payload.url must be a non-empty string when present');
    }
    let proxy;
    if (record.proxy !== undefined) {
        if (typeof record.proxy !== 'object' || record.proxy === null) {
            throw new BadRequest('payload.proxy must be an object when present');
        }
        const draftRecord = record.proxy;
        if (typeof draftRecord.url !== 'string' || draftRecord.url.length === 0) {
            throw new BadRequest('payload.proxy.url must be a non-empty string');
        }
        let username;
        if (draftRecord.username !== undefined) {
            if (typeof draftRecord.username !== 'string') {
                throw new BadRequest('payload.proxy.username must be a string when present');
            }
            username = draftRecord.username;
        }
        let password;
        if (draftRecord.password !== undefined) {
            if (typeof draftRecord.password !== 'string') {
                throw new BadRequest('payload.proxy.password must be a string when present');
            }
            password = draftRecord.password;
        }
        proxy = {
            url: draftRecord.url,
            ...username === undefined ? {} : { username },
            ...password === undefined ? {} : { password },
        };
    }
    return {
        ...url === undefined ? {} : { url },
        ...proxy === undefined ? {} : { proxy },
    };
}
async function dispatch(controller, speed, proxy, modelDefaults, endpoint, payload, signal, providerSettings) {
    switch (endpoint) {
        case 'providerSettings':
            if (!providerSettings)
                throw new BadRequest('provider settings are unavailable');
            return ok(await providerSettings.get(readProvider(payload), readForce(payload)));
        case 'setProviderSettings': {
            if (!providerSettings)
                throw new BadRequest('provider settings are unavailable');
            const provider = readProvider(payload);
            await providerSettings.set(provider, payload.settings);
            return ok({ ok: true });
        }
        case 'status': {
            // One provider's failure (a corrupt store entry, a broken flow) must not
            // blind the whole page: it degrades to an error detail on that provider
            // while the others still report their real status.
            const entries = await Promise.all(PROVIDER_IDS.map(async (provider) => [provider, await controller.status(provider).catch((error) => ({
                    busy: false,
                    accounts: [],
                    detail: error instanceof Error ? error.message : String(error),
                }))]));
            return ok({ providers: Object.fromEntries(entries.map(([provider, status]) => {
                    const displayName = providerSettings?.displayName?.(provider);
                    const visibleModels = providerSettings?.visibleModels?.(provider);
                    return [provider, { ...status, ...(displayName ? { displayName } : {}),
                            ...(visibleModels === undefined ? {} : { visibleModels }) }];
                })) });
        }
        case 'login': {
            const provider = readProvider(payload);
            return ok(await controller.login(provider, readLoginMethod(payload, provider)));
        }
        case 'manual': {
            const provider = readProvider(payload);
            await controller.manual(provider, readString(payload, 'input'));
            return ok({ ok: true });
        }
        case 'cancel':
            await controller.cancel(readProvider(payload));
            return ok({ ok: true });
        case 'logout': {
            const provider = readProvider(payload);
            await controller.logout(provider, readString(payload, 'account'));
            return ok({ ok: true });
        }
        case 'setDefault': {
            const provider = readProvider(payload);
            await controller.setDefault(provider, readString(payload, 'account'));
            return ok({ ok: true });
        }
        case 'usage': {
            const provider = readProvider(payload);
            return ok(await controller.usage(provider, readString(payload, 'account'), signal, readForce(payload)));
        }
        case 'prepareReset':
            if (!controller.prepareReset)
                throw new BadRequest('Reset redemption unavailable');
            return ok(await controller.prepareReset(readString(payload, 'account'), signal));
        case 'consumeReset':
            if (!controller.consumeReset)
                throw new BadRequest('Reset redemption unavailable');
            await controller.consumeReset(readString(payload, 'account'), readString(payload, 'ticket'), signal);
            return ok({ ok: true });
        case 'image':
            return ok(await controller.readImage(readImageRef(payload), signal));
        case 'video':
            return ok(await controller.readVideo(readVideoName(payload), signal));
        case 'speed':
            return ok(await speed.speed(readSessionId(payload), payload.model === undefined ? undefined : readString(payload, 'model')));
        case 'setSpeed':
            await speed.setSpeed(readSessionId(payload), readSpeedTier(payload));
            return ok({ ok: true });
        case 'proxyGet':
            if (proxy === undefined)
                throw new BadRequest('proxy configuration is unavailable');
            return ok(await proxy.get());
        case 'proxySet':
            if (proxy === undefined)
                throw new BadRequest('proxy configuration is unavailable');
            return ok(await proxy.set(readProxyInput(payload)));
        case 'proxyTest':
            if (proxy === undefined)
                throw new BadRequest('proxy configuration is unavailable');
            return ok(await proxy.test(readProxyTestPayload(payload)));
        case 'modelDefaults': {
            if (modelDefaults === undefined)
                throw new BadRequest('model defaults are unavailable');
            return ok(await modelDefaults.catalog(readForce(payload)));
        }
        case 'setModelDefault':
            if (modelDefaults === undefined)
                throw new BadRequest('model defaults are unavailable');
            {
                const input = readModelDefaultInput(payload);
                await modelDefaults.set(input.provider, input.model, input.effort);
            }
            return ok({ ok: true });
        default:
            throw new BadRequest(`unknown /subscriptions-auth endpoint "${endpoint}"`);
    }
}
/**
 * Register the `/subscriptions-auth` RPC channel when a host connection exists.
 * @param ctx - the plugin context (headless profiles have no `connection`).
 * @param controller - the auth operations backing the endpoints.
 * @param speed - the per-session speed-tier state backing the Speed toggle.
 * @param proxy - optional proxy-config controller backing `proxyGet`/`proxySet`/`proxyTest`.
 * @param modelDefaults - optional per-model default-effort state backing `modelDefaults`/`setModelDefault`.
 */
export function registerAuthRpc(ctx, controller, speed, proxy = undefined, modelDefaults = undefined, providerSettings = undefined) {
    // `connection` is not in this plugin's inject list (headless compositions
    // lack it), so its startup order is unconstrained: defer registration until
    // the service exists instead of probing once at apply time.
    //
    // Exact Fetch routes under `/api` rather than a dedicated `rpc.handle`
    // channel: since dsh 0.1.5 the connection plugin no longer injects
    // `webServer` itself, and `rpc.handle` resolves `webServer` through the
    // connection plugin's own fiber, so every dedicated channel registration
    // throws `cannot get property "webServer" without inject`. The `/api`
    // route is mounted by the connection plugin (with its own webServer scope)
    // and applies the same trust fence and browser authentication, so exact
    // routes below it work on both dsh lines.
    ctx.inject(['connection'], (ctx) => {
        const connection = ctx.get('connection');
        const handler = async (endpoint, payload, signal) => {
            try {
                return await dispatch(controller, speed, proxy, modelDefaults, endpoint, payload, signal, providerSettings);
            }
            catch (error) {
                return failure(error);
            }
        };
        const register = connection.fetch.register;
        for (const endpoint of SUBSCRIPTIONS_AUTH_ENDPOINTS) {
            ctx.effect(() => register(fetchRouteFor(endpoint, handler)), `dsh-plugin-subscriptions: /api/${SUBSCRIPTIONS_AUTH_PREFIX}${endpoint} route`);
        }
    });
}
