package com.dsharnessmobile.shell

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import kotlin.math.ceil

/**
 * Shell activity: WebView over the local dsh engine + engine guide fallback.
 *
 * 职责收窄（拆分重构）：本类只保留 WebView 宿主/生命周期/桥接线/insets 核心；
 * 引导页渲染→GuidePageRenderer、启动流/监控→EngineStartFlow、下载落盘→DownloadSaver、
 * 配置导入导出/文件选择→ConfigTransfer、路径打开→PathOpen、来件接线→FileIncoming、
 * 文件选择/SAF→DirectoryPickerController/MediaPickController、窗口 UI chrome→WebUiChrome。
 */
class MainActivity : ComponentActivity() {

  internal lateinit var webView: WebView
    private set
  internal lateinit var guideView: LinearLayout
    private set
  /** True only after WebView reported a load error for the local engine origin. */
  @Volatile
  internal var enginePageFailed = false
  /** System insets in CSS px, cached until the engine page is ready to receive them. */
  private var webSystemBottomInset = 0
  private var webSystemTopInset = 0
  private var webImeBottomInset = 0
  /** Coalesces rapid IME animation callbacks into one WebView evaluation per UI turn. */
  private var webInsetsPushScheduled = false
  /** 目录选择桥鉴权 token（进程级共享：MainActivity 重建/看门狗重启不更换，
   *  与引擎 env 的 DSH_PICK_TOKEN 始终一致；C1 修复）。 */
  private val pickToken: String = EngineManager.ensurePickToken()

  /** 跨类 ::isInitialized 形式（EngineStartFlow 监控/冻结看门狗用；语义等价原 lambda 内检查）。 */
  internal val webViewReady: Boolean get() = ::webView.isInitialized
  internal val guideViewReady: Boolean get() = ::guideView.isInitialized

  internal val guideRenderer by lazy { GuidePageRenderer(this) }
  internal val engineFlow by lazy { EngineStartFlow(this) }
  internal val engineManager by lazy { EngineManager(this, pickToken) }
  private val downloadSaver by lazy { DownloadSaver(this, engineManager.dshDataDir) }
  // 文件选择/SAF 与媒体选择控制器：字段初始化即注册 ActivityResult（必须在 STARTED 前；
  // 与拆分前 MainActivity 字段初始化时序一致）。
  internal val dirPickerController = DirectoryPickerController(this)
  internal val mediaPickerController = MediaPickController(this)
  /** 窗口/页面 UI chrome（沉浸式/字体/剪贴板/常亮/主题推送）。 */
  private val uiChrome = WebUiChrome(this)

  /** 崩溃标记：记录未捕获异常摘要，下次启动测试界面提示（不吞异常）。 */
  internal var crashInfo: String? = null
  /** 用户主动关闭后，前台监控与任何尚未结束的启动线程不得重新展示 WebUI。 */
  @Volatile
  internal var userClosedEngine = false

  private val notificationPermission =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* test channel only */ }

  companion object {
    private const val TAG = "dsh-shell"
    const val ACTION_UPDATE = "com.dsharnessmobile.shell.action.UPDATE"

    /** #120：显式拒绝哨兵路径前缀（引擎侧识别为拒绝而非取消，见 host-web-compat）。
     *  协议：`__dsh_pick_refused__:<reason>`，reason = permission-denied | android-10。 */
    const val PICK_REFUSED_PREFIX = "__dsh_pick_refused__:"

    /**
     * #128 L1：控制面（无障碍服务）读取/操作**自有 WebView** 的 DOM 需要拿到实例。
     * 只在 Activity 存活期间非空；控制服务拿到 null 即回「页面不在场」。
     */
    @Volatile
    internal var webViewRef: WebView? = null
  }

  // —— 引擎流 / 引导页委托（原位一行委托到协作类；引擎启动与引导页状态渲染
  //    的调用面保持不变：onCreate/onResume/监控/WebViewClient/引导按钮共用入口）。 ——

  /** 引擎启动流（委托 EngineStartFlow.start）。 */
  internal fun startEngineFlow() = engineFlow.start()

  /** 引导页状态渲染（委托 GuidePageRenderer；EngineStartFlow/前台监控经此驱动）。 */
  internal fun applyGuidePhase(phase: GuidePhase, title: String, hint: String? = null) =
    guideRenderer.applyGuidePhase(phase, title, hint)

  /** 回退测试界面（委托 GuidePageRenderer）。 */
  internal fun showGuide() = guideRenderer.showGuide()

  /** 恢复 WebUI（委托 GuidePageRenderer）。 */
  internal fun showWeb() = guideRenderer.showWeb()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // 0.13.3 W2：引擎鉴权模块绑定应用上下文（EngineProbe 等 object 调用方的 cookie 来源）。
    EngineAuth.initContext(this)
    // 崩溃标记：进程级未捕获异常写入 filesDir/.crashed（下次启动测试界面
    // 提示），随后交回默认 handler——只记录，不吞异常、不阻止崩溃。
    installCrashMarker()
    // 启动即 TTL 清扫临时工作区（issue #60 F5.1：7 天过期文件自动回收）
    try { FileIncoming.sweepExpired(this) } catch (_: Throwable) {}
    // 通知权限首启注册（issue #80 反馈实锤 2026-08-24）：Android 13+ POST_NOTIFICATIONS
    // 默认拒绝——不主动请求则引擎任务完成/授权请求等 NotifyCenter 通知全部静默丢弃。
    // 授权回调沿用 showTestNotification 的 launch（后果一致：拒绝即静默降级）。
    registerNotificationAsync()
    val crashFile = File(filesDir, ".crashed")
    if (crashFile.exists()) {
      crashInfo = try { crashFile.readText() } catch (_: Exception) { null }
      crashFile.delete()
    }
    // 开发者日志开关已开（上次会话）：进程启动即恢复收集。
    if (DevLogPrefs.isEnabled(this)) {
      LogCollector.start(this)
      LogCollector.log("dsh-shell", "app onCreate (dev log on)")
    }
    // 沉浸式：内容延伸到系统栏区域（状态栏常态收起，边缘滑动临时呼出）。
    WindowCompat.setDecorFitsSystemWindows(window, false)
    // 0.13.7fx-1（真机反馈）：只做 edge-to-edge 还不够——有挖孔/刘海的机器上，系统默认把窗口内容
    // 拦在挖孔下方，最顶部（原状态栏位置）留出一条窗口底色，用户看到「最顶部的黑带」。
    // 允许内容画进短边挖孔区，内容避让交给推给页面的 --dsh-android-system-top。
    if (android.os.Build.VERSION.SDK_INT >= 28) {
      window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode =
          android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
      }
    }
    uiChrome.applyImmersive(uiChrome.immersivePrefs())
    val root = FrameLayout(this)
    webView = WebView(this).apply {
      id = View.generateViewId()
      visibility = View.GONE
    }
    webViewRef = webView
    root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    guideView = guideRenderer.buildGuideView()
    root.addView(guideView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    setContentView(root)
    ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
      val mandatoryGestures = insets.getInsets(WindowInsetsCompat.Type.mandatorySystemGestures()).bottom
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val density = resources.displayMetrics.density
      // Edge-to-edge (setDecorFitsSystemWindows(false)) means the page owns the
      // status-bar strip; with the immersive toggle off the bar is visible and
      // would cover the mobile top bar / settings header (issue #135). bars.top
      // is 0 while the bar is hidden, so this tracks the toggle for free.
      webSystemTopInset = pxToCssPx(maxOf(bars.top, cutout.top), density)
      webSystemBottomInset = pxToCssPx(maxOf(bars.bottom, mandatoryGestures), density)
      webImeBottomInset = pxToCssPx(ime, density)
      // #197（机制①）：edge-to-edge 下 WebView 的**布局尺寸从不随 IME 变化**（布局视口恒 800），
      // 页面只把 frame 高度钉成 visualViewport.height → 输入框在布局里仍在页面底部，Chrome 按
      // 「把它滚进可视区」平移视觉视口；页面随后缩短 frame，Chrome 不重算 → offsetTop 残留
      // （实测 ime=371 ↔ vvTop=371），表现为键盘弹起后底部一大片空白。
      // 修法：把 IME inset 施加到 WebView 自身的**布局尺寸**上（底 padding 收缩内容盒）——
      // 布局视口真的变短，浏览器就没有可平移的余地，机制① 从根上消失；只推 CSS 变量做不到这点。
      if (webViewReady) {
        webView.setPadding(0, 0, 0, ime)
      }
      scheduleWebInsetsPush()
      if (guideViewReady) {
        val gutter = resources.getDimensionPixelSize(R.dimen.ds_guide_gutter)
        guideView.setPadding(
          gutter,
          gutter + bars.top,
          gutter,
          gutter + maxOf(bars.bottom, ime),
        )
      }
      insets
    }
    ViewCompat.requestApplyInsets(root)
    configureWebView()
    // 0.13.8 #183：键盘广播 nonce（应用私有文件，引擎子进程经 DSH_FILES_DIR 读取，
    // manage 插件广播时 --es auth 携带；幂等）。
    try { AdbKeyboardService.ensureNonce(this) } catch (_: Throwable) {
    }
    // Testable update trigger: adb am start -n .../.MainActivity -a com.dsharnessmobile.shell.action.UPDATE
    if (intent?.action == ACTION_UPDATE) {
      engineFlow.runUpdate()
    } else {
      // 来件接线（VIEW/SEND 外部来件）已迁至 FileIncoming.processIncomingIntent：
      // 校验净化→后台拷贝临时工作区→待发清单投递引擎侧插件；拒绝/失败经 showTestNotification 提示。
      // 0.13.8 #174：startEngineFlow 提前——引擎启动是异步的，先拉起缩短
      // 「拷完 POST 早于引擎 listen」的竞态窗口（投递另有待发清单 + 引擎就绪钩子兜底）。
      startEngineFlow()
      FileIncoming.processIncomingIntent(this, intent) { title, text -> showTestNotification(title, text) }
    }
  }

  /** 任务移除清理见 EngineService.onTaskRemoved（生命周期礼仪 F5.3：让位+尽力清理，不反弹）。 */

  /** 首启向导已移除（决策 2026-08-23）：初始页（GuideChrome 运行时状态/解压进度/崩溃/日志）
   *  已足够承载首启信息；配置项（共享目录/镜像/ADB 授权）经设置面与「工具与环境」页承托。 */

  override fun onResume() {
    super.onResume()
    // 前台引擎监控：引擎被杀/崩溃时自动回退测试界面，恢复后回 WebUI。
    if (!userClosedEngine) {
      engineFlow.startMonitor()
    }
    // 2026-08-24 修复（真机实锤：通知链路不消费的根因）：startEngineService（foreground service
    // + WatchdogV2 tick）此前只在 startEngineFlow 首次轮询成功时挂载——**引擎先跑、app 后启动
    // （后台恢复/热启动）时服务从未启动 → watchdog 缺失 → 通知消费（task-done 标记）/自动回退
    // /唤醒锁全链路失效**。onResume 幂等确保服务启动（已在跑则 no-op）。
    if (!userClosedEngine) {
      engineFlow.startEngineService()
    }
    // 悬浮球页面避让帧消费者（OverlayService → WebView body padding；先于
    // ensureStarted 注册——startService 的 onCreate 同步 emit 首帧，注册晚了会丢帧）。
    OverlayService.frameConsumer = { js ->
      runOnUiThread {
        try {
          if (::webView.isInitialized) webView.evaluateJavascript(js, null)
        } catch (_: Exception) {
        }
      }
    }
    // 0.13.2 W7：悬浮球开关已开时补启（含从系统授权页返回的场景——权限授予后 onResume 自动拉起）。
    OverlayController.ensureStarted(this)
    // ADB 端口后台预取（配对页秒回，不再同步等 NSD——2026-08-27 报障修复；15s TTL 内不重扫）。
    // F1 常驻预热同线程搭车：server 就绪 + 密钥生成移出配对关键路径（2026-08-27 配对窗口实锤修复）。
    try {
      Thread { AdbState.prewarm(engineManager); AdbState.prefetchPorts(this, engineManager) }.start()
    } catch (_: Throwable) {
    }
    // Back from the directory picker / Termux: re-route if the engine came up.
    // 仅当 WebView 未展示（引导页/首次启动）时才探测并重路由；相册/文件选择器
    // 返回时 WebView 已可见，探测超时会误触发 showWeb→reload，导致 JS 状态丢失。
    guideRenderer.refreshGuideMeta()
    if (!userClosedEngine && webView.visibility != View.VISIBLE && !EngineProbe.check().optBoolean("running", false)) startEngineFlow()
    // 主题补推：从系统设置/SAF 返回时系统主题可能已变（兜底桥时序覆盖）。
    if (::webView.isInitialized) {
      pushSystemDark(webView)
      pushWebInsets()
    }
    // M3：从系统授权页返回——上次 pick 因缺权限挂起时按授权结果续启/结算（迁至 DirectoryPickerController）。
    dirPickerController.settlePendingOnResume()
    // 0.13.8 批 H：从「安装未知应用」授权页返回——已授权则续继 APK 更新包的安装。
    guideRenderer.settlePendingInstall()
  }

  /** 窗口重新获得焦点时重应用沉浸式（系统栏 flag 会随焦点变化被重置）。 */
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) applyImmersive(immersivePrefs())
  }

  /** 沉浸式状态栏持久化读取（设置 → 通用设置 开关；默认收起）。 */
  private fun immersivePrefs(): Boolean {
    return try {
      getSharedPreferences("dsh_settings", MODE_PRIVATE).getBoolean("immersive_mode", true)
    } catch (_: Exception) {
      true
    }
  }

  /** 状态栏常态收起（沉浸式）：隐藏系统栏，边缘滑动临时呼出后自动收起。 */
  private fun applyImmersive(enabled: Boolean) {
    try {
      if (Build.VERSION.SDK_INT >= 30) {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        if (enabled) {
          controller.hide(WindowInsetsCompat.Type.statusBars())
          controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
          controller.show(WindowInsetsCompat.Type.statusBars())
        }
      } else {
        val flags = if (enabled) {
          View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        } else {
          0
        }
        window.decorView.systemUiVisibility = flags
      }
    } catch (t: Throwable) {
      Log.e("dsh-image", "applyImmersive failed: " + t.message)
    }
  }

  /** 沉浸式开关（JS 桥）：应用 + 持久化。 */
  private fun setImmersivePersisted(enabled: Boolean) {
    runOnUiThread { applyImmersive(enabled) }
    try {
      getSharedPreferences("dsh_settings", MODE_PRIVATE).edit().putBoolean("immersive_mode", enabled).apply()
      Log.i("dsh-image", "immersive set: " + enabled)
    } catch (e: Exception) {
      Log.e("dsh-image", "immersive persist failed: " + e.message)
    }
  }

  override fun onDestroy() {
    super.onDestroy()
    // #128 L1：控制面不再持有已销毁 Activity 的 WebView。
    webViewRef = null
    // 悬浮球避让帧消费者清除（Service 侧持有引用，避免 Activity 泄漏）
    OverlayService.frameConsumer = null
    engineFlow.stopMonitoring()
    dirPickerController.cancelTtl()
    guideRenderer.cancelPulse()
    // 兜底释放：Activity 销毁时清掉可能仍持有的屏幕常亮锁。
    try {
      if (screenWakeLock != null) {
        screenWakeLock?.release()
        screenWakeLock = null
      }
    } catch (_: Exception) {
    }
    if (::webView.isInitialized) {
      themeRetryRunnable?.let { webView.removeCallbacks(it) }
      webView.destroy()
    }
    // EngineService owns the child lifecycle. An Activity can be recreated by
    // rotation, OEM memory policy, or a WebView transition without meaning that
    // the user asked to interrupt an active agent turn.
  }

  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    pushSystemDark(webView)
    pushWebInsets()
  }

  override fun onBackPressed() {
    if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
  }

  private fun configureWebView() {
    // WebView 远程调试（debug 构建）：真机/模拟器 CDP 自动化验证 UI 行为。
    // AGP 8 默认不生成 BuildConfig，用 debuggable 标志判断。
    val debuggable = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
    if (debuggable) android.webkit.WebView.setWebContentsDebuggingEnabled(true)
    webView.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      // 禁用 HTTP 缓存：杜绝 WebView 命中旧 index/旧 bundle 造成"卡 loading 且
      // 无诊断层"（缓存页里没有页面看门狗；荣耀/MagicUI 实测类问题）。
      cacheMode = WebSettings.LOAD_NO_CACHE
      // 0.13.3：textZoom 持久化退役（D6 收益省略）——上游 ui-theme fontSize 原生管内容字号。
      // prefers-color-scheme 跟随系统深色（某些厂商 WebView 默认不跟随；
      // FORCE_DARK_AUTO 让 media query 反映系统深浅，dsh 的"跟随系统"主题依赖它）。
      if (Build.VERSION.SDK_INT >= 29) {
        @Suppress("DEPRECATION")
        forceDark = WebSettings.FORCE_DARK_AUTO
      }
    }
    webView.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        // 会话日志导出（issue apk#6 + 403 修复）：浏览器导航带 Origin:null /
        // sec-fetch-site 标记，会被 dsh 的 /api browser-trust fence 拒绝
        // （403 forbidden，防 DNS rebinding/跨站）。改为 app 内下载：
        // HttpURLConnection 无浏览器标记 → fence 放行（MuMu 实测验证）。
        if (isSessionExport(url, request.method)) {
          downloadSaver.downloadToDownloads(url, null)
          return true
        }
        // 只允许引擎同源页面留在 WebView（特权桥 + 下载能力仅对引擎可信）；
        // 外部链接交给系统浏览器，防止不可信页面获得桥能力（社工/通知轰炸/任意下载）。
        if (isEngineSource(url)) {
          view.loadUrl(url)
          return true
        }
        downloadSaver.openInExternalBrowser(request.url)
        return true
      }

      override fun onReceivedError(view: WebView, errorCode: Int, description: String, failingUrl: String) {
        if (isEngineSource(failingUrl)) {
          enginePageFailed = true
          showGuide()
        }
      }

      /**
       * A failed navigation fires onReceivedError and *then* onPageFinished, so the
       * error state must be cleared when the next load starts — clearing it in
       * onPageFinished would erase the evidence of the error page that is still on
       * screen, and showWeb() would then never reload it (measured 2026-09-08: after
       * a multi-minute snapshot refresh the WebView stayed on ERR_CONNECTION_REFUSED).
       */
      override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
        super.onPageStarted(view, url, favicon)
        if (isEngineSource(url)) enginePageFailed = false
      }

      override fun onPageFinished(view: WebView, url: String) {
        super.onPageFinished(view, url)
        pushSystemDark(view)
        pushWebInsets(view)
        // 悬浮球避让帧补放（启动期首帧注入若因页面未就绪落空，此处重放）
        if (isEngineSource(url)) OverlayService.instance?.replayFrame()
        if (isEngineSource(url) && !userClosedEngine) engineFlow.startFreezeWatchdog()
      }
    }
    // WebView 下载：会话日志导出与其余引擎源下载统一走 DownloadSaver（app 内
    // 下载优先 Documents/dshdata/exports，未授权回退 MediaStore.Downloads）。
    webView.setDownloadListener { url, _userAgent, contentDisposition, _mimeType, _contentLength ->
      downloadSaver.downloadToDownloads(url, contentDisposition)
    }
    webView.webChromeClient = object : WebChromeClient() {
      override fun onShowFileChooser(
        webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams,
      ): Boolean {
        // 文件上传/图片选择委托 MediaPickController（系统文件选择器或相册）。
        return mediaPickerController.handleFileChooser(filePathCallback, fileChooserParams)
      }

      override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean {
        // L6：不静默放大社工面——超长消息截断记录；页面确认仍自动放行
        // （移动 WebView 无原生 alert UI，confirm 阻塞会挂死页面）。
        if (message.length > 200) {
          Log.w(TAG, "js alert truncated (" + message.length + " chars): " + message.take(200))
        } else {
          Log.d(TAG, "js alert: " + message)
        }
        result.confirm()
        return true
      }
    }
    webView.addJavascriptInterface(
      AndroidBridge(
        onPickRequest = { callbackId -> dirPickerController.pickDirectoryWithPermissionCheck(callbackId) },
        onKeepScreen = { enable -> keepScreenOn(enable) },
        onNotify = { title, text -> NotifyCenter.notify(this, "task", title, text) },
        onAllFilesAccessRequest = { dirPickerController.openAllFilesAccessSettings() },

        onExportConfig = { ConfigTransfer(engineManager.homeDir, engineManager.dshDataDir).exportToShared() },
        onImportConfig = { ConfigTransfer(engineManager.homeDir, engineManager.dshDataDir).importFromShared() },
        onGetSystemDark = {
          (resources.configuration.uiMode and
            android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES
        },
        onSetImmersiveRequest = { enable -> setImmersivePersisted(enable) },
        onSettingsPathRequest = { engineManager.settingsDocumentPath() },
        onCopyTextRequest = { text -> copyTextNative(text) },
        pickToken = pickToken,
        onRestartEngine = { engineFlow.restart() },
        onShutdownToGuide = { engineFlow.shutdownToGuide() },
        onReloadWebUI = {
          webView.reload()
          showTestNotification("界面已刷新", "Web UI 已重新加载")
        },
        onOpenConsole = { startActivity(Intent(this, ConsoleActivity::class.java)) },
        onGetDevLogEnabled = { DevLogPrefs.isEnabled(this) },
        onSetDevLogEnabled = { enabled ->
          DevLogPrefs.setEnabled(this, enabled)
          if (enabled) {
            LogCollector.start(this)
            LogCollector.log("dsh-shell", "dev log enabled by user")
            showTestNotification(
              "开发者日志已开启",
              "运行日志按天写入 " + LogCollector.currentDir(this).absolutePath +
                "（共享存储，其他应用可读；启动令牌已自动脱敏，日志仍含命令与模型内容）",
            )
          } else {
            LogCollector.log("dsh-shell", "dev log disabled by user")
            LogCollector.stop()
            showTestNotification("开发者日志已关闭", "日志收集已停止")
          }
        },
        onOpenNativePath = { path -> FileIncoming.openWithExternalReader(this, path) },
        // 0.13.7：上游 0.1.5「在外部应用打开」的 Android 落点——系统选择器（MT 管理器 / 系统文件管理）。
        onOpenPathChooser = { path, mode -> PathOpen.openChooser(this, path, mode) },
        onAdbShell = { cmd -> AdbState.adbShellExecute(this, engineManager, cmd) },
        // F1 预热钩子：设置页每 3s 轮询此桥，服务掉线后 60s 节流内自动补热（prewarmDue 纯读，线程仅在到期时创建）。
        onGetAdbState = {
          if (AdbState.prewarmDue()) Thread { AdbState.prewarm(engineManager) }.start()
          AdbState.stateJson(this)
        },
        onSetAdbAllow = { enable -> AdbState.setAllowSwitch(this, enable) },
        // 0.13.2 W7：悬浮球开关（控制器处理 overlay 权限引导；onResume 补启已授权的开关）。
        onGetOverlayEnabled = { OverlayController.isEnabled(this) },
        onSetOverlayEnabled = { enable -> OverlayController.setEnabled(this, enable) },
        // 0.14 真实配对：码值只经 adb argv（壳侧），端口取自系统「无线调试」弹窗；配对成功才写 paired。
        // F3 结构化结果（JSON ok/reason/message）：前端按 reason 分流文案，拒绝「输什么都像码错」。
        onSetAdbPair = { code, pairPort, connectPort ->
          AdbState.pairWithCodeJson(this, engineManager, code, pairPort, connectPort)
        },
        onRevokeAdbPair = { AdbState.revokePair(this, engineManager) },
        // 缓存优先（启动后台预取 + 15s TTL）；无缓存才同步扫——配对页不再卡 UI（2026-08-27 报障修复）。
        onDiscoverAdbPorts = { AdbState.cachedPorts() ?: AdbState.discoverPorts(this, engineManager).toString() },
        // 0.13.5 W4：无障碍控制通道（状态 + 系统设置引导 + Android 13 受限设置一键解锁）。
        onA11yStatus = { DeviceControlService.statusJson(this) },
        onOpenA11ySettings = { openAccessibilitySettings() },
        onUnlockRestrictedSettings = { AdbState.unlockRestrictedSettings(this, engineManager) },
      ),
      "androidBridge",
    )
    // 0.13.3 W2：引擎 /api 全前缀走浏览器鉴权（401）。WebView 首屏先换好 cookie：
    // Kotlin 侧 P0（engine.log token 交换）/P1（credentials 密钥自 mint）拿到 cookie 后
    // 注入 CookieManager——同源 XHR/WS 自动携带；交换失败时回退带 token 的 URL 让引擎
    // 303+Set-Cookie 自愈（官方交换路径）。
    val authCookie = EngineAuth.refresh(this)
    if (authCookie != null) {
      try {
        android.webkit.CookieManager.getInstance().setCookie(EngineProbe.ENGINE_URL, authCookie)
      } catch (t: Throwable) {
        Log.w("dsh-engine-auth", "CookieManager injection failed: " + t.message)
      }
      webView.loadUrl(EngineProbe.ENGINE_URL)
    } else {
      val token = EngineAuth.tokenFromLog(this)
      webView.loadUrl(if (token != null) EngineProbe.ENGINE_URL + "/?token=" + token else EngineProbe.ENGINE_URL)
      // 全新安装首启竞态自愈（0.13.3 模拟器实测）：引擎冷启动期 token 行尚未打印，
      // 首次 refresh/tokenFromLog 均落空 → WebView 载入 401 文案页。后台定期重试，
      // 拿到 cookie 即注入 CookieManager 并重载一次（用户无感自愈，120s 预算封顶）。
      Thread {
        val deadline = System.currentTimeMillis() + 120_000L
        while (System.currentTimeMillis() < deadline) {
          try { Thread.sleep(5_000) } catch (_: InterruptedException) { return@Thread }
          val cookie = try { EngineAuth.refresh(this) } catch (_: Throwable) { null }
          if (cookie != null) {
            try { android.webkit.CookieManager.getInstance().setCookie(EngineProbe.ENGINE_URL, cookie) } catch (_: Throwable) {}
            runOnUiThread {
              try { if (!isFinishing && !isDestroyed) webView.reload() } catch (_: Throwable) {}
            }
            return@Thread
          }
        }
      }.apply { isDaemon = true; name = "engine-auth-reload" }.start()
    }
  }

  /** 0.13.3：textZoom 桥与持久化退役（D6）——上游 ui-theme fontSize 原生覆盖字体调节。 */

  /**
   * 原生剪贴板写入（WebView 的 Clipboard API 在 Android 上被拒
   * NotAllowedError: Write permission denied，页面回退到本桥）。
   */
  internal fun copyTextNative(text: String): Boolean {
    return try {
      val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      cm.setPrimaryClip(ClipData.newPlainText("dsh", text))
      Log.i("dsh-image", "copyTextNative ok, len=" + text.length)
      true
    } catch (e: Exception) {
      Log.e("dsh-image", "copyTextNative failed: " + e.message)
      false
    }
  }

  /** M7：主题延迟重推 Runnable 引用（onDestroy 取消用）。 */
  private var themeRetryRunnable: Runnable? = null

  /** 系统深色状态推送：某些厂商 WebView 的 prefers-color-scheme 不跟随
   *  uiMode（vivo/Android 16 实测），UI 插件经 matchMedia hook 消费此桥值
   *  （window.__dshThemeBridge.setDark）驱动上游 system 主题。
   *  推送时机加固（2026-08-16）：兜底桥（ui-responsive client bundle 内的
   *  ThemeBridge）可能晚于 onPageFinished 才安装——单次推送会静默落空
   *  （`window.__dshThemeBridge &&` 短路），主题不跟随。延迟 800ms 再推
   *  一次覆盖该时序；onResume 亦补推（覆盖从系统设置/SAF 返回后主题变化）。
   *  Runnable 体内 try/catch + onDestroy removeCallbacks（M7：防销毁后
   *  迟到的 evaluateJavascript 抛主线程异常）。 */
  private fun pushSystemDark(view: android.webkit.WebView) {
    val dark = (resources.configuration.uiMode and
      android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
      android.content.res.Configuration.UI_MODE_NIGHT_YES
    try {
      view.evaluateJavascript(
        "window.__dshThemeBridge && window.__dshThemeBridge.setDark(" + dark + ")", null,
      )
      themeRetryRunnable?.let { view.removeCallbacks(it) }
      val runnable = Runnable {
        try {
          view.evaluateJavascript(
            "window.__dshThemeBridge && window.__dshThemeBridge.setDark(" + dark + ")", null,
          )
        } catch (_: Exception) {
          // 页面/WebView 已销毁：重推失败无害。
        }
      }
      themeRetryRunnable = runnable
      view.postDelayed(runnable, 800)
    } catch (_: Exception) {
      // 页面未就绪：onPageFinished 会再推一次。
    }
  }

  /**
   * Project edge-to-edge bottom insets into the WebView's CSS coordinate space.
   * The native API reports physical pixels, while WebView CSS uses density-scaled
   * pixels; the cached values survive engine-page reloads and are re-sent from
   * onPageFinished. The seat CSS consumes the greater of system and IME inset.
   */
  private fun scheduleWebInsetsPush() {
    if (!::webView.isInitialized || webInsetsPushScheduled) return
    webInsetsPushScheduled = true
    webView.post {
      webInsetsPushScheduled = false
      pushWebInsets()
    }
  }

  private fun pushWebInsets(view: WebView = webView) {
    try {
      view.evaluateJavascript(
        "(function(){var root=document.documentElement;if(!root)return;var top='" + webSystemTopInset +
          "px';var system='" + webSystemBottomInset +
          "px';var ime='" + webImeBottomInset +
          "px';root.style.setProperty(" +
          "'--dsh-android-system-top',top);root.style.setProperty(" +
          "'--dsh-android-system-bottom',system);root.style.setProperty('--dsh-android-ime-bottom',ime);" +
          "})()",
        null,
      )
    } catch (_: Exception) {
      // 页面/WebView 尚未就绪：onPageFinished 会补推当前缓存值。
    }
  }

  /** Convert physical Android pixels to whole CSS pixels without under-padding. */
  private fun pxToCssPx(physicalPx: Int, density: Float): Int {
    if (physicalPx <= 0 || density <= 0f) return 0
    return ceil(physicalPx.toDouble() / density.toDouble()).toInt()
  }

  /** 屏幕常亮 WakeLock（JS 桥 keepScreenOn）。单例字段持有 + 成对
   *  acquire/release：旧实现每次调用 newWakeLock，新实例 isHeld 恒 false，
   *  关闭路径永不 release（Review 2026-08-18 实锤的锁泄漏）。 */
  private var screenWakeLock: PowerManager.WakeLock? = null

  /**
   * 0.13.5 W4：跳系统无障碍设置页（用户手动开启「DSH 设备控制」）。
   * Android 13+ 侧载应用可能因受限设置而看不到开关——由设置页的「一键解锁」按钮先 appops 解锁。
   */
  private fun openAccessibilitySettings() {
    val candidates = listOf(
      Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS),
      Intent(android.provider.Settings.ACTION_SETTINGS),
    )
    for (intent in candidates) {
      try {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(intent)
        return
      } catch (t: Throwable) {
        Log.w(TAG, "openAccessibilitySettings failed: " + t.message)
      }
    }
    Toast.makeText(this, "无法打开系统设置，请手动前往 系统设置 → 无障碍", Toast.LENGTH_LONG).show()
  }

  private fun keepScreenOn(enable: Boolean) {
    try {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      if (enable && screenWakeLock == null) {
        screenWakeLock = power.newWakeLock(
          PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ON_AFTER_RELEASE,
          "dsh:screen",
        ).apply { acquire() }
      } else if (!enable && screenWakeLock != null) {
        screenWakeLock?.release()
        screenWakeLock = null
      }
    } catch (t: Throwable) {
      Log.e(TAG, "keepScreenOn failed: " + t.message)
    }
  }

  /** 首启注册通知权限（issue #80 实锤 2026-08-24）：Android 13+ POST_NOTIFICATIONS 默认拒绝，
   *  不主动请求则引擎任务完成/授权请求等 NotifyCenter 通知全部静默丢弃。仅在未授予时请求一次
   *  （用户拒绝后不重复打扰；showTestNotification 仍会在用户主动触发时二次请求）。 */
  private fun registerNotificationAsync() {
    if (Build.VERSION.SDK_INT < 33) return
    if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      try {
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
      } catch (_: Throwable) {
        // Activity 未就绪时忽略（下次启动再试）
      }
    }
  }

  internal fun showTestNotification(title: String, text: String) {
    if (Build.VERSION.SDK_INT >= 33 &&
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
      return
    }
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel("dsh", "dsh", NotificationManager.IMPORTANCE_DEFAULT))
    }
    val pending = android.app.PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java), android.app.PendingIntent.FLAG_IMMUTABLE,
    )
    manager.notify(
      1,
      NotificationCompat.Builder(this, "dsh")
        .setSmallIcon(android.R.drawable.stat_notify_chat)
        .setContentTitle(title)
        .setContentText(text)
        .setContentIntent(pending)
        .setAutoCancel(true)
        .build(),
    )
  }

  /** 导出结果回传 WebView：UI 插件经 window.__dshExportResult 弹软件内结果框。 */
  internal fun pushExportResult(ok: Boolean, detail: String) {
    val title = if (ok) "导出成功" else "导出失败"
    val payload = "{\"ok\":" + ok + ",\"title\":" + jsString(title) + ",\"detail\":" + jsString(detail) + "}"
    webView.post {
      webView.evaluateJavascript(
        "window.__dshExportResult && window.__dshExportResult(" + payload + ")", null,
      )
    }
  }

  /** Hide Android's soft keyboard before replacing the WebView with the guide. */
  internal fun hideSoftInput() {
    try {
      WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.ime())
    } catch (_: Exception) {
      // The input connection may already be gone while a WebView bridge call is settling.
    }
  }

  /** Android 10（API 29）共享目录 raw 写解锁（docs/ANDROID10-SAF-ROUTING.md 方案 B）：
   *  SAF 授权只给本进程 DocumentFile 通路，引擎（bash/node）raw path 仍被 scoped
   *  storage FUSE 拦截——经既有 ADB 授权通道跑 appop LEGACY_STORAGE allow（shell uid
   *  持 MANAGE_APP_OPS_MODES），随做 /sdcard 写探测验证生效性。异步执行；未授权/
   *  连接不可用/ROM 不认 appop 时仅记日志（storageMode 降级 saf-only 由 Phase 5
   *  真机验证定案）。仅 API 29 调用（picker 回调处守卫）。 */
  internal fun unlockLegacyStorageApi29() {
    if (android.os.Build.VERSION.SDK_INT != 29) return
    Thread {
      try {
        val out = AdbState.adbShellExecute(
          this, engineManager,
          "appops set --user 0 $packageName LEGACY_STORAGE allow && appops get $packageName LEGACY_STORAGE",
          requireFullAccess = false,
        )
        LogCollector.log("dsh-saf", "appop LEGACY_STORAGE: " + out.take(300))
        val probe = AdbState.adbShellExecute(
          this, engineManager,
          "touch /storage/emulated/0/.dsh-write-probe && rm -f /storage/emulated/0/.dsh-write-probe && echo PROBE_OK",
          requireFullAccess = false,
        )
        LogCollector.log("dsh-saf", "raw 写探测: " + probe.take(200))
      } catch (t: Throwable) {
        LogCollector.log("dsh-saf", "appop 解锁失败: " + t.message)
      }
    }.start()
  }

  /** 进程级崩溃标记：记录未捕获异常摘要，交回默认 handler（不吞异常）。 */
  private fun installCrashMarker() {
    val default = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
      try {
        val text = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US)
          .format(java.util.Date()) + " " + throwable.javaClass.name + ": " + (throwable.message ?: "")
        File(filesDir, ".crashed").writeText(text)
        LogCollector.log("dsh-shell", "uncaught crash: $text")
      } catch (_: Exception) {
      }
      default?.uncaughtException(thread, throwable)
    }
  }

  /** 开发者日志开关持久化（私有 SharedPreferences；默认关）。 */
  object DevLogPrefs {
    private const val PREFS = "dsh_prefs"
    private const val KEY_DEV_LOG = "dev_log_enabled"

    fun isEnabled(context: Context): Boolean =
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_DEV_LOG, false)

    fun setEnabled(context: Context, enabled: Boolean) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit().putBoolean(KEY_DEV_LOG, enabled).apply()
    }
  }
}
