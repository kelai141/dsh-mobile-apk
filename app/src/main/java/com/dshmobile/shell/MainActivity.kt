package com.dshmobile.shell

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
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
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationCompat
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Shell activity: WebView over the local dsh engine + engine guide fallback. */
class MainActivity : ComponentActivity() {

  private lateinit var webView: WebView
  private lateinit var guideView: LinearLayout
  /** 目录选择桥鉴权 token（进程级共享：MainActivity 重建/看门狗重启不更换，
   *  与引擎 env 的 DSH_PICK_TOKEN 始终一致；C1 修复）。 */
  private val pickToken: String = EngineManager.ensurePickToken()
  private lateinit var engineStatus: TextView
  private lateinit var progressText: TextView
  /** 启动/测试双态界面（v0.11.0）：解压进度条、崩溃横幅、engine.log 摘要。 */
  private lateinit var progressBar: ProgressBar
  private lateinit var crashBanner: TextView
  private lateinit var logSummary: TextView
  /** 崩溃标记：记录未捕获异常摘要，下次启动测试界面提示（不吞异常）。 */
  private var crashInfo: String? = null
  /** 重启引擎 in-flight 守卫（防连点双杀双启）。 */
  private val engineRestarting = java.util.concurrent.atomic.AtomicBoolean(false)
  /** 前台引擎监控：3s 轮询探测，down→测试界面、up→恢复 WebUI
   *  （"设置里杀进程/引擎崩溃回退测试界面"的落地；watchdog 负责恢复）。 */
  private val engineMonitorHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private val engineMonitorRunnable = object : Runnable {
    override fun run() {
      Thread {
        val running = try { EngineProbe.check(500).optBoolean("running", false) } catch (_: Exception) { false }
        runOnUiThread {
          if (!::webView.isInitialized || !::guideView.isInitialized) return@runOnUiThread
          if (!running && webView.visibility == View.VISIBLE) {
            engineStatus.text = "引擎未运行，正在自动恢复…"
            showGuide()
          } else if (running && guideView.visibility == View.VISIBLE) {
            showWeb()
          }
        }
        engineMonitorHandler.postDelayed(this, 3000)
      }.start()
    }
  }
  private val engineManager by lazy { EngineManager(this, pickToken) }
  private val engineFlowRunning = java.util.concurrent.atomic.AtomicBoolean(false)
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
    const val ACTION_UPDATE = "com.dshmobile.shell.action.UPDATE"

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

  private val notificationPermission =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* test channel only */ }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // 崩溃标记：进程级未捕获异常写入 filesDir/.crashed（下次启动测试界面
    // 提示），随后交回默认 handler——只记录，不吞异常、不阻止崩溃。
    installCrashMarker()
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
    val root = FrameLayout(this)
    webView = WebView(this).apply { id = View.generateViewId() }
    root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    guideView = buildGuideView()
    root.addView(guideView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    setContentView(root)
    configureWebView()
    // Testable update trigger: adb am start -n .../.MainActivity -a com.dshmobile.shell.action.UPDATE
    if (intent?.action == ACTION_UPDATE) {
      runUpdate()
    } else {
      startEngineFlow()
    }
  }

  override fun onResume() {
    super.onResume()
    // 前台引擎监控：引擎被杀/崩溃时自动回退测试界面，恢复后回 WebUI。
    engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
    engineMonitorHandler.post(engineMonitorRunnable)
    // Back from the directory picker / Termux: re-route if the engine came up.
    if (!EngineProbe.check().optBoolean("running", false)) startEngineFlow()
    // 主题补推：从系统设置/SAF 返回时系统主题可能已变（兜底桥时序覆盖）。
    if (::webView.isInitialized) pushSystemDark(webView)
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

  override fun onDestroy() {
    super.onDestroy()
    engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
    pickTtlHandler.removeCallbacks(pickTtlRunnable)
    if (::webView.isInitialized) {
      themeRetryRunnable?.let { webView.removeCallbacks(it) }
      webView.destroy()
    }
    engineManager.stopEngine()
  }

  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    pushSystemDark(webView)
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
        // 文件上传走系统文件选择器（OpenDocument，可多选）；directoryPicker
        // 是目录选择（工作区用），两者必须分离。
        this@MainActivity.filePathCallback?.onReceiveValue(null)
        this@MainActivity.filePathCallback = filePathCallback
        filePicker.launch(emptyArray())
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
        onNotify = { title, text -> showTestNotification(title, text) },
        onAllFilesAccessRequest = { openAllFilesAccessSettings() },
        onDebugLogsRequest = { downloadDebugLogs() },
        onGetSystemDark = {
          (resources.configuration.uiMode and
            android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES
        },
        pickToken = pickToken,
        onRestartEngine = { restartEngine() },
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

  private fun downloadDebugLogs() {
    if (!debugLogging.compareAndSet(false, true)) return
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

  private fun keepScreenOn(enable: Boolean) {
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    val wakeLock = power.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ON_AFTER_RELEASE, "dsh:screen")
    if (enable && !wakeLock.isHeld) wakeLock.acquire()
    if (!enable && wakeLock.isHeld) wakeLock.release()
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
    val density = resources.displayMetrics.density
    val pad = (24 * density).toInt()
    val guide = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(pad, pad, pad, pad)
      gravity = android.view.Gravity.CENTER
      visibility = View.GONE
    }
    // logo + 标题：启动/测试双态界面的固定头部。
    val icon = ImageView(this).apply {
      setImageResource(R.mipmap.ic_launcher)
      layoutParams = LinearLayout.LayoutParams((64 * density).toInt(), (64 * density).toInt())
    }
    val title = TextView(this).apply {
      text = "DeepSeek Harness"
      textSize = 20f
      setPadding(0, (12 * density).toInt(), 0, (4 * density).toInt())
      gravity = android.view.Gravity.CENTER
    }
    // 上次异常退出横幅（崩溃标记存在时显示）。
    crashBanner = TextView(this).apply {
      textSize = 12f
      setTextColor(0xFFF85149.toInt())
      setPadding(0, (6 * density).toInt(), 0, (10 * density).toInt())
      gravity = android.view.Gravity.CENTER
      visibility = View.GONE
    }
    engineStatus = TextView(this).apply { textSize = 16f; setPadding(0, 0, 0, pad); gravity = android.view.Gravity.CENTER }
    // 解压/更新进度条（仅快照刷新时可见）。
    progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
      visibility = View.GONE
      layoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, (6 * density).toInt(),
      )
    }
    progressText = TextView(this).apply {
      textSize = 13f
      setPadding(0, (8 * density).toInt(), 0, pad)
      gravity = android.view.Gravity.CENTER
      visibility = View.GONE
    }
    // 失败诊断：engine.log 尾部摘要（测试界面排查用）。
    logSummary = TextView(this).apply {
      textSize = 11f
      setPadding(0, 0, 0, pad)
      gravity = android.view.Gravity.CENTER
      visibility = View.GONE
    }
    val openConsole = Button(this).apply {
      text = "打开控制台"
      setOnClickListener { startActivity(Intent(this@MainActivity, ConsoleActivity::class.java)) }
    }
    val retry = Button(this).apply {
      text = "重试"
      setOnClickListener { startEngineFlow() }
    }
    val openTermux = Button(this).apply {
      text = "打开 Termux"
      setOnClickListener { launchTermux() }
    }
    val update = Button(this).apply {
      text = "检查运行时更新"
      setOnClickListener {
        UpdateManager(this@MainActivity).checkAndApply { status ->
          runOnUiThread { engineStatus.text = status }
        }
      }
    }
    fun buttonRow(vararg buttons: Button): LinearLayout {
      val row = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = android.view.Gravity.CENTER
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        lp.setMargins(0, 0, 0, (10 * density).toInt())
        layoutParams = lp
      }
      for (b in buttons) {
        val blp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        blp.setMargins((6 * density).toInt(), 0, (6 * density).toInt(), 0)
        row.addView(b, blp)
      }
      return row
    }
    guide.addView(icon)
    guide.addView(title)
    guide.addView(crashBanner)
    guide.addView(engineStatus)
    guide.addView(progressBar)
    guide.addView(progressText)
    guide.addView(logSummary)
    guide.addView(buttonRow(openConsole, retry))
    guide.addView(buttonRow(openTermux, update))
    return guide
  }

  private fun launchTermux() {
    val intent = packageManager.getLaunchIntentForPackage("com.termux")
    if (intent != null) startActivity(intent)
  }

  /**
   * Engine-first flow: use an already-running engine (Termux or prior
   * embedded), else extract the embedded snapshot and start the embedded
   * engine, then poll until the web service answers.
   */
  private fun startEngineFlow() {
    // onCreate 与随后的 onResume 都会触发本流程；in-flight 守卫防止
    // 双线程竞态解压/启动（设备实证：双启动导致引擎进程死亡）。
    if (!engineFlowRunning.compareAndSet(false, true)) return
    Thread {
      try {
      if (EngineProbe.check().optBoolean("running", false)) {
        runOnUiThread { showWeb() }
        return@Thread
      }
      // 启动即有反馈：进入测试界面显示"正在启动引擎…"（不再白屏等 probe）。
      runOnUiThread {
        progressBar.visibility = View.GONE
        progressText.visibility = View.GONE
        engineStatus.text = "正在启动引擎…"
        showGuide()
      }
      if (!engineManager.snapshotFresh()) {
        runOnUiThread {
          progressBar.visibility = View.VISIBLE
          progressText.visibility = View.VISIBLE
          engineStatus.text = "正在更新运行时（约 70MB）…"
        }
        val ok = engineManager.refreshSnapshot { done, total ->
          runOnUiThread {
            // done 是解压后字节数，total 是压缩包字节数，口径不一致；只显示已解压量。
            engineStatus.text = "正在更新运行时… " + done / 1024 / 1024 + " MB"
          }
        }
        if (!ok) {
          runOnUiThread {
            engineStatus.text = "运行时更新失败，请重试。"
            showGuide()
          }
          return@Thread
        }
        runOnUiThread {
          progressBar.visibility = View.GONE
          progressText.visibility = View.GONE
          engineStatus.text = "正在启动引擎…"
        }
      }
      if (!engineManager.startEngine()) {
        runOnUiThread {
          engineStatus.text = "引擎启动失败，请重试。"
          showGuide()
        }
        return@Thread
      }
      // Poll up to 30s for the web service.
      for (i in 0..30) {
        if (EngineProbe.check().optBoolean("running", false)) {
          startEngineService()
          applyShizukuKeepAlive()
          runOnUiThread { showWeb() }
          return@Thread
        }
        Thread.sleep(1000)
      }
      runOnUiThread {
        engineStatus.text = "引擎启动超时，请重试。"
        showGuide()
      }
      } finally {
        engineFlowRunning.set(false)
      }
    }.start()
  }

  /** Run the runtime snapshot update; status mirrored to a file for adb verification. */
  private fun runUpdate() {
    val statusFile = java.io.File(filesDir, "update-status.txt")
    val manager = UpdateManager(this)
    manager.checkAndApply { status ->
      runOnUiThread {
        engineStatus.text = status
        progressText.visibility = View.VISIBLE
        guideView.visibility = View.VISIBLE
        webView.visibility = View.GONE
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
    webView.visibility = View.GONE
    guideView.visibility = View.VISIBLE
    val crash = crashInfo
    if (crash != null) {
      crashBanner.visibility = View.VISIBLE
      crashBanner.text = "上次异常退出：$crash"
    }
    val tail = tailEngineLog(8)
    if (tail.isNotEmpty()) {
      logSummary.visibility = View.VISIBLE
      logSummary.text = "engine.log 末尾：\n$tail"
    } else {
      logSummary.visibility = View.GONE
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