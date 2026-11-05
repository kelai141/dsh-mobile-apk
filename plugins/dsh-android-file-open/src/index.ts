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

/**
 * 队列目录的**条目名指纹**（审计 §7.7：空队列的轻量判据）。
 *
 * 缺陷形态：客户端每 4 秒 GET 一次清单，而 GET 每次都做 TTL 清理 + `readItems()`
 * （逐文件 readFileSync + JSON.parse）+ 临时目录 stat 遍历 + 每次读 dsh-adb.xml 鉴权。
 * 队列常态是空的，但空队列也要走完整条读链——纯白烧 I/O。
 *
 * 为什么指纹只用目录项名字：条目落盘是**整文件 writeFileSync**（新条目 = 新文件名，
 * 认领/更新 = 同名重写或删除）。因此「名字集合变了」是「可能有新条目或条目被消费」的充分信号；
 * 名字集合没变时仍必须核对 mtime —— 同名重写（补建会话那一步）不改名字，但改了内容。
 * 反过来，**只看名字不读内容**就能确认「队列还是那几条」，从而省掉整条逐文件读链。
 *
 * 安全边界（必须守住）：指纹只用于「要不要读」，**不得**用于跳过鉴权——鉴权永远在路由入口
 * 第一行执行（见 authorizeIncomingRoute 调用点），与队列是否为空无关。
 * @returns 指纹串；目录不可读时返回 null（调用方退回完整读链，不得当成「空」）。
 */
function queueFingerprint(): string | null {
  try {
    const dir = queueDir()
    const names: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      // mtime 取整到毫秒：同名重写（补建会话写回）必须被识别成「变了」。
      const st = statSync(join(dir, entry.name))
      names.push(entry.name + ':' + String(st.mtimeMs | 0) + ':' + String(st.size))
    }
    names.sort()
    return names.join('|')
  } catch {
    return null
  }
}

/** 清单 GET 的响应体（浏览器与设置页共用）。 */
interface QueueListBody {
  ok: true
  pending: number
  items: PublicIncomingItem[]
  bytes: number
}

/**
 * 清单 GET 的读链状态（审计 §7.7）。
 *
 * 语义：**缓存只在本进程内，且必须能被指纹证伪**。命中轻量返回的前提是「目录项指纹与上次完整读
 * 一模一样」——新文件入队会改指纹（新名字），补建会话写回会改 mtime/size，认领会删名字，
 * 三条都会立刻穿透。也就是说：命中的含义是「队列内容与上次完整读时逐项一致」，
 * 此时回上次的公开视图与重新读一遍**结果等价**。
 */
interface ListState {
  /** 上一次完整读的指纹（null = 还没读过）。 */
  fingerprint: string | null
  /** 上一次完整读的响应体（轻量返回时原样回放）。 */
  body: QueueListBody | null
  /** 上一次完整读时是否空队列（空队列才进入退避）。 */
  empty: boolean
  /** 连续空读的退避状态。 */
  backoff: IdleBackoff
  /** 上一次 GET 的时刻（epoch ms；null = 还没有过请求，回前台判据用）。 */
  lastListAt: number | null
}


/**
 * 「连续空读」退避控制器（审计 §7.7 的第二半）：空队列连续命中时把完整读链的间隔指数拉长到 30 秒上限。
 *
 * 为什么服务端也要退避：客户端是固定 4 秒一拍（客户端侧不动），服务端若每拍都做完整读链，
 * 空队列期间的 I/O 与解析就是纯成本。退避只影响「多快能发现新入队」，而新入队会改目录指纹
 * （新文件名），**指纹判定本身很便宜**（一次 readdir），所以新文件不会因为退避而看不见——
 * 退避省掉的是后面的逐文件读 + 临时目录遍历。
 *
 * 关键不变量（用例锁定）：任何**新条目**都必须立刻越过退避（指纹变了 → 立刻完整读）。
 */
interface IdleBackoff {
  /** 下一次允许做完整读链的时刻（epoch ms）。 */
  nextFullReadAt: number
  /** 当前退避档（1 = 无退避）。 */
  level: number
  /** 上一次观察到的指纹（null = 还没观察过）。 */
  lastFingerprint: string | null
}

/** 退避档上限：1s -> 2s -> 4s -> 8s -> 16s -> 30s（封顶，不再增长）。 */
const IDLE_BACKOFF_MAX_MS = 30_000
/**
 * 「回前台」判据（审计 §7.7 的第三条要求：回前台立即读一次）。
 *
 * 判据只能是**请求间隔**：服务端看不见页面可见性，但看得见「多久没人来问」。
 * 页面进入后台时客户端定时器仍在（它自带 visible 门，实际不发请求），所以一个远超退避上限的
 * 空档必然对应「页面不在前台/引擎刚被唤醒」——此时第一拍必须做完整读，不能拿退避当理由回旧视图。
 * 取 2 倍退避上限（60 秒）：比任何一个前台轮询间隔都大，不会在正常前台节奏下误判。
 */
const RESUME_GAP_MS = 2 * IDLE_BACKOFF_MAX_MS
/** 退避起步档（毫秒）：比客户端 4 秒一拍短，保证「第一个空拍」之后仍能及时看到新条目。 */
const IDLE_BACKOFF_BASE_MS = 1_000

/** 退避档上限（档位单位 = IDLE_BACKOFF_BASE_MS 的倍数）。 */
const IDLE_BACKOFF_MAX_LEVEL = Math.ceil(IDLE_BACKOFF_MAX_MS / IDLE_BACKOFF_BASE_MS)

/**
 * 按「刚做完一次完整读」的结果推进退避（纯函数，便于单测锁定三条语义）。
 *
 * 三条语义（各对着一个真实要求）：
 *   1. **队列不空 ⇒ 不退避**：有条目在等浏览器认领，每拍完整读是必要的（它们要立刻被看见）；
 *   2. **指纹变了 ⇒ 从第一档重来**：刚发生真实变化（新入队/被消费/同名重写），下一拍仍要快；
 *   3. **指纹没变且空 ⇒ 指数加档，30 秒封顶**：这才是「空队列常态」该付的成本。
 *
 * @param state - 当前退避状态。
 * @param observation - 本轮观察：指纹与「是否空队列」。
 * @param now - 当前时刻（epoch ms）。
 * @returns 下一轮状态。
 */
function advanceIdleBackoff(
  state: IdleBackoff,
  observation: { fingerprint: string | null; empty: boolean },
  now: number,
): IdleBackoff {
  // 队列不空：不退避（下一次 GET 立刻做完整读）。
  if (!observation.empty) {
    return { nextFullReadAt: 0, level: 1, lastFingerprint: observation.fingerprint }
  }
  const changed = observation.fingerprint !== state.lastFingerprint
  // 指纹变了（含首次观察）：真实变化刚被这次完整读吸收，退避从第一档重新开始。
  const level = changed ? 1 : Math.min(state.level * 2, IDLE_BACKOFF_MAX_LEVEL)
  const delay = Math.min(IDLE_BACKOFF_BASE_MS * level, IDLE_BACKOFF_MAX_MS)
  return { nextFullReadAt: now + delay, level, lastFingerprint: observation.fingerprint }
}
/** 初始读链状态（第一次 GET 必做完整读）。 */
export function initialListState(): ListState {
  return {
    fingerprint: null,
    body: null,
    empty: false,
    backoff: { nextFullReadAt: 0, level: 1, lastFingerprint: null },
    lastListAt: null,
  }
}

/** 读链的外部依赖（注入以便单测：真实实现读盘，用例给替身并计数）。 */
export interface ListReadDeps {
  /** 目录项指纹（一次 readdir + 每条 stat；不读文件内容）。 */
  fingerprint(): string | null
  /** TTL 复核（空队列轻量返回时**不执行**——它本身就要读一遍队列）。 */
  purgeTtl(): void
  /** 完整读链：逐条读队列记录（含读文件与解析）。 */
  items(): IncomingItem[]
  /** 临时工作区占用统计（空队列且上次已统计过时跳过，沿用旧值）。 */
  workspaceBytes(): number
  /** 现在（epoch ms）。 */
  now(): number
}

/**
 * 一次 GET 的读链决策（审计 §7.7 的核心：空队列走轻量返回，但**鉴权永远在调用点之前**）。
 *
 * 三条决策，按优先级：
 *   1. **回前台立即读**：距上一次 GET 超过 RESUME_GAP_MS ⇒ 强制完整读（退避与缓存都不作数）。
 *   2. **空队列轻量返回**：目录指纹与上次完整读一致，且还没到退避的下一拍 ⇒ 直接回上次的响应体，
 *      不读一个文件、不做 TTL 清理、不遍历临时目录。
 *   3. 其余 ⇒ 完整读链（TTL 清理 + readItems + 占用统计），随后按「是否空队列」推进退避。
 *
 * 为什么新条目不会因为退避而看不见：指纹每次 GET 都重新算（一次 readdir），新条目 = 新文件名 =
 * 指纹变化 ⇒ 第 2 条不成立 ⇒ 立刻走完整读。退避只推迟「指纹没变时的重复完整读」。
 *
 * @param state - 上一次的读链状态。
 * @param deps - 注入的真实读面。
 * @returns 响应体与下一状态（不修改传入的 state）。
 */
export function nextQueueAnswer(state: ListState, deps: ListReadDeps): { body: QueueListBody; state: ListState } {
  const now = deps.now()
  // 回前台判据：间隔远超退避上限 ⇒ 页面离开过前台（或引擎刚被唤醒），这一拍必须如实读。
  const resumed = state.lastListAt !== null && now - state.lastListAt > RESUME_GAP_MS
  const fingerprint = deps.fingerprint()
  const fingerprintHit = fingerprint !== null && state.fingerprint === fingerprint
  if (!resumed && fingerprintHit && state.body !== null && now < state.backoff.nextFullReadAt) {
    // 轻量返回：队列内容与上次完整读逐项一致，且退避尚未到点。
    return {
      body: state.body,
      state: { ...state, lastListAt: now },
    }
  }
  deps.purgeTtl()
  const items = deps.items()
  const publicItems = items.map(publicItem)
  const pending = items.filter(needsSession).length
  const empty = publicItems.length === 0
  // 空队列且上次已统计过占用：沿用旧值（临时目录里没有新增来件）。
  const bytes = empty && state.empty && state.body !== null ? state.body.bytes : deps.workspaceBytes()
  const body: QueueListBody = { ok: true, pending, items: publicItems, bytes }
  const backoff = advanceIdleBackoff(state.backoff, { fingerprint, empty }, now)
  return {
    body,
    state: { fingerprint, body, empty, backoff, lastListAt: now },
  }
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
  /** 清单 GET 的读链状态（审计 §7.7：空队列轻量返回 + 连续空读退避 + 回前台立即读）。 */
  let listState: ListState = initialListState()
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
          // 鉴权已在上方 first-line 完成（审计 §7.7 的安全边界：轻量返回不得绕过鉴权）。
          const answer = nextQueueAnswer(listState, {
            fingerprint: queueFingerprint,
            purgeTtl: () => { try { purgeStaleUnclaimed('ttl') } catch { /* 清理失败不阻断 */ } },
            items: readItems,
            workspaceBytes: () => {
              let total = 0
              try {
                for (const f of readdirSync(tmpWorkspace())) {
                  if (f === '.sessions') continue
                  const st = statSync(join(tmpWorkspace(), f))
                  if (st.isFile()) total += st.size
                }
              } catch { /* 统计失败不阻断 */ }
              return total
            },
            now: Date.now,
          })
          listState = answer.state
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(answer.body))
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
          try { req.destroy() } catch { /* request is already terminal */ }
          res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: 'claim timeout' }))
        }, 5000)
        req.on('data', (chunk: Buffer) => {
          if (settled) return
          body += chunk.toString()
          if (body.length > 4096) {
            settled = true
            try { req.destroy() } catch { /* request is already terminal */ }
            res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: false, error: 'claim body too large' }))
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
            if (path === null || !existsSync(path)) {
              res.writeHead(410, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ ok: false, error: 'incoming source expired' }))
              return
            }
            const current = statSync(path)
            if (!current.isFile()) {
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
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes),
          'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(lease.name),
          'cache-control': 'no-store',
        })
        await new Promise<void>((resolve) => {
          const stream = createReadStream(path)
          stream.on('data', (chunk: string | Buffer) => { res.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) })
          stream.on('error', () => { res.end(); resolve() })
          stream.on('end', () => { res.end(); resolve() })
        })
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
          try { req.destroy() } catch { /* request is already terminal */ }
          res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: 'completion timeout' }))
        }, 5000)
        req.on('data', (chunk: Buffer) => {
          if (settled) return
          body += chunk.toString()
          if (body.length > 2048) {
            settled = true
            try { req.destroy() } catch { /* request is already terminal */ }
            res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: false, error: 'completion body too large' }))
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