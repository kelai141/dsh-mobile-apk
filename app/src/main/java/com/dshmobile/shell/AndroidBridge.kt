package com.dsharnessmobile.shell

import android.net.Uri
import android.provider.DocumentsContract
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * JS bridge injected as window.androidBridge (protocol v1, see
 * docs/design.md). All methods are callable from the page; results
 * that arrive asynchronously are delivered back through
 * window.__dshBridge.onDirectoryPicked(callbackId, path) on the main thread.
 */
class AndroidBridge(
  private val onPickRequest: (callbackId: String) -> Unit,
  private val onKeepScreen: (enable: Boolean) -> Unit,
  private val onNotify: (title: String, text: String) -> Unit,
  private val onAllFilesAccessRequest: () -> Unit = {},
  private val onDebugLogsRequest: () -> Unit = {},
  private val onGetSystemDark: () -> Boolean = { false },
  private val onPickImageRequest: (callbackId: String) -> Unit = {},
  private val onSetTextZoomRequest: (percent: Int) -> Unit = {},
  private val onSetImmersiveRequest: (enable: Boolean) -> Unit = {},
  private val onCopyTextRequest: (text: String) -> Boolean = { false },
  private val pickToken: String? = null,
  private val onRestartEngine: () -> Unit = {},
  private val onShutdownToGuide: () -> Unit = {},
  private val onReloadWebUI: () -> Unit = {},
  private val onOpenConsole: () -> Unit = {},
  private val onGetDevLogEnabled: () -> Boolean = { false },
  private val onSetDevLogEnabled: (Boolean) -> Unit = {},
  private val onOpenNativePath: (path: String) -> Boolean = { false },
) {

  @JavascriptInterface
  fun version(): String = BuildConfig.VERSION_NAME

  /** Synchronous system-dark query (H1: the first-frame theme bridge pulls the real uiMode,
   *  bypassing vendor WebViews whose matchMedia is stuck on light). */
  @JavascriptInterface
  fun getSystemDark(): Boolean = onGetSystemDark()

  @JavascriptInterface
  fun checkEngine(): String = EngineProbe.check().toString()

  @JavascriptInterface
  fun keepScreenOn(enable: Boolean) {
    onKeepScreen(enable)
  }

  @JavascriptInterface
  fun showNotification(title: String, text: String) {
    onNotify(title, text)
  }

  @JavascriptInterface
  fun pickDirectory(callbackId: String) {
    onPickRequest(callbackId)
  }

  @JavascriptInterface
  fun pickImage(callbackId: String) {
    onPickImageRequest(callbackId)
  }

  /** Set the WebView font scale (textZoom, 50–200); called by the Settings → General slider. */
  @JavascriptInterface
  fun setTextZoom(percent: Int) {
    onSetTextZoomRequest(percent)
  }

  /** Immersive status bar toggle (true = status bar normally hidden); called by Settings → General. */
  @JavascriptInterface
  fun setImmersiveMode(enable: Boolean) {
    onSetImmersiveRequest(enable)
  }

  /**
   * Native clipboard write (navigator.clipboard.writeText in WebView is always rejected on Android
   * with NotAllowedError: Write permission denied, so the page falls back to this bridge after
   * writeClipboard fails). Returns whether the write succeeded.
   */
  @JavascriptInterface
  fun copyText(text: String): Boolean = onCopyTextRequest(text)

  /** Debug log export: engine logs + environment info zipped (same download/dialog path as session export). */
  @JavascriptInterface
  fun downloadDebugLogs() {
    onDebugLogsRequest()
  }

  /** True when the app holds All Files Access (external workspace requirement). */
  @JavascriptInterface
  fun hasAllFilesAccess(): Boolean {
    // isExternalStorageManager exists only on API 30+; older versions have no such permission model.
    if (android.os.Build.VERSION.SDK_INT < 30) return false
    return android.os.Environment.isExternalStorageManager()
  }

  /** Open the system screen granting All Files Access (special permission). */
  @JavascriptInterface
  fun requestAllFilesAccess() {
    onAllFilesAccessRequest()
  }

  /** One-shot session token for the directory-picker bridge (validated by the engine-side pick endpoint; null = disabled). */
  @JavascriptInterface
  fun getPickToken(): String? = pickToken

  /** Restart the engine service process: kill the engine, the EngineService watchdog brings it back. */
  @JavascriptInterface
  fun restartEngine() {
    onRestartEngine()
  }

  /** Shut down the harness: stop the engine and fall back to the init (startup/test) screen (no auto-restart). */
  @JavascriptInterface
  fun shutdownToGuide() {
    onShutdownToGuide()
  }

  /** Refresh the Web UI (reloads the current engine page, issue apk#29 requirement 1). */
  @JavascriptInterface
  fun reloadWebUI() {
    onReloadWebUI()
  }

  /** Open the built-in console (snapshot bash interactive terminal; usable for diagnostics even when the engine is down). */
  @JavascriptInterface
  fun openConsole() {
    onOpenConsole()
  }

  /** Dev debug-log toggle state (default off; persisted via SharedPreferences). */
  @JavascriptInterface
  fun getDevLogEnabled(): Boolean = onGetDevLogEnabled()

  /** Set the dev debug-log toggle; when on, logs are written daily under dshdata/log/. */
  @JavascriptInterface
  fun setDevLogEnabled(enabled: Boolean) {
    onSetDevLogEnabled(enabled)
  }

  /**
   * Open a filesystem path with an external reader app (issue #52): the
   * engine's native-path opener only knows mac/win/linux desktops, and on
   * Android the page's file-mention buttons would otherwise fail with
   * "unsupported on android". The shell resolves the path through
   * ACTION_VIEW (content Uri via FileProvider). Since v0.12.5-fx-1-rgfix the
   * bridge always returns true on Android (resolves relative/Termux paths,
   * silent on failure): the engine-RPC fallback can never open anything on
   * Android, so falling through would only surface an error dialog.
   */
  @JavascriptInterface
  fun openNativePath(path: String): Boolean = onOpenNativePath(path)

  companion object {
    /**
     * Map an ACTION_OPEN_DOCUMENT_TREE result onto a Termux-visible real path
     * when possible: "primary:rel/path" -> /storage/emulated/0/rel/path.
     * Non-primary volumes fall back to the raw content:// tree URI (the page
     * can still use it as an opaque handle).
     * @param uri the tree URI from the system picker.
     * @returns the mapped real path or the original URI string.
     */
    fun resolvePickedPath(uri: Uri): String {
      return try {
        val docId = DocumentsContract.getTreeDocumentId(uri)
        val idx = docId.indexOf(':')
        val volume = if (idx > 0) docId.substring(0, idx) else ""
        val rel = if (idx > 0) docId.substring(idx + 1) else docId
        // M5: path sanitization — reject `..` segments/absolute paths (escape prevention); empty rel is rejected.
        if (rel.isEmpty() || rel.split("/").any { it == ".." } || rel.startsWith("/")) {
          return uri.toString()
        }
        if (volume == "primary") "/storage/emulated/0/$rel" else uri.toString()
      } catch (_: Exception) {
        uri.toString()
      }
    }
  }
}

/** JSON string literal escaping for evaluateJavascript payloads. */
internal fun jsString(value: String): String = JSONObject.quote(value)
