/**
 * 九键条的**接线层**：把 keymap.ts 产出的效果送到终端，并维持布局不变量。
 *
 * 通路选择（阶段 0 实测，[A]）：
 *   优先 (c) 合成 keydown 到 .xterm-helper-textarea —— 让 **xterm 自己**按当前 DECCKM 决定
 *            CSI/SS3（实测：合成 keydown 与真键产出字节完全一致；keypress/keyup/input 事件均无效）。
 *            xterm 的 onData 会把它交给上游的 model.write，我们不重复实现映射。
 *   兜底 (a) 拿不到 .xterm-helper-textarea 时，才用 [data] 直写 —— 此时**必须**先读
 *            xterm.modes.applicationCursorKeysMode 再用 fallbackSequence() 选择序列（绝不写死）。
 *
 * 为什么优先 (c) 而不是 (a)：DECCKM 会变（vim/less 打开），而 (c) 天然跟着变；(a) 每次都要自己判。
 *
 * 焦点纪律（实测结论）：合成事件只在 textarea **持有焦点**时有意义；因此按下后必须把焦点还给它，
 * 否则第二次点击会落到别处。键条本身因此使用 mousedown.preventDefault() 防抢焦点。
 */
import {
  CTRL_LATCH_TIMEOUT_MS,
  INITIAL_LATCH,
  KEYBAR_KEYS,
  KEYBAR_SPECS,
  expireLatch,
  pressKeybarKey,
  type KeyEffect,
  type KeybarKey,
  type LatchState,
} from './keymap.ts'
import {
  KEYBAR_ATTR,
  KEYBAR_CSS,
  KEYBAR_INSET_VAR,
  KEYBAR_NOTICE_ATTR,
  KEYBAR_STYLE_ID,
  TERMINAL_ROOT_SELECTOR,
  computeBottomInset,
} from './layout.ts'

/** xterm 的隐藏输入面（合成 keydown 的目标）。 */
const XTERM_TEXTAREA = '.xterm-helper-textarea'
/** 壳侧桥：可选的软键盘兜底通道。 */
interface KeybarBridge {
  showSoftInput?: () => boolean
}

/** 键条运行期的外部依赖（便于测试注入替身）。 */
export interface KeybarHost {
  /** 终端根节点（上游 [data-sidebar-terminal]）。 */
  readonly root: HTMLElement
  /** 写入终端字节的兜底通路（通路 (a)）。返回 false = 当前不可写。 */
  write(data: string): boolean
  /** 读当前 DECCKM 状态（供兜底通路选序列）。 */
  applicationCursorKeys(): boolean | undefined
  /** 可选：壳侧软键盘兜底。 */
  readonly bridge?: KeybarBridge
  /** 当前时刻（毫秒）；默认 Date.now，测试可注入。 */
  now?(): number
}

/** 键条句柄。 */
export interface KeybarHandle {
  /** 卸载：移除 DOM、CSS、监听器（幂等）。 */
  dispose(): void
  /** 当前闩锁状态（CDP 断言用）。 */
  latch(): LatchState
  /** 最近一次提示文案（CDP 断言用）。 */
  notice(): string | undefined
}

/** 文案（产品可见字符串；与 UI 同源，后续可接 locale）。 */
export const KEYBAR_TEXT = {
  noticeUnsupported: '该组合不支持：Ctrl 只能与字母或 @ [ \\ ] ^ _ ? 组合。',
  noticeKeyboardFailed: '无法唤起软键盘，请直接点终端区域。',
  noticeNoPath: '终端输入面尚未就绪，按键未发送。请点一下终端区域后重试。',
} as const

function ensureStyle(doc: Document): () => void {
  const existing = doc.getElementById(KEYBAR_STYLE_ID)
  if (existing !== null) return () => {}
  const style = doc.createElement('style')
  style.id = KEYBAR_STYLE_ID
  style.textContent = KEYBAR_CSS
  doc.head.append(style)
  return () => { style.remove() }
}

/** 读一个 CSS 变量为像素数（读不到给 0）。 */
function readPx(styles: CSSStyleDeclaration, name: string): number {
  const raw = styles.getPropertyValue(name).trim()
  if (raw === '') return 0
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : 0
}

/**
 * 给合成事件补上**旧式** keyCode / which。
 *
 * 为什么必须这样做（0.14.2 ADB 用户层实测的阻塞级缺陷）：
 *   xterm 的按键处理器靠旧式 keyCode 认键。只带 key/code 的合成 KeyboardEvent 里
 *   keyCode 与 which 都是 0，xterm 会**直接丢弃**该键 —— 现象就是「事件确实到了
 *   .xterm-helper-textarea，却没有任何 POST /api/terminal/write，终端零反应」。
 *
 * 为什么用 defineProperty 而不是构造参数：
 *   实测在 WebView 的 KeyboardEventInit 里传 { keyCode: 37 } **无效**（构造器不认这个非标准字段，
 *   结果仍是 0）。只有在实例上 defineProperty 定义 getter 才生效，which 同值。
 *
 * @param event - 待补字段的合成 keydown。
 * @param keyCode - 该键的旧式键码（非 0）。
 */
export function defineLegacyKeyFields(event: { readonly keyCode?: number }, keyCode: number): void {
  Object.defineProperty(event, 'keyCode', { get: () => keyCode, configurable: true })
  Object.defineProperty(event, 'which', { get: () => keyCode, configurable: true })
}

/**
 * 把效果送到终端。
 *
 * @param host - 终端依赖。
 * @param effect - keymap 产出的效果。
 * @returns 提示文案（无提示则 undefined）。
 */
function applyEffect(host: KeybarHost, effect: KeyEffect): string | undefined {
  if (effect.type === 'focus') {
    const doc = host.root.ownerDocument
    const textarea = host.root.querySelector<HTMLTextAreaElement>(XTERM_TEXTAREA)
      ?? doc.querySelector<HTMLTextAreaElement>(XTERM_TEXTAREA)
    // 顺序很重要（0.14.2 实测结论）：本函数在 click 处理器的**同一次用户手势内**同步执行。
    // 必须先 focus（命中「有手势」条件），再调壳侧桥兜底；反过来会白白丢掉那次手势。
    if (textarea === null || textarea === undefined) {
      // 连输入面都没有：仍然试着走桥，但无论如何都要给可见提示。
      try { host.bridge?.showSoftInput?.() } catch { /* 已是失败路径，提示优先 */ }
      return KEYBAR_TEXT.noticeKeyboardFailed
    }
    textarea.focus()
    // 三态：'ok' 桥明确成功 / 'unavailable' 没有桥 / 'failed' 桥抛错或明确返回 false。
    // 「抛错」必须算**失败**（不得当成没桥），否则用户按了没反应还不知道为什么。
    let bridgeOutcome: 'ok' | 'unavailable' | 'failed' = 'unavailable'
    if (host.bridge?.showSoftInput !== undefined) {
      try {
        bridgeOutcome = host.bridge.showSoftInput() === false ? 'failed' : 'ok'
      } catch {
        bridgeOutcome = 'failed'
      }
    }
    if (bridgeOutcome === 'failed') return KEYBAR_TEXT.noticeKeyboardFailed
    // 无桥时：focus 已落在 textarea 上（真手势下 IME 会弹出），不吓用户。
    return undefined
  }
  if (effect.type === 'reject') return KEYBAR_TEXT.noticeUnsupported
  if (effect.type !== 'send') return undefined

  // 优先通路 (c)：合成 keydown，让 xterm 自己映射（跟随 DECCKM）。
  const doc = host.root.ownerDocument
  const textarea = host.root.querySelector<HTMLTextAreaElement>(XTERM_TEXTAREA)
    ?? doc.querySelector<HTMLTextAreaElement>(XTERM_TEXTAREA)
  if (effect.xterm !== null && textarea !== null && textarea !== undefined) {
    // 焦点必须先在 textarea 上，xterm 的键盘处理才生效（实测）。
    if (doc.activeElement !== textarea) textarea.focus()
    // 事件构造器取自**该 document 自己的 window**：既避免跨帧构造器不一致，也让本层可在
    // jsdom 等自带 window 的宿主里被真实测试（裸用全局 KeyboardEvent 会 ReferenceError）。
    const view = doc.defaultView
    if (view === null) return undefined
    const event = new view.KeyboardEvent('keydown', {
      key: effect.xterm.key,
      code: effect.xterm.code,
      bubbles: true,
      cancelable: true,
      ctrlKey: effect.ctrlKey,
    })
    // 关键一步：补旧式 keyCode/which。缺了它 xterm 丢弃该键（终端零反应）。
    // 必须 defineProperty（构造参数在 WebView 里不生效）。
    defineLegacyKeyFields(event, effect.xterm.keyCode)
    textarea.dispatchEvent(event)
    return undefined
  }

  // 兜底通路 (a)：直写。**必须**按当前 DECCKM 选序列（阶段 0 实测会变）。
  const acck = host.applicationCursorKeys()
  const data = acck === undefined
    ? effect.data  // 拿不到模式：CSI 是普通模式的默认（实测当前即 CSI）
    : (acck ? (KEYBAR_SPECS[effect.key].ss3 ?? effect.data) : (KEYBAR_SPECS[effect.key].csi ?? effect.data))
  // 两条通路都不可用（无 textarea 且无兜底写回调）：必须**可见提示**，绝不静默丢键。
  return host.write(data) ? undefined : KEYBAR_TEXT.noticeNoPath
}

/**
 * 挂载九键条。
 *
 * @param host - 终端依赖（根节点、兜底写通路、模式读取）。
 * @returns 句柄；dispose 幂等。
 */
export function mountKeybar(host: KeybarHost): KeybarHandle {
  const doc = host.root.ownerDocument
  const now = host.now ?? (() => Date.now())
  const disposeStyle = ensureStyle(doc)

  let state: LatchState = INITIAL_LATCH
  let notice: string | undefined
  let latchTimer: number | null = null
  let disposed = false

  const bar = doc.createElement('div')
  bar.setAttribute(KEYBAR_ATTR, '')

  const noticeEl = doc.createElement('p')
  noticeEl.setAttribute(KEYBAR_NOTICE_ATTR, '')
  noticeEl.setAttribute('role', 'status')
  noticeEl.hidden = true

  const buttons = new Map<KeybarKey, HTMLButtonElement>()
  for (const key of KEYBAR_KEYS) {
    const spec = KEYBAR_SPECS[key]
    const button = doc.createElement('button')
    button.type = 'button'
    button.textContent = spec.label
    button.setAttribute('aria-label', spec.ariaLabel)
    button.dataset.key = key
    // 防抢焦点：键条点击不得把焦点从 xterm 的 textarea 上夺走（否则通路 (c) 失效）。
    button.addEventListener('mousedown', (event) => { event.preventDefault() })
    button.addEventListener('click', () => { onPress(key) })
    buttons.set(key, button)
    bar.append(button)
  }

  const syncLatch = (): void => {
    for (const [key, button] of buttons) {
      button.dataset.latched = String(key === 'ctrl' && state.latched)
    }
    if (latchTimer !== null) { doc.defaultView?.clearTimeout(latchTimer); latchTimer = null }
    if (state.latched && state.expiresAtMs !== null) {
      const delay = Math.max(0, state.expiresAtMs - now())
      latchTimer = doc.defaultView?.setTimeout(() => {
        latchTimer = null
        apply(expireLatch(state, now()))
      }, delay) ?? null
    }
  }

  const setNotice = (text: string | undefined): void => {
    notice = text
    noticeEl.textContent = text ?? ''
    noticeEl.hidden = text === undefined
  }

  const apply = (outcome: { state: LatchState; effects: readonly KeyEffect[] }): void => {
    state = outcome.state
    let nextNotice: string | undefined
    for (const effect of outcome.effects) {
      const produced = applyEffect(host, effect)
      if (produced !== undefined) nextNotice = produced
    }
    setNotice(nextNotice)
    syncLatch()
    // 未产生新提示时，清掉上一轮的提示（避免「不支持」长期挂着）。
    if (nextNotice === undefined) setNotice(undefined)
  }

  const onPress = (key: KeybarKey): void => {
    if (disposed) return
    // 每次按键先收敛过期闩锁（纯函数），避免阈值判定散在 UI 里。
    const expired = expireLatch(state, now())
    if (expired.effects.length > 0) state = expired.state
    apply(pressKeybarKey(state, key, now()))
  }

  /** 当前承载留白变量的终端根节点（换根/卸载时要清掉旧的那份）。 */
  let insetHost: HTMLElement | null = null

  /**
   * 底边留白：见 layout.ts 的 computeBottomInset 判据（自足量 + 系统条/安全区）。
   *
   * 0.14.2-fx-1：视觉视口的 offsetTop 必须一起读。壳侧把 IME 吸收进布局尺寸后，
   * 键条的自然底边就是布局视口底边，判据要拿它与**视觉**底边（offsetTop + height）比；
   * 漏掉 offsetTop 会在「布局视口没缩但浏览器平移了内容」的内核上留下一条空白带。
   *
   * 变量写在**终端根节点**上，不是键条上（0.14.2 真机缺陷实修的关键一步）：
   * 自定义属性只向**后代**继承，写在键条上祖先读不到，于是
   * `[data-sidebar-terminal]{padding-bottom:var(...)}` 恒为 0。留白必须由承载者
   * （根节点）拥有，这样它才是**根节点自己的 padding**（在盒内、无背景 -> 露出页面底色），
   * 而不是键条自己的 padding（在盒内但有背景 -> 涂成一大片灰）。
   *
   * @param host - 当前终端根节点（留白的承载者）。
   */
  const syncInset = (host: HTMLElement): void => {
    if (disposed) return
    const view = doc.defaultView
    if (view === null) return
    const styles = view.getComputedStyle(doc.documentElement)
    // env(safe-area-inset-bottom) 无法直接读；用同一个 computed style 上的自定义属性近似：
    // 壳侧已把安全区并入 --dsh-android-system-bottom（见 composer-insets 口径）。
    const inset = computeBottomInset({
      safeAreaBottom: 0,
      shellSystemBottom: readPx(styles, '--dsh-android-system-bottom'),
      shellImeBottom: readPx(styles, '--dsh-android-ime-bottom'),
      visualViewportHeight: view.visualViewport?.height ?? view.innerHeight,
      visualViewportOffsetTop: view.visualViewport?.offsetTop ?? 0,
      layoutViewportHeight: view.innerHeight,
    })
    if (insetHost !== null && insetHost !== host) insetHost.style.removeProperty(KEYBAR_INSET_VAR)
    insetHost = host
    host.style.setProperty(KEYBAR_INSET_VAR, inset + 'px')
  }

  /** 自愈挂载：键条必须是 .root 的最后一个子节点（保证「终端底边 <= 键条顶边」）。 */
  const reconcile = (): void => {
    if (disposed) return
    const roots = doc.querySelectorAll<HTMLElement>(TERMINAL_ROOT_SELECTOR)
    const current = roots[roots.length - 1]
    if (current === undefined) {
      bar.remove()
      noticeEl.remove()
      if (insetHost !== null) { insetHost.style.removeProperty(KEYBAR_INSET_VAR); insetHost = null }
      return
    }
    // 挂在最后：终端 .screen 是 flex:1，键条 flex:none 在流内 -> 不遮挡。
    if (bar.parentElement !== current || current.lastElementChild !== noticeEl) {
      current.append(bar)
      current.append(noticeEl)
    }
    syncInset(current)
  }

  // visualViewport 兜底：resize **与** scroll 双监听（只监听 resize 会漏掉 offsetTop 变化）。
  const view = doc.defaultView
  const onViewport = (): void => { reconcile() }
  view?.visualViewport?.addEventListener('resize', onViewport)
  view?.visualViewport?.addEventListener('scroll', onViewport)
  view?.addEventListener('resize', onViewport)

  // 上游 .root 的子列表会随状态分支重建，可能摘掉我们手动插入的节点 -> 观察并挂回。
  const MutationObserverCtor = view === null || view === undefined ? undefined : view.MutationObserver
  const observer = typeof MutationObserverCtor === 'function'
    ? new MutationObserverCtor(() => { reconcile() })
    : null
  observer?.observe(doc.body, { childList: true, subtree: true })

  syncLatch()
  reconcile()

  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      if (latchTimer !== null) { view?.clearTimeout(latchTimer); latchTimer = null }
      observer?.disconnect()
      view?.visualViewport?.removeEventListener('resize', onViewport)
      view?.visualViewport?.removeEventListener('scroll', onViewport)
      view?.removeEventListener('resize', onViewport)
      bar.remove()
      noticeEl.remove()
      // 留白变量挂在根节点上：卸载必须清掉，否则下一个键条会继承一个陈旧的非零留白。
      if (insetHost !== null) { insetHost.style.removeProperty(KEYBAR_INSET_VAR); insetHost = null }
      disposeStyle()
    },
    latch: () => state,
    notice: () => notice,
  }
}

/** 供 UI/CDP 断言复用的常量导出（避免两处各写一份）。 */
export const KEYBAR_TIMEOUT_MS = CTRL_LATCH_TIMEOUT_MS

/** 每个终端根一个键条的句柄表（以 DOM 节点为键，根消失即卸载）。 */
export interface KeybarWatchHandle {
  /** 当前已挂载的键条数量（CDP 断言用）。 */
  count(): number
  /** 全部卸载（幂等）。 */
  dispose(): void
}

/**
 * 监视页面上的终端根，为每一个挂载一条键条（终端 tab 打开即出现，关闭即消失）。
 *
 * 为什么要「每个根一条」而不是全局一条：终端 tab 可以分栏（上游 dockkit 支持 split），
 * 此时页面上会同时存在多个 [data-sidebar-terminal]；每条键条必须绑在自己那棵根上，
 * 否则会给错误的终端发键。
 *
 * @param deps - 终端根查询范围与可选的兜底写通路。
 * @returns 监视句柄。
 */
export function watchTerminalKeybars(deps: {
  readonly doc?: Document
  readonly bridge?: KeybarBridge
  /**
   * 兜底通路 (a) 的写回调；给不出时该根只走通路 (c)。
   * 返回 undefined 表示「本根没有兜底通路」，此时若 textarea 也缺失会给出可见提示。
   */
  resolveWrite?(root: HTMLElement): ((data: string) => boolean) | undefined
  resolveApplicationCursorKeys?(root: HTMLElement): boolean | undefined
} = {}): KeybarWatchHandle {
  const doc = deps.doc ?? document
  const mounted = new Map<HTMLElement, KeybarHandle>()

  const reconcile = (): void => {
    const roots = [...doc.querySelectorAll<HTMLElement>(TERMINAL_ROOT_SELECTOR)]
    for (const [root, handle] of mounted) {
      if (!roots.includes(root)) { handle.dispose(); mounted.delete(root) }
    }
    for (const root of roots) {
      if (mounted.has(root)) continue
      const write = deps.resolveWrite?.(root)
      mounted.set(root, mountKeybar({
        root,
        // 无兜底通路时返回 false 并让上层给提示（绝不静默丢键）。
        write: write ?? (() => false),
        applicationCursorKeys: () => deps.resolveApplicationCursorKeys?.(root),
        bridge: deps.bridge,
      }))
    }
  }

  const ObserverCtor = doc.defaultView?.MutationObserver
  const observer = ObserverCtor === undefined ? null : new ObserverCtor(() => { reconcile() })
  observer?.observe(doc.body, { childList: true, subtree: true })
  reconcile()

  return {
    count: () => mounted.size,
    dispose(): void {
      observer?.disconnect()
      for (const handle of mounted.values()) handle.dispose()
      mounted.clear()
    },
  }
}
