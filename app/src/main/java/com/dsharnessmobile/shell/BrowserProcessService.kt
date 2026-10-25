package com.dsharnessmobile.shell

import android.annotation.SuppressLint
import android.app.Application
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.MotionEvent
import android.view.Display
import android.view.KeyEvent
import android.view.SurfaceControlViewHost
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Callable
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONArray
import org.json.JSONObject

/**
 * 旧 WebView（<114，无 MULTI_PROFILE）兼容档的远端渲染器（数据目录后缀架构）。
 *
 * 本进程承载全部浏览器 tab 的 WebView：进程启动先 `setDataDirectorySuffix` 再建任何
 * WebView（API 28+；违反即 IllegalStateException），因此本进程的 cookie/storage/缓存与
 * 主进程（Default 档案，含引擎鉴权）完全隔离——隔离性实证见
 * docs/BROWSER-COMPAT-SPIKE-2026-10-24.md S1。
 *
 * 职责边界（有意收窄）：只做「视图原语」。URL 策略在本进程逐请求执行（与主进程同一份
 * BrowserHostNavigationPolicy 代码，isolatedProfile=true，受保护引擎源按 EngineEndpoint
 * 动态端口拒绝）；但 tab 模型、ref 解析、页面快照脚本全部留在主进程 BrowserHost，
 * 经 evaluateJs/dispatchTap 等原语驱动。
 *
 * 安全约束（与 BrowserHost 同源，不得放松）：
 *  - 本进程永不注入 androidBridge；
 *  - SSL 错误一律取消，不 bypass；
 *  - 不支持 scheme/受保护源/未指定地址逐请求拒绝并计数；
 *  - document-start 身份/视口脚本只经 WebViewCompat 注册（真源 BrowserTabResources）。
 *
 * 宿主 token（spike 实锤）：ensureTab 必须携带主进程窗口 token，否则 SCVH setView 在
 * grantInputChannel 撞 INTERNAL_SYSTEM_WINDOW。
 *
 * 触摸路径（issue #540）：forwardMotion 是 oneway，binder 线程只入队；主线程 drain 时按
 * [MotionCoalescer] 的合帧结果逐条重放（DOWN/UP/CANCEL 保序、连续 MOVE 只留最后一条）。
 * 不再有「渲染进程主线程忙 → 主进程主线程跟着等」的同步 Binder 往返。
 */
class BrowserProcessService : Service() {

  companion object {
    const val SUFFIX = "dsh-browser-v1"
    private const val MAIN_TIMEOUT_S = 10L
    private const val BLOCKED_REQUEST_LOG_LIMIT = 8
    /** 单 tab 待发触摸上限（见 [MotionCoalescer.DEFAULT_CAPACITY]）。 */
    private const val MOTION_QUEUE_CAPACITY = MotionCoalescer.DEFAULT_CAPACITY
  }

  private val main = Handler(Looper.getMainLooper())
  private var suffixApplied = false
  private var suffixError = ""
  private var callback: IBrowserRendererCallback? = null
  @Volatile private var allowAnonymousEngineAccess = false
  private val tabs = LinkedHashMap<String, RemoteTab>()
  private var jsSeq = AtomicInteger(0)

  /** tabId → 待重放的触摸样本（binder 线程入队，主线程合帧后重放）。 */
  private val motionQueues = TabMotionQueues(MOTION_QUEUE_CAPACITY, MotionEvent.ACTION_MOVE)
  private val motionDrainPending = AtomicBoolean(false)

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= 28) {
      try {
        // 本进程第一个 WebView 族调用必须是后缀登记（生产约束，与 spike 同）。
        WebView.setDataDirectorySuffix(SUFFIX)
        suffixApplied = true
      } catch (t: Throwable) {
        suffixError = t.toString()
      }
    } else {
      suffixError = "api-" + Build.VERSION.SDK_INT + "-below-28"
    }
    // 主进程同口径：仅 debuggable 才开远程调试（release 调用 setWebContentsDebuggingEnabled
    // 同样生效——该 API 不看构建类型，此前"发布构建会被系统拒绝"的注释是错误声明）。
    // debug 构建的 CDP 验收面不受影响（verify 脚本都在 debug 包上跑）。
    val debuggable = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
    if (debuggable) {
      try {
        WebView.setWebContentsDebuggingEnabled(true)
      } catch (_: Throwable) {
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder = object : IBrowserRenderer.Stub() {

    override fun start(cb: IBrowserRendererCallback?, configJson: String?): String = onMain {
      if (cb != null) callback = cb
      val config = runCatching { JSONObject(configJson ?: "{}") }.getOrNull() ?: JSONObject()
      allowAnonymousEngineAccess = config.optBoolean("allowAnonymousEngineAccess", false)
      // 受保护引擎源的动态端口由主进程下发（本进程不验证引擎日志，只采用已确认值）。
      EngineEndpoint.init(this@BrowserProcessService)
      EngineEndpoint.adoptConfirmedPort(config.optInt("enginePort", 0))
      infoJson().toString()
    }

    override fun ensureTab(tabId: String?, hostToken: IBinder?, configJson: String?): String = onMain {
      val id = tabId?.takeIf { it.isNotBlank() } ?: return@onMain fail("invalid-tab-id")
      if (!suffixApplied) return@onMain fail("browser-suffix-unavailable")
      val config = runCatching { JSONObject(configJson ?: "{}") }.getOrNull() ?: return@onMain fail("invalid-config")
      val width = config.optInt("widthPx", 0).coerceAtLeast(1)
      val height = config.optInt("heightPx", 0).coerceAtLeast(1)
      val token = hostToken ?: return@onMain fail("host-token-required")
      val existing = tabs[id]
      if (existing != null) {
        // 复用：仅同步身份/视口配置（需要换 doc-start 脚本时主进程走 destroy+ensure 重建）。
        existing.applyIdentityConfig(config)
        JSONObject().put("ok", true).put("tabId", id).put("reused", true).toString()
      } else {
        val tab = try {
          RemoteTab(id, token, width, height, config)
        } catch (t: Throwable) {
          return@onMain fail("tab-create-failed:" + t.javaClass.simpleName)
        }
        tabs[id] = tab
        JSONObject().put("ok", true).put("tabId", id).put("reused", false).toString()
      }
    }

    override fun destroyTab(tabId: String?): String = onMain {
      tabId?.let { motionQueues.forget(it) }
      val removed = tabs.remove(tabId)
      removed?.destroy()
      JSONObject().put("ok", true).put("tabId", tabId ?: "").put("removed", removed != null).toString()
    }

    override fun destroyAll() {
      motionQueues.clear()
      onMain {
        tabs.values.forEach { it.destroy() }
        tabs.clear()
        Unit
      }
    }

    override fun loadUrl(tabId: String?, url: String?): String = onMain {
      val tab = liveTab(tabId) ?: return@onMain fail("tab-not-found")
      // 主进程已规范化；这里仍过一遍策略——纵深防御，两端策略代码同源。
      val target = BrowserHostNavigationPolicy.normalize(url, isolatedProfile = true, allowAnonymousEngineAccess = allowAnonymousEngineAccess)
        ?: return@onMain fail("unsupported-url")
      tab.view.loadUrl(target)
      JSONObject().put("ok", true).put("url", target).toString()
    }

    override fun reload(tabId: String?): String = onMain {
      val tab = liveTab(tabId) ?: return@onMain fail("tab-not-found")
      tab.view.reload()
      JSONObject().put("ok", true).toString()
    }

    override fun goBack(tabId: String?): String = onMain {
      val tab = liveTab(tabId) ?: return@onMain fail("tab-not-found")
      if (!tab.view.canGoBack()) return@onMain fail("cannot-go-back")
      tab.view.goBack()
      JSONObject().put("ok", true).toString()
    }

    override fun goForward(tabId: String?): String = onMain {
      val tab = liveTab(tabId) ?: return@onMain fail("tab-not-found")
      if (!tab.view.canGoForward()) return@onMain fail("cannot-go-forward")
      tab.view.goForward()
      JSONObject().put("ok", true).toString()
    }

    override fun relayout(tabId: String?, widthPx: Int, heightPx: Int): String = onMain {
      val tab = tabs[tabId] ?: return@onMain fail("tab-not-found")
      tab.relayout(widthPx.coerceAtLeast(1), heightPx.coerceAtLeast(1))
      JSONObject().put("ok", true).put("widthPx", tab.view.width).put("heightPx", tab.view.height).toString()
    }

    override fun evaluateJs(tabId: String?, script: String?, seq: Int): Boolean = onMain {
      val tab = liveTab(tabId) ?: return@onMain false
      if (script == null) return@onMain false
      tab.evaluate(script, seq)
      true
    }

    override fun dispatchTap(tabId: String?, x: Float, y: Float): Boolean = onMain {
      val tab = liveTab(tabId) ?: return@onMain false
      val now = SystemClock.uptimeMillis()
      fun event(action: Int): MotionEvent = MotionEvent.obtain(now, now, action, x, y, 0)
      try {
        tab.view.dispatchTouchEvent(event(MotionEvent.ACTION_DOWN))
        tab.view.dispatchTouchEvent(event(MotionEvent.ACTION_UP))
        true
      } catch (_: Throwable) {
        false
      }
    }

    override fun dispatchKey(tabId: String?, keyCode: Int): Boolean = onMain {
      val tab = liveTab(tabId) ?: return@onMain false
      val now = SystemClock.uptimeMillis()
      fun key(action: Int, code: Int): KeyEvent = KeyEvent(now, now, action, code, 0)
      return@onMain try {
        tab.view.dispatchKeyEvent(key(KeyEvent.ACTION_DOWN, keyCode))
        tab.view.dispatchKeyEvent(key(KeyEvent.ACTION_UP, keyCode))
        true
      } catch (_: Throwable) {
        false
      }
    }

    /**
     * oneway 触摸转发（issue #540）：只在 binder 线程入队，不撞主线程、不等待任何结算。
     *
     * 旧实现走 `onMain`（FutureTask.get(10s)）：一次滑动 20 余条事件 = 20 余次同步 Binder
     * 往返，渲染进程主线程一忙，主进程主线程就跟着挂住，逼近 ANR 阈。现在投递即返回，
     * 主线程只按合帧后的结果重放（见 [drainMotion]）。
     */
    override fun forwardMotion(
      tabId: String?, action: Int, downTime: Long, eventTime: Long,
      x: Float, y: Float, pressure: Float, size: Float, metaState: Int,
    ) {
      val id = tabId?.takeIf { it.isNotBlank() } ?: return
      motionQueues.offer(
        id,
        MotionCoalescer.Sample(action, downTime, eventTime, x, y, pressure, size, metaState),
      )
      scheduleMotionDrain()
    }

    override fun capture(tabId: String?, fd: ParcelFileDescriptor?, maxWidthPx: Int, maxHeightPx: Int): Boolean = onMain {
      val tab = liveTab(tabId) ?: return@onMain false
      if (fd == null) return@onMain false
      tab.capture(fd, maxWidthPx, maxHeightPx)
    }

    override fun tabState(tabId: String?): String = onMain {
      val tab = tabs[tabId] ?: return@onMain fail("tab-not-found")
      tab.stateJson().toString()
    }

    override fun tabIds(): String = onMain {
      JSONArray(tabs.keys).toString()
    }

    override fun flushCookies(): String = onMain {
      try {
        CookieManager.getInstance().flush()
        JSONObject().put("ok", true).toString()
      } catch (t: Throwable) {
        fail("cookie-flush-failed")
      }
    }

    override fun clearBrowsingData(): String = onMain {
      // 进程级单例作用于后缀档案：与 tier-1 的 limited clear 同语义（不承诺
      // IndexedDB/CacheStorage 彻底擦除；彻底路径=停进程删目录，由主进程编排）。
      try {
        WebStorage.getInstance().deleteAllData()
        val done = java.util.concurrent.CountDownLatch(1)
        CookieManager.getInstance().removeAllCookies { done.countDown() }
        done.await(5, TimeUnit.SECONDS)
        CookieManager.getInstance().flush()
        JSONObject().put("ok", true).toString()
      } catch (t: Throwable) {
        fail("clear-failed")
      }
    }
  }

  private fun fail(reason: String): String = JSONObject().put("ok", false).put("reason", reason).toString()

  /** 渲染进程已死/已销毁的 tab 拒绝一切操作（主进程收到 renderGone 后会重建）。 */
  private fun liveTab(tabId: String?): RemoteTab? = tabs[tabId]?.takeIf { it.alive }

  private fun infoJson(): JSONObject = JSONObject()
    .put("processName", if (Build.VERSION.SDK_INT >= 28) Application.getProcessName() else "unknown")
    .put("sdkInt", Build.VERSION.SDK_INT)
    .put("suffix", SUFFIX)
    .put("suffixApplied", suffixApplied)
    .put("suffixError", suffixError)
    .put("suffixDirExists", File(filesDir.parentFile, "app_webview_" + SUFFIX).exists())
    .put("allowAnonymousEngineAccess", allowAnonymousEngineAccess)
    .put("tabCount", tabs.size)

  /**
   * 安排一次主线程 drain。同一批入队只排一次：已有 drain 在排/在跑时不重复 post。
   * 允许「多排一次」的空跑（入队与置标志之间存在窗口），代价是空队列 drain，不做等待。
   */
  private fun scheduleMotionDrain() {
    if (!motionDrainPending.compareAndSet(false, true)) return
    main.post { drainMotion() }
  }

  /**
   * 主线程重放合帧后的触摸：逐条 obtain / dispatchTouchEvent / recycle。
   * 取不到 live tab 就整批丢弃（tab 已销毁或渲染进程已崩，事件无处可去）。
   * 不 sleep、不等待：主线程开销 = 实际待发条数（连续 MOVE 已被合帧）。
   */
  private fun drainMotion() {
    motionDrainPending.set(false)
    for ((tabId, samples) in motionQueues.drainAll()) {
      val tab = tabs[tabId]?.takeIf { it.alive } ?: continue
      for (sample in samples) {
        val event = try {
          MotionEvent.obtain(
            sample.downTime, sample.eventTime, sample.action, sample.x, sample.y,
            sample.pressure, sample.size, sample.metaState, 1f, 1f, 0, 0,
          )
        } catch (_: Throwable) {
          null
        } ?: continue
        try {
          tab.view.dispatchTouchEvent(event)
        } catch (_: Throwable) {
          // 单条失败不影响后续：远端 WebView 自己决定是否消费。
        } finally {
          event.recycle()
        }
      }
    }
  }

  private fun <T> onMain(block: () -> T): T {
    val task = FutureTask(Callable { block() })
    main.post(task)
    return task.get(MAIN_TIMEOUT_S, TimeUnit.SECONDS)
  }

  private fun emit(tabId: String, event: JSONObject) {
    val cb = callback ?: return
    try {
      cb.onEvent(tabId, event.toString())
    } catch (_: Throwable) {
      // 主进程侧回调死亡由 binder 重绑兜底；事件面不反压渲染。
    }
  }

  /** 单个远端 tab：WebView + SCVH 投影 + 页面状态。全部操作持有进程主线程。 */
  private inner class RemoteTab(
    val id: String,
    hostToken: IBinder,
    widthPx: Int,
    heightPx: Int,
    identityConfig: JSONObject,
  ) {
    val generation = AtomicLong(0)
    val blockedRequests = AtomicInteger(0)
    var alive: Boolean = true
      private set
    var url: String = "about:blank"
    var title: String = ""
    var loadState: String = "idle"
    var reason: String = ""
    var errorPageUrl: String? = null
    var scrollY: Int = 0
    var scrollDirection: Int = 0
    var identityId: String = identityConfig.optString("identityId", "android-real")
    var ua: String = identityConfig.optString("ua", "")
    var viewportCssWidth: Int = identityConfig.optInt("viewportCssWidth", 0)
    var uaChApplied: Boolean = false
    private val docStartHandlers = mutableListOf<androidx.webkit.ScriptHandler>()
    private var identityScriptHandler: androidx.webkit.ScriptHandler? = null
    private var scvh: SurfaceControlViewHost? = null
    private var hostWindowContext: Context? = null
    lateinit var view: WebView
      private set

    init {
      val display: Display = getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
        ?: throw IllegalStateException("default display lookup null")
      // SCVH 官方要求：窗口上下文保证密度/配置与显示一致（spike 验证路径）。
      val windowContext: Context = if (Build.VERSION.SDK_INT >= 30) {
        baseContext.createWindowContext(display, WindowManager.LayoutParams.TYPE_APPLICATION, null)
      } else {
        baseContext.createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION, null)
      }
      hostWindowContext = windowContext

      view = createWebView(windowContext)
      applyIdentityConfig(identityConfig)
      relayoutInternal(display, windowContext, hostToken, widthPx, heightPx, first = true)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(context: Context): WebView {
      // 注意：这里不能对 WebView 整体用 apply——WebView 自带 id/url/title/scrollY 属性，
      // 会把 RemoteTab 同名状态遮蔽掉（apply 接收者优先）。只对 settings 用 apply。
      val created = WebView(context)
      created.settings.apply {
        WebViewShim.applyBaseline(this)
        WebViewShim.applyIsolation(this)
      }
      created.setOnScrollChangeListener { _, _, y, _, oldY ->
        scrollY = y
        val delta = y - oldY
        if (delta > 0) scrollDirection = 1 else if (delta < 0) scrollDirection = -1
        emit(id, JSONObject().put("type", "scroll").put("y", y).put("direction", scrollDirection))
      }
      created.webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
          if (this@RemoteTab.view !== view) return true
          val raw = request.url.toString()
          val target = BrowserHostNavigationPolicy.normalize(raw, isolatedProfile = true, allowAnonymousEngineAccess = allowAnonymousEngineAccess)
          if (target == null) {
            reason = "unsupported-url"
            return true
          }
          if (request.isForMainFrame && request.method == "GET" && target != raw) {
            view.loadUrl(target)
            return true
          }
          return false
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
          handler.cancel()
          if (this@RemoteTab.view !== view) return
          loadState = "error"
          reason = "ssl-error-cancelled"
          emit(id, JSONObject().put("type", "sslError").put("reason", reason))
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
          val raw = request.url?.toString().orEmpty()
          val blockReason = BrowserHostNavigationPolicy.blockedRequestReason(
            raw, isolatedProfile = true, allowAnonymousEngineAccess = allowAnonymousEngineAccess,
          ) ?: return null
          val count = blockedRequests.incrementAndGet()
          if (count <= BLOCKED_REQUEST_LOG_LIMIT) {
            android.util.Log.w("dsh-browser", "blocked subresource ($blockReason): $raw")
          }
          return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }

        override fun onPageStarted(view: WebView, startedUrl: String, favicon: android.graphics.Bitmap?) {
          if (this@RemoteTab.view !== view) return
          // 内置错误页守卫（与 BrowserHost 同判据）：错误页/data 事件不得覆盖真实状态。
          if (errorPageUrl != null && !startedUrl.startsWith("http")) return
          if (startedUrl.startsWith("data:")) return
          val gen = generation.incrementAndGet()
          errorPageUrl = null
          url = startedUrl
          title = ""
          loadState = "loading"
          reason = ""
          emit(id, JSONObject().put("type", "pageStarted").put("url", startedUrl).put("generation", gen))
        }

        override fun onPageFinished(view: WebView, finishedUrl: String) {
          if (this@RemoteTab.view !== view) return
          if (errorPageUrl != null && !finishedUrl.startsWith("http")) return
          if (finishedUrl.startsWith("data:")) return
          url = finishedUrl
          if (loadState == "loading") loadState = "loaded"
          // pageWidth/pageHeight 契约 = 页面 CSS 视口（与主进程 measurePage 的 innerWidth/innerHeight
          // 同口径），不是宿主视图的物理像素——分辨率预设下两者相差 factor 倍，宿主侧 status 与
          // verify 脚本的「host 报的必须等于页面实测」断言据此判定。
          view.evaluateJavascript(
            "(function(){return JSON.stringify({w:window.innerWidth||0,h:window.innerHeight||0,dpr:window.devicePixelRatio||0})})()",
          ) { raw ->
            if (this@RemoteTab.view !== view) return@evaluateJavascript
            val measured = decodeJsonString(raw)
            emit(id, JSONObject().put("type", "pageFinished")
              .put("url", finishedUrl).put("title", title).put("generation", generation.get())
              .put("pageWidth", measured?.optInt("w") ?: view.width)
              .put("pageHeight", measured?.optInt("h") ?: view.height)
              .put("pageDevicePixelRatio", measured?.optDouble("dpr") ?: 0.0)
              .put("canGoBack", view.canGoBack()).put("canGoForward", view.canGoForward()))
          }
        }

        /** evaluateJavascript 回执是 JSON 编码字符串（带引号转义）；解出对象，失败给 null。 */
        private fun decodeJsonString(raw: String?): JSONObject? = try {
          val text = raw?.trim()?.takeIf { it.startsWith("\"") }?.let {
            it.removePrefix("\"").removeSuffix("\"").replace("\\\"", "\"").replace("\\\\", "\\")
          } ?: raw?.trim()
          if (text.isNullOrEmpty()) null else JSONObject(text)
        } catch (_: Throwable) { null }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
          if (this@RemoteTab.view !== view || !request.isForMainFrame) return
          val failing = request.url.toString()
          errorPageUrl = failing
          url = failing
          loadState = "error"
          reason = "load-error:" + error.errorCode
          emit(id, JSONObject().put("type", "loadError").put("url", failing).put("reason", reason))
          view.loadDataWithBaseURL(null, BrowserTabResources.errorPageHtml(failing, error.errorCode, error.description?.toString() ?: ""), "text/html", "utf-8", null)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
          if (this@RemoteTab.view !== view) return true
          generation.incrementAndGet()
          reason = if (detail.didCrash()) "renderer-crashed" else "renderer-killed"
          emit(id, JSONObject().put("type", "renderGone").put("reason", reason))
          // 主进程据此 destroyTab+ensureTab 重建（recycle 语义）；此处只清投影与引用。
          alive = false
          motionQueues.forget(id)
          destroyProjection()
          view.destroy()
          return true
        }
      }
      created.webChromeClient = object : WebChromeClient() {
        override fun onReceivedTitle(view: WebView, pageTitle: String?) {
          if (this@RemoteTab.view !== view) return
          title = pageTitle ?: ""
          emit(id, JSONObject().put("type", "title").put("title", title))
        }
      }
      return created
    }

    /** 身份/视口配置（ensureTab 复用路径同步记录；脚本面变更须由主进程走重建）。 */
    fun applyIdentityConfig(config: JSONObject) {
      config.optString("identityId", "").takeIf { it.isNotBlank() }?.let { identityId = it.take(32) }
      config.optString("ua", "").let { if (it.isNotEmpty()) ua = it.take(512) }
      if (config.has("viewportCssWidth")) viewportCssWidth = config.optInt("viewportCssWidth", 0).coerceIn(0, 7680)
      view.settings.userAgentString = if (identityId == "android-real" || ua.isBlank()) null else ua
      uaChApplied = BrowserTabResources.applyUserAgentMetadata(view.settings, identityId)
      releaseDocStartScripts()
      if (WebViewShim.supports(androidx.webkit.WebViewFeature.DOCUMENT_START_SCRIPT)) {
        if (viewportCssWidth > 0) addDocStart(BrowserTabResources.viewportScript(viewportCssWidth))
        if (identityId != "android-real") {
          identityScriptHandler = addDocStart(
            BrowserTabResources.IDENTITY_JS.replace("Linux x86_64", if (identityId == "windows-desktop") "Win32" else "Linux x86_64"),
          )
        }
      }
    }

    private fun addDocStart(script: String): androidx.webkit.ScriptHandler? = try {
      androidx.webkit.WebViewCompat.addDocumentStartJavaScript(view, script, setOf("*")).also { docStartHandlers.add(it) }
    } catch (_: Throwable) {
      null
    }

    private fun releaseDocStartScripts() {
      docStartHandlers.forEach { try { it.remove() } catch (_: Throwable) { } }
      docStartHandlers.clear()
      identityScriptHandler = null
    }

    /** 重建 SCVH 投影（WebView 保留）。spike 实锤：复用 WebView 需先从旧容器摘除。 */
    fun relayout(widthPx: Int, heightPx: Int) {
      val display = getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY) ?: return
      val context = hostWindowContext ?: return
      relayoutInternal(display, context, currentHostToken ?: return, widthPx, heightPx, first = false)
    }

    private var currentHostToken: IBinder? = null

    private fun relayoutInternal(display: Display, context: Context, hostToken: IBinder, widthPx: Int, heightPx: Int, first: Boolean) {
      currentHostToken = hostToken
      destroyProjection()
      val scvhHost = SurfaceControlViewHost(context, display, hostToken)
      (view.parent as? ViewGroup)?.removeView(view)
      val container = FrameLayout(context).apply {
        addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      }
      scvhHost.setView(container, widthPx, heightPx)
      scvh = scvhHost
      // 显式 layout（spike 实锤：SCVH 换手后渲染器视口可能不跟随，需主动量一遍）。
      view.layout(0, 0, widthPx, heightPx)
      val pkg = try {
        @Suppress("DEPRECATION")
        scvhHost.surfacePackage
      } catch (_: Throwable) {
        null
      }
      if (pkg != null) {
        try {
          callback?.onSurfacePackage(id, pkg)
        } catch (_: Throwable) {
        }
      }
    }

    private fun destroyProjection() {
      try {
        scvh?.release()
      } catch (_: Throwable) {
      }
      scvh = null
    }

    fun evaluate(script: String, seq: Int) {
      view.evaluateJavascript(script) { raw ->
        val payload = try {
          JSONObject().put("value", raw ?: "null").toString()
        } catch (_: Throwable) {
          JSONObject().put("__error", "js-result-unserializable").toString()
        }
        try {
          callback?.onJsResult(id, seq, payload)
        } catch (_: Throwable) {
        }
      }
    }

    fun capture(fd: ParcelFileDescriptor, maxWidthPx: Int, maxHeightPx: Int): Boolean = try {
      val w = view.width.coerceAtLeast(1)
      val h = view.height.coerceAtLeast(1)
      val scale = minOf(1f, maxWidthPx.toFloat() / w, maxHeightPx.toFloat() / h)
      val bitmap = Bitmap.createBitmap((w * scale).toInt().coerceAtLeast(1), (h * scale).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
      val canvas = Canvas(bitmap)
      if (scale != 1f) canvas.scale(scale, scale)
      view.draw(canvas)
      // 注意：fd 是管道端，fsync 会抛 SyncNotSupported——压缩后直接 flush 由 use 关闭收尾。
      FileOutputStream(fd.fileDescriptor).use { out ->
        bitmap.compress(Bitmap.CompressFormat.PNG, 90, out)
      }
      bitmap.recycle()
      true
    } catch (_: Throwable) {
      false
    }

    fun stateJson(): JSONObject = JSONObject()
      .put("tabId", id)
      .put("url", url)
      .put("title", title)
      .put("loadState", loadState)
      .put("reason", reason)
      .put("generation", generation.get())
      .put("width", view.width)
      .put("height", view.height)
      .put("scrollY", scrollY)
      .put("scrollDirection", scrollDirection)
      .put("canGoBack", view.canGoBack())
      .put("canGoForward", view.canGoForward())
      .put("blockedRequests", blockedRequests.get())
      .put("identityId", identityId)
      .put("uaChApplied", uaChApplied && identityId != "android-real")
      .put("viewportCssWidth", viewportCssWidth)
      .put("projectionAttached", scvh != null)

    fun destroy() {
      alive = false
      releaseDocStartScripts()
      destroyProjection()
      try {
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
      } catch (_: Throwable) {
      }
    }
  }
}
