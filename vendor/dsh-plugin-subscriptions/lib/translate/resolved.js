/**
 * Resolved-image plumbing for the wire translators. ImageBlocks carry only an
 * attachment reference; the bytes live in the attachment service, which is
 * async I/O. Adapters resolve images BEFORE calling the (pure, synchronous)
 * translators, so the translators see {@link ResolvedImagePart}s with inline
 * base64 data.
 */
import { LlmError } from '@deepseek-ai/dsh-llm';
import * as llm from '@deepseek-ai/dsh-llm';
/**
 * Wires with text-only tool outputs receive images in a following user turn.
 * Defer that turn until all consecutive user messages have been processed:
 * parallel tool results can arrive in separate harness messages, and a user
 * image message must not interrupt their tool-call/output pairing.
 */
export function withToolResultImages(messages) {
    const out = [];
    let images = [];
    const flush = () => {
        if (images.length > 0)
            out.push({ role: 'user', content: images });
        images = [];
    };
    for (const message of messages) {
        if (message.role === 'assistant')
            flush();
        out.push(message);
        if (message.role === 'tool') {
            const parts = message.content.filter((part) => part.type === 'image' && 'dataBase64' in part);
            if (parts.length > 0) {
                images.push({ type: 'text', text: `Images from tool result ${String(message.toolCallId)}:` }, ...parts);
            }
        }
        for (const block of message.content) {
            if (block.type !== 'tool-result')
                continue;
            const parts = block.content.filter((part) => part.type === 'image' && 'dataBase64' in part);
            if (parts.length > 0) {
                images.push({ type: 'text', text: `Images from tool result ${String(block.toolCallId)}:` }, ...parts);
            }
        }
    }
    flush();
    return out;
}
/**
 * Failure code a host's image-offload executor answers by replacing the oldest
 * retained images with text and retrying (`IMAGE_OFFLOAD_REQUIRED_CODE` in
 * dsh-llm 0.2+). Spelled out so the build links against older hosts too.
 */
export const IMAGE_OFFLOAD_REQUIRED = 'IMAGE_OFFLOAD_REQUIRED';
/**
 * Whether the installed host records image offloads. Hosts that predate the
 * executor never mark images `offloaded`, so asking them to would fail every
 * later request instead of shrinking it.
 */
export function hostSupportsImageOffload() {
    const exports = llm;
    return exports['IMAGE_OFFLOAD_REQUIRED_CODE'] === IMAGE_OFFLOAD_REQUIRED
        && typeof exports['offloadedImageText'] === 'function';
}
/**
 * How many of the oldest images still sent inline must be offloaded before
 * the resolved request fits `maxBase64Bytes` of image data; zero when it fits.
 * Images are counted depth-first in request order, skipping assistant
 * messages, the same order the host's executor selects occurrences in.
 * @param messages - the resolved request, after {@link resolveImages}.
 * @param maxBase64Bytes - the route's budget for all inline image data.
 */
export function requiredImageOffloadCount(messages, maxBase64Bytes) {
    const lengths = [];
    const visit = (blocks) => {
        for (const block of blocks) {
            if (block.type === 'image' && 'dataBase64' in block)
                lengths.push(block.dataBase64.length);
            else if (block.type === 'tool-result')
                visit(block.content);
        }
    };
    for (const message of messages) {
        if (message.role !== 'assistant')
            visit(message.content);
    }
    let excess = lengths.reduce((sum, bytes) => sum + bytes, 0) - maxBase64Bytes;
    let count = 0;
    while (excess > 0 && count < lengths.length) {
        excess -= lengths[count];
        count += 1;
    }
    return count;
}
/**
 * The request projection for one oversized image, or undefined when it fits.
 * Hosts before DSH 0.1.7 read a pixel budget (`maxPixels`), later ones the
 * target edges (`width`/`height`); each validates only its own fields, so
 * one projection carries both.
 */
export function imageRequestTarget(ref, limit) {
    const longEdge = Math.max(ref.width, ref.height);
    if (!(longEdge > limit.maxEdge))
        return undefined;
    const short = (edge) => Math.max(1, Math.floor(edge * limit.maxEdge / longEdge));
    const width = ref.width >= ref.height ? limit.maxEdge : short(ref.width);
    const height = ref.width >= ref.height ? short(ref.height) : limit.maxEdge;
    return { width, height, maxPixels: width * height, maxBytes: limit.maxBytes };
}
/**
 * Resolve every ImageBlock's attachment reference to inline base64 bytes.
 * Messages without images pass through unchanged. A request carrying an image
 * with no attachment service available fails loudly rather than silently
 * dropping the image.
 * @param messages - the request's conversation messages.
 * @param attachments - the deployment's attachment service, when mounted.
 * @param signal - cancellation for the storage reads.
 * @param limit - the route's outgoing image cap; oversized images are sent
 *   downscaled while the stored attachment and history stay untouched.
 * @returns the same messages with image blocks resolved for the translators.
 */
export async function resolveImages(messages, attachments, signal, limit) {
    const hasImage = (block) => block.type === 'image'
        || (block.type === 'tool-result' && block.content.some(hasImage));
    if (!messages.some(message => message.content.some(hasImage))) {
        return messages;
    }
    const hasRetainedImage = (block) => block.type === 'image'
        ? !('offloaded' in block && block.offloaded === true)
        : block.type === 'tool-result' && block.content.some(hasRetainedImage);
    if (attachments === undefined && messages.some(message => message.content.some(hasRetainedImage))) {
        throw new LlmError('dsh-plugin-subscriptions: the request carries an image but no attachments service is mounted; '
            + 'image input requires the harness attachment store', 'UNSUPPORTED');
    }
    const readForRequest = async (ref) => {
        if (attachments === undefined)
            throw new LlmError('No attachment service for retained image', 'UNSUPPORTED');
        const target = limit === undefined ? undefined : imageRequestTarget(ref, limit);
        if (target !== undefined) {
            try {
                const version = await attachments.readImageRequest(ref, target, signal);
                return { data: version.data, mediaType: version.mediaType, ref: version.attachment };
            }
            catch (error) {
                // A host that cannot derive request images keeps sending the stored bytes, as before.
                if (signal?.aborted)
                    throw error;
            }
        }
        const stored = await attachments.readImage(ref, signal);
        return { data: stored.data, mediaType: stored.ref.mediaType, ref: stored.ref };
    };
    const resolveBlock = async (block) => {
        if (block.type === 'tool-result') {
            return [{ ...block, content: (await Promise.all(block.content.map(resolveBlock))).flat() }];
        }
        if (block.type !== 'image')
            return [block];
        if ('offloaded' in block && block.offloaded === true) {
            // New hosts own the omission decision. Never restore omitted bytes,
            // including when the original attachment is no longer readable.
            const format = llm.offloadedImageText;
            return [{ type: 'text', text: format?.(block.attachment)
                        ?? `[image omitted to fit request image limits; ${block.attachment.attachmentId}]` }];
        }
        const { data, mediaType: sentType, ref } = await readForRequest(block.attachment);
        const { attachmentId, mediaType, bytes, width, height, name } = ref;
        return [{
                type: 'image',
                mediaType: sentType,
                dataBase64: Buffer.from(data).toString('base64'),
            }, {
                type: 'text',
                text: `Image reference (for image_generate.referenceImages): ${JSON.stringify({
                    attachmentId, mediaType, bytes, width, height, ...name === undefined ? {} : { name },
                })}`,
            }];
    };
    return Promise.all(messages.map(async (message) => ({
        ...message,
        content: (await Promise.all(message.content.map(resolveBlock))).flat(),
    })));
}
