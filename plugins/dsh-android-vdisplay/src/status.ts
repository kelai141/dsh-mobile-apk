/**
 * 虚拟屏能力状态：宿主半与浏览器半**共用**的纯逻辑（无 host-only 依赖，浏览器包可内联）。
 *
 * 拆出来的理由：状态映射是唯一需要"双端一致 + 可离线验证"的部分——宿主工具、只读状态端点、
 * 浏览器面板必须对同一份 payload 得到同一个四态结论；放在 client 里则 host 无法复用，
 * 放在 host 里则浏览器包要跨端 import（上游禁止）。这里是纯函数，可被 node 直接单测。
 *
 * 四态（fail-closed）：
 *   disabled 开关关闭（默认态） / blocked 探测缺项或状态源不可达 / ready 能力就绪未建屏 / active 已建屏
 * 任何未知、缺失、异常一律 blocked——**不得**出现"未知但可用"。
 */

/** 计划中的 `vd*` op 表（源文档 §8.2）。仅声明：未进六处登记链，当前不可从控制队列调用。 */
export const VD_OPS = ['vdCreate', 'vdDestroy', 'vdLaunch', 'vdMoveTask', 'vdInfo', 'vdLaunchApp', 'vdInput'] as const
export type VdOp = (typeof VD_OPS)[number]

/**
 * Panel copy in the active page language.
 *
 * This module is also imported by the host half, where there is no DOM; the
 * lookup therefore degrades to Chinese instead of throwing.
 */
function tr(zh: string, en: string): string {
  try {
    return document.documentElement.lang.toLowerCase().startsWith('en') ? en : zh
  } catch {
    return zh
  }
}

/** 能力状态。 */
export type VdState = 'disabled' | 'blocked' | 'ready' | 'active'

/** 只读状态端点（宿主注册，浏览端读；与 ADB 授权块的 /api/android/privilege/status 同风格）。 */
export const VD_STATUS_PATH = '/api/android/vdisplay/status'

/** 状态源不可达时的稳定错误码（面板显示它，而不是假装可用）。 */
export const VD_STATUS_UNAVAILABLE = 'vdisplay-status-unavailable'

/** 壳侧桥面（可选服务；缺失时一律 blocked）。 */
export interface VdisplayFace {
  vdisplayStatus?(): VdStatusPayload
  /**
   * 控制队列调用面（与 dsh-android-bridge 的 androidPrivilege.controlExec 同形）。
   * `vd*` 是 neverA11y 的壳桥 op：本插件只借队列投递，绝不把 op 加进 A11Y_OPS。
   *
   * `auth.session` **不是可选装饰**：`vdInput` / `vdLaunch` / `vdLaunchApp` / `vdMoveTask` 在
   * bridge 的 `TIER_REQUIRED_OPS` 内，服务面按「显式 auth > 异步上下文绑定 > 无」解析调用方会话，
   * 解析不到即 fail-closed 拒绝。0.14.1 设备实测（W2 真实任务）：本插件从不传 auth、也不调
   * `bindSession` ⇒ `android_vdisplay_input` **恒**被拒（回执「缺少调用方会话」），
   * 模型只能退回 `android_shell_exec` 裸跑 `input -d`——能力被承诺而不可用。
   */
  controlExec?(
    op: VdOp,
    args: Record<string, unknown>,
    timeoutMs?: number,
    auth?: { session?: unknown; internal?: string },
  ): Promise<VdControlReply>
}

/** 控制队列回执（逐字段收窄；失败一律带结构化 error）。 */
export interface VdControlReply {
  ok: boolean
  code?: string
  data?: Record<string, unknown>
  error?: string
}

/** 实时屏幕注册表条目（壳侧 DisplayManager 真源 + 稳定别名；真实屏不可镜像）。 */
export interface VdScreen {
  alias: string
  displayId: number
  kind: string
  label: string
  state: string
  width: number
  height: number
  densityDpi: number
  selectable: boolean
  reason: string
  viewerId?: string
}

/** 查看器独立 bounds 记录（多窗口仲裁用；同一 Surface 不会同时挂两个查看器）。 */
export interface VdViewer {
  viewerId: string
  target?: string
  presenting: boolean
}

/** 宿主返回体 / 面板消费体（两侧同一形状）。 */
export interface VdStatusPayload {
  ok?: boolean
  enabled?: boolean
  state?: string
  code?: string
  guidance?: string
  ops?: string[]
  transports?: string[]
  displayId?: number
  screens?: VdScreen[]
  selected?: string | null
  viewers?: VdViewer[]
  /** 0.14.0 会话归属：非空且非本会话时，面板显示「由会话 X 使用中」并禁用操作。 */
  ownerSessionId?: string
}

/** 宿主工具返回值（含渲染用的 text）。 */
export interface VdSnapshot {
  ok: boolean
  enabled: boolean
  state: VdState
  code: string
  guidance: string
  transports: string[]
  displayId?: number
  ops: string[]
  screens: VdScreen[]
  selected?: string
}

/** 面板状态（比 VdSnapshot 少 enabled/transports，多稳定 detail 文案）。 */
export interface VdPanelState {
  state: VdState
  code: string
  detail: string
  ops: string[]
  displayId?: number
  screens: VdScreen[]
  selected?: string
  viewers: VdViewer[]
  ownerSessionId?: string
}

/**
 * 读一次能力状态（宿主半用）。fail-closed：桥面缺席 / 开关关闭 / 状态非法一律 ok:false + 结构化 code。
 * @param face - 壳侧桥面（可选服务，缺失即未接通）。
 * @returns 状态快照。
 */
/**
 * 由**已取到的**状态载荷映射为工具快照（纯函数）。
 *
 * 拆出这一层的理由（0.14.0 真机实锤）：状态有两条来源，形状不同，必须共用同一个映射体，
 * 否则「同一事实、两种读数」的缺陷会再次出现——
 *   - 壳侧 WebView 桥 `vdisplayStatus()`（面板读，**存在且正常**）；
 *   - 引擎侧 `androidPrivilege.controlExec('vdInfo')`（模型工具唯一可达的通路）。
 * 缺陷形态：模型工具只认前者，而引擎侧服务从来没有 `vdisplayStatus` 字段（只有 `controlExec`），
 * 于是 `android_vdisplay_status` 恒报 blocked/`vdisplay-shell-not-wired`，
 * 而 `android_vdisplay_create` 同一时刻成功建屏（displayId=25/state=active）。
 * 模型据此判定能力不可用而放弃整条路径——**声称不可用而实际可用**，与「声称可用而实际不可用」
 * 危害相同（都会让模型做出错误决策）。
 *
 * @param raw - 状态载荷；`undefined` = 无任何来源（fail-closed）。
 * @param absent - 无来源时的失败文案（区分「真的没接通」与「控制队列报错」）。
 * @returns 工具快照。
 */
export function snapshotFromRaw(
  raw: VdStatusPayload | undefined,
  absent?: { code: string; guidance: string },
): VdSnapshot {
  const base = { enabled: false, transports: [] as string[], ops: [...VD_OPS], screens: [] as VdScreen[] }
  if (raw === undefined) {
    return { ok: false, ...base, state: 'blocked',
      code: absent?.code ?? 'vdisplay-shell-not-wired',
      guidance: absent?.guidance ?? '虚拟屏状态不可达：引擎侧 androidPrivilege 既无 vdisplayStatus 桥面、控制队列也未回执。先用 android_vdisplay_create 试建屏，或用 android_privilege_status 检查授权面。' }
  }
  const enabled = raw.enabled === true
  const state = raw.state === 'ready' || raw.state === 'active' || raw.state === 'blocked' || raw.state === 'disabled'
    ? raw.state
    : 'blocked'
  const screens = normalizeScreens(raw.screens)
  if (!enabled || state === 'disabled') {
    return { ok: false, ...base, screens, state: 'disabled', code: raw.code ?? 'vdisplay-disabled',
      guidance: raw.guidance ?? '虚拟屏开关关闭（默认关闭；在右侧栏「虚拟屏」Tab 或设置页开启，需先满足探测缺项）。' }
  }
  if (state === 'blocked') {
    return { ok: false, ...base, screens, enabled, state, code: raw.code ?? 'vdisplay-blocked',
      guidance: raw.guidance ?? '能力探测缺项，虚拟屏无法打开（缺什么/为什么/能否补救见设置页错误码）。' }
  }
  // issue #1211：自报 `active`/`ready` **不等于**有对应屏幕。旧实现直接把 state 当 ok:true，
  // 于是「displayId 不在 screens 里」甚至「screens 为空」都报「虚拟屏已激活」——模型据此下发
  // vdInput/vdLaunch，拿到的却是壳侧失败回执：先假成功再失败，比直接 blocked 更难排查。
  // 判据与 #1476 同型：**ok 必须有功能证据**（这里的功能证据 = 已注册屏幕里有它）。
  if (screens.length === 0) {
    return { ok: false, ...base, screens, enabled, state, code: 'vdisplay-no-screens',
      guidance: '虚拟屏自报「' + state + '」，但没有任何已注册屏幕（screens 为空）——先 android_vdisplay_create 再操作。' }
  }
  const reportedDisplay = typeof raw.displayId === 'number' ? raw.displayId : undefined
  if (reportedDisplay !== undefined && !screens.some((s) => s.displayId === reportedDisplay)) {
    return { ok: false, ...base, screens, enabled, state, code: 'vdisplay-display-missing',
      guidance: '虚拟屏自报 displayId=' + reportedDisplay + '，但它不在已注册屏幕里（现有：'
        + screens.map((s) => s.alias + '#' + s.displayId).join('、') + '）——以 android_vdisplay_status 的 screens 为准，请重建屏。' }
  }
  if (state === 'active' && reportedDisplay === undefined) {
    return { ok: false, ...base, screens, enabled, state, code: 'vdisplay-display-missing',
      guidance: '虚拟屏自报已激活，但没有给出 displayId——无法证明对应屏幕存在，按未就绪处理。' }
  }
  const out: VdSnapshot = { ok: true, ...base, screens, enabled, state, code: raw.code ?? 'vdisplay-ok',
    guidance: raw.guidance ?? (state === 'active' ? '虚拟屏已激活（AI 操作面在虚拟屏，用户前台不受影响）。' : '能力就绪，尚未建屏。'),
    transports: raw.transports ?? [] }
  // displayId 只在真为数字时带上整键：undefined 会被 lossless 物化丢弃，引擎整值校验直接判
  // 「非 lossless JSON 对象」（与 #204 同族）。
  if (typeof raw.displayId === 'number') out.displayId = raw.displayId
  if (typeof raw.selected === 'string') out.selected = raw.selected
  return out
}

/**
 * 读一次能力状态（**仅壳侧 WebView 桥**路径；浏览器面板与只读端点没有引擎侧服务，只有这个面）。
 *
 * 注意：引擎侧模型工具**不要**用本函数——引擎侧 androidPrivilege 服务没有 `vdisplayStatus`
 * （这正是 0.14.0 那个「status 恒报未接通」缺陷）。模型面请用 `readVdToolSnapshot`。
 * @param face - 壳侧桥面（可选服务，缺失即未接通）。
 * @returns 状态快照。
 */
export function readVdSnapshot(face: VdisplayFace | undefined): VdSnapshot {
  return snapshotFromRaw(face?.vdisplayStatus?.())
}

/**
 * 读一次能力状态——**模型工具专用**，走与控制 op 完全相同的通路。
 *
 * 为什么模型工具不能复用 `readVdSnapshot(faceOf())`：引擎侧 androidPrivilege 服务只暴露
 * `controlExec`（create/destroy 都从这条路走通），**没有** `vdisplayStatus`。工具只认桥面就必然
 * 恒报「未接通」。这里优先控制队列 `vdInfo`，与 create/destroy 同源；控制队列不可用时才回退桥面。
 *
 * @param face - 引擎侧 androidPrivilege 面（可选服务）。
 * @returns 状态快照；任何失败都带**归因准确**的 code/guidance，绝不把「读不到」说成「没落地」。
 */
export async function readVdToolSnapshot(face: VdisplayFace | undefined): Promise<VdSnapshot> {
  const service = face
  if (service?.controlExec !== undefined) {
    try {
      const reply = await service.controlExec('vdInfo', {}, 8_000)
      if (reply !== null && typeof reply === 'object' && reply.ok === true) {
        const data = reply.data
        if (data !== null && typeof data === 'object') return snapshotFromRaw(data as VdStatusPayload)
      }
      const detail = reply !== null && typeof reply === 'object' && typeof reply.error === 'string' && reply.error !== ''
        ? reply.error
        : undefined
      return snapshotFromRaw(undefined, {
        code: 'vdisplay-control-failed',
        guidance: '虚拟屏控制通道未回执 vdInfo：' + (detail ?? '控制队列未返回结果')
          + '。建屏/销毁走同一条通路，此处读不到不代表能力不可用——可先试 android_vdisplay_create。',
      })
    } catch (e) {
      return snapshotFromRaw(undefined, {
        code: 'vdisplay-control-exception',
        guidance: '虚拟屏控制通道异常：' + (e instanceof Error ? e.message : String(e))
          + '。可先试 android_vdisplay_create 复核通路是否真的不可用。',
      })
    }
  }
  return snapshotFromRaw(service?.vdisplayStatus?.())
}

/** 逐字段收窄壳侧 screens 数组（形状不可信；坏条目丢弃而不是整块失败）。 */
function normalizeScreens(input: unknown): VdScreen[] {
  if (!Array.isArray(input)) return []
  const out: VdScreen[] = []
  for (const item of input) {
    if (item === null || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    if (typeof raw.alias !== 'string' || typeof raw.displayId !== 'number') continue
    out.push({
      alias: raw.alias,
      displayId: raw.displayId,
      kind: typeof raw.kind === 'string' ? raw.kind : 'unknown',
      label: typeof raw.label === 'string' ? raw.label : raw.alias,
      state: typeof raw.state === 'string' ? raw.state : 'unknown',
      width: typeof raw.width === 'number' ? raw.width : 0,
      height: typeof raw.height === 'number' ? raw.height : 0,
      densityDpi: typeof raw.densityDpi === 'number' ? raw.densityDpi : 0,
      selectable: raw.selectable === true,
      reason: typeof raw.reason === 'string' ? raw.reason : '',
      ...(typeof raw.viewerId === 'string' ? { viewerId: raw.viewerId } : {}),
    })
  }
  return out
}

/** 逐字段收窄壳侧 viewers 数组。 */
function normalizeViewers(input: unknown): VdViewer[] {
  if (!Array.isArray(input)) return []
  const out: VdViewer[] = []
  for (const item of input) {
    if (item === null || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    if (typeof raw.viewerId !== 'string') continue
    out.push({
      viewerId: raw.viewerId,
      presenting: raw.presenting === true,
      ...(typeof raw.target === 'string' ? { target: raw.target } : {}),
    })
  }
  return out
}

/**
 * 浏览器 fetch 的最小结构面：只用到 `ok/status/json()`。
 *
 * 这样做而不直接写 `typeof fetch` 的原因：本文件同时被宿主半编译（host tsconfig 的 lib 只有
 * ES2022，没有 DOM），引用 `fetch` 类型会让宿主构建失败。浏览器半在调用点把全局 fetch 适配进来。
 */
export type FetchLike = (
  path: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/**
 * 读一次状态端点并映射为四态。任何失败（网络、非 2xx、非法 JSON）都是 blocked，且带稳定
 * 错误码 `vdisplay-status-unavailable`（面板据此显示"为什么不可用"）。
 * @param fetchImpl - fetch 适配（浏览器传全局 fetch；node 可注入桩）。
 * @returns 面板状态。
 */
export async function readPanelState(fetchImpl: FetchLike): Promise<VdPanelState> {
  try {
    const r = await fetchImpl(VD_STATUS_PATH, { headers: { accept: 'application/json' } })
    if (!r.ok) {
      return {
        state: 'blocked', code: VD_STATUS_UNAVAILABLE,
        detail: tr('状态端点返回 HTTP ', 'Status endpoint returned HTTP ') + r.status
          + tr('（fail-closed）。', ' (fail-closed).'), ops: [], screens: [], viewers: [],
      }
    }
    return mapStatusPayload(await r.json())
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      state: 'blocked', code: VD_STATUS_UNAVAILABLE,
      detail: tr('状态端点不可达（fail-closed）：', 'Status endpoint unreachable (fail-closed): ') + msg,
      ops: [], screens: [], viewers: [],
    }
  }
}

/**
 * 把宿主返回体映射为面板四态（纯函数，浏览器与 node 单测共用）。
 * @param payload - 状态端点返回体（形状不可信，逐字段收窄）。
 * @returns 面板状态。
 */
export function mapStatusPayload(payload: unknown): VdPanelState {
  if (payload === null || typeof payload !== 'object') {
    return {
      state: 'blocked', code: VD_STATUS_UNAVAILABLE,
      detail: tr('状态端点返回体不是对象（fail-closed）。', 'Status endpoint did not return an object (fail-closed).'),
      ops: [], screens: [], viewers: [],
    }
  }
  const p = payload as VdStatusPayload
  const ops = Array.isArray(p.ops) ? p.ops.filter((x): x is string => typeof x === 'string') : []
  const screens = normalizeScreens(p.screens)
  const viewers = normalizeViewers(p.viewers)
  const selected = typeof p.selected === 'string' ? p.selected : undefined
  const ownerSessionId = typeof p.ownerSessionId === 'string' && p.ownerSessionId !== '' ? p.ownerSessionId : undefined
  const base = {
    ops,
    screens,
    viewers,
    detail: typeof p.guidance === 'string' ? p.guidance : '',
    ...(selected === undefined ? {} : { selected }),
    ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
  }
  const displayId = typeof p.displayId === 'number' ? p.displayId : undefined
  const state = p.state
  if (state === 'disabled' || p.enabled !== true) {
    return { ...base, state: 'disabled', code: typeof p.code === 'string' ? p.code : 'vdisplay-disabled' }
  }
  if (state === 'blocked') {
    return { ...base, state: 'blocked', code: typeof p.code === 'string' ? p.code : 'vdisplay-blocked' }
  }
  if (state === 'ready' || state === 'active') {
    const out: VdPanelState = { ...base, state, code: typeof p.code === 'string' ? p.code : 'vdisplay-ok' }
    if (displayId !== undefined) out.displayId = displayId
    return out
  }
  // 未知 state：一律 blocked（不得乐观置位）
  return { ...base, state: 'blocked', code: typeof p.code === 'string' ? p.code : 'vdisplay-blocked' }
}
