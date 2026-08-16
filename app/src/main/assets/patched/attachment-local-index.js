import { dirname, join, parse, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { AttachmentError, AttachmentId, AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import sharp from "sharp";
//#region lib/types/image.js
/** Raster inspection: full decode at admission, header-only probe on verified reads. */
const MEDIA_TYPES = {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif"
};
async function imageMetadata(image) {
	const metadata = await image.metadata();
	const mediaType = MEDIA_TYPES[metadata.format];
	if (mediaType === void 0) throw new AttachmentError("Unsupported or malformed image data.", "INVALID_IMAGE");
	return {
		mediaType,
		width: metadata.width,
		height: metadata.height
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
* @param maxPixels - decoded-pixel admission limit.
* @returns verified format and dimensions.
*/
async function detectImage(data, maxPixels) {
	try {
		const image = sharp(data, {
			failOn: "error",
			limitInputPixels: false
		});
		const detected = await imageMetadata(image);
		if (maxPixels !== void 0 && detected.width * detected.height > maxPixels) throw new AttachmentError("Image exceeds the configured decoded-pixel limit.", "IMAGE_TOO_MANY_PIXELS");
		await image.raw().toBuffer();
		return detected;
	} catch (error) {
		if (error instanceof AttachmentError) throw error;
		throw new AttachmentError("Unsupported or malformed image data.", "INVALID_IMAGE", { cause: error });
	}
}
//#endregion
//#region lib/types/store.js
/** Content-addressed, owner-private local attachment storage. */
const ID_PATTERN = /^sha256:([a-f0-9]{64})$/;
const durableHomes = /* @__PURE__ */ new Set();
function digest(data) {
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
async function inspectMetadata(data, declaredMediaType, maxPixels) {
	if (data.byteLength === 0) throw new AttachmentError("Image is empty.", "INVALID_IMAGE");
	const detected = await detectImage(data, maxPixels);
	if (detected.mediaType !== declaredMediaType) throw new AttachmentError("Declared image type does not match its bytes.", "IMAGE_TYPE_MISMATCH");
	return {
		...detected,
		bytes: data.byteLength
	};
}
/**
* Run the full admission policy for one image without touching storage.
* @param input - encoded bytes and declared metadata.
* @param limits - resolved storage policy.
* @returns completion after the encoded raster has been fully decoded.
*/
async function validateImageFile(input, limits) {
	if (input.data.byteLength > limits.maxImageBytes) throw new AttachmentError("Image exceeds the configured byte limit.", "IMAGE_TOO_LARGE");
	await inspectMetadata(input.data, input.mediaType, limits.maxImagePixels);
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
	try {
		const handle = await open(path, constants.O_RDONLY);
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (error) {
		// Android: the app cannot open ancestor dirs above its data dir
		// (EACCES on /data/user/0). Durability of those ancestors is the
		// platform's concern; skip the sync rather than fail the save.
		if (error !== null && (error.code === "EACCES" || error.code === "EPERM")) return;
		throw error;
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
* Save and verify immutable image bytes below a versioned attachment root.
* @param root - absolute `DSH_HOME/attachments/v1` root.
* @param input - encoded bytes and declared metadata.
* @param limits - resolved storage policy.
* @returns durable content-addressed reference.
*/
async function saveImageFile(root, input, limits) {
	if (input.data.byteLength > limits.maxImageBytes) throw new AttachmentError("Image exceeds the configured byte limit.", "IMAGE_TOO_LARGE");
	const metadata = await inspectMetadata(input.data, input.mediaType, limits.maxImagePixels);
	const sha256 = digest(input.data);
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
		await handle.writeFile(input.data);
		await handle.sync();
		await handle.close();
		handle = void 0;
		try {
			await link(temporary, target);
		} catch (error) {
			/* v8 ignore next -- Private same-filesystem directories make EEXIST the only recoverable link race. */
			if (error instanceof Error && "code" in error && error.code === "EEXIST") {
				if (digest(new Uint8Array(await readFile(target))) !== sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");
			} else if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOSYS" || error.code === "EOPNOTSUPP" || error.code === "EXDEV")) {
				// Android sepolicy blocks link(2) (Huawei/HarmonyOS observed); fall back to an exclusive copy.
				try {
					await copyFile(temporary, target, constants.COPYFILE_EXCL);
				} catch (copyError) {
					if (copyError instanceof Error && "code" in copyError && copyError.code === "EEXIST") {
						if (digest(new Uint8Array(await readFile(target))) !== sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");
					} else {
						throw copyError;
					}
				}
			} else {
				throw error;
			}
		}
		await syncDirectory(bucket);
		await syncDirectory(join(root, "objects"));
		await unlink(temporary);
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
	const name = displayName(input.name);
	return {
		attachmentId: AttachmentId(`sha256:${sha256}`),
		...metadata,
		...name !== void 0 ? { name } : {}
	};
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
	if (digest(data) !== sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");
	const metadata = await probeImage(data);
	signal?.throwIfAborted();
	if (metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes || metadata.width !== ref.width || metadata.height !== ref.height) throw new AttachmentError("Stored attachment metadata does not match its reference.", "ATTACHMENT_CORRUPT");
	return {
		ref,
		data
	};
}
//#endregion
//#region lib/types/index.js
/** Local durable attachment backend rooted below `DSH_HOME`. @module @deepseek-ai/dsh-attachment-local */
/** Default maximum encoded bytes for one image. */
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Default maximum images in one prompt. */
const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20;
/** Default maximum aggregate image bytes in one prompt. */
const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 100 * 1024 * 1024;
/** Default maximum intrinsic pixels for one image. */
const DEFAULT_MAX_IMAGE_PIXELS = 4e7;
/** Persistent content-addressed local attachment store. */
var LocalAttachmentStore = class extends AttachmentStore {
	static Config = z.object({
		dshHome: z.string(),
		maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
		maxImagesPerMessage: z.number().step(1).min(1).default(20),
		maxMessageImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
		maxImagePixels: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_PIXELS)
	});
	/** Absolute versioned storage root. */
	root;
	imageLimits;
	constructor(ctx, config) {
		super(ctx);
		this.root = resolve(join(resolveDshHome(config.dshHome), "attachments", "v1"));
		this.imageLimits = Object.freeze({
			maxImageBytes: config.maxImageBytes ?? 5242880,
			maxImagesPerMessage: config.maxImagesPerMessage ?? 20,
			maxMessageImageBytes: config.maxMessageImageBytes ?? 104857600,
			maxImagePixels: config.maxImagePixels ?? 4e7,
			mediaTypes: Object.freeze([
				"image/png",
				"image/jpeg",
				"image/webp",
				"image/gif"
			])
		});
	}
	async validateImage(input) {
		await validateImageFile(input, this.imageLimits);
	}
	async saveImage(input) {
		return saveImageFile(this.root, input, this.imageLimits);
	}
	async readImage(ref, signal) {
		return readImageFile(this.root, ref, signal);
	}
};
//#endregion
export { DEFAULT_MAX_IMAGES_PER_MESSAGE, DEFAULT_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_PIXELS, DEFAULT_MAX_MESSAGE_IMAGE_BYTES, LocalAttachmentStore, LocalAttachmentStore as default, detectImage, readImageFile, saveImageFile, validateImageFile };
