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
import android.webkit.ConsoleMessage
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
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
  /** Lazily-created untrusted BrowserHost surface, geometrically owned by the Files sidebar stage. */
  private lateinit var browserHost: BrowserHost
  /** Native SurfaceView output for the VirtualDisplay Files-sidebar stage. */
  private lateinit var vdisplayHost: VdisplayHost
  /** 虚拟屏空闲回收定时器（前台期间每 [VDISPLAY_REAP_INTERVAL_MS] 扫一次；退后台停掉）。 */
  private var vdisplayReaper: android.os.Handler? = null
  /** 0.14.0：退后台时把虚拟屏画面以小窗浮在系统上（只读；回前台立即隐藏并交还侧栏）。 */
  private lateinit var vdisplayFloat: VdisplayFloat
  internal lateinit var guideView: LinearLayout
    private set
  /** True only after WebView reported a load error for the local engine origin. */
  @Volatile
  internal var enginePageFailed = false
  /** 返回策略：页面层栈信号缓存（JS 经 dshBackBridge 主动推送；onPageStarted 复位、
   *  onPageFinished 拉平）。返回回调只读它，绝不 evaluateJavascript 现问页面。 */
  internal val backGateState = BackGateState()
  /** System insets in CSS px, cached until the engine page is ready to receive them. */
  private var webSystemBottomInset = 0
  private var webSystemTopInset = 0
  private var webImeBottomInset = 0
  /** apk #182-2：横屏 + 侧边挖孔（short edge = 左右）时页面需要左右 inset 才能避让。 */
  private var webSystemLeftInset = 0
  private var webSystemRightInset = 0
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

    /**
     * §2.3（0.14.1 块C）：主 WebView 背景色（中性深灰）。未设时为默认白，白屏与「正常空页」
     * 视觉不可区分；此色与引导页深色系一致，使「没渲染出来」一眼可辨且不闪白。
     */
    private const val MAIN_WEBVIEW_BACKGROUND = 0xFF1E1E1E.toInt()

    /**
     * §2.4：ES2022 类静态块（`static{}`）需要 Chromium 94+；低于此值的产物会在**解析期**整体
     * 不执行——用户看到纯白、无报错、引擎却健康（详档 §1.2 的 A 档实测）。
     * 本常量是诊断字段 `syntax_floor_ok` 的判据门槛，与 `check-browser-syntax-floor.mjs` 的
     * 「chrome87 降级」目标口径不同：**这里是「当前内核能不能解析已发布产物」**，取 94。
     * **可见性 = internal**（0.14.1 §2.4 收口）：`EngineManager.buildDiagnosticsText()` 的
     * `syntax_floor_ok:` 字段必须与本处同源（同一个数字），故跨类引用；`private` 会编译不过。
     * 单一来源：两处引用同一常量，禁止任何一方再写字面量 94。
     */
    internal const val WEBVIEW_SYNTAX_FLOOR_MAJOR = 94
    /** 虚拟屏空闲回收扫描间隔（判定阈值在 VdisplayController.IDLE_RECLAIM_MS = 10 分钟）。 */
    private const val VDISPLAY_REAP_INTERVAL_MS = 2 * 60 * 1000L
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
      // §2.3（0.14.1 块C）：未设背景色时默认白，白屏在视觉上与「正常空页」不可区分——渲染失败
      // 就看不出来。设中性深色，使「没渲染出来」一眼可辨（与引导页同色系，避免闪白）。
      setBackgroundColor(MAIN_WEBVIEW_BACKGROUND)
    }
    webViewRef = webView
    root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    guideView = guideRenderer.buildGuideView()
    root.addView(guideView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    setContentView(root)
    browserHost = BrowserHost(this, root, webView)
    vdisplayHost = VdisplayHost(root, webView)
    vdisplayFloat = VdisplayFloat(this)
    // The accessibility control service carries the model-facing browser* ops; it reaches this
    // Activity-owned isolated WebView only through the process-wide holder.
    BrowserHostHolder.host = browserHost
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
      // #182-2：左右同样取系统栏与挖孔的较大者（横屏且侧边挖孔时 cutout.left/right > 0）。
      webSystemLeftInset = pxToCssPx(maxOf(bars.left, cutout.left), density)
      webSystemRightInset = pxToCssPx(maxOf(bars.right, cutout.right), density)
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
    // §2.4（0.14.1 块C）：内核版本必须在**首启路径**上落盘，不只进诊断包——老设备白屏时
    // 页面根本跑不起来，用户拿不到版本就无法自助；落 boot-diag.log 后 `run-as cat` 即可取。
    reportWebViewVersion("onCreate")
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
    if (::browserHost.isInitialized) browserHost.onActivityResumed()
    // 0.14.0：内置 adb 退役——原 ST-01「回前台同步 All Files Access 偏好」随 ADB 授权面一并移除
    // （特权面改由 Shizuku 承载，不再有需要回前台收敛的门1 prefs）。
    // ST-11：开发者日志回前台补启——EngineService 退出时采集器可能已停而偏好仍为开，
    // 「开关事实 = 偏好 && 在跑」由 DevLogControl 保证（幂等；偏好关时 no-op）。
    DevLogControl.ensureStarted(this)
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
    // 0.13.2 W7 + ST-02：悬浮球开关已开且权限在场时补启。权限缺失时 OverlayController 把偏好
    // 回落 false，本行随即短路——不再每次回前台弹系统页；用户重新授予后需再点一次开关。
    OverlayController.ensureStarted(this)
    // 0.14.0：ADB 端口预取与 server 预热随内置 adb 退役（Shizuku UserService 自身常驻，无需预热）。
    // Back from the directory picker / Termux: re-route if the engine came up.
    // 仅当 WebView 未展示（引导页/首次启动）时才探测并重路由；相册/文件选择器
    // 返回时 WebView 已可见，探测超时会误触发 showWeb→reload，导致 JS 状态丢失。
    guideRenderer.refreshGuideMeta()
    // FX-210.5：探活不得在主线程（onResume 每次回前台都跑；cookie 取不到 + 3080 半死时
    // 单次同步 HTTP 为秒级）。后台探活 + 主线程分流，失败原因结构化落盘。
    if (!userClosedEngine && webView.visibility != View.VISIBLE) {
      probeEngineOffMainThread { running ->
        if (!running && !userClosedEngine && webView.visibility != View.VISIBLE) startEngineFlow()
      }
    }
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

  /**
   * FX-210.5：引擎探活的后台入口。EngineProbe.check 是同步 HTTP（connect+read 各 800ms，
   * 半死引擎下为秒级下限），主线程调用会直接冻结 onResume/首帧；失败态以结构化原因落盘
   * （reason/latencyMs，不含任何令牌）。
   */
  private fun probeEngineOffMainThread(onResult: (Boolean) -> Unit) {
    Thread {
      val probe = try {
        EngineProbe.check()
      } catch (t: Throwable) {
        org.json.JSONObject().put("running", false).put("error", t.javaClass.simpleName)
      }
      val running = probe.optBoolean("running", false)
      if (!running) {
        LogCollector.log(
          "dsh-engine-probe",
          "probe miss: reason=" + probe.optString("error").ifBlank { "unknown" } +
            " latencyMs=" + probe.optLong("latencyMs", -1L),
        )
      }
      runOnUiThread {
        try {
          if (!isFinishing && !isDestroyed) onResult(running)
        } catch (_: Throwable) {
        }
      }
    }.apply { isDaemon = true; name = "engine-probe" }.start()
  }

  /** 窗口重新获得焦点时重应用沉浸式（系统栏 flag 会随焦点变化被重置）。
   *  ST-10：读与都用 ShellState.ImmersiveMode 单一真源，本类不再自带私有副本。 */
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) ImmersiveMode.apply(this, ImmersiveMode.isEnabled(this))
  }

  override fun onPause() {
    // BrowserHost owns a separate renderer. Pause only that WebView; never call the global
    // WebView.pauseTimers(), which would suspend the trusted DSH page as well.
    if (::browserHost.isInitialized) browserHost.onActivityPaused()
    super.onPause()
  }

  override fun onStart() {
    super.onStart()
    // 回前台：浮窗让位，侧栏查看器重新接管虚拟屏 Surface。
    if (::vdisplayFloat.isInitialized) vdisplayFloat.hide()
    if (::vdisplayHost.isInitialized) vdisplayHost.reattach()
    startVdisplayReaper()
  }

  /**
   * 虚拟屏空闲回收兜底（0.14.0 用户要求：「对话数分钟不运行且虚拟屏无操作则 kill 掉，
   * 否则会一直占用资源」）。
   *
   * 为什么需要周期任务而不是只在 vd op 入口回收：面板关掉、AI 也不再调用之后，
   * 就没有任何 vd op 会进来了——那条路永远不触发，屏会一直挂着。这里每 2 分钟扫一次，
   * 由 [VdisplayController.reclaimIdle] 判定（阈值 10 分钟未使用）。
   *
   * 成本：仅比较时间戳；无屏时是一次空列表遍历。
   */
  private fun startVdisplayReaper() {
    if (vdisplayReaper != null) return
    val handler = android.os.Handler(android.os.Looper.getMainLooper())
    val task = object : Runnable {
      override fun run() {
        try {
          VdisplayController.reclaimIdle(applicationContext)
        } catch (_: Throwable) {
          // 回收是尽力而为：任何异常都不得影响界面（资源会在下次回收窗口再试）。
        }
        handler.postDelayed(this, VDISPLAY_REAP_INTERVAL_MS)
      }
    }
    handler.postDelayed(task, VDISPLAY_REAP_INTERVAL_MS)
    vdisplayReaper = handler
  }

  override fun onStop() {
    // 退后台：停止回收定时器（进程存活期间由 vd op 入口路径兜底，避免后台空转）。
    vdisplayReaper?.removeCallbacksAndMessages(null)
    vdisplayReaper = null
    // 退后台：侧栏 Surface 交还给浮窗（只读、小窗；开关/权限/无屏时 fail-closed 不显示）。
    if (::vdisplayFloat.isInitialized && ::vdisplayHost.isInitialized && VdisplayPrefs.floatEnabled(this)) {
      vdisplayHost.detachForBackground()
      vdisplayFloat.show()
    }
    super.onStop()
  }

  override fun onDestroy() {
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
    // Tear down native stage owners before their trusted geometry source is destroyed.
    if (::vdisplayFloat.isInitialized) vdisplayFloat.destroy()
    if (::vdisplayHost.isInitialized) vdisplayHost.destroy()
    if (::browserHost.isInitialized) {
      browserHost.destroy()
      if (BrowserHostHolder.host === browserHost) BrowserHostHolder.host = null
    }
    if (::webView.isInitialized) {
      themeRetryRunnable?.let { webView.removeCallbacks(it) }
      webView.destroy()
    }
    super.onDestroy()
    // EngineService owns the child lifecycle. An Activity can be recreated by
    // rotation, OEM memory policy, or a WebView transition without meaning that
    // the user asked to interrupt an active agent turn.
  }

  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    pushSystemDark(webView)
    pushWebInsets()
  }

  /**
   * 返回策略接线（计划 §5.1 方案 1）：legacy onBackPressed() 覆写升级为
   * OnBackPressedCallback。回调内**同步**读缓存布尔——evaluateJavascript 是异步 API，
   * 不能在返回回调里现问页面，页面信号只能由 JS 主动推送。
   *
   * 三级判定见 BackGate.decide：① 跨文档历史（canGoBack()，本机 WebView 不认
   * same-document 条目，故只作历史腿）→ goBack()；② 页面层栈 → JS 执行关闭并**消费**
   * （即便 JS 侧没找到关闭控件也不退出：「观测不到/关不掉的层不得变成误退应用」）；
   * ③ 都没有 → 关掉本回调后重新 dispatch，落回 Activity 默认 finish。
   */
  private fun installBackGate() {
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val canGoBack = ::webView.isInitialized && webView.canGoBack()
        val pageStack = backGateState.pageStackAvailable
        val decision = BackGate.decide(canGoBack, pageStack)
        Log.i(
          BackGate.TAG,
          "back: canGoBack=" + canGoBack + " pageStack=" + pageStack +
            " depth=" + backGateState.pageStackDepth + " -> " + decision.name,
        )
        when (decision) {
          BackDecision.GO_BACK_HISTORY -> webView.goBack()
          BackDecision.DISPATCH_PAGE_STACK -> webView.evaluateJavascript(BackGate.DISPATCH_SCRIPT, null)
          BackDecision.FINISH_ACTIVITY -> {
            // 层穷尽：交回 Activity 默认行为。重新 dispatch（而非直接 finish()）保持与
            // 其它 OnBackPressedCallback 的次序语义一致；dispatch 返回后复位，多窗口或
            // 延迟 finish 时下一次返回仍由本回调处理。
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            isEnabled = true
          }
        }
      }
    })
  }

  /**
   * onPageFinished 后拉平层栈缓存：注入插件可能晚于首帧挂载，桥上推的初始信号会漏。
   * @param view - 已就绪的 WebView。
   */
  private fun pullBackGateState(view: WebView) {
    try {
      view.evaluateJavascript(BackGate.READ_DEPTH_SCRIPT) { raw ->
        backGateState.onPageFinished(BackGate.parseDepth(raw))
      }
    } catch (t: Throwable) {
      Log.w(BackGate.TAG, "page stack pull failed: " + t.message)
    }
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
       * §2.3（0.14.1 块C）：HTTP 层失败（4xx/5xx）此前**零实现**——`onReceivedError` 只覆盖
       * 传输层失败（DNS/拒绝连接），服务端返回 500 时它**不触发**，于是「引擎活着但页面 500」
       * 与「正常空页」在诊断上不可区分。这里把状态码落到启动诊断面（`source=http-error`）。
       * 只在引擎同源时置位：外部跳转不该污染引擎页面健康度。
       */
      override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
        super.onReceivedHttpError(view, request, errorResponse)
        if (!isEngineSource(request.url.toString())) return
        try {
          LogCollector.writeBootDiag(
            this@MainActivity,
            "http-error",
            "url=${request.url} status=${errorResponse.statusCode} reason=${errorResponse.reasonPhrase ?: ""}"
          )
        } catch (t: Throwable) {
          Log.w(TAG, "http error diag failed: " + (t.message ?: t.javaClass.simpleName))
        }
      }

      /**
       * §2.3：TLS 失败此前零实现。引擎走 `http://127.0.0.1` 不走 TLS，故本回调只在用户被跳到
       * 外部 https 页面时触发；**不得**为「让页面能开」而放行（`super` 保持默认拒绝语义），
       * 只落诊断（`source=ssl-error`）以免静默白屏。
       */
      override fun onReceivedSslError(view: WebView, handler: android.webkit.SslErrorHandler, error: android.net.http.SslError) {
        try {
          LogCollector.writeBootDiag(
            this@MainActivity,
            "ssl-error",
            "url=${error.url} primary=${error.primaryError}"
          )
        } catch (t: Throwable) {
          Log.w(TAG, "ssl error diag failed: " + (t.message ?: t.javaClass.simpleName))
        }
        // 保持上游默认行为（取消），不放行：安全敏感面不得为诊断而弱化。
        handler.cancel()
      }

      /**
       * §2.3：渲染进程被杀（低内存/OOM/厂商治理）此前主 WebView **零实现**（仅隔离
       * `BrowserHost.kt:634` 有）。不处理则 Activity 留在一个永不响应的 WebView 上——用户看到
       * 「卡死」而不是「崩了」。这里落诊断并释放该 WebView 的渲染进程，交由既有引擎监控/引导页
       * 路径恢复（不在此重建 WebView：重建属启动流程，避免在回调里引入第二套生命周期）。
       * @returns true = 已消费（WebView 不再被使用）。
       */
      override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
        try {
          LogCollector.writeBootDiag(
            this@MainActivity,
            "render-gone",
            "didCrash=${detail.didCrash()} rendererPriorityAtExit=${detail.rendererPriorityAtExit()}"
          )
        } catch (t: Throwable) {
          Log.w(TAG, "render gone diag failed: " + (t.message ?: t.javaClass.simpleName))
        }
        enginePageFailed = true
        try { view.destroy() } catch (t: Throwable) { Log.w(TAG, "destroy after render-gone failed", t) }
        showGuide()
        return true
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
        // 新文档：上一文档的层栈信号作废（页面插件在新文档里重新推）。
        if (isEngineSource(url)) backGateState.onPageStarted()
      }

      override fun onPageFinished(view: WebView, url: String) {
        super.onPageFinished(view, url)
        // 层栈缓存拉平（插件可能晚于首帧挂载，初始上行信号会漏）。
        if (isEngineSource(url)) pullBackGateState(view)
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
      /**
       * 块L L-2：页面控制台消费者（跨层契约的壳侧一半）。
       *
       * 页面侧 `dsh-host-web-compat` 早已用 `console.error('[dsh-boot-stall] dsh-boot-diag …')`
       * 发布诊断行（并自述「壳侧 onConsoleMessage 抓这一条」），但全壳此前**零实现**，
       * 于是 `files/boot-diag.log` 的 `source=page-console` 恒 0 行、`pageSideRuntime` 恒
       * `unavailable`——那是**永远不可得**而不是「当前不可得」。本方法补上这一半。
       *
       * 两种前缀（契约与页面侧逐字对应，改动须两侧同步，见 LogCollector 的常量）：
       *  - `[dsh-boot-ready]`：页面首次渲染成功（L-1 的判据真源）→ 停止本 epoch 的 stall 计时；
       *  - `[dsh-boot-stall]`：页面自报卡住（带 §6.2 四字段）→ 落 `source=page-console`。
       *
       * 返回 `true` = 已消费，不再走默认 console 行为。**只拦我们自己的前缀**，其余一律
       * 返回 false 交给默认处理（不改变第三方页面的既有日志行为，也不吞掉真正的页面报错）。
       */
      override fun onConsoleMessage(message: ConsoleMessage): Boolean {
        val text = message?.message() ?: return false
        return try {
          when {
            LogCollector.isPageReadyMessage(text) -> {
              engineFlow.onPageReadyReported(text)
              true
            }
            LogCollector.isPageStallMessage(text) -> {
              engineFlow.onPageStallReported(text)
              true
            }
            // §2.3（0.14.1 块C）：既有两个自有前缀之外，**补收页面 JS 错误**。老设备白屏的
            // 产物级真因是解析期 SyntaxError——它只出现在控制台，此前全壳不收，用户拿不到。
            // 与自有前缀**并集**（不改动上面两条既有分支），只落诊断，不改变第三方页面行为。
            isRenderErrorMessage(message) -> {
              LogCollector.writeBootDiag(
                this@MainActivity,
                "console-error",
                "level=${message.messageLevel()} url=${message.sourceId()}:${message.lineNumber()} text=${text.take(400)}"
              )
              // 返回 false：仍是「未消费」，交回默认 console 行为（不吞页面报错）。
              false
            }
            else -> false
          }
        } catch (t: Throwable) {
          // 诊断通路不得成为故障源；未消费则交回默认处理。
          Log.w(TAG, "page console route failed: " + (t.message ?: t.javaClass.simpleName))
          false
        }
      }

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
        // ST-10：桥 setter 走 ShellState.ImmersiveMode（偏好 + 应用成对，单一真源）。
        onSetImmersiveRequest = { enable -> ImmersiveMode.setEnabled(this, enable) },
        onSettingsPathRequest = { engineManager.settingsDocumentPath() },
        onExportSettingsDocument = { engineManager.settingsDocumentExport() },
        onCopyTextRequest = { text -> copyTextNative(text) },
        pickToken = pickToken,
        onRestartEngine = { engineFlow.restart() },
        onShutdownToGuide = { engineFlow.shutdownToGuide() },
        onReloadWebUI = {
          webView.reload()
          showTestNotification("界面已刷新", "Web UI 已重新加载")
        },
        onOpenConsole = { startActivity(Intent(this, ConsoleActivity::class.java)) },
        onGetDevLogEnabled = { DevLogControl.isEnabled(this) },
        onSetDevLogEnabled = { enabled ->
          // ST-10/ST-11：偏好与采集器成对动作走 ShellState.DevLogControl（单一真源）。
          DevLogControl.setEnabled(this, enabled)
          if (enabled) {
            LogCollector.log("dsh-shell", "dev log enabled by user")
            showTestNotification(
              "开发者日志已开启",
              "运行日志按天写入 " + LogCollector.currentDir(this).absolutePath +
                "（共享存储，其他应用可读；启动令牌已自动脱敏，日志仍含命令与模型内容）",
            )
          } else {
            LogCollector.log("dsh-shell", "dev log disabled by user")
            showTestNotification("开发者日志已关闭", "日志收集已停止")
          }
        },
        onOpenNativePath = { path -> FileIncoming.openWithExternalReader(this, path) },
        // 0.13.7：上游 0.1.5「在外部应用打开」的 Android 落点——系统选择器（MT 管理器 / 系统文件管理）。
        onOpenPathChooser = { path, mode -> PathOpen.openChooser(this, path, mode) },
        // 0.14.0：内置 adb 退役——原 ADB 授权面（shell / 状态 / 允许开关 / 配对 / 端口发现）
        // 的四个桥方法已从 AndroidBridge 移除；特权执行改由 Shizuku UserService（设置页「手机控制」）。
        // 0.13.2 W7：悬浮球开关（控制器处理 overlay 权限引导；onResume 补启已授权的开关）。
        onGetOverlayEnabled = { OverlayController.isEnabled(this) },
        onSetOverlayEnabled = { enable -> OverlayController.setEnabled(this, enable) },
        // 0.14：开放屏幕范围由用户设置面独占写入；默认 virtual-only，模型工具只读并由壳侧执行面强制。
        onGetScreenScope = { ScreenScopePrefs.current(this).wire },
        onSetScreenScope = { raw -> ScreenScopePrefs.set(this, raw).wire },
        onIncomingWorkspacePath = { FileIncoming.tmpWorkspace(this).absolutePath },
        onBrowserHostStatus = { browserHost.statusJson() },
        onBrowserHostShow = { target -> browserHost.show(target) },
        onBrowserHostHide = { browserHost.hide() },
        onBrowserHostReload = { browserHost.reload() },
        onBrowserHostBounds = { bounds -> browserHost.setStageBounds(bounds) },
        onBrowserHostViewport = { viewport -> browserHost.setViewport(viewport) },
        onBrowserHostClose = { browserHost.close() },
        onBrowserHostIdentity = { payload -> browserHost.identity(payload) },
        onVdisplayStatus = { VdisplayController.status(this).toString() },
        onVdisplayCreate = { VdisplayController.create(this).toString() },
        onVdisplayDestroy = { VdisplayController.destroy(this).toString() },
        onVdisplayBounds = { bounds -> vdisplayHost.setStageBounds(bounds) },
        onVdisplaySelect = { alias -> VdisplayController.select(this, alias).toString() },
        onGetVdisplayScale = { VdisplayPrefs.scale(this) },
        onSetVdisplayScale = { value -> VdisplayPrefs.setScale(this, value); VdisplayPrefs.scale(this) },
        onGetVdisplayFloat = { VdisplayPrefs.floatEnabled(this) },
        onSetVdisplayFloat = { enable -> VdisplayPrefs.setFloatEnabled(this, enable); VdisplayPrefs.floatEnabled(this) },
        onForceDestroyVdisplay = { VdisplayController.forceDestroy(this).toString() },
        // 0.13.5 W4：无障碍控制通道（状态 + 系统设置引导 + Android 13 受限设置一键解锁）。
        onA11yStatus = { DeviceControlService.statusJson(this) },
        onOpenA11ySettings = { openAccessibilitySettings() },
        // 0.14.0：Android 13+ 侧载应用「受限设置」解锁改走 Shizuku shell（appops）——内置 adb 已退役。
        onUnlockRestrictedSettings = { unlockRestrictedSettingsViaShizuku() },
      ),
      "androidBridge",
    )
    // 返回策略（计划 §5.1 方案 1）：页面 → 壳的层栈上行接口。独立接口对象，只暴露
    // setAvailable/getBackAvailable 两个方法（授权面窄于 androidBridge 的 34 个方法）；
    // addJavascriptInterface 的方法调用是同步的——正是「同步决策」需要的形态。
    webView.addJavascriptInterface(BackGateBridge(backGateState), "dshBackBridge")
    installBackGate()
    // 0.13.3 W2：引擎 /api 全前缀走浏览器鉴权（401）。WebView 首屏先换好 cookie：
    // Kotlin 侧 P0（engine.log token 交换）/P1（credentials 密钥自 mint）拿到 cookie 后
    // 注入 CookieManager——同源 XHR/WS 自动携带；交换失败时回退带 token 的 URL 让引擎
    // 303+Set-Cookie 自愈（官方交换路径）。
    // FX-210.5：此处只取**零网络**的本地缓存 cookie（预置 cookie 有效即用）；同步 refresh
    // 含最长 8s 的 HTTP 且持 EngineAuth 锁（排队可达 ~16s），原先在 onCreate 主线程同步调用
    // 会冻结首帧——已迁到下面的后台重试线程（首个尝试立即执行）。
    val authCookie = EngineAuth.cookie(this)
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
          // FX-210.5：refresh 在后台线程内同步执行（首个尝试不再延迟 5s）。
          val cookie = try { EngineAuth.refresh(this) } catch (_: Throwable) { null }
          if (cookie != null) {
            try { android.webkit.CookieManager.getInstance().setCookie(EngineProbe.ENGINE_URL, cookie) } catch (_: Throwable) {}
            runOnUiThread {
              try { if (!isFinishing && !isDestroyed) webView.reload() } catch (_: Throwable) {}
            }
            return@Thread
          }
          try { Thread.sleep(5_000) } catch (_: InterruptedException) { return@Thread }
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
          "px';var left='" + webSystemLeftInset +
          "px';var right='" + webSystemRightInset +
          "px';root.style.setProperty(" +
          "'--dsh-android-system-top',top);root.style.setProperty(" +
          "'--dsh-android-system-bottom',system);root.style.setProperty('--dsh-android-ime-bottom',ime);" +
          "root.style.setProperty('--dsh-android-system-left',left);" +
          "root.style.setProperty('--dsh-android-system-right',right);" +
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
   *  storage FUSE 拦截——经 Shizuku 特权 shell（uid 2000 持 MANAGE_APP_OPS_MODES）跑
   *  appop LEGACY_STORAGE allow，随做 /sdcard 写探测验证生效性。异步执行；Shizuku 未就绪 /
   *  ROM 不认 appop 时仅记日志（storageMode 降级 saf-only 由 Phase 5 真机验证定案）。
   *  仅 API 29 调用（picker 回调处守卫）。 */
  internal fun unlockLegacyStorageApi29() {
    if (android.os.Build.VERSION.SDK_INT != 29) return
    Thread {
      try {
        val out = ShizukuTransport.runShell(
          this,
          "appops set --user 0 $packageName LEGACY_STORAGE allow && appops get $packageName LEGACY_STORAGE",
        )
        LogCollector.log("dsh-saf", "appop LEGACY_STORAGE: " + out.toString().take(300))
        val probe = ShizukuTransport.runShell(
          this,
          "touch /storage/emulated/0/.dsh-write-probe && rm -f /storage/emulated/0/.dsh-write-probe && echo PROBE_OK",
        )
        LogCollector.log("dsh-saf", "raw 写探测: " + probe.toString().take(200))
      } catch (t: Throwable) {
        LogCollector.log("dsh-saf", "appop 解锁失败: " + t.message)
      }
    }.start()
  }

  /**
   * Android 13+ 侧载应用「受限设置」一键解锁（设置页「无障碍 → 一键解锁」）：
   * 经 Shizuku 特权 shell 跑 `appops set … ACCESS_RESTRICTED_SETTINGS allow`（0.14.0 内置 adb 退役后
   * 的唯一执行面）。返回与旧实现同形的 JSON 文本 {ok, message}。
   */
  private fun unlockRestrictedSettingsViaShizuku(): String {
    val result = ShizukuTransport.runShell(
      this,
      "appops set --user 0 $packageName ACCESS_RESTRICTED_SETTINGS allow",
    )
    val ok = result.optBoolean("ok")
    val message = if (ok) {
      "已解锁受限设置（Shizuku 特权 shell）"
    } else {
      result.optString("guidance").ifBlank { result.optString("error").ifBlank { "解锁失败" } }
    }
    return org.json.JSONObject().put("ok", ok).put("message", message).toString()
  }

  /**
   * §2.4（0.14.1 块C）：主 WebView 内核版本回读 + 落盘诊断。
   *
   * 为什么必须做（详档 §2.4 原话）：`docs/WHITE-SCREEN-MI8-MIUI125-2026-09-17.md:268-270` 把
   * 「WebView 内核版本」列为定位闭环所必需的**第 1 项**，而此前该值既不进诊断包、也不进日志、
   * 主 WebView 也不读——**用户拿不到，维护方就要不到**。老设备白屏的真因是内核版本（`<94` 不支持
   * ES2022 类静态块），拿不到版本就无法判定，用户必须装 adb 才能给出。
   *
   * 读法与 `BrowserHost.kt:876-878` 同源（`getCurrentWebViewPackage()` + 主版本号正则），
   * 落盘走既有 `LogCollector.writeBootDiag`（唯一写者纪律：壳侧自有文件，不写 engine.log）。
   * @returns 形如 `"110.0.5481.154.1"`；API < 26 或读不到时返回空串（显式空，不抛）。
   */
  internal fun currentWebViewVersionName(): String =
    if (Build.VERSION.SDK_INT >= 26) WebView.getCurrentWebViewPackage()?.versionName ?: "" else ""

  /** 主版本号（§2.4 的判据字段：`syntax_floor_ok` 的输入）；读不到记 0（显式未知，不当通过）。 */
  internal fun currentWebViewMajor(): Int =
    Regex("(\\d+)\\.").find(currentWebViewVersionName())?.groupValues?.get(1)?.toIntOrNull() ?: 0

  /**
   * §2.4：把内核版本落到启动诊断面。**判据**：`files/boot-diag.log` 出现
   * `source=webview-version` 行且 `webview_major` 与 `dumpsys webviewupdate` 一致。
   * 失败绝不抛出（诊断通路不得成为故障源）。
   */
  private fun reportWebViewVersion(source: String) {
    try {
      val version = currentWebViewVersionName()
      val major = currentWebViewMajor()
      // ES2022 类静态块需 Chromium 94+；<94 的产物会在解析期整体不执行（详档 §1.2）。
      val floorOk = major >= WEBVIEW_SYNTAX_FLOOR_MAJOR
      LogCollector.writeBootDiag(
        this,
        "webview-version",
        "from=$source webview_package=${WebView.getCurrentWebViewPackage()?.packageName ?: ""}"
          + " webview_version=$version webview_major=$major"
          + " syntax_floor_ok=$floorOk"
      )
    } catch (t: Throwable) {
      Log.w(TAG, "webview version report failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  /**
   * §2.3：控制台错误判据——**结果性**而非「文本在场」式：按 ConsoleMessage 的级别取
   * `ERROR`（含页面抛出的 SyntaxError / ReferenceError 等），并排除我们自己的两个前缀
   * （它们由上面两条分支消费，绝不能重复落盘）。
   *
   * 为什么用级别而不是匹配 "SyntaxError" 文本：白屏时页面可能连错误对象都构造不出来，
   * 也可能由不同内核给出不同措辞；级别是平台给出的结果信号，措辞会变、级别不会。
   * @param message - 平台回调给出的控制台消息。
   * @returns true = 应作为渲染错误落诊断。
   */
  internal fun isRenderErrorMessage(message: ConsoleMessage): Boolean {
    val text = message.message() ?: return false
    if (LogCollector.isPageReadyMessage(text) || LogCollector.isPageStallMessage(text)) return false
    return message.messageLevel() == ConsoleMessage.MessageLevel.ERROR
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
