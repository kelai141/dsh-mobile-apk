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
  /** UI language: system, zh, or en; the shell preference is the truth source. */
  private val onGetUiLanguage: () -> String = { AppLanguage.MODE_SYSTEM },
  /**
   * Persist a UI language and mirror it into the dsh profile patch.
   * Returns the mode that is now stored (an unknown value falls back to system).
   */
  private val onSetUiLanguage: (mode: String) -> String = { AppLanguage.MODE_SYSTEM },
  /** ST-10：沉浸式**读**面（缺它就是三方分裂 #1：壳偏好与页面 localStorage 互不校验）。
   *  默认实现直接读壳侧单一真源（ShellAppContext 由 EngineAuth.initContext 绑定），
   *  因此 MainActivity 无需传参即可返回真实值。 */
  private val onGetImmersiveMode: () -> Boolean = { ImmersiveMode.current() },
  private val onCopyTextRequest: (text: String) -> Boolean = { false },
  private val onRequestClipboardText: (requestId: String) -> Unit = {},
  private val onCancelClipboardText: (requestId: String) -> Unit = {},
  private val pickToken: String? = null,
  private val onRestartEngine: () -> Boolean = { false },
  private val onShutdownToGuide: () -> Unit = {},
  private val onReloadWebUI: () -> Unit = {},
  private val onOpenConsole: () -> Unit = {},
  private val onGetDevLogEnabled: () -> Boolean = { false },
  private val onSetDevLogEnabled: (Boolean) -> Unit = {},
  private val onOpenNativePath: (path: String) -> Boolean = { false },
  /** 0.13.7：系统「打开方式」选择器（MT 管理器 / 系统文件管理…）。返回 JSON {ok, reason?}。 */
  private val onOpenPathChooser: (path: String, mode: String?) -> String =
    { _, _ -> """{"ok":false,"reason":"bridge not wired"}""" },
  /**
   * 0.15.0：文件「外部打开 / 转发」到别的应用（chooser 聚合 ACTION_VIEW + ACTION_SEND）。
   * kind 取 [FileExternalBridge.KIND_OPEN] / [FileExternalBridge.KIND_SHARE]；返回 JSON {ok, error?}。
   */
  private val onOpenFileExternal: (path: String, mime: String?, kind: String) -> String =
    { _, _, _ -> """{"ok":false,"error":"no-receiver"}""" },
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
  /** 0.14.3: narrow session/tab-addressed navigation, not a page JS or shell interface. */
  private val onBrowserHostCommand: (String) -> String = { _ -> """{"ok":false,"available":false,"reason":"browser-host-not-wired"}""" },
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
   * 0.14.1 设置页「手机控制」：外链唯一出口。页面只能传 key（`shizuku-download` /
   * `shizuku-tutorial`），URL 表在壳侧 [ExternalLinks]——页面不得传任意地址。
   */
  private val onOpenExternalLink: (String) -> String =
    { _ -> """{"ok":false,"reason":"bridge not wired"}""" },
  /** 0.14.1 设置页「手机控制」：拉起 Shizuku 管理器界面（未安装 → `not-installed`）。 */
  private val onOpenShizukuManager: () -> String =
    { """{"ok":false,"reason":"bridge not wired"}""" },
  /**
   * 0.14.1 设置页「手机控制」：Shizuku 特权通道**真实状态**（[ShizukuTransport.status] 全文）。
   *
   * 此前该页面拿不到任何 Shizuku 事实：唯一的间接来源是 `vdisplayStatus()`——它只在虚拟屏处于
   * blocked 时顺带透出 Shizuku 的 code/guidance，其余时候同一位置讲的是虚拟屏。于是标题写着
   * 「Shizuku 特权通道」、内容却是虚拟屏状态（0.14.1 UI 审查 P0）。本方法是那个错位的正解。
   */
  private val onShizukuStatus: () -> String = { """{"ok":false,"code":"shizuku-not-wired"}""" },
  /**
   * 0.14.2 P1：设置页「重置链接」——强制移除 Shizuku 侧 UserService + 清空绑定态（[ShizukuTransport.resetConnection]）。
   * 回写后读回的 status JSON；页面沿用既有 settleLinkCall 结算，不新造口径。
   */
  private val onResetShizukuConnection: () -> String =
    { """{"ok":false,"code":"shizuku-not-wired"}""" },
  /**
   * issue #262 免责门：打开 APK 内免责声明文档（[LocalDocs] 通道，页面不传路径）。
   * 需要 Activity 弹对话框，故由 MainActivity 接线；默认实现结构化拒绝（fail-closed）。
   */
  private val onOpenRootDisclaimer: () -> String =
    { """{"ok":false,"reason":"bridge not wired"}""" },
  /**
   * 2026-09-30：显式请求 Shizuku 授权（UI 线程 + 前台 Activity；需要 Activity 故由 MainActivity 接线）。
   * 后台自动请求落不到用户眼前 ⇒ 管理器「应用管理」列表里根本没有本应用、状态恒 denied。
   */
  private val onRequestShizukuPermission: () -> String =
    { """{"ok":false,"code":"shizuku-not-wired"}""" },
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
  /**
   * 0.14.1 批 4：通知**自检**（`NotifyCenter.selfCheck` 的页面入口）。
   *
   * 此前 `selfCheck` / `appSettingsIntent` / `channelSettingsIntent` 三者在页面侧**零调用点**：
   * 系统把渠道降级（用户关掉或 ROM 改了重要性）时，应用看得见、用户看不见，「系统已降级，
   * 应用无法调回」这句提示永远到不了用户眼前。与 FIX-4 同款修法：默认实现钉在真源上，
   * 不依赖 MainActivity 传参（漏接线这一失效形态从结构上消失）。
   */
  /**
   * 0.14.6：设置页「检查更新」入口（用户指令：更新 = 下载 APK 然后更新）。
   * 单方法 + action 参数（status/check/start），返回 JSON `{"ok":..,"state":..,...}`。
   * 同步桥不能回 Promise，长动作只能「发起 + 轮询 status」，故状态机放在壳侧（ApkUpdateAction）。
   */
  private val onApkUpdate: (String) -> String = { _ -> """{"ok":false,"state":"idle","reason":"bridge not wired"}""" },
  /**
   * 原生拍照（WebView「加号」面板的拍照瓦片）。
   *
   * 为什么签名是 `(action) -> String` 而不是直接返回结果：相机是**外部 Activity**，用户取景
   * 时间不可预知。同步桥会阻塞 WebView 的 JS 线程直到用户按快门（整页假死），因此这里只受理
   * 并立即返回 `{ok:true,accepted:true}`；最终结果由控制器在主线程用
   * `window.__dshBridge.onPhotoCaptured(payload)` 推回页面。
   * 接线在 MainActivity（那里才有 webView 与 Activity 作用域的 launcher）。
   */
  private val onCapturePhoto: ((action: String) -> String)? = null,
  private val onNotifySelfCheck: () -> String = {
    val app = ShellAppContext.get()
    if (app == null) """{"ok":false,"reason":"no-shell-context"}"""
    else NotifyCenter.selfCheck(app).toString()
  },
  /** 页面的「打开系统通知设置」入口（App 级）。 */
  private val onOpenNotifyAppSettings: () -> Boolean = { false },
  /** 页面的「打开该渠道的系统设置」入口（渠道级）。 */
  private val onOpenNotifyChannelSettings: (String) -> Boolean = { _ -> false },
  /**
   * 页面的「发送测试通知」入口（0.14.1 批 8 / S3-26）。
   *
   * 默认实现同样钉在真源上（`NotifyCenter.sendTestAll`），不依赖 MainActivity 传参——`sendTest`
   * 此前全仓零调用点的成因就是「能力在、没人接线」。返回实际投递条数（0 = 没发出去，页面如实提示）。
   */
  private val onNotifySendTest: () -> Int = {
    val app = ShellAppContext.get()
    if (app == null) 0 else NotifyCenter.sendTestAll(app)
  },
  /**
   * #686：顶层帧来源判据（MainActivity 以 `isEngineSource(webView.url)` 接线，与导航闸门
   * `shouldOverrideUrlLoading` 同一判据）。默认 fail-closed：未接线即拒——单独构造本类
   * （单测/复用）时宁可全拒也不裸放。
   */
  private val isTrustedTopFrame: () -> Boolean = { false },
) {

  /**
   * #686：桥面入口的顶层帧来源门禁（每个 `@JavascriptInterface` 方法第一件事）。
   *
   * `addJavascriptInterface` 把本对象暴露给**每一个 frame**，而壳侧导航闸门
   * （`shouldOverrideUrlLoading`）只拦主帧——不可信来源此前拿到的是完整能力面。Android
   * 无法在桥方法里识别「调用者来自哪个 frame」，本门禁守住另一条硬边界：**顶层帧必须始终
   * 是引擎 origin**（判据与导航闸门同源，见 [isTrustedTopFrame]）。顶层被劫持出引擎 origin
   * （子帧 top-navigation、外部跳转落回本 WebView）的形态被结构性关死。
   *
   * **如实登记的残余缺口**：引擎 origin 顶层**之下**的跨源子帧仍够得到桥面（本门禁按
   * WebView 级 URL 判定，无法按帧区分）；该形态的可达性未证实（issue #686 按「加固缺口」
   * 报）。彻底关法是 token 握手（JS 契约变更，跨仓协调），登记为后续项，不在本批范围。
   */
  private fun checkTrustedFrame() {
    if (!isTrustedTopFrame()) throw BridgeFrameDenied()
  }

  /** 表达式体入口的包裹形式（与 [checkTrustedFrame] 同判据）。 */
  private fun <T> trusted(block: () -> T): T {
    checkTrustedFrame()
    return block()
  }

  /** #686：不可信来源调用桥方法的结构化拒绝；页面侧表现为 JS 异常。 */
  class BridgeFrameDenied :
    SecurityException("androidBridge: untrusted frame (top frame is not the engine origin; #686)")

  @JavascriptInterface
  fun version(): String = trusted { BuildConfig.VERSION_NAME }

  /** Synchronous system-dark query (H1: the first-frame theme bridge pulls the real uiMode,
   *  bypassing vendor WebViews whose matchMedia is stuck on light). */
  @JavascriptInterface
  fun getSystemDark(): Boolean = trusted { onGetSystemDark() }

  @JavascriptInterface
  fun checkEngine(): String = trusted { EngineProbe.check().toString() }

  /**
   * Linux 环境资产准备（实验性内部插件，默认不启用）。
   *
   * 只接资产清单（`url`/`sha256`/`size`），落点由宿主按摘要自行推导；除非 Linux 环境在场
   * （根目录 + bootstrap 状态文件）一律拒绝，故它不会变成通用下载器。立即返回，结果用
   * [linuxAssetPrepareStatus] 轮询 —— 下载不得阻塞 WebView 的 JS 线程。
   */
  @JavascriptInterface
  fun linuxAssetPrepare(specJson: String): String = trusted { LinuxAssetPrepare.start(ShellAppContext.get()?.filesDir, specJson) }

  @JavascriptInterface
  fun linuxAssetPrepareStatus(): String = trusted { LinuxAssetPrepare.status() }

  @JavascriptInterface
  fun keepScreenOn(enable: Boolean) {
    checkTrustedFrame()
    onKeepScreen(enable)
  }

  @JavascriptInterface
  fun showNotification(title: String, text: String) {
    checkTrustedFrame()
    onNotify(title, text)
  }

  @JavascriptInterface
  fun pickDirectory(callbackId: String) {
    checkTrustedFrame()
    onPickRequest(callbackId)
  }


  /**
   * Absolute path of the Host settings document (`$DSH_HOME/settings.yaml`).
   * The mobile adaptation layer opens it through the shell chooser, because the upstream
   * "open configuration file" action delegates to a desktop native text editor (apk #152).
   */
  @JavascriptInterface
  fun settingsPath(): String = trusted { onSettingsPathRequest() }

  /** 配置文档副本的公共路径（空串 = 导出失败）。选择器/FileProvider 只放行这个副本。 */
  @JavascriptInterface
  fun exportSettingsDocument(): String = trusted { onExportSettingsDocument() }
  /** Immersive status bar toggle (true = status bar normally hidden); called by Settings → General. */
  @JavascriptInterface
  fun setImmersiveMode(enable: Boolean) {
    checkTrustedFrame()
    onSetImmersiveRequest(enable)
  }

  /**
   * ST-10（F-APK-06 / F-UI-05 三方分裂 #1）：沉浸式**读**面——页面以壳侧值为唯一初值。
   * 只有 setter 时，用 `adb shell` 直接改壳偏好（绕过页面）后重开设置页显示不一致。
   */
  @JavascriptInterface
  fun getImmersiveMode(): Boolean = trusted { onGetImmersiveMode() }

  /** Current UI language mode (system / zh / en); the shell preference is the truth source. */
  @JavascriptInterface
  fun getUiLanguage(): String = trusted { onGetUiLanguage() }

  /**
   * Store a UI language and sync it to dsh; returns the stored mode.
   * The caller reloads the page, so the new language is visible immediately.
   */
  @JavascriptInterface
  fun setUiLanguage(mode: String): String = trusted { onSetUiLanguage(mode) }

  /**
   * Native clipboard write (navigator.clipboard.writeText in WebView is always rejected on Android
   * with NotAllowedError: Write permission denied, so the page falls back to this bridge after
   * writeClipboard fails). Returns whether the write succeeded.
   */
  @JavascriptInterface
  fun copyText(text: String): Boolean = trusted { onCopyTextRequest(text) }

  /** Request a foreground native consent prompt; text arrives through dsh:clipboard-text. */
  @JavascriptInterface
  fun requestClipboardText(requestId: String) = trusted { onRequestClipboardText(requestId) }

  /** Revoke a disposed editor's outstanding native clipboard prompt. */
  @JavascriptInterface
  fun cancelClipboardText(requestId: String) = trusted { onCancelClipboardText(requestId) }

  /**
   * 0.13.1 W4：配置导出（私有 settings.yaml -> Documents/dshdata/exports/config/settings.yaml）。
   * 引擎 DSH_HOME 在私有域（外部改共享目录副本无效），本桥是安全的手改通道：
   * 导出 -> 文件管理器编辑 -> 导入。返回 JSON {ok, path?, error?}（同步执行，桥线程允许阻塞 IO）。
   */
  @JavascriptInterface
  fun exportConfig(): String = trusted { onExportConfig() }

  /** 0.13.1 W4：配置导入（exports/config/settings.yaml -> 私有 DSH_HOME；引擎 chokidar 热加载）。返回 JSON 同上。 */
  @JavascriptInterface
  fun importConfig(): String = trusted { onImportConfig() }

  /** True when the app holds All Files Access (external workspace requirement). */
  @JavascriptInterface
  fun hasAllFilesAccess(): Boolean {
    checkTrustedFrame()
    // isExternalStorageManager exists only on API 30+; older versions have no such permission model.
    if (android.os.Build.VERSION.SDK_INT < 30) return false
    return android.os.Environment.isExternalStorageManager()
  }

  /** 0.13.7：把路径交给系统选择器（MT 管理器 / 系统文件管理…；返回 JSON {ok, reason?}）。 */
  @JavascriptInterface
  fun openPathChooser(path: String, mode: String?): String = trusted { onOpenPathChooser(path, mode) }

  /**
   * 0.15.0：用别的应用打开这个文件（主意图 ACTION_VIEW + ACTION_SEND 作并列候选）。
   *
   * 参数名与顺序固定：页面按 (path, mime) 调用。
   *
   * @param path 设备绝对路径（必须在允许面内）。
   * @param mime 文件 MIME；空串 = 让系统按 Uri 推断。
   * @returns JSON {ok:true} 或 {ok:false, error:"no-receiver"|"uri-denied"|"io"|"bad-request", detail?}。
   */
  @JavascriptInterface
  fun openFileExternal(path: String, mime: String): String =
    // #686：表达式体入口用 trusted{} 包裹（与 checkTrustedFrame() 同判据）。
    trusted { onOpenFileExternal(path, mime, FileExternalBridge.KIND_OPEN) }

  /**
   * 0.15.0：把这个文件转发给别的应用（主意图 ACTION_SEND + ACTION_VIEW 作并列候选）。
   *
   * 参数名与顺序固定：页面按 (path, mime) 调用。
   *
   * @param path 设备绝对路径（必须在允许面内）。
   * @param mime 文件 MIME；空串 = 让系统按 Uri 推断。
   * @returns JSON {ok:true} 或 {ok:false, error:"no-receiver"|"uri-denied"|"io"|"bad-request", detail?}。
   */
  @JavascriptInterface
  fun shareFile(path: String, mime: String): String =
    // #686：同上，表达式体用 trusted{} 包裹。
    trusted { onOpenFileExternal(path, mime, FileExternalBridge.KIND_SHARE) }

  /** Open the system screen granting All Files Access (special permission). */
  @JavascriptInterface
  fun requestAllFilesAccess() {
    checkTrustedFrame()
    onAllFilesAccessRequest()
  }

  /**
   * One-shot session token for the directory-picker bridge (validated by the engine-side pick
   * endpoint; null = disabled).
   *
   * #686：本方法**不做**第二层凭据。整对象已在非放行帧被封死（见 BridgeOriginGuard），
   * 再加一层持有式凭据是冗余代码——实测证明跨源子帧连 window.androidBridge 都摸不到，
   * 到不了这里。保留正控断言（BridgeOriginGuardTest.pickTokenWorksOnAllowedFrame）
   * 守住「放行帧照常拿得到真值」这条行为即可。
   */
  @JavascriptInterface
  fun getPickToken(): String? = trusted { pickToken }

  /**
   * Restart the engine service process: kill the engine, the EngineService watchdog brings it back.
   *
   * S3-15：返回**是否真的发起了**重启（false = 已在重启中或上下文缺失）。页面据此决定要不要进入
   * 「重启中…」的忙碌态——旧实现是 void，页面只能假装忙碌两秒再自己变回。
   */
  @JavascriptInterface
  fun restartEngine(): Boolean = trusted { onRestartEngine() }

  /** Shut down the harness: stop the engine and fall back to the init (startup/test) screen (no auto-restart). */
  @JavascriptInterface
  fun shutdownToGuide() {
    checkTrustedFrame()
    onShutdownToGuide()
  }

  /** Refresh the Web UI (reloads the current engine page, issue apk#29 requirement 1). */
  @JavascriptInterface
  fun reloadWebUI() {
    checkTrustedFrame()
    onReloadWebUI()
  }

  /** Open the built-in console (snapshot bash interactive terminal; usable for diagnostics even when the engine is down). */
  @JavascriptInterface
  fun openConsole() {
    checkTrustedFrame()
    onOpenConsole()
  }

  /** Dev debug-log toggle state (default off; persisted via SharedPreferences).
   *  ST-11：返回值 = 偏好 **&&** 采集器在跑——EngineService.onDestroy 无条件停采集器，
   *  此后只回读偏好就是乐观置位（开关显示「开」而日志文件不再增长）。 */
  @JavascriptInterface
  fun getDevLogEnabled(): Boolean = trusted { onGetDevLogEnabled() && LogCollector.isRunning() }

  /** Set the dev debug-log toggle; when on, logs are written daily under dshdata/log/. */
  @JavascriptInterface
  fun setDevLogEnabled(enabled: Boolean) {
    checkTrustedFrame()
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
  fun openNativePath(path: String): Boolean = trusted { onOpenNativePath(path) }

  /** 悬浮球开关态（持久化；开发者选项 → 悬浮球）。 */
  @JavascriptInterface
  fun getOverlayEnabled(): Boolean = trusted { onGetOverlayEnabled() }

  /** 悬浮球开关（控制器负责权限引导）；返回当前是否已启动。 */
  @JavascriptInterface
  fun setOverlayEnabled(enable: Boolean): Boolean = trusted { onSetOverlayEnabled(enable) }

  /** User-owned screen-access scope. Model tools never call this setter. */
  @JavascriptInterface
  fun getScreenScope(): String = trusted { onGetScreenScope() }

  /** Persist one normalized screen scope selected from the DSH settings surface. */
  @JavascriptInterface
  fun setScreenScope(scope: String): String = trusted { onSetScreenScope(scope) }

  /** CWD for the external-open blank session; source file names and paths remain queue-private. */
  @JavascriptInterface
  fun incomingWorkspacePath(): String = trusted { onIncomingWorkspacePath() }

  /** BrowserHost current lifecycle/navigation state for the Files-sidebar workbench. */
  @JavascriptInterface
  fun browserHostStatus(): String = trusted { onBrowserHostStatus() }

  /** Session/occurrence-addressed browser commands for the trusted native adapter. */
  @JavascriptInterface
  fun browserHostCommand(payload: String): String = trusted { onBrowserHostCommand(payload) }

  /** Lazily create/show BrowserHost and optionally navigate to one http(s) URL. */
  @JavascriptInterface
  fun browserHostShow(url: String?): String = trusted { onBrowserHostShow(url) }

  /**
   * review C12/C24（2026-09-14 设备实测）：TS 类型面把 url 声明为可选（`browserHostShow?: (url?)`），
   * 而 WebView 的 JS 桥按**实参个数**匹配 Java 方法——只有单参重载时零参调用抛 `Error: Method not found`
   * （真机/模拟器实测复现）。这里补零参重载，与显式 `null` 完全同义（再次显示已创建的工作台）。
   */
  @JavascriptInterface
  fun browserHostShow(): String = trusted { onBrowserHostShow(null) }

  /** Hide BrowserHost while retaining the current page in its one-tab workbench. */
  @JavascriptInterface
  fun browserHostHide(): String = trusted { onBrowserHostHide() }

  /** Reload the BrowserHost page. */
  @JavascriptInterface
  fun browserHostReload(): String = trusted { onBrowserHostReload() }

  /** Update BrowserHost overlay bounds from the trusted DSH sidebar stage. */
  @JavascriptInterface
  fun browserHostBounds(bounds: String): String = trusted { onBrowserHostBounds(bounds) }

  /** Select a letterboxed BrowserHost viewport without transforming touch coordinates. */
  @JavascriptInterface
  fun browserHostViewport(viewport: String): String = trusted { onBrowserHostViewport(viewport) }

  /** Close (destroy) the BrowserHost page; the workbench can be opened fresh afterwards. */
  @JavascriptInterface
  fun browserHostClose(): String = trusted { onBrowserHostClose() }

  /** Switch the BrowserHost identity profile (PC / mobile); payload is {profile, ua}. */
  @JavascriptInterface
  fun browserHostIdentity(payload: String): String = trusted { onBrowserHostIdentity(payload) }

  /** Virtual-display state/actions for the trusted Files-sidebar panel. */
  @JavascriptInterface
  fun vdisplayStatus(): String = trusted { onVdisplayStatus() }

  @JavascriptInterface
  fun vdisplayCreate(): String = trusted { onVdisplayCreate() }

  @JavascriptInterface
  fun vdisplayDestroy(): String = trusted { onVdisplayDestroy() }

  /** Trusted virtual-screen viewer geometry from the Files-sidebar stage. */
  @JavascriptInterface
  fun vdisplayBounds(bounds: String): String = trusted { onVdisplayBounds(bounds) }

  /** Select the controller-owned presentation target; real screen rejects with a structured code. */
  @JavascriptInterface
  fun vdisplaySelect(alias: String): String = trusted { onVdisplaySelect(alias) }

  /** 0.14.0：虚拟屏分辨率档位读写（设置页「手机控制」）。 */
  @JavascriptInterface
  fun getVdisplayScale(): Double = trusted { onGetVdisplayScale() }

  @JavascriptInterface
  fun setVdisplayScale(value: Double): Double = trusted { onSetVdisplayScale(value) }

  /** 0.14.0：退后台自动浮窗开关（设置页「手机控制」）。 */
  @JavascriptInterface
  fun getVdisplayFloatEnabled(): Boolean = trusted { onGetVdisplayFloat() }

  @JavascriptInterface
  fun setVdisplayFloatEnabled(enable: Boolean): Boolean = trusted { onSetVdisplayFloat(enable) }

  /** 0.14.0：强制销毁全部虚拟屏（设置页「手机控制」三连点确认后调用）。 */
  @JavascriptInterface
  fun forceDestroyVdisplay(): String = trusted { onForceDestroyVdisplay() }

  /** 0.13.5 W4：无障碍控制通道状态（设置页展示 + 引导）。 */
  @JavascriptInterface
  fun a11yStatus(): String = trusted { onA11yStatus() }

  /** 0.13.5 W4：跳系统无障碍设置页（开启「DSH 设备控制」）。 */
  @JavascriptInterface
  fun openA11ySettings() {
    checkTrustedFrame()
    onOpenA11ySettings()
  }

  /** 0.13.5 W4：一键解锁受限设置（appops set … ACCESS_RESTRICTED_SETTINGS allow，走 Shizuku 特权 shell）。 */
  @JavascriptInterface
  fun unlockRestrictedSettings(): String = trusted { onUnlockRestrictedSettings() }

  /**
   * 0.14.1 设置页「手机控制」：打开登记在册的外部链接。
   * @param key 只能是 `shizuku-download` / `shizuku-tutorial`（[ExternalLinks.keys]）；未登记一律拒收。
   * @return JSON `{ok, reason?}`；reason ∈ `unknown-key` / `insecure-url` / `no-handler` / 异常类名。
   */
  @JavascriptInterface
  fun openExternalLink(key: String): String = trusted { onOpenExternalLink(key) }

  /**
   * 0.14.1 设置页「手机控制」：拉起 Shizuku 管理器界面。
   *
   * 授权只能由用户在 Shizuku 内完成（被提权方不得自改授权），故壳侧只负责把人送到界面；
   * 未安装时回 `{"ok":false,"reason":"not-installed"}`，由页面提示去下载。
   */
  @JavascriptInterface
  fun openShizukuManager(): String = trusted { onOpenShizukuManager() }

  /**
   * 0.14.1 设置页「手机控制」：Shizuku 特权通道状态（页面据此决定「打开 Shizuku」是否可点）。
   * 字段：`installed` / `running` / `granted` / `bound` / `binding` / `code` / `guidance` / `ok`。
   */
  @JavascriptInterface
  fun shizukuStatus(): String = trusted { onShizukuStatus() }

  /**
   * 0.14.2 P1 设置页「手机控制」：「重置链接」按钮。
   *
   * 做三件事（缺一即未完成）：强制移除 Shizuku 侧 UserService（承重墙）、清空绑定态、让 caps 缓存失效。
   * 随后页面每 2 秒的既有轮询会把通道重建结果读回来（不新开扫描机制）。
   * 返回写后回读的 status JSON；**不承诺已修好**——能否恢复取决于 Shizuku 服务本身是否还在运行。
   */
  @JavascriptInterface
  fun resetShizukuConnection(): String = trusted { onResetShizukuConnection() }

  /**
   * issue #262 设置页「手机控制」：「AI root 权限」读面（写后回读同源）。
   *
   * 默认实现钉在真源上（[RootGrant.state] + [ShizukuTransport] 的通道 uid），
   * 不依赖 MainActivity 传参——漏接线这一失效形态在结构上不可能（与通知设置读面同纪律）。
   * 字段：`granted` / `consentValid` / `channelUid` / `channelRoot` / `canToggle` / `honesty`。
   */
  @JavascriptInterface
  fun rootGrantState(): String {
    checkTrustedFrame()
    val app = ShellAppContext.get()
      ?: return """{"ok":false,"reason":"no-shell-context","canToggle":false,"channelRoot":false}"""
    return RootGrant.state(app, RootGrant.channelUidNow(app)).put("ok", true).toString()
  }

  /**
   * issue #262：开关写面。[RootGrant.setGranted] 判据（通道身份 root + 免责确认有效）全部
   * 满足才写入；返回写后读回的状态 JSON，拒绝时带 `code`/`guidance`（页面据此说话，不静默）。
   */
  @JavascriptInterface
  fun setRootGranted(on: Boolean): String {
    checkTrustedFrame()
    val app = ShellAppContext.get()
      ?: return """{"ok":false,"reason":"no-shell-context"}"""
    return RootGrant.setGranted(app, on).toString()
  }

  /**
   * issue #262：「已阅读」免责确认写面。取消勾选即撤销同意并**同时关闭开关**
   * （不留矛盾态）；同意绑定免责声明**内容**版本（[RootGrant.DISCLAIMER_REVISION]），
   * **不随 APK 升级失效**（0.14.7 修复：此前绑 versionCode，每次升级都掉）。
   */
  @JavascriptInterface
  fun setRootConsent(on: Boolean): String {
    checkTrustedFrame()
    val app = ShellAppContext.get()
      ?: return """{"ok":false,"reason":"no-shell-context"}"""
    return RootGrant.setConsent(app, on).toString()
  }

  /**
   * issue #262 免责门：打开本地免责声明（[LocalDocs.ROOT_DISCLAIMER]，APK assets，
   * 离线/随版本/不可远端替换）。页面不传路径，只触发这一条登记过的文档。
   */
  @JavascriptInterface
  fun openRootDisclaimer(): String = trusted { onOpenRootDisclaimer() }

  /**
   * 2026-09-30：**显式请求 Shizuku 授权**（必须在 UI 线程 + 前台 Activity 上发起，
   * 否则授权对话框落不到用户眼前；由 MainActivity 接线，见 `onRequestShizukuPermission`）。
   */
  @JavascriptInterface
  fun requestShizukuPermission(): String = trusted { onRequestShizukuPermission() }

  /**
   * 2026-09-30 主人定例：应用级 root 授权状态读面（**纯读，永不触发授权弹窗**）。
   *
   * 字段：`suExists` / `suPath` / `state`（unknown|requesting|granted|denied|timeout|no-su）/
   * `uid` / `granted` / `requesting` / `manager{package,label,installed}` / `guidance`。
   * 默认实现钉在真源上（[RootAccess.state]），不依赖 MainActivity 传参。
   */
  @JavascriptInterface
  fun rootAccessState(): String {
    checkTrustedFrame()
    val app = ShellAppContext.get()
      ?: return """{"ok":false,"reason":"no-shell-context","state":"unknown","granted":false}"""
    return RootAccess.state(app).put("ok", true).toString()
  }

  /**
   * 2026-09-30 主人定例：**显式检测/请求 root 授权**——后台跑一次 `su -c id` 取真实身份。
   * ★主人同日指正：多数管理器**不会**因此自动弹授权框（除 Magisk 外得自己打开管理器授予）✗
   * ⇒ 本方法只承诺「取一次真实身份并如实回报」，不承诺弹窗 ✓。
   *
   * 非阻塞（后台线程 + 25s 有界超时）：立即返回 `{ok:true,code:request-started}`，
   * 结果由页面既有 2s 轮询经 [rootAccessState] 看到；幂等（在飞时不重复起，避免弹窗连发）。
   */
  @JavascriptInterface
  fun requestRootAccess(): String {
    checkTrustedFrame()
    val app = ShellAppContext.get()
      ?: return """{"ok":false,"reason":"no-shell-context"}"""
    return RootAccess.requestGrant(app).toString()
  }

  /**
   * 2026-09-30 主人指正后**移除**了「打开 Root 管理器」入口（见 [RootAccess] 的类注释）：
   * 各家管理器包名/入口不一（还可能根本没有管理器 App），打开不保证成功 ✗；而能刷 root 的用户
   * 自己会开管理器 ✓ ⇒ 只保留「检测/请求 root 授权」＋诚实引导文案。
   *
   * 保留此注释是为了让后来者知道这里**曾经**有这个方法、以及为什么删掉（别再捡回来 ✗）。
   */

  /**
   * 2026-09-30 主人定例（「Root 属主这种 bug 也得找一找修一修」）：root 通道写盘属主自愈。
   *
   * root 通道（Shizuku 以 root 启动）里 UserService 的 uid=0，它写的文件属主是 root:root；
   * 落进应用数据目录（files/...）就是**应用自己读不回来**（0600）⇒ watcher / 插件更新 /
   * 引擎读写失败。本方法异步启动单飞、有界深度修复（Shizuku root 或显式授权 su）。
   * 立即返回 `{ok, code:repair-started|repair-running, running, startedAt, ...}`；
   * `rootGrantState().ownership` 的既有轮询读取真实结算 `result`，提交成功不等于修复完成。
   */
  @JavascriptInterface
  fun repairRootOwnership(): String {
    checkTrustedFrame()
    val app = ShellAppContext.get()
      ?: return """{"ok":false,"reason":"no-shell-context"}"""
    return RootOwnershipJobs.request(app).toString()
  }

  /**
   * 0.14.1 块J FIX-4：通知设置读回（设置页「开发者选项」的初始态与写后读回）。
   *
   * 调用面 = 受信任 DSH 页面（`window.androidBridge`）；返回 `NotifyCenter.settingsSnapshot`
   * 的 JSON（`suppressForeground` / `suppressForegroundDefault` / `categories`）。
   * @param key 可选：只回读一个设置键（空串 = 全量快照）。回读**始终取壳侧真源**，不回显入参。
   */
  @JavascriptInterface
  fun getNotifySetting(key: String?): String = trusted { onGetNotifySetting(key ?: "") }

  /**
   * 0.14.1 块J FIX-4：通知设置写入（key = `suppressForeground` 或 `cat.<category>`）。
   *
   * 返回写后读回的快照：`applied=true` 才代表生效；未知 key / 读回不一致一律如实回 `false`
   * （拒绝乐观置位，与 `ShellState.DevLogControl` 同纪律）。这是 FIX-4 的唯一页面上行入口。
   */
  @JavascriptInterface
  fun setNotifySetting(key: String, value: Boolean): String = trusted { onSetNotifySetting(key, value) }

  /**
   * 0.14.6：APK 自更新入口（设置页「检查更新」行）。
   *
   * @param action `status`（只读当前状态，**不发起任何网络/安装动作**）/ `check`（发起检查）/
   *   `start`（确认下载并安装：下载 → 体积与 sha256 校验 → 拉起系统安装器；未持安装权限时先拉授权页
   *   并回 `need-permission`）。
   * @return JSON：`{"ok":bool,"state":"idle|checking|up-to-date|available|downloading|installing|need-permission|failed", ...}`
   *   —— `ok` 只表示**这次调用是否被受理**，不表示更新成功；`reason` 一律是用户可读中文
   *   （不含内部标识符）。
   *
   * 与既有「检查更新」按钮（引导页）**共用同一状态机**，两入口不会互相打架；
   * 全程无自动请求：必须用户显式点 `check` / `start`。
   */
  @JavascriptInterface
  fun apkUpdate(action: String): String = trusted { onApkUpdate(action) }

  /**
   * 0.14.1 批 4：通知自检（每个渠道的系统实际状态 + 是否被降级 + 该走哪个设置页）。
   *
   * 返回 `{ok, channels:[{category,label,channelId,importance,enabled,silenced?}], degraded:[...]}`
   * ——页面据此显示「系统已降级，应用无法调回」并给出直达系统设置的入口（此前这条信息零调用点）。
   */
  /**
   * 原生拍照：发起一次系统相机取景，结果经 [PhotoCapture.okPayload] / [PhotoCapture.errorPayload]
   * 的 JSON 回到页面（进程内回调，见 [onCapturePhoto]）。
   *
   * 为什么返回「已受理」而不是最终结果：见 [onCapturePhoto] 的说明——相机等待时间不可预知。
   * 页面拿到 `{ok:true,accepted:true}` 只表示**请求已受理**，不表示拍到了；
   * 拍的成败由回执里的 `ok` + `code` 决定（与 apkUpdate 的「ok 只表示受理」同一口径）。
   *
   * @param action 目前只有 `capture`（拍照）。留 action 参数是为了与 apkUpdate 同形，
   *   后续若加「重拍」之类的动作不必再动桥面。
   * @returns 受理结果 JSON；桥未接线时 `{ok:false,code:"not-wired"}`。
   */
  @JavascriptInterface
  fun capturePhoto(action: String): String = trusted {
    // #686：**每个** `@JavascriptInterface` 第一件事必须是 trusted{} —— 不可信 frame 拿到的是
    // 完整能力面，导航闸门只拦主帧。本入口在合并 #773 时是唯一漏网的一个
    //（AndroidBridgeFrameGuardTest.sweep_everyBridgeEntryIsGuardedFailClosed 扫出来的）。
    val handler = onCapturePhoto
    if (handler == null) """{"ok":false,"code":"not-wired"}""" else try {
      handler(action)
    } catch (t: Throwable) {
      """{"ok":false,"code":"failed","detail":""" + JSONObject.quote(t.message ?: t.javaClass.simpleName) + "}"
    }
  }

  @JavascriptInterface
  fun notifySelfCheck(): String = trusted { onNotifySelfCheck() }

  /** 打开系统的「本应用通知设置」页；返回是否真的拉起（false = 该 ROM 无此页，页面须如实提示）。 */
  @JavascriptInterface
  fun openNotifyAppSettings(): Boolean = trusted { onOpenNotifyAppSettings() }

  /** 打开某个渠道的系统设置页（channelId 由 notifySelfCheck 给出）；返回是否真的拉起。 */
  @JavascriptInterface
  fun openNotifyChannelSettings(channelId: String): Boolean = trusted { onOpenNotifyChannelSettings(channelId) }

  /**
   * 发送五类测试通知，返回实际投递条数（0..5）。
   * 让用户自证「关掉某类提醒 / 系统降级渠道之后，任务完成还会不会提醒我」——渠道状态由
   * `notifySelfCheck` 给出，本方法给的是**实际到达效果**。
   */
  @JavascriptInterface
  fun notifySendTest(): Int = trusted { onNotifySendTest() }

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
 * （Chrome 74；minSdk 26 的机器可能带旧 WebView，故按旧引擎口径防御）。后果形态很阴：模型 `browser_type` 一段含 U+2028 的正文（网页/JSON 里常见）
 * → 整段注入脚本解析失败 → `evaluateJavascript` 回调拿不到对象 → 工具回 **stale-ref**
 * （一个与真因毫无关系的错误码）→ 模型去重新 snapshot 而不是改变输入方式。
 * 一处修、全仓受益（所有经本函数拼装的注入脚本：TYPE_JS、ConfigTransfer 等）。
 */
internal fun jsString(value: String): String = escapeLineSeparators(JSONObject.quote(value))

/**
 * 把**裸行分隔符**换成 `\uXXXX` 转义文本（纯函数：单测直接判形态，不受 org.json 实现差异影响）。
 * 方向只能是「裸字符 → 转义文本」；反向替换（把转义文本再转义一次）会改变字符串语义。
 */
internal fun escapeLineSeparators(quoted: String): String = quoted
  .replace(" ", "\\u2028")
  .replace(" ", "\\u2029")
