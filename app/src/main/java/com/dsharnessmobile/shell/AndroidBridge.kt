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
  /** 0.13.1 W4：配置导出（私有 settings.yaml -> 共享 exports/config/）。返回 JSON {ok, path?, error?}。 */
  private val onExportConfig: () -> String = { """{"ok":false,"error":"bridge not wired"}""" },
  /** 0.13.1 W4：配置导入（共享 exports/config/settings.yaml -> 私有 DSH_HOME）。返回 JSON 同上。 */
  private val onImportConfig: () -> String = { """{"ok":false,"error":"bridge not wired"}""" },
  private val onGetSystemDark: () -> Boolean = { false },
  /** Absolute path of the Host settings document, or empty when unavailable. */
  private val onSettingsPathRequest: () -> String = { "" },
  /** apk #168：把活动 settings.yaml 导出为公共副本并返回其路径（私有目录不对外开放）。 */
  private val onExportSettingsDocument: () -> String = { "" },
  private val onSetImmersiveRequest: (enable: Boolean) -> Unit = {},
  /** ST-10：沉浸式**读**面（缺它就是三方分裂 #1：壳偏好与页面 localStorage 互不校验）。
   *  默认实现直接读壳侧单一真源（ShellAppContext 由 EngineAuth.initContext 绑定），
   *  因此 MainActivity 无需传参即可返回真实值。 */
  private val onGetImmersiveMode: () -> Boolean = { ImmersiveMode.current() },
  private val onCopyTextRequest: (text: String) -> Boolean = { false },
  private val pickToken: String? = null,
  private val onRestartEngine: () -> Unit = {},
  private val onShutdownToGuide: () -> Unit = {},
  private val onReloadWebUI: () -> Unit = {},
  private val onOpenConsole: () -> Unit = {},
  private val onGetDevLogEnabled: () -> Boolean = { false },
  private val onSetDevLogEnabled: (Boolean) -> Unit = {},
  private val onOpenNativePath: (path: String) -> Boolean = { false },
  /** 0.13.7：系统「打开方式」选择器（MT 管理器 / 系统文件管理…）。返回 JSON {ok, reason?}。 */
  private val onOpenPathChooser: (path: String, mode: String?) -> String =
    { _, _ -> """{"ok":false,"reason":"bridge not wired"}""" },
  /** 0.13.2 W7：悬浮球开关态（持久化，OverlayController）。 */
  private val onGetOverlayEnabled: () -> Boolean = { false },
  /** 0.13.2 W7：悬浮球开关（未授 overlay 权限时由控制器发起系统授权引导）。返回是否已启动。 */
  private val onSetOverlayEnabled: (Boolean) -> Boolean = { _ -> false },
  /** User-owned scope for model access to real/virtual Android screens. */
  private val onGetScreenScope: () -> String = { "virtual-only" },
  private val onSetScreenScope: (String) -> String = { "virtual-only" },
  /** Trusted UI-only session cwd for an external attachment draft; never returns a source file path. */
  private val onIncomingWorkspacePath: () -> String = { "" },
  /** BrowserHost workbench state and commands; callable only by trusted DSH UI. */
  private val onBrowserHostStatus: () -> String = { """{"ok":false,"reason":"browser-host-not-wired"}""" },
  private val onBrowserHostShow: (String?) -> String = { _ -> """{"ok":false,"reason":"browser-host-not-wired"}""" },
  private val onBrowserHostHide: () -> String = { """{"ok":false,"reason":"browser-host-not-wired"}""" },
  private val onBrowserHostReload: () -> String = { """{"ok":false,"reason":"browser-host-not-wired"}""" },
  private val onBrowserHostBounds: (String) -> String = { _ -> """{"ok":false,"reason":"browser-host-not-wired"}""" },
  private val onBrowserHostViewport: (String) -> String = { _ -> """{"ok":false,"reason":"browser-host-not-wired"}""" },
  /** 0.14.0：关闭即销毁当前页（工作台对象保留，可再次打开）。 */
  private val onBrowserHostClose: () -> String = { """{"ok":false,"reason":"browser-host-not-wired"}""" },
  /** 0.14.0：身份（PC / 手机）切换，载荷为 {profile, ua}。 */
  private val onBrowserHostIdentity: (String) -> String = { _ -> """{"ok":false,"reason":"browser-host-not-wired"}""" },
  /** VirtualDisplay lifecycle is owned by the trusted Files-sidebar panel; no generic shell is exposed. */
  private val onVdisplayStatus: () -> String = { """{"ok":false,"code":"vdisplay-not-wired"}""" },
  private val onVdisplayCreate: () -> String = { """{"ok":false,"code":"vdisplay-not-wired"}""" },
  private val onVdisplayDestroy: () -> String = { """{"ok":false,"code":"vdisplay-not-wired"}""" },
  private val onVdisplayBounds: (String) -> String = { _ -> """{"ok":false,"code":"vdisplay-not-wired"}""" },
  /** Controller-owned presentation target selection for the realtime screen registry. */
  private val onVdisplaySelect: (String) -> String = { _ -> """{"ok":false,"code":"vdisplay-not-wired"}""" },
  /** 0.14.0 设置页「手机控制」：虚拟屏分辨率档位（0.5 / 0.75 / 1.0）。 */
  private val onGetVdisplayScale: () -> Double = { 0.75 },
  private val onSetVdisplayScale: (Double) -> Double = { value -> value },
  /** 0.14.0 设置页「手机控制」：app 退后台自动浮窗开关。 */
  private val onGetVdisplayFloat: () -> Boolean = { true },
  private val onSetVdisplayFloat: (Boolean) -> Boolean = { enable -> enable },
  /** 0.14.0 设置页「手机控制」：强制销毁全部虚拟屏（用户三连点确认；无视会话归属）。 */
  private val onForceDestroyVdisplay: () -> String = { """{"ok":false,"code":"vdisplay-not-wired"}""" },
  /** 0.13.5 W4：无障碍控制通道状态 JSON {enabled, label, restrictedHint}。 */
  private val onA11yStatus: () -> String = { """{"enabled":false}""" },
  /** 0.13.5 W4：跳系统无障碍设置页（用户手动开启「DSH 设备控制」）。 */
  private val onOpenA11ySettings: () -> Unit = {},
  /** 0.13.5 W4：一键解锁受限设置（Android 13+ 侧载应用默认禁止开启无障碍）。返回 JSON {ok, message}。 */
  private val onUnlockRestrictedSettings: () -> String = { """{"ok":false,"message":"未接线"}""" },
  /**
   * 0.14.1 块J FIX-4：通知设置**读**面（key 为空 = 全量快照）。
   *
   * 默认实现与 [onGetImmersiveMode] 同款：**直接读壳侧单一真源**（`ShellAppContext` 由
   * `EngineAuth.initContext` 绑定），因此 MainActivity 无需传参即可返回真实值。
   *
   * 这是 J-1「FIX-4 名义落地、实际不可达」的直接修法：旧态的 `settingsSnapshot` /
   * `applySetting` 在 `app/src/main` 全仓**零外部调用点**（只有定义处互调），桥面 35 个
   * `@JavascriptInterface` 无一涉及 notify/suppress，页面侧 grep 亦 0 命中——能力在、入口无。
   * 把默认实现钉在真源上（而不是 `{ok:false}` 桩），则「漏接线」这一失效形态在结构上不可能复发：
   * 没有 MainActivity 传参，入口依然可达。
   */
  private val onGetNotifySetting: (String) -> String = { key ->
    val app = ShellAppContext.get()
    if (app == null) """{"ok":false,"reason":"no-shell-context"}"""
    else NotifyCenter.settingsSnapshot(app).put("key", key).toString()
  },
  /**
   * 0.14.1 块J FIX-4：通知设置**写**面（key + value），返回写后读回的 JSON（含 applied/reason）。
   * 与读面同款默认实现：未绑定壳上下文时**拒绝**而不是静默假成功（fail-closed）。
   */
  private val onSetNotifySetting: (String, Boolean) -> String = { key, value ->
    val app = ShellAppContext.get()
    if (app == null) """{"ok":false,"reason":"no-shell-context"}"""
    else NotifyCenter.applySetting(app, key, value).toString()
  },
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


  /**
   * Absolute path of the Host settings document (`$DSH_HOME/settings.yaml`).
   * The mobile adaptation layer opens it through the shell chooser, because the upstream
   * "open configuration file" action delegates to a desktop native text editor (apk #152).
   */
  @JavascriptInterface
  fun settingsPath(): String = onSettingsPathRequest()

  /** 配置文档副本的公共路径（空串 = 导出失败）。选择器/FileProvider 只放行这个副本。 */
  @JavascriptInterface
  fun exportSettingsDocument(): String = onExportSettingsDocument()
  /** Immersive status bar toggle (true = status bar normally hidden); called by Settings → General. */
  @JavascriptInterface
  fun setImmersiveMode(enable: Boolean) {
    onSetImmersiveRequest(enable)
  }

  /**
   * ST-10（F-APK-06 / F-UI-05 三方分裂 #1）：沉浸式**读**面——页面以壳侧值为唯一初值。
   * 只有 setter 时，用 `adb shell` 直接改壳偏好（绕过页面）后重开设置页显示不一致。
   */
  @JavascriptInterface
  fun getImmersiveMode(): Boolean = onGetImmersiveMode()

  /**
   * Native clipboard write (navigator.clipboard.writeText in WebView is always rejected on Android
   * with NotAllowedError: Write permission denied, so the page falls back to this bridge after
   * writeClipboard fails). Returns whether the write succeeded.
   */
  @JavascriptInterface
  fun copyText(text: String): Boolean = onCopyTextRequest(text)

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

  /** 0.13.7：把路径交给系统选择器（MT 管理器 / 系统文件管理…；返回 JSON {ok, reason?}）。 */
  @JavascriptInterface
  fun openPathChooser(path: String, mode: String?): String = onOpenPathChooser(path, mode)

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

  /** Dev debug-log toggle state (default off; persisted via SharedPreferences).
   *  ST-11：返回值 = 偏好 **&&** 采集器在跑——EngineService.onDestroy 无条件停采集器，
   *  此后只回读偏好就是乐观置位（开关显示「开」而日志文件不再增长）。 */
  @JavascriptInterface
  fun getDevLogEnabled(): Boolean = onGetDevLogEnabled() && LogCollector.isRunning()

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

  /** 悬浮球开关态（持久化；开发者选项 → 悬浮球）。 */
  @JavascriptInterface
  fun getOverlayEnabled(): Boolean = onGetOverlayEnabled()

  /** 悬浮球开关（控制器负责权限引导）；返回当前是否已启动。 */
  @JavascriptInterface
  fun setOverlayEnabled(enable: Boolean): Boolean = onSetOverlayEnabled(enable)

  /** User-owned screen-access scope. Model tools never call this setter. */
  @JavascriptInterface
  fun getScreenScope(): String = onGetScreenScope()

  /** Persist one normalized screen scope selected from the DSH settings surface. */
  @JavascriptInterface
  fun setScreenScope(scope: String): String = onSetScreenScope(scope)

  /** CWD for the external-open blank session; source file names and paths remain queue-private. */
  @JavascriptInterface
  fun incomingWorkspacePath(): String = onIncomingWorkspacePath()

  /** BrowserHost current lifecycle/navigation state for the Files-sidebar workbench. */
  @JavascriptInterface
  fun browserHostStatus(): String = onBrowserHostStatus()

  /** Lazily create/show BrowserHost and optionally navigate to one http(s) URL. */
  @JavascriptInterface
  fun browserHostShow(url: String?): String = onBrowserHostShow(url)

  /**
   * review C12/C24（2026-09-14 设备实测）：TS 类型面把 url 声明为可选（`browserHostShow?: (url?)`），
   * 而 WebView 的 JS 桥按**实参个数**匹配 Java 方法——只有单参重载时零参调用抛 `Error: Method not found`
   * （真机/模拟器实测复现）。这里补零参重载，与显式 `null` 完全同义（再次显示已创建的工作台）。
   */
  @JavascriptInterface
  fun browserHostShow(): String = onBrowserHostShow(null)

  /** Hide BrowserHost while retaining the current page in its one-tab workbench. */
  @JavascriptInterface
  fun browserHostHide(): String = onBrowserHostHide()

  /** Reload the BrowserHost page. */
  @JavascriptInterface
  fun browserHostReload(): String = onBrowserHostReload()

  /** Update BrowserHost overlay bounds from the trusted DSH sidebar stage. */
  @JavascriptInterface
  fun browserHostBounds(bounds: String): String = onBrowserHostBounds(bounds)

  /** Select a letterboxed BrowserHost viewport without transforming touch coordinates. */
  @JavascriptInterface
  fun browserHostViewport(viewport: String): String = onBrowserHostViewport(viewport)

  /** Close (destroy) the BrowserHost page; the workbench can be opened fresh afterwards. */
  @JavascriptInterface
  fun browserHostClose(): String = onBrowserHostClose()

  /** Switch the BrowserHost identity profile (PC / mobile); payload is {profile, ua}. */
  @JavascriptInterface
  fun browserHostIdentity(payload: String): String = onBrowserHostIdentity(payload)

  /** Virtual-display state/actions for the trusted Files-sidebar panel. */
  @JavascriptInterface
  fun vdisplayStatus(): String = onVdisplayStatus()

  @JavascriptInterface
  fun vdisplayCreate(): String = onVdisplayCreate()

  @JavascriptInterface
  fun vdisplayDestroy(): String = onVdisplayDestroy()

  /** Trusted virtual-screen viewer geometry from the Files-sidebar stage. */
  @JavascriptInterface
  fun vdisplayBounds(bounds: String): String = onVdisplayBounds(bounds)

  /** Select the controller-owned presentation target; real screen rejects with a structured code. */
  @JavascriptInterface
  fun vdisplaySelect(alias: String): String = onVdisplaySelect(alias)

  /** 0.14.0：虚拟屏分辨率档位读写（设置页「手机控制」）。 */
  @JavascriptInterface
  fun getVdisplayScale(): Double = onGetVdisplayScale()

  @JavascriptInterface
  fun setVdisplayScale(value: Double): Double = onSetVdisplayScale(value)

  /** 0.14.0：退后台自动浮窗开关（设置页「手机控制」）。 */
  @JavascriptInterface
  fun getVdisplayFloatEnabled(): Boolean = onGetVdisplayFloat()

  @JavascriptInterface
  fun setVdisplayFloatEnabled(enable: Boolean): Boolean = onSetVdisplayFloat(enable)

  /** 0.14.0：强制销毁全部虚拟屏（设置页「手机控制」三连点确认后调用）。 */
  @JavascriptInterface
  fun forceDestroyVdisplay(): String = onForceDestroyVdisplay()

  /** 0.13.5 W4：无障碍控制通道状态（设置页展示 + 引导）。 */
  @JavascriptInterface
  fun a11yStatus(): String = onA11yStatus()

  /** 0.13.5 W4：跳系统无障碍设置页（开启「DSH 设备控制」）。 */
  @JavascriptInterface
  fun openA11ySettings() {
    onOpenA11ySettings()
  }

  /** 0.13.5 W4：一键解锁受限设置（appops set … ACCESS_RESTRICTED_SETTINGS allow，走 ADB 通道）。 */
  @JavascriptInterface
  fun unlockRestrictedSettings(): String = onUnlockRestrictedSettings()

  /**
   * 0.14.1 块J FIX-4：通知设置读回（设置页「开发者选项」的初始态与写后读回）。
   *
   * 调用面 = 受信任 DSH 页面（`window.androidBridge`）；返回 `NotifyCenter.settingsSnapshot`
   * 的 JSON（`suppressForeground` / `suppressForegroundDefault` / `categories`）。
   * @param key 可选：只回读一个设置键（空串 = 全量快照）。回读**始终取壳侧真源**，不回显入参。
   */
  @JavascriptInterface
  fun getNotifySetting(key: String?): String = onGetNotifySetting(key ?: "")

  /**
   * 0.14.1 块J FIX-4：通知设置写入（key = `suppressForeground` 或 `cat.<category>`）。
   *
   * 返回写后读回的快照：`applied=true` 才代表生效；未知 key / 读回不一致一律如实回 `false`
   * （拒绝乐观置位，与 `ShellState.DevLogControl` 同纪律）。这是 FIX-4 的唯一页面上行入口。
   */
  @JavascriptInterface
  fun setNotifySetting(key: String, value: Boolean): String = onSetNotifySetting(key, value)

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

/**
 * JSON string literal escaping for evaluateJavascript payloads.
 *
 * 审查 §3.1-C3：`JSONObject.quote` 只处理 `" \ /` 与控制字符（< 0x20），**不转义
 * U+2028/U+2029**；而 ES2019 之前，行分隔符出现在字符串字面量里是 **SyntaxError**
 * （Chromium < 92）。后果形态很阴：模型 `browser_type` 一段含 U+2028 的正文（网页/JSON 里常见）
 * → 整段注入脚本解析失败 → `evaluateJavascript` 回调拿不到对象 → 工具回 **stale-ref**
 * （一个与真因毫无关系的错误码）→ 模型去重新 snapshot 而不是改变输入方式。
 * 一处修、全仓受益（所有经本函数拼装的注入脚本：TYPE_JS、ConfigTransfer 等）。
 */
internal fun jsString(value: String): String = JSONObject.quote(value)
  .replace(" ", "\u2028")
  .replace(" ", "\u2029")
