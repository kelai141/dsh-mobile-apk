package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Rect
import android.graphics.Region
import android.util.Base64
import android.widget.ImageView
import android.graphics.drawable.GradientDrawable
import android.widget.FrameLayout
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat

/**
 * 底部输入区内容（§3.1 W5 / §8.1 / P4）。
 *
 * 竖排结构：
 *  1. 待答提示行（pendingHint，11sp ds_warn，空则 GONE）——「正在回答：…」；
 *  2. 工作区/会话胶囊由 [workspaceView]/[sessionView] 交付独立有界窗口，不属于本根；
 *  3. 附件预览条（横向，空则 GONE；chip = 名称 + 24dp 命中删除）；
 *  4. 输入行：[＋ 44dp] [EditText 1..4 行] [发送/停止 44dp 圆形按钮]；
 *
 * 根透明，工作区/会话胶囊不再共用透明整行；输入行完整圆角药丸离底由编排层定位。
 * 选择卡片通过 [drawerView] 交付独立窗口，绝不加入输入根、不用展开撑高输入区。
 *
 * 键盘策略：输入窗是 focusable + SOFT_INPUT_ADJUST_PAN（服务侧窗口参数），本类**不**监听
 * IME insets、不自己挪布局——旧方案已废（OverlayService.kt:327-329 有真因）。
 *
 * 抽屉只做 alpha/translationY 的有限过渡（展开 170ms / 收起 140ms，数值取自 [OverlayMotionSpec]；
 * 系统关动画时 0ms 直接到终态），最大可用高由编排层注入；不逐帧变更高度或窗口布局，
 * detach/重新打开必须废弃旧关闭回调。
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
    maxLines = 4
    ellipsize = android.text.TextUtils.TruncateAt.END
    setPadding(dp(16), dp(2), dp(16), dp(2))
    visibility = View.GONE
  }

  private val answerActions = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    addView(chip(UiText.t(context, "完整问答 / 选项", "Full form / options"), "overlay-answer-full") { listener.onComposerFullQuestionForm() })
    addView(chip(UiText.t(context, "返回消息", "Back to message"), "overlay-answer-cancel") { listener.onComposerCancelAnswer() })
    visibility = View.GONE
  }

  // ── 药丸行 ────────────────────────────────────────────────────────────────
  private val workspaceChip = chip(UiText.t(context, "工作区", "Workspace"), "overlay-composer-workspace") {
    listener.onComposerWorkspaceChip()
  }
  private val sessionChip = chip(UiText.t(context, "会话", "Session"), "overlay-composer-session") {
    listener.onComposerSessionChip()
  }

  /** Same stable chip objects; the orchestrator alone adds each to its own bounded window. */
  val workspaceView: View get() = workspaceChip
  val sessionView: View get() = sessionChip
  /**
   * Vertical gap between the chip row and the input pill, in px.
   *
   * Why 8dp became 16dp: chips live in their own bounded windows directly above the pill, while the
   * plus button sits inside the pill. At 8dp the two hit regions were only 16px apart on this device,
   * so a quick tap while reaching for a chip landed on the plus and opened the sheet instead - the
   * race the user reported. 16dp separates the targets without moving the input itself.
   */
  val chipGapPx: Int get() = dp(16)

  fun chipsVisible(): Boolean = workspaceChip.visibility == View.VISIBLE

  private data class ChipMeasureKey(val width: Int, val workspace: String, val session: String, val densityDpi: Int, val fontScale: Float)
  private var chipMeasureKey: ChipMeasureKey? = null
  private var measuredChipSizes: Pair<Pair<Int, Int>, Pair<Int, Int>>? = null

  /** Natural sizes cached by labels/width/config; geometry-only pre-draw checks never remeasure. */
  fun chipSizesPx(composerWidthPx: Int): Pair<Pair<Int, Int>, Pair<Int, Int>> {
    val config = context.resources.configuration
    val key = ChipMeasureKey(composerWidthPx, workspaceChip.text.toString(), sessionChip.text.toString(), config.densityDpi, config.fontScale)
    val cached = measuredChipSizes
    if (chipMeasureKey == key && cached != null) return cached
    val widthLimit = overlayChipWidthLimitPx(composerWidthPx, chipGapPx)
    val height = dp(32).coerceAtLeast(1)
    val sizes = measureChip(workspaceChip, widthLimit, height) to measureChip(sessionChip, widthLimit, height)
    chipMeasureKey = key
    measuredChipSizes = sizes
    return sizes
  }

  private fun measureChip(chip: TextView, widthLimit: Int, height: Int): Pair<Int, Int> {
    if (chip.maxWidth != widthLimit) chip.maxWidth = widthLimit
    chip.measure(
      View.MeasureSpec.makeMeasureSpec(widthLimit, View.MeasureSpec.AT_MOST),
      View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY),
    )
    return chip.measuredWidth.coerceIn(0, widthLimit) to height
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
  // 加号与发送按钮共用同一组几何比例（见 OverlayPlusGlyphView）：字体字形在 44dp 圆里
  // 笔画偏细、视觉偏小，和自绘箭头放在一行会读成两个不同尺寸的按钮。
  private val plusButton = OverlayPlusGlyphView(context).apply {
    tag = "overlay-composer-plus"
    contentDescription = UiText.t(context, "更多：附件与命令", "More: attachments and commands")
    isClickable = true
    setOnClickListener { listener.onComposerToggleDrawer() }
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
    background = null
    // apply 里的 this 不能从匿名 TextWatcher 内部直接取，先存成局部引用（self），
    addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) = Unit
      override fun afterTextChanged(s: Editable) {
        // 有字/没字决定发送按钮画箭头还是画方块，必须跟着内容立刻变。
        applyActionButton()
      }
    })
  }

  /**
   * 发送/停止按钮：蓝色圆形，空闲画上箭头，输入为空时画白色方块，忙碌时也画方块。
   *
   * 为什么用自绘而不是文字：文字"发送/停止"在 44dp 圆里只能压到 12sp，中英文宽度差异还会
   * 让它看起来左右不居中；箭头/方块是几何图形，任何字体缩放下都精确居中。
   */
  private val actionButton = OverlayActionGlyphView(context).apply {
    tag = "overlay-composer-action"
    contentDescription = UiText.t(context, "发送", "Send")
    isClickable = true
    setOnClickListener {
      // 与按钮形态严格一致：只有"运行中且没字"才是停止，其余都是发送（含运行中插话）。
      if (busy && !hasSendableDraft()) listener.onComposerStop() else listener.onComposerSend(inputText())
    }
  }

  private val inputRow = LinearLayout(context).apply {
    tag = "overlay-composer-input-pill"
    orientation = LinearLayout.HORIZONTAL
    // 必须居中而不是贴底：输入框会随行数（1..4 行）长高，贴底会让加号和发送按钮
    // 随之上浮/下沉，视觉上跟文字基线对不齐（设备实测曾偏差 5px，且加号比输入框高 13px）。
    gravity = Gravity.CENTER_VERTICAL
    setPadding(dp(8), dp(6), dp(8), dp(6))
    background = GradientDrawable().apply {
      cornerRadius = dp(32).toFloat()
      setColor(colorSurface)
      setStroke(dp(1), colorBorder)
    }
    addView(plusButton, LinearLayout.LayoutParams(dp(MIN_TOUCH_TARGET_DP), dp(MIN_TOUCH_TARGET_DP)).apply { marginEnd = dp(4) })
    addView(input, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(4) })
    addView(actionButton, LinearLayout.LayoutParams(dp(MIN_TOUCH_TARGET_DP), dp(MIN_TOUCH_TARGET_DP)))
  }

  // ── 抽屉 ──────────────────────────────────────────────────────────────────
  private val drawer = OverlayCommandDrawer(context)

  private var drawerOpen = false
  private var maxDrawerHeightPx = 0
  private var attached = false
  private var motionEnabled = false
  private var unregisterMotionListener: (() -> Unit)? = null
  private var drawerAnimationGeneration = 0L
  private var drawerAnimationTargetAlpha: Float? = null
  private var drawerAnimationTargetTranslationY = 0f
  private var drawerAnimationEnd: (() -> Unit)? = null
  /** 展开/收起沿 Y 的位移（px）：数值来自 OverlayMotionSpec，本类不写第二份。 */
  private val drawerSlidePx = OverlayMotionSpec.DRAWER_SLIDE_DP * context.resources.displayMetrics.density

  /** 独立不透底 sheet：以实色承接文字，覆盖原输入而不移动它；Back/outside 仍走原网关。 */
  val drawerView: View = BackKeyPanelLayout(context) { listener.onComposerBack() }.apply {
    tag = "overlay-composer-drawer-host"
    orientation = LinearLayout.VERTICAL
    isFocusableInTouchMode = true
    descendantFocusability = ViewGroup.FOCUS_BEFORE_DESCENDANTS
    // 默认是接底通栏形态：只圆上两角。切到选择器气泡时由 setDrawerFloating 换成四角全圆。
    background = GradientDrawable().apply {
      val radius = context.resources.getDimension(R.dimen.ds_radius_card)
      cornerRadii = floatArrayOf(radius, radius, radius, radius, 0f, 0f, 0f, 0f)
      setColor(colorSurface)
      setStroke(dp(1), colorBorder)
    }
    clipToOutline = true
    addView(drawer.view, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
  }

  /**
   * sheet 背景：贴底的通栏只圆上两角，浮起的气泡四角全圆。
   *
   * 为什么必须区分：接底形态如果四角全圆，下边缘会出现两个缺口，看起来像"浮在半空却没浮起来"；
   * 反过来浮起的气泡用上圆下直，就会像一块被从屏幕底边拽出来的板子 —— 用户会直接说"太诡异"。
   */
  private fun sheetBackground(floating: Boolean): GradientDrawable {
    val radius = context.resources.getDimension(R.dimen.ds_radius_card)
    return GradientDrawable().apply {
      cornerRadii = if (floating) {
        floatArrayOf(radius, radius, radius, radius, radius, radius, radius, radius)
      } else {
        floatArrayOf(radius, radius, radius, radius, 0f, 0f, 0f, 0f)
      }
      setColor(colorSurface)
      setStroke(dp(1), colorBorder)
    }
  }

  /** 编排层按「气泡 / 接底通栏」切换圆角形态；幂等，重复调用不重建。 */
  fun setDrawerFloating(floating: Boolean) {
    if (fluxFloating == floating) return
    fluxFloating = floating
    drawerView.background = sheetBackground(floating)
  }

  private var fluxFloating = false

  /** 输入区根透明；只包含答题、附件与完整圆角输入药丸，不包含工作区/会话或选择卡片。 */
  val view: View = BackKeyPanelLayout(context) { listener.onComposerBack() }.apply {
    orientation = LinearLayout.VERTICAL
    // 首次展示优先让根拿焦点，只有用户点输入框或显式 focusInput 才请求 IME。
    isFocusableInTouchMode = true
    descendantFocusability = ViewGroup.FOCUS_BEFORE_DESCENDANTS
    background = null
    addView(pendingHint, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(answerActions, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(attachScroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(inputRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
  }

  init {
    installTouchableSurfaces(view as ViewGroup)
    drawerView.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(v: View) {
        attached = true
        motionEnabled = DsUi.animationsEnabled(context)
        unregisterMotionListener?.invoke()
        unregisterMotionListener = DsUi.registerMotionListener(context) {
          motionEnabled = DsUi.animationsEnabled(context)
          applyDrawerRowGate()
          if (!motionEnabled) finishAnimations()
        }
        applyDrawerRowGate()
        finishAnimations()
      }

      override fun onViewDetachedFromWindow(v: View) {
        attached = false
        unregisterMotionListener?.invoke()
        unregisterMotionListener = null
        // 移窗即收口：列表行的出现过渡不能在没人看的 View 上继续跑。
        drawer.setAnimationsEnabled(false)
        cancelDrawerAnimation()
      }
    })
  }

  /** Subscribe only while attached. Layout/scroll changes queue one update, never a frame loop. */
  private fun installTouchableSurfaces(root: ViewGroup) {
    var queued = false
    var observer: ViewTreeObserver? = null
    val update = Runnable {
      queued = false
      if (root.isAttachedToWindow) applyTouchableSurfaces(root)
    }
    fun schedule() {
      if (queued || !root.isAttachedToWindow) return
      queued = true
      root.post(update)
    }
    val layoutListener = ViewTreeObserver.OnGlobalLayoutListener { schedule() }
    val scrollListener = ViewTreeObserver.OnScrollChangedListener { schedule() }
    root.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(v: View) {
        observer = root.viewTreeObserver.also {
          it.addOnGlobalLayoutListener(layoutListener)
          it.addOnScrollChangedListener(scrollListener)
        }
        schedule()
      }

      override fun onViewDetachedFromWindow(v: View) {
        cancelPendingImeShow()
        root.removeCallbacks(update)
        queued = false
        observer?.let {
          if (it.isAlive) {
            it.removeOnGlobalLayoutListener(layoutListener)
            it.removeOnScrollChangedListener(scrollListener)
          }
        }
        observer = null
        OverlayTouchRegion.forget(root)
      }
    })
  }

  /** Exact visible surface union in this WM root's coordinates; no transparent common rows. */
  private fun applyTouchableSurfaces(root: ViewGroup): Boolean {
    val surfaces = ArrayList<View>()
    surfaces.add(pendingHint)
    surfaces.add(inputRow)
    if (answerActions.visibility == View.VISIBLE) {
      for (index in 0 until answerActions.childCount) surfaces.add(answerActions.getChildAt(index))
    }
    val region = OverlayTouchRegion.unionRegions(root, surfaces) { child ->
      if (child === inputRow) dp(32).toFloat() else if (child === pendingHint) 0f else dp(16).toFloat()
    }
    if (attachScroll.visibility == View.VISIBLE) {
      val attachments = ArrayList<View>()
      for (index in 0 until attachColumn.childCount) attachments.add(attachColumn.getChildAt(index))
      val attachmentRegion = OverlayTouchRegion.unionRegions(root, attachments) { dp(6).toFloat() }
      // Horizontal scrolling must not keep off-viewport attachment pixels touchable over other rows.
      val viewport = Rect(0, 0, attachScroll.width, attachScroll.height)
      root.offsetDescendantRectToMyCoords(attachScroll, viewport)
      attachmentRegion.op(viewport, Region.Op.INTERSECT)
      region.op(attachmentRegion, Region.Op.UNION)
    }
    // A bounded input region is separate from Android's combined-obscuring-opacity policy.
    // V2 retains ownership of window alpha/flags and the older-API fallback.
    return OverlayTouchRegion.apply(root, region)
  }

  /** 当前是否 busy（发送按钮语义由它切换；render 里更新）。 */
  private var busy = false
  private var sendEnabled = false
  private var renderedAttachments = emptyList<OverlayAttachmentChip>()
  private var sendRecheck = false
  private var previewId: String? = null
  private var hasReadyAttachments = false

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
    workspaceChip.contentDescription = workspaceChip.text
    sessionChip.contentDescription = sessionChip.text

    hasReadyAttachments = data.attachments.isNotEmpty()
    sendRecheck = data.sendRecheck
    if (data.attachments != renderedAttachments) {
      renderedAttachments = data.attachments
      if (renderedAttachments.none { it.id == previewId }) previewId = null
      renderAttachments(renderedAttachments)
    }

    busy = data.busy && !data.answeringQuestion
    answerActions.visibility = if (data.answeringQuestion) View.VISIBLE else View.GONE
    workspaceChip.visibility = if (data.answeringQuestion) View.GONE else View.VISIBLE
    sessionChip.visibility = workspaceChip.visibility
    plusButton.visibility = if (data.answeringQuestion) View.GONE else View.VISIBLE
    if (data.answeringQuestion) attachScroll.visibility = View.GONE else if (data.attachments.isNotEmpty()) attachScroll.visibility = View.VISIBLE
    sendEnabled = data.sendEnabled
    applyActionButton()
    drawer.render(
      commands = data.commands,
      onPick = { name ->
        listener.onComposerCommand(name)
      },
      onAttach = { kind ->
        listener.onComposerAttach(kind)
      },
      emptyLabel = data.drawerEmptyLabel,
    )
  }

  fun inputText(): String = input.text?.toString() ?: ""

  /** 光标起点（诊断/恢复用）。EditText 未初始化时返回 0。 */
  fun inputSelectionStart(): Int = input.selectionStart.coerceAtLeast(0)

  /** 光标终点（选区尾）。与 start 一起还原用户的选择范围。 */
  fun inputSelectionEnd(): Int = input.selectionEnd.coerceAtLeast(0)

  fun setInputText(t: String) {
    input.setText(t)
    input.setSelection(input.text?.length ?: 0)
  }

  fun hasDraft(): Boolean = inputText().isNotBlank()
  /** 只管理状态与按钮语义；独立窗口增删和位置由编排层负责。 */
  fun setDrawerOpen(open: Boolean) {
    if (open == drawerOpen) return
    drawerOpen = open
    // Closing changes the button state while the native window is still fading out.
    // Reopening cancels the old completion before that callback can remove the new window.
    if (open) cancelDrawerAnimation()
    plusButton.isSelected = open
    plusButton.contentDescription = if (open) UiText.t(context, "收起附件与命令", "Close attachments and commands")
      else UiText.t(context, "更多：附件与命令", "More: attachments and commands")
  }

  /**
   * 输入区整体的进场过渡（窗口 addView 成功后调用）。
   *
   * 为什么需要它：窗口一旦 addView 就整块可见，没有任何过渡，用户看到的是"啪一下出现"，
   * 在手机上和其它浮层（卡片逐行淡入、sheet 淡入上抬）观感完全不一致。
   * 这里只动 alpha 与 translationY，不碰窗口几何与布局，避免和 IME 顶起抢时序。
   */
  /** 窗口 addView 之前先把首帧压到透明位；否则系统会先绘一帧满透明度，再被动画覆盖成「闪现」。 */
  fun prepareEnter() {
    view.animate().cancel()
    view.alpha = 0f
    view.translationY = composerEnterRisePx
  }

  fun fadeComposerIn() {
    if (!motionEnabled || !attached) {
      view.alpha = 1f
      view.translationY = 0f
      return
    }
    view.animate().cancel()
    view.alpha = 0f
    view.translationY = composerEnterRisePx
    view.animate()
      .alpha(1f)
      .translationY(0f)
      .setDuration(OverlayMotionSpec.fadeInMs(reduced = !motionEnabled))
      .setInterpolator(OverlayEasing.DECELERATE.interpolator())
      .start()
  }

  /**
   * 输入区整体的退场过渡；[onEnd] 在动画结束后才该移除窗口。
   *
   * 动效关闭时同步走 onEnd，绝不留一帧空窗，也不产生"零时长动画"这种中间态。
   */
  fun fadeComposerOut(onEnd: () -> Unit) {
    if (!motionEnabled || !attached || view.alpha <= 0.01f) {
      view.animate().cancel()
      view.alpha = 1f
      view.translationY = 0f
      onEnd()
      return
    }
    view.animate().cancel()
    view.animate()
      .alpha(0f)
      .translationY(composerExitDropPx)
      .setDuration(OverlayMotionSpec.pillOutMs(reduced = !motionEnabled))
      .setInterpolator(OverlayEasing.ACCELERATE.interpolator())
      .withEndAction {
        view.alpha = 1f
        view.translationY = 0f
        onEnd()
      }
      .start()
  }

  /** 进场从下方抬起 12dp、退场向下沉 8dp：小于一个 chip 高度，读作"浮起/落下"而非整块滑入。 */
  private val composerEnterRisePx = 12f * context.resources.displayMetrics.density
  private val composerExitDropPx = 8f * context.resources.displayMetrics.density

  /** addView 成功后调用；只动画独立卡片，不改变输入根或窗口的几何。 */
  fun fadeDrawerIn() {
    // Must cancel first, then animate: an early "not open" return would leave a stale queued end
    // action from the previous close able to remove the window of this newly opened sheet.
    cancelDrawerAnimation()
    drawerView.visibility = View.VISIBLE
    drawerView.alpha = 0f
    drawerView.translationY = drawerSlidePx
    animateDrawerTo(1f, 0f, null, OverlayMotionSpec.drawerShowMs(reduced = !motionEnabled))
  }

  /** 关闭结束只通知当前代次；重开或detach会取消旧移窗回调。 */
  fun animateDrawerOut(onEnd: () -> Unit) {
    // 不要在 drawerOpen 时提前 return：这个标志只表示「逻辑上处于展开态」，
    // 而关闭动画恰恰是在展开态下才需要执行的。提前返回会让 onEnd 永远不被调用，
    // 窗口就再也不会被移除 —— 表现为用户点空白后 sheet 一直挂在屏上。
    cancelDrawerAnimation()
    animateDrawerTo(0f, drawerSlidePx, onEnd, OverlayMotionSpec.drawerHideMs(reduced = !motionEnabled))
  }

  /**
   * 一次性过渡到给定透明度/位移。
   *
   * 时长由调用方从 [OverlayMotionSpec] 取：动效关闭时是 0，因此这里只剩「同步写终态」一条路径，
   * 不会出现零时长动画再补一帧。只改渲染属性，不动 layout/窗口几何。
   */
  private fun animateDrawerTo(alpha: Float, translationY: Float, onEnd: (() -> Unit)?, durationMs: Long) {
    drawerAnimationTargetAlpha = alpha
    drawerAnimationTargetTranslationY = translationY
    drawerAnimationEnd = onEnd
    if (!attached || !motionEnabled || durationMs <= 0L) { finishAnimations(); return }
    val generation = drawerAnimationGeneration
    drawerView.animate().alpha(alpha).translationY(translationY).setDuration(durationMs)
      .setInterpolator(OverlayEasing.DECELERATE.interpolator()).withEndAction {
        if (generation == drawerAnimationGeneration && attached) finishAnimations()
      }.start()
  }

  /** 动效关闭时一次性到终态，当前关闭回调只消费一次，不留下旧窗口移除动作。 */
  fun finishAnimations() {
    val alpha = drawerAnimationTargetAlpha ?: if (drawerOpen) 1f else 0f
    val translationY = if (drawerAnimationTargetAlpha != null) drawerAnimationTargetTranslationY else 0f
    val onEnd = drawerAnimationEnd
    cancelDrawerAnimation()
    drawerView.alpha = alpha
    drawerView.translationY = translationY
    onEnd?.invoke()
  }

  /** 编排层注入「当前是选择器（会话/工作区）还是命令/附件」：前者显示搜索框、隐藏瓦片。 */
  fun setPickerMode(enabled: Boolean) = drawer.setPickerMode(enabled)

  fun setSheetDragHandler(handler: (OverlayDragPhase, Float) -> Boolean) { drawer.onSheetDrag = handler }
  fun drawerAtTop(): Boolean = drawer.atTop()
  fun resetDrawerScroll() = drawer.view.scrollTo(0, 0)

  fun prepareCommandSheet() {
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.hideSoftInputFromWindow(view.windowToken, 0)
    focusRoot()
  }

  /** 编排层以可用屏高40%注入；0表示几何未就绪，不显示无上限列表。 */
  fun setMaxDrawerHeightPx(maxHeightPx: Int) {
    val next = maxHeightPx.coerceAtLeast(0)
    if (next == maxDrawerHeightPx) return
    maxDrawerHeightPx = next
    drawer.setMaxHeightPx(next)
  }

  /** 按实际窗口宽度测量wrap内容；只在内容/配置变化时测，不参与动画帧。 */
  fun measureDrawerHeightPx(widthPx: Int): Int {
    drawerView.measure(
      View.MeasureSpec.makeMeasureSpec(widthPx.coerceAtLeast(0), View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(maxDrawerHeightPx, View.MeasureSpec.AT_MOST),
    )
    return drawerView.measuredHeight.coerceIn(0, maxDrawerHeightPx)
  }

  fun isDrawerOpen(): Boolean = drawerOpen

  /** 非输入展示路径聚焦根（窗口 softInputMode 由编排层设为 ALWAYS_HIDDEN）。 */
  fun focusRoot() {
    cancelPendingImeShow()
    input.clearFocus()
    view.requestFocus()
  }

  private var pendingImeShow: ViewTreeObserver.OnWindowFocusChangeListener? = null

  private fun cancelPendingImeShow() {
    pendingImeShow?.let { view.viewTreeObserver.removeOnWindowFocusChangeListener(it) }
    pendingImeShow = null
  }

  fun isEditing(): Boolean = (input.hasFocus() && view.hasWindowFocus()) || drawer.isSearchEditing()

  /** Show the IME once the window has an input connection. */
  fun focusInput(canFocus: () -> Boolean = { true }) {
    if (!view.isAttachedToWindow || !canFocus()) return
    cancelPendingImeShow()
    input.requestFocus()
    fun showWhenServed() {
      input.post {
        if (!view.isAttachedToWindow || !input.hasFocus() || !view.hasWindowFocus() || !canFocus()) return@post
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
      }
    }
    if (view.hasWindowFocus()) {
      showWhenServed()
    } else {
      val listener = ViewTreeObserver.OnWindowFocusChangeListener { focused ->
        if (focused) {
          cancelPendingImeShow()
          showWhenServed()
        }
      }
      pendingImeShow = listener
      view.viewTreeObserver.addOnWindowFocusChangeListener(listener)
    }
  }

  private fun hasSendableDraft(): Boolean = inputText().isNotBlank() || hasReadyAttachments

  private fun applyActionButton() {
    // 形态语义（用户 2026-11-14 明确纠正，不要自行推导）：
    //   1. 引擎空闲 —— 一直是"发送"（箭头）；
    //   2. 引擎运行 —— "方块"，表示可以随时暂停；
    //   3. 引擎运行 + 输入框有文字 —— 切回"发送"（箭头），用来插话。
    // 换句话说：只有「运行中且没字」才是方块。把空闲也算成方块会让人以为一直在跑。
    val hasDraft = hasSendableDraft() || sendRecheck
    val showStop = busy && !hasDraft
    actionButton.setGlyph(
      if (showStop) OverlayActionGlyphView.Glyph.STOP else OverlayActionGlyphView.Glyph.SEND,
    )
    actionButton.contentDescription = if (showStop) {
      UiText.t(context, "停止", "Stop")
    } else {
      UiText.t(context, "发送", "Send")
    }
    // 空闲且没字时没有可发的东西，但按钮保持实色可见（只是不可点）：
    // 设计稿的蓝是实色，靠半透明表达 disable 会变成另一种灰蓝，看起来像坏了。
    actionButton.isEnabled = showStop || (sendEnabled && hasDraft)
    actionButton.alpha = 1f
  }

  private fun renderAttachments(items: List<OverlayAttachmentChip>) {
    val scrollX = attachScroll.scrollX
    attachColumn.removeAllViews()
    attachScroll.visibility = if (items.isEmpty()) View.GONE else View.VISIBLE
    for (chip in items) {
      attachColumn.addView(
        attachmentChip(chip),
        LinearLayout.LayoutParams(dp(100), ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(8) },
      )
    }
    attachScroll.scrollTo(scrollX, 0)
  }

  private fun attachmentChip(item: OverlayAttachmentChip): View {
    val name = TextView(context).apply {
      textSize = 11f
      setTextColor(colorTextPrimary)
      setSingleLine()
      ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
      gravity = Gravity.CENTER
      text = OverlayAttachmentIcons.fileName(item.name)
      contentDescription = item.name
    }
    val artwork = ImageView(context).apply {
      tag = "overlay-attachment-preview"
      scaleType = ImageView.ScaleType.FIT_CENTER
      val fallback = OverlayAttachmentIcons.drawable(context, item.name)
      val thumbnail = overlayThumbnailData(item.thumbnail)
      val bitmap = if (item.id != previewId || thumbnail.isEmpty()) null else runCatching {
        val bytes = Base64.decode(thumbnail.substringAfter(","), Base64.DEFAULT)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth !in 1..256 || bounds.outHeight !in 1..256) null
        else BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
      }.getOrNull()
      if (bitmap == null) setImageDrawable(fallback) else setImageBitmap(bitmap)
      if (item.kind == "image" && !item.pending) {
        contentDescription = UiText.t(context, "预览图片：", "Preview image: ") + item.name
        setOnClickListener {
          previewId = if (previewId == item.id) null else item.id
          if (previewId == item.id && thumbnail.isEmpty()) listener.onComposerPreviewAttachment(item.id)
          renderAttachments(renderedAttachments)
        }
      }
    }
    val artworkRow = FrameLayout(context).apply {
      addView(artwork, FrameLayout.LayoutParams(dp(56), dp(44), Gravity.CENTER))
      if (!item.pending) {
        val remove = TextView(context).apply {
          tag = "overlay-composer-attachment-remove"
          text = "\u00D7"
          textSize = 16f
          gravity = Gravity.CENTER
          setTextColor(colorTextSecondary)
          contentDescription = UiText.t(context, "移除附件", "Remove attachment") + " " + item.name
          setOnClickListener { listener.onComposerRemoveAttachment(item.id) }
        }
        addView(remove, FrameLayout.LayoutParams(dp(28), dp(36), Gravity.TOP or Gravity.END))
      }
    }
    val extension = OverlayAttachmentIcons.extension(item.name).uppercase(java.util.Locale.ROOT).take(10)
    return LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      setPadding(dp(4), dp(2), dp(4), dp(5))
      background = GradientDrawable().apply {
        cornerRadius = dp(12).toFloat()
        setColor(colorChip)
        setStroke(dp(1), colorBorder)
      }
      addView(artworkRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)))
      val label = TextView(context).apply {
        textSize = 10f
        setSingleLine()
        ellipsize = android.text.TextUtils.TruncateAt.END
        setTextColor(colorTextSecondary)
        gravity = Gravity.CENTER
        text = if (item.failed) UiText.t(context, "重试上传", "Retry upload")
          else item.status.ifEmpty { extension.ifEmpty { UiText.t(context, "文件", "File") } }
        if (item.failed) {
          contentDescription = text.toString() + " " + item.name
          setOnClickListener { listener.onComposerRetryAttachment(item.id) }
        }
      }
      addView(label, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(22)))
      addView(name, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
  }

  private fun chip(label: String, tag: String, onClick: () -> Unit): TextView = TextView(context).apply {
    this.tag = tag
    text = label + " \u25BE"
    textSize = 11f
    maxLines = 1
    ellipsize = android.text.TextUtils.TruncateAt.END
    setTextColor(colorTextSecondary)
    gravity = Gravity.CENTER
    setPadding(dp(12), 0, dp(12), 0)
    minWidth = dp(MIN_TOUCH_TARGET_DP)
    minHeight = dp(32)
    background = GradientDrawable().apply {
      cornerRadius = context.resources.getDimension(R.dimen.ds_radius_pill)
      setColor(colorChip)
      setStroke(dp(1), colorBorder)
    }
    isClickable = true
    contentDescription = label
    setOnClickListener { onClick() }
  }

  private fun chipLabel(label: String, fallbackZh: String, fallbackEn: String): String =
    overlaySingleLine(label.ifBlank { UiText.t(context, fallbackZh, fallbackEn) }) + " \u25BE"

  /** 行出现过渡的门：attached 且系统动效开启才允许；任何翻转都立即收口在跑的行。 */
  private fun applyDrawerRowGate() {
    drawer.setAnimationsEnabled(attached && motionEnabled)
  }

  /**
   * Cancel any in-flight drawer animation and invalidate its captured generation.
   *
   * Kept next to the other drawer animation helpers (not at the file tail): the stale-end-action
   * guarantee is only meaningful together with [animateDrawerTo], and separating them let the two
   * drift apart once already. Cancelling without bumping the generation would let a queued end action
   * run against a reopened sheet.
   */
  private fun cancelDrawerAnimation() {
    drawerAnimationGeneration++
    drawerAnimationTargetAlpha = null
    drawerAnimationEnd = null
    drawerView.animate().withEndAction(null).cancel()
  }

  private fun dp(value: Int): Int = (value * density).toInt()
}

/** Equal maximum widths guarantee a real gap even with very long workspace/session labels. */
internal fun overlayChipWidthLimitPx(composerWidthPx: Int, gapPx: Int): Int =
  ((composerWidthPx.coerceAtLeast(0).toLong() - gapPx.coerceAtLeast(0).toLong()).coerceAtLeast(0L) / 2L).toInt()
