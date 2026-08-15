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
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationCompat
import java.net.HttpURLConnection
import java.net.URL

/** Shell activity: WebView over the local dsh engine + engine guide fallback. */
class MainActivity : ComponentActivity() {

  private lateinit var webView: WebView
  private lateinit var guideView: LinearLayout
  /** 目录选择桥鉴权 token（每次进程启动随机；引擎 env + JS 桥同源持有）。 */
  private val pickToken: String = java.util.UUID.randomUUID().toString()
  private lateinit var engineStatus: TextView
  private lateinit var progressText: TextView
  private val engineManager by lazy { EngineManager(this, pickToken) }
  private val engineFlowRunning = java.util.concurrent.atomic.AtomicBoolean(false)
  private var pendingPickCallback: String? = null
  private var filePathCallback: ValueCallback<Array<Uri>>? = null

  private val directoryPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
    val callback = pendingPickCallback
    pendingPickCallback = null
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

  companion object {
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
    // Back from the directory picker / Termux: re-route if the engine came up.
    if (!EngineProbe.check().optBoolean("running", false)) startEngineFlow()
  }

  override fun onDestroy() {
    super.onDestroy()
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
    // 统一走 app 内 MediaStore 下载——浏览器导航带 Origin:null 会被 dsh
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
        pickToken = pickToken,
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
      directoryPicker.launch(null)
      return
    }
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
   * 下载引擎侧 URL 到系统下载目录（会话日志 ZIP 导出）。API 29+ 走
   * MediaStore.Downloads（免权限）；更老系统不支持（实际设备均为新版本）。
   * 仅接受引擎同源 URL（防本机 SSRF/恶意文件投放）；流式写入并设大小上限。
   * app 内 HttpURLConnection 请求无浏览器标记（Origin/sec-fetch-site），
   * 通过 dsh 的 /api browser-trust fence（浏览器导航 403 的修复路径）。
   */
  /** 下载 in-flight 守卫：shouldOverrideUrlLoading 与 downloadListener 双入口去重。 */
  private val exportDownloading = java.util.concurrent.atomic.AtomicBoolean(false)

  private fun downloadToDownloads(url: String, contentDisposition: String?) {
    if (!isEngineSource(url)) {
      showTestNotification("下载被拒绝", "仅支持从本机引擎导出文件")
      return
    }
    if (!exportDownloading.compareAndSet(false, true)) return
    if (Build.VERSION.SDK_INT < 29) {
      showTestNotification("导出失败", "当前系统版本不支持下载，请升级到 Android 10+")
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
          saved = saveToDownloadsStreamed(filename, input)
        }
        val finalName = saved
        runOnUiThread { showTestNotification("会话日志已导出", "已保存到 下载/$finalName") }
      } catch (t: Throwable) {
        runOnUiThread { showTestNotification("导出失败", t.message ?: "未知错误") }
      } finally {
        conn?.disconnect()
        exportDownloading.set(false)
      }
    }.start()
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

  /** 系统深色状态推送：某些厂商 WebView 的 prefers-color-scheme 不跟随
   *  uiMode（vivo/Android 16 实测），UI 插件经 matchMedia hook 消费此桥值
   *  （window.__dshThemeBridge.setDark）驱动上游 system 主题。 */
  private fun pushSystemDark(view: android.webkit.WebView) {
    val dark = (resources.configuration.uiMode and
      android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
      android.content.res.Configuration.UI_MODE_NIGHT_YES
    try {
      view.evaluateJavascript(
        "window.__dshThemeBridge && window.__dshThemeBridge.setDark(" + dark + ")", null,
      )
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
    val padding = (24 * resources.displayMetrics.density).toInt()
    val guide = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(padding, padding, padding, padding)
      gravity = android.view.Gravity.CENTER
      visibility = View.GONE
    }
    engineStatus = TextView(this).apply { textSize = 16f; setPadding(0, 0, 0, padding) }
    progressText = TextView(this).apply { textSize = 13f; setPadding(0, 0, 0, padding); visibility = View.GONE }
    val openTermux = Button(this).apply {
      text = "打开 Termux"
      setOnClickListener { launchTermux() }
    }
    val retry = Button(this).apply {
      text = "重试"
      setOnClickListener { startEngineFlow() }
    }
    val update = Button(this).apply {
      text = "检查运行时更新"
      setOnClickListener {
        UpdateManager(this@MainActivity).checkAndApply { status ->
          runOnUiThread { engineStatus.text = status }
        }
      }
    }
    guide.addView(engineStatus)
    guide.addView(progressText)
    guide.addView(openTermux)
    guide.addView(retry)
    guide.addView(update)
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
      if (!engineManager.engineReady) {
        runOnUiThread {
          progressText.visibility = View.VISIBLE
          guideView.visibility = View.VISIBLE
          engineStatus.text = "首次启动：正在解压运行时（约 70MB）…"
        }
        val ok = engineManager.extractSnapshot { done, total ->
          runOnUiThread {
            // done 是解压后字节数，total 是压缩包字节数，口径不一致；只显示已解压量。
            engineStatus.text = "正在解压运行时… " + done / 1024 / 1024 + " MB"
          }
        }
        if (!ok) {
          runOnUiThread {
            engineStatus.text = "运行时解压失败，请重试。"
            showGuide()
          }
          return@Thread
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

  private fun showGuide() {
    webView.visibility = View.GONE
    guideView.visibility = View.VISIBLE
  }
}