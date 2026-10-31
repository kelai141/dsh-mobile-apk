/**
 * Plumbing shared by the subscription adapters: HTTP error mapping, a
 * stream idle watchdog, fetch failure classification, OAuth endpoint errors,
 * and the per-provider {@link TokenManager} that owns session freshness.
 * Concurrent refreshes for one provider coalesce behind a single in-flight
 * promise (`inflight`), so a rotating refresh token is never spent twice.
 */
import { createHash, randomUUID } from 'node:crypto';
import { CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId, } from '@deepseek-ai/dsh-llm';
import { durationMs, rateLimitDiagnostics, retryAfterInstant, waitFromReset } from './rate-limit.js';
/**
 * Validate a configured model catalog (mirrors llm-deepseek's resolveModels).
 * @param models - raw configured entries.
 * @param label - diagnostic prefix naming the provider.
 * @returns the validated entries.
 */
export function validateModels(models, label) {
    const seen = new Set();
    return models.map((model) => {
        if (model.id.length === 0)
            throw new Error(`${label}: catalog model ids must be non-empty`);
        if (model.name !== undefined && model.name.length === 0) {
            throw new Error(`${label}: catalog model "${model.id}" has an empty name`);
        }
        if (model.contextWindow !== undefined
            && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
            throw new Error(`${label}: catalog model "${model.id}" contextWindow must be a positive integer`);
        }
        if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
            throw new Error(`${label}: catalog model "${model.id}" maxTokens must be a positive integer`);
        }
        if (model.inputModalities !== undefined
            && (model.inputModalities.length === 0
                || model.inputModalities.some(modality => modality !== 'text' && modality !== 'image'))) {
            throw new Error(`${label}: catalog model "${model.id}" inputModalities must be a non-empty list of "text"/"image"`);
        }
        if (model.wire !== undefined && model.wire !== 'chat-completions' && model.wire !== 'responses') {
            throw new Error(`${label}: catalog model "${model.id}" wire must be "chat-completions" or "responses"`);
        }
        if (seen.has(model.id))
            throw new Error(`${label}: duplicate catalog model "${model.id}"`);
        seen.add(model.id);
        return {
            id: model.id,
            ...model.name === undefined ? {} : { name: model.name },
            ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
            ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
            ...model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] },
            ...model.wire === undefined ? {} : { wire: model.wire },
        };
    });
}
/**
 * Build an LlmError from a non-2xx provider response, mapping the status to a
 * stable code and, for a rate-limited request, the disclosed reset instant to
 * the `providerRetryAfterMs` the retry plugin waits out.
 *
 * A 429 classifies as `RATE_LIMIT` on the strength of the status alone, ahead
 * of the quota-wording check. On these routes there is no terminal quota to
 * distinguish: a subscription has no balance to top up, only a window that
 * reopens, and providers announce an exhausted window with wording
 * (`usage_limit_reached`) the shared classifier reads as permanent.
 * @param response - the failed response.
 * @param label - diagnostic prefix naming the provider API.
 * @param options - the calling provider's rate-limit reader and warning sink.
 * @returns the classified error.
 */
export async function httpLlmError(response, label, options = {}) {
    let body = '';
    try {
        body = await response.text();
    }
    catch {
        // Only swallow error-body reading: the HTTP status still identifies the failure.
    }
    // Truncated for display only; the readers below need the whole body to parse it.
    const shown = body.slice(0, 500);
    const message = shown.length > 0
        ? `${label} error (HTTP ${String(response.status)}): ${shown}`
        : `${label} error (HTTP ${String(response.status)})`;
    let code;
    if (response.status === 401 || response.status === 403)
        code = 'AUTH';
    else if (response.status === 429)
        code = 'RATE_LIMIT';
    else if (isQuotaExceededError(shown))
        code = QUOTA_EXCEEDED_CODE;
    else if (response.status === 400 && isContextWindowExceededError(shown))
        code = CONTEXT_WINDOW_EXCEEDED_CODE;
    else if (response.status === 408 || response.status === 504)
        code = 'TIMEOUT';
    else if (response.status >= 500)
        code = 'SERVER';
    else
        code = `HTTP_${String(response.status)}`;
    const now = Date.now();
    // The provider's reader runs on a 429 and nowhere else. Providers attach
    // their rate-limit headers to every response, so reading them on a transient
    // 500 would report the current window's rollover — hours out — as the delay
    // before retrying a failure that has nothing to do with the window, and the
    // retry plugin honours `providerRetryAfterMs` for every retryable code.
    // `retry-after` stays readable on any status: there it is a real backoff the
    // provider asked for (a 503 shedding load), not a window snapshot.
    //
    // On a 429 the provider's own field wins outright rather than being raced
    // against `retry-after`: a rejected window often carries both, and the
    // generic header then names a short backoff that would burn the retry budget
    // re-hitting the same closed window.
    const rateLimited = response.status === 429;
    const reset = rateLimited
        ? options.rateLimitReset?.(response, body, now) ?? googleQuotaReset(body, now) ?? retryAfterInstant(response, now)
        : retryAfterInstant(response, now);
    if (reset === undefined && rateLimited) {
        options.onWarn?.(`${label}: ${rateLimitDiagnostics(response, body)}`);
    }
    return new LlmError(message, code, {
        status: response.status,
        ...reset === undefined ? {} : { providerRetryAfterMs: waitFromReset(reset, now) },
    });
}
/**
 * Read a Google RPC quota reset from a 429 body.
 *
 * The provider discloses the window in `quotaResetDelay` and
 * `quotaResetTimeStamp` and supplies no rate-limit reader. A wait beyond the
 * route's delay ceiling makes the retry plugin fail the turn immediately
 * rather than spending its local retry budget on a closed window. The
 * relative delay wins: it is measured from this response, so a skewed local
 * clock cannot stretch or erase it the way it would an absolute timestamp.
 * @param body - the complete response body.
 * @param now - the current epoch milliseconds.
 * @returns the reset instant, or undefined when the body does not name one.
 */
function googleQuotaReset(body, now) {
    const delay = /"quotaResetDelay"\s*:\s*"([^"]+)"/.exec(body);
    if (delay !== null) {
        const ms = durationMs(delay[1]);
        if (ms !== undefined && ms > 0)
            return now + ms;
    }
    const stamp = /"quotaResetTimeStamp"\s*:\s*"([^"]+)"/.exec(body);
    if (stamp === null)
        return undefined;
    const instant = Date.parse(stamp[1]);
    return Number.isFinite(instant) && instant > now ? instant : undefined;
}
/**
 * Parse a response's `retry-after` header (seconds) into milliseconds.
 * @param response - the failed response.
 * @returns the delay in ms, or undefined when absent/unusable.
 */
function parseRetryAfterMs(response) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter === null)
        return undefined;
    const seconds = Number(retryAfter);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}
/**
 * Create an idle watchdog chained to the caller's signal.
 * @param caller - the request's own abort signal, when present.
 * @param timeoutMs - maximum idle interval while a stream read is outstanding.
 * @returns the watchdog; always {@link IdleWatchdog.stop} it when the stream ends.
 */
export function idleWatchdog(caller, timeoutMs) {
    const controller = new AbortController();
    let expired = false;
    let timer;
    const arm = () => {
        if (timer !== undefined)
            clearTimeout(timer);
        timer = setTimeout(() => {
            expired = true;
            controller.abort(new Error(`stream idle timeout after ${String(timeoutMs)}ms`));
        }, timeoutMs);
        timer.unref();
    };
    const onCallerAbort = () => controller.abort(caller?.reason);
    if (caller?.aborted === true)
        controller.abort(caller.reason);
    else
        caller?.addEventListener('abort', onCallerAbort, { once: true });
    arm();
    return {
        signal: controller.signal,
        pulse: arm,
        stop() {
            if (timer !== undefined)
                clearTimeout(timer);
            caller?.removeEventListener('abort', onCallerAbort);
        },
        timedOut: () => expired,
    };
}
/**
 * Classify a thrown fetch failure. Caller cancellation maps to ABORTED, idle
 * expiry to TIMEOUT, and everything else (DNS, TLS, refused connection) to
 * TRANSPORT with the cause chained.
 * @param label - diagnostic prefix naming the provider API.
 * @param error - the thrown value.
 * @param watchdog - the request's idle watchdog.
 * @param caller - the request's own abort signal, when present.
 * @returns the classified error.
 */
export function mapFetchFailure(label, error, watchdog, caller) {
    if (watchdog.timedOut())
        return new LlmError(`${label} stream idle timeout`, 'TIMEOUT', { cause: error });
    if (caller?.aborted === true)
        return new LlmError(`${label} request aborted by caller`, 'ABORTED', { cause: error });
    if (error instanceof LlmError)
        return error;
    return new LlmError(`${label} request failed`, 'TRANSPORT', { cause: error });
}
/** OAuth token-endpoint failure carrying the provider's `error` code when it sent one. */
export class OAuthEndpointError extends Error {
    /** HTTP status of the token endpoint response. */
    status;
    /** The provider's OAuth `error` code (e.g. `invalid_grant`), when present. */
    oauthCode;
    /**
     * The endpoint's `retry-after`, in ms, when it sent one. Usage/models
     * endpoints reuse this error type and can rate-limit progressively (each
     * hit within the window extends the next one), so a caller retrying on a
     * fixed schedule instead of honoring this can keep an account locked out
     * indefinitely.
     */
    retryAfterMs;
    constructor(message, status, oauthCode, retryAfterMs) {
        super(message);
        this.name = 'OAuthEndpointError';
        this.status = status;
        this.oauthCode = oauthCode;
        this.retryAfterMs = retryAfterMs;
    }
}
/**
 * Read an OAuth JSON error body into an {@link OAuthEndpointError}. Two body
 * shapes are understood: RFC 6749 (`{ error: "invalid_grant", error_description }`)
 * and the OpenAI API envelope the auth.openai.com token endpoint now answers
 * with (`{ error: { code: "refresh_token_reused", message } }`). The code
 * must land in `oauthCode` either way — the permanent-failure classifiers
 * key on it, and an unrecognized shape would keep a dead login forever.
 * @param response - the failed token-endpoint response.
 * @param label - diagnostic prefix naming the provider.
 * @returns the error to throw.
 */
export async function oauthEndpointError(response, label) {
    let oauthCode;
    let detail = '';
    try {
        const parsed = await response.json();
        if (typeof parsed.error === 'string') {
            oauthCode = parsed.error;
        }
        else if (typeof parsed.error === 'object' && parsed.error !== null) {
            const nested = parsed.error;
            if (typeof nested.code === 'string' && nested.code.length > 0)
                oauthCode = nested.code;
            if (typeof nested.message === 'string')
                detail = nested.message;
        }
        if (typeof parsed.error_description === 'string')
            detail = parsed.error_description;
        if (detail.length === 0)
            detail = oauthCode ?? '';
    }
    catch {
        // Only swallow error-body parsing: the HTTP status still identifies the failure.
    }
    const message = detail.length > 0
        ? `${label} token endpoint error (HTTP ${String(response.status)}): ${detail}`
        : `${label} token endpoint error (HTTP ${String(response.status)})`;
    return new OAuthEndpointError(message, response.status, oauthCode, parseRetryAfterMs(response));
}
/**
 * Per-provider session freshness: loads the stored session, refreshes
 * proactively inside the preempt window or on demand after a 401, and
 * coalesces concurrent refreshes behind one in-flight promise. Permanent
 * refresh failures delete the stored session and surface INVALID_CREDENTIAL
 * with a re-login hint; transient failures fall back to a still-valid token.
 */
export class TokenManager {
    options;
    inflight;
    /** The session whose refresh token the in-flight refresh is spending. */
    attempted;
    constructor(options) {
        this.options = options;
        this.options = options;
    }
    /**
     * Read the stored session without any refresh side effect. Catalog queries
     * (`listModels`) use this to decide whether the provider is logged in.
     * @returns the stored session, or `undefined` when logged out.
     */
    peek() {
        return this.options.load();
    }
    /**
     * Whether a session is currently stored (cheap; never refreshes).
     * @returns true when logged in.
     */
    async hasSession() {
        return (await this.options.load()) !== undefined;
    }
    /**
     * Resolve a usable session, refreshing proactively or on demand.
     * @param forceRefresh - refresh regardless of expiry (used after a 401).
     * @returns the persisted session to send.
     * @throws LlmError MISSING_CREDENTIAL when logged out, INVALID_CREDENTIAL
     *   when the refresh grant is permanently rejected.
     */
    async session(forceRefresh = false) {
        const session = await this.options.load();
        if (session === undefined) {
            throw new LlmError(`dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; `
                + 'log in via Settings → Subscriptions in the dsh web app', 'MISSING_CREDENTIAL');
        }
        if (!forceRefresh && session.expiresAt - Date.now() > this.options.preemptMs) {
            return session;
        }
        this.inflight ??= this.doRefresh(session).finally(() => {
            this.inflight = undefined;
        });
        try {
            return await this.inflight;
        }
        catch (error) {
            if (this.options.isPermanent(error)) {
                // A re-login may have landed while this refresh was failing: its
                // session carries a different refresh token, and deleting it would
                // log out an account that just signed in. Serve it instead.
                const attempted = this.attempted;
                const stored = await this.options.load();
                if (stored !== undefined && attempted !== undefined && stored.refreshToken !== attempted.refreshToken) {
                    return stored;
                }
                await this.options.remove();
                this.options.onRemoved?.();
                throw new LlmError(`${this.options.displayName} login expired or was revoked; log in again via Settings → Subscriptions`, 'INVALID_CREDENTIAL', { cause: error });
            }
            if (!forceRefresh && session.expiresAt > Date.now()) {
                // Transient refresh failure with a still-valid token: use it.
                return session;
            }
            throw error instanceof LlmError
                ? error
                : new LlmError(`${this.options.displayName} token refresh failed`, 'AUTH', { cause: error });
        }
    }
    async doRefresh(session) {
        // A concurrent caller may have refreshed while this one waited: re-read
        // the store and skip the round trip when the stored session is fresh.
        const current = await this.options.load();
        if (current !== undefined
            && current.accessToken !== session.accessToken
            && current.expiresAt - Date.now() > this.options.preemptMs) {
            return current;
        }
        const attempted = current ?? session;
        this.attempted = attempted;
        const next = await this.options.refresh(attempted);
        await this.options.save(next);
        return next;
    }
}
/** Bound on one account catalog fetch or usage poll — a hang must not block the picker. */
export const DISCOVERY_TIMEOUT_MS = 10_000;
/** Cancel one caller's wait without cancelling catalog work shared with other callers. */
export async function withAbortSignal(work, signal) {
    signal?.throwIfAborted();
    if (signal === undefined)
        return work();
    return new Promise((resolve, reject) => {
        const cleanup = () => signal.removeEventListener('abort', abort);
        const abort = () => { cleanup(); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}
/**
 * Run `work` with an aborting signal. Resolves undefined when the timeout
 * fires (the fetch is aborted); other failures propagate.
 */
export function withTimeout(work, timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    const aborted = new Promise(resolve => {
        if (signal.aborted)
            resolve(undefined);
        else
            signal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
    return Promise.race([
        work(signal).then(value => (signal.aborted ? undefined : value), (error) => {
            if (signal.aborted)
                return undefined;
            throw error;
        }),
        aborted,
    ]);
}
/** Display name for a wire reasoning-effort identifier. */
export function effortDisplayName(effort) {
    return effort === 'xhigh' ? 'Extra High' : effort.charAt(0).toUpperCase() + effort.slice(1);
}
/**
 * Fold a configured per-model default effort into a reasoning block, keeping
 * the DSH runtime invariant `defaultEffort ∈ efforts` (the runtime rejects an
 * unknown default with `INVALID_MODEL_REASONING`).
 *
 * A configured level the base set does not advertise is *dropped*, not
 * appended: for claude/grok/copilot the base is the provider's live catalog,
 * i.e. the truth about what the model accepts, so honouring a stale override
 * would put an unsupported effort on every single request instead of letting
 * the harness reject it before provider I/O. The override then simply falls
 * back to the provider's own default until the user picks a level the catalog
 * still lists.
 *
 * `extendable` opts into the opposite rule for a base that is a *built-in
 * fallback* rather than discovered truth (codex, whose static effort list is
 * known to trail the backend): there, appending the configured level is how a
 * newly shipped tier becomes selectable at all.
 * @param configuredDefault - the user-configured default effort id, or undefined.
 * @param base - the discovered/built-in reasoning block, or undefined.
 * @param options - `extendable` marks the base as a fallback that may be extended.
 * @returns the merged block, or undefined when neither side contributes one.
 */
export function mergeReasoning(configuredDefault, base, options) {
    const detached = base === undefined
        ? undefined
        : {
            efforts: [...base.efforts],
            ...(base.defaultEffort === undefined ? {} : { defaultEffort: base.defaultEffort }),
        };
    if (configuredDefault === undefined)
        return detached;
    const effort = ReasoningEffortId(configuredDefault);
    if (base === undefined) {
        // No capability information at all (catalog unavailable, or a model the
        // catalog does not cover). Inventing a reasoning block here would claim a
        // capability nobody advertised; only a fallback-based provider may.
        return options?.extendable === true
            ? { efforts: [{ id: effort, name: effortDisplayName(effort) }], defaultEffort: effort }
            : undefined;
    }
    if (base.efforts.some(entry => entry.id === effort)) {
        return { efforts: [...base.efforts], defaultEffort: effort };
    }
    if (options?.extendable !== true)
        return detached;
    return {
        efforts: [...base.efforts, { id: effort, name: effortDisplayName(effort) }],
        defaultEffort: effort,
    };
}
/**
 * First account catalog that lists `model` (callers pass default-first).
 * One failing lookup sits that account out so a sibling's metadata still
 * resolves — the same isolation as the picker catalog union.
 */
export async function discoverAcrossAccounts(accounts, lookup) {
    for (const account of accounts) {
        try {
            const found = await lookup(account);
            if (found !== undefined)
                return found;
        }
        catch {
            // sit out
        }
    }
    return undefined;
}
/** Skip scheduled refreshes when the last successful catalog is this recent. */
export const DISCOVERY_TTL_MS = 5 * 60_000;
/**
 * Cache for one provider's discovered model catalog. The TTL only decides
 * when to REFRESH; it never makes the cache forget: capability metadata
 * (reasoning efforts) must stay stable for a session that selected an effort,
 * or mid-conversation calls fail UNSUPPORTED_REASONING_EFFORT the moment the
 * cache goes stale. `get` awaits freshness unless its caller opts into
 * cache-only picker/routing reads. The startup/hourly job owns automatic
 * refreshes; `resolveModel` uses {@link resolve}, which serves the last-known
 * catalog and only awaits the fetch when nothing is known yet. An optional {@link CatalogPersistence} seeds the
 * last-known state across restarts and receives every successful fetch. A 401
 * that still fails after a forced token refresh must call {@link invalidate}.
 */
export class ModelCatalogCache {
    persistence;
    ttlMs;
    onChanged;
    entry;
    inflight;
    /** Settles once the persisted snapshot (when any) has been considered. */
    seeded;
    /** Set by {@link invalidate} so an in-flight disk read cannot resurrect dropped state. */
    seedDisabled = false;
    /** Bumped by {@link invalidate} so a loser in-flight fetch cannot write back. */
    generation = 0;
    constructor(persistence, ttlMs = DISCOVERY_TTL_MS, onChanged) {
        this.persistence = persistence;
        this.ttlMs = ttlMs;
        this.onChanged = onChanged;
    }
    /**
     * The cached catalog when fresh, without fetching.
     * @returns the cached models, or `undefined` when absent or stale.
     */
    cached() {
        if (this.entry === undefined || Date.now() - this.entry.at >= this.ttlMs)
            return undefined;
        return this.entry.models;
    }
    /**
     * The last successfully fetched catalog, ignoring TTL. Used to carry
     * capability metadata forward when a later fetch cannot re-enrich.
     * @returns the last-known models, or `undefined` when nothing has been stored.
     */
    lastKnown() {
        return this.entry?.models;
    }
    /** Load the persisted snapshot once; a fetch or invalidate that landed first wins. */
    ensureSeeded() {
        if (this.persistence === undefined)
            return Promise.resolve();
        this.seeded ??= this.persistence.load().then((snapshot) => {
            if (snapshot !== undefined && this.entry === undefined && !this.seedDisabled) {
                this.entry = snapshot;
            }
        }, () => undefined);
        return this.seeded;
    }
    /** Run (or join) the single in-flight fetch, updating memory and disk on success. */
    refresh(fetcher) {
        if (this.inflight !== undefined)
            return this.inflight;
        const gen = this.generation;
        const pending = fetcher()
            .then((models) => {
            if (this.generation !== gen)
                return models;
            const changed = this.entry === undefined || JSON.stringify(this.entry.models) !== JSON.stringify(models);
            const snapshot = { at: Date.now(), models };
            this.entry = snapshot;
            // Write-through is fire-and-forget: a failed save only costs durability.
            void this.persistence?.save(snapshot).catch(() => undefined);
            if (changed)
                this.onChanged?.();
            return models;
        })
            .finally(() => {
            if (this.generation === gen)
                this.inflight = undefined;
        });
        this.inflight = pending;
        return pending;
    }
    /**
     * Return the cached catalog when fresh, otherwise fetch and cache it.
     * @param fetcher - performs the provider's model-list request.
     * @param preferCached - serve saved metadata; the startup/hourly job owns automatic refreshes.
     * @returns the discovered models.
     * @throws the fetcher's failure (the `listModels` caller warns and falls back).
     */
    async get(fetcher, preferCached = false) {
        await this.ensureSeeded();
        const fresh = this.cached();
        if (fresh !== undefined)
            return fresh;
        if (preferCached && this.entry !== undefined) {
            // Menu reads do not increase network frequency. Scheduled and explicit
            // refreshes call get without preferCached and still honor the five-minute TTL.
            return this.entry.models;
        }
        return this.refresh(fetcher);
    }
    /**
     * The models for capability resolution. A fresh cache answers directly; a
     * stale one answers immediately from the last-known catalog. Only the
     * startup/hourly job refreshes known metadata automatically; a cold cache
     * awaits one fetch.
     * @param fetcher - performs the provider's model-list request.
     * @returns the models, or `undefined` when nothing is known (the caller
     *   falls back to its static metadata). Never throws.
     */
    async resolve(fetcher) {
        await this.ensureSeeded();
        const fresh = this.cached();
        if (fresh !== undefined)
            return fresh;
        const known = this.entry?.models;
        if (known !== undefined)
            return known;
        try {
            return await this.refresh(fetcher);
        }
        catch {
            return undefined;
        }
    }
    /** Drop the cached catalog (e.g. after a 401 proved the credential changed). */
    invalidate() {
        this.generation += 1;
        this.entry = undefined;
        this.inflight = undefined;
        this.seedDisabled = true;
        void this.persistence?.clear().catch(() => undefined);
    }
}
/** Whether discovery failed because the stored login is gone. */
export function isMissingOrInvalidCredential(error) {
    return error instanceof LlmError
        && (error.code === 'MISSING_CREDENTIAL' || error.code === 'INVALID_CREDENTIAL');
}
/** Whether discovery stopped because the caller cancelled or the timeout fired. */
export function isDiscoveryAborted(error, signal) {
    if (signal?.aborted === true)
        return true;
    // Only treat abort-shaped errors as cancellation when this call had a signal;
    // a refresh TimeoutError must not fail the whole picker union.
    return signal !== undefined
        && error instanceof Error
        && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
/**
 * Whether discovery failed because the access token was rejected. After
 * {@link discoverOrRetryAuth} this means the token was rejected AGAIN right
 * after a forced refresh: the login is dead server-side (revoked) even though
 * the refresh grant still answers, so the store keeps the session.
 */
export function isDiscoveryAuthFailure(error) {
    return (error instanceof OAuthEndpointError && error.status === 401)
        || (error instanceof LlmError && error.code === 'AUTH');
}
/**
 * Run a catalog fetch, retrying once after a forced token refresh when the
 * first attempt is a 401/AUTH. Only {@link ModelCatalogCache.invalidate}s
 * when the retry is also an auth failure, so a refresh race cannot erase
 * last-known capability metadata.
 */
export async function discoverOrRetryAuth(session, catalog, run) {
    try {
        return await run();
    }
    catch (error) {
        if (isMissingOrInvalidCredential(error) || !isDiscoveryAuthFailure(error))
            throw error;
        try {
            await session(true);
            return await run();
        }
        catch (retryError) {
            if (!isMissingOrInvalidCredential(retryError) && isDiscoveryAuthFailure(retryError)) {
                catalog.invalidate();
            }
            throw retryError;
        }
    }
}
/**
 * Keep Codex's session header stable for a supplied, non-empty session ID.
 * Existing UUIDs are preserved; other IDs use a SHA-256-derived UUIDv8 (a
 * custom deterministic layout). UUID formatting is a client convention,
 * not a claim about gateway validation or guaranteed prompt-cache hits.
 * Missing and empty IDs have no session identity and receive a fresh UUIDv4.
 */
export function deterministicSessionId(sessionId) {
    if (sessionId === undefined || sessionId.length === 0)
        return randomUUID();
    const str = String(sessionId);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str)) {
        return str;
    }
    const bytes = createHash('sha256').update(str).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
