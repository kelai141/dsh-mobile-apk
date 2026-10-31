/**
 * Health bookkeeping for pool members: which `(provider, account, model)`
 * member is cooling down after a failure, and for how long. Purely in-memory
 * — a restart re-probes members naturally, so nothing here is persisted.
 *
 * The failure classifier maps the adapters' stable `LlmError` codes (see
 * `httpLlmError`/`mapFetchFailure` in `common.ts`) to one of three actions:
 * switch to another member with a cooldown, switch without recording a
 * cooldown (transport blips say nothing about the account), or rethrow
 * (the request itself is at fault and another account would fail alike).
 */
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
/** Registry key for one pool member. */
export function memberKey(provider, account, model) {
    return `${provider}/${account}/${model}`;
}
/** Registry key parking EVERY member of one account (account-level failures). */
export function accountKey(provider, account) {
    return `${provider}/${account}/*`;
}
/** Default cooldown when a quota/rate failure carries no `retry-after`. */
export const DEFAULT_QUOTA_COOLDOWN_MS = 5 * 60_000;
/** Auth failures recheck after a day; a re-login clears the record immediately. */
export const AUTH_COOLDOWN_MS = 24 * 60 * 60_000;
/** Transient server-side failures cool down briefly. */
export const TRANSIENT_COOLDOWN_MS = 60_000;
/**
 * Providers whose quota windows are model-scoped, so a quota failure on one
 * model says nothing about its siblings (Claude's Opus/Sonnet lanes;
 * Per-model quotas, whose 429 names the exhausted model and
 * can disclose a reset 35 hours out that must not park its Gemini siblings).
 * Every other provider meters the account as a whole: one member hitting the
 * wall means its siblings on the SAME account would too, so the cooldown
 * parks the account (other accounts of the provider are unaffected).
 */
const MODEL_SCOPED_QUOTA_PROVIDERS = new Set(['claude']);
/** The `retry-after` an adapter propagated through `httpLlmError`, when any. */
function retryAfterMs(error) {
    return error.failure.providerRetryAfterMs;
}
/**
 * Classify a member failure. Quota and rate-limit failures cool down (using
 * the provider's own `retry-after` when sent, which is more accurate than
 * any fixed guess) — account-wide for account-metered providers, per-member
 * for model-scoped ones; auth failures park the account until re-login
 * (credentials are account-level); server/timeout failures get a short
 * per-member cooldown; transport failures switch without a record;
 * everything else — most importantly CONTEXT_WINDOW_EXCEEDED and ABORTED —
 * is the request's own fault and is rethrown untouched.
 * @param error - the failure thrown by a member adapter's stream.
 * @param provider - the failing member's provider (decides the quota scope).
 * @returns the action the pool should take.
 */
export function classifyPoolFailure(error, provider) {
    if (!(error instanceof LlmError))
        return { action: 'throw' };
    switch (error.code) {
        case QUOTA_EXCEEDED_CODE:
        case 'RATE_LIMIT':
            return {
                action: 'switch',
                cooldownMs: retryAfterMs(error) ?? DEFAULT_QUOTA_COOLDOWN_MS,
                reason: error.code,
                scope: MODEL_SCOPED_QUOTA_PROVIDERS.has(provider) ? 'member' : 'account',
            };
        case 'AUTH':
        case 'INVALID_CREDENTIAL':
        case 'MISSING_CREDENTIAL':
            return { action: 'switch', cooldownMs: AUTH_COOLDOWN_MS, reason: error.code, scope: 'account' };
        case 'SERVER':
        case 'TIMEOUT':
        case 'EMPTY_RESPONSE':
            return { action: 'switch', cooldownMs: TRANSIENT_COOLDOWN_MS, reason: error.code, scope: 'member' };
        case 'TRANSPORT':
            return { action: 'switch' };
        case 'HTTP_402':
        case 'HTTP_404':
            // Plan/model availability is account-shaped: another account of the
            // same subscription may still serve. A 400 that is not a context-window
            // error stays HTTP_400 and throws (the request itself is at fault).
            return { action: 'switch', cooldownMs: TRANSIENT_COOLDOWN_MS, reason: error.code, scope: 'member' };
        case CONTEXT_WINDOW_EXCEEDED_CODE:
        case 'ABORTED':
        default:
            return { action: 'throw' };
    }
}
/**
 * Cooldown registry keyed by {@link memberKey}. A member whose cooldown has
 * expired is simply available again — recovery is proven by the next real
 * request, not by a background probe.
 */
export class PoolHealthRegistry {
    records = new Map();
    /** Whether a member may serve: neither it nor its whole account is cooling. */
    isMemberAvailable(provider, account, model, now = Date.now()) {
        return this.isAvailable(accountKey(provider, account), now)
            && this.isAvailable(memberKey(provider, account, model), now);
    }
    /** Whether one registry key is clear right now. */
    isAvailable(key, now = Date.now()) {
        const record = this.records.get(key);
        if (record === undefined)
            return true;
        if (record.unavailableUntil <= now) {
            this.records.delete(key);
            return true;
        }
        return false;
    }
    /** Park a member for `cooldownMs`; a longer existing cooldown wins. */
    markUnavailable(key, cooldownMs, reason, now = Date.now()) {
        const until = now + cooldownMs;
        const existing = this.records.get(key);
        if (existing !== undefined && existing.unavailableUntil > until)
            return;
        this.records.set(key, { unavailableUntil: until, reason });
    }
    /**
     * Epoch ms at which the earliest cooling record among `keys` recovers;
     * `undefined` when none of them is cooling. The registry is shared by
     * every pool, so the caller passes the keys of ITS members (member and
     * account keys alike) — an unrelated pool's cooldown must not shape this
     * pool's retry hint. Feeds the pool-exhausted error's
     * `providerRetryAfterMs`.
     */
    earliestRecovery(keys, now = Date.now()) {
        return this.earliestRecoveryRecord(keys, now)?.unavailableUntil;
    }
    /**
     * The earliest-recovering cooling record among `keys` (with the failure
     * code that parked it), or `undefined` when none of them is cooling. Lets
     * an exhausted pool say WHY its members are parked, instead of assuming a
     * rate limit.
     */
    earliestRecoveryRecord(keys, now = Date.now()) {
        let earliest;
        for (const [key, record] of this.records) {
            if (record.unavailableUntil <= now) {
                this.records.delete(key);
                continue;
            }
            if (!keys.has(key))
                continue;
            if (earliest === undefined || record.unavailableUntil < earliest.unavailableUntil) {
                earliest = { key, unavailableUntil: record.unavailableUntil, reason: record.reason };
            }
        }
        return earliest;
    }
    /** Drop records of one provider, or of a single account when given (auth changes). */
    clear(provider, account) {
        const prefix = account === undefined ? `${provider}/` : `${provider}/${account}/`;
        for (const key of [...this.records.keys()]) {
            if (key.startsWith(prefix))
                this.records.delete(key);
        }
    }
}
