/**
 * ChatGPT/Codex subscription provider: OAuth against auth.openai.com with the
 * Codex CLI client id, and streaming against the ChatGPT backend Responses
 * endpoint.
 */
import { createHash, randomUUID } from 'node:crypto';
import { attributionHeaders, EMPTY_RESPONSE_CODE, errorChain, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '../compat.js';
import { decodeJwtPayload } from '../auth/jwt.js';
import { resolveImages } from '../translate/resolved.js';
import { streamResponses, toResponsesInput, toResponsesTools } from '../translate/responses.js';
import { deterministicSessionId, effortDisplayName, httpLlmError, idleWatchdog, mapFetchFailure, mergeReasoning, ModelCatalogCache, discoverAcrossAccounts, discoverOrRetryAuth, isDiscoveryAborted, isDiscoveryAuthFailure, isMissingOrInvalidCredential, oauthEndpointError, OAuthEndpointError, } from './common.js';
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js';
import { proxiedFetch } from '../http.js';
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, jsonBody, resetFromFields, subscriptionRetryPolicy, } from './rate-limit.js';
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const CODEX_CALLBACK_PATH = '/auth/callback';
const CODEX_CONTEXT_WINDOW = 400_000;
const CODEX_DEFAULT_MAX_TOKENS = 128_000;
/** Refresh when the access token has less than this much life left. */
export const CODEX_PREEMPT_MS = 5 * 60_000;
/**
 * Body fields the backend uses to name a reset. A window-exhaustion rejection
 * carries `usage_limit_reached` with the seconds left on the window — the case
 * that used to classify as a terminal quota and never be retried at all.
 */
const CODEX_RESET_FIELDS = ['resets_in_seconds', 'reset_after_seconds', 'resets_at', 'reset_at'];
/**
 * Reads the reset instant of the Codex window that rejected a request.
 *
 * Body only. The `x-codex-{primary,secondary}-reset-after-seconds` headers are
 * rollover snapshots the backend attaches to every response, one per window,
 * so they say nothing about which window refused: a burst 429 that would clear
 * in seconds still carries a primary rollover hours out, and reading it would
 * park the turn for those hours. They reach the operator through
 * `rateLimitDiagnostics` instead.
 */
export const codexRateLimitReset = (_response, body, now) => resetFromFields(jsonBody(body), CODEX_RESET_FIELDS, now);
/** Default instruction when the request carries no system prompt. */
const DEFAULT_CODEX_INSTRUCTIONS = 'You are Codex, a coding agent based on GPT-5. '
    + 'Help the user with their software engineering tasks.';
/** Refresh-grant rejections that mean the login is gone for good. */
const PERMANENT_REFRESH_CODES = new Set([
    'refresh_token_expired',
    'refresh_token_reused',
    'refresh_token_invalidated',
    'invalid_grant',
]);
const CODEX_EFFORTS = [
    { id: ReasoningEffortId('minimal'), name: 'Minimal' },
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('medium'), name: 'Medium' },
    { id: ReasoningEffortId('high'), name: 'High' },
    { id: ReasoningEffortId('xhigh'), name: 'Extra High' },
];
const CODEX_DEFAULT_EFFORT = ReasoningEffortId('high');
/** Every gpt-5.x codex model accepts image input. */
const CODEX_MODALITIES = ['text', 'image'];
/**
 * Fast tier (the codex CLI's "fast mode"): the Responses `service_tier` wire
 * value for priority processing, mirroring codex-rs
 * `ServiceTier::Fast.request_value()`. The legacy catalog spelling is the
 * `additional_speed_tiers` entry "fast".
 */
export const CODEX_FAST_SERVICE_TIER = 'priority';
const CODEX_FAST_SPEED_TIER = 'fast';
/** Static codex flow facts for the OAuth flow engine. */
export const codexFlow = {
    callbackPath: CODEX_CALLBACK_PATH,
    listen: { host: 'localhost', ports: [1455, 1457] },
    buildAuthorizeUrl({ redirectUri, state, pkce }) {
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: CODEX_CLIENT_ID,
            redirect_uri: redirectUri,
            scope: CODEX_SCOPE,
            code_challenge: pkce.challenge,
            code_challenge_method: 'S256',
            state,
            id_token_add_organizations: 'true',
            codex_cli_simplified_flow: 'true',
            originator: 'codex_cli_rs',
        });
        return `${CODEX_AUTHORIZE_URL}?${params.toString()}`;
    },
};
/** Pull `chatgpt_account_id` out of an id token payload. */
function accountIdOf(idToken) {
    const payload = idToken === undefined ? undefined : decodeJwtPayload(idToken);
    const auth = payload?.['https://api.openai.com/auth'];
    const accountId = typeof auth === 'object' && auth !== null
        ? auth.chatgpt_account_id
        : undefined;
    if (typeof accountId !== 'string' || accountId.length === 0) {
        throw new Error('codex login did not return a chatgpt account id; cannot use the subscription');
    }
    return accountId;
}
/**
 * Decode the user-identity claims of a codex id token (pure, cheap — no
 * verification, same trust posture as {@link accountIdOf}). Claim paths
 * mirror codex-rs `login/src/token_data.rs`: the email is the top-level
 * `email` claim, falling back to `https://api.openai.com/profile`.email; the
 * plan is `https://api.openai.com/auth`.chatgpt_plan_type.
 * @param idToken - a stored or freshly issued id token, when present.
 * @returns whichever claims the token carried; empty when undecodable.
 */
export function codexProfileClaims(idToken) {
    const payload = idToken === undefined ? undefined : decodeJwtPayload(idToken);
    if (payload === undefined)
        return {};
    const profile = payload['https://api.openai.com/profile'];
    const profileEmail = typeof profile === 'object' && profile !== null
        ? profile.email
        : undefined;
    const email = payload.email ?? profileEmail;
    const auth = payload['https://api.openai.com/auth'];
    const plan = typeof auth === 'object' && auth !== null
        ? auth.chatgpt_plan_type
        : undefined;
    return {
        ...typeof email === 'string' && email.length > 0 ? { emailAddress: email } : {},
        ...typeof plan === 'string' && plan.length > 0 ? { planType: plan } : {},
    };
}
/** Build a session from a token response; expires_in wins, JWT exp is the fallback. */
function codexSession(tokens, fallback) {
    if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
        throw new Error('codex token endpoint returned no access token');
    }
    const refreshToken = tokens.refresh_token ?? fallback?.refreshToken;
    if (refreshToken === undefined)
        throw new Error('codex token endpoint returned no refresh token');
    let expiresAt;
    if (typeof tokens.expires_in === 'number' && tokens.expires_in > 0) {
        expiresAt = Date.now() + tokens.expires_in * 1000;
    }
    else {
        const exp = decodeJwtPayload(tokens.access_token)?.exp;
        if (typeof exp === 'number' && exp > 0)
            expiresAt = exp * 1000;
    }
    if (expiresAt === undefined)
        throw new Error('codex token endpoint returned no usable expiry');
    // Identity claims come from the freshest id token; a refresh that omits
    // one keeps the claims the stored session already had.
    const idToken = tokens.id_token ?? fallback?.idToken;
    const claims = {
        ...fallback?.emailAddress === undefined ? {} : { emailAddress: fallback.emailAddress },
        ...fallback?.planType === undefined ? {} : { planType: fallback.planType },
        ...codexProfileClaims(tokens.id_token),
    };
    return {
        accessToken: tokens.access_token,
        refreshToken,
        expiresAt,
        accountId: tokens.id_token === undefined && fallback !== undefined
            ? fallback.accountId
            : accountIdOf(tokens.id_token),
        ...idToken === undefined ? {} : { idToken },
        ...claims,
    };
}
/**
 * Exchange an authorization code for a codex session (form-encoded grant).
 * @param code - the authorization code from the callback.
 * @param verifier - the PKCE verifier minted for the attempt.
 * @param redirectUri - the attempt's redirect URI.
 * @returns the session to store.
 */
export async function exchangeCodexCode(code, verifier, redirectUri) {
    const response = await proxiedFetch(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: CODEX_CLIENT_ID,
            code_verifier: verifier,
        }).toString(),
    });
    if (!response.ok)
        throw await oauthEndpointError(response, 'codex');
    return codexSession(await response.json());
}
/**
 * Refresh a codex session (JSON grant — unlike the code exchange).
 * @param session - the stored session.
 * @returns the fresh session to store.
 */
export async function refreshCodex(session) {
    const response = await proxiedFetch(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            client_id: CODEX_CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: session.refreshToken,
        }),
    });
    if (!response.ok)
        throw await oauthEndpointError(response, 'codex');
    return codexSession(await response.json(), session);
}
/**
 * Whether a codex refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix.
 */
export function isCodexPermanentRefreshError(error) {
    return error instanceof OAuthEndpointError
        && error.oauthCode !== undefined
        && PERMANENT_REFRESH_CODES.has(error.oauthCode);
}
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
function parseResetDate(value) {
    if (typeof value !== 'string')
        return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
}
/** Read available banked resets. This endpoint is private and intentionally read-only. */
export async function fetchCodexResetCredits(session, fetchFn = proxiedFetch, signal) {
    const response = await fetchFn(CODEX_RESET_CREDITS_URL, {
        headers: {
            authorization: `Bearer ${session.accessToken}`,
            'chatgpt-account-id': session.accountId,
            originator: 'Codex Desktop',
            'openai-beta': 'codex-1',
            accept: 'application/json',
            ...attributionHeaders(),
        },
        ...signal === undefined ? {} : { signal },
    });
    if (!response.ok)
        throw await oauthEndpointError(response, 'codex reset credits');
    const payload = await response.json();
    if (!Array.isArray(payload?.credits))
        throw new Error('codex reset credits: unexpected response (missing credits array)');
    return payload.credits.flatMap((value) => {
        if (typeof value !== 'object' || value === null)
            return [];
        const credit = value;
        if (credit.status !== 'available' || credit.reset_type !== 'codex_rate_limits')
            return [];
        const grantedAt = parseResetDate(credit.granted_at);
        const expiresAt = parseResetDate(credit.expires_at);
        return [{ ...(typeof credit.id === 'string' ? { id: credit.id } : {}), ...(grantedAt === undefined ? {} : { grantedAt }), ...(expiresAt === undefined ? {} : { expiresAt }) }];
    });
}
/** Spend one banked reset. The caller must already have confirmed the credit is still available. */
export async function consumeCodexResetCredit(session, creditId, requestId, fetchFn = proxiedFetch, signal) {
    const response = await fetchFn(CODEX_RESET_CREDITS_URL + '/consume', {
        method: 'POST',
        headers: {
            authorization: 'Bearer ' + session.accessToken,
            'chatgpt-account-id': session.accountId,
            originator: 'Codex Desktop', 'openai-beta': 'codex-1',
            'content-type': 'application/json', accept: 'application/json',
            ...attributionHeaders(),
        },
        body: JSON.stringify({ redeem_request_id: requestId, credit_id: creditId }),
        ...signal === undefined ? {} : { signal },
    });
    if (!response.ok)
        throw await oauthEndpointError(response, 'codex consume reset');
    const payload = await response.json();
    if (payload?.code !== 'reset')
        throw new Error('Reset was not confirmed. Verify the account in Codex before retrying.');
}
/** Seconds of the canonical 5-hour session and 7-day weekly windows. */
const SESSION_WINDOW_SECONDS = 5 * 60 * 60;
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
/** Whether a reported duration approximately matches the expected window length. */
function matchesWindow(seconds, expected) {
    return seconds >= expected * 0.95 && seconds <= expected * 1.05;
}
/**
 * Classify a wham/usage window by its reported duration. The backend has been
 * observed to place the weekly lane in `primary_window` with no secondary
 * window, so slot position alone is unreliable; the caller's positional
 * fallback applies only when the duration is absent.
 */
function codexWindowKind(window, fallback) {
    const seconds = window.limit_window_seconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0)
        return fallback;
    if (matchesWindow(seconds, SESSION_WINDOW_SECONDS))
        return 'session';
    if (matchesWindow(seconds, WEEKLY_WINDOW_SECONDS))
        return 'weekly';
    return 'other';
}
/** Map one wham/usage window into a {@link UsageWindow}; undefined when unusable. */
function codexUsageWindow(value, fallbackKind) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const window = value;
    if (typeof window.used_percent !== 'number' || !Number.isFinite(window.used_percent))
        return undefined;
    let resetsAt;
    if (typeof window.reset_at === 'number' && window.reset_at > 0) {
        resetsAt = window.reset_at * 1000;
    }
    else if (typeof window.reset_after_seconds === 'number' && window.reset_after_seconds > 0) {
        resetsAt = Date.now() + window.reset_after_seconds * 1000;
    }
    return {
        kind: codexWindowKind(window, fallbackKind),
        usedPercent: window.used_percent,
        ...resetsAt === undefined ? {} : { resetsAt },
    };
}
/**
 * Fetch the codex subscription usage from the ChatGPT backend wham/usage
 * endpoint (the source of the codex CLI `/status` rate-limit lines). The
 * windows are classified by their reported duration (`limit_window_seconds`)
 * rather than by slot, since the backend has been observed to report the
 * weekly lane as `primary_window` without a secondary window; slot order is
 * kept only as a fallback when the duration is absent. The lookup itself
 * consumes no rate-limit budget.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation from the RPC transport.
 * @returns the mapped usage snapshot.
 */
export async function fetchCodexUsage(session, fetchFn = proxiedFetch, signal) {
    const response = await fetchFn(CODEX_USAGE_URL, {
        headers: {
            'authorization': `Bearer ${session.accessToken}`,
            'chatgpt-account-id': session.accountId,
            'originator': 'codex_cli_rs',
            'accept': 'application/json',
            ...attributionHeaders(),
        },
        ...signal === undefined ? {} : { signal },
    });
    if (!response.ok)
        throw await oauthEndpointError(response, 'codex usage');
    const payload = await response.json();
    const windows = [];
    const primary = codexUsageWindow(payload.rate_limit?.primary_window, 'session');
    const secondary = codexUsageWindow(payload.rate_limit?.secondary_window, 'weekly');
    if (primary !== undefined)
        windows.push(primary);
    if (secondary !== undefined)
        windows.push(secondary);
    return {
        supported: true,
        windows,
        ...typeof payload.plan_type === 'string' && payload.plan_type.length > 0
            ? { plan: payload.plan_type }
            : {},
    };
}
export const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
/**
 * Client version sent on the /models catalog request. The backend gates the
 * visible model list by client version. Verified 2026-09-05: the same account
 * omitted GPT-6 Astra at 0.147.0 and listed it at stable CLI 0.153.4. This is
 * not an entitlement guarantee; the server remains authoritative.
 */
export const CODEX_CLIENT_VERSION = '0.153.4';
/** Validate an explicit catalog compatibility version before using it on the wire. */
export function codexClientVersion(value = CODEX_CLIENT_VERSION) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value)) {
        throw new Error('codexClientVersion must be a version such as 0.153.4');
    }
    return value;
}
/**
 * Whether a catalog entry advertises the fast tier. Mirrors codex-rs
 * `ModelPreset::supports_fast_mode`: a `service_tiers` id matching the fast
 * wire value, or the legacy `additional_speed_tiers` "fast" entry.
 */
function supportsFastTier(entry) {
    return (entry.service_tiers ?? []).some(tier => tier.id === CODEX_FAST_SERVICE_TIER)
        || (entry.additional_speed_tiers ?? []).includes(CODEX_FAST_SPEED_TIER);
}
/**
 * Fetch the live codex model catalog with the session's auth headers.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation (pool-assembly timeout).
 * @param clientVersion - catalog compatibility version, not the plugin version.
 * @returns discovered models: hidden entries dropped, sorted by priority.
 */
export async function fetchCodexModels(session, fetchFn = proxiedFetch, signal, clientVersion = CODEX_CLIENT_VERSION) {
    const version = codexClientVersion(clientVersion);
    const url = `${CODEX_MODELS_URL}?client_version=${encodeURIComponent(version)}`;
    const response = await fetchFn(url, {
        headers: {
            'authorization': `Bearer ${session.accessToken}`,
            'chatgpt-account-id': session.accountId,
            'originator': 'codex_cli_rs',
            'accept': 'application/json',
            ...attributionHeaders(),
        },
        ...signal === undefined ? {} : { signal },
    });
    if (!response.ok)
        throw await oauthEndpointError(response, 'codex models');
    const payload = await response.json();
    if (!Array.isArray(payload.models))
        throw new Error('codex models endpoint returned no models array');
    const discovered = [];
    for (const entry of payload.models) {
        if (typeof entry.slug !== 'string' || entry.slug.length === 0)
            continue;
        // codex-rs ModelVisibility: only "list" is picker-visible; hide/none are
        // dropped, and an absent or unknown value is included (in doubt, include).
        if (entry.visibility === 'hide' || entry.visibility === 'none')
            continue;
        // "ultra" is a Codex-client mode (max reasoning + automatic sub-agent
        // delegation), not a wire value: the Responses API rejects it with HTTP 400.
        const efforts = (entry.supported_reasoning_levels ?? [])
            .filter(level => typeof level.effort === 'string' && level.effort.length > 0 && level.effort !== 'ultra')
            .map(level => ({
            id: ReasoningEffortId(level.effort),
            name: effortDisplayName(level.effort),
            ...level.description === undefined ? {} : { description: level.description },
        }));
        const defaultEffort = typeof entry.default_reasoning_level === 'string'
            && entry.default_reasoning_level.length > 0
            && efforts.some(effort => effort.id === ReasoningEffortId(entry.default_reasoning_level))
            ? ReasoningEffortId(entry.default_reasoning_level)
            : undefined;
        const model = {
            id: entry.slug,
            name: typeof entry.display_name === 'string' && entry.display_name.length > 0
                ? entry.display_name
                : entry.slug,
            ...typeof entry.description === 'string' && entry.description.length > 0
                ? { description: entry.description }
                : {},
            ...typeof entry.context_window === 'number' && entry.context_window > 0
                ? { contextWindow: entry.context_window }
                : {},
            ...Number.isSafeInteger(entry.max_context_window) && entry.max_context_window > 0
                ? { maxContextWindow: entry.max_context_window }
                : {},
            ...typeof entry.priority === 'number' ? { priority: entry.priority } : {},
            ...efforts.length > 0
                ? { reasoning: { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } } }
                : {},
            ...supportsFastTier(entry) ? { fastTier: true } : {},
        };
        discovered.push(model);
    }
    discovered.sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
    // An empty catalog from a 200 response means the backend gated us out (e.g.
    // client_version too old): surface it as a discovery failure so the adapter
    // falls back to the static catalog instead of vanishing from the picker.
    if (discovered.length === 0) {
        throw new Error(`codex models endpoint returned an empty catalog (client_version ${version})`);
    }
    return discovered;
}
const CODEX_CALL_ID_MAX_LENGTH = 64;
const CODEX_CALL_ID_PREFIX = 'call_';
/**
 * Bound tool-call ids at the Codex wire boundary without changing the shared
 * Responses translation used by Grok. Short ids stay verbatim. Oversized ids
 * become deterministic hashes, and every id already present in this request
 * is reserved first so a generated id cannot collide with a legitimate short
 * one (or another oversized id).
 */
function normalizeCodexCallIds(input) {
    const mapping = new Map();
    const used = new Set();
    const callId = (item) => (item.type === 'function_call' || item.type === 'function_call_output') && typeof item.call_id === 'string'
        ? item.call_id
        : undefined;
    for (const item of input) {
        const id = callId(item);
        if (id !== undefined && id.length <= CODEX_CALL_ID_MAX_LENGTH) {
            mapping.set(id, id);
            used.add(id);
        }
    }
    for (const item of input) {
        const id = callId(item);
        if (id === undefined || mapping.has(id))
            continue;
        let attempt = 0;
        let normalized;
        do {
            const hash = createHash('sha256');
            if (attempt > 0)
                hash.update(String(attempt)).update('\0');
            const digest = hash.update(id).digest('hex');
            normalized = `${CODEX_CALL_ID_PREFIX}${digest.slice(0, CODEX_CALL_ID_MAX_LENGTH - CODEX_CALL_ID_PREFIX.length)}`;
            attempt += 1;
        } while (used.has(normalized));
        mapping.set(id, normalized);
        used.add(normalized);
    }
    return input.map((item) => {
        const id = callId(item);
        if (id === undefined)
            return item;
        const normalized = mapping.get(id) ?? id;
        return normalized === id ? item : { ...item, call_id: normalized };
    });
}
/** Text marking a repaired tool output as an unknown outcome; the model must verify before retrying. */
export const CODEX_UNKNOWN_TOOL_OUTCOME = 'The tool call has no recorded result. Its outcome is unknown; verify external state before retrying any operation that may have side effects.';
/**
 * Reconcile one Responses input's tool-call pairing after id normalization:
 * every `function_call` gets an output and every `function_call_output`
 * matches a call. Missing outputs become error-style outputs whose text marks
 * the outcome unknown; orphan outputs are dropped. Duplicate calls of one id
 * receive exactly one repair output. The request is local repair only: the
 * durable history stays authoritative and unchanged.
 * @param input - normalized Responses input items.
 * @returns the same array when already balanced, otherwise a repaired array.
 */
export function reconcileResponsesToolCalls(input) {
    const calls = new Set();
    const outputs = new Set();
    for (const item of input) {
        if (item.type === 'function_call' && typeof item.call_id === 'string')
            calls.add(item.call_id);
        else if (item.type === 'function_call_output' && typeof item.call_id === 'string')
            outputs.add(item.call_id);
    }
    const missing = new Set([...calls].filter(callId => !outputs.has(callId)));
    if (missing.size === 0 && [...outputs].every(callId => calls.has(callId)))
        return input;
    const balanced = [];
    for (const item of input) {
        if (item.type === 'function_call_output' && (typeof item.call_id !== 'string' || !calls.has(item.call_id))) {
            continue;
        }
        balanced.push(item);
        if (item.type === 'function_call' && typeof item.call_id === 'string' && missing.delete(item.call_id)) {
            balanced.push({ type: 'function_call_output', call_id: item.call_id, output: CODEX_UNKNOWN_TOOL_OUTCOME });
        }
    }
    return balanced;
}
/**
 * The `reasoning.effort` wire value for a selected effort. Codex's "ultra" is
 * a client-side selection (max reasoning plus proactive sub-agent delegation)
 * that the Codex CLI itself lowers to `max` at the Responses API boundary;
 * the backend answers HTTP 400 to a literal `ultra`. Discovery no longer
 * lists it, but an effort saved before that change may still arrive here.
 */
export function codexWireEffort(effort) {
    return effort === 'ultra' ? 'max' : effort;
}
/**
 * The Responses request body for one generation. A fast-tier request (the
 * composer Speed toggle, the codex CLI's fast mode) carries
 * `service_tier: priority`; the tier field is omitted entirely otherwise,
 * matching the CLI (it never sends an explicit standard tier).
 */
export function codexRequestBody(options, resolved, fast) {
    return {
        model: options.model,
        instructions: resolved.instructions ?? DEFAULT_CODEX_INSTRUCTIONS,
        input: reconcileResponsesToolCalls(normalizeCodexCallIds(resolved.input)),
        // Omit tool controls for tool-less requests, matching the other adapters.
        // This is request-shape consistency, not a claim that Codex rejects the
        // controls when no tools are supplied.
        ...options.tools !== undefined && options.tools.length > 0
            ? { tools: toResponsesTools(options.tools, { strict: false }), tool_choice: 'auto', parallel_tool_calls: true }
            : {},
        ...options.reasoningEffort !== undefined
            ? { reasoning: { effort: codexWireEffort(String(options.reasoningEffort)), summary: 'auto' } }
            : {},
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        ...options.sessionId !== undefined ? { prompt_cache_key: String(options.sessionId) } : {},
        ...fast ? { service_tier: CODEX_FAST_SERVICE_TIER } : {},
    };
}
/** Adapt the current harness's first-class tool messages at the Codex boundary. */
export function projectCodexMessages(messages) {
    return messages.map((message) => {
        if (String(message.role) !== 'tool')
            return message;
        const current = message;
        const callId = current.toolCallId
            ?? (current.source?.kind === 'tool' ? String(current.source.callId) : undefined);
        if (callId === undefined)
            throw new LlmError('Codex tool result has no call id', 'INVALID_REQUEST');
        return {
            ...message.id === undefined ? {} : { id: message.id },
            role: 'user',
            source: { kind: 'tool', callId: ToolCallId(callId) },
            content: [{
                    type: 'tool-result',
                    toolCallId: ToolCallId(callId),
                    content: [...message.content],
                    ...current.isError === undefined ? {} : { isError: current.isError },
                }],
        };
    });
}
/** Codex wire adapter: one instance serves the `codex` provider route. */
export class CodexAdapter extends LlmAdapter {
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
        codexClientVersion(options.clientVersion);
        this.catalog = new ModelCatalogCache(options.catalogStore, undefined, options.onCatalogChanged);
    }
    /** Discovery fetcher: resolves the session through the refresh-aware path. */
    async fetchCatalog(account, signal) {
        const version = this.options.clientVersion ?? await this.options.resolveClientVersion?.();
        signal?.throwIfAborted();
        return fetchCodexModels(await this.options.tokens.session(account), this.options.fetchFn, signal, version);
    }
    /** Drop cached catalogs after login/logout so the next list does not reuse a stale plan. */
    clearAccountCatalog(account) {
        if (account === undefined) {
            this.accountCatalogsInvalidated = true;
            this.invalidatedAccounts.clear();
        }
        else
            this.invalidatedAccounts.add(account);
        // invalidate() also drops the persisted snapshot, so a logged-out account
        // cannot resurface its models from disk.
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
    /** Picker rows for discovered entries (the wire id doubles as the route id). */
    listed(provider, models) {
        return models.map(model => ({
            provider,
            id: model.id,
            name: model.name,
            ...model.description === undefined ? {} : { description: model.description },
            inputModalities: CODEX_MODALITIES,
            ...model.priority === undefined ? {} : { priority: model.priority },
        }));
    }
    /**
     * The last catalog one account successfully listed, without any network.
     * Routing asks for this when live discovery times out: an account that
     * listed a model minutes ago is still a better answer than "no models".
     */
    async lastKnownOwnModels(provider, account) {
        if (!this.options.discovery || !await this.options.tokens.hasSession(account))
            return undefined;
        const known = (await this.catalogFor(account)).lastKnown();
        return known === undefined ? undefined : this.listed(provider, known);
    }
    providerInfo(provider) {
        return { id: provider, name: 'ChatGPT (Codex)' };
    }
    providerRetryPolicy(provider) {
        return subscriptionRetryPolicy(DEFAULT_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT, `codex: provider "${provider}" retryPolicy`);
    }
    staticModels(provider) {
        return this.options.models.map(model => ({
            provider,
            id: model.id,
            name: model.name ?? model.id,
            inputModalities: model.inputModalities ?? CODEX_MODALITIES,
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
            return unionAccountCatalogs(accounts, (key, accountSignal) => this.listOwnModels(provider, key, accountSignal, preferCached), { timeoutMs: this.options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS, ...signal === undefined ? {} : { signal } });
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
            return this.listed(provider, discovered);
        }
        catch (error) {
            // A cancelled discovery must not fall back to the static catalog — the
            // caller (pool assembly) treats abort as "this account sits out".
            if (isDiscoveryAborted(error, signal))
                throw error;
            // A permanent refresh failure deletes the stored session: the provider
            // is logged out, so hide it instead of showing a stale static catalog.
            if (isMissingOrInvalidCredential(error))
                return [];
            // The backend rejected the token again right after a forced refresh:
            // the login is revoked server-side. Listing the built-in catalog here
            // would route requests to a dead account and show phantom models.
            if (isDiscoveryAuthFailure(error)) {
                const who = (await this.options.tokens.peek(account))?.emailAddress ?? account ?? 'default account';
                this.options.onWarn?.(`codex rejected the login of ${who}; hiding its models until it logs in again (${errorChain(error)})`);
                return [];
            }
            // A transient failure (network, 5xx, timeout) must not demote a
            // working account to the built-in catalog, which lags the backend by
            // generations: the last successful discovery is the truthful answer.
            const known = catalog.lastKnown();
            if (known !== undefined) {
                this.options.onWarn?.(`codex model discovery failed; using the last discovered catalog (${errorChain(error)})`);
                return this.listed(provider, known);
            }
            this.options.onWarn?.(`codex model discovery failed; using the built-in catalog (${errorChain(error)})`);
            return this.staticModels(provider);
        }
    }
    /**
     * The discovered entry for one model. Resolved through the cache's
     * stale-while-revalidate path so capability metadata stays stable across a
     * long conversation: a discovered-only effort (one missing from the static
     * CODEX_EFFORTS list) selected by the user must not vanish — and fail the
     * call — just because the TTL lapsed mid-turn.
     */
    async discovered(model, account) {
        if (!this.options.discovery)
            return undefined;
        const accounts = account === undefined
            ? (await this.options.tokens.list()).map(entry => entry.key)
            : [account];
        return discoverAcrossAccounts(accounts, async (account) => {
            const catalog = await this.catalogFor(account);
            const models = await catalog.resolve(() => this.fetchCatalog(account));
            return models?.find(entry => entry.id === model);
        });
    }
    /** Whether the discovered catalog advertises a fast tier for this model. */
    async supportsFastTier(model, account) {
        return (await this.discovered(model, account))?.fastTier === true;
    }
    /** Ids of every discovered model with a fast tier (the Speed toggle's visibility list). */
    async fastCapableModels() {
        if (!this.options.discovery)
            return [];
        // Not logged in → no fast models, so the Speed toggle hides after logout
        // (mirrors the listModels guard above). Union every account: a fast-capable
        // model only the non-default lists (e.g. gpt-5.6-sol) must still show Speed.
        const accounts = (await this.options.tokens.list()).map(entry => entry.key);
        if (accounts.length === 0)
            return [];
        const seen = new Set();
        const ids = [];
        for (const account of accounts) {
            try {
                const catalog = await this.catalogFor(account);
                const models = await catalog.resolve(() => this.fetchCatalog(account));
                for (const model of models ?? []) {
                    if (model.fastTier !== true || seen.has(model.id))
                        continue;
                    seen.add(model.id);
                    ids.push(model.id);
                }
            }
            catch {
                // sit out
            }
        }
        return ids;
    }
    async resolveModel(provider, model) {
        const pool = this.options.pool?.();
        if (pool !== undefined && await pool.owns(provider, model)) {
            return pool.resolveModel(provider, model);
        }
        return this.resolveOwnModel(provider, model);
    }
    /** Capability resolution of the provider's own models (the pool resolves members here). */
    async resolveOwnModel(provider, model, account) {
        // Discovered metadata (when discovery is on) wins over the static entry;
        // the static entry wins over the built-in defaults. A configured default
        // effort merges over both.
        const discovered = await this.discovered(model, account);
        const configured = this.options.models.find(entry => entry.id === model);
        // `extendable` only while falling back to the built-in list: that one is
        // known to trail the backend, so a configured level it omits still has to
        // be selectable. A discovered catalog is the truth about what the model
        // accepts, and a stale override must not be forced onto every request.
        const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), discovered?.reasoning ?? { efforts: CODEX_EFFORTS, defaultEffort: CODEX_DEFAULT_EFFORT }, { extendable: discovered?.reasoning === undefined });
        return {
            provider,
            id: model,
            name: discovered?.name ?? configured?.name ?? model,
            ...discovered?.description === undefined ? {} : { description: discovered.description },
            inputModalities: configured?.inputModalities ?? CODEX_MODALITIES,
            context: { contextWindow: await this.contextWindowFor(model, account) },
            defaultMaxTokens: configured?.maxTokens ?? CODEX_DEFAULT_MAX_TOKENS,
            ...(reasoning === undefined ? {} : { reasoning }),
        };
    }
    /** Account-specific bounds; absent maximum conservatively keeps the advertised default. */
    async contextLimits(model, account) {
        const discovered = await this.discovered(model, account);
        const configured = this.options.models.find(entry => entry.id === model);
        const fallback = discovered?.contextWindow ?? configured?.contextWindow ?? CODEX_CONTEXT_WINDOW;
        return { default: fallback, max: discovered?.maxContextWindow ?? fallback };
    }
    async contextWindowFor(model, account) {
        const limits = await this.contextLimits(model, account);
        return Math.min(this.options.contextWindowOf?.(model) ?? limits.default, limits.max);
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
                throw await httpLlmError(response, 'codex API', {
                    rateLimitReset: codexRateLimitReset,
                    ...this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn },
                });
            }
            if (response.body === null) {
                throw new LlmError('codex API returned no response body', EMPTY_RESPONSE_CODE);
            }
            yield* streamResponses(response.body, () => { watchdog.pulse(); });
        }
        catch (error) {
            throw mapFetchFailure('codex API', error, watchdog, options.signal);
        }
        finally {
            watchdog.stop();
        }
    }
    async request(options, session, signal) {
        const messages = await resolveImages(projectCodexMessages(options.messages), this.options.resolveAttachments?.(), signal);
        const fast = this.options.speedFor !== undefined
            && await this.options.speedFor(options.sessionId, options.model);
        const body = codexRequestBody(options, toResponsesInput(messages, options.system), fast);
        return proxiedFetch(CODEX_API_URL, {
            method: 'POST',
            headers: {
                'authorization': `Bearer ${session.accessToken}`,
                'chatgpt-account-id': session.accountId,
                'originator': 'codex_cli_rs',
                'session-id': deterministicSessionId(options.sessionId),
                'accept': 'text/event-stream',
                'content-type': 'application/json',
                ...attributionHeaders(),
            },
            body: JSON.stringify(body),
            signal,
        });
    }
}
