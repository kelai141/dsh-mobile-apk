/**
 * dsh-android-file-open — 文件直达会话（PRD F5，M3.5 + 消费端补齐 2026-08-23）
 *
 * 引擎侧职责：接收壳侧拷贝完成的临时工作区路径 → 校验（必须在临时工作区内）→
 * 入队并**当场创建强制新会话**（种子消息携带 @文件路径——DSH 文件引用格式，
 * read/视觉链路按 <path> 取用；会话 cwd = 临时工作区，模型只见工作区内路径）→
 * 提供 GET 清单 + claim 端点（前端消费/删除）→ 状态工具。
 *
 * 强制新会话语义：绝不并入既有会话（PRD F5.2 硬规则）——本插件不提供任何"附加到现有会话"路径。
 *
 * 幂等：队列条目若无 sessionId（引擎曾在建会话前崩溃），apply 时的工作循环与每次 POST
 * 后都会补建——已建条目不重复创建（同一会话绝不重复开）。消费（claim）只由前端在
 * 确实把界面路由到新会话后执行。
 */
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep, basename } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// FX-205.1：三条 exact 路由与 dsh-android-bridge 控制队列共用同一枚壳侧控制令牌
// （shellControlToken = controlTokenFrom(env, 壳侧 prefs)）；鉴权实现见 route-auth.ts。
import { shellControlToken } from '@dsh-android/dsh-android-bridge'
import {
  CONTROL_TOKEN_HEADER,
  authorizeIncomingRoute,
  type AuthOptions,
  type AuthResult,
  type ConnectionFace,
  type IncomingRes,
} from './route-auth.js'

export const name = 'dsh-android-file-open'
export const inject = ['tools', 'webServer', 'sessions', 'workspaceRegistry'] as const

/** 临时工作区（与壳侧 FileIncoming.tmpWorkspace 一致；环境注入 DSH_HOME 决定配置根） */
function tmpWorkspace(): string {
  const dshHome = process.env.DSH_HOME ?? '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh'
  return join(dshHome, 'workspaces', 'incoming')
}

function queueDir(): string {
  const d = join(tmpWorkspace(), '.sessions')
  mkdirSync(d, { recursive: true })
  return d
}

/**
 * 本工具自有临时项清单（FX-205.5）：`/clean` 的**唯一删除依据**。投递被受理时逐条记账
 * （路径 = 临时工作区内的绝对落点），因此手动清理只删本工具自己拷进来的项：用户放进
 * 工作区的文件、`.sessions` 队列元数据、`.meta.ndjson`/`.pending-notify.ndjson` 都不在
 * 清单内（0.13.8 前是 readdirSync + rmSync{recursive} 全清，能删掉任意用户文件）。
 */
function ownershipFile(): string {
  return join(tmpWorkspace(), '.tool-temp.ndjson')
}

function recordOwnedTemp(path: string): void {
  try {
    appendFileSync(ownershipFile(), path + '\n')
  } catch { /* 记账失败不阻断投递：该项退化为 TTL/生命周期清理 */ }
}

function ownedTemps(): string[] {
  try {
    return readFileSync(ownershipFile(), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l !== '')
  } catch {
    return [] // 无清单 = 无可清理项（fail-safe：绝不回退成全量删除）
  }
}

/** canonical 形态（realpath 失败回落词法 resolve）。 */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/**
 * 自有临时项的归属断言（FX-205.5）：**两侧都 canonical 化**后比较。
 *
 * 设备实测（0.14.0-preview-SN-1-13）：清单里记的是 canonical 形态
 * （/data/data/...，由 enqueueSession 的 realpath 落盘），而 tmpWorkspace() 词法是
 * /data/user/0/... —— 只做词法比较会把自有临时项判为越界：/clean 恒返回 removed:0
 * 且清单被清空（所有权静默丢失）。Android 上这两个前缀指向同一目录，必须一律
 * canonical 化后再判定（同 gotcha「前缀混用」）。
 * @param owned - 清单里的路径（任一等价形态）。
 * @returns 可删除的 canonical 路径；越界/豁免/工作区根自身返回 null。
 */
function ownedInsideWorkspace(owned: string): string | null {
  const wsReal = canonicalPath(tmpWorkspace())
  const real = canonicalPath(resolve(owned))
  if (real === wsReal || !real.startsWith(wsReal + sep)) return null
  if (basename(real) === '.sessions') return null
  return real
}

/** 宿主会话服务最小面（类型局部收敛：跨包服务面走 cast，不引入 dsh-session 编译期整体）。 */
interface HostSession {
  append(type: string, payload: Record<string, unknown>, opts?: { surfaceOp: string }): void
  id: unknown
}
interface HostSessions {
  create(id?: unknown, opts?: { meta?: Record<string, unknown> }): HostSession
  get?(id: unknown): HostSession | undefined
}

/** workspaceRegistry 最小面（注册临时工作区让面板可见；R2 需要 list/delete 做 canonical 解析与自愈）。 */
interface HostWorkspace {
  id: unknown
  path: string
  title?: string
  sessionIds?: readonly unknown[]
}
interface HostWorkspaceRegistry {
  create(path: string, title?: string): Promise<unknown>
  list?(): HostWorkspace[]
  delete?(id: unknown): Promise<boolean>
}

/**
 * sessionController 最小面（R1：**会话命令面**）。
 * 上游语义（dsh/packages/api/session-controller/src/commands.ts）：
 *  - create({ workspaceId })：铸 durable session-<uuid> + 组合 Agent + attachSession（工作区归属）；
 *  - prompt(request, signal)：admit 一条 user 消息（mode 'queue' = followup 排队，真正起首轮），
 *    signal 必传（index.ts:347 第一行 signal.throwIfAborted()）。
 */
interface HostSessionController {
  create(request: { workspaceId?: string }): Promise<{ sessionId: string }>
  prompt(request: {
    requestId: string
    sessionId: string
    mode: 'queue' | 'steer'
    content: Array<{ type: 'text'; text: string }>
  }, signal: AbortSignal): Promise<{ accepted: boolean }>
}

interface IncomingItem {
  ts: string
  path: string
  context: string
  forcedNewSession: true
  sessionId?: string
  file?: string
}

function readItems(): IncomingItem[] {
  const dir = queueDir()
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as IncomingItem
      j.file = f
      return j
    } catch {
      return null
    }
  }).filter((x): x is IncomingItem => x !== null)
}

/**
 * 强制新会话请求入队（每个文件一条独立清单；会话由 ensureSessions 创建）。
 * 路径边界（H3 修复 2026-08-23）：ws+sep 边界 + realpath 规范化，拒绝跨边界 symlink。
 */
function enqueueSession(path: string): { ok: boolean; sessionFile: string; message: string } {
  const dir = queueDir()
  const ws = resolve(tmpWorkspace())
  const real = safeResolveInside(ws, path)
  if (real === null || !existsSync(real)) {
    return { ok: false, sessionFile: '', message: `路径不在临时工作区内或不存在: ${path}` }
  }
  const sessionFile = join(dir, Date.now() + '-' + Math.random().toString(16).slice(2, 8) + '.json')
  const context = `此会话处理外部文件：${real}\n\n请先阅读该文件（图片可直接用视觉工具查看），并按用户意图处理。文件已安全拷贝进临时工作区（不引用外部原始路径）；处理完成后可在设置页手动清理临时工作区。`
  writeFileSync(sessionFile, JSON.stringify({ ts: new Date().toISOString(), path: real, context, forcedNewSession: true }, null, 2))
  // FX-205.5：受理即记自有临时项（/clean 只删这些）。
  recordOwnedTemp(real)
  return { ok: true, sessionFile, message: '已生成强制新会话请求：' + real }
}

/** 持久会话 id 形态（命令面铸 session-<uuid>；计数形态 session-N 是存储层原语产物，需自愈重建）。 */
const DURABLE_SESSION_ID = /^session-[0-9a-f]{8}-/

/** 临时工作区标题（面板/工作区列表可见性契约；R2 自愈按标题 + 同目录 + sessionIds 空判定残留）。 */
const INCOMING_TITLE = '临时工作区'

/** 待建判据（R1）：无 sessionId 或**非 durable 形态**（遗留 session-1 条目自愈重建，IX-TW-02）。 */
function needsSession(item: IncomingItem): boolean {
  return item.sessionId === undefined || !DURABLE_SESSION_ID.test(item.sessionId)
}

/**
 * 服务读取统一走 ctx.get（无 inject 要求）：未声明 inject 的属性访问会被 cordis 的属性陷阱
 * 抛错（设备实测该异常被上游 webserver 兜底成 400）。返回 undefined = 该部署没有该服务面。
 */
function serviceOf<T>(name: string): T | undefined {
  try {
    return ctxRef?.get(name) as T | undefined
  } catch {
    return undefined
  }
}

function sessionControllerOf(): HostSessionController | undefined {
  return serviceOf<HostSessionController>('sessionController')
}

let workspacePromise: { key: string; value: Promise<string | undefined> } | undefined

/**
 * R2：解析「临时工作区」登记条目，返回**可 attach** 的条目 id。
 *
 * 上游 attachSession（workspace/workspace/src/entity.ts:124-143）把会话 header 的 cwd
 * 做 realpath 后与登记 path **字符串**比较；登记 path 非 canonical（设备上的
 * /data/user/0 形态）时该比较必然失败（HTTP 200 + body ok:false 的静默失败）。
 * 因此：优先复用「path 自身即 canonical」的条目；否则删除同目录 + sessionIds 为空 +
 * 标题匹配的历史残留，再以 canonical 形态重建（IX-TW-01：该标题下只剩 1 条可用条目）。
 * @returns 条目 id；注册面缺失或失败时 undefined（调用方省略 workspaceId，会话仍能建但未分组）。
 */
async function resolveIncomingWorkspace(): Promise<string | undefined> {
  const registry = serviceOf<HostWorkspaceRegistry>('workspaceRegistry')
  if (!registry?.list) return undefined
  const canonical = canonicalPath(tmpWorkspace())
  let entries: HostWorkspace[]
  try {
    entries = registry.list()
  } catch (e) {
    ctxLogger?.('dsh-android-file-open')?.warn?.('workspaceRegistry.list 失败: ' + String((e as Error).message))
    return undefined
  }
  const sameDir = entries.filter((w) => canonicalPath(w.path) === canonical)
  const usable = sameDir.find((w) => w.path === canonicalPath(w.path))
  // 自愈（IX-TW-01：该标题下必须只剩 1 条且 path == realpath(path)）：删除同目录 + 标题匹配 +
  // sessionIds 为空 + **非 canonical** 的历史残留——即使已有可用条目也要删（设备实测常驻两条）。
  for (const w of sameDir) {
    if (usable !== undefined && w.id === usable.id) continue
    if (w.title !== INCOMING_TITLE) continue
    if ((w.sessionIds?.length ?? 0) > 0) continue
    if (w.path === canonicalPath(w.path)) continue
    if (!registry.delete) {
      ctxLogger?.('dsh-android-file-open')?.warn?.('workspaceRegistry 无 delete：非 canonical 残留无法自愈')
      break
    }
    try {
      await registry.delete(w.id)
      ctxLogger?.('dsh-android-file-open')?.info?.('已自愈删除非 canonical 的临时工作区残留: ' + w.path)
    } catch (e) {
      ctxLogger?.('dsh-android-file-open')?.warn?.('临时工作区残留删除失败: ' + String((e as Error).message))
    }
  }
  if (usable !== undefined) return String(usable.id)
  try {
    const created = await registry.create(canonical, INCOMING_TITLE) as HostWorkspace | undefined
    return created?.id === undefined ? undefined : String(created.id)
  } catch (e) {
    ctxLogger?.('dsh-android-file-open')?.warn?.('临时工作区登记失败: ' + String((e as Error).message))
    return undefined
  }
}

/**
 * 解析结果的单次缓存（**按解析出的工作区路径为键**：DSH_HOME 变化/换工作区不得沿用旧条目；
 * 解析失败不缓存，允许后续重试）。
 */
function incomingWorkspaceId(): Promise<string | undefined> {
  const key = canonicalPath(tmpWorkspace())
  if (workspacePromise === undefined || workspacePromise.key !== key) {
    const value = resolveIncomingWorkspace().then((id) => {
      if (id === undefined && workspacePromise?.key === key) workspacePromise = undefined
      return id
    })
    workspacePromise = { key, value }
  }
  return workspacePromise.value
}

let ensureChain: Promise<number> = Promise.resolve(0)

/**
 * 补建会话（幂等；引擎重启后重跑安全）。IX-TW-09：启动补建与每次 POST 可能并发，
 * 全部经 ensureChain 串行化——同一队列条目绝不重复建会话。
 */
function ensureSessions(): Promise<number> {
  const run = (): Promise<number> => ensureSessionsOnce()
  const next = ensureChain.then(run, run)
  ensureChain = next.then(() => 0, () => 0)
  return next
}

/**
 * R1：走**会话命令面**建会话并起首轮。
 *  - create({ workspaceId }) → durable session-<uuid> + Agent 组合 + 工作区归属（未分组问题闭环）；
 *  - prompt(..., signal) → 排队首轮（模型未配置等失败时回落存储层 append 并记日志，不漏件也不静默）；
 *  - 命令面缺失（桌面/headless）→ 回落存储层原语并记警告（保留旧行为，绝不静默）。
 */
async function ensureSessionsOnce(): Promise<number> {
  const sessions = ctxServices.sessions
  if (!sessions) return 0
  const workspaceId = await incomingWorkspaceId()
  const controller = sessionControllerOf()
  let created = 0
  for (const item of readItems()) {
    if (!item.file || !needsSession(item)) continue
    try {
      const text = `@${item.path}\n\n${item.context}`
      let sessionId = ''
      if (controller) {
        const value = await controller.create(workspaceId === undefined ? {} : { workspaceId })
        sessionId = String(value?.sessionId ?? '')
      } else {
        const sess = sessions.create(undefined, {
          // header 的 meta 仅接受白名单键（origin 只允许 "subagent"，实测拒绝自定义值）
          meta: { cwd: tmpWorkspace() },
        })
        sessionId = String(sess.id)
        ctxLogger?.('dsh-android-file-open')?.warn?.('sessionController 缺面：回落存储层建会话（无 Agent/无工作区归属）')
      }
      if (sessionId === '') continue
      // 种子消息：@绝对路径 = DSH 文件引用约定（read/视觉工具按引用取文件）。
      // user/message 是 surface-eligible 事件：存储层回落路径必须带 surfaceOp（'append'）。
      let prompted = false
      if (controller) {
        try {
          await controller.prompt({
            requestId: `incoming-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          }, new AbortController().signal)
          prompted = true
        } catch (e) {
          ctxLogger?.('dsh-android-file-open')?.warn?.('首轮 prompt 失败，回落存储层 append: ' + String((e as Error).message))
        }
      }
      if (!prompted) {
        sessions.get?.(sessionId)?.append('user/message', createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }) as unknown as Record<string, unknown>, { surfaceOp: 'append' })
      }
      const file = join(queueDir(), item.file)
      const updated: IncomingItem = { ...item, sessionId }
      delete updated.file
      writeFileSync(file, JSON.stringify(updated, null, 2))
      created++
    } catch (e) {
      /* 单条失败不阻断其余；下次 POST/apply 再试——落错误文件供诊断 */
      try {
        writeFileSync(join(queueDir(), 'last-error.txt'), String((e as Error).stack ?? e))
      } catch { /* 诊断文件失败忽略 */ }
    }
  }
  return created
}

// 幂等补建时的日志落点（apply 时注入）
let ctxLogger: ((scope: string) => { warn?(msg: string): void; info?(msg: string): void }) | undefined
/** apply 注入的宿主面（命令面/工作区面按调用实时经 ctx.get 读取）。 */
let ctxRef: Context | undefined
let ctxServices: { sessions?: HostSessions; workspaceRegistry?: HostWorkspaceRegistry } = {}

/**
 * 解析到工作区内的规范化真实路径（H3 + 2026-08-23 前缀混用修复）：
 * - ws+sep 边界判定（同名前缀碰撞不通过；resolve 折叠 .. 后的落点为准）；
 * - **两侧都 realpath 后再比较**——Android 上 /data/user/0 可能是指向 /data/data 的
 *   软链（实测：仅 realpath 文件侧会把 rp 变成 /data/data 前缀，与未 realpath 的 ws
 *   比较必拒——正是"B7 前缀混用"的运行时表现）；ws 侧 realpath 失败按原样参与比较；
 * - 任一解析失败（不存在/越界/IO 错误）返回 null。
 */
function safeResolveInside(ws: string, path: string): string | null {
  let real: string
  let wsReal: string
  try {
    real = resolve(path)
    const inBound = real === ws || real.startsWith(ws + sep)
    if (!inBound) return null
  } catch {
    return null
  }
  try {
    wsReal = realpathSync(ws)
  } catch {
    wsReal = ws
  }
  try {
    // realpath 跟随符号链接：工作区内软链指向外部时，最终落点越界 → 拒绝
    const rp = realpathSync(real)
    if (rp === wsReal || rp.startsWith(wsReal + sep)) return rp
    // 兼容：若文件确在 ws 内但文件名含坏字符被捕获等情形，走边界回退判定
    return real.startsWith(wsReal + sep) ? real : null
  } catch {
    // 文件不存在（realpath ENOENT）：交由调用方 existsSync 判定
    return real.startsWith(wsReal + sep) ? real : null
  }
}

function tools() {
  const statusTool = defineTool({
    name: 'android_file_incoming_status',
    description: '文件直达会话队列视图：待/已消费的强制新会话清单（每项含文件路径、会话 id 与初始上下文概览）与临时工作区占用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pending: { type: 'number', required: true },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          tmpWorkspace: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: `待消费新会话请求 ${String(v.pending)} 条（工作区 ${String(v.tmpWorkspace)}）` },
      ],
    },
    execute: async () => {
      const items = readItems()
      return { pending: items.filter(needsSession).length, items, tmpWorkspace: tmpWorkspace() } as never
    },
  })
  // 注意：注入面（前端消费端）claim 后删除条目；本插件无"并入既有会话"路径（安全边界）。
  return [statusTool]
}

export function apply(ctx: Context, _config: Record<string, unknown> = {}) {
  ctxLogger = ctx.logger
  ctxRef = ctx
  const sessions = (ctx as unknown as { sessions?: HostSessions }).sessions
  const workspaceRegistry = (ctx as unknown as { workspaceRegistry?: HostWorkspaceRegistry }).workspaceRegistry
  ctxServices = { sessions, workspaceRegistry }
  for (const t of tools()) ctx.tools.register(t)
  // F5.1：引擎初始化即确保临时工作区存在（PRD：干净安装后首次启动即存在）
  try {
    mkdirSync(tmpWorkspace(), { recursive: true })
  } catch { /* 工作区由入队路径兜底创建 */ }
  // F5.1 / issue #60 + R2：登记「临时工作区」——面板可见性靠它；解析期自愈只保留一个
  // canonical（可 attach）条目，旧的非 canonical 残留按「同目录 + sessionIds 空 + 标题匹配」删除。
  void incomingWorkspaceId()
  // 启动即补建（引擎重启后可能残留无 sessionId/非 durable id 的条目——幂等、串行化）
  void ensureSessions().then((n) => {
    if (n > 0) ctx.logger?.('dsh-android-file-open')?.info?.('recovered ' + n + ' incoming session(s) after restart')
  }).catch(() => { /* 补建失败不阻断插件 */ })
  const wsvc = (ctx as unknown as { webServer?: { register(r: unknown): () => void } }).webServer
  if (wsvc) {
    // FX-205.1：鉴权依赖实时求值——令牌随壳侧 prefs 变化（重装/清数据后自愈），
    // 浏览器会话栅栏取自上游 connection 服务（桌面/无浏览器面时缺失 → 只认令牌）。
    const authOptions = (): AuthOptions => ({
      token: shellControlToken,
      // 必须走 ctx.get（无 inject 要求）：未声明 inject 时 cordis 的属性陷阱会抛
      // 「cannot get property "connection" without inject」（ReflectService.handler.get）——
      // 设备实测该异常被上游 webserver 的兜底 catch 成 **400**，三条路由因此整组 400
      // （FX-205 验收全灭）。ctx.get 缺失时返回 undefined，此处退化为「只认令牌」。
      connection: ctx.get('connection') as ConnectionFace | undefined,
    })
    const sendRejection = (res: IncomingRes, rejection: AuthResult): void => {
      res.writeHead(rejection.code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(rejection.body)
    }
    // FX-205.7：注册即 effect（register 返回 disposer）——热重载/卸载回收路由，不留重复 handler。
    ctx.effect(() => wsvc.register({
      kind: 'exact',
      path: '/api/android/file-incoming',
      handler: async (req: {
        method?: string
        headers?: Record<string, string | string[] | undefined>
        on(_e: string, cb: (b: Buffer) => void): void
        destroy(): void
      }, res: IncomingRes) => {
        // FX-205.1/.3/.4：拒绝必须发生在本 handler 任何副作用之前（GET 统计、body 读取都在其后）。
        const rejection = authorizeIncomingRoute(req, authOptions())
        if (rejection) { sendRejection(res, rejection); return }
        if (req.method === 'GET') {
          const items = readItems()
          // R16：展示临时工作区占用（设置页清理入口用；dir 遍历不含 .sessions）
          let bytes = 0
          try {
            for (const f of readdirSync(tmpWorkspace())) {
              if (f === '.sessions') continue
              const st = statSync(join(tmpWorkspace(), f))
              if (st.isFile()) bytes += st.size
            }
          } catch { /* 统计失败不阻断 */ }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, pending: items.filter(needsSession).length, items, bytes }))
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'GET/POST only' }))
          return
        }
        // body 上限 + 超时——本地 DoS 防护（无限累加耗尽内存）。
        let body = ''
        let settled = false
        const MAX_BODY = 16 * 1024
        const timeout = setTimeout(() => {
          if (settled) return
          settled = true
          try { req.destroy() } catch { /* noop */ }
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'body too large or timeout' }))
        }, 5000)
        req.on('data', (b: Buffer) => {
          if (settled) return
          body += b.toString()
          if (body.length > MAX_BODY) {
            settled = true
            try { req.destroy() } catch { /* noop */ }
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'body too large' }))
          }
        })
        req.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          try {
            const path = (JSON.parse(body) as { path?: string }).path ?? ''
            const result = enqueueSession(path)
            if (result.ok) {
              // R1：命令面建会话可能较慢——不阻塞壳侧投递的 200；失败保留条目待下次补建。
              void ensureSessions().catch(() => { /* 队列条目保留，下次补建 */ })
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(result))
          } catch (e) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: String((e as Error).message) }))
          }
        })
      },
    }))
    // 消费端点：前端已把界面路由到新会话后删除队列条目（条目名白名单校验，拒绝路径穿越）。
    ctx.effect(() => wsvc.register({
      kind: 'exact',
      path: '/api/android/file-incoming/claim',
      handler: async (req: {
        method?: string
        headers?: Record<string, string | string[] | undefined>
        on(_e: string, cb: (b: Buffer) => void): void
        destroy(): void
      }, res: IncomingRes) => {
        // FX-205.1/.3/.4：拒绝先于 method 判定与任何删除动作。
        const rejection = authorizeIncomingRoute(req, authOptions())
        if (rejection) { sendRejection(res, rejection); return }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'POST only' }))
          return
        }
        let body = ''
        let settled = false
        const timeout = setTimeout(() => {
          if (settled) return
          settled = true
          try { req.destroy() } catch { /* noop */ }
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'timeout' }))
        }, 5000)
        req.on('data', (b: Buffer) => {
          if (settled) return
          body += b.toString()
          if (body.length > 4096) {
            settled = true
            try { req.destroy() } catch { /* noop */ }
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'body too large' }))
          }
        })
        req.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          try {
            const file = (JSON.parse(body) as { file?: string }).file ?? ''
            const name = basename(file)
            // 白名单：仅允许删除队列目录内的 .json 条目（basename 化后拒绝穿越）
            if (name !== file || !name.endsWith('.json')) {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'invalid entry name' }))
              return
            }
            const target = join(queueDir(), name)
            if (target !== join(resolve(queueDir()), name)) {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'invalid entry path' }))
              return
            }
            if (existsSync(target)) rmSync(target)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true }))
          } catch (e) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: String((e as Error).message) }))
          }
        })
      },
    }))
    // F5.1/D15 手动清理（FX-205.2 POST-only + FX-205.5 删除范围收敛为自有临时项；
    // 保留 .sessions 队列元数据，会话关联提示由设置页文案承担）。
    ctx.effect(() => wsvc.register({
      kind: 'exact',
      path: '/api/android/file-incoming/clean',
      handler: async (req: {
        method?: string
        headers?: Record<string, string | string[] | undefined>
        on(_e: string, cb: (b: Buffer) => void): void
        destroy(): void
      }, res: IncomingRes) => {
        // FX-205.1/.3/.4：拒绝先于 method 判定与任何删除动作（Host 伪造时工作区零变化）。
        const rejection = authorizeIncomingRoute(req, authOptions())
        if (rejection) { sendRejection(res, rejection); return }
        // FX-205.2：上游 match() 无 method 维度，GET 曾可触发递归删除 → POST-only。
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json', 'allow': 'POST' })
          res.end(JSON.stringify({ ok: false, error: 'POST only' }))
          return
        }
        // FX-205.5：只删本工具受理时记账的自有临时项；清单外（用户文件、.sessions、
        // .meta.ndjson、.pending-notify.ndjson）一律保留。归属判定两侧 canonical 化。
        let removed = 0
        const kept: string[] = []
        try {
          for (const owned of ownedTemps()) {
            const target = ownedInsideWorkspace(owned)
            if (target === null) {
              kept.push(owned) // 越界/豁免：不属本工具可删面，记录保留
              continue
            }
            try {
              rmSync(target, { recursive: true, force: true })
              removed++
            } catch {
              kept.push(owned) // 删除失败：保留记录可重试（不得静默丢所有权）
            }
          }
          // 清单与现场对齐：只保留未删除项；全删空才移除清单文件。
          if (kept.length === 0) rmSync(ownershipFile(), { force: true })
          else writeFileSync(ownershipFile(), kept.join('\n') + '\n')
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, removed }))
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String((e as Error).message) }))
        }
      },
    }))
  }
}
