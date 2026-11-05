/** Codex-backed provider for DSH's native web_search capability. */
import { randomUUID } from 'node:crypto';
import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import { WebError } from '@deepseek-ai/dsh-web';
export const CODEX_SEARCH_PROVIDER_ID = 'codex';
export const CODEX_SEARCH_URL = 'https://chatgpt.com/backend-api/codex/alpha/search';
export const CODEX_SEARCH_MODEL = 'gpt-5.6-terra';
const MAX_ATTEMPTS = 5;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RETRY_BASE_MS = 100;
/** Search provider registered behind DSH's stock web_search tool and citation UI. */
export class CodexWebSearchProvider {
    options;
    id = CODEX_SEARCH_PROVIDER_ID;
    constructor(options) {
        this.options = options;
    }
    available() { return this.options.enabled?.() ?? true; }
    async search(request, signal) {
        throwIfAborted(signal);
        let session;
        try {
            session = await this.options.tokens.session();
        }
        catch (cause) {
            throw new WebError('Codex Web Search requires a logged-in Codex account; log in via Settings → Subscriptions', 'CODEX_AUTH_REQUIRED', { cause });
        }
        const body = {
            id: this.options.requestId?.() ?? randomUUID(),
            model: CODEX_SEARCH_MODEL,
            input: request.query,
            commands: { search_query: [{ q: request.query }] },
            settings: {
                search_context_size: 'medium',
                allowed_callers: ['direct'],
                external_web_access: 'live',
            },
            max_output_tokens: 2048,
        };
        const value = await this.dispatch(body, session, signal);
        return normalizeCodexSearchResponse(value);
    }
    async dispatch(body, session, signal) {
        const fetchFn = this.options.fetchFn ?? fetch;
        const retryBaseMs = this.options.retryBaseMs ?? RETRY_BASE_MS;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            throwIfAborted(signal);
            let response;
            try {
                response = await fetchFn(CODEX_SEARCH_URL, {
                    method: 'POST',
                    headers: {
                        'authorization': `Bearer ${session.accessToken}`,
                        'chatgpt-account-id': session.accountId,
                        'content-type': 'application/json',
                        'originator': 'codex_cli_rs',
                        ...attributionHeaders(),
                    },
                    body: JSON.stringify(body),
                    ...(signal === undefined ? {} : { signal }),
                });
            }
            catch (cause) {
                if (signal?.aborted)
                    throw cancelled(cause);
                if (attempt < MAX_ATTEMPTS) {
                    await abortableDelay(retryBaseMs * 2 ** (attempt - 1), signal);
                    continue;
                }
                throw new WebError('Codex Web Search failed after five transport attempts', 'CODEX_SEARCH_NETWORK', { cause });
            }
            if (response.status === 429) {
                await discard(response);
                throw new WebError('Codex Web Search was rate-limited; retry later', 'CODEX_SEARCH_RATE_LIMIT');
            }
            if (response.status >= 500 && response.status <= 599 && attempt < MAX_ATTEMPTS) {
                await discard(response);
                await abortableDelay(retryBaseMs * 2 ** (attempt - 1), signal);
                continue;
            }
            if (!response.ok) {
                await discard(response);
                throw new WebError(`Codex Web Search returned HTTP ${response.status}`, 'CODEX_SEARCH_UPSTREAM');
            }
            const text = await boundedText(response, signal);
            try {
                return JSON.parse(text);
            }
            catch (cause) {
                throw new WebError('Codex Web Search returned invalid JSON', 'CODEX_SEARCH_RESPONSE', { cause });
            }
        }
        throw new WebError('Codex Web Search exhausted its retry policy', 'CODEX_SEARCH_UPSTREAM');
    }
}
export function normalizeCodexSearchResponse(value) {
    if (!record(value) || typeof value.output !== 'string') {
        throw new WebError('Codex Web Search returned an unusable response', 'CODEX_SEARCH_RESPONSE');
    }
    const sources = [];
    const seen = new Set();
    if (Array.isArray(value.results))
        for (const candidate of value.results) {
            if (!record(candidate))
                continue;
            const rawUrl = safeString(candidate.url, 8192) ?? safeString(candidate.source_url, 8192);
            const url = rawUrl === undefined ? undefined : httpUrl(rawUrl);
            if (url === undefined || seen.has(url))
                continue;
            seen.add(url);
            const title = safeString(candidate.title, 1000) ?? safeString(candidate.source_title, 1000);
            const snippet = safeString(candidate.snippet, 4000) ?? safeString(candidate.text, 4000);
            sources.push({ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) });
        }
    return { content: value.output, sources, truncated: false };
}
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function safeString(value, max) {
    if (typeof value !== 'string')
        return undefined;
    const text = value.trim();
    if (!text || text.length > max || /[\u0000-\u001f]/.test(text))
        return undefined;
    return text;
}
function httpUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined;
    }
    catch {
        return undefined;
    }
}
async function discard(response) {
    try {
        await response.body?.cancel();
    }
    catch { /* best effort */ }
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw cancelled(signal.reason);
}
function cancelled(cause) {
    return new WebError('Codex Web Search was cancelled', 'CODEX_SEARCH_CANCELLED', { cause });
}
function abortableDelay(ms, signal) {
    if (ms <= 0) {
        throwIfAborted(signal);
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
        const onAbort = () => { cleanup(); reject(cancelled(signal?.reason)); };
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
async function boundedText(response, signal) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        await discard(response);
        throw new WebError('Codex Web Search response exceeded the safe size limit', 'CODEX_SEARCH_RESPONSE_TOO_LARGE');
    }
    if (response.body === null)
        return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    try {
        while (true) {
            throwIfAborted(signal);
            const chunk = await reader.read();
            if (chunk.done)
                break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES)
                throw new WebError('Codex Web Search response exceeded the safe size limit', 'CODEX_SEARCH_RESPONSE_TOO_LARGE');
            text += decoder.decode(chunk.value, { stream: true });
        }
        return text + decoder.decode();
    }
    catch (cause) {
        if (signal?.aborted)
            throw cancelled(cause);
        throw cause;
    }
    finally {
        try {
            reader.releaseLock();
        }
        catch { /* best effort */ }
    }
}
