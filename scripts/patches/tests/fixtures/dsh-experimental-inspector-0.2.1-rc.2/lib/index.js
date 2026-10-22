import z from "@deepseek-ai/schemastery";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { MessageChannel, Worker } from "node:worker_threads";
import { Context } from "@deepseek-ai/cordis";
import { randomUUID as randomUUID$1 } from "@deepseek-ai/dsh-util-crypto";
//#endregion
//#region lib/types/host/inspection/network.js
/** Full `globalThis.fetch` capture that publishes without delaying response delivery. */
/** Observation topics published by the Host network adapter. */
const NETWORK_TOPICS = [
	"fetch/start",
	"fetch/request-body-chunk",
	"fetch/request-body-end",
	"fetch/response",
	"fetch/response-body-chunk",
	"fetch/end",
	"fetch/error"
];
/**
* Keeps each wrapper-created Request reachable while the caller's response body stream is reachable.
* Node's fetch forwards the caller's abort signal only while that Request is reachable. The capture
* clone shares one source with the caller's body stream and keeps that stream reachable while capture
* reads. Entries are set after `response.clone()`, which replaces `response.body`. The map is
* module-level so that responses obtained before `stop()` keep their Request reachable afterwards.
*/
const requestsByBody = /* @__PURE__ */ new WeakMap();
/**
* Install full fetch capture for every later call through `globalThis.fetch`.
* @param publisher - Host source that receives fetch lifecycle records.
* @param options - Per-body capture limits.
* @returns The owner that stops capture and awaits pending body readers.
*/
function installFetchObserver(publisher, options) {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	const original = globalThis.fetch;
	if (typeof original !== "function") throw new Error("inspector: globalThis.fetch is unavailable");
	if (descriptor !== void 0 && !("value" in descriptor)) throw new Error("inspector: globalThis.fetch is an accessor and cannot be observed safely");
	const controller = new AbortController();
	const pending = /* @__PURE__ */ new Set();
	let nextRequestId = 0;
	const track = (promise) => {
		pending.add(promise);
		promise.then(() => {
			pending.delete(promise);
		}, () => {
			pending.delete(promise);
		});
	};
	const observedFetch = async (input, init) => {
		const request = new Request(input, init);
		const requestId = `fetch-${++nextRequestId}`;
		publisher.publish("fetch/start", {
			requestId,
			url: request.url,
			method: request.method,
			headers: headerEntries(request.headers),
			hasBody: request.body !== null,
			wallTimeMs: Date.now()
		});
		let requestClone;
		try {
			requestClone = request.clone();
		} catch (error) {
			publisher.publish("fetch/request-body-end", {
				requestId,
				capturedBytes: 0,
				truncated: false,
				captureError: renderError$1(error)
			});
		}
		if (requestClone !== void 0) track(captureBody(requestClone.body, options.maxRequestBodyBytes, options.maxChunkBytes, controller.signal, (data) => {
			publisher.publish("fetch/request-body-chunk", {
				requestId,
				data
			});
		}).then((outcome) => {
			publisher.publish("fetch/request-body-end", compactOutcome(requestId, outcome));
		}));
		let response;
		try {
			response = await Reflect.apply(original, globalThis, [request]);
		} catch (error) {
			publisher.publish("fetch/error", {
				requestId,
				message: renderError$1(error),
				canceled: request.signal.aborted || isAbortError(error)
			});
			throw error;
		}
		publisher.publish("fetch/response", {
			requestId,
			url: response.url || request.url,
			status: response.status,
			statusText: response.statusText,
			headers: headerEntries(response.headers),
			mimeType: response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
		});
		try {
			track(captureBody(response.clone().body, options.maxResponseBodyBytes, options.maxChunkBytes, controller.signal, (data) => {
				publisher.publish("fetch/response-body-chunk", {
					requestId,
					data
				});
			}).then((outcome) => {
				publisher.publish("fetch/end", {
					requestId,
					capturedBytes: outcome.capturedBytes,
					responseBodyTruncated: outcome.truncated,
					...outcome.captureError === void 0 ? {} : { responseCaptureError: outcome.captureError }
				});
			}));
		} catch (error) {
			publisher.publish("fetch/end", {
				requestId,
				capturedBytes: 0,
				responseBodyTruncated: false,
				responseCaptureError: renderError$1(error)
			});
		}
		if (response.body !== null) requestsByBody.set(response.body, request);
		return response;
	};
	Object.defineProperty(observedFetch, "name", {
		value: original.name,
		configurable: true
	});
	Object.defineProperty(observedFetch, "length", {
		value: original.length,
		configurable: true
	});
	Object.defineProperty(globalThis, "fetch", descriptor === void 0 ? {
		value: observedFetch,
		writable: true,
		configurable: true
	} : {
		...descriptor,
		value: observedFetch
	});
	let stopped;
	return { stop() {
		if (stopped !== void 0) return stopped;
		stopped = (async () => {
			const current = Object.getOwnPropertyDescriptor(globalThis, "fetch");
			if (current !== void 0 && "value" in current && current.value === observedFetch) if (descriptor === void 0) Reflect.deleteProperty(globalThis, "fetch");
			else Object.defineProperty(globalThis, "fetch", descriptor);
			controller.abort();
			await Promise.allSettled([...pending]);
		})();
		return stopped;
	} };
}
async function captureBody(body, limit, chunkLimit, signal, emit) {
	if (body === null) return {
		capturedBytes: 0,
		truncated: false
	};
	const reader = body.getReader();
	const abort = () => {
		reader.cancel(signal.reason).catch(() => void 0);
	};
	signal.addEventListener("abort", abort, { once: true });
	let capturedBytes = 0;
	let truncated = false;
	try {
		while (!signal.aborted) {
			const item = await reader.read();
			if (item.done) break;
			let offset = 0;
			while (offset < item.value.byteLength) {
				const remaining = limit - capturedBytes;
				if (remaining <= 0) {
					truncated = true;
					reader.cancel("inspector body capture limit reached").catch(() => void 0);
					return {
						capturedBytes,
						truncated
					};
				}
				const size = Math.min(chunkLimit, remaining, item.value.byteLength - offset);
				const chunk = item.value.subarray(offset, offset + size);
				emit(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64"));
				capturedBytes += size;
				offset += size;
			}
		}
		if (signal.aborted) {
			reader.cancel(signal.reason).catch(() => void 0);
			return {
				capturedBytes,
				truncated,
				captureError: "inspector stopped during body capture"
			};
		}
		return {
			capturedBytes,
			truncated
		};
	} catch (error) {
		return {
			capturedBytes,
			truncated: true,
			captureError: renderError$1(error)
		};
	} finally {
		signal.removeEventListener("abort", abort);
		reader.releaseLock();
	}
}
function compactOutcome(requestId, outcome) {
	return {
		requestId,
		capturedBytes: outcome.capturedBytes,
		truncated: outcome.truncated,
		...outcome.captureError === void 0 ? {} : { captureError: outcome.captureError }
	};
}
function headerEntries(headers) {
	return [...headers.entries()];
}
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}
function renderError$1(error) {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	try {
		return String(error);
	} catch {
		return "unrenderable fetch error";
	}
}
//#endregion
//#region lib/types/shared/identity.js
/** Shared branded-identifier construction without assigning protocol ownership. */
/**
* Validate and brand a non-empty identifier received from or sent across a runtime boundary.
* @param value - Untrusted identifier text.
* @param label - Field name used in validation errors.
* @returns The role-branded identifier.
*/
function inspectorId(value, label) {
	if (value.length === 0 || value.length > 256) throw new Error(`inspector protocol: ${label} must contain 1 to 256 characters`);
	return value;
}
//#endregion
//#region lib/types/shared/json.js
/** JSON values admitted by every Inspector cross-realm message. */
/**
* Test that a value can cross both MessagePort and JSON WebSocket carriers without coercion.
* @param value - Candidate wire value.
* @returns Whether the value is lossless JSON data.
*/
function isJsonValue(value) {
	return visitJson(value, /* @__PURE__ */ new Set());
}
/**
* Compute the UTF-8 byte length of a JSON wire value.
* @param value - Validated JSON value.
* @returns Its encoded byte length.
*/
function jsonByteLength(value) {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
/**
* Test whether a value is a plain object with string own keys.
* @param value - Candidate object.
* @returns Whether the value has `Object.prototype` or a null prototype.
*/
function isPlainObject(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Reflect.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function visitJson(value, ancestors) {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
	if (typeof value !== "object" || ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return false;
			return value.every((item) => visitJson(item, ancestors));
		}
		if (!isPlainObject(value)) return false;
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor?.enumerable !== true || !("value" in descriptor) || !visitJson(descriptor.value, ancestors)) return false;
		}
		return true;
	} finally {
		ancestors.delete(value);
	}
}
//#endregion
//#region lib/types/shared/validation.js
/** Shared exact-object readers for versioned Inspector wire protocols. */
/**
* Require a plain object containing only the listed fields.
* @param value - Candidate object.
* @param keys - Complete field allowlist.
* @param label - Object name used in validation errors.
* @returns The validated plain object.
*/
function exactObject(value, keys, label) {
	if (!isPlainObject(value)) throw new Error(`inspector protocol: ${label} must be an object`);
	exactKeys(value, keys, label);
	return value;
}
/**
* Reject fields outside one versioned object's declared field set.
* @param value - Plain object being validated.
* @param keys - Complete field allowlist.
* @param label - Object name used in validation errors.
*/
function exactKeys(value, keys, label) {
	const allowed = new Set(keys);
	for (const key of Reflect.ownKeys(value)) if (typeof key !== "string" || !allowed.has(key)) throw new Error(`inspector protocol: ${label} has unknown field ${JSON.stringify(String(key))}`);
}
/**
* Read one non-empty opaque identifier.
* @param value - Candidate identifier.
* @param label - Field name used in validation errors.
* @returns The role-branded identifier.
*/
function wireId(value, label) {
	if (typeof value !== "string") throw new Error(`inspector protocol: ${label} must be a string`);
	return inspectorId(value, label);
}
/**
* Read one optional string field.
* @param value - Object containing the field.
* @param key - Field name.
* @returns An empty object or the validated field.
*/
function optionalString(value, key) {
	const item = value[key];
	if (item === void 0) return {};
	if (typeof item !== "string") throw new Error(`inspector protocol: ${key} must be a string`);
	return { [key]: item };
}
/**
* Read one optional boolean field.
* @param value - Object containing the field.
* @param key - Field name.
* @returns An empty object or the validated field.
*/
function optionalBoolean(value, key) {
	const item = value[key];
	if (item === void 0) return {};
	if (typeof item !== "boolean") throw new Error(`inspector protocol: ${key} must be a boolean`);
	return { [key]: item };
}
/**
* Read one optional non-negative finite number field.
* @param value - Object containing the field.
* @param key - Field name.
* @returns An empty object or the validated field.
*/
function optionalNonNegativeNumber(value, key) {
	const item = value[key];
	if (item === void 0) return {};
	if (typeof item !== "number" || !Number.isFinite(item) || item < 0) throw new Error(`inspector protocol: ${key} must be a non-negative finite number`);
	return { [key]: item };
}
//#endregion
//#region lib/types/shared/bridge/messages/runtime/console-frames.js
/**
* Parse a Worker-to-Client Console lifecycle frame.
* @param value - Untrusted decoded frame.
* @returns A validated enable or disable frame.
*/
function parseClientConsoleControlFrame(value) {
	exactKeys(value, [
		"v",
		"t",
		"sourceId",
		"generation",
		"sessionId"
	], "Client Console control frame");
	if (value.v !== 0 || value.t !== "client-console/enable" && value.t !== "client-console/disable") throw new Error("inspector protocol: invalid Client Console control frame");
	return {
		v: 0,
		t: value.t,
		sourceId: wireId(value.sourceId, "sourceId"),
		generation: wireId(value.generation, "generation"),
		sessionId: wireId(value.sessionId, "sessionId")
	};
}
//#endregion
//#region lib/types/shared/bridge/messages/runtime/command-codec.js
/** Exact wire decoder for Client Runtime commands. */
/**
* Parse and rebuild one Runtime command before it enters the Client realm.
* @param value - Untrusted command value.
* @returns The validated command union member.
*/
function parseClientRuntimeCommand(value) {
	if (!isPlainObject(value) || typeof value.op !== "string") throw new Error("inspector protocol: Client Runtime command must have an op");
	switch (value.op) {
		case "evaluate":
			exactKeys(value, [
				"op",
				"expression",
				"objectGroup",
				"includeCommandLineAPI",
				"silent",
				"returnByValue",
				"generatePreview",
				"userGesture",
				"awaitPromise",
				"disableBreaks",
				"replMode",
				"allowUnsafeEvalBlockedByCSP",
				"timeoutMs"
			], "evaluate command");
			if (typeof value.expression !== "string") throw new Error("inspector protocol: evaluate expression must be a string");
			return {
				op: "evaluate",
				expression: value.expression,
				...optionalString(value, "objectGroup"),
				...optionalBoolean(value, "includeCommandLineAPI"),
				...optionalBoolean(value, "silent"),
				...optionalBoolean(value, "returnByValue"),
				...optionalBoolean(value, "generatePreview"),
				...optionalBoolean(value, "userGesture"),
				...optionalBoolean(value, "awaitPromise"),
				...optionalBoolean(value, "disableBreaks"),
				...optionalBoolean(value, "replMode"),
				...optionalBoolean(value, "allowUnsafeEvalBlockedByCSP"),
				...optionalNonNegativeNumber(value, "timeoutMs")
			};
		case "get-properties":
			exactKeys(value, [
				"op",
				"handle",
				"ownProperties",
				"accessorPropertiesOnly",
				"generatePreview",
				"nonIndexedPropertiesOnly"
			], "get-properties command");
			return {
				op: "get-properties",
				handle: wireId(value.handle, "handle"),
				...optionalBoolean(value, "ownProperties"),
				...optionalBoolean(value, "accessorPropertiesOnly"),
				...optionalBoolean(value, "generatePreview"),
				...optionalBoolean(value, "nonIndexedPropertiesOnly")
			};
		case "call-function": return parseCallFunction(value);
		case "await-promise":
			exactKeys(value, [
				"op",
				"promise",
				"returnByValue",
				"generatePreview"
			], "await-promise command");
			return {
				op: "await-promise",
				promise: wireId(value.promise, "promise"),
				...optionalBoolean(value, "returnByValue"),
				...optionalBoolean(value, "generatePreview")
			};
		case "release-object":
			exactKeys(value, ["op", "handle"], "release-object command");
			return {
				op: "release-object",
				handle: wireId(value.handle, "handle")
			};
		case "release-object-group":
			exactKeys(value, ["op", "objectGroup"], "release-object-group command");
			if (typeof value.objectGroup !== "string") throw new Error("inspector protocol: objectGroup must be a string");
			return {
				op: "release-object-group",
				objectGroup: value.objectGroup
			};
		case "global-lexical-scope-names":
			exactKeys(value, ["op"], "global-lexical-scope-names command");
			return { op: "global-lexical-scope-names" };
		default: throw new Error(`inspector protocol: unknown Client Runtime command ${JSON.stringify(value.op)}`);
	}
}
function parseCallFunction(value) {
	exactKeys(value, [
		"op",
		"functionDeclaration",
		"receiver",
		"arguments",
		"objectGroup",
		"silent",
		"returnByValue",
		"generatePreview",
		"userGesture",
		"awaitPromise"
	], "call-function command");
	if (typeof value.functionDeclaration !== "string") throw new Error("inspector protocol: functionDeclaration must be a string");
	let args;
	if (value.arguments !== void 0) {
		if (!Array.isArray(value.arguments)) throw new Error("inspector protocol: call arguments must be an array");
		args = value.arguments.map(parseCallArgument);
	}
	return {
		op: "call-function",
		functionDeclaration: value.functionDeclaration,
		...value.receiver === void 0 ? {} : { receiver: wireId(value.receiver, "receiver") },
		...args === void 0 ? {} : { arguments: args },
		...optionalString(value, "objectGroup"),
		...optionalBoolean(value, "silent"),
		...optionalBoolean(value, "returnByValue"),
		...optionalBoolean(value, "generatePreview"),
		...optionalBoolean(value, "userGesture"),
		...optionalBoolean(value, "awaitPromise")
	};
}
function parseCallArgument(value) {
	if (!isPlainObject(value) || typeof value.kind !== "string") throw new Error("inspector protocol: invalid Client Runtime call argument");
	switch (value.kind) {
		case "value":
			exactKeys(value, ["kind", "value"], "value call argument");
			if (!isJsonValue(value.value)) throw new Error("inspector protocol: call argument value must be JSON");
			return {
				kind: "value",
				value: value.value
			};
		case "unserializable":
			exactKeys(value, ["kind", "value"], "unserializable call argument");
			if (typeof value.value !== "string") throw new Error("inspector protocol: unserializable argument must be a string");
			return {
				kind: "unserializable",
				value: value.value
			};
		case "object":
			exactKeys(value, ["kind", "handle"], "object call argument");
			return {
				kind: "object",
				handle: wireId(value.handle, "handle")
			};
		case "undefined":
			exactKeys(value, ["kind"], "undefined call argument");
			return { kind: "undefined" };
		default: throw new Error(`inspector protocol: unknown call argument ${JSON.stringify(value.kind)}`);
	}
}
//#endregion
//#region lib/types/shared/bridge/messages/runtime/frames.js
/**
* Parse and rebuild one Worker-to-Client Runtime request.
* @param value - Untrusted request frame.
* @returns The validated request frame.
*/
function parseClientRuntimeRequestFrame(value) {
	exactKeys(value, [
		"v",
		"t",
		"sourceId",
		"generation",
		"sessionId",
		"requestId",
		"command"
	], "Client Runtime request");
	if (value.v !== 0 || value.t !== "client-runtime/request") throw new Error("inspector protocol: invalid Client Runtime request envelope");
	return {
		v: 0,
		t: "client-runtime/request",
		sourceId: wireId(value.sourceId, "sourceId"),
		generation: wireId(value.generation, "generation"),
		sessionId: wireId(value.sessionId, "sessionId"),
		requestId: wireId(value.requestId, "requestId"),
		command: parseClientRuntimeCommand(value.command)
	};
}
/**
* Parse and rebuild one Worker-to-Client Runtime cancellation.
* @param value - Untrusted cancellation frame.
* @returns The validated cancellation frame.
*/
function parseClientRuntimeCancelFrame(value) {
	exactKeys(value, [
		"v",
		"t",
		"sourceId",
		"generation",
		"sessionId",
		"requestId"
	], "Client Runtime cancellation");
	if (value.v !== 0 || value.t !== "client-runtime/cancel") throw new Error("inspector protocol: invalid Client Runtime cancellation envelope");
	return {
		v: 0,
		t: "client-runtime/cancel",
		sourceId: wireId(value.sourceId, "sourceId"),
		generation: wireId(value.generation, "generation"),
		sessionId: wireId(value.sessionId, "sessionId"),
		requestId: wireId(value.requestId, "requestId")
	};
}
/**
* Parse and rebuild one Worker acknowledgement for a Client Runtime response.
* @param value - Untrusted acknowledgement frame.
* @returns The validated acknowledgement frame.
*/
function parseClientRuntimeResponseAcknowledgedFrame(value) {
	exactKeys(value, [
		"v",
		"t",
		"sourceId",
		"generation",
		"sessionId",
		"requestId"
	], "Client Runtime response acknowledgement");
	if (value.v !== 0 || value.t !== "client-runtime/response-acknowledged") throw new Error("inspector protocol: invalid Client Runtime response acknowledgement envelope");
	return {
		v: 0,
		t: "client-runtime/response-acknowledged",
		sourceId: wireId(value.sourceId, "sourceId"),
		generation: wireId(value.generation, "generation"),
		sessionId: wireId(value.sessionId, "sessionId"),
		requestId: wireId(value.requestId, "requestId")
	};
}
/**
* Parse and rebuild one Runtime-session cleanup notification.
* @param value - Untrusted cleanup frame.
* @returns The validated cleanup frame.
*/
function parseClientRuntimeSessionClosedFrame(value) {
	exactKeys(value, [
		"v",
		"t",
		"sourceId",
		"generation",
		"sessionId"
	], "Client Runtime session close");
	if (value.v !== 0 || value.t !== "client-runtime/session-closed") throw new Error("inspector protocol: invalid Client Runtime session close envelope");
	return {
		v: 0,
		t: "client-runtime/session-closed",
		sourceId: wireId(value.sourceId, "sourceId"),
		generation: wireId(value.generation, "generation"),
		sessionId: wireId(value.sessionId, "sessionId")
	};
}
//#endregion
//#region lib/types/shared/bridge/messages/sources/codec.js
/** Exact decoders for Client source catalog operations and values. */
/**
* Parse one Worker-to-Client source command.
* @param value - Untrusted decoded command.
* @returns The validated command.
*/
function parseClientSourceCommand(value) {
	if (!isPlainObject(value) || typeof value.op !== "string") throw new Error("inspector protocol: Client source command must have an op");
	if (value.op === "list-scripts") {
		exactKeys(value, ["op"], "Client source list command");
		return { op: "list-scripts" };
	}
	if (value.op !== "get-content-chunk") throw new Error(`inspector protocol: unknown Client source command ${JSON.stringify(value.op)}`);
	exactKeys(value, [
		"op",
		"scriptKey",
		"content",
		"offset",
		"maxBytes"
	], "Client source chunk command");
	return {
		op: "get-content-chunk",
		scriptKey: wireId(value.scriptKey, "scriptKey"),
		content: contentKind(value.content),
		offset: natural$3(value.offset, "offset", true),
		maxBytes: natural$3(value.maxBytes, "maxBytes", false)
	};
}
function contentKind(value) {
	if (value !== "source" && value !== "source-map") throw new Error("inspector protocol: invalid Client source content kind");
	return value;
}
function natural$3(value, label, zero) {
	if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new Error(`inspector protocol: ${label} must be ${zero ? "a non-negative" : "a positive"} integer`);
	return value;
}
//#endregion
//#region lib/types/shared/bridge/messages/sources/frames.js
/**
* Parse one Worker-to-Client source request.
* @param value - Untrusted decoded request.
* @returns The validated request frame.
*/
function parseClientSourceRequestFrame(value) {
	exactKeys(value, [
		"v",
		"t",
		"sourceId",
		"generation",
		"sessionId",
		"requestId",
		"command"
	], "Client source request");
	if (value.v !== 0 || value.t !== "client-sources/request") throw new Error("inspector protocol: invalid Client source request envelope");
	return {
		v: 0,
		t: "client-sources/request",
		sourceId: wireId(value.sourceId, "sourceId"),
		generation: wireId(value.generation, "generation"),
		sessionId: wireId(value.sessionId, "sessionId"),
		requestId: wireId(value.requestId, "requestId"),
		command: parseClientSourceCommand(value.command)
	};
}
/**
* Parse one Client source-session cleanup notification.
* @param value - Untrusted decoded notification.
* @returns The validated cleanup frame.
*/
function parseClientSourceSessionClosedFrame(value) {
	exactKeys(value, [
		"v",
		"t",
		"sourceId",
		"generation",
		"sessionId"
	], "Client source session close");
	if (value.v !== 0 || value.t !== "client-sources/session-closed") throw new Error("inspector protocol: invalid Client source session close envelope");
	return {
		v: 0,
		t: "client-sources/session-closed",
		sourceId: wireId(value.sourceId, "sourceId"),
		generation: wireId(value.generation, "generation"),
		sessionId: wireId(value.sessionId, "sessionId")
	};
}
//#endregion
//#region lib/types/shared/bridge/messages/observation.js
/** Versioned source lifecycle, observation, and extension frames shared by both carriers. */
/**
* Parse and rebuild one Worker control frame received by a source.
* @param value - Untrusted decoded wire value.
* @returns The validated Worker-to-source frame.
*/
function parseWorkerSourceFrame(value) {
	if (!isJsonValue(value) || !isPlainObject(value) || value.v !== 0 || typeof value.t !== "string") throw new Error("inspector protocol: invalid Worker source frame");
	if (value.t === "source/rejected") {
		exactKeys(value, [
			"v",
			"t",
			"code",
			"message"
		], "source/rejected frame");
		if (value.code !== "invalid-frame" && value.code !== "version-mismatch" && value.code !== "unauthorized" || typeof value.message !== "string") throw new Error("inspector protocol: invalid source/rejected frame");
		return {
			v: 0,
			t: "source/rejected",
			code: value.code,
			message: value.message
		};
	}
	if (value.t === "client-runtime/request") return parseClientRuntimeRequestFrame(value);
	if (value.t === "client-runtime/cancel") return parseClientRuntimeCancelFrame(value);
	if (value.t === "client-runtime/response-acknowledged") return parseClientRuntimeResponseAcknowledgedFrame(value);
	if (value.t === "client-runtime/session-closed") return parseClientRuntimeSessionClosedFrame(value);
	if (value.t === "client-sources/request") return parseClientSourceRequestFrame(value);
	if (value.t === "client-sources/session-closed") return parseClientSourceSessionClosedFrame(value);
	if (value.t === "client-console/enable" || value.t === "client-console/disable") return parseClientConsoleControlFrame(value);
	const common = {
		v: 0,
		sourceId: sourceId(value.sourceId),
		generation: generation(value.generation)
	};
	if (value.t === "source/accepted") {
		exactKeys(value, [
			"v",
			"t",
			"sourceId",
			"generation"
		], "source/accepted frame");
		return {
			...common,
			t: "source/accepted"
		};
	}
	if (value.t === "source/append-acknowledged") {
		exactKeys(value, [
			"v",
			"t",
			"sourceId",
			"generation",
			"nextSequence"
		], "source append acknowledgement");
		return {
			...common,
			t: "source/append-acknowledged",
			nextSequence: natural$2(value.nextSequence, "nextSequence")
		};
	}
	if (value.t === "source/resnapshot" && typeof value.reason === "string") {
		exactKeys(value, [
			"v",
			"t",
			"sourceId",
			"generation",
			"expectedSequence",
			"reason"
		], "source/resnapshot frame");
		return {
			...common,
			t: "source/resnapshot",
			expectedSequence: natural$2(value.expectedSequence, "expectedSequence"),
			reason: value.reason
		};
	}
	throw new Error(`inspector protocol: unknown Worker source frame ${JSON.stringify(value.t)}`);
}
function sourceId(value) {
	if (typeof value !== "string") throw new Error("inspector protocol: sourceId must be a string");
	return inspectorId(value, "sourceId");
}
function generation(value) {
	if (typeof value !== "string") throw new Error("inspector protocol: generation must be a string");
	return inspectorId(value, "generation");
}
function natural$2(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`inspector protocol: ${label} must be a non-negative safe integer`);
	return value;
}
//#endregion
//#region lib/types/shared/bridge/publisher.js
/** Source-side interfaces shared by MessagePort and WebSocket bridge implementations. */
/** Shared observation and query delegation inherited by both source transports. */
var InspectorSourceConnection = class {
	/** Publish one JSON observation without waiting on its carrier. */
	publish(topic, payload, monotonicMs = performance.now()) {
		this.publisher.publish(topic, payload, monotonicMs);
	}
	/** Retain and publish one state value for reconnect or replacement recovery. */
	setState(topic, payload, monotonicMs = performance.now()) {
		this.publisher.setState(topic, payload, monotonicMs);
	}
	/** Execute one non-CDP query through the active source generation. */
	request(query) {
		return this.queries.request(query);
	}
};
/**
* Reject a Client Console control frame that was routed to the Host source.
* @param operation - Misrouted Console frame type.
* @returns This function never returns.
*/
function rejectConsoleBridgeCommand(operation) {
	throw new Error(`inspector protocol: ${operation} cannot use the Host source bridge`);
}
//#endregion
//#region lib/types/host/cdp/stack.js
/** Host stack and call-frame data remain owned by the Worker-side Node inspector session. */
/** Stable explanation used for Host bridge rejections. */
const HOST_CDP_BRIDGE_REASON = "Host Runtime is attached directly from the Inspector Worker";
//#endregion
//#region lib/types/host/cdp/errors.js
/** Explicit failure for Client-style CDP bridge commands misrouted to the Host. */
/** Host Runtime uses the Worker-side Node inspector session instead of source RPC. */
var HostCdpBridgeUnavailableError = class extends Error {
	constructor(operation) {
		super(`inspector protocol: ${operation} cannot use the Host source bridge; ${HOST_CDP_BRIDGE_REASON}`);
	}
};
//#endregion
//#region lib/types/host/cdp/objects.js
/** Host RemoteObject handles never cross the Host source bridge. */
/**
* Reject an object operation that must use the Worker-owned native inspector session.
* @param operation - Misrouted object operation.
* @returns This function never returns.
*/
function rejectObjectBridgeOperation(operation) {
	throw new HostCdpBridgeUnavailableError(operation);
}
//#endregion
//#region lib/types/host/cdp/properties.js
/** Host property enumeration never crosses the Host source bridge. */
/**
* Reject a property request that must use the Worker-owned native inspector session.
* @returns This function never returns.
*/
function rejectPropertyBridgeOperation() {
	return rejectObjectBridgeOperation("client-runtime/get-properties");
}
/**
* Reject a Client Runtime command that was routed to the Host source.
* @param command - Misrouted Client Runtime operation.
* @returns This function never returns.
*/
function rejectRuntimeBridgeCommand(command) {
	switch (command.op) {
		case "get-properties": return rejectPropertyBridgeOperation();
		case "release-object":
		case "release-object-group": return rejectObjectBridgeOperation(`client-runtime/${command.op}`);
		case "evaluate":
		case "call-function":
		case "await-promise":
		case "global-lexical-scope-names": throw new HostCdpBridgeUnavailableError(`client-runtime/${command.op}`);
		default: return assertNever$1(command);
	}
}
function assertNever$1(value) {
	throw new Error(`Unexpected Host Runtime bridge command: ${JSON.stringify(value)}`);
}
/**
* Reject a Client Sources request that was routed to the Host source.
* @returns This function never returns.
*/
function rejectSourcesBridgeCommand() {
	throw new Error("inspector protocol: Client Sources cannot use the Host source bridge");
}
//#endregion
//#region lib/types/host/cdp/index.js
/** Source-side CDP capability declarations for the Host realm. */
const HOST_BRIDGE_CAPABILITIES = [
	void 0,
	void 0,
	void 0,
	void 0,
	void 0,
	void 0
].filter((capability) => capability !== void 0);
/**
* Collect Host source-bridge capabilities.
* @param _origin - Unused Host origin supplied for parity with the Client adapter.
* @param _hasSources - Unused source availability supplied for parity with the Client adapter.
* @returns No capabilities because the Worker attaches to Host V8 directly.
*/
function bridgeCapabilities(_origin, _hasSources) {
	return HOST_BRIDGE_CAPABILITIES;
}
//#endregion
//#region lib/types/host/inspection/realm.js
/** Stable descriptor for the Host observation source generation. */
/**
* Create the descriptor for one Host-to-Worker MessagePort generation.
* @param label - Human-readable Host execution-context label.
* @returns The complete Host source descriptor.
*/
function createHostRealmSource(label) {
	return {
		sourceId: inspectorId(`host-${randomUUID()}`, "sourceId"),
		generation: inspectorId(randomUUID(), "generation"),
		kind: "host",
		label,
		timeOriginMs: performance.timeOrigin,
		capabilities: bridgeCapabilities("", false)
	};
}
//#endregion
//#region lib/types/shared/bridge/buffer.js
/** Realm-neutral bounded buffering for Host and Client observation sources. */
const SOURCE_FRAME_OVERHEAD_BYTES = 4096;
/**
* Owns retained state, queued events, and source-local sequencing independently
* of whether frames travel over MessagePort or WebSocket.
*/
var InspectorSourceBuffer = class {
	options;
	queue = [];
	state = /* @__PURE__ */ new Map();
	queuedBytes = 0;
	nextSequence = 1;
	expectedSequence = 1;
	constructor(options) {
		this.options = options;
	}
	/** Whether at least one observation is waiting for transport. */
	get hasPending() {
		return this.queue.length > 0;
	}
	/**
	* Validate and enqueue one observation, dropping the oldest prefix as needed.
	* A record larger than one transport frame is dropped after consuming its sequence number.
	* @param topic - Declared domain topic.
	* @param payload - Lossless JSON payload.
	* @param monotonicMs - Finite source-clock timestamp.
	*/
	publish(topic, payload, monotonicMs) {
		this.enqueue(this.record(topic, payload, monotonicMs));
	}
	/**
	* Replace one retained topic and enqueue the same observation for live delivery.
	* @param topic - Declared state topic.
	* @param payload - Lossless JSON payload retained for replacement frames.
	* @param monotonicMs - Finite source-clock timestamp.
	*/
	setState(topic, payload, monotonicMs) {
		const record = this.record(topic, payload, monotonicMs);
		const previous = this.state.get(topic);
		this.state.set(topic, record);
		if (!this.stateFits()) {
			if (previous === void 0) this.state.delete(topic);
			else this.state.set(topic, previous);
			throw new Error("inspector: source state exceeds the source-frame byte limit");
		}
		this.enqueue(record);
	}
	/**
	* Build a complete state replacement and absorb every preceding queue drop.
	* @param sourceId - Logical source identity.
	* @param generation - Current transport generation.
	* @returns A replacement frame whose sequence is the next append position.
	*/
	replacement(sourceId, generation) {
		const nextSequence = this.queue[0]?.sequence ?? this.nextSequence;
		this.expectedSequence = nextSequence;
		return {
			v: 0,
			t: "source/replace",
			sourceId,
			generation,
			nextSequence,
			records: [...this.state.values()]
		};
	}
	/**
	* Remove and sequence the next transport-sized observation batch.
	* @param sourceId - Logical source identity.
	* @param generation - Current transport generation.
	* @returns The next append frame, or `undefined` when the queue is empty.
	*/
	takeBatch(sourceId, generation) {
		if (this.queue.length === 0) return void 0;
		const batch = [];
		let batchBytes = SOURCE_FRAME_OVERHEAD_BYTES;
		const first = this.queue[0];
		while (batch.length < this.options.maxRecordsPerFrame && this.queue.length > 0) {
			const candidate = this.queue[0];
			if (candidate.sequence !== first.sequence + batch.length) break;
			if (batch.length > 0 && batchBytes + candidate.bytes > this.options.maxFrameBytes) break;
			this.queue.shift();
			batch.push(candidate);
			batchBytes += candidate.bytes;
		}
		this.queuedBytes -= batch.reduce((sum, item) => sum + item.bytes, 0);
		const firstSequence = first.sequence;
		const frame = {
			v: 0,
			t: "source/append",
			sourceId,
			generation,
			firstSequence,
			droppedBefore: firstSequence - this.expectedSequence,
			records: batch.map((item) => item.record)
		};
		this.expectedSequence = firstSequence + frame.records.length;
		return frame;
	}
	/** Discard observations that have not entered a transport frame. */
	discardPending() {
		this.queue.length = 0;
		this.queuedBytes = 0;
	}
	record(topic, payload, monotonicMs) {
		if (topic.length === 0 || topic.length > 128) throw new Error("inspector: topic must contain 1 to 128 characters");
		if (!this.options.topics.includes("*") && !this.options.topics.includes(topic)) throw new Error(`inspector: source does not declare topic ${JSON.stringify(topic)}`);
		if (!isJsonValue(payload)) throw new Error("inspector: source payload must be lossless JSON data");
		if (!Number.isFinite(monotonicMs)) throw new Error("inspector: monotonicMs must be finite");
		return {
			monotonicMs,
			topic,
			payload
		};
	}
	enqueue(record) {
		const bytes = jsonByteLength(record);
		const sequence = this.nextSequence++;
		if (bytes + SOURCE_FRAME_OVERHEAD_BYTES > this.options.maxFrameBytes) return;
		this.queue.push({
			sequence,
			bytes,
			record
		});
		this.queuedBytes += bytes;
		while (this.queue.length > this.options.maxQueuedRecords || this.queuedBytes > this.options.maxQueuedBytes) {
			const dropped = this.queue.shift();
			this.queuedBytes -= dropped.bytes;
		}
	}
	stateFits() {
		return jsonByteLength([...this.state.values()]) + SOURCE_FRAME_OVERHEAD_BYTES <= this.options.maxFrameBytes;
	}
};
//#endregion
//#region lib/types/host/bridge/publisher.js
/** Buffered Host observation publication over a dedicated Worker MessagePort. */
/** Non-blocking Host publisher with microtask-coalesced MessagePort writes. */
var HostBridgePublisher = class {
	port;
	source;
	records;
	flushScheduled = false;
	inFlightNextSequence;
	closed = false;
	constructor(port, source, options) {
		this.port = port;
		this.source = source;
		this.records = new InspectorSourceBuffer(options);
	}
	publish(topic, payload, monotonicMs = performance.now()) {
		if (this.closed) return;
		this.records.publish(topic, payload, monotonicMs);
		this.scheduleFlush();
	}
	setState(topic, payload, monotonicMs = performance.now()) {
		if (this.closed) throw new Error("inspector: Host source is closed");
		this.records.setState(topic, payload, monotonicMs);
		this.scheduleFlush();
	}
	/** Send the retained state as a complete source replacement. */
	replace() {
		this.inFlightNextSequence = void 0;
		this.port.postMessage(this.records.replacement(this.source.sourceId, this.source.generation));
		this.scheduleFlush();
	}
	/** Send one queued batch when no earlier MessagePort batch awaits acknowledgement. */
	flush() {
		if (this.closed || this.inFlightNextSequence !== void 0) return;
		const frame = this.records.takeBatch(this.source.sourceId, this.source.generation);
		if (frame === void 0) return;
		this.port.postMessage(frame);
		this.inFlightNextSequence = frame.firstSequence + frame.records.length;
	}
	/**
	* Release one in-flight batch and schedule the next bounded transfer.
	* @param nextSequence - First sequence expected by the Worker after the accepted batch.
	*/
	acknowledge(nextSequence) {
		if (this.closed || this.inFlightNextSequence === void 0) return;
		if (nextSequence !== this.inFlightNextSequence) throw new Error("inspector: Host source acknowledgement does not match the in-flight batch");
		this.inFlightNextSequence = void 0;
		this.scheduleFlush();
	}
	/** Send at most one final batch, discard later queued observations, and reject publication. */
	close() {
		if (this.closed) return;
		this.flush();
		this.closed = true;
		this.records.discardPending();
	}
	scheduleFlush() {
		if (!this.records.hasPending || this.flushScheduled) return;
		this.flushScheduled = true;
		queueMicrotask(() => {
			this.flushScheduled = false;
			this.flush();
		});
	}
};
/**
* Decode a consumer-neutral tree received across an Inspector transport.
* @param value - Untrusted query result value.
* @returns A detached tree containing only public semantic fields.
*/
function parseCordisRuntimeTree(value) {
	const record = exactObject(value, [
		"schemaVersion",
		"host",
		"clients"
	], "Cordis runtime tree");
	if (record.schemaVersion !== 0 || !Array.isArray(record.clients)) throw new Error("inspector protocol: invalid Cordis runtime tree");
	const host = record.host === null ? null : parseRealm(record.host, "host");
	const clients = record.clients.map((client) => parseRealm(client, "client"));
	const sourceIds = /* @__PURE__ */ new Set();
	for (const realm of host === null ? clients : [host, ...clients]) {
		if (sourceIds.has(realm.source.sourceId)) throw new Error("inspector protocol: Cordis runtime tree repeats a sourceId");
		sourceIds.add(realm.source.sourceId);
	}
	return {
		schemaVersion: 0,
		host,
		clients
	};
}
function parseRealm(value, kind) {
	const record = exactObject(value, [
		"source",
		"connection",
		"revision",
		"truncated",
		"root"
	], "Cordis runtime realm");
	const source = exactObject(record.source, [
		"sourceId",
		"kind",
		"label"
	], "Cordis runtime source");
	if (source.kind !== kind || typeof source.label !== "string" || source.label.length === 0 || source.label.length > 256) throw new Error(`inspector protocol: invalid ${kind} Cordis runtime source`);
	if (!Number.isSafeInteger(record.revision) || record.revision < 1 || typeof record.truncated !== "boolean") throw new Error("inspector protocol: invalid Cordis runtime realm header");
	const root = parseNode(record.root, { fiberUids: /* @__PURE__ */ new Set() }, 0);
	if (root.kind !== "context") throw new Error("inspector protocol: Cordis runtime root must be a Context");
	return {
		source: {
			sourceId: wireId(source.sourceId, "sourceId"),
			kind,
			label: source.label
		},
		connection: parseConnection(record.connection),
		revision: record.revision,
		truncated: record.truncated,
		root
	};
}
function parseConnection(value) {
	if (!isPlainObject(value)) throw new Error("inspector protocol: Cordis runtime connection must be an object");
	if (value.state === "connected") {
		exactKeys(value, ["state"], "connected Cordis runtime connection");
		return { state: "connected" };
	}
	if (value.state === "disconnected" && typeof value.reason === "string") {
		exactKeys(value, ["state", "reason"], "disconnected Cordis runtime connection");
		return {
			state: "disconnected",
			reason: value.reason
		};
	}
	throw new Error("inspector protocol: invalid Cordis runtime connection");
}
function parseNode(value, state, depth) {
	if (depth > 256) throw new Error("inspector protocol: Cordis runtime tree exceeds the depth limit");
	if (!isPlainObject(value) || value.kind !== "context" && value.kind !== "fiber") throw new Error("inspector protocol: Cordis runtime node must have a known kind");
	const record = exactObject(value, value.kind === "fiber" ? [
		"kind",
		"uid",
		"children"
	] : ["kind", "children"], "Cordis runtime node");
	if (!Array.isArray(record.children)) throw new Error("inspector protocol: Cordis runtime node children must be an array");
	if (record.kind === "context") return {
		kind: "context",
		children: record.children.map((child) => parseNode(child, state, depth + 1))
	};
	if (!Number.isSafeInteger(record.uid) || record.uid < 1 || record.children.length !== 1) throw new Error("inspector protocol: invalid Cordis runtime Fiber");
	const uid = record.uid;
	if (state.fiberUids.has(uid)) throw new Error("inspector protocol: Cordis runtime tree repeats a Fiber uid");
	state.fiberUids.add(uid);
	const context = parseNode(record.children[0], state, depth + 1);
	if (context.kind !== "context") throw new Error("inspector protocol: Cordis runtime Fiber child must be a Context");
	return {
		kind: "fiber",
		uid,
		children: [context]
	};
}
//#endregion
//#region lib/types/shared/bridge/messages/query/codec.js
/** Exact decoders for non-CDP Inspector query frames. */
/**
* Test whether a decoded carrier value belongs to the query response protocol.
* @param value - Decoded carrier value.
* @returns Whether the query response decoder owns the value.
*/
function isInspectorQueryResponseEnvelope(value) {
	return isPlainObject(value) && value.t === "query/response";
}
/**
* Decode one Worker-to-source query response.
* @param value - Untrusted decoded carrier value.
* @returns The detached, validated response frame.
*/
function parseInspectorQueryResponseFrame(value) {
	const record = exactObject(value, [
		"v",
		"t",
		"sourceId",
		"generation",
		"requestId",
		"outcome"
	], "query response");
	if (record.v !== 0 || record.t !== "query/response") throw new Error("inspector protocol: invalid query response envelope");
	return {
		v: 0,
		t: "query/response",
		sourceId: wireId(record.sourceId, "sourceId"),
		generation: wireId(record.generation, "generation"),
		requestId: wireId(record.requestId, "requestId"),
		outcome: parseOutcome(record.outcome)
	};
}
function parseResult(value) {
	if (!isPlainObject(value) || typeof value.op !== "string") throw new Error("inspector protocol: query result must have an op");
	switch (value.op) {
		case "cordis-tree/get":
			exactKeys(value, ["op", "tree"], "Cordis tree query result");
			return {
				op: "cordis-tree/get",
				tree: parseCordisRuntimeTree(value.tree)
			};
		default: throw new Error(`inspector protocol: unknown query result ${JSON.stringify(value.op)}`);
	}
}
function parseOutcome(value) {
	if (!isPlainObject(value) || typeof value.ok !== "boolean") throw new Error("inspector protocol: invalid query outcome");
	if (value.ok) {
		exactKeys(value, ["ok", "result"], "successful query outcome");
		return {
			ok: true,
			result: parseResult(value.result)
		};
	}
	exactKeys(value, ["ok", "error"], "failed query outcome");
	const error = exactObject(value.error, ["code", "message"], "query error");
	if (!QUERY_ERROR_CODES.has(error.code) || typeof error.message !== "string") throw new Error("inspector protocol: invalid query error");
	return {
		ok: false,
		error: {
			code: error.code,
			message: error.message
		}
	};
}
const QUERY_ERROR_CODES = new Set([
	"invalid-request",
	"stale-source",
	"result-too-large",
	"internal-error"
]);
//#endregion
//#region lib/types/shared/bridge/rpc.js
/** Shared Host/Client owner of correlated non-CDP query requests. */
/** Failure deliberately returned by the Worker query handler. */
var InspectorQueryRemoteError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
	}
};
/** Correlates requests for one reconnecting Host or Client source. */
var InspectorQueryConnection = class {
	options;
	pending = /* @__PURE__ */ new Map();
	active;
	nextRequestId = 0;
	closed = false;
	constructor(options) {
		this.options = options;
	}
	/**
	* Admit the source generation acknowledged by the Worker.
	* @param sourceId - Stable source identity.
	* @param generation - Newly accepted transport generation.
	* @param sender - Carrier writer valid for that generation.
	*/
	connect(sourceId, generation, sender) {
		if (this.closed) throw new Error("inspector query connection is closed");
		this.disconnect("Inspector source generation replaced");
		this.active = {
			sourceId,
			generation,
			sender
		};
	}
	/**
	* Execute a query against the currently accepted source generation.
	* @param query - Closed typed query command.
	* @returns The result with the same operation discriminant.
	*/
	request(query) {
		const active = this.active;
		if (this.closed || active === void 0) return Promise.reject(/* @__PURE__ */ new Error("Inspector query transport is not connected"));
		const requestId = inspectorId(`query-${String(++this.nextRequestId)}`, "requestId");
		const frame = {
			v: 0,
			t: "query/request",
			sourceId: active.sourceId,
			generation: active.generation,
			requestId,
			query
		};
		if (jsonByteLength(frame) > this.options.maxFrameBytes) return Promise.reject(/* @__PURE__ */ new Error(`Inspector query request exceeds ${String(this.options.maxFrameBytes)} bytes`));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				reject(/* @__PURE__ */ new Error(`Inspector query ${query.op} timed out after ${String(this.options.timeoutMs)}ms`));
			}, this.options.timeoutMs);
			this.pending.set(requestId, {
				op: query.op,
				resolve,
				reject,
				timer
			});
			try {
				active.sender.send(frame);
			} catch (error) {
				this.rejectPending(requestId, renderError(error));
			}
		});
	}
	/**
	* Consume a decoded carrier value when it is a query response.
	* @param value - Untrusted Worker-to-source value.
	* @returns Whether the value belonged to the query protocol.
	*/
	receive(value) {
		if (!isInspectorQueryResponseEnvelope(value)) return false;
		let frame;
		try {
			frame = parseInspectorQueryResponseFrame(value);
			if (jsonByteLength(frame) > this.options.maxFrameBytes) throw new Error(`inspector protocol: query response exceeds ${String(this.options.maxFrameBytes)} bytes`);
		} catch (error) {
			this.disconnect(`Invalid Inspector query response: ${renderError(error).message}`);
			throw error;
		}
		const pending = this.pending.get(frame.requestId);
		if (pending === void 0) return true;
		const active = this.active;
		if (active === void 0 || frame.sourceId !== active.sourceId || frame.generation !== active.generation) {
			this.rejectPending(frame.requestId, /* @__PURE__ */ new Error("Inspector query response source generation does not match"));
			return true;
		}
		if (!frame.outcome.ok) {
			this.rejectPending(frame.requestId, new InspectorQueryRemoteError(frame.outcome.error.code, frame.outcome.error.message));
			return true;
		}
		if (frame.outcome.result.op !== pending.op) {
			this.rejectPending(frame.requestId, /* @__PURE__ */ new Error(`Inspector query response op ${frame.outcome.result.op} does not match ${pending.op}`));
			return true;
		}
		clearTimeout(pending.timer);
		this.pending.delete(frame.requestId);
		pending.resolve(frame.outcome.result);
		return true;
	}
	/**
	* Reject active requests while permitting a later source generation.
	* @param reason - Failure reported to every pending caller.
	*/
	disconnect(reason) {
		this.active = void 0;
		for (const requestId of [...this.pending.keys()]) this.rejectPending(requestId, new Error(reason));
	}
	/**
	* Permanently reject requests and prevent later reconnection.
	* @param reason - Failure reported to every pending caller.
	*/
	close(reason = "Inspector query connection closed") {
		if (this.closed) return;
		this.closed = true;
		this.disconnect(reason);
	}
	rejectPending(requestId, error) {
		const pending = this.pending.get(requestId);
		if (pending === void 0) return;
		clearTimeout(pending.timer);
		this.pending.delete(requestId);
		pending.reject(error);
	}
};
function renderError(error) {
	return error instanceof Error ? error : new Error(String(error));
}
//#endregion
//#region lib/types/host/bridge/rpc.js
/** Host-side non-CDP query bridge over the Worker MessagePort. */
/** Owns query correlation for one Host source generation. */
var HostBridgeRpc = class extends InspectorQueryConnection {
	port;
	constructor(port, options) {
		super(options);
		this.port = port;
	}
	/**
	* Connect query writes after the Worker accepts the Host source.
	* @param source - Accepted Host source descriptor.
	*/
	connectPort(source) {
		this.connect(source.sourceId, source.generation, { send: (frame) => {
			this.port.postMessage(frame);
		} });
	}
};
//#endregion
//#region lib/types/host/bridge/dispatcher.js
/** Dispatch of validated Worker frames accepted by the Host MessagePort. */
/**
* Dispatch one validated Worker frame and reject Client-only commands on the Host carrier.
* @param frame - Decoded Worker-to-source frame.
* @param handlers - Host source-lifecycle operations.
*/
function dispatchBridgeFrame(frame, handlers) {
	switch (frame.t) {
		case "source/accepted":
			handlers.accepted(frame);
			return;
		case "source/append-acknowledged":
			handlers.acknowledged(frame);
			return;
		case "source/resnapshot":
			handlers.resnapshot(frame);
			return;
		case "source/rejected":
			handlers.rejected(frame);
			return;
		case "client-runtime/request": return rejectRuntimeBridgeCommand(frame.command);
		case "client-runtime/cancel":
		case "client-runtime/response-acknowledged": return;
		case "client-console/enable":
		case "client-console/disable": return rejectConsoleBridgeCommand(frame.t);
		case "client-sources/request": return rejectSourcesBridgeCommand();
		case "client-runtime/session-closed":
		case "client-sources/session-closed": return;
		default: return assertNever(frame);
	}
}
function assertNever(value) {
	throw new Error(`Unexpected Worker source frame: ${JSON.stringify(value)}`);
}
//#endregion
//#region lib/types/host/bridge/transport.js
/** Host-realm observation publisher over a dedicated MessagePort. */
/** Non-blocking Host source; queue overflow is represented by `droppedBefore` on the next batch. */
var HostInspectorSource = class extends InspectorSourceConnection {
	port;
	source;
	publisher;
	closed = false;
	queries;
	constructor(port, options) {
		super();
		this.port = port;
		this.source = createHostRealmSource(options.label);
		this.publisher = new HostBridgePublisher(port, this.source, options);
		this.queries = new HostBridgeRpc(port, {
			timeoutMs: options.queryTimeoutMs,
			maxFrameBytes: options.maxFrameBytes
		});
		port.on("message", (value) => {
			try {
				if (this.queries.receive(value)) return;
				this.receive(parseWorkerSourceFrame(value));
			} catch {
				this.close();
			}
		});
		port.on("close", () => {
			this.queries.disconnect("Inspector Host source disconnected");
		});
		port.start();
		const open = {
			v: 0,
			t: "source/open",
			source: this.source,
			topics: [...options.topics]
		};
		port.postMessage(open);
		this.publisher.replace();
	}
	/** Flush pending observations and close the source port. */
	close() {
		if (this.closed) return;
		this.publisher.close();
		this.closed = true;
		this.queries.close("Inspector Host source closed");
		const frame = {
			v: 0,
			t: "source/close",
			sourceId: this.source.sourceId,
			generation: this.source.generation
		};
		this.port.postMessage(frame);
		this.port.close();
	}
	receive(frame) {
		if (frame.t !== "source/rejected" && (frame.sourceId !== this.source.sourceId || frame.generation !== this.source.generation)) return;
		dispatchBridgeFrame(frame, {
			accepted: () => {
				this.queries.connectPort(this.source);
			},
			acknowledged: (acknowledged) => {
				this.publisher.acknowledge(acknowledged.nextSequence);
			},
			resnapshot: () => {
				this.publisher.replace();
			},
			rejected: (rejected) => {
				this.queries.disconnect(`Inspector Host source rejected: ${rejected.message}`);
			}
		});
	}
};
//#endregion
//#region lib/types/shared/bridge/control-codec.js
/** Exact decoders for Host, Worker, and injected Client lifecycle values. */
/**
* Decode one Worker-to-Host lifecycle event.
* @param value - Untrusted control message.
* @returns The validated Worker event.
*/
function parseInspectorWorkerControl(value) {
	const record = exactObjectByType(value, "Worker control message");
	switch (record.type) {
		case "ready":
			exactKeys(record, [
				"type",
				"host",
				"port",
				"targetId"
			], "Worker ready message");
			if (typeof record.host !== "string" || typeof record.targetId !== "string") throw new Error("inspector protocol: invalid Worker ready identity");
			return {
				type: "ready",
				host: record.host,
				port: natural$1(record.port, "port", true),
				targetId: record.targetId
			};
		case "failure":
			exactKeys(record, ["type", "message"], "Worker failure message");
			if (typeof record.message !== "string") throw new Error("inspector protocol: invalid Worker failure");
			return {
				type: "failure",
				message: record.message
			};
		case "stopped":
			exactKeys(record, ["type"], "Worker stopped message");
			return { type: "stopped" };
		default: throw new Error("inspector protocol: unknown Worker control message");
	}
}
function exactObjectByType(value, label) {
	if (!isPlainObject(value) || typeof value.type !== "string") throw new Error(`inspector protocol: ${label} must have a type`);
	return value;
}
function natural$1(value, label, zero = false) {
	if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new Error(`inspector protocol: ${label} must be ${zero ? "a non-negative" : "a positive"} safe integer`);
	return value;
}
//#endregion
//#region lib/types/host/bridge/lifecycle.js
/** Failure containment and shutdown coordination for the Inspector Worker. */
/** Tracks Worker termination without removing the listener that contains runtime errors. */
var InspectorWorkerLifecycle = class {
	worker;
	exitResolution = Promise.withResolvers();
	failureResolution = Promise.withResolvers();
	failure;
	running = false;
	expectedExit = false;
	notified = false;
	onUnexpectedExit;
	exitCodeValue;
	/** Worker exit code once its `exit` event has fired. */
	get exitCode() {
		return this.exitCodeValue;
	}
	constructor(worker) {
		this.worker = worker;
		worker.on("error", (error) => {
			this.failure ??= error;
			this.failureResolution.resolve(error);
			this.notifyUnexpectedExit();
		});
		worker.once("exit", (code) => {
			this.exitCodeValue = code;
			this.exitResolution.resolve(code);
			this.notifyUnexpectedExit();
		});
	}
	/**
	* Wait for the validated ready frame while also observing startup failure and exit.
	* @param timeoutMs - Readiness deadline in milliseconds.
	* @returns The Worker's bound endpoint fields.
	*/
	async waitForReady(timeoutMs) {
		let timer;
		let onMessage;
		const message = new Promise((resolve, reject) => {
			onMessage = (value) => {
				let control;
				try {
					control = parseInspectorWorkerControl(value);
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
					return;
				}
				if (control.type === "ready") resolve(control);
				else if (control.type === "failure") reject(/* @__PURE__ */ new Error(`inspector Worker failed: ${control.message}`));
			};
			timer = setTimeout(() => {
				reject(/* @__PURE__ */ new Error(`inspector Worker did not become ready within ${String(timeoutMs)}ms`));
			}, timeoutMs);
			this.worker.on("message", onMessage);
		});
		try {
			return await Promise.race([
				message,
				this.failureResolution.promise.then((error) => {
					throw error;
				}),
				this.exitResolution.promise.then((code) => {
					throw new Error(`inspector Worker exited before readiness (code ${String(code)})`);
				})
			]);
		} finally {
			if (timer !== void 0) clearTimeout(timer);
			if (onMessage !== void 0) this.worker.off("message", onMessage);
		}
	}
	/**
	* Begin reporting an unexpected runtime exit through one contained callback.
	* @param listener - Failure observer that must not throw.
	*/
	markRunning(listener) {
		this.running = true;
		this.onUnexpectedExit = listener;
		this.notifyUnexpectedExit();
	}
	/** Mark subsequent Worker termination as owner-requested. */
	expectExit() {
		this.expectedExit = true;
	}
	/** Terminate the Worker during failed initialization. */
	async terminate() {
		this.expectExit();
		if (this.exitCodeValue === void 0) await this.worker.terminate();
	}
	/**
	* Request graceful shutdown and terminate after the deadline.
	* @param timeoutMs - Grace period before forced termination.
	*/
	async stop(timeoutMs) {
		this.expectExit();
		if (this.exitCodeValue !== void 0) return;
		this.worker.postMessage({ type: "shutdown" });
		let timer;
		const timeout = new Promise((resolve) => {
			timer = setTimeout(() => {
				resolve("timeout");
			}, timeoutMs);
		});
		const outcome = await Promise.race([this.exitResolution.promise.then(() => "exited"), timeout]);
		if (timer !== void 0) clearTimeout(timer);
		if (outcome === "exited") return;
		await this.worker.terminate();
		throw new Error(`inspector Worker did not stop within ${String(timeoutMs)}ms and was terminated`);
	}
	notifyUnexpectedExit() {
		if (!this.running || this.expectedExit || this.notified || this.exitCodeValue === void 0) return;
		this.notified = true;
		this.onUnexpectedExit?.(this.failure ?? /* @__PURE__ */ new Error(`inspector Worker exited unexpectedly with code ${String(this.exitCodeValue)}`));
	}
};
//#endregion
//#region lib/types/host/bridge/controller.js
/** Host controller that owns the Inspector Worker and Host observation source. */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_BODY_CHUNK_BYTES = 48 * 1024;
const DEFAULT_MAX_JOURNAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_RETAINED_REQUESTS = 2e3;
const DEFAULT_MAX_SOURCE_FRAME_BYTES = 128 * 1024;
const DEFAULT_MAX_SOURCE_RECORDS_PER_FRAME = 128;
const DEFAULT_MAX_QUEUED_RECORDS = 2048;
const DEFAULT_MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 1e4;
const DEFAULT_STOP_TIMEOUT_MS = 5e3;
const DEFAULT_CLIENT_RECONNECT_BASE_MS = 250;
const DEFAULT_CLIENT_RECONNECT_MAX_MS = 5e3;
const DEFAULT_CLIENT_RUNTIME_TIMEOUT_MS = 3e4;
const DEFAULT_QUERY_TIMEOUT_MS = 1e4;
const DEFAULT_MAX_CLIENT_RUNTIME_OBJECTS = 1e4;
const DEFAULT_MAX_CLIENT_RUNTIME_PROPERTIES = 2e3;
const DEFAULT_MAX_CLIENT_SOURCE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CORDIS_NODES = 2048;
const DEFAULT_MAX_DISCONNECTED_CORDIS_TREES = 8;
/**
* Resolve and validate all deployment-varying Inspector choices.
* @param options - Partial caller configuration.
* @returns A complete immutable configuration.
*/
function resolveInspectorOptions(options = {}) {
	const spec = {
		host: options.host ?? "127.0.0.1",
		port: natural(options.port ?? 0, "port", true),
		clientOrigins: [...options.clientOrigins ?? []],
		captureFetch: options.captureFetch ?? true,
		maxRequestBodyBytes: natural(options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES, "maxRequestBodyBytes"),
		maxResponseBodyBytes: natural(options.maxResponseBodyBytes ?? DEFAULT_MAX_RESPONSE_BODY_BYTES, "maxResponseBodyBytes"),
		maxBodyChunkBytes: natural(options.maxBodyChunkBytes ?? DEFAULT_MAX_BODY_CHUNK_BYTES, "maxBodyChunkBytes"),
		maxJournalBytes: natural(options.maxJournalBytes ?? DEFAULT_MAX_JOURNAL_BYTES, "maxJournalBytes"),
		maxRetainedRequests: natural(options.maxRetainedRequests ?? DEFAULT_MAX_RETAINED_REQUESTS, "maxRetainedRequests"),
		maxSourceFrameBytes: natural(options.maxSourceFrameBytes ?? DEFAULT_MAX_SOURCE_FRAME_BYTES, "maxSourceFrameBytes"),
		maxSourceRecordsPerFrame: natural(options.maxSourceRecordsPerFrame ?? DEFAULT_MAX_SOURCE_RECORDS_PER_FRAME, "maxSourceRecordsPerFrame"),
		maxQueuedRecords: natural(options.maxQueuedRecords ?? DEFAULT_MAX_QUEUED_RECORDS, "maxQueuedRecords"),
		maxQueuedBytes: natural(options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES, "maxQueuedBytes"),
		startupTimeoutMs: natural(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, "startupTimeoutMs"),
		stopTimeoutMs: natural(options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS, "stopTimeoutMs"),
		clientReconnectBaseMs: natural(options.clientReconnectBaseMs ?? DEFAULT_CLIENT_RECONNECT_BASE_MS, "clientReconnectBaseMs"),
		clientReconnectMaxMs: natural(options.clientReconnectMaxMs ?? DEFAULT_CLIENT_RECONNECT_MAX_MS, "clientReconnectMaxMs"),
		clientRuntimeTimeoutMs: natural(options.clientRuntimeTimeoutMs ?? DEFAULT_CLIENT_RUNTIME_TIMEOUT_MS, "clientRuntimeTimeoutMs"),
		queryTimeoutMs: natural(options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS, "queryTimeoutMs"),
		maxClientRuntimeObjects: natural(options.maxClientRuntimeObjects ?? DEFAULT_MAX_CLIENT_RUNTIME_OBJECTS, "maxClientRuntimeObjects"),
		maxClientRuntimeProperties: natural(options.maxClientRuntimeProperties ?? DEFAULT_MAX_CLIENT_RUNTIME_PROPERTIES, "maxClientRuntimeProperties"),
		maxClientSourceBytes: natural(options.maxClientSourceBytes ?? DEFAULT_MAX_CLIENT_SOURCE_BYTES, "maxClientSourceBytes"),
		maxCordisNodes: natural(options.maxCordisNodes ?? DEFAULT_MAX_CORDIS_NODES, "maxCordisNodes"),
		maxDisconnectedCordisTrees: natural(options.maxDisconnectedCordisTrees ?? DEFAULT_MAX_DISCONNECTED_CORDIS_TREES, "maxDisconnectedCordisTrees", true)
	};
	if (spec.port > 65535) throw new Error("inspector: port must not exceed 65535");
	if (Math.ceil(spec.maxBodyChunkBytes / 3) * 4 + 4096 > spec.maxSourceFrameBytes) throw new Error("inspector: maxSourceFrameBytes cannot carry one base64 body chunk");
	if (spec.clientReconnectMaxMs < spec.clientReconnectBaseMs) throw new Error("inspector: clientReconnectMaxMs must be at least clientReconnectBaseMs");
	for (const origin of spec.clientOrigins) if (new URL(origin).origin !== origin) throw new Error(`inspector: client origin must be canonical: ${origin}`);
	return spec;
}
/**
* Start the Worker, create the Host source, and install full fetch capture by default.
* @param options - Partial caller configuration.
* @returns The ready endpoint and its quiescent shutdown handle.
*/
async function startInspector(options = {}) {
	const spec = resolveInspectorOptions(options);
	const channel = new MessageChannel();
	const clientProtocol = `dsh-inspector-v${String(0)}-${randomBytes(32).toString("base64url")}`;
	const lifecycle = new InspectorWorkerLifecycle(spawnWorker({
		config: {
			host: spec.host,
			startPort: spec.port,
			targetId: randomUUID(),
			clientToken: clientProtocol,
			clientOrigins: spec.clientOrigins,
			maxSourceFrameBytes: spec.maxSourceFrameBytes,
			maxSourceRecordsPerFrame: spec.maxSourceRecordsPerFrame,
			maxRetainedRequests: spec.maxRetainedRequests,
			maxJournalBytes: spec.maxJournalBytes,
			clientRuntimeTimeoutMs: spec.clientRuntimeTimeoutMs,
			maxClientSourceBytes: spec.maxClientSourceBytes,
			maxCordisNodes: spec.maxCordisNodes,
			maxDisconnectedCordisTrees: spec.maxDisconnectedCordisTrees
		},
		hostSourcePort: channel.port2
	}));
	let source;
	try {
		source = new HostInspectorSource(channel.port1, {
			label: "Host",
			topics: ["*", ...NETWORK_TOPICS],
			maxQueuedRecords: spec.maxQueuedRecords,
			maxQueuedBytes: spec.maxQueuedBytes,
			maxRecordsPerFrame: spec.maxSourceRecordsPerFrame,
			maxFrameBytes: spec.maxSourceFrameBytes,
			queryTimeoutMs: spec.queryTimeoutMs
		});
	} catch (error) {
		channel.port1.close();
		await lifecycle.terminate();
		throw error;
	}
	const ready = await lifecycle.waitForReady(spec.startupTimeoutMs).catch(async (error) => {
		source.close();
		await lifecycle.terminate();
		throw error;
	});
	const authority = `${ready.host}:${String(ready.port)}`;
	const endpoint = {
		httpUrl: `http://${authority}/`,
		webSocketDebuggerUrl: `ws://${authority}/devtools/page/${ready.targetId}`,
		devtoolsFrontendUrl: `devtools://devtools/bundled/devtools_app.html?ws=${authority}/devtools/page/${ready.targetId}&panel=elements&noJavaScriptCompletion=true`,
		client: {
			endpoint: `ws://${authority}/ingest`,
			protocol: clientProtocol,
			maxQueuedRecords: spec.maxQueuedRecords,
			maxQueuedBytes: spec.maxQueuedBytes,
			maxRecordsPerFrame: spec.maxSourceRecordsPerFrame,
			maxFrameBytes: spec.maxSourceFrameBytes,
			reconnectBaseMs: spec.clientReconnectBaseMs,
			reconnectMaxMs: spec.clientReconnectMaxMs,
			queryTimeoutMs: spec.queryTimeoutMs,
			maxRuntimeObjectsPerSession: spec.maxClientRuntimeObjects,
			maxRuntimePropertiesPerResult: spec.maxClientRuntimeProperties,
			maxClientSourceBytes: spec.maxClientSourceBytes,
			maxCordisNodes: spec.maxCordisNodes
		}
	};
	let fetchObserver;
	try {
		fetchObserver = spec.captureFetch ? installFetchObserver(source, {
			maxRequestBodyBytes: spec.maxRequestBodyBytes,
			maxResponseBodyBytes: spec.maxResponseBodyBytes,
			maxChunkBytes: spec.maxBodyChunkBytes
		}) : void 0;
	} catch (error) {
		source.close();
		await lifecycle.terminate();
		throw error;
	}
	lifecycle.markRunning((error) => {
		try {
			source.close();
		} catch (closeError) {
			console.error("dsh inspector: Host source cleanup after Worker failure failed", closeError);
		}
		fetchObserver?.stop().catch((stopError) => {
			console.error("dsh inspector: fetch cleanup after Worker failure failed", stopError);
		});
		console.error("dsh inspector: Worker stopped unexpectedly", error);
	});
	let closing;
	return {
		endpoint,
		source,
		close() {
			closing ??= closeInspector(lifecycle, source, fetchObserver, spec.stopTimeoutMs);
			return closing;
		}
	};
}
function spawnWorker(boot) {
	const options = {
		workerData: boot,
		transferList: [boot.hostSourcePort],
		execArgv: []
	};
	if (!import.meta.url.endsWith(".ts")) return new Worker(new URL("./worker.js", import.meta.url), options);
	const workerEntry = new URL("../../worker/entry.ts", import.meta.url);
	const tsxEsmApiEntry = import.meta.resolve("tsx/esm/api");
	const bootstrap = [
		`import { register } from ${JSON.stringify(tsxEsmApiEntry)}`,
		"register()",
		`await import(${JSON.stringify(workerEntry.href)})`
	].join("\n");
	return new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), {
		...options,
		env: sourceWorkerEnv()
	});
}
function sourceWorkerEnv() {
	const env = {};
	if (process.platform === "win32") {
		env.TMP = tmpdir();
		env.TEMP = tmpdir();
	}
	if (process.env.TSX_TSCONFIG_PATH !== void 0) env.TSX_TSCONFIG_PATH = process.env.TSX_TSCONFIG_PATH;
	return env;
}
async function closeInspector(lifecycle, source, fetchObserver, timeoutMs) {
	const failures = [];
	try {
		await fetchObserver?.stop();
	} catch (error) {
		failures.push(error);
	}
	try {
		source.close();
	} catch (error) {
		failures.push(error);
	}
	try {
		await lifecycle.stop(timeoutMs);
	} catch (error) {
		failures.push(error);
	}
	if (failures.length > 0) throw new AggregateError(failures, "inspector: shutdown failed");
}
function natural(value, name, zero = false) {
	if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new Error(`inspector: ${name} must be ${zero ? "a non-negative" : "a positive"} safe integer`);
	return value;
}
//#endregion
//#region lib/types/shared/bridge/query-reader.js
/** Query-backed adapter for the transport-independent Cordis tree reader. */
/**
* Create a reader that obtains the tree through the typed Inspector query protocol.
* @param requester - Active Host or Client query connection.
* @returns A non-CDP Cordis tree reader.
*/
function createQueryCordisRuntimeTreeReader(requester) {
	return { async getTree() {
		return (await requester.request({ op: "cordis-tree/get" })).tree;
	} };
}
//#endregion
//#region lib/types/shared/service.js
/** Cordis service API shared by the Host and Client plugin faces. */
/**
* Create the shared service façade without exposing the carrier implementation.
* @param connection - Realm-local observation and query transport.
* @returns The Cordis service value.
*/
function createInspectorService(connection) {
	return {
		publish: (topic, payload, monotonicMs) => {
			connection.publish(topic, payload, monotonicMs);
		},
		cordis: createQueryCordisRuntimeTreeReader(connection)
	};
}
//#endregion
//#region lib/types/shared/bridge/messages/cordis.js
/** Bridge message metadata for Cordis runtime-tree snapshots. */
/** Observation topic carrying the latest complete Cordis tree. */
const CORDIS_TREE_TOPIC = "cordis/tree";
//#endregion
//#region lib/types/shared/cordis/object-registry.js
/** Realm-local retention and identity for live objects referenced by Inspector snapshots. */
const REGISTRIES_SYMBOL = "dsh.inspector.realm-object-registries";
const MAX_FIBER_WRAPPER_DEPTH = 8;
`${JSON.stringify(REGISTRIES_SYMBOL)}`;
/** One realm's bounded table of objects retained by its latest semantic snapshot. */
var RealmObjectRegistry = class {
	/** Realm-unique id carried by every reference from this registry. */
	id = inspectorId(randomUUID$1(), "registryId");
	known = /* @__PURE__ */ new WeakMap();
	retained = /* @__PURE__ */ new Map();
	nextHandle = 1;
	disposed = false;
	constructor() {
		registries().set(this.id, this);
	}
	/**
	* Start one replacement generation.
	* @returns A collector that atomically installs exactly the retained objects on commit.
	*/
	begin() {
		if (this.disposed) throw new Error("inspector: realm object registry is disposed");
		return new RealmObjectGeneration(this);
	}
	/**
	* Resolve one current opaque handle.
	* @param handle - Handle from the latest committed snapshot.
	* @returns The live object, when it remains retained.
	*/
	resolve(handle) {
		return this.retained.get(handle);
	}
	/**
	* Identify one object retained by the latest snapshot. Cordis plugin calls may return nested thenable facades;
	* only objects whose prototype path consists exclusively of those `then` wrappers resolve to the retained Fiber.
	* @param value - Candidate live value.
	* @returns Its wire reference, when present in this registry.
	*/
	identify(value) {
		if ((typeof value !== "object" || value === null) && typeof value !== "function") return void 0;
		let candidate = value;
		for (let depth = 0; candidate !== null && depth <= MAX_FIBER_WRAPPER_DEPTH; depth++) {
			const handle = this.known.get(candidate);
			if (handle !== void 0 && this.retained.get(handle) === candidate) return {
				registryId: this.id,
				handle
			};
			try {
				const keys = Reflect.ownKeys(candidate);
				if (keys.length !== 1 || keys[0] !== "then") return void 0;
				candidate = Object.getPrototypeOf(candidate);
			} catch {
				return;
			}
		}
	}
	/** Remove this registry from the realm and release all strong references. */
	close() {
		if (this.disposed) return;
		this.disposed = true;
		registries().delete(this.id);
		this.retained.clear();
	}
	/**
	* Assign a stable handle and retain a value in one pending generation.
	* @param value - Object represented by the pending snapshot.
	* @param next - Pending generation's strong-reference table.
	* @returns The registry id and stable object handle.
	*/
	retain(value, next) {
		let handle = this.known.get(value);
		if (handle === void 0) {
			handle = inspectorId(`object-${String(this.nextHandle++)}`, "objectHandle");
			this.known.set(value, handle);
		}
		next.set(handle, value);
		return {
			registryId: this.id,
			handle
		};
	}
	/**
	* Replace the current strong-reference set with one completed generation.
	* @param next - Complete object table for the committed snapshot.
	*/
	commit(next) {
		this.retained = next;
	}
};
/** Mutable object set assembled before one snapshot becomes visible. */
var RealmObjectGeneration = class {
	owner;
	retained = /* @__PURE__ */ new Map();
	committed = false;
	constructor(owner) {
		this.owner = owner;
	}
	/**
	* Retain one object and obtain its stable opaque reference.
	* @param value - Context or Fiber represented in the snapshot.
	* @returns Source-local wire reference.
	*/
	retain(value) {
		if (this.committed) throw new Error("inspector: realm object generation is already committed");
		return this.owner.retain(value, this.retained);
	}
	/**
	* Stop retaining an object omitted while bounding the pending snapshot.
	* @param handle - Opaque handle removed from this pending generation.
	*/
	release(handle) {
		if (this.committed) throw new Error("inspector: realm object generation is already committed");
		this.retained.delete(handle);
	}
	/** Atomically replace the registry's retained set. */
	commit() {
		if (this.committed) return;
		this.committed = true;
		this.owner.commit(this.retained);
	}
};
function registries() {
	const key = Symbol.for(REGISTRIES_SYMBOL);
	const existing = Reflect.get(globalThis, key);
	if (existing instanceof Map) return existing;
	const value = /* @__PURE__ */ new Map();
	Reflect.set(globalThis, key, value);
	return value;
}
//#endregion
//#region lib/types/shared/cordis/collector.js
/** Shared Host/Client projection from live Cordis objects to a bounded semantic tree. */
const SHADOW = Symbol.for("cordis.shadow");
/** Realm-local collector retaining Contexts without Cordis service-call shadow wrappers. */
var CordisTreeCollector = class {
	root;
	limits;
	/** Live-object table replaced atomically with each emitted snapshot. */
	objects = new RealmObjectRegistry();
	revision = 0;
	constructor(root, limits) {
		this.root = root;
		this.limits = limits;
	}
	/**
	* Capture the current reachable Context/Fiber tree.
	* @returns A detached JSON snapshot whose retained objects replace the prior generation atomically.
	*/
	snapshot() {
		const collected = collectContexts(this.root);
		const tree = collected.root;
		const objects = this.objects.begin();
		let nodeCount = 0;
		let truncated = collected.truncated;
		const contextNode = (info) => {
			if (nodeCount >= this.limits.maxNodes) {
				truncated = true;
				return;
			}
			nodeCount++;
			const node = {
				kind: "context",
				objectHandle: objects.retain(info.value).handle,
				children: []
			};
			for (const child of info.children) if (child.fiber !== void 0 && unwrapContext(child.fiber.ctx) === child.value) {
				const projected = fiberNode(child.fiber, child);
				if (projected !== void 0) node.children.push(projected);
			} else {
				const projected = contextNode(child);
				if (projected !== void 0) node.children.push(projected);
			}
			return node;
		};
		const fiberNode = (fiber, owned) => {
			if (fiber.uid === null) return void 0;
			if (nodeCount + 2 > this.limits.maxNodes) {
				truncated = true;
				return;
			}
			nodeCount++;
			const context = contextNode(owned);
			return {
				kind: "fiber",
				objectHandle: objects.retain(fiber).handle,
				uid: fiber.uid,
				children: [context]
			};
		};
		const root = contextNode(tree);
		if (root === void 0) throw new Error("inspector: maxNodes cannot retain the root Context");
		let snapshot = {
			schemaVersion: 0,
			revision: ++this.revision,
			objectRegistryId: this.objects.id,
			root,
			truncated
		};
		while (jsonByteLength(snapshot) > this.limits.maxBytes) {
			const removed = pruneLast(root);
			if (removed.length === 0) break;
			for (const handle of removed) objects.release(handle);
			snapshot = {
				...snapshot,
				truncated: true
			};
		}
		if (jsonByteLength(snapshot) > this.limits.maxBytes) throw new Error("inspector: Cordis root exceeds the source-frame byte limit");
		objects.commit();
		return snapshot;
	}
	/** Release the realm-global resolver and every retained object. */
	close() {
		this.objects.close();
	}
};
function collectContexts(root) {
	const contexts = /* @__PURE__ */ new Map();
	let truncated = false;
	const ensure = (candidate, depth = 0) => {
		if (depth > 100) {
			truncated = true;
			return;
		}
		const value = unwrapContext(candidate);
		if (!Context.is(value)) return void 0;
		const existing = contexts.get(value);
		if (existing !== void 0) return existing;
		if (value === root) {
			const info = describeContext(value);
			contexts.set(value, info);
			return info;
		}
		const parent = ensure(unwrapContext(Object.getPrototypeOf(value)), depth + 1);
		if (parent === void 0) return void 0;
		const info = describeContext(value);
		contexts.set(value, info);
		parent.children.push(info);
		return info;
	};
	const rootInfo = ensure(root);
	for (const runtime of root.registry.values()) for (const fiber of runtime.fibers) {
		if (fiber.uid === null) continue;
		ensure(fiber.parent);
		ensure(fiber.ctx);
	}
	for (const key of Reflect.ownKeys(root.events._hooks)) for (const hook of root.events._hooks[key] ?? []) ensure(hook.ctx);
	const order = (info) => info.fiber?.uid ?? Number.MAX_SAFE_INTEGER;
	for (const info of contexts.values()) info.children.sort((left, right) => order(left) - order(right));
	return {
		root: rootInfo,
		truncated
	};
}
function describeContext(value) {
	return {
		value,
		children: [],
		fiber: ownValue(value, "fiber")
	};
}
function ownValue(value, key) {
	return Reflect.getOwnPropertyDescriptor(value, key)?.value;
}
function unwrapContext(value) {
	let current = value;
	while (typeof current === "object" && current !== null && Object.hasOwn(current, SHADOW)) current = Object.getPrototypeOf(current);
	return current;
}
function pruneLast(context) {
	const child = context.children.at(-1);
	if (child === void 0) return [];
	if (child.kind === "context") {
		const nested = pruneLast(child);
		if (nested.length > 0) return nested;
		context.children.pop();
		return [child.objectHandle];
	}
	const owned = child.children[0];
	const nested = pruneLast(owned);
	if (nested.length > 0) return nested;
	context.children.pop();
	return [child.objectHandle, owned.objectHandle];
}
//#endregion
//#region lib/types/shared/cordis/observer.js
/** Lifecycle-driven Cordis tree publication shared by Host and Client plugin faces. */
/**
* Observe one Cordis realm and publish immutable tree replacements.
* @param ctx - Plugin context whose root is inspected and whose effects own listeners.
* @param listener - Consumer of complete snapshots in the inspected realm.
* @param limits - Snapshot node and encoded-byte limits.
* @returns A disposer that unregisters listeners and releases retained objects.
*/
function observeCordisTree(ctx, listener, limits) {
	const collector = new CordisTreeCollector(ctx.root, limits);
	let scheduled = false;
	let closed = false;
	const publish = () => {
		scheduled = false;
		if (closed) return;
		listener(collector.snapshot());
	};
	const schedule = () => {
		if (scheduled || closed) return;
		scheduled = true;
		queueMicrotask(publish);
	};
	const disposers = [ctx.on("internal/plugin", schedule, { global: true }), ctx.on("internal/status", schedule, { global: true })];
	publish();
	return () => {
		if (closed) return;
		closed = true;
		for (const dispose of disposers) dispose();
		collector.close();
	};
}
//#endregion
//#region lib/types/shared/cordis/publisher.js
/** Shared Host/Client publication of browser-safe Cordis snapshots. */
/**
* Observe one Cordis runtime and retain its latest source snapshot.
* @param ctx - Plugin context whose root is inspected.
* @param publisher - Active Host or Client source publisher.
* @param limits - Snapshot node and encoded-byte limits.
* @returns A disposer that stops observation and releases retained objects.
*/
function publishCordisTree(ctx, publisher, limits) {
	return observeCordisTree(ctx, (snapshot) => {
		publisher.setState(CORDIS_TREE_TOPIC, snapshot);
	}, limits);
}
//#endregion
//#region lib/types/shared/web.js
/** Authenticated browser bootstrap route; the debugging URL stays on the Host. */
/** Read the current browser-source connection parameters. */
const INSPECTOR_BOOTSTRAP_PATH = "/api/experimental-inspector/bootstrap";
INSPECTOR_BOOTSTRAP_PATH.slice(1);
/** Query parameter selecting the Client visible beside Host in one DevTools connection. */
const INSPECTOR_CLIENT_QUERY = "clientSourceId";
/**
* Read an optional Client selection from a DevTools WebSocket URL.
* @param url - Untrusted upgrade URL.
* @returns The selected logical Client id, or undefined for all Clients.
* @throws If the selection is repeated or is not a valid source id.
*/
function readInspectorClientSelection(url) {
	const values = url.searchParams.getAll(INSPECTOR_CLIENT_QUERY);
	const selected = values[0];
	if (selected === void 0) return void 0;
	if (values.length !== 1) throw new Error("Inspector Client selection must occur once");
	return inspectorId(selected, INSPECTOR_CLIENT_QUERY);
}
//#endregion
//#region lib/types/shared/dispose.js
/** Ordered release of Inspector registrations before their source transport closes. */
/**
* Join every registration disposer in reverse order, then close the source even after failures.
* @param disposers - Registrations in acquisition order.
* @param close - Final transport teardown.
* @param message - Aggregate failure diagnostic owned by the Host or Client caller.
* @returns Completion after all cleanup actions have settled.
* @throws AggregateError containing every failed cleanup action in release order.
*/
async function disposeInspectorResources(disposers, close, message) {
	const failures = [];
	for (const dispose of [...disposers].reverse().concat(close)) try {
		await dispose();
	} catch (error) {
		failures.push(error);
	}
	if (failures.length > 0) throw new AggregateError(failures, message);
}
//#endregion
//#region lib/types/host/plugin.js
/** Host Cordis plugin for the cross-realm Inspector Worker and full fetch capture. */
const DEVTOOLS_PATH = "/inspector/devtools";
/** Node's standard code for a feature the running platform cannot provide, such as `worker_threads` in a browser Worker host. */
const FEATURE_UNAVAILABLE_ON_PLATFORM = "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM";
/**
* Start the Worker, expose `ctx.inspector`, and inject the matching Client bootstrap.
* The bootstrap route exists before the Worker is ready, so a Client published during startup waits instead of failing.
* When the platform cannot run the Worker (`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`), the plugin warns once and stays active
* with only that route, which answers 503; every other startup failure rolls back and rejects the fiber.
*/
async function apply$1(ctx, config) {
	await ctx.effect(async () => {
		const spec = resolveInspectorOptions(config);
		const ready = Promise.withResolvers();
		const disposers = [];
		let worker;
		const dispose = () => disposeInspectorResources(disposers, () => worker?.close(), "experimental-inspector: disposal failed");
		try {
			disposers.push(ctx.connection.fetch.register({
				path: INSPECTOR_BOOTSTRAP_PATH,
				methods: ["GET"],
				requestBody: "buffered",
				fetch: (request) => bootstrapResponse(ready.promise, request.signal)
			}));
			const handle = await startInspector(spec).catch((error) => {
				if (!isUnavailableOnPlatform(error)) throw error;
				ctx.logger.warn("experimental-inspector: NodeJS Inspector is unavailable on this platform; Host inspection stays disabled", error);
			});
			if (handle === void 0) {
				ready.resolve(void 0);
				return dispose;
			}
			worker = handle;
			const { default: serveStatic } = await import("serve-static");
			disposers.push(publishCordisTree(ctx, handle.source, {
				maxNodes: spec.maxCordisNodes,
				maxBytes: spec.maxSourceFrameBytes - 4096
			}));
			disposers.push(ctx.provide("inspector", createInspectorService(handle.source)));
			disposers.push(ctx.on("webserver/index-inject", (table) => {
				table.push({
					kind: "global",
					name: "__DSH_INSPECTOR__",
					value: handle.endpoint.client
				});
			}));
			const assets = serveStatic(fileURLToPath(new URL("./lib/devtools/", import.meta.resolve("@deepseek-ai/dsh-experimental-inspector/package.json"))), {
				index: false,
				redirect: false,
				fallthrough: true,
				setHeaders: (res) => {
					res.setHeader("X-Content-Type-Options", "nosniff");
				}
			});
			disposers.push(ctx.webServer.register({
				kind: "prefix",
				path: DEVTOOLS_PATH,
				handler: (req, res) => {
					if (req.method !== "GET" && req.method !== "HEAD") {
						res.writeHead(405, { allow: "GET, HEAD" }).end();
						return;
					}
					if (!ctx.connection.authorizeIndex(req, res)) return;
					const url = new URL(req.url ?? "/", "http://inspector.invalid");
					if (url.pathname === DEVTOOLS_PATH || url.pathname === `${DEVTOOLS_PATH}/`) {
						const location = `${url.pathname === DEVTOOLS_PATH ? "devtools/" : ""}devtools_app.html${url.search}`;
						res.writeHead(302, { location }).end();
						return;
					}
					req.url = `${url.pathname.slice(19)}${url.search}`;
					assets(req, res, (error) => {
						if (error !== void 0) {
							ctx.logger.warn("experimental-inspector: frontend asset request failed", error);
							if (res.headersSent) res.destroy();
							else res.writeHead(500).end();
						} else res.writeHead(404).end();
					});
				}
			}));
			const sockets = /* @__PURE__ */ new Set();
			const track = (socket) => {
				sockets.add(socket);
				socket.once("close", () => {
					sockets.delete(socket);
				});
			};
			disposers.push(async () => {
				await Promise.all([...sockets].map((socket) => new Promise((resolve) => {
					socket.once("close", resolve);
					socket.destroy();
				})));
			});
			const target = new URL(handle.endpoint.webSocketDebuggerUrl);
			disposers.push(ctx.webServer.registerUpgrade({
				path: `${DEVTOOLS_PATH}/cdp`,
				handler: (req, socket, head) => {
					const rejection = ctx.connection.requestRejection(req);
					if (rejection !== void 0) {
						const reason = rejection === 401 ? "Unauthorized" : "Forbidden";
						socket.end(`HTTP/1.1 ${rejection} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
						return;
					}
					const endpoint = new URL(target);
					try {
						const selected = readInspectorClientSelection(new URL(req.url ?? "/", "http://inspector.invalid"));
						if (selected !== void 0) endpoint.searchParams.set(INSPECTOR_CLIENT_QUERY, selected);
					} catch (error) {
						socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
						return;
					}
					const upstream = connect(Number(target.port), target.hostname);
					track(socket);
					track(upstream);
					upstream.once("connect", () => {
						upstream.write(`GET ${endpoint.pathname}${endpoint.search} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`);
						for (const [key, value] of Object.entries(req.headers)) if (key.startsWith("sec-websocket-") && value !== void 0) upstream.write(`${key}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`);
						upstream.write("\r\n");
						if (head.length > 0) upstream.write(head);
						socket.pipe(upstream).pipe(socket);
					});
					upstream.once("error", () => {
						socket.destroy();
					});
					socket.once("error", () => {
						upstream.destroy();
					});
					upstream.once("close", () => {
						socket.destroy();
					});
					socket.once("close", () => {
						upstream.destroy();
					});
				}
			}));
			console.log(`dsh inspector: ${handle.endpoint.devtoolsFrontendUrl}`);
			ready.resolve(handle.endpoint.client);
			if (ctx.get("cmdlineArgs")?.get().includes("--inspect")) {
				const { default: open, apps } = await import("open");
				await open(handle.endpoint.devtoolsFrontendUrl, {
					app: { name: apps.chrome },
					wait: false
				}).catch((error) => {
					ctx.logger.error("experimental-inspector: Chrome could not open DevTools", error);
				});
			}
		} catch (error) {
			ready.resolve(void 0);
			await dispose().catch((cleanupError) => {
				ctx.logger.error("experimental-inspector: initialization rollback failed", cleanupError);
			});
			throw error;
		}
		return dispose;
	}, "experimental-inspector: Host Worker");
}
/**
* Report whether a Worker startup failure means this platform cannot run the Inspector at all.
* @param error - Rejection from {@link startInspector}.
* @returns True only for Node's `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` code; messages are never inspected.
*/
function isUnavailableOnPlatform(error) {
	return error instanceof Error && "code" in error && error.code === FEATURE_UNAVAILABLE_ON_PLATFORM;
}
/**
* Answer one bootstrap request once Host initialization settles or the browser abandons the request.
* @param ready - Resolves with the Client bootstrap, or with undefined after initialization failed or found the platform unavailable.
* @param signal - Request signal; an aborted request stops waiting and receives no endpoint.
* @returns The bootstrap JSON, or 503 when the Inspector is unavailable or the request was aborted.
*/
async function bootstrapResponse(ready, signal) {
	const headers = { "cache-control": "no-store" };
	const abandoned = Promise.withResolvers();
	const abandon = () => {
		abandoned.resolve(void 0);
	};
	if (signal.aborted) abandon();
	else signal.addEventListener("abort", abandon, { once: true });
	try {
		const client = await Promise.race([ready, abandoned.promise]);
		return client === void 0 ? new Response(null, {
			status: 503,
			headers
		}) : Response.json(client, { headers });
	} finally {
		signal.removeEventListener("abort", abandon);
	}
}
//#endregion
//#region lib/types/index.js
/** Repository-facing Host package entry over the mirrored implementation tree. */
/** Cordis plugin name shared with the Client face. */
const name = "experimental-inspector";
/** Web Host and authenticated browser bootstrap transport. */
const inject = ["webServer", "connection"];
const libraryDefaults = resolveInspectorOptions();
/** Runtime validation for {@link Config}. */
const Config = z.object({
	host: z.const("127.0.0.1").default("127.0.0.1"),
	port: z.natural().max(65535).default(9230),
	clientOrigins: z.array(z.string()).default([]),
	captureFetch: z.boolean().default(true),
	maxRequestBodyBytes: z.natural().min(1).default(libraryDefaults.maxRequestBodyBytes),
	maxResponseBodyBytes: z.natural().min(1).default(libraryDefaults.maxResponseBodyBytes),
	maxBodyChunkBytes: z.natural().min(1).default(libraryDefaults.maxBodyChunkBytes),
	maxJournalBytes: z.natural().min(1).default(libraryDefaults.maxJournalBytes),
	maxRetainedRequests: z.natural().min(1).default(libraryDefaults.maxRetainedRequests),
	maxSourceFrameBytes: z.natural().min(1).default(libraryDefaults.maxSourceFrameBytes),
	maxSourceRecordsPerFrame: z.natural().min(1).default(libraryDefaults.maxSourceRecordsPerFrame),
	maxQueuedRecords: z.natural().min(1).default(libraryDefaults.maxQueuedRecords),
	maxQueuedBytes: z.natural().min(1).default(libraryDefaults.maxQueuedBytes),
	startupTimeoutMs: z.natural().min(1).default(libraryDefaults.startupTimeoutMs),
	stopTimeoutMs: z.natural().min(1).default(libraryDefaults.stopTimeoutMs),
	clientReconnectBaseMs: z.natural().min(1).default(libraryDefaults.clientReconnectBaseMs),
	clientReconnectMaxMs: z.natural().min(1).default(libraryDefaults.clientReconnectMaxMs),
	clientRuntimeTimeoutMs: z.natural().min(1).default(libraryDefaults.clientRuntimeTimeoutMs),
	queryTimeoutMs: z.natural().min(1).default(libraryDefaults.queryTimeoutMs),
	maxClientRuntimeObjects: z.natural().min(1).default(libraryDefaults.maxClientRuntimeObjects),
	maxClientRuntimeProperties: z.natural().min(1).default(libraryDefaults.maxClientRuntimeProperties),
	maxClientSourceBytes: z.natural().min(1).default(libraryDefaults.maxClientSourceBytes),
	maxCordisNodes: z.natural().min(1).default(libraryDefaults.maxCordisNodes),
	maxDisconnectedCordisTrees: z.natural().default(libraryDefaults.maxDisconnectedCordisTrees)
});
/**
* Start inspection when enabled; the hidden --inspect flag also opens the Host debugging window.
* @param ctx - Host Cordis plugin context.
* @param config - Validated Inspector configuration.
*/
async function apply(ctx, config) {
	await apply$1(ctx, config);
}
//#endregion
export { Config, apply, inject, name, resolveInspectorOptions, startInspector };
