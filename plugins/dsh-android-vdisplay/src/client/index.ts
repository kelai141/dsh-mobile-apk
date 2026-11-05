/**
 * 浏览器半：把「虚拟屏」注册为**右侧栏的同级 tab 类型**（与「工作区文件」同级），并把状态面板
 * 接到宿主只读端点 `GET /api/android/vdisplay/status` 的**真实返回**（fail-closed 四态）。
 *
 * 0.14.0 面板极简（用户 2026-09-15）：只保留「选择虚拟屏编号」列表 + 原生画面工位；
 * 模型未建屏时显示「暂无虚拟屏」；被其他会话占用时显示「由会话 X 使用中」。
 * 建屏只由模型驱动（android_vdisplay_create/destroy），面板不提供创建/销毁按钮。
 *
 * 依据（用户约束 U-1，见 docs/0.14.0-preview-USER-CONSTRAINTS.md）：
 * 入口必须落在该面板上，不得另起与面板无关的入口。上游「工作区文件」= 右侧栏 tab 类型，
 * 注册面 = 两阶段：① ctx.sidebarRightTabs.register({...})；② slots.inject + register。
 *
 * 数据面纪律：状态经只读 GET（与 ADB 授权块同风格）；本 Tab **不经 window.androidBridge 写面**
 * 之外的控制面、不合成像素（源文档 §9.2）。状态源不可达 = blocked（fail-closed，不假装可用）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  mapStatusPayload,
  readPanelState,
  VD_OPS,
  VD_STATUS_UNAVAILABLE,
  type FetchLike,
  type VdPanelState,
  type VdScreen,
  type VdViewer,
} from '../status.ts'
import { watchTerminalKeybars } from '../keybar/mount.ts'

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** True when the dsh page language is English. */
function isEnglish(): boolean {
  try {
    return document.documentElement.lang.toLowerCase().startsWith('en')
  } catch {
    return false
  }
}

/** Chinese or English copy for the active page language. */
function tr(zh: string, en: string): string {
  return isEnglish() ? en : zh
}

/** SlotMap 本地 augmentation：与上游 keyed/session 语义一致（临时性见文件头注释）。 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.right.pane.tab': { kind: 'keyed'; scope: 'session' }
    'sidebar.right.pane.tab.title': { kind: 'keyed'; scope: 'session' }
  }
}

/**
 * `ctx.slots` 服务面：上游由 `@deepseek-ai/dsh-client-ui-renderer/client` 声明这个
 * Context merge（dsh/packages/client/ui-renderer/src/client/index.ts:43-45，
 * `slots: SlotRegistry`），但 renderer 包不在本插件 client 半的依赖面上（运行时由宿主
 * 注入），因此按 `dsh-client-ui-responsive/src/client/slots-augment.d.ts:29-42` 的同款
 * 做法在本地镜像其签名（registry.ts:209 inject / :741 register，均返回 dispose）。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Slot registry: register()/inject() composition face. */
    slots: {
      register(options: object, component: unknown): () => void;
      inject(
        key: keyof import('@deepseek-ai/dsh-client-ui-slots').SlotMap & string,
        callback: () => () => void,
      ): () => void;
    };
  }
}

/** 本 tab 类型的 id（也是 body/title 两个 keyed seat 的 key）。 */
export const VD_TAB_ID = '@dsh-android/dsh-android-vdisplay'
/** 本 tab 类型在 tab 系统里的 kind。 */
export const VD_TAB_KIND = 'android-vdisplay'
/** 状态轮询间隔（毫秒）：只读、低频；面板打开时才有请求。 */
export const VD_POLL_MS = 10_000

/** 结构化定义（上游 SidebarRightTabDefinition 的最小面）。
 *  0.1.7 起 guide 条目新增必填 `id`（上游按 [providerId, entry.id] 键控），此处随版补齐——
 *  少了它本地最小面会比上游宽，编译期看不出漂移。 */
interface TabDefinition {
  id: string
  kind: string
  priority?: 'extension' | 'builtin' | 'fallback'
  title: () => string
  guide?: Array<{ id: string; order: number; title: () => string; description: () => string }>
}
/** 结构化注册面（上游 SidebarRightTabRegistry 的最小面）。 */
interface TabRegistry {
  register(definition: TabDefinition): () => void
}
interface SidebarRightController {
  openTab(kind: string, options?: { revealIfOpened?: boolean }): void
}

/** Required services: slots and the sidebar controller used to reveal an active viewer. */
export const inject = ['slots', 'sidebarRight'] as const

/** Browser fallback for desktop/older shells. The native bridge is authoritative on Android so a
 * missing optional host route cannot turn a working local capability into a false HTTP-404 error. */
const browserFetch: FetchLike = (path, init) => fetch(path, init)

const VD_STYLE = `
.dsh-vdisplay-panel{display:flex;flex-direction:column;gap:8px;height:100%;min-height:0;padding:8px;box-sizing:border-box;color:var(--dsw-alias-label-primary)}
.dsh-vdisplay-empty{margin:0;padding:10px;font:var(--dsw-font-markdown-small);color:var(--dsw-alias-label-secondary)}
.dsh-vdisplay-list{display:flex;flex-wrap:wrap;gap:6px}
.dsh-vdisplay-item{min-width:36px;min-height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:var(--dsw-font-markdown-small)}
.dsh-vdisplay-item-selected{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsh-vdisplay-item:disabled{opacity:.45}
/* 手动关机：与编号同排，用危险色区分「切换」与「关闭」两种动作。 */
.dsh-vdisplay-shutdown{margin-left:auto;border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary)}
.dsh-vdisplay-shutdown:hover{border-color:#e5534b;color:#e5534b}
.dsh-vdisplay-stage{position:relative;flex:1 1 180px;min-height:180px;overflow:hidden;border-radius:12px;background:var(--dsw-alias-bg-layer-2)}
`

type NativeVdisplayBridge = {
  vdisplayStatus?: () => string
  vdisplayCreate?: () => string
  /** 可传 target 别名；缺省销毁当前选中/本会话自己的屏。 */
  vdisplayDestroy?: (target?: string) => string
  vdisplayBounds?: (bounds: string) => string
  vdisplaySelect?: (alias: string) => string
  /**
   * 手动关机（0.14.0）：销毁本机全部虚拟屏，与设置页「强制销毁」同口径。
   * 声明在此以便类型检查；未声明时下方调用会静默 no-op（可选链），所以必须登记。
   */
  forceDestroyVdisplay?: () => string
}

/** Stable viewer identity for the Files-sidebar stage (independent bounds record + arbitration). */
const VIEWER_ID = 'files-sidebar'

/**
 * 两次状态快照是否**语义相同**（浅比较：逐字段比值，数组逐项比字段）。
 *
 * 审计 §7.6 的缺陷形态：`setSnap(s)` 每次都是**新对象**（`pull()` 每拍 mapStatusPayload 一次），
 * React 用 Object.is 判等，于是就算内容一个字都没变也要重渲染整个面板——每秒一次。
 * 面板里还有 `snap.screens.filter(...)` 与列表映射，重渲染不是零成本。
 *
 * 为什么自己写而不是上深比较库：形状是本文件定义的（VdPanelState），字段就这些；
 * screens/viewers 是唯一的两层结构，按字段逐项比即可，不必引入依赖（也不该为此新增依赖）。
 *
 * @param a - 上一次的快照。
 * @param b - 这次读回来的快照。
 * @returns 语义相同时 true（调用方据此跳过 setState）。
 */
export function samePanelState(a: VdPanelState, b: VdPanelState): boolean {
  if (a === b) return true
  if (a.state !== b.state) return false
  if (a.code !== b.code) return false
  if (a.detail !== b.detail) return false
  if (a.selected !== b.selected) return false
  if (a.displayId !== b.displayId) return false
  if (a.ownerSessionId !== b.ownerSessionId) return false
  if (a.ops.length !== b.ops.length) return false
  for (let i = 0; i < a.ops.length; i += 1) if (a.ops[i] !== b.ops[i]) return false
  if (!sameScreens(a.screens, b.screens)) return false
  return sameViewers(a.viewers, b.viewers)
}

/** screens 逐项比（字段全部参与：任何一个变化都可能改变渲染与可见性判据）。 */
function sameScreens(a: readonly VdScreen[], b: readonly VdScreen[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    if (x.alias !== y.alias || x.displayId !== y.displayId || x.kind !== y.kind || x.label !== y.label) return false
    if (x.state !== y.state || x.selectable !== y.selectable || x.reason !== y.reason) return false
    if (x.width !== y.width || x.height !== y.height || x.densityDpi !== y.densityDpi) return false
    if (x.viewerId !== y.viewerId) return false
  }
  return true
}

/** viewers 逐项比。 */
function sameViewers(a: readonly VdViewer[], b: readonly VdViewer[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    if (x.viewerId !== y.viewerId || x.presenting !== y.presenting || x.target !== y.target) return false
  }
  return true
}

/** 舞台几何下发的输入（全部来自调用点，纯数据，便于单测）。 */
export interface StageBoundsInput {
  /** 舞台矩形（getBoundingClientRect 的结果）。 */
  readonly rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
  readonly viewportWidth: number
  readonly viewportHeight: number
  /** 侧栏已收起（权威信号 = 上游展开控件在场；data-rightbar-collapsed 是常量，不可用）。 */
  readonly collapsed: boolean
  /** 舞台自身被 display:none / visibility:hidden 藏起来。 */
  readonly hidden: boolean
  /** 有覆盖层（三个点弹层等）压在上面。 */
  readonly overlapped: boolean
  /** 本会话之外有主（ownerSessionId 不是本会话）。 */
  readonly occupied: boolean
  /** 当前状态快照（用 state 与 screens 决定可见性与目标屏）。 */
  readonly snap: Pick<VdPanelState, 'state' | 'screens' | 'selected'>
}

/** 下发给壳侧的舞台几何载荷。 */
export interface StageBoundsPayload {
  left: number
  top: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  visible: boolean
  viewerId: string
  target?: string
}

/**
 * 由一次测量算出下发给壳侧的载荷（纯函数）。
 *
 * **三条可见性判据一条都不能丢**（每条都对着一次用户实报）：
 *   1. `collapsed`——收起侧栏时上游只是把面板隐藏（组件仍在 DOM 里保活），舞台矩形与 display
 *      都不变；缺这条会算出 visible:true → 原生 SurfaceView 保持可见，**盖在聊天界面上**。
 *   2. `overlapped`——三个点弹层展开时必须让开：原生画面在 WebView 之上，否则弹层被整块挡住。
 *   3. `occupied`——别的会话在用时本会话不得抢画面（多窗口仲裁）。
 * 另外 hidden（舞台自身不可见）与「矩形退化」两条是基础判据。
 *
 * 目标屏别名兜底（0.14.0 设备实锤）：`selected` 在面板刚打开 / 状态未拉到 / 该屏刚被销毁时为空，
 * 壳侧便会退回「按舞台宽高比」拉伸（用户报「自适应缩放不对」）。内容宽高比只取决于「哪块屏存在」，
 * 故按 选中 → 唯一活跃屏 依次退化。
 * @param input - 一次测量的全部输入。
 * @returns 待下发的载荷。
 */
export function stageBoundsPayload(input: StageBoundsInput): StageBoundsPayload {
  const { rect, snap } = input
  const virtuals = snap.screens.filter((screen) => screen.kind === 'virtual')
  const target = snap.selected ?? (virtuals.length === 1 ? virtuals[0]?.alias : undefined)
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight,
    visible: !input.occupied && !input.collapsed && !input.hidden && !input.overlapped
      && snap.state === 'active' && rect.width > 1 && rect.height > 1,
    viewerId: VIEWER_ID,
    ...(target === undefined ? {} : { target }),
  }
}
/**
 * 造一个「几何去重下发」通道（审计 §7.6：几何不变就不下发）。
 *
 * 缺陷形态：`publishBounds()` 每秒被轮询调一次，每次都做 rect + 两次 getComputedStyle +
 * JSON.stringify，再发一次 `vdisplayBounds` 桥调用——而几何在绝大多数拍里根本没变
 * （用户只是开着面板不动）。原生侧收到同样的 bounds 还要在主线程重放一遍 setStageBounds。
 *
 * 比较口径 = 下发的**整个载荷**（含 target / viewerId / visible）：任何一项变了都必须下发，
 * 否则会出现「换了屏但原生还按旧宽高比拉伸」「该让位却还挂着画面」这类可见偏差。
 *
 * 为什么抽出来：这条是**时序行为**（同一载荷连发两次只应到达一次），藏在组件里只能靠数桥调用，
 * 而组件还牵扯 React 渲染时机；抽出后可以直接断言「发了几次」。
 * @param send - 真正下发（桥调用）。
 * @returns publish（同一载荷只发一次）与 reset（强制下一次必发，卸载时用）。
 */
export function createBoundsPublisher(send: (payload: StageBoundsPayload) => void): {
  publish(payload: StageBoundsPayload): void
  reset(): void
} {
  let last: string | null = null
  return {
    publish(payload) {
      const key = boundsPayloadKey(payload)
      if (last === key) return
      last = key
      send(payload)
    },
    reset() { last = null },
  }
}
/**
 * 上一次下发给壳侧的舞台几何（审计 §7.6：几何不变就不下发）。
 *
 * 缺陷形态：`publishBounds()` 每秒被轮询调一次，每次都做 `getBoundingClientRect` + 两次
 * `getComputedStyle` + `JSON.stringify`，再发一次 `vdisplayBounds` 桥调用——而几何在绝大多数
 * 拍里根本没变（用户只是开着面板不动）。原生侧收到同样的 bounds 还要在主线程重放一遍
 * `setStageBounds`（可见性判据、Surface 绑定判定）。
 *
 * 比较口径 = 下发的**整个载荷**（含 target/viewerId）：任何一项变了都必须下发，
 * 否则会出现「看得见但方向不对」「已经切了屏却还按旧宽高比拉伸」这类偏差。
 */
function boundsPayloadKey(payload: StageBoundsPayload): string {
  return JSON.stringify(payload)
}

function nativeBridge(): NativeVdisplayBridge | undefined {
  return (window as Window & { androidBridge?: NativeVdisplayBridge }).androidBridge
}

function decodeNative(method: keyof NativeVdisplayBridge): VdPanelState | undefined {
  try {
    const bridge = nativeBridge()
    if (bridge === undefined) return undefined
    const candidate = bridge[method]
    if (typeof candidate !== 'function') return undefined
    // Java 桥方法必须以桥对象为接收者调用：抽出函数再裸调会抛
    // 「Java bridge method can't be invoked on a non-injected object」。
    const raw = (candidate as () => string).call(bridge)
    return typeof raw === 'string' ? mapStatusPayload(JSON.parse(raw)) : undefined
  } catch {
    return undefined
  }
}

async function pullPanelState(): Promise<VdPanelState> {
  // `vdisplayStatus` is a local, trusted-shell state read. It is the source of truth for the
  // lifecycle controls; HTTP remains a desktop/legacy fallback only.
  return decodeNative('vdisplayStatus') ?? readPanelState(browserFetch)
}

/**
 * 把「侧栏收起/展开、切标签页、面板被隐藏」变成**事件驱动**的即时可见性下发。
 *
 * 缺陷形态（用户 2026-09-17 实报）：侧栏收起后虚拟屏**还要挡一下、延迟一下**才消失。
 *
 * 真因：收起/切页签**不改变舞台几何**（上游只是把面板隐藏，组件在 DOM 里保活），
 * 所以 `ResizeObserver` 与 `window.resize` 都不触发；旧实现唯一的兜底是 1s 轮询，
 * 于是原生覆盖层的消失要等下一拍——用户感知到的就是那一下延迟。
 *
 * 这类「状态变了但没有任何几何事件」的缺口，靠**轮询兜底**永远只能做到「约一秒内正确」，
 * 要做到「即时」只能去观察状态本身变化的事件源：DOM 结构/属性变化（收起控件增删、
 * 面板 `data-sidebar-right-open` 摘除、style/class 改写）与页面可见性。
 *
 * 轮询保留（不删）：它是原生层重启后重新对齐的兜底，事件通道只是把延迟压到下一帧。
 * @param publish - 可见性下发函数（幂等，可在同一帧内安全重复调用）。
 * @returns 解绑函数。
 */
function watchStageVisibility(publish: () => void): () => void {
  // rAF 合帧：MutationObserver 在整棵子树上是高频回调，必须收敛到每帧最多一次下发。
  let queued = 0
  const schedule = () => {
    if (queued !== 0) return
    queued = window.requestAnimationFrame(() => { queued = 0; publish() })
  }
  const observer = typeof MutationObserver === 'undefined'
    ? null
    : new MutationObserver(schedule)
  try {
    observer?.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      // 只盯与可见性相关的属性，避免把每次文本重排都收进来。
      // data-dsh-popover-open（0.14.8）：三个点弹层展开/收起是 documentElement 上的属性翻转，
      // 它不改变舞台几何，却**必须**让原生 SurfaceView 让开——原生层在 WebView 之上，
      // 不藏起来的话弹层会被虚拟屏画面整块盖住（用户实报）。
      attributeFilter: ['style', 'class', 'hidden', 'data-sidebar-right-open', 'data-sidebar-right-collapsed', 'data-dsh-popover-open'],
    })
  } catch {
    /* document.body 尚未就绪：轮询兜底仍然在 */
  }
  document.addEventListener('visibilitychange', schedule)
  return () => {
    if (queued !== 0) window.cancelAnimationFrame(queued)
    queued = 0
    observer?.disconnect()
    document.removeEventListener('visibilitychange', schedule)
  }
}

/** 面板状态的同步回路依赖（注入以便按行为断言：读、提交、下发、可见性、时钟）。 */
export interface PanelSyncDeps {
  /** 读一次状态（跨桥 / HTTP 兜底）。 */
  read(): Promise<VdPanelState>
  /** 提交到 React（= setSnap）。**只有内容真的变了才调用**。 */
  commit(state: VdPanelState): void
  /** 下发/重发舞台几何（其内部再做「几何没变就不发」的去重）。 */
  bounds(): void
  /** 页面此刻是否不可见（后台）。 */
  hidden(): boolean
  /** 排/清定时器（浏览器传 window，测试传假时钟）。 */
  setTimer(fn: () => void, ms: number): number
  clearTimer(id: number): void
  /** 监听可见性变化，返回解绑函数。 */
  onVisibilityChange(fn: () => void): () => void
  /** 续租间隔；缺省 1000ms（**刻意设计，不改**，见审计 §7.6）。 */
  intervalMs?: number
}

/** 面板同步回路的句柄。 */
export interface PanelSyncHandle {
  /** 立刻对齐一拍（测试与事件通道用）。 */
  pull(): void
  /** 停止（幂等）。 */
  stop(): void
}

/**
 * 面板状态同步回路（审计 §7.6 的三条修法都落在这里）。
 *
 * 缺陷形态（0.14.9 审计实测）：
 *   1. 每拍 `setSnap(新对象)` → React 必然重渲染，哪怕内容一个字都没变；
 *   2. 每拍无条件 `publishBounds()`（rect + 两次 getComputedStyle + JSON.stringify + 桥调用），
 *      几何不变也照发；
 *   3. 面板不可见时轮询照跑。
 *
 * 修法的边界（审计原文）：**1 秒续租间隔是刻意设计，不要在间隔上动手**——
 * 这里保留 1000ms 默认值，只改「每拍多做的那几件事」与「不可见时停拍」。
 *
 * 为什么把它从组件里抽出来：这三条都是**时序行为**（几拍之后调了什么、后台停不停），
 * 只有用可注入的时钟与计数器才断言得准，而不是靠真实等待去赌机器快慢。
 * @param deps - 注入依赖。
 * @returns 句柄（pull / stop）。
 */
export function startPanelSync(deps: PanelSyncDeps): PanelSyncHandle {
  const intervalMs = deps.intervalMs ?? 1000
  let lastSnap: VdPanelState | undefined
  let timer: number | null = null
  let stopped = false
  /** 一拍：读状态 → 内容变了才提交；同时（去重地）下发几何。 */
  const pull = (): void => {
    if (stopped) return
    void deps.read().then((next) => {
      if (stopped) return
      // 浅比较后再提交：不 setState 就不会有 React 重渲染（内容没变的拍占绝大多数）。
      if (lastSnap !== undefined && samePanelState(lastSnap, next)) return
      lastSnap = next
      deps.commit(next)
    })
    deps.bounds()
  }
  const stopTimer = (): void => {
    if (timer === null) return
    deps.clearTimer(timer)
    timer = null
  }
  const startTimer = (): void => {
    if (stopped || timer !== null) return
    // 不可见时不排拍：后台定时器在移动端只换来唤醒，回前台会立即补一次。
    if (deps.hidden()) return
    timer = deps.setTimer(() => { timer = null; pull(); startTimer() }, intervalMs)
  }
  const offVisibility = deps.onVisibilityChange(() => {
    if (stopped) return
    if (deps.hidden()) { stopTimer(); return }
    // 回前台：立即对齐一拍，不等下一拍。
    pull()
    startTimer()
  })
  pull()
  startTimer()
  return {
    pull,
    stop(): void {
      if (stopped) return
      stopped = true
      stopTimer()
      offVisibility()
    },
  }
}
/**
 * Panel: 编号列表（选择查看哪块虚拟屏）+ 原生画面工位。
 * 空态「暂无虚拟屏」；占用态「由会话 X 使用中」（不渲染任何操作面）。
 */
function VdPanel(props: { sessionId?: unknown }): ReactElement {
  const sessionKey = typeof props.sessionId === 'string' ? props.sessionId : ''
  const stageRef = useRef<HTMLDivElement>(null)
  const [snap, setSnap] = useState<VdPanelState>({
  state: 'blocked', code: VD_STATUS_UNAVAILABLE,
  detail: tr('正在读取状态…', 'Reading status...'), ops: [...VD_OPS], screens: [], viewers: [],
  })
  const [tick, setTick] = useState(0)
  const occupied = snap.ownerSessionId !== undefined && sessionKey !== '' && snap.ownerSessionId !== sessionKey
  const occupiedRef = useRef(false)

  // 几何去重下发（审计 §7.6）：同一载荷只发一次，见 createBoundsPublisher 注释。
  const publisherRef = useRef<ReturnType<typeof createBoundsPublisher> | null>(null)
  if (publisherRef.current === null) {
    publisherRef.current = createBoundsPublisher((payload) => {
      try { nativeBridge()?.vdisplayBounds?.(JSON.stringify(payload)) } catch { /* host gone */ }
    })
  }

  const publishBounds = useCallback(() => {
    const stage = stageRef.current
    if (stage === null) return
    const rect = stage.getBoundingClientRect()
    try {
      // 可见性判据（0.14.0 设备实测修正，与浏览器侧同源）：**必须把「侧栏已收起」算进去**。
      //
      // 缺这一条的后果（用户报「强行遮盖上 UI」）：收起侧栏时上游只是把面板隐藏（组件仍在 DOM 里
      // 保活），舞台矩形与 display 都不变，于是旧判据仍算出 visible:true → 原生 SurfaceView 保持
      // 可见，**盖在聊天界面上**。权威收起信号 = 上游展开控件在场（ExpandButton 只在收起时渲染；
      // data-rightbar-collapsed 是恒为 true 的常量，不可用——见坑 119/120）。
      const payload = stageBoundsPayload({
        rect,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        // 三条用户实报对应的可见性判据，一条都不能丢（见 stageBoundsPayload 的注释）。
        collapsed: document.querySelector('[data-sidebar-right-expand]') !== null,
        hidden: getComputedStyle(stage).display === 'none' || getComputedStyle(stage).visibility === 'hidden',
        overlapped: document.documentElement.hasAttribute('data-dsh-popover-open'),
        occupied: occupiedRef.current,
        snap,
      })
      publisherRef.current?.publish(payload)
    } catch {
      /* old/desktop shells have no native viewer */
    }
  }, [snap.selected, snap.state, snap.screens])

  useEffect(() => {
    publishBounds()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publishBounds)
    if (stageRef.current !== null) observer?.observe(stageRef.current)
    window.addEventListener('resize', publishBounds)
    // 事件驱动的可见性下发（0.14.0 用户实报「收起后还要延迟一下才消失」的直接修复）。
    const unwatch = watchStageVisibility(publishBounds)
    return () => {
      unwatch()
      observer?.disconnect()
      window.removeEventListener('resize', publishBounds)
      // 卸载必须**强制**下发一次「不可见」：绕过上面那条「几何不变就不发」的短路
      // （原生 SurfaceView 在 WebView 之上，卸载时藏不掉就会留在屏幕上盖住 UI）。
      publisherRef.current?.reset()
      try { nativeBridge()?.vdisplayBounds?.(JSON.stringify({ visible: false, viewerId: VIEWER_ID })) } catch { /* host gone */ }
    }
  }, [publishBounds])

  useEffect(() => { publishBounds() }, [publishBounds, snap.state])

  // 占用态变化立即重发 bounds（原生层让位）。
  useEffect(() => {
    occupiedRef.current = occupied
    publishBounds()
  }, [occupied, publishBounds])

  useEffect(() => {
    // 轮询里**同时重发 bounds**（0.14.0 用户实报修正）：原先只 setSnap，状态变了但从不把
    // 新的可见性推给壳侧，于是原生 SurfaceView 的可见性要等别的事件（切页签/切面板）才更新
    // ——用户原话「在人不查看但 AI 操控的时候状态不刷新，必须切换上方状态栏才显示」。
    // 收起/展开只改可见性、不改舞台尺寸，ResizeObserver 不触发，所以必须由轮询兜底同批下发。
    //
    // 三条修法（浅比较提交 / 几何去重下发 / 不可见停拍）都在 startPanelSync 里，见其注释。
    // 1s 续租间隔是刻意设计，原样保留。
    const sync = startPanelSync({
      read: pullPanelState,
      commit: (next) => { setSnap(next) },
      bounds: publishBounds,
      hidden: () => document.hidden,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => { window.clearTimeout(id) },
      onVisibilityChange: (fn) => {
        document.addEventListener('visibilitychange', fn)
        return () => { document.removeEventListener('visibilitychange', fn) }
      },
    })
    return () => { sync.stop() }
  }, [tick, publishBounds])

  const selectTarget = (alias: string) => {
    try {
      const raw = nativeBridge()?.vdisplaySelect?.(alias)
      const next = typeof raw === 'string' ? mapStatusPayload(JSON.parse(raw)) : undefined
      if (next !== undefined) setSnap(next)
      else setTick((n) => n + 1)
    } catch {
      setTick((n) => n + 1)
    }
  }

  /**
   * 手动关机（0.14.0 用户要求）：与编号同一行，点一下销毁全部本机虚拟屏。
   *
   * 为什么必须有这个按钮：虚拟屏是**有上限的稀缺系统资源**，且现在会话间不再互相阻塞——
   * 如果只能靠 AI 工具或设置页三连点来关，用户当面看着一块不需要的屏却关不掉，体验是断的。
   * 「切换序号」与「关掉它」是同一个心理动作的两半，理应并排放。
   *
   * 语义 = 强制销毁本机全部虚拟屏（与设置页 forceDestroy 同口径）：用户按下的就是这个意思，
   * 不做二次确认（误触成本低——重建只需一次工具调用），但按钮文案明确写「关闭全部」。
   */
  const shutdownAll = () => {
    try {
      nativeBridge()?.forceDestroyVdisplay?.()
    } catch {
      /* 旧壳没有该桥：退回逐个销毁 */
      try {
        for (const screen of snap.screens.filter((s) => s.kind === 'virtual')) {
          nativeBridge()?.vdisplayDestroy?.(screen.alias)
        }
      } catch { /* 壳不可用 */ }
    }
    setTick((n) => n + 1)
  }

  const screens = snap.screens.filter((screen) => screen.kind === 'virtual')

  if (occupied) {
    return createElement('div', { className: 'dsh-vdisplay-panel', 'data-state': snap.state },
      createElement('p', { className: 'dsh-vdisplay-empty' },
        tr('由会话 ', 'In use by session ') + String(snap.ownerSessionId ?? '').slice(-6)
          + tr(' 使用中', '')))
  }

  return createElement('div', { className: 'dsh-vdisplay-panel', 'data-state': snap.state },
    screens.length === 0
      ? createElement('p', { className: 'dsh-vdisplay-empty' }, tr('暂无虚拟屏', 'No virtual screens'))
      : createElement('div', { className: 'dsh-vdisplay-list' },
        screens.map((screen) => createElement('button', {
          key: screen.alias,
          type: 'button',
          className: 'dsh-vdisplay-item' + (screen.alias === snap.selected ? ' dsh-vdisplay-item-selected' : ''),
          'data-alias': screen.alias,
          disabled: !screen.selectable || screen.alias === snap.selected,
          onClick: () => selectTarget(screen.alias),
        }, String(screen.alias.replace('virtual-', '')))),
        // 手动关机：与编号同一行（用户要求）。destructive 样式以区别于「切换」。
        createElement('button', {
          key: '__shutdown__',
          type: 'button',
          className: 'dsh-vdisplay-item dsh-vdisplay-shutdown',
          'aria-label': tr('关闭全部虚拟屏', 'Close all virtual screens'),
          title: tr('关闭全部虚拟屏（释放系统资源）', 'Close all virtual screens (frees system resources)'),
          'data-action': 'shutdown-all',
          onClick: shutdownAll,
        }, tr('关闭全部', 'Close all'))),
    createElement('div', { ref: stageRef, className: 'dsh-vdisplay-stage', 'data-testid': 'vdisplay-stage' }),
  )
}

/** chip 标题：与「工作区文件」同类。 */
function VdTitle(): ReactElement {
  return createElement('span', { className: 'dsh-vdisplay-title' }, tr('虚拟屏', 'Virtual screen'))
}

/**
 * 注册 tab 类型 + body + title。三处 contribution 全部经 ctx.effect（注册即 effect，
 * 随 fiber 释放回收）。sidebarRightTabs 缺席时只告警不抛错（fail-closed，不阻断客户端启动）。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin', 'dsh-android-vdisplay')
    style.textContent = VD_STYLE
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dsh-android-vdisplay: styles')

  ctx.effect(() => {
    const sidebar = ctx.get('sidebarRight') as SidebarRightController | undefined
    if (sidebar === undefined) return () => {}
    // 只在一次「激活」周期内揭示一次：openTab 抛错（会话尚未挂载）时不得吞掉重试机会——
    // 只有舞台真的挂上（[data-testid=vdisplay-stage] 在场）才置 revealed；显示被销毁后复位。
    //
    // 0.14.0 设备实锤（MuMu，verify-vdisplay-viewer 步骤 C）：`openTab(..., {revealIfOpened:true})`
    // 的 revealIfOpened 语义是「右侧栏**已展开**时才切换过去」——侧栏关着时该调用是静默 no-op，
    // 于是建屏后舞台永不挂载（前一轮「自动露出失效」的真因）。修法 = 先确保右侧栏展开：
    // 页内原生开关（会话头部 corner 按钮）在闭态下点一次，下一拍 openTab 再切到本 Tab。
    // 与「AI 浏览器自动落位」互斥（0.14.0 P0-2 用户语义）：两侧共用 localStorage 里的
    // 最近声索记录（id + 时间戳），**最近一次模型驱动的能力动作赢**。浏览器的机制见
    // dsh-client-ui-responsive 的 'ui-responsive: AI browser auto-place'。
    // 同浏览器侧：**边沿触发 + 收起时延迟落位**，不是每秒无条件抢焦点。
    // 旧实现每 800ms 无条件 openTab，用户收起侧栏后会被下一拍拽开、点 × 收起也会被切回来
    // （设备实测：浏览器侧与虚拟屏侧是同一个结构缺陷，两侧一起改）。
    /** 上一次已处理过的舞台标记（'' = 还没出现过）。 */
    let seenActive = false
    /** 收起期间出现过、等待用户展开后补落位。 */
    let pending = false
    /** 最近一次读到的活跃态（决定节拍用短还是用长；不活跃时退回空闲节拍）。 */
    let lastActive = false
    /** 已排的下一拍（null = 没有排队）。 */
    let timer: number | null = null
    /** 卸载标记：定时器与事件回调都要认它（否则卸载后还会读一次桥）。 */
    let disposed = false
    /**
     * 短节拍：有活跃屏 / 待落位时才用。**800ms 是刻意设计**（审计 §7.5 明确要求不要动这个间隔）：
     * 原生层重启、事件通道漏网时的重新对齐靠它。
     */
    const ACTIVE_POLL_MS = 800
    /**
     * 空闲节拍（审计 §7.5）：**既非 active 也无 pending** 时退到 5 秒以上。
     *
     * 缺陷形态：旧实现 `setInterval(reveal, 800)` 无条件常驻，而 reveal() 第一句就是
     * 跨桥读 `vdisplayStatus` 并 decodeNative（内含一次 JSON.parse）。虚拟屏在绝大多数时间里
     * 根本不存在，用户锁屏放着一夜也照样每 800ms 读一次——纯粹的唤醒与解析开销。
     */
    const IDLE_POLL_MS = 5_000
    // 同浏览器侧：权威收起信号 = 上游展开控件是否在场（`data-rightbar-collapsed` 是常量，不可用）。
    const collapsedNow = (): boolean => document.querySelector('[data-sidebar-right-expand]') !== null
    /** 舞台是否已挂载（挂上了就说明落位成功，不必再抢焦点）。 */
    const stageMounted = (): boolean => document.querySelector('[data-testid=vdisplay-stage]') !== null
    /**
     * 读一次状态并做一次**边沿**判定（不是每拍无条件 openTab）。
     *
     * 边沿语义（0.14.0 设备实锤，不得退回旧行为）：只在「由不活跃变为活跃」那一次落位；
     * 收起期间攒成 pending，等用户展开后再补——用户自己收起侧栏后不该被下一拍拽开。
     */
    const reveal = (): void => {
      const active = decodeNative('vdisplayStatus')?.state === 'active'
      lastActive = active
      if (!active) { seenActive = false; return }
      if (stageMounted()) return
      try {
        if (seenActive) {
          // 无新事件：仅当「收起期间攒下待落位」且用户已展开时，补一次。
          if (pending && !collapsedNow()) {
            pending = false
            unwatchExpanded()
            sidebar.openTab(VD_TAB_KIND, { revealIfOpened: true })
          }
          return
        }
        seenActive = true
        if (collapsedNow()) {
          pending = true
          watchExpanded()
          return
        }
        sidebar.openTab(VD_TAB_KIND, { revealIfOpened: true })
      } catch {
        /* 侧栏未挂载：下一拍重试（seenActive 未置位，保持可重试） */
        seenActive = false
      }
    }
    /** 清掉已排的那一拍（幂等）。 */
    const clearTimer = (): void => {
      if (timer === null) return
      window.clearTimeout(timer)
      timer = null
    }
    /** 下一拍间隔：活跃或待落位用短节拍，其余退到空闲节拍。 */
    // 判据按审计原文：**既非 active 也无 pending** 才退到空闲节拍。屏还在（active）时保持原节拍——
 // 需求是「没屏的时候别常驻读」，不是「有屏的时候慢一拍」。
    const nextDelay = (): number => (lastActive || pending ? ACTIVE_POLL_MS : IDLE_POLL_MS)
    /**
     * 排下一拍。**页面在后台时不排**（审计 §7.5）：后台定时器在移动端只换来唤醒，
     * 回前台由 visibilitychange 立即补一次对齐。
     */
    function scheduleNext(): void {
      clearTimer()
      if (disposed || document.hidden) return
      timer = window.setTimeout(tick, nextDelay())
    }
    /** 一拍：读状态 → 按新的活跃/待落位状态决定下一拍间隔。 */
    function tick(): void {
      timer = null
      if (disposed || document.hidden) return
      reveal()
      scheduleNext()
    }
    /** 事件驱动入口：立即对齐一拍，并按最新状态重排节拍。 */
    const alignNow = (): void => {
      if (disposed) return
      reveal()
      scheduleNext()
    }
    // 事件通道（审计 §7.5：事件驱动优先，轮询只作兜底）：
    // ① 回前台立即读一次——后台期间我们根本不排拍，回来必须马上对齐；
    // ② 用户展开右侧栏时，把「收起期间攒下的待落位」立即补上，不等下一拍（旧实现最多晚 800ms）。
    const onVisibility = (): void => { if (!document.hidden) alignNow() }
    document.addEventListener('visibilitychange', onVisibility)
    // 展开监听**只在「收起且有待落位」这一小段窗口内挂**（审计 §7.3 的教训：常驻全文档观察器
    // 是另一笔账）。窗口之外它一次都不跑，因此这里不构成新的常驻观察成本。
    const expandWatch = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => {
        // 只认一条边沿：待落位 + 已展开。其余结构变更不值得为它去跨桥读一次状态。
        if (disposed || !pending || collapsedNow()) return
        alignNow()
      })
    let expandWatching = false
    const watchExpanded = (): void => {
      if (expandWatch === null || expandWatching) return
      try {
        // 权威收起信号是展开控件的**在场与否**：用户展开时 React 会把它从子列表里摘掉。
        expandWatch.observe(document.body, { childList: true, subtree: true })
        expandWatching = true
      } catch { /* body 未就绪：轮询仍可兜底 */ }
    }
    const unwatchExpanded = (): void => {
      if (expandWatch === null || !expandWatching) return
      expandWatch.disconnect()
      expandWatching = false
    }
    reveal()
    scheduleNext()
    return () => {
      disposed = true
      clearTimer()
      unwatchExpanded()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, 'dsh-android-vdisplay: automatically reveal active viewer')

  ctx.effect(() => {
    const tabs = ctx.get('sidebarRightTabs') as TabRegistry | undefined
    if (!tabs) {
      ctx.logger?.('dsh-android-vdisplay')?.warn?.('sidebarRightTabs 服务缺席——虚拟屏 Tab 未注册（fail-closed）')
      return () => {}
    }
    return tabs.register({
      id: VD_TAB_ID,
      kind: VD_TAB_KIND,
      priority: 'extension',
    title: () => tr('虚拟屏', 'Virtual screen'),
      guide: [{
        // 0.1.7 起 guide 条目必填 id（上游按 [providerId, entry.id] 键控，唯一性只在 provider 内判定）
        id: 'open',
        order: 40,
    title: () => tr('虚拟屏', 'Virtual screen'),
    description: () => tr('在独立屏幕上运行第三方 App（Shizuku 特权通道），不挤占用户前台。',
      'Run third-party apps on a separate display through Shizuku without taking over the foreground.'),
      }],
    })
  }, 'dsh-android-vdisplay: tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: VD_TAB_ID, inject: () => ({}) },
    VdPanel,
  )), 'dsh-android-vdisplay: tab body')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: VD_TAB_ID, inject: () => ({}) },
    VdTitle,
  )), 'dsh-android-vdisplay: tab title')

  // 侧边栏终端的屏上九键条（0.14.2 T4）。
  //
  // 落点：不是 slot —— 上游 pane.tab 是 keyed「一个 key 一个组件」，没有 pane 底部槽，
  // 同 key 再注册会顶掉终端 body。因此对 [data-sidebar-terminal] 做**受管 DOM 注入**，
  // 把键条作为该根最后一个 flex:none 子项（终端 .screen 是 flex:1; min-height:0），
  // 从而让「终端底边 <= 键条顶边」成为布局不变量而非调数值的结果。
  //
  // 通路：优先合成 keydown 到 .xterm-helper-textarea，让 xterm 自己按当前 DECCKM 决定 CSI/SS3
  // （阶段 0 [A] 实测：合成 keydown 与真键产出字节一致）。兜底才直写，且按 acck 动态选序列。
  // 语义（键->序列、Ctrl 闩锁）全部来自 ../keybar/keymap.ts 的纯函数，UI 层不做任何键位判断。
  ctx.effect(() => {
    let watch: { dispose(): void } | undefined
    try {
      watch = watchTerminalKeybars({
        bridge: (window as Window & { androidBridge?: { showSoftInput?: () => boolean } }).androidBridge,
      })
    } catch (error) {
      // 注入失败必须可见（不得让用户以为键条只是「没做」）。
      ctx.logger?.('dsh-android-vdisplay')?.warn?.(
        '终端九键条注入失败：' + ((error as Error)?.message ?? String(error)),
      )
    }
    return () => { watch?.dispose() }
  }, 'dsh-android-vdisplay: terminal keybar')
}