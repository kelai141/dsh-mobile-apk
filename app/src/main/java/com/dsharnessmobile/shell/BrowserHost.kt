package com.dsharnessmobile.shell

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.ScriptHandler
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * A lazily-created untrusted browsing surface over the trusted DSH WebView.
 *
 * Browser pages never receive `androidBridge`. The trusted DSH sidebar reports its CSS stage rect
 * through its bridge; this owner maps that rect into the root FrameLayout and overlays only that
 * stage. Main-thread ownership keeps lifecycle, layout, and renderer callbacks serialized.
 *
 * 0.14.0 batch: the host now also carries the model-facing control surface. All page reads and
 * actions go through DOM/ARIA snapshot refs: a snapshot records `{tabId, pageGeneration, refs}`,
 * and every action re-validates the generation and the ref before it can dispatch input. Stale
 * refs and stale pages are rejected instead of guessed. Hit testing, touch dispatch, CDP bounds,
 * and screenshots share the same untransformed letterbox rectangle.
 */
internal class BrowserHost(
  private val activity: MainActivity,
  private val root: FrameLayout,
  private val dshWebView: WebView,
  // Trusted native configuration only; never derived from webpage/bridge URL arguments.
  private val allowAnonymousEngineAccess: Boolean = false,
) {
  private data class StageBounds(
    val left: Double,
    val top: Double,
    val width: Double,
    val height: Double,
    val viewportWidth: Double,
    val viewportHeight: Double,
    val visible: Boolean,
  )
  private data class RequestedViewport(val id: String, val width: Int, val height: Int)

  companion object {
    /** 锚点标签页 id（首个页面恒定用它，保证旧调用与设备脚本的期望值不变）。 */
    const val TAB_ID = "tab-1"
    private const val ROOT_TAB_ID = TAB_ID
    /** 非会话调用（旧调用/设备脚本）的工作台键：与任何真实会话隔离，保持改造前的可用性。 */
    private const val ANONYMOUS_SESSION = "__anonymous__"
    private const val MAX_TABS = 8
    /**
     * 请求级过滤写进 logcat 的**条数上限**（审查 S-4）。
     *
     * 为什么必须有上限：被拦请求的数量由**页面**决定 —— 一个恶意/失控页面可以刷出成千上万条回环
     * 探测请求，没有上限就是把 logcat 与诊断文件交给它写。超出后只累加计数
     * （`status().blockedRequests`），行为仍如实可观测。
     */
    private const val BLOCKED_REQUEST_LOG_LIMIT = 20
    private const val SNAPSHOT_MAX_NODES = 400
    /** 无活动标签页时的只读占位（避免把“没有页面”误判成“有页面”） */
    private val ORPHAN_GENERATION = AtomicLong(0)
    private val ORPHAN_REFS = HashSet<String>()
  }

  /** Complete per-session native authority; polling never changes selected workspace or visibility. */
  private fun tabSummaries(workspace: Workspace = requireWorkspace()): JSONArray {
    val density = dshWebView.resources.displayMetrics.density.coerceAtLeast(0.5f)
    val profileAvailable = workspace.profile.isAssigned && workspace.profileError.isEmpty()
    val profileReason = workspace.profileError.ifEmpty { if (profileAvailable) "" else "browser-profile-not-ready" }
    val out = JSONArray()
    for (tab in workspace.tabs.values) {
      out.put(JSONObject()
        .put("session", workspace.sessionKey).put("tabId", tab.id)
        .apply { tab.uiTabId?.let { put("uiTabId", it) } }
        .put("url", tab.url).put("title", tab.title.take(1024))
        .put("pageGeneration", tab.generation.get()).put("loadState", tab.loadState)
        .put("canGoBack", tab.view?.canGoBack() == true).put("canGoForward", tab.view?.canGoForward() == true)
        .put("identityId", tab.identityId)
        .put("viewportWidth", tab.requestedViewport?.width ?: (dshWebView.width / density).toInt())
        .put("viewportHeight", tab.requestedViewport?.height ?: (dshWebView.height / density).toInt())
        .put("profileAvailable", profileAvailable).put("profileReason", profileReason)
        .put("reason", tab.reason).put("active", tab.id == workspace.activeTabId))
    }
    return out
  }

  /** 取用或新建一个标签页；id 为空时落在锚点页（单页签调用语义与改造前一致）。 */
  private fun ensureTab(id: String?): Tab {
    val wanted = id?.takeIf { it.isNotBlank() } ?: activeTabId ?: run {
      var candidate: String
      do { candidate = "tab-" + nextTabSeq++ } while (tabs.containsKey(candidate))
      candidate
    }
    tabs[wanted]?.let { return it }
    val created = Tab(wanted)
    tabs[wanted] = created
    if (activeTabId == null) activeTabId = wanted
    return created
  }

  private val main = Handler(Looper.getMainLooper())

  /**
   * 一个浏览器标签页的**全部页面级状态**（0.14.0 多页签）。
   *
   * 为什么要把这些字段从宿主搬进来：此前宿主只有一份 url/title/loadState/generation/refs，
   * 结构上只能有一个页面——但工具面早就承诺了 browser_list_tabs / browser_follow_tab /
   * browser_close_tab，模型因此「以为」能同时控多个网页（用户实测：开三个站点只有一页生效）。
   * 每个 tab 一份状态后，工具承诺与原生能力才对齐。
   */
  private inner class Tab(val id: String) {
    var uiTabId: String? = null
    var reason = ""
    var requestedViewport: RequestedViewport? = null
    var appliedViewport: RequestedViewport? = null
    var identityId = "android-real"
    var identityUa = ""
    var uaChApplied = false
    var identityScriptHandler: ScriptHandler? = null
    val docStartHandlers = mutableListOf<ScriptHandler>()
    var view: WebView? = null
    var url = "about:blank"
    var title = ""
    var loadState = "idle"
    val generation = AtomicLong(0)
    /** 最近一次被接受的 snapshot 的 ref 集；动作只接受这些。 */
    val refs = HashSet<String>()
    var snapshotGeneration = -1L
    var scrollY = 0
    var scrollDirection = 0
    var pageWidth = 0
    var pageHeight = 0
    var pageDevicePixelRatio = 0.0
    var errorPageUrl: String? = null
    /**
     * 被**请求级过滤**拦下的子资源计数（审查 S-4）。
     *
     * 为什么要有这个计数：拦截动作发生在 `shouldInterceptRequest`（后台线程），既不改页面状态、
     * 也不产生 onReceivedError —— 如果只写 logcat，模型与面板都无从知道「页面少了东西」，
     * 现场排查只能靠人捞日志。计数进 `status()` 后可被 `browser_state` 直接看到。
     * 计数用 AtomicInteger：该方法在 WebView 的 IO 线程池上并发调用。
     */
    val blockedRequests = AtomicInteger(0)
  }

  /**
   * 一个会话的浏览器工作台（0.14.0 用户口径：**按会话隔离，互不占用**）。
   *
   * 为什么必须是「每会话一份」：上游侧栏面板是**每会话**的（`openTab(kind)` 落在当前会话），
   * 而此前壳侧只有**全局单实例** tabs + 一把单向归属锁（`ownerSessionId`）。两者模型不匹配，
   * 直接后果就是用户实测到的：A 对话开过浏览器后，B 对话打开面板只能看到「由会话 A 使用中」，
   * 而且**只有 A 能解锁**（会话 A 一旦被删除，工作台永久锁死、只能重启 App）。
   *
   * 正确模型：切到别的对话就看不到、也碰不到别人的页面；各自独立开页、独立计代次、
   * 独立可见性。成本是每个**有活动页面的**会话各持一个 WebView —— 这正是浏览器该有的语义。
   */
  private inner class Workspace(val sessionKey: String) {
    val profile = BrowserHostProfile(sessionKey, allowAnonymousEngineAccess)
    var profileError = ""
    /** 本会话的标签页，插入序即 UI 顺序；锚点固定为 [ROOT_TAB_ID]。 */
    val tabs = LinkedHashMap<String, Tab>()
    var activeTabId: String? = null
    /** Model focus is independent from the trusted foreground occurrence. Main-thread only. */
    var modelTabId: String? = null
    var nextTabSeq = 1
    /** 本会话是否已向原生舞台下发过可见性（面板收起/未挂载时为 false）。 */
    var requestedVisible = false
    var stageVisible = false
    var stageBounds: StageBounds? = null
    /**
     * 最近一次可信 bounds 下推的 `uptimeMillis`（`0` = 从未下推）。
     *
     * 「记忆态」与「在场态」必须分开：`stageVisible` 只说明**上一次下推**说了什么，
     * 它无法回答「现在还有没有发布者」。用户实报「收起侧边栏浏览器不卸载」正是这个缺口
     * （见 [BrowserOverlayPolicy] 的 KDoc）——所以绘制判据加上了这个时间戳做保鲜。
     */
    var boundsAt = 0L
    var lastStageSize: Pair<Int, Int>? = null
  }

  /** 全部会话工作台（键 = 会话 id；[ANONYMOUS_SESSION] 为非会话调用）。 */
  private val workspaces = LinkedHashMap<String, Workspace>()

  /** 当前正在被操作/呈现的工作台。null = 尚无任何会话建立工作台。 */
  private var currentWorkspace: Workspace? = null

  /** 取用（必要时创建）某会话的工作台。 */
  private fun workspaceFor(session: String?): Workspace {
    val key = session?.takeIf { it.isNotBlank() } ?: ANONYMOUS_SESSION
    workspaces[key]?.let { return it }
    val created = Workspace(key)
    workspaces[key] = created
    return created
  }

  /** Foreground selection is owned exclusively by trusted UI work on the main thread. */
  private fun switchTo(workspace: Workspace) {
    check(Looper.myLooper() == Looper.getMainLooper())
    currentWorkspace = workspace
    applyStageBounds()
    applyVisibility()
  }

  /**
   * 清空并移除某会话的工作台（销毁它自己的 WebView；不影响其它会话）。
   * 匿名工作台例外：它永远保留在表里（旧调用/设备脚本会反复复用同一份状态，
   * 若被移除则每次调用都会新建，页面凭空丢失）。
   */
  private fun dropWorkspace(workspace: Workspace) {
    for (tab in workspace.tabs.values) {
      tab.generation.incrementAndGet()
      releaseTabScripts(tab)
      synchronized(tab.refs) { tab.refs.clear() }
      tab.view?.let { browser ->
        root.removeView(browser)
        browser.destroy()
      }
      tab.view = null
      tab.snapshotGeneration = -1L
    }
    try { workspace.profile.dispose() } catch (_: Throwable) {
      workspace.profileError = "browser-profile-dispose-failed"
      lastError = workspace.profileError
    }
    workspace.tabs.clear()
    workspace.activeTabId = null
    workspace.modelTabId = null
    workspace.nextTabSeq = 1
    workspace.requestedVisible = false
    workspace.stageVisible = false
    workspace.stageBounds = null
    if (workspace.sessionKey != ANONYMOUS_SESSION) workspaces.remove(workspace.sessionKey)
    if (currentWorkspace === workspace) currentWorkspace = null
    applyVisibility()
  }

  /**
   * 取当前工作台；若尚未选定（旧调用/设备脚本先到），落到匿名工作台并**设为当前**。
   *
   * 为什么要保证「读到就一定被设为当前」：早先写成 `workspaceFor(key)` 的读侧副作用会在 map 里
   * 新建一个工作台却不切换 currentWorkspace，于是「tab 建在 A、activeTabId 读自 null」——
   * 状态分裂、页面永远不显示。读侧不得产生「半生效」的写。
   */
  private fun requireWorkspace(): Workspace {
    currentWorkspace?.let { return it }
    val anon = workspaces[ANONYMOUS_SESSION] ?: Workspace(ANONYMOUS_SESSION).also { workspaces[ANONYMOUS_SESSION] = it }
    currentWorkspace = anon
    return anon
  }

  /** 当前工作台的标签页表（页面级状态代理的目标）。 */
  private val tabs: LinkedHashMap<String, Tab>
    get() = requireWorkspace().tabs

  private var activeTabId: String?
    get() = currentWorkspace?.activeTabId
    set(value) { currentWorkspace?.activeTabId = value }
  /** 页 id 序号按会话独立递增（各会话的 tab-N 互不干扰）。 */
  private var nextTabSeq: Int
    get() = currentWorkspace?.nextTabSeq ?: 1
    set(value) { currentWorkspace?.nextTabSeq = value }
  private fun activeTab(): Tab? = currentWorkspace?.activeTabId?.let { currentWorkspace?.tabs?.get(it) }
  private fun tabOrNull(id: String?): Tab? = id?.let { currentWorkspace?.tabs?.get(it) }

  /** 页面级字段一律代理到**活动标签页**：单页签时代码路径与改造前逐字等价。 */
  private var view: WebView?
    get() = activeTab()?.view
    set(value) { activeTab()?.view = value }

  // 可见性三件套按会话隔离：A 对话把面板收起来，不该影响 B 对话的显示状态。
  private var requestedVisible: Boolean
    get() = currentWorkspace?.requestedVisible ?: false
    set(value) { currentWorkspace?.requestedVisible = value }
  private var stageVisible: Boolean
    get() = currentWorkspace?.stageVisible ?: false
    set(value) { currentWorkspace?.stageVisible = value }
  private var stageBounds: StageBounds?
    get() = currentWorkspace?.stageBounds
    set(value) { currentWorkspace?.stageBounds = value }
  /**
   * 最近一次**可见舞台**的物理像素尺寸（宽, 高）。
   *
   * 用途：舞台被收起（`bounds.visible=false`）时，仍要按这个尺寸给 WebView 排版，
   * 否则页面布局盒塌成 0×0（`innerWidth/innerHeight = 0`），模型侧 snapshot/click 全线失效。
   * 「收起」只是不显示，不是「页面不存在」。
   */
  private var lastStageSize: Pair<Int, Int>?
    get() = currentWorkspace?.lastStageSize
    set(value) { currentWorkspace?.lastStageSize = value }
  /** Device viewport is default; named presets letterbox inside the trusted stage without transforms. */
  private var requestedViewport: RequestedViewport?
    get() = activeTab()?.requestedViewport
    set(value) { activeTab()?.requestedViewport = value }
  private var lastError = ""
  /** Identity and viewport belong to one tab, never to global selection or another Session. */
  private var identityId: String
    get() = activeTab()?.identityId ?: "android-real"
    set(value) { activeTab()?.identityId = value }
  private var identityUa: String
    get() = activeTab()?.identityUa.orEmpty()
    set(value) { activeTab()?.identityUa = value }
  private var identityScriptHandler: ScriptHandler?
    get() = activeTab()?.identityScriptHandler
    set(value) { activeTab()?.identityScriptHandler = value }
  private val docStartHandlers: MutableList<ScriptHandler>
    get() = activeTab()?.docStartHandlers ?: mutableListOf()
  /** recycleView 内部重建时抑制再次重建。 */
  private var recycling = false
  /** 当前已注入脚本的预设；预设变化需要重建脚本并重载页面。 */
  private var appliedViewport: RequestedViewport?
    get() = activeTab()?.appliedViewport
    set(value) { activeTab()?.appliedViewport = value }
  /**
   * 当前**呈现面**（侧栏）声明的会话。
   *
   * 只用于「这次 bounds 下推属于谁」——决定哪个 Workstation 的页面该显示、以及不带 session 的
   * 旧调用该落到哪个工作台。**不再是归属锁**：0.14.0 改为按会话隔离后，没有任何会话能「占用」
   * 或「锁死」别人的工作台。
   */
  private var viewerSessionId: String? = null

  private val title: String get() = activeTab()?.title ?: ""
  private val url: String get() = activeTab()?.url ?: "about:blank"
  private val loadState: String get() = activeTab()?.loadState ?: "idle"
  private val generation: AtomicLong get() = activeTab()?.generation ?: ORPHAN_GENERATION
  private val lastRefs: HashSet<String> get() = activeTab()?.refs ?: ORPHAN_REFS
  private var lastSnapshotGeneration: Long
    get() = activeTab()?.snapshotGeneration ?: -1L
    set(value) { activeTab()?.snapshotGeneration = value }
  private var pageWidth: Int
    get() = activeTab()?.pageWidth ?: 0
    set(value) { activeTab()?.pageWidth = value }
  private var pageHeight: Int
    get() = activeTab()?.pageHeight ?: 0
    set(value) { activeTab()?.pageHeight = value }
  private var pageDevicePixelRatio: Double
    get() = activeTab()?.pageDevicePixelRatio ?: 0.0
    set(value) { activeTab()?.pageDevicePixelRatio = value }
  private var scrollY: Int
    get() = activeTab()?.scrollY ?: 0
    set(value) { activeTab()?.scrollY = value }
  private var scrollDirection: Int
    get() = activeTab()?.scrollDirection ?: 0
    set(value) { activeTab()?.scrollDirection = value }
  private var errorPageUrl: String?
    get() = activeTab()?.errorPageUrl
    set(value) { activeTab()?.errorPageUrl = value }
  private val rootLayoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
    applyStageBounds()
  }

  init {
    root.addOnLayoutChangeListener(rootLayoutListener)
  }

  /** BrowserHost is ready once the owner has a root; no second WebView exists until show/open. */
  fun statusJson(): String = onMain { status().toString() } ?: unavailable("main-thread-timeout")

  /** Trusted UI command vocabulary only: no page JavaScript, shell, or arbitrary native dispatch. */
  fun command(raw: String): String = onMain {
    if (raw.length > 20_480) return@onMain commandUnavailable("", "browser-command-too-large")
    val args = try { JSONObject(raw) } catch (_: Throwable) {
      return@onMain commandUnavailable("", "browser-command-invalid")
    }
    val session = args.opt("session") as? String ?: ""
    if (!validUiId(session, 2048)) return@onMain commandUnavailable(session, "browser-session-invalid")
    val action = args.opt("action") as? String ?: ""
    if (action !in setOf("open", "back", "forward", "reload", "select", "close", "status", "tabs")) {
      return@onMain commandUnavailable(session, "browser-command-unknown")
    }
    for (key in listOf("tabId", "uiTabId")) {
      if (args.has(key) && !validUiId(args.opt(key) as? String ?: "", 256)) {
        return@onMain commandUnavailable(session, "browser-tab-id-invalid")
      }
    }
    val workspace = workspaceFor(session)
    val requestedId = args.optString("tabId", "").takeIf { it.isNotEmpty() }
    val uiId = args.optString("uiTabId", "").takeIf { it.isNotEmpty() }
    var tab = requestedId?.let { workspace.tabs[it] }
      ?: if (requestedId == null && uiId != null) workspace.tabs.values.firstOrNull { it.uiTabId == uiId } else null
    if (action == "tabs" || action == "status") {
      return@onMain nativeReply(workspace, tab).toString()
    }
    if (requestedId != null && tab == null) return@onMain nativeReply(workspace, reason = "tab-not-found").toString()
    if (uiId != null && workspace.tabs.values.any { it.uiTabId == uiId && it !== tab }) {
      return@onMain nativeReply(workspace, tab, "browser-ui-tab-conflict").toString()
    }
    // Only select may explicitly rebind a retained native tab after the trusted layout inventory
    // has proved that its previous occurrence is absent. Other actions cannot hijack a binding.
    if (tab?.uiTabId != null && uiId != null && tab.uiTabId != uiId && action != "select") {
      return@onMain nativeReply(workspace, tab, "browser-ui-tab-mismatch").toString()
    }
    val previous = currentWorkspace
    currentWorkspace = workspace
    try {
      if (action == "open" && tab == null) {
        if (workspace.tabs.size >= MAX_TABS) return@onMain nativeReply(workspace, reason = "tab-limit").toString()
        var id: String
        do { id = "tab-" + workspace.nextTabSeq++ } while (workspace.tabs.containsKey(id))
        tab = ensureTab(id)
      }
      val target = tab ?: return@onMain nativeReply(workspace, reason = "tab-not-found").toString()
      if (uiId != null) target.uiTabId = uiId
      if (action == "close") {
        val closed = closeTabOp(JSONObject().put("tabId", target.id))
        return@onMain nativeReply(workspace, reason = if (closed.optBoolean("ok")) "" else closed.optString("reason", "browser-close-failed"))
          .put("closedTabId", target.id).toString()
      }
      workspace.activeTabId = target.id
      if (action == "select") return@onMain nativeReply(workspace, target).toString()
      val browser = ensureViewFor(target)
        ?: return@onMain nativeReply(workspace, target, workspace.profileError.ifEmpty { "browser-not-created" }).toString()
      if (action == "open") {
        val address = args.opt("url") as? String
        if (address == null || address.length > 16_384) return@onMain nativeReply(workspace, target, "unsupported-url").toString()
        val normalized = workspace.profile.normalize(address)
          ?: return@onMain nativeReply(workspace, target, "unsupported-url").toString()
        invalidateNavigation(target)
        target.url = normalized
        browser.loadUrl(normalized)
      } else when (action) {
        "back" -> if (browser.canGoBack()) { invalidateNavigation(target); browser.goBack() }
        "forward" -> if (browser.canGoForward()) { invalidateNavigation(target); browser.goForward() }
        "reload" -> { invalidateNavigation(target); browser.reload() }
      }
      nativeReply(workspace, target).toString()
    } finally {
      // Commands and polling are addressed operations, not a claim on the foreground stage.
      currentWorkspace = previous
      applyStageBounds()
      applyVisibility()
    }
  } ?: commandUnavailable("", "main-thread-timeout")

  private fun validUiId(value: String, limit: Int): Boolean =
    value.isNotBlank() && value.length <= limit && value.none { it.code < 32 || it.code == 127 }

  private fun commandUnavailable(session: String, reason: String): String = JSONObject()
    .put("ok", false).put("available", false).put("session", session)
    .put("profileAvailable", false).put("profileReason", reason).put("reason", reason).toString()

  private fun nativeReply(workspace: Workspace, tab: Tab? = null, reason: String = ""): JSONObject {
    val supported = BrowserHostProfile.supported()
    val available = supported && workspace.profileError.isEmpty()
    val isolated = available && workspace.profile.isAssigned
    val profileReason = workspace.profileError.ifEmpty {
      if (!supported) "browser-profile-unsupported" else if (!isolated) "browser-profile-not-ready" else ""
    }
    return JSONObject().put("ok", available && reason.isEmpty()).put("available", available)
      .put("session", workspace.sessionKey).put("ownerSessionId", workspace.sessionKey)
      .put("profileAvailable", isolated).put("profileReason", profileReason)
      .put("reason", reason.ifEmpty { if (!available) profileReason else tab?.reason.orEmpty() })
      .put("tabs", tabSummaries(workspace)).put("activeTabId", workspace.activeTabId ?: "")
      .apply { tab?.let { put("tabId", it.id) } }
  }

  private fun invalidateNavigation(tab: Tab) {
    tab.reason = ""
    tab.loadState = "loading"
    tab.generation.incrementAndGet()
    tab.snapshotGeneration = -1L
    synchronized(tab.refs) { tab.refs.clear() }
  }


  /**
   * Show the browser workbench, creating the untrusted WebView on first use.
   * 0.14.0：入参兼容裸 URL（旧调用/设备脚本）与 JSON `{url?, session?}`（可信面板带会话）。
   */
  fun show(rawUrl: String?): String = onMain {
    val payload = showPayload(rawUrl)
    switchTo(workspaceFor(payload.second ?: viewerSessionId))
    val browser = ensureView() ?: return@onMain rejected(lastError)
    val target = normalizeUrl(payload.first)
    if (payload.first?.isNotEmpty() == true && target == null) {
      lastError = "unsupported-url"
      return@onMain rejected(lastError)
    }
    requestedVisible = true
    if (target != null && target != url) browser.loadUrl(target)
    applyVisibility()
    status().toString()
  } ?: unavailable("main-thread-timeout")

  /** 解析 show 入参：裸 URL 或 `{url, session}`。 */
  private fun showPayload(raw: String?): Pair<String?, String?> {
    val text = raw?.trim().orEmpty()
    if (!text.startsWith("{")) return text.takeIf { it.isNotEmpty() } to null
    return try {
      val value = JSONObject(text)
      value.optString("url", "").takeIf { it.isNotBlank() } to
        value.optString("session", "").takeIf { it.isNotBlank() }
    } catch (_: Throwable) {
      null to null
    }
  }

  // 归属锁（bindOwner/requireOwner）已在 0.14.0 移除：按会话隔离后不再存在「工作台被某会话占用」
  // 这种状态。历史原因（用户实测「切到别的对话只能看到『由会话 A 使用中』且只有 A 能解锁、
  // A 被删就永久锁死）见 Workspace 的注释。

  /** Hide the browser surface without destroying its tab state. */
  fun hide(): String = onMain {
    requestedVisible = false
    // 停画必须把两半都撤掉：只清 requestedVisible 会让 stageVisible 留成 true，
    // 于是下一次 show()/switchTo 回到本工作台时**不需要任何在场 UI** 就又画出来
    // （用户实报「收起侧边栏浏览器不卸载」的幽灵态由此而来）。见 [BrowserOverlayPolicy]。
    stageVisible = false
    applyVisibility()
    status().toString()
  } ?: unavailable("main-thread-timeout")

  /** Reload the current page only when a BrowserHost tab exists. */
  fun reload(): String = onMain {
    val browser = view
    if (browser == null) {
      lastError = "browser-not-created"
      return@onMain rejected(lastError)
    }
    browser.reload()
    status().toString()
  } ?: unavailable("main-thread-timeout")

  /** Navigate only in a verified nonDefault profile; protected engine and unsafe URLs stay denied. */
  fun navigate(rawUrl: String): String = onMain {
    val browser = ensureView() ?: return@onMain rejected(lastError)
    val target = normalizeUrl(rawUrl)
    if (target == null) {
      lastError = "unsupported-url"
      return@onMain rejected(lastError)
    }
    requestedVisible = true
    browser.loadUrl(target)
    applyVisibility()
    status().toString()
  } ?: unavailable("main-thread-timeout")

  /**
   * Update native overlay geometry from one trusted DSH sidebar stage.
   * @param raw JSON `{left,top,width,height,viewportWidth,viewportHeight,visible}` in CSS px.
   */
  fun setStageBounds(raw: String): String = onMain {
    try {
      val value = JSONObject(raw)
      val session = value.optString("session", "").takeIf { it.isNotBlank() }
      val tabId = value.optString("tabId", "").takeIf { it.isNotBlank() }
      val visible = value.optBoolean("visible", false)
      if (session != null && tabId != null) {
        val workspace = workspaces[session]
          ?: return@onMain commandUnavailable(session, "browser-session-not-found")
        val tab = workspace.tabs[tabId]
          ?: return@onMain nativeReply(workspace, reason = "tab-not-found").toString()
        val uiId = value.optString("uiTabId", "").takeIf { it.isNotBlank() }
        if (uiId != null && tab.uiTabId != uiId) return@onMain nativeReply(workspace, tab, "browser-ui-tab-mismatch").toString()
        if (!visible) {
          // Stale detach/HMR from A must not hide the currently visible occurrence B.
          if (workspace.activeTabId == tabId) {
            workspace.stageVisible = false
            workspace.requestedVisible = false
            applyVisibility()
          }
          return@onMain nativeReply(workspace, tab).toString()
        }
        workspace.activeTabId = tabId
        viewerSessionId = session
        switchTo(workspace)
        workspace.requestedVisible = true
      } else if (session != null) {
        viewerSessionId = session
        switchTo(workspaceFor(session))
      }
      stageBounds = StageBounds(
        left = value.optDouble("left", 0.0), top = value.optDouble("top", 0.0),
        width = value.optDouble("width", 0.0), height = value.optDouble("height", 0.0),
        viewportWidth = value.optDouble("viewportWidth", 0.0), viewportHeight = value.optDouble("viewportHeight", 0.0),
        visible = visible,
      )
      currentWorkspace?.boundsAt = SystemClock.uptimeMillis()
      if (lastError == "invalid-stage-bounds") lastError = ""
      applyStageBounds()
      if (session != null && tabId != null) nativeReply(requireWorkspace(), activeTab()).toString() else status().toString()
    } catch (_: Throwable) { rejected("invalid-stage-bounds") }
  } ?: unavailable("main-thread-timeout")

  /** Viewport and identity target a captured Session/tab, never whichever page happens to have focus. */
  private fun withUiTarget(args: JSONObject, apply: () -> JSONObject): JSONObject {
    if (!args.has("session") && !args.has("tabId") && !args.has("uiTabId")) {
      ensureTab(null) // Legacy/model pre-open identity and viewport remain remembered on their own tab.
      return apply()
    }
    val session = args.optString("session", "")
    val workspace = workspaces[session] ?: return JSONObject(commandUnavailable(session, "browser-session-not-found"))
    val tab = workspace.tabs[args.optString("tabId", "")]
      ?: return nativeReply(workspace, reason = "tab-not-found")
    val uiId = args.optString("uiTabId", "").takeIf { it.isNotBlank() }
    if (uiId != null && tab.uiTabId != uiId) return nativeReply(workspace, tab, "browser-ui-tab-mismatch")
    val previous = currentWorkspace
    val previousTab = workspace.activeTabId
    currentWorkspace = workspace
    workspace.activeTabId = tab.id
    try {
      val settled = apply()
      return nativeReply(workspace, tab, if (settled.optBoolean("ok")) "" else settled.optString("reason", "browser-setting-failed"))
    } finally {
      workspace.activeTabId = previousTab
      currentWorkspace = previous
      applyStageBounds()
      applyVisibility()
    }
  }

  fun setViewport(raw: String): String = onMain {
    try {
      val value = JSONObject(raw)
      withUiTarget(value) {
        val id = value.optString("id", "").take(48)
        val width = value.optInt("width", 0)
        val height = value.optInt("height", 0)
        if (id != "device" && (width !in 240..3840 || height !in 240..3840)) {
          return@withUiTarget JSONObject().put("ok", false).put("reason", "invalid-viewport")
        }
        val next = if (id == "device") null else RequestedViewport(id.ifBlank { "$width x $height" }, width, height)
        val changed = next != appliedViewport
        requestedViewport = next
        if (changed && view != null) recycleView() else applyStageBounds()
        status()
      }.toString()
    } catch (_: Throwable) { rejected("invalid-viewport") }
  } ?: unavailable("main-thread-timeout")

  // ── model-facing control surface ──────────────────────────────────────────

  /**
   * Dispatch one registered shell control op. Called from the control queue thread; every WebView
   * touch/JS call is marshalled to the main thread with a bounded wait.
   */
  fun controlOp(op: String, args: JSONObject): JSONObject {
    if (op == "browserOpen") openConfigProblem(args)?.let { return rejectControl(it) }
    // Capture Session and tab on the sole UI owner. No global selection survives a main slice.
    val target = onMain {
      val session = args.optString("session", "").takeIf { it.isNotBlank() } ?: viewerSessionId
      val workspace = workspaceFor(session)
      val id = args.optString("tabId", "").takeIf { it.isNotBlank() }
        ?: workspace.modelTabId ?: workspace.activeTabId
      ControlTarget(workspace, id?.let { workspace.tabs[it] })
    } ?: return controlTimeout()
    if (args.optString("tabId", "").isNotBlank() && target.tab == null && op != "browserOpen") {
      return targetFailure(target, "tab-not-found")
    }
    return when (op) {
      "browserCaps" -> controlOnMain(target) { caps() }
      "browserState" -> controlOnMain(target) { status() }
      "browserTabs" -> controlOnMain(target) { listTabsOp() }
      "browserFollowTab" -> controlOnMain(target) {
        followTabOp(args).also { if (it.optBoolean("ok")) target.workspace.modelTabId = activeTabId }
      }
      "browserCloseTab" -> controlOnMain(target) { closeTabOp(args) }
      "browserShow" -> controlOnMain(target) {
        // Do not route through show(), which claims the global foreground workspace.
        val browser = ensureView() ?: return@controlOnMain status().put("ok", false)
        target.workspace.modelTabId = activeTabId
        val raw = args.optString("url", "")
        if (raw.isNotBlank()) {
          val normalized = normalizeUrl(raw) ?: return@controlOnMain status().put("ok", false).put("reason", "unsupported-url")
          browser.loadUrl(normalized)
        }
        status()
      }
      "browserHide" -> controlOnMain(target) { controlJson(hide()) }
      "browserClose" -> controlOnMain(target) {
        dropWorkspace(target.workspace)
        targetFailure(target, target.workspace.profileError).put("ok", target.workspace.profileError.isEmpty())
          .put("created", false).put("visible", false).put("tabs", JSONArray())
      }
      "browserOpen" -> navigateOp(args, target)
      "browserViewport" -> viewportOp(args, target)
      "browserSetUa" -> identityOp(args, target)
      "browserJs" -> browserJsOp(args, target)
      "browserInput" -> inputOp(args, target)
      "browserShot" -> shotOp(args, target)
      else -> targetFailure(target, "unknown-op").put("__error", "未知浏览器操作 $op")
    }
  }

  private inner class ControlTarget(val workspace: Workspace, val tab: Tab?)

  /** Main-thread slice only. Never keep this temporary selection while awaiting JS/navigation. */
  private fun <T> withModelTarget(target: ControlTarget, block: () -> T): T {
    val workspace = target.workspace
    val foreground = currentWorkspace
    val foregroundTab = workspace.activeTabId
    val foregroundError = lastError
    currentWorkspace = workspace
    workspace.activeTabId = target.tab?.id
    lastError = workspace.profileError.ifEmpty { target.tab?.reason.orEmpty() }
    try {
      return block()
    } finally {
      workspace.activeTabId = foregroundTab?.takeIf { workspace.tabs.containsKey(it) }
      if (foregroundTab != null && workspace.activeTabId == null) {
        workspace.stageVisible = false
        workspace.requestedVisible = false
      }
      currentWorkspace = foreground?.takeIf { workspaces[it.sessionKey] === it }
      lastError = foregroundError
      applyStageBounds()
      applyVisibility()
    }
  }

  private fun targetFailure(target: ControlTarget, reason: String): JSONObject = rejectControl(reason)
    .put("session", target.workspace.sessionKey).put("tabId", target.tab?.id ?: "")

  /** Called only on main, including every asynchronous completion before reading or dispatching. */
  private fun targetProblem(target: ControlTarget, browser: WebView? = null): String? = when {
    workspaces[target.workspace.sessionKey] !== target.workspace -> "browser-session-closed"
    target.tab != null && target.workspace.tabs[target.tab.id] !== target.tab -> "tab-closed"
    browser != null && target.tab?.view !== browser -> "stale-browser-view"
    else -> null
  }

  private fun controlOnMain(target: ControlTarget, block: () -> JSONObject): JSONObject = onMain {
    targetProblem(target)?.let { return@onMain targetFailure(target, it) }
    withModelTarget(target, block)
  } ?: controlTimeout()


  /**
   * 0.14.0：app 退后台时不暂停隔离 WebView——页面是 AI 的工作空间，收起/切后台仍须继续运行
   * （不暂停 JS 定时器）；Activity 销毁仍走 [destroy]。
   */
  fun onActivityPaused() {
    Unit
  }

  /** Resume only this isolated WebView after the owning Activity returns. */
  fun onActivityResumed() {
    onMain {
      view?.onResume()
      val workspace = currentWorkspace
      if (workspace != null && BrowserOverlayPolicy.visible(
          isCurrent = true,
          requestedVisible = workspace.requestedVisible,
          stageVisible = workspace.stageVisible,
          boundsAgeMs = BrowserOverlayPolicy.boundsAge(workspace.boundsAt, SystemClock.uptimeMillis()),
          ttlMs = BrowserOverlayPolicy.STAGE_BOUNDS_TTL_MS,
        )) {
        // Reapply only a live UI lease; foregrounding must never revive a detached stage.
        applyStageBounds()
        view?.requestLayout()
        view?.invalidate()
      } else {
        applyVisibility()
      }
      Unit
    }
  }

  /** Destroy the current page and its renderer; the workbench object stays reusable for a fresh open. */
  fun close(): String = onMain {
    disposeView()
    status().toString()
  } ?: unavailable("main-thread-timeout")

  /** Dispose the isolated renderer with the owning Activity. */
  fun destroy() {
    onMain {
      stageBounds = null
      // 看门狗随 Activity 一起退场（否则它持有的 root/View 引用会泄漏到下一次 attach）。
      root.removeCallbacks(boundsWatchdog)
      root.removeOnLayoutChangeListener(rootLayoutListener)
      // Activity disposal owns every workspace, not just the currently visible session.
      for (workspace in workspaces.values.toList()) dropWorkspace(workspace)
      workspaces.clear()
      currentWorkspace = null
      Unit
    }
  }

  private fun disposeView() {
    // 审查 N-2：看门狗此前只在 destroy() 摘表，disposeView()（close/关最后一页走到）不摘 ⇒
    // browserClose 之后仍每 500ms 唤醒主线程空转。这里补摘（幂等：removeCallbacks 对未挂表是空操作）。
    root.removeCallbacks(boundsWatchdog)
    // browserClose 的语义 = 关闭**当前会话**的工作台（销毁它的全部页面与 renderer）。
    // 复用 dropWorkspace，避免「同一件事两份实现」——早先这里是 dropWorkspace 的重复副本，
    // 改一处漏一处是这类状态的经典回归源。
    // 若此刻还没有任何工作台（从未开过页面），直接返回即可——没有东西需要销毁。
    val closingWorkspace = currentWorkspace
    closingWorkspace?.let { dropWorkspace(it) }
    // Per-tab identity/viewport disappear with the closed workspace, not with its neighbour.
    if (viewerSessionId == closingWorkspace?.sessionKey) viewerSessionId = null
    lastError = closingWorkspace?.profileError.orEmpty()
    if (workspaces.values.any { it.stageVisible || it.requestedVisible }) {
      root.postDelayed(boundsWatchdog, BrowserOverlayPolicy.STAGE_BOUNDS_WATCHDOG_MS)
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun ensureView(): WebView? = ensureViewFor(ensureTab(null))

  /** 为指定标签页创建（或取用）它自己的隔离 WebView；一个 tab 一个 renderer。 */
  @SuppressLint("SetJavaScriptEnabled")
  private fun ensureViewFor(tab: Tab): WebView? {
    activeTabId = tab.id
    val existing = tab.view
    val workspace = requireWorkspace()
    if (existing != null) {
      if (workspace.profileError.isEmpty() && workspace.profile.isAssigned) return existing
      lastError = workspace.profileError.ifEmpty { "browser-profile-not-ready" }
      return null
    }
    val sessionProfile = workspace.profile
    if (!BrowserHostProfile.supported()) {
      workspace.profileError = "browser-profile-unsupported"
      lastError = workspace.profileError
      tab.loadState = "error"
      return null
    }
    // provider 会话中更新/被移除时，WebView() 构造本身会抛——走既有错误通道如实报，
    // 不让浏览器面板的一次打开把壳侧整个崩掉（与 MainActivity 构造守护同一类故障）。
    val created = try {
      WebView(activity)
    } catch (_: Throwable) {
      workspace.profileError = "webview-provider-unavailable"
      lastError = workspace.profileError
      tab.loadState = "error"
      return null
    }
    // FIRST operation on this WebView: assign and verify its session's nonDefault profile.
    // No settings, JS evaluation, bridge, load or root attachment may precede this boundary.
    try {
      sessionProfile.attach(created)
      workspace.profileError = ""
    } catch (failure: BrowserHostProfile.Failure) {
      workspace.profileError = failure.reason
      lastError = failure.reason
      tab.loadState = "error"
      try { created.destroy() } catch (_: Throwable) { /* Never use the failed view. */ }
      return null
    }
    created.apply {
      id = View.generateViewId()
      visibility = View.GONE
      setBackgroundColor(Color.TRANSPARENT)
      // 隔离 WebView 吃「baseline + isolation」两档：版本敏感设置的真源在 WebViewShim。
      // （settings.apply{} 是既有线序钉：profile attach 必须先于任何 settings 配置。）
      settings.apply {
        WebViewShim.applyBaseline(this)
        WebViewShim.applyIsolation(this)
      }
      // 滚动观察（页面真实滚动位置，不注入任何脚本）：驱动可信面板的控件避让与横屏锁定。
      // 回调一律写**本 tab** 的状态（闭包捕获 tab），绝不写「当前活动页」——否则后台页的
      // 加载/滚动事件会把前台页的状态覆盖掉（多页签下的典型错乱）。
      setOnScrollChangeListener { _, _, y, _, oldY ->
        tab.scrollY = y
        val delta = y - oldY
        if (delta > 0) tab.scrollDirection = 1 else if (delta < 0) tab.scrollDirection = -1
      }
      webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
          if (tab.view !== view) return true
          val raw = request.url.toString()
          val target = sessionProfile.normalize(raw)
          if (target == null) {
            tab.reason = "unsupported-url"
            return true
          }
          // Rebuild main-frame GETs too, so canonical policy and the actual load stay identical.
          if (request.isForMainFrame && request.method == "GET" && target != raw) {
            view.loadUrl(target)
            return true
          }
          return false
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
          handler.cancel()
          if (tab.view !== view) return
          // No certificate bypass, even for ordinary loopback HTTPS.
          tab.loadState = "error"
          tab.reason = "ssl-error-cancelled"
        }

        /** Requests use the captured owning profile, never the currently selected workspace. */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
          val url = request.url?.toString().orEmpty()
          val reason = sessionProfile.blockedRequestReason(url)
          if (reason == null) return null
          val count = tab.blockedRequests.incrementAndGet()
          // 前若干条进 logcat（稳定 tag，便于现场 `logcat | grep dsh-browser` 定性）；
          // 之后的只计数——攻击者可控的页面可以刷出成千上万条，日志面不能被它撑爆。
          if (count <= BLOCKED_REQUEST_LOG_LIMIT) {
            android.util.Log.w("dsh-browser", "blocked subresource ($reason): $url")
          }
          return WebResourceResponse(
            "text/plain",
            "utf-8",
            403,
            "Blocked",
            emptyMap(),
            ByteArrayInputStream(ByteArray(0)),
          )
        }

        override fun onPageStarted(view: WebView, startedUrl: String, favicon: android.graphics.Bitmap?) {
          if (tab.view !== view) return
          // 内置错误页守卫（0.14.0 设备实锤的真缺陷）：错误页用 loadDataWithBaseURL(null, ...) 载入，
          // 其文档 URL 是 **about:blank**，**不是** data: ——所以只判 data: 的旧守卫会漏掉它：
          // 错误页的 started/finished 事件随即把 loadState 从 error 覆盖成 loaded、把 url 改成
          // about:blank、并清空 lastError，只剩 title 还留着 ERR_*。
          // 后果：模型拿到 {loadState:loaded, url:about:blank, reason:""}，**无法判断页面已失败**。
          // 判据改为「本 tab 正处于内置错误页」：错误页自身及其 about:blank 事件一律不改状态；
          // 只有真正的新导航（http(s)）才清掉错误标记并推进状态。
          if (tab.errorPageUrl != null && !startedUrl.startsWith("http")) return
          if (startedUrl.startsWith("data:")) return
          tab.generation.incrementAndGet()
          synchronized(tab.refs) { tab.refs.clear() }
          tab.errorPageUrl = null
          tab.url = startedUrl
          tab.title = ""
          tab.loadState = "loading"
          tab.reason = ""
        }

        override fun onPageFinished(view: WebView, finishedUrl: String) {
          if (tab.view !== view) return
          // 同 onPageStarted：内置错误页的完成事件不得覆盖 error 态（其 URL 是 about:blank）。
          if (tab.errorPageUrl != null && !finishedUrl.startsWith("http")) return
          if (finishedUrl.startsWith("data:")) return
          tab.url = finishedUrl
          if (tab.loadState == "loading") tab.loadState = "loaded"
          measurePage(view, tab)
        }

        /**
         * 主帧网络类失败 → 浏览器风格错误页（标题 + 主机 + 原因 + ERR_* + 刷新），
         * 在隔离 WebView 内以 data 页呈现；重试链接是绝对 http(s) URL，不依赖任何桥。
         */
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
          if (tab.view !== view || !request.isForMainFrame) return
          val failing = request.url.toString()
          tab.errorPageUrl = failing
          tab.url = failing
          tab.loadState = "error"
          tab.reason = "load-error:" + error.errorCode
          val html = errorPageHtml(failing, error.errorCode, error.description?.toString() ?: "")
          view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
          if (tab.view !== view) return true
          tab.generation.incrementAndGet()
          tab.snapshotGeneration = -1L
          releaseTabScripts(tab)
          tab.reason = if (detail.didCrash()) "renderer-crashed" else "renderer-killed"
          root.removeView(view)
          view.destroy()
          if (tab.view === view) tab.view = null
          synchronized(tab.refs) { tab.refs.clear() }
          return true
        }
      }
      webChromeClient = object : WebChromeClient() {
        override fun onReceivedTitle(view: WebView, pageTitle: String?) {
          if (tab.view !== view) return
          tab.title = pageTitle ?: ""
        }
      }
    }
    root.addView(created, FrameLayout.LayoutParams(1, 1))
    tab.view = created
    applyIdentityToView(created)
    appliedViewport = requestedViewport
    // 覆盖层在场之后才需要看门狗：它守的是「发布者已经不在场」这件事（见 boundsWatchdog）。
    root.removeCallbacks(boundsWatchdog)
    root.postDelayed(boundsWatchdog, BrowserOverlayPolicy.STAGE_BOUNDS_WATCHDOG_MS)
    applyStageBounds()
    return created
  }

  /** Recalculate the native overlay after either trusted bounds or the root geometry changes. */
  private fun applyStageBounds() {
    val bounds = stageBounds
    val cssWidth = bounds?.viewportWidth ?: 0.0
    val cssHeight = bounds?.viewportHeight ?: 0.0
    if (bounds == null || !bounds.visible || cssWidth <= 0.0 || cssHeight <= 0.0 ||
      bounds.width <= 1.0 || bounds.height <= 1.0 || root.width <= 0 || root.height <= 0 ||
      dshWebView.width <= 0 || dshWebView.height <= 0
    ) {
      // **没有可用舞台 ≠ 页面可以不排版**（0.14.0 模拟器实锤的严重缺陷）。
      //
      // 缺陷形态：侧栏收起时前端把 bounds.visible 置 false，本函数原来直接 return——WebView 保持
      // 上一次的尺寸甚至 GONE，于是**页面自身布局盒变成 0×0**：
      //   document.body.getBoundingClientRect() → width=1100 height=0
      //   window.innerWidth/innerHeight          → 0 / 0
      //   window.visualViewport                  → 0×0
      // 后果不是「画面不好看」，而是**模型侧读页面全线残废**：真实站点（B 站）191 个可交互元素里
      // 绝大多数被 `r.width < 1 || r.height < 1` 判掉，browser_snapshot 只回 1 个节点，
      // browser_click/browser_type 因此无从下手。实测 7 次 snapshot 全部拿不到搜索框。
      //
      // 语义依据（用户口径）：UI 是给用户看的，**AI 的工作面必须独立于 UI 是否可见**。
      // 人把侧栏收起来，不该让 AI 的浏览器瞎掉。
      //
      // 修法：舞台不可见时，仍按**上一次已知的舞台尺寸**（或该档位 CSS 视口）给 WebView 一个
      // 非退化的排版尺寸，只把「绘制」关掉（INVISIBLE）——页面继续有真实布局盒，原生层不再覆盖 UI。
      stageVisible = false
      layoutDetached()
      applyVisibility()
      return
    }
    val scaleX = dshWebView.width.toDouble() / cssWidth
    val scaleY = dshWebView.height.toDouble() / cssHeight
    val left = (bounds.left * scaleX).toInt().coerceIn(0, (root.width - 1).coerceAtLeast(0))
    val top = (bounds.top * scaleY).toInt().coerceIn(0, (root.height - 1).coerceAtLeast(0))
    val stageWidth = (bounds.width * scaleX).toInt().coerceIn(1, (root.width - left).coerceAtLeast(1))
    val stageHeight = (bounds.height * scaleY).toInt().coerceIn(1, (root.height - top).coerceAtLeast(1))
    val desired = requestedViewport
    // 分辨率预设 = CSS 视口（SPEC §1.2）：通过覆盖隔离 WebView 的 density 只缩放一次。
    //   fitScale     = min(stageW/(cssW*baseDensity), stageH/(cssH*baseDensity), 1)
    //   视口脚本注入 `width=<cssW>`（document-start），WebView 自动把该宽度适配到物理宽
    //   k = min(stageW/cssW, stageH/cssH, baseDensity)（每 CSS px 物理像素数，封顶原生 density）
    //   物理矩形 = cssW*k × cssH*k（居中 letterbox，不拉伸）
    //   ⇒ window.innerWidth == cssW、window.innerHeight == cssH、dpr == k
    // 分辨率变化由调用方注入脚本后重载；舞台变化只改 k/居中，不重载、不重建。
    val baseDensity = dshWebView.resources.displayMetrics.density.coerceAtLeast(0.5f)
    val pageCssWidth = desired?.width?.toDouble() ?: stageWidth.toDouble()
    val pageCssHeight = desired?.height?.toDouble() ?: stageHeight.toDouble()
    val factor = if (desired == null) 1.0 else minOf(
      stageWidth.toDouble() / pageCssWidth,
      stageHeight.toDouble() / pageCssHeight,
      baseDensity.toDouble(),
    ).coerceAtLeast(0.05)
    val width = if (desired == null) stageWidth else Math.round(pageCssWidth * factor).toInt()
    val height = if (desired == null) stageHeight else Math.round(pageCssHeight * factor).toInt()
    val positionedLeft = left + (stageWidth - width) / 2
    val positionedTop = top + (stageHeight - height) / 2
    // 记下这块「用户刚见过」的舞台尺寸，供收起态排版兜底（见 lastStageSize 说明）。
    lastStageSize = width.coerceAtLeast(1) to height.coerceAtLeast(1)
    val existing = view?.layoutParams as? FrameLayout.LayoutParams
    if (existing == null || existing.width != width || existing.height != height ||
      existing.leftMargin != positionedLeft || existing.topMargin != positionedTop
    ) {
      view?.layoutParams = FrameLayout.LayoutParams(width.coerceAtLeast(1), height.coerceAtLeast(1)).apply {
        leftMargin = positionedLeft
        topMargin = positionedTop
      }
    }
    stageVisible = true
    applyVisibility()
    // A repeated live lease can be the only signal after a renderer/surface stops drawing.
    // Invalidate the visible native surface without forcing a layout pass on every renewal.
    if (stageVisible) view?.invalidate()
  }

  /** 读取页面自报视口（诊断 + 设备断言）；失败保留上一次值。 */
  private fun measurePage(browser: WebView, tab: Tab) {
    val measuredGeneration = tab.generation.get()
    browser.evaluateJavascript(
      "(function(){return JSON.stringify({w:window.innerWidth||0,h:window.innerHeight||0,dpr:window.devicePixelRatio||0})})()",
    ) { raw ->
      if (tab.view !== browser || tab.generation.get() != measuredGeneration) return@evaluateJavascript
      val value = decodeJsObject(raw) ?: return@evaluateJavascript
      tab.pageWidth = value.optInt("w", tab.pageWidth)
      tab.pageHeight = value.optInt("h", tab.pageHeight)
      tab.pageDevicePixelRatio = value.optDouble("dpr", tab.pageDevicePixelRatio)
    }
  }

  /**
   * 原生覆盖层可见性：**只看当前工作台自己的意愿与舞台是否在场**。
   *
   * 原先还有一条 foreignViewer 判定（「呈现面会话 ≠ 归属会话就不显示」）——那是归属锁的配套，
   * 随按会话隔离一并移除：现在切到哪个会话就显示哪个会话的工作台，别的会话的页面根本不在场上。
   */
  private fun applyVisibility() {
    // **关键**：必须遍历**全部工作台**，把非当前会话的页面一律 GONE。
    // 只处理当前工作台的 `view` 是不够的——别的会话的 WebView 仍然 attach 在 root 上且可见，
    // 那正是用户要求消除的「跨对话互相看见」。切到哪个会话，就只有那个会话的页面在场。
    val current = currentWorkspace
    val now = SystemClock.uptimeMillis()
    for (workspace in workspaces.values) {
      // 判据 = 当前位置 ∧ 调用方意愿 ∧ 最近一次舞台判定 ∧ **发布者仍在场**（保鲜期）。
      // 前三项都是粘滞记忆态，只有第四项能把「组件已经卸载、没人再来下推」这件事反映出来；
      // 缺了它就会出现没有任何 UI 所有者、用户收起侧栏也撤不掉的幽灵覆盖层（用户实报）。
      val visible = BrowserOverlayPolicy.visible(
        isCurrent = workspace === current,
        requestedVisible = workspace.requestedVisible,
        stageVisible = workspace.stageVisible,
        boundsAgeMs = BrowserOverlayPolicy.boundsAge(workspace.boundsAt, now),
        ttlMs = BrowserOverlayPolicy.STAGE_BOUNDS_TTL_MS,
      )
      for (tab in workspace.tabs.values) {
        // **INVISIBLE 而不是 GONE**（0.14.0 模拟器实锤）：
        // GONE 的 View 不参与布局 → WebView 内页面拿不到布局盒（innerWidth/innerHeight = 0），
        // 模型侧的 snapshot/click/type 全部失效；INVISIBLE **保留布局**、只是不绘制。
        // 两者对用户的观感完全一致（都不会盖在聊天界面上），但对 AI 的可读性是「全有 vs 全无」。
        tab.view?.visibility = if (visible && tab.id == workspace.activeTabId) View.VISIBLE else View.INVISIBLE
      }
    }
  }

  /**
   * 保鲜看门狗：记忆态说自己可见、但保鲜期内没有任何新下推时，**立刻停画**。
   *
   * 为什么必须是个"主动"的定时器：`applyVisibility()` 只在有事件时被调用，而"发布者消失"
   * 本身不产生任何事件（组件卸载、工具进程被回收、页面崩掉、别的会话抢走当前工作台……）。
   * 没有这个看门狗，粘滞的 `stageVisible` 可以永久把 WebView 留在屏幕上——
   * 那正是用户 2026-09-19 实报「收起侧边栏浏览器不卸载」的存活条件。
   *
   * 代价：每 [BrowserOverlayPolicy.STAGE_BOUNDS_WATCHDOG_MS] 一次主线程空转（绝大多数拍
   * `stageVisible` 为 false 或保鲜期内，直接跳过），相比"永久盖住聊天界面"可以忽略。
   */
  private val boundsWatchdog = object : Runnable {
    override fun run() {
      val workspace = currentWorkspace
      if (workspace != null) {
        val age = BrowserOverlayPolicy.boundsAge(workspace.boundsAt, SystemClock.uptimeMillis())
        if (BrowserOverlayPolicy.shouldDropStaleStage(
            stageVisible = workspace.stageVisible,
            boundsAgeMs = age,
            ttlMs = BrowserOverlayPolicy.STAGE_BOUNDS_TTL_MS,
          )
        ) {
          // 停画但**保留排版**：AI 的工作面独立于 UI 是否可见（0.14.0 既有口径）。
          workspace.stageVisible = false
          applyVisibility()
        }
      }
      // 审查 N-2：没有工作台（或没有可见工作台）时不再自续 —— 看门狗守的是「发布者已不在场」，
      // 而「一个页面都没有」不产生任何停画决策；继续每 500ms 唤醒主线程只是纯开销。
      val stillNeeded = workspaces.values.any { it.stageVisible || it.requestedVisible }
      if (stillNeeded) root.postDelayed(this, BrowserOverlayPolicy.STAGE_BOUNDS_WATCHDOG_MS)
    }
  }

  /**
   * 舞台不可见时给当前工作台的 WebView 一个**非退化的排版尺寸**，保证页面布局盒真实存在。
   *
   * 尺寸取值优先级：① 上一次已知的舞台尺寸（用户刚见过的那块，最贴合其预期）；
   * ② 该会话请求的分辨率档（若设过）；③ 兜底用原生 WebView 自身的可用宽高。
   * 这是「后台工作面」的物理矩形，与「可见舞台」解耦——它不进 UI，也不参与点击坐标换算
   * （后者始终由阶段 bounds 下推的真实舞台决定）。
   */
  private fun layoutDetached() {
    val browser = view ?: return
    // 尺寸优先级（越靠前越贴合「用户/AI 预期的那块画布」）：
    //   ① 用户刚见过的舞台尺寸；② 显式请求的分辨率档（browser_set_viewport 的物理像素）；
    //   ③ 主 UI WebView 的可用尺寸（= 手机可用视口，最合理的通用兜底）；④ 640x960 常量兜底。
    //
    // **为什么必须有兜底**（0.14.0 模拟器实锤的 P0）：WebView 建页时是按
    // `root.addView(created, FrameLayout.LayoutParams(1, 1))` 挂上去的，只有
    // `applyStageBounds()` 走到「舞台可见」那一支才会被改成真实矩形。模型在**用户侧栏收起**时
    // 调 browser_open（这是常态——AI 干活时人未必看着），舞台永远不可见 → 页面停在 1×1 →
    // `window.innerWidth/innerHeight = 0`、`document.documentElement` 矩形 0×0，
    // 于是真实站点里 `getBoundingClientRect()` 全为 0，browser_snapshot 只回 1 个节点，
    // browser_click/type 无从下手。实测 B 站页面 191 个可交互元素全部被 `r.width < 1` 判掉。
    val preset = requestedViewport
    val stage = lastStageSize
    val uiW = dshWebView.width.coerceAtLeast(1)
    val uiH = dshWebView.height.coerceAtLeast(1)
    val w = (stage?.first ?: preset?.width ?: uiW.coerceAtLeast(320)).coerceAtLeast(1)
    val h = (stage?.second ?: preset?.height ?: uiH.coerceAtLeast(480)).coerceAtLeast(1)
    val lp = browser.layoutParams as? FrameLayout.LayoutParams
    if (lp != null && lp.width == w && lp.height == h) return
    browser.layoutParams = FrameLayout.LayoutParams(w, h)
  }

  private fun status(): JSONObject {
    val density = dshWebView.resources.displayMetrics.density.coerceAtLeast(0.5f)
    val isolationAvailable = BrowserHostProfile.supported() && currentWorkspace?.profileError.isNullOrEmpty()
    return JSONObject()
      .put("ok", isolationAvailable)
      .put("available", isolationAvailable)
      .put("profileAvailable", isolationAvailable && currentWorkspace?.profile?.isAssigned == true)
      .put("profileReason", currentWorkspace?.profileError.orEmpty().ifEmpty { if (currentWorkspace?.profile?.isAssigned == true) "" else if (isolationAvailable) "browser-profile-not-ready" else "browser-profile-unsupported" })
      .put("session", currentWorkspace?.sessionKey ?: "")
      .put("multiProfileSupported", BrowserHostProfile.supported())
      .put("profileIsolation", if (currentWorkspace?.profile?.isAssigned == true) "isolated" else if (isolationAvailable) "not-created" else "unavailable")
      .put("profileName", currentWorkspace?.profile?.takeIf { it.isAssigned }?.name ?: "")
      .put("created", view != null)
      .put("visible", view?.visibility == View.VISIBLE)
      .put("url", url)
      .put("title", title)
      .put("loadState", loadState)
      .put("pageGeneration", generation.get())
      .put("canGoBack", view?.canGoBack() == true)
      .put("canGoForward", view?.canGoForward() == true)
      .put("identityId", identityId)
      // 会话标识改为「当前工作台的会话」：每个会话各有自己的页面与代次，不再是全局归属。
      .put("ownerSessionId", currentWorkspace?.sessionKey ?: "")
      .put("scrollY", scrollY)
      .put("scrollDirection", scrollDirection)
      .put("atTop", scrollY <= 0)
      .put("viewportId", requestedViewport?.id ?: "device")
      .put("viewportWidth", requestedViewport?.width ?: (dshWebView.width / density).toInt())
      .put("viewportHeight", requestedViewport?.height ?: (dshWebView.height / density).toInt())
      .put("pageWidth", pageWidth)
      .put("pageHeight", pageHeight)
      .put("pageDevicePixelRatio", pageDevicePixelRatio)
      .put("tabId", activeTabId ?: "")
      .put("tabs", tabSummaries())
      .put("tabCount", tabs.size)
      // 请求级过滤计数（审查 S-4）：非 0 表示本页有子资源被拒（模型/面板据此知道「页面少了东西」）。
      .put("blockedRequests", activeTab()?.blockedRequests?.get() ?: 0)
      .put("serviceWorkerBlockedRequests", currentWorkspace?.profile?.serviceWorkerBlockedRequests?.get() ?: 0)
      .put("reason", activeTab()?.reason?.takeIf { it.isNotEmpty() } ?: lastError.ifEmpty { if (!isolationAvailable) currentWorkspace?.profileError?.takeIf { it.isNotEmpty() } ?: "browser-profile-unsupported" else "" })
  }

  private fun rejected(reason: String): String = status().put("ok", false).put("reason", reason).toString()

  private fun unavailable(reason: String): String = JSONObject()
    .put("ok", false)
    .put("available", false)
    .put("created", false)
    .put("visible", false)
    .put("url", "about:blank")
    .put("title", "")
    .put("pageGeneration", generation.get())
    .put("canGoBack", false)
    .put("canGoForward", false)
    .put("reason", reason)
    .toString()

  /** Isolation is established before this helper can admit any address. */
  private fun normalizeUrl(raw: String?): String? = currentWorkspace?.profile?.normalize(raw)

  /** 浏览器风格错误页（无脚本、无桥；重试链接为绝对 http(s) URL）。 */
  private fun errorPageHtml(failedUrl: String, code: Int, description: String): String {
    val names = mapOf(
      -1 to "ERR_FAILED", -2 to "ERR_NAME_NOT_RESOLVED", -3 to "ERR_ABORTED",
      -4 to "ERR_AUTHENTICATION", -5 to "ERR_PROXY_AUTHENTICATION", -6 to "ERR_CONNECTION_REFUSED",
      -7 to "ERR_IO", -8 to "ERR_TIMED_OUT", -9 to "ERR_REDIRECT_LOOP", -10 to "ERR_UNSUPPORTED_SCHEME",
      -11 to "ERR_SSL_PROTOCOL_ERROR", -12 to "ERR_BAD_URL", -13 to "ERR_FILE_NOT_FOUND",
      -14 to "ERR_FILE_ACCESS_DENIED", -15 to "ERR_TOO_MANY_REQUESTS", -16 to "ERR_UNSAFE_RESOURCE",
    )
    val name = names[code] ?: "ERR_FAILED"
    val host = try { java.net.URI(failedUrl).host ?: failedUrl } catch (_: Throwable) { failedUrl }
    val reason = description.ifBlank { "无法访问该页面。" }
    fun esc(text: String): String = text
      .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
    return """
<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)}</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1b1b1f;color:#e8e8ea;font:16px/1.6 system-ui,sans-serif}
main{max-width:420px;padding:32px 24px}h1{font-size:22px;margin:0 0 12px}
p{margin:0 0 8px;color:#b9b9c0}code{color:#8f8f98;font-size:13px}
a{display:inline-block;margin-top:16px;padding:10px 20px;border-radius:8px;background:#3d6bff;color:#fff;text-decoration:none}
@media (prefers-color-scheme: light){body{background:#f5f5f7;color:#1b1b1f}p{color:#5f5f66}code{color:#8a8a92}}
</style></head><body><main>
<h1>嗯… 无法访问此页面</h1>
<p><strong>${esc(host)}</strong> ${esc(reason)}</p>
<p><code>${esc(name)}</code></p>
<a href="${esc(failedUrl)}">刷新</a>
</main></body></html>
    """.trimIndent()
  }

  // ── capability + navigation ops ───────────────────────────────────────────

  private fun caps(): JSONObject {
    val versionText = WebViewShim.providerVersionName()
    val chromiumVersion = WebViewShim.chromiumVersionFromUserAgent(dshWebView.settings.userAgentString.orEmpty())
    val major = WebViewShim.majorOf(chromiumVersion).takeIf { it > 0 } ?: -1
    val metrics = dshWebView.resources.displayMetrics
    val documentStart = WebViewShim.supports(WebViewFeature.DOCUMENT_START_SCRIPT)
    val uaCh = WebViewShim.supports(WebViewFeature.USER_AGENT_METADATA)
    val multiProfile = BrowserHostProfile.supported()
    val isolationAvailable = multiProfile && currentWorkspace?.profileError.isNullOrEmpty()
    return JSONObject()
      .put("ok", isolationAvailable)
      .put("available", isolationAvailable)
      .put("multiProfileSupported", multiProfile)
      .put("profileIsolationRequired", true)
      .put("defaultProfileFallback", false)
      .put("completeBrowsingDataClearAvailable", false)
      .put("reason", if (isolationAvailable) "" else currentWorkspace?.profileError?.takeIf { it.isNotEmpty() } ?: "browser-profile-unsupported")
      .put("webviewMajor", major)
      .put("webviewVersion", versionText)
      .put("uaChAvailable", uaCh)
      .put("androidxWebkitCompiled", true)
      .put("androidxWebkitAvailable", documentStart || uaCh)
      .put("documentStartScript", documentStart)
      .put("densityOverrideSupported", false)
      .put("screenWidth", metrics.widthPixels)
      .put("screenHeight", metrics.heightPixels)
      .put("densityDpi", metrics.densityDpi)
      .put("rendererProcesses", 0)
      .put("browserWebViewAvailable", isolationAvailable)
      .put("cdpEnabled", false)
      .put("viewportId", requestedViewport?.id ?: "device")
      .put("surface", "browser")
  }

  /** Validate all private open options before creating/configuring a tab or loading any URL. */
  private fun openConfigProblem(args: JSONObject): String? {
    if (args.has("viewportConfig")) {
      val config = args.optJSONObject("viewportConfig") ?: return "invalid-viewport"
      val preset = config.opt("preset") as? String ?: return "invalid-viewport"
      if (preset.isBlank() || preset.length > 48) return "invalid-viewport"
      val width = (config.opt("width") as? Number)?.toDouble() ?: return "invalid-viewport"
      val height = (config.opt("height") as? Number)?.toDouble() ?: return "invalid-viewport"
      if (!width.isFinite() || !height.isFinite() || width != width.toInt().toDouble() || height != height.toInt().toDouble()) return "invalid-viewport"
      if (preset != "device" && (width.toInt() !in 240..3840 || height.toInt() !in 240..3840)) {
        return "invalid-viewport"
      }
    }
    if (args.has("identityConfig")) {
      val config = args.optJSONObject("identityConfig") ?: return "invalid-identity"
      val profile = config.opt("profile") as? String ?: return "invalid-identity"
      if (profile !in setOf("android-real", "linux-desktop", "windows-desktop")) return "invalid-identity"
      if (config.has("ua") && (config.opt("ua") !is String || config.optString("ua").length > 512)) return "invalid-identity"
    }
    return null
  }

  private fun navigateOp(args: JSONObject, captured: ControlTarget): JSONObject {
    openConfigProblem(args)?.let { return targetFailure(captured, it) }
    val raw = args.optString("url", "")
    if (raw.length > 16_384 || BrowserHostNavigationPolicy.normalize(
        raw, isolatedProfile = true, allowAnonymousEngineAccess = allowAnonymousEngineAccess,
      ) == null) return targetFailure(captured, "unsupported-url")
    val requestedTabId = args.optString("tabId", "").takeIf { it.isNotBlank() }
    val wantsNewTab = args.optBoolean("newTab", false)
    var navigationTarget: ControlTarget? = null
    val started = controlOnMain(captured) {
      val workspace = captured.workspace
      val newTab = (wantsNewTab && requestedTabId == null) ||
        (requestedTabId != null && !tabs.containsKey(requestedTabId))
      if (newTab && tabs.size >= MAX_TABS) {
        return@controlOnMain targetFailure(captured, "tab-limit")
          .put("guidance", "同时打开的页面已达上限（$MAX_TABS）；先 browser_close_tab 关掉不再需要的页。")
          .put("tabs", tabSummaries())
      }
      val tab = if (wantsNewTab && requestedTabId == null) {
        var candidate: String
        do { candidate = "tab-" + nextTabSeq++ } while (tabs.containsKey(candidate))
        ensureTab(candidate)
      } else ensureTab(requestedTabId)
      activeTabId = tab.id
      navigationTarget = ControlTarget(workspace, tab)
      val cold = tab.view == null
      val viewport = args.optJSONObject("viewportConfig")
      val identity = args.optJSONObject("identityConfig")
      val nextViewport = if (viewport == null) tab.requestedViewport else {
        val preset = viewport.optString("preset")
        if (preset == "device") null else RequestedViewport(preset, viewport.optInt("width"), viewport.optInt("height"))
      }
      val nextIdentity = identity?.optString("profile") ?: tab.identityId
      val nextUa = if (identity == null) tab.identityUa else identityUaFor(nextIdentity, identity.optString("ua", ""))
      val reconfigure = nextViewport != tab.requestedViewport || nextIdentity != tab.identityId || nextUa != tab.identityUa
      tab.requestedViewport = nextViewport
      tab.identityId = nextIdentity
      tab.identityUa = nextUa
      // Rebuild at most once. Never replay the previous URL/form before the requested navigation.
      if (reconfigure && tab.view != null) recycleView(reloadPreviousUrl = false)
      val browser = ensureViewFor(tab) ?: return@controlOnMain status().put("ok", false)
      val normalized = workspace.profile.normalize(raw) ?: return@controlOnMain status().put("ok", false)
        .put("reason", "unsupported-url")
      workspace.modelTabId = tab.id
      invalidateNavigation(tab)
      tab.url = normalized
      val before = tab.generation.get()
      browser.loadUrl(normalized)
      JSONObject().put("__go", true).put("__before", before).put("__cold", cold)
    }
    if (!started.optBoolean("__go", false)) return started
    val target = navigationTarget ?: return controlTimeout()
    val tab = target.tab ?: return targetFailure(target, "tab-not-found")
    // Only captured atomic generation is read off-main; callbacks/status use this same Session/tab.
    awaitNavigation(tab, started.optLong("__before", 0L), if (started.optBoolean("__cold", false)) 10_000L else 2_500L)
    return controlOnMain(target) { status() }
  }

  /**
   * 等一次导航「开始」（页代次前进），供 browser_open 返回**导航后**的状态。
   *
   * 为什么必须有：loadUrl() 立即返回，而 onPageStarted/onPageFinished 是异步回调——紧接着调
   * status() 读到的还是上一页（新页则是 about:blank + 代次 0）。设备实测：模型因此以为
   * 「导航还没完成」，甚至去猜「工具默认先开空白页」（Agent 原话），可能触发重复导航。
   *
   * 只等「代次前进」，**不等整页加载完**：慢站点不应拖住控制队列；常规上限 2.5s、冷启动新页 10s，
   * 如实返回（loadState 仍为 loading，模型可自行决定要不要继续 browser_wait）。
   */
  private fun awaitNavigation(tab: Tab, before: Long, budgetMs: Long = 2_500L) {
    val deadline = SystemClock.elapsedRealtime() + budgetMs
    while (SystemClock.elapsedRealtime() < deadline) {
      if (tab.generation.get() > before) return
      try { Thread.sleep(40) } catch (_: InterruptedException) { return }
    }
  }

  private fun viewportOp(args: JSONObject, target: ControlTarget): JSONObject {
    val route = args.optString("route", "S2")
    val preset = args.optString("preset", "").take(48)
    if (preset == "device") {
      return controlOnMain(target) {
        val tab = ensureTab(null)
        target.workspace.modelTabId = tab.id
        val changed = requestedViewport != null
        requestedViewport = null
        if (changed && view != null) recycleView() else applyStageBounds()
        status().put("route", route).put("width", 0).put("height", 0)
      }
    }
    val width = args.optInt("width", 0)
    val height = args.optInt("height", 0)
    if (width !in 240..3840 || height !in 240..3840) {
      return JSONObject().put("ok", false).put("reason", "invalid-viewport")
    }
    val id = preset.ifBlank { "$width x $height" }
    return controlOnMain(target) {
      val tab = ensureTab(null)
      target.workspace.modelTabId = tab.id
      val next = RequestedViewport(id, width, height)
      val changed = next != appliedViewport
      requestedViewport = next
      if (changed && view != null) recycleView() else applyStageBounds()
      status().put("route", route).put("width", width).put("height", height)
    }
  }

  private fun identityOp(args: JSONObject, target: ControlTarget): JSONObject = controlOnMain(target) {
    identityApply(args).also { if (it.optBoolean("ok")) target.workspace.modelTabId = activeTabId }
  }

  /** Apply one identity profile; shared by the control op and the trusted panel's PC/mobile toggle. */
  fun identity(raw: String): String = onMain {
    try {
      val args = JSONObject(raw)
      withUiTarget(args) { identityApply(args) }.toString()
    } catch (_: Throwable) { rejected("invalid-identity") }
  } ?: unavailable("main-thread-timeout")

  private fun identityApply(args: JSONObject): JSONObject {
    ensureTab(null)
    val profile = args.optString("profile", "android-real").take(32)
    val ua = args.optString("ua", "").take(512)
    // 身份/视口记在目标 tab，仍支持先设身份再建 WebView；不能串到其它 tab/Session。
    //
    // 缺陷形态（用户 2026-09-17 实报）：`browser_open { identity: "linux-desktop" }` 恒失败
    // `browser-not-created`。真因是这里的 `view ?:` 前置守卫——它排在状态赋值**之前**，
    // 于是「还没有页面」时不但不重建，连身份都没记下；而 browser_open 的正常流程恰恰是
    // **先设身份/视口、再开页**，第一个人用这个参数必然撞上。
    //
    // 正确语义：没有页面时**先记下状态**（建页时由 ensureViewFor → applyIdentityToView 与
    // requestedViewport 统一应用），只有「需要重建现有页面」时才要求 view 在场。
    // 这样既修好首个调用的失败，也避免「先建页再设身份」带来的多余重载。
    // PC / 手机切换 = 身份 + 该模式记忆分辨率 + 一次重载（SPEC §1.2）。
    val width = args.optInt("width", 0)
    val height = args.optInt("height", 0)
    val preset = args.optString("preset", "").take(48)
    if (width in 240..3840 && height in 240..3840) {
      requestedViewport = RequestedViewport(preset.ifBlank { "$width x $height" }, width, height)
    } else if (preset == "device") {
      requestedViewport = null
    }
    val nextUa = identityUaFor(profile, ua)
    val changed = profile != identityId || nextUa != identityUa || requestedViewport != appliedViewport
    identityId = profile
    identityUa = nextUa
    if (view == null) {
      // 页面尚未建立：状态已记下，建页时按此应用（不报错、不假装已应用脚本）。
      return identityResult(profile, false, false)
    }
    if (changed) {
      // document-start 脚本只在新建 WebView 时注册（当前实现无法可靠替换），故重建一次。
      recycleView()
    } else {
      applyStageBounds()
    }
    if (!currentWorkspace?.profileError.isNullOrEmpty()) return status().put("ok", false)
    val reloaded = url != "about:blank"
    return identityResult(profile, identityScriptHandler != null, reloaded)
  }

  private fun identityUaFor(profile: String, ua: String): String = if (profile == "android-real") "" else ua.ifBlank {
    WebSettings.getDefaultUserAgent(activity)
      .replace(Regex("\\(Linux; Android[^)]*\\)"),
        if (profile == "windows-desktop") "(Windows NT 10.0; Win64; x64)" else "(X11; Linux x86_64)")
      .replace("; wv", "").replace(" Version/4.0", "").replace(" Mobile", "")
  }

  private fun identityResult(profile: String, scriptApplied: Boolean, reloaded: Boolean): JSONObject {
    val uaChApplied = activeTab()?.uaChApplied == true && profile != "android-real"
    return JSONObject().put("ok", true).put("profile", profile).put("applied", true)
      .put("uaChApplied", uaChApplied).put("scriptApplied", scriptApplied)
      .put("viewportId", requestedViewport?.id ?: "device").put("reloaded", reloaded)
      .put("degraded", if (uaChApplied) "" else
        "ua-ch-unavailable：本机 WebView 不支持 UA-CH 覆写；已应用 UA 串 + document-start 身份脚本（platform/触摸/屏幕，指纹可检出）。")
  }

  /** 组合 document-start 注入：视口宽度（预设生效时）+ 桌面身份覆盖；安卓档/无预设时对应段为空。 */
  private fun releaseTabScripts(tab: Tab) {
    tab.docStartHandlers.forEach { try { it.remove() } catch (_: Throwable) { /* View may already be gone. */ } }
    tab.docStartHandlers.clear()
    tab.identityScriptHandler = null
  }

  private fun applyDocumentStartScript(browser: WebView) {
    activeTab()?.let { releaseTabScripts(it) }
    if (!WebViewShim.supports(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    val preset = requestedViewport
    if (preset != null) addDocStart(browser, viewportScript(preset.width))
    if (identityId != "android-real") identityScriptHandler = addDocStart(browser,
      IDENTITY_JS.replace("Linux x86_64", if (identityId == "windows-desktop") "Win32" else "Linux x86_64"))
  }

  private fun addDocStart(browser: WebView, script: String): ScriptHandler? = try {
    WebViewCompat.addDocumentStartJavaScript(browser, script, setOf("*")).also { docStartHandlers.add(it) }
  } catch (_: Throwable) {
    null
  }

  /**
   * 销毁并按当前预设/身份重建隔离 WebView 后重放 URL。
   * document-start 脚本无法可靠替换（旧脚本会继续生效），故视口或身份变化一律重建。
   */
  private fun recycleView(reloadPreviousUrl: Boolean = true) {
    val browser = view ?: return
    val reloadTarget = url.takeIf { reloadPreviousUrl && it != "about:blank" }
    recycling = true
    try {
      // 重建当前**活动**标签页自己的 WebView；其它页不受影响（多页签）。
      val tab = activeTab()
      tab?.let { releaseTabScripts(it) }
      root.removeView(browser)
      browser.destroy()
      tab?.view = null
      tab?.let {
        synchronized(it.refs) { it.refs.clear() }
        it.snapshotGeneration = -1L
        it.generation.incrementAndGet()
        it.loadState = "idle"
        val next = ensureViewFor(it)
        if (next != null && reloadTarget != null) normalizeUrl(reloadTarget)?.let { next.loadUrl(it) }
      }
    } finally {
      recycling = false
    }
    applyVisibility()
  }

  /** 把当前身份（UA 串 / UA-CH / document-start 脚本）套用到指定 WebView，供每次创建与切换复用。 */
  private fun applyIdentityToView(browser: WebView) {
    browser.settings.userAgentString = if (identityId == "android-real" || identityUa.isBlank()) null else identityUa
    activeTab()?.uaChApplied = applyUserAgentMetadata(browser, identityId)
    applyDocumentStartScript(browser)
  }

  /** 视口注入脚本：在页面任何脚本之前把 viewport 固定为请求的 CSS 宽（document-start）。 */
  private fun viewportScript(width: Int): String = """
    (function(){
      var W = $width;
      var C = 'width=' + W + ', user-scalable=no';
      function fixViewport(){
        try {
          var metas = document.querySelectorAll('meta[name="viewport"]');
          if (metas.length > 0) {
            for (var i = 0; i < metas.length; i++) {
              if (metas[i].getAttribute('content') !== C) metas[i].setAttribute('content', C);
            }
            var head = document.head;
            if (head) {
              for (var j = 0; j < metas.length; j++) {
                if (metas[j].parentNode !== head) { head.insertBefore(metas[j], head.firstChild); break; }
              }
            }
            return true;
          }
          var target = document.head || document.documentElement;
          if (!target) return false;
          var m = document.createElement('meta');
          m.setAttribute('name', 'viewport');
          m.setAttribute('content', C);
          target.insertBefore(m, target.firstChild);
          return true;
        } catch (e) { return true; }
      }
      fixViewport();
      var o = new MutationObserver(function(){ fixViewport(); });
      o.observe(document, {childList: true, subtree: true});
      setTimeout(function(){ o.disconnect(); }, 3000);
    })()
  """.trimIndent()

  /** WebView >= 116 时同批设置 UA-CH（与 UA 串脱钩会让站点判定分裂）；本机不支持则如实返回 false。 */
  private fun applyUserAgentMetadata(browser: WebView, profile: String): Boolean {
    if (profile == "android-real" || !WebViewShim.supports(WebViewFeature.USER_AGENT_METADATA)) return false
    // Metadata follows the applied UA, not an unrelated provider package version.
    val versionText = WebViewShim.chromiumVersionFromUserAgent(browser.settings.userAgentString.orEmpty())
    if (versionText.isEmpty()) return false
    // UA 不含可验证的 Chromium 版本时不伪造 UA-CH 元数据。
    val major = WebViewShim.majorOf(versionText).takeIf { it > 0 }?.toString() ?: ""
    return try {
      val metadata = UserAgentMetadata.Builder()
        .setBrandVersionList(listOf(UserAgentMetadata.BrandVersion.Builder()
          .setBrand("Chromium").setMajorVersion(major).setFullVersion(versionText).build()))
        .setFullVersion(versionText)
        .setPlatform(if (profile == "windows-desktop") "Windows" else "Linux")
        .setPlatformVersion("")
        .setArchitecture("x86")
        .setModel("")
        .setMobile(false)
        .setBitness(64)
        .setWow64(false)
        .build()
      WebSettingsCompat.setUserAgentMetadata(browser.settings, metadata)
      true
    } catch (_: Throwable) {
      false
    }
  }

  // ── 多页签 ops（0.14.0：AI 用工具直接管多网页，UI 只是给人看的视图）────────

  /** 列出全部标签页 + 当前活动页。 */
  private fun listTabsOp(): JSONObject = JSONObject()
    .put("ok", true)
    .put("tabs", tabSummaries())
    .put("activeTabId", activeTabId ?: "")
    .put("tabCount", tabs.size)

  /** 切换活动标签页（不新建、不销毁）。 */
  private fun followTabOp(args: JSONObject): JSONObject {
    val id = args.optString("tabId", "")
    val tab = tabOrNull(id)
      ?: return JSONObject().put("ok", false).put("reason", "tab-not-found")
        .put("tabId", id)
        .put("tabs", tabSummaries())
    activeTabId = tab.id
    applyStageBounds()
    applyVisibility()
    return JSONObject().put("ok", true)
      .put("activeTabId", tab.id)
      .put("url", tab.url)
      .put("tabs", tabSummaries())
  }

  /**
   * 关闭指定标签页并同步销毁它的 WebView（一个 tab 一个 renderer —— 不关就是不销毁，
   * 这是「多页共存」与「省资源」的取舍点）。关掉活动页时自动切到相邻页。
   */
  private fun closeTabOp(args: JSONObject): JSONObject {
    val id = args.optString("tabId", "").ifBlank { activeTabId ?: "" }
    val workspace = requireWorkspace()
    val tab = tabOrNull(id)
      ?: return JSONObject().put("ok", false).put("reason", "tab-not-found").put("tabId", id)
    tab.generation.incrementAndGet()
    tab.snapshotGeneration = -1L
    synchronized(tab.refs) { tab.refs.clear() }
    releaseTabScripts(tab)
    // 最后一个页面：与 browserClose 等价（清空并保持宿主可复用），不残留半个状态。
    tab.view?.let { browser ->
      root.removeView(browser)
      browser.destroy()
    }
    tab.view = null
    tabs.remove(tab.id)
    if (workspace.modelTabId == tab.id) workspace.modelTabId = tabs.keys.firstOrNull()
    if (tabs.isEmpty()) {
      try { workspace.profile.dispose() } catch (_: Throwable) {
        workspace.profileError = "browser-profile-dispose-failed"
        lastError = workspace.profileError
        return status().put("ok", false).put("reason", lastError)
      }
      // Never reuse a closed native id while retained UI occurrences may still refer to it.
      activeTabId = null
      requestedVisible = false
      stageVisible = false
      applyVisibility()
      return JSONObject().put("ok", true).put("closedTabId", tab.id)
        .put("activeTabId", "").put("tabs", JSONArray())
    }
    if (activeTabId == tab.id) {
      activeTabId = tabs.keys.firstOrNull()
      applyStageBounds()
    }
    applyVisibility()
    return JSONObject().put("ok", true)
      .put("closedTabId", tab.id)
      .put("activeTabId", activeTabId ?: "")
      .put("tabs", tabSummaries())
  }

  // ── DOM snapshot ref discipline ───────────────────────────────────────────

  private fun pageReply(target: ControlTarget): JSONObject = JSONObject()
    .put("session", target.workspace.sessionKey).put("tabId", target.tab?.id ?: "")
    .put("url", target.tab?.url ?: "about:blank").put("title", target.tab?.title ?: "")
    .put("loadState", target.tab?.loadState ?: "idle").put("reason", target.tab?.reason.orEmpty())
    .put("pageGeneration", target.tab?.generation?.get() ?: 0L)

  private fun browserJsOp(args: JSONObject, target: ControlTarget): JSONObject {
    if (args.optBoolean("snapshot", false)) return snapshotOp(target)
    val expr = args.optString("expr", "")
    if (expr.isBlank()) return targetFailure(target, "expr-required")
    if (expr.length > 60_000) return targetFailure(target, "expr-too-long")
    return awaitMain(8_000) { done ->
      targetProblem(target)?.let { done(targetFailure(target, it)); return@awaitMain }
      val tab = target.tab
      val browser = tab?.view
      if (browser == null) { done(targetFailure(target, "browser-not-created")); return@awaitMain }
      browser.evaluateJavascript(expr, ValueCallback { raw ->
        targetProblem(target, browser)?.let { done(targetFailure(target, it)); return@ValueCallback }
        val value = decodeJs(raw)
        done(pageReply(target).put("ok", true).put("value", when (value) {
          null -> ""
          is String -> value
          else -> value.toString()
        }))
      })
    }
  }

  private fun snapshotOp(target: ControlTarget): JSONObject = awaitMain(8_000) { done ->
    targetProblem(target)?.let { done(targetFailure(target, it)); return@awaitMain }
    val tab = target.tab
    val browser = tab?.view
    if (tab == null || browser == null) { done(targetFailure(target, "browser-not-created")); return@awaitMain }
    val startedGeneration = tab.generation.get()
    browser.evaluateJavascript(SNAPSHOT_JS, ValueCallback { raw ->
      targetProblem(target, browser)?.let { done(targetFailure(target, it)); return@ValueCallback }
      if (tab.generation.get() != startedGeneration) {
        done(targetFailure(target, "stale-page-generation")); return@ValueCallback
      }
      try {
        val payload = decodeJsObject(raw) ?: throw IllegalStateException("snapshot-unparsable")
        val nodes = payload.optJSONArray("nodes") ?: JSONArray()
        val refs = HashSet<String>()
        for (i in 0 until nodes.length()) {
          val ref = nodes.getJSONObject(i).optString("ref", "")
          if (ref.isNotEmpty()) refs.add(ref)
        }
        synchronized(tab.refs) { tab.refs.clear(); tab.refs.addAll(refs) }
        tab.snapshotGeneration = startedGeneration
        done(pageReply(target).put("ok", true).put("surface", "browser")
          .put("pageGeneration", startedGeneration)
          .put("url", payload.optString("url", tab.url)).put("title", payload.optString("title", tab.title))
          .put("viewport", payload.optJSONObject("viewport") ?: JSONObject())
          .put("nodes", nodes).put("nodeCount", nodes.length()).put("truncated", payload.optBoolean("truncated", false)))
      } catch (t: Throwable) {
        done(targetFailure(target, "snapshot-failed").put("detail", t.javaClass.simpleName + ": " + (t.message ?: "")))
      }
    })
  }

  /** Main-thread ref validation on the captured tab, both before JS and before native tap dispatch. */
  private fun resolveRef(args: JSONObject, target: ControlTarget): JSONObject? {
    targetProblem(target)?.let { return targetFailure(target, it) }
    val tab = target.tab ?: return targetFailure(target, "browser-not-created")
    if (args.has("tabId") && args.optString("tabId") != tab.id) return targetFailure(target, "stale-tab")
    val ref = args.optString("ref", "")
    if (ref.isEmpty()) return targetFailure(target, "ref-required")
    if (!Regex("^bx\\d{1,5}$").matches(ref)) return targetFailure(target, "invalid-ref")
    val pageGeneration = args.optLong("pageGeneration", -1L)
    if (tab.snapshotGeneration < 0L) return targetFailure(target, "snapshot-required")
    if (pageGeneration != tab.snapshotGeneration || pageGeneration != tab.generation.get()) {
      return targetFailure(target, "stale-page-generation")
        .put("snapshotGeneration", tab.snapshotGeneration).put("currentGeneration", tab.generation.get())
    }
    if (!synchronized(tab.refs) { ref in tab.refs }) return targetFailure(target, "stale-ref")
    return null
  }

  private fun inputOp(args: JSONObject, target: ControlTarget): JSONObject = when (args.optString("kind", "")) {
    "tap" -> tapOp(args, target)
    "text" -> textOp(args, target)
    "key" -> keyOp(args, target)
    else -> targetFailure(target, "unsupported-input-kind")
      .put("guidance", "支持 kind=tap|text|key；滚动/等待等请走 browserJs 的固定脚本。")
  }

  private fun tapOp(args: JSONObject, target: ControlTarget): JSONObject {
    val ref = args.optString("ref")
    return awaitMain(8_000) { done ->
      resolveRef(args, target)?.let { done(it); return@awaitMain }
      val tab = target.tab!!
      val browser = tab.view
      if (browser == null) { done(targetFailure(target, "browser-not-created")); return@awaitMain }
      val startedGeneration = tab.generation.get()
      browser.evaluateJavascript(RESOLVE_REF_JS.replace("__REF__", ref), ValueCallback { raw ->
        targetProblem(target, browser)?.let { done(targetFailure(target, it)); return@ValueCallback }
        resolveRef(args, target)?.let { done(it); return@ValueCallback }
        val payload = decodeJsObject(raw)
        if (payload == null || !payload.optBoolean("found")) {
          done(targetFailure(target, "stale-ref").put("ref", ref)); return@ValueCallback
        }
        if (payload.optBoolean("disabled", false)) {
          done(targetFailure(target, "element-disabled").put("ref", ref)); return@ValueCallback
        }
        val vw = payload.optDouble("vw", 0.0)
        val vh = payload.optDouble("vh", 0.0)
        if (vw <= 0.0 || vh <= 0.0 || browser.width <= 0 || browser.height <= 0) {
          done(targetFailure(target, "viewport-unavailable")); return@ValueCallback
        }
        val viewX = (payload.optDouble("x") * browser.width / vw).toFloat()
        val viewY = (payload.optDouble("y") * browser.height / vh).toFloat()
        dispatchTap(browser, viewX, viewY)
        main.postDelayed({
          val problem = targetProblem(target, browser)
          if (problem != null) done(targetFailure(target, problem)) else {
            done(pageReply(target).put("ok", true).put("ref", ref)
              .put("changed", tab.generation.get() != startedGeneration))
          }
        }, 220)
      })
    }
  }

  private fun textOp(args: JSONObject, target: ControlTarget): JSONObject {
    val ref = args.optString("ref")
    val script = TYPE_JS.replace("__REF__", ref)
      .replace("__REPLACE__", if (args.optBoolean("replace", true)) "true" else "false")
      .replace("__TEXT__", jsString(args.optString("text", "")))
    return awaitMain(8_000) { done ->
      resolveRef(args, target)?.let { done(it); return@awaitMain }
      val tab = target.tab!!
      val browser = tab.view
      if (browser == null) { done(targetFailure(target, "browser-not-created")); return@awaitMain }
      val startedGeneration = tab.generation.get()
      browser.evaluateJavascript(script, ValueCallback { raw ->
        targetProblem(target, browser)?.let { done(targetFailure(target, it)); return@ValueCallback }
        if (tab.generation.get() != startedGeneration) {
          done(targetFailure(target, "stale-page-generation")); return@ValueCallback
        }
        val payload = decodeJsObject(raw)
        if (payload == null || !payload.optBoolean("found")) done(targetFailure(target, "stale-ref").put("ref", ref))
        else done(pageReply(target).put("ok", true).put("ref", ref).put("value", payload.optString("value", "")))
      })
    }
  }

  private fun keyOp(args: JSONObject, target: ControlTarget): JSONObject {
    val rawKey = args.optString("key", "").trim()
    if (rawKey.isEmpty()) return targetFailure(target, "key-required")
    val keyCode = KEY_CODES[rawKey.lowercase()] ?: return if (rawKey.length == 1) {
      textOp(JSONObject().put("ref", args.optString("ref", ""))
        .put("pageGeneration", args.optLong("pageGeneration", -1L)).put("text", rawKey).put("replace", false), target)
    } else targetFailure(target, "unsupported-key")
      .put("guidance", "支持 Enter/Tab/Escape/Backspace/Delete/方向键/PageUp/PageDown/Home/End，或单个可打印字符。")
    return controlOnMain(target) {
      val tab = target.tab ?: return@controlOnMain targetFailure(target, "browser-not-created")
      val browser = tab.view ?: return@controlOnMain targetFailure(target, "browser-not-created")
      if (args.has("pageGeneration") && args.optLong("pageGeneration", -1L) != tab.generation.get()) {
        return@controlOnMain targetFailure(target, "stale-page-generation")
      }
      // Explicit dispatch does not take focus from another Session's trusted editor/stage.
      dispatchKey(browser, keyCode)
      status().put("ok", true).put("key", rawKey)
    }
  }

  private fun shotOp(args: JSONObject, target: ControlTarget): JSONObject = controlOnMain(target) {
    val browser = target.tab?.view ?: return@controlOnMain targetFailure(target, "browser-not-created")
    try {
      if (browser.width <= 0 || browser.height <= 0) return@controlOnMain targetFailure(target, "viewport-unavailable")
      val bitmap = Bitmap.createBitmap(browser.width, browser.height, Bitmap.Config.ARGB_8888)
      try {
        browser.draw(Canvas(bitmap))
        val dir = File(File(activity.filesDir, "home/tmp"), "dsh-tmp").apply { mkdirs() }
        val file = File.createTempFile("browser-shot-", ".png", dir)
        FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        pageReply(target).put("ok", true).put("path", file.absolutePath).put("bytes", file.length())
          .put("width", bitmap.width).put("height", bitmap.height).put("health", "ok")
          .apply { if (!args.optBoolean("inline", false)) put("note", "截图落在应用私有目录的引擎可读路径；工具层读完即删。") }
      } finally { bitmap.recycle() }
    } catch (t: Throwable) { targetFailure(target, "shot-failed:" + t.javaClass.simpleName) }
  }

  // ── async plumbing ────────────────────────────────────────────────────────

  /** Run a block on the main thread and wait for its callback to complete (bounded). */
  private fun awaitMain(timeoutMs: Long, block: (done: (JSONObject) -> Unit) -> Unit): JSONObject {
    val latch = CountDownLatch(1)
    val result = AtomicReference(controlTimeout())
    main.post {
      try {
        block { value ->
          result.set(value)
          latch.countDown()
        }
      } catch (t: Throwable) {
        result.set(rejectControl("browser-op-failed").put("detail", t.javaClass.simpleName + ": " + (t.message ?: "")))
        latch.countDown()
      }
    }
    return if (latch.await(timeoutMs, TimeUnit.MILLISECONDS)) result.get() else controlTimeout()
  }

  private fun controlTimeout(): JSONObject = JSONObject()
    .put("ok", false)
    .put("reason", "timeout")
    .put("guidance", "浏览器操作超时：页面可能繁忙或 WebView 未就绪。")

  private fun rejectControl(reason: String): JSONObject = JSONObject().put("ok", false).put("reason", reason)

  private fun controlJson(raw: String?): JSONObject = try {
    JSONObject(raw ?: "")
  } catch (_: Throwable) {
    JSONObject().put("ok", false).put("reason", "browser-host-offline")
  }

  private fun decodeJs(raw: String?): Any? {
    val text = raw ?: return null
    return try {
      JSONTokener(text).nextValue()
    } catch (_: Throwable) {
      null
    }
  }

  private fun decodeJsObject(raw: String?): JSONObject? = when (val value = decodeJs(raw)) {
    is JSONObject -> value
    is String -> try { JSONObject(value) } catch (_: Throwable) { null }
    else -> null
  }

  private fun dispatchTap(browser: WebView, x: Float, y: Float) {
    val downAt = SystemClock.uptimeMillis()
    val down = MotionEvent.obtain(downAt, downAt, MotionEvent.ACTION_DOWN, x, y, 0)
    val up = MotionEvent.obtain(downAt, downAt + 48, MotionEvent.ACTION_UP, x, y, 0)
    try {
      browser.dispatchTouchEvent(down)
      browser.dispatchTouchEvent(up)
    } finally {
      down.recycle()
      up.recycle()
    }
  }

  private fun dispatchKey(browser: WebView, keyCode: Int) {
    val downAt = SystemClock.uptimeMillis()
    browser.dispatchKeyEvent(KeyEvent(downAt, downAt, KeyEvent.ACTION_DOWN, keyCode, 0))
    browser.dispatchKeyEvent(KeyEvent(downAt, downAt + 32, KeyEvent.ACTION_UP, keyCode, 0))
  }

  private fun <T> onMain(block: () -> T): T? {
    if (Looper.myLooper() == Looper.getMainLooper()) return block()
    var result: T? = null
    val latch = CountDownLatch(1)
    main.post {
      try {
        result = block()
      } finally {
        latch.countDown()
      }
    }
    return if (latch.await(2, TimeUnit.SECONDS)) result else null
  }

  /** 桌面身份脚本：只在 document-start 运行；不暴露桥、不改页面内容。 */
  private val IDENTITY_JS = """
    (function(){
      try {
        var N = Navigator.prototype;
        Object.defineProperty(N, 'platform', {get:function(){return 'Linux x86_64';}, configurable:true});
        Object.defineProperty(N, 'maxTouchPoints', {get:function(){return 0;}, configurable:true});
        Object.defineProperty(N, 'userAgentData', {get:function(){return undefined;}, configurable:true});
        Object.defineProperty(N, 'hardwareConcurrency', {get:function(){return 8;}, configurable:true});
      } catch (e) {}
      try { delete window.ontouchstart; } catch (e) {}
      try { delete Object.getPrototypeOf(window).ontouchstart; } catch (e) {}
      try {
        var S = Screen.prototype;
        Object.defineProperty(S, 'width', {get:function(){return 1920;}, configurable:true});
        Object.defineProperty(S, 'height', {get:function(){return 1080;}, configurable:true});
        Object.defineProperty(S, 'availWidth', {get:function(){return 1920;}, configurable:true});
        Object.defineProperty(S, 'availHeight', {get:function(){return 1080;}, configurable:true});
        Object.defineProperty(S, 'colorDepth', {get:function(){return 24;}, configurable:true});
        Object.defineProperty(S, 'pixelDepth', {get:function(){return 24;}, configurable:true});
      } catch (e) {}
    })()
  """.trimIndent()

  /** Fixed scripts run inside the untrusted page; they never expose a bridge and never mutate it. */
  private val SNAPSHOT_JS = """
    (function(){
      var MAX = $SNAPSHOT_MAX_NODES;
      var old = document.querySelectorAll('[data-dsh-bx]');
      for (var i = 0; i < old.length; i++) old[i].removeAttribute('data-dsh-bx');
      // 选择器口径（0.14.0 模拟器实测，勿轻易扩大）：
      // 本选择器**只收语义化可交互元素**。我一度加过「cursor:pointer / 可滚动容器」的补充扫描，
      // 想解决移动端 B 站（m.bilibili.com）内容区全是非语义 <div> 的问题——实测**零收益**：
      // 该站 1339 个元素里 cursor:pointer 的为 0（点击全靠 JS 事件委托，样式上不体现），
      // 却要为此对全部 div/span/li 逐个 getComputedStyle（数百毫秒）。已回退。
      //
      // 移动端非语义站点的正确解法是**换身份档**（站点自己会返回语义化桌面标记）：
      // 实测同一页面 linux-desktop 档 => 135 个可交互节点（含 bx18 link "影视飓风"），
      // 而默认移动档只有 1-2 个。见 browser_open 的 identity 参数说明。
      var sel = 'a[href],button,input,select,textarea,[role],[onclick],[tabindex],[contenteditable="true"]';
      var all = document.querySelectorAll(sel);
      var nodes = [];
      for (var j = 0; j < all.length && nodes.length < MAX; j++) {
        var el = all[j];
        var r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        var style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        var tag = el.tagName;
        var role = el.getAttribute('role') || (tag === 'A' ? 'link' : tag === 'BUTTON' ? 'button' : tag === 'SELECT' ? 'combobox' : (tag === 'INPUT' || tag === 'TEXTAREA') ? ((el.type === 'submit' || el.type === 'button' || el.type === 'checkbox' || el.type === 'radio') ? el.type : 'textbox') : (el.getAttribute('onclick') ? 'clickable' : (el.getAttribute('tabindex') ? 'focusable' : 'text')));
        var name = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.innerText || el.value || '';
        name = String(name).replace(/\s+/g, ' ').trim();
        if (name.length > 120) name = name.slice(0, 120);
        var ref = 'bx' + (nodes.length + 1);
        el.setAttribute('data-dsh-bx', ref);
        var inView = r.bottom > 0 && r.top < (window.innerHeight || 0) && r.right > 0 && r.left < (window.innerWidth || 0);
        nodes.push({ref: ref, role: role, name: name, bounds: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], inView: inView, disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true')});
      }
      return JSON.stringify({url: location.href, title: document.title, viewport: {width: window.innerWidth, height: window.innerHeight, scale: 1}, nodes: nodes, truncated: all.length > MAX});
    })()
  """.trimIndent()

  private val RESOLVE_REF_JS = """
    (function(){
      var el = document.querySelector('[data-dsh-bx="__REF__"]');
      if (!el) return JSON.stringify({found: false});
      el.scrollIntoView({block: 'center', inline: 'center'});
      var r = el.getBoundingClientRect();
      return JSON.stringify({found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, vw: window.innerWidth || 1, vh: window.innerHeight || 1, disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'), inView: r.bottom > 0 && r.top < (window.innerHeight || 0) && r.right > 0 && r.left < (window.innerWidth || 0)});
    })()
  """.trimIndent()

  private val TYPE_JS = """
    (function(){
      var el = document.querySelector('[data-dsh-bx="__REF__"]');
      if (!el) return JSON.stringify({found: false});
      el.focus();
      if (__REPLACE__ && typeof el.select === 'function') { try { el.select(); } catch (e) {} }
      var inserted = false;
      try { inserted = document.execCommand('insertText', false, __TEXT__); } catch (e) { inserted = false; }
      if (!inserted) {
        if (el.isContentEditable) {
          inserted = true;
        } else {
          var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, 'value');
          if (setter && setter.set) setter.set.call(el, __TEXT__); else el.value = __TEXT__;
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
          inserted = true;
        }
      }
      var value = el.isContentEditable ? el.innerText : el.value;
      return JSON.stringify({found: true, inserted: inserted, value: String(value === null || value === undefined ? '' : value).slice(0, 200)});
    })()
  """.trimIndent()

  private val KEY_CODES = mapOf(
    "enter" to KeyEvent.KEYCODE_ENTER,
    "tab" to KeyEvent.KEYCODE_TAB,
    "escape" to KeyEvent.KEYCODE_ESCAPE,
    "esc" to KeyEvent.KEYCODE_ESCAPE,
    "backspace" to KeyEvent.KEYCODE_DEL,
    "delete" to KeyEvent.KEYCODE_FORWARD_DEL,
    "arrowup" to KeyEvent.KEYCODE_DPAD_UP,
    "up" to KeyEvent.KEYCODE_DPAD_UP,
    "arrowdown" to KeyEvent.KEYCODE_DPAD_DOWN,
    "down" to KeyEvent.KEYCODE_DPAD_DOWN,
    "arrowleft" to KeyEvent.KEYCODE_DPAD_LEFT,
    "left" to KeyEvent.KEYCODE_DPAD_LEFT,
    "arrowright" to KeyEvent.KEYCODE_DPAD_RIGHT,
    "right" to KeyEvent.KEYCODE_DPAD_RIGHT,
    "pageup" to KeyEvent.KEYCODE_PAGE_UP,
    "pagedown" to KeyEvent.KEYCODE_PAGE_DOWN,
    "home" to KeyEvent.KEYCODE_MOVE_HOME,
    "end" to KeyEvent.KEYCODE_MOVE_END,
    "space" to KeyEvent.KEYCODE_SPACE,
  )
}

/**
 * Process-wide handle for the Activity-owned BrowserHost instance.
 *
 * The accessibility control service carries the model-facing `browser*` ops in the existing queue,
 * but the untrusted WebView itself is owned by the Activity. The holder lets the service route an
 * op to the live instance without moving WebView ownership; absence is explicit, never guessed.
 */
internal object BrowserHostHolder {
  @Volatile
  var host: BrowserHost? = null

  /** Route one control op to the live BrowserHost; absent host is a structured fail-closed answer. */
  fun control(op: String, args: JSONObject): JSONObject {
    val current = host ?: return JSONObject()
      .put("__error", "浏览器工作台尚未创建：请先在右侧栏「AI 浏览器」中打开页面。")
      .put("reason", "browser-host-unavailable")
    return current.controlOp(op, args)
  }
}
