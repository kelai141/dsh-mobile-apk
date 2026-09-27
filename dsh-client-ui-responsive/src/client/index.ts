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
 * - one drawer toggle in upstream's own header row (`conversation.header.leading`),
 *   so no control is added to the sidebar rail or the composer row;
 * - the drawer mask (`shell.overlay`), which covers the frame while it is open;
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
import { ATTACHMENT_PICKER_MENU_CSS } from './attachment-picker-menu.css.ts'
import { AttachmentPickerMenuEnhancer } from './mobile/attachment-picker-menu.ts'
import { COMPOSER_ROW_CSS } from './composer-row.css.ts'
import { COMPOSER_INSETS_CSS } from './composer-insets.css.ts'
import { TRAJECTORY_DETAILS_CSS } from './trajectory-details.css.ts'
import { TrajectoryPanelsObserver } from './trajectory-panels-observer.ts'
import { ComposerPopupGuard } from './composer-popup-guard.ts'
import { SESSION_LOG_DIALOG_HIDE_CSS } from './session-log-dialog.css.ts'
import { SessionLogDialogObserver } from './session-log-dialog-observer.ts'
import { openSessionForNotify, type SessionOpenFace } from './mobile/notify-landing.ts'
import { DevSection } from './dev-section/DevSection.tsx'
import { PhoneControlSection } from './dev-section/phone-control.tsx'
import { NotifySettingsSection } from './dev-section/notify-settings.tsx'
import { DEV_SECTION_CSS } from './dev-section/dev-section.css.ts'
import { GeneralSettings } from './general-settings/GeneralSettings.tsx'
import { ThemeBridge } from './theme-bridge.ts'
import { EnterGuard } from './enter-guard.ts'
import { KeyboardBoundary } from './keyboard-boundary.ts'
import { ExportResultChannel, reportUserFacingResult, type ExportResultPayload } from './export-result.ts'
import { MobileFormMarker } from './mobile/form-marker.ts'
import { MOBILE_FORM_CSS } from './mobile/mobile-form.css.ts'
import { MobileChrome, type MobileChromeInjected } from './mobile/MobileChrome.tsx'
import { SidebarToggle, type SidebarToggleInjected } from './mobile/SidebarToggle.tsx'
import { VENDOR_CHROME_HIDE_CSS } from './mobile/vendor-chrome-hide.css.ts'
import { EXTERNAL_OPEN_ID, externalOpenDefinition } from './mobile/external-open-paths.ts'
import { ExternalOpenTab } from './mobile/external-open.tsx'
import { SettingsDocumentAction } from './mobile/settings-document.ts'
import { ReferenceMenuEnhancer, REFERENCE_BAR_CSS } from './mobile/reference-menu.ts'
import { BackStackSignal } from './mobile/back-stack.ts'
import { MAIN_PANEL_BACK_CSS } from './mobile/main-panel-back.css.ts'
import { MainPanelBackMount } from './mobile/main-panel-back.ts'
import { PanelNavDrawer } from './mobile/panel-nav-drawer.ts'
import { SessionMarker, type SessionsFace } from './mobile/session-marker.ts'
import { BROWSER_TAB_ID, BROWSER_TAB_KIND, BrowserTab, browserTabDefinition } from './mobile/browser-tab.tsx'
import {
  BrowserAutoPlace,
  domCollapsedNow,
  domCurrentSessionId,
  type BrowserSidebarFace,
} from './mobile/browser-auto-place.ts'
import { IncomingDraftConsumer } from './mobile/incoming-draft.ts'

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
export const inject = ['slots', 'theme', 'sessions', 'workspaces', 'uiWorkspace', 'layout', 'conversation']

/** Narrow runtime face for the existing Conversation draft/upload service. */
interface IncomingConversationFace {
  /** Build-time J1 seam over the normal composer draft/upload path. */
  addFiles(sessionId: unknown, files: readonly File[]): boolean
  input: {
    for(scope: unknown): {
      notify(level: 'info' | 'error', text: string): void
    }
  }
}

/** Session service methods used by the process-local external attachment hand-off. */
interface IncomingSessionsFace {
  refresh(): Promise<void>
  open(id: unknown): void
  scope(id: unknown): unknown | undefined
}

/** Standard workspace create path used before connecting its blank Session. */
interface IncomingWorkspacesFace {
  create(input: { path: string }): Promise<{ workspaceId: unknown }>
}

/** Standard workspace navigation face; it returns a locally addressable blank session. */
interface IncomingUiWorkspaceFace {
  connectWorkspace(workspaceId: unknown): Promise<unknown>
}


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

  // The upstream paperclip keeps one hidden file input and one addFiles/upload admission path.
  // Add an upward DSH-native source menu in front of that exact input rather than a second picker
  // bridge: each row changes accept in its own user gesture, clicks the existing input, then restores it.
  ctx.effect(() => injectStyle('attachment-picker-menu', ATTACHMENT_PICKER_MENU_CSS), 'ui-responsive: attachment picker source menu styles')
  ctx.effect(() => {
    const picker = new AttachmentPickerMenuEnhancer()
    picker.attach()
    return () => { picker.detach() }
  }, 'ui-responsive: paperclip attachment/image source menu')

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

  // 通知（0.14.1 批 3 / P3-5）：提醒方式与「关掉会怎样」是每个用户都要做的决定，
  // 此前唯一入口埋在开发者选项里（对普通用户不可达）——提级为设置页一级分区。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'android-notify',
    order: 97,
    label: () => '通知',
  }, NotifySettingsSection))

  // 手机控制（0.14.0 用户定例）：把屏幕/Shizuku/虚拟屏/浮窗/无障碍/强制销毁收进独立设置页。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'android-phone-control',
    order: 98,
    label: () => '手机控制',
  }, PhoneControlSection))

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

  // Mobile chrome: the drawer mask only (0.14.2 P4 moved the toggle out of this
  // layer, see below). The mask covers the frame while the drawer is open.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'mobile-chrome',
    inject: (): MobileChromeInjected => ({
      toggleSidebar: () => { ctx.layout.toggleSidebar() },
    }),
  }, MobileChrome))

  // The drawer toggle, moved into upstream's own header row (0.14.2 P4).
  //
  // It used to live in a self-drawn 44px band ([data-dsh-mobile-topbar]) above the
  // header; the user reported that band as wasted vertical space ("这个顶部的额头太大了
  // （标题上方留空）挤占屏幕空间"). Upstream already owns a reserved, empty seat for
  // exactly this control — conversation.header.leading, a global-navigation seat
  // rendered beside the Session title (ui-conversation skeleton/ConversationHeader)
  // — so the toggle moves there and the band is gone.
  ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
    name: 'conversation.header.leading',
    inject: (): SidebarToggleInjected => ({
      toggleSidebar: () => { ctx.layout.toggleSidebar() },
    }),
  }, SidebarToggle))

  // Vendor chrome the user asked to remove (0.14.2 P5): the undo-savepoint dot.
  // See the module header for why this is a CSS override on the vendor's own
  // attribute rather than a vendor edit.
  ctx.effect(() => injectStyle('vendor-chrome-hide', VENDOR_CHROME_HIDE_CSS), 'ui-responsive: hide vendor header chrome')

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

  // Retired (0.14.2 P5): the Session-header "open in file manager" action used to
  // be registered at conversation.session.header.utilities. The user reported the
  // folder button as useless and asked for it to go away (2026-09-26), so its
  // registration is gone and no other site re-adds it. The component file stays
  // for the "open with" tab type, which still opens files through the chooser.

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

  // ── AI 浏览器：模型驱动后自动「落位」到右侧栏（0.14.0 P0-2，用户语义；0.14.1 块 D） ──────
  //
  // 用户原话：「顶栏就是浏览器标签页切换；AI 打开浏览器后应自动在侧边栏注册/切到该面板，
  // 人无需再点一下才符合语义。」随后澄清为：**收起状态下自动开窗（注册 tab），但不强制展开**
  // —— 人手动展开时就能看见已经打开的浏览器界面。
  //
  // 0.14.1 块 D（已知 issue #1）修正两处**在源码里实证**的缺陷，判据与实现见
  // `mobile/browser-auto-place.ts`（本处只做接线，不再内联策略）：
  //  A. 落位必须绑定**发起动作的会话**（壳侧 `browserHostStatus().ownerSessionId`，且只在它与
  //     `<html data-dsh-session-id>` 的当前会话一致时才动作）——读全局状态后调
  //     `ctx.sidebarRight.openTab` 会落在**上屏/焦点会话**上（跨会话污染）。
  //  B. 落位必须走**带会话的入口** `openTabIn(ownerSessionId, kind)`：`openTab` 内部第一条 op 是
  //     `planSetExpanded(state, true)`（`ui-sidebar-right/src/client/stores.ts` 的 `openContent`），
  //     收起态下调它必然强制展开。收起态一律只记 per-session `pending`。
  ctx.effect(() => {
    const placement = new BrowserAutoPlace({
      kind: BROWSER_TAB_KIND,
      status: () => window.androidBridge?.browserHostStatus?.(),
      currentSessionId: domCurrentSessionId,
      collapsed: domCollapsedNow,
      sidebar: () => (ctx.get('sidebarRight') as BrowserSidebarFace | undefined),
    })
    return placement.attach()
  }, 'ui-responsive: AI browser auto-place into right sidebar (session-addressed, deferred while collapsed)')

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
      // The selected main panel is the layout service own fact: it covers every
      // registrant of the main seat and stays null on the Conversation, where the
      // shell must still finish the activity.
      activePanelId: () => ctx.layout.panelInfo.getSnapshot().activePanelId,
      leaveMainPanel: () => { ctx.layout.selectPanel(null) },
    })
    backStack.attach()
    // A panel switch is a service change, so reconcile on it as well as on DOM mutations.
    // The same notification moves the phone drawer aside: it is a 289px off-canvas
    // overlay on the phone form, and leaving it up hides the panel it just opened -
    // including that panel's back control, which the user then cannot tap.
    const drawer = new PanelNavDrawer({
      activePanelId: () => ctx.layout.panelInfo.getSnapshot().activePanelId,
      collapseDrawer: () => { ctx.layout.toggleSidebar() },
      frame: () => document.querySelector('[data-dsh-frame]'),
    })
    const unsubscribe = ctx.layout.panelInfo.subscribe(() => {
      backStack.refresh()
      drawer.sync()
    })
    return () => {
      unsubscribe()
      backStack.detach()
    }
  }, 'ui-responsive: back-stack signal (page layers → shell back gate)')

  // FX1-C (2026-09-27, user): the sidebar 插件 row switches the centre column to
  // upstream plugin-manager main panel, which is neither a dialog nor a sidebar layer -
  // so system back finished the activity from inside it (点进去就出不来), and its list
  // root drew no back control at all (你关闭键呢). The layer above pops the page; this
  // mount injects the missing control at the list root. Upstream stays unpatched.
  ctx.effect(() => {
    const disposeStyle = injectStyle('main-panel-back', MAIN_PANEL_BACK_CSS)
    const mount = new MainPanelBackMount(() => { ctx.layout.selectPanel(null) })
    mount.attach()
    return () => {
      mount.detach()
      disposeStyle()
    }
  }, 'ui-responsive: injected back control for upstream main panels')

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

  // External open/share enters a blank temporary session with one normal file attachment draft.
  // The host queue supplies only opaque metadata; this consumer claims and streams a source only
  // after the session scope exists, then delegates attachment ownership to ui-conversation.
  ctx.effect(() => {
    document.documentElement.setAttribute('data-dsh-incoming-draft-consumer', 'active')
    // Resolve the scoped service faces only at their actual operation. Cordis may install this
    // extension before a root-scoped Conversation tracker is materialized; eager property reads
    // would abort the effect and leave the incoming queue unpolled.
    const sessions = (): IncomingSessionsFace => ctx.sessions as unknown as IncomingSessionsFace
    const workspaces = (): IncomingWorkspacesFace => ctx.get('workspaces') as IncomingWorkspacesFace
    const uiWorkspace = (): IncomingUiWorkspaceFace => ctx.get('uiWorkspace') as IncomingUiWorkspaceFace
    const conversation = (): IncomingConversationFace => ctx.conversation as unknown as IncomingConversationFace
    const consumer = new IncomingDraftConsumer(
      (path, init) => fetch(path, init),
      {
        refreshSessions: () => sessions().refresh(),
        createSession: async (cwd) => {
          document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'workspace-create')
          const workspace = await workspaces().create({ path: cwd })
          document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'workspace-created')
          document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'workspace-connect')
          const sessionId = await uiWorkspace().connectWorkspace(workspace.workspaceId)
          document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'workspace-connected')
          return String(sessionId)
        },
        openSession: (sessionId) => { sessions().open(sessionId) },
        sessionScope: (sessionId) => sessions().scope(sessionId),
        attachGenericFile: (sessionId, file) => {
          try {
            return conversation().addFiles(sessionId, [file])
          } catch {
            // The target can be released between session navigation and draft admission.
            return false
          }
        },
        notify: (scope, text) => {
          try { conversation().input.for(scope).notify('error', text) } catch { /* target scope ended */ }
        },
      },
    )
    const poll = (): void => { void consumer.poll() }
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') poll()
    }, 4000)
    const onVisible = (): void => { if (document.visibilityState === 'visible') poll() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    poll()
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      document.documentElement.removeAttribute('data-dsh-incoming-draft-consumer')
    }
  }, 'ui-responsive: blank-session external attachment drafts')

  /**
   * 壳侧 → 页面的**通知落点**通道（0.14.1 批 4 / P0-1）。
   *
   * 为什么需要它：通知点击此前只是把应用拉到前台（壳侧一直在写 `dsh.notify.*` extras 而全仓没有
   * 读取者，`MainActivity` 连 `onNewIntent` 都没有）——整族通知是单向公告板。会话视图与切换能力
   * 只在页面里，故落点必须由页面执行：壳侧把会话 id 送进来，这里调会话服务的 `open(id)`。
   *
   * 契约（壳侧 `MainActivity.deliverNotifyRoute` 依此判成败）：**同步返回 boolean**
   *   true  = 已切到该会话；false = 没找到（会话可能已被删除），壳侧据此给用户可见提示。
   * 不把异常抛出去（抛出去会在桥层被吞成 undefined，壳侧就分不清「失败」与「未实现」）。
   */
  ctx.effect(() => {
    const open = (sessionId: unknown): boolean =>
      openSessionForNotify(ctx.sessions as unknown as SessionOpenFace, sessionId)
    ;(window as unknown as Record<string, unknown>).__dshOpenSession = open
    return () => {
      delete (window as unknown as Record<string, unknown>).__dshOpenSession
    }
  }, 'ui-responsive: notification landing (openSession)')
}