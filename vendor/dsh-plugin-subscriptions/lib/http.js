/**
 * Proxy routing for every outbound subscription request. When a proxy is
 * configured, {@link proxiedFetch} attaches an undici {@link ProxyAgent} as the
 * fetch `dispatcher`, so token exchanges, model-API streams, usage lookups,
 * model discovery, and the `web_search` / `x_search` / `image_generate` / `video_generate`
 * tools all leave through the proxy without touching their call sites.
 *
 * The config lives at `~/.dsh/plugins/subscriptions/proxy.json` (mode 0600,
 * it may carry a password), sibling to the auth store. The `proxyGet` /
 * `proxySet` / `proxyTest` RPC endpoints drive it from the web Settings page;
 * a saved config applies immediately to subsequent requests.
 *
 * The OAuth authorize step opens in the user's browser, which uses the
 * browser/system proxy and is outside this module's reach.
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { dirname } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
/**
 * undici's own fetch, typed to the DOM fetch signature: its bundled types are
 * stricter (Request requires `duplex`, `RequestInit.body` is non-null) and
 * incompatible with the DOM shapes the provider code passes. The runtime
 * object is the same Web-fetch implementation Node uses.
 */
const dispatchFetch = undiciFetch;
/** Destination the `proxyTest` endpoint probes when none is given. */
export const DEFAULT_PROXY_TEST_URL = 'https://api.x.ai/v1/models';
/** Probe deadline; a hung proxy must not pin the Settings dialog forever. */
export const DEFAULT_PROXY_TEST_TIMEOUT_MS = 15_000;
/**
 * Minimum per-address connect attempt budget for Node's Happy Eyeballs
 * (`net.autoSelectFamilyAttemptTimeout`). Node's default is 250ms, which is
 * shorter than one TCP handshake to Cloudflare-fronted hosts (registry.npmjs.org,
 * chatgpt.com) on a high-latency link: every address then fails with
 * ETIMEDOUT and the whole fetch dies even though curl succeeds.
 */
export const MIN_CONNECT_ATTEMPT_TIMEOUT_MS = 1500;
/**
 * Raise the process-wide Happy Eyeballs attempt timeout to at least `minMs`.
 * Never lowers a host-configured value. The setting is per process (there is
 * no per-dispatcher knob that survives the host's global dispatcher), so the
 * plugin restores the previous value on dispose.
 * @param minMs - the floor to enforce.
 * @returns the value in effect before the call.
 */
export function ensureConnectAttemptTimeout(minMs = MIN_CONNECT_ATTEMPT_TIMEOUT_MS) {
    const previous = getDefaultAutoSelectFamilyAttemptTimeout();
    if (previous < minMs)
        setDefaultAutoSelectFamilyAttemptTimeout(minMs);
    return previous;
}
/** Restore a value captured by {@link ensureConnectAttemptTimeout}. */
export function restoreConnectAttemptTimeout(previous) {
    setDefaultAutoSelectFamilyAttemptTimeout(previous);
}
/** Disabled configuration: the module state before the first load. */
const DISABLED = { enabled: false, url: '', bypass: [] };
/** Current config; updated by every load/apply/save. */
let current = DISABLED;
/** The live dispatcher, or undefined when proxies are off/errored. */
let agent;
/** Last load/apply failure, surfaced by the config view. */
let configError;
/** One lazy load of the on-disk config (module-import cheap; file read once). */
let ready;
/** Absolute path of the proxy config file. */
export function proxyFilePath() {
    return dshHomePath('plugins', 'subscriptions', 'proxy.json');
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Flatten a fetch failure into a readable message: undici wraps the true
 * cause (`connect ECONNREFUSED ...`) behind a bare "fetch failed", so walk
 * the cause chain and append each distinct layer (up to four, cycle-safe).
 * A hostname resolving to several addresses (e.g. `localhost` → ::1 and
 * 127.0.0.1) fails as an `AggregateError` with an empty message, so its
 * per-address `errors` entries are folded in too.
 */
export function describeFetchError(error) {
    const parts = [];
    let node = error;
    for (let depth = 0; depth < 4 && node !== undefined && node !== null; depth += 1) {
        const layer = node;
        if (Array.isArray(layer.errors)) {
            for (const child of layer.errors) {
                const childText = child instanceof Error && child.message !== '' ? child.message : String(child);
                if (childText !== '' && !parts.includes(childText))
                    parts.push(childText);
            }
        }
        let text = layer instanceof Error ? layer.message : String(node);
        const code = layer.code;
        if (typeof code === 'string' && code !== '') {
            if (text === '')
                text = code;
            else if (!text.includes(code))
                text = `${text} (${code})`;
        }
        if (text !== '' && !parts.includes(text))
            parts.push(text);
        const next = layer.cause;
        if (next === undefined || next === null || next === node)
            break;
        node = next;
    }
    return parts.join(' → ');
}
function withError(error) {
    configError = errorMessage(error);
}
/**
 * Credentials embedded in a proxy URL's userinfo, or undefined when the URL
 * does not parse. Needed because a user may legitimately paste
 * `http://user:pass@host:port` into the URL field instead of filling the
 * separate username/password inputs; the secret then lives in `url`, not in
 * {@link ProxyConfig.password}.
 * @param raw - the stored URL.
 * @returns the percent-decoded userinfo, or undefined when unparsable.
 */
function urlCredentials(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return undefined;
    }
    if (url.username === '' && url.password === '')
        return undefined;
    const decode = (value) => {
        try {
            return decodeURIComponent(value);
        }
        catch {
            return value;
        }
    };
    return { username: decode(url.username), password: decode(url.password) };
}
/**
 * Strip the userinfo from a proxy URL so it can be logged or returned to the
 * browser. Unparsable input still gets the authority prefix removed: a
 * half-typed `http://user:pass@` is exactly the shape that used to be echoed
 * back in a validation error.
 * @param raw - the URL to sanitize.
 * @returns the URL without credentials.
 */
export function redactProxyUrl(raw) {
    try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        return url.toString();
    }
    catch {
        const match = /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)(.*)$/i.exec(raw);
        if (match !== null && match[2].includes('@'))
            return (match[1] ?? '') + match[2].slice(match[2].lastIndexOf('@') + 1) + match[3];
        return raw;
    }
}
/**
 * Parse and validate a proxy URL. Only HTTP(S) proxies are supported because
 * the undici dispatcher speaks CONNECT over HTTP; socks5 is not supported.
 * @param raw - the URL the user configured.
 * @returns the parsed URL (credentials attached by the caller).
 */
export function parseProxyUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        // The message quotes the URL, so it must quote the **redacted** form:
        // a rejected `http://user:pass@` used to put the password into the
        // error text, which the browser then rendered and any log kept.
        throw new Error(`proxy URL "${redactProxyUrl(raw)}" is not a valid URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`proxy URL must use the http:// or https:// scheme (got "${redactProxyUrl(raw)}")`);
    }
    if (url.hostname === '')
        throw new Error('proxy URL must include a host');
    return url;
}
/**
 * Whether a request hostname bypasses the proxy.
 * @param hostname - the request's hostname.
 * @param entries - configured bypass entries: exact host, plain suffix
 *   (`example.com` also matches `api.example.com`), or `*.example.com`.
 */
export function matchesBypass(hostname, entries) {
    const host = hostname.toLowerCase();
    for (const raw of entries) {
        let entry = raw.trim().toLowerCase();
        if (entry === '')
            continue;
        if (entry.includes('://')) {
            try {
                entry = new URL(entry).hostname;
            }
            catch {
                continue;
            }
        }
        entry = entry.replace(/:\d+$/, '');
        if (entry === '' || entry === '*')
            continue;
        if (entry.startsWith('*.')) {
            if (host.endsWith(entry.slice(1)))
                return true;
        }
        else if (host === entry || host.endsWith(`.${entry}`)) {
            return true;
        }
    }
    return false;
}
/** Validate and normalize one config (throws with a user-facing message). */
function normalizeConfig(input) {
    const url = input.url.trim();
    if (input.enabled && url === '') {
        throw new Error('a proxy URL is required when the proxy is enabled');
    }
    if (url !== '') {
        // issue #1282: promote userinfo into the dedicated fields. Keeping the
        // password inside `url` is what made `proxyGetConfig` hand it to the
        // browser, and it also made `passwordSet` report `false` for a config
        // that does have a password. Promotion happens on every normalize, so a
        // config already on disk is cleaned the next time it is loaded.
        const embedded = urlCredentials(url);
        if (embedded !== undefined) {
            const promoted = parseProxyUrl(url);
            promoted.username = '';
            promoted.password = '';
            return normalizeConfig({
                enabled: input.enabled,
                url: promoted.toString(),
                username: input.username !== undefined && input.username !== ''
                    ? input.username
                    : embedded.username === '' ? undefined : embedded.username,
                password: input.password !== undefined && input.password !== '' && input.password !== null
                    ? input.password
                    : embedded.password === '' ? undefined : embedded.password,
                bypass: input.bypass,
            });
        }
        parseProxyUrl(url);
    }
    const bypass = Array.from(new Set((input.bypass ?? [])
        .map(entry => entry.trim())
        .filter(entry => entry !== '')));
    return {
        enabled: input.enabled,
        url,
        ...input.username !== undefined && input.username !== '' ? { username: input.username.trim() } : {},
        ...input.password !== undefined && input.password !== '' && input.password !== null ? { password: input.password } : {},
        bypass,
    };
}
/** Build the undici agent for a config (throws on an unusable URL). */
function buildAgent(cfg) {
    if (!cfg.enabled || cfg.url === '')
        return undefined;
    const url = parseProxyUrl(cfg.url);
    if (cfg.username !== undefined)
        url.username = cfg.username;
    if (cfg.password !== undefined)
        url.password = cfg.password;
    return new ProxyAgent(url.toString());
}
/** Swap in a config and its agent; a failed agent falls back to host routing. */
async function applyConfig(cfg) {
    let next;
    if (cfg !== undefined) {
        configError = undefined;
        try {
            next = buildAgent(cfg);
        }
        catch (error) {
            withError(error);
            next = undefined;
        }
        current = cfg;
    }
    const previous = agent;
    agent = next;
    if (previous !== undefined)
        void previous.close().catch(() => undefined);
}
/** Read the on-disk config. A missing file is the disabled default. */
async function loadConfigFile(path) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { ...DISABLED, bypass: [] };
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new Error(`subscriptions proxy config at ${path} is not valid JSON; fix or delete the file`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('subscriptions proxy config must be a JSON object');
    }
    const record = parsed;
    const enabled = record.enabled === true;
    const url = typeof record.url === 'string' ? record.url : '';
    const username = typeof record.username === 'string' ? record.username : undefined;
    const password = typeof record.password === 'string' ? record.password : undefined;
    const bypass = Array.isArray(record.bypass)
        ? record.bypass.filter((entry) => typeof entry === 'string')
        : [];
    return normalizeConfig({
        enabled,
        url,
        ...username === undefined ? {} : { username },
        ...password === undefined ? {} : { password },
        bypass,
    });
}
/** Resolve the module state once from disk; failures disable the proxy. */
async function ensureReady() {
    ready ??= loadConfigFile(proxyFilePath()).then(async (cfg) => {
        await applyConfig(cfg);
        return current;
    }, async (error) => {
        withError(error);
        await applyConfig(undefined);
        return current;
    });
    return ready;
}
/** Persist a config atomically with owner-only permissions, then apply it. */
async function persistConfig(cfg, path) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
        await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, path);
    }
    catch (error) {
        await rm(tmp, { force: true });
        throw error;
    }
}
/**
 * Close the live agent and drop the cached config. Test-only: lets a suite
 *  unwind the agent's keep-alive sockets before the process exits.
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export async function resetProxyForTests() {
    const previous = agent;
    agent = undefined;
    current = { ...DISABLED, bypass: [] };
    ready = undefined;
    configError = undefined;
    if (previous !== undefined)
        await previous.close().catch(() => undefined);
}
/**
 * Current proxy config as served to the client (secrets omitted).
 * @returns the view; {@link ProxyConfigView.error} carries the last
 *   load/apply failure when the stored config is unusable.
 */
export async function proxyGetConfig() {
    await ensureReady();
    // issue #1282: this view is served to the browser, so it must never carry a
    // secret. Two places can hold one: the separate `password` field and the
    // userinfo of a URL the user pasted in whole. The first is only reported as
    // `passwordSet`; the second is **stripped from `url`** (not masked, not
    // replaced with a placeholder — a masked value still ships the secret's shape
    // and length, and every consumer here only needs the routed destination).
    const embedded = urlCredentials(current.url);
    return {
        enabled: current.enabled,
        url: redactProxyUrl(current.url),
        ...current.username === undefined ? {} : { username: current.username },
        passwordSet: (current.password !== undefined && current.password !== '') || (embedded !== undefined && embedded.password !== ''),
        bypass: [...current.bypass],
        ...configError === undefined ? {} : { error: configError },
    };
}
/**
 * Validate, persist, and apply one proxy config. A `password` of `undefined`
 * keeps the stored value; `null` or `''` clears it.
 * @param input - the client's payload.
 * @returns the resulting view (secrets omitted).
 */
export async function proxySetConfig(input) {
    await ensureReady();
    const password = input.password === undefined
        ? current.password
        : input.password === null || input.password === ''
            ? undefined
            : input.password;
    const next = normalizeConfig({
        enabled: input.enabled,
        url: input.url,
        ...input.username === undefined ? {} : { username: input.username },
        ...password === undefined ? {} : { password },
        bypass: input.bypass ?? current.bypass,
    });
    await persistConfig(next, proxyFilePath());
    await applyConfig(next);
    return proxyGetConfig();
}
/**
 * The fetch caller all subscription code uses: routes through the configured
 * proxy unless the host bypasses it. Identity-passthrough otherwise: the host
 * may itself route global fetch through an environment-configured proxy.
 *
 * Proxied requests run on undici's own fetch (not the global one) so the
 * ProxyAgent dispatcher always comes from the same undici build the request
 * is issued with — a mismatched dispatcher can be silently ignored by the
 * host's global fetch.
 */
export async function proxiedFetch(input, init = {}) {
    await ensureReady();
    let dispatcher;
    if (current.enabled && agent !== undefined) {
        let hostname = '';
        try {
            const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
            hostname = url.hostname;
        }
        catch {
            hostname = '';
        }
        if (!matchesBypass(hostname, current.bypass))
            dispatcher = agent;
    }
    if (dispatcher === undefined)
        return fetch(input, init);
    const proxied = { ...init, dispatcher };
    return dispatchFetch(input, proxied);
}
/**
 * Probe a destination through a proxy, answering with the HTTP status or a
 * flattened transport error. The probe uses `draft` when given (the dialog's
 * current inputs, without saving) and the stored config otherwise.
 * @param target - `http(s)` URL to fetch; defaults to {@link DEFAULT_PROXY_TEST_URL}.
 * @param draft - unsaved proxy inputs to test; absent means the stored config.
 * @returns the result; any HTTP status counts as a successful connection,
 *   only a transport failure is an error.
 */
export async function proxyTestConnection(target = DEFAULT_PROXY_TEST_URL, draft) {
    let parsed;
    try {
        parsed = new URL(target);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            return { ok: false, viaProxy: false, error: `test destination must be http or https (got "${parsed.protocol}//")` };
        }
    }
    catch (error) {
        return { ok: false, viaProxy: false, error: errorMessage(error) };
    }
    await ensureReady();
    let probeAgent;
    let viaProxy;
    let closeProbe = false;
    if (draft !== undefined) {
        // Test the typed values: a throw here is a config problem, not a route one.
        try {
            probeAgent = buildAgent(normalizeConfig({
                enabled: true,
                url: draft.url,
                ...draft.username === undefined || draft.username === '' ? {} : { username: draft.username },
                ...draft.password === undefined || draft.password === '' ? {} : { password: draft.password },
                bypass: [],
            }));
            viaProxy = probeAgent !== undefined;
            closeProbe = true;
        }
        catch (error) {
            return { ok: false, viaProxy: false, error: errorMessage(error) };
        }
    }
    else {
        viaProxy = current.enabled && agent !== undefined && !matchesBypass(parsed.hostname, current.bypass);
        probeAgent = viaProxy ? agent : undefined;
    }
    const started = Date.now();
    try {
        const init = probeAgent !== undefined
            ? { method: 'GET', dispatcher: probeAgent, signal: AbortSignal.timeout(DEFAULT_PROXY_TEST_TIMEOUT_MS) }
            : { method: 'GET', signal: AbortSignal.timeout(DEFAULT_PROXY_TEST_TIMEOUT_MS) };
        const response = probeAgent !== undefined
            ? await dispatchFetch(parsed.toString(), init)
            : await fetch(parsed.toString(), init);
        // Drain so the connection can be released; the body is irrelevant.
        void response.arrayBuffer().catch(() => undefined);
        return { ok: true, viaProxy, status: response.status, latencyMs: Date.now() - started };
    }
    catch (error) {
        return { ok: false, viaProxy, latencyMs: Date.now() - started, error: describeFetchError(error) };
    }
    finally {
        if (closeProbe && probeAgent !== undefined) {
            await probeAgent.close().catch(() => undefined);
        }
    }
}
