/**
 * Layout plugin, browser half: one register() call contributes AppFrame into
 * the runtime's built-in 'root' slot and, in the same breath, declares the
 * four child slots (declaration = exclusive render authority), seats the
 * layout store (panel geometry), and wires the panel-action service face.
 * ctx.layout is the cross-plugin panel-action contract; navigation state lives
 * with the runtime sessions service. Later effects seat the theme presenter
 * (projecting ctx.theme snapshots onto document.body) and other UI fixes.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { PanelActions } from './service.ts'
import { AppFrame } from './AppFrame.tsx'
import { createLayoutStore } from './stores.ts'
import { LayoutController } from './service.ts'
import { ThemePresenter } from './theme-presenter.ts'
import { ThemeBridge } from './theme-bridge.ts'
import { EnterGuard } from './enter-guard.ts'
import { KeyboardBoundary } from './keyboard-boundary.ts'
import { ExportResultDialog } from './ExportResultDialog.tsx'
import { createExportResultStore, type ExportResultPayload } from './export-result.ts'
import { MOBILE_SETTINGS_CSS } from './mobile-settings.css.ts'
import { COMPOSER_MENU_CSS } from './composer-menu.css.ts'
import { COMPOSER_ROW_CSS } from './composer-row.css.ts'
import { COMPOSER_INSETS_CSS } from './composer-insets.css.ts'
import { TRAJECTORY_DETAILS_CSS } from './trajectory-details.css.ts'
import { TrajectoryPanelsObserver } from './trajectory-panels-observer.ts'
import { MenuViewportGuard } from './menu-viewport-guard.ts'
import { SESSION_LOG_DIALOG_HIDE_CSS } from './session-log-dialog.css.ts'
import { DevSection } from './dev-section/DevSection.tsx'
import { DEV_SECTION_CSS } from './dev-section/dev-section.css.ts'
import { GeneralSettings } from './general-settings/GeneralSettings.tsx'

// Contract exports only (export-convergence rule: cross-package consumers
// keep a symbol exported; test-only/package-internal symbols live off /src).
// ILayout: the ctx.layout face consumers and test fakes type against.
// OwnerShare contracts below are the render-side halves registrants compose
// against; the frame components and the store factory are package-internal.
export { LayoutController } from './service.ts'
export type { ILayout } from './service.ts'

declare global {
  interface Window {
    /** Android shell session-export outcome bridge (success / failure). */
    __dshExportResult?: (payload: ExportResultPayload) => void
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    layout: import('./service.ts').ILayout
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    // The 'root' entry itself is the runtime's built-in slot (declared
    // there); these four are the frame's children, declared by the same
    // register() call that contributes AppFrame. Session owners never pass
    // sessionId: the framework injects it as a standard prop.
    /**
     * The whole left column. OCCUPIED by ui-sidebar's SidebarRoot, which
     * declares the workspace and settings seats inside it — registering here
     * replaces the navigation column outright rather than adding to it, and
     * the seats it declares disappear with it. To add something to the
     * sidebar, register into one of those inner seats instead.
     *
     * The occupant receives the frame's live column state (collapsed, width)
     * and is expected to render the compact control rail while collapsed.
     */
    'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
    /**
     * The whole center column, across both the no-session hero and a live
     * conversation. OCCUPIED by ui-conversation's ConversationRoot, which
     * declares the session body, composer, and input seats inside it —
     * registering here replaces the entire conversation surface (and removes
     * every seat it declares) rather than adding to it.
     *
     * Current-session-optional: the occupant owns both states without
     * changing its React identity, so it keeps its own state across a session
     * switch. It receives no owner props; session facts arrive through the
     * framework hooks of the `session-maybe` scope.
     */
    'conversation': { kind: 'single'; scope: 'session-maybe'; owner: ConvOwnerProps }
    /**
     * The right details column, shown when the layout opens it. OCCUPIED by
     * ui-conversation's DetailsPanel, which declares the tool-details seat
     * inside it — registering here replaces the column and takes that seat
     * with it. Absent an occupant the column renders nothing.
     *
     * No owner props: the framework injects the session id and hooks for the
     * `session` scope, and `ctx.layout` owns whether the column is open.
     */
    'details': { kind: 'single'; scope: 'session'; owner: DetailsOwnerProps }
    /**
     * Frame-wide floating layer, above every column and outside their scroll
     * containers. Deliberately generic and unowned by any feature: a badge, a
     * toast stack or a status pill all belong here, and entries order among
     * themselves. The layer itself is click-through — entries opt back into
     * pointer events — so an occupant never blocks the app underneath.
     *
     * This is the additive seat for a frame-wide surface of your own: a fresh
     * `id` is added beside the shipped entries instead of replacing them.
     */
    'shell.overlay': { kind: 'list'; scope: 'root' }
    /**
     * Developer-options child seat (2026-08-23): feature-owned blocks under the
     *「开发者选项」section — ADB authorization panel etc. Listed like the
     * general.item seat the shell declares; registered by dsh-android-bridge.
     */
    'settings.dev.item': { kind: 'list'; scope: 'root' }
  }
}

// OwnerShare contracts — the render-side share the slot owner supplies at
// renderSlot. Registrants IMPORT these and compose their full component props
// through the four-share intersection (PropsRuntime & PropsRenderSlots &
// PropsStore & I). Conversation business state and actions arrive through
// framework-standard hooks and each registrant's inject face, not owner props.

/** Sidebar owner share: live column state from the frame's concession solve. */
export interface SidebarOwnerProps {
  /** True when the sidebar is closed (the column renders the compact control rail). */
  collapsed: boolean
  /** Rendered column width in px (SIDEBAR_COLLAPSED when collapsed). */
  width: number
}

/** Conversation owner share: business state and actions belong to the registrant. */
export interface ConvOwnerProps {}

/** Details owner share: empty — sessionId arrives as a framework-standard prop. */
export interface DetailsOwnerProps {}

/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
export const inject = ['slots', 'theme', 'sessions']

/**
 * Client plugin body: provide ctx.layout, then one register() call — AppFrame
 * into 'root' with the four child-slot declarations, the layout store seat,
 * and the inject hook that hands the store's bound actions to the service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const layout = new LayoutController()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
      // Exclusive store: the factory itself — the framework instantiates per
      // entry and delivers useStore/actions to AppFrame as standard props.
      store: createLayoutStore,
      // The hook's only side effect connects the root store to ctx.layout;
      // conversation business actions belong to their registrants.
      inject: (actions: PanelActions) => {
        layout.attachPanels(actions)
        return {}
      },
    }, AppFrame)
    return () => {
      disposeRegistration()
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService()
    }
  }, 'ui-layout: service + root registration')

  // Mobile settings-panel adaptation: the upstream settings modal is a
  // fixed 800px two-column panel; below the mobile breakpoint it is
  // re-shaped to a single column (nav strip scrolls horizontally). The
  // upstream CSS Modules class names are hashed and unreachable from here,
  // so the stylesheet targets the dialog's ARIA attributes instead.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin', 'mobile-settings')
    style.textContent = MOBILE_SETTINGS_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'ui-layout: mobile settings styles')

  // Developer options: a settings page on the upstream official
  // settings.section extension point — the shell projects the nav row from
  // the registration options, so no upstream DOM injection is needed.
  // Android shell facilities: restart engine / reload UI / console / dev log.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin', 'dev-section')
    style.textContent = DEV_SECTION_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'ui-layout: dev section styles')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'android-dev',
    order: 99,
    label: () => '开发者选项',
    // 开发者选项子区（2026-08-23）：ADB 授权面板等安卓调试设施挂进此槽——不开独立导航行。
    children: { 'settings.dev.item': { kind: 'list', scope: 'root' } },
  }, DevSection))

  // Android general-settings rows (issue #59): font-size slider + immersive
  // status-bar toggle. The upstream General section lost these two rows; the
  // shell bridges (setTextZoom / setImmersiveMode) exist and persist, the UI
  // never called them. Registered into settings.general.item with a low order
  // so the rows appear after the built-in items.
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'android-general',
    order: 90,
    label: () => 'Android 显示',
  }, GeneralSettings))

  // Composer control-row narrow fix: the 176px model pill overlaps the
  // permission pill below the 400px breakpoint; cap it on phones.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin', 'composer-row')
    style.textContent = COMPOSER_ROW_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'ui-layout: composer row narrow fix')

  // Composer insets adaptation: pad composer seat with system bottom / IME bottom.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin', 'composer-insets')
    style.textContent = COMPOSER_INSETS_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'ui-layout: composer insets adaptation')

  // Composer command-menu scroll fix: the upstream menu viewport lacks
  // flex:1, so an over-long candidate list is clipped unscrollable.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin', 'composer-menu')
    style.textContent = COMPOSER_MENU_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'ui-layout: composer menu scroll fix')

  // Trajectory local details panel (issue apk#67): on narrow screens the
  // upstream panel is confined between the timeline bar and the composer seat.
  // Overlay it full-viewport so it has real reading space (fixed escapes the
  // ledger; the panel's own body scrolls).
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin', 'trajectory-details')
    style.textContent = TRAJECTORY_DETAILS_CSS
    document.head.appendChild(style)
    // 旧 WebView 不认 :has()（#17 回归，MIUI12/Chromium 83）：class 降级路径兜底。
    const ledger = document.querySelector<HTMLElement>('[class*="ledger"]')
    const observer = new TrajectoryPanelsObserver(ledger)
    observer.attach()
    return () => {
      observer.detach()
      style.remove()
    }
  }, 'ui-layout: trajectory details full-viewport overlay + :has() fallback')

  // Mobile chrome occupies the top viewport edge; keep an upward-opening
  // command menu below it rather than hiding its first rows beneath the bar.
  ctx.effect(() => {
    const guard = new MenuViewportGuard()
    guard.attach()
    return () => { guard.detach() }
  }, 'ui-layout: mobile command menu top clearance')

  // Session-log export: the shell owns the only result dialog (success/failure
  // via window.__dshExportResult). Hide the upstream preparing/success/error
  // modal so two dialogs never stack on Android.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin', 'session-log-dialog')
    style.textContent = SESSION_LOG_DIALOG_HIDE_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'ui-layout: hide upstream session-log dialog')

  // Theme presentation: pure DOM writes from resolved snapshots — initial
  // state through the getter once, then event-driven only; no React path.
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'ui-layout: theme presenter')

  // Mobile Enter guard: on the mobile form the soft-keyboard Enter key must
  // insert a newline instead of submitting — the send button is the only
  // send channel. Desktop and command-menu/IME paths stay untouched.
  ctx.effect(() => {
    const guard = new EnterGuard()
    guard.attach()
    return () => { guard.detach() }
  }, 'ui-layout: mobile enter guard')

  // Mobile keyboard boundary (issue #57): while the IME is open the mobile
  // frame keeps its 100% height (the layout viewport does not shrink on
  // Android 16 edge-to-edge), leaving a scrollable blank band under the
  // composer. Pin the frame to the visualViewport height while an IME inset
  // is present so the blank band is clipped instead of scrolled into view.
  ctx.effect(() => {
    const boundary = new KeyboardBoundary()
    boundary.attach()
    return () => { boundary.detach() }
  }, 'ui-layout: mobile keyboard boundary')

  // Theme bridge: prefers-color-scheme → OS dark state on WebViews whose
  // media query does not track uiMode (vivo/Android 16 observed). The shell
  // pushes window.__dshThemeBridge.setDark() on Configuration changes.
  ctx.effect(() => {
    const bridge = new ThemeBridge()
    bridge.install()
    return () => { /* the hook is global and idempotent: no teardown needed */ }
  }, 'ui-layout: theme bridge')

  // Export-result dialog: the shell's session-export download finishes on a
  // background thread and reports through window.__dshExportResult. The bridge
  // dispatches a DOM event into the React tree; the dialog entry reads it from
  // the store below. Registration waits on the shell.overlay declaration
  // owned by this plugin's root entry.
  let exportActions: BoundActions<ReturnType<typeof createExportResultStore>> | undefined
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'export-result',
    store: createExportResultStore,
    inject: (actions: BoundActions<ReturnType<typeof createExportResultStore>>) => {
      exportActions = actions
      return {}
    },
  }, ExportResultDialog))

  // PRD F5 消费端（2026-08-23 补齐）：外部文件/图片 → 宿主 dsh-android-file-open 已创建
  // 强制新会话（种子消息 = @文件路径 + 上下文）。本消费端轮询 GET /api/android/file-incoming，
  // 对带 sessionId 的条目：自动切到该会话（绝不并入既有会话）→ claim 删除条目。
  // 失败重试（会话可能尚未同步进客户端列表）；非安卓宿主无该端点时静默跳过。
  ctx.effect(() => {
    const opened = new Set<string>()
    let busy = false
    const poll = async (): Promise<void> => {
      if (busy) return
      busy = true
      try {
        const r = await fetch('/api/android/file-incoming')
        if (!r.ok) return
        const j = (await r.json().catch(() => null)) as { items?: Array<{ sessionId?: string; file?: string }> } | null
        if (!j?.items) return
        for (const item of j.items) {
          if (!item.sessionId || opened.has(item.sessionId)) continue
          try {
            ctx.sessions.open(item.sessionId as never)
            opened.add(item.sessionId)
            void fetch('/api/android/file-incoming/claim', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ file: item.file }),
            }).catch(() => { /* claim 失败（条目已删/端点缺）不阻断 */ })
          } catch {
            /* 会话尚未同步进列表：下轮重试 */
          }
        }
      } catch {
        /* 端点不存在（桌面/非壳宿主）：静默 */
      } finally {
        busy = false
      }
    }
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void poll() }, 4000)
    const onVisible = (): void => { if (document.visibilityState === 'visible') void poll() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    void poll()
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, 'ui-responsive: file-incoming consumer (F5)')

  ctx.effect(() => {
    const onResult = (event: Event): void => {
      const payload = (event as CustomEvent<ExportResultPayload>).detail
      if (payload === null || typeof payload !== 'object') return
      if (typeof payload.ok !== 'boolean' || typeof payload.title !== 'string' || typeof payload.detail !== 'string') return
      exportActions?.show(payload)
    }
    const bridge = (payload: ExportResultPayload): void => {
      window.dispatchEvent(new CustomEvent('dsh:export-result', { detail: payload }))
    }
    window.__dshExportResult = bridge
    window.addEventListener('dsh:export-result', onResult)
    return () => {
      window.removeEventListener('dsh:export-result', onResult)
      delete window.__dshExportResult
    }
  }, 'ui-layout: export result dialog bridge')
}
