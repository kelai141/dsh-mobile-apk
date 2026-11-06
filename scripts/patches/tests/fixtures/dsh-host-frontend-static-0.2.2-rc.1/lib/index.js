import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import z from "@deepseek-ai/schemastery";
//#region lib/types/index.js
/**
* @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
* fallback seat: a webserver resource serving the built frontend directory
* with explicit index entry points. A readable index renders at the dist root
* and configured index path; missing paths return 404, traversal outside the
* dist root is 403, unknown extensions ship as octet-stream, and non-GET/HEAD
* is 405. An HTTP index request first passes Connection's browser
* authentication and renders for the browser Peer; an in-process read renders
* for the Peer its caller admitted. Both renders go through the webserver's
* index render (structured injection rows, then raw taps). Non-index assets
* stay public; every file other than the index carries a weak ETag with
* `cache-control: no-cache` and answers a matching `If-None-Match` with 304,
* while the index carries no cache headers. The dist location is workspace
* knowledge of the composing application, so `distIndex` is typically
* supplied through a `!!js` expression, never hardcoded by a deployment.
* @module @deepseek-ai/dsh-host-frontend-static
*/
/** Stable Cordis plugin name. */
const name = "frontend-static";
/** Services required before the authenticated fallback seat can be claimed. */
const inject = ["webServer", "connection"];
const Config = z.object({ distIndex: z.string().required() });
const HTML_MIME = "text/html; charset=utf-8";
const MIME = {
	".html": HTML_MIME,
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".json": "application/json",
	".map": "application/json",
	".webmanifest": "application/manifest+json",
	".gz": "application/gzip"
};
const STATIC_MISS_CODES = new Set([
	"ENOENT",
	"EISDIR",
	"ENOTDIR"
]);
/** A Response body that is `bytes` itself, without the copy a buffer body gets. */
function bytesBody(bytes) {
	return new ReadableStream({ start(controller) {
		controller.enqueue(bytes);
		controller.close();
	} });
}
/**
* Answer one GET or HEAD dist request; the webserver answers any other method
* with 405 before a resource runs. A malformed percent-escape or a filesystem
* failure other than a missing or non-file target rejects.
* @param request - the request; only its method and URL path are read.
* @param distRoot - absolute dist root directory (resolved by the caller).
* @param distIndex - absolute path of index.html inside distRoot.
* @param authorizeIndex - answers an index request before its bytes are read:
* the response to send instead of the index, or undefined to serve it.
* @param renderIndex - turns the raw index.html body into the served document
* for the dist root and configured index path.
* @returns the dist response; a HEAD response carries the GET status and
* headers without a body. A file other than the index carries
* `cache-control: no-cache` and a weak ETag from a SHA-1 of its bytes, and a
* request whose `If-None-Match` equals that ETag receives an empty 304.
*/
async function serveStatic(request, distRoot, distIndex, authorizeIndex, renderIndex) {
	const target = resolve(normalize(join(distRoot, decodeURIComponent(new URL(request.url).pathname))));
	if (target !== distRoot && !target.startsWith(distRoot + sep)) return new Response(null, { status: 403 });
	let body;
	let headers;
	try {
		if (target === distRoot || target === distIndex) {
			const refusal = authorizeIndex();
			if (refusal !== void 0) return refusal;
			body = renderIndex(await readFile(distIndex, "utf8"));
			headers = { "content-type": HTML_MIME };
		} else {
			body = await readFile(target);
			const cache = {
				"cache-control": "no-cache",
				etag: `W/"${createHash("sha1").update(body).digest("base64url")}"`
			};
			if (request.headers.get("if-none-match") === cache.etag) return new Response(null, {
				status: 304,
				headers: cache
			});
			headers = {
				"content-type": MIME[extname(target)] ?? "application/octet-stream",
				...cache
			};
		}
	} catch (error) {
		if (!STATIC_MISS_CODES.has(error.code)) throw error;
		return new Response(null, { status: 404 });
	}
	if (request.method === "HEAD") return new Response(null, {
		status: 200,
		headers
	});
	return new Response(typeof body === "string" ? body : bytesBody(body), {
		status: 200,
		headers
	});
}
/**
* Claim the webserver fallback seat with a resource serving the dist.
* @param ctx - plugin context carrying the webServer and connection services.
* @param config - validated {@link Config}.
*/
function apply(ctx, config) {
	const distIndex = config.distIndex;
	const distRoot = dirname(distIndex);
	const authorizeIndex = (request) => {
		let status = 401;
		let headers = new Headers();
		let body;
		return ctx.connection.authorizeIndex(request, {
			writeHead(nextStatus, nextHeaders) {
				status = nextStatus;
				headers = new Headers(nextHeaders);
			},
			end(text) {
				body = text;
			}
		}) ? void 0 : new Response(body, {
			status,
			headers
		});
	};
	ctx.effect(() => ctx.webServer.registerFallback({ resource: (request, peer) => serveStatic(request, distRoot, distIndex, () => peer === void 0 ? authorizeIndex(request) : void 0, (html) => ctx.webServer.renderIndex(html, peer ?? ctx.connection.browserPeer).replace(/<head(?:\s[^>]*)?>/i, (open) => `${open}<base href="./">`)) }), "frontend-static: fallback seat");
}
//#endregion
export { Config, apply, inject, name };
