/** Account scheduling shared by image generation and editing, independent of chat catalogs/quota. */
import { LlmError } from '@deepseek-ai/dsh-llm';
import { httpLlmError } from './common.js';
import { AUTH_COOLDOWN_MS, DEFAULT_QUOTA_COOLDOWN_MS, TRANSIENT_COOLDOWN_MS, PoolHealthRegistry, memberKey } from './pool-health.js';
export class ImageAccountPool {
    options;
    // Deliberately separate from chat health: image quotas/entitlements need not match chat.
    health = new PoolHealthRegistry();
    sticky = new WeakMap();
    constructor(options = {}) {
        this.options = options;
    }
    /** Login/logout clears cooling image members and stale session affinity. */
    clear(provider, account) {
        this.health.clear(provider, account);
        this.sticky = new WeakMap();
    }
    async request(request) {
        const { provider, tokens, signal, owner, send, rateLimitReset } = request;
        signal.throwIfAborted();
        const accounts = await tokens.list();
        if (accounts.length === 0) {
            await tokens.session(); // standard provider-specific login hint
            throw new LlmError('image_generate: no image account is logged in', 'MISSING_CREDENTIAL');
        }
        const pooling = this.options.enabled !== false;
        const members = (pooling ? accounts : accounts.slice(0, 1)).map(entry => entry.key);
        const sticky = pooling && owner !== undefined ? this.sticky.get(owner)?.get(provider) : undefined;
        const ordered = sticky !== undefined && members.includes(sticky)
            ? [sticky, ...members.filter(key => key !== sticky)] : members;
        let lastError;
        for (const account of ordered) {
            signal.throwIfAborted();
            const key = memberKey(provider, account, 'images');
            if (pooling && !this.health.isAvailable(key))
                continue;
            let failure;
            try {
                let session = await tokens.session(account);
                signal.throwIfAborted();
                let response = await send(session);
                // Only a definitive unauthorized rejection permits retrying this account.
                if (response.status === 401) {
                    await response.body?.cancel();
                    session = await tokens.session(account, true);
                    signal.throwIfAborted();
                    response = await send(session);
                }
                signal.throwIfAborted();
                if (response.ok) {
                    if (pooling && owner !== undefined) {
                        let affinity = this.sticky.get(owner);
                        if (affinity === undefined) {
                            affinity = new Map();
                            this.sticky.set(owner, affinity);
                        }
                        affinity.set(provider, account);
                    }
                    return response;
                }
                // Images can be produced despite timeouts/server failures. Switch only on
                // explicit auth/quota/entitlement rejection, never ambiguous transport/5xx.
                failure = await httpLlmError(response, 'image_generate', { rateLimitReset });
                if (![401, 402, 403, 404, 429].includes(response.status))
                    throw failure;
            }
            catch (error) {
                signal.throwIfAborted();
                if (!(error instanceof LlmError) || !['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'RATE_LIMIT', 'HTTP_402', 'HTTP_404'].includes(error.code))
                    throw error;
                failure = error;
            }
            if (!pooling)
                throw failure;
            const delay = failure.failure.providerRetryAfterMs ?? (failure.code === 'RATE_LIMIT'
                ? DEFAULT_QUOTA_COOLDOWN_MS
                : ['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL'].includes(failure.code) ? AUTH_COOLDOWN_MS : TRANSIENT_COOLDOWN_MS);
            this.health.markUnavailable(key, delay, failure.code);
            this.options.onWarn?.(`image pool ${provider}: account ${members.indexOf(account) + 1}/${members.length} rejected (${failure.code}); checking remaining accounts`);
            lastError = failure;
        }
        if (lastError !== undefined)
            throw lastError;
        const recovery = this.health.earliestRecovery(new Set(members.map(account => memberKey(provider, account, 'images'))));
        throw new LlmError(`image_generate: all ${provider} image accounts are cooling down`, 'RATE_LIMIT', {
            ...recovery === undefined ? {} : { providerRetryAfterMs: Math.max(0, recovery - Date.now()) },
        });
    }
}
