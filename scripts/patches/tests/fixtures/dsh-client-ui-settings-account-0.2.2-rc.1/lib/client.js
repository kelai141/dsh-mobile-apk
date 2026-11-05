window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-settings-account",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_dom = require("react-dom");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		//#region ../../../vendor/cosmokit/src/misc.ts
		/** Return true when a value is `null` or `undefined`. */
		function isNullable(value) {
			return value === null || value === void 0;
		}
		/** Return true for non-array object values. */
		function isPlainObject(data) {
			return data && typeof data === "object" && !Array.isArray(data);
		}
		/** Filter object entries and return a new object. */
		function filterKeys(object, filter) {
			return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
		}
		/** Map object values while preserving the original key set. */
		function mapValues(object, transform) {
			return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
		}
		/** Pick selected keys from an object, optionally including `undefined` values. */
		function pick(source, keys, forced) {
			if (!keys) return { ...source };
			const result = {};
			for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
			return result;
		}
		//#endregion
		//#region ../../../vendor/cosmokit/src/volatile.ts
		/** Shared config references used by schema validators and plugin runtimes. */
		const write = Symbol.for("cosmokit.volatile.write");
		function snapshot(value, ancestors = /* @__PURE__ */ new Set()) {
			if (typeof value === "function") throw new TypeError("volatile config cannot contain functions");
			if (value === null || typeof value !== "object") return value;
			if (ancestors.has(value)) throw new TypeError("volatile config cannot contain cycles");
			ancestors.add(value);
			try {
				if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, ancestors)));
				if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("volatile config objects must be plain objects or arrays");
				return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, ancestors)])));
			} finally {
				ancestors.delete(value);
			}
		}
		/**
		* Create a detached reference containing an immutable copy of the supplied data.
		* @param value - validated config data; class instances and functions are unsupported.
		* @returns a reference whose value is updated only by its owning runtime.
		*/
		function createVolatile(value) {
			let current = snapshot(value);
			return Object.freeze({
				get: () => current,
				[write]: (value) => {
					current = value;
				}
			});
		}
		/**
		* Identify references across ESM/CJS copies of the shared library.
		* @param value - a parsed config value.
		* @returns whether the value implements the shared reference protocol.
		*/
		function isVolatile(value) {
			return typeof value === "object" && value !== null && write in value;
		}
		//#endregion
		//#region ../../../vendor/cosmokit/src/types.ts
		/** Test values using `instanceof` with a `toStringTag` fallback. */
		function is(type, value) {
			if (arguments.length === 1) return (value) => is(type, value);
			return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
		}
		function isArrayBufferLike(value) {
			return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
		}
		function isArrayBufferSource(value) {
			return isArrayBufferLike(value) || ArrayBuffer.isView(value);
		}
		let Binary;
		(function(_Binary) {
			_Binary.is = isArrayBufferLike;
			_Binary.isSource = isArrayBufferSource;
			function fromSource(source) {
				if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
				else return source;
			}
			_Binary.fromSource = fromSource;
			function toBase64(source) {
				source = fromSource(source);
				if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
				let binary = "";
				const bytes = new Uint8Array(source);
				for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
				return btoa(binary);
			}
			_Binary.toBase64 = toBase64;
			function fromBase64(source) {
				if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
				return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
			}
			_Binary.fromBase64 = fromBase64;
			function toHex(source) {
				source = fromSource(source);
				if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
				return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
			}
			_Binary.toHex = toHex;
			function fromHex(source) {
				if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
				const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
				const buffer = [];
				for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
				return Uint8Array.from(buffer).buffer;
			}
			_Binary.fromHex = fromHex;
		})(Binary || (Binary = {}));
		Binary.fromBase64;
		Binary.toBase64;
		Binary.fromHex;
		Binary.toHex;
		/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
		function clone(source, refs = /* @__PURE__ */ new Map()) {
			if (!source || typeof source !== "object") return source;
			if (is("Date", source)) return new Date(source.valueOf());
			if (is("RegExp", source)) return new RegExp(source.source, source.flags);
			if (isArrayBufferLike(source)) return source.slice(0);
			if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
			const cached = refs.get(source);
			if (cached) return cached;
			if (Array.isArray(source)) {
				const result = [];
				refs.set(source, result);
				source.forEach((value, index) => {
					result[index] = Reflect.apply(clone, null, [value, refs]);
				});
				return result;
			}
			const result = Object.create(Object.getPrototypeOf(source));
			refs.set(source, result);
			for (const key of Reflect.ownKeys(source)) {
				const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
				if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
				Reflect.defineProperty(result, key, descriptor);
			}
			return result;
		}
		/**
		* Compare values recursively, treating two volatile references as equal regardless of value.
		* Strict comparison distinguishes null/undefined, treats opaque objects by identity,
		* compares URLs by normalized href, treats array holes as undefined, and considers distinct cyclic structures unequal.
		* @param a - first value.
		* @param b - second value.
		* @param strict - whether to require strict data equality outside volatile references.
		* @returns whether the values compare equal.
		*/
		function deepEqual(a, b, strict) {
			const ancestors = /* @__PURE__ */ new Set();
			function compare(a, b) {
				if (a === b) return true;
				if (isVolatile(a) || isVolatile(b)) return isVolatile(a) && isVolatile(b);
				if (!strict && isNullable(a) && isNullable(b)) return true;
				if (typeof a !== typeof b || typeof a !== "object" || !a || !b) return false;
				if (ancestors.has(a)) return false;
				function check(test, then) {
					return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
				}
				ancestors.add(a);
				try {
					return check(Array.isArray, (a, b) => {
						if (a.length !== b.length) return false;
						for (let index = 0; index < a.length; index++) if (!compare(a[index], b[index])) return false;
						return true;
					}) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("URL"), (a, b) => a.href === b.href) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
						if (a.byteLength !== b.byteLength) return false;
						const viewA = new Uint8Array(a);
						const viewB = new Uint8Array(b);
						for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
						return true;
					}) ?? ((!strict || [a, b].every((value) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) && Object.keys({
						...a,
						...b
					}).every((key) => compare(a[key], b[key])));
				} finally {
					ancestors.delete(a);
				}
			}
			return compare(a, b);
		}
		//#endregion
		//#region ../../../vendor/cosmokit/src/time.ts
		let Time;
		(function(_Time) {
			_Time.millisecond = 1;
			const second = _Time.second = 1e3;
			const minute = _Time.minute = second * 60;
			const hour = _Time.hour = minute * 60;
			const day = _Time.day = hour * 24;
			const week = _Time.week = day * 7;
			let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
			function setTimezoneOffset(offset) {
				timezoneOffset = offset;
			}
			_Time.setTimezoneOffset = setTimezoneOffset;
			function getTimezoneOffset() {
				return timezoneOffset;
			}
			_Time.getTimezoneOffset = getTimezoneOffset;
			function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
				if (typeof date === "number") date = new Date(date);
				if (offset === void 0) offset = timezoneOffset;
				return Math.floor((date.valueOf() / minute - offset) / 1440);
			}
			_Time.getDateNumber = getDateNumber;
			function fromDateNumber(value, offset) {
				const date = new Date(value * day);
				if (offset === void 0) offset = timezoneOffset;
				return new Date(+date + offset * minute);
			}
			_Time.fromDateNumber = fromDateNumber;
			const numeric = /\d+(?:\.\d+)?/.source;
			const timeRegExp = new RegExp(`^${[
				"w(?:eek(?:s)?)?",
				"d(?:ay(?:s)?)?",
				"h(?:our(?:s)?)?",
				"m(?:in(?:ute)?(?:s)?)?",
				"s(?:ec(?:ond)?(?:s)?)?"
			].map((unit) => `(${numeric}${unit})?`).join("")}$`);
			function parseTime(source) {
				const capture = timeRegExp.exec(source);
				if (!capture) return 0;
				return (parseFloat(capture[1]) * week || 0) + (parseFloat(capture[2]) * day || 0) + (parseFloat(capture[3]) * hour || 0) + (parseFloat(capture[4]) * minute || 0) + (parseFloat(capture[5]) * second || 0);
			}
			_Time.parseTime = parseTime;
			function parseDate(date) {
				const parsed = parseTime(date);
				if (parsed) date = Date.now() + parsed;
				else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
				else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
				return date ? new Date(date) : /* @__PURE__ */ new Date();
			}
			_Time.parseDate = parseDate;
			function format(ms) {
				const abs = Math.abs(ms);
				if (abs >= day - hour / 2) return Math.round(ms / day) + "d";
				else if (abs >= hour - minute / 2) return Math.round(ms / hour) + "h";
				else if (abs >= minute - second / 2) return Math.round(ms / minute) + "m";
				else if (abs >= second) return Math.round(ms / second) + "s";
				return ms + "ms";
			}
			_Time.format = format;
			function toDigits(source, length = 2) {
				return source.toString().padStart(length, "0");
			}
			_Time.toDigits = toDigits;
			function template(template, time = /* @__PURE__ */ new Date()) {
				return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
			}
			_Time.template = template;
		})(Time || (Time = {}));
		//#endregion
		//#region ../../../vendor/schemastery/src/index.ts
		const kSchema = Symbol.for("schemastery");
		const kValidationError = Symbol.for("ValidationError");
		globalThis.__schemastery_index__ ??= 0;
		globalThis.__schemastery_refs__ = void 0;
		var ValidationError = class extends TypeError {
			options;
			name = "ValidationError";
			constructor(message, options) {
				let prefix = "$";
				for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
				else if (typeof segment === "number") prefix += "[" + segment + "]";
				else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
				if (prefix.startsWith(".")) prefix = prefix.slice(1);
				super((prefix === "$" ? "" : `${prefix} `) + message);
				this.options = options;
			}
			static is(error) {
				return !!error?.[kValidationError];
			}
		};
		Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
		const Schema = function(options) {
			const schema = function(data, options = {}) {
				return Schema.resolve(data, schema, options)[0];
			};
			if (options.refs) {
				const refs = mapValues(options.refs, (options) => new Schema(options));
				const getRef = (uid) => refs[uid];
				for (const key in refs) {
					const options = refs[key];
					options.sKey = getRef(options.sKey);
					options.inner = getRef(options.inner);
					options.list = options.list && options.list.map(getRef);
					options.dict = options.dict && mapValues(options.dict, getRef);
				}
				return refs[options.uid];
			}
			Object.assign(schema, options);
			if (typeof schema.callback === "string") try {
				schema.callback = new Function("return " + schema.callback)();
			} catch {}
			Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
			Object.setPrototypeOf(schema, Schema.prototype);
			schema.meta ||= {};
			schema.toString = schema.toString.bind(schema);
			return schema;
		};
		Schema.prototype = Object.create(Function.prototype);
		Schema.prototype[kSchema] = true;
		Object.defineProperty(Schema.prototype, "~standard", { get() {
			return {
				version: 1,
				vendor: "schemastery",
				validate: (value) => {
					try {
						return { value: Schema.resolve(value, this, {})[0] };
					} catch (error) {
						if (ValidationError.is(error)) return { issues: [{
							message: error.message,
							path: error.options.path
						}] };
						throw error;
					}
				}
			};
		} });
		Schema.ValidationError = ValidationError;
		Schema.prototype.toJSON = function toJSON() {
			if (globalThis.__schemastery_refs__) {
				globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
				return this.uid;
			}
			globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
			globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
			const result = {
				uid: this.uid,
				refs: globalThis.__schemastery_refs__
			};
			globalThis.__schemastery_refs__ = void 0;
			return result;
		};
		Schema.prototype.set = function set(key, value) {
			this.dict[key] = value;
			return this;
		};
		Schema.prototype.push = function push(value) {
			this.list.push(value);
			return this;
		};
		function mergeDesc(original, messages) {
			const result = typeof original === "string" ? { "": original } : { ...original };
			for (const locale in messages) {
				const value = messages[locale];
				if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
				else if (typeof value === "string") result[locale] = value;
			}
			return result;
		}
		function getInner(value) {
			return value?.$value ?? value?.$inner;
		}
		function extractKeys(data) {
			return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
		}
		Schema.prototype.i18n = function i18n(messages) {
			const schema = Schema(this);
			const desc = mergeDesc(schema.meta.description, messages);
			if (Object.keys(desc).length) schema.meta.description = desc;
			if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
				return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
			});
			if (schema.list) schema.list = schema.list.map((inner, index) => {
				return inner.i18n(mapValues(messages, (data = {}) => {
					if (Array.isArray(getInner(data))) return getInner(data)[index];
					if (Array.isArray(data)) return data[index];
					return extractKeys(data);
				}));
			});
			if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
				if (getInner(data)) return getInner(data);
				return extractKeys(data);
			}));
			if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
			return schema;
		};
		Schema.prototype.extra = function extra(key, value) {
			const schema = Schema(this);
			schema.meta = {
				...schema.meta,
				[key]: value
			};
			return schema;
		};
		for (const key of [
			"required",
			"disabled",
			"collapse",
			"hidden",
			"loose"
		]) Object.assign(Schema.prototype, { [key](value = true) {
			const schema = Schema(this);
			schema.meta = {
				...schema.meta,
				[key]: value
			};
			return schema;
		} });
		Schema.prototype.deprecated = function deprecated() {
			const schema = Schema(this);
			schema.meta.badges ||= [];
			schema.meta.badges.push({
				text: "deprecated",
				type: "danger"
			});
			return schema;
		};
		Schema.prototype.experimental = function experimental() {
			const schema = Schema(this);
			schema.meta.badges ||= [];
			schema.meta.badges.push({
				text: "experimental",
				type: "warning"
			});
			return schema;
		};
		Schema.prototype.pattern = function pattern(regexp) {
			const schema = Schema(this);
			const pattern = pick(regexp, ["source", "flags"]);
			schema.meta = {
				...schema.meta,
				pattern
			};
			return schema;
		};
		Schema.prototype.simplify = function simplify(value) {
			if (isVolatile(value)) value = value.get();
			if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
			if (isNullable(value)) return value;
			if (this.type === "object" || this.type === "dict") {
				const result = {};
				for (const key in value) {
					const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
					if (this.type === "dict" || !isNullable(item)) result[key] = item;
				}
				if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
				return result;
			} else if (this.type === "array" || this.type === "tuple") {
				const result = [];
				value.forEach((value, index) => {
					const schema = this.type === "array" ? this.inner : this.list[index];
					const item = schema ? schema.simplify(value) : value;
					result.push(item);
				});
				return result;
			} else if (this.type === "intersect") {
				const result = {};
				for (const item of this.list) Object.assign(result, item.simplify(value));
				return result;
			} else if (this.type === "union") for (const schema of this.list) try {
				Schema.resolve(value, schema, {});
				return schema.simplify(value);
			} catch {}
			return value;
		};
		Schema.prototype.toString = function toString(inline) {
			return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
		};
		Schema.prototype.role = function role(role, extra) {
			const schema = Schema(this);
			schema.meta = {
				...schema.meta,
				role,
				extra
			};
			return schema;
		};
		for (const key of [
			"default",
			"link",
			"comment",
			"description",
			"max",
			"min",
			"step"
		]) Object.assign(Schema.prototype, { [key](value) {
			const schema = Schema(this);
			schema.meta = {
				...schema.meta,
				[key]: value
			};
			return schema;
		} });
		Schema.prototype.volatile = function volatile() {
			if (this.meta.volatile) throw new TypeError("volatile schema is already wrapped");
			return this.extra("volatile", true);
		};
		const resolvers = {};
		const checkedVolatile = Symbol("checked-volatile-schema");
		function validateVolatileSchema(schema, path = [], blocked = false, seen = /* @__PURE__ */ new Map()) {
			const states = seen.get(schema) ?? /* @__PURE__ */ new Set();
			if (states.has(blocked)) return;
			states.add(blocked);
			seen.set(schema, states);
			if (schema.meta?.volatile && blocked) throw new ValidationError("volatile fields require a fixed object path without an enclosing volatile field", { path });
			const nested = blocked || !!schema.meta?.volatile;
			if (schema.dict) for (const [key, child] of Object.entries(schema.dict)) validateVolatileSchema(child, [...path, key], nested, seen);
			if (schema.sKey) validateVolatileSchema(schema.sKey, [...path, "<key>"], true, seen);
			if (schema.inner && (schema.type !== "lazy" || schema.inner[kSchema])) validateVolatileSchema(schema.inner, [...path, "*"], true, seen);
			if (schema.list) for (let index = 0; index < schema.list.length; index++) validateVolatileSchema(schema.list[index], [...path, String(index)], true, seen);
		}
		Schema.extend = function extend(type, resolve) {
			resolvers[type] = resolve;
		};
		Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
			if (!schema) return [data];
			if (!options[checkedVolatile]) {
				validateVolatileSchema(schema, options.path);
				options = {
					...options,
					[checkedVolatile]: true
				};
			}
			if (schema.meta?.volatile) {
				const inner = Schema(schema);
				inner.meta = {
					...schema.meta,
					volatile: false
				};
				const [value, adapted] = Schema.resolve(data, inner, options, strict);
				try {
					return [createVolatile(value), adapted];
				} catch (error) {
					throw new ValidationError(error instanceof Error ? error.message : String(error), options);
				}
			}
			if (options.ignore?.(data, schema)) return [data];
			if (isNullable(data) && schema.type !== "lazy") {
				if (schema.meta.required) throw new ValidationError(`missing required value`, options);
				let current = schema;
				let fallback = schema.meta.default;
				while (current?.type === "intersect" && isNullable(fallback)) {
					current = current.list[0];
					fallback = current?.meta.default;
				}
				if (isNullable(fallback)) return [data];
				data = clone(fallback);
			}
			const callback = resolvers[schema.type];
			if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
			try {
				return callback(data, schema, options, strict);
			} catch (error) {
				if (!schema.meta.loose) throw error;
				return [schema.meta.default];
			}
		};
		Schema.from = function from(source) {
			if (isNullable(source)) return Schema.any();
			else if ([
				"string",
				"number",
				"boolean"
			].includes(typeof source)) return Schema.const(source).required();
			else if (source[kSchema]) return source;
			else if (typeof source === "function") switch (source) {
				case String: return Schema.string().required();
				case Number: return Schema.number().required();
				case Boolean: return Schema.boolean().required();
				case Function: return Schema.function().required();
				default: return Schema.is(source).required();
			}
			else throw new TypeError(`cannot infer schema from ${source}`);
		};
		Schema.lazy = function lazy(builder) {
			const toJSON = () => {
				if (!schema.inner[kSchema]) {
					schema.inner = schema.builder();
					schema.inner.meta = {
						...schema.meta,
						...schema.inner.meta
					};
				}
				return schema.inner.toJSON();
			};
			const schema = new Schema({
				type: "lazy",
				builder,
				inner: { toJSON }
			});
			return schema;
		};
		Schema.natural = function natural() {
			return Schema.number().step(1).min(0);
		};
		Schema.percent = function percent() {
			return Schema.number().step(.01).min(0).max(1).role("slider");
		};
		Schema.date = function date() {
			return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
				const date = new Date(value);
				if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
				return date;
			}, true)]);
		};
		Schema.regExp = function regExp(flag = "") {
			return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
				try {
					return new RegExp(value, flag);
				} catch (e) {
					throw new ValidationError(e.message, options);
				}
			}, true)]);
		};
		Schema.arrayBuffer = function arrayBuffer(encoding) {
			return Schema.union([
				Schema.is(ArrayBuffer),
				Schema.is(SharedArrayBuffer),
				Schema.transform(Schema.any(), (value, options) => {
					if (Binary.isSource(value)) return Binary.fromSource(value);
					throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
				}, true),
				...encoding ? [Schema.transform(Schema.string(), (value, options) => {
					try {
						return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
					} catch (e) {
						throw new ValidationError(e.message, options);
					}
				}, true)] : []
			]);
		};
		Schema.extend("lazy", (data, schema, options, strict) => {
			if (!schema.inner[kSchema]) {
				schema.inner = schema.builder();
				schema.inner.meta = {
					...schema.meta,
					...schema.inner.meta
				};
				validateVolatileSchema(schema.inner, options.path, true);
			}
			return Schema.resolve(data, schema.inner, options, strict);
		});
		Schema.extend("any", (data) => {
			return [data];
		});
		Schema.extend("never", (data, _, options) => {
			throw new ValidationError(`expected nullable but got ${data}`, options);
		});
		Schema.extend("const", (data, { value }, options) => {
			if (deepEqual(data, value)) return [value];
			throw new ValidationError(`expected ${value} but got ${data}`, options);
		});
		function checkWithinRange(data, meta, description, options, skipMin = false) {
			const { max = Infinity, min = -Infinity } = meta;
			if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
			if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
		}
		Schema.extend("string", (data, { meta }, options) => {
			if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
			if (meta.pattern) {
				const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
				if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
			}
			checkWithinRange(data.length, meta, "string length", options);
			return [data];
		});
		function decimalShift(data, digits) {
			const str = data.toString();
			if (str.includes("e")) return data * Math.pow(10, digits);
			const index = str.indexOf(".");
			if (index === -1) return data * Math.pow(10, digits);
			const frac = str.slice(index + 1);
			const integer = str.slice(0, index);
			if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
			return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
		}
		function isMultipleOf(data, min, step) {
			step = Math.abs(step);
			if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
			const index = step.toString().indexOf(".");
			const digits = step.toString().slice(index + 1).length;
			return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
		}
		Schema.extend("number", (data, { meta }, options) => {
			if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
			checkWithinRange(data, meta, "number", options);
			const { step } = meta;
			if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
			return [data];
		});
		Schema.extend("boolean", (data, _, options) => {
			if (typeof data === "boolean") return [data];
			throw new ValidationError(`expected boolean but got ${data}`, options);
		});
		Schema.extend("bitset", (data, { bits, meta }, options) => {
			let value = 0, keys = [];
			if (typeof data === "number") {
				value = data;
				for (const key in bits) if (data & bits[key]) keys.push(key);
			} else if (Array.isArray(data)) {
				keys = data;
				for (const key of keys) {
					if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
					if (key in bits) value |= bits[key];
				}
			} else throw new ValidationError(`expected number or array but got ${data}`, options);
			if (value === meta.default) return [value];
			return [value, keys];
		});
		Schema.extend("function", (data, _, options) => {
			if (typeof data === "function") return [data];
			throw new ValidationError(`expected function but got ${data}`, options);
		});
		Schema.extend("is", (data, { constructor }, options) => {
			if (typeof constructor === "function") {
				if (data instanceof constructor) return [data];
				throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
			} else {
				if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
				let prototype = Object.getPrototypeOf(data);
				while (prototype) {
					if (prototype.constructor?.name === constructor) return [data];
					prototype = Object.getPrototypeOf(prototype);
				}
				throw new ValidationError(`expected ${constructor} but got ${data}`, options);
			}
		});
		function property(data, key, schema, options) {
			try {
				const [value, adapted] = Schema.resolve(data[key], schema, {
					...options,
					path: [...options.path || [], key]
				});
				if (adapted !== void 0) data[key] = adapted;
				return value;
			} catch (e) {
				if (!options?.autofix) throw e;
				delete data[key];
				return schema.meta.volatile ? createVolatile(schema.meta.default) : schema.meta.default;
			}
		}
		Schema.extend("array", (data, { inner, meta }, options) => {
			if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
			checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
			return [data.map((_, index) => property(data, index, inner, options))];
		});
		Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
			if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
			const result = {};
			for (const key in data) {
				let rKey;
				try {
					rKey = Schema.resolve(key, sKey, options)[0];
				} catch (error) {
					if (strict) continue;
					throw error;
				}
				result[rKey] = property(data, key, inner, options);
				data[rKey] = data[key];
				if (key !== rKey) delete data[key];
			}
			return [result];
		});
		Schema.extend("tuple", (data, { list }, options, strict) => {
			if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
			const result = list.map((inner, index) => property(data, index, inner, options));
			if (strict) return [result];
			result.push(...data.slice(list.length));
			return [result];
		});
		function merge(result, data) {
			for (const key in data) {
				if (key in result) continue;
				result[key] = data[key];
			}
		}
		Schema.extend("object", (data, { dict }, options, strict) => {
			if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
			const result = {};
			for (const key in dict) {
				const value = property(data, key, dict[key], options);
				if (!isNullable(value) || key in data) result[key] = value;
			}
			if (!strict) merge(result, data);
			return [result];
		});
		Schema.extend("union", (data, { list, toString }, options, strict) => {
			const messages = [];
			for (const inner of list) try {
				return Schema.resolve(data, inner, options, strict);
			} catch (error) {
				messages.push(error);
			}
			throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		});
		Schema.extend("intersect", (data, { list, toString }, options, strict) => {
			if (!list.length) return [data];
			let result;
			for (const inner of list) {
				const value = Schema.resolve(data, inner, options, true)[0];
				if (isNullable(value)) continue;
				if (isNullable(result)) result = value;
				else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
				else if (typeof value === "object") merge(result ??= {}, value);
				else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
			}
			if (!strict && isPlainObject(data)) merge(result, data);
			return [result];
		});
		Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
			const [result, adapted = data] = Schema.resolve(data, inner, options, true);
			if (preserve) return [callback(result)];
			else return [callback(result), callback(adapted)];
		});
		const formatters = {};
		function defineMethod(name, keys, format) {
			formatters[name] = format;
			Object.assign(Schema, { [name](...args) {
				const schema = new Schema({ type: name });
				keys.forEach((key, index) => {
					switch (key) {
						case "sKey":
							schema.sKey = args[index] ?? Schema.string();
							break;
						case "inner":
							schema.inner = Schema.from(args[index]);
							break;
						case "list":
							schema.list = args[index].map(Schema.from);
							break;
						case "dict":
							schema.dict = mapValues(args[index], Schema.from);
							break;
						case "bits":
							schema.bits = {};
							for (const key in args[index]) {
								if (typeof args[index][key] !== "number") continue;
								schema.bits[key] = args[index][key];
							}
							break;
						case "callback": {
							const callback = schema.callback = args[index];
							callback["toJSON"] ||= () => callback.toString();
							break;
						}
						case "constructor": {
							const constructor = schema.constructor = args[index];
							if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
							break;
						}
						default: schema[key] = args[index];
					}
				});
				if (name === "object" || name === "dict") schema.meta.default = {};
				else if (name === "array" || name === "tuple") schema.meta.default = [];
				else if (name === "bitset") schema.meta.default = 0;
				return schema;
			} });
		}
		defineMethod("is", ["constructor"], ({ constructor }) => {
			if (typeof constructor === "function") return constructor.name;
			else return constructor;
		});
		defineMethod("any", [], () => "any");
		defineMethod("never", [], () => "never");
		defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
		defineMethod("string", [], () => "string");
		defineMethod("number", [], () => "number");
		defineMethod("boolean", [], () => "boolean");
		defineMethod("bitset", ["bits"], () => "bitset");
		defineMethod("function", [], () => "function");
		defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
		defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
		defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
		defineMethod("object", ["dict"], ({ dict }) => {
			if (Object.keys(dict).length === 0) return "{}";
			return `{ ${Object.entries(dict).map(([key, inner]) => {
				return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
			}).join(", ")} }`;
		});
		defineMethod("union", ["list"], ({ list }, inline) => {
			const result = list.map(({ toString: format }) => format()).join(" | ");
			return inline ? `(${result})` : result;
		});
		defineMethod("intersect", ["list"], ({ list }) => {
			return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
		});
		defineMethod("transform", [
			"inner",
			"callback",
			"preserve"
		], ({ inner }, isInner) => inner.toString(isInner));
		//#endregion
		//#region lib/types/contact-config.js
		/** Public contact and bonus notice options shared by Host and Client. */
		/** Validate public questionnaire options. */
		const ContactConfigFields = {
			contactFormUrl: Schema.string().pattern(/^https:\/\/[^/\s]+\//).default("https://trtgsjkv6r.feishu.cn/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg?hide_uid=1&hide_device_info=1&hide_harness_version=1"),
			contactSource: Schema.string().default(""),
			bonusAckRetryDelayMs: Schema.number().min(1).default(1e3),
			bonusAckRetryMaxDelayMs: Schema.number().min(1).default(6e4)
		};
		/** Validate public questionnaire options. */
		const ContactConfig = Schema.object(ContactConfigFields);
		//#endregion
		//#region lib/types/client/contact-url.js
		/**
		* Build an external questionnaire URL without authentication credentials.
		* @param config - questionnaire destination and supported source option.
		* @param context - account, build and environment facts sampled by the caller.
		* @returns questionnaire URL with hidden, optionally prefilled context fields.
		*/
		function contactUrl(config, context) {
			const url = new URL(config.contactFormUrl);
			const ratio = Number.isFinite(context.pixelRatio) ? context.pixelRatio : 1;
			const width = Math.round(context.width * ratio);
			const height = Math.round(context.height * ratio);
			const deviceInfo = [context.deviceInfo];
			if (width > 0 && height > 0) deviceInfo.push(`screen_resolution=${width}x${height}`);
			const fields = {
				uid: context.uid,
				source: config.contactSource,
				harness_version: context.version,
				device_info: deviceInfo.filter(Boolean).join("; ")
			};
			for (const [name, value] of Object.entries(fields)) {
				url.searchParams.set(`hide_${name}`, "1");
				url.searchParams.delete(`prefill_${name}`);
				if (value) url.searchParams.set(`prefill_${name}`, value);
			}
			for (const name of [
				"os_version",
				"device_brand",
				"app_locale",
				"screen_resolution",
				"app_version",
				"device_model"
			]) {
				url.searchParams.delete(`prefill_${name}`);
				url.searchParams.delete(`hide_${name}`);
			}
			return url.href;
		}
		//#endregion
		//#region lib/types/client/authorize-url.js
		/** Platform authorization links that carry the active application palette into the login page. */
		/**
		* Add the resolved application palette to a Platform authorization link without
		* dropping any parameter the Host already put on it.
		* @param authorizeUrl - authorization URL of the current account attempt.
		* @param colorScheme - resolved scheme of the active application theme.
		* @returns the authorization URL carrying `theme=light` or `theme=dark`.
		*/
		function authorizeUrlWithTheme(authorizeUrl, colorScheme) {
			const url = new URL(authorizeUrl);
			url.searchParams.set("theme", colorScheme);
			return url.href;
		}
		//#endregion
		//#region lib/types/client/browser-login.js
		/** Keeps a preopened browser tab separate from Host authorization state. */
		var BrowserLogin = class {
			destination;
			popup = null;
			navigated = false;
			attempt;
			/** @param destination - maps the Host authorization URL to the page the tab opens, read when the tab navigates. */
			constructor(destination) {
				this.destination = destination;
			}
			/**
			* Preopen a tab and bind it to the attempt returned by the Host.
			* @param request - authenticated Host start request.
			* @param latest - most recent streamed state, including frames received before the response.
			* @returns after this UI is following the new attempt.
			*/
			async start(request, latest) {
				this.begin();
				try {
					this.follow(await request());
					this.update(latest());
				} catch (error) {
					this.dispose();
					throw error;
				}
			}
			/** Preopen a tab during the user's click; blocked popups need the copy-link route. */
			begin() {
				this.dispose();
				this.popup = window.open("about:blank", "_blank");
				if (this.popup) this.popup.opener = null;
			}
			/**
			* Bind the preopened tab to its Host attempt.
			* @param view - initial RPC response identifying this UI's attempt.
			*/
			follow(view) {
				this.attempt = view.attempt?.id;
				this.update(view);
			}
			/**
			* Navigate or close the pending tab when its attempt changes.
			* @param view - latest Host state.
			*/
			update(view) {
				const attempt = view?.attempt;
				if (attempt?.id !== this.attempt) return;
				if (attempt && [
					"failed",
					"expired",
					"cancelled"
				].includes(attempt.phase)) {
					this.dispose();
					return;
				}
				if (attempt?.phase === "succeeded") {
					if (!this.navigated) this.popup?.close();
					this.popup = null;
					this.attempt = void 0;
					return;
				}
				if (!attempt?.authorizeUrl || this.navigated) return;
				this.navigated = true;
				if (this.popup && !this.popup.closed) this.popup.location.replace(this.destination(attempt.authorizeUrl));
			}
			/** Close the owned authorization tab and stop following its attempt. */
			dispose() {
				this.popup?.close();
				this.popup = null;
				this.attempt = void 0;
				this.navigated = false;
			}
		};
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-settings-account/src/client/SignInDialog.module.css.mjs
		const css$7 = "._76YFJG_dialog{user-select:none;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-inverted)}._76YFJG_content{flex-direction:column;width:100%;display:flex}._76YFJG_header{justify-content:space-between;align-items:center;gap:8px;padding:22px 24px 12px;display:flex}._76YFJG_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}._76YFJG_close{box-sizing:border-box;border-radius:var(--dsw-radius-sm);width:28px;height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:0;flex:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}@media (hover:hover){._76YFJG_close:hover{background:var(--dsw-alias-interactive-bg-hover)}}._76YFJG_actions{box-sizing:border-box;justify-content:flex-end;align-items:center;gap:8px;width:100%;padding:0 24px;display:flex}._76YFJG_primaryButton,._76YFJG_secondaryButton{box-sizing:border-box;border-radius:var(--dsw-radius-md);min-width:72px;height:36px;font-size:14px;line-height:22px}._76YFJG_primaryButton{padding:0 16px;font-weight:500}._76YFJG_secondaryButton{--dsh-button-outline-color:var(--dsw-alias-border-l2);padding:0 14px}._76YFJG_description{color:var(--dsw-alias-label-primary);margin:0;padding:0 24px;font-size:14px;line-height:22px}._76YFJG_link{color:inherit;font:inherit;cursor:pointer;background:0 0;border:0;padding:0;text-decoration:underline}._76YFJG_spinner{flex:none;animation:1s linear infinite _76YFJG_spin}._76YFJG_primaryButton:has(._76YFJG_spinner){opacity:1}@keyframes _76YFJG_spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){._76YFJG_spinner{animation:none}}";
		const tagId$7 = "@deepseek-ai/dsh-client-ui-settings-account/SignInDialog.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$7) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-settings-account";
			tag.dataset.pluginCss = tagId$7;
			tag.textContent = css$7;
			document.head.appendChild(tag);
		}
		var SignInDialog_module_css_default = {
			"actions": "_76YFJG_actions",
			"close": "_76YFJG_close",
			"content": "_76YFJG_content",
			"description": "_76YFJG_description",
			"dialog": "_76YFJG_dialog",
			"header": "_76YFJG_header",
			"link": "_76YFJG_link",
			"primaryButton": "_76YFJG_primaryButton",
			"secondaryButton": "_76YFJG_secondaryButton",
			"spin": "_76YFJG_spin",
			"spinner": "_76YFJG_spinner",
			"title": "_76YFJG_title"
		};
		//#endregion
		//#region lib/types/client/SignInDialog.js
		/** Account authorization dialog; errors allow retry after cancelling any active attempt. */
		/** @param props - safe account state, localized copy, and user actions. @returns login dialog. */
		function SignInDialog({ account, colorScheme, start, cancel, close, useApiKey, t }) {
			const [busy, setBusy] = (0, react.useState)(false);
			const [failed, setFailed] = (0, react.useState)(false);
			const [copyResult, setCopyResult] = (0, react.useState)(null);
			const attempt = account.view?.attempt;
			(0, react.useEffect)(() => {
				setCopyResult(null);
			}, [attempt?.id, attempt?.authorizeUrl]);
			(0, react.useEffect)(() => {
				if (copyResult === null) return;
				const timer = setTimeout(() => {
					setCopyResult(null);
				}, 2e3);
				return () => {
					clearTimeout(timer);
				};
			}, [copyResult]);
			const authorizeUrl = attempt?.authorizeUrl;
			const phase = attempt?.phase;
			const active = busy || phase === "initializing" || phase === "waiting-browser" || phase === "exchanging" || phase === "committing";
			const expired = phase === "expired";
			const localFailure = failed || account.loginFailed || account.failed;
			const error = localFailure || phase === "failed";
			const failureKey = !localFailure && phase === "failed" && attempt?.errorCode === "no-response" ? "noResponse" : "failed";
			const waiting = active && !error;
			const committing = phase === "committing";
			(0, react.useEffect)(() => {
				if (account.view?.status === "credential-stored") close();
			}, [account.view?.status, close]);
			const run = async (action) => {
				setBusy(true);
				setFailed(false);
				try {
					await action();
				} catch {
					setFailed(true);
				} finally {
					setBusy(false);
				}
			};
			const dismiss = () => {
				if (committing || busy) return;
				if (active && attempt) run(async () => {
					await cancel(attempt.id);
					close();
				});
				else close();
			};
			const retry = async () => {
				if (active && attempt) await cancel(attempt.id);
				await start();
			};
			const copyLink = async (authorizeUrl) => {
				try {
					await navigator.clipboard.writeText(authorizeUrlWithTheme(authorizeUrl, colorScheme));
					setCopyResult({ messageKey: "copiedLink" });
				} catch {
					setCopyResult({ messageKey: "copyFailed" });
				}
			};
			const title = error ? t("failureTitle") : active ? t("browserTitle") : expired ? t("timeoutTitle") : t("loginTitle");
			return (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				headless: true,
				title,
				onClose: dismiss,
				className: SignInDialog_module_css_default.dialog,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: SignInDialog_module_css_default.content,
					children: [(0, react_jsx_runtime.jsxs)("div", {
						className: SignInDialog_module_css_default.header,
						children: [(0, react_jsx_runtime.jsx)("h2", {
							className: SignInDialog_module_css_default.title,
							children: title
						}), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: SignInDialog_module_css_default.close,
							"aria-label": t("close"),
							onClick: dismiss,
							children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutlineRegular, { size: 14 })
						})]
					}), waiting ? (0, react_jsx_runtime.jsxs)("p", {
						className: SignInDialog_module_css_default.description,
						children: [
							t("browserPrompt"),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: SignInDialog_module_css_default.link,
								disabled: !authorizeUrl,
								onClick: authorizeUrl ? () => {
									copyLink(authorizeUrl);
								} : void 0,
								children: t(copyResult?.messageKey ?? "copyLink")
							}),
							t("browserDescription")
						]
					}) : (0, react_jsx_runtime.jsx)("p", {
						className: SignInDialog_module_css_default.description,
						children: error ? t(failureKey) : expired ? t("timeoutDescription") : t("loginDescription")
					})]
				}), (0, react_jsx_runtime.jsxs)("div", {
					className: SignInDialog_module_css_default.actions,
					children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "outline",
						className: SignInDialog_module_css_default.secondaryButton,
						disabled: committing || busy,
						onClick: active ? dismiss : useApiKey,
						children: t(active ? "cancel" : "addApiKey")
					}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "primary",
						className: SignInDialog_module_css_default.primaryButton,
						disabled: busy || committing || waiting || account.view === void 0,
						"aria-label": waiting ? t("waiting") : void 0,
						onClick: () => {
							run(retry);
						},
						children: waiting ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLoadingOutlineRegular, { className: SignInDialog_module_css_default.spinner }) : t(expired || error ? "retry" : "signIn")
					})]
				})]
			});
		}
		//#endregion
		//#region lib/types/client/AccountOnboarding.js
		/** Account choice inside the model credential onboarding step. */
		/** @param props - onboarding completion, account state and actions. @returns account dialog while signed out. */
		function AccountOnboarding({ complete, useApiKey, useAccount, useTheme, setOnboarding, showLogin, start, cancel, t }) {
			const account = useAccount((value) => value);
			const colorScheme = useTheme((snapshot) => snapshot.active.colorScheme);
			(0, react.useEffect)(() => {
				setOnboarding(true);
				return () => {
					setOnboarding(false);
				};
			}, [setOnboarding]);
			(0, react.useEffect)(() => {
				if (account.view?.status === "credential-stored") complete();
			}, [account.view?.status, complete]);
			if (!account.view || account.view.status === "credential-stored") return null;
			return (0, react_jsx_runtime.jsx)(SignInDialog, {
				account,
				colorScheme,
				start,
				cancel,
				t,
				close: () => {
					showLogin(false);
					complete();
				},
				useApiKey: () => {
					showLogin(false);
					useApiKey();
				}
			});
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-settings-account/src/client/PlatformOverlay.module.css.mjs
		const css$6 = "._44HXVa_overlay{z-index:1001;background:var(--dsw-alias-bg-base);flex-direction:column;display:flex;position:fixed;inset:0}[data-windows-titlebar] ._44HXVa_overlay{padding-top:var(--dsh-windows-titlebar-height)}._44HXVa_header{-webkit-app-region:initial;box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none;height:48px;padding:6px 16px}._44HXVa_controls{align-items:center;gap:24px;padding-top:5px;display:flex}._44HXVa_trafficLights{flex:none;width:60.667px;height:14px;display:none}html[data-platform=darwin] ._44HXVa_trafficLights{display:block}._44HXVa_back{box-sizing:border-box;border-radius:var(--dsw-radius-sm);height:28px;color:var(--dsw-alias-label-secondary);font:inherit;white-space:nowrap;cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;gap:8px;padding:0 6px;font-size:14px;line-height:22px;display:inline-flex}._44HXVa_viewport{min-height:0;color:var(--dsw-alias-label-secondary);flex:1;position:relative}._44HXVa_status{flex-direction:column;justify-content:center;align-items:center;gap:16px;display:flex;position:absolute;inset:0}._44HXVa_failure{color:var(--dsw-alias-label-tertiary);text-align:center;font-size:14px;line-height:22px}._44HXVa_retry._44HXVa_retry{box-sizing:border-box;--dsh-button-outline-color:var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);min-width:58px;height:32px;padding:0 12px;font-size:13px;font-weight:400;line-height:20px}._44HXVa_spinner{width:24px;height:24px;animation:1s linear infinite _44HXVa_spin;position:relative}._44HXVa_spinner:before{content:\"\";background:url(data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTkiIGhlaWdodD0iMjIiIHZpZXdCb3g9IjAgMCAxOSAyMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGcgY2xpcC1wYXRoPSJ1cmwoI3BhaW50MF9hbmd1bGFyXzI5ODhfMzIzMjlfY2xpcF9wYXRoKSIgZGF0YS1maWdtYS1za2lwLXBhcnNlPSJ0cnVlIj48ZyB0cmFuc2Zvcm09Im1hdHJpeCgwLjAwNjk1MDQ4IDAuMDA2OTUwNDggLTAuMDA2OTUwNDggMC4wMDY5NTA0OCAxMC44Nzk3IDEwLjg3OTMpIj48Zm9yZWlnbk9iamVjdCB4PSItMTg2Ny40MiIgeT0iLTE4NjcuNDIiIHdpZHRoPSIzNzM0Ljg1IiBoZWlnaHQ9IjM3MzQuODUiPjxkaXYgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGh0bWwiIHN0eWxlPSJiYWNrZ3JvdW5kOmNvbmljLWdyYWRpZW50KGZyb20gOTBkZWcscmdiYSgyNDYsIDI0NiwgMjQ2LCAwLjk5NDMpIDBkZWcscmdiYSgwLCAwLCAwLCAwLjgzKSAyNzMuMDI3ZGVnLHJnYmEoMCwgMCwgMCwgMCkgMjg3LjY5NGRlZyxyZ2JhKDI1NSwgMjU1LCAyNTUsIDEpIDM1MC40OTdkZWcscmdiYSgyNDYsIDI0NiwgMjQ2LCAwLjk5NDMpIDM2MGRlZyk7aGVpZ2h0OjEwMCU7d2lkdGg6MTAwJTtvcGFjaXR5OjAuNSI+PC9kaXY+PC9mb3JlaWduT2JqZWN0PjwvZz48L2c+PHBhdGggZD0iTTMuMTg2MjcgMTguNTcyMkMtMS4wNjIwOSAxNC4zMjM2IC0xLjA2MjA5IDcuNDM1MDIgMy4xODYyNyAzLjE4NjM5QzcuNDM0ODggLTEuMDYyMjIgMTQuMzIzMyAtMS4wNjIwNSAxOC41NzIxIDMuMTg2MzlMMTcuMDg3OCA0LjY3MDdDMTMuNjU5MSAxLjI0MjM2IDguMTAwMTEgMS4yNDMyMiA0LjY3MTYxIDQuNjcxNzNDMS4yNDMzNSA4LjEwMDI2IDEuMjQzMzUgMTMuNjU4MyA0LjY3MTYxIDE3LjA4NjhDOC4xMDAxMSAyMC41MTUzIDEzLjY1OTEgMjAuNTE2MiAxNy4wODc4IDE3LjA4NzlMMTguNTcyMSAxOC41NzIyQzE0LjMyMzMgMjIuODIwNiA3LjQzNDg4IDIyLjgyMDggMy4xODYyNyAxOC41NzIyWiIgZGF0YS1maWdtYS1ncmFkaWVudC1maWxsPSJ7JiMzNDt0eXBlJiMzNDs6JiMzNDtHUkFESUVOVF9BTkdVTEFSJiMzNDssJiMzNDtzdG9wcyYjMzQ7Olt7JiMzNDtjb2xvciYjMzQ7OnsmIzM0O3ImIzM0OzowLjAsJiMzNDtnJiMzNDs6MC4wLCYjMzQ7YiYjMzQ7OjAuMCwmIzM0O2EmIzM0OzowLjgyOTk5OTk4MzMxMDY5OTQ2fSwmIzM0O3Bvc2l0aW9uJiMzNDs6MC43NTg0MDg3MjUyNjE2ODgyM30seyYjMzQ7Y29sb3ImIzM0Ozp7JiMzNDtyJiMzNDs6MC4wLCYjMzQ7ZyYjMzQ7OjAuMCwmIzM0O2ImIzM0OzowLjAsJiMzNDthJiMzNDs6MC4wfSwmIzM0O3Bvc2l0aW9uJiMzNDs6MC43OTkxNDk2OTIwNTg1NjMyM30seyYjMzQ7Y29sb3ImIzM0Ozp7JiMzNDtyJiMzNDs6MS4wLCYjMzQ7ZyYjMzQ7OjEuMCwmIzM0O2ImIzM0OzoxLjAsJiMzNDthJiMzNDs6MS4wfSwmIzM0O3Bvc2l0aW9uJiMzNDs6MC45NzM2MDE4MTgwODQ3MTY4MH1dLCYjMzQ7dHJhbnNmb3JtJiMzNDs6eyYjMzQ7bTAwJiMzNDs6MTMuOTAwOTUzMjkyODQ2NjgwLCYjMzQ7bTAxJiMzNDs6LTEzLjkwMDk1MzI5Mjg0NjY4MCwmIzM0O20wMiYjMzQ7OjEwLjg3OTY3Nzc3MjUyMTk3MywmIzM0O20xMCYjMzQ7OjEzLjkwMDk1NDI0NjUyMDk5NiwmIzM0O20xMSYjMzQ7OjEzLjkwMDk1NDI0NjUyMDk5NiwmIzM0O20xMiYjMzQ7Oi0zLjAyMTY2NzAwMzYzMTU5MTh9LCYjMzQ7b3BhY2l0eSYjMzQ7OjAuNTAsJiMzNDtibGVuZE1vZGUmIzM0OzomIzM0O05PUk1BTCYjMzQ7LCYjMzQ7c3RvcHNWYXImIzM0OzpbeyYjMzQ7Y29sb3ImIzM0Ozp7JiMzNDtyJiMzNDs6MC4wLCYjMzQ7ZyYjMzQ7OjAuMCwmIzM0O2ImIzM0OzowLjAsJiMzNDthJiMzNDs6MC44Mjk5OTk5ODMzMTA2OTk0Nn0sJiMzNDtwb3NpdGlvbiYjMzQ7OjAuNzU4NDA4NzI1MjYxNjg4MjN9LHsmIzM0O2NvbG9yJiMzNDs6eyYjMzQ7ciYjMzQ7OjAuMCwmIzM0O2cmIzM0OzowLjAsJiMzNDtiJiMzNDs6MC4wLCYjMzQ7YSYjMzQ7OjAuMH0sJiMzNDtwb3NpdGlvbiYjMzQ7OjAuNzk5MTQ5NjkyMDU4NTYzMjN9LHsmIzM0O2NvbG9yJiMzNDs6eyYjMzQ7ciYjMzQ7OjEuMCwmIzM0O2cmIzM0OzoxLjAsJiMzNDtiJiMzNDs6MS4wLCYjMzQ7YSYjMzQ7OjEuMH0sJiMzNDtwb3NpdGlvbiYjMzQ7OjAuOTczNjAxODE4MDg0NzE2ODB9XSwmIzM0O3Zpc2libGUmIzM0Ozp0cnVlfSIvPgo8ZGVmcz4KPGNsaXBQYXRoIGlkPSJwYWludDBfYW5ndWxhcl8yOTg4XzMyMzI5X2NsaXBfcGF0aCI+PHBhdGggZD0iTTMuMTg2MjcgMTguNTcyMkMtMS4wNjIwOSAxNC4zMjM2IC0xLjA2MjA5IDcuNDM1MDIgMy4xODYyNyAzLjE4NjM5QzcuNDM0ODggLTEuMDYyMjIgMTQuMzIzMyAtMS4wNjIwNSAxOC41NzIxIDMuMTg2MzlMMTcuMDg3OCA0LjY3MDdDMTMuNjU5MSAxLjI0MjM2IDguMTAwMTEgMS4yNDMyMiA0LjY3MTYxIDQuNjcxNzNDMS4yNDMzNSA4LjEwMDI2IDEuMjQzMzUgMTMuNjU4MyA0LjY3MTYxIDE3LjA4NjhDOC4xMDAxMSAyMC41MTUzIDEzLjY1OTEgMjAuNTE2MiAxNy4wODc4IDE3LjA4NzlMMTguNTcyMSAxOC41NzIyQzE0LjMyMzMgMjIuODIwNiA3LjQzNDg4IDIyLjgyMDggMy4xODYyNyAxOC41NzIyWiIvPjwvY2xpcFBhdGg+PC9kZWZzPgo8L3N2Zz4K) 50%/100% 100% no-repeat;width:18.572px;height:21.759px;position:absolute;top:1.121px;left:1.12px}@keyframes _44HXVa_spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){._44HXVa_spinner{animation:none}}";
		const tagId$6 = "@deepseek-ai/dsh-client-ui-settings-account/PlatformOverlay.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$6) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-settings-account";
			tag.dataset.pluginCss = tagId$6;
			tag.textContent = css$6;
			document.head.appendChild(tag);
		}
		var PlatformOverlay_module_css_default = {
			"back": "_44HXVa_back",
			"controls": "_44HXVa_controls",
			"failure": "_44HXVa_failure",
			"header": "_44HXVa_header",
			"overlay": "_44HXVa_overlay",
			"retry": "_44HXVa_retry",
			"spin": "_44HXVa_spin",
			"spinner": "_44HXVa_spinner",
			"status": "_44HXVa_status",
			"trafficLights": "_44HXVa_trafficLights",
			"viewport": "_44HXVa_viewport"
		};
		//#endregion
		//#region lib/types/client/overlay-inert.js
		/** Shared inert ownership for overlapping account overlays. */
		const owners = /* @__PURE__ */ new WeakMap();
		/**
		* Disable background interaction until every account overlay releases the element.
		* @param element - background element covered by an overlay.
		* @returns an idempotent release restoring the original inert state after the last owner.
		*/
		function acquireOverlayInert(element) {
			const state = owners.get(element) ?? {
				count: 0,
				previous: element.inert
			};
			state.count++;
			owners.set(element, state);
			element.inert = true;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				if (--state.count === 0) {
					element.inert = state.previous;
					owners.delete(element);
				}
			};
		}
		//#endregion
		//#region lib/types/client/PlatformOverlay.js
		/** Desktop Platform viewport; the native child owns remote content and credentials. */
		/** @param props - native commands, localized copy, and return action. @returns full-window Platform container. */
		function PlatformOverlay({ bridge, page, backLabel, loadingLabel, failureLabel, retryLabel, onClose }) {
			const layer = (0, react.useRef)(null);
			const back = (0, react.useRef)(null);
			const viewport = (0, react.useRef)(null);
			const [attempt, setAttempt] = (0, react.useState)(0);
			const [status, setStatus] = (0, react.useState)("loading");
			(0, react.useLayoutEffect)(() => {
				const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
				const background = Array.from(document.body.children).filter((element) => element instanceof HTMLElement && element !== layer.current).map((element) => acquireOverlayInert(element));
				back.current?.focus();
				return () => {
					for (const release of background) release();
					if (previousFocus?.isConnected) previousFocus.focus();
				};
			}, []);
			(0, react.useLayoutEffect)(() => {
				back.current?.focus();
			}, [page, attempt]);
			(0, react.useEffect)(() => {
				const element = viewport.current;
				let closed = false;
				const bounds = () => {
					const rect = element.getBoundingClientRect();
					return {
						x: rect.x,
						y: rect.y,
						width: rect.width,
						height: rect.height
					};
				};
				const fail = () => {
					if (!closed) setStatus("failed");
				};
				setStatus("loading");
				bridge.open(page, bounds()).then(() => {
					if (!closed) setStatus("loaded");
				}, fail);
				const observer = new ResizeObserver(() => {
					bridge.setBounds(bounds()).catch(fail);
				});
				observer.observe(element);
				return () => {
					closed = true;
					observer.disconnect();
					bridge.close().catch(() => {});
				};
			}, [
				bridge,
				page,
				attempt
			]);
			return (0, react_dom.createPortal)((0, react_jsx_runtime.jsxs)("div", {
				ref: layer,
				className: PlatformOverlay_module_css_default.overlay,
				role: "dialog",
				"aria-modal": "true",
				"aria-label": backLabel,
				children: [(0, react_jsx_runtime.jsx)("header", {
					className: PlatformOverlay_module_css_default.header,
					"data-window-drag": true,
					children: (0, react_jsx_runtime.jsxs)("div", {
						className: PlatformOverlay_module_css_default.controls,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: PlatformOverlay_module_css_default.trafficLights,
							"aria-hidden": "true"
						}), (0, react_jsx_runtime.jsxs)("button", {
							ref: back,
							className: PlatformOverlay_module_css_default.back,
							onClick: onClose,
							children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronLeftOutlineRegular, { size: 16 }), backLabel]
						})]
					})
				}), (0, react_jsx_runtime.jsx)("div", {
					ref: viewport,
					className: PlatformOverlay_module_css_default.viewport,
					children: status !== "loaded" && (0, react_jsx_runtime.jsx)("div", {
						className: PlatformOverlay_module_css_default.status,
						role: "status",
						"aria-label": status === "loading" ? loadingLabel : void 0,
						children: status === "failed" ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("span", {
							className: PlatformOverlay_module_css_default.failure,
							children: failureLabel
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							className: PlatformOverlay_module_css_default.retry,
							onClick: () => {
								setAttempt((value) => value + 1);
							},
							children: retryLabel
						})] }) : (0, react_jsx_runtime.jsx)("span", {
							className: PlatformOverlay_module_css_default.spinner,
							"aria-hidden": "true"
						})
					})
				})]
			}), document.body);
		}
		//#endregion
		//#region lib/types/client/AccountPlatformHost.js
		/**
		* @param props - the native commands, the live page request, and its dismissal.
		* @returns the native Platform container, or null while no page is requested.
		*/
		function AccountPlatformHost({ platform, usePage, closePage, t }) {
			const claim = usePage((current) => current);
			if (claim === null) return null;
			return (0, react_jsx_runtime.jsx)(PlatformOverlay, {
				bridge: platform,
				page: claim.page,
				backLabel: t("backToHarness"),
				loadingLabel: t("loading"),
				failureLabel: t("platformFailed"),
				retryLabel: t("platformRetry"),
				onClose: closePage
			});
		}
		//#endregion
		//#region lib/types/client/SignOutDialog.js
		/** Account sign-out confirmation with the current task impact. */
		/** @param props - task impact at opening, localized copy, and account actions. @returns sign-out confirmation. */
		function SignOutDialog({ running, signOut, close, t }) {
			const [busy, setBusy] = (0, react.useState)(false);
			const [failed, setFailed] = (0, react.useState)(false);
			const dismiss = () => {
				if (!busy) close();
			};
			const confirm = async () => {
				setBusy(true);
				setFailed(false);
				try {
					await signOut();
					close();
				} catch {
					setFailed(true);
				} finally {
					setBusy(false);
				}
			};
			return (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				headless: true,
				title: t("signOut"),
				onClose: dismiss,
				className: SignInDialog_module_css_default.dialog,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: SignInDialog_module_css_default.content,
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							className: SignInDialog_module_css_default.header,
							children: [(0, react_jsx_runtime.jsx)("h2", {
								className: SignInDialog_module_css_default.title,
								children: t("signOut")
							}), (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: SignInDialog_module_css_default.close,
								"aria-label": t("close"),
								disabled: busy,
								onClick: dismiss,
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutlineRegular, { size: 14 })
							})]
						}),
						(0, react_jsx_runtime.jsx)("p", {
							className: SignInDialog_module_css_default.description,
							children: t(running === "unknown" ? "signOutUnknownDescription" : running ? "signOutRunningDescription" : "signOutDescription")
						}),
						failed && (0, react_jsx_runtime.jsx)("p", {
							className: SignInDialog_module_css_default.description,
							role: "alert",
							children: t("failed")
						})
					]
				}), (0, react_jsx_runtime.jsxs)("div", {
					className: SignInDialog_module_css_default.actions,
					children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "outline",
						className: SignInDialog_module_css_default.secondaryButton,
						disabled: busy,
						onClick: dismiss,
						children: t("cancel")
					}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "primary",
						className: SignInDialog_module_css_default.primaryButton,
						disabled: busy,
						onClick: () => {
							confirm();
						},
						children: t("signOut")
					})]
				})]
			});
		}
		//#endregion
		//#region lib/types/client/LogoutIcon.js
		/** Figma IcDsLogOutOutline16 glyph, stored inline for theme-aware rendering. */
		/** @returns the account menu logout glyph. */
		function LogoutIcon() {
			return (0, react_jsx_runtime.jsx)("span", {
				style: {
					width: 16,
					height: 16,
					position: "relative"
				},
				"aria-hidden": "true",
				children: (0, react_jsx_runtime.jsxs)("svg", {
					style: {
						position: "absolute",
						left: 1.168,
						top: 1.214
					},
					width: "13.664",
					height: "13.571",
					viewBox: "0 0 14 14",
					fill: "none",
					xmlns: "http://www.w3.org/2000/svg",
					children: [(0, react_jsx_runtime.jsx)("path", {
						d: "M3.9961 1.40039C3.37842 1.40039 2.96028 1.40039 2.63867 1.42871C2.32631 1.45627 2.17171 1.50666 2.06641 1.56543C1.85606 1.68288 1.68189 1.85605 1.56446 2.06641C1.50569 2.17173 1.45625 2.32627 1.42871 2.63867C1.40036 2.9603 1.39942 3.37827 1.39942 3.9961L1.39942 9.5752C1.39942 10.193 1.40036 10.611 1.42871 10.9326C1.45625 11.245 1.50569 11.3996 1.56445 11.5049C1.68188 11.7153 1.85605 11.8884 2.06641 12.0059C2.17171 12.0646 2.32631 12.115 2.63867 12.1426C2.96028 12.1709 3.37842 12.1709 3.9961 12.1709V13.5713C3.4033 13.5713 2.91297 13.5721 2.51563 13.5371C2.10906 13.5013 1.73277 13.4233 1.38379 13.2285C0.946838 12.9845 0.585697 12.6235 0.341799 12.1865C0.14725 11.8377 0.0700118 11.4621 0.0341815 11.0557C-0.000847399 10.6583 1.58129e-06 10.1681 1.85029e-06 9.5752L2.09416e-06 3.9961C1.83027e-06 3.40325 -0.000846367 2.91297 0.0341818 2.51563C0.0700164 2.10924 0.147239 1.73362 0.341799 1.38477C0.585703 0.947758 0.946825 0.586744 1.38379 0.342775C1.73277 0.148001 2.10906 0.0700381 2.51563 0.0341813C2.91297 -0.000823893 3.40331 1.37805e-06 3.9961 1.71712e-06L3.9961 1.40039Z",
						fill: "currentColor"
					}), (0, react_jsx_runtime.jsx)("path", {
						d: "M13.6426 6.51953C13.6705 6.6957 13.6705 6.8756 13.6426 7.05176C13.5902 7.38188 13.4302 7.64112 13.2539 7.86035C13.0857 8.06937 12.8546 8.29971 12.6006 8.55371L9.3086 11.8447L8.31836 10.8545L11.6104 7.56348C11.637 7.53681 11.6628 7.51104 11.6875 7.48633H3.74317V6.08594H11.6885C11.6635 6.06088 11.6374 6.03487 11.6104 6.00781L8.31836 2.7168L9.3086 1.72656L12.6006 5.01758C12.8547 5.27169 13.0857 5.50185 13.2539 5.71094C13.4303 5.93018 13.5902 6.18939 13.6426 6.51953Z",
						fill: "currentColor"
					})]
				})
			});
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-settings-account/src/client/AccountAvatar.module.css.mjs
		const css$5 = ".ZCYJYW_image{corner-shape:round;object-fit:cover;border-radius:50%;width:100%;height:100%;display:block}";
		const tagId$5 = "@deepseek-ai/dsh-client-ui-settings-account/AccountAvatar.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$5) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-settings-account";
			tag.dataset.pluginCss = tagId$5;
			tag.textContent = css$5;
			document.head.appendChild(tag);
		}
		var AccountAvatar_module_css_default = { "image": "ZCYJYW_image" };
		//#endregion
		//#region lib/types/client/AccountAvatar.js
		/** Shared account picture with an icon fallback for missing or unavailable images. */
		/**
		* Render a decorative avatar next to the account identity.
		* @param props - shared browser load outcome and rendered-image failure reporter; absent data uses the default icon.
		* @returns picture or the default account icon.
		*/
		function AccountAvatar({ avatar, avatarFailed }) {
			return avatar?.status === "ready" ? (0, react_jsx_runtime.jsx)("img", {
				className: AccountAvatar_module_css_default.image,
				src: avatar.url,
				alt: "",
				referrerPolicy: "no-referrer",
				onError: () => {
					avatarFailed(avatar);
				}
			}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconUserOutlineMedium, { size: 16 });
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-settings-account/src/client/AccountNotice.module.css.mjs
		const css$4 = ".zwW4-W_stack{z-index:40;isolation:isolate;width:280px;max-width:calc(100vw - 16px);position:fixed}.zwW4-W_card{box-sizing:border-box;background:var(--dsw-specific-input-major);width:100%;box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-secondary);z-index:calc(0 - var(--notice-depth));transform:translateY(calc(-4px * var(--notice-depth))) scaleX(var(--notice-scale));transform-origin:top;border:0;border-radius:16px;padding:20px;font-size:14px;line-height:22px;transition:transform .25s ease-out;position:relative}.zwW4-W_card[data-front=false]{pointer-events:none;height:100%;position:absolute;inset:0;overflow:hidden}@media (prefers-reduced-motion:reduce){.zwW4-W_card{transition:none}}.zwW4-W_copy{overflow-wrap:anywhere;flex-direction:column;gap:2px;display:flex}.zwW4-W_copy p{white-space:pre-wrap;margin:0}.zwW4-W_title{align-items:flex-start;gap:2px;font-weight:500;line-height:20px;display:flex}.zwW4-W_icon{width:14px;height:14px;color:var(--dsw-alias-brand-primary-new-colorprimary-new-color);flex:none;margin-top:1px;display:flex}.zwW4-W_close{width:18px;height:18px;color:var(--dsw-alias-label-caption);cursor:pointer;background:0 0;border:0;justify-content:center;align-items:center;padding:4px;display:flex;position:absolute;top:6px;right:6px}.zwW4-W_close:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:4px}";
		const tagId$4 = "@deepseek-ai/dsh-client-ui-settings-account/AccountNotice.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$4) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-settings-account";
			tag.dataset.pluginCss = tagId$4;
			tag.textContent = css$4;
			document.head.appendChild(tag);
		}
		var AccountNotice_module_css_default = {
			"card": "zwW4-W_card",
			"close": "zwW4-W_close",
			"copy": "zwW4-W_copy",
			"icon": "zwW4-W_icon",
			"stack": "zwW4-W_stack",
			"title": "zwW4-W_title"
		};
		//#endregion
		//#region lib/types/client/notice-transition.js
		/** Animate a notification promotion across the old and new card dimensions. */
		/**
		* Close a card and animate surviving siblings from their currently displayed rectangles.
		* @param card - mounted foreground card whose direct parent owns the stack.
		* @param dismiss - synchronous notification-store update for the close gesture.
		*/
		function dismissNotice(card, dismiss) {
			if (typeof card.animate !== "function" || getComputedStyle(card).transitionDuration === "0s") {
				dismiss();
				return;
			}
			const before = [...card.parentElement.querySelectorAll("aside")].map((element) => ({
				element,
				rect: element.getBoundingClientRect()
			}));
			for (const { element } of before) {
				for (const animation of element.getAnimations()) animation.cancel();
				element.style.transition = "none";
			}
			(0, react_dom.flushSync)(dismiss);
			for (const { element, rect } of before) {
				if (!element.isConnected) continue;
				const transform = getComputedStyle(element).transform;
				element.style.transform = "none";
				const next = element.getBoundingClientRect();
				element.style.transform = "";
				element.animate([{ transform: `translate(${rect.x + rect.width / 2 - next.x - next.width / 2}px, ${rect.y - next.y}px) scale(${rect.width / next.width}, ${rect.height / next.height})` }, { transform }], {
					duration: 250,
					easing: "ease-out"
				});
				element.style.transition = "";
			}
		}
		//#endregion
		//#region lib/types/client/AccountNotice.js
		/**
		* Sidebar bonus notice. The card reports a display once it has a position, the
		* document is visible, and it has painted one frame: that is the whole signal,
		* and the card measures no cover, so a painted card behind the open Settings
		* overlay reports the same way as any other. Closing counts as a display too,
		* because the user acted on it. An award that expired before a render is not
		* drawn at all.
		*/
		/** @param expiresAt - server expiration timestamp. @returns whether the award can still be spent. */
		function live(expiresAt) {
			if (expiresAt === "") return true;
			const expires = Date.parse(expiresAt);
			return Number.isNaN(expires) || expires > Date.now();
		}
		/**
		* @param run - callback to invoke once one presented frame has passed.
		* @returns a canceller for a card that unmounts or hides first.
		*/
		function afterPaint(run) {
			if (typeof requestAnimationFrame !== "function") {
				const timer = setTimeout(run, 0);
				return () => {
					clearTimeout(timer);
				};
			}
			let cancelled = false;
			let timer;
			const frame = requestAnimationFrame(() => {
				timer = setTimeout(() => {
					if (!cancelled) run();
				}, 0);
			});
			return () => {
				cancelled = true;
				cancelAnimationFrame(frame);
				if (timer !== void 0) clearTimeout(timer);
			};
		}
		/** @param props - server-ordered notices, localized fallback copy, anchor, and display callbacks.
		* @returns a non-modal stack whose foreground card alone can report display or be closed.
		*/
		function AccountNoticeStack({ notices, anchor, title, closeLabel, onShown, onDismiss }) {
			const [position, setPosition] = (0, react.useState)();
			(0, react.useLayoutEffect)(() => {
				if (!anchor.current) return;
				const element = anchor.current;
				const update = () => {
					const rect = element.getBoundingClientRect();
					setPosition({
						left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)),
						bottom: Math.max(8, window.innerHeight - rect.top + 4)
					});
				};
				update();
				const observer = new ResizeObserver(update);
				observer.observe(element);
				window.addEventListener("resize", update);
				window.addEventListener("scroll", update, true);
				return () => {
					observer.disconnect();
					window.removeEventListener("resize", update);
					window.removeEventListener("scroll", update, true);
				};
			}, [anchor]);
			const liveNotices = notices.filter((notice) => live(notice.expiresAt));
			return (0, react_dom.createPortal)((0, react_jsx_runtime.jsx)("div", {
				className: AccountNotice_module_css_default.stack,
				style: position ?? { visibility: "hidden" },
				children: liveNotices.map((notice, depth) => (0, react_jsx_runtime.jsx)(NoticeCard, {
					notice,
					depth,
					ready: position !== void 0,
					title: notice.title ?? title,
					closeLabel,
					onShown,
					onDismiss
				}, notice.orderId))
			}), document.body);
		}
		/** One stable card node remains mounted as the cards before it are dismissed. */
		function NoticeCard({ notice, depth, ready, title, closeLabel, onShown, onDismiss }) {
			const foreground = depth === 0;
			const reported = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (!ready || !foreground || reported.current || !live(notice.expiresAt)) return;
				let cancel;
				const attempt = () => {
					if (reported.current || cancel !== void 0 || !live(notice.expiresAt)) return;
					if (document.visibilityState === "hidden") return;
					cancel = afterPaint(() => {
						cancel = void 0;
						if (reported.current || document.visibilityState === "hidden" || !live(notice.expiresAt)) return;
						reported.current = true;
						onShown(notice.orderId);
					});
				};
				attempt();
				document.addEventListener("visibilitychange", attempt);
				return () => {
					document.removeEventListener("visibilitychange", attempt);
					cancel?.();
				};
			}, [
				ready,
				foreground,
				notice.orderId,
				notice.expiresAt,
				onShown
			]);
			return (0, react_jsx_runtime.jsxs)("aside", {
				className: AccountNotice_module_css_default.card,
				"data-front": foreground,
				"aria-hidden": !foreground,
				style: {
					"--notice-depth": depth,
					"--notice-scale": Math.pow(272 / 280, depth)
				},
				children: [(0, react_jsx_runtime.jsxs)("div", {
					role: "status",
					className: AccountNotice_module_css_default.copy,
					children: [(0, react_jsx_runtime.jsxs)("div", {
						className: AccountNotice_module_css_default.title,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: AccountNotice_module_css_default.icon,
							"aria-hidden": "true",
							children: (0, react_jsx_runtime.jsxs)("svg", {
								width: "14",
								height: "14",
								viewBox: "0 0 14 14",
								fill: "none",
								children: [(0, react_jsx_runtime.jsx)("path", {
									d: "M3.6355 6.93969C3.6355 4.8398 5.33779 3.1375 7.43768 3.1375C9.53757 3.1375 11.23987 4.8398 11.23987 6.93968V11.363H3.6355V6.93969Z",
									fill: "currentColor",
									fillOpacity: "0.2",
									stroke: "currentColor",
									strokeWidth: "0.875"
								}), (0, react_jsx_runtime.jsx)("path", {
									d: "M1.641 11.3645H12.36M5.053 13.3095H8.9479M7.4375 4.27422V2.70137912",
									stroke: "currentColor",
									strokeWidth: "0.875"
								})]
							})
						}), (0, react_jsx_runtime.jsx)("span", { children: title })]
					}), (0, react_jsx_runtime.jsx)("p", { children: notice.message })]
				}), (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					tabIndex: foreground ? void 0 : -1,
					className: AccountNotice_module_css_default.close,
					"aria-label": closeLabel,
					onClick: (event) => {
						dismissNotice(event.currentTarget.parentElement, () => {
							onDismiss(notice.orderId);
						});
					},
					children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutlineRegular, { size: 10 })
				})]
			});
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-settings-account/src/client/AccountMenu.module.css.mjs
		const css$3 = ".yHnPSG_root{flex:1;min-width:0}.yHnPSG_root[data-inset=true]{margin-inline:2px}.yHnPSG_anchor{width:100%}.yHnPSG_trigger{user-select:none;width:100%;height:44px;padding:6px calc(var(--dsh-sidebar-row-padding) - var(--dsh-sidebar-paint-inset));border:0;border-inline:var(--dsh-sidebar-paint-inset) solid transparent;box-sizing:border-box;border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:padding-box padding-box;align-items:center;gap:8px;font-size:14px;display:flex}.yHnPSG_trigger[data-signed-out=false]:not([data-collapsed=true]){background-clip:border-box;border-inline:0;padding:6px}.yHnPSG_trigger[data-collapsed=true]{box-sizing:border-box;background-clip:border-box;border-inline:0;justify-content:center;gap:0;width:36px;height:36px;padding:0}@media (hover:hover){.yHnPSG_trigger:hover{background-color:var(--dsw-alias-interactive-bg-hover)}}.yHnPSG_avatar{corner-shape:round;background:var(--dsw-alias-bg-skeleton);width:24px;height:24px;color:var(--dsw-alias-label-tertiary);border-radius:50%;flex:none;justify-content:center;align-items:center;display:flex}.yHnPSG_label{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.yHnPSG_trigger[data-signed-out=true]:not([data-collapsed=true]){height:32px;padding:6px calc(var(--dsh-sidebar-row-padding) - var(--dsh-sidebar-paint-inset));line-height:20px}.yHnPSG_signedOutMenu[role=menu]{min-width:124px;max-width:280px;padding:4px}.yHnPSG_signedOutMenu [role=menuitem]{border-radius:var(--dsw-radius-md);gap:8px;min-height:40px;padding:8px 10px;font-size:14px;line-height:22px}.yHnPSG_signedOutMenu [role=menuitem]>span:first-child:not(:last-child){width:16px;height:16px;color:var(--dsw-alias-menu-icon)}.yHnPSG_signedOutMenu [role=menuitem]>span:first-child:not(:last-child) svg{width:16px;height:16px}";
		const tagId$3 = "@deepseek-ai/dsh-client-ui-settings-account/AccountMenu.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$3) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-settings-account";
			tag.dataset.pluginCss = tagId$3;
			tag.textContent = css$3;
			document.head.appendChild(tag);
		}
		var AccountMenu_module_css_default = {
			"anchor": "yHnPSG_anchor",
			"avatar": "yHnPSG_avatar",
			"label": "yHnPSG_label",
			"root": "yHnPSG_root",
			"signedOutMenu": "yHnPSG_signedOutMenu",
			"trigger": "yHnPSG_trigger"
		};
		//#endregion
		//#region lib/types/client/AccountMenu.js
		/** Sidebar account launcher and locally authoritative sign-out action. */
		/** The signed-in label stays empty while the profile loads.
		* @param props - sidebar geometry, settings navigation and account operations.
		* @returns account menu launcher.
		*/
		function AccountMenu({ subscribeSessionExpired, subscribeModelSignInRequired, wide, settingsShortcut, openSettings, openOnboarding, settingsOpen, useAccount, useTheme, signOut, hasRunningAccountTasks, refreshAccount, bonusNoticeShown, bonusNoticeDismissed, contactUs, showLogin, start, cancel, avatarFailed, t }) {
			const anchor = (0, react.useRef)(null);
			const settingsWasOpen = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (settingsOpen && !settingsWasOpen.current) refreshAccount();
				settingsWasOpen.current = settingsOpen;
			}, [refreshAccount, settingsOpen]);
			const account = useAccount((state) => state);
			const colorScheme = useTheme((snapshot) => snapshot.active.colorScheme);
			const signedIn = account.view?.status === "credential-stored";
			const [signInNotice, setSignInNotice] = (0, react.useState)(0);
			(0, react.useEffect)(() => subscribeModelSignInRequired?.(() => {
				setSignInNotice((value) => value + 1);
			}), [subscribeModelSignInRequired]);
			const [expiryNotice, setExpiryNotice] = (0, react.useState)(false);
			(0, react.useEffect)(() => subscribeSessionExpired?.(() => {
				setExpiryNotice(true);
			}), [subscribeSessionExpired]);
			const profile = account.details?.profile;
			const label = profile === void 0 ? null : profile.status === "ready" ? profile.value.name ?? profile.value.contact ?? t("signedIn") : t("signedIn");
			const [open, setOpen] = (0, react.useState)(false);
			const trigger = (0, react.useRef)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [signOutImpact, setSignOutImpact] = (0, react.useState)();
			const requestSignOut = async () => {
				setBusy(true);
				try {
					setSignOutImpact(await hasRunningAccountTasks());
					setOpen(false);
				} catch (_error) {
					setSignOutImpact("unknown");
					setOpen(false);
				} finally {
					setBusy(false);
				}
			};
			const beginSignIn = () => {
				setOpen(false);
				start().catch(() => void 0);
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				ref: anchor,
				className: AccountMenu_module_css_default.root,
				"data-inset": signedIn && wide,
				children: [
					signInNotice > 0 && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
						text: t("modelSignInRequired"),
						onDone: () => {
							setSignInNotice(0);
						}
					}, signInNotice),
					expiryNotice && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
						text: t("sessionExpired"),
						onDone: () => {
							setExpiryNotice(false);
						}
					}),
					signedIn && !account.desktopOnboardingVisible && !account.onboarding && account.notices && (0, react_jsx_runtime.jsx)(AccountNoticeStack, {
						notices: account.notices,
						anchor,
						title: t("bonusNoticeTitle"),
						closeLabel: t("close"),
						onShown: bonusNoticeShown,
						onDismiss: bonusNoticeDismissed
					}),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
						open,
						side: "top",
						portal: true,
						autoFocus: true,
						className: AccountMenu_module_css_default.anchor,
						listClassName: signedIn ? void 0 : AccountMenu_module_css_default.signedOutMenu,
						anchor: (0, react_jsx_runtime.jsxs)("button", {
							ref: trigger,
							type: "button",
							className: AccountMenu_module_css_default.trigger,
							"data-collapsed": !wide,
							"data-signed-out": !signedIn,
							"aria-label": t("menu"),
							"aria-haspopup": "menu",
							"aria-expanded": open,
							onClick: () => {
								setOpen((value) => !value);
							},
							children: [signedIn ? (0, react_jsx_runtime.jsx)("span", {
								className: AccountMenu_module_css_default.avatar,
								"data-avatar-status": account.avatar?.status,
								children: (0, react_jsx_runtime.jsx)(AccountAvatar, {
									avatar: account.avatar,
									avatarFailed
								})
							}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEllipsisOutlineMedium, { size: 14 }), wide && (0, react_jsx_runtime.jsx)("span", {
								className: AccountMenu_module_css_default.label,
								children: signedIn ? label : t("more")
							})]
						}),
						items: [
							{
								id: "settings",
								label: t("settings"),
								icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSettingsOutlineMedium, { size: 16 }),
								...settingsShortcut === void 0 ? {} : { shortcut: settingsShortcut }
							},
							{
								id: "contact",
								label: t("contactUs"),
								icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPaperPlaneOutlineMedium, { size: 16 })
							},
							...signedIn ? [{
								id: "signout",
								label: t("signOut"),
								icon: (0, react_jsx_runtime.jsx)(LogoutIcon, {}),
								disabled: busy
							}] : [{
								id: "signin",
								label: t("signIn"),
								icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconUserOutlineMedium, { size: 16 })
							}]
						],
						onClose: () => {
							setOpen(false);
						},
						onSelect: (id) => {
							if (id === "settings") {
								setOpen(false);
								trigger.current?.focus();
								openSettings();
							} else if (id === "contact") {
								setOpen(false);
								contactUs();
							} else if (id === "signin") beginSignIn();
							else requestSignOut();
						}
					}),
					account.loginVisible && !account.onboarding && (0, react_jsx_runtime.jsx)(SignInDialog, {
						account,
						colorScheme,
						start,
						cancel,
						t,
						close: () => {
							showLogin(false);
						},
						useApiKey: () => {
							showLogin(false);
							openOnboarding("deepseek-official");
						}
					}),
					signedIn && signOutImpact !== void 0 && (0, react_jsx_runtime.jsx)(SignOutDialog, {
						running: signOutImpact,
						signOut,
						close: () => {
							setSignOutImpact(void 0);
						},
						t
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/platform-pages.js
		/**
		* One native Platform view for the whole account feature. The Account settings
		* page, the frame-wide quota notice, and the desktop onboarding recharge step
		* request a page here instead of mounting their own container, because the
		* Desktop host owns a single WebContentsView and its `open` destroys whatever
		* was showing before.
		*/
		/**
		* Create the plugin-scoped request channel shared by the account surfaces and
		* the one host that renders their pages. The snapshot store supplies the
		* observable and isolates a throwing subscriber from the rest.
		* @returns the request channel.
		*/
		function createPlatformPages() {
			const store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(null);
			let owner;
			let token = null;
			return {
				getSnapshot: () => store.getSnapshot(),
				subscribe: (listener) => store.subscribe(listener),
				open(page, onClose) {
					const previous = owner;
					const own = {};
					token = own;
					owner = onClose;
					store.set({ page });
					previous?.("superseded");
					return () => {
						if (token !== own) return;
						token = null;
						owner = void 0;
						store.set(null);
					};
				},
				close() {
					if (store.getSnapshot() === null) return;
					const retiring = owner;
					token = null;
					owner = void 0;
					store.set(null);
					retiring?.("returned");
				},
				dispose() {
					token = null;
					owner = void 0;
					if (store.getSnapshot() === null) return;
					store.set(null);
				}
			};
		}
		//#endregion
		//#region ../../../node_modules/.pnpm/big.js@7.0.1/node_modules/big.js/big.mjs
		/************************************** EDITABLE DEFAULTS *****************************************/
		var DP = 20, RM = 1, MAX_DP = 1e6, MAX_POWER = 1e6, NE = -7, PE = 21, STRICT = false, NAME = "[big.js] ", INVALID = NAME + "Invalid ", INVALID_DP = INVALID + "decimal places", INVALID_RM = INVALID + "rounding mode", DIV_BY_ZERO = NAME + "Division by zero", P = {}, UNDEFINED = void 0, NUMERIC = /^-?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;
		function _Big_() {
			function Big(n) {
				var x = this;
				if (!(x instanceof Big)) return n === UNDEFINED && arguments.length === 0 ? _Big_() : new Big(n);
				if (n instanceof Big) {
					x.s = n.s;
					x.e = n.e;
					x.c = n.c.slice();
				} else {
					if (typeof n !== "string") {
						if (Big.strict === true && typeof n !== "bigint") throw TypeError(INVALID + "value");
						n = n === 0 && 1 / n < 0 ? "-0" : String(n);
					}
					parse(x, n);
				}
				x.constructor = Big;
			}
			Big.prototype = P;
			Big.DP = DP;
			Big.RM = RM;
			Big.NE = NE;
			Big.PE = PE;
			Big.strict = STRICT;
			Big.roundDown = 0;
			Big.roundHalfUp = 1;
			Big.roundHalfEven = 2;
			Big.roundUp = 3;
			return Big;
		}
		function parse(x, n) {
			var e, i, nl;
			if (!NUMERIC.test(n)) throw Error(INVALID + "number");
			x.s = n.charAt(0) == "-" ? (n = n.slice(1), -1) : 1;
			if ((e = n.indexOf(".")) > -1) n = n.replace(".", "");
			if ((i = n.search(/e/i)) > 0) {
				if (e < 0) e = i;
				e += +n.slice(i + 1);
				n = n.substring(0, i);
			} else if (e < 0) e = n.length;
			nl = n.length;
			for (i = 0; i < nl && n.charAt(i) == "0";) ++i;
			if (i == nl) x.c = [x.e = 0];
			else {
				for (; nl > 0 && n.charAt(--nl) == "0";);
				x.e = e - i - 1;
				x.c = [];
				for (e = 0; i <= nl;) x.c[e++] = +n.charAt(i++);
			}
			return x;
		}
		function round(x, sd, rm, more) {
			var xc = x.c;
			if (rm === UNDEFINED) rm = x.constructor.RM;
			if (rm !== 0 && rm !== 1 && rm !== 2 && rm !== 3) throw Error(INVALID_RM);
			if (sd < 1) {
				more = rm === 3 && (more || !!xc[0]) || sd === 0 && (rm === 1 && xc[0] >= 5 || rm === 2 && (xc[0] > 5 || xc[0] === 5 && (more || xc[1] !== UNDEFINED)));
				xc.length = 1;
				if (more) {
					x.e = x.e - sd + 1;
					xc[0] = 1;
				} else xc[0] = x.e = 0;
			} else if (sd < xc.length) {
				more = rm === 1 && xc[sd] >= 5 || rm === 2 && (xc[sd] > 5 || xc[sd] === 5 && (more || xc[sd + 1] !== UNDEFINED || xc[sd - 1] & 1)) || rm === 3 && (more || !!xc[0]);
				xc.length = sd;
				if (more) for (; ++xc[--sd] > 9;) {
					xc[sd] = 0;
					if (sd === 0) {
						++x.e;
						xc.unshift(1);
						break;
					}
				}
				for (sd = xc.length; !xc[--sd];) xc.pop();
			}
			return x;
		}
		function stringify(x, doExponential, isNonzero) {
			var e = x.e, s = x.c.join(""), n = s.length;
			if (doExponential) s = s.charAt(0) + (n > 1 ? "." + s.slice(1) : "") + (e < 0 ? "e" : "e+") + e;
			else if (e < 0) {
				for (; ++e;) s = "0" + s;
				s = "0." + s;
			} else if (e > 0) {
				if (++e > n) for (e -= n; e--;) s += "0";
				else if (e < n) s = s.slice(0, e) + "." + s.slice(e);
			} else if (n > 1) s = s.charAt(0) + "." + s.slice(1);
			return x.s < 0 && isNonzero ? "-" + s : s;
		}
		P.abs = function() {
			var x = new this.constructor(this);
			x.s = 1;
			return x;
		};
		P.cmp = function(y) {
			var isneg, x = this, xc = x.c, yc = (y = new x.constructor(y)).c, i = x.s, j = y.s, k = x.e, l = y.e;
			if (!xc[0] || !yc[0]) return !xc[0] ? !yc[0] ? 0 : -j : i;
			if (i != j) return i;
			isneg = i < 0;
			if (k != l) return k > l ^ isneg ? 1 : -1;
			j = (k = xc.length) < (l = yc.length) ? k : l;
			for (i = -1; ++i < j;) if (xc[i] != yc[i]) return xc[i] > yc[i] ^ isneg ? 1 : -1;
			return k == l ? 0 : k > l ^ isneg ? 1 : -1;
		};
		P.div = function(y) {
			var x = this, Big = x.constructor, a = x.c, b = (y = new Big(y)).c, k = x.s == y.s ? 1 : -1, dp = Big.DP;
			if (dp !== ~~dp || dp < 0 || dp > MAX_DP) throw Error(INVALID_DP);
			if (!b[0]) throw Error(DIV_BY_ZERO);
			if (!a[0]) {
				y.s = k;
				y.c = [y.e = 0];
				return y;
			}
			var bl, bt, n, cmp, ri, bz = b.slice(), ai = bl = b.length, al = a.length, r = a.slice(0, bl), rl = r.length, q = y, qc = q.c = [], qi = 0, p = dp + (q.e = x.e - y.e) + 1;
			q.s = k;
			k = p < 0 ? 0 : p;
			bz.unshift(0);
			for (; rl++ < bl;) r.push(0);
			do {
				for (n = 0; n < 10; n++) {
					if (bl != (rl = r.length)) cmp = bl > rl ? 1 : -1;
					else for (ri = -1, cmp = 0; ++ri < bl;) if (b[ri] != r[ri]) {
						cmp = b[ri] > r[ri] ? 1 : -1;
						break;
					}
					if (cmp < 0) {
						for (bt = rl == bl ? b : bz; rl;) {
							if (r[--rl] < bt[rl]) {
								ri = rl;
								for (; ri && !r[--ri];) r[ri] = 9;
								--r[ri];
								r[rl] += 10;
							}
							r[rl] -= bt[rl];
						}
						for (; !r[0];) r.shift();
					} else break;
				}
				qc[qi++] = cmp ? n : ++n;
				if (r[0] && cmp) r[rl] = a[ai] || 0;
				else r = [a[ai]];
			} while ((ai++ < al || r[0] !== UNDEFINED) && k--);
			if (!qc[0] && qi != 1) {
				qc.shift();
				q.e--;
				p--;
			}
			if (qi > p) round(q, p, Big.RM, r[0] !== UNDEFINED);
			return q;
		};
		P.eq = function(y) {
			return this.cmp(y) === 0;
		};
		P.gt = function(y) {
			return this.cmp(y) > 0;
		};
		P.gte = function(y) {
			return this.cmp(y) > -1;
		};
		P.lt = function(y) {
			return this.cmp(y) < 0;
		};
		P.lte = function(y) {
			return this.cmp(y) < 1;
		};
		P.minus = P.sub = function(y) {
			var i, j, t, xlty, x = this, Big = x.constructor, a = x.s, b = (y = new Big(y)).s;
			if (a != b) {
				y.s = -b;
				return x.plus(y);
			}
			var xc = x.c.slice(), xe = x.e, yc = y.c, ye = y.e;
			if (!xc[0] || !yc[0]) {
				if (yc[0]) y.s = -b;
				else if (xc[0]) y = new Big(x);
				else y.s = 1;
				return y;
			}
			if (a = xe - ye) {
				if (xlty = a < 0) {
					a = -a;
					t = xc;
				} else {
					ye = xe;
					t = yc;
				}
				t.reverse();
				for (b = a; b--;) t.push(0);
				t.reverse();
			} else {
				j = ((xlty = xc.length < yc.length) ? xc : yc).length;
				for (a = b = 0; b < j; b++) if (xc[b] != yc[b]) {
					xlty = xc[b] < yc[b];
					break;
				}
			}
			if (xlty) {
				t = xc;
				xc = yc;
				yc = t;
				y.s = -y.s;
			}
			if ((b = (j = yc.length) - (i = xc.length)) > 0) for (; b--;) xc[i++] = 0;
			for (b = i; j > a;) {
				if (xc[--j] < yc[j]) {
					for (i = j; i && !xc[--i];) xc[i] = 9;
					--xc[i];
					xc[j] += 10;
				}
				xc[j] -= yc[j];
			}
			for (; xc[--b] === 0;) xc.pop();
			for (; xc[0] === 0;) {
				xc.shift();
				--ye;
			}
			if (!xc[0]) {
				y.s = 1;
				xc = [ye = 0];
			}
			y.c = xc;
			y.e = ye;
			return y;
		};
		P.mod = function(y) {
			var ygtx, x = this, Big = x.constructor, a = x.s, b = (y = new Big(y)).s;
			if (!y.c[0]) throw Error(DIV_BY_ZERO);
			x.s = y.s = 1;
			ygtx = y.cmp(x) == 1;
			x.s = a;
			y.s = b;
			if (ygtx) return new Big(x);
			a = Big.DP;
			b = Big.RM;
			Big.DP = Big.RM = 0;
			x = x.div(y);
			Big.DP = a;
			Big.RM = b;
			return this.minus(x.times(y));
		};
		P.neg = function() {
			var x = new this.constructor(this);
			x.s = -x.s;
			return x;
		};
		P.plus = P.add = function(y) {
			var e, k, t, x = this, Big = x.constructor;
			y = new Big(y);
			if (x.s != y.s) {
				y.s = -y.s;
				return x.minus(y);
			}
			var xe = x.e, xc = x.c, ye = y.e, yc = y.c;
			if (!xc[0] || !yc[0]) {
				if (!yc[0]) if (xc[0]) y = new Big(x);
				else y.s = x.s;
				return y;
			}
			xc = xc.slice();
			if (e = xe - ye) {
				if (e > 0) {
					ye = xe;
					t = yc;
				} else {
					e = -e;
					t = xc;
				}
				t.reverse();
				for (; e--;) t.push(0);
				t.reverse();
			}
			if (xc.length - yc.length < 0) {
				t = yc;
				yc = xc;
				xc = t;
			}
			e = yc.length;
			for (k = 0; e; xc[e] %= 10) k = (xc[--e] = xc[e] + yc[e] + k) / 10 | 0;
			if (k) {
				xc.unshift(k);
				++ye;
			}
			for (e = xc.length; xc[--e] === 0;) xc.pop();
			y.c = xc;
			y.e = ye;
			return y;
		};
		P.pow = function(n) {
			var x = this, one = new x.constructor("1"), y = one, isneg = n < 0;
			if (n !== ~~n || n < -MAX_POWER || n > MAX_POWER) throw Error(INVALID + "exponent");
			if (isneg) n = -n;
			for (;;) {
				if (n & 1) y = y.times(x);
				n >>= 1;
				if (!n) break;
				x = x.times(x);
			}
			return isneg ? one.div(y) : y;
		};
		P.prec = function(sd, rm) {
			if (sd !== ~~sd || sd < 1 || sd > MAX_DP) throw Error(INVALID + "precision");
			return round(new this.constructor(this), sd, rm);
		};
		P.round = function(dp, rm) {
			if (dp === UNDEFINED) dp = 0;
			else if (dp !== ~~dp || dp < -MAX_DP || dp > MAX_DP) throw Error(INVALID_DP);
			return round(new this.constructor(this), dp + this.e + 1, rm);
		};
		P.sqrt = function() {
			var r, c, t, x = this, Big = x.constructor, s = x.s, e = x.e, half = new Big("0.5");
			if (!x.c[0]) return new Big(x);
			if (s < 0) throw Error(NAME + "No square root");
			s = Math.sqrt(+stringify(x, true, true));
			if (s === 0 || s === Infinity) {
				c = x.c.join("");
				if (!(c.length + e & 1)) c += "0";
				s = Math.sqrt(c);
				e = ((e + 1) / 2 | 0) - (e < 0 || e & 1);
				r = new Big((s == Infinity ? "5e" : (s = s.toExponential()).slice(0, s.indexOf("e") + 1)) + e);
			} else r = new Big(s + "");
			e = r.e + (Big.DP += 4);
			do {
				t = r;
				r = half.times(t.plus(x.div(t)));
			} while (t.c.slice(0, e).join("") !== r.c.slice(0, e).join(""));
			return round(r, (Big.DP -= 4) + r.e + 1, Big.RM);
		};
		P.times = P.mul = function(y) {
			var c, x = this, Big = x.constructor, xc = x.c, yc = (y = new Big(y)).c, a = xc.length, b = yc.length, i = x.e, j = y.e;
			y.s = x.s == y.s ? 1 : -1;
			if (!xc[0] || !yc[0]) {
				y.c = [y.e = 0];
				return y;
			}
			y.e = i + j;
			if (a < b) {
				c = xc;
				xc = yc;
				yc = c;
				j = a;
				a = b;
				b = j;
			}
			for (c = new Array(j = a + b); j--;) c[j] = 0;
			for (i = b; i--;) {
				b = 0;
				for (j = a + i; j > i;) {
					b = c[j] + yc[i] * xc[j - i - 1] + b;
					c[j--] = b % 10;
					b = b / 10 | 0;
				}
				c[j] = b;
			}
			if (b) ++y.e;
			else c.shift();
			for (i = c.length; !c[--i];) c.pop();
			y.c = c;
			return y;
		};
		P.toExponential = function(dp, rm) {
			var x = this, n = x.c[0];
			if (dp !== UNDEFINED) {
				if (dp !== ~~dp || dp < 0 || dp > MAX_DP) throw Error(INVALID_DP);
				x = round(new x.constructor(x), ++dp, rm);
				for (; x.c.length < dp;) x.c.push(0);
			}
			return stringify(x, true, !!n);
		};
		P.toFixed = function(dp, rm) {
			var x = this, n = x.c[0];
			if (dp !== UNDEFINED) {
				if (dp !== ~~dp || dp < 0 || dp > MAX_DP) throw Error(INVALID_DP);
				x = round(new x.constructor(x), dp + x.e + 1, rm);
				for (dp = dp + x.e + 1; x.c.length < dp;) x.c.push(0);
			}
			return stringify(x, false, !!n);
		};
		P.toJSON = P.toString = function() {
			var x = this, Big = x.constructor;
			return stringify(x, x.e <= Big.NE || x.e >= Big.PE, !!x.c[0]);
		};
		if (typeof Symbol !== "undefined") P[Symbol.for("nodejs.util.inspect.custom")] = P.toJSON;
		P.toNumber = function() {
			var n = +stringify(this, true, true);
			if (this.constructor.strict === true && !this.eq(n.toString())) throw Error(NAME + "Imprecise conversion");
			return n;
		};
		P.toPrecision = function(sd, rm) {
			var x = this, Big = x.constructor, n = x.c[0];
			if (sd !== UNDEFINED) {
				if (sd !== ~~sd || sd < 1 || sd > MAX_DP) throw Error(INVALID + "precision");
				x = round(new Big(x), sd, rm);
				for (; x.c.length < sd;) x.c.push(0);
			}
			return stringify(x, sd <= x.e || x.e <= Big.NE || x.e >= Big.PE, !!n);
		};
		P.valueOf = function() {
			var x = this, Big = x.constructor;
			if (Big.strict === true) throw Error(NAME + "valueOf disallowed");
			return stringify(x, x.e <= Big.NE || x.e >= Big.PE, true);
		};
		var Big = _Big_();
		//#endregion
		//#region lib/types/client/formatBalance.js
		/** Platform Web currency formatting for account balances; source amounts retain decimal precision. */
		/**
		* Format a balance using Platform Web's two-decimal and sub-cent display rules.
		* @param amount - validated decimal balance string.
		* @param symbol - currency symbol.
		* @returns signed currency text with grouped digits.
		*/
		function formatBalance(amount, symbol) {
			const value = new Big(amount);
			if (value.eq(0)) return `${symbol}0.00`;
			if (value.lt(0)) return `-${symbol}${value.gt(-.01) ? "0.01" : addCommas(value.abs().toFixed(2))}`;
			if (value.lt("0.01")) return `<${symbol}0.01`;
			return `${symbol}${addCommas(value.round(2, Big.roundDown).toFixed(2))}`;
		}
		function addCommas(value) {
			const [integer, fraction] = value.split(".");
			return `${Number(integer).toLocaleString()}.${fraction}`;
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-settings-account/src/client/AccountSection.module.css.mjs
		const css$2 = ".LcmJYa_section{color:var(--dsw-alias-label-primary);flex-direction:column;gap:16px;padding:8px 0;font-size:13px;line-height:22px;display:flex}.LcmJYa_card,.LcmJYa_balanceCard{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);padding:12px 16px}.LcmJYa_card,.LcmJYa_row{justify-content:space-between;align-items:center;gap:16px;display:flex}.LcmJYa_identity{align-items:center;gap:10px;min-width:0;min-height:44px;display:flex}.LcmJYa_avatar{corner-shape:round;width:32px;height:32px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-skeleton);border-radius:50%;flex:none;justify-content:center;align-items:center;display:flex}.LcmJYa_identityCopy{flex-direction:column;min-width:0;display:flex}.LcmJYa_name{font-size:14px;font-weight:500}.LcmJYa_status,.LcmJYa_secondary,.LcmJYa_unavailable{color:var(--dsw-alias-label-tertiary)}.LcmJYa_balanceCard{flex-direction:column;gap:8px;display:flex}.LcmJYa_row{box-sizing:border-box;min-height:40px;padding:6px 0}.LcmJYa_divider{border-top:.5px solid var(--dsw-alias-border-l2)}.LcmJYa_links,.LcmJYa_actions{flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:10px;display:flex}.LcmJYa_linkButton{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);white-space:nowrap;min-width:58px;height:36px;color:var(--dsw-alias-label-primary);background:0 0;flex:none;justify-content:center;align-items:center;padding:0 14px;font-size:14px;line-height:22px;text-decoration:none;display:inline-flex}@media (hover:hover){.LcmJYa_linkButton:hover{background:var(--dsw-alias-interactive-bg-hover)}}.LcmJYa_linkButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}.LcmJYa_unavailableLink{color:var(--dsw-alias-label-tertiary);text-underline-offset:3px;text-decoration:underline}@media (hover:hover){.LcmJYa_unavailableLink:hover{color:var(--dsw-alias-label-primary)}}.LcmJYa_unavailableLink:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:4px}.LcmJYa_primary{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border-color:#0000;font-weight:500}@media (hover:hover){.LcmJYa_primary:hover{background:var(--dsw-alias-button-primary-hover)}}.LcmJYa_signedOut{box-sizing:border-box;min-height:calc(100% + 16px);color:var(--dsw-alias-label-primary);flex-direction:column;justify-content:center;align-items:center;margin-bottom:-16px;padding-bottom:8px;display:flex}.LcmJYa_signedOutContent{flex-direction:column;justify-content:center;align-items:center;gap:20px;width:100%;min-height:60px;padding:12px 0;display:flex}.LcmJYa_signedOutCopy{text-align:center;flex-direction:column;gap:4px;width:100%;display:flex}.LcmJYa_signedOutTitle{font-size:14px;line-height:22px}.LcmJYa_signedOutDescription{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.LcmJYa_signInButton{min-width:72px;font-weight:500}.LcmJYa_amount{flex-wrap:wrap;justify-content:flex-end;font-size:18px;font-weight:510;line-height:28px;display:flex}.LcmJYa_amount>span+span:before{content:\" + \";white-space:pre}.LcmJYa_accountInfo{color:var(--dsw-alias-label-primary);flex:none;align-items:center;gap:2px;font-size:13px;line-height:22px;text-decoration:none;display:inline-flex}.LcmJYa_bonusValue{justify-content:flex-end;align-items:center;gap:8px;display:flex}";
		const tagId$2 = "@deepseek-ai/dsh-client-ui-settings-account/AccountSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-settings-account";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var AccountSection_module_css_default = {
			"accountInfo": "LcmJYa_accountInfo",
			"actions": "LcmJYa_actions",
			"amount": "LcmJYa_amount",
			"avatar": "LcmJYa_avatar",
			"balanceCard": "LcmJYa_balanceCard",
			"bonusValue": "LcmJYa_bonusValue",
			"card": "LcmJYa_card",
			"divider": "LcmJYa_divider",
			"identity": "LcmJYa_identity",
			"identityCopy": "LcmJYa_identityCopy",
			"linkButton": "LcmJYa_linkButton",
			"links": "LcmJYa_links",
			"name": "LcmJYa_name",
			"primary": "LcmJYa_primary",
			"row": "LcmJYa_row",
			"secondary": "LcmJYa_secondary",
			"section": "LcmJYa_section",
			"signInButton": "LcmJYa_signInButton",
			"signedOut": "LcmJYa_signedOut",
			"signedOutContent": "LcmJYa_signedOutContent",
			"signedOutCopy": "LcmJYa_signedOutCopy",
			"signedOutDescription": "LcmJYa_signedOutDescription",
			"signedOutTitle": "LcmJYa_signedOutTitle",
			"status": "LcmJYa_status",
			"unavailable": "LcmJYa_unavailable",
			"unavailableLink": "LcmJYa_unavailableLink"
		};
		//#endregion
		//#region lib/types/client/AccountSection.js
		/** Account settings renders safe Host state and explicit login actions. */
		/** @param props - localized actions, account subscription, and the shared Platform page channel. @returns account settings UI. */
		function AccountSection({ t, useAccount, useTheme, start, cancel, openPlatformPage, avatarFailed }) {
			const { view: state, details, avatar, failed: streamFailed } = useAccount((value) => value);
			const colorScheme = useTheme((snapshot) => snapshot.active.colorScheme);
			const releasePage = (0, react.useRef)(void 0);
			const [failed, setFailed] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const profile = details?.profile?.status === "ready" ? details.profile.value : void 0;
			const wallets = details?.balance?.status === "ready" ? details.balance.value : void 0;
			const bonusWallets = details?.balance?.status === "ready" ? details.balance.bonusWallets.filter((wallet) => new Big(wallet.balance).gt(0)) : [];
			const showBonusRow = details?.balance?.status !== "ready" || bonusWallets.length > 0;
			const attempt = state?.attempt;
			const active = attempt !== null && attempt !== void 0 && [
				"initializing",
				"waiting-browser",
				"exchanging",
				"committing"
			].includes(attempt.phase);
			const signedIn = state?.status === "credential-stored";
			(0, react.useEffect)(() => () => {
				releasePage.current?.();
				releasePage.current = void 0;
			}, []);
			(0, react.useEffect)(() => {
				if (signedIn) return;
				releasePage.current?.();
				releasePage.current = void 0;
			}, [signedIn]);
			const showPage = (open, page) => {
				releasePage.current?.();
				releasePage.current = open(page, () => {
					releasePage.current = void 0;
				});
			};
			const run = async (action) => {
				setBusy(true);
				setFailed(false);
				try {
					await action();
				} catch {
					setFailed(true);
				} finally {
					setBusy(false);
				}
			};
			/**
			* @param event - click on a Platform destination link.
			* @returns nothing; on Desktop the embedded page replaces the pending navigation.
			*/
			const openUsage = (event) => {
				if (openPlatformPage !== void 0 && signedIn) {
					event.preventDefault();
					showPage(openPlatformPage, "usage");
				}
			};
			/**
			* The Platform entry the balance rows share with the Usage action: an embedded page on
			* Desktop, a new tab elsewhere. A wallet read that failed still reaches the same
			* destination, so the user can inspect the balance the Harness could not load; the
			* destination comes from the account links, not from the wallet response.
			* @param label - localized link copy.
			* @param className - link treatment for the row that renders it, absent when the sheet has no such rule.
			* @returns the Platform anchor.
			*/
			const platformLink = (label, className) => (0, react_jsx_runtime.jsx)("a", {
				className,
				href: state?.links.usageUrl,
				"aria-disabled": state === void 0,
				target: "_blank",
				rel: "noreferrer",
				onClick: openUsage,
				children: label
			});
			const status = failed || streamFailed || attempt?.phase === "failed" ? t("failed") : attempt?.phase === "expired" ? t("expired") : active ? t(attempt.phase === "initializing" ? "initializing" : attempt.phase === "waiting-browser" ? "waiting" : "completing") : signedIn ? profile?.contact ?? t(details?.profile === void 0 ? "loading" : "profileUnavailable") : t("signInDescription");
			if (!signedIn && !active) return (0, react_jsx_runtime.jsx)("section", {
				className: AccountSection_module_css_default.signedOut,
				"aria-label": t("nav"),
				children: (0, react_jsx_runtime.jsxs)("div", {
					className: AccountSection_module_css_default.signedOutContent,
					children: [(0, react_jsx_runtime.jsxs)("div", {
						className: AccountSection_module_css_default.signedOutCopy,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: AccountSection_module_css_default.signedOutTitle,
							children: t("settingsSignedOutTitle")
						}), (0, react_jsx_runtime.jsx)("span", {
							className: AccountSection_module_css_default.signedOutDescription,
							role: "status",
							children: failed || streamFailed ? t("failed") : t("settingsSignedOutDescription")
						})]
					}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "primary",
						className: AccountSection_module_css_default.signInButton,
						disabled: busy || state === void 0,
						onClick: () => {
							run(start);
						},
						children: t("signIn")
					})]
				})
			});
			return (0, react_jsx_runtime.jsxs)("section", {
				className: AccountSection_module_css_default.section,
				"aria-label": t("nav"),
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: AccountSection_module_css_default.card,
						children: [(0, react_jsx_runtime.jsxs)("div", {
							className: AccountSection_module_css_default.identity,
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: AccountSection_module_css_default.avatar,
								"data-avatar-status": signedIn ? avatar?.status : void 0,
								children: (0, react_jsx_runtime.jsx)(AccountAvatar, {
									avatar: signedIn ? avatar : void 0,
									avatarFailed
								})
							}), (0, react_jsx_runtime.jsxs)("div", {
								className: AccountSection_module_css_default.identityCopy,
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: AccountSection_module_css_default.name,
									children: signedIn ? profile?.name ?? t("signedIn") : t("signedOut")
								}), (0, react_jsx_runtime.jsx)("span", {
									className: AccountSection_module_css_default.status,
									role: "status",
									children: status
								})]
							})]
						}), signedIn && (0, react_jsx_runtime.jsxs)("a", {
							className: AccountSection_module_css_default.accountInfo,
							href: new URL("/", state.links.usageUrl).href,
							target: "_blank",
							rel: "noopener noreferrer",
							children: [t("accountInfo"), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRightUpOutlineRegular, { size: 12 })]
						})]
					}),
					active && (0, react_jsx_runtime.jsxs)("div", {
						className: AccountSection_module_css_default.actions,
						children: [attempt.authorizeUrl && (0, react_jsx_runtime.jsx)("a", {
							className: AccountSection_module_css_default.linkButton,
							href: authorizeUrlWithTheme(attempt.authorizeUrl, colorScheme),
							target: "_blank",
							rel: "noreferrer",
							children: t("open")
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							disabled: busy || attempt.phase === "committing",
							onClick: () => {
								run(() => cancel(attempt.id));
							},
							children: t("cancel")
						})]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: AccountSection_module_css_default.balanceCard,
						children: [
							(0, react_jsx_runtime.jsxs)("div", {
								className: AccountSection_module_css_default.row,
								children: [(0, react_jsx_runtime.jsx)("span", { children: t("balance") }), signedIn && wallets !== void 0 && wallets.length > 0 ? (0, react_jsx_runtime.jsx)("span", {
									className: AccountSection_module_css_default.amount,
									children: wallets.map((wallet) => (0, react_jsx_runtime.jsx)("span", { children: formatBalance(wallet.balance, wallet.currency === "CNY" ? "¥" : "$") }, wallet.currency))
								}) : !signedIn || details?.balance === void 0 ? (0, react_jsx_runtime.jsx)("span", {
									className: AccountSection_module_css_default.unavailable,
									children: t(!signedIn ? "balanceSignedOut" : "loading")
								}) : platformLink(t("balanceUnavailable"), AccountSection_module_css_default.unavailableLink)]
							}),
							signedIn && showBonusRow && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("div", { className: AccountSection_module_css_default.divider }), (0, react_jsx_runtime.jsxs)("div", {
								className: AccountSection_module_css_default.row,
								children: [(0, react_jsx_runtime.jsx)("span", { children: t("bonusBalance") }), (0, react_jsx_runtime.jsx)("span", {
									className: AccountSection_module_css_default.bonusValue,
									children: bonusWallets.length > 0 ? (0, react_jsx_runtime.jsx)("span", {
										className: AccountSection_module_css_default.amount,
										children: bonusWallets.map((wallet) => (0, react_jsx_runtime.jsx)("span", { children: formatBalance(wallet.balance, wallet.currency === "CNY" ? "¥" : "$") }, wallet.currency))
									}) : details?.balance === void 0 ? (0, react_jsx_runtime.jsx)("span", {
										className: AccountSection_module_css_default.unavailable,
										children: t("loading")
									}) : platformLink(t("balanceUnavailable"), AccountSection_module_css_default.unavailableLink)
								})]
							})] }),
							(0, react_jsx_runtime.jsx)("div", { className: AccountSection_module_css_default.divider }),
							(0, react_jsx_runtime.jsxs)("div", {
								className: AccountSection_module_css_default.row,
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: AccountSection_module_css_default.secondary,
									children: t("more")
								}), (0, react_jsx_runtime.jsxs)("div", {
									className: AccountSection_module_css_default.links,
									children: [platformLink(t("usage"), AccountSection_module_css_default.linkButton), (0, react_jsx_runtime.jsx)("a", {
										className: `${AccountSection_module_css_default.linkButton} ${AccountSection_module_css_default.primary}`,
										href: state?.links.topUpUrl,
										"aria-disabled": state === void 0,
										target: "_blank",
										rel: "noreferrer",
										onClick: (event) => {
											if (openPlatformPage !== void 0 && signedIn) {
												event.preventDefault();
												showPage(openPlatformPage, "top-up");
											}
										},
										children: t("topUp")
									})]
								})]
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/bonus-notices.js
		/**
		* @param expiresAt - server expiration timestamp.
		* @param at - milliseconds since epoch.
		* @returns whether the bonus can no longer be shown.
		*/
		function expired(expiresAt, at) {
			if (expiresAt === "") return false;
			const expires = Date.parse(expiresAt);
			return !Number.isNaN(expires) && expires <= at;
		}
		/**
		* Own the read, display, and acknowledgement lifecycle of bonus notices.
		* @param options - collaborators and timings.
		* @returns the controller the account plugin drives from account and settings state.
		*/
		function createBonusNoticeController(options) {
			let scope;
			/** Notice currently published to the sidebar, including the expiration checked at display time. */
			let current = [];
			/** Newest read; an older read still in flight has its result dropped once a newer one starts. */
			let readGeneration = 0;
			let ackTimer;
			let ackInFlight = false;
			let ackDelay = options.ackRetryDelayMs;
			/** Orders the card on screen already reported, so one mount cannot acknowledge twice. */
			const reported = /* @__PURE__ */ new Set();
			const clearAckTimer = () => {
				if (ackTimer !== void 0) {
					clearTimeout(ackTimer);
					ackTimer = void 0;
				}
			};
			const setCurrent = (notices) => {
				if (notices.length === current.length && notices.every((notice, index) => {
					const previous = current[index];
					return notice.orderId === previous?.orderId && notice.message === previous.message && notice.title === previous.title && notice.expiresAt === previous.expiresAt;
				})) return;
				const retained = new Set(notices.map((notice) => notice.orderId));
				for (const orderId of reported) if (!retained.has(orderId)) reported.delete(orderId);
				current = notices;
				options.publish(notices);
			};
			const scheduleAck = (delay) => {
				clearAckTimer();
				ackTimer = setTimeout(() => {
					runAcks();
				}, delay);
			};
			/** Drop acknowledgement work of the previous account or lifecycle, so its carry-over cannot reach the next one. */
			const resetAcks = () => {
				clearAckTimer();
				ackInFlight = false;
				ackDelay = options.ackRetryDelayMs;
			};
			const startAcks = () => {
				if (scope !== void 0 && scope.pending.length > 0) scheduleAck(0);
			};
			/**
			* Apply the server-ordered stack, excluding expired notices. An empty batch
			* retains only the foreground card if the user has already seen it.
			*/
			const apply = (scopeAtRead, batch) => {
				if (scopeAtRead.accountId !== batch.accountId) {
					scopeAtRead.accountId = batch.accountId;
					scopeAtRead.pending.length = 0;
					resetAcks();
					setCurrent([]);
				}
				const candidates = batch.bonuses.filter((notice) => !expired(notice.expiresAt, Date.now()));
				if (candidates.length === 0) {
					const foreground = current[0];
					setCurrent(foreground !== void 0 && reported.has(foreground.orderId) ? [foreground] : []);
					return;
				}
				setCurrent(candidates);
			};
			/**
			* Read once for one live lifecycle. A newer read supersedes one in flight: the
			* older result is dropped instead of applied, so only the newest read can report
			* an account change.
			* @param scopeAtRead - lifecycle this read belongs to.
			* @returns after this read settles.
			*/
			function runRead(scopeAtRead) {
				const generation = ++readGeneration;
				return (async () => {
					let batch;
					try {
						batch = await options.read();
					} catch {
						batch = null;
					}
					if (scope !== scopeAtRead || generation !== readGeneration) return;
					if (batch !== null) apply(scopeAtRead, batch);
				})();
			}
			/**
			* Acknowledge presented orders one at a time. A protocol failure backs off up
			* to the ceiling and retries for the rest of the signed-in lifecycle, which
			* never persists. A false answer settles the order without a retry: this
			* session cannot make the server accept it. A hidden window keeps retrying,
			* because the presented frame is what a pending acknowledgement proves.
			*/
			async function runAcks() {
				const scopeAtCall = scope;
				if (scopeAtCall === void 0 || ackInFlight) return;
				const accountId = scopeAtCall.accountId;
				const orderId = scopeAtCall.pending[0];
				/* v8 ignore next -- an acknowledgement runs only while a read named the account and left a pending order */
				if (accountId === void 0 || orderId === void 0) return;
				ackInFlight = true;
				/** @returns whether this call still owns the lifecycle and account it started for. */
				const owns = () => scope === scopeAtCall && scopeAtCall.accountId === accountId;
				let acknowledged;
				try {
					acknowledged = await options.acknowledge(accountId, orderId);
				} catch {
					if (!owns()) return;
					ackInFlight = false;
					scheduleAck(ackDelay);
					ackDelay = Math.min(ackDelay * 2, options.ackRetryMaxDelayMs);
					return;
				}
				if (!owns()) return;
				ackInFlight = false;
				/* v8 ignore next -- the call owns the scope, and this order is its head until this shift */
				if (scopeAtCall.pending[0] === orderId) scopeAtCall.pending.shift();
				ackDelay = options.ackRetryDelayMs;
				if (acknowledged && scopeAtCall.pending.length > 0) scheduleAck(0);
				else clearAckTimer();
			}
			/** Queue a presented order, so an acknowledgement interrupted by a failure retries within this sign-in. */
			const report = (orderId) => {
				const scopeAtReport = scope;
				if (scopeAtReport === void 0 || current[0]?.orderId !== orderId || reported.has(orderId)) return;
				reported.add(orderId);
				if (!scopeAtReport.pending.includes(orderId)) scopeAtReport.pending.push(orderId);
				ackDelay = options.ackRetryDelayMs;
				scheduleAck(0);
			};
			const endLifecycle = () => {
				if (scope === void 0) return;
				resetAcks();
				scope = void 0;
				reported.clear();
				setCurrent([]);
			};
			return {
				begin() {
					scope ??= { pending: [] };
					runRead(scope);
				},
				end: endLifecycle,
				refresh() {
					if (scope === void 0) return Promise.resolve();
					startAcks();
					return runRead(scope);
				},
				shown(orderId) {
					setCurrent(current.filter((notice) => !expired(notice.expiresAt, Date.now())));
					if (current[0]?.orderId !== orderId) return;
					report(orderId);
				},
				dismiss(orderId) {
					setCurrent(current.filter((notice) => !expired(notice.expiresAt, Date.now())));
					if (current[0]?.orderId !== orderId) return;
					report(orderId);
					setCurrent(current.slice(1).filter((notice) => !expired(notice.expiresAt, Date.now())));
				}
			};
		}
		//#endregion
		//#region lib/types/client/client-metadata.js
		/**
		* Build the request identity for one account call.
		* @param locale - active UI language; the Host reduces it to the Platform wire locale.
		* @param version - client build version inlined by the bundle.
		* @returns the metadata the account Remote methods carry.
		* @throws Error when the build carries no version, instead of reporting an empty one.
		*/
		function accountClientMetadata(locale, version) {
			if (version === void 0 || version === "") throw new Error("account: this client build carries no DSH_CLIENT_VERSION");
			return {
				version,
				locale,
				timezoneOffsetSeconds: -(/* @__PURE__ */ new Date()).getTimezoneOffset() * 60
			};
		}
		//#endregion
		//#region lib/types/client/locales/onboarding.js
		/** Chinese first-run copy from the onboarding requirements. */
		const onboardingZh = {
			onboardingArtworkLocale: "zh",
			onboardingWelcome: "欢迎使用",
			onboardingBrand: "DeepSeek Harness",
			onboardingIntroduction: "DeepSeek Harness 会以本地文件夹作为工作区，通过调用各种工具，读写本机文件，完成搜索整理资料、制作文档表格、编写代码、排查问题等各种任务。",
			onboardingStart: "开始设置",
			onboardingCredit: "准备可用额度",
			onboardingCreditDescription: "DeepSeek Harness 执行任务时，会根据模型与工具使用的 token 量扣除额度。请提前添加额度，避免任务在执行过程中被迫中断。你的余额只会在 Agent 实际执行任务时消耗。",
			onboardingTopUp: "去充值",
			onboardingLater: "下一步",
			onboardingFundedTopUp: "去充值",
			onboardingPurposePrefix: "你希望",
			onboardingPurposeSuffix: "帮你做什么？",
			onboardingPurposeDescription: "我们会根据你的选择调整界面和工具，以更适合你的工作方式。",
			onboardingOffice: "办公与创作",
			onboardingOfficeDescription: "编辑文档、整理数据和制作演示文稿等",
			onboardingDevelopment: "代码与开发",
			onboardingDevelopmentDescription: "修改代码、调试问题、运行命令和管理项目文件等",
			onboardingContinue: "继续",
			onboardingProcess: "你希望看到多少工作过程？",
			onboardingProcessDescription: "这只会影响工作过程的展示方式，不会影响 DeepSeek Harness 的工作能力。",
			onboardingCompact: "聚焦结果",
			onboardingCompactDescription: "只看结果，保持界面简洁明了",
			onboardingStandard: "关键细节",
			onboardingStandardDescription: "结果优先，仅展示重要步骤和关键操作",
			onboardingDetailed: "完整过程",
			onboardingDetailedDescription: "查看完整工作过程，方便调试和排查问题",
			onboardingEnter: "进入应用",
			onboardingBack: "上一步",
			onboardingSkip: "跳过",
			onboardingSkipTitle: "跳过设置？",
			onboardingSkipDescription: "你可以随时前往 设置 → 通用设置 中调整工作过程、性能与用量展示方式或开启代码工作工具。",
			onboardingKeepSetting: "继续设置",
			onboardingNoCreditTitle: "暂时跳过充值？",
			onboardingNoCreditDescription: "没有可用额度时，DeepSeek Harness 将无法开始新的任务。你可以稍后前往 设置 → 账号与余额 进行充值。",
			onboardingUnderstood: "我知道了",
			onboardingGoTopUp: "前往充值",
			onboardingSaveFailed: "未能保存设置，请重试。",
			onboardingRetry: "重试",
			onboardingLoading: "正在加载设置…"
		};
		/** English first-run copy with the same keys as the Chinese dictionary. */
		const onboardingEn = {
			onboardingArtworkLocale: "en",
			onboardingWelcome: "Welcome to",
			onboardingBrand: "DeepSeek Harness",
			onboardingIntroduction: "DeepSeek Harness works in a local folder and uses tools to read and write files on your computer. It can help you research and organize information, create documents and spreadsheets, write code, troubleshoot issues, and more.",
			onboardingStart: "Get started",
			onboardingCredit: "Add credits",
			onboardingCreditDescription: "DeepSeek Harness charges credits based on the tokens used by models and tools. Add credits in advance to keep your tasks running without interruption. Your balance is only used while the agent is working on a task.",
			onboardingTopUp: "Add credits",
			onboardingLater: "Next",
			onboardingFundedTopUp: "Add credits",
			onboardingPurposePrefix: "What would you like",
			onboardingPurposeSuffix: "to help with?",
			onboardingPurposeDescription: "We’ll tailor the interface and tools to fit the way you work.",
			onboardingOffice: "Office & creative work",
			onboardingOfficeDescription: "Edit documents, organize data, create presentations, and more",
			onboardingDevelopment: "Coding & development",
			onboardingDevelopmentDescription: "Edit code, debug issues, run commands, manage project files, and more",
			onboardingContinue: "Continue",
			onboardingProcess: "How much detail would you like to see?",
			onboardingProcessDescription: "This only changes how progress is shown, not what DeepSeek Harness can do.",
			onboardingCompact: "Results only",
			onboardingCompactDescription: "See just the results in a clean, simple interface",
			onboardingStandard: "Key details",
			onboardingStandardDescription: "Focus on results, with only the most important steps and actions shown",
			onboardingDetailed: "Full details",
			onboardingDetailedDescription: "See the full process for easier debugging and troubleshooting",
			onboardingEnter: "Open app",
			onboardingBack: "Back",
			onboardingSkip: "Skip",
			onboardingSkipTitle: "Skip setup?",
			onboardingSkipDescription: "You can change how progress, performance, and usage are displayed, or enable Coding Tools, anytime in Settings → General.",
			onboardingKeepSetting: "Continue setup",
			onboardingNoCreditTitle: "Skip adding credits?",
			onboardingNoCreditDescription: "DeepSeek Harness can’t start new tasks without credits. You can add them later in Settings → Account.",
			onboardingUnderstood: "Got it",
			onboardingGoTopUp: "Add credits",
			onboardingSaveFailed: "Could not save settings. Try again.",
			onboardingRetry: "Retry",
			onboardingLoading: "Loading settings…"
		};
		/** Japanese copy, checked against the English keys. */
		const onboardingJa = {
			"onboardingArtworkLocale": "en",
			"onboardingWelcome": "ようこそ",
			"onboardingBrand": "DeepSeek Harness",
			"onboardingIntroduction": "DeepSeek Harness はローカルフォルダで動作し、ツールを使ってお使いのコンピューター上のファイルを読み書きします。情報の調査や整理、ドキュメントやスプレッドシートの作成、コードの作成、問題のトラブルシューティングなどに役立ちます。",
			"onboardingStart": "始める",
			"onboardingCredit": "クレジットを追加",
			"onboardingCreditDescription": "DeepSeek Harness は、モデルとツールが使用したトークンに基づいてクレジットを消費します。タスクを中断なく実行し続けるために、事前にクレジットを追加してください。残高はエージェントがタスクを実行している間のみ使用されます。",
			"onboardingTopUp": "クレジットを追加",
			"onboardingLater": "次へ",
			"onboardingFundedTopUp": "クレジットを追加",
			"onboardingPurposePrefix": "",
			"onboardingPurposeSuffix": "にどのような作業を任せたいですか？",
			"onboardingPurposeDescription": "お仕事のスタイルに合わせてインターフェースとツールを調整します。",
			"onboardingOffice": "オフィス・クリエイティブ作業",
			"onboardingOfficeDescription": "ドキュメントの編集、データの整理、プレゼンテーションの作成など",
			"onboardingDevelopment": "コーディング・開発",
			"onboardingDevelopmentDescription": "コードの編集、デバッグ、コマンドの実行、プロジェクトファイルの管理など",
			"onboardingContinue": "続ける",
			"onboardingProcess": "どの程度の詳細を表示しますか？",
			"onboardingProcessDescription": "これは進捗の表示方法を変えるだけで、DeepSeek Harness の機能には影響しません。",
			"onboardingCompact": "結果のみ",
			"onboardingCompactDescription": "シンプルでクリーンなインターフェースで結果だけを表示します",
			"onboardingStandard": "重要な詳細",
			"onboardingStandardDescription": "結果を中心に、重要なステップとアクションのみを表示します",
			"onboardingDetailed": "すべての詳細",
			"onboardingDetailedDescription": "デバッグやトラブルシューティングをしやすいよう、すべてのプロセスを表示します",
			"onboardingEnter": "アプリを開く",
			"onboardingBack": "戻る",
			"onboardingSkip": "スキップ",
			"onboardingSkipTitle": "セットアップをスキップしますか？",
			"onboardingSkipDescription": "進捗、パフォーマンス、利用状況の表示方法や Coding Tools の有効化は、設定 → 一般でいつでも変更できます。",
			"onboardingKeepSetting": "セットアップを続ける",
			"onboardingNoCreditTitle": "クレジットの追加をスキップしますか？",
			"onboardingNoCreditDescription": "クレジットがないと DeepSeek Harness は新しいタスクを開始できません。後から設定 → アカウントで追加できます。",
			"onboardingUnderstood": "了解",
			"onboardingGoTopUp": "クレジットを追加",
			"onboardingSaveFailed": "設定を保存できませんでした。もう一度お試しください。",
			"onboardingRetry": "再試行",
			"onboardingLoading": "設定を読み込んでいます…"
		};
		/** Spanish dictionary, checked against the English keys. */
		const onboardingEs = {
			onboardingArtworkLocale: "en",
			onboardingWelcome: "Bienvenido a",
			onboardingBrand: "DeepSeek Harness",
			onboardingIntroduction: "DeepSeek Harness funciona en una carpeta local y utiliza herramientas para leer y escribir archivos en su computadora. Puede ayudarle a investigar y organizar información, crear documentos y hojas de cálculo, escribir código, solucionar problemas y más.",
			onboardingStart: "empezar",
			onboardingCredit: "Añadir créditos",
			onboardingCreditDescription: "DeepSeek Harness cobra créditos en función de los tokens utilizados por los modelos y herramientas. Agregue créditos por adelantado para mantener sus tareas ejecutándose sin interrupciones. Su saldo solo se utiliza mientras el agente está trabajando en una tarea.",
			onboardingTopUp: "Añadir créditos",
			onboardingLater: "Siguiente",
			onboardingFundedTopUp: "Añadir créditos",
			onboardingPurposePrefix: "¿En qué quieres que ",
			onboardingPurposeSuffix: " te ayude?",
			onboardingPurposeDescription: "Adaptaremos la interfaz y las herramientas para que se adapten a su forma de trabajar.",
			onboardingOffice: "Oficina y trabajo creativo",
			onboardingOfficeDescription: "Edite documentos, organice datos, cree presentaciones y más",
			onboardingDevelopment: "Codificación y desarrollo",
			onboardingDevelopmentDescription: "Edite código, depure problemas, ejecute comandos, administre archivos de proyectos y más",
			onboardingContinue: "Continuar",
			onboardingProcess: "¿Cuántos detalles te gustaría ver?",
			onboardingProcessDescription: "Esto solo cambia cómo se muestra el progreso, no lo que puede hacer DeepSeek Harness.",
			onboardingCompact: "Sólo resultados",
			onboardingCompactDescription: "Vea solo los resultados en una interfaz limpia y sencilla",
			onboardingStandard: "Detalles clave",
			onboardingStandardDescription: "Centrarse en los resultados, mostrando solo los pasos y acciones más importantes.",
			onboardingDetailed: "Detalles completos",
			onboardingDetailedDescription: "Vea el proceso completo para facilitar la depuración y la resolución de problemas",
			onboardingEnter: "Abrir aplicación",
			onboardingBack: "Atrás",
			onboardingSkip: "Saltar",
			onboardingSkipTitle: "¿Saltar configuración?",
			onboardingSkipDescription: "Puede cambiar cómo se muestran el progreso, el rendimiento y el uso, o habilitar las herramientas de codificación, en cualquier momento en Configuración → General.",
			onboardingKeepSetting: "Continuar con la configuración",
			onboardingNoCreditTitle: "¿Omitir agregar créditos?",
			onboardingNoCreditDescription: "DeepSeek Harness no puede iniciar nuevas tareas sin créditos. Puede agregarlos más tarde en Configuración → Cuenta.",
			onboardingUnderstood: "Lo tengo",
			onboardingGoTopUp: "Añadir créditos",
			onboardingSaveFailed: "No se pudo guardar la configuración. Intentar otra vez.",
			onboardingRetry: "Reintentar",
			onboardingLoading: "Cargando configuración…"
		};
		/** French dictionary, checked against the English keys. */
		const onboardingFr = {
			onboardingArtworkLocale: "en",
			onboardingWelcome: "Bienvenue à",
			onboardingBrand: "DeepSeek Harness",
			onboardingIntroduction: "DeepSeek Harness fonctionne dans un dossier local et utilise des outils pour lire et écrire des fichiers sur votre ordinateur. Il peut vous aider à rechercher et à organiser des informations, à créer des documents et des feuilles de calcul, à écrire du code, à résoudre des problèmes, etc.",
			onboardingStart: "Commencez",
			onboardingCredit: "Ajouter des crédits",
			onboardingCreditDescription: "DeepSeek Harness facture des crédits en fonction des jetons utilisés par les modèles et les outils. Ajoutez des crédits à l'avance pour que vos tâches continuent de s'exécuter sans interruption. Votre solde n'est utilisé que lorsque l'agent travaille sur une tâche.",
			onboardingTopUp: "Ajouter des crédits",
			onboardingLater: "Suivant",
			onboardingFundedTopUp: "Ajouter des crédits",
			onboardingPurposePrefix: "Que souhaitez-vous que ",
			onboardingPurposeSuffix: " fasse pour vous ?",
			onboardingPurposeDescription: "Nous adapterons l’interface et les outils à votre façon de travailler.",
			onboardingOffice: "Bureau et travail créatif",
			onboardingOfficeDescription: "Modifiez des documents, organisez des données, créez des présentations et bien plus encore",
			onboardingDevelopment: "Codage et développement",
			onboardingDevelopmentDescription: "Modifiez le code, déboguez les problèmes, exécutez des commandes, gérez les fichiers de projet, etc.",
			onboardingContinue: "Continuer",
			onboardingProcess: "Combien de détails aimeriez-vous voir\xA0?",
			onboardingProcessDescription: "Cela change uniquement la façon dont la progression est affichée, pas ce que DeepSeek Harness peut faire.",
			onboardingCompact: "Résultats uniquement",
			onboardingCompactDescription: "Visualisez uniquement les résultats dans une interface claire et simple",
			onboardingStandard: "Détails clés",
			onboardingStandardDescription: "Concentrez-vous sur les résultats, en affichant uniquement les étapes et actions les plus importantes.",
			onboardingDetailed: "Tous les détails",
			onboardingDetailedDescription: "Consultez le processus complet pour faciliter le débogage et le dépannage",
			onboardingEnter: "Ouvrir l'application",
			onboardingBack: "Retour",
			onboardingSkip: "Sauter",
			onboardingSkipTitle: "Ignorer la configuration\xA0?",
			onboardingSkipDescription: "Vous pouvez modifier la façon dont la progression, les performances et l'utilisation sont affichées, ou activer les outils de codage, à tout moment dans Paramètres → Général.",
			onboardingKeepSetting: "Continuer la configuration",
			onboardingNoCreditTitle: "Ignorer l'ajout de crédits\xA0?",
			onboardingNoCreditDescription: "DeepSeek Harness ne peut pas démarrer de nouvelles tâches sans crédits. Vous pourrez les ajouter plus tard dans Paramètres → Compte.",
			onboardingUnderstood: "Je l'ai compris",
			onboardingGoTopUp: "Ajouter des crédits",
			onboardingSaveFailed: "Impossible d'enregistrer les paramètres. Essayer à nouveau.",
			onboardingRetry: "Réessayer",
			onboardingLoading: "Chargement des paramètres…"
		};
		/** German dictionary, checked against the English keys. */
		const onboardingDe = {
			onboardingArtworkLocale: "en",
			onboardingWelcome: "Willkommen bei",
			onboardingBrand: "DeepSeek Harness",
			onboardingIntroduction: "DeepSeek Harness arbeitet in einem lokalen Ordner und verwendet Tools zum Lesen und Schreiben von Dateien auf Ihrem Computer. Es kann Ihnen dabei helfen, Informationen zu recherchieren und zu organisieren, Dokumente und Tabellenkalkulationen zu erstellen, Code zu schreiben, Probleme zu beheben und vieles mehr.",
			onboardingStart: "Fangen Sie an",
			onboardingCredit: "Credits hinzufügen",
			onboardingCreditDescription: "DeepSeek Harness berechnet Credits basierend auf den von Modellen und Tools verwendeten Token. Fügen Sie Credits im Voraus hinzu, damit Ihre Aufgaben ohne Unterbrechung ausgeführt werden können. Ihr Guthaben wird nur verwendet, während der Agent an einer Aufgabe arbeitet.",
			onboardingTopUp: "Credits hinzufügen",
			onboardingLater: "Weiter",
			onboardingFundedTopUp: "Credits hinzufügen",
			onboardingPurposePrefix: "Wobei soll ",
			onboardingPurposeSuffix: " Ihnen helfen?",
			onboardingPurposeDescription: "Wir passen die Benutzeroberfläche und die Tools an Ihre Arbeitsweise an.",
			onboardingOffice: "Büro & kreative Arbeit",
			onboardingOfficeDescription: "Bearbeiten Sie Dokumente, organisieren Sie Daten, erstellen Sie Präsentationen und mehr",
			onboardingDevelopment: "Codierung und Entwicklung",
			onboardingDevelopmentDescription: "Bearbeiten Sie Code, debuggen Sie Probleme, führen Sie Befehle aus, verwalten Sie Projektdateien und mehr",
			onboardingContinue: "Weiter",
			onboardingProcess: "Wie viele Details möchten Sie sehen?",
			onboardingProcessDescription: "Dies ändert nur die Art und Weise, wie der Fortschritt angezeigt wird, nicht jedoch, was DeepSeek Harness tun kann.",
			onboardingCompact: "Nur Ergebnisse",
			onboardingCompactDescription: "Sehen Sie nur die Ergebnisse in einer übersichtlichen, einfachen Benutzeroberfläche",
			onboardingStandard: "Wichtige Details",
			onboardingStandardDescription: "Konzentrieren Sie sich auf die Ergebnisse und zeigen Sie nur die wichtigsten Schritte und Aktionen",
			onboardingDetailed: "Ausführliche Informationen",
			onboardingDetailedDescription: "Sehen Sie sich den vollständigen Prozess an, um das Debuggen und die Fehlerbehebung zu vereinfachen",
			onboardingEnter: "App öffnen",
			onboardingBack: "Zurück",
			onboardingSkip: "Überspringen",
			onboardingSkipTitle: "Einrichtung überspringen?",
			onboardingSkipDescription: "Sie können jederzeit unter Einstellungen → Allgemein ändern, wie Fortschritt, Leistung und Nutzung angezeigt werden, oder Codierungstools aktivieren.",
			onboardingKeepSetting: "Setzen Sie die Einrichtung fort",
			onboardingNoCreditTitle: "Hinzufügen von Credits überspringen?",
			onboardingNoCreditDescription: "DeepSeek Harness kann ohne Credits keine neuen Aufgaben starten. Sie können sie später unter Einstellungen → Konto hinzufügen.",
			onboardingUnderstood: "Verstanden",
			onboardingGoTopUp: "Credits hinzufügen",
			onboardingSaveFailed: "Die Einstellungen konnten nicht gespeichert werden. Versuchen Sie es erneut.",
			onboardingRetry: "Erneut versuchen",
			onboardingLoading: "Einstellungen werden geladen…"
		};
		/** Russian dictionary, checked against the English keys. */
		const onboardingRu = {
			onboardingArtworkLocale: "en",
			onboardingWelcome: "Добро пожаловать в",
			onboardingBrand: "DeepSeek Harness",
			onboardingIntroduction: "DeepSeek Harness работает в локальной папке и использует инструменты для чтения и записи файлов на вашем компьютере. Он может помочь вам исследовать и систематизировать информацию, создавать документы и таблицы, писать код, устранять неполадки и многое другое.",
			onboardingStart: "Начать",
			onboardingCredit: "Добавить кредиты",
			onboardingCreditDescription: "DeepSeek Harness взимает кредиты на основе токенов, используемых моделями и инструментами. Добавляйте кредиты заранее, чтобы ваши задачи выполнялись без перебоев. Ваш баланс используется только пока агент работает над задачей.",
			onboardingTopUp: "Добавить кредиты",
			onboardingLater: "Далее",
			onboardingFundedTopUp: "Добавить кредиты",
			onboardingPurposePrefix: "С чем ",
			onboardingPurposeSuffix: " должен вам помочь?",
			onboardingPurposeDescription: "Мы адаптируем интерфейс и инструменты под ваш стиль работы.",
			onboardingOffice: "Офис и творческая работа",
			onboardingOfficeDescription: "Редактируйте документы, систематизируйте данные, создавайте презентации и многое другое.",
			onboardingDevelopment: "Кодирование и разработка",
			onboardingDevelopmentDescription: "Редактируйте код, устраняйте проблемы, запускайте команды, управляйте файлами проекта и многое другое.",
			onboardingContinue: "Продолжить",
			onboardingProcess: "Насколько подробно показывать процесс работы?",
			onboardingProcessDescription: "Это меняет только способ отображения прогресса, а не возможности DeepSeek Harness.",
			onboardingCompact: "Только результаты",
			onboardingCompactDescription: "Смотрите только результаты в понятном и простом интерфейсе",
			onboardingStandard: "Ключевые детали",
			onboardingStandardDescription: "Сосредоточьтесь на результатах, показывая только самые важные шаги и действия.",
			onboardingDetailed: "Полная информация",
			onboardingDetailedDescription: "Ознакомьтесь с полным процессом для упрощения отладки и устранения неполадок.",
			onboardingEnter: "Открыть приложение",
			onboardingBack: "Назад",
			onboardingSkip: "Пропустить",
			onboardingSkipTitle: "Пропустить настройку?",
			onboardingSkipDescription: "Вы можете изменить способ отображения прогресса, производительности и использования или включить инструменты программирования в любое время в «Настройки» → «Основные».",
			onboardingKeepSetting: "Продолжить настройку",
			onboardingNoCreditTitle: "Пропустить добавление кредитов?",
			onboardingNoCreditDescription: "DeepSeek Harness не может начинать новые задачи без кредитов. Вы можете добавить их позже в «Настройки» → «Аккаунт».",
			onboardingUnderstood: "понял",
			onboardingGoTopUp: "Добавить кредиты",
			onboardingSaveFailed: "Не удалось сохранить настройки. Попробуйте еще раз.",
			onboardingRetry: "Повторить",
			onboardingLoading: "Загрузка настроек…"
		};
		/** Portuguese dictionary, checked against the English keys. */
		const onboardingPt = {
			onboardingArtworkLocale: "en",
			onboardingWelcome: "Bem-vindo ao",
			onboardingBrand: "DeepSeek Harness",
			onboardingIntroduction: "DeepSeek Harness funciona em uma pasta local e usa ferramentas para ler e gravar arquivos no seu computador. Ele pode ajudá-lo a pesquisar e organizar informações, criar documentos e planilhas, escrever códigos, solucionar problemas e muito mais.",
			onboardingStart: "Comece",
			onboardingCredit: "Adicionar créditos",
			onboardingCreditDescription: "DeepSeek Harness cobra créditos com base nos tokens usados pelos modelos e ferramentas. Adicione créditos antecipadamente para manter suas tarefas funcionando sem interrupção. Seu saldo só é usado enquanto o agente está trabalhando em uma tarefa.",
			onboardingTopUp: "Adicionar créditos",
			onboardingLater: "Próximo",
			onboardingFundedTopUp: "Adicionar créditos",
			onboardingPurposePrefix: "Em que você quer que ",
			onboardingPurposeSuffix: " ajude?",
			onboardingPurposeDescription: "Adaptaremos a interface e as ferramentas à sua maneira de trabalhar.",
			onboardingOffice: "Escritório e trabalho criativo",
			onboardingOfficeDescription: "Edite documentos, organize dados, crie apresentações e muito mais",
			onboardingDevelopment: "Codificação e desenvolvimento",
			onboardingDevelopmentDescription: "Edite código, depure problemas, execute comandos, gerencie arquivos de projeto e muito mais",
			onboardingContinue: "Continuar",
			onboardingProcess: "Quantos detalhes você gostaria de ver?",
			onboardingProcessDescription: "Isso altera apenas a forma como o progresso é mostrado, e não o que DeepSeek Harness pode fazer.",
			onboardingCompact: "Somente resultados",
			onboardingCompactDescription: "Veja apenas os resultados em uma interface limpa e simples",
			onboardingStandard: "Detalhes principais",
			onboardingStandardDescription: "Foco nos resultados, mostrando apenas as etapas e ações mais importantes",
			onboardingDetailed: "Detalhes completos",
			onboardingDetailedDescription: "Veja o processo completo para depuração e solução de problemas mais fáceis",
			onboardingEnter: "Abrir aplicativo",
			onboardingBack: "Voltar",
			onboardingSkip: "Pular",
			onboardingSkipTitle: "Ignorar configuração?",
			onboardingSkipDescription: "Você pode alterar a forma como o progresso, o desempenho e o uso são exibidos ou ativar as ferramentas de codificação a qualquer momento em Configurações → Geral.",
			onboardingKeepSetting: "Continuar configuração",
			onboardingNoCreditTitle: "Pular a adição de créditos?",
			onboardingNoCreditDescription: "DeepSeek Harness não pode iniciar novas tarefas sem créditos. Você pode adicioná-los posteriormente em Configurações → Conta.",
			onboardingUnderstood: "Entendi",
			onboardingGoTopUp: "Adicionar créditos",
			onboardingSaveFailed: "Não foi possível salvar as configurações. Tente novamente.",
			onboardingRetry: "Tentar novamente",
			onboardingLoading: "Carregando configurações…"
		};
		//#endregion
		//#region lib/types/client/locales.js
		/** Account settings copy, owned by the account feature. */
		/** English account dictionary. */
		const en = {
			modelSignInRequired: "Model unavailable. Please sign in and try again.",
			sessionExpired: "You have signed out of your account, please log in again.",
			...onboardingEn,
			close: "Close",
			addApiKey: "Add API Key",
			retry: "Sign in again",
			loginTitle: "Get started",
			loginDescription: "Sign in to your DeepSeek account or add an API Key to get started. Your projects and files are stored locally.",
			browserTitle: "Waiting for sign in",
			browserPrompt: "Page did not open automatically? ",
			copyLink: "Copy sign-in link",
			copiedLink: "Link copied",
			copyFailed: "Copy failed",
			browserDescription: ", then open it in your browser to finish signing in.",
			timeoutTitle: "Sign in timed out",
			timeoutDescription: "Sign in again to continue.",
			failureTitle: "Could not sign in",
			platformFailed: "Could not complete the operation. Try again.",
			platformRetry: "Retry",
			loading: "Loading…",
			backToHarness: "Back to DeepSeek Harness",
			settings: "Settings",
			contactUs: "Feedback",
			menu: "Account menu",
			nav: "Account",
			signedIn: "Signed in to DeepSeek",
			signedOut: "Not signed in",
			signIn: "Sign in",
			signOut: "Sign out",
			signOutUnknownDescription: "Could not check running tasks. Signing out may interrupt tasks using this account. Sign out now?",
			signOutDescription: "Signing out will not delete any data. You can sign in to this account again.",
			signOutRunningDescription: "Tasks are currently running. Signing out will interrupt them. Sign out now?",
			cancel: "Cancel",
			open: "Open browser",
			initializing: "Starting sign in…",
			waiting: "Continue in your browser",
			completing: "Completing sign in…",
			expired: "Sign in expired. Try again.",
			failed: "Could not complete the operation. Try again.",
			noResponse: "Something went wrong. Please check your network connection and try again.",
			settingsSignedOutTitle: "You are not signed in to DeepSeek Harness",
			settingsSignedOutDescription: "Sign in to DeepSeek Harness to get your dedicated API Key",
			signInDescription: "Use your DeepSeek account to get started.",
			profileUnavailable: "Account details are not available yet.",
			balance: "Topped-up balance",
			bonusBalance: "Granted balance",
			balanceUnavailable: "View on Platform",
			balanceSignedOut: "Sign in to view",
			accountInfo: "More account information",
			more: "More",
			usage: "View usage",
			topUp: "Top up",
			quotaTitle: "No balance available",
			quotaDescription: "DeepSeek Harness cannot start a new task with this account when no balance is available. Would you like to top up? You can also top up later in Settings → Account.",
			quotaTopUp: "Top up",
			bonusNoticeTitle: "Bonus credited"
		};
		/** Chinese account settings copy. */
		const zh = {
			modelSignInRequired: "当前模型暂不可用，请登录后再试",
			sessionExpired: "登录信息已失效，请重新登录",
			...onboardingZh,
			close: "关闭",
			addApiKey: "添加 API Key",
			retry: "重新登录",
			loginTitle: "开始使用",
			loginDescription: "登录 DeepSeek 账号，或添加 API Key，即可开始使用。你的项目和文件保存在本地。",
			browserTitle: "等待登录",
			browserPrompt: "没有自动打开新页面？",
			copyLink: "复制登录链接",
			copiedLink: "链接已复制",
			copyFailed: "复制失败",
			browserDescription: "，手动打开登录页完成登录。",
			timeoutTitle: "登录已超时",
			timeoutDescription: "请重新登录后继续操作。",
			failureTitle: "登录失败",
			platformFailed: "操作未完成，请重试",
			platformRetry: "重试",
			loading: "加载中…",
			backToHarness: "返回 DeepSeek Harness",
			settings: "设置",
			contactUs: "意见反馈",
			menu: "账号菜单",
			nav: "账号与余额",
			signedIn: "已登录 DeepSeek",
			signedOut: "尚未登录",
			signIn: "登录",
			signOut: "退出登录",
			signOutUnknownDescription: "暂时无法确认任务状态。退出登录可能会中断使用此账号的任务，是否继续？",
			signOutDescription: "退出登录不会丢失任何数据，你仍可以登录此账号。",
			signOutRunningDescription: "当前有进程正在执行中，点击“退出登录”，将会打断进程，是否即刻退出登录？",
			cancel: "取消",
			open: "打开浏览器",
			initializing: "正在发起登录…",
			waiting: "请在浏览器中继续",
			completing: "正在完成登录…",
			expired: "登录已过期，请重试。",
			failed: "操作未完成，请重试。",
			noResponse: "操作未完成，可能是网络异常，请检查你的网络状况后重试",
			settingsSignedOutTitle: "当前未登录 DeepSeek Harness 账号",
			settingsSignedOutDescription: "登录 DeepSeek Harness 账号获取专属 API Key",
			signInDescription: "登录 DeepSeek 账号以开始使用",
			profileUnavailable: "账号资料暂不可用",
			balance: "充值余额",
			bonusBalance: "赠金余额",
			balanceUnavailable: "前往开放平台查看",
			balanceSignedOut: "登录后查看",
			accountInfo: "更多账号信息",
			more: "更多",
			usage: "查询用量",
			topUp: "充值",
			quotaTitle: "当前无可用余额",
			quotaDescription: "没有可用额度时，DeepSeek Harness 无法开始新的任务，是否前往充值？或者可以稍后前往 设置 → 账号与余额 进行充值。",
			quotaTopUp: "去充值",
			bonusNoticeTitle: "赠金已到账"
		};
		/** Japanese copy, checked against the English keys. */
		const ja = {
			...onboardingJa,
			"modelSignInRequired": "モデルを利用できません。ログインしてから再試行してください。",
			"sessionExpired": "アカウントからログアウトしました。もう一度ログインしてください。",
			"close": "閉じる",
			"addApiKey": "API Key を追加",
			"retry": "再ログイン",
			"loginTitle": "はじめに",
			"loginDescription": "DeepSeek アカウントにログインするか、API Key を追加して開始します。プロジェクトとファイルはローカルに保存されます。",
			"browserTitle": "ログインを待機中",
			"browserPrompt": "ページが自動で開きませんでしたか？ ",
			"copyLink": "ログインリンクをコピー",
			"copiedLink": "リンクをコピーしました",
			"copyFailed": "コピーに失敗しました",
			"browserDescription": "をコピーし、ブラウザで開いてログインを完了してください。",
			"timeoutTitle": "ログインがタイムアウトしました",
			"timeoutDescription": "続行するには再ログインしてください。",
			"failureTitle": "ログインできませんでした",
			"platformFailed": "操作を完了できませんでした。再試行してください。",
			"platformRetry": "再試行",
			"loading": "読み込み中…",
			"backToHarness": "DeepSeek Harness に戻る",
			"settings": "設定",
			"contactUs": "フィードバック",
			"menu": "アカウントメニュー",
			"nav": "アカウント",
			"signedIn": "DeepSeek にログイン済み",
			"signedOut": "未ログイン",
			"signIn": "ログイン",
			"signOut": "ログアウト",
			"signOutUnknownDescription": "実行中のタスクを確認できませんでした。ログアウトすると、このアカウントを使用しているタスクが中断される可能性があります。今すぐログアウトしますか？",
			"signOutDescription": "ログアウトしてもデータは削除されません。このアカウントに再度ログインできます。",
			"signOutRunningDescription": "現在実行中のタスクがあります。ログアウトすると中断されます。今すぐログアウトしますか？",
			"cancel": "キャンセル",
			"open": "ブラウザで開く",
			"initializing": "ログインを開始しています…",
			"waiting": "ブラウザで続行してください",
			"completing": "ログインを完了しています…",
			"expired": "ログインの有効期限が切れました。もう一度お試しください。",
			"failed": "操作を完了できませんでした。もう一度お試しください。",
			"noResponse": "問題が発生しました。ネットワーク接続を確認して、もう一度お試しください。",
			"settingsSignedOutTitle": "DeepSeek Harness にログインしていません",
			"settingsSignedOutDescription": "DeepSeek Harness にログインして専用の API Key を取得してください",
			"signInDescription": "DeepSeek アカウントで始めましょう。",
			"profileUnavailable": "アカウント情報はまだ利用できません。",
			"balance": "チャージ残高",
			"bonusBalance": "付与残高",
			"balanceUnavailable": "Platform で表示",
			"balanceSignedOut": "ログインして表示",
			"accountInfo": "アカウント情報の詳細",
			"more": "その他",
			"usage": "利用状況を表示",
			"topUp": "チャージ",
			"quotaTitle": "残高がありません",
			"quotaDescription": "残高がない場合、DeepSeek Harness はこのアカウントで新しいタスクを開始できません。チャージしますか？後から設定 → アカウントでチャージすることもできます。",
			"quotaTopUp": "チャージ",
			"bonusNoticeTitle": "ボーナスが付与されました"
		};
		/** Spanish dictionary, checked against the English keys. */
		const es = {
			modelSignInRequired: "Modelo no disponible. Por favor inicia sesión y vuelve a intentarlo.",
			sessionExpired: "Has cerrado sesión en tu cuenta, inicia sesión nuevamente.",
			...onboardingEs,
			close: "Cerrar",
			addApiKey: "Agregar clave API",
			retry: "Iniciar sesión nuevamente",
			loginTitle: "empezar",
			loginDescription: "Inicie sesión en su cuenta DeepSeek o agregue una clave API para comenzar. Sus proyectos y archivos se almacenan localmente.",
			browserTitle: "Esperando iniciar sesión",
			browserPrompt: "¿La página no se abrió automáticamente? ",
			copyLink: "Copiar enlace de inicio de sesión",
			copiedLink: "Enlace copiado",
			copyFailed: "Copia fallida",
			browserDescription: ", luego ábrelo en tu navegador para terminar de iniciar sesión.",
			timeoutTitle: "Se agotó el tiempo de inicio de sesión",
			timeoutDescription: "Inicia sesión nuevamente para continuar.",
			failureTitle: "No se pudo iniciar sesión",
			platformFailed: "No se pudo completar la operación. Intentar otra vez.",
			platformRetry: "Reintentar",
			loading: "Cargando…",
			backToHarness: "Volver a DeepSeek Harness",
			settings: "Configuración",
			contactUs: "Comentarios",
			menu: "Menú de cuenta",
			nav: "Cuenta",
			signedIn: "Iniciado sesión en DeepSeek",
			signedOut: "No iniciado sesión",
			signIn: "Iniciar sesión",
			signOut: "Cerrar sesión",
			signOutUnknownDescription: "No se pudieron verificar las tareas en ejecución. Cerrar sesión puede interrumpir las tareas que utilizan esta cuenta. ¿Cerrar sesión ahora?",
			signOutDescription: "Cerrar sesión no eliminará ningún dato. Puede iniciar sesión en esta cuenta nuevamente.",
			signOutRunningDescription: "Las tareas se están ejecutando actualmente. Cerrar sesión los interrumpirá. ¿Cerrar sesión ahora?",
			cancel: "Cancelar",
			open: "Abrir navegador",
			initializing: "Iniciando sesión...",
			waiting: "Continuar en tu navegador",
			completing: "Completando el inicio de sesión…",
			expired: "Iniciar sesión caducado. Intentar otra vez.",
			failed: "No se pudo completar la operación. Intentar otra vez.",
			noResponse: "Algo salió mal. Verifique su conexión de red e inténtelo nuevamente.",
			settingsSignedOutTitle: "No has iniciado sesión en DeepSeek Harness",
			settingsSignedOutDescription: "Inicie sesión en DeepSeek Harness para obtener su clave API dedicada",
			signInDescription: "Utilice su cuenta DeepSeek para comenzar.",
			profileUnavailable: "Los detalles de la cuenta aún no están disponibles.",
			balance: "Saldo recargado",
			bonusBalance: "Saldo concedido",
			balanceUnavailable: "Ver en plataforma",
			balanceSignedOut: "Inicia sesión para ver",
			accountInfo: "Más información de la cuenta",
			more: "Más",
			usage: "Ver uso",
			topUp: "Recargar",
			quotaTitle: "No hay saldo disponible",
			quotaDescription: "DeepSeek Harness no puede iniciar una nueva tarea con esta cuenta cuando no hay saldo disponible. ¿Quieres recargar? También puedes recargar más tarde en Configuración → Cuenta.",
			quotaTopUp: "Recargar",
			bonusNoticeTitle: "Bono acreditado"
		};
		/** French dictionary, checked against the English keys. */
		const fr = {
			modelSignInRequired: "Modèle indisponible. Veuillez vous connecter et réessayer.",
			sessionExpired: "Vous vous êtes déconnecté de votre compte, veuillez vous reconnecter.",
			...onboardingFr,
			close: "Fermer",
			addApiKey: "Ajouter une clé API",
			retry: "Connectez-vous à nouveau",
			loginTitle: "Commencez",
			loginDescription: "Connectez-vous à votre compte DeepSeek ou ajoutez une clé API pour commencer. Vos projets et fichiers sont stockés localement.",
			browserTitle: "En attente de connexion",
			browserPrompt: "La page ne s'est pas ouverte automatiquement ? ",
			copyLink: "Copier le lien de connexion",
			copiedLink: "Lien copié",
			copyFailed: "Échec de la copie",
			browserDescription: ", puis ouvrez-le dans votre navigateur pour terminer la connexion.",
			timeoutTitle: "La connexion a expiré",
			timeoutDescription: "Connectez-vous à nouveau pour continuer.",
			failureTitle: "Impossible de se connecter",
			platformFailed: "Impossible de terminer l'opération. Essayer à nouveau.",
			platformRetry: "Réessayer",
			loading: "Chargement…",
			backToHarness: "Retour à DeepSeek Harness",
			settings: "Paramètres",
			contactUs: "Commentaires",
			menu: "Menu du compte",
			nav: "Compte",
			signedIn: "Connecté à DeepSeek",
			signedOut: "Non connecté",
			signIn: "Connectez-vous",
			signOut: "Se déconnecter",
			signOutUnknownDescription: "Impossible de vérifier les tâches en cours d'exécution. La déconnexion peut interrompre les tâches utilisant ce compte. Se déconnecter maintenant\xA0?",
			signOutDescription: "La déconnexion ne supprimera aucune donnée. Vous pouvez vous reconnecter à ce compte.",
			signOutRunningDescription: "Les tâches sont actuellement en cours d'exécution. La déconnexion les interrompra. Se déconnecter maintenant\xA0?",
			cancel: "Annuler",
			open: "Ouvrir le navigateur",
			initializing: "Début de la connexion…",
			waiting: "Continuez dans votre navigateur",
			completing: "Connexion terminée…",
			expired: "Connexion expirée. Essayer à nouveau.",
			failed: "Impossible de terminer l'opération. Essayer à nouveau.",
			noResponse: "Quelque chose s'est mal passé. Veuillez vérifier votre connexion réseau et réessayer.",
			settingsSignedOutTitle: "Vous n'êtes pas connecté à DeepSeek Harness",
			settingsSignedOutDescription: "Connectez-vous à DeepSeek Harness pour obtenir votre clé API dédiée",
			signInDescription: "Utilisez votre compte DeepSeek pour commencer.",
			profileUnavailable: "Les détails du compte ne sont pas encore disponibles.",
			balance: "Solde rechargé",
			bonusBalance: "Solde accordé",
			balanceUnavailable: "Afficher sur la plateforme",
			balanceSignedOut: "Connectez-vous pour voir",
			accountInfo: "Plus d'informations sur le compte",
			more: "Plus",
			usage: "Afficher l'utilisation",
			topUp: "Recharger",
			quotaTitle: "Aucun solde disponible",
			quotaDescription: "DeepSeek Harness ne peut pas démarrer une nouvelle tâche avec ce compte lorsqu'aucun solde n'est disponible. Souhaitez-vous recharger ? Vous pouvez également recharger plus tard dans Paramètres → Compte.",
			quotaTopUp: "Recharger",
			bonusNoticeTitle: "Bonus crédité"
		};
		/** German dictionary, checked against the English keys. */
		const de = {
			modelSignInRequired: "Modell nicht verfügbar. Bitte melden Sie sich an und versuchen Sie es erneut.",
			sessionExpired: "Sie haben sich von Ihrem Konto abgemeldet. Bitte melden Sie sich erneut an.",
			...onboardingDe,
			close: "Schließen",
			addApiKey: "Fügen Sie den API-Schlüssel hinzu",
			retry: "Melden Sie sich erneut an",
			loginTitle: "Fangen Sie an",
			loginDescription: "Melden Sie sich bei Ihrem DeepSeek-Konto an oder fügen Sie einen API-Schlüssel hinzu, um loszulegen. Ihre Projekte und Dateien werden lokal gespeichert.",
			browserTitle: "Warten auf die Anmeldung",
			browserPrompt: "Seite wurde nicht automatisch geöffnet? ",
			copyLink: "Anmeldelink kopieren",
			copiedLink: "Link kopiert",
			copyFailed: "Das Kopieren ist fehlgeschlagen",
			browserDescription: ", und öffnen Sie es dann in Ihrem Browser, um die Anmeldung abzuschließen.",
			timeoutTitle: "Zeitüberschreitung bei der Anmeldung",
			timeoutDescription: "Melden Sie sich erneut an, um fortzufahren.",
			failureTitle: "Konnte mich nicht anmelden",
			platformFailed: "Der Vorgang konnte nicht abgeschlossen werden. Versuchen Sie es erneut.",
			platformRetry: "Erneut versuchen",
			loading: "Laden…",
			backToHarness: "Zurück zu DeepSeek Harness",
			settings: "Einstellungen",
			contactUs: "Rückmeldung",
			menu: "Kontomenü",
			nav: "Konto",
			signedIn: "Angemeldet bei DeepSeek",
			signedOut: "Nicht angemeldet",
			signIn: "Melden Sie sich an",
			signOut: "Abmelden",
			signOutUnknownDescription: "Laufende Aufgaben konnten nicht überprüft werden. Durch das Abmelden werden möglicherweise Aufgaben mit diesem Konto unterbrochen. Jetzt abmelden?",
			signOutDescription: "Durch das Abmelden werden keine Daten gelöscht. Sie können sich erneut bei diesem Konto anmelden.",
			signOutRunningDescription: "Derzeit werden Aufgaben ausgeführt. Durch das Abmelden werden sie unterbrochen. Jetzt abmelden?",
			cancel: "Abbrechen",
			open: "Browser öffnen",
			initializing: "Anmeldung beginnt…",
			waiting: "Fahren Sie in Ihrem Browser fort",
			completing: "Anmeldung wird abgeschlossen…",
			expired: "Anmeldung abgelaufen. Versuchen Sie es erneut.",
			failed: "Der Vorgang konnte nicht abgeschlossen werden. Versuchen Sie es erneut.",
			noResponse: "Etwas ist schief gelaufen. Bitte überprüfen Sie Ihre Netzwerkverbindung und versuchen Sie es erneut.",
			settingsSignedOutTitle: "Sie sind nicht bei DeepSeek Harness angemeldet",
			settingsSignedOutDescription: "Melden Sie sich bei DeepSeek Harness an, um Ihren dedizierten API-Schlüssel zu erhalten",
			signInDescription: "Verwenden Sie Ihr DeepSeek-Konto, um loszulegen.",
			profileUnavailable: "Kontodaten sind noch nicht verfügbar.",
			balance: "Aufgeladenes Guthaben",
			bonusBalance: "Gewährte Balance",
			balanceUnavailable: "Auf der Plattform ansehen",
			balanceSignedOut: "Melden Sie sich an, um es anzuzeigen",
			accountInfo: "Weitere Kontoinformationen",
			more: "Mehr",
			usage: "Nutzung anzeigen",
			topUp: "Auffüllen",
			quotaTitle: "Kein Guthaben verfügbar",
			quotaDescription: "DeepSeek Harness kann mit diesem Konto keine neue Aufgabe starten, wenn kein Guthaben verfügbar ist. Möchten Sie aufladen? Sie können das Guthaben auch später unter Einstellungen → Konto aufladen.",
			quotaTopUp: "Auffüllen",
			bonusNoticeTitle: "Bonus gutgeschrieben"
		};
		/** Russian dictionary, checked against the English keys. */
		const ru = {
			modelSignInRequired: "Модель недоступна. Пожалуйста, войдите в систему и повторите попытку.",
			sessionExpired: "Вы вышли из своей учетной записи, пожалуйста, войдите снова.",
			...onboardingRu,
			close: "Закрыть",
			addApiKey: "Добавить ключ API",
			retry: "Войдите снова",
			loginTitle: "Начать",
			loginDescription: "Войдите в свою учетную запись DeepSeek или добавьте ключ API, чтобы начать. Ваши проекты и файлы хранятся локально.",
			browserTitle: "Ожидание входа в систему",
			browserPrompt: "Страница не открылась автоматически? ",
			copyLink: "Скопировать ссылку для входа",
			copiedLink: "Ссылка скопирована",
			copyFailed: "Не удалось скопировать",
			browserDescription: ", затем откройте его в браузере, чтобы завершить вход.",
			timeoutTitle: "Время входа в систему истекло",
			timeoutDescription: "Войдите еще раз, чтобы продолжить.",
			failureTitle: "Не удалось войти в систему",
			platformFailed: "Не удалось завершить операцию. Попробуйте еще раз.",
			platformRetry: "Повторить",
			loading: "Загрузка…",
			backToHarness: "Вернуться к DeepSeek Harness",
			settings: "Настройки",
			contactUs: "Обратная связь",
			menu: "Меню аккаунта",
			nav: "Аккаунт",
			signedIn: "Вошёл в DeepSeek",
			signedOut: "Не авторизован",
			signIn: "Войти",
			signOut: "Выйти",
			signOutUnknownDescription: "Не удалось проверить запущенные задачи. Выход из системы может прервать выполнение задач с использованием этой учетной записи. Выйти сейчас?",
			signOutDescription: "Выход из системы не приведет к удалению данных. Вы можете снова войти в эту учетную запись.",
			signOutRunningDescription: "Задачи в настоящее время выполняются. Выход из системы прервет их. Выйти сейчас?",
			cancel: "Отмена",
			open: "Открыть браузер",
			initializing: "Начинаем вход…",
			waiting: "Продолжить в браузере",
			completing: "Завершение входа…",
			expired: "Срок действия входа истек. Попробуйте еще раз.",
			failed: "Не удалось завершить операцию. Попробуйте еще раз.",
			noResponse: "Что-то пошло не так. Пожалуйста, проверьте сетевое соединение и повторите попытку.",
			settingsSignedOutTitle: "Вы не вошли в DeepSeek Harness.",
			settingsSignedOutDescription: "Войдите в DeepSeek Harness, чтобы получить специальный ключ API.",
			signInDescription: "Используйте свою учетную запись DeepSeek, чтобы начать.",
			profileUnavailable: "Детали аккаунта пока недоступны.",
			balance: "Пополненный баланс",
			bonusBalance: "Предоставленный баланс",
			balanceUnavailable: "Посмотреть на платформе",
			balanceSignedOut: "Войдите, чтобы просмотреть",
			accountInfo: "Дополнительная информация об аккаунте",
			more: "Ещё",
			usage: "Посмотреть использование",
			topUp: "Пополнить",
			quotaTitle: "Нет доступного баланса",
			quotaDescription: "DeepSeek Harness не может запустить новую задачу с этой учетной записью, если на ней нет баланса. Хотите пополнить счет? Вы также можете пополнить счет позже в «Настройки» → «Аккаунт».",
			quotaTopUp: "Пополнить",
			bonusNoticeTitle: "Бонус начислен"
		};
		/** Portuguese dictionary, checked against the English keys. */
		const pt = {
			modelSignInRequired: "Modelo indisponível. Faça login e tente novamente.",
			sessionExpired: "Você saiu da sua conta, faça login novamente.",
			...onboardingPt,
			close: "Fechar",
			addApiKey: "Adicionar chave API",
			retry: "Faça login novamente",
			loginTitle: "Comece",
			loginDescription: "Faça login em sua conta DeepSeek ou adicione uma chave API para começar. Seus projetos e arquivos são armazenados localmente.",
			browserTitle: "Aguardando login",
			browserPrompt: "A página não abriu automaticamente? ",
			copyLink: "Copiar link de login",
			copiedLink: "Link copiado",
			copyFailed: "Falha na cópia",
			browserDescription: "e abra-o no navegador para concluir o login.",
			timeoutTitle: "O tempo limite de login expirou",
			timeoutDescription: "Faça login novamente para continuar.",
			failureTitle: "Não foi possível fazer login",
			platformFailed: "Não foi possível concluir a operação. Tente novamente.",
			platformRetry: "Tentar novamente",
			loading: "Carregando…",
			backToHarness: "Voltar para DeepSeek Harness",
			settings: "Configurações",
			contactUs: "Comentários",
			menu: "Menu da conta",
			nav: "Conta",
			signedIn: "Conectado em DeepSeek",
			signedOut: "Não conectado",
			signIn: "Faça login",
			signOut: "Sair",
			signOutUnknownDescription: "Não foi possível verificar as tarefas em execução. Sair pode interromper tarefas usando esta conta. Sair agora?",
			signOutDescription: "Sair não excluirá nenhum dado. Você pode fazer login nesta conta novamente.",
			signOutRunningDescription: "As tarefas estão em execução no momento. Sair irá interrompê-los. Sair agora?",
			cancel: "Cancelar",
			open: "Abra o navegador",
			initializing: "Iniciando login…",
			waiting: "Continue no seu navegador",
			completing: "Concluindo login…",
			expired: "O login expirou. Tente novamente.",
			failed: "Não foi possível concluir a operação. Tente novamente.",
			noResponse: "Algo deu errado. Verifique sua conexão de rede e tente novamente.",
			settingsSignedOutTitle: "Você não está conectado a DeepSeek Harness",
			settingsSignedOutDescription: "Faça login em DeepSeek Harness para obter sua chave API dedicada",
			signInDescription: "Use sua conta DeepSeek para começar.",
			profileUnavailable: "Os detalhes da conta ainda não estão disponíveis.",
			balance: "Saldo reabastecido",
			bonusBalance: "Saldo concedido",
			balanceUnavailable: "Ver na plataforma",
			balanceSignedOut: "Faça login para ver",
			accountInfo: "Mais informações da conta",
			more: "Mais",
			usage: "Ver uso",
			topUp: "Recarregar",
			quotaTitle: "Nenhum saldo disponível",
			quotaDescription: "DeepSeek Harness não pode iniciar uma nova tarefa com esta conta quando não houver saldo disponível. Você gostaria de recarregar? Você também pode recarregar mais tarde em Configurações → Conta.",
			quotaTopUp: "Recarregar",
			bonusNoticeTitle: "Bônus creditado"
		};
		//#endregion
		//#region lib/types/client/AccountQuotaNotice.js
		/** Account-owned take-over of the frame-wide quota notice for account balances. */
		/**
		* @param props - the claimed notice, account state, and the shared Platform page channel.
		* @returns the balance Modal, nothing while awaiting account state or a Platform page's return, or the fallback Toast.
		*/
		function AccountQuotaNotice({ matched, openPlatformPage, useAccount, usePlatformPage, t }) {
			const { dismiss, keepOpen, message } = matched;
			const accountStatus = useAccount((snapshot) => snapshot.view?.status);
			const accountFailed = useAccount((snapshot) => snapshot.failed);
			const signedIn = accountStatus === "credential-stored";
			const platformPage = usePlatformPage((current) => current);
			const [opened, setOpened] = (0, react.useState)(false);
			const previousSignedIn = (0, react.useRef)(signedIn);
			const releaseHold = (0, react.useRef)(void 0);
			const releasePage = (0, react.useRef)(void 0);
			const releaseClaims = () => {
				releasePage.current?.();
				releasePage.current = void 0;
				releaseHold.current?.();
				releaseHold.current = void 0;
			};
			(0, react.useEffect)(() => releaseClaims, []);
			(0, react.useEffect)(() => {
				if (previousSignedIn.current && !signedIn) {
					releaseClaims();
					dismiss();
				}
				previousSignedIn.current = signedIn;
			}, [dismiss, signedIn]);
			if (accountStatus === void 0 && !accountFailed && openPlatformPage !== void 0) return null;
			if (!signedIn || openPlatformPage === void 0) return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
				text: message,
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutlineRegular, { size: 18 }),
				onDone: dismiss
			});
			if (opened || platformPage !== null) return null;
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				title: t("quotaTitle"),
				closeLabel: t("close"),
				onClose: dismiss,
				description: t("quotaDescription"),
				footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					onClick: dismiss,
					children: t("cancel")
				}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "primary",
					onClick: () => {
						releaseHold.current = keepOpen();
						releasePage.current = openPlatformPage("top-up", () => {
							releasePage.current = void 0;
							dismiss();
						});
						setOpened(true);
					},
					children: t("quotaTopUp")
				})] })
			});
		}
		//#endregion
		//#region lib/types/onboarding-settings.js
		/** Device-local onboarding progress stored in the Host settings document. */
		/** Account feature's durable onboarding namespace. */
		const DESKTOP_ONBOARDING_NAMESPACE = "ui-settings-account";
		/** Validated defaults for a fresh installation. */
		const OnboardingSettingsFields = {
			version: Schema.const(1).default(1),
			step: Schema.union([
				"welcome",
				"credit",
				"purpose",
				"process",
				"done"
			]).default("welcome"),
			purpose: Schema.union([
				"office",
				"development",
				"both",
				Schema.const(null)
			]),
			process: Schema.union([
				"compact",
				"standard",
				"detailed",
				Schema.const(null)
			]),
			completion: Schema.union([
				"completed",
				"skipped",
				"api-key",
				Schema.const(null)
			]),
			usage: Schema.union(["compact", "detailed"]).default("compact"),
			developerTools: Schema.boolean().default(false)
		};
		Schema.object(OnboardingSettingsFields);
		//#endregion
		//#region lib/types/client/onboarding-balance.js
		/** Available onboarding credit includes both purchased and granted wallets. */
		/**
		* Check purchased and granted credit without treating a pending query as zero.
		* @param balance - current account balance result.
		* @returns whether either wallet group has positive credit.
		*/
		function hasOnboardingCredit(balance) {
			return balance?.status === "ready" && [...balance.value, ...balance.bonusWallets].some((wallet) => new Big(wallet.balance).gt(0));
		}
		//#endregion
		//#region lib/types/client/onboarding-state.js
		function freshProgress() {
			return {
				version: 1,
				step: "welcome",
				purpose: null,
				process: null,
				completion: null,
				usage: "compact",
				developerTools: false
			};
		}
		/** Host-backed progress; completing writes active preferences before the durable done marker. */
		var DesktopOnboardingController = class {
			progress;
			chat;
			setDeveloperTools;
			account;
			readApiKeyPresence;
			settings;
			/** Private observable projected into the shell overlay's framework hook. */
			state = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
				status: "loading",
				visible: false,
				progress: freshProgress(),
				error: null,
				creditFunded: false
			});
			disposers;
			saving = false;
			completing = false;
			draft;
			updates = Promise.resolve(true);
			disposed = false;
			credentialGeneration = 0;
			hasApiKey;
			checkingKeys = false;
			error = null;
			failedWrite;
			creditFunded;
			/**
			* @param progress - installation-scoped durable progress.
			* @param chat - existing Chat settings owner.
			* @param setDeveloperTools - persist enablement through the shared developer-tools preference.
			* @param account - safe account state, initially unresolved.
			* @param settings - shared settings reader exposing initial failures and retry.
			* @param readApiKeyPresence - reads configured model-credential metadata without secrets.
			*/
			constructor(progress, chat, setDeveloperTools, account, readApiKeyPresence, settings) {
				this.progress = progress;
				this.chat = chat;
				this.setDeveloperTools = setDeveloperTools;
				this.account = account;
				this.readApiKeyPresence = readApiKeyPresence;
				this.settings = settings;
				this.disposers = [
					settings.subscribe(() => {
						this.derive();
					}),
					progress.subscribe(() => {
						this.derive();
					}),
					chat.subscribe(() => {
						this.derive();
					}),
					account.subscribe(() => {
						this.derive();
					})
				];
				this.derive();
			}
			/** Recheck credential metadata after a provider or credential invalidation. */
			invalidateCredentials() {
				this.credentialGeneration++;
				this.checkingKeys = false;
				this.hasApiKey = void 0;
				if (this.failedWrite?.next.completion === "api-key") {
					this.error = null;
					this.failedWrite = void 0;
				}
				this.derive();
			}
			/**
			* Preview a step or selection immediately and serialize its persistence; the last rejected write restores saved progress.
			* @param change - user-selected progress fields.
			* @returns whether Host settings accepted the complete next progress value.
			*/
			async update(change) {
				if (this.completing || this.saving && this.draft === void 0 || this.disposed || this.account.getSnapshot().view?.status !== "credential-stored") return false;
				const current = this.draft ?? this.readProgress();
				if (current === void 0 || current.step === "done") return false;
				const next = {
					...current,
					...change
				};
				this.draft = next;
				this.error = null;
				const pending = this.updates.then(async () => {
					if (this.disposed || this.account.getSnapshot().view?.status !== "credential-stored") return false;
					return this.save(next, false);
				}).finally(() => {
					if (this.draft === next) this.draft = void 0;
					this.derive();
				});
				this.updates = pending;
				this.derive();
				return pending;
			}
			/**
			* Apply the selected display and developer-tool preferences and finish this installation's introduction.
			* @param reason - ordinary completion or an explicit skip at the current step.
			* @returns whether preferences and the completion marker persisted.
			*/
			async complete(reason) {
				if (this.completing || this.disposed || this.account.getSnapshot().view?.status !== "credential-stored") return false;
				this.completing = true;
				this.derive();
				try {
					if (!await this.updates) return false;
					return await this.finish(reason);
				} finally {
					this.completing = false;
					this.derive();
				}
			}
			async finish(reason) {
				if (this.saving || this.disposed || this.account.getSnapshot().view?.status !== "credential-stored") return false;
				const current = this.readProgress();
				if (current === void 0 || current.step === "done" || current.step === "welcome") return false;
				const office = reason === "completed" && current.purpose === "office";
				const development = reason === "completed" && !office;
				if (development && current.process === null) return false;
				return this.save({
					...current,
					step: "done",
					completion: reason,
					process: office ? "compact" : reason === "skipped" ? "standard" : current.process,
					usage: development ? "detailed" : "compact",
					developerTools: development
				}, true);
			}
			/**
			* Retry an initial settings read or the last failed choice, including active preferences.
			* @returns whether the read or pending write succeeded; false when nothing can be retried.
			*/
			async retry() {
				if (this.saving || this.completing || this.draft !== void 0 || this.disposed || this.account.getSnapshot().view?.status !== "credential-stored") return false;
				if (this.settings.getSnapshot().error !== null && this.progress.getSnapshot().status === "loading") {
					await this.settings.ensure();
					return this.progress.getSnapshot().status === "ready";
				}
				const pending = this.failedWrite;
				if (pending === void 0) return false;
				const saved = await this.save(pending.next, pending.applyPreferences);
				this.updates = Promise.resolve(saved);
				return saved;
			}
			/** Remove subscriptions and prevent delayed metadata reads from writing progress. */
			dispose() {
				this.disposed = true;
				this.credentialGeneration++;
				for (const dispose of this.disposers) dispose();
			}
			readProgress() {
				const value = this.progress.getSnapshot().value;
				return value === void 0 ? void 0 : {
					...value,
					purpose: value.purpose ?? null,
					process: value.process ?? null,
					completion: value.completion ?? null
				};
			}
			async save(next, applyPreferences) {
				const accountStatus = this.account.getSnapshot().view?.status;
				this.saving = true;
				this.error = null;
				this.derive();
				try {
					if (applyPreferences) {
						const mode = next.process;
						const accepted = await this.chat.mutate([{
							op: "set",
							path: ["transcriptView"],
							value: mode
						}, {
							op: "set",
							path: ["performanceUsage"],
							value: next.usage
						}]);
						const saved = this.chat.getSnapshot().value;
						if (!accepted || saved?.transcriptView !== mode || saved.performanceUsage !== next.usage) throw new Error("Chat preferences were not saved");
						if (this.disposed || this.account.getSnapshot().view?.status !== accountStatus) return false;
						await this.setDeveloperTools(next.developerTools);
					}
					if (this.disposed || this.account.getSnapshot().view?.status !== accountStatus) return false;
					const fields = Object.keys(next);
					const accepted = await this.progress.mutate(fields.map((field) => ({
						op: "set",
						path: [field],
						value: next[field]
					})));
					const saved = this.readProgress();
					if (!accepted || saved === void 0 || Object.entries(next).some(([field, value]) => saved[field] !== value)) throw new Error("onboarding progress was not saved");
					this.failedWrite = void 0;
					return true;
				} catch {
					this.error = "settings";
					this.failedWrite = {
						next,
						applyPreferences
					};
					return false;
				} finally {
					this.saving = false;
					this.derive();
				}
			}
			derive() {
				if (this.disposed) return;
				const host = this.progress.getSnapshot();
				const snapshot = this.account.getSnapshot();
				const account = snapshot.view;
				const signedIn = account?.status === "credential-stored";
				const progress = this.draft ?? this.readProgress() ?? freshProgress();
				if (!signedIn) this.creditFunded = void 0;
				else if (this.creditFunded === void 0 && host.status === "ready" && progress.step === "credit") this.creditFunded = hasOnboardingCredit(snapshot.details?.balance);
				if (signedIn && this.failedWrite?.next.completion === "api-key") {
					this.failedWrite = void 0;
					this.error = null;
				}
				const done = progress.step === "done";
				const unavailable = host.status === "unavailable" || host.status === "ready" && !host.writable;
				const readFailed = host.status === "loading" && this.settings.getSnapshot().error !== null;
				const accountFailed = account === void 0 && snapshot.failed;
				const previous = this.state.getSnapshot();
				const next = {
					progress: (0, _deepseek_ai_dsh_client_store.shallowEqual)(previous.progress, progress) ? previous.progress : progress,
					creditFunded: this.creditFunded ?? false,
					visible: !done && signedIn && !unavailable,
					status: this.completing || this.saving && this.draft === void 0 ? "saving" : unavailable || readFailed || accountFailed || this.error !== null ? "error" : host.status === "loading" || account === void 0 ? "loading" : "ready",
					error: unavailable || readFailed ? "settings" : this.error
				};
				if (!(0, _deepseek_ai_dsh_client_store.shallowEqual)(previous, next)) this.state.set(next);
				if (done || this.saving || this.completing || this.draft !== void 0 || unavailable || host.status !== "ready" || this.chat.getSnapshot().status !== "ready" || account?.status !== "signed-out") return;
				if (this.hasApiKey === true && this.error === null) this.save({
					...progress,
					step: "done",
					process: "standard",
					usage: "detailed",
					developerTools: true,
					completion: "api-key"
				}, true);
				else if (this.hasApiKey === void 0 && !this.checkingKeys) {
					this.checkingKeys = true;
					const generation = this.credentialGeneration;
					this.readApiKeyPresence().then((present) => {
						if (this.disposed || generation !== this.credentialGeneration) return;
						this.hasApiKey = present;
						this.checkingKeys = false;
						this.derive();
					}).catch(() => {
						if (this.disposed || generation !== this.credentialGeneration) return;
						this.checkingKeys = false;
						this.hasApiKey = false;
					});
				}
			}
		};
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-settings-account/src/client/OnboardingSurface.module.css.mjs
		const css$1 = ".tQSFJa_onboardingOverlay{z-index:900;background:var(--dsw-alias-bg-base);user-select:none;flex-direction:column;display:flex;position:fixed;inset:0}html[data-platform=darwin] .tQSFJa_onboardingOverlay{background:0 0}.tQSFJa_onboardingOverlay[data-exiting]{pointer-events:none;animation:.18s ease-out forwards tQSFJa_onboardingExit}@keyframes tQSFJa_onboardingExit{0%{opacity:1}to{opacity:0}}@media (prefers-reduced-motion:reduce){.tQSFJa_onboardingOverlay[data-exiting]{animation:none}}html[data-platform=darwin] .tQSFJa_dragBand{pointer-events:none;position:absolute;inset:8px}.tQSFJa_onboardingStage{-webkit-app-region:initial;flex:1;justify-content:center;min-height:0;display:flex;overflow:auto}.tQSFJa_onboardingOverlay[inert] .tQSFJa_dragBand{-webkit-app-region:no-drag}";
		const tagId$1 = "@deepseek-ai/dsh-client-ui-settings-account/OnboardingSurface.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-settings-account";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var OnboardingSurface_module_css_default = {
			"dragBand": "tQSFJa_dragBand",
			"onboardingExit": "tQSFJa_onboardingExit",
			"onboardingOverlay": "tQSFJa_onboardingOverlay",
			"onboardingStage": "tQSFJa_onboardingStage"
		};
		//#endregion
		//#region lib/types/client/OnboardingSurface.js
		/** Body-portaled introduction with shared background interaction ownership. */
		/**
		* Render a body-portaled onboarding stage and keep the application root inert
		* while mounted. Completion reveals the root beneath a fading stage;
		* native titlebar controls, dialogs, and account pages remain above the stage.
		* @param props.children - the step's page content, centered on the stage.
		* @param props.exiting - reveal the application while the owner retains the stage for its 180ms exit.
		* @returns the body-portaled overlay tree.
		*/
		function OnboardingSurface({ children, exiting = false }) {
			const rootState = (0, react.useRef)(null);
			(0, react.useLayoutEffect)(() => {
				const appRoot = document.getElementById("root");
				if (appRoot === null) return;
				const releaseInert = acquireOverlayInert(appRoot);
				const previousOpacity = appRoot.style.opacity;
				rootState.current = {
					element: appRoot,
					opacity: previousOpacity
				};
				appRoot.style.opacity = "0";
				return () => {
					releaseInert();
					appRoot.style.opacity = previousOpacity;
					rootState.current = null;
				};
			}, []);
			(0, react.useLayoutEffect)(() => {
				const root = rootState.current;
				if (root !== null) root.element.style.opacity = exiting ? root.opacity : "0";
			}, [exiting]);
			return (0, react_dom.createPortal)((0, react_jsx_runtime.jsxs)("div", {
				className: OnboardingSurface_module_css_default.onboardingOverlay,
				"data-exiting": exiting || void 0,
				role: "presentation",
				children: [(0, react_jsx_runtime.jsx)("div", {
					className: OnboardingSurface_module_css_default.dragBand,
					"data-window-drag": true,
					"aria-hidden": "true"
				}), (0, react_jsx_runtime.jsx)("div", {
					className: OnboardingSurface_module_css_default.onboardingStage,
					children
				})]
			}), document.body);
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-settings-account/src/client/DesktopOnboarding.module.css.mjs
		const css = ".ywGceq_page{--page-padding:clamp(40px, 8.333vw, 120px);width:100%;height:100%;min-height:480px;color:var(--dsw-alias-label-primary);animation:.1s ease-out ywGceq_pageEnter;position:relative;overflow:hidden}.ywGceq_blurred{filter:var(--dsw-mask-blur)}@keyframes ywGceq_pageEnter{0%{opacity:0}to{opacity:1}}.ywGceq_loading{height:100%;color:var(--dsw-alias-label-tertiary);place-items:center;display:grid}.ywGceq_content{width:min(calc(100% - 2 * var(--page-padding)), 1200px);position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)}.ywGceq_copy h1{outline:none;margin:0;font-size:28px;font-weight:300;line-height:48px}html[data-platform=darwin] .ywGceq_copy h1{-webkit-app-region:initial}.ywGceq_brand{font-family:var(--dsw-font-family-brand);font-size:inherit;white-space:nowrap;font-style:normal;font-weight:500}.ywGceq_page:lang(en) .ywGceq_copy h1{font-family:var(--dsw-font-family-brand);font-weight:300}.ywGceq_page:lang(en) :is(.ywGceq_heroDescription,.ywGceq_subtitle,.ywGceq_cardTitle,.ywGceq_cardDescription){font-family:var(--dsw-font-family-brand)}.ywGceq_heroDescription{color:var(--dsw-alias-label-tertiary);margin:24px 0 0;font-size:16px;font-weight:300;line-height:28px}.ywGceq_welcome{width:100%;max-width:2200px;height:100%}.ywGceq_welcome .ywGceq_copy{z-index:1;width:520px;position:absolute;top:50%;left:clamp(64px,41.667vw - 300px,200px);transform:translateY(-50%)}.ywGceq_start{width:240px;margin:60px 0 0;display:flex}.ywGceq_welcomeIllustration{pointer-events:none;width:1247px;height:822px;position:absolute;top:clamp(32px,31.608vh - 157.65px,133.145px);left:min(41.667vw + 112.5px,712.5px)}.ywGceq_welcomeArtwork{width:1331px;height:auto;position:absolute;top:-40px;left:-67px}.ywGceq_illustration img{width:100%;height:auto;display:block}.ywGceq_illustration .ywGceq_darkIllustration{display:none}body[data-ds-dark-theme] .ywGceq_lightIllustration{display:none}body[data-ds-dark-theme] .ywGceq_darkIllustration{display:block}.ywGceq_credit{grid-template-columns:minmax(0,594px) minmax(0,400px);justify-content:center;align-items:center;gap:clamp(32px,33.3333vw - 331.333px,164px);max-width:1196px;display:grid;transform:translate(-50%,calc(-50% - 5px))}.ywGceq_creditIllustration{aspect-ratio:594/509;object-fit:contain;width:100%;height:auto}.ywGceq_credit .ywGceq_copy{max-width:400px}.ywGceq_creditActions{gap:24px;margin-top:60px;display:flex}.ywGceq_creditActions>button{flex:1;max-width:160px}.ywGceq_creditActions .ywGceq_laterAction{background:var(--dsw-alias-onboarding-secondary-fill)}@media (hover:hover){.ywGceq_creditActions .ywGceq_laterAction:hover:not(:disabled){background:linear-gradient(var(--dsw-alias-interactive-bg-hover), var(--dsw-alias-interactive-bg-hover)), var(--dsw-alias-onboarding-secondary-fill)}}.ywGceq_page button{transition:background-color .12s,color .12s,opacity .12s}.ywGceq_purpose,.ywGceq_process{flex-direction:column;align-items:center;gap:48px;display:flex;top:calc(50% - 188.5px);transform:translate(-50%)}.ywGceq_purpose{max-width:843px}.ywGceq_process{max-width:1130px}.ywGceq_purpose .ywGceq_copy,.ywGceq_process .ywGceq_copy{text-align:center}.ywGceq_purpose .ywGceq_copy h1,.ywGceq_process .ywGceq_copy h1{font-size:28px;line-height:39px}.ywGceq_purpose .ywGceq_brand{line-height:0}.ywGceq_subtitle{color:var(--dsw-alias-label-tertiary);margin:16px 0 0;font-size:16px;font-weight:300;line-height:22px}.ywGceq_purposeCards,.ywGceq_processCards{align-items:stretch;gap:16px;width:100%;display:grid}.ywGceq_purposeCards{grid-template-columns:repeat(2,minmax(0,1fr));gap:17px}.ywGceq_processCards{box-sizing:border-box;grid-template-columns:repeat(3,minmax(0,1fr));min-height:225px;padding-block:1.5px}.ywGceq_card{-webkit-app-region:no-drag;--card-border-stops:var(--dsw-gradient-onboarding-blue-stops);box-sizing:border-box;background:var(--dsw-alias-onboarding-card-fill);min-width:0;min-height:222px;box-shadow:8px 8px 24px color-mix(in srgb, var(--dsw-alias-onboarding-accent) 8%, transparent), 4px 4px 12px color-mix(in srgb, var(--dsw-alias-onboarding-accent) 4%, transparent);color:inherit;font:inherit;text-align:left;cursor:pointer;backdrop-filter:blur(32.609px);border:0;border-radius:32px;flex-direction:column;align-items:flex-start;padding:48.5px 32.5px 64.5px;transition:background-color .12s;display:flex;position:relative}.ywGceq_card:before,.ywGceq_card:after{content:\"\";border-radius:inherit;pointer-events:none;transition:opacity .12s,border-color .12s;position:absolute;inset:0}.ywGceq_card:before{border:.5px solid var(--dsw-alias-border-l2)}.ywGceq_card:after{background:conic-gradient(from var(--dsh-onboarding-border-angle), var(--card-border-stops));opacity:0;padding:2px;mask-image:linear-gradient(#fff 0 0),linear-gradient(#fff 0 0);mask-position:0 0,0 0;mask-size:auto,auto;mask-repeat:repeat,repeat;mask-clip:content-box,border-box;mask-origin:content-box,border-box;mask-composite:exclude;mask-mode:match-source,match-source}@media (hover:hover){.ywGceq_card:hover:before{border-color:var(--dsw-alias-border-l4)}.ywGceq_card:hover:after{opacity:.35}}.ywGceq_selected:before{opacity:0}.ywGceq_selected:after{opacity:1}@media (hover:hover){.ywGceq_selected:hover:after{opacity:1}}.ywGceq_selected:after{animation:14s linear infinite ywGceq_borderSweep}.ywGceq_officeCard,.ywGceq_card[data-process=compact]{--card-border-stops:var(--dsw-gradient-onboarding-violet-stops)}.ywGceq_card[data-process=detailed]{--card-border-stops:var(--dsw-gradient-onboarding-cyan-stops)}@property --dsh-onboarding-border-angle{syntax:\"<angle>\";inherits:false;initial-value:90deg}@keyframes ywGceq_borderSweep{0%{--dsh-onboarding-border-angle:90deg}to{--dsh-onboarding-border-angle:450deg}}.ywGceq_card:focus-visible,html:not([data-input-modality=pointer]) .ywGceq_card:has(:focus-visible){outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:5px}.ywGceq_card[aria-disabled=true]{cursor:wait}.ywGceq_cardTop{justify-content:space-between;align-items:center;gap:12px;width:100%;height:40px;margin-bottom:12px;display:flex}.ywGceq_cardCheckbox{position:static}.ywGceq_card .ywGceq_cardCheckbox input:focus-visible,.ywGceq_card .ywGceq_cardCheckbox input:focus-visible+span{outline:none}.ywGceq_cardCheckbox:after{content:\"\";z-index:1;cursor:pointer;position:absolute;inset:0}.ywGceq_fileIcons{align-items:center;gap:clamp(2px,.56vw,8px);display:flex}.ywGceq_fileIcons>svg{transform-origin:0;flex:none}.ywGceq_iconsEntering>svg{animation:ywGceq_iconEnter var(--ds-transition-duration) var(--ds-ease-in-out) both}.ywGceq_iconsEntering>svg:nth-child(2){animation-delay:30ms}.ywGceq_iconsEntering>svg:nth-child(3){animation-delay:50ms}.ywGceq_iconsEntering>svg:nth-child(4){animation-delay:62ms}.ywGceq_iconsEntering>svg:nth-child(5){animation-delay:70ms}@keyframes ywGceq_iconEnter{0%{opacity:0;transform:scale(.8)}to{opacity:1;transform:scale(1)}}.ywGceq_cardTitle{font-size:20px;font-weight:400;line-height:28px}.ywGceq_cardDescription{color:var(--dsw-alias-label-tertiary);margin-top:8px;font-size:15px;font-weight:300;line-height:21px}.ywGceq_processIcon{justify-content:center;align-items:center;width:40px;height:40px;margin-bottom:12px;display:flex}.ywGceq_primaryAction{justify-content:center;width:100%;min-height:44px;margin-top:100px;display:flex;position:absolute;top:100%}.ywGceq_primaryAction>button{width:min(240px,100%)}.ywGceq_primaryAction>button[aria-disabled=true]{cursor:wait}.ywGceq_navigation{pointer-events:none;width:min(calc(100% - 2 * var(--page-padding)), 1200px);justify-content:space-between;display:flex;position:absolute;bottom:clamp(24px,7.61vh,70px);left:50%;transform:translate(-50%)}.ywGceq_navigation button{pointer-events:auto;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:0;align-items:center;gap:20px;padding:0;font-size:16px;font-weight:300;line-height:32px;display:flex}.ywGceq_navigation button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:5px}@media (hover:hover){.ywGceq_navigation button:hover:not(:disabled){color:var(--dsw-alias-label-primary)}}.ywGceq_backIcon{background:currentColor;flex:none;width:17px;height:14px;mask-position:50%;mask-size:contain;mask-repeat:no-repeat}.ywGceq_status{font-size:14px;line-height:22px;position:absolute;bottom:12px;left:50%;transform:translate(-50%)}.ywGceq_confirmation{color:var(--dsw-alias-label-primary);padding:22px 24px 0}.ywGceq_confirmationHeading{justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px;display:flex}.ywGceq_confirmation h2{margin:0;font-size:16px;font-weight:500;line-height:24px}.ywGceq_confirmationClose{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:28px;flex:none;justify-content:center;align-items:center;display:flex}@media (hover:hover){.ywGceq_confirmationClose:hover{background:var(--dsw-alias-interactive-bg-hover)}}.ywGceq_confirmation p{margin:0;font-size:14px;line-height:22px}.ywGceq_confirmationActions{justify-content:flex-end;gap:8px;margin-top:20px;display:flex}.ywGceq_dialogButton{font-family:var(--dsw-font-family);border-radius:12px;font-weight:500}.ywGceq_dialogButton:first-child{font-weight:400}@media (height<=760px){.ywGceq_purpose,.ywGceq_process{top:calc(50% - 180px)}.ywGceq_purpose .ywGceq_copy h1,.ywGceq_process .ywGceq_copy h1{font-size:28px;line-height:39px}.ywGceq_subtitle{margin-top:16px;line-height:21px}.ywGceq_card{min-height:187px;padding:24.5px 32.5px 32.5px}.ywGceq_processCards{min-height:0;padding-block:0}.ywGceq_primaryAction{margin-top:40px}.ywGceq_creditActions{margin-top:32px}}@media (width<=1200px){.ywGceq_welcomeIllustration{left:calc(73.333vw - 267.5px)}}@media (height>=920px){.ywGceq_welcomeIllustration{top:calc(50% - 326.855px)}}@media (width<=1100px){.ywGceq_page{--page-padding:40px}.ywGceq_copy h1{font-size:26px;line-height:40px}.ywGceq_heroDescription{font-size:16px;line-height:28px}.ywGceq_welcome .ywGceq_copy h1{font-size:28px;line-height:48px}.ywGceq_fileIcons{gap:3px}}@media (height<=560px){.ywGceq_page{overflow:auto}}@media (prefers-reduced-motion:reduce){.ywGceq_page button,.ywGceq_card,.ywGceq_card:before,.ywGceq_card:after{transition:none}.ywGceq_page,.ywGceq_fileIcons>svg,.ywGceq_selected:after{animation:none}}.ywGceq_page .ywGceq_action{height:44px;font-family:var(--dsw-font-family);border-radius:12px;padding:0 24px;font-size:14px;font-weight:500;line-height:22px}.ywGceq_page .ywGceq_action:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:3px}.ywGceq_page:lang(en) .ywGceq_navigation button{font-family:var(--dsw-font-family-brand)}.ywGceq_cardCheckbox input{opacity:0;width:24px;height:24px;margin:0;position:absolute}.ywGceq_indicator{box-sizing:border-box;border:2px solid var(--dsw-alias-onboarding-checkbox-border);width:24px;height:24px;color:var(--dsw-alias-label-primary-foreground);pointer-events:none;background:0 0;border-radius:6px;flex:none;justify-content:center;align-items:center;display:inline-flex}.ywGceq_indicator svg{visibility:hidden}.ywGceq_cardCheckbox input:checked+.ywGceq_indicator{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary)}.ywGceq_cardCheckbox input:checked+.ywGceq_indicator svg{visibility:visible}";
		const tagId = "@deepseek-ai/dsh-client-ui-settings-account/DesktopOnboarding.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-settings-account";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var DesktopOnboarding_module_css_default = {
			"action": "ywGceq_action",
			"backIcon": "ywGceq_backIcon",
			"blurred": "ywGceq_blurred",
			"borderSweep": "ywGceq_borderSweep",
			"brand": "ywGceq_brand",
			"card": "ywGceq_card",
			"cardCheckbox": "ywGceq_cardCheckbox",
			"cardDescription": "ywGceq_cardDescription",
			"cardTitle": "ywGceq_cardTitle",
			"cardTop": "ywGceq_cardTop",
			"confirmation": "ywGceq_confirmation",
			"confirmationActions": "ywGceq_confirmationActions",
			"confirmationClose": "ywGceq_confirmationClose",
			"confirmationHeading": "ywGceq_confirmationHeading",
			"content": "ywGceq_content",
			"copy": "ywGceq_copy",
			"credit": "ywGceq_credit",
			"creditActions": "ywGceq_creditActions",
			"creditIllustration": "ywGceq_creditIllustration",
			"darkIllustration": "ywGceq_darkIllustration",
			"dialogButton": "ywGceq_dialogButton",
			"fileIcons": "ywGceq_fileIcons",
			"heroDescription": "ywGceq_heroDescription",
			"iconEnter": "ywGceq_iconEnter",
			"iconsEntering": "ywGceq_iconsEntering",
			"illustration": "ywGceq_illustration",
			"indicator": "ywGceq_indicator",
			"laterAction": "ywGceq_laterAction",
			"lightIllustration": "ywGceq_lightIllustration",
			"loading": "ywGceq_loading",
			"navigation": "ywGceq_navigation",
			"officeCard": "ywGceq_officeCard",
			"page": "ywGceq_page",
			"pageEnter": "ywGceq_pageEnter",
			"primaryAction": "ywGceq_primaryAction",
			"process": "ywGceq_process",
			"processCards": "ywGceq_processCards",
			"processIcon": "ywGceq_processIcon",
			"purpose": "ywGceq_purpose",
			"purposeCards": "ywGceq_purposeCards",
			"selected": "ywGceq_selected",
			"start": "ywGceq_start",
			"status": "ywGceq_status",
			"subtitle": "ywGceq_subtitle",
			"welcome": "ywGceq_welcome",
			"welcomeArtwork": "ywGceq_welcomeArtwork",
			"welcomeIllustration": "ywGceq_welcomeIllustration"
		};
		//#endregion
		//#region lib/types/client/OnboardingIllustration.js
		/** Paired artwork follows the page's light and dark theme selectors. */
		/** @param props - artwork URLs and feature-owned geometry. @returns decorative theme variants. */
		function OnboardingIllustration({ className = "", src, darkSrc }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: `${DesktopOnboarding_module_css_default.illustration} ${className}`,
				"aria-hidden": "true",
				children: [(0, react_jsx_runtime.jsx)("img", {
					className: DesktopOnboarding_module_css_default.lightIllustration,
					src,
					alt: ""
				}), (0, react_jsx_runtime.jsx)("img", {
					className: DesktopOnboarding_module_css_default.darkIllustration,
					src: darkSrc,
					alt: ""
				})]
			});
		}
		//#endregion
		//#region src/client/assets/onboarding-welcome.webp
		var onboarding_welcome_default = require.asset("plugins/@deepseek-ai/dsh-client-ui-settings-account/assets/onboarding-welcome-8bee260fc9a4.webp");
		//#endregion
		//#region src/client/assets/onboarding-welcome-dark.webp
		var onboarding_welcome_dark_default = require.asset("plugins/@deepseek-ai/dsh-client-ui-settings-account/assets/onboarding-welcome-dark-1bdaf68d0d0a.webp");
		//#endregion
		//#region src/client/assets/onboarding-welcome-zh.webp
		var onboarding_welcome_zh_default = require.asset("plugins/@deepseek-ai/dsh-client-ui-settings-account/assets/onboarding-welcome-zh-9a237747664d.webp");
		//#endregion
		//#region src/client/assets/onboarding-welcome-zh-dark.webp
		var onboarding_welcome_zh_dark_default = require.asset("plugins/@deepseek-ai/dsh-client-ui-settings-account/assets/onboarding-welcome-zh-dark-6c914dc6013e.webp");
		//#endregion
		//#region lib/types/client/OnboardingWelcomeStep.js
		/** @param props - localized content, focus target and navigation. @returns the welcome step. */
		function OnboardingWelcomeStep({ t, locale, heading, busy, onStart }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: `${DesktopOnboarding_module_css_default.content} ${DesktopOnboarding_module_css_default.welcome}`,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: DesktopOnboarding_module_css_default.copy,
					children: [
						(0, react_jsx_runtime.jsxs)("h1", {
							id: "desktop-onboarding-title",
							ref: heading,
							tabIndex: -1,
							children: [
								t("onboardingWelcome"),
								" ",
								(0, react_jsx_runtime.jsx)("em", {
									className: DesktopOnboarding_module_css_default.brand,
									children: t("onboardingBrand")
								})
							]
						}),
						(0, react_jsx_runtime.jsx)("p", {
							className: DesktopOnboarding_module_css_default.heroDescription,
							children: t("onboardingIntroduction")
						}),
						(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							className: `${DesktopOnboarding_module_css_default.action} ${DesktopOnboarding_module_css_default.start}`,
							disabled: busy,
							onClick: onStart,
							children: t("onboardingStart")
						})
					]
				}), (0, react_jsx_runtime.jsx)("div", {
					className: DesktopOnboarding_module_css_default.welcomeIllustration,
					"aria-hidden": "true",
					children: (0, react_jsx_runtime.jsx)(OnboardingIllustration, {
						className: DesktopOnboarding_module_css_default.welcomeArtwork,
						src: locale === "zh" ? onboarding_welcome_zh_default : onboarding_welcome_default,
						darkSrc: locale === "zh" ? onboarding_welcome_zh_dark_default : onboarding_welcome_dark_default
					})
				})]
			});
		}
		//#endregion
		//#region src/client/assets/onboarding-recharge.webp
		var onboarding_recharge_default = require.asset("plugins/@deepseek-ai/dsh-client-ui-settings-account/assets/onboarding-recharge-9a85d64a2d3b.webp");
		//#endregion
		//#region src/client/assets/onboarding-recharge-dark.webp
		var onboarding_recharge_dark_default = require.asset("plugins/@deepseek-ai/dsh-client-ui-settings-account/assets/onboarding-recharge-dark-9878e7197bac.webp");
		//#endregion
		//#region src/client/assets/onboarding-recharge-zh.webp
		var onboarding_recharge_zh_default = require.asset("plugins/@deepseek-ai/dsh-client-ui-settings-account/assets/onboarding-recharge-zh-aec6cd5fc265.webp");
		//#endregion
		//#region src/client/assets/onboarding-recharge-zh-dark.webp
		var onboarding_recharge_zh_dark_default = require.asset("plugins/@deepseek-ai/dsh-client-ui-settings-account/assets/onboarding-recharge-zh-dark-5289932ad3f8.webp");
		//#endregion
		//#region lib/types/client/OnboardingCreditStep.js
		/** @param props - credit facts, localized content and recharge/navigation actions. @returns the credit step. */
		function OnboardingCreditStep({ t, locale, heading, busy, funded, canRecharge, onContinue, onRecharge, onLater }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: `${DesktopOnboarding_module_css_default.content} ${DesktopOnboarding_module_css_default.credit}`,
				children: [(0, react_jsx_runtime.jsx)(OnboardingIllustration, {
					className: DesktopOnboarding_module_css_default.creditIllustration,
					src: locale === "zh" ? onboarding_recharge_zh_default : onboarding_recharge_default,
					darkSrc: locale === "zh" ? onboarding_recharge_zh_dark_default : onboarding_recharge_dark_default
				}), (0, react_jsx_runtime.jsxs)("div", {
					className: DesktopOnboarding_module_css_default.copy,
					children: [
						(0, react_jsx_runtime.jsx)("h1", {
							id: "desktop-onboarding-title",
							ref: heading,
							tabIndex: -1,
							children: t("onboardingCredit")
						}),
						(0, react_jsx_runtime.jsx)("p", {
							className: DesktopOnboarding_module_css_default.heroDescription,
							children: t("onboardingCreditDescription")
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: DesktopOnboarding_module_css_default.creditActions,
							children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								className: DesktopOnboarding_module_css_default.action,
								variant: "primary",
								disabled: busy || !funded && !canRecharge,
								onClick: funded ? onContinue : onRecharge,
								children: t(funded ? "onboardingContinue" : "onboardingTopUp")
							}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								className: `${DesktopOnboarding_module_css_default.action} ${DesktopOnboarding_module_css_default.laterAction}`,
								disabled: busy || funded && !canRecharge,
								onClick: funded ? onRecharge : onLater,
								children: t(funded ? "onboardingFundedTopUp" : "onboardingLater")
							})]
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/client/assets/onboarding-office.svg
		var onboarding_office_default = require.asset("plugins/@deepseek-ai/dsh-client-ui-settings-account/assets/onboarding-office-8ca45c77307a.svg");
		//#endregion
		//#region src/client/assets/onboarding-code.svg
		var onboarding_code_default = require.asset("plugins/@deepseek-ai/dsh-client-ui-settings-account/assets/onboarding-code-130f4f9f819c.svg");
		//#endregion
		//#region lib/types/client/OnboardingPurposeStep.js
		/** Work-purpose selection with controlled, independently selectable cards. */
		/** @param props - selected purposes, localized copy and persistence callbacks. @returns the purpose step. */
		function OnboardingPurposeStep({ t, heading, busy, purpose, onSelect, onContinue }) {
			const selected = (value) => purpose === value || purpose === "both";
			const toggle = (value) => {
				if (busy) return;
				const office = value === "office" ? !selected("office") : selected("office");
				const development = value === "development" ? !selected("development") : selected("development");
				onSelect(office && development ? "both" : office ? "office" : development ? "development" : null);
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: `${DesktopOnboarding_module_css_default.content} ${DesktopOnboarding_module_css_default.purpose}`,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: DesktopOnboarding_module_css_default.copy,
						children: [(0, react_jsx_runtime.jsxs)("h1", {
							id: "desktop-onboarding-title",
							ref: heading,
							tabIndex: -1,
							children: [
								t("onboardingPurposePrefix"),
								" ",
								(0, react_jsx_runtime.jsx)("em", {
									className: DesktopOnboarding_module_css_default.brand,
									children: t("onboardingBrand")
								}),
								" ",
								t("onboardingPurposeSuffix")
							]
						}), (0, react_jsx_runtime.jsx)("p", {
							className: DesktopOnboarding_module_css_default.subtitle,
							children: t("onboardingPurposeDescription")
						})]
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: DesktopOnboarding_module_css_default.purposeCards,
						children: ["office", "development"].map((value) => (0, react_jsx_runtime.jsx)(PurposeCard, {
							purpose: value,
							checked: selected(value),
							t,
							onToggle: () => {
								toggle(value);
							}
						}, value))
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: DesktopOnboarding_module_css_default.primaryAction,
						children: purpose !== null && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							className: DesktopOnboarding_module_css_default.action,
							variant: "primary",
							"aria-disabled": busy,
							onClick: () => {
								if (!busy) onContinue();
							},
							children: t("onboardingContinue")
						})
					})
				]
			});
		}
		function PurposeCard({ purpose, checked, t, onToggle }) {
			const previous = (0, react.useRef)(checked);
			const [entering, setEntering] = (0, react.useState)(false);
			(0, react.useLayoutEffect)(() => {
				setEntering(checked && !previous.current);
				previous.current = checked;
			}, [checked]);
			const titleKey = purpose === "office" ? "onboardingOffice" : "onboardingDevelopment";
			return (0, react_jsx_runtime.jsxs)("div", {
				className: `${DesktopOnboarding_module_css_default.card} ${checked ? DesktopOnboarding_module_css_default.selected : ""} ${purpose === "office" ? DesktopOnboarding_module_css_default.officeCard : ""}`,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: DesktopOnboarding_module_css_default.cardTop,
						children: [checked ? (0, react_jsx_runtime.jsx)("span", {
							className: `${DesktopOnboarding_module_css_default.fileIcons} ${entering ? DesktopOnboarding_module_css_default.iconsEntering : ""}`,
							"aria-hidden": "true",
							children: (purpose === "office" ? [
								"word",
								"ppt",
								"excel",
								"pdf",
								"image"
							] : [
								"typescript",
								"javascript",
								"sql",
								"python",
								"cpp"
							]).map((kind) => (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.FileTypeIcon, {
								kind,
								size: 28
							}, kind))
						}) : (0, react_jsx_runtime.jsx)("img", {
							src: purpose === "office" ? onboarding_office_default : onboarding_code_default,
							width: 40,
							height: 40,
							alt: ""
						}), (0, react_jsx_runtime.jsxs)("label", {
							className: DesktopOnboarding_module_css_default.cardCheckbox,
							children: [(0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								"aria-label": t(titleKey),
								checked,
								onChange: onToggle
							}), (0, react_jsx_runtime.jsx)("span", {
								className: DesktopOnboarding_module_css_default.indicator,
								"aria-hidden": "true",
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutlineRegular, {})
							})]
						})]
					}),
					(0, react_jsx_runtime.jsx)("span", {
						className: DesktopOnboarding_module_css_default.cardTitle,
						children: t(titleKey)
					}),
					(0, react_jsx_runtime.jsx)("span", {
						className: DesktopOnboarding_module_css_default.cardDescription,
						children: t(purpose === "office" ? "onboardingOfficeDescription" : "onboardingDevelopmentDescription")
					})
				]
			});
		}
		//#endregion
		//#region src/client/assets/onboarding-compact.svg
		var onboarding_compact_default = require.asset("plugins/@deepseek-ai/dsh-client-ui-settings-account/assets/onboarding-compact-4d29ad212f3b.svg");
		//#endregion
		//#region src/client/assets/onboarding-standard.svg
		var onboarding_standard_default = require.asset("plugins/@deepseek-ai/dsh-client-ui-settings-account/assets/onboarding-standard-13b8aa0232ab.svg");
		//#endregion
		//#region src/client/assets/onboarding-detailed.svg
		var onboarding_detailed_default = require.asset("plugins/@deepseek-ai/dsh-client-ui-settings-account/assets/onboarding-detailed-0e44397e280d.svg");
		//#endregion
		//#region lib/types/client/OnboardingProcessStep.js
		const options = [
			{
				value: "compact",
				titleKey: "onboardingCompact",
				descriptionKey: "onboardingCompactDescription",
				icon: onboarding_compact_default,
				size: 40
			},
			{
				value: "standard",
				titleKey: "onboardingStandard",
				descriptionKey: "onboardingStandardDescription",
				icon: onboarding_standard_default,
				size: 36
			},
			{
				value: "detailed",
				titleKey: "onboardingDetailed",
				descriptionKey: "onboardingDetailedDescription",
				icon: onboarding_detailed_default,
				size: 36
			}
		];
		/** @param props - selected detail, localized copy and persistence callbacks. @returns the process step. */
		function OnboardingProcessStep({ t, heading, busy, process, onSelect, onComplete }) {
			const onKeyDown = (event, value) => {
				if (busy) return;
				const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
				if (direction === 0) return;
				event.preventDefault();
				const next = options[(options.findIndex((option) => option.value === value) + direction + options.length) % options.length];
				onSelect(next.value);
				event.currentTarget.parentElement?.querySelector(`[data-process="${next.value}"]`)?.focus();
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: `${DesktopOnboarding_module_css_default.content} ${DesktopOnboarding_module_css_default.process}`,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: DesktopOnboarding_module_css_default.copy,
						children: [(0, react_jsx_runtime.jsx)("h1", {
							id: "desktop-onboarding-title",
							ref: heading,
							tabIndex: -1,
							children: t("onboardingProcess")
						}), (0, react_jsx_runtime.jsx)("p", {
							className: DesktopOnboarding_module_css_default.subtitle,
							children: t("onboardingProcessDescription")
						})]
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: DesktopOnboarding_module_css_default.processCards,
						role: "radiogroup",
						"aria-labelledby": "desktop-onboarding-title",
						children: options.map((option) => (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							role: "radio",
							"data-process": option.value,
							"aria-checked": process === option.value,
							tabIndex: process === option.value || process === null && option.value === "compact" ? 0 : -1,
							className: `${DesktopOnboarding_module_css_default.card} ${process === option.value ? DesktopOnboarding_module_css_default.selected : ""}`,
							"aria-disabled": busy,
							onClick: () => {
								if (!busy) onSelect(option.value);
							},
							onKeyDown: (event) => {
								onKeyDown(event, option.value);
							},
							children: [
								(0, react_jsx_runtime.jsx)("span", {
									className: DesktopOnboarding_module_css_default.processIcon,
									children: (0, react_jsx_runtime.jsx)("img", {
										src: option.icon,
										width: option.size,
										height: option.size,
										alt: ""
									})
								}),
								(0, react_jsx_runtime.jsx)("span", {
									className: DesktopOnboarding_module_css_default.cardTitle,
									children: t(option.titleKey)
								}),
								(0, react_jsx_runtime.jsx)("span", {
									className: DesktopOnboarding_module_css_default.cardDescription,
									children: t(option.descriptionKey)
								})
							]
						}, option.value))
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: DesktopOnboarding_module_css_default.primaryAction,
						children: process !== null && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							className: DesktopOnboarding_module_css_default.action,
							variant: "primary",
							"aria-disabled": busy,
							onClick: () => {
								if (!busy) onComplete();
							},
							children: t("onboardingEnter")
						})
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/OnboardingConfirmation.js
		/** Credit and setup confirmations with contained keyboard focus. */
		/** @param props - confirmation action, localized copy and navigation callbacks. @returns a focus-contained dialog. */
		function OnboardingConfirmation({ kind, t, busy, canRecharge, onClose, onContinueSetup, onContinue, onRecharge, onSkip }) {
			const credit = kind !== "skip";
			const title = t(credit ? "onboardingNoCreditTitle" : "onboardingSkipTitle");
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				headless: true,
				backdropBlur: false,
				title,
				onClose,
				children: (0, react_jsx_runtime.jsxs)("div", {
					className: DesktopOnboarding_module_css_default.confirmation,
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							className: DesktopOnboarding_module_css_default.confirmationHeading,
							children: [(0, react_jsx_runtime.jsx)("h2", { children: title }), (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: DesktopOnboarding_module_css_default.confirmationClose,
								"aria-label": t("close"),
								onClick: onClose,
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutlineRegular, { size: 14 })
							})]
						}),
						(0, react_jsx_runtime.jsx)("p", { children: t(credit ? "onboardingNoCreditDescription" : "onboardingSkipDescription") }),
						(0, react_jsx_runtime.jsxs)("div", {
							className: DesktopOnboarding_module_css_default.confirmationActions,
							children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								className: DesktopOnboarding_module_css_default.dialogButton,
								variant: "outline",
								disabled: busy,
								onClick: kind === "credit-skip" ? onSkip : kind === "credit" ? onContinue : onContinueSetup,
								children: t(credit ? "onboardingUnderstood" : "onboardingKeepSetting")
							}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								className: DesktopOnboarding_module_css_default.dialogButton,
								variant: "primary",
								disabled: busy || credit && !canRecharge,
								onClick: credit ? onRecharge : onSkip,
								children: t(credit ? "onboardingGoTopUp" : "onboardingEnter")
							})]
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/assets/onboarding-back.svg
		var onboarding_back_default = require.asset("plugins/@deepseek-ai/dsh-client-ui-settings-account/assets/onboarding-back-04427ce3e26c.svg");
		//#endregion
		//#region lib/types/client/DesktopOnboarding.js
		const onboardingPages = {
			welcome: "onboarding_welcome",
			credit: "onboarding_recharge",
			purpose: "onboarding_use_case",
			process: "onboarding_process",
			done: void 0
		};
		/**
		* @param props - durable choices, account state, localized copy and the shared recharge page channel.
		* @returns the active first-run page.
		*/
		function DesktopOnboarding({ state, account, openPlatformPage, update, complete, retry, t, locale, track, exiting = false }) {
			const [dialog, setDialog] = (0, react.useState)(null);
			const heading = (0, react.useRef)(null);
			const page = (0, react.useRef)(null);
			const releaseRecharge = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => () => {
				releaseRecharge.current?.();
				releaseRecharge.current = void 0;
			}, []);
			const progress = state.progress;
			const targetStep = progress.step;
			const [step, setStep] = (0, react.useState)(targetStep);
			const busy = state.status === "loading" || state.status === "saving" || exiting || step !== targetStep;
			(0, react.useEffect)(() => {
				if (step === targetStep) return;
				const element = page.current;
				if (!state.visible || element?.animate === void 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) {
					setStep(targetStep);
					return;
				}
				const animation = element.animate([{ opacity: 1 }, { opacity: 0 }], {
					duration: 40,
					fill: "forwards",
					easing: "ease-out"
				});
				animation.finished.then(() => {
					setStep(targetStep);
				}, (_error) => {});
				return () => {
					animation.cancel();
				};
			}, [
				targetStep,
				step,
				state.visible
			]);
			(0, react.useEffect)(() => {
				heading.current?.focus();
			}, [step]);
			const pageName = onboardingPages[step];
			const shownPage = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (!state.visible || pageName === void 0 || exiting) {
					shownPage.current = null;
					return;
				}
				if (state.status === "loading") return;
				if (shownPage.current === pageName) return;
				shownPage.current = pageName;
				track?.("onboarding_page_view", { page_name: pageName });
			}, [
				state.visible,
				state.status,
				step,
				pageName,
				exiting,
				track
			]);
			const shownPopup = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (dialog === null || !state.visible || state.status === "loading" || step === "done") {
					shownPopup.current = null;
					return;
				}
				if (shownPopup.current === dialog) return;
				shownPopup.current = dialog;
				track?.("onboarding_popup_view", { popup_name: dialog === "skip" ? "skip_setting" : "skip_charge" });
			}, [
				dialog,
				track,
				state.visible,
				state.status,
				step
			]);
			const popupClick = (button_name) => {
				track?.("onboarding_popup_click", {
					popup_name: dialog === "skip" ? "skip_setting" : "skip_charge",
					button_name
				});
			};
			if (state.visible && state.status === "loading") return (0, react_jsx_runtime.jsx)(OnboardingSurface, { children: (0, react_jsx_runtime.jsx)("div", {
				className: DesktopOnboarding_module_css_default.loading,
				role: "status",
				children: t("onboardingLoading")
			}) });
			if (!state.visible || pageName === void 0) return null;
			const click = (button_name) => {
				const selected_content = step === "purpose" && progress.purpose !== null ? {
					office: "office",
					development: "code",
					both: "code_office"
				}[progress.purpose] : step === "process" && progress.process !== null ? {
					compact: "focus_result",
					standard: "key_detail",
					detailed: "full_process"
				}[progress.process] : void 0;
				track?.("onboarding_page_click", {
					page_name: pageName,
					button_name,
					...selected_content === void 0 ? {} : { selected_content }
				});
			};
			const go = (next) => {
				update({ step: next });
			};
			const canRecharge = openPlatformPage !== void 0;
			const recharge = () => {
				setDialog(null);
				releaseRecharge.current?.();
				releaseRecharge.current = openPlatformPage?.("top-up", () => {
					releaseRecharge.current = void 0;
				});
			};
			const later = () => {
				const balance = account.details?.balance;
				if (balance?.status === "ready" && !hasOnboardingCredit(balance)) setDialog("credit");
				else go("purpose");
			};
			const purposeNext = () => {
				if (progress.purpose === "office") complete("completed");
				else go("process");
			};
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(OnboardingSurface, {
				exiting,
				children: (0, react_jsx_runtime.jsxs)("section", {
					ref: page,
					className: `${DesktopOnboarding_module_css_default.page} ${dialog !== null ? DesktopOnboarding_module_css_default.blurred : ""}`,
					"data-desktop-onboarding": step,
					lang: locale,
					"aria-labelledby": "desktop-onboarding-title",
					"aria-busy": busy,
					children: [
						step === "welcome" && (0, react_jsx_runtime.jsx)(OnboardingWelcomeStep, {
							t,
							locale,
							heading,
							busy,
							onStart: () => {
								click("next");
								go("credit");
							}
						}),
						step === "credit" && (0, react_jsx_runtime.jsx)(OnboardingCreditStep, {
							t,
							locale,
							heading,
							busy,
							funded: state.creditFunded,
							canRecharge,
							onContinue: () => {
								click("continue");
								go("purpose");
							},
							onRecharge: () => {
								click("charge");
								recharge();
							},
							onLater: () => {
								click("later");
								later();
							}
						}),
						step === "purpose" && (0, react_jsx_runtime.jsx)(OnboardingPurposeStep, {
							t,
							heading,
							busy,
							purpose: progress.purpose,
							onSelect: (purpose) => {
								update({ purpose });
							},
							onContinue: () => {
								click("next");
								purposeNext();
							}
						}),
						step === "process" && (0, react_jsx_runtime.jsx)(OnboardingProcessStep, {
							t,
							heading,
							busy,
							process: progress.process,
							onSelect: (process) => {
								update({ process });
							},
							onComplete: () => {
								click("next");
								complete("completed");
							}
						}),
						state.error !== null && (0, react_jsx_runtime.jsxs)("div", {
							className: DesktopOnboarding_module_css_default.status,
							role: "alert",
							children: [t("onboardingSaveFailed"), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								disabled: busy,
								onClick: () => {
									retry();
								},
								children: t("onboardingRetry")
							})]
						}),
						step !== "welcome" && (0, react_jsx_runtime.jsxs)("footer", {
							className: DesktopOnboarding_module_css_default.navigation,
							children: [(0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								disabled: busy,
								onClick: () => {
									click("back");
									go(step === "credit" ? "welcome" : step === "purpose" ? "credit" : "purpose");
								},
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: DesktopOnboarding_module_css_default.backIcon,
									style: { maskImage: `url(${onboarding_back_default})` },
									"aria-hidden": "true"
								}), t("onboardingBack")]
							}), (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: busy,
								onClick: () => {
									click("skip");
									setDialog(step === "credit" ? "credit-skip" : "skip");
								},
								children: t("onboardingSkip")
							})]
						})
					]
				}, step)
			}), dialog !== null && (0, react_jsx_runtime.jsx)(OnboardingConfirmation, {
				kind: dialog,
				t,
				busy,
				canRecharge,
				onClose: () => {
					popupClick("close");
					setDialog(null);
				},
				onContinueSetup: () => {
					popupClick("setting");
					setDialog(null);
				},
				onContinue: () => {
					popupClick("know");
					setDialog(null);
					go("purpose");
				},
				onRecharge: () => {
					popupClick("charge");
					recharge();
				},
				onSkip: () => {
					popupClick(dialog === "skip" ? "enter" : "know");
					complete("skipped").then(() => {
						setDialog(null);
					});
				}
			})] });
		}
		//#endregion
		//#region lib/types/client/DesktopOnboardingEntry.js
		/** Framework-hook projection into the desktop introduction's pure view. */
		/**
		* Read shared state through framework hooks; sessions do not control activation.
		* @param props - shell overlay bindings and account-owned actions.
		* @returns the unfinished flow, retained briefly after successful completion unless motion is reduced.
		*/
		function DesktopOnboardingEntry({ useOnboarding, useAccount, setVisible, ...props }) {
			const locale = props.t("onboardingArtworkLocale");
			const state = useOnboarding((value) => value);
			const account = useAccount((value) => value);
			(0, react.useLayoutEffect)(() => {
				if (!state.visible) return;
				const bridge = globalThis.dshOnboarding;
				bridge?.setActive(true);
				return () => {
					bridge?.setActive(false);
				};
			}, [state.visible]);
			const [lastVisible, setLastVisible] = (0, react.useState)(state.visible ? state : null);
			const done = !state.visible && state.progress.step === "done" && account.view?.status === "credential-stored";
			const pendingCompletion = done && state.status === "saving";
			const completed = done && state.status === "ready";
			const exiting = completed && lastVisible !== null && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			(0, react.useLayoutEffect)(() => {
				if (state.visible) setLastVisible(state);
				else if (!completed && !pendingCompletion) setLastVisible(null);
			}, [
				state,
				completed,
				pendingCompletion
			]);
			(0, react.useEffect)(() => {
				if (!exiting) return;
				const timer = window.setTimeout(() => {
					setLastVisible(null);
				}, 180);
				return () => {
					window.clearTimeout(timer);
				};
			}, [exiting]);
			const displayed = state.visible ? state : exiting || pendingCompletion ? lastVisible : null;
			const visible = displayed !== null || state.status === "loading";
			(0, react.useLayoutEffect)(() => {
				setVisible(visible);
			}, [setVisible, visible]);
			if (displayed === null) return state.status === "loading" ? (0, react_jsx_runtime.jsx)(OnboardingSurface, { children: (0, react_jsx_runtime.jsx)("div", {
				role: "status",
				children: props.t("onboardingLoading")
			}) }) : null;
			return (0, react_jsx_runtime.jsx)(DesktopOnboarding, {
				...props,
				locale,
				state: pendingCompletion ? {
					...displayed,
					status: "saving"
				} : displayed,
				account,
				exiting
			});
		}
		//#endregion
		//#region lib/types/client/onboarding-credentials.js
		/** Desktop login owns model-credential discovery for both welcome and onboarding. */
		/**
		* Read the same safe credential fact used by native login.
		* @returns configured API-key presence; rejects when the desktop bridge is unavailable.
		*/
		async function readOnboardingApiKeyPresence() {
			const bridge = globalThis.dshOnboarding;
			if (bridge === void 0) throw new Error("desktop login bridge unavailable");
			return bridge.hasApiKey();
		}
		//#endregion
		//#region lib/types/client/account-refresh.js
		/** Refresh ordering for returning from an external account operation. */
		/**
		* Wait for the pre-return read, then request a fresh account snapshot.
		* @param pending - query already running before the user returned.
		* @param refresh - account owner's normal refresh operation.
		* @returns settlement of the new query, independent of the older query's outcome.
		*/
		async function refreshAfterReturn(pending, refresh) {
			try {
				await pending;
			} catch (_error) {}
			await refresh();
		}
		//#endregion
		//#region lib/types/client/account-avatar.js
		/** One account picture load shared by the sidebar and Settings for this plugin lifetime. */
		/** Owns the browser image and discards callbacks after URL replacement or plugin unload. */
		var AccountAvatarLoader = class {
			publish;
			snapshot;
			image;
			disposed = false;
			/** @param publish - publishes picture changes through the account snapshot. */
			constructor(publish) {
				this.publish = publish;
			}
			/**
			* Load a changed URL once; an absent or empty URL clears the picture.
			* @param url - latest successful profile's picture, absent when no picture is available.
			*/
			setUrl(url) {
				if (this.disposed) return;
				const source = url || void 0;
				if (this.snapshot?.url === source) return;
				if (source === void 0) {
					this.detach();
					this.update(void 0);
				} else this.load(source);
			}
			/** Retry a failed picture once; successful and pending loads remain shared. */
			retry() {
				if (!this.disposed && this.snapshot?.status === "failed") this.load(this.snapshot.url);
			}
			/**
			* Return both surfaces to fallback when a rendered picture fails.
			* @param snapshot - picture attempt rendered by the failing element; superseded attempts are ignored.
			*/
			failed(snapshot) {
				if (this.disposed || this.snapshot !== snapshot || snapshot.status !== "ready") return;
				this.detach();
				this.update({
					url: snapshot.url,
					status: "failed"
				});
			}
			/** Release the picture without publishing; the owner publishes an empty avatar with the replacement account frame. */
			reset() {
				this.detach();
				this.snapshot = void 0;
			}
			/** Release the browser image and prevent further loads or publications. */
			dispose() {
				this.disposed = true;
				this.reset();
			}
			load(url) {
				this.detach();
				const image = new Image();
				this.image = image;
				image.referrerPolicy = "no-referrer";
				const settle = (status) => {
					if (this.image !== image) return;
					image.onload = null;
					image.onerror = null;
					this.update({
						url,
						status
					});
				};
				image.onload = () => {
					settle("ready");
				};
				image.onerror = () => {
					settle("failed");
				};
				this.update({
					url,
					status: "loading"
				});
				if (this.image === image) image.src = url;
			}
			update(snapshot) {
				this.snapshot = snapshot;
				this.publish(snapshot);
			}
			detach() {
				const image = this.image;
				this.image = void 0;
				if (image === void 0) return;
				image.onload = null;
				image.onerror = null;
				image.removeAttribute("src");
			}
		};
		//#endregion
		//#region lib/types/client/index.js
		/** Services required by account settings. */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.account",
			"remote.session",
			"theme",
			"configForms",
			"remoteAccess"
		];
		/** Register account UI in Desktop and plain Web clients. @param ctx - client plugin context. */
		function apply(ctx) {
			const desktop = "dshDesktop" in globalThis;
			ctx.effect(() => ctx.locale.register("settings.account", {
				en,
				zh,
				ja,
				es,
				fr,
				de,
				ru,
				pt
			}), "account: dictionaries");
			const t = ctx.locale.bind("settings.account");
			const config = ContactConfig(globalThis["__DSH_CONTACT_CONFIG__"] ?? {});
			let snapshot = {
				view: void 0,
				details: void 0,
				avatar: void 0,
				failed: false,
				loginVisible: false,
				desktopOnboardingVisible: desktop
			};
			const browser = new BrowserLogin((url) => authorizeUrlWithTheme(url, ctx.theme.getTheme().active.colorScheme));
			ctx.effect(() => () => {
				browser.dispose();
			}, "account: pending browser window");
			const listeners = /* @__PURE__ */ new Set();
			const publish = (value) => {
				snapshot = value;
				for (const listener of listeners) listener();
			};
			const avatar = new AccountAvatarLoader((value) => {
				publish({
					...snapshot,
					avatar: value
				});
			});
			ctx.effect(() => () => {
				avatar.dispose();
			}, "account: profile picture lifetime");
			/** @returns the client identity for one account call, read at call time so it carries the language and zone in effect then. */
			const client = () => accountClientMetadata(ctx.locale.getSnapshot().active, "0.2.2-rc.1");
			const notices = createBonusNoticeController({
				ackRetryDelayMs: config.bonusAckRetryDelayMs,
				ackRetryMaxDelayMs: config.bonusAckRetryMaxDelayMs,
				read: async () => {
					const result = await ctx.remote.account.getUnnotifiedBonuses(client());
					if (!result.ok) throw new Error("account bonus read failed");
					return result.value;
				},
				acknowledge: async (accountId, orderId) => {
					const result = await ctx.remote.account.ackBonusNotified(accountId, orderId, client());
					if (!result.ok) throw new Error("account bonus acknowledgement failed");
					return result.value;
				},
				publish: (notices) => {
					const { notices: _replaced, ...withoutNotices } = snapshot;
					publish(notices.length === 0 ? withoutNotices : {
						...withoutNotices,
						notices
					});
				}
			});
			ctx.effect(() => () => {
				notices.end();
			}, "account: bonus notice lifetime");
			let revision = 0;
			let refreshing;
			const refresh = () => {
				if (snapshot.view?.status !== "credential-stored") return Promise.resolve();
				if (refreshing !== void 0) return refreshing;
				const generation = revision;
				const read = async (field, query) => {
					let value;
					try {
						value = await query();
					} catch {
						value = { status: "failed" };
					}
					if (value?.status === "failed") console.error("[deepseek-account] account read failed", { field });
					if (generation === revision && value !== null) publish({
						...snapshot,
						details: {
							...snapshot.details,
							[field]: value
						}
					});
				};
				const request = Promise.all([read("profile", async () => {
					const result = await ctx.remote.account.getProfile(client());
					if (!result.ok) throw new Error("account profile failed");
					if (generation === revision && result.value?.status === "ready") avatar.setUrl(result.value.value.avatarUrl);
					return result.value;
				}), read("balance", async () => {
					const result = await ctx.remote.account.getBalance(client());
					if (!result.ok) throw new Error("account balance failed");
					return result.value;
				})]).then(() => void 0);
				refreshing = request;
				request.finally(() => {
					if (refreshing === request) refreshing = void 0;
				});
				return request;
			};
			ctx.effect(() => () => {
				revision++;
			}, "account: details request lifetime");
			ctx.remoteAccess.whenAccess("account/watch", function* () {
				const stream = ctx.remote.$stream({
					name: "account",
					open: (signal) => ctx.remote.account.watch(signal),
					ended: () => /* @__PURE__ */ new Error("account stream ended")
				});
				const grant = { ended: false };
				yield () => {
					grant.ended = true;
					revision++;
					refreshing = void 0;
					avatar.reset();
					browser.dispose();
					const { loginFailed: _loginFailed, ...current } = snapshot;
					publish({
						...current,
						view: void 0,
						details: void 0,
						avatar: void 0,
						failed: false,
						loginVisible: false
					});
					notices.end();
					return stream.dispose();
				};
				(async () => {
					for await (const frame of stream) {
						if (grant.ended) return;
						revision++;
						refreshing = void 0;
						avatar.reset();
						const initialize = frame.value.status === "credential-stored" && frame.value.attempt?.phase === "succeeded" && snapshot.view?.attempt?.phase !== "succeeded";
						const { notices: previousNotices, ...previous } = snapshot;
						publish({
							...previous,
							view: frame.value,
							details: void 0,
							avatar: void 0,
							failed: false,
							...frame.value.status === "credential-stored" && previousNotices ? { notices: previousNotices } : {}
						});
						browser.update(frame.value);
						frame.accept();
						if (frame.value.status === "credential-stored") notices.begin();
						else notices.end();
						if (initialize) (async () => {
							try {
								if (!(await ctx.remote.session.initializeDefaultModel()).ok) console.error("[deepseek-account] default model initialization failed", { reason: "refused" });
							} catch (_error) {
								console.error("[deepseek-account] default model initialization failed", { reason: "disconnected" });
							}
						})();
						refresh();
					}
				})().catch(() => {
					if (!grant.ended) publish({
						...snapshot,
						failed: true
					});
				});
			});
			const nativePlatform = globalThis.dshPlatform;
			const platformPages = createPlatformPages();
			ctx.effect(() => () => {
				platformPages.dispose();
			}, "account: platform page request");
			const refreshAccount = async () => {
				avatar.retry();
				await Promise.all([refresh(), notices.refresh()]);
			};
			/**
			* Narrow the shared channel to one surface's post-return read: only a viewer
			* returning from top-up re-reads, so a superseded page or a plugin teardown
			* never triggers account work.
			* @param reRead - that surface's read after a returned top-up page.
			* @returns the opener that surface injects.
			*/
			const platformPageOpener = (reRead) => (page, onClose) => platformPages.open(page, (reason) => {
				onClose(reason);
				if (reason === "returned" && page === "top-up") refreshAfterReturn(refreshing, reRead);
			});
			const operations = {
				avatarFailed: (value) => {
					avatar.failed(value);
				},
				subscribeSessionExpired: (listener) => ctx.remote.$on("deepseek-account/session-expired", listener),
				subscribeModelSignInRequired: (listener) => ctx.remote.$on("deepseek-account/model-sign-in-required", listener),
				...nativePlatform === void 0 ? {} : { openPlatformPage: platformPageOpener(refreshAccount) },
				refreshAccount,
				contactUs() {
					const profile = snapshot.details?.profile;
					const context = {
						uid: profile?.status === "ready" ? profile.value.id : null,
						version: "0.2.2-rc.1",
						width: window.screen.width,
						height: window.screen.height,
						pixelRatio: window.devicePixelRatio
					};
					const openForm = (deviceInfo) => {
						window.open(contactUrl(config, {
							...context,
							deviceInfo
						}), "_blank", "noopener,noreferrer");
					};
					const readDeviceInfo = globalThis.dshDesktop?.deviceInfo;
					if (readDeviceInfo === void 0) {
						openForm(navigator.userAgent);
						return;
					}
					(async () => {
						let deviceInfo = "";
						try {
							deviceInfo = await readDeviceInfo();
						} catch (_error) {}
						openForm(deviceInfo);
					})();
				},
				showLogin(visible) {
					publish({
						...snapshot,
						loginVisible: visible
					});
				},
				setOnboarding(active) {
					publish({
						...snapshot,
						onboarding: active
					});
				},
				bonusNoticeShown(orderId) {
					notices.shown(orderId);
				},
				bonusNoticeDismissed(orderId) {
					notices.dismiss(orderId);
				},
				hooks: {
					account: {
						getSnapshot: () => snapshot,
						subscribe: (listener) => {
							listeners.add(listener);
							return () => {
								listeners.delete(listener);
							};
						}
					},
					theme: {
						getSnapshot: () => ctx.theme.getTheme(),
						subscribe: (listener) => ctx.on("theme/change", listener)
					}
				},
				async start() {
					publish({
						...snapshot,
						loginVisible: true,
						loginFailed: false
					});
					const transport = globalThis.__DSH_TRANSPORT__;
					const request = async () => {
						const result = await ctx.remote.account.startSignIn(client(), desktop && transport?.streamBaseUrl !== void 0 ? new URL(transport.streamBaseUrl).origin : window.location.origin, desktop ? "desktop" : "web");
						if (!result.ok) throw new Error("account start failed");
						return result.value;
					};
					try {
						if (desktop) await request();
						else await browser.start(request, () => snapshot.view);
					} catch (error) {
						publish({
							...snapshot,
							loginFailed: true
						});
						throw error;
					}
				},
				async cancel(id) {
					if (!(await ctx.remote.account.cancelSignIn(id)).ok) throw new Error("account cancel failed");
				},
				async hasRunningAccountTasks() {
					const result = await ctx.remote.account.hasRunningAccountTasks();
					if (!result.ok) throw new Error("account task query failed");
					return result.value;
				},
				async signOut() {
					const result = await ctx.remote.account.signOut(client());
					if (result.ok) return;
					throw result.error;
				}
			};
			if (desktop) {
				const controller = new DesktopOnboardingController(ctx.configForms.get(DESKTOP_ONBOARDING_NAMESPACE), ctx.configForms.get("ui-chat"), (enabled) => ctx.configForms.developerTools.setEnabled(enabled), operations.hooks.account, readOnboardingApiKeyPresence, ctx.configForms.describe());
				ctx.effect(() => () => {
					controller.dispose();
				}, "account: desktop onboarding lifetime");
				ctx.effect(() => {
					const refreshCredentials = () => {
						controller.invalidateCredentials();
					};
					const disposers = [
						ctx.remote.$on("credentials/reference-updated", refreshCredentials),
						ctx.remote.$on("llm/adapters-updated", refreshCredentials),
						ctx.configForms.describe().subscribe(refreshCredentials)
					];
					return () => {
						for (const dispose of disposers) dispose();
					};
				}, "account: desktop credential readiness");
				ctx.slots.inject("shell.overlay", () => ctx.slots.register({
					name: "shell.overlay",
					id: "desktop-onboarding",
					locale: "settings.account",
					inject: () => ({
						hooks: {
							account: operations.hooks.account,
							onboarding: controller.state
						},
						setVisible: (visible) => {
							if (snapshot.desktopOnboardingVisible !== visible) publish({
								...snapshot,
								desktopOnboardingVisible: visible
							});
						},
						...nativePlatform === void 0 ? {} : { openPlatformPage: platformPageOpener(refresh) },
						update: (change) => controller.update(change),
						complete: (reason) => controller.complete(reason),
						retry: () => controller.retry(),
						track: (name, attributes) => ctx.get("productAnalytics")?.track(name, attributes)
					})
				}, DesktopOnboardingEntry));
			}
			ctx.remoteAccess.whenAccess("account/watch", () => ctx.slots.inject("settings.models.sign-in", () => ctx.slots.register({
				name: "settings.models.sign-in",
				locale: "settings.account",
				inject: () => operations
			}, AccountOnboarding)));
			ctx.remoteAccess.whenAccess("account/watch", () => ctx.slots.inject("shell.quota-notice", () => ctx.slots.register({
				name: "shell.quota-notice",
				locale: "settings.account",
				select: (owner) => owner.code === "ACCOUNT_QUOTA" ? owner : null,
				inject: () => ({
					hooks: {
						account: operations.hooks.account,
						platformPage: platformPages
					},
					...nativePlatform === void 0 ? {} : { openPlatformPage: platformPageOpener(refreshAccount) }
				})
			}, AccountQuotaNotice)));
			if (nativePlatform !== void 0) ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "account.platform-page",
				locale: "settings.account",
				inject: () => ({
					platform: nativePlatform,
					hooks: { page: platformPages },
					closePage: platformPages.close
				})
			}, AccountPlatformHost));
			ctx.remoteAccess.whenAccess("account/watch", () => ctx.slots.inject("settings.launcher", () => ctx.slots.register({
				name: "settings.launcher",
				locale: "settings.account",
				inject: () => operations
			}, AccountMenu)));
			ctx.remoteAccess.whenAccess("account/watch", () => ctx.slots.inject("settings.section", () => {
				let unregister;
				const update = () => {
					if (snapshot.view?.status === "credential-stored") unregister ??= ctx.slots.register({
						name: "settings.section",
						id: "account",
						order: -10,
						label: () => t("nav"),
						locale: "settings.account",
						inject: () => operations
					}, AccountSection);
					else {
						unregister?.();
						unregister = void 0;
					}
				};
				listeners.add(update);
				update();
				return () => {
					listeners.delete(update);
					unregister?.();
				};
			}));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map