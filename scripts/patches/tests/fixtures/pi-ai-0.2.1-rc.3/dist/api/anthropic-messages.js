import Anthropic, {} from "@anthropic-ai/sdk";
import { ANTHROPIC_FEDERATION_RULE_ID_ENV, ANTHROPIC_IDENTITY_TOKEN_FILE_ENV, ANTHROPIC_ORGANIZATION_ID_ENV, ANTHROPIC_SERVICE_ACCOUNT_ID_ENV, ANTHROPIC_WORKSPACE_ID_ENV, } from "../env-api-keys.js";
import { calculateCost } from "../models.js";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.js";
import { getPiUserAgent } from "../utils/pi-user-agent.js";
import { getProviderEnvValue } from "../utils/provider-env.js";
import { retryProviderRequest } from "../utils/provider-retry.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.js";
import { getCurrentTools, getInitialSystemMessage, resolveTranscript, } from "../utils/transcript.js";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling, } from "./constrained-sampling.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import { adjustMaxTokensForThinking, buildBaseOptions, clampMaxTokensToContext } from "./simple-options.js";
import { transformMessages } from "./transform-messages.js";
/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention, env) {
    if (cacheRetention) {
        return cacheRetention;
    }
    if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
        return "long";
    }
    return "short";
}
function getCacheControl(model, cacheRetention, env) {
    const retention = resolveCacheRetention(cacheRetention, env);
    if (retention === "none") {
        return { retention };
    }
    const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
    return {
        retention,
        cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
    };
}
// Stealth mode: Mimic Claude Code's tool naming exactly
const claudeCodeVersion = "2.1.280";
// Claude Code 2.x tool names (canonical casing)
// Source: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// To update: https://github.com/badlogic/cchistory
const claudeCodeTools = [
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Grep",
    "Glob",
    "AskUserQuestion",
    "EnterPlanMode",
    "ExitPlanMode",
    "KillShell",
    "NotebookEdit",
    "Skill",
    "Task",
    "TaskOutput",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
];
const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));
// Convert tool name to CC canonical casing if it matches (case-insensitive)
const toClaudeCodeName = (name) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name, tools) => {
    if (tools && tools.length > 0) {
        const lowerName = name.toLowerCase();
        const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
        if (matchedTool)
            return matchedTool.name;
    }
    return name;
};
/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content) {
    // If only text blocks, return as concatenated string for simplicity
    const hasImages = content.some((c) => c.type === "image");
    if (!hasImages) {
        return sanitizeSurrogates(content.map((c) => c.text).join("\n"));
    }
    // If we have images, convert to content block array
    const blocks = content.map((block) => {
        if (block.type === "text") {
            return {
                type: "text",
                text: sanitizeSurrogates(block.text),
            };
        }
        return {
            type: "image",
            source: {
                type: "base64",
                media_type: block.mimeType,
                data: block.data,
            },
        };
    });
    // If only images (no text), add placeholder text block
    const hasText = blocks.some((b) => b.type === "text");
    if (!hasText) {
        blocks.unshift({
            type: "text",
            text: "(see attached image)",
        });
    }
    return blocks;
}
const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MID_CONVERSATION_OUTPUT_CONFIG_BETA = "mid-conversation-output-config-2026-07-01";
const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";
const INLINE_TOOLS_BETA = "inline-tools-2026-09-15";
/**
 * Stable deferred tool declared whenever native tool changes are in use. Anthropic adds
 * hidden prompt scaffolding for mid-conversation tool changes; declaring this placeholder
 * from the first request keeps that scaffolding in the cached prefix, so the first tool
 * change does not invalidate the cache (measured: full miss without it). It is never
 * activated and the model cannot see it.
 */
const DEFERRED_TOOL_PLACEHOLDER = {
    name: "__pi_deferred_placeholder__",
    description: "Reserved placeholder. Never available. Never call this.",
    input_schema: { type: "object", properties: {}, required: [] },
    defer_loading: true,
};
function shouldUseServerSideFallbackBeta(model) {
    return (model.compat?.allowedFallbackModels?.length ?? 0) > 0;
}
function getAnthropicCompat(model) {
    const isOpenRouter = model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
    return {
        supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
        supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
        sendSessionAffinityHeaders: model.compat?.sendSessionAffinityHeaders ?? isOpenRouter,
        sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? (isOpenRouter ? "openrouter" : undefined),
        supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? true,
        supportsTemperature: model.compat?.supportsTemperature ?? true,
        allowEmptySignature: model.compat?.allowEmptySignature ?? false,
        supportsStrictTools: model.compat?.supportsStrictTools ?? false,
        supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
        supportsMidConvoToolChanges: model.compat?.supportsMidConvoToolChanges ?? false,
    };
}
function mergeHeaders(...headerSources) {
    const merged = {};
    for (const headers of headerSources) {
        if (headers) {
            Object.assign(merged, headers);
        }
    }
    return merged;
}
function mergeClientHeaders(...headerSources) {
    return mergeHeaders({ "User-Agent": getPiUserAgent() }, ...headerSources);
}
function hasHeader(headers, name) {
    if (!headers)
        return false;
    const expected = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === expected && value !== null && value.trim().length > 0)
            return true;
    }
    return false;
}
function hasRequestAuth(apiKey, headers) {
    return (!!apiKey ||
        hasHeader(headers, "authorization") ||
        hasHeader(headers, "x-api-key") ||
        hasHeader(headers, "cf-aig-authorization"));
}
function assertRequestAuth(provider, apiKey, headers) {
    if (!hasRequestAuth(apiKey, headers))
        throw new Error(`No API key for provider: ${provider}`);
}
/**
 * Anthropic SDK client that never runs the SDK's own credential chain
 * (ANTHROPIC_PROFILE config files, federation env vars). Without this, every
 * client built with `apiKey: null, authToken: null` for header-owned auth would
 * also resolve and exchange SDK credentials behind pi's auth resolver.
 */
class PiAnthropic extends Anthropic {
    _shouldResolveDefaultCredentials() {
        return false;
    }
}
/**
 * Workload identity federation config from the ANTHROPIC_* variables the
 * Anthropic SDK documents; the SDK performs the token exchange and refresh.
 * Only for the anthropic provider, since the exchange is an Anthropic API
 * endpoint, and only when no key or auth header was resolved.
 */
function getAnthropicFederation(model, apiKey, headers, env) {
    if (model.provider !== "anthropic" || hasRequestAuth(apiKey, headers))
        return undefined;
    const federationRuleId = getProviderEnvValue(ANTHROPIC_FEDERATION_RULE_ID_ENV, env);
    const organizationId = getProviderEnvValue(ANTHROPIC_ORGANIZATION_ID_ENV, env);
    const identityTokenFile = getProviderEnvValue(ANTHROPIC_IDENTITY_TOKEN_FILE_ENV, env);
    if (!federationRuleId || !organizationId || !identityTokenFile)
        return undefined;
    return {
        organization_id: organizationId,
        workspace_id: getProviderEnvValue(ANTHROPIC_WORKSPACE_ID_ENV, env),
        authentication: {
            type: "oidc_federation",
            federation_rule_id: federationRuleId,
            service_account_id: getProviderEnvValue(ANTHROPIC_SERVICE_ACCOUNT_ID_ENV, env),
            identity_token: { source: "file", path: identityTokenFile },
        },
    };
}
/**
 * The SDK caches the federated access token per client, but pi creates a client
 * per request. Keep one client for the current federation config and fetch, and
 * clone it per request with `withOptions()`, which shares the token cache.
 */
let federationClient;
const ANTHROPIC_MESSAGE_EVENTS = new Set([
    "message_start",
    "message_delta",
    "message_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
]);
function flushSseEvent(state) {
    if (!state.event && state.data.length === 0) {
        return null;
    }
    const event = {
        event: state.event,
        data: state.data.join("\n"),
        raw: [...state.raw],
    };
    state.event = null;
    state.data = [];
    state.raw = [];
    return event;
}
function decodeSseLine(line, state) {
    if (line === "") {
        return flushSseEvent(state);
    }
    state.raw.push(line);
    if (line.startsWith(":")) {
        return null;
    }
    const delimiterIndex = line.indexOf(":");
    const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
    let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
    if (value.startsWith(" ")) {
        value = value.slice(1);
    }
    if (fieldName === "event") {
        state.event = value;
    }
    else if (fieldName === "data") {
        state.data.push(value);
    }
    return null;
}
function nextLineBreakIndex(text) {
    const carriageReturnIndex = text.indexOf("\r");
    const newlineIndex = text.indexOf("\n");
    if (carriageReturnIndex === -1) {
        return newlineIndex;
    }
    if (newlineIndex === -1) {
        return carriageReturnIndex;
    }
    return Math.min(carriageReturnIndex, newlineIndex);
}
function consumeLine(text) {
    const lineBreakIndex = nextLineBreakIndex(text);
    if (lineBreakIndex === -1) {
        return null;
    }
    let nextIndex = lineBreakIndex + 1;
    if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
        nextIndex += 1;
    }
    return {
        line: text.slice(0, lineBreakIndex),
        rest: text.slice(nextIndex),
    };
}
async function* iterateSseMessages(body, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const state = { event: null, data: [], raw: [] };
    let buffer = "";
    try {
        while (true) {
            if (signal?.aborted) {
                throw new Error("Request was aborted");
            }
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            let consumed = consumeLine(buffer);
            while (consumed) {
                buffer = consumed.rest;
                const event = decodeSseLine(consumed.line, state);
                if (event) {
                    yield event;
                }
                consumed = consumeLine(buffer);
            }
        }
        buffer += decoder.decode();
        let consumed = consumeLine(buffer);
        while (consumed) {
            buffer = consumed.rest;
            const event = decodeSseLine(consumed.line, state);
            if (event) {
                yield event;
            }
            consumed = consumeLine(buffer);
        }
        if (buffer.length > 0) {
            const event = decodeSseLine(buffer, state);
            if (event) {
                yield event;
            }
        }
        const trailingEvent = flushSseEvent(state);
        if (trailingEvent) {
            yield trailingEvent;
        }
    }
    finally {
        reader.releaseLock();
    }
}
async function* iterateAnthropicEvents(response, signal) {
    if (!response.body) {
        throw new Error("Attempted to iterate over an Anthropic response with no body");
    }
    let sawMessageStart = false;
    let sawMessageEnd = false;
    for await (const sse of iterateSseMessages(response.body, signal)) {
        if (sse.event === "error") {
            throw new Error(sse.data);
        }
        if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
            continue;
        }
        try {
            const event = parseJsonWithRepair(sse.data);
            if (event.type === "message_start") {
                sawMessageStart = true;
            }
            else if (event.type === "message_stop") {
                sawMessageEnd = true;
            }
            yield event;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`);
        }
    }
    if (sawMessageStart && !sawMessageEnd) {
        throw new Error("Anthropic stream ended before message_stop");
    }
}
export const stream = (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    const normalizedContext = resolveTranscript(context, getAnthropicCompat(model).supportsMidConvoSystemMessages);
    const currentTools = getCurrentTools(normalizedContext.messages);
    (async () => {
        const providerThinkingLevel = model.compat?.supportsMidConvoEffort ? (options?.effort ?? "high") : undefined;
        const output = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            ...(providerThinkingLevel === undefined ? {} : { providerThinkingLevel }),
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "pending",
            timestamp: Date.now(),
        };
        try {
            let client;
            let isOAuth;
            let usageModel = model;
            let inputTransformations;
            if (options?.client) {
                client = options.client;
                isOAuth = false;
            }
            else {
                const apiKey = options?.apiKey;
                const federation = getAnthropicFederation(model, apiKey, options?.headers, options?.env);
                if (!federation)
                    assertRequestAuth(model.provider, apiKey, options?.headers);
                let copilotDynamicHeaders;
                if (model.provider === "github-copilot") {
                    const hasImages = hasCopilotVisionInput(normalizedContext.messages);
                    copilotDynamicHeaders = buildCopilotDynamicHeaders({
                        messages: normalizedContext.messages,
                        hasImages,
                    });
                }
                const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
                const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
                const created = createClient(model, apiKey, options?.headers, options?.fetch, copilotDynamicHeaders, cacheSessionId, federation);
                client = created.client;
                isOAuth = created.isOAuthToken;
            }
            let params = buildParams(model, normalizedContext, isOAuth, options);
            const nextParams = await options?.onPayload?.(params, model);
            if (nextParams !== undefined) {
                params = { ...nextParams, stream: true };
            }
            const requestOptions = {
                ...(options?.signal ? { signal: options.signal } : {}),
                ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
                maxRetries: 0,
            };
            const response = await retryProviderRequest(() => client.beta.messages.create(params, requestOptions).asResponse(), {
                maxRetries: options?.maxRetries,
                maxRetryDelayMs: options?.maxRetryDelayMs,
                signal: options?.signal,
            });
            await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
            stream.push({ type: "start", partial: output });
            const blocks = output.content;
            for await (const event of iterateAnthropicEvents(response, options?.signal)) {
                await options?.onProviderStreamEvent?.(event, model);
                if (event.type === "message_start") {
                    output.responseId = event.message.id;
                    const transformations = event.message.input_transformations;
                    if (Array.isArray(transformations))
                        inputTransformations = transformations;
                    const responseModel = event.message.model;
                    if (responseModel !== model.id)
                        output.responseModel = responseModel;
                    const fallbackCost = responseModel === model.id
                        ? undefined
                        : model.compat?.allowedFallbackModels?.find((fallback) => fallback.provider === model.provider && fallback.model === responseModel)?.cost;
                    usageModel = fallbackCost ? { ...model, id: responseModel, cost: fallbackCost } : model;
                    // Capture initial token usage from message_start event
                    // This ensures we have input token counts even if the stream is aborted early
                    output.usage.input = event.message.usage.input_tokens || 0;
                    output.usage.output = event.message.usage.output_tokens || 0;
                    output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
                    output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
                    output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
                    // Anthropic doesn't provide total_tokens, compute from components
                    output.usage.totalTokens =
                        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
                    calculateCost(usageModel, output.usage);
                }
                else if (event.type === "content_block_start") {
                    if (event.content_block.type === "fallback") {
                        if (output.content.length > 0) {
                            throw new Error("Anthropic performed an unsupported mid-output model fallback");
                        }
                        continue;
                    }
                    if (event.content_block.type === "text") {
                        const block = {
                            type: "text",
                            text: event.content_block.text ?? "",
                            index: event.index,
                        };
                        output.content.push(block);
                        stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
                    }
                    else if (event.content_block.type === "thinking") {
                        const block = {
                            type: "thinking",
                            thinking: event.content_block.thinking ?? "",
                            thinkingSignature: event.content_block.signature ?? "",
                            index: event.index,
                        };
                        output.content.push(block);
                        stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
                    }
                    else if (event.content_block.type === "redacted_thinking") {
                        const block = {
                            type: "thinking",
                            thinking: "[Reasoning redacted]",
                            thinkingSignature: event.content_block.data,
                            redacted: true,
                            index: event.index,
                        };
                        output.content.push(block);
                        stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
                    }
                    else if (event.content_block.type === "tool_use") {
                        const block = {
                            type: "toolCall",
                            id: event.content_block.id,
                            name: isOAuth
                                ? fromClaudeCodeName(event.content_block.name, currentTools)
                                : event.content_block.name,
                            arguments: event.content_block.input ?? {},
                            partialJson: "",
                            index: event.index,
                        };
                        output.content.push(block);
                        stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
                    }
                }
                else if (event.type === "content_block_delta") {
                    if (event.delta.type === "text_delta") {
                        const index = blocks.findIndex((b) => b.index === event.index);
                        const block = blocks[index];
                        if (block && block.type === "text") {
                            block.text += event.delta.text;
                            stream.push({
                                type: "text_delta",
                                contentIndex: index,
                                delta: event.delta.text,
                                partial: output,
                            });
                        }
                    }
                    else if (event.delta.type === "thinking_delta") {
                        const index = blocks.findIndex((b) => b.index === event.index);
                        const block = blocks[index];
                        if (block && block.type === "thinking") {
                            block.thinking += event.delta.thinking;
                            stream.push({
                                type: "thinking_delta",
                                contentIndex: index,
                                delta: event.delta.thinking,
                                partial: output,
                            });
                        }
                    }
                    else if (event.delta.type === "input_json_delta") {
                        const index = blocks.findIndex((b) => b.index === event.index);
                        const block = blocks[index];
                        if (block && block.type === "toolCall") {
                            block.partialJson += event.delta.partial_json;
                            block.arguments = parseStreamingJson(block.partialJson);
                            stream.push({
                                type: "toolcall_delta",
                                contentIndex: index,
                                delta: event.delta.partial_json,
                                partial: output,
                            });
                        }
                    }
                    else if (event.delta.type === "signature_delta") {
                        const index = blocks.findIndex((b) => b.index === event.index);
                        const block = blocks[index];
                        if (block && block.type === "thinking") {
                            block.thinkingSignature = block.thinkingSignature || "";
                            block.thinkingSignature += event.delta.signature;
                        }
                    }
                }
                else if (event.type === "content_block_stop") {
                    const index = blocks.findIndex((b) => b.index === event.index);
                    const block = blocks[index];
                    if (block) {
                        delete block.index;
                        if (block.type === "text") {
                            stream.push({
                                type: "text_end",
                                contentIndex: index,
                                content: block.text,
                                partial: output,
                            });
                        }
                        else if (block.type === "thinking") {
                            stream.push({
                                type: "thinking_end",
                                contentIndex: index,
                                content: block.thinking,
                                partial: output,
                            });
                        }
                        else if (block.type === "toolCall") {
                            block.arguments = parseStreamingJson(block.partialJson);
                            // Finalize in-place and strip the scratch buffer so replay only
                            // carries parsed arguments.
                            delete block.partialJson;
                            stream.push({
                                type: "toolcall_end",
                                contentIndex: index,
                                toolCall: block,
                                partial: output,
                            });
                        }
                    }
                }
                else if (event.type === "message_delta") {
                    const transformations = event.input_transformations;
                    if (Array.isArray(transformations))
                        inputTransformations = transformations;
                    if (event.delta.stop_reason) {
                        output.rawStopReason = event.delta.stop_reason;
                        const stopReasonResult = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
                        output.stopReason = stopReasonResult.stopReason;
                        if (stopReasonResult.errorMessage) {
                            output.errorMessage = stopReasonResult.errorMessage;
                        }
                    }
                    // Only update usage fields if present (not null).
                    // Preserves input_tokens from message_start when proxies omit it in message_delta.
                    if (event.usage) {
                        if (event.usage.input_tokens != null) {
                            output.usage.input = event.usage.input_tokens;
                        }
                        if (event.usage.output_tokens != null) {
                            output.usage.output = event.usage.output_tokens;
                        }
                        if (event.usage.cache_read_input_tokens != null) {
                            output.usage.cacheRead = event.usage.cache_read_input_tokens;
                        }
                        if (event.usage.cache_creation_input_tokens != null) {
                            output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
                        }
                        // Vercel AI Gateway includes the TTL breakdown in deltas, though the SDK only types it on message_start.
                        const cacheCreation = event.usage.cache_creation;
                        if (cacheCreation?.ephemeral_1h_input_tokens != null) {
                            output.usage.cacheWrite1h = cacheCreation.ephemeral_1h_input_tokens;
                        }
                        // Anthropic reports reasoning tokens as a subset of output tokens.
                        const thinkingTokens = event.usage.output_tokens_details?.thinking_tokens;
                        if (thinkingTokens != null) {
                            output.usage.reasoning = thinkingTokens;
                        }
                    }
                    // Anthropic doesn't provide total_tokens, compute from components
                    output.usage.totalTokens =
                        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
                    calculateCost(usageModel, output.usage);
                }
            }
            if (options?.signal?.aborted) {
                throw new Error("Request was aborted");
            }
            if (output.stopReason === "pending") {
                throw new Error("Anthropic stream ended without a stop reason");
            }
            if (output.stopReason === "aborted" || output.stopReason === "error") {
                throw new Error(output.errorMessage || "An unknown error occurred");
            }
            if (inputTransformations && inputTransformations.length > 0) {
                appendAssistantMessageDiagnostic(output, {
                    type: "anthropic_input_transformations",
                    timestamp: Date.now(),
                    details: {
                        transformations: inputTransformations.map((transformation) => ({
                            type: transformation.type ?? undefined,
                            path: transformation.path ?? undefined,
                            reason: transformation.reason ?? undefined,
                        })),
                    },
                });
            }
            stream.push({ type: "done", reason: output.stopReason, message: output });
            stream.end();
        }
        catch (error) {
            for (const block of output.content) {
                delete block.index;
                // partialJson is only a streaming scratch buffer; never persist it.
                delete block.partialJson;
            }
            output.stopReason = options?.signal?.aborted ? "aborted" : "error";
            output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
            stream.push({ type: "error", reason: output.stopReason, error: output });
            stream.end();
        }
    })();
    return stream;
};
/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Note: effort "max" is available on all adaptive-thinking Claude models, while native
 * "xhigh" is only available on Opus 4.7/4.8, Sonnet 5, and Fable 5.
 */
function mapThinkingLevelToEffort(model, level) {
    const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
    if (typeof mapped === "string")
        return mapped;
    switch (level) {
        case "minimal":
        case "low":
            return "low";
        case "medium":
            return "medium";
        case "high":
            return "high";
        default:
            return "high";
    }
}
export const streamSimple = (model, context, options) => {
    if (!getAnthropicFederation(model, options?.apiKey, options?.headers, options?.env)) {
        assertRequestAuth(model.provider, options?.apiKey, options?.headers);
    }
    const base = {
        ...buildBaseOptions(model, context, options, options?.apiKey),
        toolChoice: options?.toolChoice,
    };
    if (!options?.reasoning) {
        return stream(model, context, {
            ...base,
            thinkingEnabled: false,
        });
    }
    // For models with adaptive thinking: use an effort level.
    // For older models: use budget-based thinking.
    if (model.compat?.forceAdaptiveThinking === true) {
        const effort = mapThinkingLevelToEffort(model, options.reasoning);
        return stream(model, context, {
            ...base,
            thinkingEnabled: true,
            effort,
        });
    }
    // Undefined means the caller did not request an output cap; let the helper use the model cap.
    // Do not coerce to 0 here, or the thinking budget would become the entire max_tokens value.
    const adjusted = adjustMaxTokensForThinking(base.maxTokens, model.maxTokens, options.reasoning, options.thinkingBudgets);
    const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
    return stream(model, context, {
        ...base,
        maxTokens,
        thinkingEnabled: true,
        thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
    });
};
function isOAuthToken(apiKey) {
    return apiKey.includes("sk-ant-oat");
}
function createClient(model, apiKey, optionsHeaders, fetch, dynamicHeaders, sessionId, federation) {
    // Copilot: Bearer auth.
    if (model.provider === "github-copilot") {
        const client = new PiAnthropic({
            apiKey: null,
            authToken: apiKey ?? null,
            baseURL: model.baseUrl,
            dangerouslyAllowBrowser: true,
            fetch,
            defaultHeaders: mergeClientHeaders({
                accept: "application/json",
                "anthropic-dangerous-direct-browser-access": "true",
            }, model.headers, dynamicHeaders, optionsHeaders),
        });
        return { client, isOAuthToken: false };
    }
    // OAuth: Bearer auth, Claude Code identity headers
    if (apiKey && isOAuthToken(apiKey)) {
        const client = new PiAnthropic({
            apiKey: null,
            authToken: apiKey,
            baseURL: model.baseUrl,
            dangerouslyAllowBrowser: true,
            fetch,
            defaultHeaders: mergeClientHeaders({
                accept: "application/json",
                "anthropic-dangerous-direct-browser-access": "true",
                "user-agent": `claude-cli/${claudeCodeVersion}`,
                "x-app": "cli",
            }, model.headers, optionsHeaders),
        });
        return { client, isOAuthToken: true };
    }
    // API key, header-owned auth, or workload identity federation.
    const compat = getAnthropicCompat(model);
    const sessionAffinityHeaders = {};
    if (sessionId && compat.sendSessionAffinityHeaders) {
        const header = compat.sessionAffinityFormat === "openrouter" ? "x-session-id" : "x-session-affinity";
        sessionAffinityHeaders[header] = sessionId;
    }
    const defaultHeaders = mergeClientHeaders({
        accept: "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
    }, sessionAffinityHeaders, model.headers, optionsHeaders);
    if (federation) {
        const key = JSON.stringify([model.baseUrl, federation]);
        if (federationClient?.key !== key || federationClient.fetch !== fetch) {
            const client = new PiAnthropic({
                apiKey: null,
                authToken: null,
                config: federation,
                baseURL: model.baseUrl,
                dangerouslyAllowBrowser: true,
                fetch,
            });
            federationClient = { key, fetch, client };
        }
        return { client: federationClient.client.withOptions({ defaultHeaders }), isOAuthToken: false };
    }
    const client = new PiAnthropic({
        apiKey: apiKey ?? null,
        authToken: null,
        baseURL: model.baseUrl,
        dangerouslyAllowBrowser: true,
        fetch,
        defaultHeaders,
    });
    return { client, isOAuthToken: false };
}
function getBetaFeatures(model, context, isOAuthToken, nativeToolChanges, options) {
    let configuredFeatures;
    for (const headers of [model.headers, options?.headers]) {
        for (const [name, value] of Object.entries(headers ?? {})) {
            if (name.toLowerCase() === "anthropic-beta")
                configuredFeatures = value;
        }
    }
    if (configuredFeatures === null)
        return [];
    if (configuredFeatures !== undefined) {
        return [
            ...new Set(configuredFeatures
                .split(",")
                .map((feature) => feature.trim())
                .filter((feature) => feature.length > 0)),
        ];
    }
    const features = [];
    if (isOAuthToken)
        features.push("claude-code-20250219", "oauth-2025-04-20");
    if (shouldUseFineGrainedToolStreamingBeta(model, context))
        features.push(FINE_GRAINED_TOOL_STREAMING_BETA);
    if (model.reasoning &&
        options?.thinkingEnabled === true &&
        (options.interleavedThinking ?? true) &&
        model.compat?.forceAdaptiveThinking !== true) {
        features.push(INTERLEAVED_THINKING_BETA);
    }
    if (shouldUseServerSideFallbackBeta(model))
        features.push(SERVER_SIDE_FALLBACK_BETA);
    if (model.compat?.supportsMidConvoEffort === true) {
        features.push(MID_CONVERSATION_OUTPUT_CONFIG_BETA, THINKING_BINDING_CONTROLS_BETA);
    }
    if (nativeToolChanges)
        features.push(INLINE_TOOLS_BETA);
    return [...new Set(features)];
}
function buildParams(model, context, isOAuthToken, options) {
    const { cacheControl } = getCacheControl(model, options?.cacheRetention, options?.env);
    const compat = getAnthropicCompat(model);
    const initialSystemMessage = getInitialSystemMessage(context.messages);
    const initialSystemText = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
    const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
    const conversationMessages = initialSystemMessage ? transformedMessages.slice(1) : transformedMessages;
    // Native tool changes keep the request-level tool list fixed and define every later tool
    // by value in a `tool_addition` block, which also expresses same-name redefinitions.
    // Anthropic rejects a tool list where every tool is deferred, so there must be an initial
    // active tool to anchor the placeholder. Otherwise the current tool list is sent.
    const initialTools = initialSystemMessage?.toolsAdded ?? [];
    const nativeToolChanges = compat.supportsMidConvoSystemMessages && compat.supportsMidConvoToolChanges && initialTools.length > 0;
    const converted = convertMessages(conversationMessages, isOAuthToken, cacheControl, compat.allowEmptySignature, model.compat?.supportsMidConvoEffort === true ? model.provider : undefined, nativeToolChanges
        ? (tools) => convertTools(tools, isOAuthToken, compat.supportsEagerToolInputStreaming, compat.supportsStrictTools)
        : undefined);
    const activeEffort = options?.effort ?? "high";
    const betaFeatures = getBetaFeatures(model, context, isOAuthToken, nativeToolChanges, options);
    const params = {
        model: model.id,
        messages: model.compat?.supportsMidConvoEffort === true
            ? insertThinkingLevelMessages(converted, activeEffort)
            : converted.messages,
        max_tokens: options?.maxTokens ?? model.maxTokens,
        stream: true,
        ...(betaFeatures.length > 0 ? { betas: betaFeatures } : {}),
    };
    // For OAuth tokens, we MUST include Claude Code identity
    if (isOAuthToken) {
        params.system = [
            {
                type: "text",
                text: "You are Claude Code, Anthropic's official CLI for Claude.",
                ...(cacheControl ? { cache_control: cacheControl } : {}),
            },
        ];
        if (initialSystemText) {
            params.system.push({
                type: "text",
                text: sanitizeSurrogates(initialSystemText),
                ...(cacheControl ? { cache_control: cacheControl } : {}),
            });
        }
    }
    else if (initialSystemText) {
        // Add cache control to system prompt for non-OAuth tokens
        params.system = [
            {
                type: "text",
                text: sanitizeSurrogates(initialSystemText),
                ...(cacheControl ? { cache_control: cacheControl } : {}),
            },
        ];
    }
    // Temperature is incompatible with extended thinking and unsupported on Claude Opus 4.7+.
    if (options?.temperature !== undefined &&
        !options?.thinkingEnabled &&
        model.compat?.supportsMidConvoEffort !== true &&
        compat.supportsTemperature) {
        params.temperature = options.temperature;
    }
    const toolCacheControl = compat.supportsCacheControlOnTools ? cacheControl : undefined;
    if (nativeToolChanges) {
        // Initial tools stay active with the cache breakpoint on the last one, followed by the
        // placeholder. The list never changes afterwards: later tools are defined by value in
        // `tool_addition` blocks and withdrawn by `tool_removal`, so the cached prefix survives
        // every tool change.
        params.tools = [
            ...convertTools(initialTools, isOAuthToken, compat.supportsEagerToolInputStreaming, compat.supportsStrictTools, toolCacheControl),
            DEFERRED_TOOL_PLACEHOLDER,
        ];
    }
    else {
        const tools = getCurrentTools(context.messages);
        if (tools.length > 0) {
            params.tools = convertTools(tools, isOAuthToken, compat.supportsEagerToolInputStreaming, compat.supportsStrictTools, toolCacheControl);
        }
    }
    // Managed effort models always use adaptive thinking so prefix mismatches can
    // be dropped instead of surfacing as persistent 400 responses.
    if (model.compat?.supportsMidConvoEffort === true) {
        params.thinking = {
            type: "adaptive",
            display: options?.thinkingDisplay ?? "summarized",
            block_binding: { prefix_mismatch_behavior: "drop_block" },
        };
        params.output_config = { effort: "high" };
    }
    else if (model.reasoning) {
        if (options?.thinkingEnabled) {
            // Default to "summarized" so Opus 4.7 and Mythos Preview behave like
            // older Claude 4 models (whose API default is also "summarized").
            const display = options.thinkingDisplay ?? "summarized";
            if (model.compat?.forceAdaptiveThinking === true) {
                // Adaptive thinking: Claude decides when and how much to think.
                params.thinking = { type: "adaptive", display };
                if (options.effort) {
                    params.output_config = { effort: options.effort };
                }
            }
            else {
                // Budget-based thinking for older models
                params.thinking = {
                    type: "enabled",
                    budget_tokens: options.thinkingBudgetTokens || 1024,
                    display,
                };
            }
        }
        else if (options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null) {
            params.thinking = { type: "disabled" };
        }
    }
    if (options?.metadata) {
        const userId = options.metadata.user_id;
        if (typeof userId === "string") {
            params.metadata = { user_id: userId };
        }
    }
    if (options?.toolChoice) {
        if (typeof options.toolChoice === "string") {
            params.tool_choice = { type: options.toolChoice };
        }
        else {
            params.tool_choice = options.toolChoice;
        }
    }
    const allowedFallbackModels = model.compat?.allowedFallbackModels;
    if (allowedFallbackModels && allowedFallbackModels.length > 0) {
        params.fallbacks = allowedFallbackModels.map((fallback) => ({ model: fallback.model }));
    }
    return params;
}
// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id) {
    return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}
function convertToolResult(msg) {
    return {
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: convertContentBlocks(msg.content),
        is_error: msg.isError,
    };
}
function convertMessages(transformedMessages, isOAuthToken, cacheControl, allowEmptySignature = false, managedProvider, 
/** Converts tool definitions for native `tool_addition` blocks; undefined when tool changes are not native. */
convertToolDefinitions) {
    const params = [];
    const assistantLevels = new Map();
    // Later system messages are held back and emitted directly before the next assistant
    // message (or at the end of the transcript). Anthropic requires `tool_result` blocks to
    // immediately follow their `tool_use`, so a system message between them is rejected; this
    // also mirrors where the managed-effort system messages are inserted. As a result an
    // update placed before a user message in the transcript lands after it on the wire.
    const pendingSystemMessages = [];
    const flushPendingSystemMessages = () => {
        params.push(...pendingSystemMessages);
        pendingSystemMessages.length = 0;
    };
    for (let i = 0; i < transformedMessages.length; i++) {
        const msg = transformedMessages[i];
        if (msg.role === "system") {
            // Later system messages only reach this point when the model accepts them natively;
            // otherwise the transcript was collapsed into the leading message before conversion.
            const text = renderSystemMessageUpdate(msg);
            const blocks = [];
            if (text.length > 0)
                blocks.push({ type: "text", text: sanitizeSurrogates(text) });
            if (convertToolDefinitions) {
                const added = msg.toolsAdded ?? [];
                const redefined = new Set(added.map((tool) => tool.name));
                for (const tool of msg.toolsRemoved ?? []) {
                    // A new definition under the same name replaces the old one, so no removal is needed.
                    if (redefined.has(tool.name))
                        continue;
                    blocks.push({
                        type: "tool_removal",
                        tool: { type: "tool_reference", name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name },
                    });
                }
                for (const definition of convertToolDefinitions(added)) {
                    blocks.push({ type: "tool_addition", tool: { type: "tool_definition", definition } });
                }
            }
            if (blocks.length > 0)
                pendingSystemMessages.push({ role: "system", content: blocks });
        }
        else if (msg.role === "user") {
            if (typeof msg.content === "string") {
                if (msg.content.trim().length > 0) {
                    params.push({
                        role: "user",
                        content: sanitizeSurrogates(msg.content),
                    });
                }
            }
            else {
                const blocks = msg.content.map((item) => {
                    if (item.type === "text") {
                        return {
                            type: "text",
                            text: sanitizeSurrogates(item.text),
                        };
                    }
                    else {
                        return {
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: item.mimeType,
                                data: item.data,
                            },
                        };
                    }
                });
                const filteredBlocks = blocks.filter((b) => {
                    if (b.type === "text") {
                        return b.text.trim().length > 0;
                    }
                    return true;
                });
                if (filteredBlocks.length === 0)
                    continue;
                params.push({
                    role: "user",
                    content: filteredBlocks,
                });
            }
        }
        else if (msg.role === "assistant") {
            flushPendingSystemMessages();
            const blocks = [];
            for (const block of msg.content) {
                if (block.type === "text") {
                    if (block.text.trim().length === 0)
                        continue;
                    blocks.push({
                        type: "text",
                        text: sanitizeSurrogates(block.text),
                    });
                }
                else if (block.type === "thinking") {
                    // Redacted thinking: pass the opaque payload back as redacted_thinking
                    if (block.redacted) {
                        blocks.push({
                            type: "redacted_thinking",
                            data: block.thinkingSignature,
                        });
                        continue;
                    }
                    const thinkingSignature = block.thinkingSignature;
                    const hasThinkingSignature = !!thinkingSignature && thinkingSignature.trim().length > 0;
                    if (block.thinking.trim().length === 0 && !hasThinkingSignature)
                        continue;
                    // If thinking signature is missing/empty (e.g., from aborted stream),
                    // convert to plain text for Anthropic. Some compatible providers emit
                    // and accept empty signatures, so let marked models preserve the block.
                    if (!hasThinkingSignature) {
                        blocks.push(allowEmptySignature
                            ? {
                                type: "thinking",
                                thinking: sanitizeSurrogates(block.thinking),
                                signature: "",
                            }
                            : {
                                type: "text",
                                text: sanitizeSurrogates(block.thinking),
                            });
                    }
                    else {
                        blocks.push({
                            type: "thinking",
                            thinking: sanitizeSurrogates(block.thinking),
                            signature: thinkingSignature,
                        });
                    }
                }
                else if (block.type === "toolCall") {
                    blocks.push({
                        type: "tool_use",
                        id: block.id,
                        name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
                        input: block.arguments ?? {},
                    });
                }
            }
            if (blocks.length === 0)
                continue;
            const messageIndex = params.length;
            params.push({
                role: "assistant",
                content: blocks,
            });
            if (managedProvider !== undefined &&
                msg.api === "anthropic-messages" &&
                msg.provider === managedProvider &&
                isAnthropicEffort(msg.providerThinkingLevel)) {
                assistantLevels.set(messageIndex, msg.providerThinkingLevel);
            }
        }
        else if (msg.role === "toolResult") {
            // Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint.
            const toolResults = [];
            let j = i;
            while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
                toolResults.push(convertToolResult(transformedMessages[j]));
                j++;
            }
            // Skip the messages we've already processed.
            i = j - 1;
            params.push({
                role: "user",
                content: toolResults,
            });
        }
    }
    flushPendingSystemMessages();
    // Add cache_control to the last user or system message to cache conversation history
    if (cacheControl && params.length > 0) {
        const lastMessage = params[params.length - 1];
        if (lastMessage.role === "user" || lastMessage.role === "system") {
            if (Array.isArray(lastMessage.content)) {
                const lastBlock = lastMessage.content[lastMessage.content.length - 1];
                if (lastBlock &&
                    (lastBlock.type === "text" ||
                        lastBlock.type === "image" ||
                        lastBlock.type === "tool_result" ||
                        lastBlock.type === "tool_addition" ||
                        lastBlock.type === "tool_removal")) {
                    lastBlock.cache_control = cacheControl;
                }
            }
            else if (typeof lastMessage.content === "string") {
                lastMessage.content = [
                    {
                        type: "text",
                        text: lastMessage.content,
                        cache_control: cacheControl,
                    },
                ];
            }
        }
    }
    return { messages: params, assistantLevels };
}
function isAnthropicEffort(value) {
    return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}
function insertThinkingLevelMessages(converted, activeEffort) {
    const messages = [];
    for (let index = 0; index < converted.messages.length; index++) {
        const historicalEffort = converted.assistantLevels.get(index);
        if (historicalEffort !== undefined) {
            messages.push({ role: "system", content: [], output_config: { effort: historicalEffort } });
        }
        messages.push(converted.messages[index]);
    }
    messages.push({ role: "system", content: [], output_config: { effort: activeEffort } });
    return messages;
}
function shouldUseFineGrainedToolStreamingBeta(model, context) {
    return getCurrentTools(context.messages).length > 0 && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}
// Keywords Anthropic strict tool use rejects with a 400 for the whole request.
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations
const ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS = new Set([
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "maxItems",
    "uniqueItems",
    "minContains",
    "maxContains",
    "minProperties",
    "maxProperties",
]);
const ANTHROPIC_STRICT_STRING_FORMATS = new Set([
    "date-time",
    "time",
    "date",
    "duration",
    "email",
    "hostname",
    "uri",
    "ipv4",
    "ipv6",
    "uuid",
]);
const isAnthropicStrictUnsupportedKeyword = (key, value) => {
    if (ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS.has(key))
        return true;
    if (key === "minItems")
        return value !== 0 && value !== 1;
    if (key === "format")
        return typeof value !== "string" || !ANTHROPIC_STRICT_STRING_FORMATS.has(value);
    return false;
};
function convertTools(tools, isOAuthToken, supportsEagerToolInputStreaming, supportsStrictTools, cacheControl) {
    if (!tools)
        return [];
    return tools.map((tool, index) => {
        const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictTools, isAnthropicStrictUnsupportedKeyword);
        const parameters = getJsonSchemaToolParameters(tool, strict);
        const schema = parameters;
        const legacyInputSchema = {
            type: "object",
            properties: schema.properties ?? {},
            required: schema.required ?? [],
        };
        const inputSchema = strict === true
            ? {
                ...parameters,
                ...legacyInputSchema,
            }
            : legacyInputSchema;
        return {
            name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
            description: tool.description,
            ...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
            ...(strict === true ? { strict: true } : {}),
            input_schema: inputSchema,
            ...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
        };
    });
}
function mapStopReason(reason, stopDetails) {
    switch (reason) {
        case "end_turn":
            return { stopReason: "stop" };
        case "max_tokens":
            return { stopReason: "length" };
        case "tool_use":
            return { stopReason: "toolUse" };
        case "refusal":
            return {
                stopReason: "error",
                errorMessage: stopDetails?.explanation || `The model refused to complete the request`,
            };
        case "pause_turn": // Stop is good enough -> resubmit
            return { stopReason: "stop" };
        case "stop_sequence":
            return { stopReason: "stop" }; // We don't supply stop sequences, so this should never happen
        case "sensitive": // Content flagged by safety filters (not yet in SDK types)
            return { stopReason: "error", errorMessage: "Provider stopped with: sensitive" };
        default:
            // Handle unknown stop reasons gracefully (API may add new values)
            throw new Error(`Unhandled stop reason: ${reason}`);
    }
}
//# sourceMappingURL=anthropic-messages.js.map