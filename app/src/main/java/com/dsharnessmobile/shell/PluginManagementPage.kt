package com.dsharnessmobile.shell

import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.Spinner
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * 插件页加载失败行（#1011 ④）。
 *
 * 缺陷现场：重试提示是硬拼的中文后缀（`"$message　点击重试"`），而 `message` 本身已经走
 * `t(...)` —— 同一行里中英混排。后缀也必须跟着语言走，且不重试时不得凭空长出提示。
 */
internal fun pluginLoadErrorMessage(message: String, retry: Boolean, english: Boolean): String =
  if (retry) message + UiText.t(english, "　点击重试", " - tap to retry") else message

/** A stopped engine is an ordinary page state; HTTP liveness alone does not mean the plugin API is ready. */
internal enum class PluginEngineAvailability { OFFLINE, STARTING, ONLINE, FAILED }

internal fun pluginEngineAvailability(
  userStopped: Boolean,
  httpAlive: Boolean,
  portAlive: Boolean,
  phase: GuidePhase,
  startPending: Boolean,
): PluginEngineAvailability = when {
  userStopped -> PluginEngineAvailability.OFFLINE
  httpAlive -> PluginEngineAvailability.ONLINE
  phase == GuidePhase.Error -> PluginEngineAvailability.FAILED
  portAlive || startPending || phase in setOf(GuidePhase.Starting, GuidePhase.Extracting,
    GuidePhase.Updating, GuidePhase.Recovering, GuidePhase.Undoing) -> PluginEngineAvailability.STARTING
  else -> PluginEngineAvailability.OFFLINE
}

/** Native plugin list and detail surface. Repository owns RPC/auth and performs network I/O off-main. */
internal class PluginManagementPage(
  private val activity: MainActivity,
  private val onBack: () -> Unit,
) {
  private val repository = PluginManagementRepository(activity)
  private val worker = Executors.newSingleThreadExecutor()
  @Volatile private var disposed = false
  private val black = activity.getColor(R.color.ds_bg)
  private val white = activity.getColor(R.color.ds_text_primary)
  private val gray1 = activity.getColor(R.color.ds_text_secondary)
  private val gray2 = activity.getColor(R.color.ds_hairline)
  private val gray3 = activity.getColor(R.color.ds_text_tertiary)
  private val gray4 = activity.getColor(R.color.ds_surface)
  private val accent = activity.getColor(R.color.ds_accent)
  private val textOnAccent = activity.getColor(R.color.ds_text_on_accent)
  private fun t(zh: String, en: String) = UiText.t(activity, zh, en)

  /** 行内双语（#1011）：插值里带变量的句子，中英两份就写在同一行。 */
  private fun s(zh: String, en: String) = UiText.t(activity, zh, en)

  private val root = LinearLayout(activity).apply {
    orientation = LinearLayout.VERTICAL
    setBackgroundColor(black)
    layoutParams = ViewGroup.LayoutParams(-1, -1)
  }
  private val content = FrameLayout(activity).apply {
    layoutParams = LinearLayout.LayoutParams(-1, 0, 1f)
  }
  private val query = EditText(activity).apply {
    setSingleLine(true)
    hint = t("搜索插件", "Search plugins")
    setHintTextColor(gray3)
    setTextColor(white)
    textSize = 15f
    setPadding(dp(14), 0, dp(14), 0)
    background = rounded(gray4, 8)
    contentDescription = t("搜索插件", "Search plugins")
  }
  private val countLabel = TextView(activity).apply {
    textSize = 12f
    setTextColor(gray3)
    gravity = Gravity.CENTER_VERTICAL
  }
  private val progress = ProgressBar(activity).apply { isIndeterminate = true }
  private val error = TextView(activity).apply {
    textSize = 14f
    setTextColor(white)
    setPadding(dp(16), dp(12), dp(16), dp(12))
    background = rounded(activity.getColor(R.color.ds_danger_soft), 8)
    visibility = View.GONE
    isFocusable = true
    contentDescription = t("插件管理错误", "Plugin management error")
  }
  private val list = ListView(activity).apply {
    divider = android.graphics.drawable.ColorDrawable(0xFF262626.toInt())
    dividerHeight = dp(1)
    cacheColorHint = black
    isVerticalScrollBarEnabled = true
  }
  private val adapter = PluginAdapter()
  private var allRows: List<PluginRow> = emptyList()
  private var filter = Filter.ALL
  private var showingDetail = false
  private var loading = false
  private lateinit var searchControls: View
  private var startPendingUntil = 0L
  private var apiWaitSince = 0L
  private var offlinePanel: PluginOfflinePanel? = null
  private val retryLoad = Runnable { load() }

  val view: View get() = root

  init {
    val header = LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(16), dp(10), dp(16), dp(10))
      setBackgroundColor(black)
    }
    val back = TextView(activity).apply {
      text = "‹"
      textSize = 32f
      setTextColor(white)
      gravity = Gravity.CENTER
      contentDescription = t("返回", "Back")
      isClickable = true
      isFocusable = true
      setOnClickListener { if (!back()) onBack() }
      layoutParams = LinearLayout.LayoutParams(dp(42), dp(48))
    }
    val title = TextView(activity).apply {
      text = t("插件管理", "Plugins")
      textSize = 20f
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      setTextColor(white)
      setPadding(dp(8), 0, 0, 0)
      layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
    }
    val refresh = TextView(activity).apply {
      text = t("刷新", "Refresh")
      textSize = 14f
      setTextColor(white)
      gravity = Gravity.CENTER
      contentDescription = t("刷新插件列表", "Refresh the plugin list")
      isClickable = true
      isFocusable = true
      setOnClickListener { load() }
      setPadding(dp(8), dp(10), dp(8), dp(10))
    }
    header.addView(back)
    header.addView(title)
    header.addView(refresh)
    root.addView(header)

    val searchBlock = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(16), dp(4), dp(16), dp(10))
      setBackgroundColor(black)
    }
    searchBlock.addView(query, LinearLayout.LayoutParams(-1, dp(46)))
    val chips = LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(0, dp(10), 0, 0)
    }
    Filter.entries.forEach { item -> chips.addView(filterChip(item)) }
    val summary = LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(0, dp(10), 0, 0)
    }
    summary.addView(countLabel, LinearLayout.LayoutParams(0, dp(24), 1f))
    progress.layoutParams = LinearLayout.LayoutParams(dp(18), dp(18))
    summary.addView(progress)
    searchBlock.addView(chips)
    searchBlock.addView(summary)
    root.addView(searchBlock)
    searchControls = searchBlock

    list.adapter = adapter
    content.addView(list, FrameLayout.LayoutParams(-1, -1))
    content.addView(error, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
    root.addView(content)

    query.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = refreshRows()
      override fun afterTextChanged(s: Editable?) = Unit
    })
    load()
  }

  fun back(): Boolean {
    if (showingDetail) {
      showingDetail = false
      content.removeAllViews()
      content.addView(list, FrameLayout.LayoutParams(-1, -1))
      content.addView(error, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
      return true
    }
    return false
  }

  fun dispose() {
    disposed = true
    root.removeCallbacks(retryLoad)
    worker.shutdownNow()
  }

  private enum class Filter { ALL, ENABLED, DISABLED }

  private fun filterChip(item: Filter): TextView = TextView(activity).apply {
    text = when (item) {
      Filter.ALL -> t("全部", "All")
      Filter.ENABLED -> t("已启用", "Enabled")
      Filter.DISABLED -> t("已停用", "Disabled")
    }
    textSize = 13f
    gravity = Gravity.CENTER
    isClickable = true
    isFocusable = true
    setPadding(dp(14), dp(8), dp(14), dp(8))
    val lp = LinearLayout.LayoutParams(-2, dp(36)).apply { marginEnd = dp(8) }
    layoutParams = lp
    setOnClickListener { filter = item; paintChips(parent as? LinearLayout); refreshRows() }
    paintChip(this, item == filter)
  }

  private fun paintChips(parent: LinearLayout?) {
    if (parent == null) return
    Filter.entries.forEachIndexed { index, item -> (parent.getChildAt(index) as? TextView)?.let { paintChip(it, filter == item) } }
  }

  private fun paintChip(view: TextView, selected: Boolean) {
    view.setTextColor(if (selected) textOnAccent else white)
    view.background = rounded(if (selected) accent else gray4, 18)
    view.contentDescription = view.text.toString() + if (selected) t("，已选", ", selected") else ""
  }

  private fun load() {
    if (disposed || loading || showingDetail) return
    root.removeCallbacks(retryLoad)
    loading = true
    setBusy(true)
    error.visibility = View.GONE
    val phase = activity.guideRenderer.lastGuidePhase
    val userStopped = activity.userClosedEngine || EngineService.userShutdown
    val requestPending = android.os.SystemClock.elapsedRealtime() < startPendingUntil
    worker.execute {
      val probe = EngineProbe.check()
      val availability = pluginEngineAvailability(
        userStopped, probe.optBoolean("running"),
        if (probe.optBoolean("running")) true else EngineProbe.portReachable(300), phase, requestPending,
      )
      if (availability != PluginEngineAvailability.ONLINE) {
        activity.runOnUiThread {
          if (disposed || activity.isFinishing || activity.isDestroyed) return@runOnUiThread
          loading = false
          setBusy(false)
          // 引擎没起来不等于「不能管理插件」：离线数据源直接读写 live 装配清单，
          // 用户才可能先把会导致崩溃的 soft 插件关掉、再启动引擎。
          showOfflineManagement(availability)
        }
        return@execute
      }
      try {
        val rows = kotlinx.coroutines.runBlocking { repository.listPlugins() }
        activity.runOnUiThread {
          if (disposed || activity.isFinishing || activity.isDestroyed) return@runOnUiThread
          loading = false
          apiWaitSince = 0L
          startPendingUntil = 0L
          allRows = rows
          showList()
          setBusy(false)
          refreshRows()
        }
      } catch (t: Exception) {
        val stillRunning = EngineProbe.check().optBoolean("running")
        activity.runOnUiThread {
          if (disposed || activity.isFinishing || activity.isDestroyed) return@runOnUiThread
          loading = false
          setBusy(false)
          if (!stillRunning) {
            showOfflineManagement(pluginEngineAvailability(activity.userClosedEngine || EngineService.userShutdown,
              false, false, activity.guideRenderer.lastGuidePhase,
              android.os.SystemClock.elapsedRealtime() < startPendingUntil))
          } else {
            val now = android.os.SystemClock.elapsedRealtime()
            if (apiWaitSince == 0L) apiWaitSince = now
            if (requestPending && now - apiWaitSince < 30_000L) {
              showEngineAvailability(PluginEngineAvailability.STARTING)
            } else {
              showList()
              countLabel.text = t("清单暂不可用", "List unavailable")
              showError(t("暂时无法读取插件，请稍后刷新。", "Could not read plugins right now; refresh later. ") + t.message.orEmpty(), retry = true)
            }
          }
        }
      }
    }
  }

  /** 在线路径的列表（引擎活着，走 pluginManager RPC）。 */
  private fun showList() {
    offlinePanel = null
    showingDetail = false
    searchControls.visibility = View.VISIBLE
    content.removeAllViews()
    content.addView(list, FrameLayout.LayoutParams(-1, -1))
    content.addView(error, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
    error.visibility = View.GONE
  }

  /**
   * 离线路径：引擎没起来时仍可管理 soft 插件（直接读写 live 装配清单）。
   *
   * 为什么必须在这里而不是只给一个「启动引擎」按钮：会导致引擎起不来的插件，恰恰是用户唯一需要
   * 先关掉的东西；旧实现把它挡在「先起引擎」之后，形成死循环。
   * 启动中的状态不抢页面（用户正在等引擎起来），但按钮仍可用；启动失败与未启动一律给离线列表。
   */
  private fun showOfflineManagement(state: PluginEngineAvailability) {
    showingDetail = false
    allRows = emptyList()
    adapter.rows = emptyList()
    adapter.notifyDataSetChanged()
    searchControls.visibility = View.GONE
    error.visibility = View.GONE
    if (state == PluginEngineAvailability.STARTING) {
      showEngineAvailability(state)
      return
    }
    val panel = offlinePanel ?: PluginOfflinePanel(activity).also { offlinePanel = it }
    panel.reload()
    content.removeAllViews()
    content.addView(panel.view, FrameLayout.LayoutParams(-1, -1))
  }

  /** 离线态的「启动引擎」主入口：仍复用引导页主按钮（含维护隔离与恢复闸门），只是不再挡列表。 */
  private fun launchEngineFromHere() {
    val primary = activity.guideRenderer.chrome.primaryButton
    if (!primary.isEnabled) {
      showEngineAvailability(PluginEngineAvailability.STARTING)
      return
    }
    startPendingUntil = android.os.SystemClock.elapsedRealtime() + 15_000L
    apiWaitSince = 0L
    // Use the existing explicit launch outlet, including its maintenance and recovery guards.
    primary.performClick()
  }

  private fun showEngineAvailability(state: PluginEngineAvailability) {
    showingDetail = false
    allRows = emptyList()
    adapter.rows = emptyList()
    adapter.notifyDataSetChanged()
    searchControls.visibility = View.GONE
    error.visibility = View.GONE
    content.removeAllViews()
    val waiting = state == PluginEngineAvailability.STARTING
    val failed = state == PluginEngineAvailability.FAILED
    val panel = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      setPadding(dp(24), dp(32), dp(24), dp(24))
    }
    panel.addView(label(when {
      waiting -> t("正在启动引擎", "Starting the engine")
      failed -> t("引擎尚未启动成功", "The engine did not start")
      else -> t("引擎未启动", "The engine is stopped")
    }, 20, white, true))
    panel.addView(label(when {
      waiting -> t("就绪后会自动加载插件。首次准备运行时可能需要几分钟。", "Plugins load as soon as the engine is ready. Preparing the runtime for the first time can take a few minutes.")
      failed -> t("请返回启动页重试，或打开控制台查看原因。", "Go back and retry, or open the console for the reason.")
      else -> t("启动引擎后，即可读取插件列表并管理运行状态。", "Start the engine to list plugins and manage them.")
    }, 14, gray1).apply { gravity = Gravity.CENTER; setPadding(0, dp(12), 0, dp(20)) })
    if (waiting) {
      panel.addView(ProgressBar(activity).apply {
        indeterminateTintList = android.content.res.ColorStateList.valueOf(accent)
      }, LinearLayout.LayoutParams(dp(28), dp(28)))
      root.postDelayed(retryLoad, 1_500L)
    } else {
      panel.addView(actionButton(if (failed) t("返回管理中心", "Back to management") else t("启动引擎", "Start engine")) {
        if (failed) onBack() else launchEngineFromHere()
      }.apply {
        setTextColor(textOnAccent)
        background = DsUi.ripple(DsUi.roundRect(accent, dp(8).toFloat()), activity.getColor(R.color.ds_accent_pressed))
        minimumHeight = dp(48)
        layoutParams = LinearLayout.LayoutParams(-1, -2)
      })
    }
    content.addView(ScrollView(activity).apply { addView(panel) }, FrameLayout.LayoutParams(-1, -1))
  }

  private fun changeEnabled(row: PluginRow, enabled: Boolean) {
    if (!enabled) {
      android.app.AlertDialog.Builder(activity)
        .setTitle(t("停用插件", "Disable plugin"))
        .setMessage(
          t(
            "将重新加载插件，并检查其他插件的运行状态。若造成其他插件失活，会尝试恢复并报告结果。确认停用 ${row.moduleName}？",
            "Plugins reload and the others are checked. If one stops working, it is restored and the result is reported. Disable ${row.moduleName}?",
          ),
        )
        .setNegativeButton(t("取消", "Cancel")) { _, _ -> adapter.notifyDataSetChanged() }
        .setPositiveButton(t("停用", "Disable")) { _, _ -> performEnabledChange(row, enabled) }
        .setOnCancelListener { adapter.notifyDataSetChanged() }
        .show()
      return
    }
    performEnabledChange(row, enabled)
  }

  private fun performEnabledChange(row: PluginRow, enabled: Boolean) {
    setBusy(true)
    error.visibility = View.GONE
    worker.execute {
      try {
        val result = kotlinx.coroutines.runBlocking { repository.setPluginEnabled(row.entryId, enabled) }
        activity.runOnUiThread {
          if (disposed || activity.isFinishing || activity.isDestroyed) return@runOnUiThread
          setBusy(false)
          val application = result.optString("application")
          if (application in setOf("applied", "restart-required", "overridden")) {
            when (application) {
              "restart-required" -> showError(s("${row.moduleName} 已记录变更，重启引擎后生效。", "Change to ${row.moduleName} recorded; restart the engine to apply it."), false)
              "overridden" -> showError(s("${row.moduleName} 的状态被策略覆盖，已重新读取实际状态。", "A policy overrides the state of ${row.moduleName}; the actual state was read again."), false)
            }
            load()
          } else {
            reloadAfterMutationError(s("${row.moduleName} 启停结果未确认，已回读实际状态。", "The enable/disable result for ${row.moduleName} is unconfirmed; the actual state was read again."))
          }
        }
      } catch (t: Throwable) {
        activity.runOnUiThread {
          if (disposed || activity.isFinishing || activity.isDestroyed) return@runOnUiThread
          reloadAfterMutationError(s("${row.moduleName} 启停失败：", "Could not enable/disable ${row.moduleName}: ") + (t.message ?: s("正在回读实际状态", "re-reading the actual state")))
        }
      }
    }
  }

  private fun reloadAfterMutationError(message: String) {
    setBusy(true)
    worker.execute {
      val rows = runCatching { kotlinx.coroutines.runBlocking { repository.listPlugins() } }.getOrNull()
      activity.runOnUiThread {
        if (disposed || activity.isFinishing || activity.isDestroyed) return@runOnUiThread
        setBusy(false)
        if (rows != null) {
          allRows = rows
          refreshRows()
        }
        showError(if (rows == null) message + s(" 清单回读也失败。", " Re-reading the list failed too.") else message, false)
      }
    }
  }

  private fun openDetail(row: PluginRow) {
    showingDetail = true
    val page = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(18), dp(18), dp(18), dp(18))
      setBackgroundColor(black)
      isFocusableInTouchMode = true
    }
    page.addView(label(rowTitle(row), 22, white, true))
    page.addView(label(t("模块名：", "Module: ") + row.moduleName, 14, gray1))
    page.addView(label(stateSummary(row) + t(" · 实际状态：", " · actual: ") + (if (row.enabled) t("已启用", "enabled") else t("已停用", "disabled")), 14, gray1))
    page.addView(label(t("运行阶段：", "Phase: ") + row.fiberPhase.ifBlank { t("未知", "unknown") }, 14, gray1))
    val description = rowDescription(row).ifBlank { t("暂无描述", "No description") }
    page.addView(label(t("描述：", "Description: ") + description, 14, gray1))
    row.patchId?.takeIf { it.isNotBlank() }?.let { page.addView(label(s("补丁：", "Patch: ") + it, 13, gray3)) }
    row.readOnlyReason?.takeIf { it.isNotBlank() }?.let { page.addView(label(s("只读原因：", "Read-only reason: ") + it, 13, gray3)) }
    val configStatus = label(t("正在读取配置…", "Reading settings…"), 14, gray3)
    page.addView(configStatus)
    content.removeAllViews()
    content.addView(ScrollView(activity).apply {
      isFillViewport = true
      addView(page, ViewGroup.LayoutParams(-1, -2))
    }, FrameLayout.LayoutParams(-1, -1))
    worker.execute {
      try {
        val config = kotlinx.coroutines.runBlocking { repository.pluginConfiguration(row.entryId) }
        activity.runOnUiThread {
          if (disposed || activity.isFinishing || activity.isDestroyed) return@runOnUiThread
          if (!showingDetail || page.parent == null) return@runOnUiThread
          page.removeView(configStatus)
          if (config == null) {
            page.addView(label(s("暂无可编辑 schema。插件可能尚未激活，或未提供配置 schema。", "No editable schema. The plugin may not be active, or it provides no configuration schema."), 14, gray3))
          } else {
            val writable = config.optBoolean("writable", false)
            val hasUserConfig = (config.optJSONObject("user")?.length() ?: 0) > 0
            page.addView(label(s("配置：", "Settings: ") + (if (hasUserConfig) s("已配置", "configured") else s("使用默认值", "defaults")) + " · " + (if (writable) s("可写", "writable") else s("只读", "read-only")), 14, gray1))
            addNamespaceEditor(page, row, config, writable)
          }
        }
      } catch (t: Throwable) {
        activity.runOnUiThread {
          if (disposed || activity.isFinishing || activity.isDestroyed) return@runOnUiThread
          if (showingDetail && page.parent != null) {
            page.removeView(configStatus)
            page.addView(label(s("读取配置失败：", "Could not read settings: ") + (t.message ?: s("请重试", "retry")), 14, activity.getColor(R.color.ds_danger)))
          }
        }
      }
    }
  }

  private fun addNamespaceEditor(page: LinearLayout, row: PluginRow, namespace: JSONObject, globallyWritable: Boolean) {
    val nsName = namespace.optString("ns")
    val revision = namespace.optInt("revision", -1)
    val schema = namespace.optJSONObject("schema")
    val secretPaths = secretPaths(namespace)
    val initial = namespace.optJSONObject("user")?.let { JSONObject(it.toString()) } ?: JSONObject()
    secretPaths.forEach { path -> removePath(initial, path) }
    page.addView(label(nsName.ifBlank { s("插件配置", "Plugin settings") }, 15, white, true))
    page.addView(label(s("高级配置：编辑 JSON 对象并合并保存，可保留未知字段。删除字段不会重置原值；版本冲突时请重新加载。", "Advanced: edit the JSON object and save to merge; unknown fields are kept. Deleting a field does not reset its value; reload after a version conflict."), 13, gray3))
    if (!globallyWritable || !namespace.optBoolean("writable", true) || revision < 0) {
      page.addView(label(s("当前配置不可编辑：服务未提供可写描述或版本号。", "The current settings are not editable: the service provides no writable descriptor or version."), 14, activity.getColor(R.color.ds_danger)))
      return
    }
    val secretInputs = linkedMapOf<List<String>, EditText>()
    if (secretPaths.isNotEmpty()) page.addView(label(s("已设置的敏感值不会回填。仅在密码框输入新值时才会更新。", "Stored secrets are never shown. They only change when you type a new value in the password field."), 13, gray3))
    val editor = EditText(activity).apply {
      setText(initial.toString(2))
      setTextColor(white)
      setHintTextColor(gray3)
      textSize = 13f
      typeface = Typeface.MONOSPACE
      gravity = Gravity.TOP or Gravity.START
      minLines = 5
      maxLines = 16
      setHorizontallyScrolling(false)
      inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or
        android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
      setPadding(dp(12), dp(10), dp(12), dp(10))
      background = rounded(gray4, 8)
      contentDescription = "$nsName " + t("高级 JSON 配置", "advanced JSON config")
    }
    val editorLp = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8); bottomMargin = dp(8) }
    page.addView(editor, editorLp)
    addPrimitiveControls(page, schema, editor, namespace.optJSONObject("value") ?: JSONObject())
    secretPaths.forEach { path ->
      val secret = EditText(activity).apply {
        hint = path.joinToString(".") + s("：已设置，留空保留原值", ": set; leave blank to keep the current value")
        setHintTextColor(gray3)
        setTextColor(white)
        textSize = 14f
        inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        setSingleLine(true)
        setPadding(dp(10), dp(8), dp(10), dp(8))
        background = rounded(gray4, 8)
        contentDescription = t("设置敏感配置", "Set sensitive config") + " " + path.joinToString(".")
      }
      secretInputs[path] = secret
      page.addView(secret, LinearLayout.LayoutParams(-1, dp(44)).apply { bottomMargin = dp(6) })
    }
    val actions = LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.END
    }
    val reload = actionButton("重新加载") {
      openDetail(row)
    }
    lateinit var save: Button
    save = actionButton("保存") {
      val submitted = try {
        JSONObject(editor.text.toString())
      } catch (_: Throwable) {
        showError("配置必须是有效的 JSON 对象。", false)
        return@actionButton
      }
      secretInputs.forEach { (path, input) ->
        val value = input.text.toString()
        if (value.isNotEmpty()) putPath(submitted, path, value)
      }
      saveNamespace(row, nsName, submitted, revision, save)
    }
    actions.addView(reload)
    actions.addView(save)
    page.addView(actions)
  }

  /** Schema-declared primitive fields get native text/check controls; the full JSON stays available. */
  private fun addPrimitiveControls(page: LinearLayout, schema: JSONObject?, editor: EditText, effective: JSONObject) {
    val properties = schema?.optJSONObject("properties") ?: schema?.optJSONObject("dict") ?: return
    if (properties.length() == 0) return
    page.addView(label("常用字段", 13, gray3, true))
    val keys = properties.keys()
    while (keys.hasNext()) {
      val key = keys.next()
      val field = properties.optJSONObject(key) ?: JSONObject().put("type", properties.opt(key)?.toString())
      val type = field.optString("type")
      val enum = field.optJSONArray("enum")
      when {
        enum != null && enum.length() in 1..20 -> {
          val opts = listOf("不修改此字段") + (0 until enum.length()).map { enum.optString(it) }
          val current = try { JSONObject(editor.text.toString()).optString(key) } catch (_: Throwable) { "" }
          val originalIndex = if (current.isBlank()) 0 else opts.indexOf(current).coerceAtLeast(0)
          var changedByUser = false
          val fieldLabel = label(field.optString("title").ifBlank { key }, 13, gray1)
          page.addView(fieldLabel)
          val spinner = Spinner(activity).apply {
            adapter = android.widget.ArrayAdapter(activity, android.R.layout.simple_spinner_dropdown_item, opts)
            setSelection(originalIndex)
            contentDescription = field.optString("title").ifBlank { key }
            onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
              override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
              override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (!changedByUser && position == originalIndex) return
                changedByUser = true
                updateEditorValue(editor, key) { if (position > 0) it.put(key, enum.opt(position - 1)) else it.remove(key) }
              }
            }
          }
          page.addView(spinner, LinearLayout.LayoutParams(-1, dp(46)))
        }
        type == "boolean" -> {
          val check = android.widget.CheckBox(activity).apply {
            text = field.optString("title").ifBlank { key }
            setTextColor(gray1)
            buttonTintList = android.content.res.ColorStateList.valueOf(white)
            isChecked = try { JSONObject(editor.text.toString()).optBoolean(key, effective.optBoolean(key)) } catch (_: Throwable) { false }
            setOnCheckedChangeListener { _, checked -> updateEditorValue(editor, key) { it.put(key, checked) } }
          }
          page.addView(check)
        }
        type == "string" || type == "number" || type == "integer" -> {
          val input = EditText(activity).apply {
            hint = field.optString("title").ifBlank { key }
            setHintTextColor(gray3)
            setTextColor(white)
            textSize = 14f
            setSingleLine(true)
            setPadding(dp(10), dp(8), dp(10), dp(8))
            background = rounded(gray4, 8)
            val current = try { (JSONObject(editor.text.toString()).opt(key) ?: effective.opt(key))?.toString().orEmpty() } catch (_: Throwable) { "" }
            setText(current)
            inputType = if (type == "string") android.text.InputType.TYPE_CLASS_TEXT else
              android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_SIGNED or
                if (type == "number") android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL else 0
            setOnFocusChangeListener { _, focused -> if (!focused && text.toString() != current) updateEditorValue(editor, key) { obj ->
              val raw = text.toString()
              when (type) {
                "number" -> raw.toDoubleOrNull()?.let { obj.put(key, it) }
                "integer" -> raw.toLongOrNull()?.let { obj.put(key, it) }
                else -> obj.put(key, raw)
              }
            } }
          }
          page.addView(input, LinearLayout.LayoutParams(-1, dp(44)).apply { bottomMargin = dp(6) })
        }
      }
    }
  }

  private fun updateEditorValue(editor: EditText, key: String, mutate: (JSONObject) -> Unit) {
    try {
      val value = JSONObject(editor.text.toString())
      mutate(value)
      editor.setText(value.toString(2))
    } catch (_: Throwable) {
      showError("先修正 JSON 格式，再使用常用字段控件。", false)
    }
  }

  private fun saveNamespace(row: PluginRow, ns: String, patch: JSONObject, revision: Int, button: Button) {
    button.isEnabled = false
    worker.execute {
      try {
        val result = kotlinx.coroutines.runBlocking {
          repository.savePluginConfiguration(row.entryId, patch, revision)
        }
        activity.runOnUiThread {
          if (disposed || activity.isFinishing || activity.isDestroyed) return@runOnUiThread
          button.isEnabled = true
          val applied = result.optString("application", t("已应用", "applied"))
          Toast.makeText(activity, t("配置已保存：", "Configuration saved: ") + applied, Toast.LENGTH_SHORT).show()
          openDetail(row)
        }
      } catch (t: Throwable) {
        activity.runOnUiThread {
          if (disposed || activity.isFinishing || activity.isDestroyed) return@runOnUiThread
          button.isEnabled = true
          showError("配置保存失败：${t.message ?: "请重新加载后再试"}", false)
        }
      }
    }
  }

  private fun secretPaths(namespace: JSONObject): List<List<String>> {
    val secrets = namespace.optJSONArray("secrets") ?: return emptyList()
    return (0 until secrets.length()).mapNotNull { index ->
      val item = secrets.optJSONObject(index) ?: return@mapNotNull null
      if (!item.optBoolean("set", false)) return@mapNotNull null
      val path = item.opt("path")
      when (path) {
        is org.json.JSONArray -> (0 until path.length()).map { path.optString(it) }.filter { it.isNotBlank() }
        is String -> path.split('.', '/').filter { it.isNotBlank() }
        else -> null
      }
    }
  }

  private fun removePath(root: JSONObject, path: List<String>) {
    if (path.isEmpty()) return
    var parent = root
    path.dropLast(1).forEach { key -> parent = parent.optJSONObject(key) ?: return }
    parent.remove(path.last())
  }

  private fun putPath(root: JSONObject, path: List<String>, value: String) {
    if (path.isEmpty()) return
    var parent = root
    path.dropLast(1).forEach { key ->
      val child = parent.optJSONObject(key) ?: JSONObject().also { parent.put(key, it) }
      parent = child
    }
    parent.put(path.last(), value)
  }

  private fun actionButton(text: String, action: () -> Unit): Button = Button(activity).apply {
    this.text = text
    setTextColor(white)
    textSize = 13f
    background = rounded(gray4, 8)
    isAllCaps = false
    contentDescription = text
    setOnClickListener { action() }
    val lp = LinearLayout.LayoutParams(-2, dp(42)).apply { marginStart = dp(6); marginEnd = dp(6); bottomMargin = dp(6) }
    layoutParams = lp
  }

  private fun refreshRows() {
    val needle = query.text?.toString()?.trim()?.lowercase().orEmpty()
    val rows = allRows.filter { row ->
      val statusOk = when (filter) { Filter.ALL -> true; Filter.ENABLED -> row.enabled; Filter.DISABLED -> !row.enabled }
      val searchable = listOf(rowTitle(row), row.moduleName, rowDescription(row), row.entryId).joinToString(" ").lowercase()
      statusOk && (needle.isEmpty() || searchable.contains(needle))
    }
    adapter.rows = rows
    countLabel.text = if (UiText.isEnglish(activity)) rows.size.toString() + " plugins" else rows.size.toString() + " 个插件"
    adapter.notifyDataSetChanged()
  }

  private fun setBusy(busy: Boolean) {
    progress.visibility = if (busy) View.VISIBLE else View.GONE
    query.isEnabled = !busy
    list.isEnabled = !busy
  }

  private fun showError(message: String, retry: Boolean) {
    error.text = pluginLoadErrorMessage(message, retry, UiText.isEnglish(activity))
    error.setOnClickListener(if (retry) View.OnClickListener { load() } else null)
    error.visibility = View.VISIBLE
    Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
  }

  private inner class PluginAdapter : BaseAdapter() {
    var rows: List<PluginRow> = emptyList()
    override fun getCount() = rows.size
    override fun getItem(position: Int) = rows[position]
    override fun getItemId(position: Int) = rows[position].entryId.hashCode().toLong()
    fun rowAt(position: Int) = rows[position]

    override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
      val row = getItem(position)
      val holder = (convertView?.tag as? Holder) ?: makeHolder().also { convertViewHolder ->
        // Holder stores the row root and reusable child views for ListView recycling.
        convertViewHolder.root.tag = convertViewHolder
      }
      holder.name.text = rowTitle(row)
      holder.id.text = row.entryId
      holder.description.text = rowDescription(row).ifBlank { t("暂无描述", "No description") }
      holder.switch.setOnCheckedChangeListener(null)
      val desiredEnabled = row.desiredEnabled ?: row.enabled
      holder.switch.isChecked = desiredEnabled
      holder.switch.isEnabled = row.readOnlyReason.isNullOrBlank()
      holder.switch.contentDescription = rowTitle(row) + ", " + stateSummary(row) + ", " + t("启用开关", "enable switch")
      holder.switch.setOnCheckedChangeListener { _, enabled ->
        if (enabled != desiredEnabled) changeEnabled(row, enabled)
      }
      holder.state.text = stateSummary(row)
      holder.root.contentDescription = rowTitle(row) + ", " + stateSummary(row) + ", " + holder.description.text + ". " + t("查看详情", "Open details")
      holder.root.isFocusable = true
      holder.root.isClickable = true
      holder.root.setOnClickListener { openDetail(row) }
      return holder.root
    }
  }

  private class Holder(val root: LinearLayout, val name: TextView, val id: TextView, val state: TextView, val description: TextView, val switch: Switch)

  private fun makeHolder(): Holder {
    val card = LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(16), dp(14), dp(16), dp(14))
      setBackgroundColor(black)
      minimumHeight = dp(82)
    }
    val textCol = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
      setPadding(0, 0, dp(12), 0)
    }
    val name = label("", 16, white, true)
    val id = label("", 12, gray3)
    val state = label("", 12, gray1)
    val description = label("", 13, gray1)
    description.maxLines = 2
    textCol.addView(name)
    textCol.addView(id)
    textCol.addView(state)
    textCol.addView(description)
    val sw = Switch(activity).apply {
      textOn = ""
      textOff = ""
      showText = false
      contentDescription = t("插件启用开关", "Plugin enabled switch")
      minWidth = dp(52)
      minHeight = dp(48)
      thumbTintList = android.content.res.ColorStateList(
        arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
        intArrayOf(textOnAccent, white),
      )
      trackTintList = android.content.res.ColorStateList(
        arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
        intArrayOf(accent, activity.getColor(R.color.ds_surface_muted)),
      )
    }
    card.addView(textCol)
    card.addView(sw)
    return Holder(card, name, id, state, description, sw)
  }

  private fun stateSummary(row: PluginRow): String {
    val desired = row.desiredEnabled ?: row.enabled
    if (row.pendingRestart || desired != row.enabled) {
      return t("等待重启 · 将", "Restart pending · will be ") + (if (desired) t("启用", "enabled") else t("停用", "disabled"))
    }
    if (!row.enabled) return t("已停用", "Disabled")
    val phase = row.fiberPhase.ifBlank { t("未知", "unknown") }
    return if (phase.equals("active", ignoreCase = true)) t("已启用", "Enabled") else t("已启用 · ", "Enabled · ") + phase
  }

  private fun label(value: String, size: Int, color: Int, medium: Boolean = false) = TextView(activity).apply {
    text = value
    textSize = size.toFloat()
    setTextColor(color)
    if (medium) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    setPadding(0, dp(3), 0, dp(3))
    setLineSpacing(0f, 1.2f)
  }

  private fun rowTitle(row: PluginRow): String = localized(row.meta?.opt("title") ?: row.meta?.opt("name"))
    .ifBlank { row.moduleName }

  private fun rowDescription(row: PluginRow): String = localized(row.meta?.opt("description"))

  private fun localized(value: Any?): String = when (value) {
    is String -> value
    is org.json.JSONObject -> sequenceOf("zh-CN", "zh", "en").mapNotNull { value.optString(it).takeIf(String::isNotBlank) }
      .firstOrNull() ?: value.keys().asSequence().mapNotNull { value.optString(it).takeIf(String::isNotBlank) }.firstOrNull().orEmpty()
    else -> ""
  }

  private fun codeBlock(value: String): TextView = TextView(activity).apply {
    text = value
    textSize = 12f
    typeface = Typeface.MONOSPACE
    setTextColor(gray1)
    setPadding(dp(12), dp(10), dp(12), dp(10))
    background = rounded(gray4, 8)
    setTextIsSelectable(true)
    val lp = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(4); bottomMargin = dp(10) }
    layoutParams = lp
  }

  private fun rounded(color: Int, radiusDp: Int): GradientDrawable = GradientDrawable().apply {
    setColor(color)
    cornerRadius = dp(radiusDp).toFloat()
  }

  private fun dp(value: Int): Int = (value * activity.resources.displayMetrics.density + 0.5f).toInt()
}
