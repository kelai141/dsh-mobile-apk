import { createHash } from 'node:crypto';
const REPLAY_KIND = 'subscriptions-account-replay';
/** Bind opaque provider replay to the concrete account/model behind a public route alias. */
export async function* streamAccountWithReplay(adapter, options, account, model = options.model) {
    const key = createHash('sha256').update(JSON.stringify([options.provider, account, model])).digest('hex');
    const messages = options.messages.map(message => {
        if (message.role !== 'assistant' || message.source?.replayState === undefined)
            return message;
        const source = message.source;
        if (source.replayState === null || typeof source.replayState !== 'object' || !('response' in source.replayState))
            return message;
        const replay = source.replayState;
        const response = replay.response;
        if (response !== null && typeof response === 'object' && 'kind' in response && response.kind === REPLAY_KIND) {
            if ('version' in response && response.version === 1 && 'key' in response && response.key === key && 'state' in response) {
                return { ...message, source: { ...source, provider: options.provider, model, replayState: { ...replay, response: response.state } } };
            }
            const { replayState: _discarded, ...withoutReplay } = source;
            return { ...message, source: withoutReplay };
        }
        // Unwrapped older histories retain their existing direct-route behavior.
        // An alias alone cannot identify which concrete member produced old replay.
        if (source.provider === options.provider && source.model === model)
            return message;
        const { replayState: _discarded, ...withoutReplay } = source;
        return { ...message, source: withoutReplay };
    });
    for await (const chunk of adapter.streamAccount({ ...options, model, messages }, account)) {
        if (chunk.type === 'finish' && chunk.replayState !== undefined) {
            yield { ...chunk, replayState: { ...chunk.replayState, response: {
                        kind: REPLAY_KIND, version: 1, key, state: chunk.replayState.response,
                    } } };
        }
        else
            yield chunk;
    }
}
