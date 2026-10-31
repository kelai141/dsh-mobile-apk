/**
 * Grok (X Premium / xAI) subscription provider: OIDC-discovered OAuth against
 * auth.x.ai with the Grok CLI client id, and streaming against the xAI
 * Responses-style endpoint.
 */
import { attributionHeaders, EMPTY_RESPONSE_CODE, errorChain, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { decodeJwtPayload } from '../auth/jwt.js';
import { resolveImages } from '../translate/resolved.js';
import { streamResponses, toResponsesInput, toResponsesTools } from '../translate/responses.js';
import { httpLlmError, idleWatchdog, mapFetchFailure, mergeReasoning, ModelCatalogCache, discoverAcrossAccounts, discoverOrRetryAuth, isDiscoveryAborted, isMissingOrInvalidCredential, oauthEndpointError, OAuthEndpointError, } from './common.js';
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js';
import { proxiedFetch } from '../http.js';
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, jsonBody, resetFromFields, subscriptionRetryPolicy, } from './rate-limit.js';
export const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const GROK_DISCOVERY_URL = 'https://auth.x.ai/.well-known/openid-configuration';
export const GROK_API_URL = 'https://api.x.ai/v1/responses';
const GROK_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const GROK_CALLBACK_PATH = '/callback';
const GROK_CONTEXT_WINDOW = 256_000;
const GROK_DEFAULT_MAX_TOKENS = 32_000;
/** Refresh when the access token has less than this much life left. */
export const GROK_PREEMPT_MS = 2 * 60_000;
/** Body fields xAI uses to name a delay or reset. */
const GROK_RESET_FIELDS = ['retry_after', 'retry_after_seconds', 'resets_at', 'reset_at'];
/**
 * Reads the reset instant of the xAI window that rejected a request.
 *
 * Body only. xAI serves the OpenAI-compatible `x-ratelimit-reset-*` family,
 * whose values are rollover durations (`6m0s`) present on every response, one
 * per bucket — on a 429 the earliest of them is usually a bucket with room
 * (`0s` for the request bucket while the token bucket is the one exhausted),
 * which would burn the whole retry budget in seconds. They reach the operator
 * through `rateLimitDiagnostics` instead.
 */
export const grokRateLimitReset = (_response, body, now) => resetFromFields(jsonBody(body), GROK_RESET_FIELDS, now);
/** A discovered URL must be https on x.ai or a subdomain; anything else is a hostile document. */
function assertXaiEndpoint(url, field) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new Error(`grok OIDC discovery returned an invalid ${field}`);
    }
    if (parsed.protocol !== 'https:'
        || (parsed.hostname !== 'x.ai' && !parsed.hostname.endsWith('.x.ai'))) {
        throw new Error(`grok OIDC discovery returned a non-x.ai ${field}: ${url}`);
    }
    return url;
}
let discoveryCache;
/**
 * Resolve the xAI OIDC endpoints (cached after the first fetch).
 * @returns validated authorization and token endpoints.
 */
export async function grokDiscovery() {
    if (discoveryCache !== undefined)
        return discoveryCache;
    const response = await proxiedFetch(GROK_DISCOVERY_URL);
    if (!response.ok)
        throw await oauthEndpointError(response, 'grok OIDC discovery');
    const document = await response.json();
    if (typeof document.authorization_endpoint !== 'string' || typeof document.token_endpoint !== 'string') {
        throw new Error('grok OIDC discovery document is missing endpoints');
    }
    discoveryCache = {
        authorizationEndpoint: assertXaiEndpoint(document.authorization_endpoint, 'authorization_endpoint'),
        tokenEndpoint: assertXaiEndpoint(document.token_endpoint, 'token_endpoint'),
    };
    return discoveryCache;
}
/**
 * Build the grok flow facts for the OAuth flow engine (async because the
 * authorize URL comes from OIDC discovery).
 * @returns the flow spec for one attempt.
 */
export async function grokFlow() {
    const discovery = await grokDiscovery();
    return {
        callbackPath: GROK_CALLBACK_PATH,
        listen: { host: '127.0.0.1', ports: [56121] },
        buildAuthorizeUrl({ redirectUri, state, pkce, nonce }) {
            const params = new URLSearchParams({
                response_type: 'code',
                client_id: GROK_CLIENT_ID,
                redirect_uri: redirectUri,
                scope: GROK_SCOPE,
                code_challenge: pkce.challenge,
                code_challenge_method: 'S256',
                state,
                nonce,
                plan: 'generic',
                referrer: 'dsh-plugin-subscriptions',
            });
            return `${discovery.authorizationEndpoint}?${params.toString()}`;
        },
    };
}
/**
 * Display names for the numeric `tier` claim xAI stamps on OAuth access
 * tokens (the `prod_auth.SubscriptionTier` proto enum; the mapping mirrors
 * grok-build's `jwt_tier_claim`). Unknown values fall through to the raw
 * number so a future tier still shows something.
 */
const GROK_TIER_NAMES = {
    0: 'Free',
    1: 'SuperGrok',
    2: 'X Basic',
    3: 'X Premium',
    4: 'X Premium+',
    5: 'SuperGrok Heavy',
    6: 'SuperGrok Lite',
    7: 'SuperGrok Plus',
};
/**
 * The subscription tier encoded in a grok access token's `tier` claim (no
 * verification — same trust posture as the other claim reads).
 * @param accessToken - the stored access token.
 * @returns the display tier name, or undefined when the claim is absent.
 */
export function grokTierName(accessToken) {
    const tier = decodeJwtPayload(accessToken)?.tier;
    if (typeof tier !== 'number' || !Number.isInteger(tier))
        return undefined;
    return GROK_TIER_NAMES[tier] ?? String(tier);
}
/** Pick a display account from an id token's claims. */
function grokAccount(idToken) {
    const payload = idToken === undefined ? undefined : decodeJwtPayload(idToken);
    const claim = payload?.email ?? payload?.preferred_username ?? payload?.name ?? payload?.sub;
    return typeof claim === 'string' && claim.length > 0 ? claim : undefined;
}
/** Build a session from a token response. */
function grokSession(tokens, tokenEndpoint, fallbackRefreshToken) {
    if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
        throw new Error('grok token endpoint returned no access token');
    }
    const refreshToken = tokens.refresh_token ?? fallbackRefreshToken;
    if (refreshToken === undefined)
        throw new Error('grok token endpoint returned no refresh token');
    if (typeof tokens.expires_in !== 'number' || tokens.expires_in <= 0) {
        throw new Error('grok token endpoint returned no usable expiry');
    }
    const account = grokAccount(tokens.id_token);
    return {
        accessToken: tokens.access_token,
        refreshToken,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        tokenEndpoint,
        ...typeof tokens.scope === 'string' ? { scopes: tokens.scope } : {},
        ...account === undefined ? {} : { account },
    };
}
/**
 * Exchange an authorization code for a grok session (form-encoded grant that
 * echoes the PKCE challenge as well as the verifier, per the xAI flow).
 * A 403 here means the X plan lacks the API OAuth entitlement.
 * @param code - the authorization code from the callback.
 * @param verifier - the PKCE verifier minted for the attempt.
 * @param redirectUri - the attempt's redirect URI.
 * @param challenge - the PKCE challenge sent at authorize time.
 * @returns the session to store.
 */
export async function exchangeGrokCode(code, verifier, redirectUri, challenge) {
    const discovery = await grokDiscovery();
    const response = await proxiedFetch(discovery.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: GROK_CLIENT_ID,
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
            code_challenge: challenge,
            code_challenge_method: 'S256',
        }).toString(),
    });
    if (response.status === 403) {
        throw new OAuthEndpointError('grok token endpoint refused the exchange (HTTP 403): your X plan does not include '
            + 'the API OAuth entitlement; an X Premium or xAI subscription with API access is required', 403);
    }
    if (!response.ok)
        throw await oauthEndpointError(response, 'grok');
    return grokSession(await response.json(), discovery.tokenEndpoint);
}
/**
 * Refresh a grok session (form-encoded grant).
 * @param session - the stored session.
 * @returns the fresh session to store.
 */
export async function refreshGrok(session) {
    const response = await proxiedFetch(session.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: GROK_CLIENT_ID,
            refresh_token: session.refreshToken,
        }).toString(),
    });
    if (!response.ok)
        throw await oauthEndpointError(response, 'grok');
    const next = grokSession(await response.json(), session.tokenEndpoint, session.refreshToken);
    return {
        ...next,
        ...session.account === undefined ? {} : { account: session.account },
        ...next.scopes === undefined && session.scopes !== undefined ? { scopes: session.scopes } : {},
    };
}
/**
 * Whether a grok refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix.
 */
export function isGrokPermanentRefreshError(error) {
    return error instanceof OAuthEndpointError && error.oauthCode === 'invalid_grant';
}
/**
 * The Grok Build CLI chat proxy's billing endpoint (the source of the CLI's
 * `/usage` "Usage limit" panel; see xai-org/grok-build
 * `extensions/billing.rs`). Forwards to the backend `GetGrokCreditsConfig`.
 */
export const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
/** RFC3339 timestamp → epoch ms, or undefined when absent/unparsable. */
function grokResetsAt(value) {
    if (typeof value !== 'string' || value.length === 0)
        return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
/**
 * Fetch the grok subscription usage from the Grok Build CLI chat proxy. The
 * newer credits config carries a ready-made percentage plus the current
 * (typically weekly) period; the legacy shape carries cent-valued
 * `monthlyLimit`/`used`, from which the percentage is derived.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation from the RPC transport.
 * @returns the mapped usage snapshot.
 */
export async function fetchGrokUsage(session, fetchFn = proxiedFetch, signal) {
    const response = await fetchFn(GROK_BILLING_URL, {
        headers: {
            'authorization': `Bearer ${session.accessToken}`,
            // The proxy only honors bearer tokens presented as the Grok CLI.
            'x-xai-token-auth': 'xai-grok-cli',
            'accept': 'application/json',
            ...attributionHeaders(),
        },
        ...signal === undefined ? {} : { signal },
    });
    if (!response.ok)
        throw await oauthEndpointError(response, 'grok billing');
    const payload = await response.json();
    const config = typeof payload.config === 'object' && payload.config !== null ? payload.config : {};
    const windows = [];
    if (config.currentPeriod || (typeof config.creditUsagePercent === 'number' && Number.isFinite(config.creditUsagePercent))) {
        const kind = config.currentPeriod?.type === 'USAGE_PERIOD_TYPE_WEEKLY'
            ? 'weekly'
            : 'other';
        const resetsAt = grokResetsAt(config.currentPeriod?.end);
        const usedPercent = typeof config.creditUsagePercent === 'number' && Number.isFinite(config.creditUsagePercent)
            ? config.creditUsagePercent
            : 0;
        windows.push({ kind, usedPercent, ...resetsAt === undefined ? {} : { resetsAt } });
    }
    else if (typeof config.monthlyLimit?.val === 'number' && config.monthlyLimit.val > 0) {
        const used = typeof config.used?.val === 'number' ? config.used.val : 0;
        const resetsAt = grokResetsAt(config.billingPeriodEnd);
        windows.push({
            kind: 'other',
            usedPercent: (used / config.monthlyLimit.val) * 100,
            ...resetsAt === undefined ? {} : { resetsAt },
        });
    }
    // The upstream billing response rarely carries `subscriptionTier` (the CLI
    // enriches it locally from its settings cache), so the access token's
    // `tier` claim is the working fallback.
    const plan = typeof payload.subscriptionTier === 'string' && payload.subscriptionTier.length > 0
        ? payload.subscriptionTier
        : grokTierName(session.accessToken);
    return {
        supported: true,
        windows,
        ...plan === undefined ? {} : { plan },
    };
}
export const GROK_MODELS_URL = 'https://api.x.ai/v1/models';
/**
 * Input modalities for one grok model: chat models (grok-4 family) accept
 * images; code and embedding models are text-only.
 */
function grokModalities(id) {
    return /code|embed/i.test(id) ? ['text'] : ['text', 'image'];
}
/**
 * The Grok Build CLI chat proxy's model catalog — the only grok endpoint that
 * advertises reasoning capability. The `api.x.ai/v1/models` and
 * `/v1/language-models` payloads carry pricing, context, and aliases only, so
 * effort metadata must come from here (the same source the official CLI's
 * picker uses).
 */
export const GROK_CLI_MODELS_URL = 'https://cli-chat-proxy.grok.com/v1/models';
/** Map one CLI catalog entry's reasoning fields, or undefined when unsupported. */
function grokCliReasoning(entry) {
    if (entry.supports_reasoning_effort !== true)
        return undefined;
    const efforts = (entry.reasoning_efforts ?? [])
        .filter(level => typeof level.value === 'string' && level.value.length > 0)
        .map(level => ({
        id: ReasoningEffortId(level.value),
        name: typeof level.label === 'string' && level.label.length > 0 ? level.label : level.value,
        ...typeof level.description === 'string' && level.description.length > 0
            ? { description: level.description }
            : {},
    }));
    if (efforts.length === 0)
        return undefined;
    // The per-entry `default` flags are unreliable (the live catalog marks
    // several levels default at once), so the top-level `reasoning_effort`
    // field is the trusted default.
    const defaultEffort = typeof entry.reasoning_effort === 'string'
        && efforts.some(effort => effort.id === ReasoningEffortId(entry.reasoning_effort))
        ? ReasoningEffortId(entry.reasoning_effort)
        : undefined;
    return { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } };
}
/**
 * Fetch the CLI catalog and index its per-model metadata by model id.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation (pool-assembly timeout).
 * @returns model id → contributed metadata.
 */
export async function fetchGrokCliCatalog(session, fetchFn = proxiedFetch, signal) {
    const response = await fetchFn(GROK_CLI_MODELS_URL, {
        headers: {
            'authorization': `Bearer ${session.accessToken}`,
            // The proxy only honors bearer tokens presented as the Grok CLI.
            'x-xai-token-auth': 'xai-grok-cli',
            'accept': 'application/json',
            ...attributionHeaders(),
        },
        ...signal === undefined ? {} : { signal },
    });
    if (!response.ok)
        throw await oauthEndpointError(response, 'grok CLI catalog');
    const payload = await response.json();
    if (!Array.isArray(payload.data))
        throw new Error('grok CLI catalog returned no data array');
    const catalog = new Map();
    for (const entry of payload.data) {
        if (typeof entry.id !== 'string' || entry.id.length === 0)
            continue;
        const reasoning = grokCliReasoning(entry);
        catalog.set(entry.id, {
            ...typeof entry.name === 'string' && entry.name.length > 0 ? { name: entry.name } : {},
            ...typeof entry.description === 'string' && entry.description.length > 0
                ? { description: entry.description }
                : {},
            ...typeof entry.context_window === 'number' && entry.context_window > 0
                ? { contextWindow: entry.context_window }
                : {},
            ...reasoning === undefined ? {} : { reasoning },
        });
    }
    return catalog;
}
/**
 * The /v1/models list also serves generation models that cannot chat
 * (grok-imagine-image*, grok-imagine-video*) and embedding models; the picker
 * must not offer them. Heuristic over the id substring, verified against the
 * live catalog (grok-build-0.1 and the grok-4 family pass).
 */
function isChatModel(id) {
    return !/imagine|image-|video|embed/i.test(id);
}
/**
 * CLI-contributed fields carried forward from a previously discovered model.
 * @param prior - the last-known entry for this id, if any.
 * @returns enrichment to apply when the live CLI catalog cannot contribute.
 */
function grokPriorMeta(prior) {
    if (prior === undefined)
        return {};
    return {
        ...(prior.name.length > 0 ? { name: prior.name } : {}),
        ...(prior.description === undefined ? {} : { description: prior.description }),
        ...(prior.contextWindow === undefined ? {} : { contextWindow: prior.contextWindow }),
        ...(prior.reasoning === undefined ? {} : { reasoning: prior.reasoning }),
    };
}
/**
 * Fetch the live grok model list, enriched with the CLI catalog's per-model
 * metadata (display name, context window, reasoning efforts). The api.x.ai
 * list stays authoritative for which models exist; the CLI catalog is
 * enrichment only, so its failure degrades to a plain list instead of taking
 * discovery down. When enrichment is missing, last-known capability metadata
 * is carried forward so a transient CLI outage cannot strip efforts a
 * session already selected.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param onWarn - warning sink for a failed CLI catalog fetch.
 * @param previous - last-known catalog used to keep enrichment when the CLI
 *   catalog is down or omits a model.
 * @param signal - caller cancellation (pool-assembly timeout).
 * @returns discovered chat models in endpoint order.
 */
export async function fetchGrokModels(session, fetchFn = proxiedFetch, onWarn, previous, signal) {
    const previousById = previous === undefined || previous.length === 0
        ? undefined
        : new Map(previous.map(model => [model.id, model]));
    const [response, cliCatalog] = await Promise.all([
        fetchFn(GROK_MODELS_URL, {
            headers: {
                'authorization': `Bearer ${session.accessToken}`,
                'accept': 'application/json',
                ...attributionHeaders(),
            },
            ...signal === undefined ? {} : { signal },
        }),
        fetchGrokCliCatalog(session, fetchFn, signal).catch((error) => {
            if (isDiscoveryAborted(error, signal))
                throw error;
            onWarn?.(previousById === undefined
                ? `grok CLI catalog fetch failed; reasoning efforts are unavailable (${errorChain(error)})`
                : `grok CLI catalog fetch failed; keeping last-known reasoning efforts (${errorChain(error)})`);
            return undefined;
        }),
    ]);
    if (!response.ok)
        throw await oauthEndpointError(response, 'grok models');
    const payload = await response.json();
    if (!Array.isArray(payload.data))
        throw new Error('grok models endpoint returned no data array');
    const seen = new Set();
    const discovered = [];
    for (const entry of payload.data) {
        if (typeof entry.id !== 'string' || entry.id.length === 0 || seen.has(entry.id))
            continue;
        if (!isChatModel(entry.id))
            continue;
        seen.add(entry.id);
        const cli = cliCatalog?.get(entry.id);
        discovered.push({
            id: entry.id,
            name: entry.id,
            ...(cli ?? grokPriorMeta(previousById?.get(entry.id))),
        });
    }
    // An empty catalog from a 200 response is treated as a discovery failure so
    // the adapter falls back to the static catalog instead of vanishing from
    // the picker.
    if (discovered.length === 0)
        throw new Error('grok models endpoint returned an empty catalog');
    return discovered;
}
/**
 * Build one xAI Responses request body (exported for tests, like
 * {@link codexRequestBody}). The tool trio renders only when tools exist:
 * A reported xAI 400 invalid-argument on tool-less calls motivated omitting
 * tool controls when no tools are supplied. Keep this endpoint-specific
 * compatibility measure separate from assumptions about other backends.
 */
export function grokRequestBody(options, resolved) {
    return {
        model: options.model,
        ...resolved.instructions === undefined ? {} : { instructions: resolved.instructions },
        input: resolved.input,
        ...options.tools !== undefined && options.tools.length > 0
            ? { tools: toResponsesTools(options.tools), tool_choice: 'auto', parallel_tool_calls: true }
            : {},
        ...options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {},
        // The harness only passes an effort the resolved model advertised (the
        // CLI catalog's), so this never reaches a model that rejects it.
        ...options.reasoningEffort !== undefined
            ? { reasoning: { effort: String(options.reasoningEffort) } }
            : {},
        // Cache-affinity hint (mirrors codex): xAI caches prompts per server,
        // and `prompt_cache_key` is the Responses-API signal that routes repeat
        // requests back to the cache-holding shard — without it every turn's
        // cache hit is shard-routing luck. The session id is the stable key
        // xAI's own docs recommend.
        ...options.sessionId !== undefined ? { prompt_cache_key: String(options.sessionId) } : {},
        store: false,
        stream: true,
    };
}
/** Grok wire adapter: one instance serves the `grok` provider route. */
export class GrokAdapter extends LlmAdapter {
    options;
    catalog;
    /** In-memory catalogs for non-default accounts (the persisted cache is the default's). */
    accountCatalogs = new Map();
    accountCatalogsInvalidated = false;
    invalidatedAccounts = new Set();
    /** Account whose snapshot currently lives in {@link catalog}; cleared on default change. */
    catalogOwner;
    constructor(options) {
        super();
        this.options = options;
        this.catalog = new ModelCatalogCache(options.catalogStore, undefined, options.onCatalogChanged);
    }
    /** Discovery fetcher: resolves the session through the refresh-aware path. */
    async fetchCatalog(account, signal) {
        const lastKnown = account === undefined || account === await this.options.tokens.defaultAccount()
            ? this.catalog.lastKnown()
            : this.accountCatalogs.get(account)?.lastKnown();
        return fetchGrokModels(await this.options.tokens.session(account), this.options.fetchFn, this.options.onWarn, lastKnown, signal);
    }
    /** Drop cached catalogs after login/logout so the next list does not reuse a stale plan. */
    clearAccountCatalog(account) {
        if (account === undefined) {
            this.accountCatalogsInvalidated = true;
            this.invalidatedAccounts.clear();
        }
        else
            this.invalidatedAccounts.add(account);
        if (account === undefined) {
            for (const cache of this.accountCatalogs.values())
                cache.invalidate();
            this.accountCatalogs.clear();
        }
        else {
            this.accountCatalogs.get(account)?.invalidate();
            this.accountCatalogs.delete(account);
        }
        if (account === undefined || this.catalogOwner === account || this.catalogOwner === undefined) {
            this.catalogOwner = undefined;
            this.catalog.invalidate();
        }
    }
    /** Default and secondary accounts each seed their own persisted catalog. */
    async catalogFor(account) {
        const defaultKey = await this.options.tokens.defaultAccount();
        const key = account ?? defaultKey;
        if (key === undefined || key === defaultKey) {
            if (this.catalogOwner !== undefined && this.catalogOwner !== defaultKey) {
                this.catalog.invalidate();
            }
            this.catalogOwner = defaultKey;
            return this.catalog;
        }
        let cache = this.accountCatalogs.get(key);
        if (cache === undefined) {
            cache = new ModelCatalogCache(this.options.accountCatalogStore?.(key), undefined, this.options.onCatalogChanged);
            const invalidated = this.invalidatedAccounts.delete(key);
            if (this.accountCatalogsInvalidated || invalidated)
                cache.invalidate();
            this.accountCatalogs.set(key, cache);
        }
        return cache;
    }
    listed(provider, discovered) {
        return discovered.map(model => ({
            provider,
            id: model.id,
            name: model.name,
            ...model.description === undefined ? {} : { description: model.description },
            inputModalities: grokModalities(model.id),
        }));
    }
    providerInfo(provider) {
        return { id: provider, name: 'Grok (Subscription)' };
    }
    providerRetryPolicy(provider) {
        return subscriptionRetryPolicy(DEFAULT_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `grok: provider "${provider}" retryPolicy`);
    }
    staticModels(provider) {
        return this.options.models.map(model => ({
            provider,
            id: model.id,
            name: model.name ?? model.id,
            inputModalities: model.inputModalities ?? grokModalities(model.id),
        }));
    }
    async listModels(provider) {
        const own = await this.listOwnModels(provider, undefined, undefined, true);
        const pool = this.options.pool?.();
        if (pool === undefined)
            return own;
        const extra = await pool.modelsForProvider(provider);
        const seen = new Set(own.map(model => model.id));
        // Account pools reuse the catalog row; only configured tiers are extra.
        return [...own, ...extra.filter(model => !seen.has(model.id))];
    }
    /** The provider's own catalog: union of every account, or one account when named. */
    async listOwnModels(provider, account, signal, preferCached = false) {
        if (account === undefined) {
            const accounts = (await this.options.tokens.list()).map(entry => entry.key);
            if (accounts.length === 0)
                return [];
            return unionAccountCatalogs(accounts, (key, accountSignal) => this.listOwnModels(provider, key, accountSignal, preferCached), { timeoutMs: DISCOVERY_TIMEOUT_MS, ...signal === undefined ? {} : { signal } });
        }
        if (!await this.options.tokens.hasSession(account)) {
            return [];
        }
        if (!this.options.discovery)
            return this.staticModels(provider);
        const catalog = await this.catalogFor(account);
        try {
            // The fetcher runs only on a cache miss, and resolves the session
            // through the refresh-aware path so an expired access token renews here
            // instead of failing discovery into the static fallback.
            return this.listed(provider, await catalog.get(() => discoverOrRetryAuth(force => this.options.tokens.session(account, force), catalog, () => this.fetchCatalog(account, signal)), preferCached));
        }
        catch (error) {
            if (isDiscoveryAborted(error, signal))
                throw error;
            // A permanent refresh failure deletes the stored session: the provider
            // is logged out, so hide it instead of showing a stale static catalog.
            if (isMissingOrInvalidCredential(error))
                return [];
            this.options.onWarn?.(`grok model discovery failed; using the built-in catalog (${errorChain(error)})`);
            return this.staticModels(provider);
        }
    }
    /**
     * The discovered entry for one model. Resolved through the cache's
     * stale-while-revalidate path: capability metadata must stay stable across
     * a long conversation — a session that selected a reasoning effort calls
     * this on EVERY step, and forgetting the efforts just because the TTL
     * lapsed mid-turn would fail the call with UNSUPPORTED_REASONING_EFFORT
     * before provider I/O.
     */
    async discovered(model) {
        if (!this.options.discovery)
            return undefined;
        const accounts = (await this.options.tokens.list()).map(entry => entry.key);
        return discoverAcrossAccounts(accounts, async (account) => {
            const catalog = await this.catalogFor(account);
            const models = await catalog.resolve(() => this.fetchCatalog(account));
            return models?.find(entry => entry.id === model);
        });
    }
    async resolveModel(provider, model) {
        const pool = this.options.pool?.();
        if (pool !== undefined && await pool.owns(provider, model)) {
            return pool.resolveModel(provider, model);
        }
        return this.resolveOwnModel(provider, model);
    }
    /** Capability resolution of the provider's own models (the pool resolves members here). */
    async resolveOwnModel(provider, model) {
        const discovered = await this.discovered(model);
        const configured = this.options.models.find(entry => entry.id === model);
        // Efforts come from the discovered CLI catalog; models it does not
        // cover expose none, so the harness rejects explicit efforts before
        // provider I/O instead of the API 400ing. A configured default effort
        // still merges in: the picker then preselects it even for models the
        // CLI catalog does not cover.
        const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), discovered?.reasoning);
        return {
            provider,
            id: model,
            name: discovered?.name ?? configured?.name ?? model,
            ...discovered?.description === undefined ? {} : { description: discovered.description },
            inputModalities: configured?.inputModalities ?? grokModalities(model),
            context: { contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? GROK_CONTEXT_WINDOW },
            defaultMaxTokens: configured?.maxTokens ?? GROK_DEFAULT_MAX_TOKENS,
            ...reasoning === undefined ? {} : { reasoning },
        };
    }
    async *stream(options) {
        const pool = this.options.pool?.();
        if (pool !== undefined && await pool.owns(options.provider, options.model)) {
            yield* pool.stream(options);
            return;
        }
        yield* this.streamCore(options);
    }
    /** Pool seam: stream through one specific account instead of the default. */
    streamAccount(options, account) {
        return this.streamCore(options, account);
    }
    async *streamCore(options, account) {
        const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs);
        try {
            let session = await this.options.tokens.session(account);
            let response = await this.request(options, session, watchdog.signal);
            if (response.status === 401) {
                // One forced refresh + retry on an unexpired-but-rejected token.
                session = await this.options.tokens.session(account, true);
                response = await this.request(options, session, watchdog.signal);
            }
            if (!response.ok) {
                throw await httpLlmError(response, 'grok API', {
                    rateLimitReset: grokRateLimitReset,
                    ...this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn },
                });
            }
            if (response.body === null) {
                throw new LlmError('grok API returned no response body', EMPTY_RESPONSE_CODE);
            }
            yield* streamResponses(response.body, () => { watchdog.pulse(); });
        }
        catch (error) {
            throw mapFetchFailure('grok API', error, watchdog, options.signal);
        }
        finally {
            watchdog.stop();
        }
    }
    async request(options, session, signal) {
        const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal);
        const body = grokRequestBody(options, toResponsesInput(messages, options.system));
        return proxiedFetch(GROK_API_URL, {
            method: 'POST',
            headers: {
                'authorization': `Bearer ${session.accessToken}`,
                'accept': 'text/event-stream',
                'content-type': 'application/json',
                ...attributionHeaders(),
            },
            body: JSON.stringify(body),
            signal,
        });
    }
}
