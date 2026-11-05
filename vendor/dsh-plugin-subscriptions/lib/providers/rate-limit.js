/**
 * Rate-limit window handling shared by the subscription adapters.
 *
 * A subscription plan is rate-limit shaped by design — a five-hour session
 * window, a weekly window, and on some plans a per-model weekly one — so a 429
 * is not a dead end: the window reopens at a time the provider discloses. This
 * module turns that disclosure into the `providerRetryAfterMs` the optional
 * `@deepseek-ai/dsh-llm-retry` plugin waits out, and resolves the retry policy
 * whose `maxDelayMs` decides how long a route is allowed to hold the turn.
 *
 * The wait itself is provider-independent: adapters own the policy, the retry
 * plugin executes it. Only the extraction of the reset instant differs, so each
 * adapter contributes one {@link RateLimitResetReader} built from the parsing
 * primitives here.
 *
 * @module dsh-plugin-subscriptions/providers/rate-limit
 */
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
/**
 * Extra time added to every provider-disclosed wait. Absorbs clock skew
 * between the harness and the provider, so a retry does not land a moment
 * before the window actually reopens and burn an attempt on a second 429.
 */
const RESET_GRACE_MS = 2_000;
/** Shortest wait ever scheduled, including for a reset instant already in the past. */
const MIN_WAIT_MS = 1_000;
/** Below this a bare number is a delay in seconds rather than an epoch stamp. */
const EPOCH_SECONDS_FLOOR = 1_000_000_000;
/** At or above this a bare epoch stamp is already in milliseconds. */
const EPOCH_MILLIS_FLOOR = 1_000_000_000_000;
/** Node's maximum timer delay; a longer wait cannot be scheduled at all. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** Default ceiling on a rate-limit wait: six hours covers a five-hour session window with slack. */
export const DEFAULT_RATE_LIMIT_MAX_WAIT_MS = 6 * 60 * 60 * 1_000;
/**
 * Interpret a bare numeric rate-limit value, which providers write in three
 * shapes: epoch milliseconds, epoch seconds, or a delay in seconds. The
 * magnitude separates them unambiguously for any plausible value — an epoch in
 * seconds is ~1.8e9 today, while a delay of even a full week is ~6e5.
 * @param value - the raw numeric value.
 * @param now - the current epoch milliseconds.
 * @returns epoch milliseconds of the reset, or undefined when the value is unusable.
 */
export function resetInstantFromNumber(value, now) {
    if (!Number.isFinite(value) || value <= 0)
        return undefined;
    if (value >= EPOCH_MILLIS_FLOOR)
        return value;
    if (value >= EPOCH_SECONDS_FLOOR)
        return value * 1_000;
    // Provider body fields in this helper's allowlists are contracted as
    // seconds. A provider that sends milliseconds here (for example,
    // `retry_after: 30000`) would be interpreted as 30,000 seconds (~8.3 h),
    // so such a field must be normalized by its provider reader first.
    return now + value * 1_000;
}
/**
 * Parse a Go-style duration (`6m0s`, `1h2m3.5s`, `150ms`) into milliseconds —
 * the form OpenAI-compatible `x-ratelimit-reset-*` headers use.
 * @param text - the raw header value.
 * @returns the duration in milliseconds, or undefined when the text is not one.
 */
export function durationMs(text) {
    const trimmed = text.trim();
    if (trimmed.length === 0)
        return undefined;
    // Sticky: every component must abut the previous one, so trailing or
    // interleaved junk ("6m0s later") fails the length check below.
    const pattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/y;
    const units = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };
    let total = 0;
    let matched = false;
    // A failed sticky exec resets `lastIndex` to zero, so the reached offset is
    // tracked separately rather than read back off the regex after the loop.
    let index = 0;
    // Components run strictly coarse to fine, the only order Go writes them in;
    // a repeated or out-of-order unit ("1s2h", "1s1s") is not a duration and
    // must not be silently summed into one.
    let previousUnit = Number.POSITIVE_INFINITY;
    for (;;) {
        pattern.lastIndex = index;
        const match = pattern.exec(trimmed);
        if (match === null)
            break;
        const unit = units[match[2]];
        if (unit >= previousUnit)
            return undefined;
        previousUnit = unit;
        total += Number(match[1]) * unit;
        index = pattern.lastIndex;
        matched = true;
    }
    if (!matched || index !== trimmed.length)
        return undefined;
    // A zero duration ("0s") is not a disclosed reset — it is a bucket that has
    // already rolled over — and reporting it as one would short-circuit the real
    // signal behind it with a wait of `now`. The numeric path agrees:
    // {@link resetInstantFromNumber} rejects zero too.
    return total > 0 ? total : undefined;
}
/**
 * Interpret any single rate-limit value — a number, a numeric string, a
 * duration (`6m0s`), or a date — as the instant a window reopens. One reader
 * for every shape, so a provider that changes the encoding of a field it
 * already sends does not need a code change here.
 * @param value - the raw header value or JSON field.
 * @param now - the current epoch milliseconds.
 * @returns epoch milliseconds of the reset, or undefined when the value is unusable.
 */
export function resetInstantFromValue(value, now) {
    if (typeof value === 'number')
        return resetInstantFromNumber(value, now);
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0)
        return undefined;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric))
        return resetInstantFromNumber(numeric, now);
    const duration = durationMs(trimmed);
    if (duration !== undefined)
        return now + duration;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
}
/**
 * Read a header carrying any of the {@link resetInstantFromValue} shapes.
 * @param response - the failed response.
 * @param name - the header to read.
 * @param now - the current epoch milliseconds.
 * @returns epoch milliseconds of the reset, or undefined when absent or unusable.
 */
export function resetInstantFromHeader(response, name, now) {
    return resetInstantFromValue(response.headers.get(name), now);
}
/**
 * Read the RFC 7231 `retry-after` header in both its forms: a delay in seconds
 * (never an epoch stamp, whatever its magnitude) or an HTTP-date.
 * @param response - the failed response.
 * @param now - the current epoch milliseconds.
 * @returns epoch milliseconds of the reset, or undefined when absent or unusable.
 */
export function retryAfterInstant(response, now) {
    const raw = response.headers.get('retry-after');
    if (raw === null)
        return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        return undefined;
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds))
        return seconds > 0 ? now + seconds * 1_000 : undefined;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
}
/**
 * Parse a response body as JSON without throwing on the non-JSON bodies
 * providers occasionally return under load (an HTML gateway page, say).
 * @param body - the complete response body.
 * @returns the parsed value, or undefined when the body is not JSON.
 */
export function jsonBody(body) {
    if (body.length === 0)
        return undefined;
    try {
        return JSON.parse(body);
    }
    catch {
        // Only swallow body parsing: header-derived signals still apply.
        return undefined;
    }
}
/** How deep {@link resetFromFields} walks; every observed payload nests one or two levels. */
const MAX_BODY_DEPTH = 4;
/**
 * Find a reset instant under any of the named keys, anywhere in a parsed body.
 *
 * The search is by key rather than by path on purpose: providers move the same
 * field between containers (`detail`, `error`, top level) across endpoints and
 * versions, and a path-shaped reader silently stops working when they do. Only
 * the key list is provider-specific.
 * @param value - the parsed body, or any nested value.
 * @param keys - field names this provider uses for a reset or delay.
 * @param now - the current epoch milliseconds.
 * @param depth - remaining recursion depth.
 * @returns the earliest instant found, or undefined when no key matched.
 */
export function resetFromFields(value, keys, now, depth = MAX_BODY_DEPTH) {
    if (depth <= 0 || value === null || typeof value !== 'object')
        return undefined;
    let earliest;
    const consider = (candidate) => {
        if (candidate !== undefined && (earliest === undefined || candidate < earliest))
            earliest = candidate;
    };
    if (Array.isArray(value)) {
        for (const item of value)
            consider(resetFromFields(item, keys, now, depth - 1));
        return earliest;
    }
    for (const [key, nested] of Object.entries(value)) {
        if (keys.includes(key))
            consider(resetInstantFromValue(nested, now));
        else
            consider(resetFromFields(nested, keys, now, depth - 1));
    }
    return earliest;
}
/**
 * The earliest of several candidate reset instants, ignoring absent ones. The
 * earliest is the one that matters: it is the first moment any of the reported
 * limits allows a request again.
 * @param candidates - reset instants in no particular order.
 * @returns the earliest instant, or undefined when every candidate is absent.
 */
export function earliestReset(...candidates) {
    let earliest;
    for (const candidate of candidates) {
        if (candidate === undefined)
            continue;
        if (earliest === undefined || candidate < earliest)
            earliest = candidate;
    }
    return earliest;
}
/**
 * Turn a reset instant into the wait to report as `providerRetryAfterMs`.
 *
 * Deliberately not capped: a reset beyond the policy's `maxDelayMs` makes the
 * retry plugin delegate immediately, failing the turn at once with the real
 * reset in the message, rather than clamping the wait down and burning the
 * retry budget against a window that is still closed.
 * @param instant - epoch milliseconds the window reopens.
 * @param now - the current epoch milliseconds.
 * @returns the wait in milliseconds, never below {@link MIN_WAIT_MS}.
 */
export function waitFromReset(instant, now) {
    return Math.max(MIN_WAIT_MS, instant - now + RESET_GRACE_MS);
}
/** Header names worth showing when a 429 disclosed no reset this code recognizes. */
const DIAGNOSTIC_HEADER = /rate-?limit|retry|reset|^x-codex-/i;
/**
 * Render the rate-limit-shaped headers and the head of the body of a 429 whose
 * reset instant nothing parsed. Emitted through the adapter's `onWarn`, this is
 * how an unrecognized provider field gets named from live traffic instead of
 * being guessed at.
 *
 * It is also where the per-bucket rollover snapshots land by design — no reader
 * parks a turn on one, because on a 429 they cannot say which bucket refused —
 * so the operator still sees what the provider disclosed.
 * @param response - the failed response.
 * @param body - the complete response body.
 * @returns a one-line diagnostic.
 */
export function rateLimitDiagnostics(response, body) {
    const headers = [];
    response.headers.forEach((value, key) => {
        if (DIAGNOSTIC_HEADER.test(key))
            headers.push(`${key}: ${value}`);
    });
    headers.sort();
    const rendered = headers.length > 0 ? headers.join('; ') : '(none)';
    const head = body.slice(0, 200);
    return `429 disclosed no reset time; headers [${rendered}]; body ${head.length > 0 ? head : '(empty)'}`;
}
/**
 * The retry shape every subscription route starts from: Claude Code's own SDK
 * numbers — ten retries after the first attempt, exponential backoff from 1s
 * doubling per attempt, capped at 60s, plus 20% jitter.
 *
 * Shared across all four routes rather than kept to claude, because what these
 * numbers are tuned for is the shape of a subscription endpoint — a consumer
 * plan behind a session window, which sheds load in bursts and rewards an
 * attempt that outlasts them — and that is the same on all four. The dsh-llm
 * defaults (5 retries from 500ms to 10s) give up after about fifteen seconds,
 * which is short for that.
 *
 * The 60s cap governs local backoff only: a disclosed rate-limit reset is
 * accepted up to the configured wait ceiling instead.
 */
export const DEFAULT_RETRY = Object.freeze({
    maxRetries: 10,
    initialDelayMs: 1_000,
    maxDelayMs: 60_000,
    jitterRatio: 0.2,
});
/** Waiting behavior a route falls back to when the plugin passed none (waiting on, six-hour ceiling). */
export const DEFAULT_RATE_LIMIT_WAIT = Object.freeze({
    wait: true,
    maxWaitMs: DEFAULT_RATE_LIMIT_MAX_WAIT_MS,
});
/**
 * Validate and default the rate-limit waiting config.
 * @param config - the raw plugin config section, when present.
 * @param path - diagnostic path naming the config that owns the value.
 * @returns the resolved, immutable behavior.
 */
export function resolveRateLimitWait(config, path) {
    const wait = config?.wait ?? true;
    const maxWaitMs = config?.maxWaitMs ?? DEFAULT_RATE_LIMIT_MAX_WAIT_MS;
    if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) {
        throw new Error(`${path}.maxWaitMs must be a positive finite number of milliseconds`);
    }
    if (maxWaitMs > MAX_TIMER_DELAY_MS) {
        throw new Error(`${path}.maxWaitMs must be no greater than ${String(MAX_TIMER_DELAY_MS)} (the maximum schedulable delay)`);
    }
    return Object.freeze({ wait, maxWaitMs });
}
/**
 * Resolve one route's retry policy, widening the delay ceiling to the
 * configured wait so a disclosed reset hours out is accepted rather than
 * refused.
 *
 * The ceiling is shared with local exponential backoff, so widening it also
 * raises how long an unrelated transient failure may back off for. That stays
 * bounded by the finite retry budget — the claude route's ten retries reach
 * 512 s per attempt at most — and it only governs when the provider disclosed
 * nothing, which is exactly the case where a longer wait is the safer guess.
 * @param defaults - the route's retry shape.
 * @param rateLimit - resolved waiting behavior.
 * @param path - diagnostic path naming the provider route.
 * @returns the policy to report from `providerRetryPolicy`.
 */
export function subscriptionRetryPolicy(defaults, rateLimit, path) {
    const maxDelayMs = rateLimit.wait
        ? Math.max(defaults.maxDelayMs, rateLimit.maxWaitMs)
        : defaults.maxDelayMs;
    return resolveRetryPolicy({
        mode: 'normal',
        maxRetries: defaults.maxRetries,
        backoff: {
            initialDelayMs: defaults.initialDelayMs,
            maxDelayMs,
            jitterRatio: defaults.jitterRatio,
        },
    }, path);
}
