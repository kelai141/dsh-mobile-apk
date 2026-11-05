import { stripTypeScriptTypes } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, isAbsolute, resolve } from "node:path";
import { DUNDER_MEMBER, PORTABLE_RESERVED_WORDS, PtcRuntime, RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS } from "@deepseek-ai/dsh-ptc-runtime";
import { MAX_TIMER_DELAY_MS, clampTimeout } from "@deepseek-ai/dsh-timeout";
import { SandboxUnavailableError, classifyRunnerFailure, isRunnerSpawnFailure } from "@deepseek-ai/dsh-sandbox";
import { assertNever, snapshotJsonValue } from "@deepseek-ai/dsh-util-values";
import { Buffer as Buffer$1 } from "node:buffer";
import { fileURLToPath, pathToFileURL } from "node:url";
import z from "@deepseek-ai/schemastery";
//#region lib/types/json-wire.js
/**
* Lossless-JSON snapshots for the dependency-free source bootstrap closure.
* @module @deepseek-ai/dsh-ptc-runtime-node/json-wire
*/
const intrinsicFunctionToString = Reflect.get(Function.prototype, "toString");
const intrinsicReflectApply$1 = Reflect.get(Reflect, "apply");
const IntrinsicError = Error;
const IntrinsicSet = Set;
const intrinsicArrayIsArray$1 = Array.isArray;
const intrinsicArrayPrototype = Array.prototype;
const intrinsicNumberIsFinite = Number.isFinite;
const intrinsicNumberIsSafeInteger = Number.isSafeInteger;
const intrinsicObjectCreate$1 = Object.create;
const intrinsicObjectDefineProperty$1 = Object.defineProperty;
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicObjectHasOwn = Object.hasOwn;
const intrinsicObjectIs = Object.is;
const intrinsicObjectKeys$1 = Object.keys;
const intrinsicObjectPrototype = Object.prototype;
const intrinsicObjectPropertyIsEnumerable = Reflect.get(intrinsicObjectPrototype, "propertyIsEnumerable");
const intrinsicReflectOwnKeys = Reflect.ownKeys;
const intrinsicSetAdd = Reflect.get(Set.prototype, "add");
Reflect.get(Set.prototype, "delete");
const intrinsicSetHas = Reflect.get(Set.prototype, "has");
/** Build a data descriptor that cannot inherit model-defined accessor fields. */
function dataDescriptor$1(value) {
	const descriptor = intrinsicObjectCreate$1(null);
	descriptor.value = value;
	return descriptor;
}
/** Define an ordinary enumerable data slot without a prototype-bearing descriptor. */
function defineEnumerableDataProperty$1(target, key, value) {
	const descriptor = dataDescriptor$1(value);
	descriptor.enumerable = true;
	descriptor.configurable = true;
	descriptor.writable = true;
	intrinsicObjectDefineProperty$1(target, key, descriptor);
}
/** Append without consulting a model-mutated `Array.prototype`. */
function append$1(target, value) {
	defineEnumerableDataProperty$1(target, target.length, value);
}
/** Pop without consulting a model-mutated `Array.prototype`. */
function takeLast$1(target) {
	if (target.length === 0) return void 0;
	const index = target.length - 1;
	const value = target[index];
	intrinsicObjectDefineProperty$1(target, "length", dataDescriptor$1(index));
	return value;
}
/** Whether one captured-intrinsic Set contains a value. */
function setHas(target, value) {
	return intrinsicReflectApply$1(intrinsicSetHas, target, [value]);
}
/** Add to one captured-intrinsic Set. */
function setAdd(target, value) {
	intrinsicReflectApply$1(intrinsicSetAdd, target, [value]);
}
/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor(prototype, name) {
	const constructor = intrinsicObjectGetOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name && constructor.prototype === prototype && intrinsicReflectApply$1(intrinsicFunctionToString, constructor, []) === `function ${name}() { [native code] }`;
	} catch {
		return false;
	}
}
/** Whether a candidate is a foreign realm's intrinsic `Object.prototype`. */
function isForeignIntrinsicObjectPrototype(value) {
	return intrinsicObjectGetPrototypeOf(value) === null && hasIntrinsicConstructor(value, "Object");
}
/** Whether an array uses one realm's intrinsic `Array.prototype`, not a subclass or forged prototype. */
function hasPlainArrayPrototype(value) {
	const prototype = intrinsicObjectGetPrototypeOf(value);
	if (prototype === intrinsicArrayPrototype) return true;
	if (!intrinsicArrayIsArray$1(prototype) || !hasIntrinsicConstructor(prototype, "Array")) return false;
	const objectPrototype = intrinsicObjectGetPrototypeOf(prototype);
	return typeof objectPrototype === "object" && objectPrototype !== null && isForeignIntrinsicObjectPrototype(objectPrototype);
}
/** Whether an object is a plain or null-prototype record from any JavaScript realm. */
function hasPlainObjectPrototype(value) {
	const prototype = intrinsicObjectGetPrototypeOf(value);
	return prototype === null || prototype === intrinsicObjectPrototype || typeof prototype === "object" && isForeignIntrinsicObjectPrototype(prototype);
}
/** Return every JSON-visible object key, or reject own data JSON would discard. */
function enumerableStringKeys(value) {
	const keys = intrinsicReflectOwnKeys(value);
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index];
		if (typeof key !== "string" || !intrinsicReflectApply$1(intrinsicObjectPropertyIsEnumerable, value, [key])) return void 0;
	}
	return keys;
}
/**
* Flatten one validated JSON value for the process control channel.
* @param value - the lossless JSON value to transport.
* @returns a pre-order token stream whose own nesting is bounded.
*/
function encodePtcJsonWire(value) {
	const wire = [];
	const pending = [value];
	for (let current = takeLast$1(pending); current !== void 0; current = takeLast$1(pending)) {
		if (current === null || typeof current === "boolean" || typeof current === "number" || typeof current === "string") {
			append$1(wire, current);
			continue;
		}
		if (intrinsicArrayIsArray$1(current)) {
			append$1(wire, {
				kind: "array",
				length: current.length
			});
			for (let index = current.length - 1; index >= 0; index--) {
				const item = current[index];
				if (item === void 0) throw new IntrinsicError("cannot encode a sparse JSON array");
				append$1(pending, item);
			}
			continue;
		}
		const keys = intrinsicObjectKeys$1(current);
		append$1(wire, {
			kind: "object",
			keys
		});
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) throw new IntrinsicError("cannot encode a missing JSON object key");
			const item = current[key];
			if (item === void 0) throw new IntrinsicError("cannot encode an undefined JSON object property");
			append$1(pending, item);
		}
	}
	return wire;
}
/** Whether an array contains exactly its dense indexed slots and `length`. */
function isDenseArray(value) {
	if (!hasPlainArrayPrototype(value) || intrinsicReflectOwnKeys(value).length !== value.length + 1) return false;
	for (let index = 0; index < value.length; index++) if (!intrinsicObjectHasOwn(value, index)) return false;
	return true;
}
/** Whether one exact string-key list contains a key, without consulting its prototype. */
function keysContain(keys, expected) {
	for (let index = 0; index < keys.length; index++) if (keys[index] === expected) return true;
	return false;
}
/** Return one exact container marker, or reject any extra/missing fields. */
function containerToken(value) {
	if (intrinsicArrayIsArray$1(value) || !hasPlainObjectPrototype(value)) return void 0;
	const keys = enumerableStringKeys(value);
	if (keys === void 0) return void 0;
	const token = value;
	if (token.kind === "array") {
		if (keys.length !== 2 || !keysContain(keys, "kind") || !keysContain(keys, "length")) return void 0;
		const length = token.length;
		return typeof length === "number" && intrinsicNumberIsSafeInteger(length) && length >= 0 ? {
			kind: "array",
			length
		} : void 0;
	}
	if (token.kind === "object") {
		if (keys.length !== 2 || !keysContain(keys, "kind") || !keysContain(keys, "keys")) return void 0;
		const objectKeys = token.keys;
		if (!intrinsicArrayIsArray$1(objectKeys) || !isDenseArray(objectKeys)) return void 0;
		const unique = new IntrinsicSet();
		const normalizedKeys = [];
		const objectKeyValues = objectKeys;
		for (let index = 0; index < objectKeyValues.length; index++) {
			const key = objectKeyValues[index];
			if (typeof key !== "string" || setHas(unique, key)) return void 0;
			setAdd(unique, key);
			append$1(normalizedKeys, key);
		}
		return {
			kind: "object",
			keys: normalizedKeys
		};
	}
}
/**
* Rebuild one lossless JSON value from the flat process wire format.
* Malformed or incomplete traffic returns `undefined`; traversal is iterative
* and therefore independent of the transported value's application depth.
* @param input - untrusted message-port payload.
* @returns the detached JSON value, or `undefined` when the wire is invalid.
*/
function decodePtcJsonWire(input) {
	try {
		if (!intrinsicArrayIsArray$1(input) || !isDenseArray(input) || input.length === 0) return void 0;
		const wire = input;
		const frames = [];
		let root;
		let rootAssigned = false;
		const attach = (value) => {
			const parent = frames[frames.length - 1];
			if (!parent) {
				if (rootAssigned) return false;
				root = value;
				rootAssigned = true;
				return true;
			}
			/* v8 ignore next -- completed frames are popped before another token can attach. */
			if (parent.index >= (parent.kind === "array" ? parent.length : parent.keys.length)) return false;
			if (parent.kind === "array") append$1(parent.target, value);
			else {
				const key = parent.keys[parent.index];
				/* v8 ignore next -- object frames are built from validated keys and their exact length. */
				if (key === void 0) return false;
				defineEnumerableDataProperty$1(parent.target, key, value);
			}
			parent.index += 1;
			return true;
		};
		for (let tokenIndex = 0; tokenIndex < wire.length; tokenIndex++) {
			const token = wire[tokenIndex];
			let value;
			let frame;
			if (token === null || typeof token === "boolean" || typeof token === "string") value = token;
			else if (typeof token === "number") {
				if (!intrinsicNumberIsFinite(token) || intrinsicObjectIs(token, -0)) return void 0;
				value = token;
			} else {
				if (typeof token !== "object") return void 0;
				const marker = containerToken(token);
				if (!marker) return void 0;
				const remainingTokens = wire.length - tokenIndex - 1;
				if (marker.kind === "array") {
					if (marker.length > remainingTokens) return void 0;
					const target = [];
					value = target;
					if (marker.length > 0) frame = {
						kind: "array",
						target,
						length: marker.length,
						index: 0
					};
				} else {
					if (marker.keys.length > remainingTokens) return void 0;
					const target = {};
					value = target;
					if (marker.keys.length > 0) frame = {
						kind: "object",
						target,
						keys: marker.keys,
						index: 0
					};
				}
			}
			if (!attach(value)) return void 0;
			if (frame) append$1(frames, frame);
			while (frames.length > 0) {
				const current = frames[frames.length - 1];
				/* v8 ignore next -- the loop condition guarantees a final frame. */
				if (current === void 0) break;
				if (current.index < (current.kind === "array" ? current.length : current.keys.length)) break;
				takeLast$1(frames);
			}
		}
		return frames.length === 0 ? root : void 0;
	} catch {
		return;
	}
}
//#endregion
//#region lib/types/bindings.js
/** Validate and capture the binding names available to one program. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
* Reject unusable namespaces before starting a process.
* @param request - Host-owned binding declarations.
* @returns Namespaces keyed by their declared global.
*/
function validateBindings(request) {
	const bindings = /* @__PURE__ */ new Map();
	for (const namespace of request.bindings) {
		if (!IDENTIFIER.test(namespace.global) || PORTABLE_RESERVED_WORDS.has(namespace.global)) throw new Error(`dsh-ptc-runtime-node: binding global ${JSON.stringify(namespace.global)} is not a usable identifier`);
		if (RESERVED_BINDING_GLOBALS.has(namespace.global)) throw new Error(`dsh-ptc-runtime-node: reserved binding global ${JSON.stringify(namespace.global)}`);
		if (bindings.has(namespace.global)) throw new Error(`dsh-ptc-runtime-node: duplicate binding global ${JSON.stringify(namespace.global)}`);
		bindings.set(namespace.global, namespace);
	}
	const errorClassNames = /* @__PURE__ */ new Set();
	for (const namespace of request.bindings) {
		const descriptor = namespace.errorClass;
		if (!descriptor) continue;
		if (!IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) throw new Error(`dsh-ptc-runtime-node: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`);
		if (RESERVED_BINDING_GLOBALS.has(descriptor.name)) throw new Error(`dsh-ptc-runtime-node: reserved binding global ${JSON.stringify(descriptor.name)}`);
		if (bindings.has(descriptor.name) || errorClassNames.has(descriptor.name)) throw new Error(`dsh-ptc-runtime-node: duplicate injected global ${JSON.stringify(descriptor.name)}`);
		const member = descriptor.memberNameProperty;
		if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) throw new Error(`dsh-ptc-runtime-node: binding error member property ${JSON.stringify(descriptor.memberNameProperty)} is not usable`);
		errorClassNames.add(descriptor.name);
	}
	return bindings;
}
/**
* Invoke a host binding and encode its lossless result or bounded-channel rejection.
* @param id - Program-issued correlation identifier.
* @param binding - Current evaluation's declared function, absent if it was removed.
* @param args - Validated JSON arguments detached from the program.
* @returns A reply suitable for the runtime's bounded control channel.
*/
async function replyToBinding(id, binding, args) {
	try {
		if (!binding) throw new Error("binding is unavailable in this evaluation; reacquire the current tool");
		const value = snapshotJsonValue(await binding(args));
		if (value === void 0) throw new Error("binding resolution must be lossless JSON");
		return {
			type: "reply",
			id,
			ok: true,
			value: encodePtcJsonWire(value)
		};
	} catch (error) {
		return {
			type: "reply",
			id,
			ok: false,
			message: error instanceof Error ? error.message : String(error)
		};
	}
}
//#endregion
//#region lib/types/output-json.js
/** JSON string-prefix accounting for the outer-output ledger. @module @deepseek-ai/dsh-ptc-runtime-node/output-json */
const intrinsicReflectApply = Reflect.apply;
const intrinsicArrayIsArray = Array.isArray;
const IntrinsicBuffer = Buffer;
const intrinsicBufferByteLength = Reflect.get(Buffer, "byteLength");
const intrinsicObjectCreate = Object.create;
const intrinsicObjectDefineProperty = Object.defineProperty;
const intrinsicObjectKeys = Object.keys;
const intrinsicString = String;
const intrinsicStringCharCodeAt = Reflect.get(String.prototype, "charCodeAt");
const intrinsicStringCodePointAt = Reflect.get(String.prototype, "codePointAt");
const intrinsicStringSlice = Reflect.get(String.prototype, "slice");
/** Build a data descriptor that cannot inherit model-defined accessor fields. */
function dataDescriptor(value) {
	const descriptor = intrinsicObjectCreate(null);
	descriptor.value = value;
	return descriptor;
}
/** Define an ordinary enumerable data slot without a prototype-bearing descriptor. */
function defineEnumerableDataProperty(target, key, value) {
	const descriptor = dataDescriptor(value);
	descriptor.enumerable = true;
	descriptor.configurable = true;
	descriptor.writable = true;
	intrinsicObjectDefineProperty(target, key, descriptor);
}
/** UTF-8 byte length through the module-captured Node intrinsic. */
function byteLength(text) {
	return intrinsicReflectApply(intrinsicBufferByteLength, IntrinsicBuffer, [text, "utf8"]);
}
/** Append without consulting a model-mutated `Array.prototype`. */
function append(target, value) {
	defineEnumerableDataProperty(target, target.length, value);
}
/** Pop without consulting a model-mutated `Array.prototype`. */
function takeLast(target) {
	if (target.length === 0) return void 0;
	const index = target.length - 1;
	const value = target[index];
	intrinsicObjectDefineProperty(target, "length", dataDescriptor(index));
	return value;
}
/** One code-point-aligned character from a string. */
function characterAt(text, index) {
	return intrinsicReflectApply(intrinsicStringSlice, text, [index, index + (intrinsicReflectApply(intrinsicStringCodePointAt, text, [index]) > 65535 ? 2 : 1)]);
}
/** Serialized bytes contributed by one complete Unicode code point inside JSON quotes. */
function serializedCharacterBytes(character) {
	if (character.length === 2) return 4;
	if (character === "\"" || character === "\\") return 2;
	const code = intrinsicReflectApply(intrinsicStringCharCodeAt, character, [0]);
	if (code >= 55296 && code <= 57343) return 6;
	if (code < 32) return code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
	return byteLength(character);
}
/**
* Measure one JSON string without materializing its complete escaped form.
* @param text - the candidate string.
* @param maxBytes - largest serialized size the caller can admit.
* @returns Exact serialized bytes, or `undefined` as soon as the cap is crossed.
*/
function jsonStringBytesUpTo(text, maxBytes) {
	if (maxBytes < 2) return void 0;
	let bytes = 2;
	for (let index = 0; index < text.length;) {
		const character = characterAt(text, index);
		bytes += serializedCharacterBytes(character);
		if (bytes > maxBytes) return void 0;
		index += character.length;
	}
	return bytes;
}
/**
* Measure one lossless JSON value without allocating its serialized form.
* @param value - already validated lossless JSON.
* @param maxBytes - largest serialized size the caller can admit.
* @returns Exact serialized bytes, or `undefined` as soon as the cap is crossed.
*/
function jsonValueBytesUpTo(value, maxBytes) {
	let bytes = 0;
	const add = (cost) => {
		bytes += cost;
		return bytes <= maxBytes;
	};
	const tasks = [{
		kind: "value",
		value
	}];
	for (let task = takeLast(tasks); task !== void 0; task = takeLast(tasks)) {
		if (task.kind === "value") {
			const current = task.value;
			if (current === null) {
				if (!add(4)) return void 0;
			} else if (typeof current === "string") {
				const stringBytes = jsonStringBytesUpTo(current, maxBytes - bytes);
				if (stringBytes === void 0) return void 0;
				bytes += stringBytes;
			} else if (typeof current === "number") {
				if (!add(byteLength(intrinsicString(current)))) return void 0;
			} else if (typeof current === "boolean") {
				if (!add(current ? 4 : 5)) return void 0;
			} else if (intrinsicArrayIsArray(current)) {
				if (!add(2)) return void 0;
				if (current.length > 0) append(tasks, {
					kind: "array",
					value: current,
					index: 0
				});
			} else {
				if (!add(2)) return void 0;
				const keys = intrinsicObjectKeys(current);
				if (keys.length > 0) append(tasks, {
					kind: "object",
					value: current,
					keys,
					index: 0
				});
			}
			continue;
		}
		if (task.index > 0 && !add(1)) return void 0;
		if (task.kind === "array") {
			const item = task.value[task.index];
			if (item === void 0) return void 0;
			if (task.index + 1 < task.value.length) append(tasks, {
				...task,
				index: task.index + 1
			});
			append(tasks, {
				kind: "value",
				value: item
			});
			continue;
		}
		const key = task.keys[task.index];
		/* v8 ignore next -- an object frame is created and advanced only for an existing Object.keys entry. */
		if (key === void 0) return void 0;
		const keyBytes = jsonStringBytesUpTo(key, maxBytes - bytes);
		if (keyBytes === void 0) return void 0;
		if (!add(keyBytes + 1)) return void 0;
		const item = task.value[key];
		if (item === void 0) return void 0;
		if (task.index + 1 < task.keys.length) append(tasks, {
			...task,
			index: task.index + 1
		});
		append(tasks, {
			kind: "value",
			value: item
		});
	}
	return bytes;
}
/**
* Return the longest code-point-aligned prefix whose JSON string encoding,
* including its surrounding quotes, fits `maxBytes`.
*
* @param text - the candidate string.
* @param maxBytes - serialized JSON-string bytes available.
* @returns the fitting prefix, or an empty string when even useful content cannot fit.
*/
function truncateJsonStringBytes(text, maxBytes) {
	if (maxBytes < 2) return "";
	let bytes = 2;
	let end = 0;
	for (let index = 0; index < text.length;) {
		const character = characterAt(text, index);
		const cost = serializedCharacterBytes(character);
		if (bytes + cost > maxBytes) break;
		bytes += cost;
		end += character.length;
		index += character.length;
	}
	return end === text.length ? text : intrinsicReflectApply(intrinsicStringSlice, text, [0, end]);
}
//#endregion
//#region lib/types/channel.js
/** Length-prefixed JSON transport with bounded input and queued writes. */
const stringify = JSON.stringify;
const parse = JSON.parse;
/** One co-shipped process channel; the consumer owns frame validation and terminal outcomes. */
var JsonChannel = class {
	stream;
	maxBytes;
	receive;
	failure;
	header = Buffer$1.alloc(4);
	headerBytes = 0;
	payload;
	payloadBytes = 0;
	queuedBytes = 0;
	closed = false;
	writes = /* @__PURE__ */ new Set();
	constructor(stream, maxBytes, receive, failure) {
		this.stream = stream;
		this.maxBytes = maxBytes;
		this.receive = receive;
		this.failure = failure;
		stream.on("data", this.onData);
		stream.on("error", this.onError);
		stream.on("end", this.onEnd);
		stream.on("close", this.onClose);
	}
	onError = (error) => {
		this.finishWrites(error);
		if (!this.closed) this.failure(error, "io");
	};
	onClose = () => {
		this.finishWrites(/* @__PURE__ */ new Error("control channel closed during a write"));
	};
	onEnd = () => {
		if (!this.closed) this.failure(/* @__PURE__ */ new Error("control channel ended before the program settled"), "io");
	};
	onData = (chunk) => {
		if (this.closed) return;
		try {
			let offset = 0;
			while (offset < chunk.length && !this.closed) {
				if (this.payload === void 0) {
					const bytes = Math.min(4 - this.headerBytes, chunk.length - offset);
					chunk.copy(this.header, this.headerBytes, offset, offset + bytes);
					this.headerBytes += bytes;
					offset += bytes;
					if (this.headerBytes !== 4) continue;
					const length = this.header.readUInt32BE(0);
					if (length === 0 || length > this.maxBytes) throw new Error(`control frame exceeds ${this.maxBytes} bytes or is empty`);
					this.payload = Buffer$1.allocUnsafe(length);
					this.payloadBytes = 0;
					this.headerBytes = 0;
				}
				const bytes = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset);
				chunk.copy(this.payload, this.payloadBytes, offset, offset + bytes);
				this.payloadBytes += bytes;
				offset += bytes;
				if (this.payloadBytes !== this.payload.length) continue;
				const frame = this.payload;
				this.payload = void 0;
				this.payloadBytes = 0;
				this.receive(parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)), frame.length);
			}
		} catch (error) {
			this.failure(error instanceof Error ? error : new Error(String(error)), "protocol");
		}
	};
	/**
	* Submit a bounded frame immediately and await the stream's write receipt.
	* @param message - JSON-only co-shipped protocol value.
	* @returns Resolves when this frame has been written, or rejects after transport failure.
	*/
	send(message) {
		if (this.closed) return Promise.reject(/* @__PURE__ */ new Error("control channel is closed"));
		const size = jsonValueBytesUpTo(message, this.maxBytes);
		if (size === void 0 || this.queuedBytes + size > this.maxBytes) return Promise.reject(/* @__PURE__ */ new Error(`control output exceeds ${this.maxBytes} queued bytes`));
		const body = Buffer$1.from(stringify(message), "utf8");
		const header = Buffer$1.alloc(4);
		header.writeUInt32BE(body.length);
		this.queuedBytes += body.length;
		const completion = Promise.withResolvers();
		const write = {
			promise: completion.promise,
			finish: (error) => {
				if (!this.writes.delete(write)) return;
				this.queuedBytes -= body.length;
				if (error) completion.reject(error);
				else completion.resolve();
			}
		};
		this.writes.add(write);
		try {
			this.stream.cork();
			this.stream.write(header);
			this.stream.write(body, (error) => {
				write.finish(error ?? void 0);
			});
			this.stream.uncork();
		} catch (error) {
			write.finish(error instanceof Error ? error : new Error(String(error)));
		}
		return completion.promise;
	}
	finishWrites(error) {
		for (const write of this.writes) write.finish(error);
	}
	/** Stop reads and close the owned endpoint; pending writes reject on closure. */
	close() {
		if (this.closed) return;
		this.closed = true;
		this.payload = void 0;
		this.finishWrites(/* @__PURE__ */ new Error("control channel is closed"));
		this.stream.off("data", this.onData);
		this.stream.off("end", this.onEnd);
		this.stream.destroy();
	}
	/** Wait for accepted writes to finish or fail. */
	async drain() {
		await Promise.allSettled([...this.writes].map((write) => write.promise));
	}
};
//#endregion
//#region lib/types/launch.js
/** Select source or built bootstrap assets in the mounted execution world. */
/**
* Resolve the local carrier default or validate an explicit execution-world invocation.
* @param config - explicit remote or local worker configuration; omitted selects this carrier.
* @returns the worker invocation without guessing from the execution world's paths.
*/
function resolveLaunch(config) {
	const launch = config ?? {
		kind: "pkg" in process ? "embedded" : "node-script",
		executable: process.execPath
	};
	if (launch.executable.length === 0) throw new Error("ptc-runtime-node: launch.executable must be non-empty");
	if (launch.kind === "node-script" && launch.bootstrapPath !== void 0 && !isAbsolute(launch.bootstrapPath)) throw new Error("ptc-runtime-node: launch.bootstrapPath must be absolute");
	return launch;
}
/**
* Select explicit arguments without inheriting host loader or inspector flags.
* @param fs - Filesystem mapping host bootstrap assets into the process world.
* @param config - resolved worker invocation.
* @param maxMessageBytes - Validated frame and queued-write limit.
* @param persistent - Select the in-memory REPL bootstrap instead of the one-shot evaluator.
* @returns Arguments following the resolved Node executable.
*/
function bootstrapArgs(fs, config, maxMessageBytes, persistent = false) {
	switch (config.kind) {
		case "embedded":
			if (persistent) throw new Error("Persistent PTC requires a node-script launch");
			return [String(maxMessageBytes)];
		case "node-script": return scriptBootstrapArgs(fs, config.bootstrapPath, maxMessageBytes, persistent);
		/* v8 ignore next -- Callers supply the resolved, closed LaunchConfig union. */
		default: return assertNever(config);
	}
}
function scriptBootstrapArgs(fs, bootstrapPath, maxMessageBytes, persistent) {
	const moduleName = persistent ? "persistent-process" : "process";
	if (bootstrapPath !== void 0) return [bootstrapPath, String(maxMessageBytes)];
	const mapped = (path) => {
		const result = fs.processPathFromHostPath(path);
		if (result === void 0) throw new Error(`PTC runtime bootstrap is unavailable in the subprocess execution world: ${path}`);
		return result;
	};
	/* v8 ignore next 3 -- built-lib.e2e.ts executes the bundled provider and sibling process.js under plain Node. */
	if (!new URL(import.meta.url).pathname.endsWith(".ts")) return [mapped(fileURLToPath(new URL(`./${moduleName}.js`, import.meta.url))), String(maxMessageBytes)];
	const entry = mapped(fileURLToPath(new URL(`./${moduleName}.ts`, import.meta.url)));
	const helper = mapped(resolve(dirname(fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-subprocess/package.json"))), "src/control.ts"));
	const main = persistent ? "runPersistentMain" : "runNodeMain";
	return [
		"--input-type=module",
		"--eval",
		`const {openInheritedControlChannel}=await import(${JSON.stringify(pathToFileURL(helper).href)});const {${main}}=await import(${JSON.stringify(pathToFileURL(entry).href)});await ${main}(openInheritedControlChannel(),${maxMessageBytes},process);`
	];
}
//#endregion
//#region lib/types/config.js
/** Execution mode and resource limits for the Node PTC provider. */
/** Loader defaults for the Node PTC provider. */
const NodeConfig = z.object({
	executionMode: z.union([z.const("per-call"), z.const("persistent-in-memory")]).default("per-call"),
	timeoutMs: z.number().default(12e4),
	maxTimeoutMs: z.number().default(6e5),
	maxOutputBytes: z.number().default(67108864),
	maxOldGenerationSizeMb: z.number().default(512),
	maxMessageBytes: z.number().default(134217728),
	maxPendingCalls: z.number().default(128),
	graceMs: z.number().default(3e3),
	launch: z.union([z.object({
		kind: z.const("node-script").required(),
		executable: z.string().required(),
		bootstrapPath: z.string()
	}), z.object({
		kind: z.const("embedded").required(),
		executable: z.string().required()
	})])
});
/**
* Validate resolved Node limits and paths.
* @param config - Loader-defaulted fields with the selected executable.
*/
function validateConfig(config) {
	for (const [key, value] of Object.entries(config)) if (typeof value === "number" && (!Number.isFinite(value) || value <= 0)) throw new Error(`ptc-runtime-node: ${key} must be positive and finite`);
	for (const key of [
		"timeoutMs",
		"maxTimeoutMs",
		"graceMs"
	]) if (config[key] > MAX_TIMER_DELAY_MS) throw new Error(`ptc-runtime-node: ${key} exceeds the supported timer range`);
	if (!Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes < 4) throw new Error("ptc-runtime-node: maxOutputBytes must be an integer of at least 4");
	if (!Number.isSafeInteger(config.maxMessageBytes) || config.maxMessageBytes > 4294967295) throw new Error("ptc-runtime-node: maxMessageBytes must fit an unsigned 32-bit frame length");
	if (!Number.isSafeInteger(config.maxPendingCalls)) throw new Error("ptc-runtime-node: maxPendingCalls must be an integer");
	if (!Number.isSafeInteger(config.maxOldGenerationSizeMb)) throw new Error("ptc-runtime-node: maxOldGenerationSizeMb must be an integer");
}
//#endregion
//#region lib/types/policy-processes.js
/** Owns asynchronous process cleanup without delaying permission setters. */
var PolicyProcesses = class {
	ctx;
	processes = /* @__PURE__ */ new Set();
	/**
	* Begin cleanup on policy changes, even when no subsequent program runs.
	* @param ctx - Node provider lifecycle and Session services.
	*/
	constructor(ctx) {
		this.ctx = ctx;
		ctx.on("session/event", (session, event) => {
			if (event.type !== "sandbox/mode") return;
			for (const process of this.processes) {
				if (process.sessionId !== session.id || process.mode === event.data.mode) continue;
				process.invalidated = true;
				this.release(process).catch((error) => {
					ctx.logger.warn(error);
				});
			}
		}, { global: true });
		ctx.effect(() => async () => {
			await this.settle([...this.processes]);
		}, "Node PTC policy cleanup");
	}
	/**
	* Track an admitted call or retained process until its owner confirms cleanup.
	* @param policy - Resolved process policy, including an optional Session identity.
	* @param release - Idempotent cancellation and awaited cleanup.
	* @returns Removal after successful process cleanup.
	*/
	register(policy, release) {
		if (policy.sessionId === void 0) return () => {};
		const session = this.ctx.get("sessions")?.get(policy.sessionId);
		const process = {
			sessionId: policy.sessionId,
			mode: session === void 0 ? policy.mode : this.ctx.sandboxPolicy.resolve({ session }).mode,
			release,
			invalidated: false
		};
		this.processes.add(process);
		return () => {
			this.processes.delete(process);
		};
	}
	/**
	* Wait for invalidated processes before admitting another program.
	* @param sessionId - Session carried by the resolved policy.
	* @returns Completion after prior cleanup; a failure rejects and remains retryable.
	*/
	async wait(sessionId) {
		await this.settle([...this.processes].filter((process) => process.sessionId === sessionId && process.invalidated));
	}
	release(process) {
		if (process.cleanup !== void 0) return process.cleanup;
		process.cleanup = process.release().then(() => {
			this.processes.delete(process);
		}, (error) => {
			delete process.cleanup;
			throw error;
		});
		return process.cleanup;
	}
	async settle(processes) {
		const failed = (await Promise.allSettled(processes.map((process) => this.release(process)))).find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
	}
};
//#endregion
//#region lib/types/environment.js
/** Startup variables required by native executables before model evaluation. */
/** Native executable search, Windows system paths, and sandbox temporary paths retained in the OS environment. */
const STARTUP_ENVIRONMENT_NAMES = new Set([
	"PATH",
	"PATHEXT",
	"SYSTEMROOT",
	"WINDIR",
	"TEMP",
	"TMP"
]);
//#endregion
//#region lib/types/output-ledger.js
/** One run's combined outer-output ledger; binding values never enter it. */
var OutputLedger = class {
	maxBytes;
	overflowMessage;
	bytes = 2;
	entries = 0;
	constructor(maxBytes, overflowMessage) {
		this.maxBytes = maxBytes;
		this.overflowMessage = overflowMessage;
	}
	/** Admit one exact log entry, or report that the hard cap was crossed. */
	admit(text, sink) {
		const separatorBytes = this.entries > 0 ? 1 : 0;
		const stringBytes = jsonStringBytesUpTo(text, this.maxBytes - this.bytes - separatorBytes);
		if (stringBytes === void 0) return false;
		this.bytes += stringBytes + separatorBytes;
		this.entries += 1;
		sink.push(text);
		return true;
	}
	/** Finalize a successful absent-or-JSON completion against the combined cap. */
	success(logs, value) {
		if (value !== void 0 && jsonValueBytesUpTo(value, this.maxBytes - this.bytes) === void 0) return this.limit(logs);
		return {
			logs,
			...value !== void 0 ? { value } : {}
		};
	}
	/** Finalize a failure diagnostic, with output-limit taking precedence when combined bytes exceed the cap. */
	failure(logs, error) {
		if (jsonStringBytesUpTo(error.message, this.maxBytes - this.bytes) === void 0) return this.limit(logs);
		return {
			logs,
			error
		};
	}
	/** Build the explicit output-limit failure while retaining a fitting prefix of the final log. */
	limit(logs) {
		const fullMessage = this.overflowMessage ?? `outer output exceeded ${this.maxBytes} bytes`;
		const messageBytes = fullMessage.length + 2;
		const retained = [];
		let retainedBytes = 2;
		const logBudget = this.maxBytes - messageBytes;
		for (const text of logs) {
			const separatorBytes = retained.length > 0 ? 1 : 0;
			const availableBytes = logBudget - retainedBytes - separatorBytes;
			const stringBytes = jsonStringBytesUpTo(text, availableBytes);
			if (stringBytes !== void 0) {
				retained.push(text);
				retainedBytes += stringBytes + separatorBytes;
				continue;
			}
			const prefix = truncateJsonStringBytes(text, availableBytes);
			if (prefix.length > 0) {
				const prefixBytes = jsonStringBytesUpTo(prefix, availableBytes);
				/* v8 ignore next -- truncateJsonStringBytes guarantees its returned prefix fits the same budget. */
				if (prefixBytes === void 0) throw new Error("output ledger produced an oversized log prefix");
				retained.push(prefix);
				retainedBytes += prefixBytes + separatorBytes;
			}
			break;
		}
		return {
			logs: retained,
			error: {
				kind: "output-limit",
				message: truncateJsonStringBytes(fullMessage, this.maxBytes - retainedBytes)
			}
		};
	}
};
//#endregion
//#region lib/types/output-stream.js
/**
* Wait for queued bytes without letting an inherited descriptor retain a run forever.
* @param stream - Caller-owned raw process output, when provided.
* @param graceMs - Maximum wait after managed process termination.
* @returns Whether the complete stream ended without a transport error.
*/
function drainOutput(stream, graceMs) {
	if (stream === void 0 || stream.readableEnded) return Promise.resolve(true);
	if (stream.destroyed) return Promise.resolve(false);
	return new Promise((resolve) => {
		const finish = (complete) => {
			clearTimeout(timer);
			stream.off("end", onEnd);
			stream.off("close", onClose);
			stream.off("error", onError);
			resolve(complete);
		};
		const onEnd = () => {
			finish(true);
		};
		const onClose = () => {
			finish(false);
		};
		const onError = () => {
			finish(false);
		};
		const timer = setTimeout(() => {
			finish(false);
		}, graceMs);
		stream.once("end", onEnd);
		stream.once("close", onClose);
		stream.once("error", onError);
	});
}
/**
* Terminate a managed process and drain its pipes, including failures before output listeners attach.
* @param handle - Process and streams owned by the runtime.
* @param graceMs - Maximum pipe-drain wait after managed exit.
* @returns Whether both output streams ended cleanly.
*/
async function terminateProcess(handle, graceMs) {
	try {
		handle.terminate();
		handle.stdout?.resume();
		handle.stderr?.resume();
		await Promise.all([handle.done.catch(() => {}), handle.waitForExit()]);
		return !(await Promise.all([drainOutput(handle.stdout, graceMs), drainOutput(handle.stderr, graceMs)])).includes(false);
	} finally {
		handle.stdout?.destroy();
		handle.stderr?.destroy();
	}
}
//#endregion
//#region lib/types/persistent.js
/** Node PTC in-memory execution with retained processes scoped to caller-owned objects. */
const messageOf$1 = (error) => error instanceof Error ? error.message : String(error);
const record$1 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function persistentOutput(maxBytes) {
	return new OutputLedger(maxBytes, `retained variables were cleared; outer output exceeded ${maxBytes} bytes`);
}
/** One managed process; all mutable program state belongs to this process alone. */
var Kernel = class {
	ctx;
	config;
	policy;
	unregister;
	confined;
	handle;
	channel;
	active;
	/** Admission remains reserved until the result includes completed process cleanup. */
	running = false;
	cleanupPending = false;
	ready = false;
	sequence = 0;
	nextCall = 1;
	stderr = "";
	stopped;
	starting;
	exitOutcome;
	controller = new AbortController();
	closed = false;
	constructor(ctx, config, policy, processes) {
		this.ctx = ctx;
		this.config = config;
		this.policy = policy;
		this.unregister = processes.register(policy, () => this.dispose());
	}
	assertIdle() {
		if (this.running) throw new Error("persistent PTC does not accept concurrent runs for one state owner");
		if (this.cleanupPending) throw new Error("persistent PTC environment cleanup is incomplete; release the owner before running another program");
	}
	async run(spec, bindings, code) {
		this.running = true;
		const sandbox = {
			mode: this.policy.mode,
			denied: false
		};
		try {
			const result = await this.evaluate(spec, bindings, code);
			if (this.confined !== void 0) {
				sandbox.enforcement = this.confined.enforcement;
				sandbox.denied = result.error?.kind !== "sandbox-unavailable" && this.confined.denialSignatures.some((signature) => result.error?.message.toLowerCase().includes(signature.toLowerCase()));
			}
			return {
				...result,
				sandbox
			};
		} finally {
			this.running = false;
		}
	}
	async evaluate(spec, bindings, code) {
		if (this.exitOutcome !== void 0) {
			const output = persistentOutput(this.config.maxOutputBytes);
			const failure = spec.signal?.aborted ? {
				kind: "abort",
				message: "execution canceled; retained variables were cleared"
			} : {
				kind: "worker-exit",
				message: `${this.exitMessage(this.exitOutcome)}; retained variables were cleared`
			};
			try {
				await this.stop();
			} catch (error) {
				return output.failure([], {
					kind: "worker-exit",
					message: `managed process cleanup failed: ${messageOf$1(error)}`
				});
			}
			return output.failure([], failure);
		}
		this.stderr = "";
		const output = persistentOutput(this.config.maxOutputBytes);
		const logs = [];
		const result = Promise.withResolvers();
		const timer = spec.timeoutMs === null ? void 0 : setTimeout(() => {
			evaluation.finish({
				kind: "timeout",
				message: `execution deadline reached (${spec.timeoutMs}ms); retained variables were cleared`
			}, void 0, true);
		}, spec.timeoutMs);
		const onAbort = () => {
			evaluation.finish({
				kind: "abort",
				message: "execution canceled; retained variables were cleared"
			}, void 0, true);
		};
		const evaluation = {
			id: ++this.sequence,
			data: {
				code,
				maxOutputBytes: this.config.maxOutputBytes,
				namespaces: [...bindings.values()].map((binding) => ({
					global: binding.global,
					names: Object.keys(binding.functions),
					...binding.errorClass ? { errorClass: binding.errorClass } : {}
				}))
			},
			spec,
			bindings,
			reply: AsyncLocalStorage.bind(replyToBinding),
			pending: 0,
			pendingBytes: 0,
			admit: (text) => {
				if (!output.admit(text, logs)) {
					logs.push(text);
					evaluation.finish({
						kind: "output-limit",
						message: "output limit exceeded"
					}, void 0, true);
				}
			},
			finish: (error, value, discard = false) => {
				if (this.active !== evaluation) return;
				clearTimeout(timer);
				spec.signal?.removeEventListener("abort", onAbort);
				this.active = void 0;
				const outcome = error?.kind === "output-limit" ? output.limit(logs) : error ? output.failure(logs, error) : output.success(logs, value);
				(discard || outcome.error?.kind === "output-limit" || spec.stateOwner === void 0 ? this.stop() : Promise.resolve(true)).then((drained) => {
					result.resolve(drained ? outcome : output.failure(logs, {
						kind: "worker-exit",
						message: "managed process exited but its output did not drain cleanly"
					}));
				}, (failure) => {
					result.resolve(output.failure(logs, {
						kind: "worker-exit",
						message: `managed process cleanup failed: ${messageOf$1(failure)}`
					}));
				});
			}
		};
		this.active = evaluation;
		spec.signal?.addEventListener("abort", onAbort, { once: true });
		if (spec.signal?.aborted) onAbort();
		else if (this.ready) this.dispatch(evaluation);
		else {
			this.starting = this.start(spec.cwd);
			this.starting.catch((error) => {
				this.fail(error instanceof SandboxUnavailableError || this.confined !== void 0 && isRunnerSpawnFailure(error, this.confined.argv[0], spec.cwd) ? "sandbox-unavailable" : "worker-exit", messageOf$1(error));
			});
		}
		return await result.promise;
	}
	async dispose() {
		this.active?.finish({
			kind: "abort",
			message: "PTC environment disposed; retained variables were cleared"
		}, void 0, true);
		await this.stop();
	}
	stop() {
		if (this.stopped) return this.stopped;
		this.closed = true;
		this.cleanupPending = true;
		this.controller.abort();
		this.channel?.close();
		this.stopped = (async () => {
			await this.starting?.catch(() => {});
			const handle = this.handle;
			return handle === void 0 || await terminateProcess(handle, this.config.graceMs);
		})().then((drained) => {
			this.unregister?.();
			this.cleanupPending = false;
			if (!drained) this.ctx.logger.warn("persistent Node process exited but its output did not drain cleanly");
			return drained;
		}, (error) => {
			this.stopped = void 0;
			throw error;
		});
		return this.stopped;
	}
	fail(kind, message) {
		if (this.active) this.active.finish({
			kind,
			message: `${message}; retained variables were cleared`
		}, void 0, true);
		else {
			if (!this.closed) this.ctx.logger.warn(message);
			this.stop().catch((error) => {
				this.ctx.logger.warn(messageOf$1(error));
			});
		}
	}
	dispatch(evaluation) {
		this.channel?.send({
			type: "run",
			id: evaluation.id,
			cwd: evaluation.spec.cwd,
			data: evaluation.data
		}).catch((error) => {
			this.fail("protocol", messageOf$1(error));
		});
	}
	exitMessage(outcome) {
		return `Node process exited (${String(outcome.exitCode)}, signal ${String(outcome.signal)})${this.stderr ? `: ${this.stderr}` : ""}`;
	}
	async start(cwd) {
		const executable = await this.ctx.subprocess.resolveExecutable(this.config.launch.executable, void 0, this.controller.signal);
		if (this.closed) return;
		const argv = [
			executable,
			`--max-old-space-size=${this.config.maxOldGenerationSizeMb}`,
			...bootstrapArgs(this.ctx.fs, this.config.launch, this.config.maxMessageBytes, true)
		];
		const policy = this.policy;
		this.confined = policy.mode === "danger-full-access" ? void 0 : await this.ctx.sandbox.confine(argv, {
			...policy,
			mode: policy.mode
		}, this.controller.signal);
		if (this.closed) return;
		const env = Object.fromEntries(Object.keys(process.env).filter((key) => !STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase()) && key.toUpperCase() !== "ELECTRON_RUN_AS_NODE").map((key) => [key, void 0]));
		const handle = this.ctx.subprocess.spawn({
			argv: this.confined?.argv ?? argv,
			cwd,
			env,
			stdio: {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				control: "pipe"
			},
			graceMs: this.config.graceMs
		});
		this.handle = handle;
		if (!handle.control || !handle.stdout || !handle.stderr) throw new Error("subprocess provider did not supply persistent PTC pipes");
		for (const stream of [handle.stdout, handle.stderr]) {
			stream.setEncoding("utf8");
			stream.on("data", (text) => {
				if (stream === handle.stderr) this.stderr = (this.stderr + text).slice(-this.config.maxOutputBytes);
				this.active?.admit(text);
			});
			stream.on("error", (error) => {
				this.fail("worker-exit", error.message);
			});
		}
		this.channel = new JsonChannel(handle.control, this.config.maxMessageBytes, (raw, bytes) => {
			this.receive(raw, bytes);
		}, (error, kind) => {
			if (kind === "protocol") this.fail("protocol", error.message);
			else setImmediate(() => {
				if (!this.closed && this.exitOutcome === void 0) handle.terminate();
			});
		});
		handle.done.then(async (outcome) => {
			this.exitOutcome = outcome;
			await Promise.all([drainOutput(handle.stdout, this.config.graceMs), drainOutput(handle.stderr, this.config.graceMs)]);
			setImmediate(() => {
				if (!this.closed) this.fail(this.confined !== void 0 && classifyRunnerFailure(outcome.exitCode, this.stderr, this.confined.runnerFailureRules) !== void 0 ? "sandbox-unavailable" : "worker-exit", this.exitMessage(outcome));
			});
		}, (error) => {
			this.fail("worker-exit", messageOf$1(error));
		});
	}
	receive(raw, bytes) {
		if (!record$1(raw)) {
			this.fail("protocol", "invalid persistent PTC frame");
			return;
		}
		const evaluation = this.active;
		if (!evaluation) {
			this.fail("protocol", "frame arrived without an active PTC evaluation");
			return;
		}
		if (!this.ready) {
			if (raw.type !== "ready") {
				this.fail("protocol", "expected persistent PTC readiness");
				return;
			}
			this.ready = true;
			this.dispatch(evaluation);
			return;
		}
		if (raw.id !== evaluation.id || !record$1(raw.payload)) {
			this.fail("protocol", "frame does not belong to the active PTC evaluation");
			return;
		}
		const payload = raw.payload;
		switch (payload.type) {
			case "log":
				if (typeof payload.text === "string") evaluation.admit(payload.text);
				else this.fail("protocol", "invalid persistent PTC log");
				return;
			case "output-limit":
				evaluation.finish({
					kind: "output-limit",
					message: "output limit exceeded"
				}, void 0, true);
				return;
			case "done":
				if (payload.error !== void 0) {
					const error = payload.error;
					if (!record$1(error) || typeof error.message !== "string" || error.kind !== "exception" && error.kind !== "invalid-output" && error.kind !== "output-limit") {
						this.fail("protocol", "invalid persistent PTC failure");
						return;
					}
					const failure = {
						kind: error.kind,
						message: error.message
					};
					setImmediate(() => {
						evaluation.finish(failure, void 0, failure.kind === "output-limit");
					});
				} else {
					const value = payload.value === void 0 ? void 0 : decodePtcJsonWire(payload.value);
					const failure = payload.value !== void 0 && value === void 0 ? {
						kind: "invalid-output",
						message: "program completion must be lossless JSON"
					} : void 0;
					setImmediate(() => {
						evaluation.finish(failure, value);
					});
				}
				return;
			case "call": {
				if (payload.id !== this.nextCall || typeof payload.global !== "string" || typeof payload.name !== "string") {
					this.fail("protocol", "invalid persistent PTC binding identity");
					return;
				}
				this.nextCall += 1;
				const args = decodePtcJsonWire(payload.args);
				if (args === void 0) {
					this.fail("protocol", "binding arguments must be lossless JSON");
					return;
				}
				if (++evaluation.pending > this.config.maxPendingCalls || (evaluation.pendingBytes += bytes) > this.config.maxMessageBytes) {
					this.fail("protocol", "pending binding calls exceed configured limits");
					return;
				}
				const functions = evaluation.bindings.get(payload.global)?.functions;
				const fn = functions && Object.hasOwn(functions, payload.name) ? functions[payload.name] : void 0;
				const id = payload.id;
				(async () => {
					const reply = await evaluation.reply(id, fn, args).finally(() => {
						evaluation.pending -= 1;
						evaluation.pendingBytes -= bytes;
					});
					if (this.active === evaluation) await this.channel?.send(reply);
				})().catch((error) => {
					this.fail("protocol", messageOf$1(error));
				});
				return;
			}
			default: this.fail("protocol", "unknown persistent PTC message");
		}
	}
};
/** Sandboxed, best-effort retained state; restart, disposal, and interrupted execution clear it. */
var InMemoryExecution = class {
	ctx;
	config;
	processes;
	/**
	* Model-facing rules for retained variables, authority, output, and recovery.
	* @returns Usage guidance appended to the run_code schema.
	*/
	get executionInstructions() {
		return "The program contains TypeScript REPL statements; only erasable syntax is accepted, with no enum or namespaces. Type annotations are advisory. Top-level declarations and await are supported; top-level return is not supported. Emit output with console.log(...) or a final lossless JSON expression. Only printed values and that final expression become program output. Variables, functions, and imported modules remain in memory for this Agent across calls. Use await import(...) for modules. Direct filesystem access follows this execution's sandbox policy; process.env starts empty. Changing the session sandbox mode clears retained variables. An approved sandbox escalation runs in a separate temporary environment: it cannot access retained variables, and its declarations are discarded afterward. Restart, Agent disposal, cancellation, timeout, output overflow, or process failure clears the environment. If a variable is undefined, recreate it and reacquire its resources. State is not restored from the conversation, and failed evaluations can leave earlier mutations in memory. Redeclaring an existing let, const, or class name fails; assign to a mutable binding or use a new name. Await all tool calls; background callbacks cannot call tools after their evaluation ends. Await child-process completion before ending an evaluation; raw subprocess output belongs to whichever evaluation is active when it arrives.";
	}
	owners = /* @__PURE__ */ new WeakMap();
	kernels = /* @__PURE__ */ new Set();
	disposed = false;
	/**
	* Own retained execution resources under the existing Node provider.
	* @param ctx - Provider lifecycle and execution services.
	* @param config - Validated limits and selected executable.
	* @param processes - Provider-owned policy invalidation and cleanup.
	*/
	constructor(ctx, config, processes) {
		this.ctx = ctx;
		this.config = config;
		this.processes = processes;
		if (this.config.launch.kind === "embedded") throw new Error("Persistent PTC requires a node-script launch");
		ctx.effect(() => async () => {
			this.disposed = true;
			const results = await Promise.allSettled([...this.kernels].map((kernel) => kernel.dispose()));
			this.kernels.clear();
			const failed = results.find((result) => result.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
		}, "Persistent PTC environments");
	}
	/**
	* Resolve the file policy, directory and deadline for a retained REPL.
	* @param request - Program, bindings, owner, directory and elapsed budget.
	* @returns Resolved inputs with the selected file policy.
	*/
	resolve(request) {
		if (this.disposed) throw new Error("persistent PTC: resolve after disposal");
		const sandboxPolicy = request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
		const cwd = request.cwd ?? sandboxPolicy.workspaceRoot;
		if (!isAbsolute(cwd)) throw new Error("persistent PTC: cwd must be absolute");
		return {
			...request,
			sandboxPolicy,
			cwd,
			timeoutMs: request.timeoutMs === null ? null : clampTimeout(request.timeoutMs, this.config.timeoutMs, this.config.maxTimeoutMs, "persistent PTC timeoutMs")
		};
	}
	/**
	* Evaluate statements using this owner's process, or a temporary process without an owner.
	* @param spec - Resolved request; concurrent calls for one owner are rejected.
	* @returns Logs, a final JSON expression, or a structured execution failure.
	*/
	async run(spec) {
		if (this.disposed) throw new Error("persistent PTC: run after disposal");
		if (spec.sandboxPolicy === void 0 || !isAbsolute(spec.cwd) || spec.timeoutMs !== null && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0 || spec.timeoutMs > this.config.maxTimeoutMs)) throw new Error("persistent PTC: run requires resolved inputs with a sandbox policy");
		const bindings = validateBindings(spec);
		let kernel = spec.stateOwner === void 0 ? void 0 : this.owners.get(spec.stateOwner);
		kernel?.assertIdle();
		if (kernel && !kernel.closed && (kernel.policy.mode !== spec.sandboxPolicy.mode || kernel.policy.workspaceRoot !== spec.sandboxPolicy.workspaceRoot || kernel.policy.sessionId !== spec.sandboxPolicy.sessionId)) throw new Error("persistent PTC: release the retained environment before changing its sandbox policy");
		let code;
		try {
			code = stripTypeScriptTypes(spec.program);
		} catch (error) {
			const output = persistentOutput(this.config.maxOutputBytes);
			const outcome = output.failure([], {
				kind: "exception",
				message: messageOf$1(error)
			});
			if (outcome.error?.kind === "output-limit" && spec.stateOwner !== void 0) try {
				await this.release(spec.stateOwner);
			} catch (failure) {
				return output.failure([], {
					kind: "worker-exit",
					message: `managed process cleanup failed: ${messageOf$1(failure)}`
				});
			}
			return outcome;
		}
		if (!kernel || kernel.closed) {
			if (kernel) this.kernels.delete(kernel);
			kernel = new Kernel(this.ctx, this.config, { ...spec.sandboxPolicy }, this.processes);
			this.kernels.add(kernel);
			if (spec.stateOwner !== void 0) this.owners.set(spec.stateOwner, kernel);
		}
		try {
			return await kernel.run(spec, bindings, code);
		} finally {
			if (spec.stateOwner === void 0) this.kernels.delete(kernel);
		}
	}
	/**
	* Release retained state and await its process cleanup.
	* @param owner - Exact object supplied to run.
	* @returns Completion after the owned process and output streams stop.
	*/
	async release(owner) {
		const kernel = this.owners.get(owner);
		if (!kernel) return;
		await kernel.dispose();
		if (this.owners.get(owner) === kernel) this.owners.delete(owner);
		this.kernels.delete(kernel);
	}
};
//#endregion
//#region lib/types/index.js
/** Node PTC execution with configurable per-call processes or retained in-memory REPL state. */
const STRIP_PREFIX = "async function __dsh_program__() {\n";
const STRIP_SUFFIX = "\n}";
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Node execution under file policy, with optional owner-scoped retained memory. */
var NodePtcRuntime = class extends PtcRuntime {
	static inject = [
		"fs",
		"subprocess",
		"sandbox",
		"sandboxPolicy"
	];
	static Config = NodeConfig;
	language = "typescript";
	isolation = "process";
	inMemory;
	processes;
	get programFormat() {
		return this.inMemory ? "repl" : "function-body";
	}
	get executionInstructions() {
		if (this.inMemory) return this.inMemory.executionInstructions;
		return "The program is the body of an async TypeScript function; only erasable syntax is accepted, with no enum or namespaces. Type annotations are advisory. Top-level await and return are supported. Emit output with console.log(...) or return a lossless JSON value. Only printed values and the returned value become program output. Each call runs in a fresh Node process. Node APIs are available through await import(...). Relative paths use the supplied working directory; process.env starts empty. Direct filesystem access follows this execution's sandbox policy.";
	}
	config;
	live = /* @__PURE__ */ new Set();
	disposed = false;
	constructor(ctx, config) {
		super(ctx);
		this.config = {
			...config,
			launch: resolveLaunch(config.launch)
		};
		validateConfig(this.config);
		this.processes = new PolicyProcesses(ctx);
		if (this.config.executionMode === "persistent-in-memory") this.inMemory = new InMemoryExecution(ctx, this.config, this.processes);
		ctx.effect(() => async () => {
			this.disposed = true;
			const active = [...this.live];
			for (const run of active) run.controller.abort("runtime disposed");
			await Promise.all(active.map((run) => run.finished));
		}, "Node ptc-runtime cleanup");
	}
	get sandboxMode() {
		return this.ctx.sandboxPolicy.defaultMode;
	}
	release(owner) {
		return this.inMemory ? this.inMemory.release(owner) : super.release(owner);
	}
	get timeout() {
		return {
			defaultMs: Math.min(this.config.timeoutMs, this.config.maxTimeoutMs),
			maxMs: this.config.maxTimeoutMs
		};
	}
	/**
	* Resolve directory, deadline and file policy for the selected execution mode.
	* @param request - Program, bindings, optional cwd/deadline, and resolved authority.
	* @returns Complete execution inputs with a capped numeric budget or an explicit null deadline.
	*/
	resolve(request) {
		if (this.inMemory) return this.inMemory.resolve(request);
		if (this.disposed) throw new Error("ptc-runtime-node: resolve after disposal");
		const sandboxPolicy = request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
		const cwd = request.cwd ?? sandboxPolicy.workspaceRoot;
		if (!isAbsolute(cwd)) throw new Error("ptc-runtime-node: cwd must be absolute");
		return {
			...request,
			cwd,
			timeoutMs: request.timeoutMs === null ? null : clampTimeout(request.timeoutMs, this.config.timeoutMs, this.config.maxTimeoutMs, "ptc-runtime-node: timeoutMs"),
			sandboxPolicy
		};
	}
	/**
	* Run a resolved program under the configured execution mode.
	* Session mode changes cancel admitted calls before process launch as well as active programs.
	* @param spec - Inputs returned by resolve for the configured mode.
	* @returns Logs, JSON completion or failure; retained processes remain until release or invalidation.
	*/
	async run(spec) {
		if (this.disposed) throw new Error("ptc-runtime-node: run after disposal");
		const controller = new AbortController();
		const completion = Promise.withResolvers();
		const unregister = spec.sandboxPolicy === void 0 ? void 0 : this.processes.register(spec.sandboxPolicy, async () => {
			controller.abort(/* @__PURE__ */ new Error("sandbox mode changed"));
			await completion.promise;
		});
		const live = {
			controller,
			finished: completion.promise
		};
		this.live.add(live);
		try {
			await this.processes.wait(spec.sandboxPolicy?.sessionId);
			if (this.inMemory) {
				const signal = spec.signal === void 0 ? controller.signal : AbortSignal.any([spec.signal, controller.signal]);
				return await this.inMemory.run({
					...spec,
					signal
				});
			}
			if (spec.sandboxPolicy === void 0) throw new Error("ptc-runtime-node: run requires a resolved sandbox policy");
			if (!isAbsolute(spec.cwd) || spec.timeoutMs !== null && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0 || spec.timeoutMs > this.config.maxTimeoutMs)) throw new Error("ptc-runtime-node: run requires resolved cwd and timeout");
			const bindings = validateBindings(spec);
			return await this.execute(spec, spec.sandboxPolicy, bindings, controller);
		} finally {
			unregister?.();
			this.live.delete(live);
			completion.resolve();
		}
	}
	async execute(spec, policy, bindings, controller) {
		const replyBinding = AsyncLocalStorage.bind(replyToBinding);
		const output = new OutputLedger(this.config.maxOutputBytes);
		const logs = [];
		const sandbox = {
			mode: policy.mode,
			denied: false
		};
		const result = Promise.withResolvers();
		const signal = spec.signal === void 0 ? controller.signal : AbortSignal.any([spec.signal, controller.signal]);
		let handle;
		let channel;
		let confined;
		let settled = false;
		let timedOut = false;
		let outputOverflow = false;
		let overflowResult;
		let stderr = "";
		let parsing = true;
		const wallTimer = spec.timeoutMs === null ? void 0 : setTimeout(() => {
			timedOut = true;
			controller.abort("execution deadline reached");
		}, spec.timeoutMs);
		let stopping;
		const stop = () => {
			if (stopping !== void 0) return stopping;
			stopping = (handle === void 0 ? Promise.resolve(true) : terminateProcess(handle, this.config.graceMs)).then((drained) => {
				unregister();
				return drained;
			}, (error) => {
				stopping = void 0;
				throw error;
			});
			return stopping;
		};
		const finish = (failure, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(wallTimer);
			signal.removeEventListener("abort", onAbort);
			channel?.close();
			(async () => {
				try {
					if (!await stop() && failure === void 0) failure = {
						kind: "worker-exit",
						message: "Node process output did not close cleanly"
					};
				} catch (error) {
					failure = {
						kind: "worker-exit",
						message: `managed process cleanup failed: ${messageOf(error)}`
					};
				}
				const outcome = outputOverflow ? overflowResult ?? output.limit(logs) : failure === void 0 ? output.success(logs, value) : output.failure(logs, failure);
				result.resolve({
					...outcome,
					sandbox: { ...sandbox }
				});
			})();
		};
		const onAbort = () => {
			finish(timedOut ? {
				kind: "timeout",
				message: `execution deadline reached (${spec.timeoutMs}ms)`
			} : {
				kind: "abort",
				message: messageOf(signal.reason)
			});
		};
		const unregister = this.processes.register(policy, async () => {
			controller.abort(/* @__PURE__ */ new Error("sandbox mode changed"));
			await stop();
		});
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		try {
			if (settled) return await result.promise;
			const stripped = stripTypeScriptTypes(STRIP_PREFIX + spec.program + STRIP_SUFFIX);
			parsing = false;
			const data = {
				code: stripped.slice(35, stripped.length - 2),
				namespaces: [...bindings.values()].map((binding) => ({
					global: binding.global,
					names: Object.keys(binding.functions),
					...binding.errorClass ? { errorClass: binding.errorClass } : {}
				})),
				maxOutputBytes: this.config.maxOutputBytes
			};
			const executable = await this.ctx.subprocess.resolveExecutable(this.config.launch.executable, void 0, signal);
			if (settled) return await result.promise;
			const packaged = this.config.launch.kind === "embedded";
			const heapFlag = `--max-old-space-size=${this.config.maxOldGenerationSizeMb}`;
			const argv = [
				executable,
				...packaged ? [] : [heapFlag],
				...bootstrapArgs(this.ctx.fs, this.config.launch, this.config.maxMessageBytes)
			];
			confined = policy.mode === "danger-full-access" ? void 0 : await this.ctx.sandbox.confine(argv, {
				...policy,
				mode: policy.mode
			}, signal);
			if (settled) return await result.promise;
			if (confined !== void 0) sandbox.enforcement = confined.enforcement;
			const env = Object.fromEntries(Object.keys(process.env).filter((key) => !STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase()) && key.toUpperCase() !== "ELECTRON_RUN_AS_NODE").map((key) => [key, void 0]));
			if (packaged) {
				env.DSH_PTC_RUNTIME_NODE = "1";
				env.NODE_OPTIONS = heapFlag;
			}
			handle = this.ctx.subprocess.spawn({
				argv: confined?.argv ?? argv,
				cwd: spec.cwd,
				env,
				stdio: {
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					control: "pipe"
				},
				graceMs: this.config.graceMs,
				signal
			});
			const launched = handle;
			if (launched.control === void 0 || launched.stdout === void 0 || launched.stderr === void 0) throw new Error("subprocess provider did not supply the requested control and output pipes");
			const admit = (text) => {
				if (outputOverflow) return;
				if (!output.admit(text, logs)) {
					outputOverflow = true;
					overflowResult = output.limit([...logs, text]);
					finish({
						kind: "output-limit",
						message: `outer output exceeded ${this.config.maxOutputBytes} bytes`
					});
				}
			};
			const stdoutDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
			const stderrDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
			handle.stdout?.on("data", (chunk) => {
				const text = stdoutDecoder.decode(chunk, { stream: true });
				if (text.length > 0) admit(text);
			});
			handle.stdout?.on("end", () => {
				const text = stdoutDecoder.decode();
				if (text.length > 0) admit(text);
			});
			handle.stdout?.on("error", (error) => {
				finish({
					kind: "worker-exit",
					message: messageOf(error)
				});
			});
			handle.stderr?.on("data", (chunk) => {
				const text = stderrDecoder.decode(chunk, { stream: true });
				stderr = (stderr + text).slice(-this.config.maxOutputBytes);
				if (text.length > 0) admit(text);
			});
			handle.stderr?.on("end", () => {
				const text = stderrDecoder.decode();
				if (text.length > 0) admit(text);
			});
			handle.stderr?.on("error", (error) => {
				finish({
					kind: "worker-exit",
					message: messageOf(error)
				});
			});
			let ready = false;
			let nextId = 1;
			let pending = 0;
			let pendingBytes = 0;
			const protocolFailure = (message) => {
				finish({
					kind: "protocol",
					message
				});
			};
			const processFinished = (outcome) => {
				if (settled) return;
				finish(confined !== void 0 && classifyRunnerFailure(outcome.exitCode, stderr, confined.runnerFailureRules) !== void 0 ? {
					kind: "sandbox-unavailable",
					message: stderr
				} : {
					kind: "worker-exit",
					message: `Node process exited before completing (${String(outcome.exitCode)})${stderr ? `: ${stderr}` : ""}`
				});
			};
			const transport = new JsonChannel(launched.control, this.config.maxMessageBytes, (raw, bytes) => {
				if (!record(raw)) {
					protocolFailure("invalid control frame");
					return;
				}
				if (!ready) {
					if (raw.type !== "ready") {
						protocolFailure("program frame arrived before bootstrap readiness");
						return;
					}
					ready = true;
					transport.send({
						type: "boot",
						data
					}).catch((error) => {
						protocolFailure(messageOf(error));
					});
					return;
				}
				switch (raw.type) {
					case "log":
						if (typeof raw.text !== "string") {
							protocolFailure("invalid log frame");
							return;
						}
						admit(raw.text);
						return;
					case "output-limit":
						outputOverflow = true;
						finish();
						return;
					case "done": {
						if (raw.error !== void 0) {
							if (!record(raw.error) || typeof raw.error.message !== "string" || raw.error.kind !== "exception" && raw.error.kind !== "invalid-output" && raw.error.kind !== "output-limit") {
								protocolFailure("invalid terminal error");
								return;
							}
							const failure = {
								kind: raw.error.kind,
								message: raw.error.message
							};
							if (confined !== void 0) sandbox.denied = confined.denialSignatures.some((signature) => failure.message.toLowerCase().includes(signature.toLowerCase()));
							if (failure.kind === "output-limit") outputOverflow = true;
							finish(failure);
							return;
						}
						const value = raw.value === void 0 ? void 0 : decodePtcJsonWire(raw.value);
						if (raw.value !== void 0 && value === void 0) finish({
							kind: "invalid-output",
							message: "program completion must be lossless JSON"
						});
						else finish(void 0, value);
						return;
					}
					case "call": {
						if (!Number.isSafeInteger(raw.id) || raw.id !== nextId || typeof raw.global !== "string" || typeof raw.name !== "string") {
							protocolFailure("invalid binding call identity");
							return;
						}
						nextId += 1;
						const functions = bindings.get(raw.global)?.functions;
						const fn = functions !== void 0 && Object.hasOwn(functions, raw.name) ? functions[raw.name] : void 0;
						if (typeof fn !== "function") {
							protocolFailure("program requested an undeclared binding");
							return;
						}
						const args = decodePtcJsonWire(raw.args);
						if (args === void 0) {
							protocolFailure("binding arguments must be lossless JSON");
							return;
						}
						if (++pending > this.config.maxPendingCalls || (pendingBytes += bytes) > this.config.maxMessageBytes) {
							protocolFailure("pending binding calls exceed configured limits");
							return;
						}
						const id = raw.id;
						(async () => {
							const reply = await replyBinding(id, fn, args).finally(() => {
								pending -= 1;
								pendingBytes -= bytes;
							});
							if (!settled) await transport.send(reply);
						})().catch((error) => {
							protocolFailure(messageOf(error));
						});
						return;
					}
					default: protocolFailure("unknown control message");
				}
			}, (error, kind) => {
				if (kind === "protocol") protocolFailure(messageOf(error));
				else if (ready) finish({
					kind: "worker-exit",
					message: messageOf(error)
				});
				else launched.done.then(processFinished, (failure) => {
					finish({
						kind: "worker-exit",
						message: messageOf(failure)
					});
				});
			});
			channel = transport;
			launched.done.then((outcome) => {
				setImmediate(() => {
					processFinished(outcome);
				});
			}, (error) => {
				finish({
					kind: confined !== void 0 && isRunnerSpawnFailure(error, confined.argv[0], spec.cwd) ? "sandbox-unavailable" : "worker-exit",
					message: messageOf(error)
				});
			});
		} catch (error) {
			finish({
				kind: error instanceof SandboxUnavailableError ? "sandbox-unavailable" : parsing ? "exception" : "worker-exit",
				message: messageOf(error)
			});
		}
		return await result.promise;
	}
};
//#endregion
export { NodePtcRuntime, NodePtcRuntime as default };
