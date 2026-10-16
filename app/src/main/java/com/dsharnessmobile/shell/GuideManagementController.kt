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
  private lateinit var feedback: TextView
  private var storageStatus: TextView? = null
  val isOpen get() = destination != "home" || progress > 0f
  val savedPage get() = destination
  private fun dp(n: Int) = (n * activity.resources.displayMetrics.density).toInt()

  fun build() {
    management = column()
    management.addView(label("管理中心", 26f))
    management.addView(label("DeepCode · 应用与运行环境管理", 14f))
    // Keep the same update Button instance so ApkUpdateController retains all states and actions.
    row("打开控制台", "查看终端与运行日志") {
      activity.startActivity(Intent(activity, ConsoleActivity::class.java))
    }
    row("插件管理", "启停插件与编辑配置") { showPlugins() }
    (chrome.updateButton.parent as? ViewGroup)?.removeView(chrome.updateButton)
    management.addView(chrome.updateButton.apply {
      minHeight = dp(72)
      gravity = Gravity.START or Gravity.CENTER_VERTICAL
      setPadding(dp(20), dp(12), dp(20), dp(12))
      textSize = 16f
      background = DsUi.ripple(DsUi.roundRect(activity.getColor(R.color.ds_surface), dp(8).toFloat()), activity.getColor(R.color.ds_accent_soft))
      layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) }
    })
    row("存储管理", "私有数据、容量与公共导出目录") { showStorage() }
    feedback = label("", 14f)
    management.addView(feedback)
    val scroll = ScrollView(activity).apply {
      isFillViewport = true
      addView(management)
    }
    chrome.managementHost.addView(scroll, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER_HORIZONTAL))
    activity.apkUpdate.observe { feedback.text = chrome.statusHint.text }
    chrome.managementHost.addOnLayoutChangeListener { _, l, _, r, _, _, _, _, _ ->
      val width = minOf(r - l, dp(600))
      if (management.layoutParams.width != width) {
        management.layoutParams = (management.layoutParams as FrameLayout.LayoutParams).apply { this.width = width; gravity = Gravity.CENTER_HORIZONTAL }
      }
    }
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
  private fun navigate(next: String) {
    destination = next
    if (next == "home" || next == "management") removeDetail()
    chrome.gear.contentDescription = if (next == "home") "打开管理中心" else "关闭管理中心"
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
    detail?.let { chrome.managementHost.removeView(it) }
    detail = null
    pluginPage = null
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
    body.addView(Button(activity).apply { text = "返回管理中心"; setOnClickListener { back() } })
    body.addView(label("存储管理", 24f))
    val data = activity.engineManager.dshDataDir
    val stats = StatFs(activity.filesDir.absolutePath)
    body.addView(label("公共导出目录\n${data.absolutePath}\n\n应用私有数据\n${activity.engineManager.homeDir.absolutePath}\n\n应用私有运行时\n${activity.engineManager.usrDir.absolutePath}\n\n可用空间：${android.text.format.Formatter.formatFileSize(activity, stats.availableBytes)}", 14f))
    body.addView(label("引擎在应用私有目录运行，无需公共存储授权。访问公共工作目录时才需要额外授权。此页不会清理工作区、插件配置或对话。", 14f))
    body.addView(Button(activity).apply {
      text = "复制公共导出目录"
      setOnClickListener { activity.copyTextNative(data.absolutePath); android.widget.Toast.makeText(activity, "目录已复制", 0).show() }
    })
    body.addView(Button(activity).apply {
      text = "授权公共工作目录访问"
      setOnClickListener {
        android.app.AlertDialog.Builder(activity).setTitle("公共目录访问")
          .setMessage("导出会话文件到 Documents/dshdata 时需要直接写入公共目录。仅在需要此功能时授权；拒绝不会阻止私有运行时启动。")
          .setPositiveButton("前往授权") { _, _ -> activity.dirPickerController.requestStorageGrant() }
          .setNegativeButton("取消", null).show()
      }
    })
    body.addView(Button(activity).apply {
      text = "重新检查公共目录"
      setOnClickListener {
        activity.provisionPublicRepoAndRefreshChip(PublicRepoProvision.TRIGGER_ON_RESUME)
        android.widget.Toast.makeText(activity, "正在检查公共目录，结果见下方状态", 0).show()
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
  fun refreshStorage() {
    if (destination != "storage") return
    val presentation = PublicRepoProvision.presentation(activity.engineManager.publicRepoStatus())
    storageStatus?.text = "公共导出目录：" + when (presentation) {
      PublicRepoPresentation.READY -> "可用"
      PublicRepoPresentation.PENDING -> "尚未检查"
      PublicRepoPresentation.NEEDS_GRANT -> "需要授权，可在下方恢复访问"
      PublicRepoPresentation.WRITE_FAILED -> "写入失败，请在控制台查看详细原因"
    }
  }
  fun back(): Boolean = when (destination) {
    "plugins" -> { if (pluginPage?.back() != true) navigate("management"); true }
    "storage" -> { navigate("management"); true }
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
  }
  fun destroy() { animation?.cancel(); pluginPage?.dispose() }
}
