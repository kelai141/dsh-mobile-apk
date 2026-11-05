import { CODEX_CLIENT_VERSION } from './codex.js';
import { NpmCliVersionCache } from './npm-cli-version.js';
/** Public metadata only: never send subscription credentials to this endpoint. */
export const CODEX_VERSION_URL = 'https://registry.npmjs.org/@openai%2fcodex/latest';
/** Lazy, shared-per-plugin lookup of the official CLI's stable version. */
export class CodexClientVersionCache extends NpmCliVersionCache {
    constructor(fetchFn, now, timeoutMs) {
        super({
            url: CODEX_VERSION_URL,
            label: 'Codex',
            floor: () => ({ version: CODEX_CLIENT_VERSION, source: 'fallback' }),
            ...fetchFn === undefined ? {} : { fetchFn },
            ...now === undefined ? {} : { now },
            ...timeoutMs === undefined ? {} : { timeoutMs },
        });
    }
}
