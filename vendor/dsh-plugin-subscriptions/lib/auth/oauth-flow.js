/**
 * Generic OAuth authorization-code flow engine: one temporary loopback HTTP
 * server per login attempt receives the provider's redirect, validates
 * `state`, and yields the authorization `code`. A pasted callback URL or bare
 * code can substitute for the browser redirect (`manual`), and the user can
 * abort (`cancel`). At most one attempt per provider runs at a time.
 */
import { createServer } from 'node:http';
import { createPkce, randomHex, randomToken } from './pkce.js';
/** Default attempt lifetime: three minutes for the user to complete login. */
export const DEFAULT_FLOW_TIMEOUT_MS = 180_000;
const SUCCESS_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>Login successful</title></head>'
    + '<body style="font-family:sans-serif"><h1>Login successful</h1>'
    + '<p>You can close this tab and return to DeepSeek Harness.</p></body></html>';
const MOBILE_RETURN = 'intent://oauth-return#Intent;scheme=com.dsharnessmobile.shell;package=com.dsharnessmobile.shell;end';
/**
 * 直连 scheme 的回跳链接（与壳侧 manifest 的 intent-filter 逐字一致）。
 *
 * 为什么要两路：`intent://…#Intent;…` 在部分 Chromium 内核与内置浏览器里不被当作
 * Android Intent 语法解析，而是当成普通 URL 交给「打开方式」选择器 —— 真机 2026-11-07
 * 实测：点按钮能正常回到 DeepCode，自动跳转却弹出只含钉钉/Edge 的选择器。
 * 因此自动跳转改走这条普通深链（系统能唯一定位到 MainActivity），
 * `intent://` 那一条仍留给按钮做兜底。
 */
const MOBILE_RETURN_DIRECT = 'com.dsharnessmobile.shell://oauth-return';
export function callbackReceivedPage(isMobile = Boolean(process.env.DSH_APP_VERSION)) {
    if (!isMobile) return SUCCESS_PAGE;
    // This page confirms receipt of the callback, not the subsequent token exchange.
    // The app link contains no provider, code, state or callback URL.
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<title>返回 DeepCode / Return to DeepCode</title>'
        + '<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;padding:32px 24px;max-width:32rem;margin-inline:auto}a{display:inline-block;padding:12px 18px;background:#245bce;color:white;border-radius:12px;text-decoration:none}</style></head>'
        + '<body><main><h1>已收到授权</h1><p>请返回 DeepCode，等待应用完成账号连接。</p>'
        + '<p lang="en">Authorization received. Return to DeepCode to finish connecting your account.</p>'
        + '<a id="return" href="' + MOBILE_RETURN + '">返回 DeepCode / Return to DeepCode</a>'
        + '<p>如果没有跳转，请点上方按钮，或从最近任务打开 DeepCode。<br>'
        + '<span lang="en">If nothing opens, tap the button or switch back to DeepCode from Recents.</span></p>'
        + '</main><script>if (/Android/i.test(navigator.userAgent)) location.href = '
        + JSON.stringify(MOBILE_RETURN_DIRECT) + ';</script></body></html>';
}
function failurePage(detail) {
    return '<!doctype html><html><head><meta charset="utf-8"><title>Login failed</title></head>'
        + `<body style="font-family:sans-serif"><h1>Login failed</h1><p>${detail.replace(/[<>&]/g, '')}</p></body></html>`;
}
/**
 * Loopback addresses one listen host covers. `localhost` resolves to ::1 or
 * 127.0.0.1 depending on the client, and Node binds exactly one of them per
 * listen call — a browser picking the other family gets connection-refused
 * and the login times out, so both families must serve the callback.
 */
function listenHosts(host) {
    return host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
}
/** True when the address family does not exist on this machine (safe to skip), unlike a taken port. */
function familyUnavailable(error) {
    const code = error.code;
    return code === 'EADDRNOTAVAIL' || code === 'EPROTONOSUPPORT';
}
/**
 * Listen on the first port of the spec free on every loopback family;
 * rejects when every port fails. Ephemeral ports (0) are retried so each
 * family can be re-bound onto the first family's assigned port.
 */
async function listen(handler, spec) {
    const hosts = listenHosts(spec.host);
    const candidates = spec.ports.flatMap(port => (port === 0 ? [0, 0, 0] : [port]));
    let lastError;
    for (const candidate of candidates) {
        const servers = [];
        let port = candidate;
        let unusable = false;
        for (const host of hosts) {
            const server = createServer(handler);
            try {
                await new Promise((resolve, reject) => {
                    const onError = (error) => reject(error);
                    server.once('error', onError);
                    server.listen(port, host, () => {
                        server.removeListener('error', onError);
                        resolve();
                    });
                });
                const address = server.address();
                if (address === null)
                    throw new Error(`callback server on ${host}:${port} has no address`);
                if (port === 0)
                    port = address.port;
                servers.push(server);
            }
            catch (error) {
                server.close();
                if (familyUnavailable(error))
                    continue;
                lastError = error;
                unusable = true;
                break;
            }
        }
        if (unusable || servers.length === 0) {
            for (const server of servers)
                server.close();
            continue;
        }
        return { servers, port };
    }
    throw lastError instanceof Error
        ? lastError
        : new Error(`callback server could not listen on ${spec.host} (ports ${spec.ports.join(', ')})`);
}
/**
 * Own the set of in-flight login attempts, keyed by provider. One attempt per
 * provider at a time; an attempt removes itself when it settles.
 */
export class OAuthFlowManager {
    attempts = new Map();
    /**
     * Whether a login attempt is running for one provider.
     * @param provider - the provider route.
     * @returns true while an attempt is waiting for its code.
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
     * Start a login attempt: mint PKCE/state, open the loopback callback
     * server, and build the authorize URL.
     * @param provider - the provider route (one attempt at a time).
     * @param spec - static flow facts for this provider.
     * @returns the live attempt; its `waitCode()` settles the login.
     * @throws when an attempt is already running or no callback port is free.
     */
    async start(provider, spec) {
        if (this.attempts.has(provider)) {
            throw new Error(`a ${provider} login attempt is already in progress`);
        }
        const input = {
            redirectUri: '',
            state: randomToken(32),
            pkce: createPkce(),
            nonce: randomHex(8),
        };
        const timeoutMs = spec.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;
        let resolveCode;
        let rejectCode;
        const codePromise = new Promise((resolve, reject) => {
            resolveCode = resolve;
            rejectCode = reject;
        });
        let settled = false;
        let timer;
        let servers = [];
        const handler = (request, response) => {
            const url = new URL(request.url ?? '/', 'http://localhost');
            if (url.pathname !== spec.callbackPath) {
                response.writeHead(404, { 'content-type': 'text/plain' });
                response.end('not found');
                return;
            }
            const errorDescription = url.searchParams.get('error_description') ?? url.searchParams.get('error');
            if (errorDescription !== null) {
                response.writeHead(200, { 'content-type': 'text/html' });
                response.end(failurePage(errorDescription));
                settle(new Error(`authorization failed: ${errorDescription}`));
                return;
            }
            if (url.searchParams.get('state') !== input.state) {
                // A stray or replayed redirect must not kill the real attempt.
                response.writeHead(400, { 'content-type': 'text/plain' });
                response.end('state mismatch');
                return;
            }
            const code = url.searchParams.get('code');
            if (code === null || code.length === 0) {
                response.writeHead(400, { 'content-type': 'text/plain' });
                response.end('missing authorization code');
                return;
            }
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
            response.end(callbackReceivedPage());
            settle(undefined, code);
        };
        const settle = (error, code) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            for (const server of servers) {
                server.close();
                server.closeAllConnections();
            }
            this.attempts.delete(provider);
            if (error !== undefined)
                rejectCode(error);
            else if (code !== undefined)
                resolveCode(code);
        };
        const bound = await listen(handler, spec.listen);
        servers = bound.servers;
        input.redirectUri = `http://${spec.listen.host}:${bound.port}${spec.callbackPath}`;
        timer = setTimeout(() => {
            settle(new Error(`login timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        timer.unref();
        const attempt = {
            authorizeUrl: spec.buildAuthorizeUrl(input),
            redirectUri: input.redirectUri,
            pkce: input.pkce,
            state: input.state,
            waitCode: () => codePromise,
            manual(rawInput) {
                if (settled)
                    throw new Error(`the ${provider} login attempt already finished`);
                const trimmed = rawInput.trim();
                let code;
                let pastedState;
                if (/^https?:\/\//i.test(trimmed)) {
                    const url = new URL(trimmed);
                    code = url.searchParams.get('code') ?? undefined;
                    pastedState = url.searchParams.get('state') ?? undefined;
                }
                else if (trimmed.includes('code=')) {
                    const params = new URLSearchParams(trimmed);
                    code = params.get('code') ?? undefined;
                    pastedState = params.get('state') ?? undefined;
                }
                else if (trimmed.length > 0 && !/\s/.test(trimmed)) {
                    code = trimmed;
                }
                if (code === undefined || code.length === 0) {
                    throw new Error('no authorization code found in the pasted input');
                }
                if (pastedState !== undefined && pastedState !== input.state) {
                    throw new Error('state mismatch: the pasted URL belongs to a different login attempt');
                }
                settle(undefined, code);
            },
            cancel() {
                settle(new Error('login cancelled'));
            },
        };
        this.attempts.set(provider, attempt);
        return attempt;
    }
}
