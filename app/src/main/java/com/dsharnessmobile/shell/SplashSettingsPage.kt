package com.dsharnessmobile.shell

import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * Native 「启动页管理」 page under the guide page's gear menu.
 *
 * It is intentionally not part of the Web UI settings: the engine may be down when a
 * user wants to fix their launch animation, and the guide page is the only surface that
 * is guaranteed to exist. All copy is bilingual at the call site (shell convention).
 */
internal class SplashSettingsPage(
  private val activity: MainActivity,
  private val onBack: () -> Unit,
) {
  private val status = label("", 14f).apply {
    setTextColor(activity.getColor(R.color.ds_text_secondary))
    setPadding(0, dp(4), 0, 0)
  }
  private val remove = button(t("移除视频", "Remove video")) { clear() }
  private val toggle: SplashToggle

  val view: View

  init {
    toggle = SplashToggle.create(activity, SplashStore.autoStart(activity)) { enabled ->
      val applied = SplashStore.setAutoStart(activity, enabled)
      android.util.Log.i(SplashOverlay.PROBE_TAG, "settings onChanged enabled=$enabled applied=$applied")
      if (applied != enabled) {
        toggle.setChecked(applied, notify = false)
        toast(t("设置没有保存成功，请重试。", "The setting was not saved. Try again."))
      }
    }
    val body = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(4), dp(8), dp(4), dp(16))
    }
    body.addView(button(t("返回管理中心", "Back to management")) { onBack() })
    body.addView(label(t("启动页管理", "Startup screen"), 24f))
    body.addView(label(
      t(
        "引擎启动时，这段视频会全屏覆盖启动页，静音循环播放，直到界面加载完成。支持常见视频格式，单个文件不超过 50 MB；不支持 .ts。",
        "While the engine boots, this video covers the startup screen. It plays muted and loops until the UI is ready. Common formats up to 50 MB are supported; .ts is not.",
      ),
      14f,
    ))

    val videoCard = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(20), dp(16), dp(20), dp(12))
      background = DsUi.roundRect(activity.getColor(R.color.ds_surface), dp(8).toFloat())
      layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        topMargin = dp(8)
      }
    }
    videoCard.addView(label(t("开屏视频", "Launch video"), 16f))
    videoCard.addView(status)
    videoCard.addView(button(t("选择视频", "Choose video")) { pick() })
    videoCard.addView(remove)
    body.addView(videoCard)

    body.addView(toggleRow())
    body.addView(label(
      t(
        "关闭后，打开应用会停在启动页，需要手动点「启动引擎」。视频仍然会在你手动启动时播放。",
        "When off, opening the app stays on the startup screen and you start the engine yourself. The video still plays on that manual start.",
      ),
      13f,
    ))

    refresh()
    view = ScrollView(activity).apply {
      isFillViewport = true
      addView(body)
    }
  }

  private fun pick() {
    status.text = t("正在打开系统文件选择器…", "Opening the system picker…")
    activity.splashImportController.requestPick { outcome ->
      when (outcome) {
        is SplashImportController.Outcome.Saved -> {
          refresh()
          toast(t("视频已保存", "Video saved"))
        }
        is SplashImportController.Outcome.Rejected -> {
          refresh()
          status.text = rejectionText(outcome.code)
        }
        SplashImportController.Outcome.Cancelled -> refresh()
      }
    }
  }

  private fun clear() {
    if (SplashStore.info(activity) == null) {
      refresh()
      return
    }
    android.app.AlertDialog.Builder(activity)
      .setTitle(t("移除开屏视频", "Remove launch video"))
      .setMessage(t("启动时将直接显示启动页，不再播放视频。", "The startup screen will appear without a video."))
      .setPositiveButton(t("移除", "Remove")) { _, _ ->
        val cleared = SplashStore.clear(activity)
        refresh()
        if (!cleared) status.text = t("文件没有删除干净，请重试。", "The file was not fully removed. Try again.")
      }
      .setNegativeButton(t("取消", "Cancel"), null)
      .show()
  }

  private fun refresh() {
    val info = SplashStore.info(activity)
    if (info == null) {
      status.text = t("未选择视频", "No video selected")
      remove.isEnabled = false
      remove.alpha = 0.45f
      return
    }
    val duration = SplashPolicy.formatDuration(info.durationMs)
    status.text = info.name + "\n" + SplashPolicy.formatBytes(info.bytes) +
      (if (duration.isNotEmpty()) " · " + duration else "")
    remove.isEnabled = true
    remove.alpha = 1f
  }

  /** Map stable codes to one short sentence; never surface a raw exception. */
  private fun rejectionText(code: String): String = when (code) {
    "forbidden-ts" -> t("不支持 .ts 视频，请换一个文件。", "MPEG-TS (.ts) videos are not supported. Choose another file.")
    "too-large" -> t("视频超过 50 MB，请压缩后再试。", "The video is larger than 50 MB. Compress it and try again.")
    "empty" -> t("这个文件是空的，请换一个视频。", "That file is empty. Choose another video.")
    "decode-failed" -> t("系统读不了这个视频的编码信息，请换一个常见格式。", "The system cannot read this video. Try a common format.")
    "no-picker" -> t("没有可用的文件选择器。", "No system file picker is available.")
    "unreadable" -> t("读不到这个文件，请重试或换一个视频。", "The file could not be read. Retry or choose another one.")
    else -> t("保存失败，请重试。", "Saving failed. Try again.")
  }

  private fun toggleRow(): View = LinearLayout(activity).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(dp(20), dp(12), dp(20), dp(12))
    minimumHeight = dp(72)
    background = DsUi.ripple(
      DsUi.roundRect(activity.getColor(R.color.ds_surface), dp(8).toFloat()),
      activity.getColor(R.color.ds_accent_soft),
    )
    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
      topMargin = dp(8)
    }
    addView(LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
      setPadding(0, 0, dp(12), 0)
      addView(label(t("打开应用后自动启动", "Start engine on app open"), 16f))
      addView(label(t("关闭后停在启动页", "Off keeps the startup screen"), 13f).apply {
        setTextColor(activity.getColor(R.color.ds_text_secondary))
        setPadding(0, dp(4), 0, 0)
      })
    })
    addView(toggle)
  }

  private fun button(text: String, onClick: () -> Unit): Button = Button(activity).apply {
    this.text = text
    isAllCaps = false
    stateListAnimator = null
    minimumHeight = dp(48)
    setTextColor(activity.getColor(R.color.ds_text_primary))
    background = DsUi.ripple(
      DsUi.roundRect(activity.getColor(R.color.ds_surface_muted), dp(8).toFloat()),
      activity.getColor(R.color.ds_accent_soft),
    )
    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
      topMargin = dp(8)
    }
    setOnClickListener { onClick() }
  }

  private fun label(value: String, size: Float): TextView = TextView(activity).apply {
    text = value
    textSize = size
    setTextColor(activity.getColor(R.color.ds_text_primary))
    setPadding(0, dp(6), 0, dp(6))
    setLineSpacing(0f, 1.2f)
  }

  private fun toast(message: String) {
    android.widget.Toast.makeText(activity, message, android.widget.Toast.LENGTH_SHORT).show()
  }

  private fun t(zh: String, en: String) = UiText.t(activity, zh, en)

  private fun dp(n: Int) = (n * activity.resources.displayMetrics.density).toInt()

  fun dispose() {
    activity.splashImportController.cancel()
  }
}
