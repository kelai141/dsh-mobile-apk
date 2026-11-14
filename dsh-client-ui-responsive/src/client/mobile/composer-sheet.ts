import { zh, en, type ComposerSheetKey } from './composer-sheet.locales.ts'
import {
  ADD_BUTTON_SELECTOR,
  CARD_SELECTOR,
  ATTACHMENT_ROW_TITLES,
  readMenuOptionSubtitle,
  withUpstreamMenu,
  isComposerMenuReplay,
} from './composer-commands.ts'

/**
 * 输入行「+」的底部 sheet（替换上游那个小弹层）。
 *
 * ## 为什么拦截「+」
 * 上游 InputBar.tsx:420-433 的「+」是一个普通 button（aria-label 取自 t('input.commands')，
 * aria-haspopup="listbox"，onClick=onToggleCommandMenu），它开的是 ui-input-trigger 的
 * MenuView 小弹层。手机竖屏下那个弹层贴着输入行、只有半屏，且不提供拍照入口。
 * 本模块把点击换成底部 sheet：上面三块瓦片（拍照 / 照片 / 本地文件），下面**自动映射**
 * 上游「+」菜单里的全部项。
 *
 * ## 自动映射（不加白名单）
 * 打开时先让上游菜单自己开（不 preventDefault，完全保留上游行为），再读
 * [data-composer-card] [role=menu] 里的 [role=option]，逐项复制成「图标 + 标题 + 副标题」
 * 的行；点击转发回原 item。第三方插件往「+」里加的东西因此自动出现，本模块不认识任何具体项。
 *
 * 转发必须用 **mousedown** 而不是 click：上游 MenuView.tsx:161-177 的每个 option 只在
 * onMouseDown 上挂 onPick（防止焦点从编辑器被抢走），合成 click 不会触发它。
 *
 * ## 键盘行为（用户明确要求，别改回去）
 * 打开：先 blur 当前焦点、再抑制键盘，sheet 全程不唤起键盘。
 * 关闭：**不自动聚焦、不自动唤起键盘**。收起后焦点落在 body 上是期望结果 ——
 * 用户下一步要么点输入框（自己唤起键盘），要么点别处。任何「顺手把焦点还给输入框」的
 * 优化都会在关闭瞬间弹出键盘，与需求相反。inputmode=none 的临时覆盖同样不得省略：
 * 没有它，某些 WebView 会在 sheet 内任何可聚焦元素被点时再次弹键盘。
 */

/**
 * 上游隐藏的 multiple file input：**照片 / 本地文件**两块瓦片走它。
 *
 * 拍照**不**走它（issue #1288 第 4 条）：WebView 里 `capture` 属性不被实现，
 * 叠上去只会静默拉起图库 —— 这正是「点拍照却看到相册」的成因。拍照走壳侧原生相机。
 * 注：上游「+」菜单的选择器/读取层已抽到 composer-commands.ts（与宿主 API 共用）。
 */
const FILE_INPUT_SELECTOR = 'input[type="file"][multiple]'

const BACKDROP_ATTR = 'data-dsh-composer-sheet-backdrop'
const PANEL_ATTR = 'data-dsh-composer-sheet-panel'
const TILES_ATTR = 'data-dsh-composer-sheet-tiles'
const TILE_ATTR = 'data-dsh-composer-sheet-tile'
const ROWS_ATTR = 'data-dsh-composer-sheet-rows'
/** 关闭按钮（×）。三条关闭路径之一，必须与点外部 / 系统返回走同一个离场动画。 */
const CLOSE_ATTR = 'data-dsh-composer-sheet-close'
const ROW_ATTR = 'data-dsh-composer-sheet-row'
/**
 * 回执位（role=status）。原生拍照的结果是**异步一次性事件**，没有这处就只剩「点了没反应」。
 */
const STATUS_ATTR = 'data-dsh-composer-sheet-status'
/**
 * 收场动画标记：挂在 backdrop 上，CSS 据此播放「飞回视口底」的退场动画。
 *
 * 为什么要一个属性而不是直接 remove：remove() 是瞬时的，用户看不到卡片飞回去，
 * 观感上像「闪一下消失」。加了标记之后由 CSS 播 160ms，脚本等动画结束再 remove。
 * 真机 WebView 有 WAAPI（Element.getAnimations），jsdom 没有 —— 没有动画就不等，
 * 立刻 remove，测试与无动画环境的行为保持一致。
 */
const LEAVING_ATTR = 'data-dsh-composer-sheet-leaving'
/** 退场动画时长（规格 140-160ms）。与 CSS 里 dsh-composer-card-out/panel-out 同值。 */
const EXIT_ANIMATION_MS = 160
/** 竖屏标记（form-marker.ts 维护）。竖屏 sheet 的所有规则与手势都以它为前提。 */
const MOBILE_FORM_ATTR = 'data-dsh-mobile-form'
/** 形态：竖屏底部 sheet / 横屏居中卡片。横屏永远 card，新规则一条都不命中。 */
const FORM_ATTR = 'data-dsh-composer-sheet-form'
const FORM_SHEET = 'sheet'
const FORM_CARD = 'card'
/** 拖拽把手（只有竖屏有；横屏卡片靠 × 关闭）。 */
const HANDLE_ATTR = 'data-dsh-composer-sheet-handle'
/** peek / expanded 两段状态，写在面板上供 CSS 与断言读取。 */
const PHASE_ATTR = 'data-dsh-composer-sheet-phase'
/** 拖拽中标记：CSS 据此关掉过渡（跟手必须 1:1，不能被缓动吃掉）。 */
const DRAGGING_ATTR = 'data-dsh-composer-sheet-dragging'
/** 吸附中标记：CSS 据此打开 height/transform 过渡。 */
const SETTLING_ATTR = 'data-dsh-composer-sheet-settling'
/** 脚本算出来的两个高度，挂在面板上供设备验收逐条取值。 */
const PEEK_ATTR = 'data-dsh-composer-sheet-peek'
const MAX_ATTR = 'data-dsh-composer-sheet-max'
/** 手感档：写在 <html> 上（A 为契约档，B 为可选手感档）。 */
const FEEL_ATTR = 'data-dsh-composer-sheet-feel'

/** 方向锁：起手这么多像素内不判定归属（避免「想滚列表却把卡片拉高」）。 */
const DRAG_LOCK_PX = 8
/** peek 露出的行数（2.5 行：两行整 + 半行提示还有内容）。 */
const PEEK_ROWS = 3.5
/** 展开上限占视口比例。 */
const MAX_HEIGHT_RATIO = 0.88
/** 关闭阈值：超过卡片高度的这个比例才算「拉下去要关」。 */
const CLOSE_RATIO = 0.3
/** 读不到真实行高时的兜底（与 CSS min-height 同值）。 */
const ROW_FALLBACK_HEIGHT = 46
/** 松手速度判据（px/ms）：向下超这个速度直接关，向上超这个速度直接展开。 */
const SNAP_VELOCITY_CLOSE = 0.6
const SNAP_VELOCITY_EXPAND = 0.3
/**
 * 抬手前停顿多久就抹掉速度（ms）。
 *
 * 速度只在 touchmove 上更新：手指停住不动时，drag.velocity 会一直停在最后一次位移上。
 * 拿着「几百毫秒前的速度」判 fling，会把「慢慢拉、停一下再松手」判成快速甩动 —— 实测：
 * 最后一次 move 到抬手 600/1200ms 时本该回 peek，却被速度分支弹成 expanded。
 */
const VELOCITY_IDLE_MS = 120

/**
 * 手感档：只改阻尼与吸附曲线，不改语义（阈值、方向锁、关闭比例都在上面）。
 *
 * A 是**契约档**：拖拽严格 1:1（阻尼 1），吸附 200ms 快出慢收 —— 验收判据都按 A 取数。
 * B 是可选手感档：阻尼 0.85/0.9（同样的手势位移抬得更少），吸附 280ms 更柔。
 * 两档的同一手势位移序列由设备脚本分别采集，供人工挑。
 */
interface SheetFeel {
  readonly id: string
  readonly upDamping: number
  readonly downDamping: number
  readonly snapMs: number
  readonly snapTiming: string
}
const FEELS: Readonly<Record<string, SheetFeel>> = {
  A: { id: 'A', upDamping: 1, downDamping: 1, snapMs: 200, snapTiming: 'cubic-bezier(0.215, 0.61, 0.355, 1)' },
  B: { id: 'B', upDamping: 0.85, downDamping: 0.9, snapMs: 280, snapTiming: 'cubic-bezier(0.22, 1, 0.36, 1)' },
}

/** 一次拖拽的临时状态（不跨手势保留）。 */
interface SheetDrag {
  startX: number
  startY: number
  /** 上一次已经算进几何的 clientY（增量算法的基准）。 */
  appliedY: number
  lastY: number
  lastTime: number
  velocity: number
  startHeight: number
  height: number
  /** 已经回收到 peek 之后继续下拉的距离（translateY）。 */
  overscroll: number
  owner: 'none' | 'sheet' | 'list'
  /** 高度已到上限、手势交回列表（此后上滑滚列表）。 */
  handedBack: boolean
}

type TileKind = 'camera' | 'photo' | 'file'

/**
 * 壳侧原生拍照桥（issue #1288 第 4 条）。
 *
 * **对象名是小写 a 的 `androidBridge`**（MainActivity.addJavascriptInterface 注入的那个），
 * 不是 `AndroidBridge`（Kotlin 类名，页面上不存在）。`capturePhoto(action)` 是
 * `AndroidBridge.capturePhoto` 的 @JavascriptInterface 入口，动作名是闭集（目前只有 capture）。
 *
 * 类型按方法名现读而不是走 AndroidShellBridge 成员，与 file-card 的 bridgeFace 同款：
 * 桥由壳侧在页面脚本之后注入，装配期捕获快照会拿到 undefined。
 */
function photoBridge(): ((action: string) => unknown) | null {
  const bridge = (window as unknown as { androidBridge?: Record<string, unknown> }).androidBridge
  const method = bridge?.['capturePhoto']
  if (typeof method !== 'function') return null
  return (action: string) => (method as (this: unknown, action: string) => unknown).call(bridge, action)
}

/** 壳侧回执的回调名（PhotoCaptureController.pushToPage 写死的那个）。 */
const PHOTO_RECEIPT = 'onPhotoCaptured' as const

/**
 * 注入层 `window.__dshBridge` 的宿主对象（**只读地**取，绝不创建）。
 *
 * 见 installPhotoReceipt 的注释：那个对象由 host-web-compat 的 PICKER_SCRIPT 整体赋值，
 * 我们先造一个空壳会让它的幂等守卫整段跳过。
 */
function pickerBridgeHost(): Record<string, unknown> | null {
  const host = (window as unknown as { __dshBridge?: Record<string, unknown> }).__dshBridge
  return host !== undefined && host !== null && typeof host === 'object' ? host : null
}

/** 桥返回/回执的 JSON 字符串（@JavascriptInterface 只能同步回字符串）解析成对象。 */
function parseBridgeReply(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.trim() === '') {
    // 回执走 evaluateJavascript 传参，理想是字符串；对象直接给了也认。
    if (raw !== null && typeof raw === 'object') return raw as Record<string, unknown>
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** 从解析后的载荷里取一个字符串字段（缺席/非字符串一律空串，不猜）。 */
function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value : ''
}

/** 壳侧错误码 → 本模块文案 key。码值见 PhotoCapture.CODE_*，未知码不猜原因。 */
function messageKeyForCode(code: string): ComposerSheetKey {
  switch (code) {
    case 'cancelled': return 'photoCancelled'
    case 'permission-denied': return 'photoPermissionDenied'
    case 'camera-unavailable': return 'photoUnavailable'
    case 'camera-busy': return 'photoBusy'
    case 'camera-failed': return 'photoFailed'
    case 'compress-failed': return 'photoCompressFailed'
    case 'busy': return 'photoInFlight'
    case 'not-wired': return 'photoNotWired'
    default: return 'photoUnknown'
  }
}

/** 一条从上游菜单复制出来的行（index 是它在上游菜单里的位置，转发时按位取回）。 */
interface MappedRow {
  readonly title: string
  readonly subtitle: string
  readonly icon: Element | null
  readonly index: number
}

/** 本地字典兜底：插件在 locale 服务就绪前也能出正确文案。 */
function copyFor(): (key: ComposerSheetKey) => string {
  const language = (document.documentElement.lang || navigator.language || '').toLowerCase()
  const dict = language.startsWith('zh') ? zh : en
  return (key) => dict[key]
}

/** 由插件主体注入的翻译函数（locale 命名空间 androidComposerSheet）。 */
export type ComposerSheetTranslate = (key: ComposerSheetKey) => string

/** 瓦片图标：24x24 viewBox，由 CSS 缩放到 28px。 */
function tileIcon(kind: TileKind): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const d = kind === 'camera'
    ? 'M3 8.5h3l1.5-2h9L18 8.5h3v11H3zM12 16.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6'
    : kind === 'photo'
      ? 'M3 5h18v14H3zM3 16l5-5 4 4 2.5-2.5L21 19M8 9.5h.01'
      : 'M4 3.5h7l4 4v13H4zM11 3.5v4h4M7.5 13h6M7.5 16.5h6'
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', d)
  svg.append(path)
  return svg
}



/**
 * 拦截「+」并管理底部 sheet。
 * attach 挂事件与观察器，detach 完全卸掉（HMR 安全：不留 document 监听）。
 */
export class ComposerSheet {
  /** 由外界注入的翻译函数；缺省用本地字典。 */
  private translate: ComposerSheetTranslate | null

  constructor(translate: ComposerSheetTranslate | null = null) {
    this.translate = translate
  }

  /** locale/change 后由插件主体换掉绑定的 t。 */
  setTranslate(translate: ComposerSheetTranslate | null): void {
    this.translate = translate
  }

  private text(): ComposerSheetTranslate {
    return this.translate ?? copyFor()
  }

  private backdrop: HTMLElement | null = null
  /** 面板里的回执位（每次 open 重建，close 时置空）。 */
  private status: HTMLElement | null = null
  private addButton: HTMLElement | null = null
  private observer: MutationObserver | null = null
  private attached = false
  private patchScheduled = false
  /** 打开前「+」的 aria-expanded 原值（关闭时按原样还回去）。 */
  private previousExpanded: string | null = null
  /** 被我们改过 inputmode 的元素 → 原值。 */
  private readonly inputModeSnapshot = new Map<HTMLElement, string | null>()
  /**
   * 我们自己派发上游「+」点击时的重入闸。
   *
   * readUpstreamRows 必须让上游把菜单开出来，而开菜单的唯一办法就是派发一次「+」的 click；
   * 那个 click 会再次经过本类的捕获监听。没有这道闸，onClickCapture -> open -> readUpstreamRows
   * -> 派发 click -> onClickCapture ... 会无限递归（实测 RangeError: Maximum call stack size exceeded）。
   */
  private replaying = false

  /**
   * 打开代次：每次 open() 自增，close() 也自增。
   *
   * open() 里读上游菜单的收尾是异步的，用户完全可能在它跑完之前就关掉 sheet
   * （下滑 / 点遮罩 / 返回键）。收尾一旦无条件执行，就会把**用户此刻**的焦点
   * blur 掉，正在用的键盘被凭空收回（#999）。收尾前比对代次即可识别这种过期回调。
   */
  private generation = 0
  /**
   * 被折叠的滚动容器（通常是 body）→ 打开前的 overflow 原值。
   *
   * 只存快照、关闭时按原样还原：无条件写 style.removeProperty 会把别处
   * （或用户自己）设的 overflow 一起抹掉（#1009）。
   */
  private readonly overflowSnapshot = new Map<HTMLElement, string>()

  /**
   * 正在「借用」上游菜单（开一次 → 读项 → 用 Escape 关掉）。
   *
   * 借用期间我们自己派发的 Escape 会同样到达本类的 onKeyDown：不设这道闸，
   * 关上游菜单的那一下会顺手把整张 sheet 关掉（实测：容器已挂、行写不进去，
   * 因为面板刚好在这一步自我关闭）。
   */
  private borrowing = false

  /** 当前拖拽（竖屏才可能非空）。 */
  private drag: SheetDrag | null = null
  /** 吸附计时器：到点摘掉 settling 标记，避免过渡一直挂着。 */
  private settleTimer: number | undefined
  /** 竖屏 sheet 上挂过监听的面板（卸载时按它逐条摘掉）。 */
  private sheetPanel: HTMLElement | null = null
  /**
   * 行高缓存（px）。
   *
   * 吸附/展开动画期间容器高度在动，行高会量到 46.4 / 46.8 这种亚像素值，
   * 直接用它算 peek 会让 peek 每次吸附后都不一样（实测 249 → 252 → 350）。
   * 所以只在**量到真实行**时写一次，此后复用。
   */
  private rowHeightPx: number | null = null

  /**
   * **一次拖拽内**的 peek / max 缓存（per-drag，绝不跨拖）。
   *
   * 为什么需要：peekHeight() 内含 4 次 getComputedStyle + 3 次 getBoundingClientRect，
   * maxHeight() 内部又调一次 peekHeight()。拖拽时每个 touchmove 都要这两个值，而它们在
   * 一次拖拽内**恒定**（内容没变、视口没变、行高已缓存在 rowHeightPx）。120Hz 下一帧
   * 可能有两个 touchmove，原本要付 32 次强制同步布局 —— 而 Blink 每次读几何前都得先
   * flush 掉上一句 panel.style.height 的写，每一次都是真 layout。
   *
   * 生命周期：onSheetTouchStart 建立 → 整个拖拽复用 → onSheetTouchEnd/取消时丢弃。
   * **不跨拖**是刻意选择：跨拖缓存会把「用户拖到一半时行到齐 / 键盘弹起」的旧值带进下一次，
   * 而这两个场景正是 peek 会变的场合。拖拽期间真正会变的那两条（视口变化、行到齐）
   * 由 onSheetViewport / relayoutSheet 显式失效。
   */
  private dragGeometry: { peek: number; max: number } | null = null

  /** 丢弃 per-drag 几何缓存（任何可能让 peek/max 变的事实都要调它）。 */
  private invalidateDragGeometry(): void {
    this.dragGeometry = null
  }

  /**
   * 取本次拖拽的 peek/max：有缓存就用，没有就现算并缓存。
   *
   * 只在拖拽路径上用（onSheetTouchMove / settleTo）。非拖拽路径（relayoutSheet、
   * writeHeights、publishGeometry）一律走实时计算 —— 那些是低频路径，缓存只会引入
   * 失效面而没有收益。
   */
  private dragPeekMax(): { peek: number; max: number } {
    const cached = this.dragGeometry
    if (cached !== null) return cached
    const fresh = { peek: this.peekHeight(), max: this.maxHeight() }
    this.dragGeometry = fresh
    return fresh
  }

  /**
   * 捕获阶段拦「+」。
   *
   * 用捕获 + stopImmediatePropagation 而不是只 preventDefault：上游 onClick 会调
   * focusDraftEditor(editor) —— 那正是唤起键盘的那一步，必须整个拦掉。
   */
  private readonly onClickCapture = (event: Event): void => {
    // 我们自己合成的「+」点击：放过去，交还上游自己的 onClick。
    if (this.replaying || isComposerMenuReplay(event)) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (this.backdrop !== null && this.backdrop.contains(target)) return
    const button = target.closest<HTMLElement>(ADD_BUTTON_SELECTOR)
    if (button === null) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    if (button.hasAttribute('disabled')) return
    this.open(button)
  }

  private readonly onBackdropPointerDown = (event: Event): void => {
    if (this.backdrop === null) return
    const target = event.target
    if (!(target instanceof Node)) return
    const panel = this.panel()
    if (panel !== null && panel.contains(target)) return
    this.close()
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // 借用上游菜单时派发的 Escape 只用来关上游菜单，不能连锁关掉 sheet（见 borrowing）。
    if (this.borrowing) return
    if (event.key !== 'Escape' || this.backdrop === null) return
    event.preventDefault()
    event.stopPropagation()
    this.close()
  }

  private readonly onPopState = (): void => {
    if (this.backdrop !== null) this.close()
  }

  attach(): void {
    if (this.attached) return
    this.attached = true
    try {
      // 捕获阶段：必须早于上游 React 的 onClick。
      document.addEventListener('click', this.onClickCapture, true)
      document.addEventListener('pointerdown', this.onBackdropPointerDown, true)
      document.addEventListener('keydown', this.onKeyDown, true)
      window.addEventListener('popstate', this.onPopState)
      // 「+」会随合成器重挂载（会话切换 / hero 与 dock 互切）：只盯「出现了一个带 listbox 的按钮」，
      // 不做无条件全文档查询（与 top-bar-fold 同一克制）。
      this.observer = new MutationObserver((records) => { this.onMutations(records) })
      this.observer.observe(document.documentElement, { childList: true, subtree: true })
      this.patch()
    } catch (error) {
      // 手机运行时守卫：一个便利入口的装配失败绝不能中断插件主体。
      console.warn('[dsh-composer-sheet] attach failed; upstream + keeps its own menu', error)
    }
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    document.removeEventListener('click', this.onClickCapture, true)
    document.removeEventListener('pointerdown', this.onBackdropPointerDown, true)
    document.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('popstate', this.onPopState)
    this.observer?.disconnect()
    this.observer = null
    this.patchScheduled = false
    this.close()
    this.restoreInputMode()
    this.addButton = null
  }

  private onMutations(records: MutationRecord[]): void {
    if (this.addButton !== null && this.addButton.isConnected) return
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        if (node.matches(ADD_BUTTON_SELECTOR) || node.querySelector(ADD_BUTTON_SELECTOR) !== null) {
          this.schedulePatch()
          return
        }
      }
    }
  }

  private schedulePatch(): void {
    if (this.patchScheduled) return
    this.patchScheduled = true
    queueMicrotask(() => {
      this.patchScheduled = false
      if (this.attached) this.patch()
    })
  }

  /** 记住当前「+」的引用（只用于观察器判活，不接管它自己的 listener）。 */
  private patch(): void {
    this.addButton = document.querySelector<HTMLElement>(ADD_BUTTON_SELECTOR)
  }

  private panel(): HTMLElement | null {
    return this.backdrop?.querySelector<HTMLElement>('[' + PANEL_ATTR + ']') ?? null
  }

  private open(button: HTMLElement): void {
    this.close()
    const t = this.text()
    // 顺序有讲究：**先读上游菜单，再 blur**。
    // 上游 MenuView 只在编辑器持有焦点时才肯开（它把自己绑在 draft editor 的 caret 上），
    // 先 blur 会让 readUpstreamRows 读到 0 项，sheet 就只剩三块瓦片（实机复现过：
    // 面板文案只有「拍照照片本地文件」）。读完之后再压焦点，键盘照样不会弹。
    // 行容器先建好但**不读菜单**：读菜单必须等 backdrop 挂上之后再做，
    // 否则 fillRows 会在挂载前完成、被自己的「仍在面板里」守卫丢掉（实测 mapped=3 却写不进去）。
    const rows = this.buildRows()
    const active = document.activeElement
    // 键盘抑制：**先只改 inputmode，不要 blur**（issue #929）。
    // 上游 MenuView 把自己绑在 draft editor 的 caret 上，编辑器不持焦点它就不肯开；
    // 先 blur 会让 readUpstreamRows 读到 0 项 —— 这是「映射行永远 0」的真因，
    // 而且 jsdom 里的假菜单不要求焦点，所以 spec 抓不到（#892 因此带着「未验」合了）。
    this.suppressInputMode()
    this.previousExpanded = button.getAttribute('aria-expanded')

    // 形态在打开时判定一次：竖屏（html[data-dsh-mobile-form]）走底部 sheet，横屏走原来的
    // 居中卡片。横屏那条分支的 DOM 与几何一个像素都不改。
    const sheetForm = this.sheetFormRequested()
    const backdrop = document.createElement('div')
    backdrop.setAttribute(BACKDROP_ATTR, '')
    backdrop.setAttribute(FORM_ATTR, sheetForm ? FORM_SHEET : FORM_CARD)
    backdrop.setAttribute('role', 'presentation')

    const panel = document.createElement('div')
    panel.setAttribute(PANEL_ATTR, '')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-label', t('sheetLabel'))

    // 竖屏：顶部一条拖拽把手，且**没有关闭 ×**（三条离场路径都不需要它）。
    // 横屏：居中卡片保持原样 —— 有 ×、没有把手、不写任何内联高度。
    if (sheetForm) panel.append(this.buildHandle())
    panel.append(this.buildTiles(t))
    panel.append(rows)
    panel.append(this.buildStatus())
    if (!sheetForm) panel.append(this.buildClose(t))

    backdrop.append(panel)
    document.body.append(backdrop)
    this.backdrop = backdrop
    button.setAttribute('aria-expanded', 'true')
    // 竖屏：peek 高度按内容现算（瓦片 + 2.5 行 + 安全区），并挂手势/视口监听。
    // 横屏：几何仍然全部交给 CSS（居中卡片），不写内联定位。
    if (sheetForm) this.activateSheet(panel)
    this.lockBodyScroll()
    // 到这里 backdrop 已经挂到 body 上（this.backdrop 也已赋值），读菜单拿到的
    // 行才有地方写。顺序不能提前：见 fillRows 的注释。
    // issue #929：等映射读完**再**压焦点。旧实现用 `void` 丢掉了 Promise，
    // 紧接着的 blurActiveEditor() 会在读菜单**之前**跑 —— 等于又白读一次。
    const generation = this.generation
    void this.fillRows(rows).finally(() => {
      // issue #999：收尾只在「这次打开的 sheet 还开着」时做 —— 代次没变，且这块
      // backdrop 仍是当前那块、还挂在文档里。用户已经关掉的话，这里的 blur 会打断
      // 他此刻的输入（键盘自己缩回）。
      if (this.generation !== generation) return
      if (this.backdrop !== backdrop || !backdrop.isConnected) return
      if (active instanceof HTMLElement) active.blur()
      // 映射过程会开一次上游菜单、那一步会调 focusDraftEditor：再压一次焦点，
      // 保证 sheet 停留期间不会有键盘。
      this.blurActiveEditor()
      // 行到齐之后重算 peek：行高只有真实行才量得到（打开瞬间还没有行）。
      this.relayoutSheet()
      // 焦点进入第一项：必须放在**压焦点之后**。
      // 写在打开时同步段会被这里的 blurActiveEditor 清掉（实测 activeElement 退回 body）。
      // 瓦片是 <button>，focus 不会唤起软键盘（编辑器才是会被唤起的那个）。
      const first = this.panel()?.querySelector<HTMLElement>('[' + TILE_ATTR + ']')
      if (first !== null && first !== undefined) first.focus({ preventScroll: true })
    })
  }

  /**
   * 打开期间锁住背景滚动（aria-modal=true 的会话框不能滚后面那一页，#1009）。
   *
   * 选的是「快照 + 还原 body 的 overflow」：快照能保证不覆盖别处设过的值，
   * 也不引入 position:fixed 那套会重置滚动位置的副作用（键盘与滚动位置都会因此跳）。
   * 滚动锁随 close() 一起还原，所以 Sheet 不会跨开关泄留状态。
   */
  private lockBodyScroll(): void {
    if (this.overflowSnapshot.size > 0) return
    const body = document.body
    this.overflowSnapshot.set(body, body.style.overflow)
    body.style.overflow = 'hidden'
  }

  /**
   * 播退场动画并真正移除面板。
   *
   * 为什么不用 `animationend` 一个事件了事：动画可能因为元素不可见、
   * prefers-reduced-motion、或浏览器跳过动画而**根本不触发** animationend，
   * 那种情况下监听器永远等不到，面板就永久留在 DOM 里（比不播动画严重得多）。
   * 所以「事件」与「超时」两条路都要走，先到先算，且用幂等闸保证只 remove 一次。
   *
   * 无 WAAPI（jsdom / 老 WebView）时立刻 remove：那种环境本来就没有动画可播。
   * @param backdrop - 正在离场的遮罩（已经不再挂在 this.backdrop 上）。
   */
  private playExit(backdrop: HTMLElement): void {
    const supportsAnimations = typeof backdrop.getAnimations === 'function'
    // **必须先挂标记再取动画，顺序反了就没有退场动画**（设备实测 0 帧）：
    // getAnimations() 返回的是**当前已存在**的动画对象，而退场动画由 LEAVING_ATTR
    // 那条 CSS 规则定义。先取后挂 = 取到的是入场动画（或空集），
    // 于是「没有动画就立刻 remove」把面板直接抹掉，用户看不到收回。
    backdrop.setAttribute(LEAVING_ATTR, '')
    // subtree: true 是必须的：竖屏的退场动画挂在**子元素** panel 上，遮罩自己只有
    // backdrop-out。只查遮罩自身会漏掉 panel 那条。
    const animations = supportsAnimations ? backdrop.getAnimations({ subtree: true }) : []
    if (animations.length === 0) {
      // 无 WAAPI（jsdom / 老 WebView）或动画被浏览器跳过：立刻移除，
      // 否则面板会永久留在 DOM 里（比没有动画严重得多）。
      backdrop.remove()
      return
    }
    // 收场期间**保留**事件接收（不加 pointer-events: none）：遮罩此刻已不在 this.backdrop 上，
    // onBackdropPointerDown 会直接早退，重复点击不会再次触发 close()；
    // 而一旦关掉事件，这 160ms 里点击会穿透到背后页面（与「透明遮罩必须能接住点击」
    // 同一条理由）。要防的只是「点到半透明卡片」，那由 CSS 的 pointer-events 维持原样即可。
    let removed = false
    const finish = (): void => {
      if (removed) return
      removed = true
      backdrop.remove()
    }
    for (const animation of animations) {
      animation.addEventListener('finish', finish, { once: true })
      animation.addEventListener('cancel', finish, { once: true })
    }
    // 兜底：动画被跳过 / 被打断 / 事件丢失时也必须收场。比动画时长多留一档余量。
    window.setTimeout(finish, EXIT_ANIMATION_MS + 120)
  }
  /** 按快照还原背景滚动（没有快照就什么都不做，不无条件清空）。 */
  private restoreBodyScroll(): void {
    for (const [element, previous] of this.overflowSnapshot) {
      if (previous === '') element.style.removeProperty('overflow')
      else element.style.overflow = previous
    }
    this.overflowSnapshot.clear()
  }

  /**
   * 关闭按钮（×）。
   *
   * 存在的理由：居中卡片是模态形态，没有可见的关闭控件时用户只能靠「点外面」或
   * 系统返回；而系统返回在平板 / 多窗口下不一定贴着用户的直觉。
   *
   * **它只是三条关闭路径之一**：点它 → this.close() → playExit()（160ms 向下沉出）。
   * 点外部、系统返回（BackStackSignal 的 composer-sheet 层）走的是同一个 close()，
   * 所以三者的离场动画天然一致，不存在某条路径瞬关。
   */
  private buildClose(t: (key: ComposerSheetKey) => string): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute(CLOSE_ATTR, '')
    button.setAttribute('aria-label', t('close'))
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    for (const d of ['M6 6 L18 18', 'M18 6 L6 18']) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', d)
      svg.append(path)
    }
    button.append(svg)
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.close()
    })
    return button
  }

  /**
   * 回执位：原生拍照那次调用的结果落在这里（role=status + aria-live，读屏与视觉同源）。
   *
   * 空文案时不占位（CSS `:empty`），有回执才出现 —— 否则面板会凭空空出一条。
   */
  private buildStatus(): HTMLElement {
    const status = document.createElement('div')
    status.setAttribute(STATUS_ATTR, '')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    // 样式就地写在这几行上，**刻意不动 composer-sheet.css.ts**：本轮改动面限定在
    // composer-sheet.ts + locales（同一插件里还有别的面板改动在并行进行）。
    // 三条要点与 CSS 里的行列表同款：不参与弹性收缩（否则被行列表挤成 0 高）、
    // 长文案换行而不是溢出、次要色（回执不是主内容）。
    status.style.flex = 'none'
    status.style.marginTop = '10px'
    status.style.fontSize = '12px'
    status.style.lineHeight = '16px'
    status.style.color = 'var(--dsw-alias-label-secondary, inherit)'
    status.style.whiteSpace = 'normal'
    status.style.overflowWrap = 'anywhere'
    this.status = status
    return status
  }

  private buildTiles(t: (key: ComposerSheetKey) => string): HTMLElement {
    const tiles = document.createElement('div')
    tiles.setAttribute(TILES_ATTR, '')
    const order: readonly [TileKind, ComposerSheetKey][] = [
      ['camera', 'camera'],
      ['photo', 'photo'],
      ['file', 'file'],
    ]
    for (const [kind, key] of order) {
      const tile = document.createElement('button')
      tile.type = 'button'
      tile.setAttribute(TILE_ATTR, kind)
      tile.setAttribute('aria-label', t(key))
      tile.append(tileIcon(kind))
      const label = document.createElement('span')
      label.setAttribute('data-dsh-composer-sheet-tile-label', '')
      label.textContent = t(key)
      tile.append(label)
      tile.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        // 拍照走壳侧原生相机（issue #1288 第 4 条）；照片/本地文件仍走上游 file input。
        // 拍照成功才收起面板；启动失败或取消时保留入口和回执，便于直接重试。
        if (kind === 'camera') {
          this.capturePhoto()
          return
        }
        this.pickFile(kind)
      })
      tiles.append(tile)
    }
    return tiles
  }

  /**
   * 打开上游「+」菜单 → 读它的 option → 复制成行 → 关掉上游菜单。
   *
   * 菜单不在场（上游改了实现 / 焦点门不让开）时只留三块瓦片，不报错：映射是增强，
   * 不是这张 sheet 的存在前提。
   */
  /**
   * 造映射行的容器，并异步填内容。
   *
   * 容器同步返回（三块瓦片立刻可见），行在拿到上游菜单之后补进去 —— 因为读菜单
   * 必须跨一次 React 提交（见 withUpstreamMenu）。
   * @returns 空的行容器；内容稍后填入。
   */
  private buildRows(): HTMLElement {
    const rows = document.createElement('div')
    rows.setAttribute(ROWS_ATTR, '')
    return rows
  }

  /**
   * 读上游菜单项并填进容器。
   *
   * 目标已被关闭/替换时丢弃结果：用户在等待期间点掉了 sheet，就不能再往旧容器里写。
   * @param rows - 行容器。
   */
  private async fillRows(rows: HTMLElement): Promise<void> {
    const mapped = await this.readUpstreamRows()
    if (mapped.length === 0) return
    // 只丢「这张 sheet 已经关了」的结果：关掉后 rows 会随 backdrop 离场，
    // 再往里写就是往死节点里写。**不能**用 rows.isConnected 判断 —— 读菜单要跨
    // 一次上游提交，这几帧里面板可能还没挂到 body 上（实测：读到了 9 个上游项，
    // 却因为此刻未挂载而整批丢弃，面板只剩三块瓦片）。
    if (this.backdrop === null || !this.backdrop.contains(rows)) return
    for (const row of mapped) {
      // 附件入口那条（文件 / file）不复制：三块瓦片已经覆盖它。
      // 用标题精确命中而不是位置/前缀，理由见 ATTACHMENT_ROW_TITLES。
      if (ATTACHMENT_ROW_TITLES.has(row.title.trim().toLowerCase())) continue
      rows.append(this.buildRow(row))
    }
  }

  private buildRow(row: MappedRow): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute(ROW_ATTR, '')
    button.setAttribute('aria-label', row.subtitle === '' ? row.title : row.title + ' — ' + row.subtitle)
    const iconBox = document.createElement('span')
    iconBox.setAttribute('data-dsh-composer-sheet-row-icon', '')
    if (row.icon !== null) iconBox.append(row.icon.cloneNode(true))
    const text = document.createElement('span')
    text.setAttribute('data-dsh-composer-sheet-row-text', '')
    const title = document.createElement('span')
    title.setAttribute('data-dsh-composer-sheet-row-title', '')
    title.textContent = row.title
    text.append(title)
    if (row.subtitle !== '') {
      const sub = document.createElement('span')
      sub.setAttribute('data-dsh-composer-sheet-row-sub', '')
      sub.textContent = row.subtitle
      text.append(sub)
    }
    button.append(iconBox, text)
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.dispatch(row.index)
      this.close()
    })
    return button
  }

  /**
   * 让上游菜单开出来，等 React 提交完再读，读完关掉。
   *
   * 真正的 DOM 机制（开菜单、等提交、藏菜单、Escape 关闭）在 composer-commands.ts 里，
   * 与 `window.__dshOverlayHost.commands()` 共用同一份实现（设计 §6.4 要求禁止两份口径）。
   * 这里只负责本类自己的状态：
   *   - 重入闸 replaying：合成「+」click 会再次经过本类的捕获监听，不拦住就无限递归；
   *   - 借用闸 borrowing：借用期间派发的 Escape 只关上游菜单，不能连锁关掉 sheet（#1001）；
   *   - 代次 generation：借用期间用户可能已经关掉 sheet，收尾就不能再压他此刻的焦点（#999）。
   *
   * @param run - 拿到 option 列表后执行的读取。
   * @param fallback - 菜单始终不出现时的返回值。
   * @returns run 的结果，或 fallback。
   */
  private async withUpstreamMenu<T>(run: (options: HTMLElement[]) => T, fallback: T): Promise<T> {
    // 这次借用属于哪一代：借用期间 sheet 可能已经被关掉，收尾就不能再去碰用户的焦点（#999）。
    const generation = this.generation
    return withUpstreamMenu(run, fallback, {
      beginBorrow: () => { this.borrowing = true },
      endBorrow: () => { this.borrowing = false },
      setReplaying: (active) => { this.replaying = active },
      afterBorrow: () => {
        // 上游刚刚把焦点给了编辑器：重新压回去，键盘才不会跟着冒出来。
        // 只在 sheet 还开着这次借用的那一代时做 —— 用户已经关掉的话，这一下会把他
        // 此刻正在用的输入框 blur 掉，键盘自己缩回（#999）。
        if (this.generation === generation) this.blurActiveEditor()
      },
    }, this.addButton)
  }



  /** 读上游菜单的项（打开-读-关），失败时返回空（只留三块瓦片）。 */
  private readUpstreamRows(): Promise<MappedRow[]> {
    return this.withUpstreamMenu((options) => options.map((option, index): MappedRow => {
      const name = (option.querySelector<HTMLElement>('[class*="itemName"]')?.textContent ?? '').trim()
      const label = (option.getAttribute('aria-label') ?? '').trim()
      return {
        title: name !== '' ? name : label,
        subtitle: readMenuOptionSubtitle(option),
        icon: option.querySelector('svg'),
        index,
      }
    }), [])
  }

  /**
   * 把点击转回上游那一条 item。
   *
   * 按索引转发：每次重新打开菜单，取同一位置的 option。
   * 事件类型必须是 mousedown —— 上游 MenuView.tsx:170-173 每个 option 只在 onMouseDown 上挂
   * onPick（防止焦点从编辑器被抢走），合成 click 不会触发它。
   */
  private dispatch(index: number): void {
    void this.withUpstreamMenu((options) => {
      const option = options[index]
      if (option === undefined) return
      // 不带 view：jsdom 的 window 不是 node 的 global，传了会抛
      // "member view is not of type Window"；上游 onPick 也不读 view。
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    }, undefined)
  }

  /** 把焦点从任何可编辑元素上挪走（不改变 inputmode，那份由 suppress/restore 管）。 */
  private blurActiveEditor(): void {
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body) active.blur()
  }



  /**
   * 照片 / 本地文件：交给上游那个 hidden multiple file input（行为不变）。
   *
   * 「拍照」**不在这里**：issue #1288 第 4 条实测，给 file input 叠 `capture="environment"`
   * 并不能让系统拉起相机 —— Android WebView 的 `<input type=file>` 只认
   * `accept`（它在 ACTION_GET_CONTENT / ACTION_OPEN_DOCUMENT 里表现为 MIME 过滤），
   * `capture` 属性是 Chrome-for-Android 的**页面直采**扩展，WebView 里没有这条实现，
   * 属性被整个忽略 → 用户点「拍照」看到的是图库/文件选择器。所以拍照走壳侧原生通道，
   * 见 [capturePhoto]。
   */
  private pickFile(kind: Exclude<TileKind, 'camera'>): void {
    const card = this.addButton?.closest(CARD_SELECTOR) ?? document.querySelector(CARD_SELECTOR)
    const input = card?.querySelector<HTMLInputElement>(FILE_INPUT_SELECTOR) ?? null
    this.close()
    if (input === null || input.disabled || !input.isConnected) return
    if (kind === 'file') {
      // 本地文件保持上游默认（不限 accept），直接开。
      input.removeAttribute('accept')
    } else {
      // 照片走 image/*：系统选择器按 MIME 过滤出图片。**不设 capture**：见上面的实测结论，
      // 它在 WebView 里不起作用，设了只会让「照片」和「拍照」看起来走了同一条路。
      input.setAttribute('accept', 'image/*')
    }
    // 历史属性的清场：旧实现给 input 叠过 capture，用户升级后那颗 input 上可能还留着值
    // （同一颗 DOM 不重建就不刷新）。清掉它，避免「照片」意外命中残留的直采语义。
    input.removeAttribute('capture')
    try {
      input.click()
    } finally {
      // accept 只影响这一次选择请求，选择器返回后清掉，避免污染后续「本地文件」。
      window.setTimeout(() => {
        input.removeAttribute('accept')
      }, 0)
    }
  }

  /**
   * 「拍照」：调壳侧原生相机（issue #1288 第 4 条）。
   *
   * 契约（`AndroidBridge.capturePhoto(action)` / `PhotoCaptureController.handleBridgeAction`）：
   *  - 入参：action 字符串，目前只有 `'capture'`；
   *  - 同步返回：**只表示受理**，`{"ok":true,"accepted":true}`；没接线是
   *    `{"ok":false,"code":"not-wired"}`。**不表示拍到了** —— 相机等待时间不可预知。
   *  - 最终结果：壳侧经进程内回调 `window.__dshBridge.onPhotoCaptured(payload)` 推回，
   *    成功 `{ok:true,path,mime,bytes,longEdge}`，失败 `{ok:false,code,message,detail}`，
   *    code 取 PhotoCapture.CODE_*（cancelled / permission-denied / camera-unavailable /
   *    camera-busy / camera-failed / compress-failed / busy / not-wired）。
   *
   * 照片本身由壳侧经**既有**来件通路（FileIncoming，与外部分享文件同一条）投进会话，
   * 页面只负责发起与如实反馈，不自己搬运文件。
   *
   * **绝不回退 file input**：静默回退正是本 issue 的缺陷形态 —— 用户点「拍照」，
   * 系统拉起图库，拍不到照却看不出哪里不对。没有桥时如实说「未接线」。
   */
  private capturePhoto(): void {
    if (this.photoGeneration !== null) return
    const t = this.text()
    const bridge = photoBridge()
    if (bridge === null) {
      this.setStatus(t('photoNotWired'))
      return
    }
    // 回调必须**先**挂上再发起：受理与回执之间的窗口里挂晚了就会丢第一条结果。
    this.installPhotoReceipt()
    this.photoGeneration = this.generation
    let reply: unknown
    try {
      reply = bridge('capture')
    } catch (error) {
      this.photoGeneration = null
      // 桥调用抛错（ROM 拦截 / WebView 正在销毁）：如实报错，不吞。
      this.setStatus(t('photoUnknown'), String(error))
      return
    }
    const parsed = parseBridgeReply(reply)
    if (parsed === null) {
      this.photoGeneration = null
      // 返回值不是可解析的 JSON：无法判断受理与否。**不能当成功**。
      this.setStatus(t('photoUnknown'), typeof reply === 'string' ? reply : '')
      return
    }
    if (parsed.ok === true && parsed.accepted === true) {
      this.setStatus(t('photoStarting'))
      return
    }
    // 同步失败（通常是 not-wired / failed）：按码给文案。
    this.photoGeneration = null
    this.setStatus(t(messageKeyForCode(stringField(parsed, 'code'))))
  }

  /**
   * 把 `window.__dshBridge.onPhotoCaptured` 挂上（幂等）。
   *
   * **只增属性，绝不创建 `window.__dshBridge` 本身**：注入层的 PICKER_SCRIPT 是
   * `if(window.__dshBridge){return}; window.__dshBridge={...}` 的**整体赋值 + 幂等守卫**，
   * 我们先建一个空壳会让它整段跳过 —— 目录选择轮询与 pick-token 一起失效
   * （host-web-compat lib/index.js:957-966）。那个脚本在 <head> 里随文档一起执行，
   * 早于任何插件装配，所以本函数正常路径下总能挂到既有对象上。
   */
  private installPhotoReceipt(): void {
    const host = pickerBridgeHost()
    if (host === null) return
    host[PHOTO_RECEIPT] = (payload: unknown): void => { this.onPhotoReceipt(payload) }
  }

  private photoGeneration: number | null = null

  /** 成功时收起发起拍照的面板；迟到的回执不得关闭后来打开的面板。 */
  private onPhotoReceipt(payload: unknown): void {
    const generation = this.photoGeneration
    this.photoGeneration = null
    if (generation === null || generation !== this.generation) return
    const t = this.text()
    const parsed = parseBridgeReply(payload)
    if (parsed === null) {
      this.setStatus(t('photoUnknown'))
      return
    }
    if (parsed.ok === true) {
      this.close()
      return
    }
    const code = stringField(parsed, 'code')
    // 取消不算错误：如实说「已取消」，不带红。
    this.setStatus(t(messageKeyForCode(code)), stringField(parsed, 'detail'))
  }

  /**
   * 面板里的回执位（role=status + aria-live，读屏与视觉同一处）。
   *
   * 为什么要有它：拍照是**一次性事件**且结果异步到达，没有这处就只剩「点了没反应」。
   * 打开时为空（不占视觉），有回执才显示文字。
   */
  private setStatus(text: string, detail = ''): void {
    const status = this.status
    if (status === null) return
    status.textContent = text
    // detail 只做排查线索，挂 title 而不是正文：正文要短到一眼读完。
    if (detail === '') status.removeAttribute('title')
    else status.setAttribute('title', detail)
    status.toggleAttribute('data-dsh-composer-sheet-status-set', true)
  }

  /** 临时把 inputmode 压成 none（关闭时逐个还原）。 */
  private suppressInputMode(): void {
    if (this.inputModeSnapshot.size > 0) return
    for (const element of document.querySelectorAll<HTMLElement>('input, textarea, [contenteditable="true"]')) {
      this.inputModeSnapshot.set(element, element.getAttribute('inputmode'))
      element.setAttribute('inputmode', 'none')
    }
  }

  private restoreInputMode(): void {
    for (const [element, previous] of this.inputModeSnapshot) {
      if (!element.isConnected) continue
      if (previous === null) element.removeAttribute('inputmode')
      else element.setAttribute('inputmode', previous)
    }
    this.inputModeSnapshot.clear()
  }

  // ── 竖屏底部 sheet：几何（peek / 展开上限）与两段滚动手势 ───────────────────

  /** 拖拽把手：一条小横杠（只有竖屏有；横屏靠 × 关闭）。 */
  private buildHandle(): HTMLElement {
    const handle = document.createElement('div')
    handle.setAttribute(HANDLE_ATTR, '')
    handle.setAttribute('aria-hidden', 'true')
    return handle
  }

  /** 竖屏形态判据：form-marker 维护的 html[data-dsh-mobile-form]（<768px 才有）。 */
  private sheetFormRequested(): boolean {
    return document.documentElement.hasAttribute(MOBILE_FORM_ATTR)
  }

  private mountedForm(): string | null {
    return this.backdrop?.getAttribute(FORM_ATTR) ?? null
  }

  private isSheetForm(): boolean {
    return this.mountedForm() === FORM_SHEET
  }

  /** 当前手感档（<html data-dsh-composer-sheet-feel>；缺省 A = 契约档）。 */
  private feel(): SheetFeel {
    const id = (document.documentElement.getAttribute(FEEL_ATTR) ?? 'A').trim().toUpperCase()
    return FEELS[id] ?? (FEELS['A'] as SheetFeel)
  }

  /** 可见视口高度：优先 visualViewport（软键盘抬起时它才是真实可见区）。 */
  private viewportHeight(): number {
    const vv = typeof window.visualViewport === 'object' ? window.visualViewport : null
    return vv !== null && vv.height > 0 ? vv.height : window.innerHeight
  }

  /** 软键盘抬起的距离：innerHeight 与可见区（height + offsetTop）之差。 */
  private keyboardInset(): number {
    const vv = typeof window.visualViewport === 'object' ? window.visualViewport : null
    if (vv === null) return 0
    return Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)))
  }

  /** 把键盘抬起量写进 --dsh-sheet-bottom，让面板贴住可见区底边。 */
  private applyViewportVars(): void {
    const panel = this.panel()
    if (panel === null) return
    panel.style.setProperty('--dsh-sheet-bottom', this.keyboardInset() + 'px')
  }

  /** 展开上限：0.88 × 可见视口高，且不小于 peek。 */
  private maxHeight(): number {
    const cap = Math.round(this.viewportHeight() * MAX_HEIGHT_RATIO)
    return Math.max(this.peekHeight(), cap)
  }

  /**
   * 底部安全区（px）：读 CSS 变量 --dsh-sheet-safe-bottom（env() 与壳侧推送取大）。
   *
   * 不折进 padding-bottom：那样 jsdom 与老内核里 env() 恒 0 时 peek 会少一段，
   * 而把两处都算上又会重复计一次。安全区只在这一处参与计算。
   */
  private safeBottom(): number {
    const panel = this.panel()
    if (panel === null) return 0
    const raw = getComputedStyle(panel).getPropertyValue('--dsh-sheet-safe-bottom').trim()
    const px = Number.parseFloat(raw)
    return Number.isFinite(px) && px > 0 ? px : 0
  }

  /**
   * peek 高度 = 顶部内边距 + 把手 + 瓦片行 + 行间距 + 3.5 行 + 底部内边距 + 安全区。
   *
   * 行高取**真实第一行**：打开瞬间还没有映射行，用 ROW_FALLBACK_HEIGHT 兜底，
   * 行到齐后 relayoutSheet() 重算。任何一项都不写死 vh —— 内容变高，peek 跟着变。
   */
  private peekHeight(): number {
    const panel = this.panel()
    if (panel === null) return 0
    const style = getComputedStyle(panel)
    const padTop = Number.parseFloat(style.paddingTop) || 0
    const padBottom = Number.parseFloat(style.paddingBottom) || 0
    const handle = panel.querySelector<HTMLElement>('[' + HANDLE_ATTR + ']')
    let handleHeight = 0
    if (handle !== null) {
      const handleStyle = getComputedStyle(handle)
      handleHeight = handle.getBoundingClientRect().height
        + (Number.parseFloat(handleStyle.marginTop) || 0)
        + (Number.parseFloat(handleStyle.marginBottom) || 0)
    }
    const tiles = panel.querySelector<HTMLElement>('[' + TILES_ATTR + ']')
    const tilesHeight = tiles === null ? 0 : tiles.getBoundingClientRect().height
    const rows = panel.querySelector<HTMLElement>('[' + ROWS_ATTR + ']')
    const row = rows?.querySelector<HTMLElement>('[' + ROW_ATTR + ']') ?? null
    const measured = row === null ? 0 : row.getBoundingClientRect().height
    if (measured > 0 && this.rowHeightPx === null) this.rowHeightPx = Math.round(measured)
    const rowHeight = this.rowHeightPx ?? ROW_FALLBACK_HEIGHT
    const gap = rows === null ? 0 : (Number.parseFloat(getComputedStyle(rows).marginTop) || 0)
    return Math.round(padTop + handleHeight + tilesHeight + gap + PEEK_ROWS * rowHeight + padBottom + this.safeBottom())
  }

  /** 面板当前高度（优先实测；jsdom 里没有布局，退回内联值）。 */
  private currentHeight(): number {
    const panel = this.panel()
    if (panel === null) return 0
    const measured = panel.getBoundingClientRect().height
    if (measured > 0) return measured
    const inline = Number.parseFloat(panel.style.height)
    return Number.isFinite(inline) ? inline : 0
  }

  private setHeight(px: number): void {
    const panel = this.panel()
    if (panel === null) return
    panel.style.height = Math.round(px) + 'px'
  }

  /** 拖拽位移：直接写 transform（无过渡），松手吸附时才交给 CSS。 */
  private setOverscroll(px: number): void {
    const panel = this.panel()
    if (panel === null) return
    panel.style.transform = px === 0 ? '' : 'translateY(' + Math.round(px) + 'px)'
  }

  /** 把 peek / max 两个数值写到面板上，供 CSS 与设备验收逐条取值。 */
  private writeHeights(phase: string): void {
    const panel = this.panel()
    if (panel === null) return
    const peek = this.peekHeight()
    panel.setAttribute(PHASE_ATTR, phase)
    panel.setAttribute(PEEK_ATTR, String(peek))
    panel.setAttribute(MAX_ATTR, String(this.maxHeight()))
  }

  /**
   * 把当前几何挂到 window.__dshComposerSheet（设备验收的取数口，只读）。
   *
   * **拖拽期间必须走 per-drag 缓存**：本函数在 onSheetTouchMove 里每帧被调一次，
   * 若在这里直接 peekHeight()/maxHeight()，刚才在 touchmove 里省下的几何读会原样付回来
   * （实测：缓存做了但仍每帧 12 次读）。拖拽外的调用照旧实时计算。
   */
  private publishGeometry(): void {
    const panel = this.panel()
    if (panel === null) return
    // 高度用**内联值**：吸附过渡期间实测 rect 还在动，读它会拿到上一步的旧高度。
    const inline = Number.parseFloat(panel.style.height)
    const dragGeometry = this.drag !== null ? this.dragPeekMax() : null
    const geometry = {
      form: this.mountedForm(),
      phase: panel.getAttribute(PHASE_ATTR),
      height: Number.isFinite(inline) ? Math.round(inline) : Math.round(this.currentHeight()),
      peek: dragGeometry?.peek ?? this.peekHeight(),
      max: dragGeometry?.max ?? this.maxHeight(),
      viewport: { height: Math.round(this.viewportHeight()), innerHeight: window.innerHeight, keyboard: this.keyboardInset() },
      feel: this.feel().id,
    }
    ;(window as unknown as { __dshComposerSheet?: unknown }).__dshComposerSheet = geometry
  }

  /** 竖屏：写初始 peek 高度、挂手势与视口监听。 */
  private activateSheet(panel: HTMLElement): void {
    this.sheetPanel = panel
    this.invalidateDragGeometry()
    this.applyViewportVars()
    this.setHeight(this.peekHeight())
    this.writeHeights('peek')
    panel.addEventListener('touchstart', this.onSheetTouchStart, { passive: true })
    // 必须非 passive：归属卡片时要 preventDefault 才能压住原生滚动。
    panel.addEventListener('touchmove', this.onSheetTouchMove, { passive: false })
    panel.addEventListener('touchend', this.onSheetTouchEnd)
    panel.addEventListener('touchcancel', this.onSheetTouchCancel)
    window.addEventListener('resize', this.onSheetViewport)
    if (typeof window.visualViewport === 'object' && window.visualViewport !== null) {
      window.visualViewport.addEventListener('resize', this.onSheetViewport)
      window.visualViewport.addEventListener('scroll', this.onSheetViewport)
    }
    // 字体加载完成会改行高 ⇒ peek 跟着变。rowHeightPx 只在首次量到真行时写入，
    // 而那次量到的可能是回退字体；这里在字体就绪后重新采样一次并重算。
    // （jsdom / 老内核没有 document.fonts：存在性判断后跳过，不改变原有行为。）
    const fonts = (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts
    if (fonts?.ready !== undefined) {
      void fonts.ready.then(() => {
        if (this.sheetPanel !== panel) return
        this.rowHeightPx = null
        this.invalidateDragGeometry()
        this.relayoutSheet()
      }).catch(() => {})
    }
    this.publishGeometry()
  }

  private deactivateSheet(): void {
    const panel = this.sheetPanel
    this.sheetPanel = null
    this.drag = null
    this.invalidateDragGeometry()
    if (this.settleTimer !== undefined) {
      window.clearTimeout(this.settleTimer)
      this.settleTimer = undefined
    }
    window.removeEventListener('resize', this.onSheetViewport)
    if (typeof window.visualViewport === 'object' && window.visualViewport !== null) {
      window.visualViewport.removeEventListener('resize', this.onSheetViewport)
      window.visualViewport.removeEventListener('scroll', this.onSheetViewport)
    }
    // 调试取数口随面板一起失效：留着会把竖屏的 peek/max 带进横屏读到的旧值。
    delete (window as unknown as { __dshComposerSheet?: unknown }).__dshComposerSheet
    if (panel === null) return
    panel.removeEventListener('touchstart', this.onSheetTouchStart)
    panel.removeEventListener('touchmove', this.onSheetTouchMove)
    panel.removeEventListener('touchend', this.onSheetTouchEnd)
    panel.removeEventListener('touchcancel', this.onSheetTouchCancel)
  }

  /**
   * 重算 peek / 上限并重写高度：行到齐、视口变化（软键盘、转屏）都走这里。
   *
   * 打开期间被转屏换成横屏形态时直接收场：两种形态的 DOM 不同（把手 / ×），
   * 半路换 DOM 会让用户正在点的节点消失。
   */
  private relayoutSheet(): void {
    if (!this.isSheetForm()) return
    if (this.sheetFormRequested() !== true) {
      this.close()
      return
    }
    const panel = this.panel()
    if (panel === null) return
    // 行到齐（fillRows 收尾）/ 视口变化都会走到这里：几何缓存必须随之失效。
    this.invalidateDragGeometry()
    this.applyViewportVars()
    const peek = this.peekHeight()
    const max = this.maxHeight()
    const phase = panel.getAttribute(PHASE_ATTR) === 'expanded' ? 'expanded' : 'peek'
    this.setHeight(phase === 'expanded' ? max : Math.min(peek, max))
    this.writeHeights(phase)
    this.publishGeometry()
  }

  /** 松手吸附到 peek / expanded（带手感档的过渡）。 */
  private settleTo(target: number): void {
    const panel = this.panel()
    const backdrop = this.backdrop
    if (panel === null || backdrop === null) return
    const feel = this.feel()
    this.setOverscroll(0)
    // prefers-reduced-motion：直接切，不挂 settling（CSS 那条 reduce 规则是双保险）。
    const reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reduced) {
      backdrop.style.setProperty('--dsh-sheet-snap-ms', feel.snapMs + 'ms')
      backdrop.style.setProperty('--dsh-sheet-snap-timing', feel.snapTiming)
      backdrop.setAttribute(SETTLING_ATTR, '')
    }
    // 松手吸附仍在拖拽生命周期内（drag 尚未清空）：复用本次拖拽的几何，避免再付一轮读。
    // 缓存缺失（例如非手势路径调用）时 dragPeekMax 会现算，行为与原先一致。
    const phase = target > this.dragPeekMax().peek + 1 ? 'expanded' : 'peek'
    this.setHeight(target)
    this.writeHeights(phase)
    this.publishGeometry()
    if (this.settleTimer !== undefined) window.clearTimeout(this.settleTimer)
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = undefined
      this.backdrop?.removeAttribute(SETTLING_ATTR)
    }, feel.snapMs + 40)
  }

  private readonly onSheetViewport = (): void => {
    // 视口变化（软键盘弹收 / visualViewport resize / 转屏）会让 max 变 —— 拖拽中也要失效。
    this.invalidateDragGeometry()
    this.relayoutSheet()
  }

  /** 起手只记录，不判定归属（8px 方向锁在 move 里）。 */
  private readonly onSheetTouchStart = (event: TouchEvent): void => {
    if (!this.isSheetForm() || this.drag !== null) return
    const panel = this.panel()
    const touch = event.touches[0]
    if (panel === null || touch === undefined) return
    // 新一次拖拽：先丢弃上一轮的几何缓存，再让本次拖拽自己付第一次读。
    this.invalidateDragGeometry()
    const height = this.currentHeight()
    this.drag = {
      startX: touch.clientX,
      startY: touch.clientY,
      appliedY: touch.clientY,
      lastY: touch.clientY,
      lastTime: performance.now(),
      velocity: 0,
      startHeight: height,
      height,
      overscroll: 0,
      owner: 'none',
      handedBack: false,
    }
  }

  /**
   * 两段滚动：内层到顶后上滑抬卡片（1:1），到上限把剩余位移交回列表；
   * 下滑先把列表滚回顶部，再回收卡片高度，最后才是「超出 peek 的下拉」。
   */
  private readonly onSheetTouchMove = (event: TouchEvent): void => {
    const drag = this.drag
    const panel = this.panel()
    const touch = event.touches[0]
    if (drag === null || panel === null || touch === undefined) return
    const rows = panel.querySelector<HTMLElement>('[' + ROWS_ATTR + ']')
    const dy = touch.clientY - drag.startY
    const dx = touch.clientX - drag.startX
    const now = performance.now()
    const elapsed = now - drag.lastTime
    if (elapsed > 0) {
      const step = (touch.clientY - drag.lastY) / elapsed
      drag.velocity = drag.velocity * 0.5 + step * 0.5
      drag.lastY = touch.clientY
      drag.lastTime = now
    }
    // 方向锁：起手 8px 内不判定归属；横向手势直接让给浏览器。
    if (drag.owner === 'none') {
      if (Math.abs(dy) < DRAG_LOCK_PX) return
      if (Math.abs(dy) <= Math.abs(dx)) { drag.owner = 'list'; return }
      drag.owner = (rows === null ? 0 : rows.scrollTop) > 0 ? 'list' : 'sheet'
    }
    if (drag.owner !== 'sheet') return
    event.preventDefault()
    panel.setAttribute(DRAGGING_ATTR, '')
    const feel = this.feel()
    // per-drag 缓存：整个拖拽只在这里付一次几何读（见 dragPeekMax 的注释）。
    const { peek, max } = this.dragPeekMax()
    const delta = touch.clientY - drag.appliedY
    drag.appliedY = touch.clientY
    if (delta === 0) return
    if (delta < 0) {
      // 上滑：卡片先 1:1 抬起；到上限后剩余位移交回列表（此后继续上滑滚列表）。
      if (drag.handedBack) {
        if (rows !== null) rows.scrollTop = rows.scrollTop - delta
        return
      }
      const grown = drag.height + (-delta) * feel.upDamping
      if (grown <= max) {
        drag.height = Math.max(peek, grown)
      } else {
        const rest = grown - max
        drag.height = max
        drag.handedBack = true
        if (rows !== null) rows.scrollTop = rows.scrollTop + rest
      }
      this.setHeight(drag.height)
      this.publishGeometry()
      return
    }
    // 下滑：列表还有得滚就先滚列表，滚到顶之后才开始回收卡片高度。
    if (drag.handedBack) {
      if (rows !== null && rows.scrollTop > 0) {
        const next = rows.scrollTop - delta
        if (next >= 0) {
          rows.scrollTop = next
          return
        }
        rows.scrollTop = 0
      }
      drag.handedBack = false
    }
    if (drag.height > peek) {
      const next = drag.height - delta * feel.downDamping
      if (next > peek) {
        drag.height = next
        this.setHeight(next)
        this.publishGeometry()
        return
      }
      drag.height = peek
      this.setHeight(peek)
      drag.overscroll = Math.max(0, drag.overscroll + (peek - next))
      this.setOverscroll(drag.overscroll)
      this.publishGeometry()
      return
    }
    drag.height = peek
    drag.overscroll = Math.max(0, drag.overscroll + delta)
    this.setOverscroll(drag.overscroll)
    this.publishGeometry()
  }

  /**
   * 松手：下拉超过卡片高度 30% 才关闭（或明显快速下甩），否则吸附回 peek / expanded。
   *
   * 阈值是**卡片高度的比例**而不是固定像素：peek 随内容变高，阈值必须跟着变。
   */
  private readonly onSheetTouchEnd = (): void => {
    const drag = this.drag
    this.drag = null
    if (drag === null || drag.owner !== 'sheet') return
    this.panel()?.removeAttribute(DRAGGING_ATTR)
    const peek = this.peekHeight()
    const max = this.maxHeight()
    // 停手再抬：速度按「距最后一次位移的时间」清零，避免陈旧速度把慢放判成甩动。
    const velocity = performance.now() - drag.lastTime > VELOCITY_IDLE_MS ? 0 : drag.velocity
    const closing = drag.overscroll > 0
      && (drag.overscroll > CLOSE_RATIO * peek || velocity > SNAP_VELOCITY_CLOSE)
    if (closing) {
      this.close()
      return
    }
    const expanded = drag.overscroll === 0
      && (drag.height > (peek + max) / 2
        || (velocity < -SNAP_VELOCITY_EXPAND && drag.height > peek + DRAG_LOCK_PX))
    this.settleTo(expanded ? max : peek)
    // 拖拽结束：per-drag 几何缓存到此为止（绝不跨拖，见 dragGeometry 的注释）。
    this.invalidateDragGeometry()
  }

  /**
   * 手势被**系统取消**（来电、通知下拉、浏览器接管滚动）：不是用户松手，不能按提交处理。
   *
   * issue #1378：旧实现把 `touchcancel` 绑到 `onSheetTouchEnd`，回弹量超过阈值就直接 `close()`——
   * 用户什么都没做，面板却被关掉。这里只吸附回原位（与松手同样的落点判定，但**没有关闭分支**）。
   */
  private readonly onSheetTouchCancel = (): void => {
    const drag = this.drag
    this.drag = null
    if (drag === null || drag.owner !== 'sheet') return
    this.panel()?.removeAttribute(DRAGGING_ATTR)
    const peek = this.peekHeight()
    const max = this.maxHeight()
    const expanded = drag.overscroll === 0 && drag.height > (peek + max) / 2
    this.settleTo(expanded ? max : peek)
    this.invalidateDragGeometry()
  }

  /**
   * 收起 sheet。
   *
   * 刻意**不**调用任何 focus()：见文件头「键盘行为」。除还原 inputmode 外不碰焦点。
   */
  private close(): void {
    // 先让代次失效：open() 里还在跑的 fillRows 收尾拿到的是旧代次，之后一律不再碰焦点（#999）。
    this.generation += 1
    // 关掉 sheet 时借用一定结束：万一借用段还没走到自己的 finally，这里的复位
    // 保证 Escape 立刻可用（#1001）。
    this.borrowing = false
    // 面板要离场了：拖拽几何缓存没有跨开关的意义，随手丢掉。
    this.invalidateDragGeometry()

    if (this.backdrop !== null) {
      // 先摘掉引用，再播退场动画：close() 是同步语义（调用方回来时面板状态已归零），
      // 动画只是视觉上的余韵，不能让它决定「关没关」。
      const leaving = this.backdrop
      this.backdrop = null
      // 竖屏：先摘手势/视口监听，并把拖拽残留的位移清掉 —— 退场动画必须从 0 起，
      // 否则会从半路（用户拖到一半的位置）跳一下再沉下去。
      this.deactivateSheet()
      leaving.removeAttribute(SETTLING_ATTR)
      const leavingPanel = leaving.querySelector<HTMLElement>('[' + PANEL_ATTR + ']')
      if (leavingPanel !== null) {
        leavingPanel.style.transform = ''
        leavingPanel.removeAttribute(DRAGGING_ATTR)
      }
      // 回执位随面板一起失效：再往里写就是往即将离场的节点里写。
      this.status = null
      this.playExit(leaving)
      if (this.addButton !== null) {
        if (this.previousExpanded === null) this.addButton.removeAttribute('aria-expanded')
        else this.addButton.setAttribute('aria-expanded', this.previousExpanded)
      }
      this.previousExpanded = null
    }
    this.restoreInputMode()
    this.restoreBodyScroll()
  }
}
