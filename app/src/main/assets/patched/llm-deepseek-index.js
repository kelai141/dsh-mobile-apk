import z from "@deepseek-ai/schemastery";
import { CONTEXT_WINDOW_EXCEEDED_CODE, CallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId, RetryPolicySchema, assertUsableApiKey, attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { getOrCreateAnonymousUserId } from "@deepseek-ai/dsh-anonymous-user-id";
import { EventSourceParserStream } from "eventsource-parser/stream";
// ---------- 图片 → 文本（视觉桥接） ----------
// DeepSeek 走文本-only 线路，遇到图片块时改为调用 Qwen-VL 生成文字描述/OCR，
// 让纯文本模型也能"看到"上传的图片（而不是抛 UNSUPPORTED_CONTENT）。
const VISION_API_KEY_ENVS = ["DASHSCOPE_API_KEY", "QWEN_API_KEY", "OPENAI_API_KEY"];
const VISION_BASE_URL_ENV = "DASHSCOPE_BASE_URL";
const VISION_MODEL_ENV = "DASHSCOPE_MODEL";
const VISION_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const VISION_DEFAULT_MODEL = "qwen-vl-max";
function visionApiKey() {
	for (const name of VISION_API_KEY_ENVS) {
		const value = process.env[name];
		if (value !== void 0 && value.length > 0) return value;
	}
	return void 0;
}
// 图片描述缓存：同一 attachmentId 只调一次视觉 API，避免之后每一轮重复识别历史图片。
const imageDescriptionCache = /* @__PURE__ */ new Map();
const IMAGE_DESCRIPTION_CACHE_MAX = 64;
function cacheImageDescription(id, description) {
	if (imageDescriptionCache.size >= IMAGE_DESCRIPTION_CACHE_MAX) imageDescriptionCache.clear();
	imageDescriptionCache.set(id, description);
}
// 单消息图片识别并发上限：maxImagesPerMessage 默认 20，无界并发会打爆内存与 API 限流。
const IMAGE_DESCRIPTION_CONCURRENCY = 4;
/** 限并发的有序 map：结果按输入顺序返回，但最多同时跑 limit 个任务。 */
async function mapLimit(items, limit, mapper) {
	const results = new Array(items.length);
	let cursor = 0;
	const worker = async () => {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await mapper(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return results;
}
/** 递归把 content 里的图片块替换成文字描述（含 tool-result 嵌套），与 contentHasImage 的递归口径一致。 */
async function convertContentImages(content, attachments, signal, state) {
	const imageIndexes = [];
	content.forEach((block, index) => {
		if (block.type === "image") imageIndexes.push(index);
	});
	let rendered = [];
	if (imageIndexes.length > 0) {
		state.changed = true;
		rendered = await mapLimit(imageIndexes, IMAGE_DESCRIPTION_CONCURRENCY, async (pos, order) => {
			const block = content[pos];
			try {
				const id = block.attachment.attachmentId;
				let description = imageDescriptionCache.get(id);
				if (description === void 0) {
					const stored = await attachments.readImage(block.attachment);
					description = await describeImage(stored.ref.mediaType, stored.data, signal);
					cacheImageDescription(id, description);
				}
				return imageIndexes.length > 1
					? `[第 ${order + 1}/${imageIndexes.length} 张图片内容]\n${description}\n[/图片]`
					: `[图片内容]\n${description}\n[/图片]`;
			} catch {
				return imageIndexes.length > 1 ? `[第 ${order + 1}/${imageIndexes.length} 张图片（无法读取）]` : "[图片（无法读取）]";
			}
		});
	}
	const result = [];
	let cursor = 0;
	for (const block of content) {
		if (block.type === "image") result.push({ type: "text", text: rendered[cursor++] });
		else if (block.type === "tool-result") result.push({ ...block, content: await convertContentImages(block.content, attachments, signal, state) });
		else result.push(block);
	}
	return result;
}
async function describeImage(mediaType, data, signal) {
	const key = visionApiKey();
	if (key === void 0) return "(未配置视觉 API key，无法识别图片)";
	const baseURL = (process.env[VISION_BASE_URL_ENV] || VISION_DEFAULT_BASE_URL).replace(/\/+$/, "");
	const model = process.env[VISION_MODEL_ENV] || VISION_DEFAULT_MODEL;
	const b64 = Buffer.from(data).toString("base64");
	const requestSignal = signal === void 0 ? AbortSignal.timeout(60000) : AbortSignal.any([signal, AbortSignal.timeout(60000)]);
	let response;
	try {
		response = await fetch(`${baseURL}/chat/completions`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({
				model,
				messages: [{
					role: "user",
					content: [
						{ type: "image_url", image_url: { url: `data:${mediaType};base64,${b64}` } },
						{ type: "text", text: "请描述这张图片的内容，并提取图中所有文字。用中文回答，简洁完整。" }
					]
				}],
				max_tokens: 1024,
				temperature: 0
			}),
			signal: requestSignal
		});
	} catch {
		return signal?.aborted ? "(图片识别已取消)" : "(图片识别请求失败)";
	}
	if (!response.ok) return `(图片识别失败 HTTP ${response.status})`;
	try {
		const json = await response.json();
		const content = json?.choices?.[0]?.message?.content;
		return typeof content === "string" && content.length > 0 ? content : "(图片识别无结果)";
	} catch {
		return "(图片识别结果解析失败)";
	}
}
//#region lib/types/serialize.js
/**
* Serialize harness messages into DeepSeek chat completions. User text is joined; assistant text
* becomes `content`, tool calls become `tool_calls`, and tool results become separate tool messages.
* Assistant reasoning is replayed as `reasoning_content` only on tool-call turns, as required by
* thinking-mode passback. Core image blocks are rejected explicitly because this wire route is text-only;
* unknown declaration-merged block types retain the adapter's documented extension fallback.
* @module dsh-llm-deepseek/serialize
*/
/** Validate the adapter-owned effort before resolving its DeepSeek wire fields. */
function reasoningEffort(effort) {
	if (effort === "off" || effort === "high" || effort === "max") return effort;
	throw new LlmError(`DeepSeek does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
}
/** Resolve one legal thinking/effort pair without exposing `off` as a wire effort. */
function resolveThinking(options, defaults) {
	if (options.purpose === "session-title") return { thinking: "disabled" };
	const effort = options.reasoningEffort === void 0 ? defaults.reasoningEffort : reasoningEffort(options.reasoningEffort);
	if (defaults.thinking === "disabled" && effort !== void 0 && effort !== "off") throw new LlmError(`DeepSeek deployment does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
	if (effort === "off") return { thinking: "disabled" };
	if (effort === "high" || effort === "max") return {
		thinking: "enabled",
		reasoningEffort: effort
	};
	return defaults.thinking === void 0 ? {} : { thinking: defaults.thinking };
}
/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks) {
	if (contentHasImage(blocks)) throw new LlmError("The DeepSeek chat-completions adapter does not support image content.", "UNSUPPORTED_CONTENT");
}
/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message) {
	const text = flattenText(message.content);
	const reasoning = message.content.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
	const toolCalls = message.content.filter((block) => block.type === "tool-call").map((block) => ({
		id: block.id,
		type: "function",
		function: {
			name: block.name,
			arguments: block.arguments
		}
	}));
	return {
		role: "assistant",
		content: text,
		...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
		...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
	};
}
/**
* Serialize the conversation. `tool-result` blocks become standalone
* `{role: 'tool'}` messages; the harness puts each tool result in its own
* user-role message, so a mixed user message contributes its text first and
* its tool results as separate wire messages after.
* @param messages - the harness conversation, in order.
* @returns the wire messages; order preserved, each tool result expanded into its own entry.
*/
function serializeMessages(messages) {
	const wire = [];
	for (const message of messages) {
		assertTextOnly(message.content);
		if (message.role === "system") {
			wire.push({
				role: "system",
				content: flattenText(message.content)
			});
			continue;
		}
		if (message.role === "assistant") {
			wire.push(serializeAssistant(message));
			continue;
		}
		const toolResults = message.content.filter((block) => block.type === "tool-result");
		const text = flattenText(message.content);
		if (text.length > 0 || toolResults.length === 0) wire.push({
			role: "user",
			content: text
		});
		for (const result of toolResults) wire.push({
			role: "tool",
			tool_call_id: result.toolCallId,
			content: flattenText(result.content) || "(no output)"
		});
	}
	return wire;
}
/**
* Build the full wire request. Always streaming (`stream: true`, usage
* reporting on); optional fields are omitted rather than sent as null, so
* provider defaults apply.
* @param options - the harness request (model, history, system, tools, sampling).
* @param defaults - adapter-level thinking defaults; undefined fields put nothing on the wire.
* @returns the chat-completions request body.
*/
function serializeRequest(options, defaults = {}) {
	const messages = [];
	if (options.system !== void 0) messages.push({
		role: "system",
		content: options.system
	});
	messages.push(...serializeMessages(options.messages));
	const tools = options.tools?.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
	const resolvedThinking = resolveThinking(options, defaults);
	return {
		model: options.model,
		messages,
		stream: true,
		stream_options: { include_usage: true },
		...resolvedThinking.thinking !== void 0 ? { thinking: { type: resolvedThinking.thinking } } : {},
		...resolvedThinking.reasoningEffort !== void 0 ? { reasoning_effort: resolvedThinking.reasoningEffort } : {},
		...tools !== void 0 && tools.length > 0 ? { tools } : {},
		...options.temperature !== void 0 ? { temperature: options.temperature } : {},
		...options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens },
		...options.stop !== void 0 ? { stop: options.stop } : {}
	};
}
/**
* Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
* value and returns; throws `LlmError('STREAM_CLOSED')` when the stream ends
* without it (truncated response — the model call cannot be trusted).
* @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
* @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
* @returns each event's data payload in arrival order, the `[DONE]` sentinel last.
*/
async function* parseSse(stream, onComment) {
	const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment }));
	for await (const { data } of events) {
		yield data;
		if (data === "[DONE]") return;
	}
	throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
}
//#endregion
//#region lib/types/translate.js
/**
* Translate DeepSeek SSE payloads with one stateful harness block per content, reasoning, or tool
* call index. An empty initial reasoning delta does not open a block. Finish reason and the latest
* usage are deferred until `[DONE]`, covering both finish-attached and trailing usage-only shapes
* while ensuring no chunk follows `finish`.
*
* Translate DeepSeek wire chunks into the harness `StreamChunk` protocol.
* @module dsh-llm-deepseek/translate
*/
/**
* Map the wire finish_reason vocabulary to the harness FinishReason.
* @param reason - the wire `finish_reason` string.
* @returns the mapped reason; unrecognized values (content_filter, …) become `{kind: 'error'}` with the uppercased value as `code`.
*/
function mapFinishReason(reason) {
	switch (reason) {
		case "stop": return { kind: "stop" };
		case "tool_calls": return { kind: "tool-calls" };
		case "length": return { kind: "max-tokens" };
		default: return {
			kind: "error",
			failure: {
				message: `model stopped: ${reason}`,
				code: reason.toUpperCase()
			}
		};
	}
}
/**
* Map wire usage fields. DeepSeek's `prompt_tokens` INCLUDES cache hits
* (`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`,
* api/create-chat-completion); the harness TokenUsage convention is
* DISJOINT counts, so cache reads are subtracted out of `inputTokens`.
* @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
* @returns disjoint harness counts; cache/reasoning fields present only when the wire reported them.
*/
function mapUsage(usage) {
	const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
	const reasoning = usage.completion_tokens_details?.reasoning_tokens;
	return {
		inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
		outputTokens: usage.completion_tokens,
		...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
		...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
	};
}
/** Assemble the final ContentBlock for one open block. */
function closeBlock(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: CallId(block.callId ?? ""),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
* Malformed JSON payloads abort the stream with `MALFORMED_RESPONSE`.
* @param payloads - SSE data payloads from {@link parseSse}, `[DONE]`-terminated.
* @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are all deferred to the `[DONE]` sentinel.
*   A `stop` (or absent) finish with no opened blocks is a degenerate provider completion and maps to an
*   `EMPTY_RESPONSE` error finish instead of a successful empty message.
*/
async function* translate(payloads) {
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	const toolBlocks = /* @__PURE__ */ new Map();
	const order = [];
	let pendingFinish;
	let pendingUsage;
	function open(kind) {
		const block = {
			index: nextIndex++,
			kind,
			text: ""
		};
		order.push(block);
		return block;
	}
	for await (const payload of payloads) {
		if (payload === "[DONE]") {
			for (const block of order) yield {
				type: "block-end",
				index: block.index,
				block: closeBlock(block)
			};
			if (pendingUsage) yield {
				type: "usage",
				usage: pendingUsage
			};
			const reason = pendingFinish ?? { kind: "stop" };
			yield {
				type: "finish",
				reason: reason.kind === "stop" && order.length === 0 ? {
					kind: "error",
					failure: {
						message: "model returned a completed response with no content",
						code: EMPTY_RESPONSE_CODE
					}
				} : reason
			};
			return;
		}
		let chunk;
		try {
			chunk = JSON.parse(payload);
		} catch {
			throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		for (const choice of chunk.choices ?? []) {
			const delta = choice.delta;
			const reasoning = delta?.reasoning_content;
			if (typeof reasoning === "string" && reasoning.length > 0) {
				if (!reasoningBlock) {
					reasoningBlock = open("reasoning");
					yield {
						type: "block-start",
						index: reasoningBlock.index,
						blockType: "reasoning"
					};
				}
				reasoningBlock.text += reasoning;
				yield {
					type: "reasoning-delta",
					index: reasoningBlock.index,
					text: reasoning
				};
			}
			const content = delta?.content;
			if (typeof content === "string" && content.length > 0) {
				if (!textBlock) {
					textBlock = open("text");
					yield {
						type: "block-start",
						index: textBlock.index,
						blockType: "text"
					};
				}
				textBlock.text += content;
				yield {
					type: "text-delta",
					index: textBlock.index,
					text: content
				};
			}
			for (const call of delta?.tool_calls ?? []) {
				let block = toolBlocks.get(call.index);
				if (!block) {
					block = open("tool-call");
					toolBlocks.set(call.index, block);
					yield {
						type: "block-start",
						index: block.index,
						blockType: "tool-call"
					};
				}
				if (call.id !== void 0) block.callId = call.id;
				if (call.function?.name !== void 0) block.name = call.function.name;
				const fragment = call.function?.arguments ?? "";
				block.text += fragment;
				yield {
					type: "tool-call-delta",
					index: block.index,
					id: CallId(block.callId ?? ""),
					...block.name !== void 0 ? { name: block.name } : {},
					argumentsDelta: fragment
				};
			}
			if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
		}
		if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
	}
	throw new LlmError("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}
//#endregion
//#region lib/types/adapter.js
/**
* `DeepSeekAdapter`: fetch + SSE against a DeepSeek (OpenAI-compatible)
* chat-completions endpoint, emitting harness StreamChunks. The adapter is
* transport-only: connection facts arrive through a thunk resolved once per
* operation and the bearer token through a per-request resolver, so the
* registering plugin owns validation, layering, and credential policy.
*
* @module dsh-llm-deepseek/adapter
*/
var __addDisposableResource = function(env, value, async) {
	if (value !== null && value !== void 0) {
		if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
		var dispose, inner;
		if (async) {
			if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
			dispose = value[Symbol.asyncDispose];
		}
		if (dispose === void 0) {
			if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
			dispose = value[Symbol.dispose];
			if (async) inner = dispose;
		}
		if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources = (function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
/** Default maximum idle interval while an adapter stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Default combined request/response context capacity. */
const DEFAULT_CONTEXT_WINDOW = 1e6;
/** Default per-request output-token cap. */
const DEFAULT_MAX_TOKENS = 256e3;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
const OFF_REASONING_EFFORT = ReasoningEffortId("off");
const HIGH_REASONING_EFFORT = ReasoningEffortId("high");
const MAX_REASONING_EFFORT = ReasoningEffortId("max");
const REASONING_EFFORTS = [
	{
		id: OFF_REASONING_EFFORT,
		name: "Off"
	},
	{
		id: HIGH_REASONING_EFFORT,
		name: "High"
	},
	{
		id: MAX_REASONING_EFFORT,
		name: "Max"
	}
];
const OFF_ONLY_REASONING_EFFORTS = [{
	id: OFF_REASONING_EFFORT,
	name: "Off"
}];
function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name ?? model.id,
		...model.description === void 0 ? {} : { description: model.description },
		inputModalities: ["text", "image"]
	};
}
function providerRetryAfterMs(value) {
	if (value === null) return void 0;
	if (/^\d+$/.test(value)) {
		const delay = Number(value) * 1e3;
		return Number.isFinite(delay) && delay > 0 ? delay : void 0;
	}
	const delay = Date.parse(value) - Date.now();
	return Number.isFinite(delay) && delay > 0 ? delay : void 0;
}
function requestId(headers) {
	const value = headers.get("x-request-id") ?? headers.get("x-deepseek-request-id");
	return value === null || value.length === 0 ? void 0 : ProviderRequestId(value);
}
/**
* Map an HTTP status to a stable LlmError code.
* @param status - status of a non-2xx provider response.
* @param error - parsed provider error body, when available.
* @returns the normalized harness error code.
*/
function httpErrorCode(status, error) {
	if (status === 401 || status === 403) return "AUTH";
	const detail = [
		error?.code,
		error?.type,
		error?.message
	].filter(Boolean).join(" ");
	if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
	if (status === 429) return "RATE_LIMIT";
	if (status === 400) {
		if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
		return "INVALID_REQUEST";
	}
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
}
/**
* The first real `LlmAdapter`. One instance serves every model name it was
* registered under (the harness model name IS the wire model name).
*
* One stable signal reaches both initial fetch and body reads. Caller aborts
* map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
*/
var DeepSeekAdapter = class extends LlmAdapter {
	config;
	constructor(config) {
		super();
		this.config = config;
	}
	/** 递归把图片块（含 tool-result 嵌套）替换成视觉文字描述，纯文本线路不再抛错。 */
	async preprocessImages(options) {
		const attachments = this.config.resolveAttachments?.();
		if (attachments === void 0) return options;
		const state = { changed: false };
		const messages = [];
		for (const message of options.messages) {
			const content = await convertContentImages(message.content, attachments, options.signal, state);
			messages.push({ ...message, content });
		}
		return state.changed ? { ...options, messages } : options;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "DeepSeek"
		};
	}
	providerRetryPolicy(_provider) {
		return this.config.options().retryPolicy;
	}
	listModels(provider) {
		return Promise.resolve(this.config.options().models.map((model) => modelInfo(provider, model)));
	}
	resolveModel(provider, model, _signal) {
		const connection = this.config.options();
		const configured = connection.models.find((entry) => entry.id === model);
		const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
		return Promise.resolve({
			...configured === void 0 ? {
				provider,
				id: model,
				name: model,
				inputModalities: ["text", "image"]
			} : modelInfo(provider, configured),
			context: { contextWindow },
			defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
			...connection.defaults.thinking === "disabled" ? { reasoning: {
				efforts: OFF_ONLY_REASONING_EFFORTS,
				defaultEffort: OFF_REASONING_EFFORT
			} } : { reasoning: {
				efforts: REASONING_EFFORTS,
				defaultEffort: connection.defaults.reasoningEffort === "off" ? OFF_REASONING_EFFORT : connection.defaults.reasoningEffort === "max" ? MAX_REASONING_EFFORT : HIGH_REASONING_EFFORT
			} }
		});
	}
	async *stream(options) {
		const env_1 = {
			stack: [],
			error: void 0,
			hasError: false
		};
		try {
			const connection = this.config.options();
			const apiKey = await this.config.resolveApiKey(connection);
			const userId = this.config.resolveUserId();
			const consumer = new AbortController();
			const watchdog = __addDisposableResource(env_1, idleWatchdog(options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]), connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE), false);
			const preparedOptions = await this.preprocessImages(options);
			const iterator = this.request(preparedOptions, watchdog.signal, connection, apiKey, userId, () => {
				watchdog.pulse();
			})[Symbol.asyncIterator]();
			let exhausted = false;
			try {
				while (true) {
					const result = await watchdog.next(iterator);
					if (result.done) {
						exhausted = true;
						return;
					}
					yield result.value;
				}
			} catch (error) {
				if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) throw new LlmError(`DeepSeek stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
				if (options.signal?.aborted) throw new LlmError("DeepSeek request aborted by caller", "ABORTED", { cause: error });
				if (error instanceof LlmError) throw error;
				throw new LlmError(`DeepSeek API stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
			} finally {
				consumer.abort("DeepSeek stream consumer stopped");
				if (!exhausted && iterator.return !== void 0) try {
					await iterator.return();
				} catch (_abortedTransportTeardown) {}
			}
		} catch (e_1) {
			env_1.error = e_1;
			env_1.hasError = true;
		} finally {
			__disposeResources(env_1);
		}
	}
	async *request(options, signal, connection, apiKey, userId, onComment) {
		const body = serializeRequest(options, connection.defaults);
		const payload = JSON.stringify(body);
		const headers = {
			"authorization": `Bearer ${apiKey}`,
			"content-type": "application/json",
			"accept": "text/event-stream",
			...attributionHeaders(),
			"x-deepseek-harness-user-id": String(userId),
			...options.sessionId !== void 0 ? { "x-deepseek-harness-session-id": String(options.sessionId) } : {},
			...options.purpose === "compaction" ? { "x-deepseek-harness-compact": "1" } : {}
		};
		let response;
		try {
			response = await fetch(`${connection.baseURL}/chat/completions`, {
				method: "POST",
				headers,
				body: payload,
				signal
			});
		} catch (error) {
			if (signal.aborted) throw error;
			throw new LlmError(`DeepSeek API request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
		}
		if (!response.ok) {
			let message = `DeepSeek API error (HTTP ${response.status})`;
			let providerError;
			try {
				providerError = (await response.json()).error;
				if (providerError?.message) message = providerError.message;
			} catch {}
			const delay = providerRetryAfterMs(response.headers.get("retry-after"));
			const id = requestId(response.headers);
			throw new LlmError(message, httpErrorCode(response.status, providerError), {
				status: response.status,
				...delay === void 0 ? {} : { providerRetryAfterMs: delay },
				...id === void 0 ? {} : { requestId: id }
			});
		}
		if (!response.body) throw new LlmError("DeepSeek API returned no response body", "EMPTY_RESPONSE");
		yield* translate(parseSse(response.body, onComment));
	}
};
//#endregion
//#region lib/types/index.js
/**
* Register a {@link DeepSeekAdapter} for the `deepseek-official` provider route on
* `ctx.llm`, with connection facts resolved per request instead of frozen at
* load: the plugin layers its `cordis.yml` entry config under the optional
* `llm-deepseek` user-settings section (`ctx.settings`) and resolves the API
* key through the optional credential seam (`ctx.credentials`), so a changed
* base URL, catalog, or key reaches the very next request without restarting
* anything, while an in-flight stream keeps the facts it started with. The
* one registration-captured fact — the retry policy — re-registers the route
* in place when it changes.
* @module @deepseek-ai/dsh-llm-deepseek
*/
const name = "llm-deepseek";
const inject = ["llm"];
const NS = settingsNamespace("llm-deepseek");
const DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY";
/** The single provider route this plugin owns. */
const PROVIDER = "deepseek-official";
const DEFAULT_MODELS = [{
	id: "deepseek-v4-flash",
	name: "DeepSeek-V4-Flash",
	contextWindow: DEFAULT_CONTEXT_WINDOW
}, {
	id: "deepseek-v4-pro",
	name: "DeepSeek-V4-Pro",
	contextWindow: DEFAULT_CONTEXT_WINDOW
}];
const catalogModel = z.object({
	id: z.string().required(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1)
});
const Config = z.object({
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	baseURL: z.string(),
	thinking: z.union(["enabled", "disabled"]),
	reasoningEffort: z.union([
		"off",
		"high",
		"max"
	]),
	maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	models: z.array(catalogModel).default(DEFAULT_MODELS),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	retryPolicy: RetryPolicySchema
});
/** Public API default; the internal endpoint comes from $DEEPSEEK_BASE_URL. */
const PUBLIC_BASE_URL = "https://api.deepseek.com";
/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models) {
	const seen = /* @__PURE__ */ new Set();
	return (models ?? DEFAULT_MODELS).map((model) => {
		if (model.id.length === 0) throw new Error("llm-deepseek: catalog model ids must be non-empty");
		if (model.name !== void 0 && model.name.length === 0) throw new Error(`llm-deepseek: catalog model "${model.id}" has an empty name`);
		if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) throw new Error(`llm-deepseek: catalog model "${model.id}" contextWindow must be a positive integer`);
		if (model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) throw new Error(`llm-deepseek: catalog model "${model.id}" maxTokens must be a positive integer`);
		if (seen.has(model.id)) throw new Error(`llm-deepseek: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		return {
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name },
			...model.description === void 0 ? {} : { description: model.description },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
			...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }
		};
	});
}
/**
* The one explicit resolve step from raw config to validated connection
* facts. Programmatic construction may bypass Schemastery normalization, so
* every default and bound is re-judged here — for the composition entry at
* load (fail loud) and for each settings snapshot at its first use.
* @param config - raw plugin config or resolved settings snapshot.
* @param environment - this run's environment layers, or `undefined` outside
* the product CLI. Every layer may supply an endpoint: the product trusts the
* project it is launched in, so a checkout can point its own agent at the
* gateway that checkout is meant to use.
* @returns validated connection facts plus the credential reference.
*/
function resolveAdapterOptions(config, environment) {
	if (config.thinking === "disabled" && config.reasoningEffort !== void 0 && config.reasoningEffort !== "off") throw new Error("llm-deepseek: only reasoningEffort \"off\" can be configured when thinking is disabled");
	if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) throw new Error("llm-deepseek: defaultContextWindow must be a positive integer");
	if (config.maxTokens !== void 0 && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) throw new Error("llm-deepseek: maxTokens must be a positive safe integer");
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 3e5;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`llm-deepseek: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	return {
		apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
		baseURL: config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? "https://api.deepseek.com",
		defaults: {
			thinking: config.thinking,
			reasoningEffort: config.reasoningEffort
		},
		maxTokens: config.maxTokens ?? 256e3,
		defaultContextWindow: config.defaultContextWindow ?? 1e6,
		models: resolveModels(config.models),
		streamIdleTimeoutMs,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-deepseek: retryPolicy")
	};
}
function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		try {
			const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === void 0) throw error;
			lastRaw = raw;
			ctx.logger.error("llm-deepseek: keeping the last good configuration after an invalid settings section");
			ctx.logger.error(error);
			return lastGood;
		}
	};
	options();
	const resolveApiKey = async (connection) => {
		const ref = connection.apiKeyEnv;
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const hit = await credentials.resolve(ref);
			if (hit !== void 0) return assertUsableApiKey(hit.value, "llm-deepseek", ref);
		} else {
			const ambient = launchEnvironmentOf(ctx).get(ref);
			if (ambient !== void 0 && ambient.value.length > 0) return assertUsableApiKey(ambient.value, "llm-deepseek", ref);
		}
		throw new LlmError(`llm-deepseek: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service (the web Models page writes it), or export ${ref} in the launching environment`, "MISSING_CREDENTIAL");
	};
	let userId;
	const resolveUserId = () => userId ??= getOrCreateAnonymousUserId();
	const adapter = new DeepSeekAdapter({
		options,
		resolveApiKey,
		resolveUserId,
		resolveAttachments: () => ctx.get("attachments")
	});
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "DeepSeek",
		settingsNs: NS,
		settingsPath: []
	}]);
	const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
	let registeredPolicy = options().retryPolicy;
	const ensureRegistrationFacts = () => {
		const policy = options().retryPolicy;
		if (deepEqualJson(policy, registeredPolicy)) return;
		registration.replace([PROVIDER]);
		registeredPolicy = policy;
	};
	installSettingsSection(ctx, NS, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: ensureRegistrationFacts
	});
}
//#endregion
export { Config, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, DeepSeekAdapter, PUBLIC_BASE_URL, apply, inject, name, resolveAdapterOptions };
