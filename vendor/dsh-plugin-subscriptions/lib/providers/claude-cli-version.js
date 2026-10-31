import { claudeCliVersionFloor } from './claude.js';
import { NpmCliVersionCache } from './npm-cli-version.js';
/**
 * Public metadata only: never send subscription credentials to this endpoint.
 * `latest`, not `stable`: the endpoint gates new models on versions that
 * reach `stable` about a week later.
 */
export const CLAUDE_CLI_VERSION_URL = 'https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest';
/**
 * Lazy, shared-per-plugin lookup of Claude Code's newest release, never
 * below the local CLI or the bundled fallback version.
 */
export class ClaudeCliVersionCache extends NpmCliVersionCache {
    constructor(fetchFn, now, timeoutMs, detect) {
        super({
            url: CLAUDE_CLI_VERSION_URL,
            label: 'Claude Code',
            floor: () => claudeCliVersionFloor(detect),
            ...fetchFn === undefined ? {} : { fetchFn },
            ...now === undefined ? {} : { now },
            ...timeoutMs === undefined ? {} : { timeoutMs },
        });
    }
}
