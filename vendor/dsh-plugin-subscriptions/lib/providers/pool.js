/**
 * The pool adapter: same-subscription account routing, plus optional
 * configured tier extras. The picker is the union of every account's
 * catalog. A model listed by several accounts failovers; a model listed by
 * one account is pinned to it. Tiers are extra picker rows. Member
 * selection is sticky per session (so prompt caches survive) and optionally
 * quota-aware; failures fail over to the next member as long as no stream
 * content chunk has been emitted (leading usage remains buffered).
 */
import { EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, } from '@deepseek-ai/dsh-llm';
import { poolKey } from './pool-family.js';
import { accountKey, classifyPoolFailure, memberKey, PoolHealthRegistry } from './pool-health.js';
import { withAbortSignal } from './common.js';
import { streamAccountWithReplay } from './replay.js';
/** Bound on sticky-session memory; oldest entries evict past it. */
const STICKY_SESSION_LIMIT = 1000;
/** Display form of one member (account shown when pinned). */
function memberLabel(member) {
    return member.account === undefined
        ? `${member.provider}/${member.model}`
        : `${member.provider}/${member.account}/${member.model}`;
}
/** How long a pools snapshot is trusted (auth changes invalidate immediately). */
const POOLS_CACHE_TTL_MS = 5_000;
export class PoolAdapter extends LlmAdapter {
    options;
    /** sessionId|poolId → member key of the last member that served a chunk. */
    sticky = new Map();
    /** Messages already warned about — configuration diagnostics repeat every request otherwise. */
    warned = new Set();
    /**
     * Short-lived pools snapshot. `owns()` runs on every resolveModel — the
     * model picker issues one per entry — and pool assembly touches every
     * provider's catalog and account store, so recompute at most this often.
     * Auth changes bump {@link generation} so a stale snapshot cannot land.
     */
    poolsCache;
    poolsInflight;
    generation = 0;
    constructor(options) {
        super();
        this.options = options;
    }
    /** Drop the pools snapshot so the next read reflects the current accounts. */
    invalidate() {
        this.generation += 1;
        this.poolsCache = undefined;
        this.poolsInflight = undefined;
    }
    /** Warn once per distinct message (pools() runs on every request). */
    warnOnce(message) {
        if (this.warned.has(message))
            return;
        this.warned.add(message);
        this.options.onWarn(message);
    }
    /** Drop members whose adapter is not registered (copy — caller state is shared). */
    usable(pools) {
        const result = new Map(pools);
        for (const [id, definition] of [...result]) {
            const kept = definition.members.filter(member => this.options.adapters[member.provider] !== undefined);
            if (kept.length === 0)
                result.delete(id);
            else if (kept.length < definition.members.length)
                result.set(id, { ...definition, members: kept });
        }
        return result;
    }
    /** Account pools (auto-aggregated plus config overrides) with usable members. */
    async familyPools() {
        return this.usable(new Map(await this.options.families()));
    }
    /** All pools (account pools merged with extra tiers) with usable members. */
    async pools() {
        const cached = this.poolsCache;
        if (cached !== undefined && Date.now() - cached.at < POOLS_CACHE_TTL_MS)
            return cached.pools;
        const gen = this.generation;
        this.poolsInflight ??= this.assemblePools()
            .then((pools) => {
            if (this.generation === gen)
                this.poolsCache = { at: Date.now(), pools };
            return pools;
        })
            .finally(() => {
            this.poolsInflight = undefined;
        });
        return this.poolsInflight;
    }
    /** Recompute the pools snapshot (account pools merged with extra tiers). */
    async assemblePools() {
        const pools = await this.familyPools();
        for (const [id, members] of Object.entries(this.options.tiers)) {
            if (members.length === 0)
                continue;
            const owner = members[0].provider;
            const key = poolKey(owner, id);
            if (pools.has(key))
                this.warnOnce(`tier pool "${id}" overrides the account pool of the same id under ${owner}`);
            pools.set(key, { members, extra: true });
        }
        return this.usable(pools);
    }
    /**
     * Extra picker rows one provider lists (configured tiers). Account pools
     * reuse the catalog entry of the same wire id, so they are not listed
     * again — the picker stays one row per model in ChatGPT / Claude / ….
     */
    async modelsForProvider(provider) {
        const pools = await this.pools();
        const models = [];
        for (const [key, definition] of pools) {
            if (definition.extra !== true)
                continue;
            if (!key.startsWith(`${provider}/`))
                continue;
            const id = key.slice(provider.length + 1);
            models.push({
                provider,
                id,
                name: definition.name ?? id,
                ...definition.description === undefined ? {} : { description: definition.description },
            });
        }
        return models;
    }
    /**
     * Whether `model` on `provider`'s route is served here (several accounts
     * fail over, one account is pinned, or a configured tier).
     */
    async owns(provider, model) {
        return (await this.pools()).has(poolKey(provider, model));
    }
    /**
     * Resolve every member's account (config members may omit it to mean "the
     * default account") and drop members with no resolvable login. Duplicates
     * collapse — an explicitly pinned account and the default may coincide.
     */
    async concrete(members) {
        const seen = new Set();
        const resolved = [];
        for (const member of members) {
            const requested = member.account ?? await this.options.defaultAccount(member.provider);
            if (requested === undefined)
                continue;
            const account = await (this.options.resolveAccount?.(member.provider, requested) ?? Promise.resolve(requested));
            const key = memberKey(member.provider, account, member.model);
            if (seen.has(key))
                continue;
            seen.add(key);
            resolved.push({ provider: member.provider, account, model: member.model });
        }
        return resolved;
    }
    /**
     * Resolve a pool model to the conservative INTERSECTION of its members'
     * capabilities: the smallest context window and output cap, the reasoning
     * efforts every member supports, and the modalities all of them accept —
     * so a request valid for the pool stays valid after a failover. Capability
     * metadata is account-specific, so every distinct member is resolved.
     */
    async resolveModel(provider, model, signal) {
        return (await this.prepareCall(provider, model, signal)).model;
    }
    async prepareCall(provider, model, signal) {
        const definition = (await withAbortSignal(() => this.pools(), signal)).get(poolKey(provider, model));
        if (definition === undefined)
            throw new LlmError(`unknown pool model "${model}"`, 'NO_ADAPTER');
        const resolved = [];
        let lastFailure;
        const members = await withAbortSignal(() => this.concrete(definition.members), signal);
        const eligible = [];
        for (const member of members) {
            const adapter = this.options.adapters[member.provider];
            if (adapter === undefined)
                continue;
            // Tolerate per-member failures (a misconfigured tier member, a
            // logged-out provider throwing AUTH): the pool serves as long as ONE
            // member resolves, mirroring stream()'s failover semantics.
            try {
                resolved.push(await withAbortSignal(() => adapter.resolveOwnModel(member.provider, member.model, member.account), signal));
                eligible.push(member);
            }
            catch (error) {
                signal?.throwIfAborted();
                lastFailure = error;
                this.warnOnce(`pool "${model}": member ${memberLabel(member)} failed to resolve`
                    + ` (${error instanceof Error ? error.message : String(error)}); excluding it`);
            }
        }
        if (resolved.length === 0) {
            throw new LlmError(`pool "${model}" has no usable member`, 'NO_ADAPTER', {
                ...lastFailure === undefined ? {} : { cause: lastFailure },
            });
        }
        const contextWindows = resolved.map(info => info.context?.contextWindow).filter(isNumber);
        const maxTokens = resolved.map(info => info.defaultMaxTokens).filter(isNumber);
        const reasoning = intersectReasoning(resolved);
        const modalities = intersectModalities(resolved);
        const info = {
            provider,
            id: model,
            name: definition.name ?? model,
            ...definition.description === undefined ? {} : { description: definition.description },
            ...contextWindows.length > 0 ? { context: { contextWindow: Math.min(...contextWindows) } } : {},
            ...maxTokens.length > 0 ? { defaultMaxTokens: Math.min(...maxTokens) } : {},
            ...reasoning === undefined ? {} : { reasoning },
            ...modalities === undefined ? {} : { inputModalities: modalities },
        };
        return { model: info, stream: options => this.streamMembers(options, eligible) };
    }
    async *stream(options) {
        const definition = (await withAbortSignal(() => this.pools(), options.signal)).get(poolKey(options.provider, options.model));
        if (definition === undefined)
            throw new LlmError(`unknown pool model "${options.model}"`, 'NO_ADAPTER');
        const members = await withAbortSignal(() => this.concrete(definition.members), options.signal);
        yield* this.streamMembers(options, members);
    }
    async *streamMembers(options, members) {
        const candidates = await withAbortSignal(() => this.select(options.model, members, options.sessionId), options.signal);
        if (candidates.length === 0)
            throw this.exhausted(options.model, members);
        let lastFailure;
        let tried = 0;
        for (const member of candidates) {
            options.signal?.throwIfAborted();
            const adapter = this.options.adapters[member.provider];
            if (adapter === undefined)
                continue;
            tried += 1;
            const iterator = streamAccountWithReplay(adapter, { ...options, provider: member.provider }, member.account, member.model)[Symbol.asyncIterator]();
            let first;
            const leadingUsage = [];
            try {
                first = await iterator.next();
                // Usage is metadata, not delivered model content. Empty completions
                // commonly send usage before their terminal failure.
                while (!first.done && first.value.type === 'usage') {
                    leadingUsage.push(first.value);
                    first = await iterator.next();
                }
                if (first.done === true) {
                    throw new LlmError(`${memberLabel(member)} returned an empty stream`, EMPTY_RESPONSE_CODE);
                }
                if (first.value.type === 'finish' && first.value.reason.kind === 'error') {
                    const failure = first.value.reason.failure;
                    throw new LlmError(failure.message, failure.code, failure);
                }
            }
            catch (error) {
                try {
                    await iterator.return?.();
                }
                catch { /* preserve the attempt failure */ }
                options.signal?.throwIfAborted();
                const classification = classifyPoolFailure(error, member.provider);
                if (classification.action === 'throw')
                    throw error;
                if ('cooldownMs' in classification) {
                    this.options.health.markUnavailable(classification.scope === 'account'
                        ? accountKey(member.provider, member.account)
                        : memberKey(member.provider, member.account, member.model), classification.cooldownMs, classification.reason);
                    // A quota failure invalidates the cached usage snapshot so the NEXT
                    // selection re-polls instead of trusting minutes-old percentages.
                    // Transient/auth failures say nothing about quota — keep the cache.
                    if (classification.reason === QUOTA_EXCEEDED_CODE || classification.reason === 'RATE_LIMIT') {
                        this.options.usage.invalidate(member.provider, member.account);
                    }
                }
                this.options.onWarn(`pool "${options.model}": ${memberLabel(member)} failed before any output`
                    + ` (${describeFailure(error)}); trying the next member`);
                lastFailure = { member, error };
                continue;
            }
            this.remember(options.model, options.sessionId, member);
            // Past the first content chunk there is no clean attempt boundary: whatever
            // the member does next (including failing) reaches the caller as-is.
            // The finally closes the member stream when the CALLER walks away
            // early (break / .return()) — manual iteration does not propagate
            // closure the way `yield*` would, and a half-consumed member stream
            // must not linger holding its connection.
            try {
                yield* leadingUsage;
                yield first.value;
                for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
                    yield next.value;
                }
            }
            finally {
                try {
                    await iterator.return?.();
                }
                catch {
                    // Closing a half-consumed member stream must not mask the outcome.
                }
            }
            return;
        }
        throw this.exhausted(options.model, members, lastFailure, tried);
    }
    /**
     * Order the candidates for one request. Health filters both strategies;
     * `quota_aware` then ranks by urgency (members without telemetry, e.g.
     * copilot, score zero and sink to the bottom of their class), while
     * quota-exhausted members stay as a last-resort tail in pool order. The
     * sticky member keeps its lead unless a challenger out-scores it by
     * `switchMargin`.
     */
    async select(poolId, members, sessionId) {
        const usable = members.filter(member => this.options.adapters[member.provider] !== undefined
            && this.options.health.isMemberAvailable(member.provider, member.account, member.model));
        if (usable.length === 0)
            return [];
        const stickyMember = sessionId === undefined
            ? undefined
            : usable.find(member => memberKey(member.provider, member.account, member.model) === this.sticky.get(stickyKey(poolId, sessionId)));
        if (this.options.strategy === 'priority') {
            return stickyMember === undefined
                ? usable
                : [stickyMember, ...usable.filter(member => member !== stickyMember)];
        }
        const quotas = new Map(await Promise.all(usable.map(async (member) => [member, await this.options.usage.quotaFor(member)])));
        const scored = usable.filter(member => quotas.get(member)?.available === true);
        const quotaFull = usable.filter(member => quotas.get(member)?.available === false);
        scored.sort((a, b) => (quotas.get(b)?.urgency ?? 0) - (quotas.get(a)?.urgency ?? 0));
        if (stickyMember !== undefined && scored.includes(stickyMember)) {
            const best = scored[0];
            const stickyUrgency = quotas.get(stickyMember)?.urgency ?? 0;
            const bestUrgency = quotas.get(best)?.urgency ?? 0;
            if (best === stickyMember || bestUrgency <= stickyUrgency * this.options.switchMargin) {
                // Sticky holds (no challenger beats it by the margin): lead with it.
                scored.splice(scored.indexOf(stickyMember), 1);
                scored.unshift(stickyMember);
            }
        }
        return [...scored, ...quotaFull];
    }
    /** Pin the serving member to the session (with bounded memory). */
    remember(poolId, sessionId, member) {
        if (sessionId === undefined)
            return;
        const key = stickyKey(poolId, sessionId);
        this.sticky.delete(key);
        if (this.sticky.size >= STICKY_SESSION_LIMIT) {
            const oldest = this.sticky.keys().next();
            if (oldest.done !== true)
                this.sticky.delete(oldest.value);
        }
        this.sticky.set(key, memberKey(member.provider, member.account, member.model));
    }
    /**
     * The error for an exhausted pool. It says WHY (issue #139): the last
     * member failure of this request when members were tried, or the cooling
     * record that kept every member out of the candidate set — and its `code`
     * is that failure's own code, never a synthetic `RATE_LIMIT` (a transport
     * blip on a single-member pool used to be reported as a rate limit). The
     * earliest recovery hint is scoped to THIS pool's members (the health
     * registry is shared across pools).
     */
    exhausted(model, pool, last, tried = 0) {
        const keys = new Set();
        for (const member of pool) {
            keys.add(memberKey(member.provider, member.account, member.model));
            keys.add(accountKey(member.provider, member.account));
        }
        const now = Date.now();
        const cooling = this.options.health.earliestRecoveryRecord(keys, now);
        const retryAfterMs = cooling === undefined ? undefined : Math.max(cooling.unavailableUntil - now, 1);
        const recovers = retryAfterMs === undefined ? '' : ` recovers in ${formatDuration(retryAfterMs)}`;
        let message;
        let code;
        if (last !== undefined) {
            const { member, error } = last;
            code = error instanceof LlmError ? error.code : 'TRANSPORT';
            message = `pool "${model}" exhausted: ${tried} of ${pool.length} member(s) failed;`
                + ` last ${memberLabel(member)} (${describeFailure(error)})`
                + (cooling === undefined ? '' : `; earliest member${recovers}`);
        }
        else if (cooling !== undefined) {
            code = cooling.reason;
            message = `pool "${model}" exhausted: every member is cooling down;`
                + ` ${cooling.key} (${cooling.reason})${recovers}`;
        }
        else {
            code = 'NO_ADAPTER';
            message = `pool "${model}" exhausted: no usable member`;
        }
        const failure = last?.error instanceof LlmError ? last.error.failure : undefined;
        this.options.onWarn(message);
        return new LlmError(message, code, {
            ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
            ...failure?.status === undefined ? {} : { status: failure.status },
            ...failure?.requestId === undefined ? {} : { requestId: failure.requestId },
            ...last === undefined ? {} : { cause: last.error },
        });
    }
}
/** `CODE: message` for an LlmError, the message alone otherwise. */
function describeFailure(error) {
    if (error instanceof LlmError)
        return `${error.code}: ${error.message}`;
    return error instanceof Error ? error.message : String(error);
}
/** Compact human duration (`42s`, `4m12s`, `35h00m`). */
function formatDuration(ms) {
    const total = Math.max(1, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0)
        return `${hours}h${String(minutes).padStart(2, '0')}m`;
    if (minutes > 0)
        return `${minutes}m${String(seconds).padStart(2, '0')}s`;
    return `${seconds}s`;
}
function stickyKey(poolId, sessionId) {
    return `${String(sessionId)}|${poolId}`;
}
function isNumber(value) {
    return value !== undefined;
}
/** Reasoning efforts every member supports (id intersection, first member's order). */
function intersectReasoning(resolved) {
    const [first, ...rest] = resolved;
    if (first?.reasoning === undefined)
        return undefined;
    const efforts = first.reasoning.efforts.filter(effort => rest.every(info => info.reasoning?.efforts.some(other => other.id === effort.id) === true));
    if (efforts.length === 0)
        return undefined;
    const defaultEffort = first.reasoning.defaultEffort !== undefined
        && efforts.some(effort => effort.id === first.reasoning?.defaultEffort)
        ? first.reasoning.defaultEffort
        : undefined;
    return { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } };
}
/** Modalities all members accept; undefined when any member leaves it unknown. */
function intersectModalities(resolved) {
    const [first, ...rest] = resolved;
    if (first?.inputModalities === undefined)
        return undefined;
    const modalities = first.inputModalities.filter(modality => rest.every(info => info.inputModalities?.includes(modality) === true));
    // An empty intersection would declare negative capability ("accepts
    // nothing"); report unknown instead — the serving member enforces its own
    // limits at request time.
    return modalities.length === 0 ? undefined : modalities;
}
