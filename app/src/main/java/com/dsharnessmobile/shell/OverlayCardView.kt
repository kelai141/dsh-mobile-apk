package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
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
 *  1. 状态行：stateLabel（13sp 粗体主文字）+ 「xN」工具数（11sp 次文字）+ 隐藏入口 + 关闭按钮；
 *  2. 单行思考行（13sp 次文字，maxLines=1，空则 GONE）；
 *  3. ScrollView（weight=1）内的工具行列表（状态点 6dp + 标题 12sp + 详情 11sp，上限 50 行）；
 *  4. 底部说明行 footerLine（11sp，空则 GONE）；
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
 * 同形缺陷）。故层次只靠 1dp ds_border 描边 + 92% 不透明底色表达，任何人都不要再加
 * elevation（加了也看不见，只会误导后续维护者）。
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

  /** 「隐藏」入口：把入口收进召回条（隐藏态），与「关闭卡片」是两件事。文字按钮不新建 drawable。 */
  private val hideButton = TextView(context).apply {
    tag = "overlay-card-hide"
    text = UiText.t(context, "隐藏", "Hide")
    textSize = 11f
    setTextColor(colorTextSecondary)
    gravity = Gravity.CENTER
    minWidth = dp(MIN_TOUCH_TARGET_DP)
    minHeight = dp(MIN_TOUCH_TARGET_DP)
    contentDescription = UiText.t(context, "隐藏悬浮入口", "Hide floating entry")
    isClickable = true
    setOnClickListener { listener.onCardHideEntry() }
  }

  /** 关闭按钮：44dp 命中区内画「x」，只用文本不引图标资源（本仓不给单入口新建 drawable）。 */
  private val closeButton = FrameLayout(context).apply {
    tag = "overlay-card-close"
    contentDescription = UiText.t(context, "收起卡片", "Collapse card")
    isClickable = true
    setOnClickListener { listener.onCardCollapse() }
    addView(
      TextView(context).apply {
        text = "\u00D7"
        textSize = 18f
        setTextColor(colorTextPrimary)
        gravity = Gravity.CENTER
      },
      FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER),
    )
  }

  private val headerRow = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(dp(14), dp(2), dp(6), dp(2))
    addView(statusLabel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    addView(
      toolCountLabel,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        marginStart = dp(8)
      },
    )
    addView(
      hideButton,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(MIN_TOUCH_TARGET_DP)).apply {
        marginStart = dp(4)
      },
    )
    addView(
      closeButton,
      LinearLayout.LayoutParams(dp(MIN_TOUCH_TARGET_DP), dp(MIN_TOUCH_TARGET_DP)).apply {
        marginStart = dp(4)
      },
    )
  }

  // ── 思考行 / 页脚 / 待答区 ────────────────────────────────────────────────
  private val thinkingLine = TextView(context).apply {
    tag = "overlay-card-thinking"
    textSize = 13f
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
  private val scrollView = ScrollView(context).apply {
    isFillViewport = false
    overScrollMode = View.OVER_SCROLL_NEVER
    addView(rowsColumn, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
  }
  private class RowHolder(val root: View, val dot: View, val title: TextView, val detail: TextView)
  private val rowHolders = ArrayList<RowHolder>()
  private val runningAnimators = ArrayList<android.animation.Animator>()

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

  /** 卡片根视图：唯一供服务塞进窗口的 View。 */
  val view: View = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    background = GradientDrawable().apply {
      cornerRadius = context.resources.getDimension(R.dimen.ds_radius_card)
      // 92% 不透明度：既要透出底层内容的层次感，又要保证 13sp 正文对比度。
      setColor(withAlpha(colorSurface, 0.92f))
      setStroke(dp(1), colorBorder)
    }
    addView(headerRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(thinkingLine, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(scrollView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    addView(footerLine, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(pendingColumn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(handleHit, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(MIN_TOUCH_TARGET_DP)))
  }

  init {
    // 视图被移出窗口（服务收卡片窗）时立刻停掉常驻动画：否则呼吸会继续跑在没人看的 View 上。
    view.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(v: View) = Unit
      override fun onViewDetachedFromWindow(v: View) = stopRunningAnimations()
    })
  }

  /**
   * 幂等渲染：只更新文本/可见性/行增删，不重建整棵 View 树。
   *
   * 幂等的要求来自服务侧事件合并：同一份快照可能被 render 多次（合并窗口内重复触发、
   * 换肤、开动画开关），任何一次都不能改变最终状态。
   */
  fun render(data: OverlayCardData) {
    statusLabel.text = overlaySingleLine(data.stateLabel)
    if (data.toolCount > 0) {
      toolCountLabel.text = "\u00D7" + data.toolCount
      toolCountLabel.visibility = View.VISIBLE
    } else {
      toolCountLabel.visibility = View.GONE
    }

    val thinking = overlaySingleLine(data.thinkingLine)
    thinkingLine.text = thinking
    thinkingLine.visibility = if (thinking.isEmpty()) View.GONE else View.VISIBLE

    val footer = overlaySingleLine(data.footerLine)
    footerLine.text = footer
    footerLine.visibility = if (footer.isEmpty()) View.GONE else View.VISIBLE

    renderRows(data.rows)
    renderPending(data.pending)
    applyRunningAnimation(data)
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
    holder.title.text = overlaySingleLine(item.title)
    val detail = overlaySingleLine(item.detail)
    holder.detail.text = detail
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
        row.addView(pendingButton(UiText.t(context, "允许", "Allow"), filled = true) {
          listener.onCardPendingAction(action.eventId, action.kind, true)
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(MIN_TOUCH_TARGET_DP)).apply { marginStart = dp(6) })
        row.addView(pendingButton(UiText.t(context, "拒绝", "Reject"), filled = false) {
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
    }
    pendingColumn.visibility = View.VISIBLE
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
    var downRawY = 0f
    var dragging = false
    hit.setOnTouchListener { _, ev ->
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          tracker?.recycle()
          tracker = VelocityTracker.obtain().apply { addMovement(ev) }
          downRawY = ev.rawY
          dragging = false
          listener.onCardHandleDrag(OverlayDragPhase.DOWN, 0f, 0f)
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val t = tracker ?: return@setOnTouchListener false
          t.addMovement(ev)
          val dy = ev.rawY - downRawY
          // 只判一次「进入拖动」：touchSlop 是触屏噪声下限，越过它才该让服务开始改高度。
          if (!dragging && kotlin.math.abs(dy) > touchSlop) dragging = true
          if (dragging) listener.onCardHandleDrag(OverlayDragPhase.MOVE, dy, 0f)
          true
        }
        MotionEvent.ACTION_UP -> {
          val t = tracker ?: return@setOnTouchListener false
          t.addMovement(ev)
          t.computeCurrentVelocity(1000)
          val dy = ev.rawY - downRawY
          listener.onCardHandleDrag(OverlayDragPhase.UP, dy, t.yVelocity)
          t.recycle()
          tracker = null
          dragging = false
          true
        }
        MotionEvent.ACTION_CANCEL -> {
          tracker?.let {
            it.addMovement(ev)
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

  /**
   * 服务在拖动中做「视觉跟手」时用：把把手整体平移 dy（像素，向下为正）。
   *
   * 注意：本方法**只**移动把手，不动窗口；是否跟随、如何钳制由服务决定。把手是卡片
   * 最后一行，负值会让它移出窗口可视区，调用方自行限制范围。
   */
  fun setHandleOffsetPx(dy: Float) {
    handleHit.translationY = dy
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
    total += childHeightWithMargins(rowsColumn, width)
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
    stopRunningAnimations()
    if (!data.running || !DsUi.animationsEnabled(context)) return
    for ((index, item) in data.rows.withIndex()) {
      if (item.state != OverlayToolRowState.RUNNING) continue
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
    for (animator in runningAnimators) animator.cancel()
    runningAnimators.clear()
    for (holder in rowHolders) holder.dot.alpha = 1f
  }

  private fun withAlpha(color: Int, fraction: Float): Int =
    (color and 0x00FFFFFF) or ((fraction.coerceIn(0f, 1f) * 255f).toInt() shl 24)

  private fun dp(value: Int): Int = (value * density).toInt()

  private companion object {
    /** measure 用的 AT_MOST 上限：远大于任何屏幕高度，只防 MeasureSpec 进位溢出。 */
    const val MEASURE_AT_MOST_BOUND = 1 shl 20
  }
}
