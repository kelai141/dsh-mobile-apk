/**
 * Android mobile adaptation layer over the upstream frame.
 *
 * 0.2.0 de-forked this plugin: 0.1.5 turned `ui-layout` into the layout service
 * hub (`ctx.layout`, the keyed `main` panel seat, the right column's
 * track/fullscreen reporting), and the previous fork of its AppFrame had to
 * reproduce that whole surface. The plugin now keeps upstream's frame and adds
 * only what a phone needs:
 *
 * - a phone form (<768px) in CSS: the left sidebar becomes an off-canvas drawer,
 *   the centre column spans the frame, and the right Sidebar keeps upstream's own
 *   fullscreen slide-over (its threshold is the same 768px);
 * - one top-bar entry for that drawer (`shell.overlay`), so no control is added
 *   to the sidebar rail or the composer row;
 * - the native "open with" wiring: a Session-header action for the workspace
 *   directory and an `extension`-band tab type for files no preview can show;
 * - the pre-existing Android fixes (composer popups, insets, keyboard boundary,
 *   Enter guard, theme bridge, developer section, export-result dialog, external
 *   file delivery).
 *
 * Nothing here provides `ctx.layout` any more: the upstream plugin owns it, and
 * a second provider would fail the composition.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { ExportResultDialog } from './ExportResultDialog.tsx'
import { MOBILE_SETTINGS_CSS } from './mobile-settings.css.ts'
import { COMPOSER_MENU_CSS } from './composer-menu.css.ts'
import { COMPOSER_ROW_CSS } from './composer-row.css.ts'
import { COMPOSER_INSETS_CSS } from './composer-insets.css.ts'
import { TRAJECTORY_DETAILS_CSS } from './trajectory-details.css.ts'
import { TrajectoryPanelsObserver } from './trajectory-panels-observer.ts'
import { ComposerPopupGuard } from './composer-popup-guard.ts'
import { SESSION_LOG_DIALOG_HIDE_CSS } from './session-log-dialog.css.ts'
import { SessionLogDialogObserver } from './session-log-dialog-observer.ts'
import { DevSection } from './dev-section/DevSection.tsx'
import { DEV_SECTION_CSS } from './dev-section/dev-section.css.ts'
import { GeneralSettings } from './general-settings/GeneralSettings.tsx'
import { ThemeBridge } from './theme-bridge.ts'
import { EnterGuard } from './enter-guard.ts'
import { KeyboardBoundary } from './keyboard-boundary.ts'
import { ExportResultChannel, reportUserFacingResult, type ExportResultPayload } from './export-result.ts'
import { MobileFormMarker } from './mobile/form-marker.ts'
import { MOBILE_FORM_CSS } from './mobile/mobile-form.css.ts'
import { MobileChrome, type MobileChromeInjected } from './mobile/MobileChrome.tsx'
import { OpenInFileManagerAction } from './mobile/OpenInFileManagerAction.tsx'
import { EXTERNAL_OPEN_ID, externalOpenDefinition } from './mobile/external-open-paths.ts'
import { ExternalOpenTab } from './mobile/external-open.tsx'
import { SettingsDocumentAction } from './mobile/settings-document.ts'
import { ReferenceMenuEnhancer, REFERENCE_BAR_CSS } from './mobile/reference-menu.ts'
import { BackStackSignal } from './mobile/back-stack.ts'
import { SessionMarker, type SessionsFace } from './mobile/session-marker.ts'
import { BROWSER_TAB_ID, BrowserTab, browserTabDefinition } from './mobile/browser-tab.tsx'

// Contract exports only (export-convergence rule): the plugin surface is
// `apply` and `inject`; every component, marker, and helper stays internal.
export { MOBILE_FORM_MAX_WIDTH } from './mobile/form-marker.ts'

declare global {
  interface Window {
    /** Android shell session-export outcome bridge (success / failure). */
    __dshExportResult?: (payload: ExportResultPayload) => void
  }
}

/** Required services: composition, copy/theme faces, the runtime sessions, and the frame's panel actions. */
export const inject = ['slots', 'theme', 'sessions', 'layout']

/** Append one stylesheet and return its disposer. */
function injectStyle(id: string, css: string): () => void {
  const style = document.createElement('style')
  style.setAttribute('data-plugin', id)
  style.textContent = css
  document.head.appendChild(style)
  return () => { style.remove() }
}

/**
 * Client plugin body: the Android adaptation layer over the upstream frame.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // ── Phone form ──────────────────────────────────────────────────────────

  // The narrow-form stylesheet: track/drawer geometry plus the top-inset and
  // top-bar variables the other sheets consume.
  ctx.effect(() => injectStyle('mobile-form', MOBILE_FORM_CSS), 'ui-responsive: mobile form styles')

  // The mobile-form marker publishes `data-dsh-mobile-form` on <html> and tags
  // the upstream frame root, which carries no stable hook of its own.
  ctx.effect(() => {
    const marker = new MobileFormMarker()
    marker.attach()
    return () => { marker.detach() }
  }, 'ui-responsive: mobile form marker')

  // Mobile settings-panel adaptation: the upstream settings modal is a
  // fixed 800px two-column panel; below the mobile breakpoint it is
  // re-shaped to a single column (nav strip scrolls horizontally). The
  // upstream CSS Modules class names are hashed and unreachable from here,
  // so the stylesheet targets the dialog's ARIA attributes instead.
  ctx.effect(() => injectStyle('mobile-settings', MOBILE_SETTINGS_CSS), 'ui-responsive: mobile settings styles')

  // Composer control-row narrow fix: the 176px model pill overlaps the
  // permission pill below the 400px breakpoint; cap it on phones.
  ctx.effect(() => injectStyle('composer-row', COMPOSER_ROW_CSS), 'ui-responsive: composer row narrow fix')

  // Composer insets adaptation: pad composer seat with system bottom / IME bottom.
  ctx.effect(() => injectStyle('composer-insets', COMPOSER_INSETS_CSS), 'ui-responsive: composer insets adaptation')

  // Composer command-menu scroll fix: the upstream menu viewport lacks
  // flex:1, so an over-long candidate list is clipped unscrollable.
  ctx.effect(() => injectStyle('composer-menu', COMPOSER_MENU_CSS), 'ui-responsive: composer menu scroll fix')

  // Composer popups (slash menu + model menu) anchor to their trigger, not the
  // viewport: keep them inside the viewport horizontally, keep the painted card
  // as narrow as its content, and keep the first rows below the mobile top bar
  // (issue apk#135).
  ctx.effect(() => {
    const guard = new ComposerPopupGuard()
    guard.attach()
    return () => { guard.detach() }
  }, 'ui-responsive: composer popup geometry guard')

  // Trajectory local details panel (issue apk#67): on narrow screens the
  // upstream panel is confined between the timeline bar and the composer seat.
  // Overlay it full-viewport so it has real reading space (fixed escapes the
  // ledger; the panel's own body scrolls).
  ctx.effect(() => {
    const disposeStyle = injectStyle('trajectory-details', TRAJECTORY_DETAILS_CSS)
    // 旧 WebView 不认 :has()（#17 回归，MIUI12/Chromium 83）：class 降级路径兜底。
    const ledger = document.querySelector<HTMLElement>('[class*="ledger"]')
    const observer = new TrajectoryPanelsObserver(ledger)
    observer.attach()
    return () => {
      observer.detach()
      disposeStyle()
    }
  }, 'ui-responsive: trajectory details full-viewport overlay + :has() fallback')

  // Mobile Enter guard: on the mobile form the soft-keyboard Enter key must
  // insert a newline instead of submitting — the send button is the only
  // send channel. Desktop and command-menu/IME paths stay untouched.
  ctx.effect(() => {
    const guard = new EnterGuard()
    guard.attach()
    return () => { guard.detach() }
  }, 'ui-responsive: mobile enter guard')

  // Mobile keyboard boundary (issue #57): while the IME is open the frame keeps
  // its 100% height (the layout viewport does not shrink on Android 16
  // edge-to-edge), leaving a scrollable blank band under the composer. Pin the
  // frame to the visualViewport height while an IME inset is present so the
  // blank band is clipped instead of scrolled into view.
  ctx.effect(() => {
    const boundary = new KeyboardBoundary()
    boundary.attach()
    return () => { boundary.detach() }
  }, 'ui-responsive: mobile keyboard boundary')

  // Theme bridge: prefers-color-scheme → OS dark state on WebViews whose
  // media query does not track uiMode (vivo/Android 16 observed). The shell
  // pushes window.__dshThemeBridge.setDark() on Configuration changes.
  ctx.effect(() => {
    const bridge = new ThemeBridge()
    bridge.install()
    return () => { /* the hook is global and idempotent: no teardown needed */ }
  }, 'ui-responsive: theme bridge')

  // ── Developer options and Android general settings ──────────────────────

  // Developer options: a settings page on the upstream official
  // settings.section extension point — the shell projects the nav row from
  // the registration options, so no upstream DOM injection is needed.
  ctx.effect(() => injectStyle('dev-section', DEV_SECTION_CSS), 'ui-responsive: dev section styles')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'android-dev',
    order: 99,
    label: () => '开发者选项',
    // 开发者选项子区（2026-08-23）：ADB 授权面板等安卓调试设施挂进此槽——不开独立导航行。
    children: { 'settings.dev.item': { kind: 'list', scope: 'root' } },
  }, DevSection))

  // Android general-settings rows (issue #59): immersive status-bar toggle.
  // 0.13.3 (D6): the font-size slider retired — upstream ui-theme fontSize
  // (12–17px) covers it natively. The setImmersiveMode shell bridge persists,
  // and the UI registers the row at settings.general.item after the built-ins.
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'android-general',
    order: 90,
    label: () => 'Android 显示',
  }, GeneralSettings))

  // ── Frame-wide entries ──────────────────────────────────────────────────

  // Mobile chrome: the top bar holding the drawer toggle, plus its mask. This
  // is the only place the phone form adds a control.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'mobile-chrome',
    inject: (): MobileChromeInjected => ({
      toggleSidebar: () => { ctx.layout.toggleSidebar() },
    }),
  }, MobileChrome))

  // Export-result dialog: the shell's session-export download finishes on a
  // background thread and reports through window.__dshExportResult. The bridge
  // dispatches a DOM event into the React tree; the dialog entry reads it from
  // the store below. Registration waits on the shell.overlay declaration owned
  // by upstream ui-layout.
  // The dialog's state is a plain observable, not a framework store: this
  // plugin's only shared state is one dialog payload, and the slot framework
  // binds the source into `useExportResult` through the hooks compartment.
  const exportChannel = new ExportResultChannel()
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'export-result',
    inject: () => ({
      hooks: { exportResult: exportChannel },
      close: () => { exportChannel.close() },
    }),
  }, ExportResultDialog))

  // Session-log export: the shell owns the only result dialog (success/failure
  // via window.__dshExportResult). Hide the upstream preparing/success/error
  // modal so two dialogs never stack on Android.
  ctx.effect(() => injectStyle('session-log-dialog', SESSION_LOG_DIALOG_HIDE_CSS), 'ui-responsive: hide upstream session-log dialog')
  // ST-14：:has() 是主路径；旧内核把整条规则当语法错误丢弃（#17 同形态）→ class 降级路径兜底。
  ctx.effect(() => {
    const observer = new SessionLogDialogObserver()
    observer.attach()
    return () => { observer.detach() }
  }, 'ui-responsive: session-log dialog :has() fallback')

  // ── Native "open with" wiring ───────────────────────────────────────────

  // Session-header action: open the Session's workspace directory through the
  // Android system chooser. Upstream's own open-in-app split button is disabled
  // in the Android profile (its host catalog probes desktop applications).
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'android-open-in-file-manager',
    order: -10,
  }, OpenInFileManagerAction))

  // "Open with" tab type: archives, packages, and binaries the built-in
  // previews cannot render. Registered at the `extension` band, but it declines
  // whenever a builtin or extension type already welcomes the address, so a
  // future upstream renderer keeps its files.
  ctx.effect(() => {
    const tabs = ctx.get('sidebarRightTabs')
    // Without the right Sidebar (an older composition) there is no registry to
    // register into, and nothing that could ever open the type.
    if (tabs === undefined) return () => {}
    // `claimedByAnother` runs inside our own `canOpen`, and the registry's
    // ranking pass re-enters every definition (ours included): the flag makes
    // that nested pass read this type as declining, which is exactly the
    // question "does any OTHER non-fallback type claim this address".
    let ranking = false
    const claimedByAnother = (address: string): boolean => {
      if (ranking) return false
      ranking = true
      try {
        return tabs.candidates(address).some(definition =>
          definition.id !== EXTERNAL_OPEN_ID && definition.priority !== 'fallback')
      } finally {
        ranking = false
      }
    }
    return tabs.register(externalOpenDefinition(claimedByAnother))
  }, 'ui-responsive: open-with tab type')

  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: EXTERNAL_OPEN_ID,
  }, ExternalOpenTab))

  // ST-15：把「当前会话 id」发布到 DOM（工具行文件链接必须按行所属会话解析）。
  // 真源 = 客户端会话快照；注入层（host-web-compat）据此随请求带 sessionId。
  ctx.effect(() => {
    const marker = new SessionMarker(ctx.sessions as unknown as SessionsFace)
    marker.attach()
    return () => { marker.detach() }
  }, 'ui-responsive: session id marker for tool-row file links')

  // Sidebar AI browser workbench (plan §7.4 / SIDEBAR-BROWSER-PLAN; user constraint U-1):
  // the entry is a tab TYPE registered next to the upstream「工作区文件」type — its guide
  // entry is the sibling card in the same「文件」panel — and the body draws the tier report
  // served by the host half (plugins/dsh-android-browser, read-only route, plugin-side auth).
  ctx.effect(() => {
    const tabs = ctx.get('sidebarRightTabs')
    if (tabs === undefined) return () => {}
    return tabs.register(browserTabDefinition())
  }, 'ui-responsive: AI browser tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: BROWSER_TAB_ID,
  }, BrowserTab))

  // Mobile reference menu (apk #163): rows get a leading checkbox (multi-select) and a
  // directory row body drills in instead of referencing the folder; upstream keeps the
  // settle-pick for files and for the trailing chevron.
  ctx.effect(() => {
    const enhancer = new ReferenceMenuEnhancer()
    enhancer.attach()
    return () => { enhancer.detach() }
  }, 'ui-responsive: reference menu enhancer')
  // 多选条与勾选框的样式（0.13.8 修复深色适配）：集中注入，含 hover/active/焦点态与
  // prefers-color-scheme 暗色兜底（壳侧 ThemeBridge 已把该查询接到系统深浅色）。
  ctx.effect(() => injectStyle('reference-bar', REFERENCE_BAR_CSS), 'ui-responsive: reference menu bar styles')

  // Settings "open configuration file" (apk #152): the upstream action hands the document to a
  // desktop text editor, which Android does not have; claim the click and open the settings
  // document through the shell chooser instead.
  ctx.effect(() => {
    const action = new SettingsDocumentAction()
    action.attach()
    return () => { action.detach() }
  }, 'ui-responsive: settings document action takeover')

  // System back (plan §5.1): the upstream frame keeps its multi-level surfaces in
  // memory, so the shell's back callback — which must decide synchronously —
  // needs a page-side stack signal. This module owns that stack and the
  // `window.__dshBack` entry the shell calls; the shell keeps the cross-document
  // history branch (`canGoBack()`) ahead of it.
  ctx.effect(() => {
    const backStack = new BackStackSignal({
      toggleSidebar: () => { ctx.layout.toggleSidebar() },
    })
    backStack.attach()
    return () => { backStack.detach() }
  }, 'ui-responsive: back-stack signal (page layers → shell back gate)')

  // ── Bridges ─────────────────────────────────────────────────────────────

  ctx.effect(() => {
    const onResult = (event: Event): void => {
      const payload = (event as CustomEvent<ExportResultPayload>).detail
      if (payload === null || typeof payload !== 'object') return
      if (typeof payload.ok !== 'boolean' || typeof payload.title !== 'string' || typeof payload.detail !== 'string') return
      exportChannel.show(payload)
    }
    const bridge = (payload: ExportResultPayload): void => { reportUserFacingResult(payload) }
    window.__dshExportResult = bridge
    window.addEventListener('dsh:export-result', onResult)
    return () => {
      window.removeEventListener('dsh:export-result', onResult)
      delete window.__dshExportResult
    }
  }, 'ui-responsive: export result dialog bridge')

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
        // FX-205.6：插件侧端点自带鉴权（Host 白名单 + 控制令牌 / 上游浏览器会话），
        // credentials 必须显式声明 same-origin（页面 cookie 是浏览器面的凭据）。
        const r = await fetch('/api/android/file-incoming', { credentials: 'same-origin', cache: 'no-store' })
        if (!r.ok) {
          // 401/403 不再静默：否则「来件投递曾被静默 403」会以「什么都没发生」的形态复现。
          if (r.status === 401 || r.status === 403) {
            console.warn('[dsh-mobile] file-incoming unauthorized (HTTP ' + r.status + ')——来件消费已停')
          }
          return
        }
        const j = (await r.json().catch(() => null)) as { items?: Array<{ sessionId?: string; file?: string }> } | null
        if (!j?.items) return
        for (const item of j.items) {
          if (!item.sessionId || opened.has(item.sessionId)) continue
          try {
            ctx.sessions.open(item.sessionId as never)
            opened.add(item.sessionId)
            void fetch('/api/android/file-incoming/claim', {
              method: 'POST',
              credentials: 'same-origin',
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
}
