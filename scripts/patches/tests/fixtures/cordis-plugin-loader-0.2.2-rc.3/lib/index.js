import { createRequire } from "node:module";
import { Context, Inject, Service, composeError } from "@deepseek-ai/cordis";
import { deepEqual, defineProperty, isNonNullable, isNullable, updateVolatile, valueMap, volatileEntries } from "@deepseek-ai/cosmokit";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import url from "node:url";
//#region lib/types/internal.js
/** Helpers for locating the current Node internal module loader. */
var ModuleLoader;
(function(ModuleLoader) {
	let _cachedLoader;
	function requireInternal(id) {
		const require = createRequire(import.meta.url);
		if (process.execArgv.includes("--expose-internals")) try {
			return require(id);
		} catch {}
		try {
			return require("node-addon-require-builtin").requireBuiltin(id);
		} catch {}
	}
	/**
	* Locate and classify the running Node internal module loader.
	*
	* The shape is decided by which module-job API the loader owns, never by the
	* Node version: v2 landed in 24.12.0, so a major-version test mistags every
	* 24.0–24.11.1 loader as v2 and makes consumers call `resolveSync` with
	* reversed parameters. Arity is not usable either — `resolveSync` reports 2
	* under both shapes. A loader owning neither API is left unclassified rather
	* than guessed, so consumers take their documented no-internals path.
	* @returns the classified loader, or `undefined` when none is reachable or its shape is unknown.
	*/
	function fromInternal() {
		if (_cachedLoader) return _cachedLoader;
		const [major] = process.versions.node.split(".").map(Number);
		if (major < 22) return;
		const raw = requireInternal("internal/modules/esm/loader")?.getOrInitializeCascadedLoader();
		if (!raw) return;
		const version = typeof raw.getOrCreateModuleJob === "function" ? "v2" : typeof raw.getModuleJobForImport === "function" ? "v1" : void 0;
		if (!version) return;
		return _cachedLoader = Object.assign(raw, { version });
	}
	ModuleLoader.fromInternal = fromInternal;
})(ModuleLoader || (ModuleLoader = {}));
//#endregion
//#region lib/types/config/group.js
/** Runtime owner for a list of child loader entries. */
var EntryGroup = class {
	ctx;
	tree;
	static key = Symbol.for("cordis.group");
	data = [];
	constructor(ctx, tree) {
		this.ctx = ctx;
		this.tree = tree;
		const entry = ctx.fiber.entry;
		if (entry) entry.subgroup = this;
	}
	get context() {
		return this.ctx;
	}
	async create(options) {
		const id = this.tree.ensureId(options);
		const entry = this.tree.store[id] ??= new Entry(this.ctx.loader);
		entry.parent = this;
		await entry.update(options, true, true);
		return entry.id;
	}
	unlink(options) {
		const config = this.data;
		const index = config.indexOf(options);
		if (index >= 0) config.splice(index, 1);
	}
	remove(id, isDispose = false) {
		const entry = this.tree.store[id];
		if (!entry || entry.parent !== this) return;
		delete this.tree.store[id];
		entry.fiber?.dispose();
		if (!isDispose) this.unlink(entry.options);
		this.context.emit("loader/partial-dispose", entry, entry.options, false);
	}
	async update(config) {
		const oldConfig = this.data;
		this.data = config;
		const oldMap = Object.fromEntries(oldConfig.map((options) => [options.id, options]));
		const newMap = Object.fromEntries(config.map((options) => [options.id ?? Symbol("anonymous"), options]));
		const ids = Reflect.ownKeys({
			...oldMap,
			...newMap
		});
		await Promise.all(ids.map(async (id) => {
			if (newMap[id]) await this.create(newMap[id]).catch((error) => {
				this.ctx.logger.error(error);
			});
			else this.remove(id);
		}));
	}
	stop() {
		for (const options of this.data) this.remove(options.id, true);
	}
};
/** Plugin that mounts a nested loader entry group. */
var Group = class extends EntryGroup {
	ctx;
	config;
	static initial = [];
	static [EntryGroup.key] = true;
	constructor(ctx, config) {
		super(ctx, ctx.fiber.entry.parent.tree);
		this.ctx = ctx;
		this.config = config;
		ctx.on("internal/update", (config) => this.update(config));
	}
	async *[Service.init]() {
		yield () => this.stop();
		await this.update(this.config);
	}
};
//#endregion
//#region lib/types/resolve.js
var __rewriteRelativeImportExtension$1 = function(path, preserveJsx) {
	if (typeof path === "string" && /^\.\.?\//.test(path)) return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function(m, tsx, d, ext, cm) {
		return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : d + ext + "." + cm.toLowerCase() + "js";
	});
	return path;
};
const HELPER_FILES = {
	".gitignore": "# created by cordis automatically\n*\n",
	"resolve.mjs": "export default (specifier) => import.meta.resolve(specifier)\n"
};
const cache = Object.create(null);
/** Nearest ancestor of `dir` that owns a `package.json`, if any. */
function findScope(dir) {
	while (true) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return;
		dir = parent;
	}
}
function resolveScope(baseUrl) {
	if (!baseUrl) return;
	let dir;
	try {
		dir = url.fileURLToPath(new URL(".", baseUrl));
	} catch {
		return;
	}
	return findScope(path.resolve(dir));
}
async function write(filename, content) {
	const temp = `${filename}.${process.pid}`;
	await fsPromises.writeFile(temp, content);
	await fsPromises.rename(temp, filename);
}
async function _createResolve(scope) {
	const dir = path.join(scope, ".cordis");
	try {
		await fsPromises.mkdir(dir, { recursive: true });
		for (const [name, content] of Object.entries(HELPER_FILES)) await write(path.join(dir, name), content);
	} catch {
		return;
	}
	const helperUrl = url.pathToFileURL(path.join(dir, "resolve.mjs")).href;
	return (await import(__rewriteRelativeImportExtension$1(
		/* @vite-ignore */
		helperUrl
	))).default;
}
/**
* Create or reuse a native ESM resolver anchored in the config project's package scope.
* @param baseUrl Config file URL; absent, non-file or unscoped URLs cannot supply a resolver.
* @returns The project resolver, or undefined when no package scope exists or its helper cannot be written.
*/
async function createResolve(baseUrl) {
	const scope = resolveScope(baseUrl);
	if (!scope) return;
	return await (cache[scope] ??= _createResolve(scope));
}
//#endregion
//#region lib/types/config/tree.js
var __rewriteRelativeImportExtension = function(path, preserveJsx) {
	if (typeof path === "string" && /^\.\.?\//.test(path)) return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function(m, tsx, d, ext, cm) {
		return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : d + ext + "." + cm.toLowerCase() + "js";
	});
	return path;
};
/** The entry and the same-tree members of its group, recursively. */
function members(entry) {
	const { tree } = entry.parent;
	const result = [entry];
	const group = entry.subgroup;
	if (group?.tree !== tree) return result;
	for (const options of group.data) {
		const member = tree.store[options.id];
		if (member?.parent === group) result.push(...members(member));
	}
	return result;
}
/** Mutable tree of loader entries. Persistence is supplied by subclasses. */
var EntryTree = class EntryTree {
	static sep = ":";
	ctx;
	enableLogs;
	root;
	store = Object.create(null);
	constructor(ctx) {
		this.ctx = ctx.extend({ baseUrl: ctx.baseUrl });
		this.root = new EntryGroup(this.ctx, this);
		const entry = this.ctx.fiber.entry;
		if (entry) entry.subtree = this;
	}
	get context() {
		return this.ctx;
	}
	/** Iterate entries in this tree and any nested subtrees. */
	*entries() {
		for (const entry of Object.values(this.store)) {
			yield entry;
			if (!entry.subtree) continue;
			yield* entry.subtree.entries();
		}
	}
	/** Return pending import and lifecycle tasks owned by this tree. */
	getTasks() {
		return [...this.entries()].map((entry) => entry._initTask || entry.fiber?.inertia).filter(isNonNullable);
	}
	/** Wait until this tree has no pending import or lifecycle tasks. */
	async await() {
		while (true) {
			const tasks = this.getTasks();
			if (!tasks.length) return;
			await Promise.allSettled(tasks);
		}
	}
	/**
	* Assign a random tree-local id when `options.id` is absent. Explicit ids
	* may contain `EntryTree.sep`; `resolve()` and `resolveGroup()` cannot
	* address such entries by nested path.
	* @param options - Entry options; a generated id is written to `options.id`.
	* @returns The existing or generated id.
	*/
	ensureId(options) {
		if (!options.id) do
			options.id = Math.random().toString(16).slice(2, 10);
		while (this.store[options.id]);
		return options.id;
	}
	/** Resolve an entry by id, including nested ids separated by `EntryTree.sep`. */
	resolve(id) {
		const parts = id.split(EntryTree.sep);
		let tree = this;
		const final = parts.pop();
		for (const part of parts) {
			tree = tree.store[part]?.subtree;
			if (!tree) throw new Error(`cannot resolve entry ${id}`);
		}
		const entry = tree.store[final];
		if (!entry) throw new Error(`cannot resolve entry ${id}`);
		return entry;
	}
	resolveGroup(id) {
		if (!id) return this.root;
		const entry = this.resolve(id);
		if (!entry.subgroup) throw new Error(`entry ${id} is not a group`);
		return entry.subgroup;
	}
	/** Create an entry in the root group or a nested group. */
	async create(options, parent = null, position = Infinity) {
		const group = this.resolveGroup(parent);
		const id = group.tree.ensureId(options);
		group.data.splice(position, 0, options);
		group.tree.commit({
			id,
			group,
			options
		});
		return group.create(options);
	}
	/** Stop and remove an entry from its parent group. */
	remove(id) {
		const entry = this.resolve(id);
		const group = entry.parent;
		const legacy = entry.options;
		group.remove(legacy.id);
		group.tree.commit({
			id: legacy.id,
			group,
			legacy
		});
	}
	/** Update an entry and optionally move it to another group. */
	async update(id, options, parent, position) {
		const entry = this.resolve(id);
		const source = entry.parent;
		const legacy = { ...entry.options };
		if (parent !== void 0) {
			const target = this.resolveGroup(parent);
			const moved = target.tree === source.tree ? [] : members(entry);
			for (const member of moved) {
				const { id } = member.options;
				if (target.tree.store[id]) throw new Error(`entry ${id} already exists in the target tree`);
			}
			source.unlink(entry.options);
			target.data.splice(position ?? Infinity, 0, entry.options);
			entry.parent = target;
			for (const member of moved) {
				delete source.tree.store[member.options.id];
				target.tree.store[member.options.id] = member;
				if (member.subgroup?.tree === source.tree) member.subgroup.tree = target.tree;
			}
		}
		const task = entry.update(options, false, true);
		if (entry.parent.tree !== source.tree) {
			source.tree.commit({
				id: legacy.id,
				group: source,
				legacy
			});
			entry.parent.tree.commit({
				id: legacy.id,
				group: entry.parent,
				options: entry.options
			});
		} else {
			const from = entry.parent === source ? void 0 : source;
			entry.parent.tree.commit({
				id: legacy.id,
				group: entry.parent,
				from,
				options: entry.options,
				legacy
			});
		}
		return task;
	}
	/** Import a plugin module from a specifier or `cordis:` builtin. */
	import(name, getOuterStack) {
		if (name.startsWith("cordis:")) return this.ctx.loader.builtins[name.slice(7)];
		return composeError(async (info) => {
			info.offset += 3;
			if (this.ctx.loader.internal) return await this.ctx.loader.internal.import(name, this.ctx.baseUrl, {});
			else if (name.startsWith(".")) return await import(__rewriteRelativeImportExtension(
				/* @vite-ignore */
				new URL(name, this.ctx.baseUrl).href
			));
			else {
				const resolve = await createResolve(this.ctx.baseUrl);
				return await import(__rewriteRelativeImportExtension(
					/* @vite-ignore */
					resolve ? resolve(name) : name
				));
			}
		}, getOuterStack);
	}
};
//#endregion
//#region lib/types/config/utils.js
/** Evaluate a JavaScript expression against a loader context scope. */
const evaluate = new Function("ctx", "expr", `
  with (ctx) {
    return eval(expr)
  }
`);
/** Recursively replace YAML `!!js` expression nodes with evaluated values. */
function interpolate(ctx, value) {
	if (isJsExpr(value)) return evaluate(ctx, value.__jsExpr);
	else if (!value || typeof value !== "object") return value;
	else if (Array.isArray(value)) return value.map((item) => interpolate(ctx, item));
	else return valueMap(value, (item) => interpolate(ctx, item));
}
/** Return true when a value is a serialized loader JavaScript expression. */
function isJsExpr(value) {
	return value instanceof Object && "__jsExpr" in value;
}
//#endregion
//#region lib/types/config/diff.js
function isSchemastery(schema) {
	return schema?.["~standard"].vendor === "schemastery";
}
function isRecord(value) {
	if (!value || typeof value !== "object" || isJsExpr(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function equal(a, b, schema, ancestors) {
	if (schema?.meta?.volatile) return true;
	if (schema?.type !== "object" || !schema.dict || ancestors.has(schema)) return deepEqual(a, b, true);
	const left = a ?? schema.meta?.default;
	const right = b ?? schema.meta?.default;
	if (!isRecord(left) || !isRecord(right)) return deepEqual(left, right, true);
	const { dict } = schema;
	ancestors.add(schema);
	try {
		return Object.keys({
			...left,
			...right
		}).every((key) => equal(left[key], right[key], Object.hasOwn(dict, key) ? dict[key] : void 0, ancestors));
	} finally {
		ancestors.delete(schema);
	}
}
/**
* Compare two raw configs, treating schema-declared volatile fields at fixed object paths as equal and absent objects as their schema default.
* Schema backedges, expressions, unknown fields and opaque values keep strict raw equality; an absent or non-Schemastery schema compares everything raw.
* @param previous - previous raw config.
* @param next - next raw config.
* @param schema - the plugin's config schema.
* @returns Whether the configs differ at most in volatile fields, without evaluating expressions, validating config or modifying inputs.
* @internal
*/
function equalExceptVolatile(previous, next, schema) {
	return isSchemastery(schema) ? equal(previous, next, schema, /* @__PURE__ */ new Set()) : deepEqual(previous, next, true);
}
//#endregion
//#region lib/types/config/entry.js
function takeEntries(object, keys) {
	const result = [];
	for (const key of keys) {
		if (!(key in object)) continue;
		result.push([key, object[key]]);
		delete object[key];
	}
	return result;
}
function sortKeys(object, prepend = ["id", "name"], append = ["config"]) {
	const part1 = takeEntries(object, prepend);
	const part2 = takeEntries(object, append);
	const rest = takeEntries(object, Object.keys(object)).sort(([a], [b]) => a.localeCompare(b));
	return Object.assign(object, Object.fromEntries([
		...part1,
		...rest,
		...part2
	]));
}
/** One configured plugin node inside an `EntryTree`. */
var Entry = class Entry {
	loader;
	static key = Symbol.for("cordis.entry");
	ctx;
	fiber;
	/** Raw import result before export normalization; HMR updates it after a successful reload. */
	moduleNamespace;
	parent;
	options = {};
	subgroup;
	subtree;
	_initTask;
	constructor(loader) {
		this.loader = loader;
		this.ctx = loader.ctx.extend({ [Entry.key]: this });
		this.context.emit("loader/entry-init", this);
	}
	get context() {
		return this.ctx;
	}
	get id() {
		let id = this.options.id;
		if (this.parent.tree.ctx.fiber.entry) id = this.parent.tree.ctx.fiber.entry.id + EntryTree.sep + id;
		return id;
	}
	/** True when this entry or any owning parent entry is disabled. */
	get disabled() {
		if (this.options.group) return false;
		let entry = this;
		do {
			if (this._resolveDisabled(entry.options)) return true;
			entry = entry.parent.ctx.fiber.entry;
		} while (entry);
		return false;
	}
	/**
	* Effective disabled state: a `!!js` expression evaluates against the loader
	* context. The raw node stays in the options, so write-back keeps the form.
	*/
	_resolveDisabled(options) {
		return isJsExpr(options.disabled) ? Boolean(this.evaluate(options.disabled.__jsExpr)) : Boolean(options.disabled);
	}
	evaluate(expr) {
		return evaluate(this.ctx, expr);
	}
	async _patchContext(diff) {
		await this.context.waterfall("loader/patch-context", this, async () => {
			Object.setPrototypeOf(this.ctx, this.parent.ctx);
			if (this.fiber?.uid && (diff.includes("config") || this.options.group)) {
				const fiber = this.fiber.ctx.fiber;
				for (const name of Object.keys(fiber.inject)) fiber._checkImpl(name);
				await fiber.update(this.options.config, true);
			}
		});
	}
	async refresh() {
		if (this.fiber) return;
		if (this.disabled) return;
		await this.init();
	}
	/** Merge new options, restart as needed, and persist through the parent tree. */
	async update(options, create = false, force = false) {
		const legacy = { ...this.options };
		if (create) this.options = options;
		else for (const [key, value] of Object.entries(options)) if (isNullable(value)) delete this.options[key];
		else this.options[key] = value;
		sortKeys(this.options);
		if (this.disabled) {
			await this.fiber?.dispose();
			return;
		}
		if (this.fiber?.uid) {
			const changes = Object.keys({
				...this.options,
				...legacy
			}).filter((key) => !deepEqual(this.options[key], legacy[key], key === "config"));
			const volatileOnly = changes.length === 1 && changes[0] === "config" && this.fiber.state === 2 && Object.getPrototypeOf(this.ctx) === this.parent.ctx && equalExceptVolatile(legacy.config, this.options.config, this.fiber.runtime?.Config);
			if (volatileOnly) this.fiber.rawConfig = this.options.config;
			const pending = volatileOnly && this._commitVolatile() ? [] : changes;
			if (!pending.length && !force) return;
			this.context.emit("loader/partial-dispose", this, legacy, true);
			await this._patchContext(pending);
		} else await this.init();
	}
	/**
	* Parse a volatile-only raw config change and commit its values into the running fiber's references.
	* An invalid candidate is logged and leaves the running references unchanged; the raw config stays retained for the next activation.
	* @returns `false` when an ordinary effective value changed, so the caller applies the ordinary update lifecycle.
	*/
	_commitVolatile() {
		const fiber = this.fiber.ctx.fiber;
		const refs = volatileEntries(fiber.effectiveConfig);
		if (!refs.length) return true;
		const raw = this.options.config;
		let candidate;
		try {
			candidate = fiber.resolveConfig(raw);
		} catch (error) {
			this.ctx.logger.warn("volatile config update failed for %C", this.options.id);
			this.ctx.logger.warn(error);
			return true;
		}
		if (!deepEqual(fiber.effectiveConfig, candidate, true)) {
			this.ctx.logger.debug("ordinary config values of %C changed with its volatile values; applying the ordinary update", this.options.id);
			return false;
		}
		const paths = refs.flatMap(({ path, ref }) => {
			const source = path.reduce((value, key) => Reflect.get(value, key), candidate);
			if (deepEqual(ref.get(), source.get(), true)) return [];
			updateVolatile(ref, source);
			return [path];
		});
		if (!paths.length) return true;
		const self = Object.create(fiber.ctx);
		self[Context.filter] = (owner) => owner.fiber === fiber;
		try {
			fiber.ctx.emit(self, "loader/volatile-update", paths);
		} catch (error) {
			this.ctx.logger.warn(error);
		}
		return true;
	}
	getOuterStack = () => {
		let entry = this;
		const result = [];
		do {
			result.push(`    at ${entry.parent.tree.ctx.baseUrl}#${entry.options.id}`);
			entry = entry.parent.ctx.fiber.entry;
		} while (entry);
		return result;
	};
	/** Import and start the configured plugin if it is not already running. */
	async init() {
		try {
			await (this._initTask ??= this._init());
		} finally {
			this._initTask = void 0;
		}
		this.fiber?.await().catch(() => {}).finally(() => {
			if (this.loader.getTasks().length) return;
			this.ctx.reflect.notify(["loader"]);
		});
	}
	async _init() {
		let moduleNamespace;
		try {
			moduleNamespace = await this.parent.tree.import(this.options.name, this.getOuterStack);
		} catch (error) {
			this.ctx.logger.error(error);
			return;
		}
		const plugin = this.loader.unwrapExports(moduleNamespace);
		await this._patchContext([]);
		this.loader.showLog(this, "apply");
		this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack);
		this.moduleNamespace = moduleNamespace;
	}
};
//#endregion
//#region lib/types/config/isolate.js
function swap(target, source) {
	for (const key of Reflect.ownKeys(target)) Reflect.deleteProperty(target, key);
	for (const key of Reflect.ownKeys(source || {})) Reflect.defineProperty(target, key, Reflect.getOwnPropertyDescriptor(source, key));
}
/** Symbol realm used to isolate service implementations by entry or label. */
var Realm = class {
	store = Object.create(null);
	access(key, create = false) {
		if (create) return this.store[key] ??= Symbol(`${key}${this.suffix}`);
		else return this.store[key] ?? Symbol(`${key}${this.suffix}`);
	}
	delete(key) {
		delete this.store[key];
	}
	get size() {
		return Object.keys(this.store).length;
	}
};
/** Entry-local isolation realm. */
var LocalRealm = class extends Realm {
	entry;
	constructor(entry) {
		super();
		this.entry = entry;
	}
	get suffix() {
		return "#" + this.entry.options.id;
	}
};
/** Named isolation realm shared by entries that use the same label. */
var GlobalRealm = class extends Realm {
	label;
	constructor(label) {
		super();
		this.label = label;
	}
	get suffix() {
		return "@" + this.label;
	}
};
/** Install loader hooks that apply `intercept` and `isolate` entry options. */
function isolate(ctx) {
	const realms = Object.create(null);
	const delims = Object.create(null);
	function access(entry, name, create = false) {
		let realm;
		const label = entry.options.isolate?.[name];
		if (!label) return;
		if (label === true) realm = entry.realm ??= new LocalRealm(entry);
		else if (create) realm = realms[label] ??= new GlobalRealm(label);
		else realm = realms[label];
		return realm?.access(name, create);
	}
	ctx.on("loader/entry-init", (entry) => {
		entry.ctx[Context.intercept] = Object.create(entry.ctx[Context.intercept]);
		entry.ctx[Context.isolate] = Object.create(entry.ctx[Context.isolate]);
	});
	ctx.on("loader/patch-context", async (entry, next) => {
		const newMap = Object.create(entry.parent.ctx[Context.isolate]);
		for (const name of Object.keys(entry.options.isolate ?? {})) newMap[name] = access(entry, name, true);
		const diff = Object.create(null);
		const oldMap = entry.ctx[Context.isolate];
		for (const name in {
			...newMap,
			...delims
		}) {
			if (newMap[name] === oldMap[name]) continue;
			const delim = delims[name] ??= Symbol(`delim:${name}`);
			entry.ctx[delim] = Symbol(`${name}#${entry.id}`);
			for (const symbol of [oldMap[name], newMap[name]]) {
				const impl = symbol && entry.ctx.reflect.store[symbol];
				if (!impl) continue;
				const fiber = impl.ctx.fiber;
				if (!fiber) {
					entry.ctx.logger.warn(/* @__PURE__ */ new Error(`expected service ${name} to be implemented`));
					continue;
				}
				diff[name] = [
					oldMap[name],
					newMap[name],
					entry.ctx[delim],
					fiber.ctx[delim]
				];
				if (entry.ctx[delim] !== fiber.ctx[delim]) break;
			}
		}
		Object.setPrototypeOf(entry.ctx[Context.isolate], entry.parent.ctx[Context.isolate]);
		Object.setPrototypeOf(entry.ctx[Context.intercept], entry.parent.ctx[Context.intercept]);
		swap(entry.ctx[Context.isolate], newMap);
		swap(entry.ctx[Context.intercept], entry.options.intercept);
		await next();
		for (const [symbol1, symbol2, flag1, flag2] of Object.values(diff)) {
			const impl = entry.ctx.reflect.store[symbol1];
			if (flag1 === flag2 && impl && !entry.ctx.reflect.store[symbol2]) {
				entry.ctx.reflect.store[symbol2] = impl;
				delete entry.ctx.reflect.store[symbol1];
				impl.isolate = symbol2;
			}
		}
		ctx.reflect.notify(Object.keys(diff), (ctx, name) => {
			const [symbol1, symbol2, flag1, flag2] = diff[name];
			const symbol3 = ctx[Context.isolate][name];
			const flag3 = ctx[delims[name]];
			return (symbol1 === symbol3 || symbol2 === symbol3) && flag1 === flag3 !== (flag1 === flag2);
		});
		for (const name in delims) if (!Reflect.ownKeys(newMap).includes(name)) delete entry.ctx[delims[name]];
	});
	ctx.on("loader/partial-dispose", (entry, legacy, active) => {
		for (const [name, label] of Object.entries(legacy.isolate ?? {})) {
			if (label === true) continue;
			if (active && entry.options.isolate?.[name] === label) continue;
			const realm = realms[label];
			if (!realm) continue;
			for (const entry of ctx.loader.entries()) if (entry.options.isolate?.[name] === realm.label) return;
			realm.delete(name);
			if (!realm.size) delete realms[realm.label];
		}
	});
}
//#endregion
//#region lib/types/index.js
/**
* Service that owns a loader entry tree and imports configured plugins.
*
* Subclasses provide persistence by implementing `commit(change)` on `EntryTree`.
*/
var Loader = class extends EntryTree {
	config;
	envData = process.env.CORDIS_SHARED ? JSON.parse(process.env.CORDIS_SHARED) : { startTime: Date.now() };
	name = "loader";
	internal = ModuleLoader.fromInternal();
	builtins = Object.create(null);
	constructor(ctx, config = {}) {
		super(ctx);
		this.config = config;
		if (config.baseUrl) this.ctx.baseUrl = config.baseUrl;
		const self = this;
		defineProperty(this, Service.tracker, {
			associate: "loader",
			property: "ctx",
			noShadow: true
		});
		ctx.reflect.provide("loader", this, this[Service.check]);
		ctx.on("internal/config", (fiber, next) => {
			const config = next();
			if (!fiber.entry || fiber.parent.fiber?.entry === fiber.entry) return config;
			if (fiber.runtime?.callback[EntryGroup.key]) return config;
			return interpolate(fiber.ctx, config);
		});
		ctx.on("internal/commit", (fiber, config) => {
			if (!fiber.entry || fiber.parent.fiber?.entry === fiber.entry) return;
			const schema = fiber.runtime?.Config;
			const unparse = schema?.["simplify"];
			const { entry } = fiber;
			const legacy = { ...entry.options };
			entry.options.config = unparse ? unparse.call(schema, config) : config;
			entry.parent.tree.commit({
				id: entry.options.id,
				group: entry.parent,
				options: entry.options,
				legacy
			});
		});
		ctx.on("internal/update", function(config, next) {
			if (!this.entry || this.parent.fiber?.entry === this.entry) return next();
			self.showLog(this.entry, "reload");
			return next();
		}, { global: true });
		ctx.on("internal/plugin", (fiber) => {
			if (fiber.parent[Entry.key] && !fiber.entry) {
				fiber.entry = fiber.parent[Entry.key];
				Inject.resolve(fiber.entry.options.inject, fiber.inject);
			}
			if (fiber.uid) return;
			if (!fiber.entry) return;
			if (fiber.parent.fiber?.entry === fiber.entry) return;
			if (!ctx.registry.has(fiber.runtime.callback)) return;
			if (!fiber.entry.parent.tree.ctx.fiber.uid) return;
			const { entry } = fiber;
			this.showLog(entry, "unload");
			if (fiber.parent.fiber.state === 5) return;
			if (entry.parent.tree.store[entry.options.id] !== entry) return;
			if (entry.disabled) return;
			const legacy = { ...entry.options };
			entry.options.disabled = true;
			entry.parent.tree.commit({
				id: entry.options.id,
				group: entry.parent,
				options: entry.options,
				legacy
			});
		});
		ctx.plugin(isolate);
	}
	commit(_change) {}
	[Service.check]() {
		if (Service.prototype[Service.resolveConfig].call(this).await && this.getTasks().length) return false;
		return true;
	}
	showLog(entry, type) {
		if (entry.options.group || !entry.parent.tree.enableLogs) return;
		this.ctx.root.logger?.("loader").info("%s plugin %C", type, entry.options.name);
	}
	/** Return the loader entry id that owns `fiber`, if any. */
	locate(fiber = this.ctx.fiber) {
		while (1) {
			if (fiber.entry) return fiber.entry.id;
			const next = fiber.parent.fiber;
			if (fiber === next) return;
			fiber = next;
		}
	}
	/** Hook for hosts that can restart the process on full-reload requests. */
	exit() {}
	/** Normalize ESM/CJS/default export shapes before applying a plugin. */
	unwrapExports(exports) {
		if (isNullable(exports)) return exports;
		exports = exports.default ?? exports;
		if (!exports.__esModule) return exports;
		return exports.default ?? exports;
	}
};
//#endregion
export { Entry, EntryGroup, EntryTree, GlobalRealm, Group, Loader, Loader as default, LocalRealm, ModuleLoader, Realm, evaluate, interpolate, isJsExpr };
