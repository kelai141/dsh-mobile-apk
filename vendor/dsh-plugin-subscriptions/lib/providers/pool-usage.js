/**
 * Quota tracking for pool members: polls the providers' usage endpoints
 * (the same normalized `ProviderUsage` shape the Settings page consumes) and
 * turns the windows into a scheduling score.
 *
 * The score is a REQUIRED BURN RATE: the fraction of the window that must be
 * consumed per millisecond for the quota to be exactly used up at reset time
 * (`remaining / timeUntilReset`). Subscription quota does not roll over, so a
 * window about to reset with plenty left is the most urgent to spend — the
 * `quota_aware` strategy therefore prefers the highest-urgency member, which
 * over time converges on every window hitting zero right at its reset.
 */
import { isMissingOrInvalidCredential, OAuthEndpointError } from './common.js';
/** A member is taken out of rotation once any window crosses this fill level. */
export const QUOTA_FULL_PERCENT = 95;
/** How long a usage snapshot is trusted before a background refresh. */
export const USAGE_TTL_MS = 5 * 60_000;
/** Assumed window length when the provider discloses no `resetsAt`. */
const FALLBACK_HORIZON_MS = {
    session: 5 * 60 * 60_000,
    weekly: 7 * 24 * 60 * 60_000,
    other: 30 * 24 * 60 * 60_000,
};
/**
 * Per-ACCOUNT usage snapshots with in-flight dedupe and
 * stale-while-revalidate refresh. Providers without a usage endpoint
 * (copilot) resolve no fetcher and score a constant zero urgency — which
 * naturally ranks them behind every measured member. Fetchers are resolved
 * lazily per (provider, account) so accounts added after startup join
 * tracking on their first score.
 */
export class PoolUsageTracker {
    fetcherFor;
    ttlMs;
    entries = new Map();
    inflight = new Map();
    constructor(fetcherFor, ttlMs = USAGE_TTL_MS) {
        this.fetcherFor = fetcherFor;
        this.ttlMs = ttlMs;
    }
    /**
     * The quota view of one member. A cold cache awaits the first fetch; a
     * stale one answers immediately while the refresh serves the NEXT call
     * (member selection must never block on the network mid-conversation). A
     * failure still cooling down degrades immediately with no network call.
     *
     * Deliberately does NOT fall back to `lastSnapshot` the way
     * {@link snapshotFor} does: scoring routing decisions off data that is
     * known to be stale-and-unrefreshable risks steering traffic by a urgency
     * number the endpoint itself is no longer vouching for, whereas
     * `snapshotFor`'s stale-display concern (the Settings page, the composer
     * badge) has no such downside — showing an old percentage beats showing
     * nothing.
     * @param member - the pool member to score (account resolved).
     * @returns availability plus the urgency score.
     */
    async quotaFor(member) {
        const key = `${member.provider}/${member.account}`;
        const fetcher = this.fetcherFor(member.provider, member.account);
        if (fetcher === undefined)
            return { available: true, urgency: 0, fetchedAt: 0 };
        const entry = this.entries.get(key);
        if (entry !== undefined) {
            const fresh = Date.now() - entry.at < (entry.cooldownMs ?? this.ttlMs);
            if (entry.snapshot !== undefined) {
                if (!fresh)
                    void this.refresh(key, fetcher).catch(() => undefined);
                return this.score(member, entry);
            }
            if (fresh)
                return degradedQuota(entry.error);
            // The cooldown expired: fall through to a fresh, blocking attempt.
        }
        try {
            const snapshot = await this.refresh(key, fetcher);
            return this.score(member, { snapshot, at: Date.now() });
        }
        catch (error) {
            return degradedQuota(error);
        }
    }
    /**
     * Same cache as {@link quotaFor}, for direct display (the Settings page):
     * the raw snapshot, or the original fetch error, instead of a routing
     * score.
     * @param provider - the account's provider.
     * @param account - the account key.
     * @param force - bypass a fresh cached SNAPSHOT for an honest re-check (the
     *   manual Refresh button). A live failure cooldown is never bypassed —
     *   retrying through it is exactly what turns a 429 into a permanent
     *   lockout, so even a forced call still answers from the negative cache.
     * @returns `{ supported: false }` when the provider has no usage fetcher.
     */
    async snapshotFor(provider, account, force = false) {
        const fetcher = this.fetcherFor(provider, account);
        if (fetcher === undefined)
            return { supported: false };
        const key = `${provider}/${account}`;
        const entry = this.entries.get(key);
        if (entry !== undefined && Date.now() - entry.at < (entry.cooldownMs ?? this.ttlMs)) {
            if (entry.snapshot !== undefined) {
                if (!force)
                    return entry.snapshot;
            }
            else if (entry.lastSnapshot !== undefined) {
                // A stale-but-real snapshot beats surfacing the cooldown error to
                // every display surface — this is what was previously showing, so
                // keep showing it (even through a forced refresh: retrying past the
                // cooldown is exactly the retry storm `cooldownMs` exists to avoid).
                return entry.lastSnapshot;
            }
            else {
                throw entry.error;
            }
        }
        try {
            return await this.refresh(key, fetcher);
        }
        catch (error) {
            // Same fallback as the already-cooling-down branch above, for the
            // fetch that just failed on THIS call: `refresh` recorded whatever
            // snapshot was on record before it ran onto the new failure entry.
            const failed = this.entries.get(key);
            if (failed?.snapshot === undefined && failed?.lastSnapshot !== undefined)
                return failed.lastSnapshot;
            throw error;
        }
    }
    /** Drop cached snapshots: one account, or a whole provider when `account` is omitted. */
    invalidate(provider, account) {
        if (account !== undefined) {
            this.entries.delete(`${provider}/${account}`);
            return;
        }
        for (const key of [...this.entries.keys()]) {
            if (key.startsWith(`${provider}/`))
                this.entries.delete(key);
        }
    }
    /**
     * Run (or join) the single in-flight fetch for one account key, caching
     * either outcome. A missing/invalid credential is deliberately NOT
     * negative-cached: it costs no network round trip (the session lookup
     * fails before the request goes out) and re-checking live means the
     * member rejoins routing the instant its login is fixed, rather than
     * waiting out a stale cooldown.
     */
    refresh(key, fetcher) {
        let pending = this.inflight.get(key);
        if (pending === undefined) {
            // Captured before the fetch starts: whichever real snapshot is on
            // record right now is what a failure below should fall back to. A
            // failure entry's own `lastSnapshot` counts too — otherwise the stale
            // snapshot would survive exactly one cooldown and vanish on the next
            // consecutive failure, even though nothing newer ever replaced it.
            const prior = this.entries.get(key);
            const lastSnapshot = prior?.snapshot ?? prior?.lastSnapshot;
            pending = fetcher().then((snapshot) => {
                this.entries.set(key, { snapshot, at: Date.now() });
                return snapshot;
            }, (error) => {
                if (!isMissingOrInvalidCredential(error)) {
                    this.entries.set(key, {
                        error,
                        at: Date.now(),
                        cooldownMs: cooldownFor(error, this.ttlMs),
                        ...lastSnapshot === undefined ? {} : { lastSnapshot },
                    });
                }
                throw error;
            }).finally(() => {
                this.inflight.delete(key);
            });
            this.inflight.set(key, pending);
        }
        return pending;
    }
    /** Score one member against a snapshot's windows. */
    score(member, entry) {
        const windows = (entry.snapshot.windows ?? []).filter(window => windowApplies(window, member.model));
        let available = true;
        let urgency = 0;
        for (const window of windows) {
            if (window.usedPercent >= QUOTA_FULL_PERCENT)
                available = false;
            urgency = Math.max(urgency, windowUrgency(window));
        }
        return { available, urgency, fetchedAt: entry.at };
    }
}
/**
 * The routing view of a fetch failure. Logged out: the member cannot serve
 * at all. Any other failure (network, endpoint rate limit) must not block
 * routing — the member stays available with a zero score, degrading the
 * strategy to plain priority order for it.
 */
function degradedQuota(error) {
    return isMissingOrInvalidCredential(error)
        ? { available: false, urgency: 0, fetchedAt: 0 }
        : { available: true, urgency: 0, fetchedAt: 0 };
}
/** How long to hold a failure in the negative cache: the endpoint's own `retry-after`, or the default TTL. */
function cooldownFor(error, defaultTtlMs) {
    return error instanceof OAuthEndpointError && error.retryAfterMs !== undefined ? error.retryAfterMs : defaultTtlMs;
}
/**
 * Whether a window constrains this model: unscoped windows always do; a
 * model-scoped window (Claude's Opus/Sonnet lanes) applies when its scope
 * names the model family.
 */
function windowApplies(window, model) {
    if (window.scope === undefined)
        return true;
    return model.toLowerCase().includes(window.scope.toLowerCase());
}
/** The required burn rate of one window (fraction per ms). */
function windowUrgency(window, now = Date.now()) {
    const remaining = Math.max(0, 1 - window.usedPercent / 100);
    const horizon = window.resetsAt !== undefined
        ? Math.max(window.resetsAt - now, 1)
        : FALLBACK_HORIZON_MS[window.kind];
    return remaining / horizon;
}
