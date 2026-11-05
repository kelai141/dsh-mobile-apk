import { lazyStream } from "./api/lazy.js";
import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.js";
import { InMemoryCredentialStore } from "./auth/credential-store.js";
import { ModelsError, refreshStoredOAuthCredential, resolveProviderAuth, } from "./auth/resolve.js";
import { InMemoryModelsStore } from "./models-store.js";
import { operationSignal, raceWithAbortSignal } from "./utils/abort.js";
import { assertChatModel, assertClassifierInputSupported, assertClassifierModel, assertImageModel, classifierErrorResult, getModelType, imageErrorResult, isModelType, } from "./utils/model-operations.js";
import { normalizeContext } from "./utils/transcript.js";
export { ModelsError } from "./auth/resolve.js";
export { getModelType, isModelType } from "./utils/model-operations.js";
const KNOWN_MODEL_TYPES = { chat: true, image: true, classifier: true };
/** Models from stores and remote sources may have types that only newer versions know. */
function hasKnownModelType(model) {
    return Object.hasOwn(KNOWN_MODEL_TYPES, getModelType(model));
}
/** Drops stored models whose type this version does not know. */
function withKnownModelTypes(entry) {
    return { ...entry, models: entry.models.filter(hasKnownModelType) };
}
function mergeHeaders(base, override) {
    if (!base && !override)
        return undefined;
    const merged = { ...base };
    for (const [name, value] of Object.entries(override ?? {})) {
        const lowerName = name.toLowerCase();
        for (const existingName of Object.keys(merged)) {
            if (existingName.toLowerCase() === lowerName)
                delete merged[existingName];
        }
        merged[name] = value;
    }
    return merged;
}
class ModelsImpl {
    providers = new Map();
    credentials;
    modelsStore;
    authContext;
    refreshGenerations = new Map();
    refreshControllers = new Map();
    publicationChains = new Map();
    constructor(options) {
        this.credentials = options?.credentials ?? new InMemoryCredentialStore();
        this.modelsStore = options?.modelsStore ?? new InMemoryModelsStore();
        this.authContext = options?.authContext ?? defaultAuthContext();
    }
    setProvider(provider) {
        this.supersedeProviderRefresh(provider.id);
        this.providers.set(provider.id, provider);
    }
    deleteProvider(id) {
        this.supersedeProviderRefresh(id);
        this.providers.delete(id);
    }
    clearProviders() {
        for (const id of new Set([...this.providers.keys(), ...this.refreshControllers.keys()])) {
            this.supersedeProviderRefresh(id);
        }
        this.providers.clear();
    }
    getProviders() {
        return Array.from(this.providers.values());
    }
    getProvider(id) {
        return this.providers.get(id);
    }
    getModels(provider) {
        if (provider !== undefined) {
            const entry = this.providers.get(provider);
            if (!entry)
                return [];
            try {
                return entry.getModels();
            }
            catch {
                return [];
            }
        }
        const models = [];
        for (const entry of this.providers.values()) {
            try {
                models.push(...entry.getModels());
            }
            catch {
                // Best-effort: ill-behaved providers yield no models.
            }
        }
        return models;
    }
    getAllModels(provider) {
        if (provider !== undefined) {
            const entry = this.providers.get(provider);
            if (!entry)
                return [];
            try {
                return entry.getAllModels?.() ?? entry.getModels();
            }
            catch {
                return [];
            }
        }
        const models = [];
        for (const entry of this.providers.values()) {
            try {
                models.push(...(entry.getAllModels?.() ?? entry.getModels()));
            }
            catch {
                // Best-effort: ill-behaved providers yield no models.
            }
        }
        return models;
    }
    getModelsOfType(type, provider) {
        return this.getAllModels(provider).filter((model) => isModelType(model, type));
    }
    getModel(provider, id) {
        return this.getModels(provider).find((model) => model.id === id);
    }
    getModelOfType(type, provider, id) {
        return this.getModelsOfType(type, provider).find((model) => model.id === id);
    }
    supersedeProviderRefresh(providerId) {
        const generation = (this.refreshGenerations.get(providerId) ?? 0) + 1;
        this.refreshGenerations.set(providerId, generation);
        const previous = this.refreshControllers.get(providerId);
        if (previous) {
            this.refreshControllers.delete(providerId);
            previous.abort();
        }
        return generation;
    }
    beginProviderRefresh(providerId) {
        const generation = this.supersedeProviderRefresh(providerId);
        const controller = new AbortController();
        this.refreshControllers.set(providerId, controller);
        return { generation, controller };
    }
    publishProviderModels(providerId, generation, signal, publication) {
        const previous = this.publicationChains.get(providerId) ?? Promise.resolve();
        const queued = (async () => {
            await previous.catch(() => { });
            if (signal.aborted || this.refreshGenerations.get(providerId) !== generation)
                return false;
            if (publication.persist === null) {
                await this.modelsStore.delete(providerId, { signal });
            }
            else if (publication.persist !== undefined) {
                await this.modelsStore.write(providerId, structuredClone(publication.persist), { signal });
            }
            if (signal.aborted || this.refreshGenerations.get(providerId) !== generation)
                return false;
            publication.update?.();
            return true;
        })();
        const tail = queued.catch(() => { });
        this.publicationChains.set(providerId, tail);
        void tail.then(() => {
            if (this.publicationChains.get(providerId) === tail)
                this.publicationChains.delete(providerId);
        });
        return raceWithAbortSignal(queued, signal);
    }
    async runProviderRefreshPhase(provider, credential, allowNetwork, force, generation, signal) {
        const stored = await this.modelsStore.read(provider.id, { signal });
        await provider.refreshModels({
            credential,
            stored: stored ? withKnownModelTypes(structuredClone(stored)) : undefined,
            publish: (publication) => this.publishProviderModels(provider.id, generation, signal, publication),
            allowNetwork,
            force: allowNetwork ? force : undefined,
            signal,
        });
    }
    async refresh(options = {}) {
        const allowNetwork = options.allowNetwork ?? true;
        const callerSignal = operationSignal(options.signal);
        const errors = new Map();
        if (callerSignal.aborted)
            return { aborted: true, errors };
        const selected = options.providers ? new Set(options.providers) : undefined;
        const refreshable = Array.from(this.providers.values()).filter((provider) => provider.refreshModels !== undefined && (!selected || selected.has(provider.id)));
        const refresh = Promise.all(refreshable.map(async (provider) => {
            const { generation, controller } = this.beginProviderRefresh(provider.id);
            const signal = AbortSignal.any([callerSignal, controller.signal]);
            const operation = (async () => {
                let storedCredential;
                let credentialError;
                try {
                    storedCredential = await this.readCredential(provider.id, signal);
                }
                catch (error) {
                    credentialError = error;
                }
                // Restore cached provider state before auth resolution or network access.
                await this.runProviderRefreshPhase(provider, storedCredential, false, undefined, generation, signal);
                if (credentialError !== undefined)
                    throw credentialError;
                if (!allowNetwork || signal.aborted)
                    return;
                const credential = await this.resolveRefreshCredential(provider, storedCredential, signal);
                if (!credential)
                    return;
                await this.runProviderRefreshPhase(provider, credential, true, options.force, generation, signal);
            })();
            try {
                await raceWithAbortSignal(operation, signal);
            }
            catch (error) {
                if (!signal.aborted) {
                    errors.set(provider.id, error instanceof Error
                        ? error
                        : new ModelsError("model_source", `Model refresh failed for ${provider.id}`, { cause: error }));
                }
            }
            finally {
                if (this.refreshControllers.get(provider.id) === controller) {
                    this.refreshControllers.delete(provider.id);
                }
            }
        }));
        try {
            await raceWithAbortSignal(refresh, callerSignal);
        }
        catch (error) {
            if (!callerSignal.aborted)
                throw error;
        }
        return { aborted: callerSignal.aborted, errors: new Map(errors) };
    }
    async resolveRefreshCredential(provider, stored, signal) {
        if (stored?.type === "oauth") {
            const oauth = provider.auth.oauth;
            if (!oauth)
                return undefined;
            if (Date.now() < stored.expires)
                return stored;
            if (signal.aborted)
                return undefined;
            // A refresh that has started survives cancellation or a superseding model refresh, so a
            // rotated refresh token is always persisted. A newer refresh then sees the fresh credential.
            return refreshStoredOAuthCredential(this.credentials, provider.id, oauth, (current) => Date.now() >= current.expires, signal);
        }
        const apiKey = provider.auth.apiKey;
        if (!apiKey)
            return undefined;
        const credential = stored?.type === "api_key" ? stored : undefined;
        const result = await apiKey.resolve({ ctx: this.authContext, credential, signal });
        if (!result)
            return undefined;
        return { type: "api_key", key: result.auth.apiKey, env: result.env };
    }
    async readCredential(providerId, signal) {
        try {
            return await this.credentials.read(providerId, { signal });
        }
        catch (error) {
            throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
        }
    }
    async checkProviderAuth(provider, credential, signal) {
        if (credential?.type === "oauth") {
            return provider.auth.oauth ? { source: "OAuth", type: "oauth" } : undefined;
        }
        const apiKey = provider.auth.apiKey;
        if (!apiKey)
            return undefined;
        if (apiKey.check) {
            try {
                return await apiKey.check({
                    ctx: this.authContext,
                    credential: credential?.type === "api_key" ? credential : undefined,
                    signal,
                });
            }
            catch (error) {
                throw new ModelsError("auth", `API key auth check failed for provider ${provider.id}`, { cause: error });
            }
        }
        const resolution = await resolveProviderAuth(provider, this.credentials, this.authContext, { signal });
        return resolution ? { source: resolution.source, type: "api_key" } : undefined;
    }
    checkAuth(providerId, options) {
        const signal = operationSignal(options?.signal);
        const check = (async () => {
            signal.throwIfAborted();
            const provider = this.providers.get(providerId);
            if (!provider)
                return undefined;
            return this.checkProviderAuth(provider, await this.readCredential(providerId, signal), signal);
        })();
        return raceWithAbortSignal(check, signal);
    }
    async getAuthenticatedProviders(providerId, signal) {
        signal.throwIfAborted();
        const providers = providerId
            ? [this.providers.get(providerId)].filter((entry) => entry !== undefined)
            : this.getProviders();
        const checks = await Promise.all(providers.map(async (provider) => {
            const credential = await this.readCredential(provider.id, signal);
            return { provider, credential, auth: await this.checkProviderAuth(provider, credential, signal) };
        }));
        return checks.filter((entry) => entry.auth !== undefined);
    }
    getAvailable(providerId, options) {
        const signal = operationSignal(options?.signal);
        const available = (async () => {
            const providers = await this.getAuthenticatedProviders(providerId, signal);
            return providers.flatMap(({ provider, credential }) => {
                const models = provider.getModels();
                return provider.filterModels?.(models, credential) ?? models;
            });
        })();
        return raceWithAbortSignal(available, signal);
    }
    async getAvailableOfType(type, providerId, options) {
        return (await this.getAllAvailable(providerId, options)).filter((model) => isModelType(model, type));
    }
    getAllAvailable(providerId, options) {
        const signal = operationSignal(options?.signal);
        const available = (async () => {
            const providers = await this.getAuthenticatedProviders(providerId, signal);
            return providers.flatMap(({ provider, credential }) => {
                const models = provider.getAllModels?.() ?? provider.getModels();
                if (provider.filterAllModels)
                    return provider.filterAllModels(models, credential);
                if (!provider.filterModels)
                    return models;
                const availableChatIds = new Set(provider.filterModels(provider.getModels(), credential).map((model) => model.id));
                return models.filter((model) => !isModelType(model, "chat") || availableChatIds.has(model.id));
            });
        })();
        return raceWithAbortSignal(available, signal);
    }
    async getAuth(providerOrModel, overrides) {
        const signal = operationSignal(overrides?.signal);
        const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
        const provider = this.providers.get(providerId);
        if (!provider)
            return undefined;
        const result = await resolveProviderAuth(provider, this.credentials, this.authContext, { ...overrides, signal });
        if (!result || typeof providerOrModel === "string" || !providerOrModel.headers)
            return result;
        return {
            ...result,
            auth: {
                ...result.auth,
                headers: mergeHeaders(result.auth.headers, providerOrModel.headers),
            },
        };
    }
    async login(providerId, type, interaction, options) {
        const signal = operationSignal(interaction.signal);
        signal.throwIfAborted();
        const provider = this.providers.get(providerId);
        if (!provider)
            throw new ModelsError("provider", `Unknown provider: ${providerId}`);
        const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
        if (!method?.login) {
            throw new ModelsError("auth", `${provider.name} does not support ${type} login`);
        }
        const loginOperation = method.login({ ...interaction, signal }, options);
        const credential = await raceWithAbortSignal(loginOperation, signal);
        let mutationStarted = false;
        let markMutationStarted;
        const started = new Promise((resolve) => {
            markMutationStarted = resolve;
        });
        const mutation = this.credentials.modify(providerId, async () => {
            mutationStarted = true;
            markMutationStarted?.();
            return credential;
        }, { signal });
        void mutation.catch(() => { });
        try {
            await new Promise((resolve, reject) => {
                const onAbort = () => {
                    if (!mutationStarted)
                        reject(signal.reason);
                };
                signal.addEventListener("abort", onAbort, { once: true });
                void Promise.race([started, mutation]).then(() => {
                    signal.removeEventListener("abort", onAbort);
                    resolve();
                }, (error) => {
                    signal.removeEventListener("abort", onAbort);
                    reject(error);
                });
                if (signal.aborted)
                    onAbort();
            });
            await mutation;
        }
        catch (error) {
            signal.throwIfAborted();
            throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
        }
        return credential;
    }
    async logout(providerId, options) {
        const signal = operationSignal(options?.signal);
        signal.throwIfAborted();
        try {
            await this.credentials.delete(providerId, { signal });
        }
        catch (error) {
            signal.throwIfAborted();
            throw new ModelsError("auth", `Credential store delete failed for ${providerId}`, { cause: error });
        }
    }
    requireProvider(model) {
        const provider = this.providers.get(model.provider);
        if (!provider) {
            throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
        }
        return provider;
    }
    requireChatProvider(model) {
        assertChatModel(model);
        return this.requireProvider(model);
    }
    async applyAuth(model, options) {
        this.requireProvider(model);
        const resolution = await this.getAuth(model, {
            apiKey: options?.apiKey,
            env: options?.env,
            signal: options?.signal,
        });
        if (!resolution) {
            throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
        }
        const auth = resolution.auth;
        // Explicit request options win per-field; the Models-only transform runs last.
        const apiKey = options?.apiKey ?? auth.apiKey;
        let headers = mergeHeaders(auth.headers, options?.headers);
        if (options?.transformHeaders)
            headers = await options.transformHeaders(headers ?? {});
        const env = resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
        const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
        const { transformHeaders: _transformHeaders, ...providerOptions } = options ?? {};
        const requestOptions = { ...providerOptions, apiKey, headers, env };
        return { requestModel, requestOptions };
    }
    stream(model, context, options) {
        const transcript = normalizeContext(context);
        return lazyStream(model, async () => {
            const provider = this.requireChatProvider(model);
            const { requestModel, requestOptions } = await this.applyAuth(model, options);
            return provider.stream(requestModel, transcript, requestOptions);
        });
    }
    async complete(model, context, options) {
        return this.stream(model, context, options).result();
    }
    streamSimple(model, context, options) {
        const transcript = normalizeContext(context);
        return lazyStream(model, async () => {
            const provider = this.requireChatProvider(model);
            const { requestModel, requestOptions } = await this.applyAuth(model, options);
            return provider.streamSimple(requestModel, transcript, requestOptions);
        });
    }
    async completeSimple(model, context, options) {
        return this.streamSimple(model, context, options).result();
    }
    streamDeferred(model, handle, options) {
        return lazyStream(model, async () => {
            const provider = this.requireChatProvider(model);
            if (!provider.fetchDeferred) {
                throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
            }
            const { requestModel, requestOptions } = await this.applyAuth(model, options);
            return provider.fetchDeferred(requestModel, handle, requestOptions);
        });
    }
    async fetchDeferred(model, handle, options) {
        return this.streamDeferred(model, handle, options).result();
    }
    async cancelDeferred(model, handle, options) {
        const provider = this.requireChatProvider(model);
        if (!provider.cancelDeferred) {
            throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
        }
        const { requestModel, requestOptions } = await this.applyAuth(model, options);
        await provider.cancelDeferred(requestModel, handle, requestOptions);
    }
    async generateImages(model, context, options) {
        try {
            assertImageModel(model);
            const provider = this.requireProvider(model);
            if (!provider.generateImages) {
                throw new ModelsError("provider", `Provider ${model.provider} does not support image generation`);
            }
            const { requestModel, requestOptions } = await this.applyAuth(model, options);
            return await provider.generateImages(requestModel, context, requestOptions);
        }
        catch (error) {
            return imageErrorResult(model, error, options?.signal?.aborted);
        }
    }
    async classify(model, context, options) {
        try {
            assertClassifierModel(model);
            assertClassifierInputSupported(model, context);
            const provider = this.requireProvider(model);
            if (!provider.classify) {
                throw new ModelsError("provider", `Provider ${model.provider} does not support classification`);
            }
            const { requestModel, requestOptions } = await this.applyAuth(model, options);
            return await provider.classify(requestModel, context, requestOptions);
        }
        catch (error) {
            return classifierErrorResult(model, error, options?.signal?.aborted);
        }
    }
}
export function createModels(options) {
    return new ModelsImpl(options);
}
/**
 * Builds a provider from parts. Built-in provider factories and models.json
 * custom providers both go through this. A single `api` streams all chat
 * models; an `api` map dispatches on `model.api`, and a model whose api has
 * no entry produces a stream error. One-shot operation maps dispatch on
 * `model.api` the same way. At least one concrete implementation across
 * `api`/`images`/`classifiers` is required; empty maps are rejected.
 */
export function createProvider(input) {
    const single = input.api && typeof input.api.stream === "function"
        ? input.api
        : undefined;
    const byApi = single || !input.api ? undefined : input.api;
    const images = input.images;
    const classifiers = input.classifiers;
    const streams = single ? [single] : Object.values(byApi ?? {}).filter((entry) => entry !== undefined);
    const imageImplementations = Object.values(images ?? {}).filter((entry) => entry !== undefined);
    const classifierImplementations = Object.values(classifiers ?? {}).filter((entry) => entry !== undefined);
    if (streams.length === 0 && imageImplementations.length === 0 && classifierImplementations.length === 0) {
        throw new Error(`Provider ${input.id}: at least one of "api", "images", or "classifiers" is required.`);
    }
    const baselineModels = input.models;
    let dynamicModels = [];
    const fetchModels = input.fetchModels;
    const currentModels = () => {
        const merged = [...baselineModels];
        for (const model of dynamicModels) {
            const index = merged.findIndex((entry) => getModelType(entry) === getModelType(model) && entry.id === model.id);
            if (index >= 0)
                merged[index] = model;
            else
                merged.push(model);
        }
        return merged;
    };
    const apiFor = (model) => single ?? byApi?.[model.api];
    const dispatch = (model, run) => {
        const streams = apiFor(model);
        if (!streams) {
            return lazyStream(model, async () => {
                throw new ModelsError("stream", `Provider ${input.id} has no API implementation for "${model.api}"`);
            });
        }
        return run(streams);
    };
    const provider = {
        id: input.id,
        name: input.name ?? input.id,
        baseUrl: input.baseUrl,
        headers: input.headers,
        auth: input.auth,
        getModels: () => currentModels().filter((model) => isModelType(model, "chat")),
        getAllModels: currentModels,
        refreshModels: fetchModels
            ? async (context) => {
                if (context.stored) {
                    const restored = context.stored.models
                        .filter((model) => model.provider === input.id)
                        .map((model) => model);
                    if (!(await context.publish({
                        update: () => {
                            dynamicModels = restored;
                        },
                    }))) {
                        return;
                    }
                }
                if (!context.allowNetwork || context.signal.aborted)
                    return;
                const fetched = await fetchModels(context);
                if (context.signal.aborted)
                    return;
                const refreshed = fetched.filter(hasKnownModelType);
                await context.publish({
                    persist: { models: refreshed, checkedAt: Date.now() },
                    update: () => {
                        dynamicModels = refreshed;
                    },
                });
            }
            : undefined,
        filterModels: input.filterModels,
        filterAllModels: input.filterAllModels,
        stream: (model, context, options) => dispatch(model, (streams) => streams.stream(model, context, options)),
        streamSimple: (model, context, options) => dispatch(model, (streams) => streams.streamSimple(model, context, options)),
    };
    if (streams.some((entry) => entry.fetchDeferred !== undefined)) {
        provider.fetchDeferred = (model, handle, options) => lazyStream(model, async () => {
            const implementation = apiFor(model);
            if (!implementation?.fetchDeferred) {
                throw new ModelsError("provider", `Provider ${input.id} does not support deferred responses for "${model.api}"`);
            }
            return implementation.fetchDeferred(model, handle, options);
        });
    }
    if (streams.some((entry) => entry.cancelDeferred !== undefined)) {
        provider.cancelDeferred = async (model, handle, options) => {
            const implementation = apiFor(model);
            if (!implementation?.cancelDeferred) {
                throw new ModelsError("provider", `Provider ${input.id} cannot cancel deferred responses for "${model.api}"`);
            }
            await implementation.cancelDeferred(model, handle, options);
        };
    }
    if (images && imageImplementations.length > 0) {
        provider.generateImages = async (model, context, options) => {
            const implementation = images[model.api];
            if (!implementation) {
                return imageErrorResult(model, new ModelsError("provider", `Provider ${input.id} has no image generation implementation for "${model.api}"`));
            }
            return implementation.generateImages(model, context, options);
        };
    }
    if (classifiers && classifierImplementations.length > 0) {
        provider.classify = async (model, context, options) => {
            const implementation = classifiers[model.api];
            if (!implementation) {
                return classifierErrorResult(model, new ModelsError("provider", `Provider ${input.id} has no classifier implementation for "${model.api}"`));
            }
            return implementation.classify(model, context, options);
        };
    }
    return provider;
}
/**
 * Runtime-checked narrowing for dynamically looked-up models:
 *
 * ```ts
 * const model = models.getModel("anthropic", "claude-opus-4-7");
 * if (model && hasApi(model, "anthropic-messages")) {
 *   // model: Model<"anthropic-messages">, stream options fully typed
 * }
 * ```
 *
 * Non-chat models never match, even when their api id equals `api`.
 */
export function hasApi(model, api) {
    return isModelType(model, "chat") && model.api === api;
}
export function calculateCost(model, usage) {
    const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    let rates = model.cost;
    let matchedThreshold = -1;
    for (const tier of model.cost.tiers ?? []) {
        if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
            rates = tier;
            matchedThreshold = tier.inputTokensAbove;
        }
    }
    // Anthropic charges 2x base input for 1h cache writes.
    const longWrite = usage.cacheWrite1h ?? 0;
    const shortWrite = usage.cacheWrite - longWrite;
    usage.cost.input = (rates.input / 1000000) * usage.input;
    usage.cost.output = (rates.output / 1000000) * usage.output;
    usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
    usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
    usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
    return usage.cost;
}
const EXTENDED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function getSupportedThinkingLevels(model) {
    if (!model.reasoning)
        return ["off"];
    return EXTENDED_THINKING_LEVELS.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null)
            return false;
        if (level === "xhigh" || level === "max")
            return mapped !== undefined;
        return true;
    });
}
export function clampThinkingLevel(model, level) {
    const availableLevels = getSupportedThinkingLevels(model);
    if (availableLevels.includes(level))
        return level;
    const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
    if (requestedIndex === -1)
        return availableLevels[0] ?? "off";
    for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
        const candidate = EXTENDED_THINKING_LEVELS[i];
        if (availableLevels.includes(candidate))
            return candidate;
    }
    for (let i = requestedIndex - 1; i >= 0; i--) {
        const candidate = EXTENDED_THINKING_LEVELS[i];
        if (availableLevels.includes(candidate))
            return candidate;
    }
    return availableLevels[0] ?? "off";
}
/**
 * Check if two models are equal by comparing their type, id, and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual(a, b) {
    if (!a || !b)
        return false;
    return getModelType(a) === getModelType(b) && a.id === b.id && a.provider === b.provider;
}
//# sourceMappingURL=models.js.map