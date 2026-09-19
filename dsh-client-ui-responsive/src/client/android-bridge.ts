/**
 * Android shell bridge types (window.androidBridge): every method injected by MainActivity's
 * addJavascriptInterface. Single source of truth — theme-bridge and dev-section share this
 * declaration; all methods optional (safe degradation on desktop/non-shell hosts).
 */
/** How the shell should hand a path to the system chooser. */
export type OpenPathMode = 'view' | 'folder'

/** Outcome of one `openPathChooser` call, decoded from the bridge's JSON answer. */
export interface OpenPathResult {
  /** True when the chooser was raised (the user's pick is the system's business). */
  ok: boolean
  /** Failure reason: `unavailable` (no bridge), `no-handler`, `not-allowed`, or a shell error. */
  reason?: string
}

export interface AndroidShellBridge {
  /** H1: sync system-dark query (fallback for vendor WebViews whose matchMedia is stuck on light). */
  getSystemDark?: () => boolean
  /** Restart the engine service process (kill + watchdog relaunch). */
  restartEngine?: () => void
  /** Shut down the harness: stop the engine and fall back to the init (startup/test) screen (no auto-restart). */
  shutdownToGuide?: () => void
  /** Refresh the Web UI (reload the engine page). */
  reloadWebUI?: () => void
  /** Open the built-in console (snapshot bash interactive terminal). */
  openConsole?: () => void
  /** Dev debug-log toggle state (default off). */
  getDevLogEnabled?: () => boolean
  /** Set the dev debug-log toggle; when on, logs are written daily under dshdata/log/. */
  setDevLogEnabled?: (enabled: boolean) => void
  /** 0.13.1 W4: export the private settings.yaml to Documents/dshdata/exports/config/.
   *  Returns JSON {ok, path?, error?} (synchronous bridge call). */
  exportConfig?: () => string
  /** 0.13.1 W4: import Documents/dshdata/exports/config/settings.yaml back into the
   *  private DSH_HOME (engine hot-reloads via chokidar). Returns JSON {ok, path?, hint?, error?}. */
  importConfig?: () => string
  /** Whether "All Files Access" is granted (prerequisite for external workspaces / public logs). */
  hasAllFilesAccess?: () => boolean
  /** Immersive status-bar toggle (true = status bar normally hidden), persisted by the shell. */
  setImmersiveMode?: (enable: boolean) => void
  /** ST-10: current immersive state from the shell truth source (ShellState.ImmersiveMode).
   *  Prefer this over any page-side copy; absent on desktop / older shells (storage fallback applies). */
  getImmersiveMode?: () => boolean
  /** 0.13.7: open a path through the Android system chooser (MT Manager, system files).
   *  Returns a JSON `{ok, launched?, reason?}` answer; `folder` targets the directory. */
  openPathChooser?: (path: string, mode?: OpenPathMode) => string
  /** 0.13.5 W4: 无障碍控制通道状态 JSON（enabled/label/restrictedHint）。 */
  a11yStatus?: () => string
  /** 0.13.5 W4: 跳系统无障碍设置页，由用户手动开启「DSH 设备控制」。 */
  openA11ySettings?: () => void
  /** 0.14.0: 解锁 Android 13+ 受限设置（appops，经 Shizuku 特权 shell）。返回 JSON {ok, message}。 */
  unlockRestrictedSettings?: () => string
  /** Pre-0.13.7 implicit ACTION_VIEW on a single path (kept: the page's path clicks
   *  fall back to it when the chooser is unavailable). Returns whether it launched. */
  openNativePath?: (path: string) => boolean
  /** 0.13.2 W7: floating-ball toggle state (persisted by the shell). */
  getOverlayEnabled?: () => boolean
  /** 0.13.2 W7: floating-ball toggle; returns whether the overlay actually started
   *  (false = SYSTEM_ALERT_WINDOW not granted — the shell opens the settings page). */
  setOverlayEnabled?: (enable: boolean) => boolean
  /** 0.14: user-owned model screen-access scope. This is settings-only, not a model tool. */
  getScreenScope?: () => 'virtual-only' | 'real-only' | 'all'
  /** Persist a user-selected screen scope and return the normalized shell value. */
  setScreenScope?: (scope: 'virtual-only' | 'real-only' | 'all') => 'virtual-only' | 'real-only' | 'all'
  /** Trusted shell-only CWD for one blank external-open Session; no source file path is exposed. */
  incomingWorkspacePath?: () => string
  /** BrowserHost workbench lifecycle/navigation state (JSON string). */
  browserHostStatus?: () => string
  browserHostShow?: (url?: string | null) => string
  browserHostHide?: () => string
  browserHostReload?: () => string
  browserHostBounds?: (bounds: string) => string
  browserHostViewport?: (viewport: string) => string
  /** 0.14.0: close (destroy) the current page; the workbench can be opened fresh afterwards. */
  browserHostClose?: () => string
  /** 0.14.0: switch identity profile (PC / mobile); payload is JSON `{profile, ua}`. */
  browserHostIdentity?: (payload: string) => string
  /** VirtualDisplay state/actions, exposed only to the trusted Files-sidebar UI. */
  vdisplayStatus?: () => string
  vdisplayCreate?: () => string
  vdisplayDestroy?: () => string
  vdisplayBounds?: (bounds: string) => string
  /** Select the controller-owned presentation target (only owned virtual aliases are selectable). */
  vdisplaySelect?: (alias: string) => string
  /** 0.14.0 设置页「手机控制」：虚拟屏分辨率档位（0.5 / 0.75 / 1.0）。 */
  getVdisplayScale?: () => number
  setVdisplayScale?: (value: number) => number
  /** 0.14.0 设置页「手机控制」：app 退后台自动浮窗开关。 */
  getVdisplayFloatEnabled?: () => boolean
  setVdisplayFloatEnabled?: (enable: boolean) => boolean
  /** 0.14.0 设置页「手机控制」：强制销毁全部虚拟屏（三连点确认后调用）。 */
  forceDestroyVdisplay?: () => string
  /** 0.14.1 块J FIX-4：通知设置读回（JSON：suppressForeground / suppressForegroundDefault / categories）。
   *  `key` 为空串 = 全量快照；回读始终取壳侧真源，不回显入参。 */
  getNotifySetting?: (key?: string) => string
  /** 0.14.1 块J FIX-4：通知设置写入（key = `suppressForeground` 或 `cat.<category>`）。
   *  返回写后读回的 JSON；`applied=false` 即未生效（未知 key / 读回不一致）。 */
  setNotifySetting?: (key: string, value: boolean) => string
}

declare global {
  interface Window {
    /** JS bridge injected by the shell APK (MainActivity). */
    androidBridge?: AndroidShellBridge
  }
}
