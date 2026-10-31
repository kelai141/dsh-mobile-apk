/**
 * GitHub Copilot subscription provider: OAuth device-authorization flow with
 * the VS Code Copilot Chat client id, a GitHub-token → Copilot-token exchange
 * against `copilot_internal/v2/token`, and streaming against two upstream
 * protocols chosen per model: the OpenAI-compatible chat completions endpoint
 * for models whose catalog entry lists `/chat/completions`, and the Responses
 * endpoint for the newer model families (gpt-5.5/5.6, …) that only list
 * `/responses`. Both upstreams are stream-only.
 *
 * Two token generations are in play: the long-lived GitHub OAuth token (kept
 * as the session's `refreshToken`) and the ~30-minute Copilot API token it
 * exchanges into (the session's `accessToken`). A TokenManager "refresh" is a
 * fresh exchange, so the standard preempt/401-retry machinery applies
 * unchanged.
 */
import { EMPTY_RESPONSE_CODE, errorChain, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { resolveImages } from '../translate/resolved.js';
import { streamChatCompletions, toChatMessages, toChatTools, } from '../translate/chat-completions.js';
import { streamResponses, toResponsesInput, toResponsesTools } from '../translate/responses.js';
import { httpLlmError, idleWatchdog, mapFetchFailure, mergeReasoning, ModelCatalogCache, discoverAcrossAccounts, discoverOrRetryAuth, isDiscoveryAborted, isMissingOrInvalidCredential, oauthEndpointError, OAuthEndpointError, } from './common.js';
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js';
import { proxiedFetch } from '../http.js';
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, subscriptionRetryPolicy, } from './rate-limit.js';
/**
 * Client id of the VS Code Copilot Chat GitHub App (pi-mono and
 * copilot2api-go use the same value): the app is pre-authorized for the
 * Copilot internal token exchange, a self-registered OAuth App is not.
 */
export const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
export const COPILOT_DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const COPILOT_DEVICE_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
export const GITHUB_USER_URL = 'https://api.github.com/user';
export const COPILOT_API_URL = 'https://api.githubcopilot.com/chat/completions';
/** Responses endpoint for models whose catalog entry only lists `/responses`. */
export const COPILOT_RESPONSES_URL = 'https://api.githubcopilot.com/responses';
export const COPILOT_MODELS_URL = 'https://api.githubcopilot.com/models';
const COPILOT_SCOPE = 'read:user';
const COPILOT_CONTEXT_WINDOW = 128_000;
const COPILOT_DEFAULT_MAX_TOKENS = 16_000;
/** Refresh when the Copilot API token has less than this much life left. */
export const COPILOT_PREEMPT_MS = 5 * 60_000;
/**
 * The VS Code update feed answers a JSON array of version strings, latest
 * stable first. The Copilot API rejects requests whose Editor-Version is too
 * old with `401 IDE token expired`, so the version is resolved live (cached
 * for a day) instead of hardcoded — a stale hardcode bricks every request.
 */
export const VSCODE_RELEASES_URL = 'https://update.code.visualstudio.com/api/releases/stable';
/** Last-known-good VS Code version when the feed is unreachable. */
export const FALLBACK_VSCODE_VERSION = '1.107.0';
const VSCODE_VERSION_TTL_MS = 24 * 3_600_000;
let vscodeVersionCache;
let vscodeVersionInflight;
/**
 * Resolve the VS Code version presented as Editor-Version: the latest stable
 * from the update feed, cached for a day, falling back to a pinned version
 * when the feed fails. Concurrent resolves coalesce behind one fetch.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param forceRefresh - bypass the cache (a 401 `IDE token expired` retry).
 * @returns a `major.minor.patch` version string.
 */
export async function latestVsCodeVersion(fetchFn = proxiedFetch, forceRefresh = false) {
    if (!forceRefresh && vscodeVersionCache !== undefined
        && Date.now() - vscodeVersionCache.at < VSCODE_VERSION_TTL_MS) {
        return vscodeVersionCache.version;
    }
    vscodeVersionInflight ??= (async () => {
        try {
            const response = await fetchFn(VSCODE_RELEASES_URL, { headers: { accept: 'application/json' } });
            if (!response.ok)
                throw new Error(`HTTP ${String(response.status)}`);
            const releases = await response.json();
            const version = Array.isArray(releases)
                ? releases.find(entry => typeof entry === 'string' && /^\d+\.\d+\.\d+$/.test(entry))
                : undefined;
            if (version === undefined)
                throw new Error('no version string in the feed');
            vscodeVersionCache = { version: version, at: Date.now() };
            return version;
        }
        catch {
            // A feed failure must never break provider traffic: serve the stale
            // cache, else the pinned fallback.
            return vscodeVersionCache?.version ?? FALLBACK_VSCODE_VERSION;
        }
    })().finally(() => { vscodeVersionInflight = undefined; });
    return vscodeVersionInflight;
}
/**
 * The device-flow facts for the auth controller's DeviceFlowManager.
 * @returns the flow spec for one attempt.
 */
export function copilotDeviceFlow() {
    return {
        clientId: COPILOT_CLIENT_ID,
        scope: COPILOT_SCOPE,
        deviceCodeUrl: COPILOT_DEVICE_CODE_URL,
        tokenUrl: COPILOT_DEVICE_TOKEN_URL,
    };
}
/**
 * Header set presenting requests as the VS Code Copilot Chat extension; the
 * Copilot API rejects traffic without an editor identity.
 * @param hasVision - whether the request carries image input.
 * @param vscodeVersion - Editor-Version value from {@link latestVsCodeVersion}.
 * @returns headers to merge into Copilot API requests.
 */
export function copilotHeaders(hasVision = false, vscodeVersion = FALLBACK_VSCODE_VERSION) {
    return {
        'user-agent': 'GitHubCopilotChat/0.35.0',
        'editor-version': `vscode/${vscodeVersion}`,
        'editor-plugin-version': 'copilot-chat/0.35.0',
        'copilot-integration-id': 'vscode-chat',
        'openai-intent': 'conversation-edits',
        'x-github-api-version': '2026-06-01',
        ...hasVision ? { 'copilot-vision-request': 'true' } : {},
    };
}
/**
 * Exchange a long-lived GitHub OAuth token for a short-lived Copilot API
 * token. A 401/403 means the GitHub token is revoked or the account lost its
 * Copilot subscription — permanent, re-login required.
 * @param githubToken - the GitHub OAuth token from the device flow.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @returns the Copilot API token and its expiry.
 */
export async function exchangeCopilotToken(githubToken, fetchFn = proxiedFetch) {
    const response = await fetchFn(COPILOT_TOKEN_URL, {
        headers: {
            'authorization': `Bearer ${githubToken}`,
            'accept': 'application/json',
            ...copilotHeaders(false, await latestVsCodeVersion(fetchFn)),
        },
    });
    if (!response.ok)
        throw await oauthEndpointError(response, 'copilot');
    const wire = await response.json();
    if (typeof wire.token !== 'string' || wire.token.length === 0) {
        throw new Error('copilot token endpoint returned no token');
    }
    return {
        accessToken: wire.token,
        // A missing expiry falls back to a conservative 25 minutes (the tokens
        // typically live ~30).
        expiresAt: typeof wire.expires_at === 'number' && wire.expires_at > 0
            ? wire.expires_at * 1000
            : Date.now() + 25 * 60_000,
    };
}
/**
 * Complete a device-flow login: exchange the GitHub token for a Copilot API
 * token and read the GitHub login name for the status display.
 * @param githubToken - the GitHub OAuth token the device flow released.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @returns the session to store.
 */
export async function completeCopilotLogin(githubToken, fetchFn = proxiedFetch) {
    const pair = await exchangeCopilotToken(githubToken, fetchFn);
    let account;
    try {
        const response = await fetchFn(GITHUB_USER_URL, {
            headers: {
                'authorization': `Bearer ${githubToken}`,
                'accept': 'application/json',
                // api.github.com only demands a user agent; no editor disguise needed.
                'user-agent': 'GitHubCopilotChat/0.35.0',
            },
        });
        if (response.ok) {
            const profile = await response.json();
            if (typeof profile.login === 'string' && profile.login.length > 0)
                account = profile.login;
        }
    }
    catch {
        // A profile lookup failure must not fail the login; the session works without a display name.
    }
    return {
        accessToken: pair.accessToken,
        refreshToken: githubToken,
        expiresAt: pair.expiresAt,
        ...account === undefined ? {} : { account },
    };
}
/**
 * Refresh a copilot session: re-exchange the long-lived GitHub token for a
 * fresh Copilot API token.
 * @param session - the stored session.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @returns the fresh session to store.
 */
export async function refreshCopilot(session, fetchFn = proxiedFetch) {
    const pair = await exchangeCopilotToken(session.refreshToken, fetchFn);
    return {
        accessToken: pair.accessToken,
        refreshToken: session.refreshToken,
        expiresAt: pair.expiresAt,
        ...session.account === undefined ? {} : { account: session.account },
    };
}
/**
 * Whether a copilot refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix (GitHub token revoked or the subscription lost).
 */
export function isCopilotPermanentRefreshError(error) {
    return error instanceof OAuthEndpointError && (error.status === 401 || error.status === 403);
}
/** Display name for one Copilot wire reasoning-effort value. */
function copilotEffortName(effort) {
    return effort === 'xhigh' ? 'Extra High' : effort.charAt(0).toUpperCase() + effort.slice(1);
}
/**
 * Map a catalog entry's `supports.reasoning_effort` array into selectable
 * efforts. The endpoint discloses no default effort, so none is claimed
 * (absence preserves the provider's own default). Duplicates and non-string
 * entries are dropped: the harness rejects duplicate effort ids outright.
 */
function copilotReasoning(entry) {
    const wire = entry.capabilities?.supports?.reasoning_effort;
    if (!Array.isArray(wire))
        return undefined;
    const seen = new Set();
    const efforts = [];
    for (const value of wire) {
        if (typeof value !== 'string' || value.length === 0 || seen.has(value))
            continue;
        seen.add(value);
        efforts.push({ id: ReasoningEffortId(value), name: copilotEffortName(value) });
    }
    return efforts.length > 0 ? { efforts } : undefined;
}
/**
 * Fetch the live Copilot model list. Models hidden from the picker or
 * disabled by policy are excluded, as are models able to speak neither
 * protocol this adapter knows: an entry listing `/chat/completions` speaks
 * the chat wire, one listing only `/responses` (the newer GPT families,
 * e.g. gpt-5.6) speaks the Responses wire, and the choice is recorded on the
 * discovered entry so requests pick the matching endpoint; an entry listing
 * BOTH endpoints additionally records `/responses` availability, which
 * {@link copilotRequestWire} uses to reroute tools+effort requests. Vision
 * support from the catalog becomes the model's input modalities, and a
 * non-empty `supports.reasoning_effort` array becomes the model's selectable
 * reasoning efforts (the endpoint discloses no default, so none is claimed).
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation (pool-assembly timeout).
 * @returns discovered chat models in endpoint order.
 */
export async function fetchCopilotModels(session, fetchFn = proxiedFetch, signal) {
    const response = await fetchFn(COPILOT_MODELS_URL, {
        headers: {
            'authorization': `Bearer ${session.accessToken}`,
            'accept': 'application/json',
            ...copilotHeaders(false, await latestVsCodeVersion(fetchFn)),
        },
        ...signal === undefined ? {} : { signal },
    });
    if (!response.ok)
        throw await oauthEndpointError(response, 'copilot models');
    const payload = await response.json();
    if (!Array.isArray(payload.data))
        throw new Error('copilot models endpoint returned no data array');
    const seen = new Set();
    const discovered = [];
    for (const entry of payload.data) {
        if (typeof entry.id !== 'string' || entry.id.length === 0 || seen.has(entry.id))
            continue;
        if (entry.model_picker_enabled !== true || entry.policy?.state === 'disabled')
            continue;
        let wire;
        let responsesSupported = false;
        if (Array.isArray(entry.supported_endpoints)) {
            responsesSupported = entry.supported_endpoints.includes('/responses');
            if (entry.supported_endpoints.includes('/chat/completions'))
                wire = 'chat-completions';
            else if (responsesSupported)
                wire = 'responses';
            else
                continue;
        }
        seen.add(entry.id);
        const reasoning = copilotReasoning(entry);
        discovered.push({
            id: entry.id,
            name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id,
            ...typeof entry.capabilities?.limits?.max_context_window_tokens === 'number'
                && entry.capabilities.limits.max_context_window_tokens > 0
                ? { contextWindow: entry.capabilities.limits.max_context_window_tokens }
                : {},
            inputModalities: entry.capabilities?.supports?.vision === true ? ['text', 'image'] : ['text'],
            ...reasoning === undefined ? {} : { reasoning },
            ...wire === undefined ? {} : { copilotWire: wire },
            ...responsesSupported ? { copilotResponses: true } : {},
        });
    }
    // An empty catalog from a 200 response is treated as a discovery failure so
    // the adapter falls back to the static catalog instead of vanishing from
    // the picker.
    if (discovered.length === 0)
        throw new Error('copilot models endpoint returned an empty catalog');
    return discovered;
}
/**
 * The wire protocol for one model: the discovered catalog entry's recorded
 * choice, defaulting to chat completions for unknown models (static-catalog
 * and no-discovery configurations, and models listing both endpoints).
 * @param entry - the discovered catalog entry, when known.
 * @returns the protocol the request for this model must speak.
 */
export function copilotWireFor(entry) {
    return entry?.copilotWire === 'responses' ? 'responses' : 'chat-completions';
}
/**
 * The upstream protocol for ONE REQUEST: the model's default wire, except
 * that a dual-protocol model defaulting to chat completions must reroute to
 * Responses when the request combines function tools with a reasoning effort
 * — Copilot rejects exactly that combination on /chat/completions with
 * HTTP 400 invalid_request_body ("Function tools with reasoning_effort are
 * not supported … use /v1/responses or set reasoning_effort to 'none'",
 * observed on gpt-5.4) while /responses serves it. Effort 'none' stays on
 * the chat wire (the API allows the combination there), and models not
 * listing /responses never reroute.
 * @param entry - the discovered catalog entry, when known.
 * @param options - the harness generate options (tools + effort only).
 * @returns the protocol the request for this model must speak.
 */
export function copilotRequestWire(entry, options) {
    const wire = copilotWireFor(entry);
    if (wire !== 'chat-completions')
        return wire;
    if (entry?.copilotResponses !== true)
        return wire;
    if (options.tools === undefined || options.tools.length === 0)
        return wire;
    if (options.reasoningEffort === undefined || options.reasoningEffort === 'none')
        return wire;
    return 'responses';
}
/**
 * The chat completions request body for one generation. The output cap rides
 * `max_completion_tokens` — the newer OpenAI-family models on Copilot reject
 * the legacy `max_tokens` parameter outright (HTTP 400 "Unsupported
 * parameter"), and the rest of the catalog accepts the new spelling.
 * @param options - the harness generate options.
 * @param messages - translated wire messages (images pre-resolved).
 * @returns the JSON body.
 */
export function copilotChatRequestBody(options, messages) {
    return {
        model: options.model,
        messages,
        ...options.tools !== undefined && options.tools.length > 0
            ? { tools: toChatTools(options.tools), tool_choice: 'auto' }
            : {},
        ...options.maxTokens !== undefined ? { max_completion_tokens: options.maxTokens } : {},
        // The harness only passes an effort the resolved model advertised (the
        // catalog's reasoning_effort array), and copilotRequestWire keeps the
        // tools+effort combination off this wire for models that reject it.
        ...options.reasoningEffort !== undefined
            ? { reasoning_effort: String(options.reasoningEffort) }
            : {},
        // The upstream is stream-only; usage arrives on the terminal chunk.
        stream: true,
        stream_options: { include_usage: true },
    };
}
/**
 * The Responses request body for one generation (the wire the `/responses`-
 * only model families speak). Usage arrives on `response.completed`.
 * @param options - the harness generate options.
 * @param resolved - translated instructions + input (images pre-resolved).
 * @returns the JSON body.
 */
export function copilotResponsesRequestBody(options, resolved) {
    return {
        model: options.model,
        ...resolved.instructions !== undefined ? { instructions: resolved.instructions } : {},
        input: resolved.input,
        ...options.tools !== undefined && options.tools.length > 0
            ? { tools: toResponsesTools(options.tools, { strict: false }), tool_choice: 'auto' }
            : {},
        ...options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {},
        // The Responses wire spells the effort nested; only advertised efforts
        // ever reach this branch (see copilotChatRequestBody).
        ...options.reasoningEffort !== undefined
            ? { reasoning: { effort: String(options.reasoningEffort) } }
            : {},
        // [2026-08-23]-[a reasoning model continuing a tool chain must replay its
        // encrypted reasoning on the next request, and the blobs only arrive when
        // asked for; for non-reasoning models the include is a no-op]
        include: ['reasoning.encrypted_content'],
        stream: true,
    };
}
/**
 * The replayable form of one completed reasoning item: the COMPLETE item as
 * the gateway delivered it on `response.output_item.done` — its ORIGINAL id
 * (captured before the stable-key rewrite), summary parts, status, and the
 * encrypted payload. A reasoning item's `id` and `summary` are not optional
 * in the Responses input schema, so an item missing its id or its blob is
 * not replayable and degrades to the no-replay path instead of risking an
 * invalid input item.
 */
function completedReasoningItem(item) {
    if (typeof item.encrypted_content !== 'string' || item.encrypted_content.length === 0)
        return undefined;
    if (typeof item.id !== 'string' || item.id.length === 0)
        return undefined;
    return {
        type: 'reasoning',
        id: item.id,
        ...Array.isArray(item.summary) ? { summary: item.summary } : {},
        ...typeof item.status === 'string' && item.status.length > 0 ? { status: item.status } : {},
        encrypted_content: item.encrypted_content,
    };
}
/**
 * Rewrite Copilot's Responses-gateway item ids into stable per-item keys.
 * Unlike chatgpt.com's Responses backend, the Copilot gateway mints a FRESH
 * opaque `item.id`/`item_id` on every event of one response (the `added`,
 * each delta, and the `done` all differ), which defeats id-keyed block
 * assembly in the shared translator: text fragments would each open their
 * own block, `done` would synthesize duplicates, and a function call whose
 * arguments arrive whole only on `done` (the deltas carry empty strings)
 * would close empty. The stable key derives from the event's `output_index`
 * — the item's position in the response's output array, which survives the
 * gateway's per-event id churn even when two items' events interleave on
 * the wire (parallel tool calls do exactly that). Events without an
 * `output_index` fall back to the key of the last `output_item.added`, which
 * is only correct while one item's events stay contiguous — the pre-
 * interleaving behavior, kept for gateways that omit the field; with no
 * `added` seen yet they key to `copilot-item-0` as before. Function-call
 * identity additionally rides the gateway-stable `call_id`.
 */
export class CopilotResponsesItemNormalizer {
    onCaptured;
    adds = 0;
    lastKey = 'copilot-item-0';
    /** Call ids and completed reasoning items collected for the open response. */
    capturedCallIds = [];
    capturedReasoning = [];
    /**
     * @param onCaptured - fired at each `response.completed` that produced BOTH
     *   function calls and completed reasoning items, receiving the response's
     *   call ids and replayable reasoning items so the adapter can replay them
     *   on the next request.
     */
    constructor(onCaptured) {
        this.onCaptured = onCaptured;
    }
    /**
     * [2026-08-23]-[a single arrival-order ordinal mis-buckets every event after
     * a second item's `added`, mangling interleaved parallel tool calls;
     * output_index is the only correlator the gateway keeps stable]-[changes
     * keys only for streams that carry output_index; no-index streams keep the
     * old last-added-key behavior byte for byte]
     */
    keyFor(event) {
        return event.output_index !== undefined
            ? `copilot-item-${String(event.output_index)}`
            : this.lastKey;
    }
    /**
     * Rewrite one parsed Responses event.
     * @param event - the event as parsed off the wire.
     * @returns the event with a stable item key.
     */
    push(event) {
        if (event.type === 'response.output_item.added') {
            this.adds += 1;
            const key = event.output_index !== undefined
                ? `copilot-item-${String(event.output_index)}`
                : `copilot-item-${String(this.adds)}`;
            this.lastKey = key;
            const item = event.item;
            if (item?.type === 'function_call' && typeof item.call_id === 'string' && item.call_id.length > 0) {
                this.capturedCallIds.push(item.call_id);
            }
            return item === undefined
                ? event
                : { ...event, item: { ...item, id: key } };
        }
        if (event.type === 'response.output_item.done') {
            const item = event.item;
            if (item?.type === 'reasoning') {
                // Capture runs BEFORE the stable-key rewrite: the replay item must
                // carry the item's original gateway id, not the translator key.
                const captured = completedReasoningItem(item);
                if (captured !== undefined)
                    this.capturedReasoning.push(captured);
            }
            return item === undefined
                ? event
                : { ...event, item: { ...item, id: this.keyFor(event) } };
        }
        if (event.type === 'response.completed') {
            // Both sides present is the only replayable response; clear either way —
            // one SSE stream may carry multiple responses.
            if (this.capturedCallIds.length > 0 && this.capturedReasoning.length > 0) {
                this.onCaptured?.(this.capturedCallIds, this.capturedReasoning);
            }
            this.capturedCallIds = [];
            this.capturedReasoning = [];
            return event;
        }
        if (event.item_id === undefined)
            return event;
        return { ...event, item_id: this.keyFor(event) };
    }
}
/** Copilot wire adapter: one instance serves the `copilot` provider route. */
export class CopilotAdapter extends LlmAdapter {
    options;
    catalog;
    /** In-memory catalogs for non-default accounts (the persisted cache is the default's). */
    accountCatalogs = new Map();
    accountCatalogsInvalidated = false;
    invalidatedAccounts = new Set();
    /** Account whose snapshot currently lives in {@link catalog}; cleared on default change. */
    catalogOwner;
    /**
     * [2026-08-23]-[a reasoning model continuing a tool chain must get its
     * reasoning back or it restarts from scratch every tool round trip; the
     * items live in ADAPTER memory because dsh-llm's reasoning ContentBlock is
     * a closed shape that cannot carry them through the harness]-[entries are
     * namespaced per ACCOUNT × CONVERSATION × MODEL, idle out via a sliding
     * TTL, and the whole store is dropped on auth transitions, so replay
     * degrades to the old behavior instead of leaking across contexts]
     */
    replayByScope = new Map();
    /** Call-id entries kept per scope; see {@link captureReasoning}. */
    static REPLAY_CALL_LIMIT = 64;
    /** Conversation scopes kept at once; bounds memory when many sessions interleave. */
    static REPLAY_SCOPE_LIMIT = 32;
    /** How long a captured entry stays replayable; tool round trips take minutes, not hours. */
    static REPLAY_TTL_MS = 30 * 60_000;
    constructor(options) {
        super();
        this.options = options;
        this.catalog = new ModelCatalogCache(options.catalogStore, undefined, options.onCatalogChanged);
    }
    /** Discovery fetcher: resolves the session through the refresh-aware path. */
    async fetchCatalog(account, signal) {
        return fetchCopilotModels(await this.options.tokens.session(account), this.options.fetchFn, signal);
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
    providerInfo(provider) {
        return { id: provider, name: 'GitHub Copilot' };
    }
    providerRetryPolicy(provider) {
        return subscriptionRetryPolicy(DEFAULT_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `copilot: provider "${provider}" retryPolicy`);
    }
    staticModels(provider) {
        return this.options.models.map(model => ({
            provider,
            id: model.id,
            name: model.name ?? model.id,
            inputModalities: model.inputModalities ?? ['text'],
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
            const discovered = await catalog.get(() => discoverOrRetryAuth(force => this.options.tokens.session(account, force), catalog, () => this.fetchCatalog(account, signal)), preferCached);
            return discovered.map(model => ({
                provider,
                id: model.id,
                name: model.name,
                ...model.description === undefined ? {} : { description: model.description },
                ...model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities },
            }));
        }
        catch (error) {
            if (isDiscoveryAborted(error, signal))
                throw error;
            // A permanent refresh failure deletes the stored session: the provider
            // is logged out, so hide it instead of showing a stale static catalog.
            if (isMissingOrInvalidCredential(error))
                return [];
            this.options.onWarn?.(`copilot model discovery failed; using the built-in catalog (${errorChain(error)})`);
            return this.staticModels(provider);
        }
    }
    /**
     * The discovered entry for one model. Resolved through the cache's
     * stale-while-revalidate path: capability metadata must stay stable across
     * a long conversation — a mid-turn refetch must neither block nor fail the
     * call before provider I/O.
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
    /**
     * [2026-08-23]-[a manually configured responses-only model combined with
     * `discovery:false` left discovered() undefined, so copilotRequestWire
     * silently defaulted to /chat/completions and the request 404/400'd at the
     * gateway; an explicit config wire must win over catalog inference]-[config
     * `models[].wire` now routes the request even without discovery]
     */
    configuredWireEntry(model) {
        const configured = this.options.models.find(entry => entry.id === model);
        return configured?.wire === undefined
            ? undefined
            : { id: configured.id, name: configured.name ?? configured.id, copilotWire: configured.wire };
    }
    /**
     * The replay scope isolating one ACCOUNT × CONVERSATION × MODEL. The
     * account identity is the session's long-lived GitHub token (stable across
     * Copilot-token refreshes, different per GitHub login); the conversation is
     * the loop-stamped `sessionId`, falling back to the first message's id
     * when a hand-built request carries no session stamp. Identity-free
     * requests have no replay scope; the model separates
     * wire families. A call id captured in one scope is invisible to every
     * other scope, so reused ids cannot leak reasoning across accounts,
     * conversations, or models.
     */
    replayScope(tokenKey, options) {
        const conversation = options.sessionId !== undefined
            ? `session:${String(options.sessionId)}`
            : options.messages[0]?.id !== undefined
                ? `anchor:${String(options.messages[0].id)}`
                : undefined;
        if (conversation === undefined)
            return undefined;
        return `${tokenKey}\u0000${conversation}\u0000${options.model}`;
    }
    /**
     * Store one response's completed reasoning items behind every call id it
     * produced, inside one replay scope. Retention: a CONSUMED entry is kept —
     * every later round of the same conversation replays ALL its earlier
     * function_calls — until it idles out of the TTL (see {@link replayFor})
     * or the per-scope entry cap evicts it oldest-first. All calls of one
     * response share ONE entry object: toResponsesInput dedupes replays by
     * array reference, so parallel calls replay the items once instead of once
     * per call.
     */
    captureReasoning(scope, callIds, items) {
        if (scope === undefined)
            return;
        let entries = this.replayByScope.get(scope);
        if (entries === undefined) {
            entries = new Map();
            this.replayByScope.set(scope, entries);
        }
        else {
            // Refresh the scope's recency so an active conversation is never the
            // scope-cap eviction victim.
            this.replayByScope.delete(scope);
            this.replayByScope.set(scope, entries);
        }
        const now = Date.now();
        for (const [callId, entry] of entries) {
            if (now - entry.at >= CopilotAdapter.REPLAY_TTL_MS)
                entries.delete(callId);
        }
        const entry = { items: [...items], at: now };
        for (const callId of callIds)
            entries.set(callId, entry);
        // Blobs reach tens of kilobytes; cap the ENTRY count and evict the oldest
        // by insertion order rather than tracking bytes — eviction merely degrades
        // ancient calls to the pre-capture behavior.
        while (entries.size > CopilotAdapter.REPLAY_CALL_LIMIT) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined)
                break;
            entries.delete(oldest);
        }
        while (this.replayByScope.size > CopilotAdapter.REPLAY_SCOPE_LIMIT) {
            const oldest = this.replayByScope.keys().next().value;
            if (oldest === undefined)
                break;
            this.replayByScope.delete(oldest);
        }
    }
    /**
     * The replay items for one call id in one scope, when still fresh. The TTL
     * bounds IDLE time, not total age: a hit refreshes the entry (and its
     * eviction recency), so an ongoing conversation keeps its chain alive
     * while a conversation that stopped asking forgets within the TTL. An
     * absent or aged-out entry answers `undefined` — the no-replay
     * degradation, never an error.
     */
    replayFor(scope, callId) {
        if (scope === undefined)
            return undefined;
        const entries = this.replayByScope.get(scope);
        const entry = entries?.get(callId);
        if (entries === undefined || entry === undefined)
            return undefined;
        const now = Date.now();
        if (now - entry.at >= CopilotAdapter.REPLAY_TTL_MS)
            return undefined;
        entry.at = now;
        entries.delete(callId);
        entries.set(callId, entry);
        this.replayByScope.delete(scope);
        this.replayByScope.set(scope, entries);
        return entry.items;
    }
    /**
     * Drop every captured replay entry. Lookup correctness never depends on
     * the call — the scope already carries the account identity — but the host
     * wiring invokes this on every copilot auth transition (login, logout,
     * credential death) so a switched account's memory never holds the
     * previous account's encrypted reasoning at all; conversation teardown is
     * bounded by the TTL and the caps.
     */
    clearReplayState() {
        this.replayByScope.clear();
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
        // Efforts come from the discovered catalog's reasoning_effort array; a
        // model that did not advertise one exposes none, so the harness rejects
        // an explicit effort before provider I/O instead of the API 400ing
        // (Copilot returns invalid_request_body for models that cannot reason).
        // A configured default effort still merges in: the picker then
        // preselects it even for models the catalog does not cover.
        const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), discovered?.reasoning);
        return {
            provider,
            id: model,
            name: discovered?.name ?? configured?.name ?? model,
            ...discovered?.description === undefined ? {} : { description: discovered.description },
            inputModalities: discovered?.inputModalities ?? configured?.inputModalities ?? ['text'],
            context: { contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? COPILOT_CONTEXT_WINDOW },
            defaultMaxTokens: configured?.maxTokens ?? COPILOT_DEFAULT_MAX_TOKENS,
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
            // The discovered catalog decides the protocol: `/responses`-only model
            // families (gpt-5.5/5.6, …) reject /chat/completions outright, and
            // dual-protocol models reroute there once the request combines function
            // tools with a reasoning effort (gpt-5.4 400s on the chat wire then).
            // A configured `wire` outranks the catalog (see configuredWireEntry).
            const wire = copilotRequestWire(this.configuredWireEntry(options.model) ?? await this.discovered(options.model), options);
            let session = await this.options.tokens.session(account);
            // Replay scope: account identity × conversation × model (see
            // replayScope); a Copilot-token refresh preserves the GitHub token, so
            // the 401 retry below reuses it too.
            const scope = this.replayScope(session.refreshToken, options);
            let response = await this.request(options, session, watchdog.signal, wire, scope);
            if (response.status === 401) {
                // One forced refresh + retry on an unexpired-but-rejected token. The
                // editor version is force-refreshed too: a 401 `IDE token expired`
                // means GitHub raised its minimum VS Code version, and only a fresh
                // Editor-Version header fixes that (a new token does not).
                await latestVsCodeVersion(this.options.fetchFn ?? proxiedFetch, true);
                session = await this.options.tokens.session(account, true);
                response = await this.request(options, session, watchdog.signal, wire, scope);
            }
            if (!response.ok) {
                throw await httpLlmError(response, 'copilot API', {
                    // Copilot has no provider-specific reset reader yet. The shared
                    // mapper still honors its generic retry-after header and warns with
                    // rate-limit-shaped headers/body when GitHub sends another signal.
                    ...this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn },
                });
            }
            if (response.body === null) {
                throw new LlmError('copilot API returned no response body', EMPTY_RESPONSE_CODE);
            }
            const pulse = () => { watchdog.pulse(); };
            if (wire === 'responses') {
                // The normalizer doubles as the capture point for completed reasoning.
                const normalizer = new CopilotResponsesItemNormalizer((callIds, items) => {
                    this.captureReasoning(scope, callIds, items);
                });
                yield* streamResponses(response.body, pulse, event => normalizer.push(event));
            }
            else {
                yield* streamChatCompletions(response.body, pulse);
            }
        }
        catch (error) {
            throw mapFetchFailure('copilot API', error, watchdog, options.signal);
        }
        finally {
            watchdog.stop();
        }
    }
    async request(options, session, signal, wire, replayScopeKey) {
        const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal);
        const hasVision = messages.some(message => message.content.some(block => block.type === 'image'));
        const body = wire === 'responses'
            ? copilotResponsesRequestBody(options, toResponsesInput(messages, options.system, 
            // Captured completed reasoning replays ahead of its tool call.
            callId => this.replayFor(replayScopeKey, callId)))
            : copilotChatRequestBody(options, toChatMessages(messages, options.system));
        return proxiedFetch(wire === 'responses' ? COPILOT_RESPONSES_URL : COPILOT_API_URL, {
            method: 'POST',
            headers: {
                'authorization': `Bearer ${session.accessToken}`,
                'accept': 'text/event-stream',
                'content-type': 'application/json',
                ...copilotHeaders(hasVision, await latestVsCodeVersion(this.options.fetchFn ?? proxiedFetch)),
            },
            body: JSON.stringify(body),
            signal,
        });
    }
}
