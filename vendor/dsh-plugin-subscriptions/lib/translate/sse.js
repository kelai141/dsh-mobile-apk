/**
 * Minimal SSE byte-stream parser (~30 lines of framing): reassembles chunks,
 * splits CRLF/LF lines, joins multi-`data:` payloads, skips comments and
 * non-data fields, and dispatches an event only on its blank-line terminator.
 * An unterminated tail at EOF is truncation and is dropped, matching the
 * spec-strict framing the harness's own adapters use.
 */
/**
 * Decode an SSE byte stream into events.
 * @param stream - raw response bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onActivity - called on every received chunk and comment line; drives the idle watchdog.
 * @returns events in arrival order.
 */
export async function* parseSse(stream, onActivity) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let dataLines = [];
    let eventName;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                return;
            onActivity?.();
            pending += decoder.decode(value, { stream: true });
            let newline = pending.indexOf('\n');
            while (newline >= 0) {
                let line = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                newline = pending.indexOf('\n');
                if (line.endsWith('\r'))
                    line = line.slice(0, -1);
                if (line.length === 0) {
                    if (dataLines.length > 0) {
                        yield { data: dataLines.join('\n'), ...eventName === undefined ? {} : { event: eventName } };
                    }
                    dataLines = [];
                    eventName = undefined;
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
