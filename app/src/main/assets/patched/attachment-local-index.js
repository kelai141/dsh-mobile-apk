import { dirname, join, parse, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { AttachmentError, AttachmentId, AttachmentStore, ImageVariantId } from "@deepseek-ai/dsh-attachment";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
let sharpModule = void 0;
async function requireSharp() {
	if (sharpModule === void 0) {
		try {
			sharpModule = await import("sharp");
		} catch (error) {
			throw new AttachmentError("Image processing unavailable on this platform", "IMAGE_PROCESSING_UNAVAILABLE", { cause: error });
		}
	}
	return sharpModule.default;
}
//#region lib/types/compression-limiter.js
/** Instance-owned concurrency bound for native image transformations. */
/** FIFO limiter for asynchronous compression work. */
var CompressionLimiter = class {
	concurrency;
	active = 0;
	waiting = [];
	/**
	* @param concurrency - positive maximum number of active tasks.
	*/
	constructor(concurrency) {
		this.concurrency = concurrency;
	}
	/**
	* Run one task after an instance slot becomes available.
	* @param task - compression operation occupying one slot until settlement.
	* @returns the task result.
	*/
	run(task) {
		return new Promise((resolve, reject) => {
			const start = () => {
				this.active += 1;
				const release = () => {
					this.active -= 1;
					this.waiting.shift()?.();
				};
				Promise.resolve().then(task).then((value) => {
					release();
					resolve(value);
				}, (error) => {
					release();
					reject(error instanceof Error ? error : new Error("Image compression task rejected with a non-Error value.", { cause: error }));
				});
			};
			if (this.active < this.concurrency) start();
			else this.waiting.push(start);
		});
	}
};
//#endregion
//#region lib/types/encoding.js
/** Shared lazy candidate execution for normalization and request-image encoders. */
/**
* Execute encoding candidates in preference order and stop after the first fitting output.
* @param attempts - lazy encoders ordered from preferred to fallback representation.
* @param maxBytes - positive encoded-byte cap.
* @returns the first fitting candidate, otherwise the smallest completed fallback.
*/
async function encodeFirstWithinLimit(attempts, maxBytes) {
	const [first, ...remaining] = attempts;
	if (first === void 0) throw new Error("image encoding requires at least one candidate");
	let smallest = await first();
	if (smallest.data.byteLength <= maxBytes) return smallest;
	for (const attempt of remaining) {
		const candidate = await attempt();
		if (candidate.data.byteLength <= maxBytes) return candidate;
		if (candidate.data.byteLength < smallest.data.byteLength) smallest = candidate;
	}
	return { smallest };
}
/**
* Whether a lazy encoding result exhausted every candidate at one size.
* @param result - first fitting candidate or exhausted result.
* @returns whether every candidate exceeded the byte cap.
*/
function isExhaustedEncoding(result) {
	return "smallest" in result;
}
//#endregion
//#region lib/types/image.js
/** Raster inspection: full decode at admission, header-only probe on verified reads. */
/**
* Check alpha metadata for bytes produced by this package's encoders.
* Sharp/libvips may omit an all-opaque alpha plane from WebP output; every
* other addition or removal indicates that the encoded result is incompatible
* with its source facts.
* @param sourceHasAlpha - whether the source bytes declare an alpha plane, or undefined when the source frame is unspecified.
* @param output - decoded media type and alpha metadata from the encoded result.
* @returns whether the output alpha metadata is compatible with the source.
*/
function encodedAlphaIsCompatible(sourceHasAlpha, output) {
	return sourceHasAlpha === void 0 || output.hasAlpha === sourceHasAlpha || sourceHasAlpha && !output.hasAlpha && output.mediaType === "image/webp";
}
const MEDIA_TYPES = {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif"
};
function carriesRetainedMetadata(metadata) {
	return metadata.exif !== void 0 || metadata.xmp !== void 0 || metadata.iptc !== void 0 || metadata.icc !== void 0 || metadata.hasProfile || metadata.tifftagPhotoshop !== void 0 || metadata.comments !== void 0 || metadata.orientation !== void 0;
}
async function imageMetadata(image) {
	const metadata = await image.metadata();
	const mediaType = MEDIA_TYPES[metadata.format];
	if (mediaType === void 0) throw new AttachmentError("Unsupported or malformed image data.", "INVALID_IMAGE");
	const transposed = metadata.orientation !== void 0 && metadata.orientation >= 5;
	return {
		mediaType,
		width: transposed ? metadata.height : metadata.width,
		height: transposed ? metadata.width : metadata.height,
		animated: (metadata.pages ?? 1) > 1,
		carriesMetadata: carriesRetainedMetadata(metadata),
		depth: metadata.depth,
		space: metadata.space,
		hasAlpha: metadata.hasAlpha
	};
}
/**
* Parse a supported raster's header and return its intrinsic metadata without
* decoding pixels. Digest-verified reads use this: admission already proved
* that these exact bytes decode completely, so the read path only re-derives
* the reference fields instead of paying the full-raster decode again.
* @param data - complete encoded image bytes.
* @returns verified format and dimensions.
*/
async function probeImage(data) {
	const sharp = await requireSharp();
	try {
		return await imageMetadata(sharp(data, {
			failOn: "error",
			limitInputPixels: false
		}));
	} catch (error) {
		if (error instanceof AttachmentError) throw error;
		throw new AttachmentError("Unsupported or malformed image data.", "INVALID_IMAGE", { cause: error });
	}
}
/**
* Fully decode a supported raster and return its intrinsic metadata.
* @param data - complete encoded image bytes.
* @param limits - intrinsic-dimension admission limits.
* @returns verified format and dimensions.
*/
async function detectImage(data, limits) {
	const sharp = await requireSharp();
	try {
		const image = sharp(data, {
			failOn: "error",
			limitInputPixels: false
		});
		const detected = await imageMetadata(image);
		if (limits?.maxPixels !== void 0 && detected.width * detected.height > limits.maxPixels) throw new AttachmentError("Image exceeds the configured decoded-pixel limit.", "IMAGE_TOO_MANY_PIXELS");
		if (limits?.maxDimension !== void 0 && Math.max(detected.width, detected.height) > limits.maxDimension) throw new AttachmentError("Image exceeds the configured per-side pixel limit.", "IMAGE_DIMENSION_TOO_LARGE");
		await image.raw().toBuffer();
		return detected;
	} catch (error) {
		if (error instanceof AttachmentError) throw error;
		throw new AttachmentError("Unsupported or malformed image data.", "INVALID_IMAGE", { cause: error });
	}
}
//#endregion
//#region lib/types/normalization.js
/** Deterministic provider-independent image normalization. */
const NORMALIZATION_QUALITIES = [
	85,
	80,
	75
];
const LOW_COLOUR_SAMPLE_EDGE = 128;
const LOW_COLOUR_LIMIT = 256;
const MIN_SCALE_STEP = .9;
/** Encode one prepared pipeline and report exact output facts. */
async function encode(pipeline, mediaType, quality, palette = true) {
	const { data, info } = await (mediaType === "image/png" ? pipeline.png({
		compressionLevel: 9,
		palette
	}) : mediaType === "image/webp" ? pipeline.webp({ quality }) : pipeline.jpeg({ quality })).toBuffer({ resolveWithObject: true });
	return {
		data: new Uint8Array(data),
		mediaType,
		width: info.width,
		height: info.height
	};
}
/**
* Whether bytes already satisfy the normalization requirements.
* @param detected - fully decoded source facts.
* @param bytes - encoded source length.
* @param policy - resolved normalization limits.
* @returns whether the source can pass through byte-identically.
*/
function canPassThroughNormalization(detected, bytes, policy) {
	return detected.mediaType !== "image/gif" && !detected.animated && !detected.carriesMetadata && detected.depth === "uchar" && detected.space === "srgb" && bytes <= policy.maxBytes && Math.max(detected.width, detected.height) <= policy.maxDimension;
}
/**
* Classify a bounded pixel sample without assuming that a PNG source is a screenshot.
* @param pipeline - oriented sRGB source pipeline before output resizing.
* @returns whether the nearest-neighbour sample stays within the low-color threshold.
*/
async function hasLowColourCount(pipeline) {
	const sharp = await requireSharp();
	const { data, info } = await pipeline.clone().resize({
		width: LOW_COLOUR_SAMPLE_EDGE,
		height: LOW_COLOUR_SAMPLE_EDGE,
		fit: "inside",
		withoutEnlargement: true,
		kernel: sharp.kernel.nearest,
		fastShrinkOnLoad: false
	}).raw().toBuffer({ resolveWithObject: true });
	const colours = /* @__PURE__ */ new Set();
	for (let offset = 0; offset < data.length; offset += info.channels) {
		const red = data.readUInt8(offset);
		const green = data.readUInt8(offset + 1);
		const blue = data.readUInt8(offset + 2);
		const alpha = info.channels === 4 ? data.readUInt8(offset + 3) : 255;
		colours.add(red >> 3 << 15 | green >> 3 << 10 | blue >> 3 << 5 | alpha >> 3);
		if (colours.size > LOW_COLOUR_LIMIT) return false;
	}
	return true;
}
/** Assert that a normalized output is an 8-bit sRGB/sRGBA single-frame image with matching facts. */
async function verifyNormalizedImage(image, expectedAlpha) {
	const detected = await detectImage(image.data);
	if (detected.mediaType !== image.mediaType || detected.width !== image.width || detected.height !== image.height || detected.animated || detected.carriesMetadata || detected.depth !== "uchar" || detected.space !== "srgb" || !encodedAlphaIsCompatible(expectedAlpha, detected)) throw new AttachmentError("Image normalization did not produce a single-frame 8-bit sRGB image with matching metadata.", "ATTACHMENT_WRITE_FAILED");
	return image;
}
/** Build one fixed-size, oriented, metadata-free sRGB pipeline from submitted bytes. */
async function preparedPipeline(data, width, height) {
	const sharp = await requireSharp();
	return sharp(data, {
		failOn: "error",
		limitInputPixels: false
	}).rotate().toColourspace("srgb").resize({
		width,
		height,
		fit: "inside",
		withoutEnlargement: true
	});
}
/** Dimensions after the long edge is capped without changing aspect ratio. */
function initialDimensions(detected, maxDimension) {
	const scale = Math.min(1, maxDimension / Math.max(detected.width, detected.height));
	return {
		width: Math.max(1, Math.round(detected.width * scale)),
		height: Math.max(1, Math.round(detected.height * scale))
	};
}
/** Lazy encoding order for one size, separated by sampled colour complexity and alpha. */
async function encodingAttemptsAtSize(data, width, height, hasAlpha, lowColour) {
	const prepared = await preparedPipeline(data, width, height);
	const webp = NORMALIZATION_QUALITIES.map((quality) => (() => encode(prepared.clone(), "image/webp", quality)));
	if (lowColour) return [() => encode(prepared.clone(), "image/png", void 0, !hasAlpha), ...webp];
	if (hasAlpha) return webp;
	return NORMALIZATION_QUALITIES.map((quality) => (() => encode(prepared.clone(), "image/jpeg", quality)));
}
/**
* Produce the persisted provider-independent normalized version of one fully decoded source.
* The source is passed through only when it is already clean, single-frame, 8-bit sRGB/sRGBA,
* and inside both normalization limits. Re-encoding never removes transparency. After the fixed
* quality floor is reached, dimensions continue shrinking until the independent byte cap holds.
* @param data - complete admitted source bytes.
* @param detected - fully decoded source facts.
* @param policy - resolved independent normalization limits.
* @returns verified provider-independent normalized bytes and metadata.
*/
async function normalizeImage(data, detected, policy) {
	const sharp = await requireSharp();
	if (canPassThroughNormalization(detected, data.byteLength, policy)) return {
		data,
		mediaType: detected.mediaType,
		width: detected.width,
		height: detected.height
	};
	try {
		let { width, height } = initialDimensions(detected, policy.maxDimension);
		const lowColour = await hasLowColourCount(sharp(data, {
			failOn: "error",
			limitInputPixels: false
		}).rotate().toColourspace("srgb"));
		for (;;) {
			const encoded = await encodeFirstWithinLimit(await encodingAttemptsAtSize(data, width, height, detected.hasAlpha, lowColour), policy.maxBytes);
			if (!isExhaustedEncoding(encoded)) return await verifyNormalizedImage(encoded, detected.mediaType === "image/gif" ? void 0 : detected.hasAlpha);
			if (width === 1 && height === 1) break;
			const sizeScale = Math.sqrt(policy.maxBytes / encoded.smallest.data.byteLength) * .95;
			const scale = Math.min(MIN_SCALE_STEP, sizeScale);
			const nextWidth = Math.max(1, Math.floor(width * scale));
			const nextHeight = Math.max(1, Math.floor(height * scale));
			width = nextWidth;
			height = nextHeight;
		}
	} catch (error) {
		if (error instanceof AttachmentError) throw error;
		throw new AttachmentError(`The ${detected.mediaType === "image/png" && detected.depth !== "uchar" ? `${detected.depth === "ushort" ? "16-bit" : detected.depth} PNG` : `${detected.depth} ${detected.mediaType.slice(6).toUpperCase()}`} could not be converted to the normalized 8-bit sRGB form.`, "ATTACHMENT_WRITE_FAILED", { cause: error });
	}
	throw new AttachmentError("Image cannot be encoded within the configured normalized-image byte cap.", "IMAGE_TOO_LARGE");
}
//#endregion
//#region lib/types/store.js
/** Content-addressed, owner-private local attachment storage. */
const ID_PATTERN = /^sha256:([a-f0-9]{64})$/;
const durableHomes = /* @__PURE__ */ new Set();
function digest$1(data) {
	return createHash("sha256").update(data).digest("hex");
}
function displayName(value) {
	if (value === void 0) return void 0;
	const clean = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
	return clean === "" ? void 0 : clean;
}
function objectPath(root, sha256) {
	return join(root, "objects", sha256.slice(0, 2), sha256);
}
function ensureReference(ref) {
	const match = ID_PATTERN.exec(String(ref.attachmentId));
	if (match?.[1] === void 0) throw new AttachmentError("Attachment reference is invalid.", "INVALID_ATTACHMENT_REF");
	return match[1];
}
async function inspectMetadata(data, declaredMediaType, limits) {
	if (data.byteLength === 0) throw new AttachmentError("Image is empty.", "INVALID_IMAGE");
	const detected = await detectImage(data, {
		maxPixels: limits.maxImagePixels,
		maxDimension: limits.maxImageDimension
	});
	if (detected.mediaType !== declaredMediaType) throw new AttachmentError("Declared image type does not match its bytes.", "IMAGE_TYPE_MISMATCH");
	return detected;
}
/**
* Run the full admission policy for one image without touching storage,
* including normalization: a batch whose members all validate cannot later
* be refused by the normalized image byte cap during publication.
* @param input - encoded bytes and declared metadata.
* @param limits - resolved source admission policy.
* @param policy - resolved normalization policy.
* @returns completion after the raster has been decoded and its normalized version proven to fit.
*/
async function validateImageFile(input, limits, policy) {
	await prepareImageFile(input, limits, policy);
}
/**
* Decode, normalize, and verify one submitted image without touching storage.
* @param input - submitted encoded bytes and declared media type.
* @param limits - source admission policy.
* @param policy - independent normalization policy.
* @returns immutable reference facts beside bytes ready for atomic publication.
*/
async function prepareImageFile(input, limits, policy) {
	if (input.data.byteLength > limits.maxImageBytes) throw new AttachmentError("Image exceeds the configured byte limit.", "IMAGE_TOO_LARGE");
	const detected = await inspectMetadata(input.data, input.mediaType, limits);
	const normalized = await normalizeImage(input.data, detected, policy);
	const sha256 = digest$1(normalized.data);
	const name = displayName(input.name);
	const downscaled = detected.width !== normalized.width || detected.height !== normalized.height;
	return {
		data: normalized.data,
		ref: {
			attachmentId: AttachmentId(`sha256:${sha256}`),
			mediaType: normalized.mediaType,
			width: normalized.width,
			height: normalized.height,
			bytes: normalized.data.byteLength,
			...name !== void 0 ? { name } : {},
			...downscaled ? { originalDimensions: {
				width: detected.width,
				height: detected.height
			} } : {}
		}
	};
}
/**
* Make a directory's entries durable (fsync on a read-only directory handle).
* A synced file alone does not survive a crash when its directory entry never
* reached storage, so the publication directory is synced before a durable
* reference is reported.
*/
async function syncDirectory(path) {
	/* v8 ignore next -- Windows cannot open directory handles; NTFS metadata journaling owns entry durability there. */
	if (process.platform === "win32") return;
	/* v8 ignore start -- Windows cannot exercise directory fsync; POSIX behavior tests enforce this peer. */
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY);
		await handle.sync();
	} catch (error) {
		// Android: cannot open ancestor dirs above the app data dir (EACCES/EPERM on /data/user/0).
		// (attachment-ancestor-sync-eacces-tolerance)
		if (error !== null && (error.code === "EACCES" || error.code === "EPERM")) return;
		throw error;
	} finally {
		try {
			await handle?.close();
		} catch {}
	}
	/* v8 ignore stop */
}
/**
* Create one private directory tree and persist every ancestor entry up to a
* caller-vouched durable boundary. The walk deliberately ignores what mkdir
* reports as newly created: a concurrent first save can create a level this
* process then merely observes, so "already existed" is not "already durable"
* — the entry may still be unsynced in the creator, and a crash would drop a
* directory the session checkpoint already references. Re-syncing a durable
* entry is harmless; skipping an unsynced one is not.
* @param path - absolute directory to create.
* @param boundary - absolute ancestor the caller vouches is already durable.
*/
async function ensureDurableDirectory(path, boundary) {
	const target = resolve(path);
	const stop = resolve(boundary);
	await mkdir(target, {
		recursive: true,
		mode: 448
	});
	await chmod(target, 448);
	let level = target;
	while (level !== stop) {
		const parent = dirname(level);
		await syncDirectory(parent);
		/* v8 ignore next -- filesystem-root guard: callers pass a boundary that is an ancestor of path, so the walk reaches it first. */
		if (parent === level) return;
		level = parent;
	}
}
/**
* Establish this process's proof that one DSH_HOME entry and every ancestor
* below the filesystem root are durable. Mere existence is insufficient: a
* concurrent process may have created the directory but not synced its parent.
*/
async function ensureDurableHome(path) {
	const home = resolve(path);
	if (!durableHomes.has(home)) {
		await ensureDurableDirectory(home, parse(home).root);
		durableHomes.add(home);
	}
	return home;
}
/**
* Publish one already verified normalized image below a versioned attachment root.
* @param root - absolute `DSH_HOME/attachments/v1` root.
* @param prepared - deterministic normalized bytes and reference.
* @returns durable content-addressed normalized image reference.
*/
async function commitPreparedImageFile(root, prepared) {
	const normalized = prepared.data;
	const sha256 = ensureReference(prepared.ref);
	if (digest$1(normalized) !== sha256 || normalized.byteLength !== prepared.ref.bytes) throw new AttachmentError("Prepared attachment bytes do not match their reference.", "ATTACHMENT_CORRUPT");
	const bucket = join(root, "objects", sha256.slice(0, 2));
	const staging = join(root, "tmp");
	const boundary = await ensureDurableHome(dirname(dirname(resolve(root))));
	await ensureDurableDirectory(bucket, boundary);
	await ensureDurableDirectory(staging, boundary);
	const temporary = join(staging, randomUUID());
	const target = objectPath(root, sha256);
	let handle;
	try {
		handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 384);
		await handle.writeFile(normalized);
		await handle.sync();
		await handle.close();
		handle = void 0;
		try {
			await link(temporary, target);
		} catch (error) {
			/* Android app domains forbid link(2) (sepolicy /data/user/0): fall back to an atomic
			   rename of the same-filesystem staging file (same mechanism as fs-local /
			   session-persistence-jsonl). EEXIST remains the only recoverable link race. */
			if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOTSUP" || error.code === "EXDEV")) {
				let exists;
				try { await lstat(target); exists = true; } catch (e2) { if (e2.code === "ENOENT") exists = false; else throw e2; }
				if (exists) throw error;
				await rename(temporary, target);
			} else if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
				throw error;
			} else {
				if (digest$1(new Uint8Array(await readFile(target))) !== sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");
			}
		}
		await syncDirectory(bucket);
		await syncDirectory(join(root, "objects"));
		await unlink(temporary).catch(() => {});
	} catch (error) {
		/* v8 ignore next -- A descriptor can remain open only when the underlying write/sync/close operation fails. */
		if (handle !== void 0) await handle.close().catch(
			/* v8 ignore next -- Close failure is superseded by the storage operation that entered cleanup. */
			() => {}
		);
		await unlink(temporary).catch(
			/* v8 ignore next -- The callback requires a second independent staging-unlink failure. */
			(cleanupError) => {
				/* v8 ignore next -- Cleanup is best-effort only for a staging file already removed by a failed operation. */
				if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) throw cleanupError;
			}
		);
		if (error instanceof AttachmentError) throw error;
		throw new AttachmentError("Unable to persist image attachment.", "ATTACHMENT_WRITE_FAILED", { cause: error });
	}
	return prepared.ref;
}
/**
* Decode and normalize one image once, then publish the prepared object.
* @param root - absolute `DSH_HOME/attachments/v1` root.
* @param input - submitted encoded bytes and declared media type.
* @param limits - resolved source admission policy.
* @param policy - resolved normalization policy.
* @returns durable content-addressed normalized image reference.
*/
async function saveImageFile(root, input, limits, policy) {
	return commitPreparedImageFile(root, await prepareImageFile(input, limits, policy));
}
/**
* Read and verify one content-addressed image.
* @param root - absolute `DSH_HOME/attachments/v1` root.
* @param ref - reference recorded in the session log.
* @param signal - optional cancellation for filesystem and verification work.
* @returns verified bytes and reference.
* @throws the signal reason when aborted, or an AttachmentError when verification fails.
*/
async function readImageFile(root, ref, signal) {
	signal?.throwIfAborted();
	const sha256 = ensureReference(ref);
	let data;
	try {
		data = new Uint8Array(await readFile(objectPath(root, sha256), { signal }));
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new AttachmentError("Attachment object is missing.", "ATTACHMENT_NOT_FOUND");
		throw new AttachmentError("Unable to read image attachment.", "ATTACHMENT_READ_FAILED", { cause: error });
	}
	signal?.throwIfAborted();
	if (digest$1(data) !== sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");
	const metadata = await probeImage(data);
	signal?.throwIfAborted();
	if (metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes || metadata.width !== ref.width || metadata.height !== ref.height) throw new AttachmentError("Stored attachment metadata does not match its reference.", "ATTACHMENT_CORRUPT");
	return {
		ref,
		data
	};
}
//#endregion
//#region lib/types/request-image.js
/** Deterministic cached image versions for model requests. */
/** Transform version included in every cache and upload-index identity. */
const REQUEST_IMAGE_TRANSFORM_VERSION = "request-image-v4";
/** DeepSeek request versions normally fit at these two preferred qualities. */
const REQUEST_IMAGE_QUALITIES = [85, 80];
function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}
/**
* Compute aspect-preserving integer dimensions within a hard total-pixel budget.
* @param width - positive source width.
* @param height - positive source height.
* @param maxPixels - positive width-times-height cap.
* @returns inward-rounded dimensions; small images are not enlarged.
*/
function requestImageDimensions(width, height, maxPixels) {
	const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
	if (scale === 1) return {
		width,
		height
	};
	if (width >= height) {
		let projectedWidth = Math.max(1, Math.floor(width * scale));
		let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
		while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
			projectedWidth -= 1;
			projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
		}
		return {
			width: projectedWidth,
			height: projectedHeight
		};
	}
	let projectedHeight = Math.max(1, Math.floor(height * scale));
	let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
	while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
		projectedHeight -= 1;
		projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
	}
	return {
		width: projectedWidth,
		height: projectedHeight
	};
}
function checkedInteger(value, name) {
	if (!Number.isSafeInteger(value) || value <= 0) throw new AttachmentError(`${name} must be a positive integer.`, "INVALID_ATTACHMENT_REF");
	return value;
}
function validatePolicy(policy) {
	checkedInteger(policy.maxPixels, "Image request maxPixels");
	checkedInteger(policy.maxBytes, "Image request maxBytes");
}
function descriptor(attachment, policy) {
	return JSON.stringify({
		transformVersion: REQUEST_IMAGE_TRANSFORM_VERSION,
		attachmentId: attachment.attachmentId,
		routePixelBudget: policy.maxPixels,
		encodedByteBudget: policy.maxBytes,
		encoding: {
			png: {
				compressionLevel: 9,
				palette: "opaque-only"
			},
			webpQualities: REQUEST_IMAGE_QUALITIES,
			jpegQualities: REQUEST_IMAGE_QUALITIES,
			order: [
				"low-colour:png-webp",
				"alpha:webp",
				"opaque:jpeg"
			],
			colourspace: "srgb"
		}
	});
}
/**
* Complete deterministic identity for one attachment and route-owned request policy.
* @param attachment - provider-independent durable normalized attachment reference.
* @param policy - route-owned pixel and byte policy.
* @returns branded digest over every request transform input.
*/
function requestImageVariantId(attachment, policy) {
	return ImageVariantId(`sha256:${digest(descriptor(attachment, policy))}`);
}
async function pipeline(attachment, width, height) {
	return (await sourcePipeline(attachment)).resize({
		width,
		height,
		fit: "inside",
		withoutEnlargement: true
	});
}
async function sourcePipeline(attachment) {
	const sharp = await requireSharp();
	return sharp(attachment.data, {
		failOn: "error",
		limitInputPixels: false
	}).toColourspace("srgb");
}
async function encoded(image, mediaType, quality, palette = true) {
	const { data, info } = await (mediaType === "image/png" ? image.png({
		compressionLevel: 9,
		palette
	}) : mediaType === "image/webp" ? image.webp({ quality }) : image.jpeg({ quality })).toBuffer({ resolveWithObject: true });
	return {
		data: new Uint8Array(data),
		mediaType,
		width: info.width,
		height: info.height
	};
}
async function encodingAttempts(attachment, width, height, hasAlpha, lowColour) {
	const prepared = await pipeline(attachment, width, height);
	const webp = REQUEST_IMAGE_QUALITIES.map((quality) => (() => encoded(prepared.clone(), "image/webp", quality)));
	if (lowColour) return [() => encoded(prepared.clone(), "image/png", void 0, !hasAlpha), ...webp];
	if (hasAlpha) return webp;
	return REQUEST_IMAGE_QUALITIES.map((quality) => (() => encoded(prepared.clone(), "image/jpeg", quality)));
}
async function createRequestImage(attachment, policy, hasAlpha) {
	let dimensions = requestImageDimensions(attachment.ref.width, attachment.ref.height, policy.maxPixels);
	if (dimensions.width === attachment.ref.width && dimensions.height === attachment.ref.height && attachment.data.byteLength <= policy.maxBytes) return {
		data: attachment.data,
		mediaType: attachment.ref.mediaType,
		width: attachment.ref.width,
		height: attachment.ref.height
	};
	const lowColour = await hasLowColourCount(await sourcePipeline(attachment));
	for (;;) {
		const encodedVersion = await encodeFirstWithinLimit(await encodingAttempts(attachment, dimensions.width, dimensions.height, hasAlpha, lowColour), policy.maxBytes);
		if (!isExhaustedEncoding(encodedVersion)) return encodedVersion;
		if (dimensions.width === 1 && dimensions.height === 1) break;
		const scale = Math.min(.9, Math.sqrt(policy.maxBytes / encodedVersion.smallest.data.byteLength) * .95);
		dimensions = {
			width: Math.max(1, Math.floor(dimensions.width * scale)),
			height: Math.max(1, Math.floor(dimensions.height * scale))
		};
	}
	throw new AttachmentError("Image cannot be encoded within the model-request byte budget.", "IMAGE_TOO_LARGE");
}
function cachePath(root, hash) {
	return join(root, "request-images", hash.slice(0, 2), hash);
}
async function readCached(path, attachment, policy, expectedAlpha, signal) {
	try {
		const data = new Uint8Array(await readFile(path, { signal }));
		const detected = await probeImage(data);
		const maximum = requestImageDimensions(attachment.ref.width, attachment.ref.height, policy.maxPixels);
		if (data.byteLength > policy.maxBytes || detected.depth !== "uchar" || detected.space !== "srgb" || detected.width > maximum.width || detected.height > maximum.height || !encodedAlphaIsCompatible(expectedAlpha, detected)) return void 0;
		return {
			data,
			mediaType: detected.mediaType,
			width: detected.width,
			height: detected.height,
			hasAlpha: detected.hasAlpha
		};
	} catch (error) {
		if (error?.code === "ENOENT") return void 0;
		signal?.throwIfAborted();
		return;
	}
}
async function verifyRequestImage(image, expectedAlpha) {
	const detected = await detectImage(image.data);
	if (detected.depth !== "uchar" || detected.space !== "srgb" || detected.width !== image.width || detected.height !== image.height || detected.mediaType !== image.mediaType || !encodedAlphaIsCompatible(expectedAlpha, detected)) throw new AttachmentError("Encoded model-request image does not match its verified 8-bit sRGB metadata.", "ATTACHMENT_WRITE_FAILED");
	return {
		...image,
		hasAlpha: detected.hasAlpha
	};
}
async function writeCached(path, data) {
	await mkdir(dirname(path), {
		recursive: true,
		mode: 448
	});
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, data, {
			mode: 384,
			flag: "wx"
		});
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}
/**
* Generate or reuse one request image below the local attachment root.
* @param root - absolute versioned attachment storage root.
* @param attachment - verified normalized attachment bytes and reference.
* @param policy - exact route request-image policy.
* @param signal - optional cancellation for cache I/O and image transformation.
* @returns verified request bytes and deterministic variant identity.
*/
async function readRequestImageFile(root, attachment, policy, signal) {
	signal?.throwIfAborted();
	validatePolicy(policy);
	const source = await probeImage(attachment.data);
	const variantId = requestImageVariantId(attachment.ref, policy);
	const path = cachePath(root, String(variantId).slice(7));
	const cached = await readCached(path, attachment, policy, source.hasAlpha, signal);
	const created = cached ?? await createRequestImage(attachment, policy, source.hasAlpha);
	const version = cached ?? (created.data === attachment.data ? {
		...created,
		hasAlpha: source.hasAlpha
	} : await verifyRequestImage(created, source.hasAlpha));
	signal?.throwIfAborted();
	if (cached === void 0 && version.data !== attachment.data) await writeCached(path, version.data);
	return {
		variantId,
		attachment: attachment.ref,
		data: version.data,
		mediaType: version.mediaType,
		bytes: version.data.byteLength,
		width: version.width,
		height: version.height,
		depth: "uchar",
		space: "srgb",
		hasAlpha: version.hasAlpha
	};
}
//#endregion
//#region lib/types/index.js
/** Local durable attachment backend rooted below `DSH_HOME`. @module @deepseek-ai/dsh-attachment-local */
/** Default maximum encoded bytes for one submitted image; oversized sources are refused, not shrunk. */
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Default maximum images in one prompt. */
const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20;
/** Default maximum aggregate image bytes in one prompt. */
const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 200 * 1024 * 1024;
/** Default maximum intrinsic pixels for one submitted image. */
const DEFAULT_MAX_IMAGE_PIXELS = 64e6;
/** Default per-side pixel cap for one submitted image. */
const DEFAULT_MAX_IMAGE_DIMENSION = 8192;
/**
* Default long-edge target of the stored normalized image. A larger source
* is admitted and downscaled to this edge, so admission bounds what rides
* every later model request without refusing ordinary large sources.
*/
const DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION = 2048;
/** Default independent safety cap for one stored normalized image. */
const DEFAULT_NORMALIZED_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** Conservative default number of simultaneous native image transformations per store. */
const DEFAULT_IMAGE_COMPRESSION_CONCURRENCY = 2;
/** Maximum configurable native image transformations per store. */
const MAX_IMAGE_COMPRESSION_CONCURRENCY = 8;
function abortReason(signal) {
	const reason = signal.reason;
	return reason instanceof Error ? reason : new Error("Attachment request cancelled with a non-Error reason.", { cause: reason });
}
var SharedRequest = class {
	controller = new AbortController();
	promise;
	settled = false;
	waiters = 0;
	constructor(start) {
		this.promise = start(this.controller.signal).finally(() => {
			this.settled = true;
		});
	}
	wait(signal) {
		signal?.throwIfAborted();
		this.waiters += 1;
		if (signal === void 0) return this.promise.finally(() => {
			this.release(false);
		});
		let released = false;
		const release = (cancelled) => {
			if (released) return;
			released = true;
			this.release(cancelled, signal);
		};
		return new Promise((resolve, reject) => {
			const abort = () => {
				release(true);
				reject(abortReason(signal));
			};
			signal.addEventListener("abort", abort, { once: true });
			this.promise.then((value) => {
				signal.removeEventListener("abort", abort);
				release(false);
				resolve(value);
			}, (error) => {
				signal.removeEventListener("abort", abort);
				release(false);
				reject(error);
			});
		});
	}
	release(cancelled, signal) {
		this.waiters -= 1;
		if (cancelled && this.waiters === 0 && !this.settled && signal !== void 0) this.controller.abort(abortReason(signal));
	}
};
/** Persistent content-addressed local attachment store. */
var LocalAttachmentStore = class extends AttachmentStore {
	static Config = z.object({
		dshHome: z.string(),
		maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
		maxImagesPerMessage: z.number().step(1).min(1).default(20),
		maxMessageImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
		maxImagePixels: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_PIXELS),
		maxImageDimension: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_DIMENSION),
		normalizedImageMaxDimension: z.number().step(1).min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION),
		normalizedImageMaxBytes: z.number().step(1).min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_BYTES),
		imageCompressionConcurrency: z.number().step(1).min(1).max(8).default(2)
	});
	/** Absolute versioned storage root. */
	root;
	imageLimits;
	/** Resolved provider-independent normalization policy. */
	normalizationPolicy;
	/** Resolved instance-level compression limit. */
	imageCompressionConcurrency;
	compression;
	requestInflight = /* @__PURE__ */ new Map();
	constructor(ctx, config) {
		super(ctx);
		this.root = resolve(join(resolveDshHome(config.dshHome), "attachments", "v1"));
		this.imageLimits = Object.freeze({
			maxImageBytes: config.maxImageBytes ?? 20971520,
			maxImagesPerMessage: config.maxImagesPerMessage ?? 20,
			maxMessageImageBytes: config.maxMessageImageBytes ?? 209715200,
			maxImagePixels: config.maxImagePixels ?? 64e6,
			maxImageDimension: config.maxImageDimension ?? 8192,
			mediaTypes: Object.freeze([
				"image/png",
				"image/jpeg",
				"image/webp",
				"image/gif"
			])
		});
		this.normalizationPolicy = Object.freeze({
			maxDimension: config.normalizedImageMaxDimension ?? 2048,
			maxBytes: config.normalizedImageMaxBytes ?? 4194304
		});
		const compressionConcurrency = config.imageCompressionConcurrency ?? 2;
		if (!Number.isSafeInteger(compressionConcurrency) || compressionConcurrency < 1 || compressionConcurrency > 8) throw new Error(`attachment-local: imageCompressionConcurrency must be an integer from 1 through 8`);
		this.imageCompressionConcurrency = compressionConcurrency;
		this.compression = new CompressionLimiter(compressionConcurrency);
	}
	async validateImage(input) {
		await this.compression.run(() => validateImageFile(input, this.imageLimits, this.normalizationPolicy));
	}
	async saveImages(inputs) {
		this.validateImageBatch(inputs);
		const prepared = await Promise.all(inputs.map((input) => this.compression.run(() => prepareImageFile(input, this.imageLimits, this.normalizationPolicy))));
		const refs = [];
		for (const image of prepared) refs.push(await commitPreparedImageFile(this.root, image));
		return refs;
	}
	async saveImage(input) {
		const prepared = await this.compression.run(() => prepareImageFile(input, this.imageLimits, this.normalizationPolicy));
		return commitPreparedImageFile(this.root, prepared);
	}
	async readImage(ref, signal) {
		return readImageFile(this.root, ref, signal);
	}
	async readImageRequest(ref, policy, signal) {
		return this.requestVersion(ref, policy, void 0, signal);
	}
	requestVersion(ref, policy, stored, signal) {
		signal?.throwIfAborted();
		const variantId = requestImageVariantId(ref, policy);
		const key = String(variantId);
		let operation = this.requestInflight.get(key);
		if (operation?.controller.signal.aborted) {
			this.requestInflight.delete(key);
			operation = void 0;
		}
		if (operation === void 0) {
			const shared = new SharedRequest((sharedSignal) => this.compression.run(async () => readRequestImageFile(this.root, stored ?? await this.readImage(ref, sharedSignal), policy, sharedSignal)));
			operation = shared;
			this.requestInflight.set(key, shared);
			shared.promise.finally(() => {
				if (this.requestInflight.get(key) === shared) this.requestInflight.delete(key);
			}).catch(() => {});
		}
		return operation.wait(signal);
	}
};
//#endregion
export { DEFAULT_IMAGE_COMPRESSION_CONCURRENCY, DEFAULT_MAX_IMAGES_PER_MESSAGE, DEFAULT_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_DIMENSION, DEFAULT_MAX_IMAGE_PIXELS, DEFAULT_MAX_MESSAGE_IMAGE_BYTES, DEFAULT_NORMALIZED_IMAGE_MAX_BYTES, DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION, LocalAttachmentStore, LocalAttachmentStore as default, MAX_IMAGE_COMPRESSION_CONCURRENCY, canPassThroughNormalization, commitPreparedImageFile, normalizeImage, prepareImageFile, readImageFile, readRequestImageFile, requestImageDimensions, requestImageVariantId, saveImageFile, validateImageFile };
