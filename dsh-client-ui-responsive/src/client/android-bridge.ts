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
  /** Pre-0.13.7 implicit ACTION_VIEW on a single path (kept: the page's path clicks
   *  fall back to it when the chooser is unavailable). Returns whether it launched. */
  openNativePath?: (path: string) => boolean
  /** 0.13.2 W7: floating-ball toggle state (persisted by the shell). */
  getOverlayEnabled?: () => boolean
  /** 0.13.2 W7: floating-ball toggle; returns whether the overlay actually started
   *  (false = SYSTEM_ALERT_WINDOW not granted — the shell opens the settings page). */
  setOverlayEnabled?: (enable: boolean) => boolean
}

declare global {
  interface Window {
    /** JS bridge injected by the shell APK (MainActivity). */
    androidBridge?: AndroidShellBridge
  }
}
