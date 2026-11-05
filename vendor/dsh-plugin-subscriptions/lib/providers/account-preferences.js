import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { DISCOVERY_TIMEOUT_MS, withAbortSignal, withTimeout } from './common.js';
import { streamAccountWithReplay } from './replay.js';
/** Reserved namespace, recognized even when malformed or no longer enabled. */
export const ACCOUNT_MODEL_PREFIX = '~account:';
export function accountModelId(account, model) {
    return `${ACCOUNT_MODEL_PREFIX}${encodeURIComponent(account)}:${encodeURIComponent(model)}`;
}
export function parseAccountModelId(id) {
    if (!id.startsWith(ACCOUNT_MODEL_PREFIX))
        return undefined;
    const parts = id.slice(ACCOUNT_MODEL_PREFIX.length).split(':');
    try {
        if (parts.length !== 2)
            throw new Error();
        const account = decodeURIComponent(parts[0]);
        const model = decodeURIComponent(parts[1]);
        if (!account || !model || accountModelId(account, model) !== id)
            throw new Error();
        return { account, model };
    }
    catch {
        throw new LlmError('Invalid independent account model id', 'NO_ADAPTER');
    }
}
export function accountAllowsPool(preferences, model) {
    return preferences?.poolEnabled !== false && (preferences?.poolModels?.includes(model) ?? true);
}
/** Keeps the registered route separate from raw adapters and pool member seams. */
export class AccountPreferencesAdapter extends LlmAdapter {
    options;
    constructor(options) {
        super();
        this.options = options;
    }
    providerInfo(provider) {
        const info = this.options.adapter.providerInfo(provider);
        // Native model groups read provider metadata, separately from model names.
        return { ...info, name: this.options.settings.get(this.options.provider).displayName ?? info.name };
    }
    providerRetryPolicy(provider) { return this.options.adapter.providerRetryPolicy(provider); }
    preference(account) {
        const accounts = this.options.settings.get(this.options.provider).accounts;
        return accounts && Object.hasOwn(accounts, account) ? accounts[account] : undefined;
    }
    async models(account, signal) {
        const models = await withAbortSignal(() => withTimeout(signal => this.options.adapter.listOwnModels(this.options.provider, account, signal, true), this.options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS), signal);
        if (models !== undefined)
            return models;
        // Discovery timed out: the catalog this account listed last time beats
        // "no models", which would fail the turn with "No eligible account".
        return await withAbortSignal(async () => this.options.adapter.lastKnownOwnModels?.(this.options.provider, account), signal) ?? [];
    }
    async requireAccount(account, model, independent, signal) {
        if (!(await withAbortSignal(this.options.accounts, signal)).some(entry => entry.key === account)
            || (independent ? this.preference(account)?.independentEntry !== true : !accountAllowsPool(this.preference(account), model))
            || !(await this.models(account, signal)).some(entry => entry.id === model)) {
            throw new LlmError(`Account route unavailable: ${this.options.provider}/${account}/${model}`, 'NO_ADAPTER');
        }
    }
    async fallback(model, signal) {
        for (const { key } of await withAbortSignal(this.options.accounts, signal)) {
            if (!accountAllowsPool(this.preference(key), model))
                continue;
            try {
                await this.requireAccount(key, model, false, signal);
                return key;
            }
            catch {
                signal?.throwIfAborted();
            }
        }
        throw new LlmError(`No eligible account for ${this.options.provider}/${model}`, 'NO_ADAPTER');
    }
    /** Pool-only facade: explicit families/tiers must obey the same policy as auto pools. */
    poolMember() {
        const raw = this.options.adapter;
        const keyFor = async (account, model, signal) => {
            if (model.startsWith(ACCOUNT_MODEL_PREFIX))
                throw new LlmError('Independent entries cannot be pool members', 'NO_ADAPTER');
            const key = account ?? (await withAbortSignal(this.options.accounts, signal))[0]?.key;
            if (!key)
                throw new LlmError('No account available', 'NO_ADAPTER');
            await this.requireAccount(key, model, false, signal);
            return key;
        };
        return new Proxy(raw, { get: (target, property) => {
                if (property === 'streamAccount')
                    return async function* (options, account) {
                        let key;
                        try {
                            key = await keyFor(account, options.model, options.signal);
                        }
                        catch (cause) {
                            options.signal?.throwIfAborted();
                            // Skip policy-excluded members without poisoning account health. The
                            // pool treats TRANSPORT as switch-without-cooldown; raw is never called.
                            throw new LlmError('Pool member unavailable under account preferences', 'TRANSPORT', { cause });
                        }
                        yield* raw.streamAccount(options, key);
                    };
                if (property === 'resolveOwnModel')
                    return async (provider, model, account) => raw.resolveOwnModel(provider, model, await keyFor(account, model));
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
            } });
    }
    async listModels(provider) {
        const result = new Map();
        const catalogs = await Promise.all((await this.options.accounts()).map(async (account) => ({ ...account, models: await this.models(account.key).catch(() => []) })));
        for (const { key, label, models } of catalogs) {
            const preferences = this.preference(key);
            for (const model of models) {
                if (model.id.startsWith(ACCOUNT_MODEL_PREFIX))
                    continue;
                if (accountAllowsPool(preferences, model.id) && this.options.settings.visible(this.options.provider, model.id) && !result.has(model.id))
                    result.set(model.id, model);
                if (preferences?.independentEntry === true && this.options.settings.visible(this.options.provider, model.id)) {
                    const id = accountModelId(key, model.id);
                    result.set(id, { ...model, id, name: `${preferences.alias || label} · ${this.options.settings.modelName(this.options.provider, model.id, model.name)}` });
                }
            }
        }
        for (const model of await this.options.pool()?.modelsForProvider(this.options.provider) ?? []) {
            if (model.id.startsWith(ACCOUNT_MODEL_PREFIX) || !this.options.settings.visible(this.options.provider, model.id))
                continue;
            try {
                await this.options.pool().resolveModel(provider, model.id);
                result.set(model.id, model);
            }
            catch { /* excluded tier */ }
        }
        const priority = (model) => model.priority ?? Number.MAX_SAFE_INTEGER;
        return [...result.values()].map(model => ({ ...model,
            name: this.options.settings.modelName(this.options.provider, model.id, model.name),
        })).sort((left, right) => priority(left) - priority(right));
    }
    async resolveModel(provider, id, signal) {
        return (await this.prepareCall(provider, id, signal)).model;
    }
    async prepareCall(provider, id, signal) {
        signal?.throwIfAborted();
        const independent = parseAccountModelId(id);
        const pool = this.options.pool();
        if (!independent && pool && await withAbortSignal(() => pool.owns(this.options.provider, id), signal)) {
            const prepared = await pool.prepareCall(provider, id, signal);
            return { ...prepared, model: this.present(id, prepared.model) };
        }
        const account = independent?.account ?? await this.fallback(id, signal);
        const model = independent?.model ?? id;
        if (independent)
            await this.requireAccount(account, model, true, signal);
        const info = await withAbortSignal(() => this.options.adapter.resolveOwnModel(provider, model, account), signal);
        const label = independent ? (await withAbortSignal(this.options.accounts, signal)).find(entry => entry.key === account)?.label ?? account : undefined;
        const owner = this;
        const named = this.present(model, info);
        return {
            model: independent ? { ...named, id, name: `${this.preference(account)?.alias || label} · ${named.name}` } : named,
            async *stream(options) {
                // Keep the capability-bearing account; revoked permission must fail instead of rerouting.
                await owner.requireAccount(account, model, independent !== undefined, options.signal);
                options.signal?.throwIfAborted();
                yield* streamAccountWithReplay(owner.options.adapter, options, account, model);
            },
        };
    }
    /** Presentation only: routing still uses the original model id. */
    present(id, info) {
        return { ...info, name: this.options.settings.modelName(this.options.provider, id, info.name) };
    }
    async *stream(options) {
        const independent = parseAccountModelId(options.model);
        if (independent) {
            await this.requireAccount(independent.account, independent.model, true, options.signal);
            options.signal?.throwIfAborted();
            yield* streamAccountWithReplay(this.options.adapter, options, independent.account, independent.model);
            return;
        }
        const pool = this.options.pool();
        if (pool && await withAbortSignal(() => pool.owns(this.options.provider, options.model), options.signal)) {
            yield* pool.stream(options);
            return;
        }
        const account = await this.fallback(options.model, options.signal);
        options.signal?.throwIfAborted();
        yield* streamAccountWithReplay(this.options.adapter, options, account);
    }
}
