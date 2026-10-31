/**
 * Translate between the harness message vocabulary and the Anthropic Messages
 * API wire format used by the claude provider: request message assembly, tool
 * schema mapping, and a push-model SSE-event → StreamChunk state machine
 * ({@link AnthropicStreamTranslator}) so tests need no streams.
 */
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmError, } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '../compat.js';
import { parseSse } from './sse.js';
/**
 * The Claude Code identity block. The subscription endpoint rejects requests
 * that do not present as Claude Code, so this block is REQUIRED as the first
 * system entry on every request.
 */
export const CLAUDE_CODE_IDENTITY = 'You are Claude Code, Anthropic\'s official CLI for Claude.';
/** Tags wrapping a mid-conversation system message where it sits in the history. */
export const SYSTEM_REMINDER_OPEN = '<system-reminder>';
export const SYSTEM_REMINDER_CLOSE = '</system-reminder>';
/**
 * How far apart consecutive message breakpoints sit, in content blocks.
 *
 * A breakpoint looks back at most 20 blocks for an entry an earlier request
 * wrote, so marks must stay closer than that: one agentic turn can append a
 * dozen tool_use/tool_result blocks at once, and a single trailing mark would
 * silently fall out of range and rebuild the whole prefix.
 */
export const CACHE_BLOCK_STRIDE = 15;
/**
 * Message breakpoints per request. Anthropic allows four in total and the
 * last `system` block takes the fourth, so three are left for the history —
 * enough to tolerate a turn appending roughly {@link CACHE_BLOCK_STRIDE} × 3
 * blocks before a read is lost.
 */
export const MESSAGE_CACHE_BREAKPOINTS = 3;
/** The API default; a marker at this TTL carries no `ttl` field at all. */
export const DEFAULT_PROMPT_CACHE_TTL = '5m';
/**
 * Build one `cache_control` marker.
 *
 * Five minutes is spelled by omitting `ttl`, so a request that does not opt in
 * stays byte-identical to what earlier releases sent.
 * @param ttl - cache lifetime; defaults to five minutes.
 * @returns a fresh marker object (callers attach it to one block each).
 */
export function cacheControl(ttl = DEFAULT_PROMPT_CACHE_TTL) {
    return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}
/** Preserve native image blocks, retaining the existing text-only wire shape. */
function toolResultContent(block) {
    if (!block.content.some(part => part.type === 'image' && 'dataBase64' in part)) {
        return block.content.map(part => (part.type === 'text' ? part.text : '')).join('');
    }
    const content = [];
    for (const part of block.content) {
        if (part.type === 'text' && part.text.length > 0)
            content.push({ type: 'text', text: part.text });
        if (part.type === 'image' && 'dataBase64' in part) {
            content.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.dataBase64 } });
        }
    }
    return content;
}
/** Parse a tool call's raw JSON arguments into Anthropic's object-shaped `input`. */
function parseToolInput(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return parsed;
        }
        return {};
    }
    catch {
        // The model produced malformed JSON; an empty object keeps the request valid.
        return {};
    }
}
/**
 * Move a user message's `tool_result` blocks into one contiguous run at the
 * front, preserving the relative order of both groups.
 *
 * Anthropic answers every `tool_use` against the blocks that *lead* the next
 * message, so a block of any other kind before or between the results reads
 * as a call left unanswered and the request is rejected. The harness merges
 * everything queued for one user turn into a single message, and a parallel
 * tool batch arrives as one result message per call, so any context spliced
 * mid-batch lands between two results. Restoring the run here keeps that
 * independent of delivery order. Order *among* the results does not matter.
 * @param message - one assembled user message, reordered in place.
 */
function leadWithToolResults(message) {
    const firstOther = message.content.findIndex(block => block.type !== 'tool_result');
    if (firstOther === -1)
        return;
    if (!message.content.slice(firstOther).some(block => block.type === 'tool_result'))
        return;
    message.content = [
        ...message.content.filter(block => block.type === 'tool_result'),
        ...message.content.filter(block => block.type !== 'tool_result'),
    ];
}
/**
 * Index of the first non-system message; `messages.length` when every message
 * is a system one.
 *
 * A system message before the conversation starts is the operator's opening
 * instruction and belongs in the `system` slot. One that arrives later is
 * mid-conversation context, and hoisting it into `system` would move bytes in
 * front of the whole history — invalidating every cached turn behind it — so
 * it stays where it is, as a reminder block in `messages`.
 * @param messages - ordered conversation messages.
 * @returns the boundary index separating the two.
 */
function conversationStart(messages) {
    const index = messages.findIndex(message => message.role !== 'system');
    return index === -1 ? messages.length : index;
}
/**
 * Convert harness messages into Anthropic messages. Consecutive same-role
 * messages merge into one message with multiple content blocks; tool results
 * arrive as user messages with `tool_result` blocks, which a merged user
 * message keeps in one leading run ({@link leadWithToolResults}); system-role
 * messages before the conversation starts are handled by
 * {@link toAnthropicSystem} and skipped here, while a later one rides in
 * place as a user-role `<system-reminder>` block.
 * Reasoning blocks are not replayed (v1). Images must arrive pre-resolved
 * ({@link TranslatableMessage}); an unresolved ImageBlock is skipped because
 * its bytes are unreachable here.
 * @param messages - ordered conversation messages with resolved images.
 * @returns Anthropic messages in conversation order.
 */
export function toAnthropicMessages(messages) {
    const out = [];
    const start = conversationStart(messages);
    for (const [index, message] of messages.entries()) {
        // A leading system message is an opening instruction; toAnthropicSystem
        // owns those. A later one rides here so the cached prefix ahead of it
        // stays byte-identical.
        if (message.role === 'system' && index < start)
            continue;
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        const blocks = [];
        if (message.role === 'tool') {
            const id = message.toolCallId ?? message.tool_call_id
                ?? (message.source?.kind === 'tool' ? String(message.source.callId) : undefined);
            if (id === undefined)
                throw new LlmError('tool result has no call id', 'INVALID_REQUEST');
            blocks.push({
                type: 'tool_result',
                tool_use_id: id,
                content: toolResultContent({ type: 'tool-result', toolCallId: ToolCallId(id), content: message.content }),
                ...message.isError === true ? { is_error: true } : {},
            });
            const last = out[out.length - 1];
            if (last?.role === 'user')
                last.content.push(...blocks);
            else
                out.push({ role: 'user', content: blocks });
            continue;
        }
        for (const block of message.content) {
            switch (block.type) {
                case 'text':
                    blocks.push({
                        type: 'text',
                        text: message.role === 'system'
                            ? `${SYSTEM_REMINDER_OPEN}${block.text}${SYSTEM_REMINDER_CLOSE}`
                            : block.text,
                    });
                    break;
                case 'tool-call':
                    // Anthropic accepts `tool_use` only in assistant messages, and only
                    // when a matching `tool_result` follows. A tool call in any other
                    // role is replayed narrative — a settled subagent's closing message
                    // spliced into the parent as a user-role notice carries the calls it
                    // died holding, which no result will ever answer — so it rides as
                    // descriptive text instead of a call the API would reject.
                    blocks.push(role === 'assistant'
                        ? {
                            type: 'tool_use',
                            id: String(block.id),
                            name: block.name,
                            input: parseToolInput(block.arguments),
                        }
                        : { type: 'text', text: `[tool call ${block.name}: ${block.arguments}]` });
                    break;
                case 'tool-result':
                    blocks.push({
                        type: 'tool_result',
                        tool_use_id: String(block.toolCallId),
                        content: toolResultContent(block),
                        ...block.isError === true ? { is_error: true } : {},
                    });
                    break;
                case 'image':
                    if ('dataBase64' in block) {
                        blocks.push({
                            type: 'image',
                            source: { type: 'base64', media_type: block.mediaType, data: block.dataBase64 },
                        });
                    }
                    // An unresolved ImageBlock carries only an attachment reference; the
                    // adapter resolves images before translation, so this is skipped.
                    break;
                default:
                    // reasoning (not replayed), unknown blocks.
                    break;
            }
        }
        if (blocks.length === 0)
            continue;
        const last = out[out.length - 1];
        if (last !== undefined && last.role === role)
            last.content.push(...blocks);
        else
            out.push({ role, content: blocks });
    }
    for (const message of out) {
        if (message.role === 'user')
            leadWithToolResults(message);
    }
    return out;
}
/**
 * Mark the conversation's cache breakpoints in place: the last content block,
 * then one every {@link CACHE_BLOCK_STRIDE} blocks backwards, {@link
 * MESSAGE_CACHE_BREAKPOINTS} in total.
 *
 * The history is append-only, so the block one request marks last is
 * byte-identical in the next — that entry is what the next request reads.
 * Marks are counted across the flattened block sequence, not per message,
 * because the lookback window Anthropic walks counts blocks the same way.
 * @param messages - assembled Anthropic messages, marked in place.
 * @param ttl - cache lifetime for every mark; defaults to five minutes.
 */
export function markMessageCache(messages, ttl) {
    const blocks = messages.flatMap(message => message.content);
    for (let mark = 0; mark < MESSAGE_CACHE_BREAKPOINTS; mark++) {
        const at = blocks.length - 1 - mark * CACHE_BLOCK_STRIDE;
        if (at < 0)
            return;
        blocks[at].cache_control = cacheControl(ttl);
    }
}
/**
 * Build the Anthropic `system` array: the mandatory Claude Code identity
 * block, then the explicit system prompt, then any system-role messages.
 * @param system - explicit system prompt, when set.
 * @param messages - conversation messages; the system-role text preceding the
 * conversation is appended, and a later one is left to {@link toAnthropicMessages}.
 * @param ttl - cache lifetime for the tools+system mark; defaults to five minutes.
 * @returns the system content blocks.
 */
export function toAnthropicSystem(system, messages, ttl) {
    const blocks = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }];
    if (system !== undefined && system.length > 0)
        blocks.push({ type: 'text', text: system });
    const history = messages ?? [];
    for (const message of history.slice(0, conversationStart(history))) {
        for (const block of message.content) {
            if (block.type === 'text')
                blocks.push({ type: 'text', text: block.text });
        }
    }
    // `tools` renders ahead of `system`, so this one marker caches both. It is
    // deliberately separate from the message marks: a tool_choice or thinking
    // change invalidates the messages tier only, and this entry survives it.
    //
    // Anthropic processes `tools`, `system`, then `messages`, and rejects a
    // one-hour mark that follows a five-minute one (HTTP 400). This mark and the
    // message marks therefore share one TTL, which can never hit that ordering.
    blocks[blocks.length - 1].cache_control = cacheControl(ttl);
    return blocks;
}
/**
 * Map harness tool schemas to Anthropic tools, in name order.
 *
 * `tools` renders at position 0 of the cached prefix, so any reordering
 * invalidates every cache entry behind it — `system` and the whole
 * conversation included. Registration order belongs to the caller and plugin
 * load order can differ between processes, so the wire order is fixed here
 * instead. Anthropic selects a tool by name; the array order carries nothing.
 * @param tools - tool schemas from the request.
 * @returns Anthropic `tools` array entries, ordered by tool name.
 */
export function toAnthropicTools(tools) {
    return [...tools]
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        .map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
    }));
}
/** Assemble the final ContentBlock for one open block. */
function closeBlock(block) {
    switch (block.kind) {
        case 'text':
            return { type: 'text', text: block.text };
        case 'reasoning':
            return { type: 'reasoning', text: block.text };
        case 'tool-call':
            return {
                type: 'tool-call',
                id: ToolCallId(block.callId),
                name: block.name ?? '',
                arguments: block.text,
            };
    }
}
/**
 * Classify an Anthropic `error` event into a thrown LlmError.
 * @param error - the wire error object.
 * @returns the mapped error.
 */
export function anthropicFailure(error) {
    const type = error?.type ?? 'unknown_error';
    const message = error?.message ?? `Anthropic reported ${type}`;
    if (type === 'invalid_request_error' && /prompt is too long/i.test(message)) {
        return new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE);
    }
    if (type === 'rate_limit_error')
        return new LlmError(message, 'RATE_LIMIT');
    if (type === 'authentication_error')
        return new LlmError(message, 'AUTH');
    return new LlmError(message, 'SERVER');
}
/**
 * Push-model Anthropic SSE translator: feed each parsed event object to
 * {@link push} and collect the emitted harness StreamChunks. Block indexes
 * are allocated in first-seen order; `usage` is emitted before the terminal
 * `finish`, and nothing is emitted after it. `error` events throw
 * {@link LlmError}.
 */
export class AnthropicStreamTranslator {
    blocks = new Map();
    nextIndex = 0;
    sawAnyBlock = false;
    pendingUsage;
    outputTokens;
    stopReason = 'stop';
    usageEmitted = false;
    /** Set once `message_stop` produced the terminal finish chunk. */
    terminated = false;
    open(wireIndex, kind, chunks, callId = '', name) {
        const block = {
            index: this.nextIndex++,
            kind,
            text: '',
            callId,
            ...name === undefined ? {} : { name },
        };
        this.blocks.set(wireIndex, block);
        this.sawAnyBlock = true;
        chunks.push({ type: 'block-start', index: block.index, blockType: kind });
        return block;
    }
    emitUsage(chunks) {
        if (this.usageEmitted)
            return;
        this.usageEmitted = true;
        const usage = {
            inputTokens: this.pendingUsage?.inputTokens ?? 0,
            outputTokens: this.outputTokens ?? 0,
            ...this.pendingUsage?.cacheReadTokens !== undefined
                ? { cacheReadTokens: this.pendingUsage.cacheReadTokens }
                : {},
            ...this.pendingUsage?.cacheWriteTokens !== undefined
                ? { cacheWriteTokens: this.pendingUsage.cacheWriteTokens }
                : {},
        };
        chunks.push({ type: 'usage', usage });
    }
    /**
     * Process one parsed Anthropic SSE event.
     * @param event - the parsed event object.
     * @returns the StreamChunks this event produced (possibly none).
     */
    push(event) {
        if (this.terminated)
            return [];
        const chunks = [];
        switch (event.type) {
            case 'message_start': {
                const usage = event.message?.usage;
                if (usage !== undefined) {
                    this.pendingUsage = {
                        inputTokens: usage.input_tokens ?? 0,
                        ...usage.cache_read_input_tokens !== undefined
                            ? { cacheReadTokens: usage.cache_read_input_tokens }
                            : {},
                        ...usage.cache_creation_input_tokens !== undefined
                            ? { cacheWriteTokens: usage.cache_creation_input_tokens }
                            : {},
                    };
                    this.outputTokens = usage.output_tokens ?? this.outputTokens;
                }
                return chunks;
            }
            case 'content_block_start': {
                const wireIndex = event.index ?? 0;
                const block = event.content_block;
                switch (block?.type) {
                    case 'text':
                        this.open(wireIndex, 'text', chunks);
                        break;
                    case 'thinking':
                        this.open(wireIndex, 'reasoning', chunks);
                        break;
                    case 'tool_use': {
                        const opened = this.open(wireIndex, 'tool-call', chunks, block.id ?? '', block.name);
                        chunks.push({
                            type: 'tool-call-delta',
                            index: opened.index,
                            id: ToolCallId(opened.callId),
                            ...block.name === undefined ? {} : { name: block.name },
                            argumentsDelta: '',
                        });
                        break;
                    }
                    default:
                        break;
                }
                return chunks;
            }
            case 'content_block_delta': {
                const wireIndex = event.index ?? 0;
                const block = this.blocks.get(wireIndex);
                const delta = event.delta;
                if (block === undefined || delta === undefined)
                    return chunks;
                switch (delta.type) {
                    case 'text_delta':
                        block.text += delta.text ?? '';
                        chunks.push({ type: 'text-delta', index: block.index, text: delta.text ?? '' });
                        break;
                    case 'thinking_delta':
                        block.text += delta.thinking ?? '';
                        chunks.push({ type: 'reasoning-delta', index: block.index, text: delta.thinking ?? '' });
                        break;
                    case 'input_json_delta':
                        block.text += delta.partial_json ?? '';
                        chunks.push({
                            type: 'tool-call-delta',
                            index: block.index,
                            id: ToolCallId(block.callId),
                            ...block.name === undefined ? {} : { name: block.name },
                            argumentsDelta: delta.partial_json ?? '',
                        });
                        break;
                    default:
                        // signature_delta and future deltas carry no harness content.
                        break;
                }
                return chunks;
            }
            case 'content_block_stop': {
                const wireIndex = event.index ?? 0;
                const block = this.blocks.get(wireIndex);
                if (block === undefined)
                    return chunks;
                this.blocks.delete(wireIndex);
                chunks.push({ type: 'block-end', index: block.index, block: closeBlock(block) });
                return chunks;
            }
            case 'message_delta': {
                if (event.usage?.output_tokens !== undefined)
                    this.outputTokens = event.usage.output_tokens;
                switch (event.delta?.stop_reason) {
                    case 'end_turn':
                    case 'stop_sequence':
                        this.stopReason = 'stop';
                        break;
                    case 'tool_use':
                        this.stopReason = 'tool-calls';
                        break;
                    case 'max_tokens':
                        this.stopReason = 'max-tokens';
                        break;
                    default:
                        break;
                }
                return chunks;
            }
            case 'message_stop': {
                this.terminated = true;
                for (const [wireIndex, block] of [...this.blocks]) {
                    this.blocks.delete(wireIndex);
                    chunks.push({ type: 'block-end', index: block.index, block: closeBlock(block) });
                }
                this.emitUsage(chunks);
                if (this.stopReason === 'stop' && !this.sawAnyBlock) {
                    chunks.push({
                        type: 'finish',
                        reason: {
                            kind: 'error',
                            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
                        },
                    });
                }
                else {
                    chunks.push({ type: 'finish', reason: { kind: this.stopReason } });
                }
                return chunks;
            }
            case 'error':
                throw anthropicFailure(event.error);
            default:
                // ping and future event types carry no harness content.
                return chunks;
        }
    }
}
/**
 * Consume an Anthropic SSE byte stream and yield harness StreamChunks.
 * @param stream - raw response body.
 * @param onActivity - transport-activity callback for the idle watchdog.
 * @returns the chunk stream; throws when the stream ends before `message_stop`.
 */
export async function* streamAnthropic(stream, onActivity) {
    const translator = new AnthropicStreamTranslator();
    for await (const sseEvent of parseSse(stream, onActivity)) {
        let event;
        try {
            event = JSON.parse(sseEvent.data);
        }
        catch {
            throw new LlmError(`malformed SSE payload: ${sseEvent.data.slice(0, 120)}`, 'MALFORMED_RESPONSE');
        }
        yield* translator.push(event);
        if (translator.terminated)
            return;
    }
    throw new LlmError('Anthropic SSE stream ended before message_stop', 'STREAM_CLOSED');
}
