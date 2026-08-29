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
  /** 0.13.1 W4：配置导出（私有 settings.yaml -> 共享 exports/config/）。返回 JSON {ok, path?, error?}。 */
  private val onExportConfig: () -> String = { """{"ok":false,"error":"bridge not wired"}""" },
  /** 0.13.1 W4：配置导入（共享 exports/config/settings.yaml -> 私有 DSH_HOME）。返回 JSON 同上。 */
  private val onImportConfig: () -> String = { """{"ok":false,"error":"bridge not wired"}""" },
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
  /** 0.13.0 F1.7：ADB shell 执行原语（授权时执行；未授权失败关闭返回引导 JSON）。 */
  private val onAdbShell: (cmd: String) -> String = { _ -> "" },
  /** 0.13.0 F1.7：授权状态 JSON（三道人门状态视图，供设置页/授权状态探活）。 */
  private val onGetAdbState: () -> String = { "{}" },
  /** 0.13.0 F1.7：应用内「允许访问」开关（第二道人门；默认关闭；回收即失效）。 */
  private val onSetAdbAllow: (enable: Boolean) -> Unit = {},
  /** 0.13.0 F1.7：门3 配对码（6 位）；仅原生侧可写授权（被提权方自改授权被禁止——Shizuku 对照）。
   *  0.14：真实握手——pairPort/connectPort 取自系统「无线调试」弹窗（码值只进 adb argv，绝不出壳）。
   *  F3（2026-08-27）：返回结构化 JSON 文本 {ok, reason, message}，替代 Boolean。 */
  private val onSetAdbPair: (code: String, pairPort: Int, connectPort: Int) -> String = { _, _, _ -> """{"ok":false,"reason":"unknown","message":null}""" },
  /** 0.13.0 F1.7：回收配对（R6：显式回收 + 审计）。 */
  private val onRevokeAdbPair: () -> Unit = {},
  /** 0.13.0（issue #80；NSD 替换盲扫）：自动发现无线调试端口——返回结构
   *  {\"pair\": <配对端口|null>, \"connect\": <连接端口|null>, \"candidates\": [...] }，
   *  与壳 AdbState.discoverPorts 同形状（桥默认值同为完整结构，不再返回 "[]" 造成两端不一致）。
   *  0.14：Shizuku 探活重设计与豁免升级。 */
  private val onDiscoverAdbPorts: () -> String = { """{"pair":null,"connect":null,"candidates":[]}""" },
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

  /**
   * 0.13.1 W4：配置导出（私有 settings.yaml -> Documents/dshdata/exports/config/settings.yaml）。
   * 引擎 DSH_HOME 在私有域（外部改共享目录副本无效），本桥是安全的手改通道：
   * 导出 -> 文件管理器编辑 -> 导入。返回 JSON {ok, path?, error?}（同步执行，桥线程允许阻塞 IO）。
   */
  @JavascriptInterface
  fun exportConfig(): String = onExportConfig()

  /** 0.13.1 W4：配置导入（exports/config/settings.yaml -> 私有 DSH_HOME；引擎 chokidar 热加载）。返回 JSON 同上。 */
  @JavascriptInterface
  fun importConfig(): String = onImportConfig()

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
   * ACTION_VIEW (content Uri via FileProvider); returns whether a reader
   * took it. Callers fall back to the engine RPC when false (desktop hosts).
   */
  @JavascriptInterface
  fun openNativePath(path: String): Boolean = onOpenNativePath(path)

  /** ADB shell 执行原语（F1.7）：返回 JSON {ok, stdout?, stderr?, guidance?}。
   *  未授权/门控不满足 → fail-closed（绝不静默执行）。 */
  @JavascriptInterface
  fun adbShell(cmd: String): String = onAdbShell(cmd)

  /** 授权状态视图（F1.7/F2.9 授权探活）：JSON {fullAccess, allowSwitch, paired, wirelessDebugOn, message}。 */
  @JavascriptInterface
  fun getAdbState(): String = onGetAdbState()

  /** 应用内「允许访问」开关（第二道人门；默认关闭；关闭即通道失败关闭）。 */
  @JavascriptInterface
  fun setAdbAllow(enable: Boolean) {
    onSetAdbAllow(enable)
  }

  /**
   * 门3 配对码：六位数字 + 无线调试弹窗的「配对端口/连接端口」；
   * AdbState 运行真实 adb pair 握手（码值不入审计，只记长度）。
   * F3 结构化返回（JSON 文本 {ok, reason, message}）：前端按机器可读 reason 分流文案
   * （window-closed/protocol-fault/server-not-ready/handshake-timeout…），不再笼统布尔。
   */
  @JavascriptInterface
  fun setAdbPair(code: String, pairPort: Int, connectPort: Int): String =
    onSetAdbPair(code, pairPort, connectPort)

  /** 回收配对（R6 显式回收；配套审计）。 */
  @JavascriptInterface
  fun revokeAdbPair() {
    onRevokeAdbPair()
  }

  /** 自动发现无线调试端口（issue #80）：返回配对端口候选 JSONArray（顺序端序）。
   *  耗时为原生 TCP 盲扫（毫秒/端口）；无线调试未开时返回 []。 */
  @JavascriptInterface
  fun discoverAdbPorts(): String = onDiscoverAdbPorts()

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
