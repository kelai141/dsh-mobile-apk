/**
 * The drawer toggle, seated in upstream's own header row (0.14.2 P4).
 *
 * It replaced a self-drawn 44px band ([data-dsh-mobile-topbar]) that sat above the
 * header: the user reported that band as wasted vertical space ("这个顶部的额头太大了
 * （标题上方留空）挤占屏幕空间"). Upstream already reserves an empty global-navigation
 * seat beside the Session title (conversation.header.leading, kind single, scope root),
 * so the control moves there and the band is removed.
 *
 * The open state is mirrored from the frame's own data-sidebar-collapsed attribute
 * rather than owned here: the drawer keeps its own toggle inside, the marker can flip
 * the attribute on rotation, and reading it keeps aria-expanded honest without a
 * second source of truth.
 */
import { useEffect, useState } from 'react'
import { IconPanelLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { BROWSER_PENDING_ATTR } from './browser-auto-place.ts'
import css from './MobileChrome.module.css'
import { tr } from '../i18n.ts'

/** Copy follows the active UI language (see i18n.ts). */
const toggleLabel = (open: boolean): string => (open ? tr('关闭导航', 'Close navigation') : tr('打开导航', 'Open navigation'))

/** The apply-world callbacks this entry may use. */
export interface SidebarToggleInjected {
  /** Toggle the frame's left sidebar (upstream ctx.layout.toggleSidebar). */
  toggleSidebar(): void
}

/** Full props: the header-leading runtime share plus the injected toggle. */
export type SidebarToggleProps =
  & PropsRuntime<'conversation.header.leading'>
  & InjectFace<SidebarToggleInjected>

/** The frame root, tagged by the form marker; the right column identifies it before the tag lands. */
function frameElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-dsh-frame]')
    ?? document.querySelector<HTMLElement>('[data-rightbar-col]')?.parentElement
    ?? null
}

/**
 * Mirror whether the left sidebar is expanded.
 * @returns true while the frame renders the sidebar opened.
 */
function useSidebarOpen(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let frame: HTMLElement | null = null
    let frameObserver: MutationObserver | null = null
    const sync = (): void => { setOpen(frame !== null && !frame.hasAttribute('data-sidebar-collapsed')) }
    const bind = (): boolean => {
      frame = frameElement()
      if (frame === null) return false
      frameObserver = new MutationObserver(sync)
      frameObserver.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] })
      sync()
      return true
    }
    if (bind()) return () => { frameObserver?.disconnect() }
    // The frame can mount after this entry (plugin order): wait for it.
    const waitObserver = new MutationObserver(() => { if (bind()) waitObserver.disconnect() })
    waitObserver.observe(document.documentElement, { childList: true, subtree: true })
    return () => {
      waitObserver.disconnect()
      frameObserver?.disconnect()
    }
  }, [])
  return open
}

/**
 * Observe the cross-module signal "the model opened a browser tab while the sidebar
 * is collapsed" (S3-19).
 *
 * The defect: with the sidebar collapsed, a model-opened browser tab was completely
 * silent for the user - browser-auto-place only recorded the intent and waited for a
 * manual expand, with nothing on screen saying something was waiting. This turns it
 * into a badge on the sidebar toggle: the marker sits on the very button the user has
 * to press, so opening it reveals the tab.
 * @returns true while a browser tab is waiting for the drawer.
 */
function useBrowserPending(): boolean {
  const [pending, setPending] = useState(false)
  useEffect(() => {
    const sync = (): void => { setPending(document.documentElement.hasAttribute(BROWSER_PENDING_ATTR)) }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [BROWSER_PENDING_ATTR] })
    return () => { observer.disconnect() }
  }, [])
  return pending
}

/**
 * The drawer toggle for the header's leading seat.
 * @param props - runtime share and the injected toggle.
 * @returns the toggle button, with the pending-browser badge when one is waiting.
 */
export function SidebarToggle({ toggleSidebar }: SidebarToggleProps) {
  const open = useSidebarOpen()
  const browserPending = useBrowserPending()
  useEffect(() => {
    const frame = frameElement()
    frame?.setAttribute('data-dsh-header-sidebar-toggle', '')
    return () => { frame?.removeAttribute('data-dsh-header-sidebar-toggle') }
  }, [])
  return (
    <>
    <button
      type="button"
      className={css.toggle}
      data-dsh-sidebar-toggle=""
      aria-label={
        browserPending && !open
          ? tr('打开导航', 'Open navigation') + tr('（有一个浏览器标签在等你展开侧栏）', ' (a browser tab is waiting behind the sidebar)')
          : toggleLabel(open)
      }
      aria-expanded={open}
      onClick={() => { toggleSidebar() }}
    >
      <IconPanelLeftOutlineRegular size={16} />
      {/* S3-19: a badge on the toggle while a browser tab waits (not only aria). */}
      {browserPending && !open && <span className={css.badge} data-dsh-browser-badge="pending" aria-hidden="true" />}
    </button>
    {/* S3-19 kept: while a browser tab waits behind the collapsed drawer, say so in
        words beside the toggle. It renders only in that transient state, so the
        title row keeps its width the rest of the time. */}
    {browserPending && !open && (
      <span className={css.pendingHint} data-dsh-browser-pending-hint="">
        {tr('有浏览器标签待展开', 'A browser tab is ready')}
      </span>
    )}
    </>
  )
}
