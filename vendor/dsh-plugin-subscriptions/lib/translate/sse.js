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
 * carries the observed size (the caller logs it; a bare "too big" is not
 * actionable).
 * @param observed - reassembly buffer length when the ceiling was crossed.
 * @returns the error to throw.
 */
function oversizedFrame(observed) {
    return new Error(`SSE frame exceeded ${String(MAX_PENDING_CHARS)} chars without a newline (buffer reached ${String(observed)}); refusing to grow further`);
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
    const dispatch = () => {
        if (dataLines.length === 0 && eventName === undefined)
            return undefined;
        const event = dataLines.length === 0
            ? { data: '', ...eventName === undefined ? {} : { event: eventName } }
            : { data: dataLines.join('\n'), ...eventName === undefined ? {} : { event: eventName } };
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
            // ① Bound the buffer BEFORE scanning: a chunk that brings no newline
            //    must not be able to grow it past the ceiling unchecked.
            if (pending.length > MAX_PENDING_CHARS)
                throw oversizedFrame(pending.length);
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
