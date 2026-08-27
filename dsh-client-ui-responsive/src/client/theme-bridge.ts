// Single source of truth for the bridge types (incl. the Window.androidBridge global).
import type {} from './android-bridge.ts'

/**
 * ThemeBridge: make prefers-color-scheme follow the OS dark state on
 * WebViews whose media query does not track the system uiMode (observed on
 * vivo/Android 16: FORCE_DARK_AUTO leaves matchMedia stuck at light).
 *
 * The shell APK watches Configuration changes and pushes the dark flag via
 * window.__dshThemeBridge.setDark(dark). This module hooks matchMedia for the
 * (prefers-color-scheme: dark) query so the upstream ui-theme service
 * (default preference: system) resolves and live-updates through its own
 * listener — zero upstream changes.
 */
export class ThemeBridge {
  private dark = false
  private listeners = new Set<() => void>()
  private patched = false

  /** Install the matchMedia hook and the bridge object (idempotent). */
  install(): void {
    if (this.patched) return
    this.patched = true
    const android = window.androidBridge
    // The shell's early-injected bridge (host-web-compat POLYFILL_SCRIPT) already
    // owns matchMedia and __dshThemeBridge by the time this client bundle loads;
    // patching again would split the ui-theme listener (first patch) from
    // setDark (this instance), so the theme would never follow. Stand down when
    // a bridge is present.
    if ((window as unknown as { __dshThemeBridge?: unknown }).__dshThemeBridge) return
    // L4 (2026-08-16): with no setDark source at all (no early-installed bridge, no sync shell query
    // bridge), do not install either — otherwise matchMedia becomes a dangling stub with no update
    // source (desktop etc. non-Android hosts), polluting all later prefers-color-scheme queries
    // with stale values.
    if (!android || typeof android.getSystemDark !== 'function') return
    const self = this
    const nativeMatchMedia = window.matchMedia.bind(window)

    // Intercept the query ui-theme constructs and listens on.
    window.matchMedia = ((query: string): MediaQueryList => {
      if (!query.includes('prefers-color-scheme')) return nativeMatchMedia(query)
      const onChange = (): void => {
        for (const listener of self.listeners) {
          try { listener() } catch { /* a listener must not break the chain */ }
        }
      }
      return {
        get matches() { return self.dark },
        get media() { return query },
        get onchange() { return null },
        set onchange(_v) { /* not used by the theme service */ },
        addEventListener: (type: string, cb: EventListenerOrEventListenerObject | null) => {
          if (type !== 'change' || typeof cb !== 'function') return
          self.listeners.add(cb as () => void)
          onChange()
        },
        removeEventListener: (type: string, cb: EventListenerOrEventListenerObject | null) => {
          if (type !== 'change' || typeof cb !== 'function') return
          self.listeners.delete(cb as () => void)
        },
        addListener: (cb: (e: MediaQueryListEvent) => void) => { self.listeners.add(cb as unknown as () => void) },
        removeListener: (cb: (e: MediaQueryListEvent) => void) => { self.listeners.delete(cb as unknown as () => void) },
        dispatchEvent: () => false,
      } as MediaQueryList
    }) as typeof window.matchMedia

    const globalObj = window as unknown as { __dshThemeBridge?: { setDark: (d: boolean) => void } }
    globalObj.__dshThemeBridge = {
      setDark: (d: boolean): void => {
        if (self.dark === d) return
        self.dark = d
        for (const listener of self.listeners) {
          try { listener() } catch { /* keep the chain alive */ }
        }
      },
    }
    // H1 (2026-08-16): pull the shell's real uiMode synchronously at boot — a vendor WebView's
    // native matchMedia may be stuck on light (vivo/Android 16); use the real value on the first
    // frame instead of relying on native queries or later async pushes.
    try {
      if (android.getSystemDark()) globalObj.__dshThemeBridge.setDark(true)
    } catch { /* bridge query unavailable: keep light until pushed */ }
  }
}
