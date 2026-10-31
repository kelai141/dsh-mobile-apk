import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { PROVIDER_IDS } from './auth/store.js';
export const PROVIDER_TOOLS = {
    codex: ['image_generate', 'web_search'],
    claude: [],
    grok: ['image_generate', 'video_generate', 'x_search'],
    copilot: [],
};
/** Mirrors `PromptCacheTtl` in translate/anthropic.ts; kept here so the client bundle needs no translate import. */
export const PROMPT_CACHE_TTLS = ['5m', '1h'];
export function validatePreferences(provider, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('settings must be an object');
    const raw = input;
    const result = {};
    const nameOf = (value) => {
        if (typeof value !== 'string' || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
            throw new Error('display name must be a single line of at most 80 characters');
        }
        return value.trim();
    };
    if (raw.displayName !== undefined) {
        const name = nameOf(raw.displayName);
        if (name)
            result.displayName = name;
    }
    if (raw.modelDisplayNames !== undefined) {
        if (!raw.modelDisplayNames || typeof raw.modelDisplayNames !== 'object' || Array.isArray(raw.modelDisplayNames)) {
            throw new Error('modelDisplayNames must be a model-to-name map');
        }
        const names = Object.create(null);
        for (const [id, value] of Object.entries(raw.modelDisplayNames)) {
            if (!id.trim())
                throw new Error('model display name requires a model id');
            const name = nameOf(value);
            if (name)
                names[id] = name;
        }
        if (Object.keys(names).length)
            result.modelDisplayNames = names;
    }
    if (raw.accounts !== undefined) {
        if (!raw.accounts || typeof raw.accounts !== 'object' || Array.isArray(raw.accounts))
            throw new Error('accounts must be an account-to-preferences map');
        result.accounts = Object.create(null);
        for (const [key, value] of Object.entries(raw.accounts)) {
            if (!key.trim() || !value || typeof value !== 'object' || Array.isArray(value))
                throw new Error('invalid account preferences');
            const account = value;
            const parsed = {};
            if (account.alias !== undefined) {
                if (typeof account.alias !== 'string')
                    throw new Error('account alias must be a string');
                parsed.alias = account.alias.trim();
            }
            for (const field of ['poolEnabled', 'independentEntry']) {
                if (account[field] !== undefined) {
                    if (typeof account[field] !== 'boolean')
                        throw new Error(`${field} must be a boolean`);
                    parsed[field] = account[field];
                }
            }
            if (account.poolModels !== undefined) {
                if (!Array.isArray(account.poolModels) || account.poolModels.some(id => typeof id !== 'string' || !id.trim()))
                    throw new Error('poolModels must be an array of model ids');
                parsed.poolModels = [...new Set(account.poolModels)];
            }
            result.accounts[key] = parsed;
        }
    }
    if (raw.visibleModels !== undefined) {
        if (!Array.isArray(raw.visibleModels) || raw.visibleModels.some(id => typeof id !== 'string' || !id.trim())) {
            throw new Error('visibleModels must be an array of model ids');
        }
        result.visibleModels = [...new Set(raw.visibleModels)];
    }
    if (raw.contextWindows !== undefined) {
        if (provider !== 'codex')
            throw new Error('context window overrides are currently supported only for Codex');
        if (!raw.contextWindows || typeof raw.contextWindows !== 'object' || Array.isArray(raw.contextWindows)) {
            throw new Error('contextWindows must be a model-to-token map');
        }
        result.contextWindows = Object.create(null);
        for (const [model, value] of Object.entries(raw.contextWindows)) {
            if (!model.trim() || typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
                throw new Error('context windows must be positive safe integers');
            }
            result.contextWindows[model] = value;
        }
    }
    if (raw.promptCacheTtl !== undefined) {
        if (provider !== 'claude')
            throw new Error('promptCacheTtl is currently supported only for Claude');
        if (!PROMPT_CACHE_TTLS.includes(raw.promptCacheTtl)) {
            throw new Error(`promptCacheTtl must be one of ${PROMPT_CACHE_TTLS.join(', ')}`);
        }
        result.promptCacheTtl = raw.promptCacheTtl;
    }
    if (raw.subagentSpeeds !== undefined) {
        if (provider !== 'codex')
            throw new Error('subagent speeds are currently supported only for Codex');
        if (!raw.subagentSpeeds || typeof raw.subagentSpeeds !== 'object' || Array.isArray(raw.subagentSpeeds)) {
            throw new Error('subagent speeds must be a model-to-speed map');
        }
        result.subagentSpeeds = Object.create(null);
        for (const [model, tier] of Object.entries(raw.subagentSpeeds)) {
            if (!model.trim() || (tier !== 'standard' && tier !== 'fast')) {
                throw new Error('subagent speeds require a model id and either "standard" or "fast"');
            }
            result.subagentSpeeds[model] = tier;
        }
    }
    if (raw.tools !== undefined) {
        if (!raw.tools || typeof raw.tools !== 'object' || Array.isArray(raw.tools))
            throw new Error('tools must be an object');
        result.tools = {};
        for (const [tool, enabled] of Object.entries(raw.tools)) {
            if (!PROVIDER_TOOLS[provider].includes(tool) || typeof enabled !== 'boolean') {
                throw new Error(`unsupported tool setting: ${provider}/${tool}`);
            }
            result.tools[tool] = enabled;
        }
    }
    return result;
}
/** Durable user preferences, independent of expiring discovery caches. */
export class ProviderSettingsStore {
    current = { providers: {}, toolHistory: [] };
    writes = Promise.resolve();
    path;
    constructor(path = dshHomePath('plugins', 'subscriptions', 'provider-settings.json')) {
        this.path = path;
        try {
            const raw = JSON.parse(readFileSync(path, 'utf8'));
            if (!raw.providers || !Array.isArray(raw.toolHistory))
                throw new Error('invalid settings document');
            for (const provider of PROVIDER_IDS) {
                if (Object.hasOwn(raw.providers, provider))
                    this.current.providers[provider] = validatePreferences(provider, raw.providers[provider]);
            }
            this.current.toolHistory = raw.toolHistory.map(revision => {
                if (!PROVIDER_IDS.includes(revision.provider) || !Number.isSafeInteger(revision.at) || revision.at < 0)
                    throw new Error('invalid tool history');
                const tools = validatePreferences(revision.provider, { tools: revision.tools }).tools ?? {};
                return { at: revision.at, provider: revision.provider, tools };
            }).sort((a, b) => a.at - b.at);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw new Error(`Cannot read provider settings at ${path}`, { cause: error });
        }
    }
    get(provider) {
        return structuredClone(this.current.providers[provider] ?? {});
    }
    visible(provider, model) {
        return this.current.providers[provider]?.visibleModels?.includes(model) ?? true;
    }
    modelName(provider, model, fallback) {
        const names = this.current.providers[provider]?.modelDisplayNames;
        return names && Object.hasOwn(names, model) ? names[model] : fallback;
    }
    contextWindow(model) {
        const windows = this.current.providers.codex?.contextWindows;
        return windows && Object.hasOwn(windows, model) ? windows[model] : undefined;
    }
    /** Read on every request so saved changes apply to the next subagent request. */
    subagentSpeed(model) {
        const speeds = this.current.providers.codex?.subagentSpeeds;
        return speeds && Object.hasOwn(speeds, model) ? speeds[model] : 'standard';
    }
    /** The Settings-page Claude cache TTL; undefined follows the plugin config. Read per request, so no clone. */
    promptCacheTtl() {
        return this.current.providers.claude?.promptCacheTtl;
    }
    /** Creation-time policy survives restarts and never changes an existing session. */
    toolEnabled(provider, tool, createdAt = Date.now()) {
        let enabled = true;
        for (const revision of this.current.toolHistory) {
            if (revision.at > createdAt)
                break;
            if (revision.provider === provider)
                enabled = revision.tools[tool] !== false;
        }
        return enabled;
    }
    set(provider, input) {
        const preferences = validatePreferences(provider, input);
        const run = this.writes.then(async () => {
            const next = structuredClone(this.current);
            const before = next.providers[provider]?.tools ?? {};
            next.providers[provider] = preferences;
            if (PROVIDER_TOOLS[provider].some(tool => (before[tool] !== false) !== (preferences.tools?.[tool] !== false))) {
                next.toolHistory.push({ at: Date.now(), provider, tools: preferences.tools ?? {} });
            }
            await mkdir(dirname(this.path), { recursive: true });
            const temporary = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
            try {
                await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
                await rename(temporary, this.path);
            }
            finally {
                await rm(temporary, { force: true });
            }
            this.current = next;
        });
        this.writes = run.catch(() => undefined);
        return run;
    }
}
