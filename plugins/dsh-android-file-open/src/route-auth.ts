/**
 * 来件三条 exact 路由的插件侧鉴权（FX-205.1/.3/.4）。
 *
 * 为什么必须落在插件侧：上游 webserver 的 `match()`（dsh/packages/host/webserver/src/index.ts:317-327）
 * **先查 exact 表、命中即返回**，`kind:'exact'` 注册的路由因此永不经过 /api 前缀的 cookie
 * 鉴权与 Host 校验（上游零兜底）。鉴权只能由注册方自己做，且必须在 handler 体内**先于
 * 一切副作用**执行（拒绝时工作区零变化）。
 *
 * 两道栅栏 + 两种凭据：
 *  1. Host 白名单（DNS rebinding 防线）：Host 必须精确等于 127.0.0.1:3080 / localhost:3080
 *     —— 浏览器把 Host 填成它以为的目标，rebound 页面带的是攻击者域名，这是 rebinding 伪造
 *     不了的头；不匹配一律 403 且**响应体为空**（不得让 rebound 页面读到工作区清单）。
 *  2. Origin / Sec-Fetch-Site（跨站防线）：Origin 在场时必须与 Host 同源；显式
 *     `sec-fetch-site: cross-site` 一律拒绝（同样 403 + 空体）。
 *  3. 凭据（二者其一）：壳侧控制令牌（`x-dsh-control-token`，与 dsh-android-bridge 控制
 *     队列同一枚壳侧令牌，经 `shellControlToken()` 实时读取）**或**上游浏览器会话
 *     （`connection.requestRejection(req) === undefined`，WebView 页面自带 cookie）。
 *     两者皆缺 → 401（fail-closed）。
 */
import { tokenMatches } from '@dsh-android/dsh-android-bridge'

/** 允许的请求 authority（引擎监听 127.0.0.1:3080；壳侧与本插件两侧都按该端口写死）。 */
export const TRUSTED_HOSTS = ['127.0.0.1:3080', 'localhost:3080']

/** 壳侧与本插件共享的控制令牌头（壳侧 FileIncoming 投递必须带）。 */
export const CONTROL_TOKEN_HEADER = 'x-dsh-control-token'

/** 鉴权只需要的最小请求面（Node IncomingMessage 满足）。 */
export interface RouteRequestLike {
  method?: string
  headers?: Record<string, string | string[] | undefined>
}

/** 鉴权只需要的最小响应面（`end()` 允许空体——403 拒绝不得回任何内容）。 */
export interface IncomingRes {
  writeHead(code: number, headers: Record<string, string>): void
  end(body?: string): void
}

/** 上游 connection 服务的信任栅栏（浏览器会话；缺该服务时只认令牌）。 */
export interface ConnectionFace {
  requestRejection(request: RouteRequestLike): 401 | 403 | undefined
}

export interface AuthResult {
  code: 401 | 403
  body: string
}

export interface AuthOptions {
  /** 当前控制令牌实时值（壳侧 prefs；显式测试开关下可用 env）。 */
  token(): string | undefined
  /** 上游浏览器会话栅栏；未提供 = 该部署没有浏览器面，只认令牌。 */
  connection?: ConnectionFace
}

function headerOf(headers: RouteRequestLike['headers'], name: string): string | undefined {
  const value = headers?.[name]
  if (typeof value === 'string') return value
  return Array.isArray(value) ? value[0] : undefined
}

/**
 * 判定一次来件路由请求是否获准。
 * @param req - 请求事实（method/headers）。
 * @param options - 令牌读取器与浏览器会话栅栏。
 * @returns undefined = 放行；否则为应写的拒绝结果（403 的 body 恒为空串）。
 */
export function authorizeIncomingRoute(
  req: RouteRequestLike,
  options: AuthOptions,
): AuthResult | undefined {
  const host = headerOf(req.headers, 'host')?.trim().toLowerCase()
  if (host === undefined || !TRUSTED_HOSTS.includes(host)) return { code: 403, body: '' }
  if (headerOf(req.headers, 'sec-fetch-site')?.toLowerCase() === 'cross-site') return { code: 403, body: '' }
  const origin = headerOf(req.headers, 'origin')
  if (origin !== undefined && origin !== '' && !TRUSTED_HOSTS.some((h) => origin.toLowerCase() === `http://${h}`)) {
    return { code: 403, body: '' }
  }
  if (tokenMatches(options.token(), headerOf(req.headers, CONTROL_TOKEN_HEADER))) return undefined
  const connection = options.connection
  if (connection === undefined) return { code: 401, body: JSON.stringify({ ok: false, error: 'unauthorized' }) }
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return undefined
  return { code: rejection, body: '' }
}
