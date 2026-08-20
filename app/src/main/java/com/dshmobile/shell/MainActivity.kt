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
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
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
  /** Directory-picker bridge auth token (process-level shared: unchanged across MainActivity rebuilds
   *  and watchdog restarts, always matching the engine env DSH_PICK_TOKEN; C1 fix). */
  private val pickToken: String = EngineManager.ensurePickToken()
  private lateinit var engineStatus: TextView
  private lateinit var progressText: TextView
  /** Startup/test dual-state UI (v0.11.0): extraction progress bar, crash banner, engine.log summary. */
  private lateinit var progressBar: ProgressBar
  private lateinit var crashBanner: TextView
  private lateinit var logSummary: TextView
  /** Startup/test screen three-section structure blocks: staggered reveal animation fades each block in. */
  private lateinit var brandBlock: View
  private lateinit var cardBlock: View
  private lateinit var actionBlock: View
  /** Crash marker: records an uncaught-exception summary shown on the next startup's test screen (exceptions are never swallowed). */
  private var crashInfo: String? = null
  /** Engine-restart in-flight guard (prevents double-kill/double-start from rapid taps). */
  private val engineRestarting = java.util.concurrent.atomic.AtomicBoolean(false)
  /** After the user explicitly shuts down, the foreground monitor and any pending startup thread must not re-show the WebUI. */
  @Volatile
  private var userClosedEngine = false
  /** Foreground engine monitor: 3s polling probe — down → test screen, up → WebUI restored
   *  (implements "kill the process in Settings / engine crash falls back to the test screen"; the watchdog restores the engine). */
  private val engineMonitorHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private val engineMonitorRunnable = object : Runnable {
    override fun run() {
      val monitor = this
      Thread {
        val running = try { EngineProbe.check(500).optBoolean("running", false) } catch (_: Exception) { false }
        runOnUiThread {
          if (::webView.isInitialized && ::guideView.isInitialized && !userClosedEngine) {
            if (!running && webView.visibility == View.VISIBLE) {
              engineStatus.text = "引擎未运行，正在自动恢复…"
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
  // —— WebView renderer-freeze watchdog (2026-08-18, issue #36: Honor MagicUI 6.1 / Android 12
  // still stuck on "Loading plugins…" with no diagnostics layer = the renderer's JS main thread froze,
  // so in-page watchdog timers can't run either). evaluateJavascript runs in the renderer while the app
  // main thread is unaffected: the main thread pings a JS heartbeat; when the callback stops returning,
  // the renderer is judged dead → Toast + one auto-reload + log. ——
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
  /** M3: last pick was suspended for a missing permission (basis for onResume resume/settle). */
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
        // User cancelled: return null so the engine-side pick() settles as cancelled (otherwise the
        // page polling keeps pulling the same request and re-opens the picker repeatedly — device-observed picker stacking).
        webView.evaluateJavascript(
          "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callback) + ", null)", null,
        )
      }
    }
  }

  /** H2: shell-side pick slot TTL (aligned with the engine-side 5-minute TTL) — when the SAF result
   *  never comes back (stuck on a system settings page / process killed and restored / missing-permission
   *  path), the slot is cleared automatically and settled as cancelled, so later directory picks are
   *  never blocked by a permanently occupied single slot. */
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

    /** Export file size cap (prevents OOM from malicious/abnormally large files). */
    const val MAX_DOWNLOAD_BYTES = 200L * 1024 * 1024

    /** Session-log export endpoint path (recognized by the dual interception inside the WebView). */
    const val SESSION_EXPORT_PATH = "/api/session.export"
  }

  // File upload (<input type=file> → WebView onShowFileChooser → system file picker).
  // Distinct from directory picking (directoryPicker, for the workspace); multi-select, any type.
  private val filePicker =
    registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
      val callback = filePathCallback
      filePathCallback = null
      if (callback != null) {
        callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
      }
    }

  // Image picking: ACTION_PICK opens the system gallery (tap-to-select), unlike the ACTION_GET_CONTENT
  // file manager. For image accept types the gallery is mandatory, otherwise the system opens the
  // "Recent/Large files" document UI where long-press is required to select.
  private val imagePicker =
    registerForActivityResult(PickImageContract()) { uri ->
      val callback = filePathCallback
      filePathCallback = null
      if (callback != null) {
        callback.onReceiveValue(if (uri == null) null else arrayOf(uri))
      }
    }

  private val notificationPermission =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* notification permission (exports/engine status channel) */ }

  /** Bridge image picking: native read → base64 data URL → window.__dshBridge.onImagePicked.
   *  Huawei WebViews (Chromium 114) don't fire input change when onShowFileChooser receives a
   *  content:// Uri, so the native layer reads the bytes and hands them to JS directly, bypassing
   *  the WebView file picker entirely. */
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

  /** Persisted font-size read (Settings → General slider; default 100). */
  private fun textZoomPrefs(): Int {
    return try {
      getSharedPreferences("dsh_settings", MODE_PRIVATE).getInt("text_zoom", 100)
    } catch (_: Exception) {
      100
    }
  }

  /** Font-size setting (WebView textZoom) + persistence; survives restarts and cache refreshes. */
  private fun setTextZoomPersisted(percent: Int) {
    val p = percent.coerceIn(50, 200)
    // The JS bridge runs on the JavaBridge thread; WebView calls must hop back to the main thread.
    runOnUiThread { webView.settings.textZoom = p }
    try {
      getSharedPreferences("dsh_settings", MODE_PRIVATE).edit().putInt("text_zoom", p).apply()
      Log.i("dsh-image", "textZoom set: " + p)
    } catch (e: Exception) {
      Log.e("dsh-image", "textZoom persist failed: " + e.message)
    }
  }

  /**
   * Native clipboard write (the WebView Clipboard API is rejected on Android with
   * NotAllowedError: Write permission denied, so the page falls back to this bridge).
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

  /** Read the display name from a content Uri (MediaStore DISPLAY_NAME). */
  private fun queryImageName(uri: Uri): String? {
    return try {
      contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
        ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    } catch (_: Exception) {
      null
    }
  }

  /** ACTION_PICK image-picking contract: opens the system gallery; one tap returns a single image Uri. */
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
    // Crash marker: process-level uncaught exceptions write filesDir/.crashed (surfaced on the next
    // startup's test screen), then the default handler takes over — record only, never swallow or block.
    installCrashMarker()
    val crashFile = File(filesDir, ".crashed")
    if (crashFile.exists()) {
      crashInfo = try { crashFile.readText() } catch (_: Exception) { null }
      crashFile.delete()
    }
    // Dev log toggle was on last session: resume collection at process start.
    if (DevLogPrefs.isEnabled(this)) {
      LogCollector.start(this)
      LogCollector.log("dsh-shell", "app onCreate (dev log on)")
    }
    // Immersive: content extends into the system-bar area (status bar normally hidden, edge-swipe temporarily reveals it).
    WindowCompat.setDecorFitsSystemWindows(window, false)
    applyImmersive(immersivePrefs())
    val root = FrameLayout(this)
    webView = WebView(this).apply { id = View.generateViewId() }
    root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    guideView = buildGuideView()
    root.addView(guideView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    setContentView(root)
    ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
      val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom
      val mandatoryGestures = insets.getInsets(WindowInsetsCompat.Type.mandatorySystemGestures()).bottom
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val density = resources.displayMetrics.density
      webSystemBottomInset = pxToCssPx(maxOf(systemBars, mandatoryGestures), density)
      webImeBottomInset = pxToCssPx(ime, density)
      scheduleWebInsetsPush()
      insets
    }
    ViewCompat.requestApplyInsets(root)
    configureWebView()
    // Testable update trigger: adb am start -n .../.MainActivity -a com.dsharnessmobile.shell.action.UPDATE
    if (intent?.action == ACTION_UPDATE) {
      runUpdate()
    } else {
      startEngineFlow()
    }
  }

  override fun onResume() {
    super.onResume()
    // Foreground engine monitor: falls back to the test screen when the engine is killed/crashed, back to the WebUI on recovery.
    if (!userClosedEngine) {
      engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
      engineMonitorHandler.post(engineMonitorRunnable)
    }
    // Back from the directory picker / Termux: re-route if the engine came up.
    // Probe and re-route only while the WebView is hidden (guide page / first start); when returning
    // from the gallery/file picker the WebView is already visible, and a probe timeout would wrongly
    // trigger showWeb→reload, losing JS state.
    if (!userClosedEngine && webView.visibility != View.VISIBLE && !EngineProbe.check().optBoolean("running", false)) startEngineFlow()
    // Theme re-push: the system theme may have changed while returning from Settings/SAF (fallback-bridge timing coverage).
    if (::webView.isInitialized) {
      pushSystemDark(webView)
      pushWebInsets()
    }
    // M3: returning from the system authorization page — when the last pick was suspended for a
    // missing permission, resume SAF automatically if granted, otherwise settle as cancelled (the
    // engine request never hangs until the 5-minute TTL).
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

  /** Re-apply immersive mode when the window regains focus (system-bar flags reset on focus changes). */
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) applyImmersive(immersivePrefs())
  }

  /** Persisted immersive-status-bar read (Settings → General toggle; default hidden). */
  private fun immersivePrefs(): Boolean {
    return try {
      getSharedPreferences("dsh_settings", MODE_PRIVATE).getBoolean("immersive_mode", true)
    } catch (_: Exception) {
      true
    }
  }

  /** Status bar normally hidden (immersive): system bars hidden; edge-swipe shows them transiently, then auto-hides. */
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

  /** Immersive toggle (JS bridge): apply + persist. */
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
    // Fallback release: clear any still-held screen wake lock on Activity destroy.
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
    // WebView remote debugging (debug builds): CDP automation on device/emulator validates UI behavior.
    // AGP 8 doesn't generate BuildConfig by default, so use the debuggable flag instead.
    val debuggable = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
    if (debuggable) android.webkit.WebView.setWebContentsDebuggingEnabled(true)
    webView.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      // Disable HTTP cache: prevents the WebView from serving a stale index/bundle that leaves
      // "stuck loading with no diagnostics" (cached pages carry no page watchdog; Honor/MagicUI-measured issues).
      cacheMode = WebSettings.LOAD_NO_CACHE
      // Font size (Settings → General): restored from local persistence, independent of the page cache.
      textZoom = textZoomPrefs().coerceIn(50, 200)
      // prefers-color-scheme follows the system dark mode (some vendor WebViews don't by default;
      // FORCE_DARK_AUTO makes the media query reflect system light/dark, which dsh's "follow system" theme relies on).
      if (Build.VERSION.SDK_INT >= 29) {
        @Suppress("DEPRECATION")
        forceDark = WebSettings.FORCE_DARK_AUTO
      }
    }
    webView.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        // Session-log export (issue apk#6 + 403 fix): browser navigation carries Origin:null /
        // sec-fetch-site markers and gets rejected by dsh's /api browser-trust fence (403 forbidden,
        // anti DNS-rebinding/cross-site). Route through in-app download instead:
        // HttpURLConnection has no browser markers → the fence permits it (verified on MuMu).
        if (isSessionExport(url, request.method)) {
          downloadToDownloads(url, null)
          return true
        }
        // Only engine-origin pages may stay in the WebView (the privileged bridge + download capability
        // are engine-trusted only); external links go to the system browser, so untrusted pages can't
        // gain bridge powers (social engineering / notification bombing / arbitrary downloads).
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
    // WebView downloads: session-log export (/api/session.export) and other engine-origin downloads
    // all use the in-app path (Documents/dshdata/exports first, MediaStore.Downloads fallback when
    // unauthorized) — browser navigation carries Origin:null and is rejected by dsh's /api
    // browser-trust fence (403); the in-app HttpURLConnection has no browser markers, so the fence
    // permits it (the 403 fix path, see downloadToDownloads).
    webView.setDownloadListener { url, _userAgent, contentDisposition, _mimeType, _contentLength ->
      downloadToDownloads(url, contentDisposition)
    }
    webView.webChromeClient = object : WebChromeClient() {
      override fun onShowFileChooser(
        webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams,
      ): Boolean {
        // File upload uses the system file picker; directoryPicker is for directory selection (workspace) — the two stay separate.
        // accept="image/*" routes to the image picker (GetContent → gallery), otherwise the document picker.
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
        // L6: don't silently widen the social-engineering surface — truncate and log overlong messages;
        // page confirmation still auto-approves (mobile WebView has no native alert UI; a blocking
        // confirm would hang the page).
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
      ),
      "androidBridge",
    )
    webView.loadUrl(EngineProbe.ENGINE_URL)
  }

  /**
   * SAF directory pick (with All Files Access guidance): external workspaces require the bash process
   * to reach the picked real path directly; without the permission, jump to the system grant page and
   * prompt the page to retry.
   */
  private fun pickDirectoryWithPermissionCheck(callbackId: String) {
    // Concurrency guard: reject new requests while one is in flight (a single slot means a second pick
    // would overwrite pendingPickCallback and the previous engine pick would never settle — P2-8).
    if (pendingPickCallback != null) {
      webView.evaluateJavascript(
        "window.__dshBridge?.onDirectoryPicked?.(" + jsString(callbackId) + ", null)", null,
      )
      return
    }
    if (android.os.Build.VERSION.SDK_INT < 30) {
      // Android 10 and below have no All Files Access model: external workspaces unavailable.
      // Return null so the engine-side pick settles as cancelled — no crash, no silent hang.
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
    // M3: the unauthorized path also occupies the slot + sets the pending flag — onResume uses it to
    // auto-resume SAF after the grant returns (or settle as cancelled when still denied); engine requests
    // no longer silently hang until the 5-minute TTL.
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
        // No usable entry at all: silently ignore (the engine side settles as cancelled).
      }
    }
  }

  /**
   * Download an engine-side URL and save it as a session-log ZIP export. Prefers direct writes to
   * Documents/dshdata/exports/ (needs MANAGE_EXTERNAL_STORAGE); falls back to MediaStore.Downloads
   * when unauthorized. Only engine-origin URLs accepted; streamed writes with a size cap.
   * In-app HttpURLConnection requests carry no browser markers (Origin/sec-fetch-site), so they pass
   * dsh's /api browser-trust fence (the fix path for browser-navigation 403s).
   */
  /** Download in-flight guard: dedupes the shouldOverrideUrlLoading + downloadListener dual entry. */
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

  /** Send the export result back to the WebView: the UI plugin shows an in-app result dialog via window.__dshExportResult. */
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
   * Save the export stream. With MANAGE_EXTERNAL_STORAGE, write directly to
   * Documents/dshdata/exports/<sanitized filename>.zip (same-name gets " (1)", write .tmp then rename);
   * otherwise fall back to MediaStore.Downloads. Returns the actual path for display.
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

  /** Same-name conflicts get a " (1)" suffix so existing exports are never overwritten. */
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

  /** Write to MediaStore.Downloads (no permission on Android 10+), streamed with a 200MB cap. */
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

  /** Filename sanitization: strip path separators/control chars, cap the length. */
  private fun sanitizeFilename(name: String): String {
    val cleaned = name.replace(Regex("[/\\\u0000-\u001f]"), "_").take(200)
    return if (cleaned.isBlank()) "dsh-session-export.zip" else cleaned
  }

  /** Filename: Content-Disposition first, then the URL's sessionId, then a fixed name. */
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

  /** Debug log export (2026-08-16): engine logs + environment info zipped.
   *  Entry: plus-menu "Export debug logs" → androidBridge.downloadDebugLogs().
   *  Prefers Documents/dshdata/exports/ (with MANAGE_EXTERNAL_STORAGE), falls back to
   *  MediaStore.Downloads; the result reuses the export dialog (same as session downloads). */
  private val debugLogging = java.util.concurrent.atomic.AtomicBoolean(false)

  private fun downloadDebugLogs() {
    if (!debugLogging.compareAndSet(false, true)) return
    Thread {
      try {
        val ts = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US)
          .format(java.util.Date())
        val filename = "dsh-debug-logs-$ts.zip"
        // Write to the private cache first, then to the final destination on success (cross-mount only allows copies).
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

  /** Environment info bundled with the debug logs (no secrets; version/device/layout/plugin summary). */
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

  /** M7: delayed theme re-push Runnable reference (cancelled in onDestroy). */
  private var themeRetryRunnable: Runnable? = null

  /** System dark-state push: some vendor WebViews' prefers-color-scheme does not follow uiMode
   *  (measured on vivo/Android 16), so the UI plugin consumes this bridge value via a matchMedia
   *  hook (window.__dshThemeBridge.setDark) to drive the upstream system theme.
   *  Push-timing hardening (2026-08-16): the fallback bridge (ThemeBridge inside the ui-responsive
   *  client bundle) may install later than onPageFinished — a single push silently misses
   *  (`window.__dshThemeBridge &&` short-circuits) and the theme never follows. Re-push after an
   *  800ms delay to cover that timing; onResume also re-pushes (covers theme changes after returning
   *  from Settings/SAF). The Runnable body try/catches and onDestroy removes the callback (M7:
   *  a late evaluateJavascript after destroy must not throw on the main thread). */
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
          // Page/WebView already destroyed: a failed re-push is harmless.
        }
      }
      themeRetryRunnable = runnable
      view.postDelayed(runnable, 800)
    } catch (_: Exception) {
      // Page not ready: onPageFinished will push again.
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
      // Page/WebView not ready yet: onPageFinished re-pushes the cached values.
    }
  }

  /** Convert physical Android pixels to whole CSS pixels without under-padding. */
  private fun pxToCssPx(physicalPx: Int, density: Float): Int {
    if (physicalPx <= 0 || density <= 0f) return 0
    return ceil(physicalPx.toDouble() / density.toDouble()).toInt()
  }

  /**
   * Engine-origin check: exact scheme/host/port match against the local engine (prevents prefix
   * spoofing — e.g. 127.0.0.1:30800 or 127.0.0.1:3080.evil.com must not count as the engine source).
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

  /** Hit check: engine source + session-export path + GET (HEAD is a frontend preflight and must not trigger a redirect). */
  private fun isSessionExport(url: String, method: String): Boolean {
    return method == "GET" && isEngineSource(url) && url.contains(SESSION_EXPORT_PATH)
  }

  /**
   * Atomic, replay-guarded external-browser open (non-export external links). Best-effort: failures
   * are silent (callers ignore the return value); there is no MediaStore fallback contract here — the
   * fallback lives only on the export path (inside downloadToDownloads).
   */
  private val exportLaunching = java.util.concurrent.atomic.AtomicBoolean(false)

  private fun openInExternalBrowser(uri: android.net.Uri): Boolean {
    if (!exportLaunching.compareAndSet(false, true)) return true // already in flight: swallow duplicate triggers
    return try {
      startActivity(Intent(Intent.ACTION_VIEW, uri))
      true
    } catch (_: Exception) {
      // No browser can handle it: fall back to the MediaStore download path
      false
    } finally {
      exportLaunching.set(false)
    }
  }

  /** Screen-on WakeLock (JS bridge keepScreenOn). Held by a singleton field with paired
   *  acquire/release: the old implementation called newWakeLock per invocation, so a fresh instance
   *  always had isHeld=false and the release path never fired (confirmed lock leak, Review 2026-08-18). */
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
    val ctx = this
    val dens = resources.displayMetrics.density
    fun dp(v: Float) = (v * dens).toInt()
    fun sp(v: Float) = v * resources.displayMetrics.scaledDensity
    fun dim(id: Int) = resources.getDimension(id)
    fun dpix(id: Int) = resources.getDimensionPixelSize(id)

    // Ambient background: warm-gray / near-black base + subtle teal top glow (restrained, not flat) .
    val bgGradient = android.graphics.drawable.GradientDrawable(
      android.graphics.drawable.GradientDrawable.Orientation.TL_BR,
      intArrayOf(getColor(R.color.ds_glow), getColor(R.color.ds_bg), getColor(R.color.ds_bg)),
    )

    val guide = LinearLayout(ctx).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(24f), dp(24f), dp(24f), dp(24f))
      gravity = android.view.Gravity.CENTER
      background = bgGradient
      visibility = View.GONE
    }
    // —— 1. Brand area: squircle icon container + wordmark, restrained whitespace ——
    val iconShell = FrameLayout(ctx).apply {
      val lp = LinearLayout.LayoutParams(dpix(R.dimen.ds_logo_size) + dp(8f), dpix(R.dimen.ds_logo_size) + dp(8f))
      layoutParams = lp
      background = android.graphics.drawable.GradientDrawable().apply {
        setColor(getColor(R.color.ds_accent_soft))
        cornerRadius = dim(R.dimen.ds_radius_icon)
        setStroke(dp(1f), getColor(R.color.ds_accent))
      }
    }
    val icon = ImageView(ctx).apply {
      setImageResource(R.mipmap.ic_launcher)
      val lp = FrameLayout.LayoutParams(dpix(R.dimen.ds_logo_size), dpix(R.dimen.ds_logo_size), android.view.Gravity.CENTER)
      layoutParams = lp
    }
    iconShell.addView(icon)
    val title = TextView(ctx).apply {
      text = "DeepCode"
      textSize = sp(22f)
      setTextColor(getColor(R.color.ds_text_primary))
      typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
      gravity = android.view.Gravity.CENTER
      setPadding(0, dp(12f), 0, 0)
    }
    brandBlock = LinearLayout(ctx).apply {
      orientation = LinearLayout.VERTICAL
      gravity = android.view.Gravity.CENTER
      val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      lp.setMargins(0, 0, 0, dp(48f))
      layoutParams = lp
    }.also { it.addView(iconShell); it.addView(title) }
    guide.addView(brandBlock)

    // —— 2. Status card: Double-Bezel (outer shell + inner core, concentric corner radii) ——
    val shell = LinearLayout(ctx).apply {
      orientation = LinearLayout.VERTICAL
      val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      lp.setMargins(0, 0, 0, dp(32f))
      layoutParams = lp
      setPadding(dp(1.5f), dp(1.5f), dp(1.5f), dp(1.5f))
      background = android.graphics.drawable.GradientDrawable().apply {
        setColor(getColor(R.color.ds_shell))
        cornerRadius = dim(R.dimen.ds_radius_shell)
        setStroke(dp(1f), getColor(R.color.ds_border))
      }
    }
    val card = LinearLayout(ctx).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dpix(R.dimen.ds_space_24), dp(28f), dpix(R.dimen.ds_space_24), dp(28f))
      background = android.graphics.drawable.GradientDrawable().apply {
        setColor(getColor(R.color.ds_surface))
        cornerRadius = dim(R.dimen.ds_radius_card)
        setStroke(dp(1f), getColor(R.color.ds_border))
      }
    }

    engineStatus = TextView(ctx).apply {
      textSize = sp(17f)
      setTextColor(getColor(R.color.ds_text_primary))
      typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
      gravity = android.view.Gravity.CENTER
      setLineSpacing(0f, 1.15f)
    }

    crashBanner = TextView(ctx).apply {
      textSize = sp(12f)
      setTextColor(getColor(R.color.ds_danger))
      typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
      gravity = android.view.Gravity.CENTER
      visibility = View.GONE
      val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      lp.setMargins(0, dp(16f), 0, 0)
      lp.gravity = android.view.Gravity.CENTER_HORIZONTAL
      layoutParams = lp
      background = android.graphics.drawable.GradientDrawable().apply {
        setColor(getColor(R.color.ds_danger_soft))
        cornerRadius = dim(R.dimen.ds_radius_pill)
      }
      setPadding(dp(14f), dp(6f), dp(14f), dp(6f))
    }
    progressBar = ProgressBar(ctx, null, android.R.attr.progressBarStyleHorizontal).apply {
      visibility = View.GONE
      progressDrawable = android.graphics.drawable.ClipDrawable(
        android.graphics.drawable.GradientDrawable().apply {
          setColor(getColor(R.color.ds_accent))
          cornerRadius = dim(R.dimen.ds_radius_pill)
        },
        android.view.Gravity.START, android.graphics.drawable.ClipDrawable.HORIZONTAL,
      )
      progressBackgroundTintList = android.content.res.ColorStateList.valueOf(getColor(R.color.ds_progress_track))
      val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpix(R.dimen.ds_progress_height))
      lp.setMargins(dp(8f), dp(24f), dp(8f), 0)
      layoutParams = lp
    }

    progressText = TextView(ctx).apply {
      textSize = sp(13f)
      setTextColor(getColor(R.color.ds_text_secondary))
      setPadding(0, dp(10f), 0, 0)
      gravity = android.view.Gravity.CENTER
      visibility = View.GONE
    }

    logSummary = TextView(ctx).apply {
      textSize = sp(11f)
      setTextColor(getColor(R.color.ds_text_tertiary))
      setPadding(0, dp(16f), 0, 0)
      gravity = android.view.Gravity.CENTER
      typeface = android.graphics.Typeface.MONOSPACE
      visibility = View.GONE
    }

    card.addView(engineStatus)
    card.addView(crashBanner)
    card.addView(progressBar)
    card.addView(progressText)
    card.addView(logSummary)
    shell.addView(card)
    cardBlock = shell
    guide.addView(cardBlock)

    // —— 3. Action area: pill primary CTA + text-style secondary actions ——
    fun pressedColor(base: Int): android.content.res.ColorStateList =
      android.content.res.ColorStateList(arrayOf(intArrayOf(android.R.attr.state_pressed), intArrayOf()), intArrayOf(getColor(R.color.ds_accent_pressed), base))
    fun rippleOverlay(base: Int): android.graphics.drawable.RippleDrawable =
      android.graphics.drawable.RippleDrawable(
        pressedColor(base),
        android.graphics.drawable.GradientDrawable().apply {
          setColor(base)
          cornerRadius = dim(R.dimen.ds_radius_pill)
        },
        android.graphics.drawable.GradientDrawable().apply {
          setColor(getColor(R.color.ds_accent))
          cornerRadius = dim(R.dimen.ds_radius_pill)
        },
      )

    val retry = Button(ctx).apply {
      text = "启动引擎"
      isAllCaps = false
      textSize = sp(14f)
      setTextColor(getColor(R.color.ds_text_on_accent))
      typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
      background = rippleOverlay(getColor(R.color.ds_accent))
      stateListAnimator = null
      val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dpix(R.dimen.ds_btn_height))
      lp.setMargins(dp(8f), 0, dp(8f), 0)
      layoutParams = lp
      setOnClickListener {
        animate().scaleX(0.97f).scaleY(0.97f).setDuration(90).withEndAction {
          animate().scaleX(1f).scaleY(1f).setDuration(150).start()
          startEngineFlow()
        }.start()
      }
    }
    val openConsole = Button(ctx).apply {
      text = "打开控制台"
      isAllCaps = false
      textSize = sp(14f)
      setTextColor(getColor(R.color.ds_accent))
      typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
      background = rippleOverlay(android.graphics.Color.TRANSPARENT)
      stateListAnimator = null
      setPadding(dp(18f), dp(12f), dp(18f), dp(12f))
      setOnClickListener { startActivity(Intent(this@MainActivity, ConsoleActivity::class.java)) }
    }
    val update = Button(ctx).apply {
      text = "检查更新"
      isAllCaps = false
      textSize = sp(14f)
      setTextColor(getColor(R.color.ds_accent))
      typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
      background = rippleOverlay(android.graphics.Color.TRANSPARENT)
      stateListAnimator = null
      setPadding(dp(18f), dp(12f), dp(18f), dp(12f))
      setOnClickListener {
        UpdateManager(this@MainActivity).checkAndApply { status ->
          runOnUiThread { engineStatus.text = status }
        }
      }
    }
    actionBlock = LinearLayout(ctx).apply {
      orientation = LinearLayout.VERTICAL
      gravity = android.view.Gravity.CENTER
      layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }.also {
      it.addView(retry)
      it.addView(LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = android.view.Gravity.CENTER
        setPadding(0, dp(4f), 0, 0)
        addView(openConsole)
        addView(update)
      })
    }
    guide.addView(actionBlock)
    return guide
  }

  /** Startup/test screen reveal: brand / status card / actions fade in and rise sequentially, gentle pacing. */
  private fun animateGuideReveal() {
    val interp = android.view.animation.PathInterpolator(0.32f, 0.72f, 0f, 1f)
    val rise = (14 * resources.displayMetrics.density).toInt().toFloat()
    val items = listOf(brandBlock, cardBlock, actionBlock)
    items.forEachIndexed { i, v ->
      v.alpha = 0f
      v.translationY = rise
      v.animate()
        .alpha(1f).translationY(0f)
        .setStartDelay(i * 90L).setDuration(420L)
        .setInterpolator(interp).start()
    }
  }

  /** Dev-options "Shut down": stop the engine and fall back to the init (startup/test) screen, without auto-restart. */
  private fun shutdownToGuide() {
    userClosedEngine = true
    engineFlowGeneration.incrementAndGet()
    EngineService.userShutdown = true
    engineMonitorHandler.removeCallbacks(engineMonitorRunnable)
    freezeHandler.removeCallbacks(freezeRunnable)
    runOnUiThread {
      hideSoftInput()
      progressBar.visibility = View.GONE
      progressText.visibility = View.GONE
      engineStatus.text = "引擎已关闭。点击“重试”可重新启动。"
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
      // Immediate feedback on start: the test screen shows "Starting engine…" (no more white screen while probing).
      runOnUiThread {
        if (!isCurrentEngineFlow(generation)) return@runOnUiThread
        progressBar.visibility = View.GONE
        progressText.visibility = View.GONE
        engineStatus.text = "正在启动引擎…"
        showGuide()
      }
      if (!engineManager.snapshotFresh()) {
        if (!isCurrentEngineFlow(generation)) return@Thread
        runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          progressBar.visibility = View.VISIBLE
          progressText.visibility = View.VISIBLE
          engineStatus.text = "正在更新运行时（约 70MB）…"
        }
        val ok = engineManager.refreshSnapshot { done, total ->
          runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            // done is extracted bytes, total is the compressed archive bytes — different scales; show only the extracted amount.
            engineStatus.text = "正在更新运行时… " + done / 1024 / 1024 + " MB"
          }
        }
        if (!ok) {
          runOnUiThread {
            if (!isCurrentEngineFlow(generation)) return@runOnUiThread
            engineStatus.text = "运行时更新失败，请重试。"
            showGuide()
          }
          return@Thread
        }
        runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          progressBar.visibility = View.GONE
          progressText.visibility = View.GONE
          engineStatus.text = "正在启动引擎…"
        }
      }
      if (!isCurrentEngineFlow(generation)) return@Thread
      if (!engineManager.startEngine()) {
        runOnUiThread {
          if (!isCurrentEngineFlow(generation)) return@runOnUiThread
          engineStatus.text = "引擎启动失败，请重试。"
          showGuide()
        }
        return@Thread
      }
      // Poll up to 30s for the web service.
      for (i in 0..30) {
        if (!isCurrentEngineFlow(generation)) return@Thread
        if (EngineProbe.check().optBoolean("running", false)) {
          startEngineService()
          applyShizukuKeepAlive()
          runOnUiThread { if (isCurrentEngineFlow(generation)) showWeb() }
          return@Thread
        }
        Thread.sleep(1000)
      }
      if (isCurrentEngineFlow(generation)) runOnUiThread {
          engineStatus.text = "引擎启动超时，请重试。"
          showGuide()
        }
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
        engineStatus.text = status
        progressText.visibility = View.VISIBLE
        guideView.visibility = View.VISIBLE
        animateGuideReveal()
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

  /** Enter the test screen (fallback on engine failure/not-ready): status + crash banner + engine.log summary. */
  private fun showGuide() {
    webView.visibility = View.GONE
    guideView.visibility = View.VISIBLE
    animateGuideReveal()
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

  /** Hide Android's soft keyboard before replacing the WebView with the guide. */
  private fun hideSoftInput() {
    try {
      WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.ime())
    } catch (_: Exception) {
      // The input connection may already be gone while a WebView bridge call is settling.
    }
  }

  /** engine.log tail summary (test-screen diagnostics; empty when missing/unreadable). */
  private fun tailEngineLog(lines: Int): String {
    val f = File(filesDir, "engine.log")
    if (!f.exists()) return ""
    return try {
      f.readLines().takeLast(lines).joinToString("\n")
    } catch (_: Exception) {
      ""
    }
  }

  /** Process-level crash marker: record the uncaught-exception summary, then hand back to the default handler (never swallow). */
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
   * Restart the engine service process (Settings → "Restart engine"): pkill the engine → reset the
   * cooldown and flow guard → re-run the start flow after 1s (the EngineService watchdog also brings
   * it up; process-level CAS + cooldown keep the dual paths idempotent). Anti-mashing: in-flight guard.
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

  /** Dev log toggle persistence (private SharedPreferences; default off). */
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
