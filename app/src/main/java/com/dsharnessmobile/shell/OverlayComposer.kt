package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat

/**
 * 底部输入区内容（§3.1 W5 / §8.1 / P4）。
 *
 * 竖排结构：
 *  1. 待答提示行（pendingHint，11sp ds_warn，空则 GONE）——「正在回答：…」；
 *  2. 药丸行：[工作区] [会话] 两个 ds_chip 胶囊（点击由服务弹选择器）；
 *  3. 附件预览条（横向，空则 GONE；chip = 名称 + 24dp 命中删除）；
 *  4. 输入行：[＋ 44dp] [EditText 1..4 行] [发送/停止 44dp 圆形按钮]；
 *  5. 抽屉（在输入行**下方**展开，视觉上向下展开）：OverlayCommandDrawer。
 *
 * 背景：只在顶部圆角（ds_radius_card）、底部直角——它是贴屏底的浮层，底部圆角会露出
 * 一条屏幕底边，观感是「悬空面板」而不是「贴底输入区」。填充 96% ds_surface + 1dp 描边；
 * 无 elevation（overlay 窗口阴影投射不到窗口外，§7.4；加了也看不见，只会误导后入）。
 *
 * 键盘策略：输入窗是 focusable + SOFT_INPUT_ADJUST_PAN（服务侧窗口参数），本类**不**监听
 * IME insets、不自己挪布局——旧方案已废（OverlayService.kt:327-329 有真因）。
 *
 * 抽屉高度动画 <=160ms，受 DsUi.animationsEnabled 门控；抽屉最大高度由服务侧窗口收口，
 * 这里不硬编码屏幕尺寸，只用「内容测量高」作为动画目标。
 */
internal class OverlayComposer(
  private val context: Context,
  private val listener: OverlayComposerListener,
) {

  private val density = context.resources.displayMetrics.density
  private val colorSurface = ContextCompat.getColor(context, R.color.ds_surface)
  private val colorChip = ContextCompat.getColor(context, R.color.ds_chip)
  private val colorBorder = ContextCompat.getColor(context, R.color.ds_border)
  private val colorTextPrimary = ContextCompat.getColor(context, R.color.ds_text_primary)
  private val colorTextSecondary = ContextCompat.getColor(context, R.color.ds_text_secondary)
  private val colorWarn = ContextCompat.getColor(context, R.color.ds_warn)
  private val colorDanger = ContextCompat.getColor(context, R.color.ds_danger)
  private val colorAccent = ContextCompat.getColor(context, R.color.ds_accent)
  private val colorOnAccent = ContextCompat.getColor(context, R.color.ds_text_on_accent)

  // ── 待答提示 ──────────────────────────────────────────────────────────────
  private val pendingHint = TextView(context).apply {
    tag = "overlay-composer-hint"
    textSize = 11f
    setTextColor(colorWarn)
    maxLines = 1
    ellipsize = android.text.TextUtils.TruncateAt.END
    setPadding(dp(16), dp(2), dp(16), dp(2))
    visibility = View.GONE
  }

  // ── 药丸行 ────────────────────────────────────────────────────────────────
  private val workspaceChip = chip(UiText.t(context, "工作区", "Workspace"), "overlay-composer-workspace") {
    listener.onComposerWorkspaceChip()
  }
  private val sessionChip = chip(UiText.t(context, "会话", "Session"), "overlay-composer-session") {
    listener.onComposerSessionChip()
  }

  private val pillRow = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(dp(12), dp(4), dp(12), dp(4))
    addView(workspaceChip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(32)).apply { marginEnd = dp(8) })
    addView(sessionChip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(32)))
  }

  // ── 附件条 ────────────────────────────────────────────────────────────────
  private val attachColumn = LinearLayout(context).apply {
    tag = "overlay-composer-attachments"
    orientation = LinearLayout.HORIZONTAL
    setPadding(dp(12), dp(2), dp(12), dp(2))
  }
  private val attachScroll = HorizontalScrollView(context).apply {
    isHorizontalScrollBarEnabled = false
    overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    addView(attachColumn, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    visibility = View.GONE
  }

  // ── 输入行 ────────────────────────────────────────────────────────────────
  private val plusButton = TextView(context).apply {
    tag = "overlay-composer-plus"
    text = "\uFF0B"
    textSize = 18f
    setTextColor(colorTextSecondary)
    gravity = Gravity.CENTER
    minWidth = dp(MIN_TOUCH_TARGET_DP)
    minHeight = dp(MIN_TOUCH_TARGET_DP)
    background = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(withAlpha(colorChip, 0.94f))
      setStroke(dp(1), colorBorder)
    }
    contentDescription = UiText.t(context, "更多：附件与命令", "More: attachments and commands")
    isClickable = true
    setOnClickListener { setDrawerOpen(true) }
  }

  private val input = EditText(context).apply {
    tag = "overlay-composer-input"
    textSize = 13f
    setTextColor(colorTextPrimary)
    setHintTextColor(colorTextSecondary)
    hint = UiText.t(context, "消息…", "Message…")
    inputType = InputType.TYPE_CLASS_TEXT or
      InputType.TYPE_TEXT_FLAG_MULTI_LINE or
      InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    minLines = 1
    maxLines = 4
    setPadding(dp(12), dp(8), dp(12), dp(8))
    background = GradientDrawable().apply {
      cornerRadius = context.resources.getDimension(R.dimen.ds_radius_md)
      setColor(withAlpha(colorChip, 0.94f))
      setStroke(dp(1), colorBorder)
    }
    // apply 里的 this 不能从匿名 TextWatcher 内部直接取，先存成局部引用（self），
    // 避免在属性自身初始化表达式中回读该属性。
    val self = this
    addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) = Unit
      override fun afterTextChanged(s: Editable) {
        // 行数变化会改输入区高度（1..4 行），服务需要重算窗口；放到下一帧读 lineCount，
        // 因为换行后的行数要等一次 layout 才是最终值。
        self.post {
          if (self.lineCount != lastInputLineCount) {
            lastInputLineCount = self.lineCount
            listener.onComposerLayoutChanged()
          }
        }
      }
    })
  }
  private var lastInputLineCount = 1

  private val actionButton = TextView(context).apply {
    tag = "overlay-composer-action"
    textSize = 12f
    gravity = Gravity.CENTER
    minWidth = dp(MIN_TOUCH_TARGET_DP)
    minHeight = dp(MIN_TOUCH_TARGET_DP)
    isClickable = true
    contentDescription = UiText.t(context, "发送", "Send")
    setOnClickListener {
      if (busy) listener.onComposerStop() else listener.onComposerSend(inputText())
    }
  }

  private val inputRow = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.BOTTOM
    setPadding(dp(8), dp(4), dp(8), dp(8))
    addView(plusButton, LinearLayout.LayoutParams(dp(MIN_TOUCH_TARGET_DP), dp(MIN_TOUCH_TARGET_DP)).apply { marginEnd = dp(4) })
    addView(input, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(4) })
    addView(actionButton, LinearLayout.LayoutParams(dp(MIN_TOUCH_TARGET_DP), dp(MIN_TOUCH_TARGET_DP)))
  }

  // ── 抽屉 ──────────────────────────────────────────────────────────────────
  private val drawer = OverlayCommandDrawer(context)

  /** 抽屉容器：高度用 layoutParams 动画（0 ↔ 内容高），内容本身仍是普通子 View。 */
  private val drawerHost = FrameLayout(context).apply {
    tag = "overlay-composer-drawer-host"
    addView(drawer.view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    visibility = View.GONE
    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0)
  }
  private var drawerOpen = false

  /** 输入区根视图：唯一供服务塞进窗口的 View。 */
  val view: View = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    background = GradientDrawable().apply {
      val radius = context.resources.getDimension(R.dimen.ds_radius_card)
      // 只有顶部两个角是圆角（顺序：TL、TR、BR、BL 各两分量）。
      cornerRadii = floatArrayOf(radius, radius, radius, radius, 0f, 0f, 0f, 0f)
      setColor(withAlpha(colorSurface, 0.96f))
      setStroke(dp(1), colorBorder)
    }
    addView(pendingHint, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(pillRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(attachScroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(inputRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(drawerHost, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0))
  }

  /** 当前是否 busy（发送按钮语义由它切换；render 里更新）。 */
  private var busy = false
  private var sendEnabled = false
  private var attachmentSignature = ""

  /**
   * 幂等渲染。
   *
   * 纪律：文本只改 TextView，附件条只在签名变化时重建（附件增删是低频结构变化），
   * 输入框内容**不**在 render 里覆盖（草稿归视图主，服务只通过 setInputText 显式写）。
   */
  fun render(data: OverlayComposerData) {
    val hint = overlaySingleLine(data.pendingHint)
    pendingHint.text = hint
    pendingHint.visibility = if (hint.isEmpty()) View.GONE else View.VISIBLE

    workspaceChip.text = chipLabel(data.workspaceLabel, "工作区", "Workspace")
    sessionChip.text = chipLabel(data.sessionLabel, "会话", "Session")

    val signature = data.attachments.joinToString("\u0001") { it.kind + "\u0002" + it.name }
    if (signature != attachmentSignature) {
      attachmentSignature = signature
      renderAttachments(data.attachments)
      // 附件条增删改变输入区高度，服务需要重算窗口。
      listener.onComposerLayoutChanged()
    }

    busy = data.busy
    sendEnabled = data.sendEnabled
    applyActionButton()
    drawer.render(
      commands = data.commands,
      onPick = { name ->
        listener.onComposerCommand(name)
        setDrawerOpen(false)
      },
      onAttach = { kind ->
        listener.onComposerAttach(kind)
        setDrawerOpen(false)
      },
    )
    if (drawerOpen) updateDrawerHeightNow()
  }

  fun inputText(): String = input.text?.toString() ?: ""

  fun setInputText(t: String) {
    input.setText(t)
    input.setSelection(input.text?.length ?: 0)
  }

  fun hasDraft(): Boolean = inputText().isNotBlank()

  /** 展开/收起抽屉（高度动画 <=160ms；动画关闭时立即到终态）。 */
  fun setDrawerOpen(open: Boolean) {
    if (open == drawerOpen) return
    drawerOpen = open
    val lp = drawerHost.layoutParams as LinearLayout.LayoutParams
    if (!DsUi.animationsEnabled(context)) {
      drawerHost.animate().cancel()
      lp.height = if (open) measureDrawerHeight() else 0
      drawerHost.layoutParams = lp
      drawerHost.visibility = if (open) View.VISIBLE else View.GONE
      listener.onComposerLayoutChanged()
      return
    }
    drawerHost.animate().cancel()
    val target = if (open) measureDrawerHeight() else 0
    if (open) drawerHost.visibility = View.VISIBLE
    val animator = android.animation.ValueAnimator.ofInt(lp.height, target).apply {
      duration = 160L
      interpolator = DsUi.ease
      addUpdateListener { va ->
        val params = drawerHost.layoutParams as LinearLayout.LayoutParams
        params.height = va.animatedValue as Int
        drawerHost.layoutParams = params
      }
      addListener(object : android.animation.AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: android.animation.Animator) {
          if (!open) drawerHost.visibility = View.GONE
          listener.onComposerLayoutChanged()
        }
      })
    }
    animator.start()
  }

  fun isDrawerOpen(): Boolean = drawerOpen

  /** 聚焦输入框并弹键盘（长按入口 → 同时展开卡片与输入区时**不**自动调用，避免刚长按就弹键盘）。 */
  fun focusInput() {
    input.requestFocus()
    input.post {
      val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
      imm?.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
    }
  }

  // ── 内部渲染 ──────────────────────────────────────────────────────────────

  private fun applyActionButton() {
    actionButton.text = if (busy) {
      UiText.t(context, "停止", "Stop")
    } else {
      UiText.t(context, "发送", "Send")
    }
    actionButton.contentDescription = actionButton.text
    actionButton.setTextColor(colorOnAccent)
    // 圆形按钮换色：GradientDrawable 的 shape 不可原地改，直接重建一个 oval。
    actionButton.background = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(if (busy) colorDanger else colorAccent)
    }
    // 停止按钮永远可点（中断整轮是紧急动作）；发送按钮由数据决定。
    actionButton.isEnabled = busy || sendEnabled
    actionButton.alpha = if (actionButton.isEnabled) 1f else 0.45f
  }

  private fun renderAttachments(items: List<OverlayAttachmentChip>) {
    attachColumn.removeAllViews()
    if (items.isEmpty()) {
      attachScroll.visibility = View.GONE
      return
    }
    for ((index, chip) in items.withIndex()) {
      attachColumn.addView(
        attachmentChip(chip, index),
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(32)).apply { marginEnd = dp(8) },
      )
    }
    attachScroll.visibility = View.VISIBLE
  }

  private fun attachmentChip(item: OverlayAttachmentChip, index: Int): View {
    val name = TextView(context).apply {
      textSize = 11f
      setTextColor(colorTextPrimary)
      maxLines = 1
      ellipsize = android.text.TextUtils.TruncateAt.END
      text = overlaySingleLine(item.name)
      // 只做「文件名 + 类型」最小实现（§8.3：若 WebView 侧才有富预览，原生侧不复制）。
      contentDescription = if (item.kind == "image") {
        UiText.t(context, "图片附件 ", "Image attachment ") + overlaySingleLine(item.name)
      } else {
        UiText.t(context, "文件附件 ", "File attachment ") + overlaySingleLine(item.name)
      }
    }
    val remove = TextView(context).apply {
      tag = "overlay-composer-attachment-remove"
      text = "\u00D7"
      textSize = 14f
      setTextColor(colorTextSecondary)
      gravity = Gravity.CENTER
      minWidth = dp(24)
      minHeight = dp(24)
      contentDescription = UiText.t(context, "移除附件", "Remove attachment")
      isClickable = true
      setOnClickListener { listener.onComposerRemoveAttachment(index) }
    }
    return LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(10), 0, dp(4), 0)
      background = GradientDrawable().apply {
        cornerRadius = context.resources.getDimension(R.dimen.ds_radius_pill)
        setColor(withAlpha(colorChip, 0.94f))
        setStroke(dp(1), colorBorder)
      }
      addView(name, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      addView(remove, LinearLayout.LayoutParams(dp(24), dp(24)).apply { marginStart = dp(2) })
    }
  }

  private fun chip(label: String, tag: String, onClick: () -> Unit): TextView = TextView(context).apply {
    this.tag = tag
    text = label + " \u25BE"
    textSize = 11f
    setTextColor(colorTextSecondary)
    gravity = Gravity.CENTER
    setPadding(dp(12), 0, dp(12), 0)
    minWidth = dp(MIN_TOUCH_TARGET_DP)
    minHeight = dp(32)
    background = GradientDrawable().apply {
      cornerRadius = context.resources.getDimension(R.dimen.ds_radius_pill)
      setColor(withAlpha(colorChip, 0.94f))
      setStroke(dp(1), colorBorder)
    }
    isClickable = true
    contentDescription = label
    setOnClickListener { onClick() }
  }

  private fun chipLabel(label: String, fallbackZh: String, fallbackEn: String): String =
    (label.ifBlank { UiText.t(context, fallbackZh, fallbackEn) }) + " \u25BE"

  private fun measureDrawerHeight(): Int {
    val width = if (view.width > 0) view.width else context.resources.displayMetrics.widthPixels
    drawer.view.measure(
      View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
    )
    return drawer.view.measuredHeight
  }

  /** 抽屉已展开时数据变化（列表增删）后的高度就地更新：不播动画，避免事件风暴抖动。 */
  private fun updateDrawerHeightNow() {
    if (drawerHost.visibility != View.VISIBLE) return
    val lp = drawerHost.layoutParams as LinearLayout.LayoutParams
    val target = measureDrawerHeight()
    if (lp.height != target) {
      lp.height = target
      drawerHost.layoutParams = lp
    }
  }

  private fun withAlpha(color: Int, fraction: Float): Int =
    (color and 0x00FFFFFF) or ((fraction.coerceIn(0f, 1f) * 255f).toInt() shl 24)

  private fun dp(value: Int): Int = (value * density).toInt()
}
