import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError } from "@deepseek-ai/dsh-llm";
import { deepFreeze } from "@deepseek-ai/dsh-util-values";
//#region lib/types/image-offload.js
/** Select and log permanent image omissions in current model-request order. */
/**
* Record one decision omitting the oldest retained input-image occurrences.
* Assistant nodes carry model output and are excluded. Image indexes count
* every occurrence, including previously offloaded ones, within each message.
* @param session - session whose next request applies the decision.
* @param sourceEventSeqs - input message events in the failed request's order.
* @param count - additional retained occurrences the adapter needs omitted.
* @returns whether any occurrence remained to offload.
*/
function offloadOldestImages(session, sourceEventSeqs, count) {
	const targets = [];
	for (const seq of sourceEventSeqs) {
		if (count === 0) break;
		const event = session.eventAt(seq);
		if (event.type !== "user/message" && event.type !== "tool/result") continue;
		const message = session.deriveEventMessage(event);
		const imageIndexes = [];
		let imageIndex = 0;
		const visit = (blocks) => {
			for (const block of blocks) {
				if (count === 0) break;
				if (block.type === "image") {
					if (block.offloaded !== true) {
						imageIndexes.push(imageIndex);
						count -= 1;
					}
					imageIndex += 1;
				}
			}
		};
		visit(message.content);
		if (imageIndexes.length > 0) targets.push({
			seq,
			imageIndexes
		});
	}
	if (targets.length === 0) return false;
	session.append("image/offload", { targets });
	return true;
}
//#endregion
//#region lib/types/project-message.js
/** Immutable application of the image occurrences recorded by image/offload. */
/**
* Project selected image occurrences to immutable offloaded blocks.
* @param message - message projected before this decision.
* @param indexes - nonempty, strictly increasing depth-first image indexes.
* @returns an immutable message with the same identity and selected images marked.
* @throws when a selected occurrence is missing or already offloaded.
*/
function offloadMessageImages(message, indexes) {
	let imageIndex = 0;
	let selected = 0;
	const visit = (blocks) => {
		let next;
		for (const [index, block] of blocks.entries()) {
			let projected = block;
			if (block.type === "image") {
				if (imageIndex === indexes[selected]) {
					if (block.offloaded === true) throw new Error(`image/offload: image index ${imageIndex} is already offloaded`);
					projected = {
						...block,
						offloaded: true
					};
					selected += 1;
				}
				imageIndex += 1;
			}
			if (projected !== block) next ??= blocks.slice(0, index);
			next?.push(projected);
		}
		return next ?? blocks;
	};
	const content = visit(message.content);
	if (selected !== indexes.length) throw new Error(`image/offload: image index ${indexes[selected]} does not exist`);
	return deepFreeze({
		...message,
		content
	});
}
//#endregion
//#region lib/types/projection.js
/** Browser-safe durable image selection declaration and pure replay definition. */
/** Whether a durable value is a JSON object. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Whether a durable occurrence index or sequence is canonical. */
function isIndex(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
/** Atomic validation and reconstruction shared by live sessions and detached replay. */
const imageOffloadProjection = {
	type: "image/offload",
	project(event, context) {
		const data = event.data;
		if (!isRecord(data) || Object.keys(data).length !== 1 || !Array.isArray(data["targets"]) || data["targets"].length === 0) throw new Error("image/offload: data must contain a nonempty targets array");
		const messages = /* @__PURE__ */ new Map();
		const nodes = new Set(context.nodes);
		for (const target of data["targets"]) {
			if (!isRecord(target) || Object.keys(target).length !== 2 || !isIndex(target["seq"]) || !Array.isArray(target["imageIndexes"]) || target["imageIndexes"].length === 0) throw new Error("image/offload: each target must contain a seq and nonempty imageIndexes");
			const seq = target["seq"];
			if (messages.has(seq)) throw new Error(`image/offload: duplicate target seq ${seq}`);
			if (!nodes.has(seq)) throw new Error(`image/offload: target seq ${seq} is not a current surface node`);
			const source = context.events[seq - context.baseSeq];
			if (source?.type !== "user/message" && source?.type !== "tool/result") throw new Error(`image/offload: target seq ${seq} must be user/message or tool/result`);
			let previous = -1;
			for (const index of target["imageIndexes"]) {
				if (!isIndex(index) || index <= previous) throw new Error("image/offload: imageIndexes must be strictly increasing non-negative safe integers");
				previous = index;
			}
			const message = context.messages.get(seq) ?? (source.type === "user/message" ? source.data : source.data.message);
			messages.set(seq, offloadMessageImages(message, target["imageIndexes"]));
		}
		return messages;
	}
};
//#endregion
//#region lib/types/index.js
/**
* Image offload executor for the compaction seam. When an image-capable route
* fails a request with `IMAGE_OFFLOAD_REQUIRED`, the plugin records one
* `image/offload` decision selecting the oldest retained input occurrences
* and retries through the agent or compaction summary error waterfall. Every route
* sends placeholder text for those occurrences in subsequent requests.
*
* @module @deepseek-ai/dsh-compaction-image-offload
*/
const name = "compaction-image-offload";
const inject = ["agents", "sessions"];
/**
* Mount agent and summary recovery listeners without configuration.
* @param ctx - the plugin context.
*/
function apply(ctx) {
	ctx.sessions.registerMessageProjection(imageOffloadProjection);
	ctx.on("agent/request-error", ({ agent, failure, signal }, next) => {
		if (failure.code !== IMAGE_OFFLOAD_REQUIRED_CODE || failure.offloadImages === void 0 || signal.aborted) return next();
		if (!offloadOldestImages(agent.session, agent.session.surface.nodes, failure.offloadImages)) return next();
		return Promise.resolve({ kind: "retry" });
	});
	ctx.on("compaction/summary-error", ({ session, sourceEventSeqs, error, signal }, next) => {
		if (!(error instanceof LlmError) || error.code !== IMAGE_OFFLOAD_REQUIRED_CODE || error.failure.offloadImages === void 0) return next();
		signal?.throwIfAborted();
		if (!offloadOldestImages(session, sourceEventSeqs, error.failure.offloadImages)) return next();
		return true;
	});
}
//#endregion
export { apply, inject, name };
