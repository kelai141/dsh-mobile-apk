/**
 * Visible back control for upstream's global main panels (0.14.2 FX1-C).
 *
 * The defect (user, 2026-09-27): "这个左侧菜单栏里的新增选项没有返回键，没有深度层级，
 * 点进去就出不来" — the sidebar's "插件" row switches the centre column to upstream's
 * plugin-manager main panel, and that page's list root draws a head row (title,
 * refresh, "add plugin") with **no** way back. Upstream is a read-only checkout here,
 * so the control is injected from this package instead of patching the page.
 *
 * Where the page already has its own control, this module stays out of the way: the
 * package/item/row detail levels each render a crumb button in their `DetailTop`
 * (PluginManagerPage.tsx), which pops one level. Only the list root lacks one, so only
 * the list root gets our button. That keeps each level's own control authoritative and
 * stops a second back affordance from appearing on a level that has one.
 *
 * The page is React-owned: it re-renders on every poll, install, and navigation, and
 * React may drop an externally-inserted node at any commit. Mounting is therefore a
 * reconcile loop over a MutationObserver (the attachment-picker-menu precedent), never
 * a one-shot insert: a button React removed is re-inserted on the next batch, and a
 * button whose level gained its own crumb is removed again.
 *
 * 2026-11-13 (user, screenshot): "插件页面左上角不是返回而是打开左侧的抽屉". Two
 * independent causes, both fixed here:
 *  - the head was resolved with `:scope > header[data-window-drag]`, i.e. it had to be a
 *    **direct child** of the panel. Upstream renders `section[data-plugin-panel] >
 *    div[data-plugin-body] > div[data-plugin-bar] > header[data-window-drag]`, so that
 *    selector matched nothing on the list root and the control never mounted. The tests
 *    kept passing because their fixture used the flat shape (fixture drift: the test
 *    encoded a structure upstream never had);
 *  - with the conversation header gone, this package's own drawer toggle unmounts too,
 *    which un-hides upstream's floating `[data-sidebar-opener]` — so the top-left corner
 *    fell back to "open the drawer" on a page whose only sane exit is "back".
 *
 * Both are now stated as attributes instead of structure: the resolved head is tagged
 * `data-dsh-main-panel-head` and the frame `data-dsh-main-panel-open`, and the two style
 * sheets key on those tags.
 *
 * 2026-11-14 (user, screenshot): "去掉最左侧的打开侧边栏与返回，只保留自带的黑色加粗
 * 字体的放到左上角" — that feedback was about the **"更多 / 实验性插件"** level, which
 * carries upstream's own `moreBack` chevron, and the second round ("你将自带的返回也给
 * 删除了，这会导致无法返回上级界面") was about keeping that chevron. The control keeps its
 * job and loses its face **on that level only**.
 *
 * issue #1785 (user): the plugin **list root** had no visible exit at all. The
 * `display: none` above had been written unconditionally, so it also hid the injected
 * button on the list root — which has no `moreBack` (that chevron only exists in the
 * deeper sub-view). The button was in the DOM but unpaintable, and the only thing left
 * in the corner was ☰, which opens the drawer instead of going back. Two paired fixes:
 *  - `main-panel-back.css.ts` narrows the hide to `[data-dsh-main-panel-more]`, so the
 *    list root paints the button — that is the level's visible exit;
 *  - the frame tag below now follows "this screen has a visible back control" instead of
 *    "this screen owns upstream's control", so ☰ yields on the list root too. Two
 *    controls must not fight for the same corner.
 *
 * The premise of the 2026-11-14 second round was "there is no visible back control"; with
 * the button painted, the premise flips. Levels where this module injects nothing (the
 * detail levels, whose crumb is authoritative) still keep ☰.
 */
import { strokeArrow } from './settings-nav.ts'

const PANEL_SELECTOR = '[data-plugin-panel]'
/** The page head row. `data-window-drag` separates it from the intro/status siblings. */
const HEAD_SELECTOR = 'header[data-window-drag]'
/**
 * The section title inside the head we want.
 *
 * Only the main page head carries it (`h1.pageTitle[data-plugin-header-part="title"]`).
 * The "实验性插件 → 更多" sub-view renders its own `header[data-window-drag]` with a back
 * crumb but no title part, so this doubles as "the level that has no control of its own".
 */
const HEAD_TITLE_SELECTOR = '[data-plugin-header-part="title"]'
/** Marker on the head we decorate, so the style sheet never restates the structure. */
export const MAIN_PANEL_HEAD_ATTR = 'data-dsh-main-panel-head'
/** Marker on the frame while a main panel owns the screen (hides the drawer opener). */
export const MAIN_PANEL_OPEN_ATTR = 'data-dsh-main-panel-open'
/**
 * Marker on the panel while it presents the "更多" sub-view (a head that carries its own
 * back control).
 */
export const MAIN_PANEL_MORE_ATTR = 'data-dsh-main-panel-more'
/** Our control. Read by back-stack.ts as the list level's own closure. */
export const MAIN_PANEL_BACK_ATTR = 'data-dsh-main-panel-back'
/**
 * One detail level of the plugin manager (package, ledger item, configurable row).
 *
 * Shared with back-stack.ts so the two cannot drift: this module hides its button while
 * one is present, and the stack pops that level through the crumb instead.
 */
export const PANEL_DETAIL_SELECTORS = [
  '[data-plugin-detail]',
  '[data-plugin-item-detail]',
  '[data-plugin-row-detail]',
] as const
/** The phone form gate (mobile/form-marker.ts); the control is a phone affordance. */
const MOBILE_FORM_ATTR = 'data-dsh-mobile-form'
/** The frame root, tagged by the form marker; the right column identifies it before the tag lands. */
const FRAME_SELECTOR = '[data-dsh-frame]'
/**
 * The head row that carries the section title, at any depth inside the panel.
 *
 * Not `:scope > header`: upstream nests it under `pageBody > pageBar`, and a structural
 * selector that assumes otherwise fails silently (no control, no error, no test red).
 *
 * @param panel - the plugin-manager page root.
 * @returns the head to decorate, or null when this level has no title head of its own.
 */
function resolvePageHead(panel: HTMLElement): HTMLElement | null {
  for (const head of panel.querySelectorAll<HTMLElement>(HEAD_SELECTOR)) {
    if (head.querySelector(HEAD_TITLE_SELECTOR) !== null) return head
  }
  // 「更多」（实验性插件）视图的头：没有 title part，但它是 panel 的直接子 header，
  // 也就是那一屏的标题行。两屏都要打标记 —— 样式表靠标记收上边距、排标题。
  return panel.querySelector<HTMLElement>(`:scope > ${HEAD_SELECTOR}`)
}

/** Whether the plugin-manager page is presenting one of its detail levels. */
function detailLevelPresent(panel: Element): boolean {
  return PANEL_DETAIL_SELECTORS.some(selector => panel.querySelector(selector) !== null)
}

/**
 * Mounts the list root's back control into the plugin-manager page head.
 *
 * `attach` starts the reconcile loop; `detach` removes the observer and every control
 * this instance mounted, so a hot unload leaves no orphan button behind.
 */
export class MainPanelBackMount {
  private observer: MutationObserver | null = null
  private scheduled = false
  private attached = false
  private readonly mounted: HTMLButtonElement[] = []
  /** The head carrying our marker, so it is cleared exactly (never by re-deriving). */
  private markedHead: HTMLElement | null = null
  private readonly leave: () => void

  /** @param leave - return to the Conversation (upstream `ctx.layout.selectPanel(null)`). */
  constructor(leave: () => void) {
    this.leave = leave
  }

  /** Start reconciling; safe to call twice. */
  attach(): void {
    if (this.attached) return
    this.attached = true
    try {
      this.observer = new MutationObserver(() => { this.schedule() })
      // childList covers the button and its page appearing/disappearing (React commits).
      // The form attribute must be observed too: it is what gates this control, and it
      // flips on rotation with no childList mutation at all - attributeFilter keeps
      // unrelated attribute churn (streaming class/style writes) out of the path.
      this.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [MOBILE_FORM_ATTR],
      })
      this.sync()
    } catch (error) {
      // Phone-runtime guard: a convenience control must never abort the plugin body.
      console.warn('[dsh-main-panel-back] attach failed; the page keeps its own controls', error)
    }
  }

  /** Stop reconciling and remove this instance's controls. */
  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.observer?.disconnect()
    this.observer = null
    this.scheduled = false
    this.clear()
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.attached) this.sync()
    })
  }

  /** Drop every face this instance wrote: the buttons, the head marker, the frame marker. */
  private clear(): void {
    for (const button of this.mounted) button.remove()
    this.mounted.length = 0
    this.markedHead?.removeAttribute(MAIN_PANEL_HEAD_ATTR)
    this.markedHead?.closest(PANEL_SELECTOR)?.removeAttribute(MAIN_PANEL_MORE_ATTR)
    this.markedHead = null
    document.querySelector(FRAME_SELECTOR)?.removeAttribute(MAIN_PANEL_OPEN_ATTR)
  }

  /**
   * Reconcile our controls with the live page.
   *
   * Cheap-exit first: with nothing mounted and no panel in the mutated batch this pass
   * does no document-wide query at all.
   */
  private sync(): void {
    if (this.mounted.length === 0 && document.querySelector(PANEL_SELECTOR) === null) return
    try {
      for (let index = this.mounted.length - 1; index >= 0; index -= 1) {
        const button = this.mounted[index]!
        // React replaced the head row, or the level gained its own crumb: drop ours.
        if (!button.isConnected) this.mounted.splice(index, 1)
      }
      const mobileForm = document.documentElement.hasAttribute(MOBILE_FORM_ATTR)
      const panel = document.querySelector<HTMLElement>(PANEL_SELECTOR)
      const head = panel === null ? null : resolvePageHead(panel)
      const wanted = mobileForm && head !== null && panel !== null && !detailLevelPresent(panel)
      if (!wanted) {
        this.clear()
        return
      }
      // The head is tagged once and re-tagged only when React swapped it out; the marker
      // is what the style sheet reads, so it must never outlive the page it belongs to.
      if (this.markedHead !== head) {
        this.markedHead?.removeAttribute(MAIN_PANEL_HEAD_ATTR)
        head.setAttribute(MAIN_PANEL_HEAD_ATTR, '')
        this.markedHead = head
      }
      // 「更多」（实验性插件）视图的页头是 panel 的直接子 header，自带上游 moreBack：
      // 标记要打（样式据此收上边距、排标题），但不再造第二枚返回键 ——
      // 用户 2026-11-14：「你将自带的返回也给删除了…无法返回上级界面」，那一屏只能有一个返回。
      const ownsControl = head.parentElement === panel
      if (ownsControl) {
        if (!panel.hasAttribute(MAIN_PANEL_MORE_ATTR)) panel.setAttribute(MAIN_PANEL_MORE_ATTR, '')
        for (const button of this.mounted) button.remove()
        this.mounted.length = 0
      } else {
        panel.removeAttribute(MAIN_PANEL_MORE_ATTR)
        for (const button of this.mounted) {
          if (button.parentElement !== head) head.insertBefore(button, head.firstChild)
        }
        if (this.mounted.length === 0) {
          const button = this.createButton()
          head.insertBefore(button, head.firstChild)
          this.mounted.push(button)
        }
      }
      // 抽屉开关的判据是「这一屏**有没有可见的返回控件**」，不是「这一屏是不是主面板」：
      //  - 「更多」屏靠上游 moreBack（ownsControl，本模块不造第二枚键）；
      //  - 主列表页靠我们注入的按钮（this.mounted 非空）。
      // issue #1785：这两者此前被写成了同一个条件（只要 ownsControl），所以列表页即使挂上
      // 了注入键也不会让 ☰ 让位 —— 两个控件抢同一块位置。issue 的修法以「返回键可见」为
      // 前提，前提成立就必须让位。2026-11-14 第二轮反馈「删了返回就卡住」说的是当时
      // **没有可见返回键**，与这里不冲突：没有可见返回控件时（例如详情层，我们根本不挂）
      // 仍然保留 ☰。
      const frame = document.querySelector(FRAME_SELECTOR)
      if (frame !== null) {
        const visibleControl = ownsControl || this.mounted.length > 0
        if (visibleControl) {
          if (!frame.hasAttribute(MAIN_PANEL_OPEN_ATTR)) frame.setAttribute(MAIN_PANEL_OPEN_ATTR, '')
        } else {
          frame.removeAttribute(MAIN_PANEL_OPEN_ATTR)
        }
      }
    } catch (error) {
      console.warn('[dsh-main-panel-back] sync failed; the page keeps its own controls', error)
    }
  }

  private createButton(): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute(MAIN_PANEL_BACK_ATTR, '')
    button.setAttribute('aria-label', document.documentElement.lang.toLowerCase().startsWith('zh')
      ? '返回会话'
      : 'Back to conversation')
    button.appendChild(strokeArrow('M11 4 6 9l5 5'))
    button.addEventListener('click', (event) => {
      event.preventDefault()
      this.leave()
    })
    return button
  }
}
