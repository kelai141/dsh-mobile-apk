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
import { MobileSettingsNav } from './mobile/settings-nav.ts'
import { COMPOSER_MENU_CSS } from './composer-menu.css.ts'
import { ATTACHMENT_PICKER_MENU_CSS } from './attachment-picker-menu.css.ts'
import { AttachmentPickerMenuEnhancer } from './mobile/attachment-picker-menu.ts'
import { COMPOSER_ROW_CSS } from './composer-row.css.ts'
import { COMPOSER_INSETS_CSS } from './composer-insets.css.ts'
import { TRAJECTORY_DETAILS_CSS } from './trajectory-details.css.ts'
import { TrajectoryPanelsObserver } from './trajectory-panels-observer.ts'
import { SnapshotPanelsObserver } from './snapshot-panels-observer.ts'
import { SNAPSHOT_PANELS_CSS } from './snapshot-panels.css.ts'
import { ComposerPopupGuard } from './composer-popup-guard.ts'
import { SESSION_LOG_DIALOG_HIDE_CSS } from './session-log-dialog.css.ts'
import { SessionLogDialogObserver } from './session-log-dialog-observer.ts'
import { openSessionForNotify, type SessionOpenFace } from './mobile/notify-landing.ts'
import { DevSection } from './dev-section/DevSection.tsx'
import { PhoneControlSection } from './dev-section/phone-control.tsx'
import { NotifySettingsSection } from './dev-section/notify-settings.tsx'
import { ModelCapabilitySection } from './dev-section/model-capability.tsx'
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
import { TAP_HIGHLIGHT_CSS } from './mobile/tap-highlight.css.ts'
import { TopBarFold } from './mobile/top-bar-fold.ts'
import { TOP_BAR_FOLD_CSS } from './mobile/top-bar-fold.css.ts'
import { NewSessionDrawer } from './mobile/new-session-drawer.ts'
import { SidebarSessionDismiss } from './mobile/sidebar-session-dismiss.ts'
import { SidebarReorder } from './mobile/sidebar-reorder.ts'
import { SIDEBAR_REORDER_CSS } from './mobile/sidebar-reorder.css.ts'
import { EXTERNAL_OPEN_ID, externalOpenDefinition } from './mobile/external-open-paths.ts'
import { ExternalOpenTab } from './mobile/external-open.tsx'
import { SettingsDocumentAction } from './mobile/settings-document.ts'
import { ReferenceMenuEnhancer, REFERENCE_BAR_CSS } from './mobile/reference-menu.ts'
import { BackStackSignal } from './mobile/back-stack.ts'
import { MAIN_PANEL_BACK_CSS } from './mobile/main-panel-back.css.ts'
import { MainPanelBackMount } from './mobile/main-panel-back.ts'
import { PanelNavDrawer } from './mobile/panel-nav-drawer.ts'
import { MobileSidebarGestures } from './mobile/sidebar-gestures.ts'
import { SidebarDragPreview } from './mobile/sidebar-drag-preview.ts'
import { SessionMarker, type SessionsFace } from './mobile/session-marker.ts'
import {
  BROWSER_TAB_ID, BROWSER_TAB_KIND, LEGACY_BROWSER_TAB_ID, LEGACY_BROWSER_TAB_KIND,
  BrowserTab, BrowserTabMenu, browserTabDefinition, legacyBrowserTabDefinition,
} from './mobile/browser-tab.tsx'
import { NativeBrowserPlacement } from './mobile/native-browser-auto-place.ts'
import { createBrowserControllers } from './mobile/upstream-browser/browser/BrowserController.ts'
import type { BrowserInjected } from './mobile/upstream-browser/browser/BrowserController.ts'
import { createBrowserStore } from './mobile/upstream-browser/browser/store.ts'
import { BrowserTitle } from './mobile/upstream-browser/view/BrowserTitle.tsx'
import { en as browserEn, zh as browserZh } from './mobile/upstream-browser/locales.ts'
import type { AndroidBrowserBodyProps } from './mobile/browser-tab.tsx'
import type { NativeBrowserControlsInjected } from './mobile/native-browser-adapter.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
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
  // SnapshotPanel is owned by the header actions seat, so promote that header only while it is open.
  ctx.effect(() => injectStyle('snapshot-panels', SNAPSHOT_PANELS_CSS), 'ui-responsive: snapshot panel paint')
  ctx.effect(() => {
    const observer = new SnapshotPanelsObserver()
    observer.attach()
    return () => { observer.detach() }
  }, 'ui-responsive: snapshot panel ancestor ownership')

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

  // 0.14.7-B 竖屏设置分层：设置首页（分类列表）→ 二级页（可操作设置）。列表本身仍由上游按注册
  // 顺序渲染（不硬编码、不排序、不隐藏注册项）；本容器只写层级属性 + 返回控件 + 我方自有分区的
  // 一行短说明。横屏（无 mobile-form 标记）不写任何东西，布局与行为不变。
  ctx.effect(() => {
    const nav = new MobileSettingsNav()
    nav.attach()
    return () => { nav.detach() }
  }, 'ui-responsive: mobile settings layering')

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

  // 模型能力（0.14.8 提级）：补齐非内置提供商模型的思考档位等能力。
  // 此前唯一入口埋在开发者选项里（用户 2026-10-15 反馈「设置页里没有」）——提级为一级分区。
  // 与通知设置同形：能力在、入口无。手动触发，不轮询（用户明确要求）。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'android-model-capability',
    order: 96,
    label: () => '模型能力',
  }, ModelCapabilitySection))

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

  // 0.14.7 点按蓝色蒙层：WebView 的 UA 默认 -webkit-tap-highlight-color 是 ICS 蓝，声明在 :root
  // 让它被整棵文档继承（该属性可继承），只抹这一条，不动上游的 :active 与 :focus-visible 反馈。
  ctx.effect(() => injectStyle('tap-highlight', TAP_HIGHLIGHT_CSS), 'ui-responsive: clear WebView tap highlight')

  // 0.14.7 长按拖动重排：只驱动上游既有的 DnD handler（触摸屏没有原生 drag 触发路径），
  // 不复制排序状态、不写持久化；样式只给激活反馈。
  ctx.effect(() => injectStyle('sidebar-reorder', SIDEBAR_REORDER_CSS), 'ui-responsive: sidebar reorder feedback')

  // 0.14.7 竖屏顶栏插件 UI 折叠：座位里实际挂载的插件节点整体改由浮动面板呈现（不搬 React 节点，
  // 只换座位容器自己的呈现），箭头挂上游的 [data-conversation-tabs]。横屏（无 mobile-form）不介入。
  ctx.effect(() => injectStyle('top-bar-fold', TOP_BAR_FOLD_CSS), 'ui-responsive: mobile top bar fold styles')
  ctx.effect(() => {
    const fold = new TopBarFold()
    fold.attach()
    return () => { fold.detach() }
  }, 'ui-responsive: mobile top bar fold')

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

  // Browser is an extension-band replacement; SidebarRight still owns guide, tabs and docking.
  ctx.inject(['locale', 'sidebarRight', 'sidebarRightTabs'], (scope) => {
    const namespace = 'androidSidebarBrowser'
    const t = scope.locale.bind(namespace)
    const store = createBrowserStore()
    const openTabs = scope.sidebarRight.openTabs
    const placement = new NativeBrowserPlacement({
      sessions: () => scope.sessions.list.getSnapshot().ids,
      tabs: () => openTabs.getSnapshot(),
      mounted: () => scope.sidebarRight.mounted.getSnapshot(),
      expanded: () => scope.sidebarRight.isExpanded(),
      open: session => { scope.sidebarRight.openTabIn(session, BROWSER_TAB_KIND, { revealIfOpened: false }) },
      close: (session, tabId) => { scope.sidebarRight.closeIn(session, tabId) },
      kind: BROWSER_TAB_KIND, legacyKind: LEGACY_BROWSER_TAB_KIND,
    })
    const controllers = new Map<AndroidBrowserBodyProps['sessionId'], BrowserInjected & NativeBrowserControlsInjected>()
    scope.effect(() => scope.locale.register(namespace, { zh: browserZh, en: browserEn }), 'ui-responsive.browser.copy')
    scope.effect(() => scope.sidebarRightTabs.register(browserTabDefinition(t)), 'ui-responsive.browser.type')
    scope.effect(() => scope.sidebarRightTabs.register(legacyBrowserTabDefinition(t)), 'ui-responsive.browser.legacy-type')
    for (const kind of [BROWSER_TAB_KIND, LEGACY_BROWSER_TAB_KIND]) {
      scope.effect(() => scope.sidebarRight.registerCloseHandler(kind, (session, tab) => {
        placement.for(session).closeUi(tab.id)
      }), 'ui-responsive.browser.explicit-close')
    }
    scope.effect(() => async () => {
      placement.dispose()
      await Promise.all([...controllers.values()].map(controller => controller.dispose()))
      controllers.clear()
    }, 'ui-responsive.browser.frames')
    for (const key of [BROWSER_TAB_ID, LEGACY_BROWSER_TAB_ID]) {
      scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
        name: 'sidebar.right.pane.tab', key, locale: namespace, store,
        inject: (session, actions) => {
          const existing = controllers.get(session)
          if (existing !== undefined) { existing.rebind(actions); return existing }
          const native = placement.for(session)
          const neutral = createBrowserControllers(actions, native.createPage,
            tabId => openTabs.getSnapshot().some(tab => tab.sessionId === session && tab.tabId === tabId))
          const controller: BrowserInjected & NativeBrowserControlsInjected = {
            ...neutral,
            keyedHooks: { ...neutral.keyedHooks, nativeBrowserState: native.controlSource },
            setBrowserVisible: (tabId, visible) => { native.setVisible(tabId, visible) },
            setBrowserIdentity: (tabId, desktop) => { native.setIdentity(tabId, desktop) },
            setBrowserViewport: (tabId, width, height) => { native.setViewport(tabId, width, height) },
            refreshBrowserStatus: tabId => { native.refreshStatus(tabId) },
            closeBrowserTab: tabId => { scope.sidebarRight.closeIn(session, tabId) },
          }
          controllers.set(session, controller)
          return controller
        },
      }, BrowserTab)), 'ui-responsive.browser.body')
      scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
        name: 'sidebar.right.pane.tab.title', key, store,
      }, BrowserTitle)), 'ui-responsive.browser.title')
    }
    scope.effect(() => scope.slots.inject('sidebar.right.tab.menu.item', () => scope.slots.register({
      name: 'sidebar.right.tab.menu.item', id: 'android-browser.native-controls', locale: namespace,
      inject: (session: SessionId): NativeBrowserControlsInjected => {
        const native = placement.for(session)
        return {
          keyedHooks: { nativeBrowserState: native.controlSource },
          setBrowserVisible: (tabId, visible) => { native.setVisible(tabId, visible) },
          setBrowserIdentity: (tabId, desktop) => { native.setIdentity(tabId, desktop) },
          setBrowserViewport: (tabId, width, height) => { native.setViewport(tabId, width, height) },
          refreshBrowserStatus: tabId => { native.refreshStatus(tabId) },
          closeBrowserTab: tabId => { scope.sidebarRight.closeIn(session, tabId) },
        } satisfies NativeBrowserControlsInjected
      },
    }, BrowserTabMenu)), 'ui-responsive.browser.menu')
    scope.effect(() => placement.attach(), 'ui-responsive.browser.native-tab-placement')
  })

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

  // APK #335: narrow-screen content swipes reuse the layout and right-sidebar
  // controllers. The two preferences are independent and are read at gesture
  // start, so settings changes take effect without remounting this listener.
  ctx.effect(() => {
    const right = ctx.get('sidebarRight') as { isExpanded(): boolean; toggleExpanded(): void } | undefined
    const frame = (): HTMLElement | null => document.querySelector('[data-dsh-frame]')
    // 0.14.7 实时跟手：手势源只上报展开度，屏幕位移由这个消费方落点。它自己管理内联
    // transform 的写入与清理，并在松手后交还给 CSS 过渡（见 sidebar-drag-preview.ts）。
    const preview = new SidebarDragPreview()
    const gestures = new MobileSidebarGestures({
      mobileForm: () => document.documentElement.hasAttribute('data-dsh-mobile-form'),
      leftOpen: () => {
        const root = frame()
        return root !== null && !root.hasAttribute('data-sidebar-collapsed')
      },
      rightOpen: () => right?.isExpanded() ?? false,
      mainPanelSelected: () => ctx.layout.panelInfo.getSnapshot().activePanelId !== null,
      openLeft: () => { ctx.layout.toggleSidebar() },
      // task-7：回退用的**真正收起**动作。拖动中一旦确认 open-left 意图，手势源会立刻调
      // openLeft() 让上游挂载完整抽屉内容（否则屏幕上是被平移的收起导轨，"内容不完整"）；
      // 松手不够阈值 / touchcancel / 被原生滚动抢走时，必须有一个只做"收起"的动作把它收回。
      // 不能复用 returnToConversation：那里还有 selectPanel(null)，会误伤用户选中的中栏面板。
      // 收起抽屉在本插件里本来就只有 toggleSidebar 这一条通路（见下方 NewSessionDrawer 与
      // PanelNavDrawer 的 collapseDrawer），调用前手势源已用 leftOpen() 判定过，因此不会误开。
      closeLeft: () => { ctx.layout.toggleSidebar() },
      returnToConversation: () => {
        // Settings is the one dialog nested in the drawer; dismiss its own
        // back-stack layer before collapsing the drawer and selecting session.
        const settings = document.querySelector<HTMLElement>('[data-dsh-settings-dialog]')
        if (settings !== null) {
          const consumed = window.__dshBack?.() ?? false
          if (!consumed) {
            const mask = settings.parentElement?.querySelector(':scope > [aria-hidden="true"]')
              ?? settings.querySelector(':scope > [aria-hidden="true"]')
            if (mask !== null && mask !== undefined) {
              mask.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
              mask.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
            }
          }
        }
        const root = frame()
        if (root !== null && !root.hasAttribute('data-sidebar-collapsed')) ctx.layout.toggleSidebar()
        ctx.layout.selectPanel(null)
      },
      openRight: () => { if (right !== undefined && !right.isExpanded()) right.toggleExpanded() },
      closeRight: () => { if (right?.isExpanded()) right.toggleExpanded() },
      previewLeft: preview.previewLeft,
      previewRight: preview.previewRight,
      // 手势源保证顺序是「先提交开合状态、后调 endPreview」，所以这里只撤内联位移，
      // 不改状态：清空后 CSS transition 从手指停留的位置平滑收敛到刚提交的状态。
      endPreview: preview.endPreview,
    })
    gestures.attach()
    return () => { gestures.detach() }
  }, 'ui-responsive: narrow-screen sidebar content swipes')

  // apk #349：抽屉里点「新建会话」后抽屉不收、键盘残留（用户看到的「停在抽屉里，还得手动关」）。
  // 真因：上游 replaceMain 只在 panel==='reveal' 时调 selectPanel(null)（ui-workspace navigation.ts:403），
  // 停在会话时 activePanelId 本来就是 null → 不发通知；而本插件收起抽屉的唯一通路
  // panel-nav-drawer.ts:54 只认「null → panel」那一次转变 → 抽屉无人收起。
  // 这里按 DOM 事实判定（上游 CSS Modules 保留 newSession 原名 + 必须位于 sidebarCol 内），
  // 与手势的 returnToConversation 走同一个动作（toggleSidebar），不新增第二套抽屉状态机。
  ctx.effect(() => {
    const drawer = new NewSessionDrawer({
      mobileForm: () => document.documentElement.hasAttribute('data-dsh-mobile-form'),
      drawerCollapsed: () => {
        const root = document.querySelector<HTMLElement>('[data-dsh-frame]')
        return root === null || root.hasAttribute('data-sidebar-collapsed')
      },
      collapseDrawer: () => { ctx.layout.toggleSidebar() },
    })
    drawer.attach()
    return () => { drawer.detach() }
  }, 'ui-responsive: new session from drawer collapses it')

  // 从侧栏选择已有会话：回到正文但不自动拉起软键盘，保留行内菜单与长按重排。
  ctx.effect(() => {
    const dismiss = new SidebarSessionDismiss({
      mobileForm: () => document.documentElement.hasAttribute('data-dsh-mobile-form'),
      drawerCollapsed: () => {
        const root = document.querySelector<HTMLElement>('[data-dsh-frame]')
        return root === null || root.hasAttribute('data-sidebar-collapsed')
      },
      collapseDrawer: () => { ctx.layout.toggleSidebar() },
    })
    dismiss.attach()
    return () => { dismiss.detach() }
  }, 'ui-responsive: sidebar conversation selection dismisses drawer')

  // 0.14.7（Spec §2.2）侧边栏会话行长按拖动重排。与上面的 MobileSidebarGestures 靠 DOM 属性
  // 互斥（不靠注册顺序）：重排激活期间在 <html> 打标记，R1 手势据此拒绝认领 / 中途放弃。
  ctx.effect(() => {
    const reorder = new SidebarReorder()
    reorder.attach()
    return () => { reorder.detach() }
  }, 'ui-responsive: sidebar long-press reorder')

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
