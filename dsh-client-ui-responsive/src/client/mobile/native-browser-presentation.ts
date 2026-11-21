import { COMPOSER_BACKDROP_SELECTOR } from './composer-sheet.css.ts'
/** Position one native tab over only the official BrowserBody viewport. */
import type { BrowserPresentation } from './upstream-browser/view/BrowserPresentation.ts'
import type {} from '../android-bridge.ts'

/** Identity and visibility remain owned by the Session/occurrence adapter. */
export interface NativeBrowserPresentationOptions {
  readonly session: string
  readonly uiTabId: string
  readonly nativeTabId: () => string | undefined
  readonly visible: () => boolean
  readonly ready: () => boolean
}

// Must remain below BrowserOverlayPolicy.STAGE_BOUNDS_TTL_MS (4000ms).
export const BROWSER_STAGE_LEASE_MS = 1000

/**
 * 抢走输入的浮层：菜单 / 对话框 / 列表框。
 *
 * Android 原生视图在 DOM 之门（portals）之上，浮层开着时原生页会盖住它 ——
 * 这是用户实报的遮挡形态，判据一个都不能少。
 */
const OVERLAY_SELECTOR = '[role="menu"], [role="dialog"], [aria-modal="true"], [role="listbox"]'
/** 侧栏气泡导航：打开与关闭动画期间都要让位（用户实报：气泡开着时原生页压在它上面）。 */
const BUBBLES_SELECTOR = '[data-dsh-sidebar-bubbles="open"], [data-dsh-sidebar-bubbles="closing"]'
/** 工作区拖动期间的指针标记（拖动时原生页不能压在拖动指示上）。 */
const POINTER_SELECTOR = '[data-dockkit-pointer]'
/** 上面两个「在场即让位」判据合一个选择器：只有这些节点进出才要重算在场状态。 */
const PRESENCE_SELECTOR = [POINTER_SELECTOR, '[data-dsh-sidebar-bubbles]', COMPOSER_BACKDROP_SELECTOR].join(', ')
/**
 * 主观察者关心的属性：几何、显隐与布局驱动。
 *
 * 审计 §7.1 要求收窄 attributeFilter：这里只留**能改变 stage 祖先链样式或几何**的那些。
 * 遮挡类属性（role / aria-modal / aria-hidden / data-dockkit-pointer / data-dsh-sidebar-bubbles）
 * 归遮挡观察者，不在这里重复观察。
 */
const STRUCTURE_ATTRIBUTES = ['class', 'style', 'hidden', 'data-sidebar-right-open']
/**
 * 遮挡观察者关心的属性：能改变候选集、气泡或指针在场的那些。
 *
 * class / style / hidden 一并观察，是因为上游用它们驱动显隐：候选判据要读 computed style，
 * 一个本来不在候选集里的节点也可能因为这三者进入或退出。
 */
const OCCLUSION_ATTRIBUTES = ['role', 'aria-modal', 'aria-hidden', 'class', 'style', 'hidden',
  'data-dockkit-pointer', 'data-dsh-sidebar-bubbles']
/** 候选集的重判判据：这些属性变了，元素可能进入或退出候选集。 */
const CANDIDATE_ATTRIBUTES = new Set(['role', 'aria-modal', 'aria-hidden', 'class', 'style', 'hidden'])

/**
 * 祖先链上的一层样式事实。
 *
 * 审计 §7.1：send() 是每帧都在跑的，而祖先链的 getComputedStyle 与各层显隐判定在一帧之内
 * 不会变。这里把**样式事实**（是否隐藏、是否裁剪）缓存在结构版本上，几何仍每次现读 ——
 * 位置会跟着滚动变，但那几个布尔量只随结构 / 样式 / 视口变化，由观察者与尺寸事件推高版本。
 */
interface ChainLayer {
  readonly element: HTMLElement
  /** 这一层把 stage 整块藏掉了（display:none / visibility:hidden / opacity:0 / hidden 属性）。 */
  readonly hides: boolean
  /** 这一层的水平 / 垂直 overflow 会裁剪 stage 的矩形。 */
  readonly clipsX: boolean
  readonly clipsY: boolean
}

/** Native presentation never opens or closes a page; detach is targeted hide only. */
export class NativeBrowserPresentation implements BrowserPresentation {
  private release: (() => void) | undefined
  private publish: (() => void) | undefined

  constructor(private readonly options: NativeBrowserPresentationOptions) {}

  /** Republish after a framework-visible tab or native navigation change. */
  refresh(): void { this.publish?.() }

  mount(viewportId: string): () => void {
    this.release?.()
    let stage = document.getElementById(viewportId)
    let queued = 0
    let active = true
    let last = ''
    let lease: number | undefined
    /** 上一次下发的是不是「可见」：隐藏时靠它去重，也靠它保证**至少隐藏一次**。 */
    let publishedVisible = false
    /** 结构版本：任何可能改变祖先链样式事实的变化都把它推高（见两个观察者与尺寸 / 动效监听）。 */
    let epoch = 0
    let chain: ChainLayer[] = []
    let chainStage: HTMLElement | null = null
    let chainEpoch = -1
    /** 候选浮层：由遮挡观察者增量维护，send() 不再每帧做全文档查询。 */
    let candidates: HTMLElement[] = []
    let pointer = false
    let bubbles = false
    let composerSheet = false

    /** 把一串节点里匹配选择器的后代收集出来（只查这一小块，不查全文档）。 */
    const collect = (node: Node, selector: string): HTMLElement[] => {
      if (node.nodeType !== 1) return []
      const element = node as Element
      const found = [...element.querySelectorAll<HTMLElement>(selector)]
      if (element.matches(selector)) found.unshift(element as HTMLElement)
      return found
    }

    /** 两个「在场即让位」判据各读一次全文档（只在相关节点进出时调用）。 */
    const recomputePresence = (): void => {
      pointer = document.querySelector(POINTER_SELECTOR) !== null
      bubbles = document.querySelector(BUBBLES_SELECTOR) !== null
      composerSheet = document.querySelector(COMPOSER_BACKDROP_SELECTOR) !== null
    }

    /**
     * 维护候选浮层集合与两个「在场即让位」判据。
     *
     * 判据与旧实现的每帧全文档查询**完全同源**：候选集合永远是
     * document.querySelectorAll(OVERLAY_SELECTOR) 的结果，只是不再每帧重算 ——
     * 只有真的可能进入 / 退出候选集的变化（属性改写、节点进出）才触发重算。
     * @param records - 遮挡观察者这一批记录。
     */
    const refreshOcclusion = (records: readonly MutationRecord[]): void => {
      let presenceTouched = false
      for (const record of records) {
        if (record.type === 'attributes') {
          const element = record.target as Element
          const name = record.attributeName ?? ''
          if (name === 'data-dockkit-pointer' || name === 'data-dsh-sidebar-bubbles') { presenceTouched = true; continue }
          if (!CANDIDATE_ATTRIBUTES.has(name)) continue
          const isCandidate = element.matches(OVERLAY_SELECTOR)
          const index = candidates.indexOf(element as HTMLElement)
          if (isCandidate && index < 0) candidates.push(element as HTMLElement)
          else if (!isCandidate && index >= 0) candidates.splice(index, 1)
          continue
        }
        for (const node of record.removedNodes) {
          if (node.nodeType !== 1) continue
          const element = node as Element
          if (element.matches(PRESENCE_SELECTOR) || element.querySelector(PRESENCE_SELECTOR) !== null) presenceTouched = true
          candidates = candidates.filter(candidate => !node.contains(candidate))
        }
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue
          const element = node as Element
          if (element.matches(PRESENCE_SELECTOR) || element.querySelector(PRESENCE_SELECTOR) !== null) presenceTouched = true
          for (const candidate of collect(node, OVERLAY_SELECTOR)) {
            if (!candidates.includes(candidate)) candidates.push(candidate)
          }
        }
      }
      if (presenceTouched) recomputePresence()
    }

    /**
     * 取当前结构版本的祖先链样式事实。
     *
     * 缓存键是「结构版本 + stage 元素」：版本由结构 / 样式变化、视口尺寸变化与祖先链上的
     * 动效事件推高（见 epoch 的三处更新点），所以这里永远不会跨过一次真实变化。
     * @param target - 当前 stage 元素。
     * @returns 从 stage 自己到根的每一层样式事实。
     */
    const chainFor = (target: HTMLElement): ChainLayer[] => {
      if (chainEpoch === epoch && chainStage === target && chain.length > 0) return chain
      const next: ChainLayer[] = []
      for (let element: HTMLElement | null = target; element !== null; element = element.parentElement) {
        const style = window.getComputedStyle(element)
        next.push({
          element,
          hides: element.hidden || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0',
          clipsX: /hidden|clip|scroll|auto/.test(style.overflowX),
          clipsY: /hidden|clip|scroll|auto/.test(style.overflowY),
        })
      }
      chain = next
      chainStage = target
      chainEpoch = epoch
      return chain
    }

    /** 一个候选浮层此刻是否真的盖在 stage 上（与旧实现逐条同源的判据）。 */
    const covers = (element: HTMLElement): boolean => {
      const bounds = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      if (bounds.right <= 0 || bounds.bottom <= 0 || bounds.left >= window.innerWidth || bounds.top >= window.innerHeight) return false
      for (let ancestor: HTMLElement | null = element; ancestor !== null; ancestor = ancestor.parentElement) {
        const ancestorStyle = window.getComputedStyle(ancestor)
        if (ancestor.hidden || ancestorStyle.display === 'none' || ancestorStyle.visibility === 'hidden' || ancestorStyle.opacity === '0') return false
      }
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
    }

    /**
     * 下发一次「隐藏」并返回 false。
     *
     * 为什么不直接 return：用户收起侧栏 / 弹层遮挡时，前端必须把 visible:false 送到壳侧，
     * 否则原生覆盖层会留在屏上（2026-09-19 用户实报「收起侧边栏浏览器不卸载」）。
     * 所以早退的判据是「已经下发过隐藏」，不是「这次不可见」。
     * 隐藏分支**不读任何几何**：壳侧收到 visible:false 会在读几何之前就返回
     * （BrowserHost.setStageBounds 的 if (!visible) 分支），矩形一律不被使用。
     * @param tabId - 当前原生 Tab id。
     * @param force - 结构已经变了（stage 换掉 / 卸载）时无条件下发一次，不看去重标记。
     * @returns false（本拍不可见）。
     */
    const hide = (tabId: string, force = false): boolean => {
      if (!publishedVisible && !force) return false
      const payload = JSON.stringify({ session: this.options.session, tabId, uiTabId: this.options.uiTabId,
        left: 0, top: 0, width: 0, height: 0,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, visible: false })
      try {
        if (window.androidBridge?.browserHostBounds === undefined) return false
        window.androidBridge.browserHostBounds(payload)
        last = payload
        publishedVisible = false
      } catch (_bridgeUnavailable) { /* A later geometry or lifecycle event may retry. */ }
      return false
    }

    const send = (visible: boolean, renew = false): boolean => {
      const tabId = this.options.nativeTabId()
      if (tabId === undefined || stage === null) return false
      // 审计 §7.1：可见性判定放在最前面。不可见时后面那些昂贵调用（祖先链 getComputedStyle、
      // 每层 getBoundingClientRect、弹层排查）一次都不该跑 —— 它们在隐藏时不可能改变结论。
      if (!visible || document.hidden) return hide(tabId)
      const rect = stage.getBoundingClientRect()
      let left = Math.max(0, rect.left)
      let top = Math.max(0, rect.top)
      let right = Math.min(window.innerWidth, rect.right)
      let bottom = Math.min(window.innerHeight, rect.bottom)
      let displayed = stage.isConnected
      for (const layer of chainFor(stage)) {
        if (layer.hides) displayed = false
        // 几何每次现读：滚动会移动裁剪层，只有样式事实才按结构版本缓存。
        if (layer.clipsX) {
          const clip = layer.element.getBoundingClientRect()
          left = Math.max(left, clip.left)
          right = Math.min(right, clip.right)
        }
        if (layer.clipsY) {
          const clip = layer.element.getBoundingClientRect()
          top = Math.max(top, clip.top)
          bottom = Math.min(bottom, clip.bottom)
        }
      }
      // Android native views are above DOM portals; hide while app menus/dialogs own input.
      const occluded = composerSheet || bubbles || pointer || (candidates.length > 0 && candidates.some(covers))
      const stageVisible = displayed && !occluded && right - left > 1 && bottom - top > 1
      const payload = JSON.stringify({ session: this.options.session, tabId, uiTabId: this.options.uiTabId,
        left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top),
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
        visible: stageVisible })
      if (payload === last && !(renew && stageVisible)) return stageVisible
      try {
        if (window.androidBridge?.browserHostBounds === undefined) return false
        window.androidBridge.browserHostBounds(payload)
        last = payload
        publishedVisible = stageVisible
      } catch (_bridgeUnavailable) { /* A later geometry or lifecycle event may retry. */ return false }
      return stageVisible
    }
    const publish = (renew = false): void => {
      if (!active) return
      // Renewal proves UI ownership; it never reloads or reconstructs the isolated page.
      // Deduped mutation/resize events must not postpone the next renewal indefinitely.
      if (send(this.options.visible() && this.options.ready(), renew)) {
        if (lease === undefined) lease = window.setTimeout(() => { lease = undefined; publish(true) }, BROWSER_STAGE_LEASE_MS)
      } else if (lease !== undefined) {
        window.clearTimeout(lease); lease = undefined
      }
    }
    const schedule = (): void => {
      if (queued !== 0 || !active) return
      queued = window.requestAnimationFrame(() => { queued = 0; publish() })
    }
    /** 视口尺寸与媒体查询可能改写祖先链的样式事实，必须让缓存失效。 */
    const invalidate = (): void => { epoch += 1; schedule() }
    /** 祖先链上的动效（淡入淡出的 opacity 等）也会改写样式事实，只有碰到 stage 那一支才算。 */
    const onMotion = (event: Event): void => {
      const target = event.target
      if (!(target instanceof HTMLElement) || stage === null) return
      if (target !== stage && !target.contains(stage)) return
      invalidate()
    }
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(invalidate)
    // 主观察者：几何与祖先链样式。回调只推版本并合帧，不在回调里做任何查询。
    const mutation = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(() => {
      const next = document.getElementById(viewportId)
      if (stage !== next) {
        // stage 换人：旧舞台这一刻已经不在文档里，必须无条件把隐藏送到壳侧（不看隐藏去重标记），
        // 否则旧位置会留下一块没人认领的原生覆盖层。
        const previousTabId = this.options.nativeTabId()
        if (previousTabId !== undefined) hide(previousTabId, true)
        resize?.disconnect()
        stage = next
        if (stage !== null) resize?.observe(stage)
        last = ''
        // 新舞台可能整块换了一条祖先链，候选集与在场判据一并重读。
        candidates = [...document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)]
        recomputePresence()
      }
      invalidate()
    })
    // 弹层判据单独一个观察者：只维护候选集与「在场即让位」两个布尔量，不参与几何。
    const occlusion = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(records => {
      refreshOcclusion(records)
      epoch += 1
      schedule()
    })
    if (stage !== null) resize?.observe(stage)
    mutation?.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
      attributeFilter: STRUCTURE_ATTRIBUTES })
    occlusion?.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
      attributeFilter: OCCLUSION_ATTRIBUTES })
    window.addEventListener('resize', invalidate)
    window.addEventListener('scroll', schedule, true)
    window.visualViewport?.addEventListener('resize', invalidate)
    window.visualViewport?.addEventListener('scroll', schedule)
    for (const kind of ['transitionrun', 'transitionstart', 'transitionend', 'animationstart', 'animationend']) {
      document.addEventListener(kind, onMotion, true)
    }
    const restore = (): void => publish(true)
    document.addEventListener('visibilitychange', restore)
    window.addEventListener('pageshow', restore)
    window.addEventListener('focus', restore)
    this.publish = publish
    // 候选集与「在场即让位」两个判据各读一次，之后由遮挡观察者增量维护。
    // 读在这里而不是 mount 时立刻：挂载这一刻 DOM 可能还没就绪，观察者驱动的首帧才是权威。
    const primeOcclusion = (): void => {
      candidates = [...document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)]
      recomputePresence()
    }
    primeOcclusion()
    publish()
    const release = (): void => {
      if (!active) return
      active = false
      if (queued !== 0) window.cancelAnimationFrame(queued)
      if (lease !== undefined) window.clearTimeout(lease)
      resize?.disconnect()
      mutation?.disconnect()
      occlusion?.disconnect()
      window.removeEventListener('resize', invalidate)
      window.removeEventListener('scroll', schedule, true)
      window.visualViewport?.removeEventListener('resize', invalidate)
      window.visualViewport?.removeEventListener('scroll', schedule)
      for (const kind of ['transitionrun', 'transitionstart', 'transitionend', 'animationstart', 'animationend']) {
        document.removeEventListener(kind, onMotion, true)
      }
      document.removeEventListener('visibilitychange', restore)
      window.removeEventListener('pageshow', restore)
      window.removeEventListener('focus', restore)
      send(false)
      if (this.release === release) { this.release = undefined; this.publish = undefined }
    }
    this.release = release
    return release
  }

  /** Release observers and hide only this Session's native tab. */
  detach(): void { this.release?.() }
}
