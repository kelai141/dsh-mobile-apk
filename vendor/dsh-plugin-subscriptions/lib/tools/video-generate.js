/**
 * `video_generate` tool: generate videos through the grok subscription's
 * Imagine video endpoint and save them as MP4 files under the harness home.
 * The xAI API is asynchronous: POST `/v1/videos/generations` returns a
 * `request_id`, GET `/v1/videos/{request_id}` is polled until the status
 * leaves `pending`, and the completed response carries a temporary MP4 URL
 * that is downloaded promptly (the URL expires). The canonical result is the
 * saved file path; videos have no attachment surface, so the result stays
 * text-only (unlike image_generate).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { httpLlmError } from '../providers/common.js';
import { AccountTokenManager } from '../providers/accounts.js';
import { proxiedFetch } from '../http.js';
/** Endpoint the generation request is posted to. */
export const VIDEO_GENERATE_URL = 'https://api.x.ai/v1/videos/generations';
/** The video model the grok subscription endpoint serves. */
export const VIDEO_GENERATE_MODEL = 'grok-imagine-video-1.5';
/** Polling endpoint for one generation request. */
export function videoStatusUrl(requestId) {
    return `https://api.x.ai/v1/videos/${encodeURIComponent(requestId)}`;
}
/** Default delay between two status polls. */
export const DEFAULT_POLL_INTERVAL_MS = 3_000;
/** Default overall deadline for one generation (submit → done). */
export const DEFAULT_MAX_WAIT_MS = 10 * 60_000;
/** xAI's supported clip length range in seconds. */
const DURATION_RANGE = { min: 1, max: 15 };
/**
 * Assemble the request body from tool arguments (hand-checks the non-empty
 * prompt and the duration range the schema DSL cannot express).
 */
export function buildVideoGenerateBody(args) {
    const prompt = args.prompt.trim();
    if (prompt.length === 0)
        throw new Error('video_generate: prompt must be a non-empty string');
    if (args.duration !== undefined
        && (!Number.isInteger(args.duration)
            || args.duration < DURATION_RANGE.min
            || args.duration > DURATION_RANGE.max)) {
        throw new Error(`video_generate: duration must be an integer between ${String(DURATION_RANGE.min)} and ${String(DURATION_RANGE.max)} seconds`);
    }
    const imageUrl = args.image_url?.trim();
    return {
        prompt,
        model: VIDEO_GENERATE_MODEL,
        ...args.duration === undefined ? {} : { duration: args.duration },
        ...args.aspect_ratio === undefined ? {} : { aspect_ratio: args.aspect_ratio },
        ...args.resolution === undefined ? {} : { resolution: args.resolution },
        ...imageUrl === undefined || imageUrl.length === 0 ? {} : { image: { url: imageUrl } },
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Extract the request id from the submit response. Throws when the payload
 * carries none.
 */
export function parseVideoStartResponse(payload) {
    const body = isRecord(payload) ? payload : {};
    if (typeof body.request_id !== 'string' || body.request_id.length === 0) {
        throw new Error('video_generate: the response carried no request_id');
    }
    return body.request_id;
}
/**
 * Decode one poll response. A `done` payload without a video URL and an
 * unrecognized status both throw (the poll loop cannot make progress on
 * either).
 */
export function parseVideoStatusResponse(payload) {
    const body = isRecord(payload) ? payload : {};
    switch (body.status) {
        case 'pending':
            return { status: 'pending' };
        case 'done': {
            const video = isRecord(body.video) ? body.video : {};
            if (typeof video.url !== 'string' || video.url.length === 0) {
                throw new Error('video_generate: the completed response carried no video URL');
            }
            return {
                status: 'done',
                url: video.url,
                ...typeof video.duration === 'number' ? { duration: video.duration } : {},
            };
        }
        case 'failed':
        case 'expired': {
            const error = isRecord(body.error) ? body.error : {};
            const detail = typeof error.message === 'string' && error.message.length > 0
                ? error.message
                : typeof body.error === 'string' && body.error.length > 0 ? body.error : undefined;
            return { status: body.status, ...detail === undefined ? {} : { detail } };
        }
        default:
            throw new Error(`video_generate: unexpected status ${JSON.stringify(body.status)}`);
    }
}
/** Directory the downloaded MP4 files are written to. */
export function videosDirectory() {
    return dshHomePath('plugins', 'subscriptions', 'videos');
}
/** Timestamped, collision-safe file name for one generated video. */
function videoFileName() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `video-${stamp}-${Math.random().toString(36).slice(2, 8)}.mp4`;
}
/** Bound a call-card title's prompt. */
function truncate(text, max = 60) {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
/** Abort-aware sleep between two polls. */
function sleep(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason instanceof Error ? signal.reason : new Error('video_generate: aborted'));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
/**
 * Build the `video_generate` tool definition.
 * @param options - grok session source, fetch implementation, and video directory.
 * @returns the tool to register on `ctx.tools`.
 */
export function createVideoGenerateTool(options) {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    return defineTool({
        name: 'video_generate',
        description: `Generate a short video (1-15 seconds) with the grok subscription (${VIDEO_GENERATE_MODEL}) `
            + 'and save it as an MP4 file. Generation is asynchronous and may take a minute or more; '
            + 'the tool waits for completion and returns the saved file path. '
            + 'Optionally animate a still image by passing image_url (image-to-video).',
        parameters: {
            prompt: { type: 'string', required: true, description: 'What the video should show.' },
            duration: {
                type: 'integer',
                description: 'Clip length in seconds (1-15); omit for the provider default.',
            },
            aspect_ratio: {
                type: 'string',
                enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'],
                description: 'Output aspect ratio; omit for the provider default (16:9).',
            },
            resolution: {
                type: 'string',
                enum: ['480p', '720p', '1080p'],
                description: 'Output resolution; omit for the provider default (480p). Higher is slower.',
            },
            image_url: {
                type: 'string',
                description: 'Optional public URL or base64 data URL of a JPEG/PNG/WebP image to animate '
                    + '(image-to-video); the image becomes the starting frame.',
            },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    path: { type: 'string', required: true },
                    url: { type: 'string', required: true },
                    duration: { type: 'number' },
                },
                additionalProperties: false,
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Saved video to ${value.path}`
                        + (value.duration === undefined ? '' : ` (${String(value.duration)}s)`)
                        + `\nTemporary provider URL (expires soon): ${value.url}`,
                }],
            // The client toolview fetches the bytes by bare file name through the
            // `/subscriptions-auth` `video` endpoint; meta hands it that name.
            presentationMeta: (_args, value) => ({
                fileName: basename(value.path),
                ...value.duration === undefined ? {} : { duration: value.duration },
            }),
        },
        presentCall: args => ({
            card: 'generic',
            title: `video_generate: ${truncate(args.prompt)}`,
        }),
        async execute(args, exec) {
            const body = buildVideoGenerateBody(args);
            const session = await options.tokens.session();
            const fetchFn = options.fetchFn ?? proxiedFetch;
            const headers = {
                'authorization': `Bearer ${session.accessToken}`,
                'accept': 'application/json',
            };
            const submit = await fetchFn(VIDEO_GENERATE_URL, {
                method: 'POST',
                headers: { ...headers, 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: exec.signal,
            });
            if (!submit.ok)
                throw await httpLlmError(submit, 'video_generate');
            const requestId = parseVideoStartResponse(await submit.json());
            const deadline = Date.now() + maxWaitMs;
            let done;
            for (;;) {
                await sleep(pollIntervalMs, exec.signal);
                const poll = await fetchFn(videoStatusUrl(requestId), {
                    method: 'GET',
                    headers,
                    signal: exec.signal,
                });
                if (!poll.ok)
                    throw await httpLlmError(poll, 'video_generate');
                const status = parseVideoStatusResponse(await poll.json());
                if (status.status === 'done') {
                    done = status;
                    break;
                }
                if (status.status === 'failed' || status.status === 'expired') {
                    throw new Error(`video_generate: generation ${status.status} (request ${requestId})`
                        + (status.detail === undefined ? '' : `: ${status.detail}`));
                }
                if (Date.now() >= deadline) {
                    throw new Error(`video_generate: timed out after ${String(maxWaitMs)}ms waiting for request ${requestId}`);
                }
            }
            // The MP4 lives on a separate signed host: no auth header on purpose.
            const download = await fetchFn(done.url, { method: 'GET', signal: exec.signal });
            if (!download.ok)
                throw await httpLlmError(download, 'video_generate download');
            const data = Buffer.from(await download.arrayBuffer());
            const directory = options.videosDir ?? videosDirectory();
            await mkdir(directory, { recursive: true });
            const path = join(directory, videoFileName());
            await writeFile(path, data);
            const value = {
                path,
                url: done.url,
                ...done.duration === undefined ? {} : { duration: done.duration },
            };
            return value;
        },
    });
}
