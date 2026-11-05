/** Session/GUI-occurrence ownership over the Android native browser authority. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserFrame, BrowserFrameState } from './upstream-browser/browser/BrowserFrame.ts'
import { emptyBrowserFrame } from './upstream-browser/browser/BrowserFrame.ts'
import type { BrowserPage, BrowserPageOptions } from './upstream-browser/browser/BrowserPage.ts'
import { browserAddressCheckpoint } from './upstream-browser/browser/BrowserPersistence.ts'
import { parseBrowserAddress, type BrowserTarget } from './upstream-browser/browser/url.ts'
import { nativeBrowserCommand, parseNativeBrowserSnapshot, unavailableNativeBrowser } from './native-browser-bridge.ts'
import type { NativeBrowserAction, NativeBrowserSnapshot, NativeBrowserTab } from './native-browser-bridge.ts'
import { NativeBrowserPresentation } from './native-browser-presentation.ts'

/** Private renderer facts, exposed only through framework-bound keyed hooks. */
export interface NativeBrowserControlState {
  readonly nativeTabId: string | undefined
  readonly available: boolean
  readonly reason: string
  readonly profileAvailable: boolean
  /** 隔离手段是否可用；false 只触发提示，不把浏览器标成不可用。 */
  readonly isolationAvailable: boolean
  readonly profileReason: string
  readonly identityId: string
  readonly viewportWidth: number
  readonly viewportHeight: number
}

/** Companion controls; components receive bound hooks, not sources or services. */
export interface NativeBrowserControlsInjected {
  readonly keyedHooks: {
    readonly nativeBrowserState: (key: string) => HostObservable<NativeBrowserControlState>
  }
  setBrowserVisible(tabId: TabId, visible: boolean): void
  setBrowserIdentity(tabId: TabId, desktop: boolean): void
  setBrowserViewport(tabId: TabId, width: number, height: number): void
  refreshBrowserStatus(tabId: TabId): void
  closeBrowserTab(tabId: TabId): void
}

/** Native tabs outlive DOM mounts and plugin HMR; explicit layout close owns destruction. */
export class NativeBrowserSession {
  private snapshot: NativeBrowserSnapshot
  private readonly bindings = new Map<string, string>()
  private readonly visible = new Map<string, boolean>()
  private readonly controls = new Map<string, SnapshotStore<NativeBrowserControlState>>()
  private readonly frames = new Map<string, NativeBrowserFrame>()
  private readonly listeners = new Set<() => void>()
  private disposed = false

  constructor(readonly session: string) {
    this.snapshot = unavailableNativeBrowser(session, 'browser-command-unavailable')
  }

  /** Read native authority for reconciliation; failed polls cannot authorize removals. */
  getSnapshot(): NativeBrowserSnapshot { return this.snapshot }

  /** Refresh only this Session; there is no global-focus status fallback. */
  refresh(): NativeBrowserSnapshot {
    if (!this.disposed) this.accept(nativeBrowserCommand(this.session, 'tabs'))
    return this.snapshot
  }

  /** Framework keyed source, stable before the BrowserBody commits its container. */
  controlSource = (key: string): HostObservable<NativeBrowserControlState> => {
    let source = this.controls.get(key)
    if (source === undefined) {
      source = createSnapshotStore(this.controlState(key))
      this.controls.set(key, source)
    }
    return source
  }

  /** Assemble the official controller's native navigation and targeted presentation. */
  createPage = (options: BrowserPageOptions): BrowserPage => {
    this.frames.get(options.tabId)?.detach()
    const frame = new NativeBrowserFrame(this, options)
    this.frames.set(options.tabId, frame)
    this.refreshStatus(options.tabId, options.initial?.nativeTabId)
    frame.synchronize()
    return { frame, presentation: frame.presentation }
  }

  /** Recover a binding only from native ownership or a validated retained checkpoint. */
  refreshStatus(uiTabId: string, retainedNativeId?: string): void {
    if (this.disposed) return
    const id = this.nativeTabId(uiTabId)
    const result = nativeBrowserCommand(this.session, 'status', {
      uiTabId, ...id === undefined ? {} : { tabId: id },
    })
    this.accept(result, uiTabId)
    if (this.nativeTabId(uiTabId) === undefined && retainedNativeId !== undefined) {
      const saved = this.snapshot.tabs.find(tab => tab.tabId === retainedNativeId)
      if (saved !== undefined && (saved.uiTabId === undefined || saved.uiTabId === uiTabId)) this.claim(uiTabId, saved.tabId)
    }
  }

  /** Bind a native tab; absentPreviousUi is accepted only after complete layout-inventory absence. */
  claim(uiTabId: string, nativeTabId: string, absentPreviousUi?: string): boolean {
    const native = this.snapshot.tabs.find(tab => tab.tabId === nativeTabId)
    if (!this.snapshot.ok || !this.snapshot.available || native === undefined
      || (native.uiTabId !== undefined && native.uiTabId !== uiTabId && native.uiTabId !== absentPreviousUi)
      || [...this.bindings].some(([ui, id]) => ui !== uiTabId && ui !== absentPreviousUi && id === nativeTabId)) return false
    const result = nativeBrowserCommand(this.session, 'select', { tabId: nativeTabId, uiTabId })
    this.accept(result, uiTabId, nativeTabId)
    return result.ok && this.nativeTabId(uiTabId) === nativeTabId
  }

  /** Read only this occurrence's validated native id. */
  nativeTabId(uiTabId: string): string | undefined { return this.bindings.get(uiTabId) }
  /** Read only this occurrence's native navigation. */
  nativeTab(uiTabId: string): NativeBrowserTab | undefined {
    const id = this.nativeTabId(uiTabId)
    return id === undefined ? undefined : this.snapshot.tabs.find(tab => tab.tabId === id)
  }

  /** Native select changes ownership; visibility is delivered separately through bounds. */
  setVisible(uiTabId: string, visible: boolean): void {
    const changed = this.visible.get(uiTabId) !== visible
    this.visible.set(uiTabId, visible)
    if (visible && changed && this.nativeTabId(uiTabId) !== undefined) this.command(uiTabId, 'select')
    this.frames.get(uiTabId)?.presentation.refresh()
  }
  /** Visibility comes from the actual useTabInfo tab occurrence. */
  isVisible(uiTabId: string): boolean { return this.visible.get(uiTabId) === true }

  /** Execute one targeted navigation; opening an empty GUI occurrence creates its own native tab. */
  command(uiTabId: string, action: NativeBrowserAction, url?: string): void {
    if (this.disposed) return
    const tabId = this.nativeTabId(uiTabId)
    if (tabId === undefined && action !== 'open' && action !== 'status') return
    const result = nativeBrowserCommand(this.session, action, { uiTabId,
      ...tabId === undefined ? {} : { tabId }, ...url === undefined ? {} : { url } })
    this.accept(result, uiTabId, action === 'open' ? result.tabId : tabId)
  }

  /** Explicit UI close only; cleanup failure keeps the Sidebar record through its close handler. */
  closeUi(uiTabId: string): void {
    if (this.disposed) throw new Error('browser-adapter-disposed')
    const previousId = this.nativeTabId(uiTabId)
    if (previousId !== undefined && this.snapshot.ok && this.snapshot.available && this.snapshot.authoritativeTabs
      && !this.snapshot.tabs.some(tab => tab.tabId === previousId)) {
      this.bindings.delete(uiTabId)
      this.publish()
      return
    }
    this.refreshStatus(uiTabId)
    if (!this.snapshot.ok || !this.snapshot.available) {
      this.refresh()
      if (!this.snapshot.ok || !this.snapshot.available || !this.snapshot.authoritativeTabs) {
        throw new Error(this.snapshot.reason || 'browser-close-status-unavailable')
      }
    }
    const tabId = this.nativeTabId(uiTabId)
    if (tabId === undefined) return
    if (this.snapshot.authoritativeTabs && !this.snapshot.tabs.some(tab => tab.tabId === tabId)) {
      this.bindings.delete(uiTabId)
      this.publish()
      return
    }
    const result = nativeBrowserCommand(this.session, 'close', { tabId, uiTabId })
    this.accept(result)
    if (!result.ok) throw new Error(result.reason || 'browser-close-failed')
    this.bindings.delete(uiTabId)
    this.publish()
  }

  /** Apply the shell's profile, never a UI-only UA label or optimistic readiness flag. */
  setIdentity(uiTabId: string, desktop: boolean): void {
    this.setting(uiTabId, 'identity', { profile: desktop ? 'linux-desktop' : 'android-real',
      preset: 'custom', width: desktop ? 1280 : 390, height: desktop ? 720 : 844, route: 'S2' })
  }
  /** Keep native viewport dimensions separate from the viewport's presentation rectangle. */
  setViewport(uiTabId: string, width: number, height: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 240 || width > 3840 || height < 240 || height > 3840) return
    this.setting(uiTabId, 'viewport', { id: 'custom', width, height, route: 'S2' })
  }

  /** Subscribe outside components; renderer sees only the derived inject observables. */
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  /** Publish a local integration refusal without treating a failed operation as native tab absence. */
  reportFailure(reason: string): void {
    this.accept(unavailableNativeBrowser(this.session, reason))
  }

  /** Stop this provider and hide its attachments; no native tabs or workspace are closed. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const frame of this.frames.values()) frame.detach()
    this.frames.clear()
    this.listeners.clear()
    this.controls.clear()
    this.visible.clear()
  }

  private setting(uiTabId: string, kind: 'identity' | 'viewport', value: Record<string, string | number>): void {
    if (this.disposed) return
    const tabId = this.nativeTabId(uiTabId)
    if (tabId === undefined) return
    const payload = JSON.stringify({ session: this.session, tabId, uiTabId, ...value })
    let result: NativeBrowserSnapshot
    try {
      const raw = kind === 'identity' ? window.androidBridge?.browserHostIdentity?.(payload)
        : window.androidBridge?.browserHostViewport?.(payload)
      result = parseNativeBrowserSnapshot(raw, this.session)
    } catch (_bridgeFailure) { result = unavailableNativeBrowser(this.session, 'browser-setting-failed') }
    this.accept(result, uiTabId, tabId)
  }

  private accept(result: NativeBrowserSnapshot, uiTabId?: string, expectedId?: string): void {
    if (this.disposed) return
    if (result.ok && result.available) {
      // A per-tab reply updates that tab only; only a complete tabs list authorizes absence.
      const tabs = result.authoritativeTabs ? result.tabs : [
        ...this.snapshot.tabs.filter(old => !result.tabs.some(tab => tab.tabId === old.tabId)), ...result.tabs,
      ]
      this.snapshot = { ...result, tabs }
      for (const tab of tabs) {
        if (tab.uiTabId !== undefined) this.bindings.set(tab.uiTabId, tab.tabId)
      }
      const owned = uiTabId === undefined ? undefined : tabs.find(tab => tab.uiTabId === uiTabId)
      const addressed = expectedId === undefined ? undefined : tabs.find(tab => tab.tabId === expectedId)
      if (uiTabId !== undefined && owned !== undefined) this.bindings.set(uiTabId, owned.tabId)
      else if (uiTabId !== undefined && addressed !== undefined
        && (addressed.uiTabId === undefined || addressed.uiTabId === uiTabId)
        && ![...this.bindings].some(([ui, id]) => ui !== uiTabId && id === addressed.tabId)) this.bindings.set(uiTabId, addressed.tabId)
      for (const [ui, id] of this.bindings) {
        const tab = tabs.find(item => item.tabId === id)
        if (tab?.uiTabId !== undefined && tab.uiTabId !== ui) this.bindings.delete(ui)
      }
    } else this.snapshot = { ...result, tabs: this.snapshot.tabs, authoritativeTabs: false }
    this.publish()
  }

  private controlState(uiTabId: string): NativeBrowserControlState {
    const tab = this.nativeTab(uiTabId)
    return { nativeTabId: this.nativeTabId(uiTabId), available: this.snapshot.available,
      reason: this.snapshot.reason || tab?.reason || '',
      profileAvailable: this.snapshot.ok ? tab?.profileAvailable ?? this.snapshot.profileAvailable : this.snapshot.profileAvailable,
      isolationAvailable: this.snapshot.ok ? tab?.isolationAvailable ?? this.snapshot.isolationAvailable : this.snapshot.isolationAvailable,
      profileReason: this.snapshot.ok ? tab?.profileReason ?? this.snapshot.profileReason : this.snapshot.profileReason, identityId: tab?.identityId ?? '',
      viewportWidth: tab?.viewportWidth ?? 0, viewportHeight: tab?.viewportHeight ?? 0 }
  }

  private publish(): void {
    for (const [uiTabId, source] of this.controls) {
      const next = this.controlState(uiTabId)
      if (JSON.stringify(next) !== JSON.stringify(source.getSnapshot())) source.set(next)
    }
    for (const listener of [...this.listeners]) listener()
  }
}

/** Native navigation observable consumed unchanged by the vendored BrowserController. */
class NativeBrowserFrame implements BrowserFrame {
  private readonly source = createSnapshotStore<BrowserFrameState>(emptyBrowserFrame())
  private readonly unsubscribe: () => void
  private disposed = false
  private checkpoint = ''
  readonly presentation: NativeBrowserPresentation

  constructor(private readonly owner: NativeBrowserSession, private readonly options: BrowserPageOptions) {
    this.presentation = new NativeBrowserPresentation({ session: owner.session, uiTabId: options.tabId,
      nativeTabId: () => owner.nativeTabId(options.tabId), visible: () => owner.isVisible(options.tabId),
      ready: () => {
        const snapshot = owner.getSnapshot()
        const tab = owner.nativeTab(options.tabId)
        // 隔离缺失不等于浏览器不可用：只要求浏览器在且有目标页；隔离单独提示。
        return snapshot.ok && snapshot.available && tab !== undefined && this.source.getSnapshot().target !== undefined
      } })
    this.unsubscribe = owner.subscribe(() => { this.synchronize() })
  }

  getSnapshot = (): BrowserFrameState => this.source.getSnapshot()
  subscribe = (listener: () => void): (() => void) => this.source.subscribe(listener)
  loadUrl(target: BrowserTarget): void { if (!this.disposed) this.owner.command(this.options.tabId, 'open', target.url) }
  goBack(): void { if (!this.disposed && this.getSnapshot().canGoBack) this.owner.command(this.options.tabId, 'back') }
  goForward(): void { if (!this.disposed && this.getSnapshot().canGoForward) this.owner.command(this.options.tabId, 'forward') }
  reload(): void { if (!this.disposed) this.owner.command(this.options.tabId, 'reload') }

  /** Copy only observed native navigation into the official observable/checkpoint. */
  synchronize(): void {
    if (this.disposed) return
    const snapshot = this.owner.getSnapshot()
    const native = this.owner.nativeTab(this.options.tabId)
    const parsed = native === undefined || native.url === '' || native.url === 'about:blank' ? undefined
      : parseBrowserAddress(native.url, window.location.origin)
    const target = parsed?.ok === true ? { ...parsed.target, title: native?.title || parsed.target.title } : undefined
    // 只有浏览器本体不可用或页面加载失败才进 error；隔离缺失是提示，不是页面错误。
    const reason = !snapshot.ok || !snapshot.available ? snapshot.reason
      : native?.loadState === 'error' || native?.loadState === 'failed' ? native.reason || 'browser-load-failed' : undefined
    const next: BrowserFrameState = { target, address: target === undefined ? 'empty' : 'observed',
      loading: native?.loadState === 'loading' || native?.loadState === 'navigating',
      canGoBack: native?.canGoBack === true && snapshot.ok, canGoForward: native?.canGoForward === true && snapshot.ok,
      error: reason === undefined || reason === '' ? undefined : { code: undefined, description: reason }, sandboxEnabled: undefined }
    if (JSON.stringify(next) !== JSON.stringify(this.source.getSnapshot())) this.source.set(next)
    if (target !== undefined && native !== undefined) {
      const saved = { ...browserAddressCheckpoint(target, native.pageGeneration), nativeTabId: native.tabId }
      const encoded = JSON.stringify(saved)
      if (encoded !== this.checkpoint) { this.checkpoint = encoded; this.options.persist(saved) }
    }
    this.presentation.refresh()
  }

  /** Replacement, HMR and detach release presentation only; explicit close is owned by Sidebar cleanup. */
  detach(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.presentation.detach()
  }
  dispose(): Promise<void> { this.detach(); return Promise.resolve() }
}
