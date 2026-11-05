import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createServer$1 } from "node:https";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import compressionMiddleware from "compression";
import ipaddr from "ipaddr.js";
import Negotiator from "negotiator";
//#region lib/types/injections.js
/**
* Structured index injections: the typed rows plugins contribute to the boot
* HTML instead of raw `tapIndex` string transforms. Rows are pure
* JSON-serializable data because one table feeds two renderers: the served
* form renders rows into the index.html text ({@link renderIndexInjections}),
* and a static worker deployment ships the same rows over its boot payload
* for a page-side interpreter. Anything not expressible as a row stays on
* `tapIndex`, which runs after row rendering.
*/
/** Escape a row value before placing it in a quoted HTML attribute. */
function escapeHtmlAttribute(value) {
	return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function assertNever(row) {
	throw new Error(`webserver: unknown index injection row ${JSON.stringify(row)}`);
}
/** Render one row to markup with its placement. */
function renderRow(row) {
	switch (row.kind) {
		case "global": return {
			placement: "head",
			markup: `<script>globalThis[${JSON.stringify(row.name).replaceAll("<", "\\u003c")}] = ${row.value === void 0 ? "undefined" : JSON.stringify(row.value).replaceAll("<", "\\u003c")}<\/script>`
		};
		case "script": return {
			placement: row.placement,
			markup: `<script>${row.text}<\/script>`
		};
		case "script-src": return {
			placement: row.placement,
			markup: `<script src="${escapeHtmlAttribute(row.src)}"><\/script>`
		};
		case "script-preload": return {
			placement: "head",
			markup: `<link rel="preload" as="script" href="${escapeHtmlAttribute(row.src)}">`
		};
		case "style": return {
			placement: "head",
			markup: `<style>${row.text}</style>`
		};
		case "html": return {
			placement: row.placement,
			markup: row.html
		};
		default: return assertNever(row);
	}
}
/** Insert `markup` into `html` at `at`. */
function splice(html, at, markup) {
	return `${html.slice(0, at)}${markup}${html.slice(at)}`;
}
/**
* Tail script settling the boot-readiness deferred (`__DSH_BOOT_READY__`):
* the client entry awaits its `.promise` before reading any injected state.
* Whichever side runs first creates the deferred (`??=`), so a bootstrap that
* applies the table asynchronously installs it ahead of the entry module and
* settles it after the last row; the served form below creates and resolves
* it in one statement, because every row is already in the document text.
*/
const READY_MARKUP = "<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()<\/script>";
/**
* Render rows into an index.html body: head rows immediately after the
* opening head tag, body rows immediately after the opening body tag, each
* group in table order, and the boot-readiness tail after the last body row.
* @param html - the raw index.html body.
* @param rows - the collected injection table.
* @returns the html with every row rendered.
*/
function renderIndexInjections(html, rows) {
	let head = "";
	let body = "";
	for (const row of rows) {
		const rendered = renderRow(row);
		if (rendered.placement === "head") head += rendered.markup;
		else body += rendered.markup;
	}
	body += READY_MARKUP;
	let out = html;
	if (head !== "") {
		const open = /<head(?:\s[^>]*)?>/i.exec(out);
		out = open === null ? `${head}${out}` : splice(out, open.index + open[0].length, head);
	}
	if (body !== "") {
		const open = /<body(?:\s[^>]*)?>/i.exec(out);
		out = open === null ? `${out}${body}` : splice(out, open.index + open[0].length, body);
	}
	return out;
}
//#endregion
//#region lib/types/index.js
/**
* @deepseek-ai/dsh-host-webserver — node:http route registration — node:https
* when `tls` names a certificate and key — with optional gzip, index injection,
* and one fallback seat. It knows no harness concepts and serves no files; the
* composing application owns dist serving. Electron uses file:// plus IPC
* instead, and this package never prints the URL.
* Route handlers retain direct response ownership.
*/
const DEFAULT_COMPRESSION = "none";
const DEFAULT_COMPRESSION_LEVEL = 1;
const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 1024;
/** Dotted-quad tail of the IPv6 mixed notation: `::0.0.0.1`, `1:2:3:4:5:6:127.0.0.1`. */
const IPV4_TAIL = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/**
* Rewrite a dotted-quad tail as the two hex groups holding the same bytes.
* ipaddr.js 2.5.0 reads an all-zero prefix plus a quad (`::0.0.0.1`) as the
* IPv4-mapped form `::ffff:0:1`, while `getaddrinfo` — and so `listen` — reads
* that tail as the low 32 bits of the address itself, which makes `::0.0.0.1`
* the loopback literal `::1`. Parsing the rewritten text keeps the parsed value
* equal to the value the socket binds.
*/
function withHexTail(host) {
	const tail = IPV4_TAIL.exec(host);
	if (tail === null) return host;
	const [, head = "", a = "", b = "", c = "", d = ""] = tail;
	return `${head}${(Number(a) << 8 | Number(b)).toString(16)}:${(Number(c) << 8 | Number(d)).toString(16)}`;
}
/**
* Parse a concrete IP literal, normalizing IPv4-mapped IPv6 to IPv4.
* `node:net` decides what a value must look like for `listen` to accept it, and
* a trailing `%zone` (a local interface selector, never address text) comes off
* before parsing; the value handed to `listen` keeps its zone.
*/
function parseIpLiteral(host) {
	if (isIP(host) === 0) return void 0;
	const zoneAt = host.indexOf("%");
	const parsed = ipaddr.parse(withHexTail(zoneAt === -1 ? host : host.slice(0, zoneAt)));
	return parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress() ? parsed.toIPv4Address() : parsed;
}
/** Rejection for a bind address that is no concrete IP literal. */
function notLiteralError(value) {
	return /* @__PURE__ */ new Error(`webserver: host ${JSON.stringify(value)} is not a concrete IPv4 or IPv6 address literal`);
}
/** ipaddr's IPv4 unspecified range covers all of 0/8; only the all-zero address binds every interface. */
function isWildcardAddress(parsed) {
	return (parsed instanceof ipaddr.IPv4 ? parsed.octets : parsed.parts).every((part) => part === 0);
}
/**
* Whether a bind address requests every interface at once.
* @param host - bind address from configuration.
* @returns true for IPv4 any, IPv6 any, and an IPv4-mapped form of IPv4 any.
*/
function isWildcardHost(host) {
	const parsed = parseIpLiteral(host);
	return parsed !== void 0 && isWildcardAddress(parsed);
}
/**
* Whether a bind address names the local loopback authority.
* @param host - bind address from configuration.
* @returns true for any address in 127/8, `::1`, and their IPv4-mapped forms.
*/
function isLoopbackHost(host) {
	const parsed = parseIpLiteral(host);
	return parsed !== void 0 && parsed.range() === "loopback";
}
/**
* Canonical text of the address a bind literal names: IPv4 and IPv4-mapped
* literals read as dotted quad, every other literal as its compressed IPv6
* value. The text names the address `listen` binds, so `::0.0.0.1` reads as
* `::1`. A `%zone` selects an interface and never appears in the text.
* @param host - concrete IPv4 or IPv6 literal, with or without a zone.
* @returns the address text, ready to be a URL host.
* @throws when `host` is no concrete IPv4 or IPv6 address literal.
*/
function normalizeBindAddress(host) {
	const parsed = parseIpLiteral(host);
	if (parsed === void 0) throw notLiteralError(host);
	return parsed.toString();
}
/**
* The URL host form of a bind address. Loopback addresses use their canonical
* text, so browsers treat them as local, trustworthy origins: a mapped literal
* such as `::ffff:127.0.0.1` reads as `127.0.0.1`, and `::0.0.0.1` reads as
* `::1`. A redundant loopback zone is dropped; other addresses keep their text,
* and IPv6 text is bracketed.
* @param host - concrete IPv4 or IPv6 bind literal.
* @returns the URL host, or `undefined` when a non-loopback interface zone id makes the address inexpressible in a URL.
*/
function bindUrlHost(host) {
	const zoneAt = host.indexOf("%");
	const bare = zoneAt === -1 ? host : host.slice(0, zoneAt);
	if (!isLoopbackHost(bare) && zoneAt !== -1) return void 0;
	const text = isLoopbackHost(bare) ? normalizeBindAddress(bare) : host;
	return isIP(text) === 6 ? `[${text}]` : text;
}
function createGzipMiddleware(config) {
	const middleware = compressionMiddleware({
		level: config.compressionLevel,
		threshold: config.compressionThresholdBytes,
		filter(request, response) {
			if (response.getHeader("content-range") !== void 0) return false;
			const contentType = response.getHeader("content-type");
			if (typeof contentType === "string" && contentType.toLowerCase().startsWith("text/event-stream")) return false;
			if (typeof contentType === "string" && /^multipart\/form-data(?:;|$)/i.test(contentType)) return true;
			return compressionMiddleware.filter(request, response);
		}
	});
	return (req, res, next) => {
		if (res.socket === void 0) {
			next();
			return;
		}
		const encoding = new Negotiator(req).encoding(["gzip", "identity"]);
		const gzipRequest = Object.create(req);
		Object.defineProperty(gzipRequest, "headers", { value: {
			...req.headers,
			"accept-encoding": encoding === "gzip" ? "gzip" : "identity"
		} });
		middleware(gzipRequest, res, next);
	};
}
/**
* Read one TLS material file for activation. The error names the config field
* and the resolved path; empty content is rejected here because node:tls
* silently accepts it, which would bind a listener that can never complete a
* handshake.
* @param field - the config field being read, for the diagnostic.
* @param path - absolute path to read.
* @returns the file's text.
*/
async function readTlsFile(field, path) {
	let content;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		throw new Error(`webserver: cannot read tls.${field} ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (content.trim().length === 0) throw new Error(`webserver: tls.${field} ${path} is empty`);
	return content;
}
/**
* The browser HTTP carrier service. Activation loads any configured TLS
* material, then listens immediately; a material or listen failure rejects
* initialization, and the boot process reports the failed fiber. Route
* registration order does not affect requests because configured named routes
* must be distinct, and the fallback handler answers anything not yet claimed
* during startup with 404 until its owner registers.
*/
var WebServer = class extends Service {
	config;
	static Config = z.object({
		host: z.transform(z.string(), (value) => {
			const parsed = parseIpLiteral(value);
			if (parsed === void 0) throw notLiteralError(value);
			if (isWildcardAddress(parsed)) throw new Error(`webserver: host ${JSON.stringify(value)} is an unspecified (wildcard) address, which is not supported: binding every interface would expose remote code execution to the network; bind one concrete IPv4 or IPv6 address of a local interface instead`);
			return value;
		}).required(),
		port: z.natural().max(65535).required(),
		tls: z.object({
			certFile: z.string().required(),
			keyFile: z.string().required()
		}).default(void 0),
		compression: z.union([z.const("none"), z.const("gzip")]).default(DEFAULT_COMPRESSION),
		compressionLevel: z.number().step(1).min(0).max(9).default(DEFAULT_COMPRESSION_LEVEL),
		compressionThresholdBytes: z.natural().default(DEFAULT_COMPRESSION_THRESHOLD_BYTES)
	});
	exact = /* @__PURE__ */ new Map();
	prefixes = /* @__PURE__ */ new Map();
	upgrades = /* @__PURE__ */ new Map();
	upgradedSockets = /* @__PURE__ */ new Set();
	/**
	* Raw connections of a TLS listener, held until they close. A TLS connection
	* joins closeAllConnections()'s table only once its handshake completes, so a
	* socket still handshaking — or one whose peer never sends a ClientHello —
	* would otherwise keep `close()` waiting on the TLS handshake timeout. Empty
	* for the plain listener, whose connections closeAllConnections() reaches.
	*/
	tlsConnections = /* @__PURE__ */ new Set();
	indexTaps = [];
	fallback;
	server;
	listenedPort;
	gzip;
	tlsConfig;
	constructor(ctx, config) {
		super(ctx, "webServer");
		this.config = config;
		const resolved = config;
		this.tlsConfig = resolved.tls ?? void 0;
		this.gzip = resolved.compression === "gzip" ? createGzipMiddleware(resolved) : void 0;
	}
	/** The listening port (the OS-assigned value when config.port is 0), or `undefined` before `listen` binds. */
	get port() {
		return this.listenedPort;
	}
	/** The configured bind address (one concrete local interface). */
	get host() {
		return this.config.host;
	}
	/**
	* The protocol the listener speaks: `'https:'` when `tls` is configured. The
	* value follows configuration, never a socket or a request header, so a
	* consumer reads it before any request and no proxy can change it.
	*/
	get protocol() {
		return this.tlsConfig === void 0 ? "http:" : "https:";
	}
	/**
	* The root URL local clients use to reach the bound listener: the protocol,
	* the {@link bindUrlHost} form of the bind address, and the listening port.
	* @returns the origin, for example `http://127.0.0.1:3080`.
	* @throws before `listen` binds a port, or when the bind address has no URL form.
	*/
	getOrigin() {
		const host = bindUrlHost(this.config.host);
		if (host === void 0) throw new Error(`webserver: bind address ${JSON.stringify(this.config.host)} carries an interface zone id, which no URL can express`);
		if (this.listenedPort === void 0) throw new Error("webserver: origin read before the listener bound a port");
		return `${this.protocol}//${host}:${String(this.listenedPort)}`;
	}
	/**
	* Register a named route. Duplicate (kind, path) throws — route patterns are
	* a composition-level contract, so a collision is a misconfiguration.
	* @param route - kind, path, and the owning handler.
	* @returns the disposer removing the route.
	*/
	register(route) {
		const table = route.kind === "exact" ? this.exact : this.prefixes;
		if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
		table.set(route.path, route);
		return () => {
			table.delete(route.path);
		};
	}
	/**
	* Register an exact-path HTTP upgrade route. Duplicate paths throw because
	* one socket can have only one protocol owner.
	* @param route - pathname and handler owning negotiation plus socket use.
	* @returns the disposer removing the route.
	*/
	registerUpgrade(route) {
		if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`);
		this.upgrades.set(route.path, route);
		return () => {
			this.upgrades.delete(route.path);
		};
	}
	/**
	* Claim the fallback seat: the handler answering every request no named
	* route matches (the SPA dist server in the shipped Web composition). One
	* owner only — a second registration throws, because two fallbacks cannot
	* compose.
	* @param handler - owns the full response lifecycle of unmatched requests.
	* @returns the disposer releasing the seat.
	*/
	registerFallback(handler) {
		if (this.fallback !== void 0) throw new Error("webserver: fallback already registered");
		this.fallback = handler;
		return () => {
			this.fallback = void 0;
		};
	}
	/**
	* Register a raw-HTML index transform, the escape hatch for markup no
	* {@link IndexInjection} row expresses: {@link renderIndex} applies taps in
	* registration order after rendering the structured rows.
	* @param transform - pure html-to-html function.
	* @returns the disposer removing the transform.
	*/
	tapIndex(transform) {
		this.indexTaps.push(transform);
		return () => {
			const at = this.indexTaps.indexOf(transform);
			if (at !== -1) this.indexTaps.splice(at, 1);
		};
	}
	/** Listen; resolves once the socket is bound (rejection = FAILED fiber). */
	async [Service.init]() {
		const handle = async (req, res) => {
			/* v8 ignore next -- `?? '/'` arm: node:http always sets url on server
			requests; the field is only optional on the client-side IncomingMessage type */
			const rawPath = new URL(req.url ?? "/", "http://x").pathname;
			const route = this.match(rawPath);
			if (route !== void 0) {
				await route.handler(req, res);
				return;
			}
			const fallback = this.fallback;
			if (fallback === void 0) {
				res.writeHead(404);
				res.end();
				return;
			}
			await fallback(req, res);
		};
		const listener = (req, res) => {
			const next = () => {
				handle(req, res).catch((err) => {
					this.ctx.logger.warn(err instanceof Error ? err : new Error(String(err)));
					if (res.headersSent) {
						res.destroy();
						return;
					}
					res.writeHead(400);
					res.end();
				});
			};
			if (this.gzip === void 0) next();
			else this.gzip(req, res, next);
		};
		const tls = this.tlsConfig;
		await this.ctx.effect(async () => {
			if (tls === void 0) this.server = createServer(listener);
			else {
				const certFile = resolve(tls.certFile);
				const keyFile = resolve(tls.keyFile);
				const [cert, key] = await Promise.all([readTlsFile("certFile", certFile), readTlsFile("keyFile", keyFile)]);
				try {
					this.server = createServer$1({
						cert,
						key
					}, listener);
				} catch (error) {
					throw new Error(`webserver: tls.certFile ${certFile} and tls.keyFile ${keyFile} are not a usable certificate and key pair: ${error instanceof Error ? error.message : String(error)}`);
				}
				this.server.on("connection", (socket) => {
					this.tlsConnections.add(socket);
					socket.once("close", () => {
						this.tlsConnections.delete(socket);
					});
				});
			}
			this.server.on("upgrade", (req, socket, head) => {
				const onError = (error) => {
					this.ctx.logger.warn(error);
					socket.destroy();
				};
				socket.on("error", onError);
				socket.once("close", () => {
					socket.off("error", onError);
					this.upgradedSockets.delete(socket);
				});
				let route;
				try {
					/* v8 ignore next -- node:http always sets url on server requests. */
					route = this.upgrades.get(new URL(req.url ?? "/", "http://x").pathname);
				} catch (error) {
					this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
					socket.destroy();
					return;
				}
				if (route === void 0) {
					socket.destroy();
					return;
				}
				this.upgradedSockets.add(socket);
				try {
					Promise.resolve(route.handler(req, socket, head)).catch((error) => {
						this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
						socket.destroy();
					});
				} catch (error) {
					this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
					socket.destroy();
				}
			});
			await new Promise((resolve, reject) => {
				this.server.once("error", reject);
				this.server.listen(this.config.port, this.config.host, () => {
					this.server.off("error", reject);
					this.server.on("error", (err) => {
						this.ctx.logger.error(err);
					});
					this.listenedPort = this.server.address().port;
					resolve();
				});
			});
			return async () => {
				const serverClosed = new Promise((resolve) => {
					this.server.close(() => {
						resolve();
					});
				});
				this.server.closeAllConnections();
				const socketsClosed = [...this.upgradedSockets, ...this.tlsConnections].map((socket) => new Promise((resolve) => {
					socket.once("close", () => {
						resolve();
					});
					socket.destroy();
				}));
				await Promise.all([serverClosed, ...socketsClosed]);
			};
		}, "webServer.listen");
	}
	/** Longest-prefix-wins over the prefix table after an exact-table miss. */
	match(pathname) {
		const exact = this.exact.get(pathname);
		if (exact !== void 0) return exact;
		let best;
		for (const [prefix, route] of this.prefixes) {
			if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
			if (best === void 0 || prefix.length > best.path.length) best = route;
		}
		return best;
	}
	/**
	* Run an index.html body through the registered taps in registration order
	* — called by the fallback owner on every index response it renders.
	* @param html - the raw index.html body.
	* @returns the transformed body.
	*/
	applyIndexTaps(html) {
		let out = html;
		for (const transform of this.indexTaps) out = transform(out);
		return out;
	}
	/**
	* Gather the structured injection table: one `webserver/index-inject` emit,
	* every subscriber pushes its current rows. Fresh per call, so subscribers
	* read live state (module graph, theme preference) at emit time.
	* @returns rows in subscriber activation order.
	*/
	collectIndexInjections() {
		const table = [];
		this.ctx.emit("webserver/index-inject", table);
		return table;
	}
	/**
	* Render one index.html body: the structured injection table first, then
	* the raw `tapIndex` transforms over the result.
	* @param html - the raw index.html body.
	* @returns the transformed body.
	*/
	renderIndex(html) {
		return this.applyIndexTaps(renderIndexInjections(html, this.collectIndexInjections()));
	}
};
//#endregion
export { WebServer, WebServer as default, bindUrlHost, isLoopbackHost, isWildcardHost, normalizeBindAddress, renderIndexInjections };
