import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import { ImageGallery } from './ImageGallery.js';
import { hostIcon } from './host-icons.js';
import { callSubscriptionsAuth } from './subscriptions-rpc.js';
import { en } from './locales.js';
/** DSH 0.1.7 renamed IconSparkle16; resolving it by name keeps older hosts working too. */
const SparkleIcon = hostIcon(primitives, 'Sparkle');
/** Title prompt truncation budget (characters). */
const PROMPT_MAX_LENGTH = 60;
/**
 * Build the ImageGallery loader over the `image` endpoint.
 * @param rpc - Connection RPC caller.
 * @returns loader resolving an attachment ref to a data URL.
 */
export function createImageLoader(rpc) {
    // The host validates a full ImageAttachmentRef payload (readImage takes the
    // whole ref), so forward the attachment verbatim.
    return attachment => callSubscriptionsAuth(rpc, 'image', { ...attachment })
        .then(result => `data:${result.mediaType};base64,${result.dataBase64}`);
}
/**
 * English-dictionary fallback for a missing locale seat (standalone renders);
 * the framework always supplies the namespace-bound one.
 * @param key - dictionary key.
 * @param params - `{name}` template params.
 * @returns the template with params substituted.
 */
function fallbackTranslate(key, params) {
    let text = en[key];
    for (const [name, value] of Object.entries(params ?? {})) {
        text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
}
/** Extract the prompt from the call's raw args JSON; falls back to the first string value, then the raw line. */
function derivePrompt(argsRaw) {
    let parsed;
    try {
        parsed = JSON.parse(argsRaw);
    }
    catch {
        // Non-JSON args (mid-stream truncation): fall back to the raw string below.
        parsed = undefined;
    }
    let prompt;
    if (typeof parsed === 'object' && parsed !== null) {
        const args = parsed;
        if (typeof args.prompt === 'string' && args.prompt !== '')
            prompt = args.prompt;
        else {
            for (const value of Object.values(args)) {
                if (typeof value === 'string' && value !== '') {
                    prompt = value;
                    break;
                }
            }
        }
    }
    const line = (prompt ?? argsRaw).split('\n', 1)[0] ?? '';
    return line.length > PROMPT_MAX_LENGTH ? `${line.slice(0, PROMPT_MAX_LENGTH)}…` : line;
}
/** Flatten a settled result's text blocks (the degraded text-only route and the error line). */
function resultText(block) {
    if (!('kind' in block))
        return '';
    const parts = [];
    for (const part of block.content) {
        if (part.type === 'text')
            parts.push(part.text);
    }
    if (parts.length === 0 && block.error !== undefined)
        parts.push(`${block.error.name}: ${block.error.code}`);
    return parts.join('\n');
}
/** Image attachments of a settled result; empty while running or on the text-only route. */
function resultImages(block) {
    if (!('kind' in block))
        return [];
    const images = [];
    for (const part of block.content) {
        if (part.type === 'image')
            images.push({ attachment: part.attachment });
    }
    return images;
}
const styles = {
    container: { display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' },
    row: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
    icon: { display: 'inline-flex', flexShrink: 0, color: 'var(--dsw-alias-label-tertiary)' },
    title: {
        fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    },
    subtle: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
    output: {
        margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
    },
    error: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
};
/**
 * The `image_generate` keyed toolview component.
 * @param props - owner share, inject face, and locale seat (spread flat).
 * @returns the call row plus, once settled, the gallery / text / error body.
 */
export function ImageGenerateToolview(props) {
    const { block, load } = props;
    const t = props.t ?? fallbackTranslate;
    if (block === undefined)
        return null;
    const settled = 'kind' in block;
    const argsRaw = (settled ? block.call?.argsRaw : 'argsRaw' in block ? block.argsRaw : undefined) ?? '';
    let references = 0;
    try {
        const args = JSON.parse(argsRaw);
        if (Array.isArray(args?.referenceImages))
            references = args.referenceImages.length;
    }
    catch { /* Arguments may still be streaming. */ }
    const title = `image_generate${references > 0 ? ` (${references} ref)` : ''}: ${derivePrompt(argsRaw)}`;
    const images = resultImages(block);
    const text = settled ? resultText(block) : '';
    const labels = {
        image: t('image'),
        open: t('viewImage'),
        openNamed: name => t('viewImageNamed', { name }),
        loading: t('imageLoading'),
        loadFailed: t('imageLoadFailed'),
        lightbox: { dialog: t('imagePreview'), close: t('imageClose') },
    };
    return (_jsxs("div", { style: styles.container, children: [_jsxs("div", { style: styles.row, children: [_jsx("span", { style: styles.icon, children: _jsx(SparkleIcon, { size: 14 }) }), _jsx("span", { style: styles.title, children: title })] }), !settled && _jsx("p", { style: styles.subtle, children: t('generating') }), settled && block.isError && text !== '' && (_jsx("p", { style: styles.error, children: text.split('\n', 1)[0] })), settled && !block.isError && images.length > 0 && load !== undefined && (_jsx(ImageGallery, { images: images, load: load, labels: labels })), settled && !block.isError && images.length === 0 && text !== '' && (_jsx("p", { style: styles.output, children: text }))] }));
}
