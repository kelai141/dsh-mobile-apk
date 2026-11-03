/**
 * Minimal SSE byte-stream parser: reassembles chunks, splits CRLF/LF lines,
 * joins multi-`data:` payloads, skips comments and non-data fields, and
 * dispatches an event on its blank-line terminator — or at EOF when the last
 * frame arrived without the trailing blank line (see {@link parseSse}).
 *
 * Two bounds exist here on purpose; both are derived, not guessed (issue #1284):
 *
 * ① {@link MAX_PENDING_CHARS} — the reassembly buffer. A stream that never sends
 *    a newline can otherwise grow it without limit while every chunk resets the
 *    idle watchdog, so the "idle" defence is defeated by the very traffic that
 *    is exhausting memory.
 * ② {@link EOF_FRAME_GRACE} — the "did the last frame end with a blank line"
 *    decision below.
 */
/**
 * Reassembly-buffer ceiling, in UTF-16 code units (what `String.length` counts).
 *
 * How the number is derived
 * -------------------------
 * The buffer only grows while a **single SSE event** is incomplete, so the
 * question is "how big can one legitimate event get?", not "how big can a
 * response get". Per frame:
 *
 *   · Chat-completions / Responses deltas are token-sized: the largest single
 *     delta observed in providers' own fixtures is a base64 image block, and the
 *     harness caps one submitted attachment at 5 MiB encoded
 *     (`dsh-attachment-local`: "Default maximum encoded bytes for one submitted
 *     image"). Inline images therefore reach this parser as **one** `data:`
 *     line of at most ~5 MiB (6.99 M chars of base64) plus a JSON envelope.
 *   · Anthropic sends thinking blocks and tool inputs the same way, one JSON
 *     object per frame.
 *   · Every other frame is kilobytes at most (a 4k-token chunk is ~16 KiB).
 *
 * So the legitimate worst case is bounded by the attachment ceiling, not by the
 * response size — a long conversation is many small frames, never one huge one.
 * 8 MiB (8_388_608 chars) is that 5 MiB base64 payload (~6.99 M chars) plus
 * room for the JSON envelope and provider-side formatting, rounded up to a power
 * of two so the check is a comparison against a number a reader can verify
 * against the attachment cap. Anything past it cannot be a legal single frame,
 * so it is a hostile or corrupt stream, not a slow one.
 *
 * Do not raise this without redoing that derivation: the failure it prevents is
 * heap exhaustion on the host, and the harness attachment cap is what makes the
 * number finite.
 */
export const MAX_PENDING_CHARS = 8 * 1024 * 1024;
/**
 * Frame terminator accepted at EOF.
 *
 * The SSE spec allows a stream to close right after the last `data:` line,
 * without the blank line that would dispatch it: servers do this on the final
 * frame to save a round trip. Requiring the blank line therefore turned a
 * perfectly legal end-of-stream into `STREAM_CLOSED` on all three wires
 * (issue #1284 ②). At EOF the remaining `data:` lines are one complete frame and
 * are dispatched.
 */
const EOF_FRAME_GRACE = true;
/**
 * Raise a typed error for an oversized frame. Kept as a factory so the message
 * carries the observed size and the buffer that was actually measured (the
 * caller logs it; a bare "too big" is not actionable).
 *
 * issue #1309 ②: the message names the **frame** buffer, not "no newline".
 * The old wording described a different check (a chunk that never terminated a
 * line) and was flatly false when the ceiling tripped on a buffer full of
 * newline-terminated frames — which is exactly the bug it was misreporting.
 * @param frameChars - characters accumulated in the current, still-open frame.
 * @param bufferChars - total reassembly buffer at the moment of the throw.
 * @returns the error to throw.
 */
function oversizedFrame(frameChars, bufferChars) {
    return new Error(`SSE frame exceeded ${String(MAX_PENDING_CHARS)} chars before its terminating blank line (frame ${String(frameChars)}, reassembly buffer ${String(bufferChars)}); refusing to grow further`);
}
/**
 * Decode an SSE byte stream into events.
 * @param stream - raw response bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onActivity - called when a read **delivered bytes**; drives the idle
 *   watchdog's progress accounting (a stream that keeps delivering counts as
 *   alive; see `idleWatchdog`).
 * @returns events in arrival order.
 * @throws when one frame exceeds {@link MAX_PENDING_CHARS} without a newline.
 */
export async function* parseSse(stream, onActivity) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let dataLines = [];
    let eventName;
    /** Characters accumulated in the frame currently being assembled. */
    const frameChars = () => dataLines.reduce((n, line) => n + line.length + 1, 0);
    const dispatch = () => {
        // issue #1309 ①: a frame with no `data:` field is **not** dispatched.
        // WHATWG's "dispatch the event" step says so outright, and the shape it
        // protects here is the keep-alive: `event: ping\n\n` carries a type and
        // nothing else, so turning it into `{ data: '' }` handed every consumer
        // an empty string to `JSON.parse` — one heartbeat killed the whole chat
        // stream with MALFORMED_RESPONSE. The type buffer is still cleared, or
        // the next frame would inherit a stale event name.
        if (dataLines.length === 0) {
            eventName = undefined;
            return undefined;
        }
        // issue #1340: the ceiling has to be enforced **here**, at the single
        // point where a frame becomes an event. Checking only the still-open
        // frame (below) missed every frame that arrived already terminated:
        // a read carrying `data: <9 MiB>\n\n` was scanned, dispatched and
        // handed to `JSON.parse` without the limit ever seeing it, while the
        // byte-identical frame split into 64 KiB reads was rejected. Same bytes,
        // same frame, opposite verdicts — so the limit was still a property of
        // how the network happened to split the stream.
        const consumed = frameChars();
        if (consumed > MAX_PENDING_CHARS)
            throw oversizedFrame(consumed, consumed + pending.length);
        const event = { data: dataLines.join('\n'), ...eventName === undefined ? {} : { event: eventName } };
        dataLines = [];
        eventName = undefined;
        return event;
    };
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                // EOF may close a legal stream without the dispatching blank line.
                if (EOF_FRAME_GRACE) {
                    const tail = dispatch();
                    if (tail !== undefined)
                        yield tail;
                }
                return;
            }
            onActivity?.();
            pending += decoder.decode(value, { stream: true });
            // ① issue #1309 ②: the ceiling bounds **one frame**, so it is checked
            //    against the frame buffer, not against a raw read. Measuring
            //    `pending` before scanning made the limit a property of network
            //    chunking: one read carrying 9 MiB of perfectly well-formed small
            //    frames (943,719 of them, every one newline-terminated) tripped a
            //    "frame too large" error, while the identical bytes split into
            //    64 KiB reads sailed through. The buffer is scanned first now, so
            //    `pending` only holds what has not yet been consumed, and
            //    `frameChars` is what the ceiling actually governs.
            let newline = pending.indexOf('\n');
            while (newline >= 0) {
                let line = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                newline = pending.indexOf('\n');
                if (line.endsWith('\r'))
                    line = line.slice(0, -1);
                if (line.length === 0) {
                    const event = dispatch();
                    if (event !== undefined)
                        yield event;
                }
                else if (line.startsWith(':')) {
                    onActivity?.();
                }
                else if (line.startsWith('data:')) {
                    dataLines.push(line.slice(5).replace(/^ /, ''));
                }
                else if (line.startsWith('event:')) {
                    eventName = line.slice(6).replace(/^ /, '');
                }
            }
            // ① (continued) The scan leaves behind only what belongs to the frame
            //    still being assembled: `pending` is its unterminated tail and
            //    `dataLines` are the `data:` lines already consumed from it. A
            //    read that delivered many complete frames leaves both at zero —
            //    they were dispatched, and `dispatch()` capped each of them.
            //
            //    issue #1340: this check covers the frame that has NOT terminated
            //    yet (a peer dribbling an endless line, where no `dispatch()` will
            //    ever run); `dispatch()` covers the frame that just closed. Both
            //    are needed — capping only here is what let a single-read
            //    terminated frame through, capping only in `dispatch()` would let
            //    an unterminated line grow without bound until EOF.
            const openFrameChars = pending.length + frameChars();
            if (openFrameChars > MAX_PENDING_CHARS)
                throw oversizedFrame(openFrameChars, openFrameChars);
        }
    }
    finally {
        // A terminal SSE frame can precede HTTP EOF; returning or decoding failure
        // must close the remaining body rather than leave the connection reading.
        try {
            await reader.cancel();
        }
        catch { /* preserve the original stream outcome */ }
        reader.releaseLock();
    }
}
