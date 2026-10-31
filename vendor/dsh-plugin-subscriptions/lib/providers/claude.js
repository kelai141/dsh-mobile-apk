/**
 * Claude Pro/Max subscription provider: OAuth against claude.ai /
 * platform.claude.com with the Claude Code client id, and streaming against
 * the Anthropic Messages API with the Claude Code identity headers.
 */
import { execFileSync } from 'node:child_process';
import { EMPTY_RESPONSE_CODE, errorChain, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { hostSupportsImageOffload, IMAGE_OFFLOAD_REQUIRED, requiredImageOffloadCount, resolveImages } from '../translate/resolved.js';
import { markMessageCache, streamAnthropic, toAnthropicMessages, toAnthropicSystem, toAnthropicTools, } from '../translate/anthropic.js';
import { httpLlmError, idleWatchdog, mapFetchFailure, mergeReasoning, ModelCatalogCache, discoverAcrossAccounts, discoverOrRetryAuth, isDiscoveryAborted, isMissingOrInvalidCredential, oauthEndpointError, OAuthEndpointError, } from './common.js';
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js';
import { proxiedFetch } from '../http.js';
import { compareVersions } from './npm-cli-version.js';
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, earliestReset, jsonBody, resetFromFields, resetInstantFromHeader, subscriptionRetryPolicy, } from './rate-limit.js';
export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const CLAUDE_TOKEN_URL = 'https://claude.ai/v1/oauth/token';
export const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages?beta=true';
export const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
export const CLAUDE_MODELS_URL = 'https://api.anthropic.com/v1/models?beta=true';
export const CLAUDE_SCOPE = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
export const CLAUDE_CALLBACK_PATH = '/callback';
// Fallbacks only when discovery is unavailable or the model omits its limits.
const CLAUDE_CONTEXT_WINDOW = 200_000;
const CLAUDE_DEFAULT_MAX_TOKENS = 32_000;
/** Refresh when the access token has less than this much life left. */
export const CLAUDE_PREEMPT_MS = 5 * 60_000;
/**
 * Body fields Anthropic uses to name a reset instant, read when the unified
 * headers are absent.
 */
const CLAUDE_RESET_FIELDS = ['resets_at', 'resetsAt', 'reset_at', 'retry_after'];
/**
 * Reads the reset instant of the Anthropic window that rejected a request.
 *
 * `anthropic-ratelimit-unified-*` is the subscription-plan family — the one
 * Claude Code renders as "resets 3pm" — and is the only header that names the
 * window which actually rejected this request. The per-bucket
 * `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-reset`
 * headers are deliberately not read: they are rollover snapshots attached to
 * every response, so on a 429 they cannot say which bucket refused, and the
 * earliest of them is typically the bucket that still had room — a wait that
 * lands straight back in the closed window. They reach the operator through
 * `rateLimitDiagnostics` instead.
 */
export const claudeRateLimitReset = (response, body, now) => {
    const unified = earliestReset(resetInstantFromHeader(response, 'anthropic-ratelimit-unified-reset', now), resetInstantFromHeader(response, 'anthropic-ratelimit-unified-fallback-reset', now));
    if (unified !== undefined)
        return unified;
    return resetFromFields(jsonBody(body), CLAUDE_RESET_FIELDS, now);
};
/**
 * The subscription endpoint only serves requests presenting as Claude Code,
 * so these headers impersonate the CLI; the harness attribution user-agent
 * cannot be sent here (one user-agent slot, and the CLI's wins). The endpoint
 * also gates new models on the CLI version, so the version normally comes
 * from npm (`ClaudeCliVersionCache`); this is only the offline floor.
 */
export const CLAUDE_CLI_FALLBACK_VERSION = '2.1.283';
/**
 * Candidate invocations, in order of preference. Windows npm installs expose
 * Claude Code as a `.cmd` shim, which must run through a shell.
 */
const CLAUDE_VERSION_PROBES = process.platform === 'win32'
    ? [
        ['claude --version', [], { shell: true }],
        ['claude.cmd --version', [], { shell: true }],
    ]
    : [['claude', ['--version'], {}]];
export function detectClaudeVersion() {
    let lastError;
    for (const [command, args, options] of CLAUDE_VERSION_PROBES) {
        try {
            const raw = execFileSync(command, [...args], {
                timeout: 10_000,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                ...options,
            });
            const match = raw.match(/(\d+\.\d+\.\d+)/);
            if (match)
                return match[1];
        }
        catch (error) {
            lastError = error;
        }
    }
    // This is debug-only: the fallback is expected when Claude Code is absent.
    if (lastError !== undefined) {
        console.debug('dsh-plugin-subscriptions: Claude CLI version detection fell back', lastError);
    }
    return CLAUDE_CLI_FALLBACK_VERSION;
}
/**
 * The lowest version to present: the local CLI or the bundled fallback,
 * whichever is newer. An outdated local install must not pin requests to a
 * version the endpoint already rejects for new models.
 * @param detect - local CLI probe (injectable for tests).
 */
export function claudeCliVersionFloor(detect = detectClaudeVersion) {
    const local = detect();
    return compareVersions(local, CLAUDE_CLI_FALLBACK_VERSION) > 0
        ? { version: local, source: 'local' }
        : { version: CLAUDE_CLI_FALLBACK_VERSION, source: 'fallback' };
}
/** The User-Agent Claude Code sends at `version`. */
export function claudeCliUserAgent(version) {
    return `claude-cli/${version} (external, cli)`;
}
// Lazy + memoized: the floor shells out to `claude --version`, so this must
// not run at module-evaluation time (it would fire for every consumer of this
// module regardless of whether Claude is a configured provider). Used when no
// npm-backed resolver is wired in.
let localCliVersion;
async function localClaudeCliVersion() {
    localCliVersion ??= claudeCliVersionFloor().version;
    return localCliVersion;
}
export const CLAUDE_BETA_FALLBACK = [
    'claude-code-20250219',
    'oauth-2025-04-20',
    'interleaved-thinking-2025-05-14',
    'context-management-2025-06-27',
    'effort-2025-11-24',
    'compact-2026-01-12',
    'files-api-2025-04-14',
].join(',');
const CLAUDE_BETA_FLAGS = CLAUDE_BETA_FALLBACK;
/** Static claude flow facts for the OAuth flow engine. */
export const claudeFlow = {
    callbackPath: CLAUDE_CALLBACK_PATH,
    // The redirect URI embeds the port, so it must be an ephemeral one.
    listen: { host: 'localhost', ports: [0] },
    buildAuthorizeUrl({ redirectUri, state, pkce }) {
        const params = new URLSearchParams({
            code: 'true',
            client_id: CLAUDE_CLIENT_ID,
            response_type: 'code',
            redirect_uri: redirectUri,
            scope: CLAUDE_SCOPE,
            code_challenge: pkce.challenge,
            code_challenge_method: 'S256',
            state,
        });
        return `${CLAUDE_AUTHORIZE_URL}?${params.toString()}`;
    },
};
/** Best-effort account profile; login must not fail when this does. */
async function fetchClaudeProfile(accessToken) {
    try {
        const response = await proxiedFetch(CLAUDE_PROFILE_URL, {
            headers: { authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok)
            return {};
        const profile = await response.json();
        const account = typeof profile.account === 'object' && profile.account !== null
            ? profile.account
            : {};
        const email = profile.emailAddress ?? profile.email ?? account.email_address ?? account.email;
        const subscription = profile.subscriptionType ?? profile.subscription_type ?? account.subscription_type;
        return {
            ...typeof email === 'string' && email.length > 0 ? { emailAddress: email } : {},
            ...typeof subscription === 'string' && subscription.length > 0 ? { subscriptionType: subscription } : {},
        };
    }
    catch {
        // Profile lookup is decorative; only the token exchange owns login success.
        return {};
    }
}
/** Build a session from a token response. */
async function claudeSession(tokens, fallbackRefreshToken, withProfile) {
    if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
        throw new Error('claude token endpoint returned no access token');
    }
    const refreshToken = tokens.refresh_token ?? fallbackRefreshToken;
    if (refreshToken === undefined)
        throw new Error('claude token endpoint returned no refresh token');
    if (typeof tokens.expires_in !== 'number' || tokens.expires_in <= 0) {
        throw new Error('claude token endpoint returned no usable expiry');
    }
    const profile = withProfile ? await fetchClaudeProfile(tokens.access_token) : {};
    return {
        accessToken: tokens.access_token,
        refreshToken,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        scopes: tokens.scope ?? CLAUDE_SCOPE,
        ...profile,
    };
}
/**
 * Exchange an authorization code for a claude session (JSON grant).
 * @param code - the authorization code from the callback.
 * @param verifier - the PKCE verifier minted for the attempt.
 * @param redirectUri - the attempt's redirect URI.
 * @param state - the attempt's state (echoed to the token endpoint).
 * @returns the session to store.
 */
export async function exchangeClaudeCode(code, verifier, redirectUri, state) {
    const response = await proxiedFetch(CLAUDE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: CLAUDE_CLIENT_ID,
            code_verifier: verifier,
            state,
        }),
    });
    if (!response.ok)
        throw await oauthEndpointError(response, 'claude');
    return claudeSession(await response.json(), undefined, true);
}
/**
 * Refresh a claude session (JSON grant echoing the issued scope).
 * @param session - the stored session.
 * @returns the fresh session to store.
 */
export async function refreshClaude(session) {
    const response = await proxiedFetch(CLAUDE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: session.refreshToken,
            client_id: CLAUDE_CLIENT_ID,
            scope: session.scopes,
        }),
    });
    if (!response.ok)
        throw await oauthEndpointError(response, 'claude');
    const next = await claudeSession(await response.json(), session.refreshToken, false);
    return {
        ...next,
        ...session.emailAddress === undefined ? {} : { emailAddress: session.emailAddress },
        ...session.subscriptionType === undefined ? {} : { subscriptionType: session.subscriptionType },
    };
}
/**
 * Whether a claude refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix.
 */
export function isClaudePermanentRefreshError(error) {
    return error instanceof OAuthEndpointError
        && (error.oauthCode === 'invalid_grant' || error.oauthCode === 'invalid_token');
}
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** RFC3339 `resets_at` value → epoch ms, or undefined when absent/unparsable. */
function claudeResetsAt(value) {
    if (typeof value !== 'string' || value.length === 0)
        return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
/** Map one legacy `{utilization, resets_at}` bucket; undefined when null or unusable. */
function claudeLegacyWindow(value, kind, scope) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const bucket = value;
    if (typeof bucket.utilization !== 'number' || !Number.isFinite(bucket.utilization))
        return undefined;
    const resetsAt = claudeResetsAt(bucket.resets_at);
    return {
        kind,
        ...scope === undefined ? {} : { scope },
        usedPercent: bucket.utilization,
        ...resetsAt === undefined ? {} : { resetsAt },
    };
}
/** Map the modern `limits` array; empty when absent or carrying nothing usable. */
function claudeLimitsWindows(value) {
    if (!Array.isArray(value))
        return [];
    const windows = [];
    for (const raw of value) {
        if (typeof raw !== 'object' || raw === null)
            continue;
        const entry = raw;
        if (typeof entry.percent !== 'number' || !Number.isFinite(entry.percent))
            continue;
        const kind = entry.kind === 'session'
            ? 'session'
            : entry.kind === 'weekly_all' || entry.kind === 'weekly_scoped' ? 'weekly' : 'other';
        const scope = entry.scope?.model?.display_name;
        const resetsAt = claudeResetsAt(entry.resets_at);
        windows.push({
            kind,
            ...typeof scope === 'string' && scope.length > 0 ? { scope } : {},
            usedPercent: entry.percent,
            ...resetsAt === undefined ? {} : { resetsAt },
        });
    }
    return windows;
}
/**
 * Fetch the claude subscription usage from the OAuth usage endpoint (the
 * source of Claude Code's `/usage` screen). Newer responses carry a
 * structured `limits` array; older ones the flat `five_hour`/`seven_day*`
 * buckets — both shapes are read, the array winning when it has entries.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation from the RPC transport.
 * @param cliVersion - resolves the Claude Code version to present; defaults to the local floor.
 * @returns the mapped usage snapshot.
 */
export async function fetchClaudeUsage(session, fetchFn = proxiedFetch, signal, cliVersion = localClaudeCliVersion) {
    const userAgent = claudeCliUserAgent(await cliVersion());
    const response = await fetchFn(CLAUDE_USAGE_URL, {
        headers: {
            'authorization': `Bearer ${session.accessToken}`,
            'anthropic-beta': 'oauth-2025-04-20',
            // Unrecognized clients are aggressively rate-limited on this endpoint,
            // so it presents as the CLI like every other subscription request.
            'user-agent': userAgent,
            'accept': 'application/json',
        },
        ...signal === undefined ? {} : { signal },
    });
    if (!response.ok)
        throw await oauthEndpointError(response, 'claude usage');
    const payload = await response.json();
    const modern = claudeLimitsWindows(payload.limits);
    if (modern.length > 0)
        return { supported: true, windows: modern };
    const windows = [];
    const legacy = [
        claudeLegacyWindow(payload.five_hour, 'session'),
        claudeLegacyWindow(payload.seven_day, 'weekly'),
        claudeLegacyWindow(payload.seven_day_opus, 'weekly', 'Opus'),
        claudeLegacyWindow(payload.seven_day_sonnet, 'weekly', 'Sonnet'),
    ];
    for (const window of legacy) {
        if (window !== undefined)
            windows.push(window);
    }
    return { supported: true, windows };
}
function claudeThinkingType(capabilities) {
    const types = capabilities?.thinking?.types;
    if (types?.enabled?.supported === true)
        return 'enabled';
    if (types?.adaptive?.supported === true)
        return 'adaptive';
    return undefined;
}
/** Effort levels in display order; a model exposes only the ones it advertises as supported. */
const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
function claudeReasoning(capabilities) {
    const effort = capabilities?.effort;
    if (effort?.supported !== true)
        return undefined;
    const efforts = CLAUDE_EFFORT_LEVELS
        .filter(level => effort[level]?.supported === true)
        .map(level => ({ id: ReasoningEffortId(level), name: level[0].toUpperCase() + level.slice(1) }));
    return efforts.length > 0 ? { efforts } : undefined;
}
/** A token limit the endpoint disclosed, or undefined when absent or malformed. */
function positiveTokenCount(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
/**
 * Fetch the live model catalog from the subscription endpoint. `signal`
 * cancels the request; `cliVersion` resolves the Claude Code version to
 * present (defaults to the local floor).
 */
export async function fetchClaudeModels(session, fetchFn = proxiedFetch, signal, cliVersion = localClaudeCliVersion) {
    const userAgent = claudeCliUserAgent(await cliVersion());
    const response = await fetchFn(CLAUDE_MODELS_URL, {
        headers: {
            'authorization': `Bearer ${session.accessToken}`,
            'anthropic-version': '2023-06-01',
            'user-agent': userAgent,
            'anthropic-dangerous-direct-browser-access': 'true',
            'accept': 'application/json',
        },
        ...signal === undefined ? {} : { signal },
    });
    if (!response.ok)
        throw await httpLlmError(response, 'claude models API');
    const payload = await response.json();
    if (!Array.isArray(payload.data)) {
        throw new Error('claude models API returned an invalid catalog');
    }
    const models = payload.data
        .filter((m) => typeof m.id === 'string')
        .map((m) => {
        const thinkingType = claudeThinkingType(m.capabilities);
        const reasoning = claudeReasoning(m.capabilities);
        // The endpoint advertises each model's limits; carrying them through keeps
        // the route current for models newer than the bundled catalog (#101).
        const contextWindow = positiveTokenCount(m.max_input_tokens);
        const maxOutputTokens = positiveTokenCount(m.max_tokens);
        return {
            id: m.id,
            name: m.display_name ?? m.id,
            ...contextWindow === undefined ? {} : { contextWindow },
            ...maxOutputTokens === undefined ? {} : { maxOutputTokens },
            ...thinkingType === undefined ? {} : { thinkingType },
            ...reasoning === undefined ? {} : { reasoning },
        };
    });
    if (models.length === 0) {
        throw new Error('claude models API returned an empty catalog');
    }
    return models;
}
/**
 * The output cap for one model: configuration may lower the default, but never
 * exceeds a server-advertised ceiling; the built-in constant is the last resort.
 */
function claudeMaxTokens(configured, disc) {
    const outputLimit = disc?.maxOutputTokens;
    const preferred = configured?.maxTokens ?? outputLimit ?? CLAUDE_DEFAULT_MAX_TOKENS;
    return outputLimit === undefined ? preferred : Math.min(preferred, outputLimit);
}
/**
 * Anthropic rejects any image edge over 2000px once a request carries many
 * images, and every later turn resends the history, so one oversized
 * screenshot would fail the session for good (#110). Images are sent within
 * this cap; 3.75MB encoded stays under the 5MB base64 per-image limit.
 */
const CLAUDE_IMAGE_LIMIT = { maxEdge: 2000, maxBytes: 3_750_000 };
/**
 * Inline image data a Claude request may carry, in base64 bytes. Every turn
 * resends the history, so screenshots accumulate until the request passes the
 * API's 32MB body limit and every later turn and compaction fails with HTTP
 * 413 `request_too_large`. Past this budget the host offloads the oldest
 * images to text and retries; the remaining 12MB holds prompts, tools, and text.
 */
export const CLAUDE_REQUEST_IMAGE_BUDGET = 20 * 1024 * 1024;
/** The Claude 4.5 family accepts image input. */
const CLAUDE_MODALITIES = ['text', 'image'];
/**
 * Assemble the Anthropic request body.
 *
 * Extracted from the adapter so the wire shape — cache breakpoints above all —
 * is testable without a network round trip. The message array is marked before
 * it is placed so the breakpoints land on the blocks the body ships: one on the
 * last `system` block (covering `tools` + `system`, which render ahead of it)
 * and up to three across the history, Anthropic's four-slot maximum.
 * @param options - the generate request.
 * @param messages - conversation messages with images already resolved.
 * @param maxTokens - the resolved output cap.
 * @param thinking - the thinking parameter, when the model takes one.
 * @param effort - the reasoning effort, when the model advertises efforts.
 * @param cacheTtl - lifetime of every cache breakpoint; defaults to five minutes.
 * Requests that carry a `purpose` (compaction, session titles) always use five
 * minutes to preserve their existing auxiliary-request behavior. A five-minute
 * mark can still read an entry a one-hour mark wrote.
 * @returns the JSON body to POST.
 */
export function claudeRequestBody(options, messages, maxTokens, thinking, effort, cacheTtl) {
    const ttl = options.purpose === undefined ? cacheTtl : undefined;
    const anthropicMessages = toAnthropicMessages(messages);
    markMessageCache(anthropicMessages, ttl);
    return {
        model: options.model,
        max_tokens: maxTokens,
        system: toAnthropicSystem(options.system, messages, ttl),
        messages: anthropicMessages,
        ...options.tools !== undefined && options.tools.length > 0
            ? { tools: toAnthropicTools(options.tools) }
            : {},
        ...thinking === undefined ? {} : { thinking },
        ...effort === undefined ? {} : { output_config: { effort } },
        stream: true,
        ...options.sessionId !== undefined ? { metadata: { user_id: String(options.sessionId) } } : {},
    };
}
/** Claude wire adapter: one instance serves the `claude` provider route. */
export class ClaudeAdapter extends LlmAdapter {
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
    async fetchCatalog(account, signal) {
        return fetchClaudeModels(await this.options.tokens.session(account), this.options.fetchFn, signal, this.options.resolveCliVersion);
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
    staticModels(provider) {
        return this.options.models.map(model => ({
            provider,
            id: model.id,
            name: model.name ?? model.id,
            inputModalities: model.inputModalities ?? CLAUDE_MODALITIES,
        }));
    }
    providerInfo(provider) {
        return { id: provider, name: 'Claude (Subscription)' };
    }
    providerRetryPolicy(provider) {
        return subscriptionRetryPolicy(DEFAULT_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `claude: provider "${provider}" retryPolicy`);
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
            const models = await catalog.get(() => discoverOrRetryAuth(force => this.options.tokens.session(account, force), catalog, () => this.fetchCatalog(account, signal)), preferCached);
            return models.map(model => ({
                provider,
                id: model.id,
                name: model.name,
                inputModalities: CLAUDE_MODALITIES,
            }));
        }
        catch (error) {
            if (isDiscoveryAborted(error, signal))
                throw error;
            if (isMissingOrInvalidCredential(error))
                return [];
            this.options.onWarn?.(`claude model discovery failed; using the built-in catalog (${errorChain(error)})`);
            return this.staticModels(provider);
        }
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
        const disc = await this.discovered(model);
        const configured = this.options.models.find(entry => entry.id === model);
        const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), disc?.reasoning);
        return {
            provider,
            id: model,
            name: disc?.name ?? configured?.name ?? model,
            inputModalities: configured?.inputModalities ?? CLAUDE_MODALITIES,
            context: {
                contextWindow: disc?.contextWindow ?? configured?.contextWindow ?? CLAUDE_CONTEXT_WINDOW,
            },
            defaultMaxTokens: claudeMaxTokens(configured, disc),
            ...(reasoning === undefined ? {} : { reasoning }),
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
                session = await this.options.tokens.session(account, true);
                response = await this.request(options, session, watchdog.signal);
            }
            if (!response.ok) {
                throw await httpLlmError(response, 'claude API', {
                    rateLimitReset: claudeRateLimitReset,
                    ...this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn },
                });
            }
            if (response.body === null) {
                throw new LlmError('claude API returned no response body', EMPTY_RESPONSE_CODE);
            }
            yield* streamAnthropic(response.body, () => { watchdog.pulse(); });
        }
        catch (error) {
            throw mapFetchFailure('claude API', error, watchdog, options.signal);
        }
        finally {
            watchdog.stop();
        }
    }
    /**
     * `display: 'summarized'` is set explicitly on both shapes: `adaptive`-type
     * models default to `display: 'omitted'`, which returns thinking blocks with
     * an empty `thinking` field — without this override the "Think" panel would
     * always render empty even though real reasoning (and billed thinking_tokens)
     * ran.
     */
    thinkingParam(thinkingType, maxTokens) {
        if (thinkingType === 'adaptive')
            return { type: 'adaptive', display: 'summarized' };
        if (thinkingType === 'enabled') {
            const budget = Math.min(Math.max(1_024, Math.floor(maxTokens * 0.5)), maxTokens - 100);
            if (budget < 1_024)
                return undefined;
            return { type: 'enabled', budget_tokens: budget, display: 'summarized' };
        }
        return undefined;
    }
    async request(options, session, signal) {
        const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal, CLAUDE_IMAGE_LIMIT);
        if (hostSupportsImageOffload()) {
            const offloadImages = requiredImageOffloadCount(messages, CLAUDE_REQUEST_IMAGE_BUDGET);
            if (offloadImages > 0) {
                // Older dsh-llm option types lack `offloadImages`; 0.2+ hosts read it.
                throw new LlmError(`claude request images exceed the ${CLAUDE_REQUEST_IMAGE_BUDGET}-byte base64 budget; `
                    + `${offloadImages} more oldest image(s) must be offloaded`, IMAGE_OFFLOAD_REQUIRED, { offloadImages });
            }
        }
        const disc = await this.discovered(options.model);
        const maxTokens = options.maxTokens
            ?? claudeMaxTokens(this.options.models.find(entry => entry.id === options.model), disc);
        const thinking = this.thinkingParam(disc?.thinkingType, maxTokens);
        const effort = options.reasoningEffort !== undefined && disc?.reasoning !== undefined
            ? String(options.reasoningEffort)
            : undefined;
        const cacheTtl = this.options.promptCacheTtlOverride?.() ?? this.options.promptCacheTtl;
        const body = claudeRequestBody(options, messages, maxTokens, thinking, effort, cacheTtl);
        const cliVersion = await (this.options.resolveCliVersion ?? localClaudeCliVersion)();
        return proxiedFetch(CLAUDE_API_URL, {
            method: 'POST',
            headers: {
                'authorization': `Bearer ${session.accessToken}`,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': CLAUDE_BETA_FLAGS,
                'user-agent': claudeCliUserAgent(cliVersion),
                'x-app': 'cli',
                'anthropic-dangerous-direct-browser-access': 'true',
                'accept': 'text/event-stream',
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            signal,
        });
    }
}
