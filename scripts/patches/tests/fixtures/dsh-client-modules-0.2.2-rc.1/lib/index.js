import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Service } from "@deepseek-ai/cordis";
//#region lib/types/assets.js
/** Route segment between a package name and its asset path. */
const PACKAGE_ASSET_SEGMENT = "assets";
/** Media type served for each supported asset extension, keyed by the lowercase extension with its dot. */
const PACKAGE_ASSET_MEDIA_TYPES = new Map([
	[".svg", "image/svg+xml"],
	[".png", "image/png"],
	[".webp", "image/webp"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"]
]);
/**
* Look up the media type of an asset path.
* @param assetPath - file path or URL path; only its final extension is read, case-insensitively.
* @returns the served media type, or undefined when the extension is unsupported.
*/
function packageAssetMediaType(assetPath) {
	const name = assetPath.slice(Math.max(assetPath.lastIndexOf("/"), assetPath.lastIndexOf("\\")) + 1);
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? void 0 : PACKAGE_ASSET_MEDIA_TYPES.get(name.slice(dot).toLowerCase());
}
//#endregion
//#region lib/types/client/manifest.js
/**
* Client module system: the browser peer of Node's internal ESM loader, built
* as a lazy CJS table. The vendored cordis Loader consumes this object
* through its `internal` contract (the only call site is `EntryTree.import` →
* `internal.import`), which keeps entry governance (fiber lifecycle, inject
* waiting, update/refresh) entirely on the vendored side while this package
* owns code arrival.
*
* Lazy CJS model: executing a plugin bundle only REGISTERS its
* factory (`window.__ModuleLoader__.load({id, factory})`); every module body
* side effect — including CSS injection — lives inside the factory closure
* and runs at materialization, not at script execution. Materialization
* (factory(require) → exports) happens on first import/require and is
* memoized in {@link ClientModuleLoader.loadCache}; a factory that requires
* another registered-but-unmaterialized module materializes it recursively,
* so load order needs no external sequencing.
*
* Resolution branch order (import): seed word → shell instance; memoized
* record → exports; graph row → register its dependency factories and own
* factory; registered factory → materialize; anything else → throw (loud —
* the runtime mirror of the build-time bundle purity gate).
* The synchronous `require` handed to factories walks the same order minus
* the load branch. Loading is async, so a requested dynamic package must have
* registered its factory before a consumer materializes.
*
* This file is the browser-safe contract face (zero node imports): the
* `__DSH_BOOT__` wire types, the boot-manifest parser, and the boundaries around
* {@link ClientModuleSystem}. The package root is the host-side service that
* composes the wire.
*/
/**
* Validate an optional string-array field read from a `dsh.client` declaration
* or from the boot wire.
* @param subject - diagnostic prefix naming the package or the wire row.
* @param field - field name as it appears in the diagnostic.
* @param value - the raw field value.
* @returns the validated array, or undefined when the field is absent.
* @throws {Error} when the value is present but is not an array of strings.
*/
function optionalStringArray(subject, field, value) {
	if (value === void 0) return void 0;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`client-modules: ${subject} ${field} must be a string array`);
	return value;
}
/**
* Narrow an unknown parsed JSON value to the `dsh.client` declaration. Shared
* by the node half's Loader scan and the roster generator, so both read a
* package's browser declaration through one validator.
* @param pkgName - package name used as the diagnostic prefix.
* @param value - the raw `dsh.client` field of the package manifest.
* @returns the validated declaration, or undefined when the field is absent.
* @throws {Error} when the field is present but any member is malformed.
*/
function parseDshClient(pkgName, value) {
	if (value === void 0) return void 0;
	if (typeof value !== "object" || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
	const decl = value;
	if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
	const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
	const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
	if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
	return {
		platform: decl.platform,
		...inject !== void 0 ? { inject } : {},
		...external !== void 0 ? { external } : {},
		...decl.immediately !== void 0 ? { immediately: decl.immediately } : {}
	};
}
/**
* The bare package-root specifier `specifier` names, or undefined for a subpath, a path, or any scheme-qualified
* specifier (`cordis:` builtins, `node:` modules, URLs).
* @param specifier - Loader row name.
* @returns the package name, or undefined.
*/
function exactPackageSpecifier(specifier) {
	if (specifier.startsWith("@")) {
		const parts = specifier.split("/");
		return parts.length === 2 && parts.every(Boolean) ? specifier : void 0;
	}
	return specifier.length > 0 && !specifier.includes("/") && !specifier.includes(":") ? specifier : void 0;
}
/**
* Normalize a module specifier onto the graph row that owns it: a plugin bundle
* IS its package's client half, so `<id>/client` (the exports subpath external
* bundles emit) and the bare package name resolve to the same exports. Both the
* require path and graph composition normalize here, which is what lets each
* importing package request the subpath its own code imports.
* @param spec - module specifier as a bundle requires it or a declaration spells it.
* @returns the specifier with a trailing `/client` removed.
*/
function stripClientSuffix(spec) {
	return spec.endsWith("/client") ? spec.slice(0, -7) : spec;
}
//#endregion
//#region lib/types/index.js
/**
* Node half of the client module system (`dsh.client` dual-face package): scans
* the host Loader's entries for packages declaring `dsh.client`, composes the
* `window.__DSH_BOOT__` entry graph (wire single source: {@link WebBootEntry}
* in `./client/manifest.ts`) in module-graph order, serves one-or-more-plugin
* combo scripts plus their source maps, package-local chunks, and the
* content-revisioned `./assets/*` exports of active client packages,
* contributes the registration facade, application preloads, bootstrap scripts,
* and graph to the webserver's index injection table, and provides the
* `clientModules` service (the HMR node half's registration/notification
* face).
*
* Package reconciliation is incremental by Loader entry name.
* Every cordis `internal/plugin` emission (fiber construction/disposal) marks
* the fiber's entry name dirty; a microtask flush reconciles each dirty name
* against the Loader entries indexed at the start of that flush. Synchronous
* package resolution must not add or remove Loader entries during reconciliation.
* The activation pass seeds the same pending names and flushes synchronously,
* so initial activation and steady state share one implementation. Each
* reconciliation reads the package manifest and the bundle metadata again,
* so an entry that restarts after its package was reinstalled or moved
* publishes them as they are now; an unchanged result publishes nothing and
* does not read the bundle. The manifest package name identifies the browser
* module; distinct active Loader sources for that package are a composition
* error. Bundle rebuilds outside
* an entry restart reach the graph through {@link ClientModuleRegistry.rebuilt}.
* @module @deepseek-ai/dsh-client-modules
*/
/** Recovery instruction shared by grouped startup and steady-state bundle diagnostics. */
const CLIENT_BUNDLE_BUILD_INSTRUCTION = "run `pnpm run build` before launch";
/** Missing built client export, retained as structured data for activation-error grouping. */
var MissingClientBundleError = class extends Error {
	packageName;
	clientPath;
	constructor(packageName, clientPath, cause) {
		super([
			`client-modules: client bundle not found; ${CLIENT_BUNDLE_BUILD_INSTRUCTION}:`,
			`  package: ${packageName}`,
			`  path: ${clientPath}`
		].join("\n"), { cause });
		this.packageName = packageName;
		this.clientPath = clientPath;
	}
};
/** Activation failures grouped by actionable package-build errors and unrelated failures. */
var ClientPackageCompositionError = class extends AggregateError {
	constructor(failures) {
		const missingBundles = failures.filter((error) => error instanceof MissingClientBundleError);
		const otherFailures = failures.filter((error) => !(error instanceof MissingClientBundleError));
		const packageNoun = failures.length === 1 ? "package" : "packages";
		const lines = [`client-modules: ${String(failures.length)} client ${packageNoun} failed to compose:`];
		if (missingBundles.length > 0) {
			lines.push(`  client bundles not found; ${CLIENT_BUNDLE_BUILD_INSTRUCTION}:`);
			for (const error of missingBundles) lines.push(`    - package: ${error.packageName}`, `      path: ${error.clientPath}`);
		}
		if (otherFailures.length > 0) lines.push("  other failures:", ...otherFailures.map((error) => `    - ${error.message}`));
		super(failures, lines.join("\n"));
	}
};
/** Versioned code is immutable; mismatched revisions are rejected instead of serving newer bytes. */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
/** Generated request URLs stay below conservative browser and intermediary request-target limits. */
const MAX_COMBO_URL_BYTES = 3 * 1024;
const HASH_REVISION_LENGTH = 12;
const COMBO_REVISION_PLACEHOLDER = "0".repeat(HASH_REVISION_LENGTH);
/** Source-map trailer emitted by tsdown at the end of every client bundle. */
const SOURCE_MAP_TRAILER = /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/;
/** Debugger source name appended to page bundles in the WebWorker image. */
const SOURCE_URL_TRAILER = /(?:\r?\n)?\/\/# sourceURL=([^\r\n]+)(?:\r?\n)?$/;
/** Published package-local client chunk names accepted by the on-demand route. */
const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;
/** Resolve `exports["./client"]` to a relative path, accepting the string and one-level conditional forms. */
function clientExportOf(pkgName, exportsField) {
	if (typeof exportsField !== "object" || exportsField === null) return void 0;
	const client = exportsField["./client"];
	if (client === void 0) return void 0;
	if (typeof client === "string") return client;
	if (typeof client === "object" && client !== null) {
		const fallback = client.default;
		if (typeof fallback === "string") return fallback;
	}
	throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`);
}
/** sha1 metadata hash shortened to 12 hex chars. */
function shortHash(input) {
	return createHash("sha1").update(input).digest("hex").slice(0, HASH_REVISION_LENGTH);
}
/** Hash several response fields without allowing bytes to move across field boundaries. */
function framedHash(domain, parts) {
	const hash = createHash("sha1").update(domain).update("\0");
	for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part);
	return hash.digest("hex").slice(0, HASH_REVISION_LENGTH);
}
/** Identify an entry's build from filesystem metadata without hashing its contents. */
function artifactRevision(baseline) {
	return framedHash("plugin-artifact", [
		String(baseline.mtimeMs),
		String(baseline.ctimeMs),
		String(baseline.size)
	]);
}
/** Absolute route prefix serving every plugin resource. */
const PLUGIN_ROUTE = "/plugins";
/**
* `/plugins/<package>/assets/<path>`. A scoped package name spans two segments
* (`@scope/name`); an unscoped name never starts with `@`, so `@scope/assets/…`
* stays a chunk request of the package `@scope/assets`.
*/
const PACKAGE_ASSET_PATH = /^\/plugins\/(@[^/]+\/[^/]+|[^@/][^/]*)\/assets\/(.*)$/;
/** Expose a Node read stream as a shell-carrier Response body; cancelling the body closes the stream. */
function transforStreamBody(stream) {
	const chunks = stream[Symbol.asyncIterator]();
	return new ReadableStream({
		async pull(controller) {
			const next = await chunks.next();
			if (next.done === true) controller.close();
			else controller.enqueue(next.value);
		},
		async cancel() {
			await chunks.return?.();
		}
	});
}
/**
* Expose a held bundle buffer as a Response body without copying it: the
* single chunk is the buffer itself, which readers must not modify.
*/
function heldBody(buffer) {
	return new ReadableStream({ start(controller) {
		controller.enqueue(buffer);
		controller.close();
	} });
}
/** Combo query addressing one ordered plugin-file list. */
function comboSearch(ids, rev, sourceMap = false) {
	return `??${ids.map((id) => `${id}/client.js${sourceMap ? ".map" : ""}`).join(",")}&rev=${rev}`;
}
/** Absolute route URL for one combo resource. */
function comboUrl(ids, rev, sourceMap = false) {
	return `${PLUGIN_ROUTE}/${comboSearch(ids, rev, sourceMap)}`;
}
/**
* Browser reference to one combo resource: app-owned browser routes are
* document-relative, so the route key's leading slash is stripped here, at the
* boundary between the two halves. The rule and its reasons are owned by
* .agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md.
*/
function comboReference(ids, rev, sourceMap = false) {
	return comboUrl(ids, rev, sourceMap).slice(1);
}
/** Absolute route URL for one package-local chunk. */
function chunkUrl(id, fileName, rev, sourceMap = false) {
	return `${PLUGIN_ROUTE}/${id}/${fileName}${sourceMap ? ".map" : ""}?rev=${rev}`;
}
/**
* Source-map reference stamped into one chunk script. A script's map reference
* resolves against that script's own directory rather than the document, so
* this is the bare map file name, not the document-relative route.
*/
function chunkMapReference(fileName, rev) {
	return `${fileName}.map?rev=${rev}`;
}
/** Measure the longest browser-facing combo URL used to partition a startup resource list. */
function projectedComboUrlBytes(records) {
	return Buffer.byteLength(comboReference(records.map((record) => record.entry.id), COMBO_REVISION_PLACEHOLDER, true));
}
/** Partition one phase in graph order without allowing a generated URL above the protocol limit. */
function partitionComboRecords(records) {
	const chunks = [];
	let current = [];
	for (const record of records) {
		const candidate = [...current, record];
		if (projectedComboUrlBytes(candidate) <= MAX_COMBO_URL_BYTES) {
			current = candidate;
			continue;
		}
		if (current.length === 0) throw new Error(`client-modules: ${record.entry.id} exceeds the ${String(MAX_COMBO_URL_BYTES)}-byte combo URL limit`);
		chunks.push(current);
		current = [record];
		if (projectedComboUrlBytes(current) > MAX_COMBO_URL_BYTES) throw new Error(`client-modules: ${record.entry.id} exceeds the ${String(MAX_COMBO_URL_BYTES)}-byte combo URL limit`);
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}
/** Remove bundle-local debug directives and retain their stable generated-file name. */
function prepareSource(resource) {
	let source = resource.bundle.toString("utf8");
	const sourceUrl = SOURCE_URL_TRAILER.exec(source)?.[1];
	source = source.replace(SOURCE_URL_TRAILER, "").replace(SOURCE_MAP_TRAILER, "");
	if (!source.endsWith("\n")) source += "\n";
	const fallbackSource = sourceUrl === void 0 ? `/plugins/${resource.id}/${resource.fileName}` : /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/)/.test(sourceUrl) ? sourceUrl : `/${sourceUrl}`;
	return {
		source,
		fallbackSource
	};
}
/** Stamp a combo script's source-map reference onto its executable bytes. */
function comboScript(input, sourceMapUrl) {
	return Buffer.from(sourceMapUrl === void 0 ? input : `${input}//# sourceMappingURL=${sourceMapUrl}\n`);
}
/** Read and parse an optional source map when its combo-map endpoint is requested. */
function readSourceMap(clientPath) {
	let body;
	try {
		body = readFileSync(`${clientPath}.map`);
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw error;
	}
	const value = JSON.parse(body.toString("utf8"));
	const parsed = typeof value === "object" && value !== null ? value : void 0;
	if (parsed === void 0 || parsed.version !== 3 || !Array.isArray(parsed.sources) || parsed.sources.some((source) => typeof source !== "string") || !Array.isArray(parsed.names) || parsed.names.some((name) => typeof name !== "string") || typeof parsed.mappings !== "string") throw new Error(`client-modules: ${clientPath}.map is not a regular Source Map v3 object`);
	return parsed;
}
/** Count generated lines while assembling indexed-map section offsets. */
function newlineCount(value) {
	let count = 0;
	for (const char of value) if (char === "\n") count += 1;
	return count;
}
/** Resolve section sources against their original per-plugin map URL before combo relocation. */
function comboSectionMap(resource, original) {
	const sourcePaths = original.sources;
	const sourceRoot = typeof original.sourceRoot === "string" ? original.sourceRoot : "";
	const base = new URL(`/plugins/${resource.id}/client.js.map`, "http://dsh.invalid");
	const relocated = sourcePaths.map((source) => {
		const separator = sourceRoot !== "" && !sourceRoot.endsWith("/") && !source.startsWith("/") ? "/" : "";
		const resolved = new URL(`${sourceRoot}${separator}${source}`, base);
		return resolved.origin === base.origin ? `${resolved.pathname}${resolved.search}${resolved.hash}` : resolved.href;
	});
	const section = {
		...original,
		sources: relocated
	};
	delete section.sourceRoot;
	return section;
}
/** Map each generated line to the same line in a bundled JavaScript source. */
function identitySectionMap(source, sourceUrl) {
	const mappings = Array.from({ length: newlineCount(source) }, (_, index) => index === 0 ? "AAAA" : "AACA").join(";");
	return {
		version: 3,
		names: [],
		sources: [sourceUrl],
		sourcesContent: [source],
		mappings
	};
}
/**
* Run one producer in the first requester's microtask, not off-thread, and share its settlement. A rejected run is
* dropped once it settles, so the next request produces again.
*/
function lazyBody(produce) {
	let result;
	return () => {
		result ??= Promise.resolve().then(produce).catch((error) => {
			result = void 0;
			throw error;
		});
		return result;
	};
}
/** Derive one combo revision from the ordered immutable row revisions. */
function comboRevision(resources) {
	return framedHash("combo", resources.flatMap((resource) => [resource.id, resource.rev]));
}
/** Concatenate one or more factory registrations without reading or composing source maps. */
function buildComboScript(resources, sourceMapUrl) {
	let source = "";
	for (const resource of resources) source += `${prepareSource(resource).source};\n`;
	return comboScript(source, sourceMapUrl);
}
/** Compose one indexed map from source-map files read only for this request. */
function buildComboSourceMap(resources, sourceMapOf, fileName = "client.js") {
	const sections = [];
	let line = 0;
	for (const resource of resources) {
		const prepared = prepareSource(resource);
		const sourceMap = sourceMapOf(resource.clientPath);
		let section = identitySectionMap(prepared.source, prepared.fallbackSource);
		if (sourceMap !== void 0) try {
			section = comboSectionMap(resource, sourceMap);
		} catch {}
		sections.push({
			offset: {
				line,
				column: 0
			},
			map: section
		});
		line += newlineCount(`${prepared.source};\n`);
	}
	return Buffer.from(`${JSON.stringify({
		version: 3,
		file: fileName,
		sections
	})}\n`);
}
/** Describe one combo and defer its executable and debug payloads independently. */
function buildCombo(records, sourceMapOf, revision) {
	const resources = records.map((record) => ({
		id: record.entry.id,
		rev: record.entry.rev,
		clientPath: record.meta.clientPath,
		fileName: "client.js",
		bundle: record.bundle
	}));
	const rev = revision ?? comboRevision(resources);
	const entries = resources.map((resource) => resource.id);
	return {
		url: comboUrl(entries, rev),
		rev,
		entries,
		sourceMapUrl: comboUrl(entries, rev, true),
		scriptBody: lazyBody(() => buildComboScript(resources, comboSearch(entries, rev, true))),
		sourceMapBody: lazyBody(() => buildComboSourceMap(resources, sourceMapOf))
	};
}
/** Add initial-load scheduling metadata to a combo artifact. */
function buildBatch(phase, records, sourceMapOf) {
	const artifact = buildCombo(records, sourceMapOf);
	return {
		...artifact,
		descriptor: {
			phase,
			url: artifact.url.slice(1),
			rev: artifact.rev,
			entries: artifact.entries
		}
	};
}
/** Graph row for one bundle rev (the reference carries the rev as its cache-busting query). */
function graphRow(id, rev, fields) {
	return {
		id,
		url: comboReference([id], rev),
		rev,
		...fields.inject !== void 0 ? { inject: fields.inject } : {},
		...fields.immediately ? { immediately: true } : {},
		...fields.external.length > 0 ? { external: fields.external } : {}
	};
}
/**
* Order composed rows so every requested dynamic package precedes its
* consumers. An `external` specifier is either the package row it names
* (`<pkg>/client` aliases the bare package) or a static-table name that adds no
* graph edge.
* @param entries - composed rows in scan order.
* @returns the same rows reordered; scan order breaks every tie.
* @throws {Error} when a row requests itself or when the module graph has a
* cycle; the message lists the packages on it.
*/
function orderByModuleGraph(entries) {
	const rowsById = /* @__PURE__ */ new Map();
	for (const entry of entries) rowsById.set(entry.id, entry);
	const ordered = [];
	const placed = /* @__PURE__ */ new Set();
	const open = [];
	const visit = (entry) => {
		if (placed.has(entry.id)) return;
		const cycleStart = open.indexOf(entry.id);
		if (cycleStart !== -1) throw new Error(`client-modules: module graph cycle ${[...open.slice(cycleStart), entry.id].join(" -> ")} — a requested package row must precede its consumers, and factory-form CJS cannot deliver partial exports`);
		open.push(entry.id);
		for (const name of entry.external ?? []) {
			const dependency = rowsById.get(name) ?? rowsById.get(stripClientSuffix(name));
			if (dependency === entry) throw new Error(`client-modules: "${entry.id}" requests module "${name}" that it answers itself — a row must not declare its own package in dsh.client.external`);
			if (dependency !== void 0) visit(dependency);
		}
		open.pop();
		placed.add(entry.id);
		ordered.push(entry);
	};
	for (const entry of entries) visit(entry);
	return ordered;
}
/** Bootstrap package whose ordinary client bundle supplies the module-system implementation. */
const CLIENT_MODULES_ID = "@deepseek-ai/dsh-client-modules";
/** Dynamic bundles grouped into the parser bootstrap batch before the Vite shell. */
const PARSER_PRELOAD_IDS = [CLIENT_MODULES_ID];
/**
* The boot protocol as index injection rows. The inline registration queue
* precedes the application-batch preload and the blocking bootstrap batch. Its
* `create()` method materializes the modules
* bundle, delegates construction to that bundle, and leaves the same facade
* in live-registration mode. The graph global follows before the shell reads
* it.
* @param graph - the composed entry graph.
* @returns head rows in execution order: queue script, application preloads,
* blocking bootstrap scripts, graph global.
*/
function bootInjections(graph) {
	const queue = `(()=>{
const pendingQueue=[]
window.__ModuleLoader__={
  mode:"queue",
  pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){
    if(this.mode!=="queue")throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot")
    const index=pendingQueue.findIndex(registration=>registration.id===${JSON.stringify(CLIENT_MODULES_ID)})
    const registration=pendingQueue[index]
    if(registration===undefined)throw new Error("client-modules: HTML did not preload ${CLIENT_MODULES_ID}/client.js")
    pendingQueue.splice(index,1)
    const exports=registration.factory(specifier=>{
      throw new Error('client-modules: ${CLIENT_MODULES_ID}/client.js requested external "'+specifier+'" before the module system existed')
    })
    if(typeof exports!=="object"||exports===null||typeof exports.createClientModuleSystem!=="function"||typeof exports.apply!=="function"){
      throw new Error("client-modules: ${CLIENT_MODULES_ID}/client.js did not export the bootstrap module face")
    }
    return exports.createClientModuleSystem(this,{id:registration.id,exports},options)
  }
}
})()`;
	const bootstrap = graph.batches.filter((batch) => batch.phase === "bootstrap");
	const application = graph.batches.filter((batch) => batch.phase === "application");
	const rows = [{
		kind: "script",
		placement: "head",
		text: queue
	}];
	for (const batch of application) rows.push({
		kind: "script-preload",
		src: batch.url
	});
	for (const batch of bootstrap) rows.push({
		kind: "script-src",
		placement: "head",
		src: batch.url
	});
	rows.push({
		kind: "global",
		name: "__DSH_BOOT__",
		value: graph
	});
	return rows;
}
/**
* The web plugin table service: incremental `dsh.client` scan + wire composition
* + bundle and package-asset route + index injection rows. Construction runs
* the activation scan synchronously — a malformed declaration or missing bundle among the
* already-loaded entries aggregates into one loud throw (FAILED fiber; the
* boot activation audit reports it).
*/
var ClientModuleRegistry = class extends Service {
	static inject = ["loader"];
	/**
	* Host release identity published in every graph: this package's version, which releases share
	* with the CLI, and the source commit the client build fixes into the built Host artifact.
	*/
	release;
	table = /* @__PURE__ */ new Map();
	sources = /* @__PURE__ */ new Map();
	rebuildListeners = /* @__PURE__ */ new Set();
	graphListeners = /* @__PURE__ */ new Set();
	dirty = /* @__PURE__ */ new Set();
	responses = /* @__PURE__ */ new Map();
	batchResponses = /* @__PURE__ */ new Map();
	/** One prior graph generation covers a request racing the HMR recomposition that replaced its URL. */
	previousBatchResponses = /* @__PURE__ */ new Map();
	flushQueued = false;
	composed;
	/**
	* Build the service: subscribe, seed, and run the activation flush.
	* Bundle routes follow the optional Web carrier's injected lifecycle.
	* @param ctx - plugin context carrying Loader and an optional Web carrier.
	*/
	constructor(ctx) {
		super(ctx, "clientModules");
		const { version } = createRequire(import.meta.url)("../package.json");
		const commit = "c59d10a";
		this.release = {
			version,
			commit
		};
		ctx.on("internal/plugin", (fiber) => {
			const entryName = fiber.entry?.options.name;
			if (entryName === void 0) return;
			this.dirty.add(entryName);
			if (this.flushQueued) return;
			this.flushQueued = true;
			queueMicrotask(() => {
				this.flushQueued = false;
				this.flush((err) => {
					ctx.logger.warn(err);
				});
			});
		});
		for (const entry of ctx.loader.entries()) this.dirty.add(entry.options.name);
		this.composed = this.compose();
		const failures = [];
		this.flush((err) => failures.push(err));
		if (failures.length > 0) throw new ClientPackageCompositionError(failures);
		const registerWebCarrier = (webCtx) => {
			webCtx.effect(() => webCtx.webServer.register({
				kind: "prefix",
				path: PLUGIN_ROUTE,
				resource: (request) => this.fetchBundle(request)
			}), "client-modules: bundle route");
		};
		ctx.inject(["webServer"], registerWebCarrier);
		ctx.on("webserver/index-inject", (table) => {
			table.push(...bootInjections(this.composed));
		});
	}
	/**
	* Current composed entry graph (stable object between changes).
	* @returns the graph served as `window.__DSH_BOOT__`.
	*/
	graph() {
		return this.composed;
	}
	/**
	* Absolute path of an entry's client bundle.
	* @param id - entry id (package name).
	* @returns the path, or undefined for an unknown id.
	*/
	clientPath(id) {
		return this.table.get(id)?.meta.clientPath;
	}
	/**
	* Serve an advertised revisioned bundle, source map, chunk, or package asset
	* without a Web server. Unknown URLs return 404, unsupported methods return
	* 405, and `HEAD` returns the same immutable headers without materializing a
	* body. Each bundle body is built once on its first `GET`; script
	* construction never reads maps. A package asset is read on every request
	* and answers 304 without a body when `If-None-Match` equals its entity tag;
	* its body holds the file open until the caller consumes or cancels it. A
	* bundle, map, or chunk body is the held buffer itself, not a copy, so a
	* caller must not modify its bytes.
	* @param request - shell-carrier request for a `/plugins` resource.
	* @returns the exact response also exposed by the optional Web route.
	*/
	async fetchBundle(request) {
		const resource = await this.bundleResource(request.method, request.url, request.headers.get("if-none-match") ?? void 0);
		const body = resource.body === void 0 ? null : resource.body instanceof Readable ? transforStreamBody(resource.body) : heldBody(resource.body);
		return new Response(body, {
			status: resource.status,
			...resource.headers === void 0 ? {} : { headers: resource.headers }
		});
	}
	/**
	* Filesystem baseline captured before an entry's current bytes were read.
	* HMR compares it with the live files when installing a watch, so a write
	* between startup composition and watch installation cannot disappear into
	* the watcher's initial state.
	* @param id - entry id (package name).
	* @returns the path and baseline, or undefined for an unknown id.
	*/
	artifactBaseline(id) {
		const baseline = this.table.get(id)?.baseline;
		return baseline === void 0 ? void 0 : { ...baseline };
	}
	/**
	* Publish one completed bundle generation (the HMR watch's registration
	* hook; an entry restart publishes through reconciliation instead).
	* Unchanged mtime, ctime and size preserve the graph without reading the bundle.
	* @param id - entry id (package name).
	* @returns the current artifact rev, or undefined for an unknown id.
	*/
	rebuilt(id) {
		const record = this.table.get(id);
		if (record === void 0) return void 0;
		const baseline = this.captureArtifactBaseline(record.meta.clientPath);
		const rev = artifactRevision(baseline);
		if (rev === record.entry.rev) return rev;
		const bundle = readFileSync(record.meta.clientPath);
		record.baseline = baseline;
		record.entry = graphRow(id, rev, record.meta);
		record.bundle = bundle;
		this.composed = this.compose();
		for (const notify of this.rebuildListeners) try {
			notify(id, rev);
		} catch (error) {
			this.ctx.logger.error(error);
		}
		this.notifyGraphChanged();
		return rev;
	}
	/**
	* Subscribe to bundle rebuilds; fires when {@link rebuilt} changes a rev. A rev an
	* entry restart publishes reaches only {@link onGraphChanged} listeners.
	* @param listener - receives the entry id and its new bundle rev.
	* @returns the unsubscriber.
	*/
	onRebuilt(listener) {
		this.rebuildListeners.add(listener);
		return () => {
			this.rebuildListeners.delete(listener);
		};
	}
	/**
	* Fires after any flush that recomposed the graph (row added/removed, or a
	* rebuilt rev change). Pull model: listeners re-read {@link graph}.
	* @param listener - notified with no payload.
	* @returns the unsubscriber.
	*/
	onGraphChanged(listener) {
		this.graphListeners.add(listener);
		return () => {
			this.graphListeners.delete(listener);
		};
	}
	compose() {
		const entries = orderByModuleGraph([...this.table.values()].map((record) => record.entry));
		const bootstrap = PARSER_PRELOAD_IDS.map((id) => this.table.get(id)).filter((record) => record !== void 0);
		const bootstrapIds = new Set(bootstrap.map((record) => record.entry.id));
		const application = entries.filter((entry) => !bootstrapIds.has(entry.id)).map((entry) => this.table.get(entry.id)).filter((record) => record !== void 0);
		const artifacts = [];
		for (const records of partitionComboRecords(bootstrap)) artifacts.push(buildBatch("bootstrap", records, this.readSourceMap));
		for (const records of partitionComboRecords(application)) artifacts.push(buildBatch("application", records, this.readSourceMap));
		const batchResponses = /* @__PURE__ */ new Map();
		for (const artifact of artifacts) {
			batchResponses.set(artifact.url, this.responses.get(artifact.url) ?? {
				body: artifact.scriptBody,
				contentType: "text/javascript; charset=utf-8"
			});
			batchResponses.set(artifact.sourceMapUrl, this.responses.get(artifact.sourceMapUrl) ?? {
				body: artifact.sourceMapBody,
				contentType: "application/json; charset=utf-8"
			});
		}
		const responses = new Map(batchResponses);
		for (const record of this.table.values()) {
			const artifact = buildCombo([record], this.readSourceMap, record.entry.rev);
			responses.set(artifact.url, responses.get(artifact.url) ?? this.responses.get(artifact.url) ?? {
				body: artifact.scriptBody,
				contentType: "text/javascript; charset=utf-8"
			});
			responses.set(artifact.sourceMapUrl, responses.get(artifact.sourceMapUrl) ?? this.responses.get(artifact.sourceMapUrl) ?? {
				body: artifact.sourceMapBody,
				contentType: "application/json; charset=utf-8"
			});
		}
		for (const [resourceUrl, response] of this.responses) if (this.chunkRequest(new URL(resourceUrl, "http://x")) !== void 0) responses.set(resourceUrl, response);
		this.previousBatchResponses = this.batchResponses;
		this.batchResponses = batchResponses;
		this.responses = responses;
		const batches = artifacts.map((artifact) => artifact.descriptor);
		return {
			rev: shortHash(JSON.stringify({
				entries,
				batches
			})),
			release: this.release,
			entries,
			batches
		};
	}
	notifyGraphChanged() {
		for (const listener of this.graphListeners) try {
			listener();
		} catch (error) {
			this.ctx.logger.error(error);
		}
	}
	resolveMeta(loaderName, baseUrl) {
		const located = this.locatePkgJson(loaderName, baseUrl);
		if (located === void 0) return null;
		const { packageName, path: pkgPath } = located;
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		const dsh = pkg.dsh;
		const decl = parseDshClient(packageName, dsh !== null && typeof dsh === "object" ? dsh.client : void 0);
		if (decl === void 0 || decl.platform !== "web") return null;
		const clientRel = clientExportOf(packageName, pkg.exports);
		if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
		return {
			packageName,
			meta: {
				clientPath: join(dirname(pkgPath), clientRel),
				manifestPath: pkgPath,
				...decl.inject !== void 0 ? { inject: decl.inject } : {},
				external: decl.external ?? [],
				immediately: decl.immediately === true
			}
		};
	}
	/**
	* Locate the manifest of the package the Loader mounts for a row. The row's
	* module location is authoritative: the specifier resolves through the same
	* Loader resolution that imported the row's host half — including any
	* active ESM hooks — and the nearest ancestor manifest declaring the name
	* owns the module. Tree-anchored `require` resolution remains only for
	* runtimes without Node internals.
	* @param loaderName - module specifier of the loader row.
	* @param baseUrl - resolution base of the tree that owns the row.
	* @returns the manifest path, or `undefined` when the name resolves to no package root.
	*/
	locatePkgJson(loaderName, baseUrl) {
		if (loaderName.startsWith("cordis:")) return void 0;
		const pathLike = loaderName.startsWith(".") || loaderName.startsWith("file:") || isAbsolute(loaderName);
		const expectedPackageName = pathLike ? void 0 : exactPackageSpecifier(loaderName);
		if (!pathLike && expectedPackageName === void 0) return void 0;
		const internal = this.ctx.loader.internal;
		if (internal === void 0 || typeof Reflect.get(internal, "resolveSync") !== "function") {
			if (expectedPackageName === void 0) {
				const moduleUrl = loaderName.startsWith("file:") ? loaderName : isAbsolute(loaderName) ? pathToFileURL(loaderName).href : new URL(loaderName, baseUrl).href;
				return this.nearestPackage(moduleUrl);
			}
			try {
				return {
					path: createRequire(baseUrl).resolve(`${expectedPackageName}/package.json`),
					packageName: expectedPackageName
				};
			} catch {
				return;
			}
		}
		let moduleUrl;
		try {
			moduleUrl = internal.version === "v2" ? internal.resolveSync(baseUrl, {
				specifier: loaderName,
				attributes: {}
			}).url : internal.resolveSync(loaderName, baseUrl, {}).url;
		} catch {
			return;
		}
		return this.nearestPackage(moduleUrl, expectedPackageName);
	}
	nearestPackage(moduleUrl, expectedPackageName) {
		if (!moduleUrl.startsWith("file:")) return void 0;
		let dir = dirname(fileURLToPath(moduleUrl));
		while (true) {
			const candidate = join(dir, "package.json");
			if (existsSync(candidate)) try {
				const name = JSON.parse(readFileSync(candidate, "utf8")).name;
				if (typeof name === "string" && (expectedPackageName === void 0 || name === expectedPackageName)) return {
					path: candidate,
					packageName: name
				};
			} catch {}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	sourceKey(loaderName, baseUrl) {
		return `${baseUrl}\0${loaderName}`;
	}
	/** Capture the bundle stats before reading its bytes. */
	captureArtifactBaseline(clientPath) {
		const bundle = statSync(clientPath);
		return {
			path: clientPath,
			mtimeMs: bundle.mtimeMs,
			ctimeMs: bundle.ctimeMs,
			size: bundle.size
		};
	}
	/**
	* Run one filesystem read of a declared client bundle.
	* @param pkgName - package that declares the client bundle.
	* @param clientPath - absolute path of the built client artifact.
	* @param read - the stat or read of `clientPath`.
	* @returns the read's result.
	* @throws {MissingClientBundleError} when the read fails with `ENOENT`; other filesystem errors are rethrown unchanged.
	*/
	readClientBundle(pkgName, clientPath, read) {
		try {
			return read();
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			throw new MissingClientBundleError(pkgName, clientPath, error);
		}
	}
	/** Treat a missing, torn, or malformed development map as an identity section. */
	readSourceMap = (clientPath) => {
		try {
			return readSourceMap(clientPath);
		} catch (error) {
			this.ctx.logger.warn(error);
			return;
		}
	};
	/**
	* Reconcile one entry name against its sources at flush start.
	* @param entryName - Loader entry name being reconciled.
	* @param entries - same-name entries collected at flush start.
	* @param onError - receives package reconciliation failures.
	* @returns whether the table changed.
	*/
	processOne(entryName, entries, onError) {
		const nextSources = /* @__PURE__ */ new Map();
		for (const entry of entries) {
			if (entry.fiber === void 0 || entry.disabled) continue;
			const source = this.resolveSource(entry);
			if (source !== void 0) nextSources.set(source.sourceKey, source);
		}
		const affectedPackages = /* @__PURE__ */ new Set();
		for (const [sourceKey, source] of this.sources) {
			if (source.loaderName !== entryName) continue;
			affectedPackages.add(source.packageName);
			if (!nextSources.has(sourceKey)) this.sources.delete(sourceKey);
		}
		for (const [sourceKey, source] of nextSources) {
			affectedPackages.add(source.packageName);
			this.sources.set(sourceKey, source);
		}
		let changed = false;
		for (const packageName of affectedPackages) try {
			if (this.reconcilePackage(packageName)) changed = true;
		} catch (error) {
			onError(error instanceof Error ? error : new Error(String(error)));
		}
		return changed;
	}
	resolveSource(entry) {
		const loaderName = entry.options.name;
		const baseUrl = entry.parent.tree.ctx.baseUrl;
		if (baseUrl === void 0) throw new Error(`client-modules: loader entry ${loaderName} has no resolution base URL`);
		const resolved = this.resolveMeta(loaderName, baseUrl);
		if (resolved === null) return void 0;
		return {
			...resolved,
			loaderName,
			baseUrl,
			sourceKey: this.sourceKey(loaderName, baseUrl)
		};
	}
	reconcilePackage(packageName) {
		const sources = [];
		for (const source of this.sources.values()) if (source.packageName === packageName) sources.push(source);
		if (sources.length > 1) {
			const locations = sources.map((source) => `${JSON.stringify(source.loaderName)} from ${source.baseUrl}`).join(", ");
			throw new Error(`client-modules: package ${packageName} resolves from multiple active Loader sources: ${locations}; remove one entry`);
		}
		const source = sources[0];
		if (source === void 0) return this.table.delete(packageName);
		const { clientPath } = source.meta;
		const baseline = this.readClientBundle(packageName, clientPath, () => this.captureArtifactBaseline(clientPath));
		const entry = graphRow(packageName, artifactRevision(baseline), source.meta);
		const current = this.table.get(packageName);
		if (current?.sourceKey === source.sourceKey && isDeepStrictEqual(current.meta, source.meta) && isDeepStrictEqual(current.entry, entry)) return false;
		this.table.set(packageName, {
			entry,
			loaderName: source.loaderName,
			sourceKey: source.sourceKey,
			meta: source.meta,
			bundle: this.readClientBundle(packageName, clientPath, () => readFileSync(clientPath)),
			baseline
		});
		return true;
	}
	flush(onError) {
		if (this.dirty.size === 0) return;
		const entriesByName = /* @__PURE__ */ new Map();
		try {
			for (const entry of this.ctx.loader.entries()) {
				const name = entry.options.name;
				const entries = entriesByName.get(name);
				if (entries) entries.push(entry);
				else entriesByName.set(name, [entry]);
			}
		} catch (error) {
			this.dirty.clear();
			onError(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		let changed = false;
		for (const entryName of [...this.dirty]) {
			this.dirty.delete(entryName);
			try {
				if (this.processOne(entryName, entriesByName.get(entryName) ?? [], onError)) changed = true;
			} catch (error) {
				onError(error instanceof Error ? error : new Error(String(error)));
			}
		}
		if (!changed) return;
		let composed;
		try {
			composed = this.compose();
		} catch (error) {
			onError(error);
			return;
		}
		this.composed = composed;
		this.notifyGraphChanged();
	}
	/** Match an exact current-revision package-local chunk URL without reading its file. */
	chunkRequest(requestUrl) {
		const resourceUrl = `${requestUrl.pathname}${requestUrl.search}`;
		for (const record of this.table.values()) {
			const prefix = `/plugins/${record.entry.id}/`;
			if (!requestUrl.pathname.startsWith(prefix)) continue;
			const requested = requestUrl.pathname.slice(prefix.length);
			const sourceMap = requested.endsWith(".map");
			const fileName = sourceMap ? requested.slice(0, -4) : requested;
			if (!CLIENT_CHUNK.test(fileName) || fileName === "client.node.js" || fileName.startsWith("client.node.")) return void 0;
			if (resourceUrl !== chunkUrl(record.entry.id, fileName, record.entry.rev, sourceMap)) return void 0;
			return {
				record,
				fileName,
				sourceMap,
				resourceUrl
			};
		}
	}
	/** Build a package-local chunk response only when its URL is requested. */
	chunkResponse(requestUrl) {
		const request = this.chunkRequest(requestUrl);
		if (request === void 0) return void 0;
		const { record, fileName, sourceMap, resourceUrl } = request;
		const clientPath = join(dirname(record.meta.clientPath), fileName);
		if (!existsSync(clientPath)) return void 0;
		const sourceMapUrl = chunkMapReference(fileName, record.entry.rev);
		const resource = async () => ({
			id: record.entry.id,
			rev: record.entry.rev,
			clientPath,
			fileName,
			bundle: await readFile(clientPath)
		});
		const response = sourceMap ? {
			body: lazyBody(async () => buildComboSourceMap([await resource()], this.readSourceMap, fileName)),
			contentType: "application/json; charset=utf-8"
		} : {
			body: lazyBody(async () => buildComboScript([await resource()], sourceMapUrl)),
			contentType: "text/javascript; charset=utf-8"
		};
		this.responses.set(resourceUrl, response);
		return response;
	}
	/**
	* Answer one package-asset request. Node's `require.resolve` applies the
	* package's `./assets/*` export as a self-reference, so unexported,
	* `.`/`..`, missing, and directory paths answer 404. The build writes each
	* asset's content revision into its file name, so a served path names one
	* content: the body streams from disk on every request, and the path is the
	* entity tag.
	* @param method - request method.
	* @param record - the active row of the addressed package, or undefined when it is not active.
	* @param assetPath - percent-encoded path below the package's `assets/` route segment.
	* @param ifNoneMatch - request `If-None-Match` field.
	* @returns the route answer.
	*/
	assetResponse(method, record, assetPath, ifNoneMatch) {
		if (record === void 0 || assetPath === "") return { status: 404 };
		let file;
		try {
			file = createRequire(record.meta.manifestPath).resolve(`${record.entry.id}/${PACKAGE_ASSET_SEGMENT}/${decodeURIComponent(assetPath)}`);
		} catch {
			return { status: 404 };
		}
		const mediaType = packageAssetMediaType(file);
		if (mediaType === void 0) return { status: 404 };
		const headers = {
			"content-type": mediaType,
			"cache-control": IMMUTABLE_CACHE,
			etag: `"${assetPath}"`,
			"x-content-type-options": "nosniff",
			...mediaType === "image/svg+xml" ? { "content-security-policy": "script-src 'none'" } : {}
		};
		if (ifNoneMatch === headers.etag) return {
			status: 304,
			headers
		};
		return {
			status: 200,
			headers,
			...method === "HEAD" ? {} : { body: createReadStream(file) }
		};
	}
	/**
	* Answer one `/plugins` request. A `/plugins/<package>/assets/` path is
	* answered by the package-asset route alone; any other path is an advertised
	* combo or its map, a prior startup generation, or a current-revision
	* package-local chunk, in that order, and otherwise 404.
	*/
	async bundleResource(method, url, ifNoneMatch) {
		if (method !== "GET" && method !== "HEAD") return { status: 405 };
		const requestUrl = new URL(url, "http://x");
		const asset = PACKAGE_ASSET_PATH.exec(requestUrl.pathname);
		if (asset !== null) {
			const [, packageName = "", assetPath = ""] = asset;
			return this.assetResponse(method, this.table.get(packageName), assetPath, ifNoneMatch);
		}
		const resourceUrl = `${requestUrl.pathname}${requestUrl.search}`;
		const response = this.responses.get(resourceUrl) ?? this.previousBatchResponses.get(resourceUrl) ?? this.chunkResponse(requestUrl);
		if (response !== void 0) return {
			status: 200,
			headers: {
				"content-type": response.contentType,
				"cache-control": IMMUTABLE_CACHE
			},
			...method === "HEAD" ? {} : { body: await response.body() }
		};
		return { status: 404 };
	}
};
//#endregion
export { ClientModuleRegistry, ClientModuleRegistry as default, bootInjections, orderByModuleGraph, stripClientSuffix };
