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
export const VD_OPS = ['vdCreate', 'vdDestroy', 'vdLaunch', 'vdMoveTask', 'vdInfo'] as const
export type VdOp = (typeof VD_OPS)[number]

/** 能力状态。 */
export type VdState = 'disabled' | 'blocked' | 'ready' | 'active'

/** 只读状态端点（宿主注册，浏览端读；与 ADB 授权块的 /api/android/privilege/status 同风格）。 */
export const VD_STATUS_PATH = '/api/android/vdisplay/status'

/** 状态源不可达时的稳定错误码（面板显示它，而不是假装可用）。 */
export const VD_STATUS_UNAVAILABLE = 'vdisplay-status-unavailable'

/** 壳侧桥面（可选服务；缺失时一律 blocked）。 */
export interface VdisplayFace {
  vdisplayStatus?(): VdStatusPayload
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
}

/** 面板状态（比 VdSnapshot 少 enabled/transports，多稳定 detail 文案）。 */
export interface VdPanelState {
  state: VdState
  code: string
  detail: string
  ops: string[]
  displayId?: number
}

/**
 * 读一次能力状态（宿主半用）。fail-closed：桥面缺席 / 开关关闭 / 状态非法一律 ok:false + 结构化 code。
 * @param face - 壳侧桥面（可选服务，缺失即未接通）。
 * @returns 状态快照。
 */
export function readVdSnapshot(face: VdisplayFace | undefined): VdSnapshot {
  const raw = face?.vdisplayStatus?.()
  const base = { enabled: false, transports: [] as string[], ops: [...VD_OPS] }
  if (raw === undefined) {
    return { ok: false, ...base, state: 'blocked', code: 'vdisplay-shell-not-wired',
      guidance: '虚拟屏桥面尚未接通（壳侧 Shizuku/建屏探针未落地）。当前只能用真实屏控制，或先用 android_privilege_status 检查授权面。' }
  }
  const enabled = raw.enabled === true
  const state = raw.state === 'ready' || raw.state === 'active' || raw.state === 'blocked' || raw.state === 'disabled'
    ? raw.state
    : 'blocked'
  if (!enabled || state === 'disabled') {
    return { ok: false, ...base, state: 'disabled', code: raw.code ?? 'vdisplay-disabled',
      guidance: raw.guidance ?? '虚拟屏开关关闭（默认关闭；在右侧栏「虚拟屏」Tab 或设置页开启，需先满足探测缺项）。' }
  }
  if (state === 'blocked') {
    return { ok: false, ...base, enabled, state, code: raw.code ?? 'vdisplay-blocked',
      guidance: raw.guidance ?? '能力探测缺项，虚拟屏无法打开（缺什么/为什么/能否补救见设置页错误码）。' }
  }
  const out: VdSnapshot = { ok: true, ...base, enabled, state, code: raw.code ?? 'vdisplay-ok',
    guidance: raw.guidance ?? (state === 'active' ? '虚拟屏已激活（AI 操作面在虚拟屏，用户前台不受影响）。' : '能力就绪，尚未建屏。'),
    transports: raw.transports ?? [] }
  // displayId 只在真为数字时带上整键：undefined 会被 lossless 物化丢弃，引擎整值校验直接判
  // 「非 lossless JSON 对象」（与 #204 同族）。
  if (typeof raw.displayId === 'number') out.displayId = raw.displayId
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
        detail: '状态端点返回 HTTP ' + r.status + '（fail-closed）。', ops: [],
      }
    }
    return mapStatusPayload(await r.json())
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { state: 'blocked', code: VD_STATUS_UNAVAILABLE, detail: '状态端点不可达（fail-closed）：' + msg, ops: [] }
  }
}

/**
 * 把宿主返回体映射为面板四态（纯函数，浏览器与 node 单测共用）。
 * @param payload - 状态端点返回体（形状不可信，逐字段收窄）。
 * @returns 面板状态。
 */
export function mapStatusPayload(payload: unknown): VdPanelState {
  if (payload === null || typeof payload !== 'object') {
    return { state: 'blocked', code: VD_STATUS_UNAVAILABLE, detail: '状态端点返回体不是对象（fail-closed）。', ops: [] }
  }
  const p = payload as VdStatusPayload
  const ops = Array.isArray(p.ops) ? p.ops.filter((x): x is string => typeof x === 'string') : []
  const base = { ops, detail: typeof p.guidance === 'string' ? p.guidance : '' }
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
