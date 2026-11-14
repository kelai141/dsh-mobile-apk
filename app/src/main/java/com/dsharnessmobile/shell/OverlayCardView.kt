package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.text.SpannableString
import android.text.Spanned
import android.text.TextPaint
import android.text.TextUtils
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.LeadingMarginSpan
import android.text.style.QuoteSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.UnderlineSpan
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.VelocityTracker
import android.view.ViewConfiguration
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.ContextCompat

/**
 * 顶部事件卡片的内容视图（§3.1 W3 / §4.2 CARD）。
 *
 * 结构（自上而下）：
 *  1. 紧凑状态行：stateLabel + 工具数；无关闭/隐藏/形态按钮或其命中占位；
 *  2. ScrollView（weight=1）内保留思考/工具/待答和真实多行对话，内容再长也不挤掉把手；
 *  3. 单行思考（13sp 次文字，空则 GONE）与工具行（状态点 + 标题/详情，上限 50 行）；
 *  4. 说明行 footerLine（11sp，空则 GONE）；
 *  5. 待答区：approval 渲染「允许」「拒绝」，question 只渲染「回答」；
 *  6. 白条把手：40x4dp 胶囊 + 44dp 高命中区（拖动上报阶段/累计位移/速度）。
 *
 * 为什么 render() 只改文本与可见性、行数不变时绝不重建 View：
 * 事件风暴下（50 条工具调用连续到达）整棵子树 removeAllViews + addView 会触发整窗重绘与
 * 高度跳变；§7.7 要求「文本原地更新」「静止零刷新」。因此工具行用固定上限的 LinearLayout
 * 增量增删（规模 <=50 不需要 RecyclerView），行号相同就直接改绑数据。
 *
 * 为什么不用 elevation/shadow：overlay 窗口的 View.elevation 只在**本窗口矩形内**生效，
 * 无法把阴影投射到窗口之外（§7.4 已拍板）。窗口矩形因此必须等于可见卡片，若用窗口内
 * padding 模拟阴影，窗口就会比可见卡片大 —— 那会留下一条吃触摸的隐形边（历史「互吞」
 * 同形缺陷）。故层次只靠 1dp ds_border 描边 + 实色 surface token 表达，任何人都不要再加
 * elevation（加了也看不见，只会误导后续维护者）。
 *
 * 出现过渡（2026-11 动效补齐）：思考行、页脚、新工具行与待答行只在「隐藏 → 可见」那一刻
 * 播一次 0→1 透明度 + 上移 4dp 归位（时长/幅度取自 [OverlayMotionSpec]）；原地更新与流式追加不重播，
 * 否则每 100ms 一个渲染节拍都会闪一次。拖动期的整窗透明度与形状仍归距离形变（morphProgress），
 * 因此 morphProgress > 0 时不启新的出现过渡。
 *
 * 本类不参与窗口管理，也不决定卡片高度（那是 OverlayWindowFrames 的职责）；
 * measureContentHeightPx 只回答「给定宽度，内容想占多高」。
 */
internal class OverlayCardView(
  private val context: Context,
  private val listener: OverlayCardListener,
) {

  private val density = context.resources.displayMetrics.density
  private val colorSurface = ContextCompat.getColor(context, R.color.ds_surface)
  private val colorBorder = ContextCompat.getColor(context, R.color.ds_border)
  private val colorTextPrimary = ContextCompat.getColor(context, R.color.ds_text_primary)
  private val colorTextSecondary = ContextCompat.getColor(context, R.color.ds_text_secondary)
  private val colorChip = ContextCompat.getColor(context, R.color.ds_chip)
  private val colorOk = ContextCompat.getColor(context, R.color.ds_ok)
  private val colorWarn = ContextCompat.getColor(context, R.color.ds_warn)
  private val colorDanger = ContextCompat.getColor(context, R.color.ds_danger)
  private val colorOnAccent = ContextCompat.getColor(context, R.color.ds_text_on_accent)
  private val colorAccent = ContextCompat.getColor(context, R.color.ds_accent)

  // ── 状态行 ────────────────────────────────────────────────────────────────
  private val statusLabel = TextView(context).apply {
    tag = "overlay-card-status"
    textSize = 13f
    setTypeface(null, android.graphics.Typeface.BOLD)
    setTextColor(colorTextPrimary)
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
  }
  private val toolCountLabel = TextView(context).apply {
    tag = "overlay-card-toolcount"
    textSize = 11f
    setTextColor(colorTextSecondary)
    maxLines = 1
    visibility = View.GONE
  }

  private val headerRow = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(dp(14), dp(9), dp(14), dp(5))
    addView(statusLabel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    addView(
      toolCountLabel,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        marginStart = dp(8)
      },
    )
  }

  // ── 思考行 / 页脚 / 待答区 ────────────────────────────────────────────────
  private val thinkingLine = TextView(context).apply {
    tag = "overlay-card-thinking"
    textSize = 12f
    setTextColor(colorTextSecondary)
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
    setPadding(dp(14), dp(2), dp(14), dp(2))
    visibility = View.GONE
  }

  private val footerLine = TextView(context).apply {
    tag = "overlay-card-footer"
    textSize = 11f
    setTextColor(colorTextSecondary)
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
    setPadding(dp(14), dp(2), dp(14), dp(2))
    visibility = View.GONE
  }

  /** 待答区按 pending 列表结构重建（结构变化才发生，不是每次 render）。 */
  private val pendingColumn = LinearLayout(context).apply {
    tag = "overlay-card-pending"
    orientation = LinearLayout.VERTICAL
    setPadding(dp(14), dp(2), dp(14), dp(2))
    visibility = View.GONE
  }
  private var pendingSignature = ""

  // ── 工具行列表 ────────────────────────────────────────────────────────────
  private val rowsColumn = LinearLayout(context).apply {
    tag = "overlay-card-rows"
    orientation = LinearLayout.VERTICAL
    setPadding(dp(14), dp(2), dp(14), dp(2))
  }
  private val transcriptColumn = LinearLayout(context).apply {
    tag = "overlay-card-transcript"
    orientation = LinearLayout.VERTICAL
    setPadding(dp(14), dp(6), dp(14), dp(6))
    visibility = View.GONE
  }
  private class TranscriptHolder(
    val root: LinearLayout, val role: TextView, val state: TextView, val body: TextView,
    val argumentsLabel: TextView, val arguments: TextView, val resultLabel: TextView, val result: TextView, val boundary: TextView,
    val detail: LinearLayout,
  ) {
    /** True when this tool row currently shows its expanded arguments/result detail. */
    var expanded = false
  }
  private val transcriptHolders = LinkedHashMap<String, TranscriptHolder>()
  private var transcriptRows = emptyList<OverlayTranscriptRow>()
  private var scrollTouching = false
  private var scrollInteraction = 0L
  private data class TranscriptScroll(
    val follow: Boolean, val anchorId: String?, val offset: Int, val scrollY: Int, val interaction: Long,
    val survivingAnchors: List<Pair<String, Int>>,
  )
  private var pendingTranscriptScroll: TranscriptScroll? = null
  private var transcriptPreDraw: ViewTreeObserver.OnPreDrawListener? = null
  private var transcriptObserver: ViewTreeObserver? = null
  private var lastBodyData: OverlayCardData? = null

  private val scrollBody = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    addView(thinkingLine, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(rowsColumn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(footerLine, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(pendingColumn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(transcriptColumn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
  }
  private val scrollView = ScrollView(context).apply {
    isFillViewport = false
    overScrollMode = View.OVER_SCROLL_NEVER
    setOnTouchListener { _, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          scrollTouching = true
          scrollInteraction++
          cancelTranscriptScroll()
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> scrollTouching = false
      }
      false
    }
    addView(scrollBody, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
  }
  private class RowHolder(val root: View, val dot: View, val title: TextView, val detail: TextView)
  private val rowHolders = ArrayList<RowHolder>()
  private val runningAnimators = ArrayList<android.animation.Animator>()
  private var runningRows = emptyList<Pair<Int, String>>()
  private var runningAnimationSignature = emptyList<Pair<Int, String>>()
  private var attached = false
  private var motionEnabled = false
  private var unregisterMotionListener: (() -> Unit)? = null

  /**
   * 行/标签的出现过渡执行器（0→1 透明度 + 上移 4dp 归位）。
   *
   * 与距离形变（morphProgress）分工：形变拥有拖动期的整窗透明度与形状，过渡只服务非拖动期的
   * 「这一行刚出现」；因此 morphProgress > 0 时一律不开新的出现过渡，避免两套 alpha 打架。
   */
  private val rowReveal = OverlayRevealPlayer(risePx = OverlayMotionSpec.ROW_RISE_DP * density)
  /** 上一次渲染时这几处的可见性：只在 GONE→VISIBLE 的那一刻播一次，重复 render 不再重播。 */
  private var thinkingShown = false
  private var footerShown = false

  // ── 白条把手 ──────────────────────────────────────────────────────────────
  private val handleBar = View(context).apply {
    background = GradientDrawable().apply {
      cornerRadius = dp(2).toFloat()
      setColor(colorTextSecondary)
    }
  }
  private val handleHit = FrameLayout(context).apply {
    tag = "overlay-card-handle"
    contentDescription = UiText.t(context, "拖动调整卡片高度", "Drag to resize card")
    addView(handleBar, FrameLayout.LayoutParams(dp(40), dp(4), Gravity.CENTER))
    attachHandleGesture(this)
  }

  private var morphProgress = 0f
  private var morphCapsuleAlpha = 0f
  private var morphPillHeightPx = 1
  private var morphLatestOutput = ""
  private var morphStatusColor = colorTextSecondary
  private val baseRadius = context.resources.getDimension(R.dimen.ds_radius_card)
  private val surfaceFillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val surfaceBorderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val statusDotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val capsulePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = 13f * context.resources.displayMetrics.scaledDensity
    color = colorTextPrimary
  }
  private var capsuleCacheSource = ""
  private var capsuleCacheWidth = -1
  private var capsuleCacheText = ""

  private fun morphVisibleHeight(fullHeight: Int): Float =
    fullHeight + (morphPillHeightPx.coerceAtMost(fullHeight) - fullHeight) * morphProgress

  private fun morphCornerRadius(): Float = baseRadius + (morphPillHeightPx / 2f - baseRadius) * morphProgress

  /** Draw-only shape; API33 input-region updates separately schedule a framework traversal. */
  private inner class CardSurface : Drawable() {
    private fun visibleHeight(): Float = morphVisibleHeight(bounds.height())
    private fun radius(): Float = morphCornerRadius()
    override fun draw(canvas: Canvas) {
      val height = visibleHeight().coerceAtLeast(1f)
      val radius = radius().coerceAtLeast(0f)
      // Fill/border/dot paints cannot leak each other's alpha or style across draw passes.
      surfaceFillPaint.color = colorSurface
      surfaceFillPaint.alpha = 255
      canvas.drawRoundRect(0f, 0f, bounds.width().toFloat(), height, radius, radius, surfaceFillPaint)
      surfaceBorderPaint.strokeWidth = dp(1).toFloat()
      surfaceBorderPaint.color = colorBorder
      val inset = surfaceBorderPaint.strokeWidth / 2f
      canvas.drawRoundRect(inset, inset, bounds.width() - inset, height - inset, radius, radius, surfaceBorderPaint)
    }
    override fun getOutline(outline: Outline) {
      outline.setRoundRect(0, 0, bounds.width().coerceAtLeast(1), visibleHeight().toInt().coerceAtLeast(1), radius().coerceAtLeast(0f))
      outline.alpha = 1f
    }
    override fun setAlpha(alpha: Int) = Unit
    override fun setColorFilter(colorFilter: ColorFilter?) = Unit
    @Suppress("DEPRECATION") override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
  }

  private inner class CapsuleOutput : Drawable() {
    override fun draw(canvas: Canvas) {
      if (morphCapsuleAlpha <= 0f) return
      val available = (bounds.width() - dp(46)).coerceAtLeast(0)
      if (capsuleCacheWidth != available || capsuleCacheSource != morphLatestOutput) {
        capsuleCacheWidth = available
        capsuleCacheSource = morphLatestOutput
        capsuleCacheText = TextUtils.ellipsize(morphLatestOutput, capsulePaint, available.toFloat(), TextUtils.TruncateAt.END).toString()
      }
      val centerY = morphPillHeightPx / 2f
      statusDotPaint.color = morphStatusColor
      statusDotPaint.alpha = (morphCapsuleAlpha * 255).toInt()
      canvas.drawCircle(dp(17).toFloat(), centerY, dp(3).toFloat(), statusDotPaint)
      capsulePaint.alpha = (morphCapsuleAlpha * 255).toInt()
      val baseline = centerY - (capsulePaint.ascent() + capsulePaint.descent()) / 2f
      canvas.drawText(capsuleCacheText, dp(30).toFloat(), baseline, capsulePaint)
    }
    override fun setAlpha(alpha: Int) = Unit
    override fun setColorFilter(colorFilter: ColorFilter?) = Unit
    @Suppress("DEPRECATION") override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
  }
  private val cardSurface = CardSurface()
  private val capsuleOutput = CapsuleOutput()

  /** 卡片根视图：唯一供服务塞进窗口的 View。 */
  val view: View = BackKeyPanelLayout(context) { listener.onCardCollapse() }.apply {
    orientation = LinearLayout.VERTICAL
    background = cardSurface
    foreground = capsuleOutput
    clipToOutline = true
    addView(headerRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(scrollView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    addView(handleHit, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(MIN_TOUCH_TARGET_DP)))
  }

  init {
    view.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> updateMorphTouchableRegion() }
    // 视图被移出窗口（服务收卡片窗）时立刻停掉常驻动画：否则呼吸会继续跑在没人看的 View 上。
    view.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(v: View) {
        attached = true
        updateMorphTouchableRegion()
        motionEnabled = DsUi.animationsEnabled(context)
        unregisterMotionListener?.invoke()
        unregisterMotionListener = DsUi.registerMotionListener(context) {
          motionEnabled = DsUi.animationsEnabled(context)
          syncRunningAnimations()
          if (!motionEnabled) {
            // 关动画时行过渡也必须立刻收口；否则屏幕上还留着半透明的行。
            rowReveal.settleAll()
            view.animate().cancel()
            view.alpha = 1f
            view.translationY = 0f
            handleBar.translationY = 0f
            resetMorph()
          }
        }
        syncRunningAnimations()
        scheduleTranscriptScroll()
      }

      override fun onViewDetachedFromWindow(v: View) {
        attached = false
        unregisterMotionListener?.invoke()
        unregisterMotionListener = null
        stopRunningAnimations()
        rowReveal.settleAll()
        resetMorph()
        OverlayTouchRegion.forget(view)
        cancelTranscriptScroll()
        scrollTouching = false
        view.animate().cancel()
        view.alpha = 1f
        view.translationY = 0f
        handleBar.translationY = 0f
      }
    })
  }

  /**
   * 幂等渲染：只更新文本/可见性/行增删，不重建整棵 View 树。
   *
   * 幂等的要求来自服务侧事件合并：同一份快照可能被 render 多次（合并窗口内重复触发、
   * 换肤、开动画开关），任何一次都不能改变最终状态。
   */
  fun render(data: OverlayCardData) {
    // 布局变更前捕获可见消息锚点；流更新不能打断用户正在向上读历史。
    val scroll = pendingTranscriptScroll ?: captureTranscriptScroll()
    val previousTranscript = transcriptRows
    val previousBody = lastBodyData
    val bodyChanged = previousBody == null || data.thinkingLine != previousBody.thinkingLine ||
      data.rows != previousBody.rows || data.footerLine != previousBody.footerLine || data.pending != previousBody.pending
    lastBodyData = data
    statusLabel.setTextIfChanged(overlaySingleLine(data.stateLabel))
    if (data.toolCount > 0) {
      toolCountLabel.setTextIfChanged("\u00D7" + data.toolCount)
      toolCountLabel.visibility = View.VISIBLE
    } else {
      toolCountLabel.visibility = View.GONE
    }

    val thinking = overlaySingleLine(data.thinkingLine)
    // Thinking stays one quiet line: it is context, not content, so it is smaller and secondary.
    thinkingLine.setTextIfChanged(if (thinking.isEmpty()) "" else UiText.t(context, "思考 · ", "Thinking · ") + thinking)
    thinkingLine.visibility = if (thinking.isEmpty()) View.GONE else View.VISIBLE
    thinkingShown = revealOnAppear(thinkingLine, thinking.isNotEmpty(), thinkingShown)

    val footer = overlaySingleLine(data.footerLine)
    footerLine.setTextIfChanged(footer)
    footerLine.visibility = if (footer.isEmpty()) View.GONE else View.VISIBLE
    footerShown = revealOnAppear(footerLine, footer.isNotEmpty(), footerShown)

    // 先定可见性再增行：父级 GONE 时起的新行过渡没有可见帧，等于白跑一次。
    // Durable chronological tool blocks supersede live one-line summaries, never duplicate them as dialogue.
    rowsColumn.visibility = if (data.transcript.any { it.role == "tool" } || data.rows.isEmpty()) View.GONE else View.VISIBLE
    renderRows(data.rows)
    renderPending(data.pending)
    renderTranscript(data.transcript)
    if (transcriptRows != previousTranscript || (bodyChanged && transcriptRows.isNotEmpty())) {
      pendingTranscriptScroll = scroll
      scheduleTranscriptScroll()
    }
    applyRunningAnimation(data)
  }

  private fun TextView.setTextIfChanged(next: String) {
    if (text?.toString() != next) text = next
  }

  /**
   * 隐藏 → 可见的那一次播一次出现过渡，返回本帧的可见性。
   *
   * 只在「刚出现」时播：重复 render（100ms 合并节拍）里已经可见的行不再重播，否则每拍都会重来；
   * 正在拖距离形变时也不播（形变拥有整窗透明度，两套 alpha 会互相抵消）。
   */
  private fun revealOnAppear(target: View, visible: Boolean, wasVisible: Boolean): Boolean {
    if (visible && !wasVisible) rowReveal.reveal(target, 0, revealEnabled())
    if (!visible) rowReveal.settle(target)
    return visible
  }

  /** 出现过渡的统一门：附加在窗口、系统动效开启、且当前没有在跑距离形变。 */
  private fun revealEnabled(): Boolean = attached && motionEnabled && morphProgress <= 0f

  /** 同一记录 id 只改正文；追加/淘汰/重排仅动对应行，流式快照不清空整列。 */
  private fun renderTranscript(next: List<OverlayTranscriptRow>) {
    val plan = overlayTranscriptMergePlan(transcriptRows, next)
    if (plan.rows == transcriptRows) return
    // 同上：新消息的过渡要在列已可见时启动。
    transcriptColumn.visibility = if (plan.rows.isEmpty()) View.GONE else View.VISIBLE
    for (id in plan.removedIds) transcriptHolders.remove(id)?.let { transcriptColumn.removeView(it.root) }
    for ((index, row) in plan.rows.withIndex()) {
      // 「新出现的行」= 首次为这个 id 建 holder，且它当前还不在列里。先取快照再 getOrPut，
      // 否则 getOrPut 已经把 holder 写进 map，判据恒为假。
      val known = transcriptHolders.containsKey(row.id)
      val holder = transcriptHolders.getOrPut(row.id) { createTranscriptRow() }
      val fresh = !known && transcriptColumn.indexOfChild(holder.root) < 0
      if (row.id in plan.changedIds) bindTranscriptRow(holder, row)
      if (transcriptColumn.indexOfChild(holder.root) != index) {
        if (holder.root.parent === transcriptColumn) transcriptColumn.removeView(holder.root)
        transcriptColumn.addView(holder.root, index, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(8) })
      }
      // 只有真正新增的消息才淡入；流式追加与重排沿用原位（否则读历史时整列会闪）。
      if (fresh) rowReveal.reveal(holder.root, index, revealEnabled())
    }
    transcriptRows = plan.rows
  }

  private fun bindTranscriptRow(holder: TranscriptHolder, row: OverlayTranscriptRow) {
    val tool = row.role == "tool"
    holder.role.setTextIfChanged(when (row.role) {
      "user" -> UiText.t(context, "你", "You")
      "tool" -> overlaySingleLine(row.toolName)
      else -> UiText.t(context, "助手", "Assistant")
    })
    holder.role.setTextColor(if (tool) colorTextPrimary else colorTextSecondary)
    holder.state.visibility = if (tool) View.VISIBLE else View.GONE
    if (tool) {
      holder.state.setTextIfChanged(when (row.state) {
        OverlayToolRowState.RUNNING -> UiText.t(context, "进行中", "Running")
        OverlayToolRowState.DONE -> UiText.t(context, "已完成", "Done")
        OverlayToolRowState.FAILED -> UiText.t(context, "失败", "Failed")
        null -> UiText.t(context, "已调用", "Called")
      })
      holder.state.setTextColor(when (row.state) {
        OverlayToolRowState.RUNNING -> colorWarn
        OverlayToolRowState.DONE -> colorOk
        OverlayToolRowState.FAILED -> colorDanger
        null -> colorTextSecondary
      })
    }
    holder.root.background = if (tool || row.role == "user") GradientDrawable().apply {
      cornerRadius = dp(12).toFloat()
      setColor(withAlpha(colorChip, if (tool) 0.7f else 0.5f))
      if (tool) setStroke(dp(1), colorBorder)
    } else null
    // A tool row is a summary line first: chevron affordance, expanded detail only on tap.
    holder.detail.visibility = if (tool && holder.expanded) View.VISIBLE else View.GONE
    val inset = if (tool || row.role == "user") dp(10) else 0
    holder.root.setPadding(inset, dp(8), inset, dp(10))
    holder.body.visibility = if (tool) View.GONE else View.VISIBLE
    var markdownTruncated = false
    if (row.role == "assistant") {
      val document = OverlayMarkdown.parse(row.text)
      holder.body.text = markdownSpans(document)
      markdownTruncated = document.truncated
    } else if (!tool) holder.body.setTextIfChanged(row.text)
    // Tool arguments/results are literal, independently labeled data, never assistant Markdown.
    holder.argumentsLabel.visibility = if (tool && row.arguments.isNotEmpty()) View.VISIBLE else View.GONE
    holder.arguments.visibility = holder.argumentsLabel.visibility
    if (tool) {
      // The name line carries the chevron so one tap affordance is obvious without an extra row.
      val label = overlaySingleLine(row.toolName)
      val hint = overlaySingleLine(OverlayToolSummary.hint(row.arguments))
      holder.role.text = (if (holder.expanded) "\u25BE " else "\u25B8 ") + label +
        if (hint.isEmpty()) "" else "  \u00B7  " + hint
      holder.role.contentDescription = UiText.t(
        context,
        if (holder.expanded) "收起工具详情" else "展开工具详情",
        if (holder.expanded) "Collapse tool details" else "Expand tool details",
      )
      holder.root.setOnClickListener {
        holder.expanded = !holder.expanded
        holder.detail.visibility = if (holder.expanded) View.VISIBLE else View.GONE
        val sameRow = transcriptRows.firstOrNull { it.id == row.id } ?: row
        bindTranscriptRow(holder, sameRow)
      }
    } else {
      holder.root.setOnClickListener(null)
    }
    holder.arguments.setTextIfChanged(if (tool) row.arguments else "")
    val showResult = tool && (row.result.isNotEmpty() || row.state == OverlayToolRowState.DONE || row.state == OverlayToolRowState.FAILED)
    holder.resultLabel.visibility = if (showResult) View.VISIBLE else View.GONE
    holder.result.visibility = holder.resultLabel.visibility
    holder.result.setTextIfChanged(if (!showResult) "" else row.result.ifEmpty { UiText.t(context, "无文本结果", "No text result") })
    holder.boundary.visibility = if (row.truncated || markdownTruncated) View.VISIBLE else View.GONE
  }

  private fun markdownSpans(document: OverlayMarkdown.Document): CharSequence = SpannableString(document.text).apply {
    fun span(value: Any, range: OverlayMarkdown.Span) { setSpan(value, range.start, range.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
    for (range in document.spans) when (range.style) {
      OverlayMarkdown.Style.BOLD -> span(StyleSpan(Typeface.BOLD), range)
      OverlayMarkdown.Style.ITALIC -> span(StyleSpan(Typeface.ITALIC), range)
      OverlayMarkdown.Style.STRIKE -> span(StrikethroughSpan(), range)
      OverlayMarkdown.Style.CODE, OverlayMarkdown.Style.CODE_BLOCK -> {
        span(TypefaceSpan("monospace"), range)
        span(BackgroundColorSpan(withAlpha(colorChip, 0.85f)), range)
        span(RelativeSizeSpan(0.92f), range)
      }
      OverlayMarkdown.Style.HEADING -> {
        span(StyleSpan(Typeface.BOLD), range)
        span(RelativeSizeSpan(if (range.level <= 2) 1.15f else 1.05f), range)
      }
      OverlayMarkdown.Style.QUOTE -> {
        span(QuoteSpan(colorBorder), range)
        span(LeadingMarginSpan.Standard(dp(10)), range)
        span(ForegroundColorSpan(colorTextSecondary), range)
      }
      OverlayMarkdown.Style.LINK -> {
        span(ForegroundColorSpan(colorAccent), range)
        span(UnderlineSpan(), range)
      }
      OverlayMarkdown.Style.RULE -> span(ForegroundColorSpan(colorBorder), range)
    }
  }

  private fun createTranscriptRow(): TranscriptHolder {
    fun label(value: String = "") = TextView(context).apply {
      text = value
      textSize = 11f
      setTextColor(colorTextSecondary)
    }
    fun literalBody(monospace: Boolean = false) = TextView(context).apply {
      textSize = if (monospace) 12f else 13f
      setTextColor(colorTextPrimary)
      setSingleLine(false)
      setLineSpacing(dp(2).toFloat(), 1f)
      // Never install LinkMovementMethod/autoLink: displayed model text cannot execute an intent.
      autoLinkMask = 0
      linksClickable = false
      if (monospace) typeface = Typeface.MONOSPACE
    }
    fun bodyParams() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) }
    // Hierarchy by type, not decoration: tool name is the primary line (13sp bold),
    // state/labels are 10.5sp tertiary, argument and result bodies are 11.5sp monospace secondary.
    val role = label().apply {
      tag = "overlay-card-row-role"
      textSize = 13f
      setTypeface(null, Typeface.BOLD)
      setTextColor(colorTextPrimary)
      maxLines = 1
      ellipsize = TextUtils.TruncateAt.END
    }
    val state = label().apply {
      textSize = 10.5f
      maxLines = 1
    }
    val body = literalBody().apply { tag = "overlay-card-transcript-text" }
    val argumentsLabel = label(UiText.t(context, "参数", "Arguments")).apply { textSize = 10.5f }
    val arguments = literalBody(true).apply { tag = "overlay-card-tool-arguments"; textSize = 11.5f }
    val resultLabel = label(UiText.t(context, "结果", "Result")).apply { textSize = 10.5f }
    val result = literalBody(true).apply { tag = "overlay-card-tool-result"; textSize = 11.5f }
    val boundary = label(UiText.t(context, "此条内容已截断 · 在本体查看完整记录", "Content truncated · Open the app for the full record"))
    val heading = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      addView(role, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(state, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8) })
    }
    // Default-collapsed detail container: tool rows stay one readable line until the user asks
    // for arguments/results, so a long agent run never buries the conversation in raw JSON.
    val detail = LinearLayout(context).apply {
      tag = "overlay-card-tool-detail"
      orientation = LinearLayout.VERTICAL
      visibility = View.GONE
      addView(argumentsLabel, bodyParams())
      addView(arguments, bodyParams())
      addView(resultLabel, bodyParams())
      addView(result, bodyParams())
    }
    val root = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      addView(heading, bodyParams())
      addView(body, bodyParams())
      addView(detail)
      addView(boundary, bodyParams())
      isClickable = true
      isFocusable = true
    }
    return TranscriptHolder(root, role, state, body, argumentsLabel, arguments, resultLabel, result, boundary, detail)
  }

  private fun captureTranscriptScroll(): TranscriptScroll {
    val y = scrollView.scrollY
    val follow = overlayTranscriptShouldFollow(y, scrollView.height, scrollBody.height, scrollTouching, dp(16))
    val anchor = transcriptRows.firstOrNull { row ->
      transcriptHolders[row.id]?.root?.let { transcriptColumn.top + it.bottom > y } == true
    }
    val offset = anchor?.let { row -> transcriptHolders[row.id]?.root?.let { transcriptColumn.top + it.top - y } } ?: 0
    val survivingAnchors = ArrayList<Pair<String, Int>>()
    var atAnchor = false
    for (row in transcriptRows) {
      if (row.id == anchor?.id) atAnchor = true
      if (!atAnchor) continue
      val root = transcriptHolders[row.id]?.root ?: continue
      survivingAnchors.add(row.id to (transcriptColumn.top + root.top - y))
    }
    return TranscriptScroll(follow, anchor?.id, offset, y, scrollInteraction, survivingAnchors)
  }

  /** 单次布局完成后恢复位置；不每帧 smoothScroll/resize，不抢用户刚开始的触摸。 */
  private fun scheduleTranscriptScroll() {
    if (!attached || transcriptPreDraw != null || pendingTranscriptScroll == null) return
    val observer = scrollView.viewTreeObserver
    if (!observer.isAlive) return
    val callback = ViewTreeObserver.OnPreDrawListener {
      val saved = pendingTranscriptScroll
      cancelTranscriptScroll()
      if (saved != null && attached && !scrollTouching && saved.interaction == scrollInteraction) {
        val target = if (saved.follow) {
          (scrollBody.height - scrollView.height).coerceAtLeast(0)
        } else {
          val anchor = saved.anchorId?.let { transcriptHolders[it]?.root }
          if (anchor != null) transcriptColumn.top + anchor.top - saved.offset else {
            // Bounded head eviction may remove the first visible row; pin its next surviving neighbour.
            val fallback = saved.survivingAnchors.firstOrNull { transcriptHolders.containsKey(it.first) }
            if (fallback == null) saved.scrollY else transcriptColumn.top + transcriptHolders.getValue(fallback.first).root.top - fallback.second
          }
        }
        scrollView.scrollTo(0, target.coerceAtLeast(0))
      }
      true
    }
    transcriptObserver = observer
    transcriptPreDraw = callback
    observer.addOnPreDrawListener(callback)
  }

  private fun cancelTranscriptScroll() {
    transcriptPreDraw?.let { callback -> transcriptObserver?.takeIf { it.isAlive }?.removeOnPreDrawListener(callback) }
    transcriptPreDraw = null
    transcriptObserver = null
    pendingTranscriptScroll = null
  }

  /** 工具行增量：行数不变只改文本/状态色；行数变化只改尾部（§4.3 环形缓冲 = 保留最新）。 */
  private fun renderRows(rows: List<OverlayToolRowItem>) {
    val plan = overlayRowMergePlan(rowHolders.size, rows.size)
    // 1) 原地更新前 update 行。
    for (i in 0 until plan.updateCount) bindRow(rowHolders[i], rows[i])
    // 2) 收掉尾部多余行（从尾部移除，索引始终有效）。
    repeat(plan.removeCount) {
      val last = rowHolders.removeAt(rowHolders.size - 1)
      rowsColumn.removeView(last.root)
    }
    // 3) 追加新行（只追尾部；数据源是「最新在尾部」的追加模型）。
    repeat(plan.addCount) {
      val holder = createRow()
      rowsColumn.addView(
        holder.root,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
      )
      rowHolders.add(holder)
      bindRow(holder, rows[rowHolders.size - 1])
      // 新行出现才播一次过渡（0→1 透明度 + 上移 4dp 归位），原地更新行不重播。
      rowReveal.reveal(holder.root, rowHolders.size - 1, revealEnabled())
    }
  }

  private fun createRow(): RowHolder {
    val dot = View(context).apply {
      background = GradientDrawable().apply { shape = GradientDrawable.OVAL }
    }
    val title = TextView(context).apply {
      textSize = 12f
      setTextColor(colorTextPrimary)
      maxLines = 1
      ellipsize = TextUtils.TruncateAt.END
    }
    val detail = TextView(context).apply {
      textSize = 11f
      setTextColor(colorTextSecondary)
      maxLines = 1
      ellipsize = TextUtils.TruncateAt.END
    }
    val row = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(0, dp(3), 0, dp(3))
      addView(dot, LinearLayout.LayoutParams(dp(6), dp(6)).apply { marginEnd = dp(8) })
      addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(
        detail,
        LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(8) },
      )
    }
    return RowHolder(row, dot, title, detail)
  }

  private fun bindRow(holder: RowHolder, item: OverlayToolRowItem) {
    holder.title.setTextIfChanged(overlaySingleLine(item.title))
    val detail = overlaySingleLine(item.detail)
    holder.detail.setTextIfChanged(detail)
    holder.detail.visibility = if (detail.isEmpty()) View.GONE else View.VISIBLE
    val color = when (item.state) {
      OverlayToolRowState.DONE -> colorOk
      OverlayToolRowState.RUNNING -> colorWarn
      OverlayToolRowState.FAILED -> colorDanger
    }
    (holder.dot.background as? GradientDrawable)?.setColor(color)
    // 行级 contentDescription 给读屏：状态语义不能只靠颜色。
    holder.root.contentDescription = when (item.state) {
      OverlayToolRowState.DONE -> UiText.t(context, "已完成", "Done")
      OverlayToolRowState.RUNNING -> UiText.t(context, "进行中", "Running")
      OverlayToolRowState.FAILED -> UiText.t(context, "失败", "Failed")
    } + " " + overlaySingleLine(item.title)
  }

  /** 待答区只在结构变化时重建（按钮集合变了才需要新 View）；文本级变化仍走重建的这一处。 */
  private fun renderPending(pending: List<OverlayPendingAction>) {
    val signature = pending.joinToString("\u0001") { it.eventId + "\u0002" + it.kind + "\u0002" + it.label }
    if (signature == pendingSignature) return
    pendingSignature = signature
    pendingColumn.removeAllViews()
    if (pending.isEmpty()) {
      pendingColumn.visibility = View.GONE
      return
    }
    // 待答行是结构重建（按钮集合变了），因此每一行都是「新出现」，逐行淡入并错峰。
    // 先让容器可见再起过渡：父级 GONE 时启动的动画不产生可见帧，等于白跑。
    // 这里不 settleAll：它会把同时在过渡中的工具行也一起收口。
    pendingColumn.visibility = View.VISIBLE
    var pendingIndex = 0
    for (action in pending) {
      val row = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(0, dp(2), 0, dp(2))
      }
      val label = TextView(context).apply {
        textSize = 11f
        setTextColor(colorTextSecondary)
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
        text = overlaySingleLine(action.label)
      }
      row.addView(label, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      if (action.kind == "approval") {
        row.addView(pendingButton(UiText.t(context, "查看审批", "Review"), filled = true) {
          listener.onCardPendingAction(action.eventId, action.kind, true)
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(MIN_TOUCH_TARGET_DP)).apply { marginStart = dp(6) })
        row.addView(pendingButton(UiText.t(context, "处理", "Review"), filled = false) {
          listener.onCardPendingAction(action.eventId, action.kind, false)
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(MIN_TOUCH_TARGET_DP)).apply { marginStart = dp(6) })
      } else {
        // question 只提供「回答」：真正的答复文本走输入区（卡片不可 focus，§8.1）。
        // approve 参数对 question 无意义，固定 true（契约见 OverlayCardListener）。
        row.addView(pendingButton(UiText.t(context, "回答", "Answer"), filled = true) {
          listener.onCardPendingAction(action.eventId, action.kind, true)
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(MIN_TOUCH_TARGET_DP)).apply { marginStart = dp(6) })
      }
      pendingColumn.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      rowReveal.reveal(row, pendingIndex, revealEnabled())
      pendingIndex += 1
    }
  }

  private fun pendingButton(label: String, filled: Boolean, onClick: () -> Unit): TextView = TextView(context).apply {
    text = label
    textSize = 11f
    gravity = Gravity.CENTER
    minWidth = dp(MIN_TOUCH_TARGET_DP)
    setTextColor(if (filled) colorOnAccent else colorDanger)
    background = GradientDrawable().apply {
      cornerRadius = dp(10).toFloat()
      setColor(if (filled) colorAccent else withAlpha(colorChip, 0.94f))
      if (!filled) setStroke(dp(1), colorBorder)
    }
    setPadding(dp(12), 0, dp(12), 0)
    isClickable = true
    contentDescription = label
    setOnClickListener { onClick() }
  }

  /**
   * 白条拖动：只上报阶段/累计位移/速度，不自己改窗口几何（阈值与高度量化在服务侧）。
   *
   * dx/dy 语义按契约固定为「相对 ACTION_DOWN 的累计位移」；速度取 VelocityTracker 的
   * y 分量（向下为正），单位 px/s。
   */
  private fun attachHandleGesture(hit: FrameLayout) {
    val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
    var tracker: VelocityTracker? = null
    val releaseVelocity = OverlayReleaseVelocity()
    var downRawY = 0f
    var dragging = false
    hit.setOnTouchListener { _, ev ->
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          tracker?.recycle()
          tracker = VelocityTracker.obtain().apply { addRawMovement(this, ev) }
          downRawY = ev.rawY
          releaseVelocity.reset(ev.eventTime, ev.rawY)
          dragging = false
          listener.onCardHandleDrag(OverlayDragPhase.DOWN, 0f, 0f)
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val t = tracker ?: return@setOnTouchListener false
          addRawMovement(t, ev)
          releaseVelocity.add(ev.eventTime, ev.rawY)
          val dy = ev.rawY - downRawY
          // 只判一次「进入拖动」：touchSlop 是触屏噪声下限，越过它才该让服务开始改高度。
          if (!dragging && kotlin.math.abs(dy) > touchSlop) dragging = true
          if (dragging) listener.onCardHandleDrag(OverlayDragPhase.MOVE, dy, 0f)
          true
        }
        MotionEvent.ACTION_UP -> {
          val t = tracker ?: return@setOnTouchListener false
          addRawMovement(t, ev)
          t.computeCurrentVelocity(1000)
          val dy = ev.rawY - downRawY
          releaseVelocity.add(ev.eventTime, ev.rawY)
          if (BuildConfig.DEBUG) android.util.Log.d("dsh-overlay-gesture", "samples=" + releaseVelocity.toString() + " event=" + ev.eventTime + " native=" + t.yVelocity)
          listener.onCardHandleDrag(OverlayDragPhase.UP, dy, releaseVelocity.resolve(t.yVelocity, ev.eventTime))
          t.recycle()
          tracker = null
          dragging = false
          true
        }
        MotionEvent.ACTION_CANCEL -> {
          tracker?.let {
            addRawMovement(it, ev)
            it.recycle()
          }
          tracker = null
          listener.onCardHandleDrag(OverlayDragPhase.CANCEL, 0f, 0f)
          dragging = false
          true
        }
        else -> false
      }
    }
  }

  /** Already-eased progress from OverlayMotion. Settle the actual window once in V2, not here. */
  fun applyMorph(progress: Float, pillHeightPx: Int, latestOutput: String, statusColor: Int) {
    morphProgress = if (progress.isFinite()) progress.coerceIn(0f, 1f) else 0f
    morphPillHeightPx = pillHeightPx.coerceIn(1, view.height.coerceAtLeast(1))
    morphLatestOutput = overlaySingleLine(latestOutput).ifEmpty { UiText.t(context, "暂无助手输出", "No assistant output yet") }
    morphStatusColor = statusColor
    // Old status/history/handle vanish before the latest-output layer starts appearing.
    val textAlpha = overlayCardMorphTextAlpha(morphProgress)
    val historyAlpha = textAlpha.historyAlpha
    morphCapsuleAlpha = textAlpha.capsuleAlpha
    headerRow.alpha = historyAlpha
    scrollView.alpha = historyAlpha
    handleHit.alpha = historyAlpha
    cardSurface.invalidateSelf()
    capsuleOutput.invalidateSelf()
    view.invalidateOutline()
    view.invalidate()
    updateMorphTouchableRegion()
  }

  fun resetMorph() {
    morphProgress = 0f
    morphCapsuleAlpha = 0f
    headerRow.alpha = 1f
    scrollView.alpha = 1f
    handleHit.alpha = 1f
    cardSurface.invalidateSelf()
    capsuleOutput.invalidateSelf()
    view.invalidateOutline()
    view.invalidate()
    updateMorphTouchableRegion()
  }

  /**
   * API33 public genuine input region: same local rounded shape as drawing. Identical integer regions
   * are cached by OverlayTouchRegion. Android schedules an internal layout traversal; no explicit
   * history measure or WM resize here. False requires V2's older-platform fallback.
   */
  fun updateMorphTouchableRegion(): Boolean {
    if (view.width <= 0 || view.height <= 0) return false
    val bounds = RectF(0f, 0f, view.width.toFloat(), morphVisibleHeight(view.height).coerceAtLeast(1f))
    return OverlayTouchRegion.apply(view, OverlayTouchRegion.rounded(bounds, morphCornerRadius()))
  }

  /** Compatibility visual offset only; V2 owns window geometry and clamping. */
  fun setHandleOffsetPx(dy: Float) {
    // 只移动可视白条，不移动命中容器；否则拖动中容器会越出卡片被裁切。
    handleBar.translationY = dy
  }

  /**
   * 内容在给定宽度下想占的高度（像素）。服务用它与 32%/40% 上限取 min 后再量化成窗口高。
   *
   * 不直接 measure 根 View：根里 ScrollView 是 weight=1，若用 AT_MOST 大高度去量根，
   * LinearLayout 会把剩余高度全部分给权重子项（ScrollView 拿到 EXACTLY 剩余 → 量出巨大值），
   * 得到的是上限而不是内容高度。故逐段量：chrome 子项用 EXACTLY 宽 + AT_MOST 高，
   * 工具行列表单独量（不受 ScrollView 的高度约束）。
   */
  fun measureContentHeightPx(maxWidthPx: Int): Int {
    val width = maxWidthPx.coerceAtLeast(1)
    var total = 0
    total += childHeightWithMargins(headerRow, width)
    if (thinkingLine.visibility != View.GONE) total += childHeightWithMargins(thinkingLine, width)
    if (rowsColumn.visibility != View.GONE) total += childHeightWithMargins(rowsColumn, width)
    if (transcriptColumn.visibility != View.GONE) total += childHeightWithMargins(transcriptColumn, width)
    if (footerLine.visibility != View.GONE) total += childHeightWithMargins(footerLine, width)
    if (pendingColumn.visibility != View.GONE) total += childHeightWithMargins(pendingColumn, width)
    total += dp(MIN_TOUCH_TARGET_DP)
    return total
  }

  private fun childHeightWithMargins(child: View, availableWidth: Int): Int {
    val lp = child.layoutParams as? LinearLayout.LayoutParams
    val horizontal = (lp?.leftMargin ?: 0) + (lp?.rightMargin ?: 0)
    val widthSpec = View.MeasureSpec.makeMeasureSpec(
      (availableWidth - horizontal).coerceAtLeast(1),
      View.MeasureSpec.EXACTLY,
    )
    val heightSpec = View.MeasureSpec.makeMeasureSpec(MEASURE_AT_MOST_BOUND, View.MeasureSpec.AT_MOST)
    child.measure(widthSpec, heightSpec)
    return child.measuredHeight + (lp?.topMargin ?: 0) + (lp?.bottomMargin ?: 0)
  }

  /**
   * 运行态呼吸：只作用于 RUNNING 行的状态点（§4.4「状态点/扫光」）。
   *
   * 静止时必须零动画：data.running=false 或没有 RUNNING 行时保持 alpha=1 且无 animator。
   * 动画开关关闭（系统关动画/省电）时直接停在终态。
   */
  private fun applyRunningAnimation(data: OverlayCardData) {
    runningRows = if (data.running) data.rows.mapIndexedNotNull { index, item ->
      if (item.state == OverlayToolRowState.RUNNING && index < rowHolders.size) index to item.id else null
    } else emptyList()
    syncRunningAnimations()
  }

  private fun syncRunningAnimations() {
    val signature = if (attached && motionEnabled) runningRows else emptyList()
    // 相同运行行只更新文案，不在每个 100ms render 里 cancel/restart 呼吸。
    if (signature == runningAnimationSignature) return
    stopRunningAnimations()
    runningAnimationSignature = signature
    for ((index, _) in signature) {
      val holder = rowHolders.getOrNull(index) ?: continue
      val animator = android.animation.ObjectAnimator.ofFloat(holder.dot, View.ALPHA, 1f, 0.4f).apply {
        duration = 900L
        repeatMode = android.animation.ValueAnimator.REVERSE
        repeatCount = android.animation.ValueAnimator.INFINITE
        interpolator = DsUi.ease
        start()
      }
      runningAnimators.add(animator)
    }
  }

  private fun stopRunningAnimations() {
    runningAnimationSignature = emptyList()
    for (animator in runningAnimators) animator.cancel()
    runningAnimators.clear()
    for (holder in rowHolders) holder.dot.alpha = 1f
  }

  /** 窗口/把手跟手会改变局部坐标原点；速度必须在屏幕原始坐标系里计算。 */
  private fun addRawMovement(tracker: VelocityTracker, event: MotionEvent) {
    val raw = MotionEvent.obtain(event)
    raw.offsetLocation(event.rawX - event.x, event.rawY - event.y)
    tracker.addMovement(raw)
    raw.recycle()
  }

  private fun withAlpha(color: Int, fraction: Float): Int =
    (color and 0x00FFFFFF) or ((fraction.coerceIn(0f, 1f) * 255f).toInt() shl 24)

  private fun dp(value: Int): Int = (value * density).toInt()

  private companion object {
    /** measure 用的 AT_MOST 上限：远大于任何屏幕高度，只防 MeasureSpec 进位溢出。 */
    const val MEASURE_AT_MOST_BOUND = 1 shl 20
  }
}
