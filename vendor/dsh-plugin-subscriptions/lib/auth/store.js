/**
 * On-disk OAuth session store at `~/.dsh/plugins/subscriptions/auth.json`.
 *
 * The file is a JSON object keyed by provider id, each entry holding that
 * provider's ACCOUNTS: a map of account key → session plus the default
 * account's key. Writes are atomic (tmp file + rename) with mode 0600
 * because they carry bearer tokens. Session shapes live here (not in the
 * provider modules) because this file owns the durable format.
 *
 * Backward compatibility: entries written by single-account versions hold
 * the session fields directly (no `accounts` wrapper); reads migrate them
 * in memory, and the next write persists the new shape — existing logins
 * survive the upgrade untouched.
 */
import { createHash } from 'node:crypto';
import { decodeJwtPayload } from './jwt.js';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
/** Every provider route, in display order. */
export const PROVIDER_IDS = ['codex', 'claude', 'grok', 'copilot'];
/**
 * The stable identity of one session's account: Codex keys on workspace AND
 * user (email fallback, workspace-only for unidentified legacy sessions),
 * the others on their display identity, falling
 * back to a refresh-token hash for sessions stored before identity fields
 * existed. Logging the same account in again lands on the same key, so a
 * re-login updates in place instead of duplicating. (The hash fallback can
 * miss that dedup once for a legacy session re-logged with a now-known
 * identity — the duplicate is visible on the Settings page and can simply
 * be logged out.)
 * @param provider - the provider route.
 * @param session - the session to key.
 * @returns the account map key.
 */
export function accountKeyOf(provider, session) {
    switch (provider) {
        case 'codex': {
            const codex = session;
            const payload = typeof codex.idToken === 'string' ? decodeJwtPayload(codex.idToken) : undefined;
            const auth = claimObject(payload?.['https://api.openai.com/auth']);
            const user = nonEmpty(auth?.chatgpt_user_id) ?? nonEmpty(auth?.user_id);
            const profile = claimObject(payload?.['https://api.openai.com/profile']);
            const email = nonEmpty(codex.emailAddress) ?? nonEmpty(payload?.email) ?? nonEmpty(profile?.email);
            if (user === undefined && email === undefined)
                return codex.accountId;
            // JSON tuple encoding avoids separator collisions and distinguishes IDs from emails.
            return JSON.stringify([codex.accountId, user === undefined ? 'email' : 'user', user ?? email.toLowerCase()]);
        }
        case 'claude':
            return session.emailAddress ?? tokenHash(session.refreshToken);
        case 'grok':
            return session.account ?? tokenHash(session.refreshToken);
        case 'copilot':
            return session.account ?? tokenHash(session.refreshToken);
    }
}
function nonEmpty(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
function claimObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value : undefined;
}
/** Resolve only recorded aliases, not an ambiguous workspace-wide match. */
function resolveAccount(entry, key) {
    const seen = new Set();
    while (!Object.hasOwn(entry.accounts, key)
        && entry.aliases !== undefined
        && Object.hasOwn(entry.aliases, key)
        && !seen.has(key)) {
        seen.add(key);
        key = entry.aliases[key];
    }
    return key;
}
/**
 * Resolve a Codex reference that is neither a stored key nor a recorded alias:
 * a config `account` may name the login email (as the other providers' keys
 * do) or the bare workspace ID that keys stored before per-user keys. Only an
 * unambiguous match resolves; two users sharing the workspace stay apart, and
 * the reference is returned unchanged so the caller reports it as missing.
 */
function resolveCodexReference(entry, reference) {
    const wanted = reference.trim().toLowerCase();
    if (wanted.length === 0)
        return reference;
    const matches = Object.entries(entry.accounts).filter(([, session]) => session.accountId === reference.trim() || codexEmail(session) === wanted);
    return matches.length === 1 ? matches[0][0] : reference;
}
/**
 * Resolve a persisted legacy account key to its canonical account identity.
 * For Codex, a reference that matches no key or alias also resolves through
 * a unique login email or workspace ID (see {@link resolveCodexReference}).
 */
export async function resolveAccountKey(provider, account, path = authFilePath()) {
    const entry = (await loadStore(path))[provider];
    if (entry === undefined)
        return account;
    const key = resolveAccount(entry, account);
    if (provider === 'codex' && !Object.hasOwn(entry.accounts, key)) {
        return resolveCodexReference(entry, key);
    }
    return key;
}
/** Migrate workspace-only keys once; retain collisions rather than discard credentials. */
function codexEmail(session) {
    const payload = typeof session.idToken === 'string' ? decodeJwtPayload(session.idToken) : undefined;
    const profile = claimObject(payload?.['https://api.openai.com/profile']);
    return (nonEmpty(session.emailAddress) ?? nonEmpty(payload?.email) ?? nonEmpty(profile?.email))?.toLowerCase();
}
function codexUserKey(session) {
    const key = accountKeyOf('codex', session);
    try {
        const tuple = JSON.parse(key);
        return Array.isArray(tuple) && tuple[1] === 'user' ? key : undefined;
    }
    catch {
        return undefined;
    }
}
/** Upgrade one unambiguous email fallback to the stable user key. */
function reconcileCodexIdentity(entry, session) {
    const userKey = codexUserKey(session);
    const email = codexEmail(session);
    if (userKey === undefined || email === undefined)
        return undefined;
    const emailKey = JSON.stringify([session.accountId, 'email', email]);
    const previous = entry.accounts[emailKey];
    if (previous === undefined || codexEmail(previous) !== email)
        return undefined;
    // Never merge workspace-wide: the exact normalized workspace/email pair must match.
    if (!Object.hasOwn(entry.accounts, userKey))
        entry.accounts[userKey] = previous;
    delete entry.accounts[emailKey];
    entry.aliases = { ...entry.aliases, [emailKey]: userKey };
    for (const [alias, target] of Object.entries(entry.aliases)) {
        if (target === emailKey)
            entry.aliases[alias] = userKey;
    }
    if (entry.default === emailKey)
        entry.default = userKey;
    return userKey;
}
function migrateCodex(entry) {
    for (const [oldKey, session] of Object.entries(entry.accounts)) {
        if (oldKey !== session.accountId)
            continue;
        const key = accountKeyOf('codex', session);
        if (key === oldKey || Object.hasOwn(entry.accounts, key))
            continue;
        entry.accounts[key] = session;
        delete entry.accounts[oldKey];
        entry.aliases = { ...entry.aliases, [oldKey]: key };
        if (entry.default === oldKey)
            entry.default = key;
    }
}
/** Short stable hash for sessions without an identity field. */
function tokenHash(refreshToken) {
    return `token-${createHash('sha256').update(refreshToken).digest('hex').slice(0, 16)}`;
}
/**
 * Absolute path of the auth store file.
 * @returns `dshHomePath('plugins', 'subscriptions', 'auth.json')`.
 */
export function authFilePath() {
    return dshHomePath('plugins', 'subscriptions', 'auth.json');
}
/** Store location used before the plugin was renamed; migrated on first read. */
function legacyAuthFilePath() {
    return dshHomePath('plugins', 'router', 'auth.json');
}
/** Check that one durable session carries the fields every session needs. */
function assertSessionShape(provider, account, value) {
    if (typeof value !== 'object' || value === null) {
        throw new Error(`subscriptions auth store: entry "${provider}/${account}" is not an object; fix or delete the store file`);
    }
    const entry = value;
    if (typeof entry.accessToken !== 'string' || entry.accessToken.length === 0
        || typeof entry.refreshToken !== 'string' || entry.refreshToken.length === 0
        || typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt)) {
        throw new Error(`subscriptions auth store: entry "${provider}/${account}" is missing accessToken/refreshToken/expiresAt; fix or delete the store file`);
    }
}
/**
 * Read the whole store. A missing file is an empty store; malformed JSON or a
 * malformed entry throws, because silently discarding tokens would strand the
 * user without a diagnosis. Single-account entries are migrated in memory;
 * the next write persists the new shape.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the parsed session map.
 */
export async function loadStore(path = authFilePath()) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        // Migrate the pre-rename store once, preserving existing logins.
        if (path !== authFilePath())
            return {};
        try {
            text = await readFile(legacyAuthFilePath(), 'utf8');
        }
        catch (legacyError) {
            if (legacyError.code === 'ENOENT')
                return {};
            throw legacyError;
        }
        const migrated = parseStore(text, legacyAuthFilePath());
        await writeStore(migrated, path);
        await rm(legacyAuthFilePath(), { force: true });
        return migrated;
    }
    return parseStore(text, path);
}
/**
 * Parse and migrate store JSON read from `path`. An ACCOUNT entry whose shape
 * is invalid (empty or missing tokens — corruption seen in the wild from a
 * broken keychain import) is SKIPPED instead of rejected: one bad entry must
 * not blind every provider's status read, and a session without tokens is
 * unusable by definition, so nothing of value is discarded. The next write
 * persists the store without the skipped entry. Structural failures (invalid
 * JSON, a non-object file) still throw — those say the file itself is broken.
 */
function parseStore(text, path) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new Error(`subscriptions auth store at ${path} is not valid JSON; fix or delete the file`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`subscriptions auth store at ${path} must be a JSON object keyed by provider; fix or delete the file`);
    }
    const raw = parsed;
    const store = {};
    for (const provider of PROVIDER_IDS) {
        const entry = raw[provider];
        if (entry === undefined)
            continue;
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            console.warn(`subscriptions auth store: entry "${provider}" is not an object; skipped`);
            continue;
        }
        const record = entry;
        if (typeof record.accessToken === 'string') {
            // Single-account format: wrap the bare session, preserving every field.
            if (!isValidSessionShape(record)) {
                console.warn(`subscriptions auth store: legacy entry "${provider}" has no usable tokens; skipped`);
                continue;
            }
            const session = record;
            const key = provider === 'codex' ? session.accountId : accountKeyOf(provider, session);
            store[provider] = { default: key, accounts: { [key]: session } };
            continue;
        }
        const accounts = record.accounts;
        if (typeof accounts !== 'object' || accounts === null || Array.isArray(accounts)) {
            console.warn(`subscriptions auth store: entry "${provider}" has no accounts map; skipped`);
            continue;
        }
        if (record.default !== undefined && typeof record.default !== 'string') {
            console.warn(`subscriptions auth store: entry "${provider}" default is not a string; skipped`);
            continue;
        }
        const kept = {};
        for (const [account, session] of Object.entries(accounts)) {
            if (isValidSessionShape(session)) {
                kept[account] = session;
            }
            else {
                console.warn(`subscriptions auth store: entry "${provider}/${account}" has no usable accessToken/refreshToken/expiresAt; skipped`);
            }
        }
        if (Object.keys(kept).length === 0)
            continue;
        const validDefault = record.default === undefined || record.default in kept
            ? record.default
            : Object.keys(kept)[0];
        store[provider] = { ...record, default: validDefault, accounts: kept };
    }
    if (store.codex !== undefined)
        migrateCodex(store.codex);
    return store;
}
/** Whether a value carries the fields every stored session needs (non-empty tokens). */
function isValidSessionShape(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const entry = value;
    return typeof entry.accessToken === 'string' && entry.accessToken.length > 0
        && typeof entry.refreshToken === 'string' && entry.refreshToken.length > 0
        && typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt);
}
/** Persist the whole store atomically with owner-only permissions. */
async function writeStore(store, path) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
        await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
        // An existing destination keeps its old mode through rename on some
        // filesystems; enforce 0600 on the source before the swap.
        await chmod(tmp, 0o600);
        await rename(tmp, path);
    }
    catch (error) {
        await rm(tmp, { force: true });
        throw error;
    }
}
/**
 * One write chain per store path. Every mutation is a read-modify-write of a
 * single JSON file, and the plugin has several independent writers — a login,
 * a logout, and one token refresh per provider account, each on its own
 * schedule. Overlapping them unserialized costs whichever account read the
 * store first its entry.
 *
 * A chain is dropped once nothing is queued behind it, so the map holds an
 * entry only while writes are in flight.
 */
const writeChains = new Map();
/**
 * Run one read-modify-write of a store path after every write already queued
 * for it. Callers join the chain synchronously, so call order is write order.
 * @param path - the store file being mutated.
 * @param action - the read-modify-write to run.
 * @returns whatever `action` returns.
 */
async function serialize(path, action) {
    const previous = writeChains.get(path) ?? Promise.resolve();
    // Both handlers: a failed write must not strand everything queued behind it.
    const next = previous.then(action, action);
    const tail = next.then(() => undefined, () => undefined);
    writeChains.set(path, tail);
    try {
        return await next;
    }
    finally {
        if (writeChains.get(path) === tail)
            writeChains.delete(path);
    }
}
/**
 * List one provider's accounts, default first.
 * @param provider - the provider route.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the account entries in stable order (empty when logged out).
 */
export async function listAccounts(provider, path = authFilePath()) {
    const entry = (await loadStore(path))[provider];
    if (entry === undefined)
        return [];
    const accounts = Object.entries(entry.accounts).map(([key, session]) => ({ key, session }));
    accounts.sort((a, b) => Number(b.key === entry.default) - Number(a.key === entry.default));
    return accounts;
}
/**
 * Read one account's session.
 * @param provider - the provider route.
 * @param account - the account key; defaults to the provider's default account.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the stored session, or `undefined` when absent.
 */
export async function getAccountSession(provider, account, path = authFilePath()) {
    const entry = (await loadStore(path))[provider];
    if (entry === undefined)
        return undefined;
    const key = account ?? entry.default;
    if (key === undefined)
        return undefined;
    return entry.accounts[resolveAccount(entry, key)];
}
/**
 * Write one account's session, preserving the others. The first account of a
 * provider becomes its default.
 *
 * The session is validated before it lands: a corrupt entry written here
 * would fail every later read of the whole store (one bad entry breaks all
 * providers' status), so the write path must be as strict as the read path.
 * @param provider - the provider route.
 * @param account - the account key (see {@link accountKeyOf}).
 * @param session - the fresh session from a login or refresh.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @throws when the session is missing accessToken/refreshToken/expiresAt.
 */
export async function saveAccountSession(provider, account, session, path = authFilePath()) {
    assertSessionShape(provider, account, session);
    return serialize(path, async () => {
        const store = await loadStore(path);
        const entry = store[provider];
        if (entry !== undefined) {
            account = resolveAccount(entry, account);
            if (provider === 'codex') {
                account = reconcileCodexIdentity(entry, session) ?? accountKeyOf('codex', session);
            }
        }
        ;
        store[provider] = {
            ...entry,
            default: entry?.default ?? account,
            accounts: { ...entry?.accounts, [account]: session },
        };
        await writeStore(store, path);
    });
}
/**
 * Delete one account's session (logout). Deleting the default moves the badge
 * to the next remaining account.
 * @param provider - the provider route.
 * @param account - the account key.
 * @param path - store file path; defaults to {@link authFilePath}.
 */
export async function deleteAccountSession(provider, account, path = authFilePath()) {
    return serialize(path, async () => {
        const store = await loadStore(path);
        const entry = store[provider];
        if (entry === undefined)
            return;
        account = resolveAccount(entry, account);
        if (!Object.hasOwn(entry.accounts, account))
            return;
        const accounts = { ...entry.accounts };
        delete accounts[account];
        if (Object.keys(accounts).length === 0) {
            delete store[provider];
        }
        else {
            ;
            store[provider] = {
                ...entry,
                ...entry.default === account ? { default: Object.keys(accounts)[0] } : { default: entry.default },
                accounts,
            };
        }
        await writeStore(store, path);
    });
}
/**
 * Pin the account direct (non-pool) routes serve.
 * @param provider - the provider route.
 * @param account - the account key; must exist.
 * @param path - store file path; defaults to {@link authFilePath}.
 */
export async function setDefaultAccount(provider, account, path = authFilePath()) {
    return serialize(path, async () => {
        const store = await loadStore(path);
        const entry = store[provider];
        if (entry !== undefined)
            account = resolveAccount(entry, account);
        if (entry === undefined || !Object.hasOwn(entry.accounts, account)) {
            throw new Error(`no ${provider} account "${account}" is logged in`);
        }
        ;
        store[provider] = { ...entry, default: account };
        await writeStore(store, path);
    });
}
