package com.dsharnessmobile.shell

import android.animation.ValueAnimator
import android.content.Intent
import android.os.Build
import android.os.StatFs
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.math.abs

/** Native navigation owns one bounded transition; engine callbacks never replace its destination. */
internal class GuideManagementController(
  private val activity: MainActivity,
  private val renderer: GuidePageRenderer,
) {
  private val chrome get() = renderer.chrome
  private var destination = "home"
  private var progress = 0f
  private var animation: ValueAnimator? = null
  private lateinit var management: LinearLayout
  private var detail: View? = null
  private var pluginPage: PluginManagementPage? = null
  private var storageStatus: TextView? = null
  private var splashPage: SplashSettingsPage? = null
  val isOpen get() = destination != "home" || progress > 0f
  val savedPage get() = destination
  private fun dp(n: Int) = (n * activity.resources.displayMetrics.density).toInt()
  /** 按 dimens.xml 取像素高度：按钮高度必须与全应用同一把尺（52/48dp），不在这里另立常量。 */
  private fun dimenPx(id: Int) = activity.resources.getDimensionPixelSize(id)
  private fun t(zh: String, en: String) = UiText.t(activity, zh, en)

  fun build() {
    management = column()
    management.addView(label(t("管理中心", "Management"), 26f))
    management.addView(label(t("DeepCode · 应用与运行时", "DeepCode · App and runtime"), 14f))
    row(t("打开控制台", "Open console"), t("终端与运行日志", "Terminal and logs")) {
      activity.startActivity(Intent(activity, ConsoleActivity::class.java))
    }
    row(t("插件管理", "Plugins"), t("启停与配置", "Enable and configure")) { showPlugins() }
    // 软件源（issue：移动端手动改源门槛高）。放在壳侧而不是引擎 Web UI：
    // 换源只改快照里的一个文本文件，引擎坏了也应该能换。不新增桥方法、不新增 control op。
    sourceRow()
    management.addView(updateBlock())
    row(t("存储管理", "Storage"), t("数据、容量与导出", "Data, space, exports")) { showStorage() }
    // 启动页管理（0.14.9）：开屏视频与「打开应用后自动启动」属于启动面，
    // 放进管理中心而不是引擎 Web UI 的设置中心——引擎没起来时也必须能改。
    row(t("启动页管理", "Startup screen"), t("开屏视频与自动启动", "Launch video and auto start")) { showSplash() }
    languageRow()
    val scroll = ScrollView(activity).apply {
      isFillViewport = true
      addView(management)
    }
    chrome.managementHost.addView(scroll, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER_HORIZONTAL))
    // 为什么这里**不再**注册第二个观察者：旧代码是 observe { feedback.text = chrome.statusHint.text }，
    // 它抄的那行提示文本在 APK 更新路径上没有任何写入方（更新结果写的是更新块自己的状态行），
    // 所以这段渲染既搬不出状态、又在单槽时代把 GuidePageRenderer 的 renderApkUpdate 顶掉——用户点了
    // 「检查更新」按钮完全不变化，根因就在这里。更新块的三枚控件由 GuidePageRenderer.renderApkUpdate
    // 统一渲染（它在 buildGuideView 里注册的就是同一次观察），本面板只负责把控件摆上去。
    // 重复注册第二个观察者只会让同一份状态被渲染两遍、并把「谁是唯一渲染者」重新变模糊。
    chrome.managementHost.addOnLayoutChangeListener { _, l, _, r, _, _, _, _, _ ->
      val width = minOf(r - l, dp(600))
      if (management.layoutParams.width != width) {
        management.layoutParams = (management.layoutParams as FrameLayout.LayoutParams).apply { this.width = width; gravity = Gravity.CENTER_HORIZONTAL }
      }
    }
  }

  /**
   * 更新块：一张卡片，里面「标题 / 状态行 / 检查与下载两枚按钮」。
   *
   * 为什么状态行必须与按钮分开：旧形态把版本号写进按钮文案，而按钮是固定高的单行控件——
   * 长版本号（v0.13.7fx-1）在真机上被截断（GuideChrome 里那条 maxLines=1 的实测约束正是为此）。
   * 版本号挪到独立一行后，按钮文案只剩「检查更新」「下载」这类短词，截断问题从根上消失。
   *
   * 为什么三枚控件都用**实例**而不是新建：更新状态与动作只由 Activity 作用域的 ApkUpdateController
   * 持有，GuideChrome 造出来的这三枚读的就是它；另造一套控件就会与引导页那一份状态打架。
   * 检查按钮走的是既有路径（从原父节点摘下来再挂进来），另外两枚构建期无父节点，这里直接认领。
   *
   * 为什么**保留两枚独立按钮、只把它们包进一张卡片**（用户硬约束，别顺手合并）：检查与下载各自
   * 硬绑一个动作（见 GuideCallbacks.onCheckUpdate / onDownloadUpdate）。把两枚合成一枚、由它推断
   * 「这次点击该检查还是该下载」，正是历史上误清已确认载荷的来源；卡片只是外面那层视觉容器，
   * 不承担任何状态推断，也不承担任何点击。
   *
   * 卡片外壳规格对齐 WebView 设置页的 `.dsh-screen-control-card`（#860 之后「应用更新」分区就用它），
   * 于是启动页这张卡与管理中心那张卡是同一套尺寸与字号，不是一个页面一套。逐项对照见 [updateCard]，
   * 取值收在 [DsUi.settingsCardBackground] / [DsUi.settingsCardPaddingPx]，改一处两边一起变。
   */
  private fun updateBlock(): View {
    val block = updateCard()
    (chrome.updateButton.parent as? ViewGroup)?.removeView(chrome.updateButton)
    (chrome.apkStatus.parent as? ViewGroup)?.removeView(chrome.apkStatus)
    (chrome.apkDownload.parent as? ViewGroup)?.removeView(chrome.apkDownload)
    // 标题行：14sp 主色 —— 与 WebView 卡片的 .dsh-gs-title / 卡头（font-size 14px）同档。
    // 为什么卡片需要一个标题：WebView 那张卡有卡头（分区名），这里若只有一行状态小字，
    // 两个入口关掉其中一个就分不清它是「更新」还是别的行内提示。
    block.addView(cardTitle())
    // 状态行：12sp 次要色 + 18sp 行高 —— 与 .dsh-gs-desc（font-size 12px / line-height 18px）同档。
    block.addView(chrome.apkStatus, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(4) })
    val buttons = LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      // 与状态行留出间距（与 WebView 卡片 grid gap 同量级），两枚按钮视觉上并列。
      layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) }
    }
    // 按钮高度 48dp 是本改动**有意不跟** WebView 的一处：WebView 那边是 Button size="sm"（28px），
    // 那是鼠标指针的尺寸；这里手指要点，48dp 才够（本仓既有次级按钮同一把尺 ds_btn_secondary_height）。
    val buttonHeight = dimenPx(R.dimen.ds_btn_secondary_height)
    buttons.addView(chrome.updateButton, LinearLayout.LayoutParams(0, buttonHeight, 1f))
    buttons.addView(chrome.apkDownload, LinearLayout.LayoutParams(0, buttonHeight, 1f).apply { marginStart = dp(8) })
    // 这两枚按钮是启动页造的（makeSecondary：胶囊圆角 999dp + hairline 描边 + 15sp 文字），
    // 而卡片里其它面都是小圆角实心块——搬进来后圆角与描边明显不是一套，
    // 这就是「检查更新按钮风格和其他按钮不契合」。按卡片口径就地重绘，不改启动页那份原型。
    //
    // 圆角 8dp = WebView 侧 Button size="sm" 的 --dsw-radius-sm（8px），两侧按钮圆角同值。
    // 字号 14sp = WebView 侧 Button 基础档 font-size 14px（.button），不用 sm 档的 12px：
    // 按钮高度在这里是 48dp（见上），12px 字在 48dp 的块里会显得又空又小。
    //
    // 填充色必须是 ds_button_surface 而**不能**是 ds_surface：后者与卡片底色是同一个 token，
    // 一旦按钮住进卡片里，它就会和卡片融为一体、看不出边界（旧形态下按钮直接坐在面板底色上，
    // 两者刚好有对比，所以那时写 ds_surface 没暴露）。ds_button_surface 是这套设计里
    // 专为「按钮面」准备的 token，晴/暗两套底色上都有对比。
    for (button in listOf(chrome.updateButton, chrome.apkDownload)) {
      button.background = DsUi.ripple(
        DsUi.roundRect(activity.getColor(R.color.ds_button_surface), dp(8).toFloat()),
        activity.getColor(R.color.ds_accent_soft),
      )
      button.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14f)
      button.setTextColor(activity.getColor(R.color.ds_text_primary))
    }
    block.addView(buttons)
    return block
  }

  /** 更新卡的外壳（背景 / 圆角 / 描边 / 内边距），规格全部取自 DsUi 的那两个函数。 */
  private fun updateCard() = LinearLayout(activity).apply {
    orientation = LinearLayout.VERTICAL
    DsUi.settingsCardPaddingPx(activity).let { setPadding(it[0], it[1], it[2], it[3]) }
    background = DsUi.settingsCardBackground(activity)
    // 与相邻的 row 同款外边距：更新卡是这一列里的一张卡，不是贴在面板边缘的裸控件。
    // 水平方向不加任何外边距——卡片宽度由本列（column 的 4dp 内边距）决定，与其它 row 左右对齐。
    layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) }
    // 无障碍：本容器**刻意不设**点击/焦点/读屏语义。它只是背景与留白，两枚按钮的语义不改、
    // 仍是各自独立的可聚焦控件；读屏不会被这张卡片合并或截断。
    isClickable = false
    isFocusable = false
  }

  /** 更新卡的标题行：14sp 主色，与 WebView 卡片标题同档。 */
  private fun cardTitle() = TextView(activity).apply {
    text = t("应用更新", "App updates")
    setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14f)
    setTextColor(activity.getColor(R.color.ds_text_primary))
    includeFontPadding = false
    layoutParams = LinearLayout.LayoutParams(-1, -2)
  }

  private fun column() = LinearLayout(activity).apply {
    orientation = LinearLayout.VERTICAL
    setPadding(dp(4), dp(12), dp(4), dp(16))
  }
  private fun label(value: String, size: Float) = TextView(activity).apply {
    text = value
    textSize = size
    setTextColor(activity.getColor(R.color.ds_text_primary))
    setPadding(0, dp(8), 0, dp(8))
  }
  private fun row(title: String, subtitle: String, action: () -> Unit) {
    management.addView(LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(20), dp(12), dp(20), dp(12))
      minimumHeight = dp(72)
      background = DsUi.ripple(DsUi.roundRect(activity.getColor(R.color.ds_surface), dp(8).toFloat()), activity.getColor(R.color.ds_accent_soft))
      layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) }
      isClickable = true
      isFocusable = true
      contentDescription = "$title，$subtitle"
      val words = column().apply { setPadding(0, 0, dp(12), 0) }
      words.addView(label(title, 16f).apply { setPadding(0, 0, 0, 0) })
      words.addView(label(subtitle, 13f).apply {
        setPadding(0, dp(4), 0, 0)
        setTextColor(activity.getColor(R.color.ds_text_secondary))
      })
      addView(words, LinearLayout.LayoutParams(0, -2, 1f))
      addView(label("›", 24f).apply { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO })
      setOnClickListener { action() }
    })
  }

  fun toggle() {
    if (destination == "home") navigate("management") else navigate("home")
  }

  /**
   * 软件源行：显示当前源，点一下循环切换。
   *
   * 为什么用"循环"而不是弹出选择列表：这个面板的既有交互全是"点一行做一件事"
   * （语言行也是循环三态）。换源需要跑一次 apt-get update（实测 2 秒级），
   * 三态循环 + 状态回显足够，且不需要新造一个选择器页面。
   *
   * 为什么状态要回显：换源是**会失败**的操作（源不可达即回滚）。
   * 只给一个动作不给结果，用户无法知道到底换没换成——语言行可以这么写，这里不行。
   */
  private fun sourceRow() {
    val engine = EngineManager(activity, EngineManager.ensurePickToken())
    val words = column().apply { setPadding(dp(20), dp(12), dp(20), dp(12)) }
    val title = label(t("软件源", "Package source"), 16f).apply { setPadding(0, 0, 0, 0) }
    val value = label(sourceSummary(engine.usrDir), 13f).apply {
      setPadding(0, dp(4), 0, 0)
      setTextColor(activity.getColor(R.color.ds_text_secondary))
    }
    words.addView(title)
    words.addView(value)
    val card = LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(20), dp(12), dp(20), dp(12))
      minimumHeight = dp(72)
      background = DsUi.ripple(DsUi.roundRect(activity.getColor(R.color.ds_surface), dp(8).toFloat()), activity.getColor(R.color.ds_accent_soft))
      layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) }
      isClickable = true
      isFocusable = true
      contentDescription = t("软件源", "Package source") + "，" + sourceSummary(engine.usrDir)
      addView(words, LinearLayout.LayoutParams(0, -2, 1f))
      val action = label(t("切换", "Change"), 14f).apply { setTextColor(activity.getColor(R.color.ds_accent)) }
      addView(action)
      setOnClickListener {
        // 换源要跑 apt-get update（秒级），期间禁用回执避免用户重复点出并发写。
        isEnabled = false
        action.text = t("切换中…", "Switching...")
        Thread {
          val next = SourceSettings.nextMirror(engine.usrDir)
          val result = SourceSettings.switchTo(activity, next)
          activity.runOnUiThread {
            value.text = if (result.ok) sourceSummary(engine.usrDir) else result.message
            action.text = t("切换", "Change")
            isEnabled = true
          }
        }.apply { isDaemon = true }.start()
      }
    }
    management.addView(card)
  }

  /** 当前源的展示文案：认识就写名字，不认识就如实说"自定义"而不是猜。 */
  private fun sourceSummary(prefix: java.io.File): String {
    val current = SourceSettings.currentMirror(prefix)
      ?: return t("自定义（未在清单内）", "Custom (not in list)")
    return if (AppLanguage.mode(activity) == AppLanguage.MODE_EN) current.labelEn else current.labelZh
  }

  /** Language row: a tap cycles system -> zh -> en for both the shell and dsh. */
  private fun languageRow() {
    val words = column().apply { setPadding(dp(20), dp(12), dp(20), dp(12)) }
    val title = label(t("界面语言", "Language"), 16f).apply { setPadding(0, 0, 0, 0) }
    val value = label(languageSummary(), 13f).apply {
      setPadding(0, dp(4), 0, 0)
      setTextColor(activity.getColor(R.color.ds_text_secondary))
    }
    words.addView(title)
    words.addView(value)
    val card = LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(20), dp(12), dp(20), dp(12))
      minimumHeight = dp(72)
      background = DsUi.ripple(DsUi.roundRect(activity.getColor(R.color.ds_surface), dp(8).toFloat()), activity.getColor(R.color.ds_accent_soft))
      layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) }
      isClickable = true
      isFocusable = true
      contentDescription = t("界面语言", "Language") + "，" + languageSummary()
      addView(words, LinearLayout.LayoutParams(0, -2, 1f))
      addView(label(t("切换", "Change"), 14f).apply { setTextColor(activity.getColor(R.color.ds_accent)) })
      setOnClickListener {
        val next = when (AppLanguage.mode(activity)) {
          AppLanguage.MODE_SYSTEM -> AppLanguage.MODE_ZH
          AppLanguage.MODE_ZH -> AppLanguage.MODE_EN
          else -> AppLanguage.MODE_SYSTEM
        }
        AppLanguage.setMode(activity, next)
        AppLanguage.syncDshLocale(activity)
        // A language change rebuilds native resources; restart the activity so the
        // guide page and the WebView both come back in the new language.
        activity.recreate()
      }
    }
    management.addView(card)
  }

  /** The three modes are named in both languages: the user must recognise the target mode. */
  private fun languageSummary(): String = when (AppLanguage.mode(activity)) {
    AppLanguage.MODE_ZH -> t("中文", "Chinese")
    AppLanguage.MODE_EN -> "English"
    else -> t("跟随系统", "Follow system")
  }
  private fun navigate(next: String) {
    destination = next
    if (next == "home" || next == "management") removeDetail()
    chrome.gear.contentDescription = if (next == "home") t("打开管理中心", "Open management") else t("关闭管理中心", "Close management")
    chrome.primaryButton.visibility = if (next == "home") View.VISIBLE else View.GONE
    animateTo(if (next == "home") 0f else 1f)
  }
  private fun animateTo(target: Float) {
    animation?.cancel()
    val enabled = Build.VERSION.SDK_INT < 26 || ValueAnimator.areAnimatorsEnabled()
    if (!enabled || abs(target - progress) < .001f) { render(target); return }
    animation = ValueAnimator.ofFloat(progress, target).apply {
      duration = (430 * abs(target - progress)).toLong().coerceAtLeast(1)
      interpolator = DsUi.ease
      addUpdateListener { render(it.animatedValue as Float) }
      start()
    }
  }
  private fun render(value: Float) {
    progress = value
    chrome.gear.drawable?.level = (10_000 * value).toInt()
    chrome.homeContent.visibility = if (value >= 1f) View.GONE else View.VISIBLE
    chrome.managementHost.visibility = if (value <= 0f) View.GONE else View.VISIBLE
    // One content area is interactive at a time, including interrupted transitions.
    chrome.homeContent.importantForAccessibility = if (destination == "home") View.IMPORTANT_FOR_ACCESSIBILITY_AUTO else View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    chrome.managementHost.importantForAccessibility = if (destination == "home") View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS else View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
    chrome.homeContent.alpha = 1f - value
    chrome.managementHost.alpha = value
    chrome.managementHost.translationY = dp(12) * (1f - value)
  }

  private fun removeDetail() {
    pluginPage?.dispose()
    splashPage?.dispose()
    detail?.let { chrome.managementHost.removeView(it) }
    detail = null
    pluginPage = null
    splashPage = null
    chrome.managementHost.getChildAt(0)?.visibility = View.VISIBLE
  }
  private fun displayDetail(view: View) {
    removeDetail()
    chrome.managementHost.getChildAt(0)?.visibility = View.GONE
    detail = view
    chrome.managementHost.addView(view, FrameLayout.LayoutParams(-1, -1))
  }
  private fun showPlugins() {
    val page = PluginManagementPage(activity) { back() }
    displayDetail(page.view)
    pluginPage = page
    destination = "plugins"
  }
  private fun showStorage() {
    val body = column()
    body.addView(Button(activity).apply { text = t("返回管理中心", "Back to management"); setOnClickListener { back() } })
    body.addView(label(t("存储管理", "Storage"), 24f))
    val data = activity.engineManager.dshDataDir
    val stats = StatFs(activity.filesDir.absolutePath)
    body.addView(label(
      t("公共导出目录", "Shared export folder") + "\n" + data.absolutePath +
        "\n\n" + t("应用私有数据", "App private data") + "\n" + activity.engineManager.homeDir.absolutePath +
        "\n\n" + t("应用私有运行时", "App private runtime") + "\n" + activity.engineManager.usrDir.absolutePath +
        "\n\n" + t("可用空间：", "Free space: ") + android.text.format.Formatter.formatFileSize(activity, stats.availableBytes),
      14f,))
    body.addView(label(
      t(
        "引擎在应用私有目录运行，无需公共存储授权。访问公共工作目录时才需要额外授权。此页不会清理工作区、插件配置或对话。",
        "The engine runs in app-private storage; no shared-storage grant is needed. Grant access only to read or write shared folders. This page never clears workspaces, plugin settings, or chats.",
      ),
      14f,))
    body.addView(Button(activity).apply {
      text = t("复制公共导出目录", "Copy shared export folder")
      setOnClickListener { activity.copyTextNative(data.absolutePath); android.widget.Toast.makeText(activity, t("目录已复制", "Folder copied"), 0).show() }
    })
    body.addView(Button(activity).apply {
      text = t("授权公共工作目录访问", "Grant shared folder access")
      setOnClickListener {
        android.app.AlertDialog.Builder(activity).setTitle(t("公共目录访问", "Shared folder access"))
          .setMessage(t(
            "导出会话文件到 Documents/dshdata 时需要直接写入公共目录。仅在需要此功能时授权；拒绝不会阻止私有运行时启动。",
            "Exporting sessions to Documents/dshdata writes into a shared folder. Grant it only for this feature; declining does not block the private runtime.",
          ))
          .setPositiveButton(t("前往授权", "Open settings")) { _, _ -> activity.dirPickerController.requestStorageGrant() }
          .setNegativeButton(t("取消", "Cancel"), null).show()
      }
    })
    body.addView(Button(activity).apply {
      text = t("重新检查公共目录", "Recheck shared folder")
      setOnClickListener {
        activity.provisionPublicRepoAndRefreshChip(PublicRepoProvision.TRIGGER_ON_RESUME)
        android.widget.Toast.makeText(activity, t("正在检查公共目录，结果见下方状态", "Checking the shared folder; the result appears below"), 0).show()
        postDelayed({ if (destination == "storage") showStorage() }, 1000)
      }
    })
    val status = chrome.storageChip
    (status.parent as? ViewGroup)?.removeView(status)
    body.addView(status, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
    for (index in 0 until body.childCount) {
      (body.getChildAt(index) as? Button)?.apply {
        isAllCaps = false
        stateListAnimator = null
        minimumHeight = dp(48)
        setTextColor(activity.getColor(R.color.ds_text_primary))
        background = DsUi.ripple(DsUi.roundRect(activity.getColor(R.color.ds_surface), dp(8).toFloat()), activity.getColor(R.color.ds_accent_soft))
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) }
      }
    }
    displayDetail(ScrollView(activity).apply { addView(body) })
    destination = "storage"
    storageStatus = status
    refreshStorage()
  }
  private fun showSplash() {
    val page = SplashSettingsPage(activity) { back() }
    displayDetail(page.view)
    splashPage = page
    destination = "splash"
  }
  fun refreshStorage() {
    if (destination != "storage") return
    val presentation = PublicRepoProvision.presentation(activity.engineManager.publicRepoStatus())
    storageStatus?.text = t("公共导出目录：", "Shared export folder: ") + when (presentation) {
      PublicRepoPresentation.READY -> t("可用", "ready")
      PublicRepoPresentation.PENDING -> t("尚未检查", "not checked")
      PublicRepoPresentation.NEEDS_GRANT -> t("需要授权，可在下方恢复访问", "needs access; restore it below")
      PublicRepoPresentation.WRITE_FAILED -> t("写入失败，请在控制台查看详细原因", "write failed; see the console for details")
    }
  }
  fun back(): Boolean = when (destination) {
    "plugins" -> { if (pluginPage?.back() != true) navigate("management"); true }
    "storage" -> { navigate("management"); true }
    "splash" -> { navigate("management"); true }
    "management" -> { navigate("home"); true }
    else -> false
  }
  fun beginBack() { if (destination == "management") animation?.cancel() }
  fun progressBack(value: Float) { if (destination == "management") render(1f - value.coerceIn(0f, 1f)) }
  fun cancelBack() { if (destination == "management") animateTo(1f) }
  fun restore(page: String?) {
    if (page == null || page == "home") return
    navigate("management")
    animation?.cancel()
    render(1f)
    if (page == "plugins") showPlugins()
    if (page == "storage") showStorage()
    if (page == "splash") showSplash()
  }
  fun destroy() { animation?.cancel(); pluginPage?.dispose(); splashPage?.dispose() }
}
