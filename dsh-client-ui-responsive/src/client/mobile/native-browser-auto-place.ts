/** Reconcile native AI-created/closed tabs with the official Sidebar occurrence inventory. */
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SidebarRightOpenTab } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { BROWSER_PENDING_ATTR } from './browser-auto-place.ts'
import { NativeBrowserSession } from './native-browser-adapter.ts'

/**
 * 前台轮询周期（毫秒）。
 *
 * 审计 §7.2 之前是裸的 `setInterval(tick, 1000)`：与「这一拍有没有事要做」无关。
 * 现在周期语义不变，只把「要不要排下一拍」收进 [NativeBrowserPlacement.schedule]。
 */
const POLL_INTERVAL_MS = 1000

/** All navigation callbacks are captured by the browser registration's injected services. */
export interface NativeBrowserPlacementOptions {
  /**
   * 工作区里的全部会话。
   *
   * 审计 §7.2 之后**不再参与轮询**：既没有本插件 GUI 挂载点、也不是上屏会话的会话，
   * 在本模块的每条路径上都到不了任何写操作（见 [NativeBrowserPlacement.polled]），
   * 并进 ids 只换来每秒一次跨桥往返，且随会话数线性增长。字段保留是为了不改调用方。
   */
  readonly sessions: () => readonly SessionId[]
  readonly tabs: () => readonly SidebarRightOpenTab[]
  readonly mounted: () => SessionId | undefined
  readonly expanded: () => boolean
  readonly open: (session: SessionId) => void
  readonly close: (session: SessionId, tabId: TabId) => void
  readonly kind: string
  readonly legacyKind: string
}

/** One workspace per Session; HMR disposes attachments, never native workspace contents. */
export class NativeBrowserPlacement {
  private readonly workspaces = new Map<SessionId, NativeBrowserSession>()
  private readonly pending = new Map<SessionId, Map<string, TabId>>()
  private timer: number | undefined
  private attached = false
  private disposed = false

  constructor(private readonly options: NativeBrowserPlacementOptions) {}

  /** @param session - owning Session. @returns stable native adapter for that Session. */
  for(session: SessionId): NativeBrowserSession {
    if (this.disposed) throw new Error('browser-placement-disposed')
    let workspace = this.workspaces.get(session)
    if (workspace === undefined) {
      workspace = new NativeBrowserSession(session)
      this.workspaces.set(session, workspace)
      // A new workspace is new interest: the poll may have parked itself as idle.
      this.wake()
    }
    return workspace
  }

  /**
   * Restart the loop after it parked itself idle.
   *
   * [schedule] stops rescheduling when nothing can change (see [needsPolling]); every entry point
   * that creates new interest has to call this or the loop would never come back.
   */
  wake(): void {
    if (this.disposed || !this.attached) return
    this.schedule()
  }

  /** Start discovery without expanding another Session or a collapsed column. */
  attach(): () => void {
    if (this.disposed || this.attached) return () => {}
    this.attached = true
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    this.tick()
    this.schedule()
    return () => { this.dispose() }
  }

  /** Hide attachments and stop discovery; explicit close remains a separate operation. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.attached = false
    if (this.timer !== undefined) window.clearTimeout(this.timer)
    this.timer = undefined
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    for (const workspace of this.workspaces.values()) workspace.dispose()
    this.workspaces.clear()
    this.pending.clear()
    document.documentElement.removeAttribute(BROWSER_PENDING_ATTR)
  }

  /**
   * 自排下一拍。
   *
   * 审计 §7.2：由 `setInterval` 改成自续的 `setTimeout`，是为了能在**后台不排下一拍** ——
   * 被切到后台的 WebView 每秒跨桥一次纯属白烧（页面不可见时落位也没有意义）。
   * 回前台由 `visibilitychange` 补一拍再恢复自排，见 [onVisibilityChange]。
   */
  private schedule(): void {
    if (this.disposed || !this.attached || this.timer !== undefined) return
    this.timer = window.setTimeout(() => {
      this.timer = undefined
      this.tick()
      if (!document.hidden && this.needsPolling()) this.schedule()
    }, POLL_INTERVAL_MS)
  }

  /**
   * Whether another pass could possibly do anything.
   *
   * Two cases need the loop: a workspace this plugin already owns native state for (it can hold
   * bindings that a native close must remove, or a pending claim), and any Session with a pending
   * claim. Everything else is idle, and an idle page must not cross the bridge: the call is
   * synchronous on the page thread and the shell answers it on its main thread.
   * @returns true when the next tick has a reason to exist.
   */
  private needsPolling(): boolean {
    if (this.pending.size > 0) return true
    if (this.options.mounted() !== undefined) return true
    for (const workspace of this.workspaces.values()) if (workspace.hasNativeInterest()) return true
    return false
  }

  /** 回前台立刻补一拍；后台里停表（见 [schedule]）。 */
  private readonly onVisibilityChange = (): void => {
    if (document.hidden) return
    this.tick()
    this.schedule()
  }

  /** 本插件负责的 GUI 挂载点（当前 kind 及其历史别名）。 */
  private isBrowserTab(tab: SidebarRightOpenTab): boolean {
    return tab.kind === this.options.kind || tab.kind === this.options.legacyKind
  }

  /**
   * 本拍需要打原生桥的会话集合。
   *
   * 判据是「这一拍里这个会话有事情要做」，不是「工作区里存在过哪些会话」：
   * - 有本插件 GUI 挂载点的会话：要按原生清单检测原生关闭（close）、把新原生 Tab 绑到挂载点（claim）；
   * - 正在上屏的会话：展开态下 AI 新建的原生 Tab 要落一个 GUI 挂载点（open）；
   * - 还有未完成 claim 的会话：绑定要等下一条原生清单才能收尾。
   *
   * 只在 `sessions()` 里、既没有 GUI 挂载点也不是上屏会话的会话**不进来**：
   * 这些会话在 tick 的三条路径上都走不到写操作（records 为空 ⇒ close/claim/open 全部不成立），
   * 并进 ids 的唯一效果是每秒一次跨桥往返 —— 会话越多这笔账越大，而它换不到任何行为。
   */
  private polled(tabs: readonly SidebarRightOpenTab[], mounted: SessionId | undefined): Set<SessionId> {
    const ids = new Set<SessionId>()
    for (const tab of tabs) if (this.isBrowserTab(tab)) ids.add(tab.sessionId)
    // The mounted Session stays unconditional: an AI-created native tab appears only in the
    // shell's inventory, so discovering it (and giving it a GUI occurrence) is exactly what this
    // poll is for. The saving comes from [needsPolling], which stops the loop entirely when
    // nothing is mounted at all.
    if (mounted !== undefined) ids.add(mounted)
    for (const session of this.pending.keys()) ids.add(session)
    return ids
  }

  private tick(): void {
    if (this.disposed || document.hidden) return
    const mounted = this.options.mounted()
    // 一拍内只读一次布局快照：每次 tabs() 都要在一次全量数组上重建结果，而同一拍里
    // 各会话看到的是同一份快照。只有本拍**写过**布局（open/close）之后才重新取一次 ——
    // 那一次是为了看自己刚写进去的结果，不是重复读。
    let tabs = this.options.tabs()
    const ids = this.polled(tabs, mounted)
    let mountedPending = false
    for (const session of ids) {
      const workspace = this.for(session)
      try {
        const snapshot = workspace.refresh()
        if (!snapshot.ok || !snapshot.available || !snapshot.authoritativeTabs) continue
        let records = tabs.filter(tab => tab.sessionId === session && this.isBrowserTab(tab))
        // A native close removes only the corresponding GUI occurrence, never the Session workspace.
        for (const record of records) {
          const nativeId = workspace.nativeTabId(record.tabId)
          if (nativeId !== undefined && !snapshot.tabs.some(tab => tab.tabId === nativeId)) {
            this.options.close(session, record.tabId)
            // 布局刚被写过：后面的判定必须看新的挂载点集合，不能再用本拍开头那份快照。
            tabs = this.options.tabs()
          }
        }
        records = tabs.filter(tab => tab.sessionId === session && this.isBrowserTab(tab))
        let pending = this.pending.get(session)
        if (pending === undefined) { pending = new Map(); this.pending.set(session, pending) }
        for (const native of snapshot.tabs) {
          if (records.some(record => workspace.nativeTabId(record.tabId) === native.tabId || record.tabId === native.uiTabId)) {
            pending.delete(native.tabId)
            continue
          }
          // Native authority may survive a cleared layout. Rebind only after the full inventory
          // confirms the previous occurrence is absent, never by selected/focused native tab.
          if (native.uiTabId !== undefined && tabs.some(tab => tab.sessionId === session && tab.tabId === native.uiTabId)) continue
          const queued = pending.get(native.tabId)
          const queuedRecord = queued === undefined ? undefined : records.find(record => record.tabId === queued)
          if (queuedRecord !== undefined) {
            if (workspace.claim(queuedRecord.tabId, native.tabId, native.uiTabId)) pending.delete(native.tabId)
            continue
          }
          const legacy = records.find(record => record.kind === this.options.legacyKind && workspace.nativeTabId(record.tabId) === undefined)
          if (legacy !== undefined) {
            if (!workspace.claim(legacy.tabId, native.tabId, native.uiTabId)) pending.set(native.tabId, legacy.tabId)
            continue
          }
          if (session !== mounted || !this.options.expanded()) {
            if (session === mounted) mountedPending = true
            continue
          }
          const before = new Set(tabs.map(tab => tab.tabId))
          this.options.open(session)
          // open() 会向布局写入一个新挂载点：这里是本拍唯一必须重读的地方。
          tabs = this.options.tabs()
          const created = tabs.find(tab => tab.sessionId === session && tab.kind === this.options.kind && !before.has(tab.tabId))
          if (created !== undefined) {
            pending.set(native.tabId, created.tabId)
            if (workspace.claim(created.tabId, native.tabId, native.uiTabId)) pending.delete(native.tabId)
            records = tabs.filter(tab => tab.sessionId === session && this.isBrowserTab(tab))
          }
        }
        for (const nativeId of pending.keys()) if (!snapshot.tabs.some(tab => tab.tabId === nativeId)) pending.delete(nativeId)
      } catch (_sidebarOperationRefused) {
        workspace.reportFailure('browser-sidebar-operation-refused')
        if (session === mounted) mountedPending = true
      }
    }
    if (mountedPending) document.documentElement.setAttribute(BROWSER_PENDING_ATTR, 'true')
    else document.documentElement.removeAttribute(BROWSER_PENDING_ATTR)
  }
}
