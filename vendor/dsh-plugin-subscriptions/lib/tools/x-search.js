/**
 * `x_search` tool: run xAI's hosted X (Twitter) search through the grok
 * subscription's OAuth session. The wire call is a non-streaming Responses
 * request carrying the built-in `x_search` tool definition; the canonical
 * output is `{ answer, citations }`.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { httpLlmError } from '../providers/common.js';
import { AccountTokenManager } from '../providers/accounts.js';
import { proxiedFetch } from '../http.js';
/** Endpoint the search request is posted to. */
export const X_SEARCH_URL = 'https://api.x.ai/v1/responses';
/** Grok model the search runs on (a catalog model of the grok provider). */
export const X_SEARCH_MODEL = 'grok-4';
/** xAI caps each handle filter list at ten entries. */
const MAX_HANDLES = 10;
/**
 * Validate and assemble the request facts from tool arguments. Throws plain
 * Errors for argument problems the schema DSL cannot express (non-empty
 * query, handle caps, mutually exclusive filters).
 */
export function buildXSearchRequest(args) {
    const query = args.query.trim();
    if (query.length === 0)
        throw new Error('x_search: query must be a non-empty string');
    const allowed = normalizeHandles(args.allowed_x_handles, 'allowed_x_handles');
    const excluded = normalizeHandles(args.excluded_x_handles, 'excluded_x_handles');
    if (allowed.length > 0 && excluded.length > 0) {
        throw new Error('x_search: allowed_x_handles and excluded_x_handles cannot be used together');
    }
    const tool = { type: 'x_search' };
    if (allowed.length > 0)
        tool.allowed_x_handles = allowed;
    if (excluded.length > 0)
        tool.excluded_x_handles = excluded;
    if (args.from_date !== undefined && args.from_date.trim().length > 0)
        tool.from_date = args.from_date.trim();
    if (args.to_date !== undefined && args.to_date.trim().length > 0)
        tool.to_date = args.to_date.trim();
    if (args.enable_image_understanding === true)
        tool.enable_image_understanding = true;
    if (args.enable_video_understanding === true)
        tool.enable_video_understanding = true;
    return { query, tool };
}
/** Strip `@` prefixes, drop blanks, and enforce the provider's handle cap. */
function normalizeHandles(value, field) {
    if (value === undefined)
        return [];
    const handles = value.map(handle => handle.trim().replace(/^@+/, '')).filter(handle => handle.length > 0);
    if (handles.length > MAX_HANDLES)
        throw new Error(`x_search: ${field} supports at most ${MAX_HANDLES} handles`);
    return handles;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Extract the answer text and citation URLs from a Responses payload: the
 * `output_text` shortcut or message output parts for the answer, and both
 * top-level `citations` and inline `url_citation` annotations for sources.
 */
export function parseXSearchResponse(payload) {
    const body = isRecord(payload) ? payload : {};
    let answer = typeof body.output_text === 'string' ? body.output_text.trim() : '';
    const citations = [];
    const push = (url) => {
        if (typeof url === 'string' && url.length > 0 && !citations.includes(url))
            citations.push(url);
    };
    if (Array.isArray(body.citations)) {
        for (const citation of body.citations)
            push(citation);
    }
    const parts = [];
    if (Array.isArray(body.output)) {
        for (const item of body.output) {
            if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content))
                continue;
            for (const part of item.content) {
                if (!isRecord(part))
                    continue;
                if ((part.type === 'output_text' || part.type === 'text')
                    && typeof part.text === 'string' && part.text.trim().length > 0) {
                    parts.push(part.text.trim());
                }
                if (Array.isArray(part.annotations)) {
                    for (const annotation of part.annotations) {
                        if (isRecord(annotation) && annotation.type === 'url_citation')
                            push(annotation.url);
                    }
                }
            }
        }
    }
    if (answer.length === 0)
        answer = parts.join('\n\n');
    return { answer, citations };
}
/** Bound a call-card title's query. */
function truncate(text, max = 60) {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
/**
 * Build the `x_search` tool definition.
 * @param options - grok session source and fetch implementation.
 * @returns the tool to register on `ctx.tools`.
 */
export function createXSearchTool(options) {
    return defineTool({
        name: 'x_search',
        description: "Search X (Twitter) posts, profiles, and threads using the grok subscription's hosted xAI x_search. "
            + 'Use this for current discussion, reactions, or claims on X rather than general web pages.',
        parameters: {
            query: { type: 'string', required: true, description: 'What to look up on X.' },
            allowed_x_handles: {
                type: 'array',
                items: { type: 'string' },
                description: 'X handles to include exclusively (max 10).',
            },
            excluded_x_handles: {
                type: 'array',
                items: { type: 'string' },
                description: 'X handles to exclude (max 10).',
            },
            from_date: { type: 'string', description: 'Optional start date in YYYY-MM-DD format.' },
            to_date: { type: 'string', description: 'Optional end date in YYYY-MM-DD format.' },
            enable_image_understanding: {
                type: 'boolean',
                description: 'Whether xAI should analyze images attached to matching posts.',
            },
            enable_video_understanding: {
                type: 'boolean',
                description: 'Whether xAI should analyze videos attached to matching posts.',
            },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    answer: { type: 'string', required: true },
                    citations: { type: 'array', items: { type: 'string' }, required: true },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.citations.length > 0
                        ? `${value.answer}\n\nSources:\n${value.citations.map(citation => `- ${citation}`).join('\n')}`
                        : value.answer,
                }],
            presentationMeta: (_args, value) => ({ answer: value.answer, citations: value.citations }),
        },
        presentCall: args => ({
            card: 'generic',
            title: `x_search: ${truncate(args.query)}`,
            kind: 'search',
        }),
        presentResult: (_args, result) => {
            if (result.isError || !isRecord(result.meta))
                return undefined;
            const citations = Array.isArray(result.meta.citations) ? result.meta.citations : [];
            return {
                card: 'web',
                kind: 'search',
                sources: citations.filter((citation) => typeof citation === 'string')
                    .map(url => ({ url })),
                ...typeof result.meta.answer === 'string' && result.meta.answer.length > 0
                    ? { answer: result.meta.answer }
                    : {},
                truncated: false,
            };
        },
        async execute(args, exec) {
            const request = buildXSearchRequest(args);
            const session = await options.tokens.session();
            const response = await (options.fetchFn ?? proxiedFetch)(X_SEARCH_URL, {
                method: 'POST',
                headers: {
                    'authorization': `Bearer ${session.accessToken}`,
                    'content-type': 'application/json',
                    'accept': 'application/json',
                },
                body: JSON.stringify({
                    model: X_SEARCH_MODEL,
                    input: [{ role: 'user', content: request.query }],
                    tools: [request.tool],
                    store: false,
                }),
                signal: exec.signal,
            });
            if (!response.ok)
                throw await httpLlmError(response, 'x_search');
            return parseXSearchResponse(await response.json());
        },
    });
}
