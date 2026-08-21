import z from "@deepseek-ai/schemastery";
import { readdirSync } from "node:fs";
import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";
import { dirname, join, parse, resolve, toNamespacedPath } from "node:path";
import { performance } from "node:perf_hooks";
import { scheduler } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { DEFAULT_PREPARED_SESSION_CACHE_SIZE, DEFAULT_WRITE_BATCH_MAX_DELAY_MS, MAX_WRITE_BATCH_DELAY_MS, PersistenceCoordinator, SessionFormatUnsupportedError, SessionPersistence, SessionPersistenceRevision, sessionFormatVersionRefusal } from "@deepseek-ai/dsh-session-persistence";
import { SESSION_FORMAT_VERSION, decodeStorageRecord, packChunkRuns } from "@deepseek-ai/dsh-session";
import { constants, createZstdDecompress, zstdCompress, zstdDecompress, zstdDecompressSync } from "node:zlib";
import { promisify } from "node:util";
import { constants as constants$1 } from "node:buffer";
//#region lib/types/format.js
/**
* On-disk format helpers for the JSONL session-persistence backend: path
* sanitization (a {@link SessionId} is an unvalidated branded string, so it
* MUST be encoded before use in a path — no traversal, no collision), the
* per-project/session directory layout, header-line (de)serialization, and the
* truncation-repair offset computation.
*
* @module dsh-session-persistence-jsonl/format
*/
/**
* Return the artifact suffix for one physical encoding.
* @param compression - configured JSONL artifact encoding.
* @returns `.jsonl.zstd` for Zstandard or `.jsonl` for plaintext.
*/
function logSuffix(compression) {
	return compression === "zstd" ? ".jsonl.zstd" : ".jsonl";
}
/**
* Build the header line object from a {@link SessionHeader}.
* @param header - the immutable session metadata to serialize.
* @returns the `type: 'session'`-tagged line object, absent optional fields omitted (never null).
*/
function toHeaderLine(header) {
	return {
		type: "session",
		version: header.version,
		id: header.id,
		createdAt: header.createdAt,
		...header.cwd !== void 0 ? { cwd: header.cwd } : {},
		...header.parentSession !== void 0 ? { parentSession: header.parentSession } : {},
		...header.seedLength !== void 0 ? { seedLength: header.seedLength } : {},
		...header.origin !== void 0 ? { origin: header.origin } : {},
		delegationDepth: header.delegationDepth ?? 0,
		...header.agentPreset !== void 0 ? { agentPreset: header.agentPreset } : {}
	};
}
/**
* Parse a header line back into a {@link SessionHeader}.
* @param line - the shape-checked first line of a log (see the `isHeaderLine` guard).
* @returns the header, absent optional fields omitted.
*/
function fromHeaderLine(line) {
	if (Object.hasOwn(line, "sandboxMode") || Object.hasOwn(line, "approvalPolicy")) throw new Error("session header uses retired policy baseline fields");
	return {
		version: line.version,
		id: line.id,
		createdAt: line.createdAt,
		...line.cwd !== void 0 ? { cwd: line.cwd } : {},
		...line.parentSession !== void 0 ? { parentSession: line.parentSession } : {},
		...line.seedLength !== void 0 ? { seedLength: line.seedLength } : {},
		...line.origin !== void 0 ? { origin: line.origin } : {},
		delegationDepth: line.delegationDepth,
		...line.agentPreset !== void 0 ? { agentPreset: line.agentPreset } : {}
	};
}
/** Type guard: a parsed first line is a well-formed session header. */
function isHeaderLine(value) {
	return typeof value === "object" && value !== null && value.type === "session" && typeof value.version === "number" && typeof value.id === "string" && typeof value.createdAt === "number" && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0 && !Object.is(value.createdAt, -0) && typeof value.delegationDepth === "number" && Number.isSafeInteger(value.delegationDepth) && value.delegationDepth >= 0 && !Object.is(value.delegationDepth, -0) && (value.origin === void 0 || value.origin === "subagent") && (value.agentPreset === void 0 || typeof value.agentPreset === "string");
}
/**
* Encode an arbitrary string as a single safe path segment, injectively over ALL JS (UTF-16)
* strings — including lone surrogates. A {@link SessionId} is an unvalidated branded string,
* so this neutralizes `../`, absolute paths, NUL, and separators before any filesystem use.
* Safe code units remain literal; every other unit, including `~`, becomes
* `~XXXX`. Operating on code units preserves lone surrogates, while special-
* casing `.` and `..` prevents traversal by an otherwise safe whole segment.
*
* @param raw - the string to encode; must be non-empty (throws on `''`).
* @returns the escaped single path segment, decodable back to `raw`.
*/
function encodeSegment(raw) {
	if (raw.length === 0) throw new Error("cannot encode an empty path segment");
	if (raw === ".") return "~002E";
	if (raw === "..") return "~002E~002E";
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
	}
	return out;
}
/**
* Build the readable directory key for a project path.
* Filesystem separators and drive separators become `-`; unsafe code units use
* the same `~XXXX` escape as session ids. The key is bounded for filesystem
* component limits. Separator replacement and truncation are intentionally
* lossy, following the common human-navigable project-directory convention.
* @param cwd - the session's project directory.
* @returns a single filesystem-safe project directory name.
*/
function projectKey(cwd) {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
/**
* The configured root's human-navigable project directory. A configured root
* may be local or shared; this grouping does not prescribe its deployment.
* @param root - the backend's session root directory.
* @param cwd - the session's project directory; `undefined` selects `_no-cwd`.
* @returns the project directory path under `root`.
*/
function projectDir(root, cwd) {
	if (cwd === void 0) return join(root, "_no-cwd");
	return join(root, projectKey(cwd));
}
/**
* The directory owned by one session and available for future session-local
* artifacts.
* @param root - the backend's session root directory.
* @param cwd - the session's project directory.
* @param id - the session id, encoded to one safe path segment.
* @returns the session directory beneath its project directory.
*/
function sessionDir(root, cwd, id) {
	return join(projectDir(root, cwd), encodeSegment(id));
}
/**
* The append-only event-log file path for a session.
* @param root - the backend's session root directory.
* @param cwd - the session's project directory (`undefined` → `_no-cwd`).
* @param id - the session id, path-encoded via {@link encodeSegment} before filesystem use.
* @param compression - physical artifact encoding and filename suffix.
* @returns the session's configured JSONL artifact path.
*/
function logPath(root, cwd, id, compression) {
	return join(sessionDir(root, cwd, id), `session${logSuffix(compression)}`);
}
/**
* Serialize an event batch as JSONL lines (no trailing newline). With
* `packChunks` on, delta-chunk runs pack into `text-chunks` /
* `reasoning-chunks` / `tool-call-chunks` storage rows; off writes one event
* per line, byte-identical to the pre-packing layout. Reading is layout-blind
* either way ({@link scanLog} always decodes rows), so the switch changes only
* newly written bytes.
* @param events - the batch to serialize, in log order.
* @param packChunks - whether to pack delta runs into storage rows.
* @returns the batch's JSONL text; the writer adds the final newline.
*/
function eventLines(events, packChunks) {
	return (packChunks ? packChunkRuns(events) : events).map((record) => JSON.stringify(record)).join("\n");
}
/** Parse one complete header record supplied independently from event rows. */
/**
* Refuse a header carrying a format version this build does not read BEFORE
* validating the current header shape or decoding any event row: a future
* format need not satisfy today's structural checks at all, and its user must
* see "upgrade the harness", never "corrupt session log".
* @param parsed - the JSON-parsed first line of a session artifact.
*/
function refuseForeignFormatVersion(parsed) {
	if (typeof parsed !== "object" || parsed === null) return;
	const { version, id } = parsed;
	if (typeof version !== "number" || version === SESSION_FORMAT_VERSION) return;
	throw new SessionFormatUnsupportedError(sessionFormatVersionRefusal(typeof id === "string" ? id : String(id), version));
}
function parseHeaderRecord(record) {
	if (record.length === 0 || record.at(-1) !== 10 || record.indexOf(10) !== record.length - 1) throw new Error("empty or header-less session log");
	let parsed;
	try {
		parsed = JSON.parse(record.subarray(0, -1).toString("utf8"));
	} catch {
		throw new Error("corrupt session log: header line is not valid JSON");
	}
	refuseForeignFormatVersion(parsed);
	if (!isHeaderLine(parsed)) throw new Error("corrupt session log: first line is not a session header");
	return fromHeaderLine(parsed);
}
/**
* Incrementally scan complete JSONL event records after an independently
* supplied header record. Newline search and byte offsets stay on raw buffers;
* only complete records are decoded to UTF-8. A fragment crossing writes is
* copied because a decoder may reuse its output buffer after `write()` returns.
*/
var SessionLogScanner = class {
	meta;
	events = [];
	fragments = [];
	fragmentBytes = 0;
	inputBytes;
	committedBytes;
	eventLine = 0;
	issue;
	finished = false;
	/**
	* Create an event scanner from exactly one newline-terminated header record.
	* @param headerRecord - the complete first JSONL record, including its newline.
	*/
	constructor(headerRecord) {
		this.meta = parseHeaderRecord(headerRecord);
		this.inputBytes = headerRecord.length;
		this.committedBytes = headerRecord.length;
	}
	/**
	* Consume the next raw plaintext chunk, retaining only an incomplete final record.
	* @param chunk - bytes immediately following all previously supplied bytes.
	*/
	write(chunk) {
		if (this.finished) throw new Error("cannot write to a finished session log scanner");
		const chunkStart = this.inputBytes;
		this.inputBytes += chunk.length;
		let lineStart = 0;
		for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, lineStart)) {
			const fragment = chunk.subarray(lineStart, newline);
			let line = fragment;
			if (this.fragments.length > 0) {
				if (fragment.length > 0) this.fragments.push(fragment);
				line = Buffer.concat(this.fragments, this.fragmentBytes + fragment.length);
				this.fragments = [];
				this.fragmentBytes = 0;
			}
			this.consumeEventLine(line, chunkStart + newline + 1);
			lineStart = newline + 1;
		}
		if (lineStart < chunk.length) {
			const fragment = Buffer.from(chunk.subarray(lineStart));
			this.fragments.push(fragment);
			this.fragmentBytes += fragment.length;
		}
	}
	/**
	* Snapshot progress before appending a recoverable torn-frame prefix.
	* @returns byte, committed-prefix, and expanded-event cursors.
	*/
	checkpoint() {
		return {
			inputBytes: this.inputBytes,
			committedBytes: this.committedBytes,
			eventCount: this.events.length
		};
	}
	/**
	* Finish scanning, ignoring a final record without a newline as a torn tail.
	* @returns the header, contiguous event prefix, and safe truncation offset.
	*/
	finish() {
		this.finished = true;
		return {
			meta: this.meta,
			events: this.events,
			committedBytes: this.committedBytes
		};
	}
	/** Decode one complete event row and update the contiguous prefix. */
	consumeEventLine(line, endByte) {
		this.eventLine += 1;
		let decoded;
		try {
			decoded = decodeStorageRecord(JSON.parse(line.toString("utf8")));
		} catch {
			this.issue ??= /* @__PURE__ */ new Error(`corrupt session log: unparsable committed event at line ${this.eventLine}`);
			return;
		}
		if (this.issue !== void 0) {
			if (decoded.some((event) => event.type === "turn/end")) throw this.issue;
			return;
		}
		const rowStart = this.events.length;
		for (const event of decoded) {
			if (event.seq !== this.events.length) {
				const expected = this.events.length;
				this.events.length = rowStart;
				this.issue = /* @__PURE__ */ new Error(`corrupt session log: seq gap in committed region at line ${this.eventLine} (expected ${expected}, got ${event.seq})`);
				if (decoded.some((candidate) => candidate.type === "turn/end")) throw this.issue;
				return;
			}
			this.events.push(event);
		}
		this.committedBytes = endByte;
	}
};
/**
* Parse a complete or torn JSONL buffer into its preserved event prefix. This
* compatibility wrapper supplies the first record separately, then delegates
* event rows to {@link SessionLogScanner}.
*
* @param buffer - the raw bytes of the log file (header line first).
* @returns the header, preserved event prefix, and byte offset safe to append at.
*/
function scanLog(buffer) {
	const headerEnd = buffer.indexOf(10);
	if (headerEnd === -1) throw new Error("empty or header-less session log");
	const scanner = new SessionLogScanner(buffer.subarray(0, headerEnd + 1));
	scanner.write(buffer.subarray(headerEnd + 1));
	return scanner.finish();
}
/**
* Parse just the header line of a log into a {@link SessionHeader}, or
* `undefined` if it is missing/not a header. Used by `list()` to read session
* metadata WITHOUT parsing the whole log: a session picker scales with the
* number of sessions, not the total size of every conversation.
* @param firstLine - the first line of a log file (without its trailing newline).
* @returns the parsed header, or `undefined` when the line is not a well-formed session header.
*/
function parseHeaderMeta(firstLine) {
	let parsed;
	try {
		parsed = JSON.parse(firstLine);
	} catch {
		return;
	}
	if (!isHeaderLine(parsed)) return void 0;
	return fromHeaderLine(parsed);
}
//#endregion
//#region lib/types/zstd-private-decoder.js
/**
* Node-private synchronous Zstandard frame decoder optimization.
* @module dsh-session-persistence-jsonl/zstd-private-decoder
*/
const DECODE_CHUNK_SIZE = 1024 * 1024;
/** Return the stream with its observed private Node contract, or reject that optimization. */
function privateZstdStream(stream) {
	const candidate = stream;
	const handle = candidate._handle;
	const errorKey = Reflect.ownKeys(stream).find((key) => typeof key === "symbol" && key.description === "kError");
	/* v8 ignore next -- one test runtime exposes one Node-private shape; the Node 22/24/26 matrix checks compatibility. */
	if (typeof handle !== "object" || handle === null || typeof handle.writeSync !== "function" || !(candidate._writeState instanceof Uint32Array) || candidate._writeState.length < 2 || typeof candidate._defaultFlushFlag !== "number" || errorKey === void 0 || candidate[errorKey] !== null) return void 0;
	return {
		stream,
		errorKey
	};
}
/**
* Synchronous multi-frame decoder backed by one Node Zstd stream handle. Node
* exposes synchronous decoding only as a one-shot API, so this adapter uses
* the stream's private handle contract to reuse its native context and output
* chunks across frames.
*/
var NodePrivateZstdFrameDecoder = class NodePrivateZstdFrameDecoder {
	stream;
	errorKey;
	output = Buffer.allocUnsafe(DECODE_CHUNK_SIZE);
	decoderError;
	started = false;
	closed = false;
	constructor(stream, errorKey) {
		this.stream = stream;
		this.errorKey = errorKey;
		this.stream.on("error", (error) => {
			this.decoderError ??= error;
		});
	}
	/**
	* Create the optimized decoder when this Node release exposes the expected
	* private stream shape.
	* @returns a shared decoder, or `undefined` when callers must use the public fallback.
	*/
	static create() {
		const stream = createZstdDecompress({ chunkSize: DECODE_CHUNK_SIZE });
		const privateAccess = privateZstdStream(stream);
		/* v8 ignore next -- reached only when a supported Node release changes its private stream shape. */
		if (privateAccess !== void 0) return new NodePrivateZstdFrameDecoder(privateAccess.stream, privateAccess.errorKey);
		/* v8 ignore next -- the active Node runtime passed the private-shape probe above. */
		stream.close();
	}
	/** @inheritdoc */
	*decode(source, frames) {
		if (this.started) throw new Error("Zstandard frame decoder was already started");
		if (this.closed) throw new Error("cannot start a closed Zstandard frame decoder");
		this.started = true;
		try {
			for (const frame of frames) try {
				yield this.decodeFrame(source.subarray(frame.start, frame.end));
			} catch (error) {
				throw new Error(`corrupt Zstandard session log: frame at byte ${frame.start} failed validation`, { cause: error });
			}
		} finally {
			this.close();
		}
	}
	/** Decode one frame; its returned scratch view remains valid until the next call. */
	decodeFrame(input) {
		const handle = this.stream._handle;
		/* v8 ignore next -- decode() rejects closed instances before entering this private frame operation. */
		if (this.closed || handle === null) throw new Error("cannot decode with a closed Zstandard frame decoder");
		let inputOffset = 0;
		let inputRemaining = input.length;
		let outputBytes = 0;
		const fullChunks = [];
		for (;;) {
			handle.writeSync(this.stream._defaultFlushFlag, input, inputOffset, inputRemaining, this.output, 0, this.output.length);
			if (this.decoderError !== void 0) throw this.decoderError;
			const internalError = this.stream[this.errorKey];
			if (internalError !== null) {
				if (internalError instanceof Error) throw internalError;
				throw new Error("Zstandard decoder exposed a non-Error internal failure");
			}
			const outputAfter = this.stream._writeState[0];
			const inputAfter = this.stream._writeState[1];
			const consumed = inputRemaining - inputAfter;
			const produced = this.output.length - outputAfter;
			if (produced > 0) {
				outputBytes += produced;
				/* v8 ignore next -- Buffer cannot materialize a frame beyond its own process-wide maximum length. */
				if (outputBytes > constants$1.MAX_LENGTH) throw new Error(`Zstandard frame output exceeds ${constants$1.MAX_LENGTH} bytes`);
			}
			if (outputAfter !== 0) {
				/* v8 ignore next -- structurally scanned ranges contain exactly one complete frame and no trailing bytes. */
				if (inputAfter !== 0) throw new Error("Zstandard frame decoder left trailing input");
				const finalChunk = this.output.subarray(0, produced);
				if (fullChunks.length === 0) return finalChunk;
				if (produced > 0) fullChunks.push(Buffer.from(finalChunk));
				const onlyChunk = fullChunks[0];
				return fullChunks.length === 1 ? onlyChunk : Buffer.concat(fullChunks, outputBytes);
			}
			fullChunks.push(Buffer.from(this.output));
			inputOffset += consumed;
			inputRemaining = inputAfter;
		}
	}
	/** @inheritdoc */
	close() {
		if (this.closed) return;
		this.closed = true;
		this.stream.close();
	}
};
//#endregion
//#region lib/types/zstd-public-decoder.js
/**
* Public-API synchronous Zstandard frame decoder fallback.
* @module dsh-session-persistence-jsonl/zstd-public-decoder
*/
/** Multi-frame adapter built exclusively from Node's supported one-shot API. */
var PublicZstdFrameDecoder = class {
	started = false;
	closed = false;
	/** @inheritdoc */
	*decode(source, frames) {
		if (this.started) throw new Error("Zstandard frame decoder was already started");
		if (this.closed) throw new Error("cannot start a closed Zstandard frame decoder");
		this.started = true;
		try {
			for (const { start, end } of frames) {
				let decoded;
				try {
					decoded = zstdDecompressSync(source.subarray(start, end));
				} catch (error) {
					throw new Error(`corrupt Zstandard session log: frame at byte ${start} failed validation`, { cause: error });
				}
				yield decoded;
			}
		} finally {
			this.close();
		}
	}
	/** @inheritdoc */
	close() {
		this.closed = true;
	}
};
//#endregion
//#region lib/types/zstd.js
/**
* Zstandard frame primitives for the JSONL persistence backend. The backend
* owns a concatenated-frame container so it can append and recover batches
* without exposing compression mechanics through the persistence seam.
* @module dsh-session-persistence-jsonl/zstd
*/
const ZSTD_MAGIC = 4247762216;
const zstdCompressAsync = promisify(zstdCompress);
const zstdDecompressAsync = promisify(zstdDecompress);
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const INCOMPLETE_FRAME_OPTIONS = { finishFlush: constants.ZSTD_e_flush };
/**
* Locate complete frames without decompressing their blocks. Invalid complete
* structure rejects; EOF inside the final frame returns its start for repair.
* @param buffer - complete bytes currently present in the session artifact.
* @param maxFrames - optional complete-frame limit for metadata-only readers.
* @returns complete frame ranges and an optional incomplete-final-frame start.
*/
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return {
			frames,
			tornStart: start
		};
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
		offset += 4;
		if (offset === buffer.length) return {
			frames,
			tornStart: start
		};
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) return {
			frames,
			tornStart: start
		};
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return {
				frames,
				tornStart: start
			};
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = blockHeader >>> 1 & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) return {
				frames,
				tornStart: start
			};
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return {
				frames,
				tornStart: start
			};
			offset += 4;
		}
		frames.push({
			start,
			end: offset
		});
		if (frames.length === maxFrames) return { frames };
	}
	return { frames };
}
/**
* Compress one independently decodable, checksummed Zstandard frame.
* @param input - JSONL bytes for a header or durable event batch.
* @returns the complete encoded frame.
*/
async function compressZstdFrame(input) {
	return zstdCompressAsync(input, CHECKSUM_OPTIONS);
}
/**
* Decompress one complete frame and validate its checksum.
* @param input - one structurally complete Zstandard frame.
* @returns the frame plaintext.
*/
async function decompressZstdFrame(input) {
	return zstdDecompressAsync(input);
}
/**
* Select the shared private decoder when the running Node 22/24/26 shape is
* compatible, otherwise preserve correctness with the public one-shot API.
* @returns a synchronous decoder with an implementation-independent lifecycle.
*/
function createZstdFrameDecoder() {
	return NodePrivateZstdFrameDecoder.create() ?? new PublicZstdFrameDecoder();
}
/**
* Recover available plaintext from a structurally incomplete final frame.
* `ZSTD_e_flush` deliberately suppresses final-frame and checksum completion;
* callers must establish the torn frame boundary before using this helper.
* @param input - available bytes from a known incomplete Zstandard frame.
* @returns plaintext produced from the available input.
*/
async function decompressZstdPrefix(input) {
	return zstdDecompressAsync(input, INCOMPLETE_FRAME_OPTIONS);
}
//#endregion
//#region lib/types/win32.js
/**
* Windows durable namespace helpers for the JSONL backend.
*
* POSIX publishes a newly-created log by creating a directory entry and then
* fsyncing the parent directory. Windows does not expose that parent-directory
* fsync contract through Node, so the Windows path uses the native durable
* namespace primitive instead: create a staging object in the target directory
* and publish it with `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` without
* replacement or cross-volume copy fallback.
*
* @module dsh-session-persistence-jsonl/win32
*/
const MOVEFILE_WRITE_THROUGH = 8;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_NOT_SAME_DEVICE = 17;
const ERROR_FILE_EXISTS = 80;
const ERROR_INVALID_NAME = 123;
const ERROR_ALREADY_EXISTS = 183;
let bindings;
/** Load the small Win32 API lazily so non-Windows processes never load Koffi. */
async function win32() {
	if (bindings !== void 0) return bindings;
	const kernel32 = (await import("koffi")).default.load("kernel32.dll");
	bindings = {
		moveFileExW: kernel32.func("__stdcall", "MoveFileExW", "int", [
			"str16",
			"str16",
			"uint"
		]),
		getLastError: kernel32.func("__stdcall", "GetLastError", "uint", [])
	};
	return bindings;
}
function errnoCode(win32Code) {
	switch (win32Code) {
		case ERROR_FILE_NOT_FOUND:
		case ERROR_PATH_NOT_FOUND: return "ENOENT";
		case ERROR_ACCESS_DENIED: return "EACCES";
		case ERROR_NOT_SAME_DEVICE: return "EXDEV";
		case ERROR_FILE_EXISTS:
		case ERROR_ALREADY_EXISTS: return "EEXIST";
		case ERROR_INVALID_NAME: return "EINVAL";
		default: return "EIO";
	}
}
function win32Error(syscall, win32Code, path, dest) {
	const code = errnoCode(win32Code);
	const error = /* @__PURE__ */ new Error(`${syscall} ${code} (Win32 ${win32Code}): ${path} -> ${dest}`);
	error.code = code;
	error.errno = win32Code;
	error.syscall = syscall;
	error.path = path;
	error.dest = dest;
	error.win32Code = win32Code;
	return error;
}
function isENOENT$1(error) {
	return error?.code === "ENOENT";
}
function isEEXIST(error) {
	return error?.code === "EEXIST";
}
async function assertDirectory(path) {
	try {
		if ((await stat(path === parse(path).root ? path : toNamespacedPath(path))).isDirectory()) return true;
		const error = /* @__PURE__ */ new Error(`path exists but is not a directory: ${path}`);
		error.code = "ENOTDIR";
		error.path = path;
		throw error;
	} catch (error) {
		if (isENOENT$1(error)) return false;
		throw error;
	}
}
/**
* Publish `existing` at `replacement` with Windows write-through rename
* semantics. The destination must not already exist; the move must stay within
* the volume (no copy fallback flag is set).
* @param existing - the synced staging path to move.
* @param replacement - the final path, which must not already exist.
*/
async function publishNewFileWin32(existing, replacement) {
	const api = await win32();
	if (api.moveFileExW(toNamespacedPath(existing), toNamespacedPath(replacement), MOVEFILE_WRITE_THROUGH) === 0) throw win32Error("MoveFileExW", api.getLastError(), existing, replacement);
}
/**
* Create `target` and its missing ancestors with durable Windows namespace
* publication. Each missing directory is first created as a random staging
* sibling, then moved to its final name with `MOVEFILE_WRITE_THROUGH`; races
* with another creator are accepted only after verifying the winner is a
* directory.
* @param target - the absolute directory path to create durably when absent.
*/
async function ensureDurableDirectoryWin32(target) {
	const absolute = resolve(target);
	const root = parse(absolute).root;
	await assertDirectory(root);
	const segments = absolute.slice(root.length).split(/[\\/]+/).filter((part) => part.length > 0);
	let current = root;
	for (const segment of segments) {
		const next = join(current, segment);
		if (!await assertDirectory(next)) await createLeafDirectoryWin32(current, next);
		current = next;
	}
}
async function createLeafDirectoryWin32(parent, target) {
	const staging = await mkdtemp(toNamespacedPath(join(parent, ".dsh-mkdir-")));
	try {
		await publishNewFileWin32(staging, target);
	} catch (error) {
		await rm(staging, {
			recursive: true,
			force: true
		});
		if (isEEXIST(error) && await assertDirectory(target)) return;
		throw error;
	}
}
//#endregion
//#region lib/types/index.js
/**
* JSONL durable session-persistence backend. It stores a header and contiguous
* events in one append-only file per session, and delegates orchestration to
* {@link PersistenceCoordinator}. Its side-effect-free locator returns the
* absolute per-session log target before materialization.
* @module @deepseek-ai/dsh-session-persistence-jsonl
*/
const DEFAULT_PACK_CHUNKS = true;
const DEFAULT_COMPRESSION = "zstd";
/**
* Internal scheduling constant, not deployment configuration: balance
* frame-boundary event-loop yields against `setImmediate` overhead. One frame
* remains an indivisible synchronous decode.
*/
const ZSTD_DECODE_YIELD_INTERVAL_MS = 500;
/** Assert that the independently decodable first frame contains only the header record. */
function assertZstdHeaderFrame(plaintext) {
	if (plaintext.length === 0 || plaintext.indexOf(10) !== plaintext.length - 1) throw new Error("corrupt Zstandard session log: first frame is not exactly one header line");
}
/** Loader schema for the JSONL artifact's physical encoding. */
const JsonlCompressionSchema = z.union([z.const("zstd"), z.const("none")]).default(DEFAULT_COMPRESSION);
/** Build the source-qualified revision shared by full and lightweight reads. */
function fileRevision(identity) {
	return SessionPersistenceRevision([
		identity.dev,
		identity.ino,
		identity.size,
		identity.mtimeNs,
		identity.ctimeNs
	].join(":"));
}
/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error) {
	return error?.code === "ENOENT";
}
/**
* The JSONL persistence backend. Load as a plugin; it registers as
* `ctx.sessionPersistence` and (via the coordinator) installs the write-path
* listeners. Its torn-tail marker carries the byte offset and any events
* recovered from an incomplete final Zstandard frame.
*/
var JsonlSessionPersistence = class extends SessionPersistence {
	config;
	supportsRawArtifacts = true;
	static inject = ["sessions"];
	static Config = z.object({
		root: z.string().required(),
		packChunks: z.boolean().default(DEFAULT_PACK_CHUNKS),
		compression: JsonlCompressionSchema,
		preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
		writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS).default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS)
	});
	/**
	* Backend label for coordinator diagnostics and effects. It shadows
	* `Service.name` without changing the service key captured by the base
	* constructor.
	*/
	name = "session-persistence-jsonl";
	root;
	packChunks;
	compression;
	coordinator;
	rootEncodingCheck;
	constructor(ctx, config) {
		super(ctx);
		this.config = config;
		this.root = resolve(config.root);
		const preparedSessionCacheSize = config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE;
		const writeBatchMaxDelayMs = config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS;
		this.packChunks = config.packChunks ?? DEFAULT_PACK_CHUNKS;
		this.compression = config.compression ?? DEFAULT_COMPRESSION;
		this.assertUsableRoot();
		this.coordinator = new PersistenceCoordinator(this.ctx, this, {
			preparedSessionCacheSize,
			writeBatchMaxDelayMs
		});
	}
	/** Resolve the absolute target path without touching the filesystem. */
	locate(meta) {
		return {
			kind: "jsonl",
			path: logPath(this.root, meta.cwd, meta.id, this.compression)
		};
	}
	create(meta) {
		return this.coordinator.create(meta);
	}
	append(id, events) {
		return this.coordinator.append(id, events);
	}
	prepare(id, signal) {
		return this.coordinator.prepare(id, signal);
	}
	load(id) {
		return this.coordinator.load(id);
	}
	inspect(id, signal) {
		return this.coordinator.inspect(id, signal);
	}
	readFrom(id, fromSeq, signal) {
		return this.coordinator.readFrom(id, fromSeq, signal);
	}
	/** Read a stored prefix by id across all project directories when cwd is unknown. */
	async loadStored(id, signal) {
		signal?.throwIfAborted();
		await this.ensureRootEncoding();
		signal?.throwIfAborted();
		const path = await this.findLog(id, signal);
		if (path === void 0) return void 0;
		return this.readPrefix(path, id, signal);
	}
	/**
	* Read one log's stat-derived revision without loading its event bytes.
	* Resolving an id with unknown cwd still scans the project directories.
	*/
	async readStoredRevision(id, signal) {
		signal?.throwIfAborted();
		await this.ensureRootEncoding();
		signal?.throwIfAborted();
		const path = await this.findLog(id, signal);
		if (path === void 0) return void 0;
		try {
			const identity = await stat(path, { bigint: true });
			signal?.throwIfAborted();
			return fileRevision(identity);
		} catch (error) {
			signal?.throwIfAborted();
			if (isENOENT(error)) return void 0;
			throw error;
		}
	}
	/**
	* Read a session's stored artifact text verbatim: the durable file bytes
	* decoded from this backend's physical encoding (complete zstd frames
	* concatenated, or UTF-8 plaintext). The content is the exact JSONL text the
	* backend wrote — never a reconstruction from parsed events — so packed-
	* chunk rows, key order, and line breaks survive byte-for-byte. A torn
	* final frame is omitted, matching the committed-prefix semantics of every
	* other read.
	* @param id - the persisted session to read.
	* @param signal - optional cancellation for the stat/read/decode work.
	* @returns the raw artifact text plus the header parsed from its own first
	* line, or `undefined` when the session has no stored artifact.
	*/
	async readRaw(id, signal) {
		signal?.throwIfAborted();
		await this.ensureRootEncoding();
		signal?.throwIfAborted();
		const path = await this.findLog(id, signal);
		if (path === void 0) return void 0;
		const { buffer } = await this.readStableFile(path, signal);
		let content;
		if (this.compression === "zstd") {
			const { frames } = scanZstdFrames(buffer);
			if (frames.length === 0) throw new Error("empty or header-less Zstandard session log");
			const decoder = createZstdFrameDecoder();
			const plaintexts = [];
			for (const plaintext of decoder.decode(buffer, frames)) {
				signal?.throwIfAborted();
				plaintexts.push(Buffer.from(plaintext));
			}
			content = Buffer.concat(plaintexts).toString("utf8");
		} else content = buffer.toString("utf8");
		const meta = parseHeaderMeta(content.split("\n", 1)[0]);
		if (meta === void 0 || meta.id !== id) throw new Error(`corrupt session log: invalid header line in "${path}"`);
		return {
			meta,
			filename: "session.jsonl",
			content
		};
	}
	/**
	* Read a file's bytes under a revision-stable loop: a writer appending
	* between stat and readFile would yield a torn physical file, so retry
	* while the stat revision changes.
	* @param path - the artifact file to read.
	* @param signal - optional cancellation for the stat/read work.
	* @returns the stable bytes and the revision that matched both stats.
	*/
	async readStableFile(path, signal) {
		for (;;) {
			signal?.throwIfAborted();
			const before = fileRevision(await stat(path, { bigint: true }));
			const buffer = await readFile(path, { signal });
			signal?.throwIfAborted();
			const after = fileRevision(await stat(path, { bigint: true }));
			if (before === after) return {
				buffer,
				revision: after
			};
		}
	}
	/**
	* Read a stored prefix and convert torn-tail state to the opaque marker the
	* coordinator can round-trip without knowing the physical encoding.
	*/
	async readPrefix(path, expectedId, signal) {
		const { buffer, revision } = await this.readStableFile(path, signal);
		let prefix;
		try {
			if (this.compression === "zstd") prefix = await this.readZstdPrefix(buffer, signal);
			else {
				signal?.throwIfAborted();
				const { meta, events, committedBytes } = scanLog(buffer);
				signal?.throwIfAborted();
				prefix = {
					meta,
					events,
					...committedBytes < buffer.byteLength ? { tornMarker: {
						truncateTo: committedBytes,
						recoveredEvents: []
					} } : {}
				};
			}
		} catch (error) {
			if (error instanceof SessionFormatUnsupportedError && error.location === void 0) throw new SessionFormatUnsupportedError(`${error.message} (raw log: ${path})`, {
				kind: "jsonl",
				path
			});
			throw error;
		}
		signal?.throwIfAborted();
		await this.assertStoredIdentity(path, prefix.meta, expectedId, signal);
		signal?.throwIfAborted();
		return {
			...prefix,
			revision
		};
	}
	/** Decode complete frames and retain complete JSONL records from a torn final frame. */
	async readZstdPrefix(buffer, signal) {
		signal?.throwIfAborted();
		const { frames, tornStart } = scanZstdFrames(buffer);
		signal?.throwIfAborted();
		if (frames.length === 0) throw new Error("empty or header-less Zstandard session log");
		const decoder = createZstdFrameDecoder();
		let yieldDeadline = performance.now() + ZSTD_DECODE_YIELD_INTERVAL_MS;
		try {
			const decodedFrames = decoder.decode(buffer, frames);
			signal?.throwIfAborted();
			const headerFrame = decodedFrames.next();
			signal?.throwIfAborted();
			/* v8 ignore next -- a non-empty structural frame list makes the decoder yield its first frame or throw. */
			if (headerFrame.done) throw new Error("empty or header-less Zstandard session log");
			assertZstdHeaderFrame(headerFrame.value);
			const scanner = new SessionLogScanner(headerFrame.value);
			let remainingFrames = frames.length - 1;
			for (const plaintext of decodedFrames) {
				signal?.throwIfAborted();
				scanner.write(plaintext);
				remainingFrames -= 1;
				if (remainingFrames > 0 && performance.now() >= yieldDeadline) {
					await scheduler.yield();
					signal?.throwIfAborted();
					yieldDeadline = performance.now() + ZSTD_DECODE_YIELD_INTERVAL_MS;
				}
			}
			signal?.throwIfAborted();
			const complete = scanner.checkpoint();
			if (complete.committedBytes !== complete.inputBytes) throw new Error("corrupt Zstandard session log: complete frame contains a torn JSONL record");
			if (tornStart === void 0) {
				const prefix = scanner.finish();
				return {
					meta: prefix.meta,
					events: prefix.events
				};
			}
			let recoveredPlaintext = Buffer.alloc(0);
			try {
				signal?.throwIfAborted();
				recoveredPlaintext = await decompressZstdPrefix(buffer.subarray(tornStart));
			} catch {
				/* v8 ignore next -- decoder failure plus concurrent abort is timing-dependent */
				if (signal?.aborted) signal.throwIfAborted();
			}
			signal?.throwIfAborted();
			scanner.write(recoveredPlaintext);
			const recoveredPrefix = scanner.finish();
			signal?.throwIfAborted();
			return {
				meta: recoveredPrefix.meta,
				events: recoveredPrefix.events,
				tornMarker: {
					truncateTo: tornStart,
					recoveredEvents: recoveredPrefix.events.slice(complete.eventCount)
				}
			};
		} catch (error) {
			/* v8 ignore next -- decoder failure plus concurrent abort is timing-dependent */
			if (signal?.aborted) signal.throwIfAborted();
			throw error;
		} finally {
			decoder.close();
		}
	}
	/** Durably append a batch, lazily materializing the file when not yet present. */
	async appendBatch(meta, events, isMaterialized) {
		await this.ensureRootEncoding();
		if (isMaterialized) await this.appendLines(meta, events);
		else await this.materialize(meta, events);
	}
	/**
	* Make a crash repair durable: truncate a torn tail, restore complete events
	* decoded from it, then append synthetic closers. Two fsync'd steps — the seam
	* does not require this to be atomic.
	*/
	async commitRepair(meta, tornMarker, closers) {
		if (tornMarker !== void 0) await this.repair(meta, tornMarker.truncateTo);
		const repairedEvents = [...tornMarker?.recoveredEvents ?? [], ...closers];
		if (repairedEvents.length > 0) await this.appendLines(meta, repairedEvents);
	}
	/** List valid unique stored sessions' metadata (header line only — no full-log parse). */
	async list(signal) {
		return (await this.listArtifacts(signal)).map((artifact) => artifact.header);
	}
	/** List metadata plus a stat-derived identity for each append-only log. */
	async listSnapshots(signal) {
		const snapshots = [];
		for (const artifact of await this.listArtifacts(signal)) {
			signal?.throwIfAborted();
			try {
				const identity = await stat(artifact.path, { bigint: true });
				signal?.throwIfAborted();
				snapshots.push({
					header: artifact.header,
					revision: fileRevision(identity)
				});
			} catch (error) {
				signal?.throwIfAborted();
				if (!isENOENT(error)) throw error;
			}
		}
		signal?.throwIfAborted();
		return snapshots;
	}
	async listArtifacts(signal) {
		signal?.throwIfAborted();
		await this.ensureRootEncoding();
		signal?.throwIfAborted();
		const artifacts = [];
		const ids = /* @__PURE__ */ new Set();
		for (const project of await this.listProjectDirs(signal)) {
			signal?.throwIfAborted();
			for (const dir of await this.listSessionDirs(project, signal)) {
				signal?.throwIfAborted();
				const opposite = join(dir, `session${logSuffix(this.oppositeCompression())}`);
				const oppositeExists = await this.exists(opposite);
				signal?.throwIfAborted();
				if (oppositeExists) throw this.encodingMismatch(opposite);
				const path = join(dir, `session${logSuffix(this.compression)}`);
				const pathExists = await this.exists(path);
				signal?.throwIfAborted();
				if (!pathExists) continue;
				const first = this.compression === "zstd" ? await this.readFirstZstdLine(path, signal) : await this.readFirstLine(path, signal);
				signal?.throwIfAborted();
				if (first === void 0) continue;
				const meta = parseHeaderMeta(first);
				if (meta === void 0) continue;
				await this.assertStoredIdentity(path, meta, void 0, signal);
				signal?.throwIfAborted();
				if (ids.has(meta.id)) throw new Error(`duplicate JSONL session id "${meta.id}" appears in multiple project directories`);
				ids.add(meta.id);
				artifacts.push({
					header: meta,
					path
				});
			}
		}
		signal?.throwIfAborted();
		return artifacts;
	}
	/** Atomically write the header line + first batch (temp-write, fsync, publish). */
	async materialize(meta, events) {
		const project = projectDir(this.root, meta.cwd);
		const dir = sessionDir(this.root, meta.cwd, meta.id);
		const finalPath = logPath(this.root, meta.cwd, meta.id, this.compression);
		await this.rejectOppositeArtifact(meta.cwd, meta.id);
		const content = await this.encodeMaterialization(meta, events);
		/* v8 ignore next -- native Windows coverage exercises this platform dispatch; Linux covers the POSIX peer */
		if (process.platform === "win32") await this.materializeWin32(project, dir, finalPath, meta.id, content);
		else await this.materializePosix(project, dir, finalPath, meta.id, content);
	}
	/* v8 ignore start -- Windows uses the Win32 durable-publish path; POSIX coverage exercises this peer. */
	async materializePosix(project, dir, finalPath, id, content) {
		await mkdir(this.root, {
			recursive: true,
			mode: 448
		});
		await this.syncDirPosix(dirname(this.root));
		await mkdir(project, {
			recursive: true,
			mode: 448
		});
		await this.syncDirPosix(this.root);
		await mkdir(dir, {
			recursive: true,
			mode: 448
		});
		await this.syncDirPosix(project);
		await this.rejectExistingLog(finalPath, id);
		const tmp = await this.writeSyncedTempFile(finalPath, content);
		let linked = false;
		try {
			// jsonl-link-eacces-fallback: Android app domains forbid link(2)
			// (sepolicy; Huawei/HarmonyOS observed), fall back to a rename
			// (single-process, same content) like dsh 0.1.0-rc.8 did.
			await link(tmp, finalPath).catch(function (e) { if (e.code !== "EACCES" && e.code !== "EPERM" && e.code !== "ENOTSUP") throw e; return rename(tmp, finalPath); });
			linked = true;
		} finally {
			/* v8 ignore next -- link failure is the TOCTOU/IO race guarded above; not reachable in test */
			if (!linked) await rm(tmp, { force: true });
		}
		await this.syncDirPosix(dir);
		try {
			await rm(tmp, { force: true });
		} catch {}
	}
	/* v8 ignore stop */
	/* v8 ignore start -- native Windows coverage exercises this integration path */
	async materializeWin32(project, dir, finalPath, id, content) {
		await ensureDurableDirectoryWin32(this.root);
		await ensureDurableDirectoryWin32(project);
		await ensureDurableDirectoryWin32(dir);
		await this.rejectExistingLog(finalPath, id);
		const tmp = await this.writeSyncedTempFile(finalPath, content);
		try {
			await publishNewFileWin32(tmp, finalPath);
		} catch (error) {
			await rm(tmp, { force: true });
			throw error;
		}
	}
	/* v8 ignore stop */
	async rejectExistingLog(finalPath, id) {
		/* v8 ignore next 3 -- createCore guards collisions before materialize; this is a TOCTOU backstop */
		if (await this.exists(finalPath)) throw new Error(`refusing to materialize "${id}": a log already exists on disk (load/resume it instead)`);
	}
	async writeSyncedTempFile(finalPath, content) {
		const tmp = `${finalPath}.${randomBytes(6).toString("hex")}.tmp`;
		const handle = await open(tmp, "wx", 384);
		try {
			await handle.writeFile(content);
			await handle.sync();
		} finally {
			await handle.close();
		}
		return tmp;
	}
	/** Encode the header and first batch without combining their frame boundaries. */
	async encodeMaterialization(meta, events) {
		const header = JSON.stringify(toHeaderLine(meta)) + "\n";
		const body = eventLines(events, this.packChunks) + "\n";
		if (this.compression === "none") return header + body;
		const headerFrame = await compressZstdFrame(header);
		const eventFrame = await compressZstdFrame(body);
		return Buffer.concat([headerFrame, eventFrame]);
	}
	/** Encode one durable append batch in the configured physical representation. */
	async encodeEventBatch(events) {
		const body = eventLines(events, this.packChunks) + "\n";
		return this.compression === "zstd" ? compressZstdFrame(body) : body;
	}
	/** fsync a POSIX directory so a just-created/renamed entry is crash-durable. */
	/* v8 ignore start -- Windows uses write-through namespace operations; POSIX coverage exercises directory fsync. */
	async syncDirPosix(dir) {
		const handle = await open(dir, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
	/* v8 ignore stop */
	/**
	* Append and fsync event lines. On a partial write or sync failure, restore the
	* previous size before rethrowing because the unchanged cursor will retry the
	* batch; leaving partial bytes would create duplicate sequence numbers.
	*/
	async appendLines(meta, events) {
		const content = await this.encodeEventBatch(events);
		const path = logPath(this.root, meta.cwd, meta.id, this.compression);
		const handle = await open(path, "a");
		let closed = false;
		const closeAppendHandle = async () => {
			if (closed) return;
			closed = true;
			await handle.close();
		};
		try {
			const { size: before } = await handle.stat();
			try {
				await handle.writeFile(content);
				await handle.sync();
			} catch (error) {
				try {
					await closeAppendHandle();
					await this.rollbackAppend(path, before);
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], `failed to roll back append to "${path}"`);
				}
				throw error;
			}
		} finally {
			await closeAppendHandle();
		}
	}
	async rollbackAppend(path, size) {
		const handle = await open(path, "r+");
		try {
			await handle.truncate(size);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
	/** Truncate the log file to `offset` bytes and fsync (discard the crash tail). */
	async repair(meta, offset) {
		const path = logPath(this.root, meta.cwd, meta.id, this.compression);
		await truncate(path, offset);
		const handle = await open(path, "r+");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
	/**
	* Read the first newline-terminated line of a file without loading the whole
	* file. Returns undefined if the file is empty or has no complete first line.
	* Reads in bounded chunks so a huge log costs only the header read.
	*/
	async readFirstLine(path, signal) {
		signal?.throwIfAborted();
		const handle = await open(path, "r");
		try {
			signal?.throwIfAborted();
			const chunks = [];
			const buf = Buffer.alloc(8192);
			for (;;) {
				signal?.throwIfAborted();
				const { bytesRead } = await handle.read(buf, 0, buf.length, null);
				signal?.throwIfAborted();
				if (bytesRead === 0) return void 0;
				const slice = buf.subarray(0, bytesRead);
				const nl = slice.indexOf(10);
				if (nl !== -1) {
					chunks.push(slice.subarray(0, nl));
					signal?.throwIfAborted();
					return Buffer.concat(chunks).toString("utf8");
				}
				chunks.push(Buffer.from(slice));
			}
		} finally {
			await handle.close();
		}
	}
	/** Read and validate only the independently compressed header frame. */
	async readFirstZstdLine(path, signal) {
		signal?.throwIfAborted();
		const handle = await open(path, "r");
		try {
			signal?.throwIfAborted();
			let content = Buffer.alloc(0);
			const chunk = Buffer.alloc(8192);
			for (;;) {
				signal?.throwIfAborted();
				const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
				signal?.throwIfAborted();
				if (bytesRead === 0) return void 0;
				signal?.throwIfAborted();
				content = Buffer.concat([content, chunk.subarray(0, bytesRead)]);
				signal?.throwIfAborted();
				const first = scanZstdFrames(content, 1).frames[0];
				signal?.throwIfAborted();
				if (first === void 0) continue;
				let plaintext;
				try {
					signal?.throwIfAborted();
					plaintext = await decompressZstdFrame(content.subarray(first.start, first.end));
				} catch (error) {
					/* v8 ignore next -- decoder failure plus concurrent abort is timing-dependent */
					if (signal?.aborted) signal.throwIfAborted();
					throw new Error("corrupt Zstandard session log: header frame failed validation", { cause: error });
				}
				signal?.throwIfAborted();
				assertZstdHeaderFrame(plaintext);
				return plaintext.subarray(0, -1).toString("utf8");
			}
		} finally {
			await handle.close();
		}
	}
	/** Find the unique physical log for an id across every project directory. */
	async findLog(id, signal) {
		const matches = [];
		for (const project of await this.listProjectDirs(signal)) {
			signal?.throwIfAborted();
			await this.rejectLegacyFlatArtifact(project, id, signal);
			signal?.throwIfAborted();
			const dir = join(project, encodeSegment(id));
			const path = join(dir, `session${logSuffix(this.compression)}`);
			const opposite = join(dir, `session${logSuffix(this.oppositeCompression())}`);
			const oppositeExists = await this.exists(opposite);
			signal?.throwIfAborted();
			if (oppositeExists) throw this.encodingMismatch(opposite);
			const pathExists = await this.exists(path);
			signal?.throwIfAborted();
			if (pathExists) matches.push(path);
		}
		if (matches.length > 1) throw new Error(`duplicate JSONL session id "${id}" appears in multiple project directories`);
		signal?.throwIfAborted();
		return matches[0];
	}
	/** Require an existing configured root to be a readable directory. */
	assertUsableRoot() {
		try {
			readdirSync(this.root);
		} catch (error) {
			if (isENOENT(error)) return;
			throw error;
		}
	}
	/** Reject metadata that does not identify the selected physical log. */
	async assertStoredIdentity(path, meta, expectedId, signal) {
		signal?.throwIfAborted();
		if (expectedId !== void 0 && meta.id !== expectedId) throw new Error(`corrupt session log "${path}": requested id "${expectedId}" does not match header id "${meta.id}"`);
		let expectedPath;
		try {
			expectedPath = logPath(this.root, meta.cwd, meta.id, this.compression);
		} catch (error) {
			throw new Error(`corrupt session log "${path}": header id cannot name a storage path`, { cause: error });
		}
		if (path !== expectedPath && !await this.sameFile(path, expectedPath, signal)) throw new Error(`corrupt session log "${path}": header id "${meta.id}" and cwd identify "${expectedPath}"`);
		signal?.throwIfAborted();
	}
	/**
	* Whether two path spellings resolve to the same physical file. This admits
	* case aliases on case-insensitive filesystems without weakening identity
	* checks on case-sensitive stores.
	*/
	async sameFile(path, expectedPath, signal) {
		signal?.throwIfAborted();
		try {
			const [actual, expected] = await Promise.all([realpath(path), realpath(expectedPath)]);
			signal?.throwIfAborted();
			return actual === expected;
		} catch (error) {
			signal?.throwIfAborted();
			/* v8 ignore else -- non-ENOENT realpath failures require an external permission or I/O fault */
			if (isENOENT(error)) return false;
			/* v8 ignore next -- non-ENOENT realpath failures are external I/O faults, propagated unchanged */
			throw error;
		}
	}
	/** The human-readable project directories under the configured root. */
	async listProjectDirs(signal) {
		try {
			signal?.throwIfAborted();
			const entries = await readdir(this.root, { withFileTypes: true });
			signal?.throwIfAborted();
			return entries.filter((e) => e.isDirectory()).map((e) => join(this.root, e.name));
		} catch (error) {
			if (isENOENT(error)) return [];
			throw error;
		}
	}
	/** List session-owned directories and reject the obsolete flat-file layout. */
	async listSessionDirs(project, signal) {
		signal?.throwIfAborted();
		const entries = await readdir(project, { withFileTypes: true });
		signal?.throwIfAborted();
		const legacy = entries.find((entry) => entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zstd")));
		if (legacy !== void 0) throw this.legacyLayout(join(project, legacy.name));
		return entries.filter((entry) => entry.isDirectory()).map((entry) => join(project, entry.name));
	}
	/** Reject a root that already belongs to the other physical encoding. */
	ensureRootEncoding() {
		this.rootEncodingCheck ??= this.checkRootEncoding();
		return this.rootEncodingCheck;
	}
	async checkRootEncoding() {
		for (const project of await this.listProjectDirs()) for (const dir of await this.listSessionDirs(project)) {
			const incompatible = join(dir, `session${logSuffix(this.oppositeCompression())}`);
			if (await this.exists(incompatible)) throw this.encodingMismatch(incompatible);
		}
	}
	async rejectLegacyFlatArtifact(project, id, signal) {
		signal?.throwIfAborted();
		const encoded = encodeSegment(id);
		for (const compression of ["zstd", "none"]) {
			const path = join(project, encoded + logSuffix(compression));
			const artifactExists = await this.exists(path);
			signal?.throwIfAborted();
			if (artifactExists) throw this.legacyLayout(path);
		}
	}
	async rejectOppositeArtifact(cwd, id) {
		const path = logPath(this.root, cwd, id, this.oppositeCompression());
		if (await this.exists(path)) throw this.encodingMismatch(path);
	}
	oppositeCompression() {
		return this.compression === "zstd" ? "none" : "zstd";
	}
	encodingMismatch(path) {
		return /* @__PURE__ */ new Error(`session artifact ${JSON.stringify(path)} uses ${logSuffix(this.oppositeCompression())}, but this backend is configured for compression ${JSON.stringify(this.compression)}; use a separate root or select the matching compression mode`);
	}
	legacyLayout(path) {
		return /* @__PURE__ */ new Error(`session artifact ${JSON.stringify(path)} uses the unsupported flat-file layout; use a separate root or move it into a project/session directory before loading`);
	}
	async exists(path) {
		try {
			await (await open(path, "r")).close();
			return true;
		} catch (error) {
			/* v8 ignore else -- Windows reports file-valued parents as ENOENT; POSIX covers direct ENOTDIR. */
			if (isENOENT(error)) {
				await this.assertLogParentAllowsAbsence(path);
				return false;
			}
			/* v8 ignore next -- Windows repairs ENOTDIR from ENOENT above; POSIX covers direct ENOTDIR. */
			throw error;
		}
	}
	/* v8 ignore start -- native Windows coverage exercises this repair; POSIX open reports ENOTDIR before this point. */
	async assertLogParentAllowsAbsence(path) {
		try {
			const parent = dirname(path);
			if ((await stat(parent)).isDirectory()) return;
			const error = /* @__PURE__ */ new Error(`ENOTDIR: parent path exists but is not a directory: ${parent}`);
			error.code = "ENOTDIR";
			error.path = parent;
			throw error;
		} catch (error) {
			if (isENOENT(error)) return;
			throw error;
		}
	}
};
//#endregion
export { JsonlCompressionSchema, JsonlSessionPersistence, JsonlSessionPersistence as default };
