import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Keyed toolview for the `video_generate` tool: renders the generated video
 * inline in the conversation. The row shows the call's prompt while running
 * and after settling; a settled success loads the MP4 bytes through the node
 * half's `/subscriptions-auth` `video` endpoint (by bare file name), builds a
 * Blob URL, and plays it in a native `<video controls>` element. The file
 * name comes from the result's presentation meta when the dispatch was
 * top-level, and is recovered from the "Saved video to …" text line for
 * nested (Code Mode) dispatches, where the harness computes no meta. A result
 * with neither renders its text; an error result renders the first error line.
 *
 * The 'tool.call.toolview' SlotMap entry is declared by
 * ImageGenerateToolview.tsx in this same package (one declaration per
 * augmentation), so this file only mirrors the owner-props shape.
 */
import { useEffect, useState } from 'react';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import { hostIcon } from './host-icons.js';
import { callSubscriptionsAuth } from './subscriptions-rpc.js';
import { en } from './locales.js';
/** DSH 0.1.7 renamed IconSparkle16; resolving it by name keeps older hosts working too. */
const SparkleIcon = hostIcon(primitives, 'Sparkle');
/** Title prompt truncation budget (characters). */
const PROMPT_MAX_LENGTH = 60;
/**
 * Build the video loader over the `/subscriptions-auth` `video` endpoint.
 * @param rpc - Connection RPC caller.
 * @returns loader resolving a bare file name to the decoded bytes.
 */
export function createVideoLoader(rpc) {
    return name => callSubscriptionsAuth(rpc, 'video', { name });
}
/**
 * English-dictionary fallback for a missing locale seat (standalone renders);
 * the framework always supplies the namespace-bound one.
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
/** Flatten a settled result's text blocks (the fallback body and the error line). */
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
/**
 * The generated video's bare file name: presentation meta first (top-level
 * dispatches), then the render text's "Saved video to …" line (nested
 * dispatches compute no meta).
 */
function resolveFileName(block) {
    if (!('kind' in block))
        return undefined;
    const meta = block.meta;
    if (typeof meta === 'object' && meta !== null) {
        const fileName = meta.fileName;
        if (typeof fileName === 'string' && fileName.length > 0)
            return fileName;
    }
    const match = /^Saved video to (.+\.mp4)/m.exec(resultText(block));
    if (match === null)
        return undefined;
    const path = match[1];
    return path.slice(path.lastIndexOf('/') + 1);
}
/** Decode a base64 payload into bytes (browser-side; no Buffer). */
function base64Bytes(dataBase64) {
    const binary = atob(dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++)
        bytes[index] = binary.charCodeAt(index);
    return bytes;
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
    video: {
        display: 'block', maxWidth: 480, width: '100%', borderRadius: 8,
        backgroundColor: 'var(--dsw-alias-fill-tertiary)',
    },
};
/**
 * The `video_generate` keyed toolview component.
 * @param props - owner share, inject face, and locale seat (spread flat).
 * @returns the call row plus, once settled, the player / text / error body.
 */
export function VideoGenerateToolview(props) {
    const { block, loadVideo } = props;
    const t = props.t ?? fallbackTranslate;
    const settled = block !== undefined && 'kind' in block;
    const isError = settled && block.isError;
    const fileName = block !== undefined && settled && !isError ? resolveFileName(block) : undefined;
    const [load, setLoad] = useState({ phase: 'loading' });
    useEffect(() => {
        if (fileName === undefined || loadVideo === undefined)
            return;
        let cancelled = false;
        let objectUrl;
        setLoad({ phase: 'loading' });
        loadVideo(fileName).then((video) => {
            if (cancelled)
                return;
            // Uint8Array#slice detaches a plain ArrayBuffer view for BlobPart.
            objectUrl = URL.createObjectURL(new Blob([base64Bytes(video.dataBase64).slice()], { type: video.mediaType }));
            setLoad({ phase: 'ready', url: objectUrl });
        }, (error) => {
            if (cancelled)
                return;
            setLoad({ phase: 'failed', message: error instanceof Error ? error.message : String(error) });
        });
        return () => {
            cancelled = true;
            if (objectUrl !== undefined)
                URL.revokeObjectURL(objectUrl);
        };
    }, [fileName, loadVideo]);
    if (block === undefined)
        return null;
    const argsRaw = (settled ? block.call?.argsRaw : 'argsRaw' in block ? block.argsRaw : undefined) ?? '';
    const title = `video_generate: ${derivePrompt(argsRaw)}`;
    const text = settled ? resultText(block) : '';
    return (_jsxs("div", { style: styles.container, children: [_jsxs("div", { style: styles.row, children: [_jsx("span", { style: styles.icon, children: _jsx(SparkleIcon, { size: 14 }) }), _jsx("span", { style: styles.title, children: title })] }), !settled && _jsx("p", { style: styles.subtle, children: t('generatingVideo') }), settled && isError && text !== '' && (_jsx("p", { style: styles.error, children: text.split('\n', 1)[0] })), settled && !isError && fileName !== undefined && load.phase === 'loading' && (_jsx("p", { style: styles.subtle, children: t('videoLoading') })), settled && !isError && fileName !== undefined && load.phase === 'failed' && (_jsx("p", { style: styles.error, children: t('videoLoadFailed', { message: load.message }) })), settled && !isError && fileName !== undefined && load.phase === 'ready' && (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- generated clip; no caption track exists.
            _jsx("video", { style: styles.video, src: load.url, controls: true, preload: "metadata" })), settled && !isError && fileName === undefined && text !== '' && (_jsx("p", { style: styles.output, children: text }))] }));
}
