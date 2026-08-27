/**
 * General-settings additions for the Android shell (issue #59): the upstream
 * Settings → General section lost its two Android-only rows — the font-size
 * slider (WebView textZoom, 50–200%) and the immersive status-bar toggle.
 * The shell bridges exist (androidBridge.setTextZoom / setImmersiveMode, both
 * persisted by MainActivity), but no settings page ever registered the rows.
 * Registered at the upstream settings.general.item extension point (auto
 * projected into the General section nav), mirroring DevSection.
 *
 * The slider reflects the persisted value only while the page lives; the
 * shell persists textZoom in SharedPreferences and applies it at startup, so
 * there is no getter — the UI starts at 100% and the slider is an action
 * control, not a mirror. The immersive toggle reads localStorage
 * (dsh.android.immersive, written by the patched index.html immersive script)
 * for its initial state.
 */
import { useCallback, useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls in the settings.section owner share (erased at build time, types only).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Single source of truth for the bridge types (incl. the Window.androidBridge global).
import type {} from '../android-bridge.ts'

/** Full section props: the settings shell supplies only `close`. */
export type GeneralSettingsProps = PropsRuntime<'settings.general.item'>

const TEXT_ZOOM_MIN = 50
const TEXT_ZOOM_MAX = 200
const TEXT_ZOOM_STEP = 10
const IMMERSIVE_KEY = 'dsh.android.immersive'

/** Read the persisted immersive flag with the same default the shell uses (true). */
function readImmersive(): boolean {
  try {
    return localStorage.getItem(IMMERSIVE_KEY) !== '0'
  } catch {
    return true
  }
}

/**
 * Render the Android general-settings rows (font slider + immersive toggle).
 * @param props - composed slot props (contract/slots.ts).
 * @returns the section element tree.
 */
export function GeneralSettings(_props: GeneralSettingsProps) {
  const [textZoom, setTextZoom] = useState<number>(100)
  const [immersive, setImmersive] = useState<boolean>(readImmersive)

  useEffect(() => {
    setImmersive(readImmersive())
  }, [])

  const applyTextZoom = useCallback((percent: number) => {
    const clamped = Math.min(TEXT_ZOOM_MAX, Math.max(TEXT_ZOOM_MIN, percent))
    setTextZoom(clamped)
    try {
      window.androidBridge?.setTextZoom?.(clamped)
    } catch {
      /* bridge absent: desktop fallback no-op */
    }
  }, [])

  const toggleImmersive = useCallback((enabled: boolean) => {
    setImmersive(enabled)
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
  }, [])

  return (
    <div data-plugin="android-general">
      <div className="dsh-dev-row">
        <label className="dsh-dev-label" htmlFor="dsh-text-zoom">字体大小</label>
        <input
          id="dsh-text-zoom"
          type="range"
          min={TEXT_ZOOM_MIN}
          max={TEXT_ZOOM_MAX}
          step={TEXT_ZOOM_STEP}
          value={textZoom}
          onChange={(e) => applyTextZoom(Number(e.currentTarget.value))}
        />
        <span className="dsh-dev-value">{textZoom}%</span>
      </div>
      <p className="dsh-dev-hint">调整页面字体缩放（50–200%），立即生效并持久化。</p>

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
