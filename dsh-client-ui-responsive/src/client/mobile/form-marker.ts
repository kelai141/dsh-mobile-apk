/**
 * Mobile-form marker: the single source of truth behind every narrow-screen
 * rule this plugin injects.
 *
 * Two DOM facts are published here:
 * - `data-dsh-mobile-form` on `<html>` mirrors the `(max-width: 767px)` media
 *   query, so stylesheets re-anchored from the retired fork's `[data-mobile]`
 *   attribute keep one gate that matches the frame's own breakpoint choices
 *   (upstream's right panel turns fullscreen below 768px of frame width).
 * - `data-dsh-frame` tags the upstream frame root. The frame carries no stable
 *   hook of its own; its right column does (`data-rightbar-col`), so the tag is
 *   written from there and re-applied whenever the frame remounts.
 * - `data-dsh-modal-open` on `<html>` when any body-level modal is up, and
 *   `data-dsh-settings-dialog` on the settings panel itself. The settings
 *   overlay renders inside the sidebar subtree, so a translated (off-canvas)
 *   ancestor would carry it off-screen; the settings panel has no attribute of
 *   its own to key a stylesheet on, only its nav/content structure, so this
 *   marker is written onto the panel element it finds.
 * - `data-dsh-settings-open` on `<html>` while that settings panel is present.
 *   The narrow-form sheet must pin the drawer (transform: none) for the
 *   settings panel alone: a descendant rule cannot key on an attribute carried
 *   by the descendant, and a :has() selector would need a Chromium 105 floor
 *   this plugin does not have. Publishing the fact on the root keeps the
 *   stylesheet a plain attribute match on every supported kernel.
 */

/** Width at or below which the phone form applies; matches upstream's 768px fullscreen threshold. */
export const MOBILE_FORM_MAX_WIDTH = 767

/** Attribute on `<html>` publishing the four-state unified device form. */
export const DEVICE_FORM_ATTR = 'data-dsh-device-form'

/** Attribute on `<html>` indicating whether mobile bubble chrome should manage the right sidebar. */
export const BUBBLE_CHROME_ATTR = 'data-dsh-bubble-chrome'

/** Unified device form states derived from (shortSide, aspectRatio, orientation). */
export type DeviceForm = 'phone-portrait' | 'phone-landscape' | 'tablet-portrait' | 'desktop-landscape'

/** Any viewport whose shorter edge is below 560 CSS px is always a phone. */
export const PHONE_SHORT_SIDE_PX = 560

/** Ultra-high-DPI elongated phones (e.g. 20:9/21:9) can exceed 560 CSS px on short edge; gate by aspect >= 2.0 below 680px so 16:9 1067x566 inset viewports keep desktop-landscape. */
export const PHONE_ELONGATED_SHORT_SIDE_PX = 680
export const PHONE_ELONGATED_ASPECT = 2.0

/**
 * Pure four-state classifier using both shortest side and aspect ratio so high-DPI
 * tall phones never get misclassified as tablets while 16:9 / 1600x900 desktop-class
 * viewports receive full PC semantics.
 */
export function classifyDeviceForm(width: number, height: number): DeviceForm {
  const w = Math.max(1, Number.isFinite(width) ? width : 1)
  const h = Math.max(1, Number.isFinite(height) ? height : 1)
  const shortSide = Math.min(w, h)
  const longSide = Math.max(w, h)
  const aspect = longSide / shortSide
  const landscape = w > h
  const isPhone = shortSide < PHONE_SHORT_SIDE_PX
    || (shortSide < PHONE_ELONGATED_SHORT_SIDE_PX && aspect >= PHONE_ELONGATED_ASPECT)
  if (isPhone) return landscape ? 'phone-landscape' : 'phone-portrait'
  return landscape ? 'desktop-landscape' : 'tablet-portrait'
}

/** Read current viewport dimensions and classify the device form. */
export function currentDeviceForm(): DeviceForm {
  const docEl = typeof document !== 'undefined' ? document.documentElement : undefined
  const w = docEl?.clientWidth || window.innerWidth || 1
  const h = docEl?.clientHeight || window.innerHeight || 1
  return classifyDeviceForm(w, h)
}

/** Desktop-landscape uses upstream's native PC tab strip; all other mobile/tablet forms use bubble chrome. */
export function usesBubbleChrome(form: DeviceForm): boolean {
  return form !== 'desktop-landscape'
}

/** Only portrait phones and explicit fullscreen mode allow the right sidebar to overlay the conversation. */
export function rightbarOverlaysConversation(form: DeviceForm, fullscreen: boolean): boolean {
  return form === 'phone-portrait' || fullscreen
}

/** Authoritative runtime check shared by SidebarBubbles and MobileWorkspaces (compatible with matchMedia test mocks). */
export function isBubbleChromeActive(mediaMatches?: boolean): boolean {
  const root = typeof document !== 'undefined' ? document.documentElement : undefined
  const published = root?.getAttribute(DEVICE_FORM_ATTR) as DeviceForm | null
  if (published === 'phone-portrait' || published === 'phone-landscape' || published === 'tablet-portrait' || published === 'desktop-landscape') {
    return usesBubbleChrome(published)
  }
  if (mediaMatches === false) return false
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  const w = (vv && vv.width > 0 ? vv.width : 0) || root?.clientWidth || window.innerWidth || 1
  const h = (vv && vv.height > 0 ? vv.height : 0) || root?.clientHeight || window.innerHeight || 1
  return usesBubbleChrome(classifyDeviceForm(w, h))
}

/** The media query the marker mirrors. */
const MOBILE_FORM_QUERY = `(max-width: ${MOBILE_FORM_MAX_WIDTH}px)`

/** Frame tag consumed by this plugin's narrow-form stylesheet. */
const FRAME_TAG = 'data-dsh-frame'

/** Settings-panel tag consumed by the mobile settings stylesheet. */
const SETTINGS_TAG = 'data-dsh-settings-dialog'

/** Root tag consumed by the narrow-form stylesheet to pin the drawer for the settings panel alone. */
const SETTINGS_OPEN_TAG = 'data-dsh-settings-open'

/** Marks the phone form and four-state device form on `<html>` and tags the upstream frame root. */
export class MobileFormMarker {
  private media: MediaQueryList | null = null
  private observer: MutationObserver | null = null
  private frame: HTMLElement | null = null
  private modal: HTMLElement | null = null

  /** Publish both facts and keep them current. */
  attach(): void {
    this.media = typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_FORM_QUERY) : null
    this.media?.addEventListener?.('change', this.syncForm)
    window.addEventListener('resize', this.syncForm)
    window.visualViewport?.addEventListener('resize', this.syncForm)
    this.syncForm()
    this.observer = new MutationObserver(this.syncDom)
    this.observer.observe(document.documentElement, { childList: true, subtree: true })
    this.syncDom()
  }

  /** Remove listeners, the observer, and both marks. */
  detach(): void {
    this.media?.removeEventListener?.('change', this.syncForm)
    this.media = null
    window.removeEventListener('resize', this.syncForm)
    window.visualViewport?.removeEventListener('resize', this.syncForm)
    this.observer?.disconnect()
    this.observer = null
    this.frame?.removeAttribute(FRAME_TAG)
    this.frame = null
    this.modal?.removeAttribute(SETTINGS_TAG)
    this.modal = null
    document.documentElement.removeAttribute('data-dsh-mobile-form')
    document.documentElement.removeAttribute(DEVICE_FORM_ATTR)
    document.documentElement.removeAttribute(BUBBLE_CHROME_ATTR)
    document.documentElement.removeAttribute('data-dsh-modal-open')
    document.documentElement.removeAttribute(SETTINGS_OPEN_TAG)
  }

  private readonly syncDom = (): void => {
    this.syncFrame()
    this.syncModal()
  }

  /**
   * Publish "a modal is up", tag the settings panel, and mirror that one
   * dialog on the root.
   *
   * Dialogs inside the frame's own overlay layer (this plugin's export-result
   * dialog) are not modals over the sidebar and never pin the drawer.
   */
  private syncModal(): void {
    const dialogs = [...document.querySelectorAll<HTMLElement>("[role='dialog'][aria-modal='true']")]
      .filter(dialog => dialog.closest('[data-shell-overlay]') === null)
    // 上游 0.2.2 把设置面板挪进了 `[data-shell-overlay]` 覆盖层（AppFrame 的 overlayLayer），
    // 于是上面那条「排除覆盖层内对话框」的过滤把它一起排掉，settings 恒为 null ⇒ 本插件整套
    // 移动设置层（列表/详情切换、返回条、移动布局）永不激活，手机上点开头像菜单里的「设置」
    // 看到的是桌面双栏布局（错位、进不去分区）。
    // 判据改用上游自己的标记 `data-shortcut-modal="settings"`（SettingsRoot.tsx:73），
    // 它不受覆盖层位置影响；旧启发式（直接子级 <nav>）保留为兜底。
    //
    // 兜底启发式必须**排除侧栏本身**（实测真机 A/B 抓到的整条缺陷链的起点）：
    // 侧栏在抽屉形态下也是 `role=dialog[aria-modal=true]`，且直接含 `<nav class=panelList>`，
    // 于是 `:scope > nav` 命中，侧栏被错打 `data-dsh-settings-dialog`。上游据此切「设置态」——
    // `panelList` 变 `flex:1 1 0%`、`footArea` 被设成 `display:none` —— 账号入口就此消失，
    // 再叠加 52px 返回条，侧栏 839→915 溢出 52px。上游切态本身是对的（设置真打开时本该隐藏
    // 账号行），错的是我们把侧栏认成了设置面板。
    // 判据：侧栏列（`class*=sidebarCol`）与带 `data-shortcut-modal` 非 settings 值的对话框一律不选。
    const isSidebarColumn = (dialog: HTMLElement): boolean =>
      dialog.className.includes('sidebarCol') || dialog.getAttribute('data-shortcut-modal') === 'sidebar'
    const settings = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"][data-shortcut-modal="settings"]')
      ?? dialogs.find(dialog => !isSidebarColumn(dialog) && dialog.querySelector(':scope > nav') !== null) ?? null
    if (settings !== this.modal) {
      this.modal?.removeAttribute(SETTINGS_TAG)
      this.modal = settings
      settings?.setAttribute(SETTINGS_TAG, '')
    }
    document.documentElement.toggleAttribute('data-dsh-modal-open', dialogs.length > 0 || settings !== null)
    document.documentElement.toggleAttribute(SETTINGS_OPEN_TAG, settings !== null)
  }

  private readonly syncForm = (): void => {
    const matches = this.media === null ? window.innerWidth <= MOBILE_FORM_MAX_WIDTH : this.media.matches
    const form = currentDeviceForm()
    document.documentElement.setAttribute(DEVICE_FORM_ATTR, form)
    document.documentElement.toggleAttribute(BUBBLE_CHROME_ATTR, usesBubbleChrome(form))
    document.documentElement.toggleAttribute('data-dsh-mobile-form', matches && form !== 'desktop-landscape')
  }

  private readonly syncFrame = (): void => {
    const frame = document.querySelector<HTMLElement>('[data-rightbar-col]')?.parentElement ?? null
    if (frame === this.frame) return
    this.frame?.removeAttribute(FRAME_TAG)
    this.frame = frame
    frame?.setAttribute(FRAME_TAG, '')
  }
}
