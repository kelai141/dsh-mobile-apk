/**
 * 虚拟屏面板状态：**纯逻辑**（无 HTTP、无控制队列、无宿主依赖）。
 *
 * 迁移自 plugins/dsh-android-vdisplay/src/status.ts 的浏览器半部分。旧插件把状态读成两条通路：
 * 壳侧 WebView 桥 vdisplayStatus() 与 GET /api/android/vdisplay/status；后者是旧宿主端的只读端点，
 * 随旧执行器一起退役。现在 **原生 AndroidBridge 是唯一事实**，本文件只保留「把一次原生回执映射
 * 成面板四态」的纯函数，供面板与单测共用。
 *
 * 四态（fail-closed）：
 *   disabled 开关关闭（默认态） / blocked 探测缺项或状态源不可达 / ready 能力就绪未建屏 / active 已建屏
 * 任何未知、缺失、异常一律 blocked——**不得**出现「未知但可用」。
 */

/** 计划中的 vd* op 表（源文档 §8.2）。面板只用于展示，不构成执行通路。 */
export const VD_OPS = ['vdCreate', 'vdDestroy', 'vdLaunch', 'vdMoveTask', 'vdInfo', 'vdLaunchApp', 'vdInput'] as const
export type VdOp = (typeof VD_OPS)[number]

/**
 * Panel copy in the active page language.
 *
 * 面板只跑在 WebView 里，但仍按「无 DOM 时不抛」写，方便 node 单测直接导入。
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

/** 状态源不可达时的稳定错误码（面板显示它，而不是假装可用）。 */
export const VD_STATUS_UNAVAILABLE = 'vdisplay-status-unavailable'

/** 壳侧桥面（可选服务；缺失时一律 blocked）。只读，不再声明任何执行面。 */
export interface VdisplayFace {
  vdisplayStatus?(): VdStatusPayload
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

/** 面板状态（比壳侧载荷多稳定 detail 文案）。 */
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
 * 把宿主返回体映射为面板四态（纯函数，浏览器与 node 单测共用）。
 * @param payload - 原生 vdisplayStatus() 的解析结果（形状不可信，逐字段收窄）。
 * @returns 面板状态。
 */
export function mapStatusPayload(payload: unknown): VdPanelState {
  if (payload === null || typeof payload !== 'object') {
    return {
      state: 'blocked', code: VD_STATUS_UNAVAILABLE,
      detail: tr('状态源返回体不是对象（fail-closed）。', 'Status payload did not return an object (fail-closed).'),
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

/** 逐字段收窄壳侧 screens 数组（形状不可信；坏条目丢弃而不是整块失败）。 */
export function normalizeScreens(input: unknown): VdScreen[] {
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
export function normalizeViewers(input: unknown): VdViewer[] {
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
