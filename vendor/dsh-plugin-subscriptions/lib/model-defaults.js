/**
 * Per-model default reasoning effort overrides — the durable half of the
 * Settings page's per-model "default effort" pickers.
 *
 * The file lives at `~/.dsh/plugins/subscriptions/model-defaults.json`
 * (mode 0600, atomic replace). Shape: `{ "<provider>": { "<model id>": "<effort>" } }`.
 * An absent entry means "follow the provider's own default": the `Default`
 * chip the model picker shows when the discovered catalog advertises no
 * default at all.
 *
 * Writes are single-process and atomic, but *not* as serialised as the rest
 * of the page: the Settings page disables only the row being saved, so two
 * rows saved back to back can overlap. The write chain below serialises them,
 * so no update is lost to a read-modify-write race. Every read comes from the
 * in-memory snapshot, so the on-disk file only needs to survive a restart: a
 * malformed file reads as empty and is rewritten on the next save, never
 * taking the plugin down with it.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { PROVIDER_IDS } from './auth/store.js';
/** Absolute path of the defaults file. */
export function modelDefaultsFilePath() {
    return dshHomePath('plugins', 'subscriptions', 'model-defaults.json');
}
const EMPTY = Object.freeze({});
/** In-memory snapshot read by every consumer (adapters, RPC). */
let current = EMPTY;
/** One lazy load of the on-disk file (read once per process). */
let ready;
/** Last load failure, surfaced to callers that care; defaults stay empty. */
let loadError;
/**
 * Serialises every write: the read-modify-write sequence must not interleave,
 * or a fast second save would compute its snapshot from the stale `current`
 * and silently drop the first update (the UI disables only the row being
 * saved, so overlaps are reachable).
 */
let writeChain = Promise.resolve();
/**
 * Validate one persisted provider section: a string→string map, or undefined.
 * Malformed *entries* are skipped, not the whole section: one bad value (a
 * hand edit losing its quotes) must not silently un-configure every model in
 * that provider. What was dropped is reported so the caller can surface it
 * instead of the loss disappearing.
 */
function sanitizeProvider(value, dropped) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const entries = {};
    for (const [model, effort] of Object.entries(value)) {
        if (typeof effort !== 'string' || effort.length === 0) {
            dropped.push(model);
            continue;
        }
        entries[model] = effort;
    }
    if (Object.keys(entries).length === 0)
        return undefined;
    return Object.freeze(entries);
}
/** Validate the raw document: only known providers, malformed sections dropped. */
function sanitizeDefaults(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return { defaults: EMPTY, dropped: [] };
    const record = value;
    const result = {};
    const dropped = [];
    for (const provider of PROVIDER_IDS) {
        const section = sanitizeProvider(record[provider], dropped);
        if (section !== undefined)
            result[provider] = section;
    }
    return { defaults: Object.freeze(result), dropped };
}
/** Read and validate the on-disk file; a missing file reads as empty. */
async function loadFile(path) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return EMPTY;
        throw error;
    }
    try {
        const { defaults, dropped } = sanitizeDefaults(JSON.parse(text));
        if (dropped.length > 0)
            loadError = new Error(`subscriptions model defaults: ${dropped.length} malformed entr${dropped.length === 1 ? 'y' : 'ies'} skipped (${dropped.join(', ')}); fix or delete the file`);
        return defaults;
    }
    catch {
        throw new Error(`subscriptions model defaults at ${path} are not valid JSON; fix or delete the file`);
    }
}
/** Resolve the module state once from disk; failures leave the defaults empty. */
async function ensureReady() {
    ready ??= loadFile(modelDefaultsFilePath()).then((loaded) => {
        current = loaded;
        // loadFile itself sets loadError for skipped entries; do not clobber it.
    }, (error) => {
        loadError = error;
        current = EMPTY;
    });
    return ready;
}
/** Persist a snapshot atomically with owner-only permissions. */
async function atomicPersist(defaults, path) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
        await writeFile(tmp, JSON.stringify(defaults, null, 2), { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, path);
    }
    catch (error) {
        await rm(tmp, { force: true });
        throw error;
    }
}
let persistDefaults = atomicPersist;
/**
 * Clone one provider section, or undefined when nothing is configured for it.
 * The clone is prototype-less: model ids are provider-supplied catalog data
 * used as object keys, and consumers index the section directly (the RPC
 * catalog in index.ts does), so an id like `toString` would otherwise yield an
 * inherited *function* where a string is declared.
 */
function sectionOf(defaults, provider) {
    const section = defaults[provider];
    if (section === undefined)
        return undefined;
    return Object.assign(Object.create(null), section);
}
/**
 * Ready the defaults store.
 * @internal Exported for tests; index.ts calls it at apply time so every
 * later synchronous read sees the persisted state.
 */
export async function loadModelDefaults() {
    await ensureReady();
}
/**
 * The last load failure, or a warning about entries that were skipped while
 * loading; consumers only use it for diagnostics.
 */
export function modelDefaultsLoadError() {
    return loadError;
}
/**
 * The configured default effort for one model, or undefined when none (the
 * picker then follows the provider's own default).
 * @internal Exported for the adapters' `defaultEffortOf` options.
 */
export function defaultEffortOf(provider, model) {
    const section = current[provider];
    if (section === undefined)
        return undefined;
    // Own-property lookup: a model id is provider-supplied catalog data, and a
    // plain index would inherit from Object.prototype for names like
    // `toString`, handing a *function* to mergeReasoning (which then throws and
    // breaks that model's resolution).
    return Object.prototype.hasOwnProperty.call(section, model) ? section[model] : undefined;
}
/** A detached snapshot for the RPC surface (render + diffing). */
export function modelDefaultsSnapshot() {
    const result = {};
    for (const provider of PROVIDER_IDS) {
        const section = sectionOf(current, provider);
        if (section !== undefined)
            result[provider] = section;
    }
    return Object.freeze(result);
}
/**
 * Set or clear one model's configured default effort, then persist. The
 * memory snapshot updates only after the atomic write succeeds, so a failed
 * write never leaves the live state ahead of the file.
 * @param provider - the subscription provider route.
 * @param model - the wire model id.
 * @param effort - the effort id, or undefined to clear the override.
 */
export function setDefaultEffort(provider, model, effort) {
    // Chained behind every earlier write: the snapshot `current` is read inside
    // the chain, so two overlapping saves cannot lose either update. The caller
    // receives the promise of its own write (a rejection propagates), not the
    // shared chain.
    const run = writeChain.then(async () => {
        await ensureReady();
        const section = { ...sectionOf(current, provider) ?? {} };
        if (effort === undefined) {
            delete section[model];
        }
        else {
            section[model] = effort;
        }
        const next = { ...current };
        if (Object.keys(section).length === 0) {
            delete next[provider];
        }
        else {
            next[provider] = Object.freeze(section);
        }
        const frozen = Object.freeze(next);
        await persistDefaults(frozen, modelDefaultsFilePath());
        current = frozen;
    });
    // Keep the chain alive even when one write fails, or every later save would
    // be stuck behind the rejected promise. The caller has already received the
    // rejection through `run`.
    writeChain = run.catch(() => undefined);
    return run;
}
/**
 * Drop the in-memory state and the cached load. Test-only: lets a suite
 * unwind the lazy singleton before the next `loadModelDefaults`.
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export async function resetModelDefaultsForTests() {
    current = EMPTY;
    ready = undefined;
    loadError = undefined;
    writeChain = Promise.resolve();
    persistDefaults = atomicPersist;
}
/**
 * Test-only seam: replace the atomic persistence so a failure happens on the
 * real write path. Proves a failed write propagates to the caller and does
 * not wedge the write chain (resetModelDefaultsForTests restores the real
 * implementation).
 * @internal Exported for tests only.
 */
export function overridePersistForTests(persist) {
    persistDefaults = persist;
}
