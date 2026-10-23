import { tokenMatches } from './control-queue.js'

/** Control-token HTTP header shared by Android-owned loopback routes. */
export const CONTROL_TOKEN_HEADER = 'x-dsh-control-token'

/** Environment variable carrying the engine's actual listening port (set by the shell spawn). */
export const ENGINE_PORT_ENV = 'DSH_ENGINE_PORT'

/** Default engine port when the shell did not pass an explicit value. */
export const DEFAULT_ENGINE_PORT = 4145

/**
 * Read the engine port for one authorization decision.
 *
 * Missing environment means the documented default. A present value must be a plain decimal port
 * in 1024..65535; `0`, whitespace, a sign, or any other text returns `null` so callers fail closed.
 * Never cache this at module scope: the engine module is imported before `server.listen()` updates
 * the environment, so a top-level array would freeze the pre-bind default.
 *
 * @param env - Environment view (injectable for tests).
 * @returns The listening port, or `null` when the supplied value is invalid.
 */
export function enginePortFromEnv(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env[ENGINE_PORT_ENV]
  if (raw === undefined) return DEFAULT_ENGINE_PORT
  if (!/^[0-9]+$/.test(raw)) return null
  const port = Number(raw)
  return Number.isSafeInteger(port) && port >= 1024 && port <= 65535 ? port : null
}

/**
 * Loopback authorities for the currently selected engine port.
 *
 * Only the actual listening port is trusted; every other loopback port is a different origin.
 * Returns an empty list when the environment is unusable, which makes all callers reject.
 */
export function loopbackAuthorities(env: Record<string, string | undefined> = process.env): string[] {
  const port = enginePortFromEnv(env)
  return port === null ? [] : [`127.0.0.1:${port}`, `localhost:${port}`]
}

/** Minimal Node request view required to apply route trust and token checks. */
export interface MobileRouteRequest {
  method?: string
  headers?: Record<string, string | string[] | undefined>
}

/** Minimal Node response view used for uniform fail-closed replies. */
export interface MobileRouteResponse {
  writeHead(code: number, headers: Record<string, string>): void
  end(body?: string): void
}

/** The upstream connection service's Host/Origin/browser-session trust result. */
export interface ConnectionRouteAuth {
  requestRejection(request: MobileRouteRequest): 401 | 403 | undefined
}

/** Dynamic sources for one Android-owned route authorization decision. */
export interface MobileRouteAuthOptions {
  /** Reads the current shell control token; callers must not cache the value. */
  token(): string | undefined
  /** When available, owns configured authorities and browser-session authentication. */
  connection?: ConnectionRouteAuth
}

/** Rejection payload returned before the route reads a body or invokes its operation. */
export interface MobileRouteRejection {
  code: 401 | 403
  body: string
}

function headerOf(headers: MobileRouteRequest['headers'], name: string): string | undefined {
  const value = headers?.[name]
  if (typeof value === 'string') return value
  return Array.isArray(value) ? value[0] : undefined
}

/**
 * Authorize an Android-owned exact/prefix route.
 *
 * The connection service is authoritative whenever present, so configured non-default hosts and
 * browser-session cookies retain their upstream semantics. A 403 Host/Origin rejection cannot be
 * bypassed by a control token. A 401 browser-session rejection may be satisfied by the current
 * shell control token for native loopback delivery. Deployments without connection retain a
 * loopback-only control-token fallback and otherwise fail closed.
 *
 * @param request - Incoming HTTP request headers.
 * @param options - Live control-token reader and optional connection service.
 * @returns `undefined` for an authorized request, otherwise a response description.
 */
export function authorizeMobileRoute(
  request: MobileRouteRequest,
  options: MobileRouteAuthOptions,
): MobileRouteRejection | undefined {
  const provided = headerOf(request.headers, CONTROL_TOKEN_HEADER)
  const connection = options.connection
  if (connection !== undefined) {
    try {
      const rejection = connection.requestRejection(request)
      if (rejection === undefined) return undefined
      if (rejection === 403) return { code: 403, body: '' }
      return tokenMatches(options.token(), provided)
        ? undefined
        : { code: 401, body: JSON.stringify({ ok: false, error: 'unauthorized' }) }
    } catch {
      return { code: 401, body: JSON.stringify({ ok: false, error: 'unauthorized' }) }
    }
  }

  const trusted = loopbackAuthorities()
  if (trusted.length === 0) return { code: 403, body: '' }
  const host = headerOf(request.headers, 'host')?.trim().toLowerCase()
  if (host === undefined || !trusted.includes(host)) {
    return { code: 403, body: '' }
  }
  if (headerOf(request.headers, 'sec-fetch-site')?.toLowerCase() === 'cross-site') return { code: 403, body: '' }
  const origin = headerOf(request.headers, 'origin')
  if (origin !== undefined && origin !== '' && !trusted.some((authority) => origin.toLowerCase() === `http://${authority}`)) {
    return { code: 403, body: '' }
  }
  return tokenMatches(options.token(), provided)
    ? undefined
    : { code: 401, body: JSON.stringify({ ok: false, error: 'unauthorized' }) }
}

/**
 * review C12：**公开只读**状态路由的回环栅栏。
 *
 * 这类路由（privilege/vdisplay status）载荷只有能力元数据，设计上不要求令牌（设置页/面板
 * 同日主轮询）；但它们曾完全无 Host/Origin 检查——同机任意应用的浏览器上下文都能读到
 * 授权状态与屏幕元数据。这里补最小栅栏：connection 服务的 Host/Origin 判定（403）优先，
 * 401（browser session 缺失）对公开只读面不强制；缺 connection 时退化为回环 Host 白名单
 * + sec-fetch-site/origin 检查。任何异常一律 403（fail-closed）。
 *
 * @returns `undefined` = 放行；`{code:403}` = 必须拒绝（调用方用 sendMobileRouteRejection 输出）。
 */
export function authorizePublicReadOnlyRoute(
  request: MobileRouteRequest,
  options: Pick<MobileRouteAuthOptions, 'connection'>,
): MobileRouteRejection | undefined {
  const connection = options.connection
  if (connection !== undefined) {
    try {
      return connection.requestRejection(request) === 403 ? { code: 403, body: '' } : undefined
    } catch {
      return { code: 403, body: '' }
    }
  }
  const trusted = loopbackAuthorities()
  if (trusted.length === 0) return { code: 403, body: '' }
  const host = headerOf(request.headers, 'host')?.trim().toLowerCase()
  if (host === undefined || !trusted.includes(host)) {
    return { code: 403, body: '' }
  }
  if (headerOf(request.headers, 'sec-fetch-site')?.toLowerCase() === 'cross-site') return { code: 403, body: '' }
  const origin = headerOf(request.headers, 'origin')
  if (origin !== undefined && origin !== '' && !trusted.some((authority) => origin.toLowerCase() === `http://${authority}`)) {
    return { code: 403, body: '' }
  }
  return undefined
}

/**
 * Send a no-store route-auth rejection without exposing route payloads to cross-origin callers.
 * @param response - HTTP response object.
 * @param rejection - Result returned by {@link authorizeMobileRoute}.
 */
export function sendMobileRouteRejection(response: MobileRouteResponse, rejection: MobileRouteRejection): void {
  if (rejection.code === 403) {
    response.writeHead(403, { 'cache-control': 'no-store' })
    response.end()
    return
  }
  response.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(rejection.body)
}
