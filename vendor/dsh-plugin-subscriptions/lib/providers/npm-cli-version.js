import { proxiedFetch } from '../http.js';
/** Stable `major.minor.patch` only: prerelease and platform tags are not client versions. */
const STABLE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
/**
 * Compare two stable `major.minor.patch` versions numerically.
 * @returns negative when `a` is older, positive when newer, 0 when equal.
 */
export function compareVersions(a, b) {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    const different = left.findIndex((part, index) => part !== right[index]);
    return different === -1 ? 0 : left[different] - right[different];
}
/**
 * Lazy, shared-per-plugin lookup of an official CLI's newest stable version
 * on npm. Subscription endpoints gate new models on the client version they
 * see, so presenting the released CLI's version keeps new models usable
 * without a plugin release for every CLI bump.
 */
export class NpmCliVersionCache {
    options;
    presented;
    /** Whether a lookup has finished yet, successfully or not. */
    settled = false;
    expiresAt = 0;
    pending;
    fetchFn;
    now;
    timeoutMs;
    constructor(options) {
        this.options = options;
        this.fetchFn = options.fetchFn ?? proxiedFetch;
        this.now = options.now ?? Date.now;
        this.timeoutMs = options.timeoutMs ?? 5000;
    }
    /** A manual catalog refresh also checks for a newly released CLI. */
    invalidate() { this.expiresAt = 0; }
    resolve() {
        if (this.pending !== undefined)
            return this.pending;
        if (this.presented !== undefined && this.now() < this.expiresAt)
            return Promise.resolve(this.presented.version);
        this.pending = this.refresh().finally(() => { this.pending = undefined; });
        return this.pending;
    }
    /**
     * The version presented right now, without waiting on the registry;
     * undefined until the first lookup finishes, so a lookup still in flight
     * is never reported as a failed one.
     */
    current() {
        return this.settled ? this.presented : undefined;
    }
    async refresh() {
        const current = (this.presented ??= this.options.floor()).version;
        const { url, label } = this.options;
        const controller = new AbortController();
        let timer;
        try {
            const lookup = async () => {
                const response = await this.fetchFn(url, {
                    headers: { accept: 'application/json' },
                    redirect: 'error',
                    signal: controller.signal,
                });
                if (!response.ok)
                    throw new Error(`${label} version lookup failed`);
                const payload = await response.json();
                const version = payload?.version;
                // Ignore prerelease/platform tags and malformed or regressed metadata.
                if (typeof version !== 'string' || !STABLE_VERSION.test(version)) {
                    throw new Error(`Invalid stable ${label} version`);
                }
                if (compareVersions(version, current) < 0)
                    throw new Error(`Older ${label} version`);
                return version;
            };
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(new Error(`${label} version lookup timed out`));
                }, this.timeoutMs);
            });
            // Also bounded when an injected transport ignores cancellation.
            this.presented = { version: await Promise.race([lookup(), timeout]), source: 'npm' };
            this.expiresAt = this.now() + 6 * 60 * 60_000;
        }
        catch {
            // Retain last-known good; on first use this is the floor.
            this.expiresAt = this.now() + 5 * 60_000;
        }
        finally {
            clearTimeout(timer);
            this.settled = true;
        }
        return this.presented.version;
    }
}
