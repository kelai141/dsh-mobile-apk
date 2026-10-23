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
   * 更新块：状态行在上，检查 / 下载两枚按钮在下（横向两等分）。
   *
   * 为什么状态行必须与按钮分开：旧形态把版本号写进按钮文案，而按钮是固定高的单行控件——
   * 长版本号（v0.13.7fx-1）在真机上被截断（GuideChrome 里那条 maxLines=1 的实测约束正是为此）。
   * 版本号挪到独立一行后，按钮文案只剩「检查更新」「下载」这类短词，截断问题从根上消失。
   *
   * 为什么三枚控件都用**实例**而不是新建：更新状态与动作只由 Activity 作用域的 ApkUpdateController
   * 持有，GuideChrome 造出来的这三枚读的就是它；另造一套控件就会与引导页那一份状态打架。
   * 检查按钮走的是既有路径（从原父节点摘下来再挂进来），另外两枚构建期无父节点，这里直接认领。
   */
  private fun updateBlock(): View {
    val block = column().apply {
      setPadding(dp(20), dp(12), dp(20), dp(12))
      // 与相邻的 row 同款外边距：更新块是一块内容，不是贴在面板边缘的裸控件。
      layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) }
    }
    (chrome.updateButton.parent as? ViewGroup)?.removeView(chrome.updateButton)
    (chrome.apkStatus.parent as? ViewGroup)?.removeView(chrome.apkStatus)
    (chrome.apkDownload.parent as? ViewGroup)?.removeView(chrome.apkDownload)
    block.addView(chrome.apkStatus, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
    val buttons = LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      // 与状态行留出间距，两枚按钮视觉上并列（各占一半，中间 8dp 缝）。
      layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) }
    }
    val buttonHeight = dimenPx(R.dimen.ds_btn_secondary_height)
    buttons.addView(chrome.updateButton, LinearLayout.LayoutParams(0, buttonHeight, 1f))
    buttons.addView(chrome.apkDownload, LinearLayout.LayoutParams(0, buttonHeight, 1f).apply { marginStart = dp(8) })
    block.addView(buttons)
    return block
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
