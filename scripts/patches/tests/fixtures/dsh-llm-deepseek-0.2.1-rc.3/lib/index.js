import z from "@deepseek-ai/schemastery";
import { isVolatile } from "@deepseek-ai/cosmokit";
import { assertNever, deepEqualJson } from "@deepseek-ai/dsh-util-values";
import { APP_IDENTITY, IMAGE_OFFLOAD_REQUIRED_CODE, LlmAdapter, LlmError, ProviderRequestId, ReasoningEffortId, RetryPolicySchema, ToolCallId, attributionHeaders, contentHasImage, errorChain, isContextWindowExceededError, isQuotaExceededError, offloadedImageText, projectOffloadedImages, requestImageHandleText, requiredImageOffload, resolveImageAttachmentAccess, resolveRetryPolicy, textOnlyImageText } from "@deepseek-ai/dsh-llm";
import { MAX_TIMER_DELAY_MS, deadline, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { ImageVariantId, longEdgeDimensions, requestImageDimensions } from "@deepseek-ai/dsh-attachment";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { getOrCreateAnonymousUserId } from "@deepseek-ai/dsh-anonymous-user-id";
import semver from "semver";
//#region lib/types/models.js
/** Context window of both official models, as the official `/models` listing declares it. */
const OFFICIAL_CONTEXT_WINDOW = 1048576;
/** Advisory official model entries; deployments may replace the catalog. */
const DEFAULT_MODELS = [{
	id: "deepseek-flash",
	name: "DeepSeek-V4.1-Flash",
	contextWindow: OFFICIAL_CONTEXT_WINDOW,
	inputModalities: ["text", "image"],
	systemPromptUpdate: "in-history",
	toolUpdate: "addition-only"
}, {
	id: "deepseek-v4-pro",
	name: "DeepSeek-V4-Pro",
	description: "Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.",
	contextWindow: OFFICIAL_CONTEXT_WINDOW
}];
//#endregion
//#region lib/types/defaults.js
/** Shared provider limits and Chat Files API defaults. */
/** Default maximum idle interval while an adapter stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Default combined request/response context capacity. */
const DEFAULT_CONTEXT_WINDOW = 1e6;
/** Default per-request output-token cap. */
const DEFAULT_MAX_TOKENS = 256e3;
/** Default bound on accumulated base64 image payload after Files API fallback. */
const DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
/** Deterministic raw-byte removal step. */
const DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM = 64 * 1024 * 1024;
/** Deterministic base64-byte removal step after Files API fallback. */
const DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM = 10 * 1024 * 1024;
/** Deterministic image-count removal step. */
const DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM = 20;
/** Default explicit lifetime for uploaded images. */
const DEFAULT_FILE_EXPIRY_SECONDS = 10080 * 60;
/** Default proactive refresh window for indexed file ids. */
const DEFAULT_FILE_REFRESH_MARGIN_SECONDS = 3600;
/** Default number of oldest harness-owned files removed on quota recovery. */
const DEFAULT_FILE_QUOTA_CLEANUP_BATCH = 100;
/** Default deadline for resolving one request image through the Files API. */
const DEFAULT_FILES_API_TIMEOUT_MS = 6e4;
//#endregion
//#region lib/types/image-tokens.js
/**
* DeepSeek vision-token accounting: the provider's published image-token
* calculator (api-docs.deepseek.com, Token & Token Usage) ported verbatim in
* its current `v41` configuration. The provider scales an image below
* 544×544 total pixels up, aligns it to a 14px-patch grid, downsamples 3:1
* per axis into token cells, and caps one image at 1024 tokens by solving the
* largest aspect-preserving grid inside that budget. The count is exact: this
* configuration has no alignment pad and no aspect-ratio clamp. Actual usage
* remains authoritative.
*
* @module dsh-llm-deepseek/image-tokens
*/
/** Vision patch edge in pixels. */
const PATCH_SIZE = 14;
/** Per-axis patch-to-token downsampling ratio. */
const DOWNSAMPLE_RATIO = 3;
/** Provider cap on tokens for one request image. */
const MAX_IMAGE_TOKENS = 1024;
/** Total-pixel floor; smaller images are scaled up before grid projection. */
const MIN_PIXELS = 544 * 544;
/** Pixels covered by one token cell along either axis. */
const CELL_SIZE = PATCH_SIZE * DOWNSAMPLE_RATIO;
const intDiv = (value, divisor) => Math.floor(value / divisor);
const ceilDiv = (value, divisor) => Math.floor((value + divisor - 1) / divisor);
/** Token count of one grid: every row carries a separator, plus two framing tokens. */
function gridTokens(gridHeight, gridWidth) {
	return gridHeight * (gridWidth + 1) + 2;
}
/** Token-cell count along one padded pixel axis. */
function gridCells(paddedLength) {
	return ceilDiv(intDiv(paddedLength, PATCH_SIZE), DOWNSAMPLE_RATIO);
}
/** Solve the largest grid within `budget` tokens preserving the aspect ratio. */
function solveResizeRatio(height, width, budget) {
	const aspect = height / width;
	const idealGridWidth = Math.sqrt((budget - 2) / aspect + .25) - .5;
	const idealGridHeight = idealGridWidth * aspect;
	let bestHeight;
	let bestWidth;
	if (idealGridWidth < 1) {
		const solvedGridWidth = 1;
		const solvedGridHeight = intDiv(budget - 2, 2);
		bestWidth = solvedGridWidth * CELL_SIZE;
		bestHeight = solvedGridHeight * CELL_SIZE;
	} else if (idealGridHeight < 1) {
		const solvedGridHeight = 1;
		bestWidth = (intDiv(budget - 2, solvedGridHeight) - 1) * CELL_SIZE;
		bestHeight = solvedGridHeight * CELL_SIZE;
	} else {
		const solvedGridWidth = Math.trunc(idealGridWidth);
		const solvedGridHeight = Math.trunc(idealGridHeight);
		const scale = Math.min(solvedGridWidth * CELL_SIZE / width, solvedGridHeight * CELL_SIZE / height);
		bestWidth = Math.trunc(width * scale / PATCH_SIZE) * PATCH_SIZE;
		bestHeight = Math.trunc(height * scale / PATCH_SIZE) * PATCH_SIZE;
	}
	const gridHeight = gridCells(bestHeight);
	const gridWidth = gridCells(bestWidth);
	return {
		gridHeight,
		gridWidth,
		bestHeight,
		bestWidth,
		numTokens: gridTokens(gridHeight, gridWidth)
	};
}
/** Project padded pixel dimensions onto the largest in-budget token grid. */
function safeResize(height, width, paddedHeight, paddedWidth) {
	const gridHeight = gridCells(paddedHeight);
	const gridWidth = gridCells(paddedWidth);
	const direct = {
		gridHeight,
		gridWidth,
		bestHeight: paddedHeight,
		bestWidth: paddedWidth,
		numTokens: gridTokens(gridHeight, gridWidth)
	};
	if (direct.numTokens <= MAX_IMAGE_TOKENS) return direct;
	const solved = solveResizeRatio(height, width, MAX_IMAGE_TOKENS);
	/* v8 ignore next 3 -- the published solver's assertion; the closed-form
	solve stays within the budget for every positive geometry. */
	if (solved.numTokens > MAX_IMAGE_TOKENS) throw new Error(`deepseek image tokens: no grid fits the token budget for ${width}x${height}`);
	return solved;
}
/** One scale-pad-project pass; the caller iterates it to a fixpoint. */
function resizeOnce(width, height) {
	let scaledWidth = width;
	let scaledHeight = height;
	const pixels = scaledWidth * scaledHeight;
	if (pixels < MIN_PIXELS && pixels > 0) {
		const scale = Math.sqrt(MIN_PIXELS / pixels);
		scaledWidth = Math.trunc(scaledWidth * scale);
		scaledHeight = Math.trunc(scaledHeight * scale);
	}
	const paddedWidth = ceilDiv(scaledWidth, PATCH_SIZE) * PATCH_SIZE;
	const paddedHeight = ceilDiv(scaledHeight, PATCH_SIZE) * PATCH_SIZE;
	return safeResize(scaledHeight, scaledWidth, paddedHeight, paddedWidth);
}
function sameResize(a, b) {
	return a.gridHeight === b.gridHeight && a.gridWidth === b.gridWidth && a.bestHeight === b.bestHeight && a.bestWidth === b.bestWidth && a.numTokens === b.numTokens;
}
/**
* Dimensions the harness sends so the provider keeps the whole image: the
* source itself when its patch-padded grid fits the token cap, otherwise the
* source aspect ratio at the solved grid's long edge. The provider pads the
* short edge to whole patches on its side. Rounding the aspect-preserving
* short edge can change the token count from the source's solved grid;
* request pricing uses the sent dimensions. Small images are never enlarged.
* @param width - positive integer source width in pixels.
* @param height - positive integer source height in pixels.
* @returns the request dimensions to encode.
*/
function deepSeekRequestImageDimensions(width, height) {
	const paddedWidth = ceilDiv(width, PATCH_SIZE) * PATCH_SIZE;
	if (gridTokens(gridCells(ceilDiv(height, PATCH_SIZE) * PATCH_SIZE), gridCells(paddedWidth)) <= MAX_IMAGE_TOKENS) return {
		width,
		height
	};
	const solved = solveResizeRatio(height, width, MAX_IMAGE_TOKENS);
	return longEdgeDimensions(width, height, width >= height ? solved.bestWidth : solved.bestHeight);
}
/**
* Vision tokens DeepSeek charges for one request image of the given
* dimensions.
* @param width - positive integer request-image width in pixels.
* @param height - positive integer request-image height in pixels.
* @returns the provider vision-token price, at most 1024.
*/
function deepSeekImageTokens(width, height) {
	let result = resizeOnce(width, height);
	for (let iteration = 1; iteration < 10; iteration += 1) {
		const next = resizeOnce(result.bestWidth, result.bestHeight);
		if (sameResize(next, result)) return result.numTokens;
		result = next;
	}
	/* v8 ignore next 2 -- the published solver's non-convergence guard; every
	pass is a projection, so a second identical pass is a fixpoint. */
	throw new Error(`deepseek image tokens: resize did not converge for ${width}x${height}`);
}
//#endregion
//#region lib/types/request-pricing.js
/**
* Provider-side request-image pricing for DeepSeek routes: prices every
* retained surface occurrence at its per-model request target with
* the published vision-token accounting, and every occurrence the surface
* marks offloaded as its placeholder text. Consumed synchronously by the
* token meter through `LlmAdapter.imageRequestPricing`; provider usage
* remains the authoritative anchor for completed requests.
*
* @module dsh-llm-deepseek/request-pricing
*/
/** Default bound on accumulated file-referenced image bytes per request. */
const DEFAULT_MAX_REQUEST_FILES_BYTES = 128 * 1024 * 1024;
/** Provider request image-count limit. */
const DEFAULT_MAX_IMAGES_PER_REQUEST = 600;
/** Total-pixel budget matching provider low-detail image input. */
const DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET = 512 * 512;
/** Encoded-byte target for one deterministic model-request image; the smallest quality-ladder output is used when no quality fits. */
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/**
* Provider per-side limit for a request carrying 15 or more images, applied
* to every request image so the image count never changes a projection.
*/
const REQUEST_IMAGE_MAX_DIMENSION = 4096;
/**
* Resolve the encoded-byte target one DeepSeek model route applies to every request image.
* @param model - Advertised model route and its optional image overrides.
* @returns the route's encoded-byte target.
* @internal
*/
function resolveRequestImageMaxBytes(model) {
	return model.imageMaxBytes ?? 2097152;
}
/**
* Resolve the deterministic request target one DeepSeek model route chooses
* for one source image: the published token grid unless the model overrides
* it with a pixel budget, then the provider per-side limit, then the route's
* encoded-byte target. Small images are never enlarged.
* @param model - Advertised model route and its optional image overrides.
* @param source - intrinsic dimensions of the normalized attachment.
* @returns Complete request dimensions and encoded-byte target.
* @internal
*/
function resolveRequestImageTarget(model, source) {
	const budget = model.imagePixelBudget === "low" ? DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET : model.imagePixelBudget;
	const projected = budget === void 0 ? deepSeekRequestImageDimensions(source.width, source.height) : requestImageDimensions(source.width, source.height, budget);
	return {
		...Math.max(projected.width, projected.height) > 4096 ? longEdgeDimensions(source.width, source.height, REQUEST_IMAGE_MAX_DIMENSION) : projected,
		maxBytes: resolveRequestImageMaxBytes(model)
	};
}
/**
* Price one occurrence a text-only route substitutes with deterministic text,
* reproducing the `projectImagesForTextModel` substitution `LlmRuntime`
* applies before dispatching to a route without the `image` modality.
*/
function textOnlyPrice(block) {
	return {
		visualTokens: 0,
		text: textOnlyImageText(block.attachment)
	};
}
/**
* Build the request-image pricing for one DeepSeek route from a validated
* connection snapshot. Uncatalogued and text-only models price every
* occurrence as its deterministic text substitution; image-capable models
* price an offloaded occurrence as its placeholder text and a retained one by
* its projected request dimensions, with each occurrence's handle or
* placeholder text built through the same access resolution the serializer
* uses. Access paths resolve at pricing time, so a path that changes before
* the request only shifts the text price by its own length.
* @param connection - validated connection facts of the pricing resolution.
* @param model - exact model id named by the request header.
* @param resolveAccess - current execution-world access resolution shared with request serialization.
* @returns synchronous per-occurrence pricing for the route.
*/
function deepSeekImageRequestPricing(connection, model, resolveAccess) {
	const catalogModel = connection.models.find((entry) => entry.id === model);
	if (catalogModel?.inputModalities?.includes("image") !== true) return { priceImages: (images) => images.map(textOnlyPrice) };
	return { priceImages: (images) => images.map(({ attachment: ref, offloaded }) => {
		if (offloaded === true) return {
			visualTokens: 0,
			text: offloadedImageText(ref, resolveAccess?.(ref))
		};
		const target = resolveRequestImageTarget(catalogModel, ref);
		return {
			visualTokens: deepSeekImageTokens(target.width, target.height),
			text: requestImageHandleText(ref, target, resolveAccess?.(ref))
		};
	}) };
}
//#endregion
//#region lib/types/config.js
const MODEL_MODALITIES = ["text", "image"];
/** Read the current value behind every reference of a validated Config.
* @param config Parsed plugin Config.
* @returns Plain options for the resolver.
*/
function plainOptions(config) {
	return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]));
}
/**
* Schemas of the catalog-entry fields other than `id` and `inputModalities`,
* whose requiredness and defaults differ between a `models` entry and a
* provider's per-model overrides.
*/
const catalogModelFields = {
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	imagePixelBudget: z.union([z.number().step(1).min(1), "low"]),
	imageMaxBytes: z.number().step(1).min(1),
	systemPromptUpdate: z.const("in-history"),
	toolUpdate: z.union(["in-history", "addition-only"])
};
const catalogModel = z.object({
	id: z.string().required(),
	...catalogModelFields,
	inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(["text"])
});
/** Shared schema fields for Messages protocol options. */
const deepSeekConfigFields = {
	baseURL: z.string().volatile(),
	thinking: z.union(["enabled", "disabled"]).volatile(),
	reasoningEffort: z.union([
		"off",
		"low",
		"high",
		"max"
	]).volatile(),
	maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS).volatile(),
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW).volatile(),
	models: z.array(catalogModel).default(DEFAULT_MODELS).volatile(),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS).volatile(),
	maxRequestFilesBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_FILES_BYTES).volatile(),
	maxInlineRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES).volatile(),
	maxImagesPerRequest: z.number().step(1).min(1).default(600).volatile(),
	imageOffloadByteQuantum: z.number().step(1).min(1).default(DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM).volatile(),
	inlineImageOffloadByteQuantum: z.number().step(1).min(1).default(DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM).volatile(),
	imageOffloadCountQuantum: z.number().step(1).min(1).default(20).volatile(),
	filesApiTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_FILES_API_TIMEOUT_MS).volatile(),
	fileExpiresAfterSeconds: z.number().step(1).min(3600).max(2592e3).default(DEFAULT_FILE_EXPIRY_SECONDS).volatile(),
	fileRefreshMarginSeconds: z.number().step(1).min(0).default(DEFAULT_FILE_REFRESH_MARGIN_SECONDS).volatile(),
	fileQuotaCleanupBatch: z.number().step(1).min(1).max(1e3).default(100).volatile(),
	retryPolicy: RetryPolicySchema.volatile()
};
const Config = z.object(deepSeekConfigFields);
/** Public API default; the internal endpoint comes from $DEEPSEEK_BASE_URL. */
const PUBLIC_BASE_URL = "https://api.deepseek.com/anthropic";
/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
/**
* Whether a resolved catalog is the built-in one, which is what a `models`
* setting nobody customized resolves to.
* @param models - catalog resolved by {@link resolveAdapterOptions}.
* @returns whether `models` equals the resolved built-in catalog, entry by entry and in order.
*/
function isBuiltInCatalog(models) {
	return deepEqualJson(models, resolveModels(DEFAULT_MODELS));
}
/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models) {
	const seen = /* @__PURE__ */ new Set();
	return (models ?? DEFAULT_MODELS).map((model) => {
		if (Object.hasOwn(model, "imageDetail")) throw new Error("llm-deepseek: catalog model imageDetail is no longer supported; use imagePixelBudget");
		if (model.id.length === 0) throw new Error("llm-deepseek: catalog model ids must be non-empty");
		if (model.name !== void 0 && model.name.length === 0) throw new Error(`llm-deepseek: catalog model "${model.id}" has an empty name`);
		if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) throw new Error(`llm-deepseek: catalog model "${model.id}" contextWindow must be a positive integer`);
		if (model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) throw new Error(`llm-deepseek: catalog model "${model.id}" maxTokens must be a positive integer`);
		const inputModalities = model.inputModalities ?? ["text"];
		if (inputModalities.length === 0) throw new Error(`llm-deepseek: catalog model "${model.id}" inputModalities must not be empty`);
		if (inputModalities.some((modality) => !MODEL_MODALITIES.includes(modality))) throw new Error(`llm-deepseek: catalog model "${model.id}" inputModalities must contain only "text" and "image"`);
		if (new Set(inputModalities).size !== inputModalities.length) throw new Error(`llm-deepseek: catalog model "${model.id}" inputModalities must not contain duplicates`);
		const hasImage = inputModalities.includes("image");
		if (!hasImage && (model.imagePixelBudget !== void 0 || model.imageMaxBytes !== void 0)) throw new Error(`llm-deepseek: text-only catalog model "${model.id}" cannot declare image request limits`);
		if (model.imagePixelBudget !== void 0 && model.imagePixelBudget !== "low" && (!Number.isSafeInteger(model.imagePixelBudget) || model.imagePixelBudget <= 0)) throw new Error(`llm-deepseek: catalog model "${model.id}" imagePixelBudget must be "low" or a positive safe integer`);
		if (model.imageMaxBytes !== void 0 && (!Number.isSafeInteger(model.imageMaxBytes) || model.imageMaxBytes <= 0)) throw new Error(`llm-deepseek: catalog model "${model.id}" imageMaxBytes must be a positive safe integer`);
		const systemPromptUpdate = model.systemPromptUpdate;
		if (systemPromptUpdate !== void 0 && systemPromptUpdate !== "in-history") throw new Error(`llm-deepseek: catalog model "${model.id}" systemPromptUpdate must be "in-history" when present`);
		const toolUpdate = model.toolUpdate;
		if (toolUpdate !== void 0 && toolUpdate !== "in-history" && toolUpdate !== "addition-only") throw new Error(`llm-deepseek: catalog model "${model.id}" toolUpdate must be "in-history" or "addition-only" when present`);
		if (seen.has(model.id)) throw new Error(`llm-deepseek: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		return {
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name },
			...model.description === void 0 ? {} : { description: model.description },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
			...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
			...model.systemPromptUpdate === void 0 ? {} : { systemPromptUpdate: model.systemPromptUpdate },
			...model.toolUpdate === void 0 ? {} : { toolUpdate: model.toolUpdate },
			inputModalities: [...inputModalities],
			...hasImage ? {
				...model.imagePixelBudget === void 0 ? {} : { imagePixelBudget: model.imagePixelBudget },
				imageMaxBytes: model.imageMaxBytes ?? 2097152
			} : {}
		};
	});
}
/**
* The one explicit resolve step from raw config to validated protocol
* settings. Programmatic construction may bypass Schemastery normalization, so
* every default and bound is re-judged here — for the composition entry at
* load (fail loud) and for each settings snapshot at its first use.
* @param config - raw plugin config or resolved settings snapshot.
* @param environment - this run's environment layers, or `undefined` outside
* the product CLI. Every layer may supply an endpoint: the product trusts the
* project it is launched in, so a checkout can point its own agent at the
* gateway that checkout is meant to use.
* @returns validated protocol settings; `models` holds one resolved entry per
* input model in input order, or the built-in catalog when `models` is absent.
*/
function resolveAdapterOptions(config, environment) {
	if (Object.hasOwn(config, "protocol")) throw new Error("llm-deepseek: protocol is not configurable; remove it and use a Messages-compatible baseURL");
	if (config.thinking === "disabled" && config.reasoningEffort !== void 0 && config.reasoningEffort !== "off") throw new Error("llm-deepseek: only reasoningEffort \"off\" can be configured when thinking is disabled");
	if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) throw new Error("llm-deepseek: defaultContextWindow must be a positive integer");
	if (config.maxTokens !== void 0 && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) throw new Error("llm-deepseek: maxTokens must be a positive safe integer");
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 3e5;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`llm-deepseek: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	const maxRequestFilesBytes = config.maxRequestFilesBytes ?? 134217728;
	if (!Number.isSafeInteger(maxRequestFilesBytes) || maxRequestFilesBytes <= 0) throw new Error("llm-deepseek: maxRequestFilesBytes must be a positive safe integer");
	const maxInlineRequestImageBytes = config.maxInlineRequestImageBytes ?? 20971520;
	if (!Number.isSafeInteger(maxInlineRequestImageBytes) || maxInlineRequestImageBytes <= 0) throw new Error("llm-deepseek: maxInlineRequestImageBytes must be a positive safe integer");
	const maxImagesPerRequest = config.maxImagesPerRequest ?? 600;
	if (!Number.isSafeInteger(maxImagesPerRequest) || maxImagesPerRequest <= 0) throw new Error("llm-deepseek: maxImagesPerRequest must be a positive safe integer");
	const imageOffloadByteQuantum = config.imageOffloadByteQuantum ?? 67108864;
	if (!Number.isSafeInteger(imageOffloadByteQuantum) || imageOffloadByteQuantum <= 0) throw new Error("llm-deepseek: imageOffloadByteQuantum must be a positive safe integer");
	if (imageOffloadByteQuantum > maxRequestFilesBytes) throw new Error("llm-deepseek: imageOffloadByteQuantum must not exceed maxRequestFilesBytes");
	const inlineImageOffloadByteQuantum = config.inlineImageOffloadByteQuantum ?? 10485760;
	if (!Number.isSafeInteger(inlineImageOffloadByteQuantum) || inlineImageOffloadByteQuantum <= 0) throw new Error("llm-deepseek: inlineImageOffloadByteQuantum must be a positive safe integer");
	if (inlineImageOffloadByteQuantum > maxInlineRequestImageBytes) throw new Error("llm-deepseek: inlineImageOffloadByteQuantum must not exceed maxInlineRequestImageBytes");
	const imageOffloadCountQuantum = config.imageOffloadCountQuantum ?? 20;
	if (!Number.isSafeInteger(imageOffloadCountQuantum) || imageOffloadCountQuantum <= 0) throw new Error("llm-deepseek: imageOffloadCountQuantum must be a positive safe integer");
	if (imageOffloadCountQuantum > maxImagesPerRequest) throw new Error("llm-deepseek: imageOffloadCountQuantum must not exceed maxImagesPerRequest");
	const filesApiTimeoutMs = config.filesApiTimeoutMs ?? 6e4;
	if (!Number.isFinite(filesApiTimeoutMs) || filesApiTimeoutMs <= 0 || filesApiTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`llm-deepseek: filesApiTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	const fileExpiresAfterSeconds = config.fileExpiresAfterSeconds ?? 604800;
	if (!Number.isSafeInteger(fileExpiresAfterSeconds) || fileExpiresAfterSeconds < 3600 || fileExpiresAfterSeconds > 2592e3) throw new Error("llm-deepseek: fileExpiresAfterSeconds must be an integer from 3600 through 2592000");
	const fileRefreshMarginSeconds = config.fileRefreshMarginSeconds ?? 3600;
	if (!Number.isSafeInteger(fileRefreshMarginSeconds) || fileRefreshMarginSeconds < 0 || fileRefreshMarginSeconds >= fileExpiresAfterSeconds) throw new Error("llm-deepseek: fileRefreshMarginSeconds must be a non-negative integer below fileExpiresAfterSeconds");
	const fileQuotaCleanupBatch = config.fileQuotaCleanupBatch ?? 100;
	if (!Number.isSafeInteger(fileQuotaCleanupBatch) || fileQuotaCleanupBatch < 1 || fileQuotaCleanupBatch > 1e3) throw new Error("llm-deepseek: fileQuotaCleanupBatch must be an integer from 1 through 1000");
	const baseURL = config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? "https://api.deepseek.com/anthropic";
	const parsed = new URL(baseURL);
	if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("llm-deepseek: Messages baseURL must be an HTTP(S) root without credentials, query, or fragment");
	return {
		baseURL,
		defaults: {
			thinking: config.thinking,
			reasoningEffort: config.reasoningEffort
		},
		maxTokens: config.maxTokens ?? 256e3,
		defaultContextWindow: config.defaultContextWindow ?? 1e6,
		models: resolveModels(config.models),
		streamIdleTimeoutMs,
		maxRequestFilesBytes,
		maxInlineRequestImageBytes,
		maxImagesPerRequest,
		imageOffloadByteQuantum,
		inlineImageOffloadByteQuantum,
		imageOffloadCountQuantum,
		filesApiTimeoutMs,
		filePolicy: {
			expiresAfterSeconds: fileExpiresAfterSeconds,
			refreshMarginSeconds: fileRefreshMarginSeconds,
			quotaCleanupBatch: fileQuotaCleanupBatch
		},
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-deepseek: retryPolicy")
	};
}
//#endregion
//#region lib/types/model-info.js
/** Protocol-independent model capabilities and reasoning choices. */
const OFF_REASONING_EFFORT = ReasoningEffortId("off");
const LOW_REASONING_EFFORT = ReasoningEffortId("low");
const HIGH_REASONING_EFFORT = ReasoningEffortId("high");
const MAX_REASONING_EFFORT = ReasoningEffortId("max");
const REASONING_EFFORTS = [
	{
		id: OFF_REASONING_EFFORT,
		name: "Off",
		description: "Use for simple tasks that do not need reasoning."
	},
	{
		id: LOW_REASONING_EFFORT,
		name: "Low",
		description: "Prefer for routine or latency-sensitive tasks."
	},
	{
		id: HIGH_REASONING_EFFORT,
		name: "High",
		description: "The default balance for most tasks."
	},
	{
		id: MAX_REASONING_EFFORT,
		name: "Max",
		description: "Reserve for the hardest quality-first tasks."
	}
];
const OFF_ONLY_REASONING_EFFORTS = [{
	id: OFF_REASONING_EFFORT,
	name: "Off",
	description: "Use for simple tasks that do not need reasoning."
}];
/** Advertise one catalog entry.
* @param provider - registered provider id.
* @param model - advisory catalog entry.
* @returns selector metadata.
*/
function catalogModelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name ?? model.id,
		...model.description === void 0 ? {} : { description: model.description },
		inputModalities: model.inputModalities ?? ["text"]
	};
}
/** Resolve model capabilities against one configuration generation.
* @param connection - validated connection facts.
* @param provider - registered provider id.
* @param model - requested wire model id.
* @returns effective model metadata for this operation.
*/
function modelInfo(connection, provider, model) {
	const configured = connection.models.find((entry) => entry.id === model);
	const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
	return {
		...configured === void 0 ? {
			provider,
			id: model,
			name: model,
			inputModalities: ["text"]
		} : catalogModelInfo(provider, configured),
		context: { contextWindow },
		defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
		...configured?.systemPromptUpdate === void 0 ? {} : { systemPromptUpdate: configured.systemPromptUpdate },
		...configured?.toolUpdate === void 0 ? {} : { toolUpdate: configured.toolUpdate },
		...connection.defaults.thinking === "disabled" ? { reasoning: {
			efforts: OFF_ONLY_REASONING_EFFORTS,
			defaultEffort: OFF_REASONING_EFFORT
		} } : { reasoning: {
			efforts: REASONING_EFFORTS,
			defaultEffort: connection.defaults.reasoningEffort === "off" ? OFF_REASONING_EFFORT : connection.defaults.reasoningEffort === "low" ? LOW_REASONING_EFFORT : connection.defaults.reasoningEffort === "max" ? MAX_REASONING_EFFORT : HIGH_REASONING_EFFORT
		} }
	};
}
//#endregion
//#region lib/types/file-id.js
/** DeepSeek Files API identifiers. @module dsh-llm-deepseek/file-id */
/**
* Brand a provider-returned file identifier after wire validation.
* @param id - non-empty Files API identifier.
* @returns the same string with its provider identity attached at type level.
*/
function DeepSeekFileId(id) {
	return id;
}
/**
* Brand a locally derived namespace digest.
* @param scope - SHA-256 digest of endpoint and API key.
* @returns the same string with namespace identity attached at type level.
*/
function DeepSeekFileScope(scope) {
	return scope;
}
//#endregion
//#region lib/types/messages-api.js
/** Shared DeepSeek Messages API endpoint and header policy. @module dsh-llm-deepseek/messages-api */
/** Required opt-in for Messages file operations and file-referenced image requests. */
const MESSAGES_FILES_BETA = "files-api-2025-04-14";
/** Required opt-in for mid-conversation `tool_addition` and `tool_removal` blocks. */
const MESSAGES_TOOL_CHANGES_BETA = "mid-conversation-tool-changes-2026-07-01";
/**
* Resolve the API root without duplicating an explicit provider version path.
* @param baseURL - validated configured endpoint root.
* @returns the root beneath which Messages resources are exposed.
*/
function messagesApiRoot(baseURL) {
	const base = baseURL.replace(/\/+$/u, "");
	return new URL(base).pathname.endsWith("/v1") ? base : `${base}/v1`;
}
//#endregion
//#region lib/types/files-api.js
/** DeepSeek Files API transport. @module dsh-llm-deepseek/files-api */
/** Minimum provider-supported file lifetime. */
const MIN_FILE_EXPIRY_SECONDS = 3600;
/** Maximum provider-supported file lifetime. */
const MAX_FILE_EXPIRY_SECONDS = 2592e3;
/** Maximum Files API upload size. */
const MAX_FILE_UPLOAD_BYTES = 128 * 1024 * 1024;
/** Current per-key file-count quota. */
const MAX_STORED_FILE_COUNT = 1e4;
/** Current per-key storage quota. */
const MAX_STORED_FILE_BYTES = 25 * 1024 * 1024 * 1024;
/** Files API operation failure with its HTTP status retained for recovery policy. */
var DeepSeekFilesError = class extends LlmError {
	/** Parsed provider detail used only for error classification. */
	detail;
	/**
	* @param message - user-readable provider failure.
	* @param status - HTTP status returned by the Files API.
	* @param detail - provider error fields joined for classification.
	*/
	constructor(message, status, detail) {
		super(message, status === 401 || status === 403 ? "AUTH" : status === 429 ? "RATE_LIMIT" : status >= 500 ? "SERVER" : "FILES_API", { status });
		this.name = "DeepSeekFilesError";
		this.detail = detail;
	}
};
/**
* Whether an upload failure reports a provider storage or file-count quota.
* @param error - Files API operation failure.
* @returns whether one bounded remote cleanup and upload retry may recover.
*/
function isFilesQuotaError(error) {
	return error instanceof DeepSeekFilesError && /(?:quota|storage|stored files|file count|too many files)/iu.test(error.detail);
}
function invalidResponse(operation) {
	return new LlmError(`DeepSeek Files API returned an invalid ${operation} response.`, "INVALID_RESPONSE");
}
/** Decode successful Files JSON with operation context; body transport and abort failures retain their identity. */
async function responseJson(response, operation) {
	try {
		return await response.json();
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		throw new LlmError(`DeepSeek Files API returned invalid JSON for ${operation} (HTTP ${response.status}).`, "INVALID_RESPONSE", {
			status: response.status,
			cause: error
		});
	}
}
function parseFileObject(value, operation) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidResponse(operation);
	const wire = value;
	const createdAt = typeof wire.created_at === "string" ? Math.floor(Date.parse(wire.created_at) / 1e3) : NaN;
	if (typeof wire.id !== "string" || wire.id.length === 0 || wire.type !== "file" || typeof wire.mime_type !== "string" || typeof wire.size_bytes !== "number" || !Number.isSafeInteger(wire.size_bytes) || wire.size_bytes < 0 || !Number.isSafeInteger(createdAt) || createdAt < 0 || typeof wire.filename !== "string" || wire.filename.length === 0) throw invalidResponse(operation);
	return {
		id: DeepSeekFileId(wire.id),
		bytes: wire.size_bytes,
		createdAt,
		filename: wire.filename
	};
}
function providerErrorDetail$1(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { detail: "" };
	const error = value.error;
	if (error === null || typeof error !== "object" || Array.isArray(error)) return { detail: "" };
	const fields = error;
	const message = typeof fields.message === "string" ? fields.message : void 0;
	return {
		...message === void 0 ? {} : { message },
		detail: [
			fields.code,
			fields.type,
			fields.message
		].filter((field) => typeof field === "string").join(" ")
	};
}
/** Direct Files client retaining the configured URL root and refusing redirects before credentials can leave its origin. */
var DeepSeekFilesClient = class {
	baseURL;
	authHeaders;
	fetchImpl;
	/**
	* @param options - endpoint, authentication headers, and optional test transport.
	*/
	constructor(options) {
		this.authHeaders = options.headers;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.baseURL = messagesApiRoot(options.baseURL);
	}
	async request(path, init, signal) {
		let response;
		try {
			const headers = new Headers(attributionHeaders());
			for (const [name, value] of Object.entries(this.authHeaders)) headers.set(name, value);
			headers.set("anthropic-version", "2023-06-01");
			headers.set("anthropic-beta", MESSAGES_FILES_BETA);
			response = await this.fetchImpl(`${this.baseURL}${path}`, {
				...init,
				redirect: "error",
				headers,
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new LlmError(`DeepSeek Files API request to ${this.baseURL} failed`, "TRANSPORT", { cause: error });
		}
		if (response.ok) return response;
		let parsed;
		try {
			parsed = await response.json();
		} catch {}
		const { message, detail } = providerErrorDetail$1(parsed);
		throw new DeepSeekFilesError(message ?? `DeepSeek Files API error (HTTP ${response.status})`, response.status, detail);
	}
	/**
	* Upload one image with an explicit expiry.
	* @param input - deterministic request-version bytes, media type, filename, lifetime, and cancellation.
	* @returns the validated file and reuse deadline. Messages omits expiry metadata;
	*   its deadline uses upload creation plus the requested lifetime.
	*/
	async upload(input) {
		if (input.data.byteLength > 134217728) throw new LlmError("DeepSeek Files API upload exceeds 128 MiB.", "INVALID_REQUEST");
		if (!Number.isSafeInteger(input.expiresAfterSeconds) || input.expiresAfterSeconds < 3600 || input.expiresAfterSeconds > 2592e3) throw new LlmError("DeepSeek file expiry must be between 3600 and 2592000 seconds.", "INVALID_REQUEST");
		const form = new FormData();
		form.set("expires_after[anchor]", "created_at");
		form.set("expires_after[seconds]", String(input.expiresAfterSeconds));
		form.set("file", new Blob([Uint8Array.from(input.data).buffer], { type: input.mediaType }), input.filename);
		const file = parseFileObject(await responseJson(await this.request("/files", {
			method: "POST",
			body: form
		}, input.signal), "upload"), "upload");
		return {
			...file,
			expiresAt: file.createdAt + input.expiresAfterSeconds
		};
	}
	/**
	* List one provider-ordered page of files.
	* @param options - pagination and cancellation.
	* @returns the validated page with null cursors omitted.
	*/
	async list(options = {}) {
		const query = new URLSearchParams();
		if (options.after !== void 0) query.set("after_id", options.after);
		if (options.limit !== void 0) query.set("limit", String(options.limit));
		const value = await responseJson(await this.request(`/files?${query.toString()}`, { method: "GET" }, options.signal), "list");
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("list");
		const wire = value;
		const firstId = wire.first_id ?? void 0;
		const lastId = wire.last_id ?? void 0;
		if (!Array.isArray(wire.data) || typeof wire.has_more !== "boolean" || firstId !== void 0 && typeof firstId !== "string" || lastId !== void 0 && typeof lastId !== "string") throw invalidResponse("list");
		return {
			data: wire.data.map((item) => parseFileObject(item, "list")),
			...typeof firstId === "string" ? { firstId: DeepSeekFileId(firstId) } : {},
			...typeof lastId === "string" ? { lastId: DeepSeekFileId(lastId) } : {},
			hasMore: wire.has_more
		};
	}
	/**
	* Retrieve one file object.
	* @param fileId - provider file identifier.
	* @param signal - request cancellation.
	* @returns the validated file object.
	*/
	async retrieve(fileId, signal) {
		return parseFileObject(await responseJson(await this.request(`/files/${encodeURIComponent(fileId)}`, { method: "GET" }, signal), "retrieve"), "retrieve");
	}
	/**
	* Delete one provider file.
	* @param fileId - provider file identifier.
	* @param signal - request cancellation.
	*/
	async delete(fileId, signal) {
		const value = await responseJson(await this.request(`/files/${encodeURIComponent(fileId)}`, { method: "DELETE" }, signal), "delete");
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidResponse("delete");
		const wire = value;
		if (wire.id !== fileId || wire.type !== "file_deleted") throw invalidResponse("delete");
	}
};
//#endregion
//#region lib/types/upload-index.js
/** Durable DeepSeek attachment-to-file-id index. @module dsh-llm-deepseek/upload-index */
var InvalidUploadIndexError = class extends Error {};
/**
* Derive a non-secret stable index namespace without persisting or logging authentication headers.
* @param baseURL - normalized provider endpoint namespace.
* @param credentials - serialized authentication headers used only as hash input.
* @returns branded SHA-256 namespace digest.
*/
function deepSeekFileScope(baseURL, credentials) {
	return DeepSeekFileScope(createHash("sha256").update(baseURL.replace(/\/+$/u, "")).update("\0").update(credentials).digest("hex"));
}
function absent(error) {
	return error?.code === "ENOENT";
}
function parseRecord(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InvalidUploadIndexError("llm-deepseek: upload index contains a non-object record");
	const record = value;
	if (typeof record.scope !== "string" || !/^[0-9a-f]{64}$/u.test(record.scope) || typeof record.attachmentId !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record.attachmentId) || typeof record.variantId !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record.variantId) || typeof record.fileId !== "string" || record.fileId.length === 0 || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 0) throw new InvalidUploadIndexError("llm-deepseek: upload index contains an invalid record");
	return {
		scope: DeepSeekFileScope(record.scope),
		attachmentId: record.attachmentId,
		variantId: ImageVariantId(record.variantId),
		fileId: DeepSeekFileId(record.fileId),
		bytes: record.bytes,
		createdAt: record.createdAt,
		expiresAt: record.expiresAt
	};
}
function parseIndex(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new InvalidUploadIndexError("llm-deepseek: upload index is not valid JSON", { cause: error });
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InvalidUploadIndexError("llm-deepseek: upload index is not an object");
	const index = value;
	if (index.formatVersion !== 3 || !Array.isArray(index.records)) throw new InvalidUploadIndexError("llm-deepseek: unsupported upload index format");
	const records = index.records.map(parseRecord);
	const keys = /* @__PURE__ */ new Set();
	for (const record of records) {
		const key = `${record.scope}\0${record.variantId}`;
		if (keys.has(key)) throw new InvalidUploadIndexError("llm-deepseek: upload index contains duplicate mappings");
		keys.add(key);
	}
	return {
		formatVersion: 3,
		records
	};
}
function reusable(record, now, refreshMarginMs) {
	return record.expiresAt - now > refreshMarginMs;
}
/** Atomic local index shared by every DeepSeek session in this DSH home. */
var DeepSeekUploadIndex = class {
	/** Absolute owner-private JSON index path. */
	path;
	/**
	* @param path - explicit test path; omission uses `DSH_HOME/llm-deepseek/files-v3.json`.
	*/
	constructor(path = join(resolveDshHome(), "llm-deepseek", "files-v3.json")) {
		this.path = path;
	}
	async load() {
		try {
			return parseIndex(await readFile(this.path, "utf8"));
		} catch (error) {
			if (absent(error) || error instanceof InvalidUploadIndexError) return {
				formatVersion: 3,
				records: []
			};
			throw error;
		}
	}
	async save(index) {
		await writeFileAtomic(this.path, `${JSON.stringify(index, void 0, 2)}\n`, {
			mode: 384,
			dirMode: 448
		});
	}
	/**
	* Read one reusable mapping.
	* @param scope - endpoint/API-key namespace.
	* @param variantId - complete request-image transformation identity.
	* @param now - current Unix time in milliseconds.
	* @param refreshMarginMs - remaining lifetime below which a mapping is not reused.
	* @returns the mapping when it has enough lifetime remaining.
	*/
	async get(scope, variantId, now, refreshMarginMs) {
		const record = (await this.load()).records.find((candidate) => candidate.scope === scope && candidate.variantId === variantId);
		return record !== void 0 && reusable(record, now, refreshMarginMs) ? record : void 0;
	}
	/**
	* Publish a completed upload unless another process already published a reusable mapping.
	* @param candidate - completed remote upload.
	* @param now - current Unix time in milliseconds.
	* @param refreshMarginMs - minimum reusable remaining lifetime.
	* @returns the winning record and whether the candidate entered the index.
	*/
	async commit(candidate, now, refreshMarginMs) {
		await mkdir(dirname(this.path), {
			recursive: true,
			mode: 448
		});
		return withFileLock(this.path, async () => {
			const index = await this.load();
			const existing = index.records.find((record) => record.scope === candidate.scope && record.variantId === candidate.variantId && reusable(record, now, refreshMarginMs));
			if (existing !== void 0) return {
				record: existing,
				accepted: false
			};
			const records = index.records.filter((record) => reusable(record, now, refreshMarginMs) && !(record.scope === candidate.scope && record.variantId === candidate.variantId));
			records.push(candidate);
			await this.save({
				formatVersion: 3,
				records
			});
			return {
				record: candidate,
				accepted: true
			};
		});
	}
	/**
	* Remove exact mappings in one locked rewrite without deleting concurrently installed successors.
	* @param scope - endpoint/API-key namespace.
	* @param generations - exact remote generations being invalidated; pairs absent from the index are ignored.
	*/
	async remove(scope, generations) {
		const invalidated = new Set(generations.map((generation) => `${generation.variantId}\0${generation.fileId}`));
		await mkdir(dirname(this.path), {
			recursive: true,
			mode: 448
		});
		await withFileLock(this.path, async () => {
			const index = await this.load();
			const records = index.records.filter((record) => !(record.scope === scope && invalidated.has(`${record.variantId}\0${record.fileId}`)));
			if (records.length !== index.records.length) await this.save({
				formatVersion: 3,
				records
			});
		});
	}
	/**
	* Remove every local mapping for one remote namespace.
	* @param scope - endpoint/API-key namespace.
	*/
	async clear(scope) {
		await mkdir(dirname(this.path), {
			recursive: true,
			mode: 448
		});
		await withFileLock(this.path, async () => {
			const index = await this.load();
			const records = index.records.filter((record) => record.scope !== scope);
			if (records.length !== index.records.length) await this.save({
				formatVersion: 3,
				records
			});
		});
	}
};
//#endregion
//#region lib/types/file-store.js
/** DeepSeek Files API upload reuse, invalidation, and quota recovery. @module dsh-llm-deepseek/file-store */
/** Shared Files-store limit for each request image, including file-id references. */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const OWNED_FILE_PREFIX = "dsh-";
/** The Files resource's parent URL identifies the upload namespace. */
function fileScope(connection) {
	return deepSeekFileScope(messagesApiRoot(connection.baseURL), JSON.stringify(Object.entries(connection.headers).sort(([left], [right]) => left.localeCompare(right))));
}
function abortReason(signal) {
	const reason = signal.reason;
	return reason instanceof Error ? reason : new Error("DeepSeek file upload cancelled with a non-Error reason.", { cause: reason });
}
function uploadFailure(error) {
	return error instanceof Error ? error : new Error("DeepSeek file upload failed with a non-Error reason.", { cause: error });
}
function waitForUpload(operation, signal) {
	signal?.throwIfAborted();
	operation.waiters += 1;
	let released = false;
	const release = (cancelledReason) => {
		if (released) return;
		released = true;
		operation.waiters -= 1;
		if (cancelledReason !== void 0 && operation.waiters === 0 && !operation.settled) operation.controller.abort(cancelledReason);
	};
	if (signal === void 0) return operation.promise.finally(() => {
		release();
	});
	return new Promise((resolve, reject) => {
		const abort = () => {
			const reason = abortReason(signal);
			release(reason);
			reject(reason);
		};
		signal.addEventListener("abort", abort, { once: true });
		operation.promise.then((value) => {
			signal.removeEventListener("abort", abort);
			release();
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", abort);
			release();
			reject(uploadFailure(error));
		});
	});
}
function extension(mediaType) {
	switch (mediaType) {
		case "image/png": return "png";
		case "image/jpeg": return "jpeg";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
	}
}
function filename(version) {
	return `${OWNED_FILE_PREFIX}${String(version.attachment.attachmentId).slice(7, 23)}-${String(version.variantId).slice(7, 15)}.${extension(version.mediaType)}`;
}
/** User-scoped durable file-id reuse for the DeepSeek route. */
var DeepSeekFileStore = class {
	index;
	now;
	fetchImpl;
	inflight = /* @__PURE__ */ new Map();
	/**
	* @param options - testable index, clock, and transport boundaries.
	*/
	constructor(options = {}) {
		this.index = options.index ?? new DeepSeekUploadIndex();
		this.now = options.now ?? Date.now;
		this.fetchImpl = options.fetch;
	}
	client(connection) {
		return new DeepSeekFilesClient({
			baseURL: connection.baseURL,
			headers: connection.headers,
			...this.fetchImpl === void 0 ? {} : { fetch: this.fetchImpl }
		});
	}
	/**
	* Resolve or upload one deterministic request image. Concurrent calls share one upload while retaining independent waits.
	* @param version - deterministic model-request bytes and complete transformation identity.
	* @param connection - endpoint and API-key snapshot.
	* @param policy - expiry and quota-recovery policy.
	* @param signal - cancellation of this wait; shared transport stops when no waiter remains.
	* @returns a reusable file id and whether this call published a new upload.
	*/
	ensureUploaded(version, connection, policy, signal) {
		signal?.throwIfAborted();
		const key = `${fileScope(connection)}\0${version.variantId}`;
		let active = this.inflight.get(key);
		if (active?.controller.signal.aborted) {
			this.inflight.delete(key);
			active = void 0;
		}
		if (active !== void 0) return waitForUpload(active, signal);
		const controller = new AbortController();
		const shared = {
			controller,
			settled: false,
			waiters: 0,
			promise: void 0
		};
		shared.promise = this.ensureUploadedOnce(version, connection, policy, controller.signal).then((value) => {
			shared.settled = true;
			return value;
		}, (error) => {
			shared.settled = true;
			throw uploadFailure(error);
		});
		this.inflight.set(key, shared);
		shared.promise.finally(() => {
			if (this.inflight.get(key) === shared) this.inflight.delete(key);
		}).catch(() => {});
		return waitForUpload(shared, signal);
	}
	async ensureUploadedOnce(version, connection, policy, signal) {
		if (version.bytes > 33554432) throw new LlmError("DeepSeek image exceeds the 32 MiB per-image limit.", "INVALID_REQUEST");
		const scope = fileScope(connection);
		const now = this.now();
		const marginMs = policy.refreshMarginSeconds * 1e3;
		const cached = await this.index.get(scope, version.variantId, now, marginMs);
		if (cached !== void 0) return {
			record: cached,
			uploaded: false
		};
		const client = this.client(connection);
		const upload = async () => {
			const remote = await client.upload({
				data: version.data,
				mediaType: version.mediaType,
				filename: filename(version),
				expiresAfterSeconds: policy.expiresAfterSeconds,
				signal
			});
			if (remote.bytes !== version.data.byteLength) throw new LlmError("DeepSeek Files API upload response does not match the submitted image.", "INVALID_RESPONSE");
			return {
				scope,
				attachmentId: version.attachment.attachmentId,
				variantId: version.variantId,
				fileId: remote.id,
				bytes: remote.bytes,
				createdAt: remote.createdAt * 1e3,
				expiresAt: remote.expiresAt * 1e3
			};
		};
		let candidate;
		try {
			candidate = await upload();
		} catch (error) {
			if (!isFilesQuotaError(error)) throw error;
			if (await this.reclaimOldestOwned(connection, policy.quotaCleanupBatch, signal) === 0) throw error;
			candidate = await upload();
		}
		const committed = await this.index.commit(candidate, this.now(), marginMs);
		if (!committed.accepted) try {
			await client.delete(candidate.fileId, signal);
		} catch {}
		return {
			record: committed.record,
			uploaded: committed.accepted
		};
	}
	/**
	* Invalidate exact local mappings in one index update after a model request rejects their remote ids.
	* @param generations - request-image variants with the exact file id the request used for each.
	* @param connection - endpoint and API-key snapshot.
	*/
	async invalidate(generations, connection) {
		await this.index.remove(fileScope(connection), generations);
	}
	/**
	* Delete the indexed remote file for one attachment and remove its local mapping.
	* @param version - exact request-image version to release.
	* @param connection - endpoint and API-key snapshot.
	* @param policy - expiry policy used to locate a reusable mapping.
	* @param signal - request cancellation.
	* @returns whether an indexed file existed and was deleted.
	*/
	async release(version, connection, policy, signal) {
		const scope = fileScope(connection);
		const record = await this.index.get(scope, version.variantId, this.now(), policy.refreshMarginSeconds * 1e3);
		if (record === void 0) return false;
		await this.client(connection).delete(record.fileId, signal);
		await this.index.remove(scope, [{
			variantId: version.variantId,
			fileId: record.fileId
		}]);
		return true;
	}
	/**
	* Delete the oldest provider files whose names identify harness ownership.
	* @param connection - endpoint and API-key snapshot.
	* @param count - positive maximum number of files to delete.
	* @param signal - request cancellation.
	* @returns number of successfully deleted files.
	*/
	async reclaimOldestOwned(connection, count, signal) {
		const client = this.client(connection);
		let after;
		const owned = [];
		while (true) {
			const page = await client.list({
				...after === void 0 ? {} : { after },
				limit: 1e3,
				...signal === void 0 ? {} : { signal }
			});
			for (const file of page.data) {
				if (!file.filename.startsWith(OWNED_FILE_PREFIX)) continue;
				owned.push({
					id: file.id,
					createdAt: file.createdAt
				});
			}
			owned.sort((left, right) => left.createdAt - right.createdAt);
			owned.splice(count);
			if (!page.hasMore || page.lastId === void 0 || page.lastId === after) break;
			after = page.lastId;
		}
		for (const file of owned) await client.delete(file.id, signal);
		return owned.length;
	}
	/**
	* Delete every remote harness-owned file in the active API-key namespace and clear its index.
	* @param connection - endpoint and API-key snapshot.
	* @param signal - request cancellation.
	* @returns number of deleted files.
	*/
	async releaseAll(connection, signal) {
		let total = 0;
		for (;;) {
			const deleted = await this.reclaimOldestOwned(connection, 1e3, signal);
			total += deleted;
			if (deleted < 1e3) break;
		}
		await this.index.clear(fileScope(connection));
		return total;
	}
};
//#endregion
//#region lib/types/request-files.js
/** Shared Files resolution, bounded stale-id recovery, and normalized-image diagnostics. */
var __addDisposableResource$1 = function(env, value, async) {
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
var __disposeResources$1 = (function(SuppressedError) {
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
/** A file upload failure eligible for request-wide inline fallback. */
var FileResolutionFailure = class extends Error {
	constructor(cause) {
		super("DeepSeek Files API could not resolve a request image.", { cause });
		this.name = "FileResolutionFailure";
	}
};
function providerRejectedNormalizedImage(detail) {
	return /(?:unsupported|invalid|cannot read|failed to (?:decode|process)).{0,40}image/iu.test(detail) || /image.{0,40}(?:unsupported|invalid|cannot be decoded)/iu.test(detail);
}
function providerRejectedFileId(detail) {
	const file = /\bfile(?:[_ -]?(?:id|api|not[_ -]?found|deleted|expired))?/iu.test(detail);
	const missing = /(?:expired|not[_ -]?found|deleted|do(?:es)? not exist|not created under (?:this|your) account)/iu.test(detail);
	const invalidId = /(?:invalid.{0,20}file[_ -]?(?:id|api)|file[_ -]?(?:id|api).{0,20}invalid)/iu.test(detail);
	return file && (missing || invalidId);
}
function detailNamesFileId(detail, fileId) {
	let index = detail.indexOf(fileId);
	while (index >= 0) {
		const before = detail[index - 1];
		const after = detail[index + fileId.length];
		if ((before === void 0 || !/[\p{L}\p{N}_-]/u.test(before)) && (after === void 0 || !/[\p{L}\p{N}_-]/u.test(after))) return true;
		index = detail.indexOf(fileId, index + 1);
	}
	return false;
}
function staleMappings(files, detail) {
	const unique = [...new Map(files.map((file) => [`${file.version.variantId}\0${file.fileId}`, file])).values()];
	const exact = unique.filter((file) => detailNamesFileId(detail, file.fileId));
	return exact.length > 0 ? exact : unique;
}
function normalizedImageFacts(file) {
	const version = file.version;
	const name = version.attachment.name ?? version.attachment.attachmentId;
	const colour = version.hasAlpha ? "sRGBA" : "sRGB";
	return `"${name}" at message ${file.location.message}, image ${file.location.image} (${version.mediaType}, 8-bit ${colour}, ${version.width}x${version.height})`;
}
function normalizedImageDiagnostic(files, providerMessage, providerDetail) {
	const target = files.find((file) => detailNamesFileId(providerDetail, file.fileId)) ?? (files.length === 1 ? files[0] : void 0);
	if (target !== void 0) return `DeepSeek rejected normalized image ${normalizedImageFacts(target)}: ${providerMessage}. The provider rejected bytes already normalized by the harness; PNG, JPEG, WebP, and GIF remain supported input formats.`;
	return `DeepSeek rejected a normalized request image: ${providerMessage}. Candidate images: ${[...new Map(files.map((file) => [`${file.version.variantId}\0${file.location.message}\0${file.location.image}`, file])).values()].map(normalizedImageFacts).join("; ")}. The provider rejected bytes already normalized by the harness; PNG, JPEG, WebP, and GIF remain supported input formats.`;
}
/** Files state owned by one model request, including at most one stale-id retry. */
var RequestFiles = class {
	files;
	connection;
	policy;
	timeoutMs;
	signal;
	activity;
	used = [];
	retried = false;
	constructor(files, connection, policy, timeoutMs, signal, activity) {
		this.files = files;
		this.connection = connection;
		this.policy = policy;
		this.timeoutMs = timeoutMs;
		this.signal = signal;
		this.activity = activity;
	}
	/** Reset occurrence tracking before serializing the next HTTP attempt. */
	beginAttempt() {
		this.used = [];
	}
	/**
	* Resolve a retained image under its own upload deadline.
	* @param version - prepared request image.
	* @param location - occurrence used by provider-rejection diagnostics.
	* @returns the reusable provider id.
	*/
	async resolve(version, location) {
		const env_1 = {
			stack: [],
			error: void 0,
			hasError: false
		};
		try {
			const limit = __addDisposableResource$1(env_1, deadline(this.signal, this.timeoutMs, "DEEPSEEK_FILES_API_TIMEOUT"), false);
			let resolved;
			try {
				resolved = await this.files.ensureUploaded(version, this.connection, this.policy, limit.signal);
			} catch (error) {
				if (this.signal.aborted) throw error;
				throw new FileResolutionFailure(error);
			}
			this.activity();
			this.used.push({
				version,
				fileId: resolved.record.fileId,
				location
			});
			return resolved.record.fileId;
		} catch (e_1) {
			env_1.error = e_1;
			env_1.hasError = true;
		} finally {
			__disposeResources$1(env_1);
		}
	}
	/**
	* Invalidate every rejected mapping in one index update; only the first stale-id response permits another request.
	* @param detail - provider error fields used for stale-id classification.
	* @returns whether the caller should serialize and dispatch again.
	*/
	async retry(detail) {
		if (this.used.length === 0 || !providerRejectedFileId(detail)) return false;
		await this.files.invalidate(staleMappings(this.used, detail).map((file) => ({
			variantId: file.version.variantId,
			fileId: file.fileId
		})), this.connection);
		if (this.retried) return false;
		this.retried = true;
		return true;
	}
	/**
	* Attribute a normalized-image rejection to the actual uploaded image occurrences.
	* @param status - rejected request's HTTP status.
	* @param message - provider's error message.
	* @param detail - provider error classification fields.
	* @returns the image diagnostic or the original provider message.
	*/
	errorMessage(status, message, detail) {
		return status === 400 && this.used.length > 0 && providerRejectedNormalizedImage(detail) ? normalizedImageDiagnostic(this.used, message, detail) : message;
	}
};
//#endregion
//#region lib/types/request-extensions.js
/** Prepare plugin-contributed request fields and commit their delivery after HTTP acceptance. */
/**
* Merge contributions without replacing Messages fields. A rejected preparation or
* a base-field collision reports REQUEST_EXTENSION with the cause chain appended to
* the message. When the merged request fails to serialize, the payload is the
* base request alone and acceptance is a no-op, so contributors resend their
* unaccepted state on a later request. An acceptance failure is reported and
* does not fail the request.
* @param body - serialized Messages request before extension fields.
* @param options - request identity, purpose, and cancellation.
* @param prepare - contributor registry captured for this adapter.
* @param onOmitted - receives the omitted field names and the serialization failure.
* @param onUnaccepted - receives an acceptance failure after HTTP 2xx.
* @returns HTTP payload and a commit to invoke only after a successful HTTP response.
*/
async function prepareRequestExtensions(body, options, prepare, onOmitted, onUnaccepted) {
	let extensions;
	try {
		extensions = await prepare({
			body,
			...options
		});
	} catch (error) {
		throw new LlmError(`DeepSeek request extension preparation failed: ${errorChain(error)}`, "REQUEST_EXTENSION", { cause: error });
	}
	const fields = Object.keys(extensions.fields);
	for (const field of fields) if (Object.hasOwn(body, field)) throw new LlmError(`DeepSeek request extension field ${JSON.stringify(field)} collides with the base request`, "REQUEST_EXTENSION");
	let payload;
	try {
		payload = JSON.stringify({
			...body,
			...extensions.fields
		});
	} catch (error) {
		const base = JSON.stringify(body);
		onOmitted(fields, error);
		return {
			payload: base,
			accept: () => Promise.resolve()
		};
	}
	return {
		payload,
		async accept() {
			try {
				await extensions.accept();
			} catch (error) {
				onUnaccepted(error);
			}
		}
	};
}
//#endregion
//#region lib/types/images.js
/** Deterministic Messages image preparation for Files references and bounded inline fallback. */
function bounds(connection, representation) {
	return {
		representation,
		maxBytes: representation === "raw" ? connection.maxRequestFilesBytes : connection.maxInlineRequestImageBytes,
		maxImages: connection.maxImagesPerRequest,
		byteQuantum: representation === "raw" ? connection.imageOffloadByteQuantum : connection.inlineImageOffloadByteQuantum,
		countQuantum: connection.imageOffloadCountQuantum
	};
}
function* imageRefs(blocks) {
	for (const block of blocks) if (block.type === "image") yield block.attachment;
}
/** Normalize retained image references before converting Messages content.
* @param history - durable history; never mutated.
* @param connection - request-local image budgets.
* @param modelId - target model id.
* @param attachments - mounted attachment store, required only for image requests.
* @param access - current execution-world path resolver.
* @param signal - request cancellation.
* @returns projected history and prepared image bytes keyed by attachment id.
*/
async function prepareImages(history, connection, modelId, attachments, access, signal) {
	const versions = /* @__PURE__ */ new Map();
	const messages = projectOffloadedImages(history, (ref) => offloadedImageText(ref, access(ref)));
	if (!messages.some((message) => contentHasImage(message.content))) return {
		messages,
		versions
	};
	const model = connection.models.find((entry) => entry.id === modelId);
	if (model?.inputModalities?.includes("image") !== true || attachments === void 0) throw new LlmError("DeepSeek Messages image input requires a vision model and attachment service", "UNSUPPORTED_CONTENT");
	if (messages.some((message) => message.role !== "user" && message.role !== "tool" && contentHasImage(message.content))) throw new LlmError("DeepSeek Messages supports images only in user messages and tool results", "UNSUPPORTED_CONTENT");
	for (const message of messages) for (const ref of imageRefs(message.content)) if (!versions.has(ref.attachmentId)) versions.set(ref.attachmentId, await attachments.readImageRequest(ref, resolveRequestImageTarget(model, ref), signal));
	assertImagesFit(messages, versions, connection, "raw");
	return {
		messages,
		versions
	};
}
/** Require logged offload before retrying images that exceed the inline budget.
* @param messages - history already within the Files budget.
* @param versions - normalized versions prepared for retained references.
* @param connection - resolved inline bounds.
* @returns unchanged history within both byte and image-count limits.
*/
function inlineImages(messages, versions, connection) {
	assertImagesFit(messages, versions, connection, "base64");
	return messages;
}
/** Count additional oldest occurrences requiring durable offload at their exact represented bytes. */
function assertImagesFit(messages, versions, connection, representation) {
	const offloadImages = requiredImageOffload(messages, bounds(connection, representation), (block) => versions.get(block.attachment.attachmentId).bytes);
	if (offloadImages > 0) throw new LlmError(`DeepSeek Messages ${representation} request images exceed the route budget; ${offloadImages} more oldest occurrence(s) must be offloaded.`, IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages });
}
/** Resolve retained images to Files ids, recording every occurrence for failure diagnostics.
* @param messages - history within the Files byte/count budget.
* @param versions - normalized versions for every retained reference.
* @param files - request-owned Files resolution and recovery.
* @returns ids keyed by durable attachment identity.
*/
async function prepareFileIds(messages, versions, files) {
	const ids = /* @__PURE__ */ new Map();
	for (const [index, message] of messages.entries()) {
		let image = 0;
		for (const ref of imageRefs(message.content)) {
			const version = versions.get(ref.attachmentId);
			ids.set(ref.attachmentId, await files.resolve(version, {
				message: index + 1,
				image: ++image
			}));
		}
	}
	return ids;
}
//#endregion
//#region lib/types/replay.js
/** Minimal native thinking metadata; durable Harness blocks own all response text. */
/** Reject malformed JSON objects at provider and durable-data reads.
* @param value - untrusted decoded JSON.
* @param code - owning failure category.
* @returns the validated object.
*/
function object(value, code = "MALFORMED_RESPONSE") {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LlmError("DeepSeek Messages expected a JSON object", code);
	return value;
}
/** Construct response metadata without duplicating the assistant text.
* @param model - requested model identity.
* @param blocks - metadata in emitted block order.
* @returns the versioned envelope persisted by the existing assembler.
*/
function replayState(model, blocks) {
	return {
		response: {
			kind: "deepseek-messages",
			version: 1,
			model
		},
		blocks
	};
}
/** Validate native replay, discarding unusable metadata before serializing durable content.
* @param message - durable assistant content and source metadata.
* @param model - target model; cross-model signatures are not portable.
* @param onDegrade - diagnostic for unusable metadata; receives no message content or signatures.
* @returns index-aligned metadata, absent for foreign, cross-model or degraded history.
*/
function readReplay(message, model, onDegrade) {
	try {
		return validateReplay(message, model);
	} catch (error) {
		/* v8 ignore next -- the validator only throws INVALID_REPLAY_STATE; preserve future non-replay failures. */
		if (!(error instanceof LlmError) || error.code !== "INVALID_REPLAY_STATE") throw error;
		onDegrade?.(error.message);
		return;
	}
}
function validateReplay(message, model) {
	if (message.source.kind !== "model" || message.source.replayState === void 0) return void 0;
	const fail = (detail) => {
		throw new LlmError(`DeepSeek Messages replay: ${detail}`, "INVALID_REPLAY_STATE");
	};
	const envelope = object(message.source.replayState, "INVALID_REPLAY_STATE");
	const response = object(envelope.response, "INVALID_REPLAY_STATE");
	if (response.kind !== "deepseek-messages" || response.version !== 1) return fail("unsupported kind or version");
	if (response.model !== message.source.model) return fail("model does not match assistant source model");
	if (!Array.isArray(envelope.blocks) || envelope.blocks.length !== message.content.length) return fail("block count mismatch");
	const blocks = envelope.blocks.map((value, index) => {
		const block = object(value, "INVALID_REPLAY_STATE");
		if (block.type !== message.content[index]?.type || block.type !== "text" && block.type !== "reasoning" && block.type !== "tool-call") return fail("block type mismatch");
		if (block.signature !== void 0 && (block.type !== "reasoning" || typeof block.signature !== "string")) return fail("invalid signature");
		return {
			type: block.type,
			...typeof block.signature === "string" ? { signature: block.signature } : {}
		};
	});
	return response.model === model ? blocks : void 0;
}
//#endregion
//#region lib/types/serialize.js
/** Map system snapshots, tool changes, and conversation turns to Messages using the configured route capability. */
function unsupported(type) {
	throw new LlmError(`DeepSeek Messages cannot represent ${type}`, "UNSUPPORTED_CONTENT");
}
/** Historical arguments that Messages cannot represent use empty input; durable content stays unchanged. */
function toolInput(raw) {
	let value;
	try {
		value = JSON.parse(raw);
	} catch (_invalidToolHistoryJson) {
		return {};
	}
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function assistant(message, model, onReplayDegrade) {
	const replay = readReplay(message, model, onReplayDegrade);
	return message.content.flatMap((block, index) => {
		switch (block.type) {
			case "text": return block.text.length === 0 ? [] : {
				type: "text",
				text: block.text
			};
			case "reasoning": return {
				type: "thinking",
				thinking: block.text,
				...replay?.[index]?.signature === void 0 ? {} : { signature: replay[index].signature }
			};
			case "tool-call": return {
				type: "tool_use",
				id: block.id,
				name: block.name,
				input: toolInput(block.arguments)
			};
			default: return unsupported(`assistant content ${block.type}`);
		}
	});
}
/** Serialize one complete request using already prepared image bytes.
* User and tool-result content omits reasoning and tool-call blocks.
* Empty assistant text blocks and empty user/assistant messages are skipped;
* empty tool results retain their call ids.
* Developer messages, already projected for this route by `LlmRuntime`, become
* system-role updates after the preceding user turn, with tool changes as
* `tool_addition` and `tool_removal` references to the declared tool.
* @param options - provider-neutral request.
* @param connection - validated defaults and thinking policy.
* @param history - image-projected history with complete system snapshots; durable messages remain unchanged.
* @param images - request versions for retained images.
* @param access - execution-world paths for image descriptions.
* @param onReplayDegrade - diagnostic for discarded native replay metadata.
* @param fileIds - resolved Files references; omission selects inline image bytes.
* @returns the Messages API JSON body.
*/
function serialize(options, connection, history, images, access, onReplayDegrade, fileIds) {
	const model = connection.models.find((entry) => entry.id === options.model);
	const inHistory = model?.systemPromptUpdate === "in-history";
	const input = (blocks) => blocks.flatMap((block) => {
		if (block.type === "text") return block.text ? [{
			type: "text",
			text: block.text
		}] : [];
		if (block.type === "reasoning" || block.type === "tool-call") return [];
		if (block.type !== "image") return unsupported(`user/tool-result content ${block.type}`);
		const version = images.get(block.attachment.attachmentId);
		if (version === void 0) throw new LlmError("DeepSeek Messages request image is missing", "INVALID_REQUEST");
		const fileId = fileIds?.get(block.attachment.attachmentId);
		if (fileIds !== void 0 && fileId === void 0) throw new LlmError("DeepSeek Messages request file id is missing", "INVALID_REQUEST");
		return [{
			type: "text",
			text: requestImageHandleText(block.attachment, version, access(block.attachment))
		}, fileId === void 0 ? {
			type: "image",
			source: {
				type: "base64",
				media_type: version.mediaType,
				data: Buffer.from(version.data).toString("base64")
			}
		} : {
			type: "image",
			source: {
				type: "file",
				file_id: fileId
			}
		}];
	});
	const messages = [];
	let historySystem;
	const systemUpdates = [];
	const flushSystemUpdates = () => {
		if (systemUpdates.length === 0) return;
		if (messages.at(-1)?.role !== "user") return unsupported("system update without a preceding user or tool-result turn");
		messages.push(...systemUpdates.splice(0));
	};
	for (const message of history) {
		if (message.role === "developer") {
			const content = message.content.flatMap((block) => {
				switch (block.type) {
					case "text": return block.text.length === 0 ? [] : [{
						type: "text",
						text: block.text
					}];
					case "tool-addition": return [{
						type: "tool_addition",
						tool: {
							type: "tool_reference",
							name: block.toolName
						}
					}];
					case "tool-removal": return [{
						type: "tool_removal",
						tool: {
							type: "tool_reference",
							name: block.toolName
						}
					}];
					default: return unsupported(`developer content ${block.type}`);
				}
			});
			if (content.length > 0) systemUpdates.push({
				role: "system",
				content
			});
			continue;
		}
		if (message.content.some((block) => block.type === "tool-addition" || block.type === "tool-removal")) return unsupported("tool-change blocks outside developer messages");
		if (message.role === "system") {
			const texts = message.content.filter((block) => block.type === "text");
			if (texts.length !== message.content.length) return unsupported("non-text system message");
			const text = texts.map((block) => block.text).join("");
			if (inHistory && messages.length > 0) {
				if (text.length === 0) return unsupported("empty in-history system update");
				systemUpdates.push({
					role: "system",
					content: [{
						type: "text",
						text
					}]
				});
			} else historySystem = text;
			continue;
		}
		const content = message.role === "assistant" ? assistant(message, options.model, onReplayDegrade) : message.role === "tool" ? [{
			type: "tool_result",
			tool_use_id: message.toolCallId,
			content: input(message.content),
			...message.isError === void 0 ? {} : { is_error: message.isError }
		}] : message.content.flatMap((block) => input([block]));
		if ((message.role === "user" || message.role === "assistant") && content.length === 0) continue;
		if (message.role === "assistant") flushSystemUpdates();
		const wireRole = message.role === "tool" ? "user" : message.role;
		const previous = messages.at(-1);
		if (previous?.role === wireRole) previous.content.push(...content);
		else messages.push({
			role: wireRole,
			content
		});
	}
	flushSystemUpdates();
	let pending = /* @__PURE__ */ new Set();
	for (const message of messages) if (message.role === "assistant") {
		const calls = message.content.filter((block) => block.type === "tool_use");
		pending = new Set(calls.map((block) => block.id));
		if (pending.size !== calls.length) throw new LlmError("DeepSeek Messages duplicate tool call id", "INVALID_REQUEST");
	} else if (message.role === "user") {
		const results = message.content.filter((block) => block.type === "tool_result");
		for (const result of results) if (!pending.delete(result.tool_use_id)) throw new LlmError("DeepSeek Messages tool result has no matching call", "INVALID_REQUEST");
		if (pending.size > 0) throw new LlmError("DeepSeek Messages tool calls need immediate results", "INVALID_REQUEST");
		message.content = [...results, ...message.content.filter((block) => block.type !== "tool_result")];
	}
	if (pending.size > 0) throw new LlmError("DeepSeek Messages history ends with unresolved tools", "INVALID_REQUEST");
	const effort = options.reasoningEffort ?? connection.defaults.reasoningEffort ?? (connection.defaults.thinking === "disabled" ? "off" : "high");
	if (![
		"off",
		"low",
		"high",
		"max"
	].includes(effort) || connection.defaults.thinking === "disabled" && effort !== "off") throw new LlmError(`DeepSeek Messages does not support reasoning effort ${effort}`, "UNSUPPORTED_REASONING_EFFORT");
	const system = [options.system, historySystem].filter(Boolean).join("\n\n");
	return {
		model: options.model,
		stream: true,
		messages,
		max_tokens: options.maxTokens ?? model?.maxTokens ?? connection.maxTokens,
		thinking: { type: effort === "off" ? "disabled" : "enabled" },
		...effort === "off" ? {} : { output_config: { effort } },
		...system.length === 0 ? {} : { system },
		...options.temperature === void 0 ? {} : { temperature: options.temperature },
		...options.stop === void 0 ? {} : { stop_sequences: options.stop },
		...options.tools === void 0 ? {} : { tools: options.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters,
			...tool.deferLoading === true ? { defer_loading: true } : {}
		})) }
	};
}
//#endregion
//#region lib/types/transport.js
/** Normalize HTTP and in-band Messages errors into provider-neutral failures. */
/** Read only provider error fields used by bounded Files recovery.
* @param raw - decoded HTTP error response.
* @returns code, type, and message text, without unrelated response fields.
*/
function providerErrorDetail(raw) {
	const error = typeof raw === "object" && raw !== null && "error" in raw ? raw.error : void 0;
	if (typeof error !== "object" || error === null) return "";
	const fields = error;
	return [
		fields.code,
		fields.type,
		fields.message
	].filter((value) => typeof value === "string").join(" ");
}
/** Classify a provider error without trusting arbitrary response fields.
* @param raw - decoded response or in-band error event.
* @param status - HTTP status when the error preceded streaming.
* @param headers - response headers for retry delay and request identity.
* @returns a stable error consumed by LlmRuntime and llm-retry.
*/
function providerError(raw, status, headers) {
	const envelope = typeof raw === "object" && raw !== null ? raw : {};
	const error = typeof envelope.error === "object" && envelope.error !== null ? envelope.error : {};
	const message = typeof error.message === "string" ? error.message : `DeepSeek Messages request failed (${status ?? "stream error"})`;
	const type = typeof error.type === "string" ? error.type : "";
	const detail = `${type} ${typeof error.code === "string" ? error.code : ""} ${message}`;
	let code;
	if (status === 401 || status === 403 || ["authentication_error", "permission_error"].includes(type)) code = "AUTH";
	else if (isQuotaExceededError(detail) || status === 402) code = "QUOTA";
	else if (status === 429 || type === "rate_limit_error") code = "RATE_LIMIT";
	else if (isContextWindowExceededError(detail)) code = "CONTEXT_WINDOW_EXCEEDED";
	else if (status === 400 || status === 413 || type === "invalid_request_error") code = "INVALID_REQUEST";
	else if (status !== void 0 && status >= 500 || ["api_error", "overloaded_error"].includes(type)) code = "SERVER";
	else code = status === void 0 ? "SERVER" : `HTTP_${status}`;
	const retry = headers?.get("retry-after");
	const delay = retry == null ? NaN : /^\d+(?:\.\d+)?$/u.test(retry) ? Number(retry) * 1e3 : Date.parse(retry) - Date.now();
	const id = headers?.get("request-id") ?? headers?.get("x-request-id") ?? headers?.get("x-deepseek-request-id");
	return new LlmError(message, code, {
		...status === void 0 ? {} : { status },
		...id ? { requestId: ProviderRequestId(id) } : {},
		...Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {}
	});
}
//#endregion
//#region lib/types/sse.js
/** SSE framing delegated to eventsource-parser; JSON errors remain provider failures. */
/** Decode complete SSE frames without treating an unterminated tail as an event.
* @param body - provider response bytes.
* @param activity - pulse the idle watchdog for events and heartbeat comments.
* @returns JSON events, including message_stop; the translator owns completion.
*/
async function* parseSse(body, activity) {
	const events = body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment: activity }));
	for await (const frame of events) {
		activity();
		let raw;
		try {
			raw = JSON.parse(frame.data);
		} catch (_invalidSseJson) {
			throw new LlmError("DeepSeek Messages SSE contains invalid JSON", "MALFORMED_RESPONSE");
		}
		const event = object(raw);
		if (typeof event.type !== "string" || frame.event !== void 0 && frame.event !== event.type) throw new LlmError("DeepSeek Messages SSE event type mismatch", "MALFORMED_RESPONSE");
		if (event.type === "error") throw providerError(event, void 0);
		yield event;
	}
}
//#endregion
//#region lib/types/translate.js
/** Translate Messages events while preserving block order and cumulative usage. */
/** Decode a required string from provider JSON.
* @param value - provider field.
* @returns the validated string.
*/
function string(value) {
	if (typeof value !== "string") throw new LlmError("DeepSeek Messages expected a string field", "MALFORMED_RESPONSE");
	return value;
}
function malformed(detail) {
	throw new LlmError(`DeepSeek Messages stream: ${detail}`, "MALFORMED_RESPONSE");
}
function indexOf(event) {
	if (!Number.isSafeInteger(event.index) || event.index < 0) return malformed("invalid block index");
	return event.index;
}
function updateUsage(usage, raw) {
	const fields = object(raw);
	for (const [wire, local] of Object.entries({
		input_tokens: "inputTokens",
		output_tokens: "outputTokens",
		cache_read_input_tokens: "cacheReadTokens",
		cache_creation_input_tokens: "cacheWriteTokens"
	})) {
		const value = fields[wire];
		if (value === void 0) continue;
		if (!Number.isSafeInteger(value) || value < 0) return malformed(`invalid ${wire}`);
		usage[local] = value;
	}
}
function startBlock(event, index) {
	const native = object(event.content_block);
	let content;
	let replay;
	switch (native.type) {
		case "text":
			content = {
				type: "text",
				text: string(native.text)
			};
			replay = { type: "text" };
			break;
		case "thinking":
			content = {
				type: "reasoning",
				text: string(native.thinking)
			};
			replay = {
				type: "reasoning",
				...native.signature === void 0 ? {} : { signature: string(native.signature) }
			};
			break;
		case "tool_use":
			content = {
				type: "tool-call",
				id: ToolCallId(string(native.id)),
				name: string(native.name),
				arguments: JSON.stringify(object(native.input))
			};
			if (!content.id || !content.name) return malformed("empty tool identity");
			replay = { type: "tool-call" };
			break;
		default: throw new LlmError(`DeepSeek Messages does not support response block ${String(native.type)}`, "UNSUPPORTED_CONTENT");
	}
	return {
		index,
		content,
		replay,
		closed: false,
		json: ""
	};
}
function deltaChunk(block, raw) {
	const delta = object(raw);
	const content = block.content;
	if (delta.type === "text_delta" && content.type === "text") {
		const text = string(delta.text);
		content.text += text;
		return {
			type: "text-delta",
			index: block.index,
			text
		};
	}
	if (delta.type === "thinking_delta" && content.type === "reasoning") {
		const text = string(delta.thinking);
		content.text += text;
		return {
			type: "reasoning-delta",
			index: block.index,
			text
		};
	}
	if (delta.type === "signature_delta" && content.type === "reasoning") {
		block.replay.signature = (block.replay.signature ?? "") + string(delta.signature);
		return;
	}
	if (delta.type === "input_json_delta" && content.type === "tool-call") {
		const argumentsDelta = string(delta.partial_json);
		block.json += argumentsDelta;
		return {
			type: "tool-call-delta",
			index: block.index,
			id: content.id,
			argumentsDelta
		};
	}
	return malformed(`unsupported delta ${String(delta.type)} for ${content.type}`);
}
function stopReason(raw) {
	switch (raw) {
		case "end_turn":
		case "stop_sequence": return { kind: "stop" };
		case "tool_use": return { kind: "tool-calls" };
		case "max_tokens": return { kind: "max-tokens" };
		default: return malformed(`unsupported stop reason ${String(raw)}`);
	}
}
/** Translate decoded SSE data into the Harness stream protocol.
* @param events - framed, decoded provider events in arrival order.
* @param model - requested model id stored in durable replay state.
* @returns blocks, one final usage value, and exactly one terminal finish.
*/
async function* translate(events, model) {
	const blocks = /* @__PURE__ */ new Map();
	const usage = {
		inputTokens: 0,
		outputTokens: 0
	};
	let started = false;
	let reason;
	for await (const event of events) {
		if (event.type === "message_start") {
			if (started) return malformed("duplicate message_start");
			updateUsage(usage, object(event.message).usage);
			started = true;
			continue;
		}
		if (![
			"content_block_start",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop"
		].includes(String(event.type))) continue;
		if (!started) return malformed("event precedes message_start");
		if (event.type === "content_block_start") {
			const wireIndex = indexOf(event);
			if (blocks.has(wireIndex) || reason !== void 0) return malformed("block starts after settlement or repeats an index");
			const block = startBlock(event, blocks.size);
			blocks.set(wireIndex, block);
			yield {
				type: "block-start",
				index: block.index,
				blockType: block.content.type
			};
			if (block.content.type === "text" || block.content.type === "reasoning") {
				if (block.content.text) yield {
					type: block.content.type === "text" ? "text-delta" : "reasoning-delta",
					index: block.index,
					text: block.content.text
				};
			} else yield {
				type: "tool-call-delta",
				index: block.index,
				id: block.content.id,
				name: block.content.name,
				argumentsDelta: ""
			};
		} else if (event.type === "content_block_delta" || event.type === "content_block_stop") {
			const block = blocks.get(indexOf(event));
			if (block === void 0 || block.closed) return malformed("delta/stop without an open block");
			if (event.type === "content_block_delta") {
				const chunk = deltaChunk(block, event.delta);
				if (chunk !== void 0) yield chunk;
			} else {
				block.closed = true;
				if (block.content.type === "tool-call" && block.json.length > 0) block.content.arguments = block.json;
				yield {
					type: "block-end",
					index: block.index,
					block: { ...block.content }
				};
			}
		} else if (event.type === "message_delta") {
			const delta = object(event.delta);
			if (delta.stop_reason != null) reason = stopReason(delta.stop_reason);
			if (event.usage !== void 0) updateUsage(usage, event.usage);
		} else {
			if (reason === void 0 || [...blocks.values()].some((block) => !block.closed)) return malformed("message_stop without settled blocks and stop reason");
			if (blocks.size === 0 && reason.kind === "stop") throw new LlmError("DeepSeek Messages returned no content", "EMPTY_RESPONSE");
			if (reason.kind !== "max-tokens") for (const { content } of blocks.values()) {
				if (content.type !== "tool-call") continue;
				let parsed;
				try {
					parsed = JSON.parse(content.arguments);
				} catch (_invalidProviderToolJson) {
					return malformed("tool input is invalid JSON");
				}
				object(parsed);
			}
			usage.totalTokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
			yield {
				type: "usage",
				usage
			};
			yield {
				type: "finish",
				reason,
				replayState: replayState(model, [...blocks.values()].map((block) => block.replay))
			};
			return;
		}
	}
	throw new LlmError("DeepSeek Messages stream ended before message_stop", "STREAM_CLOSED");
}
//#endregion
//#region lib/types/adapter.js
/** Direct Messages transport with one cancellable lifecycle per model request. */
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
/** DeepSeek provider using Messages content and native thinking replay. */
var DeepSeekAdapter = class extends LlmAdapter {
	dependencies;
	files;
	imageAccess = (ref) => {
		const attachments = this.dependencies.resolveAttachments?.();
		return attachments === void 0 ? void 0 : this.dependencies.resolveImageAccess?.(attachments, ref);
	};
	constructor(dependencies) {
		super();
		this.dependencies = dependencies;
		this.files = dependencies.resolveFiles?.() ?? new DeepSeekFileStore();
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.dependencies.providerName ?? "DeepSeek"
		};
	}
	providerRetryPolicy(_provider) {
		return this.dependencies.options().retryPolicy;
	}
	async listModels(provider) {
		return this.dependencies.discoverModels?.(provider) ?? [];
	}
	async resolveModel(provider, model, signal) {
		return modelInfo(await this.connection(signal), provider, model);
	}
	imageRequestPricing(_provider, model) {
		return deepSeekImageRequestPricing(this.dependencies.options(), model, this.imageAccess);
	}
	imageRequestTarget(_provider, model, image) {
		const entry = this.dependencies.options().models.find((entry) => entry.id === model);
		if (entry === void 0) throw new LlmError(`DeepSeek model "${model}" has no declared image projection`, "UNKNOWN_MODEL");
		return resolveRequestImageTarget(entry, image);
	}
	async prepareCall(provider, model, signal) {
		const connection = await this.connection(signal);
		this.dependencies.admit?.(connection, model);
		return {
			model: modelInfo(connection, provider, model),
			stream: (options) => this.generate(options, connection)
		};
	}
	stream(options) {
		const connection = this.dependencies.options();
		this.dependencies.admit?.(connection, options.model);
		return this.generate(options, connection);
	}
	connection(signal) {
		return this.dependencies.connect?.(signal) ?? Promise.resolve(this.dependencies.options());
	}
	async *generate(options, connection) {
		const env_1 = {
			stack: [],
			error: void 0,
			hasError: false
		};
		try {
			const consumer = new AbortController();
			const watchdog = __addDisposableResource(env_1, idleWatchdog(options.signal === void 0 ? consumer.signal : AbortSignal.any([consumer.signal, options.signal]), connection.streamIdleTimeoutMs, "MESSAGES_IDLE"), false);
			const iterator = this.request(options, connection, watchdog.signal, () => {
				watchdog.pulse();
			});
			try {
				while (true) {
					const next = await watchdog.next(iterator);
					if (next.done) return;
					yield next.value;
				}
			} catch (error) {
				if (timeoutOf(watchdog.signal, "MESSAGES_IDLE") !== void 0) throw new LlmError("DeepSeek Messages stream idle timeout", "TIMEOUT", { cause: error });
				if (options.signal?.aborted) throw new LlmError("DeepSeek Messages request aborted", "ABORTED", { cause: error });
				if (error instanceof LlmError) throw error;
				throw new LlmError("DeepSeek Messages transport failed", "TRANSPORT", { cause: error });
			} finally {
				consumer.abort();
				/* v8 ignore next -- the detached drain only rejects while unwinding an abandoned request. */
				iterator.return(void 0).catch(() => {});
			}
		} catch (e_1) {
			env_1.error = e_1;
			env_1.hasError = true;
		} finally {
			__disposeResources(env_1);
		}
	}
	async *request(options, connection, signal, activity) {
		signal.throwIfAborted();
		const { messages, versions } = await prepareImages(options.messages, connection, options.model, this.dependencies.resolveAttachments?.(), this.imageAccess, signal);
		const auth = await this.dependencies.resolveAuth(connection);
		try {
			const files = new RequestFiles(this.files, {
				baseURL: connection.baseURL,
				headers: auth.headers
			}, connection.filePolicy, connection.filesApiTimeoutMs, signal, activity);
			let inline = false;
			while (true) {
				signal.throwIfAborted();
				files.beginAttempt();
				let fileIds;
				if (!inline) try {
					fileIds = await prepareFileIds(messages, versions, files);
				} catch (error) {
					if (!(error instanceof FileResolutionFailure)) throw error;
					inline = true;
					continue;
				}
				const body = serialize(options, connection, inline ? inlineImages(messages, versions, connection) : messages, versions, this.imageAccess, (reason) => {
					this.dependencies.onReplayDegrade?.({
						provider: options.provider,
						model: options.model,
						reason
					});
				}, fileIds);
				const extensions = await prepareRequestExtensions(body, {
					signal,
					...options.sessionId === void 0 ? {} : { sessionId: String(options.sessionId) },
					...options.purpose === void 0 ? {} : { purpose: options.purpose }
				}, this.dependencies.prepareExtensions, (fields, error) => {
					this.dependencies.onExtensionsOmitted?.({
						provider: options.provider,
						model: options.model,
						fields,
						error
					});
				}, (error) => {
					this.dependencies.onExtensionsUnaccepted?.({
						provider: options.provider,
						model: options.model,
						error
					});
				});
				signal.throwIfAborted();
				const betas = [...fileIds !== void 0 && fileIds.size > 0 ? [MESSAGES_FILES_BETA] : [], ...body.messages.some((message) => message.content.some((block) => block.type === "tool_addition" || block.type === "tool_removal")) ? [MESSAGES_TOOL_CHANGES_BETA] : []];
				const response = await fetch(`${messagesApiRoot(connection.baseURL)}/messages`, {
					method: "POST",
					signal,
					body: extensions.payload,
					redirect: "error",
					headers: {
						...attributionHeaders(),
						"content-type": "application/json",
						"accept": "text/event-stream",
						...auth.headers,
						"anthropic-version": "2023-06-01",
						...betas.length === 0 ? {} : { "anthropic-beta": betas.join(",") },
						"x-deepseek-harness-user-id": this.dependencies.resolveUserId(),
						...options.sessionId === void 0 ? {} : { "x-deepseek-harness-session-id": String(options.sessionId) },
						...options.purpose === "compaction" ? { "x-deepseek-harness-compact": "1" } : {}
					}
				});
				if (!response.ok) {
					const text = await response.text();
					let raw;
					try {
						raw = JSON.parse(text);
					} catch (_nonJsonGatewayError) {}
					const detail = providerErrorDetail(raw);
					if (await files.retry(detail)) continue;
					const failure = providerError(raw, response.status, response.headers);
					throw new LlmError(files.errorMessage(response.status, failure.message, detail), failure.code, {
						...failure.failure,
						cause: new Error(text)
					});
				}
				await extensions.accept();
				if (response.body === null) throw new LlmError("DeepSeek Messages returned no response body", "EMPTY_RESPONSE");
				yield* translate(parseSse(response.body, activity), options.model);
				return;
			}
		} catch (error) {
			if (auth.onRequestError !== void 0) {
				let mapped;
				try {
					mapped = await auth.onRequestError(error);
				} catch (_credentialUpdateFailed) {
					throw error;
				}
				throw mapped;
			}
			throw error;
		}
	}
};
//#endregion
//#region lib/types/host.js
/**
* Register one provider with request-local transport services and live retry policy.
* @param ctx - provider plugin lifetime with the LLM registry injected.
* @param provider - exact route owned by this plugin.
* @param dependencies - provider-owned discovery, credential, and configuration callbacks.
*/
function registerDeepSeekProvider(ctx, provider, dependencies) {
	ctx.inject(["settings"], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
	});
	let userId;
	const degradedReplays = /* @__PURE__ */ new Set();
	const omittedRoutes = /* @__PURE__ */ new Set();
	const unacceptedRoutes = /* @__PURE__ */ new Set();
	const adapter = new DeepSeekAdapter({
		...dependencies,
		resolveUserId: () => userId ??= getOrCreateAnonymousUserId(),
		onReplayDegrade: ({ provider, model, reason }) => {
			const key = `${provider}/${model}\u0000${reason}`;
			if (degradedReplays.has(key)) return;
			degradedReplays.add(key);
			ctx.logger.warn(`llm-deepseek: unusable Messages replay state on assistant history for route "${provider}/${model}"; sending provider-neutral content (${reason})`);
		},
		onExtensionsOmitted: ({ provider, model, fields, error }) => {
			const route = `${provider}/${model}`;
			if (omittedRoutes.has(route)) return;
			omittedRoutes.add(route);
			ctx.logger.warn(`llm-deepseek: sending route "${route}" without request extension fields ${fields.join(", ")} because they failed to serialize: %o`, error);
		},
		onExtensionsUnaccepted: ({ provider, model, error }) => {
			const route = `${provider}/${model}`;
			if (unacceptedRoutes.has(route)) return;
			unacceptedRoutes.add(route);
			ctx.logger.warn(`llm-deepseek: route "${route}" request extension acceptance failed; contributors resend on a later request: %o`, error);
		},
		resolveAttachments: () => ctx.get("attachments"),
		resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath), ref),
		prepareExtensions: (request) => ctx.get("deepseekLlmApiExtensions")?.prepare(request) ?? Promise.resolve({
			fields: {},
			accept: () => Promise.resolve()
		})
	});
	const registration = ctx.llm.registerAdapter([provider], adapter);
	let registeredPolicy = dependencies.options().retryPolicy;
	ctx.on("loader/volatile-update", () => {
		let policy;
		try {
			policy = dependencies.options().retryPolicy;
		} catch (error) {
			ctx.logger.warn(error);
			return;
		}
		if (deepEqualJson(policy, registeredPolicy)) return;
		registration.replace([provider]);
		registeredPolicy = policy;
	});
}
//#endregion
//#region lib/types/listing.js
/** DeepSeek `GET /models` listing: one authenticated request and per-entry decoding. */
const LISTED_MODALITIES = ["text", "image"];
/** Code of a listing deadline's timeout reason; {@link requestModelListing} reports it as `TIMEOUT`. */
const LISTING_TIMEOUT = "MODEL_LISTING_TIMEOUT";
/**
* The listing endpoint of a Messages root.
* @param baseURL - Messages `baseURL`.
* @returns `/models` at the origin of `baseURL`, the only origin that receives the route's credential.
*/
function modelListingURL(baseURL) {
	return new URL("/models", new URL(baseURL).origin).href;
}
function fieldsOf(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
/** Listed modalities this build sends, in listing order without repeats; `undefined` when the value is not an array. */
function knownModalities(value) {
	if (!Array.isArray(value)) return void 0;
	const listed = value;
	return LISTED_MODALITIES.filter((modality) => listed.includes(modality)).toSorted((left, right) => listed.indexOf(left) - listed.indexOf(right));
}
/** A declared capacity: `undefined` when absent, `false` when not a positive safe integer. */
function capacity(value) {
	if (value === void 0) return void 0;
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : false;
}
function requirementOf(entry) {
	if (entry.client_requirements === void 0) return { kind: "none" };
	const requirements = fieldsOf(entry.client_requirements);
	if (requirements === void 0) return { kind: "invalid" };
	const declared = requirements[APP_IDENTITY.product];
	if (declared === void 0) return { kind: "none" };
	const own = fieldsOf(declared);
	if (own === void 0) return { kind: "invalid" };
	if (own.min_version === void 0) return { kind: "none" };
	return typeof own.min_version === "string" && own.min_version.length > 0 ? {
		kind: "min-version",
		version: own.min_version
	} : { kind: "invalid" };
}
function capabilitiesOf(entry) {
	const messages = fieldsOf(fieldsOf(entry.api_capabilities)?.anthropic_messages);
	if (messages === void 0) return {
		usable: false,
		reason: "declares no api_capabilities.anthropic_messages"
	};
	if ((entry.output_modalities === void 0 ? ["text"] : knownModalities(entry.output_modalities))?.includes("text") !== true) return {
		usable: false,
		reason: "declares no text output"
	};
	const inputs = entry.input_modalities === void 0 ? ["text"] : knownModalities(entry.input_modalities);
	if (inputs === void 0 || inputs.length === 0) return {
		usable: false,
		reason: "declares no input modality DeepSeek Harness supports"
	};
	const contextWindow = capacity(entry.context_window);
	const maxOutputTokens = capacity(entry.max_output_tokens);
	if (contextWindow === false || maxOutputTokens === false) return {
		usable: false,
		reason: "declares an invalid context_window or max_output_tokens"
	};
	const promptUpdate = messages.system_prompt_update ?? void 0;
	const toolUpdate = messages.tool_update ?? void 0;
	return {
		usable: true,
		facts: {
			inputModalities: inputs,
			...contextWindow === void 0 ? {} : { contextWindow },
			...maxOutputTokens === void 0 ? {} : { maxOutputTokens },
			...promptUpdate === void 0 ? {} : { systemPromptUpdate: promptUpdate === "in-history" ? "in-history" : "leading-only" },
			...toolUpdate === void 0 ? {} : { toolUpdate: toolUpdate === "in-history" || toolUpdate === "addition-only" ? toolUpdate : "leading-only" }
		}
	};
}
/**
* Decode one `/models` body entry by entry.
* @param body - parsed JSON response.
* @returns the entries with a usable id, in listing order.
* @throws LlmError `INVALID_RESPONSE` when the body has no `data` array or no usable entry.
*/
function parseModelListing(body) {
	const data = fieldsOf(body)?.data;
	if (!Array.isArray(data)) throw new LlmError("DeepSeek model listing has no \"data\" array", "INVALID_RESPONSE");
	const rows = data;
	const entries = [];
	const seen = /* @__PURE__ */ new Set();
	for (const row of rows) {
		const entry = fieldsOf(row);
		const id = entry?.id;
		if (entry === void 0 || typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
		seen.add(id);
		entries.push({
			id,
			...typeof entry.name === "string" && entry.name.length > 0 ? { name: entry.name } : {},
			requirement: requirementOf(entry),
			capabilities: capabilitiesOf(entry)
		});
	}
	if (entries.length === 0) throw new LlmError("DeepSeek model listing contains no model entry", "INVALID_RESPONSE");
	return {
		entries,
		skipped: rows.length - entries.length
	};
}
/**
* Request and decode one model listing. Redirects fail, so credentials stay on the requested origin.
* @param url - listing endpoint.
* @param headers - authentication headers for this endpoint.
* @param signal - cancellation and deadline of the whole exchange.
* @returns the decoded listing.
* @throws LlmError `TIMEOUT` when a {@link LISTING_TIMEOUT} deadline elapses before a complete body, `ABORTED` for
*   another abort, `TRANSPORT` for a network failure, `HTTP_<status>` for a non-2xx answer,
*   and `INVALID_RESPONSE` for a body that is not a JSON listing.
*/
async function requestModelListing(url, headers, signal) {
	let response;
	let text;
	try {
		response = await fetch(url, {
			method: "GET",
			redirect: "error",
			signal,
			headers: {
				...attributionHeaders(),
				accept: "application/json",
				...headers
			}
		});
		text = await response.text();
	} catch (error) {
		const expired = timeoutOf(signal, LISTING_TIMEOUT);
		if (expired !== void 0) throw new LlmError(`DeepSeek model listing request to ${url} timed out after ${expired.timeoutMs} ms`, "TIMEOUT", { cause: error });
		throw signal.aborted ? new LlmError(`DeepSeek model listing request to ${url} was aborted`, "ABORTED", { cause: error }) : new LlmError(`could not reach ${url}`, "TRANSPORT", { cause: error });
	}
	if (!response.ok) throw new LlmError(`${url} answered HTTP ${response.status}`, `HTTP_${response.status}`, { status: response.status });
	let body;
	try {
		body = JSON.parse(text);
	} catch (error) {
		throw new LlmError(`${url} did not answer with JSON`, "INVALID_RESPONSE", { cause: error });
	}
	return parseModelListing(body);
}
//#endregion
//#region lib/types/listing-config.js
/** Default deadline of one model-listing request and of a first-use wait. */
const DEFAULT_MODELS_TIMEOUT_MS = 5e3;
/** Default listing age after which the next access refreshes it in the background. */
const DEFAULT_MODELS_MAX_AGE_MS = 6e5;
/** Schemas of the {@link ModelListingConfig} fields. */
const modelListingConfigFields = {
	modelsTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_MODELS_TIMEOUT_MS).volatile(),
	modelsMaxAgeMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MODELS_MAX_AGE_MS).volatile()
};
/**
* Validate listing timing. Settings updates can reach it without schema validation, so every bound is judged here.
* @param options - plain listing options; absent values take the defaults.
* @param owner - plugin name that prefixes each failure message.
* @returns the validated timing.
* @throws Error when a value is outside its schema bounds.
*/
function resolveListingTiming(options, owner) {
	const { modelsTimeoutMs = DEFAULT_MODELS_TIMEOUT_MS, modelsMaxAgeMs = DEFAULT_MODELS_MAX_AGE_MS } = options;
	if (!Number.isFinite(modelsTimeoutMs) || modelsTimeoutMs <= 0 || modelsTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`${owner}: modelsTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	if (!Number.isSafeInteger(modelsMaxAgeMs) || modelsMaxAgeMs < 0) throw new Error(`${owner}: modelsMaxAgeMs must be a non-negative safe integer`);
	return {
		timeoutMs: modelsTimeoutMs,
		maxAgeMs: modelsMaxAgeMs
	};
}
//#endregion
//#region lib/types/listing-cache.js
/** Credential-scoped `/models` cache with single-flight loads, background refresh, and last-known-good retention. */
/** Wait for `task` unless `signal` aborts first; the task keeps running. */
async function abandonable(task, signal) {
	if (signal === void 0) return task;
	const abandoned = Promise.withResolvers();
	const abandon = () => {
		abandoned.reject(signal.reason);
	};
	signal.addEventListener("abort", abandon, { once: true });
	try {
		await Promise.race([task, abandoned.promise]);
	} finally {
		signal.removeEventListener("abort", abandon);
	}
}
/** One route's listing cache; each endpoint and credential pair has its own scope. */
var ModelListingCache = class {
	dependencies;
	scope;
	listing;
	/** Settle time of the latest load in this scope; `undefined` before the first one settles. */
	settledAt;
	inflight;
	request;
	generation = 0;
	failing = false;
	closed = false;
	/** @param dependencies - credential, transport, clock, and diagnostic callbacks. */
	constructor(dependencies) {
		this.dependencies = dependencies;
	}
	/**
	* The last published view, without I/O.
	* @returns the credential state and listing of the current scope.
	*/
	current() {
		return {
			authenticated: this.scope !== void 0,
			listing: this.listing
		};
	}
	/**
	* Resolve the view for the current credential. The first access of a scope
	* waits for its load, which the request deadline bounds; later accesses
	* return at once and refresh a stale listing in the background.
	* @param settings - endpoint and timing of the caller's configuration generation.
	* @param signal - abandons this wait only; the shared load continues.
	* @returns the view after any first load of the scope settles.
	*/
	async view(settings, signal) {
		const credential = await this.dependencies.credential(settings.url);
		signal?.throwIfAborted();
		if (this.closed) return this.current();
		const scope = credential === void 0 ? void 0 : `${settings.url}\n${createHash("sha256").update(credential).digest("hex")}`;
		if (scope !== this.scope) this.rescope(scope);
		if (credential !== void 0) {
			if (this.settledAt === void 0) await abandonable(this.start(settings, credential), signal);
			else if (this.dependencies.now() - this.settledAt >= settings.maxAgeMs) this.start(settings, credential);
		}
		return this.current();
	}
	/** Discard the listing and abort any in-flight load; the next access loads again and waits like a first access. */
	invalidate() {
		this.rescope(this.scope);
	}
	/** Abort in-flight loads; later results and accesses change nothing. */
	dispose() {
		this.closed = true;
		this.generation += 1;
		this.request?.abort();
	}
	rescope(scope) {
		this.request?.abort();
		this.scope = scope;
		this.listing = void 0;
		this.settledAt = void 0;
		this.inflight = void 0;
		this.failing = false;
		this.generation += 1;
	}
	start(settings, credential) {
		if (this.inflight !== void 0) return this.inflight;
		this.generation += 1;
		const generation = this.generation;
		const request = new AbortController();
		this.request = request;
		const limit = deadline(request.signal, settings.timeoutMs, LISTING_TIMEOUT);
		const run = this.dependencies.load(settings.url, credential, limit.signal).then((listing) => {
			if (generation !== this.generation) return;
			this.listing = listing;
			this.settledAt = this.dependencies.now();
			this.failing = false;
			this.dependencies.info(`model listing from ${settings.url} loaded ${listing.entries.length} model(s), skipped ${listing.skipped} row(s)`);
		}, (error) => {
			if (generation !== this.generation) return;
			if (!this.failing) {
				const fallback = this.listing === void 0 ? "using the bundled catalog" : "keeping the previous catalog";
				this.dependencies.warn(`model listing from ${settings.url} failed (${String(error)}); ${fallback}`);
			}
			this.settledAt = this.dependencies.now();
			this.failing = true;
		}).finally(() => {
			limit[Symbol.dispose]();
			if (this.inflight === run) this.inflight = void 0;
		});
		this.inflight = run;
		return run;
	}
};
//#endregion
//#region lib/types/listed-catalog.js
/** A listed catalog: version gating, this build's model knowledge, and deployment overrides. */
/** Replace fields of an entry; a text-only result drops the image limits it inherited. */
function layered(model, layer) {
	const merged = {
		...model,
		...layer
	};
	if (merged.inputModalities?.includes("image") !== true) {
		if (layer.imagePixelBudget === void 0) delete merged.imagePixelBudget;
		if (layer.imageMaxBytes === void 0) delete merged.imageMaxBytes;
	}
	return merged;
}
/** Layer one usable listing entry over this build's entry for the same id; a declared `leading-only` mode removes the inherited one. */
function listed(base, entry, facts, routeMaxTokens) {
	const { systemPromptUpdate, toolUpdate, ...rest } = base;
	return layered({
		...rest,
		...systemPromptUpdate === void 0 || facts.systemPromptUpdate === "leading-only" ? {} : { systemPromptUpdate },
		...toolUpdate === void 0 || facts.toolUpdate === "leading-only" ? {} : { toolUpdate }
	}, {
		...entry.name === void 0 ? {} : { name: entry.name },
		...facts.contextWindow === void 0 ? {} : { contextWindow: facts.contextWindow },
		...facts.maxOutputTokens === void 0 ? {} : { maxTokens: Math.min(routeMaxTokens, facts.maxOutputTokens) },
		...facts.systemPromptUpdate === "in-history" ? { systemPromptUpdate: "in-history" } : {},
		...facts.toolUpdate === void 0 || facts.toolUpdate === "leading-only" ? {} : { toolUpdate: facts.toolUpdate },
		inputModalities: [...facts.inputModalities]
	});
}
function gateOf(entry, known, clientVersion, problems) {
	const requirement = entry.requirement;
	switch (requirement.kind) {
		case "none": return known ? void 0 : { kind: "unsupported" };
		case "min-version":
			if (semver.valid(requirement.version) === null) break;
			return semver.gte(clientVersion, requirement.version) ? void 0 : {
				kind: "upgrade-required",
				requiredVersion: requirement.version
			};
		case "invalid": break;
		/* v8 ignore next 2 -- listing decoding produces only the closed requirement union */
		default: return assertNever(requirement, "model listing client requirement");
	}
	problems.push(`model "${entry.id}" declares an unreadable client requirement`);
	return { kind: "unsupported" };
}
/**
* Resolve a route's catalog from its listing. A declared minimum client version decides a
* listed model's availability; without one, only models this build supports
* are offered and the other listed models stay hidden.
* @param input - listing, supported models, overrides, route cap, and this build's version.
* @returns offered models, request-resolution entries, refusals, and diagnostics.
*/
function resolveListedCatalog(input) {
	const supported = new Map(input.supported.map((model) => [model.id, model]));
	const problems = [];
	const overrideErrors = [];
	const withOverride = (model) => {
		const override = input.overrides[model.id];
		if (override === void 0) return model;
		const candidate = layered(model, override);
		try {
			resolveAdapterOptions({ models: [candidate] });
		} catch (error) {
			overrideErrors.push(`modelOverrides.${model.id} does not apply (${String(error)})`);
			return model;
		}
		return candidate;
	};
	if (input.listing === void 0) {
		const resolution = resolveAdapterOptions({ models: input.supported.map(withOverride) }).models;
		return {
			offered: resolution,
			resolution,
			refusals: /* @__PURE__ */ new Map(),
			problems,
			overrideErrors
		};
	}
	const offered = [];
	const refusals = /* @__PURE__ */ new Map();
	for (const entry of input.listing) {
		const refusal = gateOf(entry, supported.has(entry.id), input.clientVersion, problems);
		if (refusal !== void 0) {
			refusals.set(entry.id, refusal);
			continue;
		}
		if (!entry.capabilities.usable) {
			problems.push(`model "${entry.id}" ${entry.capabilities.reason}`);
			refusals.set(entry.id, { kind: "unsupported" });
			continue;
		}
		offered.push(withOverride(listed(supported.get(entry.id) ?? { id: entry.id }, entry, entry.capabilities.facts, input.routeMaxTokens)));
	}
	const offeredIds = new Set(offered.map((model) => model.id));
	const listedIds = new Set(input.listing.map((entry) => entry.id));
	for (const id of Object.keys(input.overrides)) if (!listedIds.has(id) && !supported.has(id)) overrideErrors.push(`modelOverrides names "${id}", which neither the model listing nor the built-in catalog describes`);
	const resolution = resolveAdapterOptions({ models: [...offered, ...input.supported.filter((model) => !offeredIds.has(model.id)).map(withOverride)] }).models;
	return {
		offered: resolution.slice(0, offered.length),
		resolution,
		refusals,
		problems,
		overrideErrors
	};
}
/**
* Refuse a listed model this build cannot serve, before any network I/O.
* @param model - requested wire model id.
* @param refusal - the catalog's refusal for `model`, or `undefined` when it is admitted.
* @throws LlmError `CLIENT_UPGRADE_REQUIRED` naming the required and current versions, or `MODEL_UNSUPPORTED`.
*/
function refuseListedModel(model, refusal) {
	if (refusal === void 0) return;
	switch (refusal.kind) {
		case "upgrade-required": throw new LlmError(`DeepSeek model "${model}" requires DeepSeek Harness ${refusal.requiredVersion} or later; current version is ${APP_IDENTITY.version}`, "CLIENT_UPGRADE_REQUIRED");
		case "unsupported": throw new LlmError(`DeepSeek model "${model}" is not supported by DeepSeek Harness; current version is ${APP_IDENTITY.version}`, "MODEL_UNSUPPORTED");
		/* v8 ignore next 2 -- catalog resolution produces only the closed refusal union */
		default: assertNever(refusal, "listed catalog refusal");
	}
}
//#endregion
export { Config, DEFAULT_CONTEXT_WINDOW, DEFAULT_FILES_API_TIMEOUT_MS, DEFAULT_FILE_EXPIRY_SECONDS, DEFAULT_FILE_QUOTA_CLEANUP_BATCH, DEFAULT_FILE_REFRESH_MARGIN_SECONDS, DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM, DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM, DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM, DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET, DEFAULT_MAX_IMAGES_PER_REQUEST, DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES, DEFAULT_MAX_REQUEST_FILES_BYTES, DEFAULT_MAX_TOKENS, DEFAULT_MODELS_MAX_AGE_MS, DEFAULT_MODELS_TIMEOUT_MS, DEFAULT_REQUEST_IMAGE_MAX_BYTES, DEFAULT_STREAM_IDLE_TIMEOUT_MS, DeepSeekAdapter, DeepSeekFileId, DeepSeekFileStore, DeepSeekFilesClient, DeepSeekUploadIndex, LISTING_TIMEOUT, MAX_FILE_EXPIRY_SECONDS, MAX_FILE_UPLOAD_BYTES, MAX_IMAGE_BYTES, MAX_STORED_FILE_BYTES, MAX_STORED_FILE_COUNT, MIN_FILE_EXPIRY_SECONDS, ModelListingCache, PUBLIC_BASE_URL, REQUEST_IMAGE_MAX_DIMENSION, catalogModelFields, catalogModelInfo, deepSeekConfigFields, deepSeekFileScope, deepSeekImageRequestPricing, deepSeekImageTokens, deepSeekRequestImageDimensions, isBuiltInCatalog, modelListingConfigFields, modelListingURL, parseModelListing, plainOptions, refuseListedModel, registerDeepSeekProvider, requestModelListing, resolveAdapterOptions, resolveListedCatalog, resolveListingTiming, resolveRequestImageMaxBytes, resolveRequestImageTarget };
