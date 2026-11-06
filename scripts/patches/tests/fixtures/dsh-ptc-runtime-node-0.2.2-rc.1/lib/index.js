import { stripTypeScriptTypes } from "node:module";
import { DUNDER_MEMBER, PORTABLE_RESERVED_WORDS, PtcRuntime, RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS } from "@deepseek-ai/dsh-ptc-runtime";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNever, snapshotJsonValue } from "@deepseek-ai/dsh-util-values";
import z from "@deepseek-ai/schemastery";
import { MAX_TIMER_DELAY_MS, clampTimeout } from "@deepseek-ai/dsh-timeout";
import { AsyncLocalStorage } from "node:async_hooks";
import { SandboxUnavailableError, classifyRunnerFailure, isRunnerSpawnFailure } from "@deepseek-ai/dsh-sandbox";
import { Buffer as Buffer$1 } from "node:buffer";
import { createBirpc } from "birpc";
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
* @param persistent - Whether the selected mode requires retained-process launch support.
* @returns Arguments following the resolved Node executable.
*/
function bootstrapArgs(fs, config, maxMessageBytes, persistent = false) {
	switch (config.kind) {
		case "embedded":
			if (persistent) throw new Error("Persistent PTC requires a node-script launch");
			return [String(maxMessageBytes)];
		case "node-script": return scriptBootstrapArgs(fs, config.bootstrapPath, maxMessageBytes);
		/* v8 ignore next -- Callers supply the resolved, closed LaunchConfig union. */
		default: return assertNever(config);
	}
}
function scriptBootstrapArgs(fs, bootstrapPath, maxMessageBytes) {
	if (bootstrapPath !== void 0) return [bootstrapPath, String(maxMessageBytes)];
	const mapped = (path) => {
		const result = fs.processPathFromHostPath(path);
		if (result === void 0) throw new Error(`PTC runtime bootstrap is unavailable in the subprocess execution world: ${path}`);
		return result;
	};
	/* v8 ignore next 3 -- built-lib.e2e.ts executes the bundled provider and sibling process.js under plain Node. */
	if (!new URL(import.meta.url).pathname.endsWith(".ts")) return [mapped(fileURLToPath(new URL("./process.js", import.meta.url))), String(maxMessageBytes)];
	const entry = mapped(fileURLToPath(new URL("./process.ts", import.meta.url)));
	const helper = mapped(resolve(dirname(fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-subprocess/package.json"))), "src/control.ts"));
	return [
		"--input-type=module",
		"--eval",
		`const {openInheritedControlChannel}=await import(${JSON.stringify(pathToFileURL(helper).href)});const {runNodeMain}=await import(${JSON.stringify(pathToFileURL(entry).href)});await runNodeMain(openInheritedControlChannel(),${maxMessageBytes},process);`
	];
}
//#endregion
//#region lib/types/config.js
/** Execution mode and resource limits for the Node PTC provider. */
/** Loader defaults for the Node PTC provider. */
const NodeConfig = z.object({
	executionMode: z.union([
		z.const("per-call"),
		z.const("persistent-in-memory"),
		z.const("vm-script")
	]).default("per-call"),
	scriptPersistence: z.boolean().default(false),
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
	if (config.scriptPersistence && config.executionMode !== "vm-script") throw new Error("ptc-runtime-node: scriptPersistence requires executionMode: vm-script");
	for (const [key, value] of Object.entries(config)) if (typeof value === "number" && (!Number.isFinite(value) || value <= 0)) throw new Error(`ptc-runtime-node: ${key} must be positive and finite`);
	for (const key of [
		"timeoutMs",
		"maxTimeoutMs",
		"graceMs"
	]) if (config[key] > MAX_TIMER_DELAY_MS) throw new Error(`ptc-runtime-node: ${key} exceeds the supported timer range`);
	if (!Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes < 4) throw new Error("ptc-runtime-node: maxOutputBytes must be an integer of at least 4");
	if (!Number.isSafeInteger(config.maxMessageBytes)) throw new Error("ptc-runtime-node: maxMessageBytes must be an integer");
	if (!Number.isSafeInteger(config.maxPendingCalls)) throw new Error("ptc-runtime-node: maxPendingCalls must be an integer");
	if (!Number.isSafeInteger(config.maxOldGenerationSizeMb)) throw new Error("ptc-runtime-node: maxOldGenerationSizeMb must be an integer");
}
//#endregion
//#region lib/types/json-wire.js
/**
* Lossless-JSON snapshots shared by the host and the source bootstrap closure.
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
* Invoke a host binding and encode its lossless result.
* @param binding - Current evaluation's function, absent if it was removed.
* @param args - Validated JSON arguments detached from the program.
* @returns Flat lossless JSON; unavailable bindings and invalid results reject.
*/
async function invokeBinding(binding, args) {
	if (!binding) throw new Error("binding is unavailable in this evaluation; reacquire the current tool");
	const value = snapshotJsonValue(await binding(args));
	if (value === void 0) throw new Error("binding resolution must be lossless JSON");
	return encodePtcJsonWire(value);
}
//#endregion
//#region lib/types/rpc.js
/** birpc over newline-delimited JSON on the bounded private process channel. */
const stringify = JSON.stringify;
const parse = JSON.parse;
const messageOf$1 = (error) => error instanceof Error ? error.message : String(error);
/**
* Connect typed methods over one control endpoint; execution owns all deadlines.
* @param stream - Owned control endpoint; `$close()` destroys it and rejects outstanding remote calls.
* @param maxMessageBytes - Maximum incoming JSON line and queued outgoing bytes.
* @param functions - Only these own methods may be called by the peer.
* @param eventNames - Remote methods sent as notifications without a response.
* @param failure - Receives the first I/O error, peer closure or malformed-message failure after the endpoint closes.
* @returns Typed remote calls and birpc lifetime controls.
*/
function createProcessRpc(stream, maxMessageBytes, functions, eventNames, failure) {
	const fail = (error, kind) => {
		if (rpc.$closed) return;
		rpc.$close();
		failure(error, kind);
	};
	let receive;
	const rpc = createBirpc(functions, {
		timeout: -1,
		eventNames,
		on: (listener) => {
			receive = listener;
		},
		off: () => {
			receive = void 0;
			stream.destroy();
		},
		serialize: (message) => `${stringify(message.e === void 0 ? message : {
			...message,
			e: { message: messageOf$1(message.e) }
		})}\n`,
		post: (line) => {
			if (rpc.$closed) return;
			if (stream.writableLength + Buffer$1.byteLength(line) > maxMessageBytes) fail(/* @__PURE__ */ new Error(`control output exceeds ${maxMessageBytes} queued bytes`), "protocol");
			else stream.write(line);
		},
		deserialize: (line) => {
			const message = parse(line);
			if (message.e) message.e = new Error(String(message.e.message));
			return message;
		},
		resolver: (name, fn) => Object.hasOwn(functions, name) ? (...args) => rpc.$closed ? void 0 : fn.apply(functions, args) : void 0
	});
	let parts = [];
	let size = 0;
	const buffer = (part) => {
		if (size === 0 && part.length > 0 && part[0] !== 123) throw new Error("control message is not a JSON object; the Node bootstrap may be from another release");
		size += part.length;
		if (size > maxMessageBytes) throw new Error(`RPC message exceeds ${maxMessageBytes} bytes`);
		parts.push(part);
	};
	stream.on("data", (chunk) => {
		try {
			let start = 0;
			for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
				buffer(chunk.subarray(start, end));
				const line = Buffer$1.concat(parts, size).toString("utf8");
				parts = [];
				size = 0;
				start = end + 1;
				Promise.resolve(receive?.(line)).catch((error) => {
					fail(error, "protocol");
				});
			}
			buffer(chunk.subarray(start));
		} catch (error) {
			fail(error, "protocol");
		}
	});
	stream.on("end", () => {
		if (size === 0) fail(/* @__PURE__ */ new Error("control channel ended before the program settled"), "closed");
		else fail(/* @__PURE__ */ new Error("incomplete RPC message"), "protocol");
	});
	stream.on("error", (error) => {
		fail(error, "io");
	});
	stream.on("close", () => {
		fail(/* @__PURE__ */ new Error("control channel closed"), "closed");
	});
	return rpc;
}
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
//#region lib/types/protocol.js
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/**
* Decode a remote run result without trusting model-written control traffic.
* @param result - Untrusted result returned by the program process.
* @returns Decoded completion or failure; malformed envelopes throw a protocol error.
*/
function readProgramResult(result) {
	if (!record(result)) throw new Error("invalid program result");
	if (result.error !== void 0) {
		const error = result.error;
		if (!record(error) || typeof error.message !== "string" || error.kind !== "exception" && error.kind !== "invalid-output" && error.kind !== "output-limit") throw new Error("invalid terminal error");
		return { error: {
			kind: error.kind,
			message: error.message
		} };
	}
	if (result.value === void 0) return {};
	const value = decodePtcJsonWire(result.value);
	return value === void 0 ? { error: {
		kind: "invalid-output",
		message: "program completion must be lossless JSON"
	} } : { value };
}
//#endregion
//#region lib/types/worker.js
/** Managed Node process shared by temporary and owner-retained evaluations. */
const messageOf = (error) => error instanceof Error ? error.message : String(error);
/** One managed process; all mutable program state belongs to this process alone. */
var ProgramWorker = class {
	ctx;
	config;
	policy;
	mode;
	retainsState;
	unregister;
	confined;
	handle;
	channel;
	active;
	/** Admission remains reserved until the result includes completed process cleanup. */
	running = false;
	cleanupPending = false;
	ready = false;
	stderr = "";
	controlFailure;
	stopped;
	starting;
	exitOutcome;
	controller = new AbortController();
	closed = false;
	/** Whether termination succeeded and this process no longer needs cleanup retries. */
	get cleanupComplete() {
		return this.closed && !this.cleanupPending;
	}
	/**
	* Own one process under a fixed file policy.
	* @param ctx - Provider execution services.
	* @param config - Validated resource limits and launch selection.
	* @param policy - Authority retained for the lifetime of this process.
	* @param processes - Session policy invalidation and cleanup coordination.
	* @param mode - Evaluator syntax and TypeScript erasure.
	* @param retainsState - Whether this process belongs to an owner and survives completed evaluations.
	*/
	constructor(ctx, config, policy, processes, mode, retainsState) {
		this.ctx = ctx;
		this.config = config;
		this.policy = policy;
		this.mode = mode;
		this.retainsState = retainsState;
		this.unregister = processes.register(policy, () => this.dispose());
	}
	/** Reject reuse until the previous evaluation and required cleanup settle. */
	assertIdle() {
		if (this.running) throw new Error("persistent PTC does not accept concurrent runs for one state owner");
		if (this.cleanupPending) throw new Error("persistent PTC environment cleanup is incomplete; release the owner before running another program");
	}
	/**
	* Evaluate a program, retaining this process only for an enabled state owner.
	* @param spec - Resolved program inputs and cancellation.
	* @param bindings - Current host binding implementations.
	* @returns Output after any required process cleanup.
	*/
	async run(spec, bindings) {
		this.running = true;
		const sandbox = {
			mode: this.policy.mode,
			denied: false
		};
		try {
			const result = await this.evaluate(spec, bindings);
			if (this.confined !== void 0) {
				sandbox.enforcement = this.confined.enforcement;
				sandbox.denied ||= result.error?.kind !== "sandbox-unavailable" && this.confined.denialSignatures.some((signature) => result.error?.message.toLowerCase().includes(signature.toLowerCase()));
			}
			return {
				...result,
				sandbox
			};
		} finally {
			this.running = false;
		}
	}
	output() {
		return new OutputLedger(this.config.maxOutputBytes, this.retainsState ? `retained variables were cleared; outer output exceeded ${this.config.maxOutputBytes} bytes` : void 0);
	}
	message(message) {
		return this.retainsState ? `${message}; retained variables were cleared` : message;
	}
	abortMessage(signal) {
		return this.retainsState ? "execution canceled; retained variables were cleared" : messageOf(signal?.reason);
	}
	async evaluate(spec, bindings) {
		if (this.exitOutcome !== void 0) {
			const output = this.output();
			const failure = spec.signal?.aborted ? {
				kind: "abort",
				message: this.abortMessage(spec.signal)
			} : {
				kind: "worker-exit",
				message: this.message(this.exitMessage(this.exitOutcome))
			};
			try {
				await this.stop();
			} catch (error) {
				return output.failure([], {
					kind: "worker-exit",
					message: `managed process cleanup failed: ${messageOf(error)}`
				});
			}
			return output.failure([], failure);
		}
		this.stderr = "";
		const output = this.output();
		const logs = [];
		let overflowed = false;
		const result = Promise.withResolvers();
		const timer = spec.timeoutMs === null ? void 0 : setTimeout(() => {
			evaluation.finish({
				kind: "timeout",
				message: this.message(`execution deadline reached (${spec.timeoutMs}ms)`)
			}, void 0, true);
		}, spec.timeoutMs);
		const onAbort = () => {
			evaluation.finish({
				kind: "abort",
				message: this.abortMessage(spec.signal)
			}, void 0, true);
		};
		const evaluation = {
			settled: false,
			data: {
				code: "",
				programFormat: this.mode.format,
				retainsState: this.retainsState,
				maxOutputBytes: this.config.maxOutputBytes,
				namespaces: [...bindings.values()].map((binding) => ({
					global: binding.global,
					names: Object.keys(binding.functions),
					...binding.errorClass ? { errorClass: binding.errorClass } : {}
				}))
			},
			spec,
			bindings,
			invoke: AsyncLocalStorage.bind(invokeBinding),
			pending: 0,
			pendingBytes: 0,
			admit: (text) => {
				if (overflowed) return;
				if (!output.admit(text, logs)) {
					overflowed = true;
					logs.push(text);
					evaluation.finish({
						kind: "output-limit",
						message: "output limit exceeded"
					}, void 0, true);
				}
			},
			finish: (error, value, discard = false) => {
				if (evaluation.settled) return;
				evaluation.settled = true;
				clearTimeout(timer);
				spec.signal?.removeEventListener("abort", onAbort);
				const complete = () => overflowed || error?.kind === "output-limit" ? output.limit(logs) : error ? output.failure(logs, error) : output.success(logs, value);
				const outcome = complete();
				(discard || outcome.error?.kind === "output-limit" || !this.retainsState ? this.stop() : Promise.resolve(true)).then((drained) => {
					this.active = void 0;
					result.resolve(drained ? complete() : output.failure(logs, {
						kind: "worker-exit",
						message: "managed process exited but its output did not drain cleanly"
					}));
				}, (failure) => {
					this.active = void 0;
					result.resolve(output.failure(logs, {
						kind: "worker-exit",
						message: `managed process cleanup failed: ${messageOf(failure)}`
					}));
				});
			}
		};
		this.active = evaluation;
		spec.signal?.addEventListener("abort", onAbort, { once: true });
		if (spec.signal?.aborted) onAbort();
		else {
			try {
				evaluation.data.code = this.mode.stripTypes(spec.program);
			} catch (error) {
				evaluation.finish({
					kind: "exception",
					message: messageOf(error)
				});
				return await result.promise;
			}
			if (this.ready) this.dispatch(evaluation);
			else {
				this.starting = this.start(spec.cwd);
				this.starting.catch((error) => {
					this.fail(error instanceof SandboxUnavailableError || this.confined !== void 0 && isRunnerSpawnFailure(error, this.confined.argv[0], spec.cwd) ? "sandbox-unavailable" : "worker-exit", messageOf(error));
				});
			}
		}
		return await result.promise;
	}
	/** Cancel active work and await managed process termination and output drainage. */
	async dispose() {
		this.active?.finish({
			kind: "abort",
			message: this.message("PTC environment disposed")
		}, void 0, true);
		await this.stop();
	}
	stop() {
		if (this.stopped) return this.stopped;
		this.closed = true;
		this.cleanupPending = true;
		this.controller.abort();
		this.channel?.$close();
		this.stopped = (async () => {
			await this.starting?.catch((_error) => {});
			const handle = this.handle;
			return handle === void 0 || await terminateProcess(handle, this.config.graceMs);
		})().then((drained) => {
			this.unregister?.();
			this.cleanupPending = false;
			if (!drained) this.ctx.logger.warn("Node process exited but its output did not drain cleanly");
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
			message: this.message(message)
		}, void 0, true);
		else {
			if (!this.closed) this.ctx.logger.warn(message);
			this.stop().catch((error) => {
				this.ctx.logger.warn(messageOf(error));
			});
		}
	}
	dispatch(evaluation) {
		this.channel?.run(evaluation.spec.cwd, evaluation.data).then((raw) => {
			if (evaluation.settled) return;
			const { error, value } = readProgramResult(raw);
			setImmediate(() => {
				evaluation.finish(error, value);
			});
		}).catch((error) => {
			if (this.active === evaluation && !this.channel?.$closed) this.fail("protocol", messageOf(error));
		});
	}
	withControlFailure(message) {
		return this.controlFailure === void 0 ? message : `${message}; control channel failed: ${this.controlFailure}`;
	}
	exitMessage(outcome) {
		return this.withControlFailure(`Node process exited (${String(outcome.exitCode)}, signal ${String(outcome.signal)})${this.stderr ? `: ${this.stderr}` : ""}`);
	}
	async start(cwd) {
		const executable = await this.ctx.subprocess.resolveExecutable(this.config.launch.executable, void 0, this.controller.signal);
		if (this.closed) return;
		const packaged = this.config.launch.kind === "embedded";
		const heapFlag = `--max-old-space-size=${this.config.maxOldGenerationSizeMb}`;
		const argv = [
			executable,
			...packaged ? [] : [heapFlag],
			...bootstrapArgs(this.ctx.fs, this.config.launch, this.config.maxMessageBytes, this.retainsState)
		];
		const policy = this.policy;
		this.confined = policy.mode === "danger-full-access" ? void 0 : await this.ctx.sandbox.confine(argv, {
			...policy,
			mode: policy.mode
		}, this.controller.signal);
		if (this.closed) return;
		const env = Object.fromEntries(Object.keys(process.env).filter((key) => !STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase()) && key.toUpperCase() !== "ELECTRON_RUN_AS_NODE").map((key) => [key, void 0]));
		if (packaged) {
			env.DSH_PTC_RUNTIME_NODE = "1";
			env.NODE_OPTIONS = heapFlag;
		}
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
		if (!handle.control || !handle.stdout || !handle.stderr) throw new Error("subprocess provider did not supply the requested control and output pipes");
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
		const refuse = (message) => {
			this.fail("protocol", message);
			throw new Error(message);
		};
		this.channel = createProcessRpc(handle.control, this.config.maxMessageBytes, {
			ready: () => {
				if (this.ready || !this.active) {
					this.fail("protocol", "duplicate program readiness");
					return;
				}
				this.ready = true;
				this.dispatch(this.active);
			},
			log: (text) => {
				if (!this.ready || this.active === void 0 || typeof text !== "string") this.fail("protocol", "invalid program log");
				else this.active.admit(text);
			},
			outputLimit: () => {
				if (!this.ready || this.active === void 0) this.fail("protocol", "idle PTC output limit");
				else this.active.finish({
					kind: "output-limit",
					message: "output limit exceeded"
				}, void 0, true);
			},
			invoke: async (global, name, wire) => {
				const evaluation = this.active;
				if (!this.ready || evaluation === void 0 || evaluation.settled) return refuse("binding call arrived without an active PTC evaluation");
				const functions = evaluation.bindings.get(global)?.functions;
				const fn = functions !== void 0 && Object.hasOwn(functions, name) ? functions[name] : void 0;
				if (!this.mode.retainsState && typeof fn !== "function") return refuse("program requested an undeclared binding");
				const args = decodePtcJsonWire(wire);
				if (args === void 0) return refuse("binding arguments must be lossless JSON");
				const bytes = Buffer.byteLength(JSON.stringify(wire));
				if (evaluation.pending >= this.config.maxPendingCalls || evaluation.pendingBytes + bytes > this.config.maxMessageBytes) return refuse("pending binding calls exceed configured limits");
				evaluation.pending += 1;
				evaluation.pendingBytes += bytes;
				try {
					const value = await evaluation.invoke(fn, args);
					if (this.active !== evaluation || evaluation.settled) throw new Error("PTC evaluation ended before the binding completed");
					return value;
				} finally {
					evaluation.pending -= 1;
					evaluation.pendingBytes -= bytes;
				}
			}
		}, [], (error, kind) => {
			if (kind === "protocol") this.fail("protocol", error.message);
			else {
				if (kind === "io") this.controlFailure = error.message;
				setImmediate(() => {
					if (!this.closed && this.exitOutcome === void 0) handle.terminate();
				});
			}
		});
		handle.done.then(async (outcome) => {
			this.exitOutcome = outcome;
			await Promise.all([drainOutput(handle.stdout, this.config.graceMs), drainOutput(handle.stderr, this.config.graceMs)]);
			setImmediate(() => {
				if (!this.closed) this.fail(this.confined !== void 0 && classifyRunnerFailure(outcome.exitCode, this.stderr, this.confined.runnerFailureRules) !== void 0 ? "sandbox-unavailable" : "worker-exit", this.exitMessage(outcome));
			});
		}, (error) => {
			this.fail(this.confined !== void 0 && isRunnerSpawnFailure(error, this.confined.argv[0], cwd) ? "sandbox-unavailable" : "worker-exit", this.withControlFailure(messageOf(error)));
		});
	}
};
//#endregion
//#region lib/types/execution.js
/** Select program syntax and own temporary or retained Node processes. */
/**
* Select program semantics and create their shared process owner.
* @param ctx - Provider lifecycle and execution services.
* @param config - Validated configuration with loader defaults.
* @param processes - Policy invalidation and process cleanup coordination.
* @returns Mode selection and temporary or retained execution through one process implementation.
*/
function createExecution(ctx, config, processes) {
	return new NodeExecution(ctx, config, processes, resolveMode(config));
}
/** Temporary processes and optional object-owned reuse share one process implementation. */
var NodeExecution = class {
	ctx;
	config;
	processes;
	mode;
	owners = /* @__PURE__ */ new WeakMap();
	workers = /* @__PURE__ */ new Set();
	/**
	* Own process instances and optional owner lookup for one provider.
	* @param ctx - Provider lifecycle and execution services.
	* @param config - Validated limits and selected executable.
	* @param processes - Provider-owned policy invalidation and cleanup.
	* @param mode - Program syntax and TypeScript erasure.
	*/
	constructor(ctx, config, processes, mode) {
		this.ctx = ctx;
		this.config = config;
		this.processes = processes;
		this.mode = mode;
		if (mode.retainsState && this.config.launch.kind === "embedded") throw new Error("Persistent PTC requires a node-script launch");
	}
	/** Stop every owned process, retaining failed cleanup for a later retry. */
	async dispose() {
		const failed = (await Promise.allSettled([...this.workers].map(async (worker) => {
			await worker.dispose();
			this.workers.delete(worker);
		}))).find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
	}
	/**
	* Resolve the common file policy, directory and deadline defaults.
	* @param request - Program, bindings, owner, directory and elapsed budget.
	* @returns Resolved inputs with the selected file policy.
	*/
	resolve(request) {
		const sandboxPolicy = request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
		const cwd = request.cwd ?? sandboxPolicy.workspaceRoot;
		if (!isAbsolute(cwd)) throw new Error(`${this.mode.retainsState ? "persistent PTC" : "ptc-runtime-node"}: cwd must be absolute`);
		return {
			...request,
			sandboxPolicy,
			cwd,
			timeoutMs: request.timeoutMs === null ? null : clampTimeout(request.timeoutMs, this.config.timeoutMs, this.config.maxTimeoutMs, this.mode.retainsState ? "persistent PTC timeoutMs" : "ptc-runtime-node: timeoutMs")
		};
	}
	/**
	* Evaluate in a temporary process or reuse an enabled state owner's process.
	* @param spec - Resolved request; concurrent calls for one owner are rejected.
	* @returns Captured logs, JSON completion, or a structured execution failure.
	*/
	async run(spec) {
		if (spec.sandboxPolicy === void 0) throw new Error("ptc-runtime-node: run requires a resolved sandbox policy");
		if (!isAbsolute(spec.cwd) || spec.timeoutMs !== null && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0 || spec.timeoutMs > this.config.maxTimeoutMs)) throw new Error("ptc-runtime-node: run requires resolved cwd and timeout");
		const bindings = validateBindings(spec);
		const owner = this.mode.retainsState ? spec.stateOwner : void 0;
		let worker = owner === void 0 ? void 0 : this.owners.get(owner);
		worker?.assertIdle();
		if (worker && !worker.closed && (worker.policy.mode !== spec.sandboxPolicy.mode || worker.policy.workspaceRoot !== spec.sandboxPolicy.workspaceRoot || worker.policy.sessionId !== spec.sandboxPolicy.sessionId || !sameAdditionalRoots(worker.policy.additionalWritableRoots, spec.sandboxPolicy.additionalWritableRoots))) throw new Error("persistent PTC: release the retained environment before changing its sandbox policy");
		if (!worker || worker.closed) {
			if (worker) this.workers.delete(worker);
			worker = new ProgramWorker(this.ctx, this.config, {
				...spec.sandboxPolicy,
				...spec.sandboxPolicy.additionalWritableRoots === void 0 ? {} : { additionalWritableRoots: [...spec.sandboxPolicy.additionalWritableRoots] }
			}, this.processes, this.mode, owner !== void 0);
			this.workers.add(worker);
			if (owner !== void 0) this.owners.set(owner, worker);
		}
		try {
			return await worker.run(spec, bindings);
		} finally {
			if (owner === void 0 && worker.cleanupComplete) this.workers.delete(worker);
		}
	}
	/**
	* Release retained state and await its process cleanup.
	* @param owner - Exact object supplied to run.
	* @returns Completion after the owned process and output streams stop.
	*/
	async release(owner) {
		const worker = this.owners.get(owner);
		if (!worker) return;
		await worker.dispose();
		if (this.owners.get(owner) === worker) this.owners.delete(owner);
		this.workers.delete(worker);
	}
};
/**
* Compare requested extra grants without resolving paths in another execution world.
* @param left - one policy's additional roots.
* @param right - the other policy's additional roots.
* @returns whether both contain the same paths, ignoring order and duplicates.
*/
function sameAdditionalRoots(left, right) {
	const effective = (roots) => [...new Set(roots ?? [])].sort();
	const a = effective(left);
	const b = effective(right);
	return a.length === b.length && a.every((root, index) => root === b[index]);
}
const STRIP_PREFIX = "async function __dsh_program__() {\n";
const STRIP_SUFFIX = "\n}";
function resolveMode(config) {
	switch (config.executionMode) {
		case "per-call": return {
			format: "function-body",
			retainsState: false,
			executionInstructions: "The program is the body of an async TypeScript function; only erasable syntax is accepted, with no enum or namespaces. Type annotations are advisory. Top-level await and return are supported. Emit output with console.log(...) or return a lossless JSON value. Only printed values and the returned value become program output. Each call runs in a fresh Node process. Node APIs are available through await import(...). Relative paths use the supplied working directory; process.env starts empty. Direct filesystem access follows this execution's sandbox policy.",
			stripTypes(program) {
				const stripped = stripTypeScriptTypes(STRIP_PREFIX + program + STRIP_SUFFIX);
				return stripped.slice(35, stripped.length - 2);
			}
		};
		case "persistent-in-memory": return {
			format: "repl",
			retainsState: true,
			executionInstructions: "The program contains TypeScript REPL statements; only erasable syntax is accepted, with no enum or namespaces. Type annotations are advisory. Top-level declarations and await are supported; top-level return is not supported. Emit output with console.log(...) or a final lossless JSON expression. Only printed values and that final expression become program output. Variables, functions, and imported modules remain in memory for this Agent across calls. Use await import(...) for modules. Direct filesystem access follows this execution's sandbox policy; process.env starts empty. Changing the session sandbox mode clears retained variables. An approved sandbox escalation runs in a separate temporary environment: it cannot access retained variables, and its declarations are discarded afterward. Restart, Agent disposal, cancellation, timeout, output overflow, or process failure clears the environment. If a variable is undefined, recreate it and reacquire its resources. State is not restored from the conversation, and failed evaluations can leave earlier mutations in memory. Redeclaring an existing let, const, or class name fails; assign to a mutable binding or use a new name. Await all tool calls; background callbacks cannot call tools after their evaluation ends. Await child-process completion before ending an evaluation; raw subprocess output belongs to whichever evaluation is active when it arrives.",
			stripTypes: stripTypeScriptTypes
		};
		case "vm-script": {
			const lifetime = config.scriptPersistence ? "Variables, functions, and imported modules remain in memory for this Agent across calls." : "Each call runs in a fresh Node process.";
			const asynchronousFailure = "Await asynchronous work: an uncaught callback exception or unhandled rejection terminates the process" + (config.scriptPersistence ? " and clears its variables." : ".");
			const recovery = config.scriptPersistence ? " Changing the session sandbox mode clears retained variables. An approved sandbox escalation runs in a separate temporary environment: it cannot access retained variables, and its declarations are discarded afterward. Restart, Agent disposal, cancellation, timeout, output overflow, or process failure clears the environment. If a variable is undefined, recreate it and reacquire its resources. State is not restored from the conversation, and failed evaluations can leave earlier mutations in memory. Redeclaring an existing let, const, or class name fails; assign to a mutable binding or use a new name. Await all tool calls; background callbacks cannot call tools after their evaluation ends. Await child-process completion before ending an evaluation; raw subprocess output belongs to whichever evaluation is active when it arrives. If a native top-level let, const, or class initializer throws, its name may remain permanently uninitialized; use a new name or restart the environment." : "";
			return {
				format: "script",
				retainsState: config.scriptPersistence,
				executionInstructions: "The program contains TypeScript script statements; only erasable syntax is accepted, with no enum or namespaces. Type annotations are advisory. Top-level declarations and await are supported; top-level return is not supported. Emit output with console.log(...) or a final lossless JSON expression. The final expression is awaited if it is a Promise. Only printed values and that final expression become program output. " + lifetime + " Use await import(...) for modules. Relative paths use the supplied working directory. Direct filesystem access follows this execution's sandbox policy; process.env starts empty. " + asynchronousFailure + " Values from bindings and imports can belong to another realm; use Array.isArray for arrays and the supplied binding error classes for failures, because instanceof Array or Error may be false." + recovery,
				stripTypes: stripTypeScriptTypes
			};
		}
		/* v8 ignore next -- Loader validates the closed execution-mode union before selection. */
		default: return assertNever(config.executionMode);
	}
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
//#region lib/types/index.js
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
	execution;
	processes;
	get programFormat() {
		return this.execution.mode.format;
	}
	get retainsState() {
		return this.execution.mode.retainsState;
	}
	get executionInstructions() {
		return this.execution.mode.executionInstructions;
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
		this.execution = createExecution(ctx, this.config, this.processes);
		ctx.effect(() => async () => {
			this.disposed = true;
			const active = [...this.live];
			for (const run of active) run.controller.abort("runtime disposed");
			const failed = (await Promise.allSettled([this.execution.dispose(), ...active.map((run) => run.finished)])).find((result) => result.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
		}, "Node ptc-runtime cleanup");
	}
	get sandboxMode() {
		return this.ctx.sandboxPolicy.defaultMode;
	}
	release(owner) {
		return this.execution.release(owner);
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
		if (this.disposed) {
			const source = this.retainsState ? "persistent PTC" : "ptc-runtime-node";
			throw new Error(`${source}: resolve after disposal`);
		}
		return this.execution.resolve(request);
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
			if (this.disposed) throw new Error(`${this.retainsState ? "persistent PTC" : "ptc-runtime-node"}: run after disposal`);
			const signal = spec.signal === void 0 ? controller.signal : AbortSignal.any([spec.signal, controller.signal]);
			return await this.execution.run({
				...spec,
				signal
			});
		} finally {
			unregister?.();
			this.live.delete(live);
			completion.resolve();
		}
	}
};
//#endregion
export { NodePtcRuntime, NodePtcRuntime as default };
