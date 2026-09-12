/**
 * dsh-android-browser — 侧边栏 AI 专用浏览器（host 半）。
 *
 * 本轮范围：
 *  - 档位判定（P0 探针的可执行化）+ 设备实测基线；
 *  - **面板数据面**：只读 `/api/android/browser/status`（exact 路由 → **自带插件侧鉴权**，
 *    复用 dsh-android-file-open 的 route-auth 实现：Host 白名单 + Origin 同源 + 控制令牌/浏览器会话；
 *    这是 FX-205 批的既有教训：exact 路由绕过 /api 前缀栅栏，上游零兜底）；
 *  - 事实来源三档（壳桥 browserCaps → env 临时通道 → 实测基线），来源标签原样下发。
 *
 * 不做（等窗口）：壳侧 BrowserHost 与 browser* op（MainActivity.kt 归 Lead/dev-gesture）；
 * 插件挂载五处（scripts/** 属 dev-chain）；本插件不注册任何 AI 操作面（browser_* 工具在 P3）。
 *
 * 依据：docs/SIDEBAR-BROWSER-PLAN-2026-09-12.md、docs/IMPLEMENTATION-ACCEPTANCE-PLAN-2026-09-12.md、
 * 用户约束 docs/0.14.0-preview-USER-CONSTRAINTS.md U-1（入口 = 与「工作区文件」同级的右侧栏 tab 类型）。
 */
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import { BROWSER_OPS, BROWSER_ROUTES, BROWSER_TOOLS, IDENTITY_PROFILES, VIEWPORT_PRESETS } from './contract.js'
import { factsFromEnv, factsCacheReset, pickFacts, readFacts, type ControlFace, type FactsRead } from './facts.js'
// ── 插件侧路由鉴权（**自包含 + 不新增文件**）────────────────────────────────
// 两道 P0 教训都落在这一段：
//  ① 曾 import `@dsh-android/dsh-android-file-open/route-auth` → 跨包 subpath exports 依赖
//     "源码 exports + 注入保留 + profile 合并覆盖"三个面同时正确，任一回归即
//     ERR_PACKAGE_PATH_NOT_EXPORTED → 引擎启动即死；
//  ② 改成独立模块 `./route-auth.js` 后仍然死：注入链只替换**已存在**的成员、只为**整包缺席**
//     的包补文件，新文件不会进快照 → ERR_MODULE_NOT_FOUND。
//  故鉴权内联在本文件（包内成员集合保持与基座一致：index/facts/tier/contract）。
const TRUSTED_HOSTS = ['127.0.0.1:3080', 'localhost:3080']
const CONTROL_TOKEN_HEADER = 'x-dsh-control-token'
const CONTROL_TOKEN_TEST_ENV = 'DSH_CONTROL_TOKEN_TEST'
const CONTROL_TOKEN_ENV = 'DSH_CONTROL_TOKEN'
const MIN_TOKEN_LENGTH = 8
const SHELL_PREFS_DEFAULT = '/data/user/0/com.dsharnessmobile.shell/shared_prefs/dsh-adb.xml'

/** 鉴权只需要的最小请求面（Node IncomingMessage 满足）。 */
interface RouteRequestLike {
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
interface AuthOptions {
  token(): string | undefined
  connection?: ConnectionFace
}

function authHeaderOf(headers: RouteRequestLike['headers'], name: string): string | undefined {
  const value = headers?.[name]
  if (typeof value === 'string') return value
  return Array.isArray(value) ? value[0] : undefined
}

/** 令牌比对（本地回环 + 仅防同机误触）。 */
export function tokenMatches(expected: string | undefined, provided: unknown): boolean {
  if (typeof expected !== 'string' || expected.length < MIN_TOKEN_LENGTH) return false
  return typeof provided === 'string' && provided === expected
}

/** 壳侧 prefs 路径（env 显式优先；壳域以 TERMUX__PREFIX + DSH_HOME 判定）。 */
function shellPrefsPath(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.DSH_ADB_PREFS_PATH
  if (explicit) return explicit
  if (env.TERMUX__PREFIX && env.DSH_HOME) return SHELL_PREFS_DEFAULT
  return null
}

/**
 * 当前控制令牌实时值（ST-07：生产以壳侧 prefs 为准；env 只在显式测试开关下生效）。
 * @param env - 进程环境（测试可注入）。
 * @returns 令牌；缺失/过短 → undefined（调用方 fail-closed）。
 */
export function currentControlToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const valid = (v: unknown): string | undefined => (typeof v === 'string' && v.length >= MIN_TOKEN_LENGTH ? v : undefined)
  const path = shellPrefsPath(env)
  let fromPrefs: string | undefined
  if (path !== null) {
    try {
      fromPrefs = valid(/<string\s+name="controlToken">([^<]*)<\/string>/.exec(readFileSync(path, 'utf8'))?.[1])
    } catch {
      fromPrefs = undefined
    }
  }
  const flag = env[CONTROL_TOKEN_TEST_ENV]
  if (flag !== '1' && flag !== 'true') return fromPrefs
  return valid(env[CONTROL_TOKEN_ENV]) ?? fromPrefs
}

/**
 * 判定一次状态路由请求是否获准。
 * @param req - 请求事实（method/headers）。
 * @param options - 令牌读取器与浏览器会话栅栏。
 * @returns undefined = 放行；否则应写的拒绝结果（403 body 恒为空串）。
 */
export function authorizeIncomingRoute(req: RouteRequestLike, options: AuthOptions): { code: 401 | 403; body: string } | undefined {
  const host = authHeaderOf(req.headers, 'host')?.trim().toLowerCase()
  if (host === undefined || !TRUSTED_HOSTS.includes(host)) return { code: 403, body: '' }
  if (authHeaderOf(req.headers, 'sec-fetch-site')?.toLowerCase() === 'cross-site') return { code: 403, body: '' }
  const origin = authHeaderOf(req.headers, 'origin')
  if (origin !== undefined && origin !== '' && !TRUSTED_HOSTS.some((h) => origin.toLowerCase() === 'http://' + h)) {
    return { code: 403, body: '' }
  }
  if (tokenMatches(options.token(), authHeaderOf(req.headers, CONTROL_TOKEN_HEADER))) return undefined
  const connection = options.connection
  if (connection === undefined) return { code: 401, body: JSON.stringify({ ok: false, error: 'unauthorized' }) }
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return undefined
  return { code: rejection, body: '' }
}
// ── 鉴权段结束 ────────────────────────────────────────────────────────────
import { MEASURED_DEVICE_BASELINE, resolveBrowserTier, type BrowserFacts, type BrowserTierReport } from './tier.js'

export const name = 'dsh-android-browser'
export const inject = ['tools', 'webServer'] as const

export { resolveBrowserTier, MEASURED_DEVICE_BASELINE } from './tier.js'
export type { BrowserFacts, BrowserTierReport } from './tier.js'
export { factsFromEnv, readFacts, pickFacts, factsCacheReset } from './facts.js'
export type { FactsRead, ControlFace } from './facts.js'
export * from './contract.js'

/** bridge 服务最小面（只需 controlExec；服务缺席时浏览器事实回落基线）。 */
interface BridgeFace extends ControlFace {}

/** 当前档位报告（工具/面板/测试共用入口）。 */
export async function browserTierReport(options: { env?: NodeJS.ProcessEnv; control?: ControlFace; cacheTtlMs?: number } = {}): Promise<BrowserTierReport & { factsSource: string; capsNote?: string }> {
  const read = await readFacts(options)
  const report = resolveBrowserTier(read.facts)
  return {
    ...report,
    factsSource: read.source,
    ...(read.capsNote === undefined ? {} : { capsNote: read.capsNote }),
  }
}

/** 面板状态载荷（**只读**；undefined 成员一律剔除——undefined 不是 lossless JSON）。 */
export function panelStatus(report: BrowserTierReport & { factsSource: string; capsNote?: string }): Record<string, unknown> {
  const { facts } = report
  return {
    ok: true,
    available: facts.browserWebViewAvailable === true,
    tier: report.tier,
    viewportRoute: report.viewportRoute,
    identityRoute: report.identityRoute,
    factsSource: report.factsSource,
    ...(report.capsNote === undefined ? {} : { capsNote: report.capsNote }),
    ...(facts.webviewMajor === undefined ? {} : { webviewMajor: facts.webviewMajor }),
    ...(facts.densityDpi === undefined ? {} : { densityDpi: facts.densityDpi }),
    uaChAvailable: facts.uaChAvailable === true,
    androidxWebkitAvailable: facts.androidxWebkitAvailable === true,
    densityOverrideSupported: facts.densityOverrideSupported === true,
    browserWebViewAvailable: facts.browserWebViewAvailable === true,
    cdpEnabled: facts.cdpEnabled === true,
    reasons: [...report.reasons],
    degradedNotes: [...report.degradedNotes],
    viewportPresets: VIEWPORT_PRESETS.map((p) => ({ id: p.id, label: p.label, width: p.width, height: p.height, mobile: p.mobile })),
    identityProfiles: IDENTITY_PROFILES.map((p) => ({ id: p.id, label: p.label, requiresConfirm: p.requiresConfirm })),
    tools: Object.values(BROWSER_TOOLS),
    ops: Object.values(BROWSER_OPS),
    route: BROWSER_ROUTES.status,
  }
}

/** 工具返回载荷（lossless JSON：无 undefined 成员）。 */
export function tierPayload(report: BrowserTierReport & { factsSource: string; capsNote?: string }): Record<string, unknown> {
  const { facts } = report
  return {
    ok: true,
    tier: report.tier,
    viewportRoute: report.viewportRoute,
    identityRoute: report.identityRoute,
    factsSource: report.factsSource,
    ...(report.capsNote === undefined ? {} : { capsNote: report.capsNote }),
    ...(facts.webviewMajor === undefined ? {} : { webviewMajor: facts.webviewMajor }),
    uaChAvailable: facts.uaChAvailable === true,
    androidxWebkitAvailable: facts.androidxWebkitAvailable === true,
    densityOverrideSupported: facts.densityOverrideSupported === true,
    browserWebViewAvailable: facts.browserWebViewAvailable === true,
    cdpEnabled: facts.cdpEnabled === true,
    reasons: [...report.reasons],
    degradedNotes: [...report.degradedNotes],
    tools: Object.values(BROWSER_TOOLS),
    ops: Object.values(BROWSER_OPS),
    routes: Object.values(BROWSER_ROUTES),
    viewportPresets: VIEWPORT_PRESETS.map((p) => p.id),
    identityProfiles: IDENTITY_PROFILES.map((p) => p.id),
  }
}

function tools(): unknown[] {
  return [defineTool({
    name: BROWSER_TOOLS.tier,
    description:
      '侧边栏 AI 浏览器的档位报告：当前可用档（L1 文本 / L2 原生 / L3 调试）、视口路线（S1/S2/S2b/S3）、'
      + '身份路线（UA-CH / 仅 UA 串）、判定理由与降级说明，以及工具名/壳桥 op 名/面板路由的契约清单。'
      + '事实优先经壳桥 browserCaps 取真实档位；op 未实现时回落 env/实测基线并在 factsSource 显式标注。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tier: { type: 'string', required: true },
          viewportRoute: { type: 'string', required: true },
          identityRoute: { type: 'string', required: true },
          factsSource: { type: 'string', required: true },
          capsNote: { type: 'string' },
          webviewMajor: { type: 'number' },
          uaChAvailable: { type: 'boolean', required: true },
          androidxWebkitAvailable: { type: 'boolean', required: true },
          densityOverrideSupported: { type: 'boolean', required: true },
          browserWebViewAvailable: { type: 'boolean', required: true },
          cdpEnabled: { type: 'boolean', required: true },
          reasons: { type: 'array', items: { type: 'string' }, required: true },
          degradedNotes: { type: 'array', items: { type: 'string' }, required: true },
          tools: { type: 'array', items: { type: 'string' }, required: true },
          ops: { type: 'array', items: { type: 'string' }, required: true },
          routes: { type: 'array', items: { type: 'string' }, required: true },
          viewportPresets: { type: 'array', items: { type: 'string' }, required: true },
          identityProfiles: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        {
          type: 'text',
          text: '浏览器档位 ' + String(v.tier) + '（视口 ' + String(v.viewportRoute) + ' / 身份 ' + String(v.identityRoute) + '）；'
            + '事实来源 ' + String(v.factsSource) + '；降级项 ' + String((v.degradedNotes as unknown[]).length) + ' 条',
        },
      ],
    },
    execute: async () => tierPayload(await browserTierReport({ control: bridgeFace() })) as never,
  })]
}

/** bridge 服务（可选面：缺席即回落基线，不 pending）。 */
function bridgeFace(): ControlFace | undefined {
  try {
    return ctxRef?.get('androidPrivilege') as BridgeFace | undefined
  } catch {
    return undefined
  }
}

let ctxRef: Context | undefined

/**
 * 装配：档位工具 + 只读面板状态路由。
 * @param ctx - 宿主上下文（tools + webServer）。
 */
export function apply(ctx: Context, _config: Record<string, unknown> = {}): void {
  ctxRef = ctx
  factsCacheReset()
  for (const t of tools()) (ctx.tools as unknown as { register(tool: unknown): void }).register(t)

  const wsvc = (ctx as unknown as { webServer?: { register(r: unknown): () => void } }).webServer
  if (wsvc === undefined) return
  const authOptions = (): AuthOptions => ({
    token: currentControlToken,
    // 与 dsh-android-file-open 同款：ctx.get（无 inject 要求），未 inject 的属性访问会被 cordis 抛错
    connection: ctx.get('connection') as ConnectionFace | undefined,
  })
  const sendRejection = (res: IncomingRes, rejection: { code: 401 | 403; body: string }): void => {
    res.writeHead(rejection.code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(rejection.body)
  }
  ctx.effect(() => wsvc.register({
    kind: 'exact',
    path: BROWSER_ROUTES.status,
    handler: async (req: {
      method?: string
      headers?: Record<string, string | string[] | undefined>
    }, res: IncomingRes) => {
      const rejection = authorizeIncomingRoute(req, authOptions())
      if (rejection) { sendRejection(res, rejection); return }
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'application/json', 'allow': 'GET' })
        res.end(JSON.stringify({ ok: false, error: 'GET only' }))
        return
      }
      try {
        const payload = panelStatus(await browserTierReport({ control: bridgeFace() }))
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(payload))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String((e as Error).message) }))
      }
    },
  }))
}
