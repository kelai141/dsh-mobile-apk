package com.dsharnessmobile.shell

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.MediaStore
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
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.ceil

/** Shell activity: WebView over the local dsh engine + engine guide fallback. */
class MainActivity : ComponentActivity() {

  private lateinit var webView: WebView
  private lateinit var guideView: LinearLayout
  /** Bottom insets in CSS px, cached until the engine page is ready to receive them. */
  private var webSystemBottomInset = 0
  private var webImeBottomInset = 0
  /** Coalesces rapid IME animation callbacks into one WebView evaluation per UI turn. */
  private var webInsetsPushScheduled = false
  /** 目录选择桥鉴权 token（进程级共享：MainActivity 重建/看门狗重启不更换，
   *  与引擎 env 的 DSH_PICK_TOKEN 始终一致；C1 修复）。 */
  private val pickToken: String = EngineManager.ensurePickToken()
  private lateinit var engineStatus: TextView
  private lateinit var progressText: TextView
  /** 启动/测试双态界面（v0.11.0）：解压进度条、崩溃横幅、engine.log 摘要。 */
  private lateinit var progressBar: ProgressBar
  private lateinit var crashBanner: TextView
  private lateinit var logSummary: TextView
  /** 测试界面三段式结构块：入场 stagger 动画按块依次淡入。 */
  private lateinit var brandBlock: View
  private lateinit var cardBlock: View
  private lateinit var actionBlock: View
  private lateinit var chrome: GuideChrome
  private var statusPulse: ObjectAnimator? = null
  private var lastGuidePhase: GuidePhase = GuidePhase.Idle
  private val updateRunning = java.util.concurrent.atomic.AtomicBoolean(false)
  /** 崩溃标记：记录未捕获异常摘要，下次启动测试界面提示（不吞异常）。 */
  private var crashInfo: String? = null
  /** 重启引擎 in-flight 守卫（防连点双杀双启）。 */
  private val engineRestarting = java.util.concurrent.atomic.AtomicBoolean(false)
  /** 用户主动关闭后，前台监控与任何尚未结束的启动线程不得重新展示 WebUI。 */
  @Volatile
  private var userClosedEngine = false
  /** 前台引擎监控：3s 轮询探测，down→测试界面、up→恢复 WebUI
   *  （"设置里杀进程/引擎崩溃回退测试界面"的落地；watchdog 负责恢复）。 */
  private val engineMonitorHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private val engineMonitorRunnable = object : Runnable {
    override fun run() {
      val monitor = this
      Thread {
        val running = try { EngineProbe.check(500).optBoolean("running", false) } catch (_: Exception) { false }
        runOnUiThread {
          if (::webView.isInitialized && ::guideView.isInitialized && !userClosedEngine) {
            if (!running && webView.visibility == View.VISIBLE) {
              applyGuidePhase(GuidePhase.Recovering, "引擎未运行，正在自动恢复…")
              showGuide()
            } else if (running && guideView.visibility == View.VISIBLE) {
              showWeb()
            }
          }
          if (!userClosedEngine) engineMonitorHandler.postDelayed(monitor, 3000)
        }
      }.start()
    }
  }
  // —— WebView 渲染进程冻结看门狗（2026-08-18，issue #36：荣耀 MagicUI 6.1 /
  // Android 12 仍卡「Loading plugins…」且页面无诊断层 = 渲染进程 JS 主线程冻结，
  // 页面内看门狗定时器也跑不动）。evaluateJavascript 的 JS 在渲染进程执行，App
  // 主线程不受影响：主线程周期发 JS 心跳，回调不再返回即判渲染进程失活 →
  // Toast 提示 + 自动 reload 一次 + 记日志。 ——
  private val freezeHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private var jsAckAt = System.currentTimeMillis()
  private var pageLoadedAt = System.currentTimeMillis()
  private var pingOutstanding = false
  private var freezeReloaded = false
  private val freezeRunnable = object : Runnable {
    override fun run() {
      if (!::webView.isInitialized || userClosedEngine || webView.visibility != View.VISIBLE) return
      val now = System.currentTimeMillis()
      if (now - pageLoadedAt > 45_000 && now - jsAckAt > 20_000) {
        LogCollector.log("dsh-shell", "webview JS 无响应，渲染进程冻结（frozenMs=" + (now - jsAckAt) + "）")
        try {
          android.widget.Toast.makeText(
            this@MainActivity, "页面无响应，正在自动刷新…", android.widget.Toast.LENGTH_LONG,
          ).show()
        } catch (_: Exception) {
        }
        if (!freezeReloaded) {
          freezeReloaded = true
          try { webView.reload() } catch (_: Exception) {
          }
        }
        jsAckAt = now
        pingOutstanding = false
      } else if (!pingOutstanding) {
        pingOutstanding = true
        try {
          webView.evaluateJavascript("1") { _ ->
            jsAckAt = System.currentTimeMillis()
            pingOutstanding = false
          }
        } catch (_: Exception) {
          pingOutstanding = false
        }
      }
      freezeHandler.postDelayed(this, 10_000)
    }
  }

  private fun startFreezeWatchdog() {
    if (userClosedEngine || !::webView.isInitialized || webView.visibility != View.VISIBLE) return
    val now = System.currentTimeMillis()
    pageLoadedAt = now
    jsAckAt = now
    pingOutstanding = false
    if (freezeHandler.hasCallbacks(freezeRunnable)) freezeHandler.removeCallbacks(freezeRunnable)
    freezeHandler.postDelayed(freezeRunnable, 10_000)
  }

  private val engineManager by lazy { EngineManager(this, pickToken) }
  private val engineFlowRunning = java.util.concurrent.atomic.AtomicBoolean(false)
  /** Invalidates stale startup work when the user closes or explicitly restarts the engine. */
  private val engineFlowGeneration = java.util.concurrent.atomic.AtomicLong(0)
  private var pendingPickCallback: String? = null
  /** M3：上次 pick 因缺权限挂起（onResume 续启/结算的依据）。 */
  private var pendingPermissionRequest = false
  private var filePathCallback: ValueCallback<Array<Uri>>? = null

  private val directoryPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
    pickTtlHandler.removeCallbacks(pickTtlRunnable)
    val callback = pendingPickCallback
    pendingPickCallback = null
    pendingPermissionRequest = false
    if (callback != null) {
      if (uri != null) {
        val path = AndroidBridge.resolvePickedPath(uri)
        webView.evaluateJavascript(
          "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callback) + ", " + jsString(path) + ")", null,
        )
      } else {
        // 用户取消：回传 null，让引擎侧 pick() 以取消结算（否则页面轮询
        // 会继续拿到同一请求反复唤起选择器——设备实证的 picker 堆叠）。
        webView.evaluateJavascript(
          "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callback) + ", null)", null,
        )
      }
    }
  }

  /** H2：壳侧 pick 占槽 TTL（与引擎侧 5 分钟 TTL 对齐）——SAF 结果永远
   *  不回来（系统设置页停留/进程被杀恢复/缺权限路径）时自动清槽并按取消
   *  结算，避免后续目录选择被单槽永久拒绝。 */
  private val pickTtlHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private val pickTtlRunnable = Runnable {
    val callback = pendingPickCallback
    pendingPickCallback = null
    pendingPermissionRequest = false
    if (callback != null) {
      try {
        webView.evaluateJavascript(
          "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callback) + ", null)", null,
        )
      } catch (_: Exception) {
      }
    }
  }

  companion object {
    private const val TAG = "dsh-shell"
    const val ACTION_UPDATE = "com.dsharnessmobile.shell.action.UPDATE"

    /** 导出文件大小上限（防恶意/异常大文件 OOM）。 */
    const val MAX_DOWNLOAD_BYTES = 200L * 1024 * 1024

    /** 会话日志导出端点路径（WebView 内双拦截识别用）。 */
    const val SESSION_EXPORT_PATH = "/api/session.export"
  }

  // 文件上传（<input type=file> → WebView onShowFileChooser → 系统文件选择器）。
  // 与目录选择（directoryPicker，工作区用）分离：多选、任意类型。
  private val filePicker =
    registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
      val callback = filePathCallback
      filePathCallback = null
      if (callback != null) {
        callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
      }
    }

  // 图片选择：ACTION_PICK 走系统相册（tap 即选），区别于 ACTION_GET_CONTENT 的文件管理器。
  // accept 为图片类型时必须走相册，否则系统会进「最近/大型文件」的文档界面（需要长按才能选）。
  private val imagePicker =
    registerForActivityResult(PickImageContract()) { uri ->
      val callback = filePathCallback
      filePathCallback = null
      if (callback != null) {
        callback.onReceiveValue(if (uri == null) null else arrayOf(uri))
      }
    }

  private val notificationPermission =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* test channel only */ }

  /** bridge 图片选择：原生读图 → base64 data URL → window.__dshBridge.onImagePicked。
   *  华为 WebView（Chromium 114）的 onShowFileChooser 收到 content:// Uri 后不触发
   *  input change，改由原生层读字节直接回传 JS，彻底绕开 WebView 文件选择器。 */
  private var pendingImagePickCallback: String? = null

  private val imagePickerBridge =
    registerForActivityResult(PickImageContract()) { uri ->
      val callbackId = pendingImagePickCallback
      pendingImagePickCallback = null
      Log.i("dsh-image", "bridge pick result: callbackId=" + callbackId + " uri=" + uri)
      if (callbackId == null) return@registerForActivityResult
      if (uri == null) {
        webView.evaluateJavascript(
          "window.__dshBridge?.onImagePicked?.(" + jsString(callbackId) + ", null)", null,
        )
        return@registerForActivityResult
      }
      try {
        val mediaType = contentResolver.getType(uri) ?: "image/jpeg"
        val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: byteArrayOf()
        Log.i("dsh-image", "read bytes=" + bytes.size + " type=" + mediaType)
        val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        val dataUrl = "data:$mediaType;base64,$b64"
        val name = queryImageName(uri) ?: "image"
        val json = "{\"dataUrl\":" + jsString(dataUrl) +
          ",\"mediaType\":" + jsString(mediaType) +
          ",\"name\":" + jsString(name) +
          ",\"size\":" + bytes.size + "}"
        Log.i("dsh-image", "json length=" + json.length)
        webView.evaluateJavascript(
          "window.__dshBridge?.onImagePicked?.(" + jsString(callbackId) + ", " + json + ")",
        ) { value -> Log.i("dsh-image", "js result: " + value) }
      } catch (e: Exception) {
        Log.e("dsh-image", "read failed", e)
        webView.evaluateJavascript(
          "window.__dshBridge?.onImagePicked?.(" + jsString(callbackId) + ", null)", null,
        )
      }
    }

  private fun pickImageForBridge(callbackId: String) {
    if (pendingImagePickCallback != null) {
      webView.evaluateJavascript(
        "window.__dshBridge?.onImagePicked?.(" + jsString(callbackId) + ", null)", null,
      )
      return
    }
    pendingImagePickCallback = callbackId
    imagePickerBridge.launch(Unit)
  }

  /** 字体大小持久化读取（设置 → 通用设置 滑块；默认 100）。 */
  private fun textZoomPrefs(): Int {
    return try {
      getSharedPreferences("dsh_settings", MODE_PRIVATE).getInt("text_zoom", 100)
    } catch (_: Exception) {
      100
    }
  }

  /** 字体大小设置（WebView textZoom）+ 持久化，重启/缓存刷新后仍生效。 */
  private fun setTextZoomPersisted(percent: Int) {
    val p = percent.coerceIn(50, 200)
    // JS 桥在 JavaBridge 线程调用；WebView 方法必须切回主线程。
    runOnUiThread { webView.settings.textZoom = p }
    try {
      getSharedPreferences("dsh_settings", MODE_PRIVATE).edit().putInt("text_zoom", p).apply()
      Log.i("dsh-image", "textZoom set: " + p)
    } catch (e: Exception) {
      Log.e("dsh-image", "textZoom persist failed: " + e.message)
    }
  }

  /**
   * 原生剪贴板写入（WebView 的 Clipboard API 在 Android 上被拒
   * NotAllowedError: Write permission denied，页面回退到本桥）。
   */
  private fun copyTextNative(text: String): Boolean {
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

  /**
   * 用外部阅读器打开文件路径（issue #52）：引擎 native-path-opener 仅支持
   * mac/win/linux，Android 上文件提及按钮会失败。路径解析：
   * - /storage/emulated/0/Documents/dshdata/...（导出仓库）→ FileProvider content Uri
   * - 应用私有文件区（工作区/usr/bin）→ FileProvider content Uri
   * - 其他（content://、不可读、或私密区路径如 .dsh/.credentials.yaml）→ false，
   *   前端回退引擎 RPC（桌面宿主行为）。
   * 安全（2026-08-23 CRITICAL 修复）：运行时白名单 canonical 校验，与
   * res/xml/file_paths.xml 的映射面一致——FileProvider 若配到更宽路径也会被此层拦截。
   */
  private fun openNativePathWithReader(path: String): Boolean {
    return try {
      val file = java.io.File(path)
      if (!file.exists()) {
        Log.w("dsh-image", "openNativePath: not exists: $path")
        return false
      }
      if (!isReaderAllowedPath(file)) {
        Log.w("dsh-image", "openNativePath rejected (outside reader whitelist): $path")
        return false
      }
      val uri = androidx.core.content.FileProvider.getUriForFile(
        this, "$packageName.fileprovider", file,
      )
      val intent = Intent(Intent.ACTION_VIEW, uri).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      startActivity(intent)
      Log.i("dsh-image", "openNativePath ok: $path")
      true
    } catch (e: Exception) {
      Log.w("dsh-image", "openNativePath failed: $path -> ${e.message}")
      false
    }
  }

  /** 外部阅读器白名单（与 res/xml/file_paths.xml 映射面一致；canonical 比较防 symlink/.. 逃逸）。 */
  private fun isReaderAllowedPath(file: java.io.File): Boolean {
    return try {
      val canon = file.canonicalPath
      val roots = listOf(
        java.io.File(filesDir, "home/.dsh/workspaces"),
        java.io.File(filesDir, "home/tmp"),
        java.io.File(filesDir, "usr/bin"),
        java.io.File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), "dshdata"),
      ).map { it.canonicalPath }
      roots.any { root -> canon == root || canon.startsWith(root + java.io.File.separator) }
    } catch (_: Exception) {
      false
    }
  }

  /** 从 content Uri 读取显示名（MediaStore DISPLAY_NAME）。 */
  private fun queryImageName(uri: Uri): String? {
    return try {
      contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
        ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    } catch (_: Exception) {
      null
    }
  }

  /** ACTION_PICK 图片选择契约：打开系统相册，tap 即返回单个图片 Uri。 */
  private class PickImageContract : ActivityResultContract<Unit, Uri?>() {
    override fun createIntent(context: Context, input: Unit): Intent {
      return Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI).apply {
        type = "image/*"
      }
    }
    override fun parseResult(resultCode: Int, intent: Intent?): Uri? {
      return if (resultCode == android.app.Activity.RESULT_OK) intent?.data else null
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
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
    applyImmersive(immersivePrefs())
    val root = FrameLayout(this)
    webView = WebView(this).apply {
      id = View.generateViewId()
      visibility = View.GONE
    }
    root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    guideView = buildGuideView()
    root.addView(guideView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    setContentView(root)
    ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val mandatoryGestures = insets.getInsets(WindowInsetsCompat.Type.mandatorySystemGestures()).bottom
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val density = resources.displayMetrics.density
      webSystemBottomInset = pxToCssPx(maxOf(bars.bottom, mandatoryGestures), density)
      webImeBottomInset = pxToCssPx(ime, density)
      scheduleWebInsetsPush()
      if (::guideView.isInitialized) {
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
    // Testable update trigger: adb am start -n .../.MainActivity -a com.dsharnessmobile.shell.action.UPDATE
    if (intent?.action == ACTION_UPDATE) {
      runUpdate()
    } else {
      maybeProcessIncoming(intent)
      startEngineFlow()
    }
  }

  /**
   * 文件直达（0.13.0 F5/M3.5）：VIEW/SEND 意图 → 校验净化 → 拷贝临时工作区 → 通知引擎侧插件。
   * 外部路径不留原件引用（一律拷贝，权限模型对齐 F1.8）；引擎未启动先启动（启动流先于通知）。
   */
  private fun maybeProcessIncoming(intent: Intent?) {
    if (intent == null) return
    val action = intent.action
    val uri: Uri? = when (action) {
      Intent.ACTION_VIEW -> intent.data
      Intent.ACTION_SEND -> intent.getParcelableExtra(Intent.EXTRA_STREAM)
      else -> null
    }
    if (uri == null) return
    // 每次文件入队前先做 TTL 清扫（issue #60 F5.1：临时文件 7 天自动回收，防止无限堆积）
    FileIncoming.sweepExpired(this)
    val validated = FileIncoming.validate(uri.toString(), this) ?: run {
      showTestNotification("文件直达被拒绝", "路径不在允许范围（仅系统打开/分享的真实路径）")
      return
    }
    val target = FileIncoming.copyIn(this, validated) ?: run {
      showTestNotification("文件拷贝失败", "无法读取传入文件")
      return
    }
    FileIncoming.recordOpening(this, target.absolutePath)
    LogCollector.log("dsh-file-open", "incoming processed: " + target.absolutePath)
    // 引擎侧插件端点：路径交给 dsh-android-file-open 强制新会话（引擎未起时端点由启动流承托）。
    Thread {
      try {
        val conn = java.net.URL("http://127.0.0.1:3080/api/android/file-incoming").openConnection() as java.net.HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 3000
        val body = org.json.JSONObject().put("path", target.absolutePath).toString()
        conn.outputStream.use { it.write(body.toByteArray()) }
        conn.responseCode
        conn.disconnect()
      } catch (_: Exception) {
      }
    }.start()
  }

  /** 任务移除清理见 EngineService.onTaskRemoved（生命周期礼仪 F5.3：让位+尽力清理，不反弹）。 */

  /** 首启向导已移除（决策 2026-08-23）：初始页（GuideChrome 运行时状态/解压进度/崩溃/日志）
   *  已足够承载首启信息；配置项（共享目录/镜像/ADB 授权）经设置面与「工具与环境」页承托。 */

  override fun onResume() {
    super.onResume()
    // 前台引擎监控：引擎被杀/崩溃时自动回退测试界面，恢复后回 WebUI。
    if (!userClosedEngine) {
      engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
      engineMonitorHandler.post(engineMonitorRunnable)
    }
    // 2026-08-24 修复（真机实锤：通知链路不消费的根因）：startEngineService（foreground service
    // + WatchdogV2 tick）此前只在 startEngineFlow 首次轮询成功时挂载——**引擎先跑、app 后启动
    // （后台恢复/热启动）时服务从未启动 → watchdog 缺失 → 通知消费（task-done 标记）/自动回退
    // /唤醒锁全链路失效**。onResume 幂等确保服务启动（已在跑则 no-op）。
    if (!userClosedEngine) {
      startEngineService()
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
    if (::chrome.isInitialized) refreshGuideMeta()
    if (!userClosedEngine && webView.visibility != View.VISIBLE && !EngineProbe.check().optBoolean("running", false)) startEngineFlow()
    // 主题补推：从系统设置/SAF 返回时系统主题可能已变（兜底桥时序覆盖）。
    if (::webView.isInitialized) {
      pushSystemDark(webView)
      pushWebInsets()
    }
    // M3：从系统授权页返回——上次 pick 因缺权限挂起时，已授权则自动续启
    // SAF，仍拒绝则按取消结算（引擎请求不挂到 5 分钟 TTL）。
    if (pendingPickCallback != null) {
      val granted = android.os.Build.VERSION.SDK_INT >= 30 &&
        android.os.Environment.isExternalStorageManager()
      Log.i(TAG, "M3 resume: pendingPick=" + pendingPickCallback + " granted=" + granted + " permFlag=" + pendingPermissionRequest)
      if (granted) {
        pendingPermissionRequest = false
        directoryPicker.launch(null)
      } else {
        pickTtlHandler.removeCallbacks(pickTtlRunnable)
        val callback = pendingPickCallback
        pendingPickCallback = null
        pendingPermissionRequest = false
        if (callback != null) {
          try {
            webView.evaluateJavascript(
              "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callback) + ", null)", null,
            )
          } catch (_: Exception) {
          }
        }
      }
    }
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
    engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
    freezeHandler.removeCallbacks(freezeRunnable)
    pickTtlHandler.removeCallbacks(pickTtlRunnable)
    statusPulse?.cancel()
    statusPulse = null
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
    engineManager.stopEngine()
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
      // 字体大小（设置 → 通用设置）：从本地持久化恢复，不依赖页面缓存。
      textZoom = textZoomPrefs().coerceIn(50, 200)
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
          downloadToDownloads(url, null)
          return true
        }
        // 只允许引擎同源页面留在 WebView（特权桥 + 下载能力仅对引擎可信）；
        // 外部链接交给系统浏览器，防止不可信页面获得桥能力（社工/通知轰炸/任意下载）。
        if (isEngineSource(url)) {
          view.loadUrl(url)
          return true
        }
        openInExternalBrowser(request.url)
        return true
      }

      override fun onReceivedError(view: WebView, errorCode: Int, description: String, failingUrl: String) {
        if (isEngineSource(failingUrl)) showGuide()
      }

      override fun onPageFinished(view: WebView, url: String) {
        super.onPageFinished(view, url)
        pushSystemDark(view)
        pushWebInsets(view)
        if (isEngineSource(url) && !userClosedEngine) startFreezeWatchdog()
      }
    }
    // WebView 下载：会话日志导出（/api/session.export）与其余引擎源下载
    // 统一走 app 内下载（优先 Documents/dshdata/exports，未授权回退
    // MediaStore.Downloads）——浏览器导航带 Origin:null 会被 dsh
    // 的 /api browser-trust fence 拒绝（403），app 内 HttpURLConnection
    // 无浏览器标记 → fence 放行（403 修复路径，见 downloadToDownloads）。
    webView.setDownloadListener { url, _userAgent, contentDisposition, _mimeType, _contentLength ->
      downloadToDownloads(url, contentDisposition)
    }
    webView.webChromeClient = object : WebChromeClient() {
      override fun onShowFileChooser(
        webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams,
      ): Boolean {
        // 文件上传走系统文件选择器；directoryPicker 是目录选择（工作区用），两者分离。
        // accept="image/*" 时走图片选择器（GetContent → 相册），否则走文档选择器。
        this@MainActivity.filePathCallback?.onReceiveValue(null)
        this@MainActivity.filePathCallback = filePathCallback
        val accept = fileChooserParams.acceptTypes ?: emptyArray()
        val imageOnly = accept.isNotEmpty() && accept.all { it.startsWith("image/") }
        if (imageOnly) {
          imagePicker.launch(Unit)
        } else {
          filePicker.launch(emptyArray())
        }
        return true
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
        onPickRequest = { callbackId -> pickDirectoryWithPermissionCheck(callbackId) },
        onKeepScreen = { enable -> keepScreenOn(enable) },
        onNotify = { title, text -> NotifyCenter.notify(this, "task", title, text) },
        onAllFilesAccessRequest = { openAllFilesAccessSettings() },
        onDebugLogsRequest = { downloadDebugLogs() },
        onExportConfig = { exportConfigToShared() },
        onImportConfig = { importConfigFromShared() },
        onGetSystemDark = {
          (resources.configuration.uiMode and
            android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES
        },
        onPickImageRequest = { callbackId -> pickImageForBridge(callbackId) },
        onSetTextZoomRequest = { percent -> setTextZoomPersisted(percent) },
        onSetImmersiveRequest = { enable -> setImmersivePersisted(enable) },
        onCopyTextRequest = { text -> copyTextNative(text) },
        pickToken = pickToken,
        onRestartEngine = { restartEngine() },
        onShutdownToGuide = { shutdownToGuide() },
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
              "运行日志按天写入 " + LogCollector.currentDir(this).absolutePath,
            )
          } else {
            LogCollector.log("dsh-shell", "dev log disabled by user")
            LogCollector.stop()
            showTestNotification("开发者日志已关闭", "日志收集已停止")
          }
        },
        onOpenNativePath = { path -> openNativePathWithReader(path) },
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
      ),
      "androidBridge",
    )
    webView.loadUrl(EngineProbe.ENGINE_URL)
  }

  /**
   * SAF 目录选择（带 All Files Access 引导）：外部工作区要求 bash 进程能
   * 直接访问所选真实路径；无权限时先跳系统授权页并提示页面侧重试。
   */
  private fun pickDirectoryWithPermissionCheck(callbackId: String) {
    // 并发保护：已有在途选择时拒绝新请求（单槽 pendingPickCallback 会被
    // 覆盖导致前一个引擎 pick 永不结算——P2-8）。
    if (pendingPickCallback != null) {
      webView.evaluateJavascript(
        "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callbackId) + ", null)", null,
      )
      return
    }
    if (android.os.Build.VERSION.SDK_INT < 30) {
      // Android 10 及以下无 All Files Access 模型：外部工作区不可用。
      // 回传 null 让引擎侧 pick 以取消结算，不崩溃、不静默挂起。
      webView.evaluateJavascript(
        "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callbackId) + ", null)", null,
      )
      showTestNotification("外部工作区不可用", "Android 10 及以下不支持选择外部目录")
      return
    }
    if (android.os.Environment.isExternalStorageManager()) {
      pendingPickCallback = callbackId
      pickTtlHandler.removeCallbacks(pickTtlRunnable)
      pickTtlHandler.postDelayed(pickTtlRunnable, 5 * 60_000L)
      directoryPicker.launch(null)
      return
    }
    // M3：未授权路径也占槽 + 记挂起标记——onResume 据此在授权返回后自动
    // 续启 SAF（或仍拒绝时按取消结算），引擎请求不再静默挂到 5 分钟 TTL。
    pendingPickCallback = callbackId
    pendingPermissionRequest = true
    pickTtlHandler.removeCallbacks(pickTtlRunnable)
    pickTtlHandler.postDelayed(pickTtlRunnable, 5 * 60_000L)
    openAllFilesAccessSettings()
    webView.evaluateJavascript(
      "window.__dshBridge?.onPermissionRequired?.()", null,
    )
  }

  /** Open the system All Files Access screen for this app. */
  private fun openAllFilesAccessSettings() {
    if (android.os.Build.VERSION.SDK_INT < 30) return
    try {
      startActivity(
        Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
          .setData(Uri.parse("package:$packageName")),
      )
    } catch (_: Exception) {
      // Some OEMs lack the per-app screen; fall back to the global one.
      try {
        startActivity(Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
      } catch (_: Exception) {
        // 无任何可用入口：静默忽略（引擎侧会以取消结算）。
      }
    }
  }

  /**
   * 下载引擎侧 URL 并保存为会话日志 ZIP 导出。优先直写
   * Documents/dshdata/exports/（需 MANAGE_EXTERNAL_STORAGE）；未授权时
   * 回退 MediaStore.Downloads。仅接受引擎同源 URL；流式写入并设大小上限。
   * app 内 HttpURLConnection 请求无浏览器标记（Origin/sec-fetch-site），
   * 通过 dsh 的 /api browser-trust fence（浏览器导航 403 的修复路径）。
   */
  /** 下载 in-flight 守卫：shouldOverrideUrlLoading 与 downloadListener 双入口去重。 */
  private val exportDownloading = java.util.concurrent.atomic.AtomicBoolean(false)

  private fun downloadToDownloads(url: String, contentDisposition: String?) {
    if (!isEngineSource(url)) {
      showTestNotification("下载被拒绝", "仅支持从本机引擎导出文件")
      pushExportResult(false, "仅支持从本机引擎导出文件")
      return
    }
    if (!exportDownloading.compareAndSet(false, true)) return
    if (Build.VERSION.SDK_INT < 29) {
      showTestNotification("导出失败", "当前系统版本不支持下载，请升级到 Android 10+")
      pushExportResult(false, "当前系统版本不支持下载，请升级到 Android 10+")
      exportDownloading.set(false)
      return
    }
    val filename = sanitizeFilename(parseDownloadFilename(url, contentDisposition))
    Thread {
      var conn: HttpURLConnection? = null
      try {
        val c = URL(url).openConnection() as HttpURLConnection
        conn = c
        c.connectTimeout = 15_000
        c.readTimeout = 60_000
        c.requestMethod = "GET"
        if (c.responseCode != HttpURLConnection.HTTP_OK) {
          throw java.io.IOException("HTTP " + c.responseCode)
        }
        var saved: String? = null
        c.inputStream.use { input ->
          saved = saveExportToDshData(filename, input)
        }
        val finalPath = saved
        runOnUiThread {
          showTestNotification("会话日志已导出", "已保存到 $finalPath")
          pushExportResult(true, "已保存到 $finalPath")
        }
      } catch (t: Throwable) {
        val message = t.message ?: "未知错误"
        runOnUiThread {
          showTestNotification("导出失败", message)
          pushExportResult(false, message)
        }
      } finally {
        conn?.disconnect()
        exportDownloading.set(false)
      }
    }.start()
  }

  /** 导出结果回传 WebView：UI 插件经 window.__dshExportResult 弹软件内结果框。 */
  private fun pushExportResult(ok: Boolean, detail: String) {
    val title = if (ok) "导出成功" else "导出失败"
    val payload = "{\"ok\":" + ok + ",\"title\":" + jsString(title) + ",\"detail\":" + jsString(detail) + "}"
    webView.post {
      webView.evaluateJavascript(
        "window.__dshExportResult && window.__dshExportResult(" + payload + ")", null,
      )
    }
  }

  /**
   * 保存导出流。已授 MANAGE_EXTERNAL_STORAGE 时直写
   * Documents/dshdata/exports/<净化文件名>.zip（同名加 (1)，先写 .tmp 再 rename）；
   * 未授权回退 MediaStore.Downloads。返回用于展示的实际路径。
   */
  private fun saveExportToDshData(filename: String, input: java.io.InputStream): String {
    if (Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()) {
      val exportDir = File(engineManager.dshDataDir, "exports")
      exportDir.mkdirs()
      File(engineManager.dshDataDir, ".nomedia").writeText("")
      val target = uniqueExportFile(exportDir, filename)
      val tmp = File(exportDir, "." + target.name + ".tmp")
      try {
        tmp.outputStream().use { out ->
          val buf = ByteArray(64 * 1024)
          var total = 0L
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > MAX_DOWNLOAD_BYTES) throw java.io.IOException("导出文件过大")
            out.write(buf, 0, n)
          }
        }
        if (!tmp.renameTo(target)) {
          java.nio.file.Files.move(tmp.toPath(), target.toPath())
        }
      } catch (t: Throwable) {
        tmp.delete()
        throw t
      }
      return "文档/dshdata/exports/" + target.name
    }
    val savedName = saveToDownloadsStreamed(filename, input)
    return "下载/$savedName"
  }

  /** 同名冲突加 (1) 后缀。 */
  private fun uniqueExportFile(dir: File, name: String): File {
    val dot = name.lastIndexOf('.')
    val base = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    var candidate = File(dir, name)
    var i = 1
    while (candidate.exists()) {
      candidate = File(dir, base + " (" + i + ")" + ext)
      i++
    }
    return candidate
  }

  /** 写入 MediaStore.Downloads（Android 10+ 免权限），流式 + 200MB 上限。 */
  private fun saveToDownloadsStreamed(filename: String, input: java.io.InputStream): String {
    val values = ContentValues().apply {
      put(MediaStore.Downloads.DISPLAY_NAME, filename)
      put(MediaStore.Downloads.MIME_TYPE, "application/zip")
      put(MediaStore.Downloads.IS_PENDING, 1)
      put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
    }
    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
      ?: throw java.io.IOException("无法创建下载文件")
    try {
      contentResolver.openOutputStream(uri)?.use { out ->
        val buf = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          total += n
          if (total > MAX_DOWNLOAD_BYTES) throw java.io.IOException("导出文件过大")
          out.write(buf, 0, n)
        }
      } ?: throw java.io.IOException("无法写入下载文件")
      values.clear()
      values.put(MediaStore.Downloads.IS_PENDING, 0)
      contentResolver.update(uri, values, null, null)
    } catch (t: Throwable) {
      contentResolver.delete(uri, null, null)
      throw t
    }
    return filename
  }

  /** 文件名净化：去路径分隔符/控制字符，限长。 */
  private fun sanitizeFilename(name: String): String {
    val cleaned = name.replace(Regex("[/\\\u0000-\u001f]"), "_").take(200)
    return if (cleaned.isBlank()) "dsh-session-export.zip" else cleaned
  }

  /** 文件名：Content-Disposition 优先，退回 URL 的 sessionId，再退回固定名。 */
  private fun parseDownloadFilename(url: String, contentDisposition: String?): String {
    contentDisposition?.let { cd ->
      Regex("filename=\"?([^\";]+)\"?").find(cd)?.groupValues?.get(1)?.let { return it }
    }
    return try {
      val q = URL(url).query ?: ""
      val sid = q.split("&").mapNotNull { seg ->
        val kv = seg.split("=", limit = 2)
        if (kv.size == 2 && kv[0] == "sessionId") kv[1] else null
      }.firstOrNull()
      if (sid != null) "dsh-session-$sid.zip" else "dsh-session-export.zip"
    } catch (_: Exception) {
      "dsh-session-export.zip"
    }
  }

  /** 调试日志导出（2026-08-16）：引擎日志 + 环境信息打包 zip。
   *  入口：加号菜单「导出调试日志」→ androidBridge.downloadDebugLogs()。
   *  优先写 Documents/dshdata/exports/（MANAGE_EXTERNAL_STORAGE 已授），
   *  未授权回退 MediaStore.Downloads；结果复用导出弹窗（同 session 下载）。 */
  private val debugLogging = java.util.concurrent.atomic.AtomicBoolean(false)

  /**
   * 0.13.1 W4：配置导出——私有 DSH_HOME 的 settings.yaml -> Documents/dshdata/exports/config/settings.yaml。
   * 引擎读的是私有目录（外部改共享副本无效，v0.10.5 布局），本桥提供安全的手改通道：
   * 导出 -> 文件管理器编辑 -> 导入。settings.yaml 不含凭据（API key 在私有 deepseek-key.txt）。
   * 同步执行（JavascriptInterface 专用线程，阻塞 IO 无碍）。
   */
  private fun exportConfigToShared(): String {
    return try {
      val src = File(engineManager.homeDir, ".dsh/settings.yaml")
      if (!src.exists()) return """{"ok":false,"error":"settings.yaml 不存在（引擎尚未初始化？）"}"""
      val dstDir = File(File(engineManager.dshDataDir, "exports"), "config")
      dstDir.mkdirs()
      val tmp = File(dstDir, ".settings.yaml.tmp")
      src.copyTo(tmp, overwrite = true)
      val dst = File(dstDir, "settings.yaml")
      if (!tmp.renameTo(dst)) throw java.io.IOException("rename failed")
      LogCollector.log("dsh-shell", "config exported to " + dst.absolutePath)
      """{"ok":true,"path":"${dst.absolutePath.replace("\\", "\\\\")}"}"""
    } catch (t: Throwable) {
      Log.w(TAG, "config export failed", t)
      """{"ok":false,"error":"${(t.message ?: "导出失败").replace("\"", "'")}"}"""
    }
  }

  /** 0.13.1 W4：配置导入——共享 exports/config/settings.yaml -> 私有 DSH_HOME（引擎 chokidar 热加载）。 */
  private fun importConfigFromShared(): String {
    return try {
      val src = File(File(engineManager.dshDataDir, "exports"), "config/settings.yaml")
      if (!src.exists()) return """{"ok":false,"error":"未找到 exports/config/settings.yaml（请先导出）"}"""
      val dst = File(engineManager.homeDir, ".dsh/settings.yaml")
      // 导入前留一份私有侧备份（防误导入坏配置后无法回退）。
      if (dst.exists()) {
        val bak = File(dst.parentFile, "settings.yaml.import-backup")
        dst.copyTo(bak, overwrite = true)
      }
      val tmp = File(dst.parentFile, ".settings.yaml.import-tmp")
      src.copyTo(tmp, overwrite = true)
      if (!tmp.renameTo(dst)) throw java.io.IOException("rename failed")
      LogCollector.log("dsh-shell", "config imported from " + src.absolutePath)
      """{"ok":true,"path":"${dst.absolutePath.replace("\\", "\\\\")}","hint":"引擎会热加载；若未生效请开发者选项里重启引擎"}"""
    } catch (t: Throwable) {
      Log.w(TAG, "config import failed", t)
      """{"ok":false,"error":"${(t.message ?: "导入失败").replace("\"", "'")}"}"""
    }
  }

  private fun downloadDebugLogs() {    if (!debugLogging.compareAndSet(false, true)) return
    Thread {
      try {
        val ts = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US)
          .format(java.util.Date())
        val filename = "dsh-debug-logs-$ts.zip"
        // 先写私有缓存，成功后再落最终位置（跨挂载只能 copy）。
        val cacheFile = File(cacheDir, filename)
        java.util.zip.ZipOutputStream(java.io.FileOutputStream(cacheFile)).use { zos ->
          val log = File(filesDir, "engine.log")
          if (log.exists()) {
            zos.putNextEntry(java.util.zip.ZipEntry("engine.log"))
            log.inputStream().use { it.copyTo(zos) }
            zos.closeEntry()
          }
          zos.putNextEntry(java.util.zip.ZipEntry("info.txt"))
          zos.write(buildDebugInfoText().toByteArray(Charsets.UTF_8))
          zos.closeEntry()
        }
        val saved = if (android.os.Build.VERSION.SDK_INT >= 30 &&
          android.os.Environment.isExternalStorageManager()
        ) {
          val exportDir = File(engineManager.dshDataDir, "exports").apply { mkdirs() }
          File(engineManager.dshDataDir, ".nomedia").writeText("")
          val target = uniqueExportFile(exportDir, filename)
          val tmp = File(exportDir, "." + target.name + ".tmp")
          cacheFile.inputStream().use { input -> java.io.FileOutputStream(tmp).use { out -> input.copyTo(out) } }
          if (!tmp.renameTo(target)) throw java.io.IOException("rename failed")
          "文档/dshdata/exports/" + target.name
        } else {
          cacheFile.inputStream().use { input -> saveToDownloadsStreamed(filename, input) }
          "下载/" + filename
        }
        pushExportResult(true, "已保存到 $saved")
      } catch (t: Throwable) {
        pushExportResult(false, t.message ?: "导出失败")
      } finally {
        debugLogging.set(false)
      }
    }.start()
  }

  /** 调试日志附带的环境信息（不含任何密钥；版本/设备/布局/插件摘要）。 */
  private fun buildDebugInfoText(): String {
    val sb = StringBuilder()
    sb.append("dsh-mobile debug info\n")
    sb.append("time: ").append(java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US)
      .format(java.util.Date())).append('\n')
    val pkg = try { packageManager.getPackageInfo(packageName, 0) } catch (_: Exception) { null }
    sb.append("app version: ").append(pkg?.versionName ?: "?").append(" (").append(pkg?.longVersionCode ?: 0).append(")\n")
    sb.append("android: ").append(android.os.Build.VERSION.RELEASE).append(" / SDK ").append(android.os.Build.VERSION.SDK_INT).append('\n')
    sb.append("device: ").append(android.os.Build.MANUFACTURER).append(' ').append(android.os.Build.MODEL).append('\n')
    sb.append("engine: ").append(EngineProbe.check().toString()).append('\n')
    sb.append("dshdata: ").append(engineManager.dshDataDir.absolutePath)
      .append(" (nomedia=").append(File(engineManager.dshDataDir, ".nomedia").exists())
      .append(", private-layout=").append(File(File(engineManager.homeDir, ".dsh"), ".private-layout").exists())
      .append(")\n")
    return sb.toString()
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
        "(function(){var root=document.documentElement;if(!root)return;var system='" + webSystemBottomInset +
          "px';var ime='" + webImeBottomInset +
          "px';root.style.setProperty(" +
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

  /**
   * 引擎源判定：精确匹配本机引擎的 scheme/host/port（防前缀欺骗，
   * 如 127.0.0.1:30800 或 127.0.0.1:3080.evil.com 误判为引擎源）。
   */
  private fun isEngineSource(url: String): Boolean {
    return try {
      val base = Uri.parse(EngineProbe.ENGINE_URL)
      val uri = Uri.parse(url)
      uri.scheme == base.scheme && uri.host == base.host && uri.port == base.port
    } catch (_: Exception) {
      false
    }
  }

  /** 命中判定：引擎源 + 会话导出路径 + GET（HEAD 是前端预检，不得触发跳转）。 */
  private fun isSessionExport(url: String, method: String): Boolean {
    return method == "GET" && isEngineSource(url) && url.contains(SESSION_EXPORT_PATH)
  }

  /**
   * 原子防重放的外部浏览器打开（非导出外链）。尽力而为：启动失败时
   * 静默（调用方不读返回值），不再有 MediaStore 回退契约——回退仅
   * 存在于导出路径（downloadToDownloads 内）。
   */
  private val exportLaunching = java.util.concurrent.atomic.AtomicBoolean(false)

  private fun openInExternalBrowser(uri: android.net.Uri): Boolean {
    if (!exportLaunching.compareAndSet(false, true)) return true // 已在途：吞掉重复触发
    return try {
      startActivity(Intent(Intent.ACTION_VIEW, uri))
      true
    } catch (_: Exception) {
      // 无浏览器可处理：回退 MediaStore 下载路径
      false
    } finally {
      exportLaunching.set(false)
    }
  }

  /** 屏幕常亮 WakeLock（JS 桥 keepScreenOn）。单例字段持有 + 成对
   *  acquire/release：旧实现每次调用 newWakeLock，新实例 isHeld 恒 false，
   *  关闭路径永不 release（Review 2026-08-18 实锤的锁泄漏）。 */
  private var screenWakeLock: PowerManager.WakeLock? = null

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

  private fun showTestNotification(title: String, text: String) {
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

  private fun buildGuideView(): LinearLayout {
    chrome = buildGuideChrome(
      this,
      GuideCallbacks(
        onStartEngine = { startEngineFlow() },
        onOpenConsole = { startActivity(Intent(this, ConsoleActivity::class.java)) },
        onCheckUpdate = { startUpdateCheck() },
        onGrantStorage = { openAllFilesAccessSettings() },
        onCopyLog = { copyGuideLog() },
      ),
    )
    engineStatus = chrome.engineStatus
    progressText = chrome.progressText
    progressBar = chrome.progressBar
    crashBanner = chrome.crashBanner
    logSummary = chrome.logSummary
    brandBlock = chrome.brandBlock
    cardBlock = chrome.cardBlock
    actionBlock = chrome.actionBlock
    chrome.versionLabel.text = "v" + BuildConfig.VERSION_NAME
    refreshGuideMeta()
    return chrome.root
  }

  /** 测试界面入场：品牌区/状态卡/操作区依次淡入上移。仅在界面从隐藏变为可见时播放。 */
  private fun animateGuideReveal() {
    val rise = 16 * resources.displayMetrics.density
    val items = listOf(brandBlock, cardBlock, actionBlock)
    items.forEachIndexed { i, v ->
      v.animate().cancel()
      v.alpha = 0f
      v.translationY = rise
      v.animate()
        .alpha(1f).translationY(0f)
        .setStartDelay(i * 80L).setDuration(480L)
        .setInterpolator(DsUi.ease).start()
    }
  }

  private enum class GuidePhase { Idle, Starting, Extracting, Updating, Recovering, Undoing, Error, Closed }

  private fun applyGuidePhase(phase: GuidePhase, title: String, hint: String? = null) {
    lastGuidePhase = phase
    engineStatus.text = title
    val resolvedHint = hint ?: defaultHint(phase)
    chrome.statusHint.text = resolvedHint
    chrome.statusHint.visibility = if (resolvedHint.isBlank()) View.GONE else View.VISIBLE

    val busy = phase == GuidePhase.Starting ||
      phase == GuidePhase.Extracting ||
      phase == GuidePhase.Updating ||
      phase == GuidePhase.Recovering ||
      phase == GuidePhase.Undoing
    val lockPrimary = phase == GuidePhase.Starting ||
      phase == GuidePhase.Extracting ||
      phase == GuidePhase.Updating ||
      phase == GuidePhase.Undoing
    chrome.primaryButton.isEnabled = !lockPrimary
    chrome.primaryButton.alpha = if (lockPrimary) 0.55f else 1f
    chrome.primaryButton.text = when (phase) {
      GuidePhase.Closed -> getString(R.string.ds_restart)
      GuidePhase.Error, GuidePhase.Recovering -> getString(R.string.ds_retry)
      GuidePhase.Starting, GuidePhase.Extracting -> getString(R.string.ds_starting)
      GuidePhase.Updating -> getString(R.string.ds_updating)
      GuidePhase.Undoing -> getString(R.string.ds_undoing)
      GuidePhase.Idle -> getString(R.string.ds_start_engine)
    }

    val showProgress = busy
    progressBar.visibility = if (showProgress) View.VISIBLE else View.GONE
    progressBar.isIndeterminate = true
    if (phase != GuidePhase.Extracting) progressText.visibility = View.GONE

    val dotColor = when (phase) {
      GuidePhase.Error, GuidePhase.Closed -> getColor(R.color.ds_danger)
      GuidePhase.Updating, GuidePhase.Extracting -> getColor(R.color.ds_warn)
      GuidePhase.Starting, GuidePhase.Recovering, GuidePhase.Undoing -> getColor(R.color.ds_accent)
      GuidePhase.Idle -> getColor(R.color.ds_text_tertiary)
    }
    chrome.statusDot.background = DsUi.oval(dotColor)
    setStatusPulse(busy)
    refreshGuideMeta()
  }

  private fun defaultHint(phase: GuidePhase): String = when (phase) {
    GuidePhase.Starting -> "首次启动会解压内嵌运行时，请保持应用在前台。"
    GuidePhase.Extracting -> "正在写入内嵌 Termux 环境，约 70MB。"
    GuidePhase.Updating -> "下载并校验快照后会自动切换运行时。"
    GuidePhase.Recovering -> "看门狗正在拉起引擎，通常几秒内恢复。"
    GuidePhase.Undoing -> "正在把配置/插件回滚到最后良好快照（自动回撤）。"
    GuidePhase.Error -> "可打开控制台查看 engine.log，或点击重试。"
    GuidePhase.Closed -> "引擎已停止，不会自动恢复。"
    GuidePhase.Idle -> "引擎就绪后将进入 DeepCode。"
  }

  private fun setStatusPulse(on: Boolean) {
    if (on) {
      val anim = statusPulse ?: ObjectAnimator.ofFloat(chrome.statusDot, View.ALPHA, 1f, 0.28f).apply {
        duration = 900
        repeatMode = ValueAnimator.REVERSE
        repeatCount = ValueAnimator.INFINITE
        interpolator = DsUi.ease
        statusPulse = this
      }
      if (!anim.isStarted) anim.start()
    } else {
      statusPulse?.cancel()
      chrome.statusDot.alpha = 1f
    }
  }

  private fun refreshGuideMeta() {
    if (!::chrome.isInitialized) return
    val runtimeReady = try { engineManager.engineReady } catch (_: Exception) { false }
    chrome.runtimeChip.text = if (runtimeReady) {
      getString(R.string.ds_runtime_ready)
    } else {
      getString(R.string.ds_runtime_pending)
    }
    val storageOk = Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()
    chrome.storageChip.text = if (storageOk) {
      getString(R.string.ds_storage_granted)
    } else {
      getString(R.string.ds_storage_needed)
    }
    chrome.storageChip.setTextColor(
      getColor(if (storageOk) R.color.ds_text_secondary else R.color.ds_accent),
    )
  }

  private fun copyGuideLog() {
    val text = logSummary.text?.toString().orEmpty()
    if (text.isBlank()) return
    copyTextNative(text)
    android.widget.Toast.makeText(this, "日志已复制", android.widget.Toast.LENGTH_SHORT).show()
  }

  private fun startUpdateCheck() {
    if (!updateRunning.compareAndSet(false, true)) return
    chrome.updateButton.isEnabled = false
    chrome.updateButton.alpha = 0.55f
    applyGuidePhase(GuidePhase.Updating, "检查更新…")
    UpdateManager(this).checkAndApply { status ->
      runOnUiThread {
        val done = status.startsWith("更新完成") || status.startsWith("更新失败")
        applyGuidePhase(
          if (status.startsWith("更新失败")) GuidePhase.Error
          else if (status.startsWith("更新完成")) GuidePhase.Recovering
          else GuidePhase.Updating,
          status,
        )
        if (done) {
          updateRunning.set(false)
          chrome.updateButton.isEnabled = true
          chrome.updateButton.alpha = 1f
        }
      }
    }
  }

  /** 开发者选项「关闭」：停止引擎并回退到初始化（启动/测试）界面，不自动重启。 */
  private fun shutdownToGuide() {
    userClosedEngine = true
    engineFlowGeneration.incrementAndGet()
    EngineService.userShutdown = true
    engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
    freezeHandler.removeCallbacks(freezeRunnable)
    runOnUiThread {
      hideSoftInput()
      applyGuidePhase(GuidePhase.Closed, "引擎已关闭")
      showGuide()
    }
    try { EngineService.instance?.requestShutdown() } catch (_: Exception) {
    }
    try { engineManager.stopEngine() } catch (_: Exception) {
    }
    try { stopService(Intent(this, EngineService::class.java)) } catch (_: Exception) {
    }
    LogCollector.log("dsh-shell", "harness closed via dev options (shutdownToGuide)")
  }

  /**
   * Engine-first flow: use an already-running engine (Termux or prior
   * embedded), else extract the embedded snapshot and start the embedded
   * engine, then poll until the web service answers.
   */
  /** 引擎启动超时/失败后进入自动回撤流程：UndoGate 幂等，安全多次调用。 */
  private fun maybeAutoUndo(generation: Long) {
    if (userClosedEngine) return
    Thread {
      try {
        // 引擎全死时先决门槛：急救 CLI 存在 + 快照非空 + 幂等窗口
        if (!UndoGate.onProbeFailure(this, WatchdogV2.consecutiveFailures)) return@Thread
        runOnUiThread {
          applyGuidePhase(GuidePhase.Undoing, "正在执行回撤…", "正在恢复到崩溃前的最后良好快照。")
        }
        val result = UndoGate.execute(this, engineManager)
        if (result.executed) {
          // 恢复配置文件后重启引擎（冷却窗复位由 UndoGate 完成后置零）
          runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            applyGuidePhase(GuidePhase.Recovering, "回撤完成，正在重启引擎…", "已恢复到快照 " + (result.snapshotId ?: "?"))
          }
          engineManager.resetCooldown()
          if (isCurrentEngineFlow(generation)) engineManager.startEngine()
          else EngineService.instance?.let { WatchdogV2.reset() }
        } else {
          runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            applyGuidePhase(GuidePhase.Error, "自动回撤不可用", result.summary.take(120))
          }
        }
      } catch (t: Throwable) {
        Log.e("dsh-shell", "auto-undo failed", t)
      }
    }.start()
  }

  /** 引擎启动超时（startEngineFlow 轮询失败后调用）：触发自动回撤。 */
  private fun onEngineStartTimeout(generation: Long) {
    // 先给看门狗一次机会：WatchdogV2 熔断阈值(12)远高于此处的保守阈值(6)，
    // 因此本路径只在「启动即失败」时触发；正常慢启动不会到达这里。
    maybeAutoUndo(generation)
  }

  private fun startEngineFlow() {
    // onCreate and the following onResume can both request startup. Acquire the
    // flow before mutating lifecycle state so a duplicate cannot invalidate the
    // actual starter.
    if (!engineFlowRunning.compareAndSet(false, true)) return
    val generation = engineFlowGeneration.incrementAndGet()
    userClosedEngine = false
    EngineService.userShutdown = false
    engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
    engineMonitorHandler.post(engineMonitorRunnable)
    Thread {
      try {
      if (!isCurrentEngineFlow(generation)) return@Thread
      if (EngineProbe.check().optBoolean("running", false)) {
        runOnUiThread { if (isCurrentEngineFlow(generation)) showWeb() }
        return@Thread
      }
      if (!isCurrentEngineFlow(generation)) return@Thread
      // 启动即有反馈：进入测试界面显示"正在启动引擎…"（不再白屏等 probe）。
      runOnUiThread {
        if (!isCurrentEngineFlow(generation)) return@runOnUiThread
        applyGuidePhase(GuidePhase.Starting, "正在启动引擎…")
        showGuide()
      }
      if (!engineManager.snapshotFresh()) {
        if (!isCurrentEngineFlow(generation)) return@Thread
        runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          applyGuidePhase(GuidePhase.Extracting, "正在解压运行时")
          progressText.visibility = View.VISIBLE
          progressText.text = "准备写入内嵌环境…"
        }
        val ok = engineManager.refreshSnapshot { done, _ ->
          runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            // done 是解压后字节数，total 是压缩包字节数，口径不一致；只显示已解压量。
            val mb = done / 1024 / 1024
            progressText.visibility = View.VISIBLE
            progressText.text = "已写入 " + mb + " MB"
            if (lastGuidePhase != GuidePhase.Extracting) {
              applyGuidePhase(GuidePhase.Extracting, "正在解压运行时")
            }
          }
        }
        if (!ok) {
          runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            // 0.13.1 W3：解压失败此前零落盘（engine.log 尚不存在、仅 logcat），镜像现场到共享目录。
            engineManager.mirrorDiagnosticsToShared("snapshot-refresh-failed")
            applyGuidePhase(GuidePhase.Error, "运行时更新失败（诊断包已存至 Documents/dshdata/diagnostics）")
            showGuide()
          }
          return@Thread
        }
        runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          applyGuidePhase(GuidePhase.Starting, "正在启动引擎…")
        }
      }
      if (!isCurrentEngineFlow(generation)) return@Thread
      // 急救 CLI 随 App 版本部署（内容比对幂等）：下探失败时自动回撤的前置依赖。
      engineManager.deployUndoCli()
      if (!engineManager.startEngine()) {
        runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          applyGuidePhase(GuidePhase.Error, "引擎启动失败")
          showGuide()
        }
        maybeAutoUndo(generation)
        return@Thread
      }
      // Poll for the web service with process-alive semantics (0.13.0 D1): cold boot takes
      // 20-45s (EngineManager START_COOLDOWN_MS comment); the old hard 30s budget fired
      // "引擎启动超时" on slow devices (K20 Pro) even though the engine later started.
      // Now: as long as the engine process is alive we keep waiting (up to 90s); only a dead
      // process declares failure (auto-undo path). UI shows a grey "still starting" state, not an error.
      val pollBudgetMs = 90_000L
      val pollStepMs = 1000L
      val budgetEnd = System.currentTimeMillis() + pollBudgetMs
      var waitedSeconds = 0
      var booted = false
      while (System.currentTimeMillis() < budgetEnd) {
        if (!isCurrentEngineFlow(generation)) return@Thread
        if (EngineProbe.check().optBoolean("running", false)) {
          booted = true
          break
        }
        if (!engineManager.engineProcessAlive()) {
          // 引擎进程已死：宣判失败（自动回退路径），不再空等。
          break
        }
        waitedSeconds = ((budgetEnd - System.currentTimeMillis()) / pollStepMs).toInt()
        if (waitedSeconds % 15 == 0) {
          val s = waitedSeconds
          runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            applyGuidePhase(GuidePhase.Starting, "引擎启动中（已等待 ${60 - s}s，冷启动较慢属正常）")
          }
        }
        Thread.sleep(pollStepMs)
      }
      if (!isCurrentEngineFlow(generation)) return@Thread
      if (!booted && !engineManager.engineProcessAlive()) {
        // 0.13.1 W3：进程死亡现场镜像到共享目录（含退出码），用户可直接取包反馈。
        engineManager.mirrorDiagnosticsToShared("engine-died-during-boot")
        runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          applyGuidePhase(GuidePhase.Error, "引擎启动失败（诊断包已存至 Documents/dshdata/diagnostics）")
          showGuide()
        }
        onEngineStartTimeout(generation)
        return@Thread
      }
      if (booted) {
        startEngineService()
        applyShizukuKeepAlive()
        runOnUiThread { if (isCurrentEngineFlow(generation)) showWeb() }
      } else {
        // 进程还活着但 90s 内未就绪（异常慢）：灰色提示而非红色错误，不触发回退——
        // 引擎仍在启动，3s engineMonitorRunnable 会兜底切界面。
        runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          applyGuidePhase(GuidePhase.Starting, "引擎启动较慢（已超过 90s），仍在后台启动中…")
        }
      }
      return@Thread
      } finally {
        engineFlowRunning.set(false)
      }
    }.start()
  }

  /** True only for the active startup request and while the user has not closed it. */
  private fun isCurrentEngineFlow(generation: Long): Boolean =
    !userClosedEngine && engineFlowGeneration.get() == generation

  /** Run the runtime snapshot update; status mirrored to a file for adb verification. */
  private fun runUpdate() {
    val statusFile = java.io.File(filesDir, "update-status.txt")
    val manager = UpdateManager(this)
    manager.checkAndApply { status ->
      runOnUiThread {
        val phase = when {
          status.startsWith("更新失败") -> GuidePhase.Error
          status.startsWith("更新完成") -> GuidePhase.Recovering
          else -> GuidePhase.Updating
        }
        applyGuidePhase(phase, status)
        showGuide()
      }
      try {
        statusFile.appendText(status + "\n")
      } catch (_: Exception) {
      }
    }
  }

  /** Start the foreground service (engine keep-alive + watchdog). */
  private fun startEngineService() {
    try {
      startForegroundService(Intent(this, EngineService::class.java))
    } catch (_: Exception) {
      // Foreground-service start limits: service will start on next launch.
    }
  }

  /** Best-effort Shizuku keep-alive boost; outcome logged only. */
  private fun applyShizukuKeepAlive() {
    try {
      Thread {
        val result = ShizukuSupport.status(this)
        Log.i("dsh-shizuku", result)
      }.start()
    } catch (_: Throwable) {
    }
  }

  private fun showWeb() {
    guideView.visibility = View.GONE
    webView.visibility = View.VISIBLE
    // The WebView may have rendered an error page before the engine was
    // ready (engine boot takes seconds); reload now that it answers.
    webView.reload()
  }

  /** 进入测试界面（引擎失败/未就绪回退）：状态 + 崩溃横幅 + engine.log 摘要。 */
  private fun showGuide() {
    val becomingVisible = guideView.visibility != View.VISIBLE
    webView.visibility = View.GONE
    guideView.visibility = View.VISIBLE
    if (becomingVisible) animateGuideReveal()
    val crash = crashInfo
    if (crash != null) {
      crashBanner.visibility = View.VISIBLE
      crashBanner.text = "上次异常退出：$crash"
    } else {
      crashBanner.visibility = View.GONE
    }
    val tail = tailEngineLog(8)
    if (tail.isNotEmpty()) {
      logSummary.text = tail
      chrome.logSection.visibility = View.VISIBLE
    } else {
      chrome.logSection.visibility = View.GONE
    }
    refreshGuideMeta()
  }

  /** Hide Android's soft keyboard before replacing the WebView with the guide. */
  private fun hideSoftInput() {
    try {
      WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.ime())
    } catch (_: Exception) {
      // The input connection may already be gone while a WebView bridge call is settling.
    }
  }

  /** engine.log 尾部摘要（测试界面诊断用；缺失/不可读返回空）。 */
  private fun tailEngineLog(lines: Int): String {
    val f = File(filesDir, "engine.log")
    if (!f.exists()) return ""
    return try {
      f.readLines().takeLast(lines).joinToString("\n")
    } catch (_: Exception) {
      ""
    }
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

  /**
   * 重启引擎服务进程（设置界面「重启引擎」）：pkill 引擎 → 重置冷却与
   * 流程守卫 → 1s 后重新走启动流程（EngineService 看门狗亦会拉起，
   * 进程级 CAS + 冷却保证双路径幂等）。防连点：in-flight 守卫。
   */
  private fun restartEngine() {
    if (!engineRestarting.compareAndSet(false, true)) return
    userClosedEngine = false
    engineFlowGeneration.incrementAndGet()
    EngineService.userShutdown = false
    Thread {
      try {
        try {
          Runtime.getRuntime().exec(arrayOf("/system/bin/pkill", "-f", "bin.js")).waitFor()
        } catch (_: Throwable) {
        }
        EngineManager.lastStartAttemptAt = 0
        engineFlowRunning.set(false)
        LogCollector.log("dsh-shell", "restart engine requested (pkill)")
        Thread.sleep(1000)
        runOnUiThread {
          showTestNotification("引擎重启中", "引擎进程已结束，正在重新启动…")
          startEngineFlow()
        }
      } finally {
        engineRestarting.set(false)
      }
    }.start()
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
