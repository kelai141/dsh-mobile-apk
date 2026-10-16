package com.dsharnessmobile.shell

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Built-in console: a WebView loads assets/console.html (terminal-style UI) while
 * ConsoleSession spawns the snapshot bash (env matching the engine) → commands via the stdin pipe,
 * output returned to the UI through the consoleBridge JS interface. Works even when the engine is
 * down (diagnostics scenarios).
 */
class ConsoleActivity : ComponentActivity() {

  private lateinit var webView: WebView
  private val session = ConsoleSession(this)
  private val handler = android.os.Handler(android.os.Looper.getMainLooper())
  private var sessionStarted = false
  private var pageReady = false
  private var pendingTopInset = 0f
  private var pendingBottomInset = 0f
  private var pendingImeInset = 0f

  /** Last status text (re-pushed on onPageFinished; replays status lost before page load). */
  private var lastStatus: String? = null

  /** S1-18：与 lastStatus 配对的状态，页面重放时同样按状态判就绪。 */
  private var lastState: ConsoleSession.State = ConsoleSession.State.STARTING

  private val sessionListener = object : ConsoleSession.Listener {
    override fun onOutput(text: String) {
      handler.post {
        webView.evaluateJavascript("window.__consoleAppend(" + jsString(text) + ")", null)
      }
    }

    override fun onStatus(state: ConsoleSession.State, text: String) {
      lastStatus = text
      lastState = state
      handler.post { pushStatus(state, text) }
    }

    override fun onExit(code: Int) {
      lastStatus = "bash 已退出（code $code）"
      lastState = ConsoleSession.State.EXITED
      handler.post { pushStatus(ConsoleSession.State.EXITED, lastStatus!!) }
    }
  }

  /**
   * Push status (main thread only).
   *
   * S1-18：推的是**状态 + 文案**两个参数，页面按状态判就绪、按文案显示——不再让页面拿文案
   * 做子串正则（措辞一变就静默错判）。
   */
  private fun pushStatus(state: ConsoleSession.State, text: String) {
    webView.evaluateJavascript(
      "window.__consoleState && window.__consoleState(" + jsString(state.wire) + "," + jsString(text) + ")",
      null,
    )
  }

  private fun pushInsets() {
    if (!pageReady || !::webView.isInitialized) return
    webView.evaluateJavascript(
      "window.__consoleInsets && window.__consoleInsets($pendingTopInset,$pendingBottomInset,$pendingImeInset)",
      null,
    )
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    window.statusBarColor = getColor(R.color.ds_bg)
    window.navigationBarColor = getColor(R.color.ds_bg)
    val isNight = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
      android.content.res.Configuration.UI_MODE_NIGHT_YES
    WindowInsetsControllerCompat(window, window.decorView).apply {
      isAppearanceLightStatusBars = !isNight
      isAppearanceLightNavigationBars = !isNight
    }
    webView = WebView(this).apply {
      id = View.generateViewId()
      setBackgroundColor(getColor(R.color.ds_bg))
      layoutParams = ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT,
      )
    }
    // 与引擎页同一份 baseline（版本敏感设置的真源在 WebViewShim）；
    // console.html 走 file:///android_asset，allowFileAccess=false 不影响 assets。
    WebViewShim.applyBaseline(webView.settings)
    // Re-push status after page load: bash may be ready in onStart while console.html's
    // JS bridge is defined later — early evaluateJavascript calls are silently dropped.
    webView.webViewClient = object : android.webkit.WebViewClient() {
      override fun onPageFinished(view: android.webkit.WebView, url: String) {
        super.onPageFinished(view, url)
        pageReady = true
        lastStatus?.let { pushStatus(lastState, it) }
        pushInsets()
      }
    }
    webView.addJavascriptInterface(ConsoleBridge(), "consoleBridge")
    setContentView(webView)
    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val density = resources.displayMetrics.density
      pendingTopInset = bars.top / density
      pendingBottomInset = bars.bottom / density
      pendingImeInset = ime.bottom / density
      pushInsets()
      insets
    }
    webView.loadUrl("file:///android_asset/console.html")
  }

  override fun onStart() {
    super.onStart()
    if (sessionStarted) return
    sessionStarted = session.start(sessionListener)
  }

  override fun onDestroy() {
    session.destroy()
    webView.destroy()
    super.onDestroy()
  }

  /** JS bridge: command submission + engine status query. */
  inner class ConsoleBridge {
    @JavascriptInterface
    fun submit(command: String) {
      // 缺陷 D（fx-2）：离线安全模式口令。命中 `dsh safe[ on|off|status]` 时**不落 bash**——
      // 它要动的是壳侧 profile 装配清单（bash 侧既无权限语义也无事务纪律），
      // 且引擎已死时控制台仍可用，正是这条口令存在的理由。
      val action = parseSafeCommand(command)
      if (action == null) {
        session.writeCommand(command)
        return
      }
      val engine = EngineManager(this@ConsoleActivity)
      val hardManifest = PluginMounts.ensureHard(this@ConsoleActivity, PluginMounts.currentFingerprint(this@ConsoleActivity))
      val result = when (action) {
        SafeAction.ON -> SafeMode.enter(
          patch = SafeMode.patchFile(engine),
          homePatch = SafeMode.homePatchFile(engine),
          autoDir = SafeMode.autoDir(engine),
          id = SafeMode.newId(),
          // 与引导页按钮同一权威来源（[SafeMode.isProductOwned]）：离线 CLI 与 UI 必须同口径。
          hardManifestAvailable = hardManifest != null,
          hardEntries = hardManifest?.entries,
          factoryBundles = hardManifest?.factoryBundles,
        )
        SafeAction.OFF -> SafeMode.exit(
          patch = SafeMode.patchFile(engine),
          homePatch = SafeMode.homePatchFile(engine),
          autoDir = SafeMode.autoDir(engine),
        )
        SafeAction.STATUS -> SafeMode.status(SafeMode.autoDir(engine), SafeMode.patchFile(engine), SafeMode.homePatchFile(engine))
      }
      // 回执走既有输出通道（与 bash 输出同一条路径），用户看到的就是他敲的那条命令的结果。
      sessionListener.onOutput(result.message + "\n" + safeCommandUsage() + "\n")
    }

    @JavascriptInterface
    fun engineStatus(): String = EngineProbe.check().toString()

    @JavascriptInterface
    fun close() {
      handler.post { finish() }
    }

    @JavascriptInterface
    fun restart() {
      handler.post {
        sessionStarted = session.restart(sessionListener)
      }
    }

    @JavascriptInterface
    fun copyText(text: String): Boolean {
      return try {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("dsh-console", text))
        true
      } catch (_: Exception) {
        false
      }
    }

    @JavascriptInterface
    fun ready(): Boolean = session.isAlive()
  }
}
