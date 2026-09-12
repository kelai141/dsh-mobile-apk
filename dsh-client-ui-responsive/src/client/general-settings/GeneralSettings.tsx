/**
 * General-settings additions for the Android shell (issue #59): the upstream
 * Settings → General section lost the Android-only immersive status-bar toggle.
 * The shell bridge exists (androidBridge.getImmersiveMode / setImmersiveMode,
 * whose truth source is the shell's ShellState.ImmersiveMode) and the row
 * registers at the upstream settings.general.item extension point (auto
 * projected into the General section nav), mirroring DevSection.
 *
 * 0.13.3 (D6 收益省略): the font-size slider (WebView textZoom, 50–200%)
 * retired — upstream ui-theme now ships a native fontSize field (12–17px
 * content font size) rendered in the Appearance section with persistence.
 * The shell's setTextZoom bridge and persistence were removed with it.
 *
 * ST-10: the value is the bridge's getImmersiveMode() (shell pref is the truth
 * source). The localStorage key (dsh.android.immersive) is only a fallback for
 * hosts without that bridge (desktop / older shells), and this page is its sole
 * writer — no injected index.html script writes it.
 *
 * ST-09: the read goes through useShellState (mount + visible/foreground
 * re-read + write-then-read-back), never a one-shot bridge read.
 */
import { useCallback } from 'react'
import { useShellState } from '../mobile/use-shell-state.ts'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls in the settings.section owner share (erased at build time, types only).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Single source of truth for the bridge types (incl. the Window.androidBridge global).
import type {} from '../android-bridge.ts'

/** Full section props: the settings shell supplies only `close`. */
export type GeneralSettingsProps = PropsRuntime<'settings.general.item'>

const IMMERSIVE_KEY = 'dsh.android.immersive'

/**
 * Immersive initial value (ST-10): the shell bridge is the sole truth source
 * (ShellState.ImmersiveMode); the localStorage mirror is only the fallback for
 * hosts without that bridge, and the default stays true (the shell's default).
 * @returns the effective immersive flag for this render.
 */
function readImmersive(): boolean {
  try {
    const fromBridge = window.androidBridge?.getImmersiveMode?.()
    if (typeof fromBridge === 'boolean') return fromBridge
  } catch {
    /* bridge absent or threw: fall through to the storage mirror */
  }
  try {
    return localStorage.getItem(IMMERSIVE_KEY) !== '0'
  } catch {
    return true
  }
}

/**
 * Render the Android general-settings rows (immersive toggle).
 * @param props - composed slot props (contract/slots.ts).
 * @returns the section element tree.
 */
export function GeneralSettings(_props: GeneralSettingsProps) {
  // ST-09：设置页这一处也走 useShellState（挂载 + 可见/回前台重读）；ST-10：真源是壳桥。
  const [immersive, refreshImmersive] = useShellState<boolean>(readImmersive)

  const toggleImmersive = useCallback((enabled: boolean) => {
    try {
      localStorage.setItem(IMMERSIVE_KEY, enabled ? '1' : '0')
    } catch {
      /* storage unavailable: still push to the shell */
    }
    try {
      window.androidBridge?.setImmersiveMode?.(enabled)
    } catch {
      /* bridge absent: desktop fallback no-op */
    }
    // 写后回读：展示值 = 壳侧真值（ShellState.ImmersiveMode），不做乐观置位
    refreshImmersive()
  }, [refreshImmersive])

  return (
    <div data-plugin="android-general">
      <label className="dsh-dev-row dsh-dev-switch">
        <input
          type="checkbox"
          checked={immersive}
          onChange={(e) => toggleImmersive(e.target.checked)}
        />
        <span>沉浸式状态栏</span>
      </label>
      <p className="dsh-dev-hint">常态隐藏系统状态栏，边缘滑动临时呼出；关闭后常驻显示。</p>
    </div>
  )
}
