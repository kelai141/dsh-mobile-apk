/**
 * GitHub OAuth device-authorization flow (RFC 8628) for providers that cannot
 * use the loopback redirect engine: no redirect URI, no PKCE, no client
 * secret. The user opens a verification URL and types a short code while the
 * plugin polls the token endpoint until GitHub releases the access token.
 * The management model (one attempt per provider, `isBusy`/`pending`/`cancel`)
 * mirrors {@link OAuthFlowManager} so the auth controller can treat both
 * engines uniformly.
 */
import { proxiedFetch } from '../http.js';
/** Default poll interval when the device-code response omits one. */
const DEFAULT_INTERVAL_SEC = 5;
/** Default device-code lifetime when the response omits one (GitHub: 15 minutes). */
const DEFAULT_EXPIRES_IN_SEC = 900;
/** Sleep for `ms`, rejecting early when the signal aborts. */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
            return;
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        timer.unref();
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
/**
 * Own the set of in-flight device-flow attempts, keyed by provider. One
 * attempt per provider at a time; an attempt removes itself when it settles.
 */
export class DeviceFlowManager {
    attempts = new Map();
    /**
     * Whether a device-flow attempt is running for one provider.
     * @param provider - the provider route.
     * @returns true while an attempt is polling.
     */
    isBusy(provider) {
        return this.attempts.has(provider);
    }
    /**
     * The pending attempt for one provider, when any.
     * @param provider - the provider route.
     * @returns the in-flight attempt, or `undefined`.
     */
    pending(provider) {
        return this.attempts.get(provider);
    }
    /**
     * Start a device-flow attempt: request a device code, then poll the token
     * endpoint in the background of `waitToken`.
     * @param provider - the provider route (one attempt at a time).
     * @param spec - static flow facts for this provider.
     * @returns the live attempt; its `waitToken()` settles the login.
     * @throws when an attempt is already running or the device-code request fails.
     */
    async start(provider, spec) {
        if (this.attempts.has(provider)) {
            throw new Error(`a ${provider} login attempt is already in progress`);
        }
        const fetchFn = spec.fetchFn ?? proxiedFetch;
        const response = await fetchFn(spec.deviceCodeUrl, {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ client_id: spec.clientId, scope: spec.scope }).toString(),
        });
        if (!response.ok) {
            throw new Error(`${provider} device-code request failed (HTTP ${String(response.status)})`);
        }
        const wire = await response.json();
        if (typeof wire.device_code !== 'string' || wire.device_code.length === 0
            || typeof wire.user_code !== 'string' || wire.user_code.length === 0
            || typeof wire.verification_uri !== 'string' || wire.verification_uri.length === 0) {
            throw new Error(`${provider} device-code response is missing device_code/user_code/verification_uri`);
        }
        const intervalSec = typeof wire.interval === 'number' && wire.interval > 0
            ? wire.interval
            : DEFAULT_INTERVAL_SEC;
        const expiresInSec = typeof wire.expires_in === 'number' && wire.expires_in > 0
            ? wire.expires_in
            : DEFAULT_EXPIRES_IN_SEC;
        const controller = new AbortController();
        let resolveToken;
        let rejectToken;
        const tokenPromise = new Promise((resolve, reject) => {
            resolveToken = resolve;
            rejectToken = reject;
        });
        // The promise settles exactly once, from the poll loop below; an unhandled
        // rejection must not surface if nobody awaited waitToken after a cancel.
        tokenPromise.catch(() => undefined);
        const settle = (error, token) => {
            // Identity check: a late settle from a stale attempt (its poll loop or a
            // cancel arriving after it already settled) must not kill a NEW attempt
            // the user started for the same provider.
            if (this.attempts.get(provider) !== attempt)
                return;
            this.attempts.delete(provider);
            if (error !== undefined)
                rejectToken(error);
            else if (token !== undefined)
                resolveToken(token);
        };
        const poll = async () => {
            let intervalMs = intervalSec * 1000;
            const deadline = Date.now() + expiresInSec * 1000;
            while (true) {
                await sleep(intervalMs, controller.signal);
                if (Date.now() >= deadline) {
                    settle(new Error(`login timed out after ${String(Math.round(expiresInSec))}s`));
                    return;
                }
                const pollResponse = await fetchFn(spec.tokenUrl, {
                    method: 'POST',
                    headers: {
                        'accept': 'application/json',
                        'content-type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams({
                        client_id: spec.clientId,
                        device_code: wire.device_code,
                        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    }).toString(),
                    signal: controller.signal,
                });
                const result = await pollResponse.json();
                if (typeof result.access_token === 'string' && result.access_token.length > 0) {
                    settle(undefined, result.access_token);
                    return;
                }
                switch (result.error) {
                    case 'authorization_pending':
                        break;
                    case 'slow_down':
                        // RFC 8628 §3.5: add five seconds to the poll interval.
                        intervalMs += 5000;
                        break;
                    case 'access_denied':
                        settle(new Error('login declined on the GitHub authorization page'));
                        return;
                    case 'expired_token':
                        settle(new Error('the device code expired before authorization completed'));
                        return;
                    default:
                        settle(new Error(`${provider} device-flow polling failed: ${result.error_description ?? result.error ?? `HTTP ${String(pollResponse.status)}`}`));
                        return;
                }
            }
        };
        const attempt = {
            verificationUrl: wire.verification_uri,
            userCode: wire.user_code,
            waitToken: () => tokenPromise,
            cancel: () => {
                controller.abort(new Error('login cancelled'));
                settle(new Error('login cancelled'));
            },
        };
        this.attempts.set(provider, attempt);
        void poll().catch((error) => {
            // Aborts land here from sleep/fetch; everything else is a transport or
            // parse failure worth surfacing as the login failure.
            settle(error instanceof Error ? error : new Error(String(error)));
        });
        return attempt;
    }
}
