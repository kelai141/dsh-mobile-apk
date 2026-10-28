/**
 * dsh-android-file-open — 文件直达会话（PRD F5，M3.5 + 消费端补齐 2026-08-23）
 *
 * 引擎侧职责：接收壳侧拷贝完成的临时工作区路径 → 校验（必须在临时工作区内）→
 * 入队并创建一个强制新会话，但**不发送**任何种子消息。前端仅在成功导航到该会话后，
 * 以短时 ticket 读取源字节并复用上游 composer 的 file-upload 流程，形成一个未发送的
 * `file attachment` 草稿。绝不把 `@路径` 写成 user message。
 *
 * 强制新会话语义：绝不并入既有会话（PRD F5.2 硬规则）——本插件不提供任何"附加到现有会话"路径。
 *
 * 幂等：队列条目若无 sessionId（引擎曾在建会话前崩溃），apply 时的工作循环与每次 POST
 * 后都会补建——已建条目不重复创建（同一会话绝不重复开）。消费（claim）只由前端在
 * 确实把界面路由到新会话后执行。
 */
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync, statSync, createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import { join, resolve, sep, basename } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// FX-205.1：三条 exact 路由与 dsh-android-bridge 控制队列共用同一枚壳侧控制令牌
// （shellControlToken = controlTokenFrom(env, 壳侧 prefs)）；鉴权实现见 route-auth.ts。
import { shellControlToken } from '@dsh-android/dsh-android-bridge'
import {
  authorizeIncomingRoute,
  sendIncomingRouteRejection,
  type AuthOptions,
  type AuthResult,
  type ConnectionFace,
  type IncomingRes,
} from './route-auth.js'

export const name = 'dsh-android-file-open'
export const inject = ['tools', 'webServer', 'sessions', 'workspaceRegistry'] as const

/**
 * 一次外发附件流的上限（issue #687）。
 *
 * 为什么要上限：这条 GET 直接把 `files/` 里的原文件灌给浏览器，没有上限时一个被拖错的
 * 超大文件会占满 WebView 的下载通道与内存。256 MiB 之上直接 413，不进入流式阶段。
 */
const MAX_CONTENT_BYTES = 256 * 1024 * 1024

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
  // 豁免必须按**路径前缀**判，不能只看 basename：清单里出现 `.sessions/<record>.json` 时
  // basename 是 record 名而不是 `.sessions`，旧判据放行 ⇒ 宿主的会话记录被当"自有临时项"删掉
  // （`/clean` 还是递归删，目录一并带走）。同 gotcha「前缀混用」的教训。
  const sessionsDir = join(wsReal, '.sessions')
  if (real === sessionsDir || real.startsWith(sessionsDir + sep)) return null
  return real
}

/** Host session service minimum: a blank session is created without calling prompt or append. */
interface HostSession {
  id: unknown
}
interface HostSessions {
  create(id?: unknown, opts?: { meta?: Record<string, unknown> }): HostSession
}

/** workspaceRegistry minimum face (registers the temporary workspace for navigation). */
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

/** Session-command face used to mint a durable, empty session in its workspace. */
interface HostSessionController {
  create(request: { workspaceId?: string }): Promise<{ sessionId: string }>
}

type IncomingState = 'received' | 'session-created'

/** Persistent shell-to-engine queue record. `path` remains host-only and never reaches the Web UI. */
interface IncomingItem {
  id: string
  ts: string
  path: string
  forcedNewSession: true
  state: IncomingState
  name: string
  bytes: number
  sessionId?: string
  file?: string
}

/** Browser-safe metadata for the queue status endpoint and model-visible status tool. */
interface PublicIncomingItem {
  entryId: string
  sessionId?: string
  state: IncomingState
  name: string
  bytes: number
}

/** One short-lived, process-local stream ticket after the UI has navigated to its blank session. */
interface DraftLease {
  entryId: string
  sessionId: string
  path: string
  name: string
  bytes: number
  expiresAt: number
}

const DRAFT_LEASE_MS = 5 * 60_000

/** 本进程启动时刻（模块装配时刻）：更早的未认领记录 = 上个进程残骸（review C10）。 */
const PROCESS_START_MS = Date.now()
/** 未认领来件在**本进程内**的寿命：超时未认领即墓碑化（review C10 的 TTL 半边）。 */
const UNCLAIMED_TTL_MS = 10 * 60_000

function publicItem(item: IncomingItem): PublicIncomingItem {
  return {
    entryId: item.id,
    ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
    state: item.state,
    name: item.name,
    bytes: item.bytes,
  }
}

function readItems(): IncomingItem[] {
  const dir = queueDir()
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map<IncomingItem | null>((f) => {
    try {
      const value = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Partial<IncomingItem>
      if (typeof value.path !== 'string' || value.path === '') return null
      const bytes = typeof value.bytes === 'number' && Number.isFinite(value.bytes) && value.bytes >= 0
        ? value.bytes
        : (() => { try { return statSync(value.path).size } catch { return 0 } })()
      const sessionId = typeof value.sessionId === 'string' && value.sessionId !== '' ? value.sessionId : undefined
      return {
        id: typeof value.id === 'string' && value.id !== '' ? value.id : f,
        ts: typeof value.ts === 'string' ? value.ts : '',
        path: value.path,
        forcedNewSession: true,
        state: value.state === 'session-created' || sessionId !== undefined ? 'session-created' : 'received',
        name: typeof value.name === 'string' && value.name !== '' ? value.name : basename(value.path),
        bytes,
        ...(sessionId === undefined ? {} : { sessionId }),
        file: f,
      } satisfies IncomingItem
    } catch {
      return null
    }
  }).filter((x): x is IncomingItem => x !== null)
}

/**
 * review C10：未认领草稿的生命周期收口（PLAN 约束：草稿只在当前进程有效，进程重启后不恢复
 * 草稿；原临时源按 TTL 清理）。
 *
 * 现场缺陷：队列记录跨进程复活——用户在草稿落盘前杀掉应用/引擎，下次启动浏览器轮询到
 * state='received' 的旧记录，会为其**重复新建**临时会话（还可能叠加 createSession 失败重试）。
 *
 *  ① mode='boot'：state==='received'（无 durable sessionId）且时间戳早于本进程启动 = 上个进程
 *     残骸 → 删除队列记录（浏览器之后轮询不到，自然不再补建）。
 *  ② mode='ttl'：本进程内超过 UNCLAIMED_TTL_MS 仍无人认领 → 同样清理（长驻引擎不无限积压）。
 * 已认领（session-created + durable id）记录不动：那是真实会话的待附附件，不属草稿面。
 * 时间戳不可读时保守不动（宁留不误删）。
 */
function purgeStaleUnclaimed(mode: 'boot' | 'ttl'): number {
  const now = Date.now()
  let purged = 0
  for (const item of readItems()) {
    if (!needsSession(item) || item.file === undefined) continue
    const ts = Date.parse(item.ts)
    if (Number.isNaN(ts)) continue
    const stale = mode === 'boot' ? ts < PROCESS_START_MS : ts < now - UNCLAIMED_TTL_MS
    if (!stale) continue
    try {
      rmSync(join(queueDir(), item.file), { force: true })
      purged += 1
      ctxLogger?.('dsh-android-file-open')?.info?.('未认领来件过期清理(' + mode + ')：' + item.name + '（草稿仅在当前进程有效）')
    } catch { /* 删除失败留待下次启动再清 */ }
  }
  return purged
}

/**
 * 强制新会话请求入队（每个文件一条独立清单；会话由 ensureSessions 创建）。
 * 路径边界（H3 修复 2026-08-23）：ws+sep 边界 + realpath 规范化，拒绝跨边界 symlink。
 */
function enqueueSession(path: string): { ok: boolean; entryId?: string; message: string } {
  const dir = queueDir()
  const ws = resolve(tmpWorkspace())
  const real = safeResolveInside(ws, path)
  if (real === null || !existsSync(real)) {
    return { ok: false, message: '路径不在临时工作区内或不存在' }
  }
  const entryId = randomBytes(18).toString('base64url')
  const sessionFile = join(dir, entryId + '.json')
  const bytes = statSync(real).size
  const item: IncomingItem = {
    id: entryId,
    ts: new Date().toISOString(),
    path: real,
    forcedNewSession: true,
    state: 'received',
    name: basename(real),
    bytes,
  }
  writeFileSync(sessionFile, JSON.stringify(item, null, 2))
  // 受理即记自有临时项（/clean 只删这些）。
  recordOwnedTemp(real)
  return { ok: true, entryId, message: '已创建空白临时会话请求' }
}

/** 持久会话 id 形态（命令面铸 session-<uuid>；计数形态 session-N 是存储层原语产物，需自愈重建）。 */
const DURABLE_SESSION_ID = /^session-[0-9a-f]{8}-/

/** 临时工作区标题（面板/工作区列表可见性契约；R2 自愈按标题 + 同目录 + sessionIds 空判定残留）。 */
const INCOMING_TITLE = '临时工作区'

/** 待建判据（R1）：无 sessionId 或**非 durable 形态**（遗留 session-1 条目自愈重建，IX-TW-02）。 */
function needsSession(item: IncomingItem): boolean {
  return item.state !== 'session-created' || item.sessionId === undefined || !DURABLE_SESSION_ID.test(item.sessionId)
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
 * Build one durable blank session per incoming record. This function deliberately never submits a
 * prompt and never appends a user/message event: the browser hydrates the ordinary composer draft
 * only after it has navigated to the returned session.
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
      let sessionId = ''
      if (controller) {
        const value = await controller.create(workspaceId === undefined ? {} : { workspaceId })
        sessionId = String(value?.sessionId ?? '')
      } else {
        const sess = sessions.create(undefined, {
          // Header meta is intentionally limited to the workspace; no source path becomes message text.
          meta: { cwd: tmpWorkspace() },
        })
        sessionId = String(sess.id)
        ctxLogger?.('dsh-android-file-open')?.warn?.('sessionController 缺面：无法验证空白会话的 durable id')
      }
      if (!DURABLE_SESSION_ID.test(sessionId)) {
        ctxLogger?.('dsh-android-file-open')?.warn?.('空白来件会话未得到 durable id，条目保留待重试')
        continue
      }
      const file = join(queueDir(), item.file)
      const updated: IncomingItem = { ...item, sessionId, state: 'session-created' }
      delete updated.file
      writeFileSync(file, JSON.stringify(updated, null, 2))
      created++
    } catch (e) {
      // One record cannot block the rest; leave it received for the next normal engine boot retry.
      try {
        writeFileSync(join(queueDir(), 'last-error.txt'), String((e as Error).stack ?? e))
      } catch { /* diagnostic write has no safe recovery path */ }
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
  const wsLex = resolve(ws)
  const pathLex = resolve(path)
  let wsReal: string
  try {
    wsReal = realpathSync(wsLex)
  } catch {
    // Workspace creation is mandatory before queue consumption; if its canonical form cannot be
    // resolved, preserve the lexical form and fail closed for any alias mismatch.
    wsReal = wsLex
  }
  let pathReal: string
  try {
    // Follow symlinks before the containment check so a workspace link cannot escape it.
    pathReal = realpathSync(pathLex)
  } catch {
    // The caller supplies the final existsSync policy. Retain the resolved record path here so
    // an absent source can be reported as 410 without accepting a foreign lexical prefix.
    pathReal = pathLex
  }
  return pathReal === wsReal || pathReal.startsWith(wsReal + sep) ? pathReal : null
}

function tools() {
  const statusTool = defineTool({
    name: 'android_file_incoming_status',
    description: '外部文件草稿队列的只读元数据：空白新会话是否已创建、文件名与字节数。不会公开临时文件的绝对路径，也不会发送消息。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          // ok/error 是本工具的**错误出口**：队列目录不可读/不可建时（EACCES 等）必须返回
          // 错误对象，不能抛异常——抛异常会冒到模型侧调用栈（门禁实测：CI 上
          // `mkdir .../incoming/.sessions` 抛 EACCES，工具被判定为「必须返回错误对象而非抛异常」）。
          ok: { type: 'boolean' },
          pending: { type: 'number', required: true },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        v.ok === false
          ? { type: 'text', text: `待处理外部附件草稿读取失败：${String(v.error ?? '未知原因')}` }
          : { type: 'text', text: `待处理外部附件草稿 ${String(v.pending)} 条` },
      ],
    },
    execute: async () => {
      try {
        const items = readItems()
        return { ok: true, pending: items.filter(needsSession).length, items: items.map(publicItem) } as never
      } catch (e) {
        return {
          ok: false,
          pending: 0,
          items: [],
          error: String((e as Error)?.message ?? e),
        } as never
      }
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
  // review C10：装配即清理上个进程的未认领残骸（否则浏览器下次轮询会重复补建临时会话）。
  try { purgeStaleUnclaimed('boot') } catch { /* 清理失败不阻断装配 */ }
  // Claim tickets are intentionally process-local. A browser/app restart drops them, which prevents
  // a previously unsent composer attachment from being reconstructed after restart.
  const draftLeases = new Map<string, DraftLease>()
  const leaseFor = (ticket: string): DraftLease | undefined => {
    const lease = draftLeases.get(ticket)
    if (lease !== undefined && lease.expiresAt <= Date.now()) {
      draftLeases.delete(ticket)
      return undefined
    }
    return lease
  }
  ctx.effect(() => () => { draftLeases.clear() }, 'dsh-android-file-open: draft stream leases')
  for (const t of tools()) ctx.tools.register(t)
  // F5.1：引擎初始化即确保临时工作区存在（PRD：干净安装后首次启动即存在）
  try {
    mkdirSync(tmpWorkspace(), { recursive: true })
  } catch { /* 工作区由入队路径兜底创建 */ }
  // Register the temporary workspace before a browser creates its blank Session. The browser-side
  // Session controller is the only creator because its create() result is locally addressable.
  void incomingWorkspaceId().catch(() => { /* a later GET retries workspace registration */ })
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
      sendIncomingRouteRejection(res, rejection)
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
          // review C10：长驻进程内的 TTL 复核（未认领超时即墓碑化，避免无限积压与补建）。
          try { purgeStaleUnclaimed('ttl') } catch { /* 清理失败不阻断统计 */ }
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
          res.end(JSON.stringify({
            ok: true,
            pending: items.filter(needsSession).length,
            items: items.map(publicItem),
            bytes,
          }))
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
          // 先答复、再丢请求体：`req.destroy()` 会立刻拆掉底层 socket，之后的 writeHead 写不出去，
          // 客户端只能看到 ECONNRESET 而不是 413（契约上等于不可达）。`resume()` 只丢弃剩余请求体、
          // 不拆连接，413 才能真正送达。
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'body too large or timeout' }))
          try { (req as unknown as { resume?: () => void }).resume?.() } catch { /* already ended */ }
        }, 5000)
        req.on('data', (b: Buffer) => {
          if (settled) return
          body += b.toString()
          if (body.length > MAX_BODY) {
            settled = true
            // 先答复、再丢请求体：`req.destroy()` 会立刻拆掉底层 socket，之后的 writeHead 写不出去，
            // 客户端只能看到 ECONNRESET 而不是 413（契约上等于不可达）。`resume()` 只丢弃剩余请求体、
            // 不拆连接，413 才能真正送达。
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'body too large' }))
            try { (req as unknown as { resume?: () => void }).resume?.() } catch { /* already ended */ }
          }
        })
        req.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          try {
            const path = (JSON.parse(body) as { path?: string }).path ?? ''
            const result = enqueueSession(path)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(result))
          } catch (e) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: String((e as Error).message) }))
          }
        })
      },
    }))
    // A successful navigation claims one opaque queue entry, deletes its persistent record, and
    // returns a short-lived process-local ticket. The source path never enters the browser response.
    ctx.effect(() => wsvc.register({
      kind: 'exact',
      path: '/api/android/file-incoming/claim',
      handler: async (req: {
        method?: string
        headers?: Record<string, string | string[] | undefined>
        on(_e: string, cb: (b: Buffer) => void): void
        destroy(): void
      }, res: IncomingRes) => {
        const rejection = authorizeIncomingRoute(req, authOptions())
        if (rejection) { sendRejection(res, rejection); return }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json', 'allow': 'POST' })
          res.end(JSON.stringify({ ok: false, error: 'POST only' }))
          return
        }
        let body = ''
        let settled = false
        const timeout = setTimeout(() => {
          if (settled) return
          settled = true
          // 先答复、再丢请求体：`req.destroy()` 会立刻拆掉底层 socket，之后的 writeHead 写不出去，
          // 客户端只能看到 ECONNRESET 而不是 413（契约上等于不可达）。`resume()` 只丢弃剩余请求体、
          // 不拆连接，413 才能真正送达。
          res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: 'claim timeout' }))
          try { (req as unknown as { resume?: () => void }).resume?.() } catch { /* already ended */ }
        }, 5000)
        req.on('data', (chunk: Buffer) => {
          if (settled) return
          body += chunk.toString()
          if (body.length > 4096) {
            settled = true
            // 先答复、再丢请求体：`req.destroy()` 会立刻拆掉底层 socket，之后的 writeHead 写不出去，
            // 客户端只能看到 ECONNRESET 而不是 413（契约上等于不可达）。`resume()` 只丢弃剩余请求体、
            // 不拆连接，413 才能真正送达。
            res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: false, error: 'claim body too large' }))
            try { (req as unknown as { resume?: () => void }).resume?.() } catch { /* already ended */ }
          }
        })
        req.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          try {
            const payload = JSON.parse(body) as { entryId?: string; sessionId?: string }
            const entryId = typeof payload.entryId === 'string' ? payload.entryId : ''
            const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
            const item = readItems().find(candidate => candidate.id === entryId)
            if (item === undefined || item.file === undefined) {
              res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ ok: false, error: 'incoming entry not found' }))
              return
            }
            // The browser's official sessions.create() returns a locally-addressable durable id.
            // Legacy host-created records may carry another id after an app restart; accepting the
            // browser-selected replacement avoids resurrecting an unsent old draft.
            if (!DURABLE_SESSION_ID.test(sessionId)) {
              res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ ok: false, error: 'incoming session is not ready' }))
              return
            }
            const path = safeResolveInside(resolve(tmpWorkspace()), item.path)
            // 源已经不在（被清理、被搬走、被换成目录）时，**记录必须跟着清掉**：否则这条队列项
            // 永远留着，每次 claim 都 410，而浏览器侧对 claim 的失败是静默 return —— 每轮重载都会
            // 先建一张空会话再死在这条 410 上（review C10 同族：僵尸草稿 + 空会话堆积）。
            // 记录的语义是「还有可交付的字节」，字节没了记录就没有意义（与 content 的 410 立刻杀
            // lease 是同一口径，三处处置必须一致）。
            if (path === null || !existsSync(path)) {
              rmSync(join(queueDir(), item.file), { force: true })
              res.writeHead(410, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ ok: false, error: 'incoming source expired' }))
              return
            }
            const current = statSync(path)
            if (!current.isFile()) {
              rmSync(join(queueDir(), item.file), { force: true })
              res.writeHead(410, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ ok: false, error: 'incoming source is not a file' }))
              return
            }
            // Claim happens only after the browser successfully opened the target session. Deleting
            // the record before bytes are fetched intentionally prevents restart-time draft recovery.
            rmSync(join(queueDir(), item.file))
            const ticket = randomBytes(24).toString('base64url')
            draftLeases.set(ticket, {
              entryId: item.id,
              sessionId,
              path,
              name: item.name,
              bytes: current.size,
              expiresAt: Date.now() + DRAFT_LEASE_MS,
            })
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, entryId: item.id, ticket, name: item.name, bytes: current.size, state: 'draft-hydrating' }))
          } catch (e) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: false, error: String((e as Error).message) }))
          }
        })
      },
    }))
    // Browser-only stream route. It is authenticated before ticket lookup and keeps the path in the
    // plugin process; the UI receives raw bytes, then reuses the ordinary file-upload admission path.
    ctx.effect(() => wsvc.register({
      kind: 'exact',
      path: '/api/android/file-incoming/content',
      handler: async (req: {
        method?: string
        url?: string
        headers?: Record<string, string | string[] | undefined>
      }, res: IncomingRes & { write(chunk: Buffer): boolean }) => {
        const rejection = authorizeIncomingRoute(req, authOptions())
        if (rejection) { sendRejection(res, rejection); return }
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json', 'allow': 'GET', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: 'GET only' }))
          return
        }
        const ticket = new URL(req.url ?? '', 'http://localhost').searchParams.get('ticket') ?? ''
        const lease = leaseFor(ticket)
        if (lease === undefined) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: 'draft ticket expired' }))
          return
        }
        const path = safeResolveInside(resolve(tmpWorkspace()), lease.path)
        if (path === null || !existsSync(path)) {
          draftLeases.delete(ticket)
          res.writeHead(410, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: 'incoming source expired' }))
          return
        }
        let bytes = 0
        try {
          const stat = statSync(path)
          if (!stat.isFile()) throw new Error('incoming source is not a file')
          bytes = stat.size
        } catch (e) {
          draftLeases.delete(ticket)
          res.writeHead(410, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: String((e as Error).message) }))
          return
        }
        // 超限必须在写状态行之前拒绝：先 200 再断流，浏览器侧只会看到截断的附件。
        if (bytes > MAX_CONTENT_BYTES) {
          draftLeases.delete(ticket)
          res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: 'incoming source too large', bytes, limit: MAX_CONTENT_BYTES }))
          return
        }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes),
          'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(lease.name),
          'cache-control': 'no-store',
        })
        // pipeline 自带背压与错误传播：客户端中途断开时立即销毁源流。
        // 旧写法手写 data 事件并丢弃 res.write() 的返回值 —— 整个文件会被读进 socket 缓冲，
        // 断开后仍读到 EOF，fd 与 buffer 一起泄漏（issue #687）。
        try {
          await pipeline(createReadStream(path), res as unknown as NodeJS.WritableStream)
        } catch {
          // 断开/传输失败：pipeline 已销毁两端与源流句柄，这里不再追加任何正文。
        }
      },
    }))
    // Finalize the process-local lease only after the browser has placed the File into the composer.
    ctx.effect(() => wsvc.register({
      kind: 'exact',
      path: '/api/android/file-incoming/complete',
      handler: async (req: {
        method?: string
        headers?: Record<string, string | string[] | undefined>
        on(_e: string, cb: (b: Buffer) => void): void
        destroy(): void
      }, res: IncomingRes) => {
        const rejection = authorizeIncomingRoute(req, authOptions())
        if (rejection) { sendRejection(res, rejection); return }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json', 'allow': 'POST', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: 'POST only' }))
          return
        }
        let body = ''
        let settled = false
        const timeout = setTimeout(() => {
          if (settled) return
          settled = true
          // 先答复、再丢请求体：`req.destroy()` 会立刻拆掉底层 socket，之后的 writeHead 写不出去，
          // 客户端只能看到 ECONNRESET 而不是 413（契约上等于不可达）。`resume()` 只丢弃剩余请求体、
          // 不拆连接，413 才能真正送达。
          res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: 'completion timeout' }))
          try { (req as unknown as { resume?: () => void }).resume?.() } catch { /* already ended */ }
        }, 5000)
        req.on('data', (chunk: Buffer) => {
          if (settled) return
          body += chunk.toString()
          if (body.length > 2048) {
            settled = true
            // 先答复、再丢请求体：`req.destroy()` 会立刻拆掉底层 socket，之后的 writeHead 写不出去，
            // 客户端只能看到 ECONNRESET 而不是 413（契约上等于不可达）。`resume()` 只丢弃剩余请求体、
            // 不拆连接，413 才能真正送达。
            res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: false, error: 'completion body too large' }))
            try { (req as unknown as { resume?: () => void }).resume?.() } catch { /* already ended */ }
          }
        })
        req.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          try {
            const payload = JSON.parse(body) as { ticket?: string; outcome?: string }
            const ticket = typeof payload.ticket === 'string' ? payload.ticket : ''
            const lease = leaseFor(ticket)
            if (lease === undefined) {
              res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ ok: false, error: 'draft ticket expired' }))
              return
            }
            const state = payload.outcome === 'draft-ready' ? 'draft-ready' : 'removed'
            draftLeases.delete(ticket)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, entryId: lease.entryId, state }))
          } catch (e) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
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
