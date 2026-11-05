/**
 * `image_generate` tool: generate images through a subscription image
 * endpoint, save them under the harness home, and — when the deployment
 * mounts an attachment store and the calling route declares image input —
 * also commit the bytes as durable attachments so the images render inline
 * and enter model context (the same path `read_image` uses).
 *
 * Provider selection: the `provider` argument names the preferred provider
 * (default `gpt`, i.e. the ChatGPT/Codex subscription serving gpt-image-2 —
 * mirrors codex-rs `codex-api/src/images.rs`); when the preferred one is
 * logged out the other serves as fallback (`grok` is grok-imagine-image-2.0
 * via `api.x.ai/v1/images/generations` with `response_format: 'b64_json'`).
 * Both answer the OpenAI images shape (`data[].b64_json`).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { AccountTokenManager } from '../providers/accounts.js';
import { ImageAccountPool } from '../providers/image-pool.js';
import { codexRateLimitReset } from '../providers/codex.js';
import { grokRateLimitReset } from '../providers/grok.js';
import { proxiedFetch } from '../http.js';
/** Endpoint the codex generation request is posted to. */
export const IMAGE_GENERATE_URL = 'https://chatgpt.com/backend-api/codex/images/generations';
export const IMAGE_EDIT_URL = 'https://chatgpt.com/backend-api/codex/images/edits';
/** The image model the codex subscription endpoint serves. */
export const IMAGE_GENERATE_MODEL = 'gpt-image-2';
/** Endpoint the grok generation request is posted to. */
export const GROK_IMAGE_GENERATE_URL = 'https://api.x.ai/v1/images/generations';
export const GROK_IMAGE_EDIT_URL = 'https://api.x.ai/v1/images/edits';
/** The image model the grok subscription endpoint serves. */
export const GROK_IMAGE_GENERATE_MODEL = 'grok-imagine-image-2.0';
/** Resolve references before any upstream request; never silently generate on invalid edits. */
async function resolveReferenceImages(refs, attachments, signal) {
    if (refs === undefined)
        return undefined;
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > 5) {
        throw new Error('image_generate: referenceImages must contain 1–5 complete image references; omit only for a new image');
    }
    if (attachments === undefined)
        throw new Error('image_generate: editing requires the DSH attachment service');
    const seen = new Set();
    let totalBytes = 0;
    const urls = [];
    for (const ref of refs) {
        signal.throwIfAborted();
        if (ref === null || typeof ref !== 'object'
            || typeof ref.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId)
            || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)
            || ![ref.bytes, ref.width, ref.height].every(value => Number.isSafeInteger(value) && value > 0)) {
            throw new Error('image_generate: invalid referenceImages entry; copy a complete image reference or call read_image for a local file. Do not omit references to retry an edit.');
        }
        if (seen.has(ref.attachmentId))
            throw new Error('image_generate: referenceImages contains duplicate images');
        seen.add(ref.attachmentId);
        if (refs.length > attachments.imageLimits.maxImagesPerMessage
            || ref.bytes > attachments.imageLimits.maxImageBytes
            || totalBytes + ref.bytes > attachments.imageLimits.maxMessageImageBytes) {
            throw new Error('image_generate: referenceImages exceed DSH image limits');
        }
        const stored = await attachments.readImage(imageRefFromValue(ref), signal);
        totalBytes += stored.data.byteLength;
        if (totalBytes > attachments.imageLimits.maxMessageImageBytes) {
            throw new Error('image_generate: referenceImages exceed DSH image limits');
        }
        urls.push(`data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`);
    }
    return urls;
}
/**
 * Assemble the codex request body from tool arguments (hand-checks the
 * non-empty prompt the schema DSL cannot express).
 */
export function buildImageGenerateBody(args) {
    const prompt = args.prompt.trim();
    if (prompt.length === 0)
        throw new Error('image_generate: prompt must be a non-empty string');
    return {
        prompt,
        model: IMAGE_GENERATE_MODEL,
        ...args.size === undefined ? {} : { size: args.size },
        ...args.quality === undefined ? {} : { quality: args.quality },
    };
}
/** The codex `size` values mapped onto grok aspect ratios. */
const GROK_ASPECT_RATIOS = {
    '1024x1024': '1:1',
    '1024x1536': '2:3',
    '1536x1024': '3:2',
    'auto': 'auto',
};
/**
 * Assemble the grok request body from the same tool arguments: `size` maps
 * onto the nearest `aspect_ratio`, and `quality` folds into grok's low/medium
 * pair (`high` → `medium`, `auto` → provider default).
 */
export function buildGrokImageGenerateBody(args) {
    const prompt = args.prompt.trim();
    if (prompt.length === 0)
        throw new Error('image_generate: prompt must be a non-empty string');
    const quality = args.quality === 'low' ? 'low'
        : args.quality === 'medium' || args.quality === 'high' ? 'medium'
            : undefined;
    return {
        prompt,
        model: GROK_IMAGE_GENERATE_MODEL,
        response_format: 'b64_json',
        ...args.size === undefined ? {} : { aspect_ratio: GROK_ASPECT_RATIOS[args.size] },
        ...quality === undefined ? {} : { quality },
    };
}
/**
 * Parse the generations response into decodable images. Throws when the
 * payload carries no usable `b64_json` entries.
 */
export function parseImageGenerateResponse(payload) {
    const body = typeof payload === 'object' && payload !== null ? payload : {};
    const entries = Array.isArray(body.data) ? body.data : [];
    const images = [];
    for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null)
            continue;
        const record = entry;
        if (typeof record.b64_json !== 'string' || record.b64_json.length === 0)
            continue;
        images.push({
            data: Buffer.from(record.b64_json, 'base64'),
            ...typeof record.revised_prompt === 'string' && record.revised_prompt.length > 0
                ? { revisedPrompt: record.revised_prompt }
                : {},
        });
    }
    if (images.length === 0)
        throw new Error('image_generate: the response carried no image data');
    return images;
}
/** Directory the generated image files are written to. */
export function imagesDirectory() {
    return dshHomePath('plugins', 'subscriptions', 'images');
}
/**
 * Sniff a generated image's media type from its magic bytes (codex serves
 * PNG; grok's format is undocumented, so trust the bytes). Unrecognized data
 * defaults to PNG, matching the historical behavior.
 */
export function sniffImageMediaType(data) {
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
        return 'image/jpeg';
    if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
        return 'image/webp';
    }
    return 'image/png';
}
/** File extension for one sniffed media type. */
const MEDIA_TYPE_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
};
/** Timestamped, collision-safe file name for one generated image. */
function imageFileName(index, mediaType) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `image-${stamp}-${Math.random().toString(36).slice(2, 8)}-${index}.${MEDIA_TYPE_EXTENSIONS[mediaType]}`;
}
/** Bound a call-card title's prompt. */
function truncate(text, max = 60) {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
/**
 * Non-throwing image-capability check for the calling route (read_image's
 * gate, softened: a generated image that cannot enter history degrades to the
 * text-only result instead of failing the call). Resolves the session's
 * latest routed provider/model and answers whether the exact route declares
 * image input; any resolution failure means "no".
 */
async function routeDeclaresImageInput(resolveLlm, exec) {
    const llm = resolveLlm?.();
    const routed = exec.agent?.session.requestHeader()?.config;
    const provider = routed?.provider ?? exec.agent?.options.provider;
    const model = routed?.model ?? exec.agent?.options.model;
    if (llm === undefined || provider === undefined || model === undefined)
        return false;
    try {
        const active = await llm.resolveModelInfo(provider, model, exec.signal);
        return active.inputModalities?.includes('image') === true;
    }
    catch {
        // An unresolvable route cannot be proven image-capable: degrade to text.
        return false;
    }
}
/** Re-brand one canonical image entry into the attachment reference an ImageBlock carries. */
function imageRefFromValue(image) {
    return {
        attachmentId: AttachmentId(image.attachmentId),
        mediaType: image.mediaType,
        bytes: image.bytes,
        width: image.width,
        height: image.height,
        ...image.name === undefined ? {} : { name: image.name },
        ...image.originalDimensions === undefined ? {} : { originalDimensions: image.originalDimensions },
    };
}
/** Project the canonical value into the model-facing text + image blocks. */
function imageGenerateContent(value) {
    return [
        imageGenerateText(value),
        ...(value.images ?? []).map(image => ({ type: 'image', attachment: imageRefFromValue(image) })),
    ];
}
/** The text summary of one generation, shared by the model content and the UI card. */
function imageGenerateText(value) {
    const text = `Saved ${value.paths.length} image(s):\n${value.paths.map(path => `- ${path}`).join('\n')}`
        + (value.images?.length ? `\n\nImage references (for image_generate.referenceImages): ${JSON.stringify(value.images)}` : '')
        + (value.revisedPrompt === undefined ? '' : `\n\nRevised prompt: ${value.revisedPrompt}`);
    return { type: 'text', text };
}
/**
 * Build the `image_generate` tool definition.
 * @param options - codex session source, fetch implementation, and image directory.
 * @returns the tool to register on `ctx.tools`.
 */
export function createImageGenerateTool(options) {
    const imagePool = options.imagePool ?? new ImageAccountPool();
    return defineTool({
        name: 'image_generate',
        description: 'Generate an image with the ChatGPT subscription (gpt-image-2) or the Grok '
            + 'subscription (grok-imagine-image-2.0) and save it as an image file. The `provider` '
            + 'parameter picks the preferred provider (default gpt); when the preferred one is logged '
            + 'out the other serves as fallback. '
            + 'Within the selected provider, image requests use available subscription accounts; '
            + 'quota or authentication rejection can switch accounts without changing providers. '
            + 'Returns the saved file paths; on image-capable models the image itself is attached. '
            + 'To edit or use existing images as references, pass referenceImages copied from the image reference text '
            + 'or structured tool results (read_image.image or image_generate.images). Select only the images the user '
            + 'intends, in prompt order. For local files, call read_image first. Omit referenceImages only for a new image. '
            + 'If an edit reference fails, fix it and retry; never omit it to substitute text-to-image generation.',
        parameters: {
            referenceImages: {
                type: 'array',
                description: 'Optional 1–5 ordered complete DSH image references to edit or use as source images. Not file paths or URLs. Omit only for new images.',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        attachmentId: { type: 'string', required: true },
                        mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
                        bytes: { type: 'integer', required: true },
                        width: { type: 'integer', required: true },
                        height: { type: 'integer', required: true },
                        name: { type: 'string' },
                        originalDimensions: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                width: { type: 'integer', required: true },
                                height: { type: 'integer', required: true },
                            },
                        },
                    },
                },
            },
            prompt: { type: 'string', required: true, description: 'What the image should show.' },
            size: {
                type: 'string',
                enum: ['1024x1024', '1024x1536', '1536x1024', 'auto'],
                description: 'Image dimensions; omit for the provider default.',
            },
            quality: {
                type: 'string',
                enum: ['low', 'medium', 'high', 'auto'],
                description: 'Rendering quality; omit for the provider default.',
            },
            provider: {
                type: 'string',
                enum: ['gpt', 'grok'],
                description: 'Preferred provider (default gpt); the other one serves as fallback when the preferred is logged out.',
            },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    paths: { type: 'array', items: { type: 'string' }, required: true },
                    images: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                attachmentId: { type: 'string', required: true },
                                mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
                                bytes: { type: 'integer', required: true },
                                width: { type: 'integer', required: true },
                                height: { type: 'integer', required: true },
                                name: { type: 'string' },
                            },
                        },
                    },
                    revisedPrompt: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => imageGenerateContent(value),
        },
        presentCall: args => ({
            card: 'generic',
            title: `image_generate${args.referenceImages === undefined ? '' : ` (edit, ${args.referenceImages.length} images)`}: ${truncate(args.prompt)}`,
        }),
        // The web UI has no image surface on tool cards and flattens result blocks
        // to text/JSON, so the completed card shows the text summary only; the
        // image block stays model-facing in the render output.
        presentResult: (_args, result) => ({
            card: 'generic',
            content: result.content.filter(block => block.type === 'text'),
        }),
        async execute(args, exec) {
            const fetchFn = options.fetchFn ?? proxiedFetch;
            // Validate the prompt even when references cannot be resolved.
            buildImageGenerateBody(args);
            const references = await resolveReferenceImages(args.referenceImages, options.resolveAttachments?.(), exec.signal);
            // Provider selection: the preferred provider (default gpt) when logged
            // in, the other one as the fallback. A configured-but-logged-out manager
            // still resolves through `session()` below so the standard log-in hint
            // surfaces.
            const preferGrok = args.provider === 'grok';
            const createdAt = exec.agent?.session.header?.createdAt;
            const codexEnabled = options.providerEnabled?.('codex', createdAt) !== false;
            const grokEnabled = options.providerEnabled?.('grok', createdAt) !== false;
            const codexReady = codexEnabled && options.codexTokens !== undefined && (await options.codexTokens.list()).length > 0;
            const grokReady = grokEnabled && options.grokTokens !== undefined && (await options.grokTokens.list()).length > 0;
            const useGrok = preferGrok ? grokReady : grokReady && !codexReady;
            const useCodex = !useGrok && codexReady;
            let response;
            if (useCodex && options.codexTokens !== undefined) {
                response = await imagePool.request({
                    provider: 'codex', tokens: options.codexTokens, signal: exec.signal,
                    owner: exec.agent?.session, rateLimitReset: codexRateLimitReset,
                    send: session => fetchFn(references === undefined ? IMAGE_GENERATE_URL : IMAGE_EDIT_URL, {
                        method: 'POST',
                        headers: {
                            'authorization': `Bearer ${session.accessToken}`,
                            'chatgpt-account-id': session.accountId,
                            'originator': 'codex_cli_rs',
                            'content-type': 'application/json',
                            'accept': 'application/json',
                        },
                        body: JSON.stringify({
                            ...buildImageGenerateBody(args),
                            ...references === undefined ? {} : { images: references.map(image_url => ({ image_url })) },
                        }),
                        signal: exec.signal,
                    }),
                });
            }
            else if (useGrok && options.grokTokens !== undefined) {
                response = await imagePool.request({
                    provider: 'grok', tokens: options.grokTokens, signal: exec.signal,
                    owner: exec.agent?.session, rateLimitReset: grokRateLimitReset,
                    send: session => fetchFn(references === undefined ? GROK_IMAGE_GENERATE_URL : GROK_IMAGE_EDIT_URL, {
                        method: 'POST',
                        headers: {
                            'authorization': `Bearer ${session.accessToken}`,
                            'content-type': 'application/json',
                            'accept': 'application/json',
                        },
                        body: JSON.stringify({
                            ...buildGrokImageGenerateBody(args),
                            ...references === undefined ? {} : references.length === 1
                                ? { image: { type: 'image_url', url: references[0] } }
                                : { images: references.map(url => ({ type: 'image_url', url })) },
                        }),
                        signal: exec.signal,
                    }),
                });
            }
            else {
                if (!codexEnabled && !grokEnabled)
                    throw new Error('image_generate: disabled for this session');
                const codex = codexEnabled ? options.codexTokens : undefined;
                const grok = grokEnabled ? options.grokTokens : undefined;
                const manager = preferGrok ? grok ?? codex : codex ?? grok;
                if (manager === undefined)
                    throw new Error('image_generate: no image provider is configured');
                await manager.session(); // logged out: throws the provider's log-in hint
                throw new Error('image_generate: no image provider is logged in');
            }
            const images = parseImageGenerateResponse(await response.json());
            const directory = options.imagesDir ?? imagesDirectory();
            await mkdir(directory, { recursive: true });
            const paths = [];
            const mediaTypes = [];
            for (const [index, image] of images.entries()) {
                const mediaType = sniffImageMediaType(image.data);
                const path = join(directory, imageFileName(index, mediaType));
                await writeFile(path, image.data);
                paths.push(path);
                mediaTypes.push(mediaType);
            }
            // Inline display requires durable attachment references, and those may
            // only enter session history on a route that declares image input.
            // Either condition failing degrades to the text-only result.
            const attachments = options.resolveAttachments?.();
            const imageCapable = attachments !== undefined
                && await routeDeclaresImageInput(options.resolveLlm, exec);
            const refs = [];
            if (attachments !== undefined && imageCapable) {
                for (const [index, image] of images.entries()) {
                    const ref = await attachments.saveImage({
                        data: image.data,
                        mediaType: mediaTypes[index],
                        name: basename(paths[index]),
                    });
                    refs.push({
                        attachmentId: ref.attachmentId,
                        mediaType: ref.mediaType,
                        bytes: ref.bytes,
                        width: ref.width,
                        height: ref.height,
                        ...ref.name === undefined ? {} : { name: ref.name },
                    });
                }
            }
            const revisedPrompt = images.find(image => image.revisedPrompt !== undefined)?.revisedPrompt;
            const value = {
                paths,
                ...refs.length > 0 ? { images: refs } : {},
                ...revisedPrompt === undefined ? {} : { revisedPrompt },
            };
            // Nested (Code Mode) dispatches need no defer here: the harness's code
            // mode already defers any image-bearing sub-result as a user message, so
            // deferring again would inject the same attachment twice.
            return value;
        },
    });
}
