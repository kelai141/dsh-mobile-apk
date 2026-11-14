package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.os.SystemClock
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.view.WindowInsets
import android.widget.Toast
import org.json.JSONObject

/**
 * 悬浮交互 v2（entry_ui_v2）的窗口编排层：入口 / 顶部事件卡片 / 状态药丸 / 底部输入区。
 *
 * 与旧实现（OverlayService.buildRoot + OverlayPanel）的关系：
 *  - 开关 **关闭**（默认）= 旧的三窗实现，一切行为不变（回滚第一手段，见 implementation-plan.md §12 L1）；
 *  - 开关 **打开** = 本类接管全部悬浮窗口；旧面板仅保留「提问作答」与回滚两条用途，
 *    不再承担主界面（design.md §11.1 的拆分复用决策在实现上收敛为「v2 接管 + 面板作降级面」）。
 *
 * 结构性纪律（任何改动都不得违反）：
 *  1. 窗口矩形 = 可视矩形：每个窗口的可触摸区域就是它画出来的那块，禁止全屏透明窗；
 *  2. 一切「收起/隐藏」只动窗口，**不动服务与数据流**（Mux/探活/live 流照常跑）——R13；
 *  3. 尺寸/位置全部经 [OverlayWindowFrames] 纯函数计算（可单测），本类不写字面量几何；
 *  4. 事件 → 模型 → 渲染：模型聚合在 [OverlayUiModel]（纯函数），本类只做「模型 → View 绑定 + 窗口 resize」，
 *     避免事件风暴下每帧重建 View（design.md §4.3/§7.7）；
 *  5. 静止零刷新：无事件时除「运行时钟」外没有任何定时重绘，卡片不可见时时钟也必须停。
 */
internal class OverlayV2(private val svc: OverlayService) {

  internal companion object {
    /** 悬浮显示偏好（既有 overlay_display prefs；新键在此文件集中定义，便于 PERSISTENT-DATA 登记）。 */
    internal const val PREFS = "overlay_display"
    /** 新 UI 总开关（默认 false；P7 验收通过后单独 PR 改为 true）。 */
    internal const val KEY_ENTRY_UI_V2 = "entry_ui_v2"
    /** 入口形态：ball | strip（默认 ball）。 */
    internal const val KEY_ENTRY_STYLE = "entry_style"
    /** 取件租约恢复失败时的有限重试：不设上限就变成永久轮询。 */
  internal const val ATTACHMENT_RESTORE_MAX_ATTEMPTS = 3
  internal const val ATTACHMENT_RESTORE_RETRY_MS = 60L

  internal const val STYLE_BALL = "ball"
    internal const val STYLE_STRIP = "strip"
    /** 入口窗口上次位置（不落盘：隐藏是临时动作，位置也按会话存活即可）。 */
    private const val CARD_ANIM_MS = 180L
    private const val CARD_COLLAPSE_ANIM_MS = 140L
    private const val CARD_RESIZE_ANIM_MS = 160L
    private const val PILL_FADE_IN_MS = 120L
    private const val PILL_DISMISS_MS = 160L

    internal fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    internal fun enabled(context: Context): Boolean = try {
      prefs(context).getBoolean(KEY_ENTRY_UI_V2, false)
    } catch (_: Throwable) {
      false
    }

    internal fun entryStyle(context: Context): String = try {
      val v = prefs(context).getString(KEY_ENTRY_STYLE, STYLE_BALL) ?: STYLE_BALL
      if (v == STYLE_STRIP) STYLE_STRIP else STYLE_BALL
    } catch (_: Throwable) {
      STYLE_BALL
    }
  }

  // ── 窗口 ────────────────────────────────────────────────────────────────

  private val windows = OverlayWindows(svc.wm) { LogCollector.log("dsh-overlay", it) }
  private var style: String = entryStyle(svc)
  private var entryView: OverlayEntryView? = null
  private var entryParams: WindowManager.LayoutParams? = null
  private var entryX = 0
  private var entryY = 0
  private var card: OverlayCardView? = null
  private var cardParams: WindowManager.LayoutParams? = null
  private var pill: OverlayPillView? = null
  private var pillParams: WindowManager.LayoutParams? = null
  private var composer: OverlayComposer? = null
  private var composerParams: WindowManager.LayoutParams? = null

  // ── 模型与状态 ──────────────────────────────────────────────────────────

  private var model = OverlayCardModel()
  private var pageState: OverlayPageHost.PageState? = null
  private var pageCommands: List<OverlayPageHost.PageCommand> = emptyList()
  private var drawerMode = DrawerMode.NONE
  private var cardExpanded = false
  private var entryHiddenByUser = false
  private var hostForeground = OverlayHostVisibility.foreground
  private var selectedPendingEventId = ""
  // 当前提问的目标（事件 + 问题）；提交答案前用它做迟到回执比对。
  private var questionTarget: QuestionTarget? = null
  // 进入答题前留档的消息草稿：离开答题态时原样还原，用户写了一半的话不能丢。
  private var messageDraftBeforeAnswer: OverlayV2DraftSnapshot? = null

  /** 一次提问的稳定身份：事件 id + 问题 id，用来判断回执是否还属于当前这道题。 */
  private data class QuestionTarget(val eventId: String, val questionId: String)
  private var destroyed = false
  private var engineRunningCache = false

  /** 抽屉当前内容来源：命令（页面真源）/ 会话列表 / 工作区列表。 */
  private enum class DrawerMode { NONE, COMMANDS, SESSIONS, WORKSPACES }

  /** 渲染合并：一次事件风暴最多一次布局（100ms 窗口，design.md §5.4）。 */
  private var renderPending = false
  private var lastResizeAt = 0L
  private var clockTick: Runnable? = null
  private var lastSessionRowId = 0
  private val main get() = svc.main

  // ── 生命周期 ────────────────────────────────────────────────────────────

  internal fun start() {
    showEntry()
    OverlayAttachmentBus.handler = { kind, path, err -> onAttachmentResult(kind, path, err) }
    OverlayAttachmentBus.receiptHandler = { receipt -> onAttachmentReceipt(receipt) }
    OverlayAttachmentBus.pickerReturnedHandler = { sid, requestId -> restoreAttachmentInteraction(sid, requestId) }
    refreshPageState()
    refreshCommands()
  }

  internal fun destroy() {
    destroyed = true
    OverlayAttachmentBus.handler = null
    OverlayAttachmentBus.receiptHandler = null
    OverlayAttachmentBus.pickerReturnedHandler = null
    clockTick?.let { main.removeCallbacks(it) }
    clockTick = null
    entryView?.let { windows.remove(OverlayWindows.Slot.ENTRY) }
    card?.let { windows.remove(OverlayWindows.Slot.CARD) }
    pill?.let { windows.remove(OverlayWindows.Slot.PILL) }
    composer?.let { windows.remove(OverlayWindows.Slot.COMPOSER) }
    windows.removeAll()
    entryView = null
    card = null
    pill = null
    composer = null
  }

  private fun t(zh: String, en: String): String = UiText.t(svc, zh, en)

  // ── 入口 ────────────────────────────────────────────────────────────────

  /** 兼容名：历史调用点与测试契约都引用 buildEntry，实际实现是 showEntry。 */
  private fun buildEntry() = showEntry()

  private fun showEntry() {
    if (destroyed) return
    if (entryHiddenByUser || hostForeground) return
    val s = screen()
    val styleEnum = if (style == STYLE_STRIP) OverlayEntryStyle.STRIP else OverlayEntryStyle.BALL
    val view = OverlayEntryView(svc, styleEnum).also { entryView = it }
    // 「从未摆过」的哨兵：坐标为 (0,0) 说明用户还没拖过它（偏好默认值就是 0/0）。
    // 必须在两个分支之前算出来 —— 分开判会让球和条各写一份判据，之后必然漂移。
    val initialEntry = entryX == 0 && entryY == 0
    val w: Int
    val h: Int
    if (styleEnum == OverlayEntryStyle.STRIP) {
      w = OverlayWindowFrames.stripWindowWidthPx(s.density)
      h = OverlayWindowFrames.stripWindowHeightPx(s.density)
      // 细条贴边：默认贴右（上次拖到哪边就继续贴那边，右侧是主手位）。
      // 首次挂载必须离开 y=0：那是状态栏的触摸死区，条会「看得见点不到」。
      val placement = OverlayWindowFrames.stripPlacement(
        s, true, if (initialEntry) s.heightPx / 3 else entryY, h,
      )
      entryX = placement.first
      entryY = placement.second
    } else {
      w = (OverlayWindowFrames.ENTRY_BALL_DP * s.density).toInt()
      h = w
      // 初始右上角：与旧实现同口径（距右缘 12dp、竖直 1/3 处）。
      if (initialEntry) {
        entryX = (s.widthPx - w - (12 * s.density).toInt()).coerceAtLeast(0)
        entryY = s.heightPx / 3
      }
    }
    val lp = WindowManager.LayoutParams(
      w, h,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
      x = entryX
      y = entryY
    }
    entryParams = lp
    val ok = windows.add(OverlayWindows.Slot.ENTRY, view.view, lp)
    if (!ok) {
      // addView 失败（权限被撤/窗口数超限）：不能留下「点了没反应」的状态，给可见回执。
      entryView = null
      toast(t("悬浮入口创建失败，请检查悬浮窗权限", "Could not create the floating entry; check overlay permission"))
      return
    }
    attachEntryTouch(view.view, styleEnum == OverlayEntryStyle.STRIP)
  }

  private fun removeEntryWindow() {
    windows.remove(OverlayWindows.Slot.ENTRY)
    entryView = null
    entryParams = null
  }

  private fun attachEntryTouch(view: View, strip: Boolean) {
    val vc = ViewConfiguration.get(svc)
    val router = OverlayGestureRouter(
      vc.scaledTouchSlop.toFloat(),
      ViewConfiguration.getDoubleTapTimeout().toLong(),
      ViewConfiguration.getLongPressTimeout().toLong(),
    )
    var startX = 0
    var startY = 0
    var downRawX = 0f
    var downRawY = 0f
    // 这次入口触摸的 downTime：双击判定要延迟到超时之后才结算 TAP，那时已经拿不到 MotionEvent。
    var entryDownTime = -1L
    val longPress = Runnable {
      if (router.onLongPress(SystemClock.uptimeMillis()) == EntryGesture.LONG_PRESS) {
        onEntryLongPress()
      }
    }
    val resolveTap = Runnable {
      if (router.resolvePendingTap(SystemClock.uptimeMillis()) == EntryGesture.TAP) {
        val openCardOnTap = overlayEntryTapShouldOpen(cardVisible(), outsideClosedCardDownTime == entryDownTime)
        onEntryTap(openCardOnTap)
      }
    }
    view.setOnTouchListener { _, ev ->
      val lp = entryParams ?: return@setOnTouchListener false
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          router.onDown(SystemClock.uptimeMillis())
          entryDownTime = ev.downTime
          startX = lp.x
          startY = lp.y
          downRawX = ev.rawX
          downRawY = ev.rawY
          main.removeCallbacks(resolveTap)
          main.postDelayed(longPress, ViewConfiguration.getLongPressTimeout().toLong())
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = ev.rawX - downRawX
          val dy = ev.rawY - downRawY
          if (router.onMove(dx, dy) == EntryGesture.DRAG_START) main.removeCallbacks(longPress)
          if (router.isDragging()) {
            main.removeCallbacks(longPress)
            moveEntry(lp, startX, startY, dx, dy, strip)
          }
          true
        }
        MotionEvent.ACTION_UP -> {
          main.removeCallbacks(longPress)
          val dx = ev.rawX - downRawX
          val dy = ev.rawY - downRawY
          when (router.onUp(dx, dy, SystemClock.uptimeMillis())) {
            EntryGesture.DRAG_END -> settleEntry(lp, strip)
            EntryGesture.TAP -> {
              // 先把「这一次要不要展开」算成一个明确的决定，再交给 onEntryTap：
              // 同一次空白触摸已经收掉了卡片时，这里必须是 false。
              val openCardOnTap = overlayEntryTapShouldOpen(cardVisible(), outsideClosedCardDownTime == ev.downTime)
              onEntryTap(openCardOnTap)
            }
            EntryGesture.DOUBLE_TAP -> svc.jumpToApp()
            else -> main.postDelayed(resolveTap, ViewConfiguration.getDoubleTapTimeout().toLong())
          }
          true
        }
        MotionEvent.ACTION_CANCEL -> {
          main.removeCallbacks(longPress)
          router.reset()
          true
        }
        else -> false
      }
    }
  }

  private fun moveEntry(lp: WindowManager.LayoutParams, startX: Int, startY: Int, dx: Float, dy: Float, strip: Boolean) {
    val s = screen()
    if (strip) {
      // 细条只上下动：横向恒贴边（向右扩展会在屏内留下隐形触区，design.md §9.2）。
      entryY = OverlayWindowFrames.clampStripY(startY + dy.toInt(), lp.height, s)
      lp.y = entryY
    } else {
      entryX = OverlayWindowFrames.clampPillX(startX + dx.toInt(), lp.width, s)
      entryY = OverlayWindowFrames.clampPillY(startY + dy.toInt(), lp.width, lp.height, s)
      lp.x = entryX
      lp.y = entryY
    }
    windows.update(OverlayWindows.Slot.ENTRY, lp)
  }

  private fun settleEntry(lp: WindowManager.LayoutParams, strip: Boolean) {
    val s = screen()
    if (strip) {
      // 松手后吸附到最近的水平边缘：细条必须是「贴边拉手」，浮在屏中间毫无意义。
      val right = lp.x + lp.width / 2 >= s.widthPx / 2
      val placement = OverlayWindowFrames.stripPlacement(s, right, entryY, lp.height)
      entryX = placement.first
      entryY = placement.second
      lp.x = entryX
      lp.y = entryY
      lp.width = OverlayWindowFrames.stripWindowWidthPx(s.density)
      lp.height = OverlayWindowFrames.stripWindowHeightPx(s.density)
    } else {
      entryX = OverlayWindowFrames.clampPillX(lp.x, lp.width, s)
      entryY = OverlayWindowFrames.clampPillY(lp.y, lp.width, lp.height, s)
      lp.x = entryX
      lp.y = entryY
    }
    windows.update(OverlayWindows.Slot.ENTRY, lp)
  }

  /**
   * 入口点击。是否展开由 [open] 决定（由手势路由器与「同一次 outside 触摸」共同裁定）。
   *
   * 为什么需要 open 参数而不是就地判断 cardVisible()：同一次空白触摸会先收卡片、再触发入口的
   * TAP；如果这里只看 cardVisible()，就会立刻把刚收掉的卡片重新打开 —— 用户点空白反而弹出卡片。
   */
  private fun onEntryTap(open: Boolean) {
    if (open) showCard() else hideCard()
  }

  private fun onEntryLongPress() {
    // 长按 = 卡片 + 输入区同时展开；**不自动聚焦输入框**（刚长按完就弹键盘会挡住卡片）。
    showCard()
    showComposer(focusInput = false)
  }

  /**
   * 用户主动隐藏入口（卡片头部的「隐藏」）：入口离窗，屏上只剩贴边召回条。
   * 服务不停：探活 / Mux / live 流照常（R13）。
   */
  internal fun hideEntry() {
    if (entryHiddenByUser) return
    entryHiddenByUser = true
    hideCard()
    hidePill(false)
    hideComposer()
    val p = entryParams
    removeEntryWindow()
    svc.hidden = true
    svc.recall.show(p?.x ?: entryX, p?.y ?: entryY, (OverlayWindowFrames.ENTRY_BALL_DP * screen().density).toInt())
  }

  /** 从召回条恢复入口（b 服务 recallBall 调用）。 */
  internal fun restoreEntry() {
    if (!entryHiddenByUser) return
    entryHiddenByUser = false
    svc.hidden = false
    svc.recall.hide()
    showEntry()
  }

  /** 本体进入/离开前台：入口隐藏但服务与后台 Agent 不受影响（R3）。 */
  internal fun onHostForeground(foreground: Boolean) {
    if (hostForeground == foreground) return
    hostForeground = foreground
    if (foreground) {
      // 本体在前台时用户就在看主界面，悬浮入口是纯遮挡：移除窗口（不是 alpha/GONE）。
      if (cardVisible()) hideCard()
      hidePill(false)
      hideComposer()
      if (!entryHiddenByUser) removeEntryWindow()
    } else if (!entryHiddenByUser) {
      showEntry()
    }
  }

  // ── 顶部事件卡片 ────────────────────────────────────────────────────────

  private fun cardVisible(): Boolean = windows.contains(OverlayWindows.Slot.CARD)

  internal fun showCard() {
    if (destroyed) return
    if (card == null) {
      val view = OverlayCardView(svc, object : OverlayCardListener {
        override fun onCardCollapse() = hideCard()
        override fun onCardHandleDrag(phase: OverlayDragPhase, dyPx: Float, velocityPxPerS: Float) =
          handleCardHandleDrag(phase, dyPx, velocityPxPerS)
        override fun onCardPendingAction(eventId: String, kind: String, approve: Boolean) =
          onPendingAction(eventId, kind, approve)
        override fun onCardHideEntry() = hideEntry()
      })
      card = view
      // 「点卡片外部收起」的接线单独抽出去：它不属于「卡片展开」这件事，混在 showCard 里
      // 会让这段代码同时承担建窗与手势裁定两种职责，也让 outside 语义散在两处。
      attachCardOutsideTouch(view)
    }
    val c = card ?: return
    if (cardVisible()) {
      renderCard()
      return
    }
    hidePill(false)
    val s = screen()
    val contentH = c.measureContentHeightPx(OverlayWindowFrames.cardWidthPx(s))
    val targetH = OverlayWindowFrames.cardHeightPx(contentH, s, cardExpanded)
    val lp = WindowManager.LayoutParams(
      OverlayWindowFrames.cardWidthPx(s), targetH,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
        WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
      x = (OverlayWindowFrames.CARD_SIDE_MARGIN_DP * s.density).toInt()
      y = OverlayWindowFrames.cardTopPx(s)
    }
    cardParams = lp
    renderCard()
    val ok = windows.add(OverlayWindows.Slot.CARD, c.view, lp)
    if (!ok) {
      cardParams = null
      toast(t("事件卡片创建失败", "Could not create the event card"))
      return
    }
    c.view.alpha = 0f
    val rise = 8 * s.density
    c.view.translationY = -rise
    if (DSUiAnimationsEnabled()) {
      c.view.animate().alpha(1f).translationY(0f).setDuration(CARD_ANIM_MS).start()
    } else {
      c.view.alpha = 1f
      c.view.translationY = 0f
    }
    startClockIfNeeded()
    refreshPageState()
  }


  internal fun hideCard() {
    if (!cardVisible()) return
    stopClock()
    windows.remove(OverlayWindows.Slot.CARD)
    cardParams = null
    cardExpanded = false
  }

  /**
   * 顶部卡片不消费 outside 触摸。
   *
   * design.md §3.4 的当前裁决（用户 2026-11-12 直接澄清）：**中间空白点击只收下面输入和键盘，
   * 不关上面输出**。旧版把 ACTION_OUTSIDE 接 hideCard 的解释已废止，且明确写了
   * 「顶部即使监听 outside 也不得调用 hideCard」。
   *
   * 因此这里只做一件事：记下这次触摸的 downTime，供入口 TAP 判定"同一次触摸已经处理过"。
   * 绝不动卡片本身 —— 用户点空白是为了收起键盘，不是想丢掉正在读的转录。
   */
  private fun attachCardOutsideTouch(view: OverlayCardView) {
    view.view.setOnTouchListener { _, ev ->
      if (ev.actionMasked == MotionEvent.ACTION_OUTSIDE) {
        outsideClosedCardDownTime = ev.downTime
        false
      } else {
        false
      }
    }
  }

  private fun collapseToPill() {
    hideCard()
    showPill()
  }

  private fun handleCardHandleDrag(phase: OverlayDragPhase, dyPx: Float, velocityPxPerS: Float) {
    val c = card ?: return
    when (phase) {
      OverlayDragPhase.DOWN -> Unit
      OverlayDragPhase.MOVE -> c.setHandleOffsetPx(dyPx.coerceIn(-48f * screen().density, 48f * screen().density))
      OverlayDragPhase.UP, OverlayDragPhase.CANCEL -> {
        c.setHandleOffsetPx(0f)
        if (phase == OverlayDragPhase.CANCEL) return
        val density = screen().density
        val fastUp = dyPx <= -48f * density && velocityPxPerS <= -500f * density
        if (fastUp) {
          collapseToPill()
        } else if (dyPx >= 24f * density) {
          setCardExpanded(true)
        } else if (dyPx <= -24f * density && cardExpanded) {
          setCardExpanded(false)
        }
      }
    }
  }

  private fun setCardExpanded(expanded: Boolean) {
    if (cardExpanded == expanded) return
    cardExpanded = expanded
    val lp = cardParams ?: return
    val c = card ?: return
    val s = screen()
    val target = OverlayWindowFrames.cardHeightPx(c.measureContentHeightPx(lp.width), s, expanded)
    animateWindowHeight(OverlayWindows.Slot.CARD, lp, target, CARD_RESIZE_ANIM_MS)
    lastResizeAt = SystemClock.uptimeMillis()
  }

  private fun animateWindowHeight(slot: OverlayWindows.Slot, lp: WindowManager.LayoutParams, target: Int, durationMs: Long) {
    if (lp.height == target) return
    if (!DSUiAnimationsEnabled()) {
      lp.height = target
      windows.update(slot, lp)
      return
    }
    val from = lp.height
    val anim = android.animation.ValueAnimator.ofInt(from, target)
    anim.duration = durationMs
    anim.interpolator = DsUi.ease
    anim.addUpdateListener { a ->
      lp.height = a.animatedValue as Int
      windows.update(slot, lp)
    }
    anim.start()
  }

  /** 内容变化后按量化档重算卡片高度（≥120ms 间隔，避免事件风暴 resize 抖动）。 */
  private fun resizeCardIfNeeded() {
    val lp = cardParams ?: return
    val c = card ?: return
    val s = screen()
    val content = c.measureContentHeightPx(lp.width)
    val target = OverlayWindowFrames.cardHeightPx(content, s, cardExpanded)
    if (target == lp.height) return
    val now = SystemClock.uptimeMillis()
    if (now - lastResizeAt < OverlayWindowFrames.CARD_RESIZE_MIN_INTERVAL_MS) return
    lastResizeAt = now
    animateWindowHeight(OverlayWindows.Slot.CARD, lp, target, CARD_RESIZE_ANIM_MS)
  }

  // ── 状态药丸 ────────────────────────────────────────────────────────────

  private fun pillVisible(): Boolean = windows.contains(OverlayWindows.Slot.PILL)

  private fun showPill() {
    if (destroyed) return
    if (pill == null) {
      pill = OverlayPillView(svc, object : OverlayPillListener {
        override fun onPillTap() {
          hidePill(false)
          showCard()
        }
        override fun onPillDrag(phase: OverlayDragPhase, dxPx: Float, dyPx: Float, velocityPxPerS: Float) =
          handlePillDrag(phase, dxPx, dyPx, velocityPxPerS)
      })
    }
    val p = pill ?: return
    if (pillVisible()) return
    val s = screen()
    val pm = OverlayUiModel.pillOf(model, UiText.isEnglish(svc))
    p.render(pm.text, toneOf(pm.tone))
    // 初位置：卡片下沿水平居中（design.md §4.2）。卡片已收起时沿用上次药丸位置或屏幕上部。
    val h = (OverlayWindowFrames.PILL_HEIGHT_DP * s.density).toInt()
    val maxPillWidth = (s.widthPx * OverlayWindowFrames.PILL_WIDTH_MAX_RATIO).toInt()
    val w = OverlayWindowFrames.pillWidthPx(p.measureContentWidthPx(maxPillWidth), s)
    val posX = OverlayWindowFrames.clampPillX((s.widthPx - w) / 2, w, s)
    val posY = OverlayWindowFrames.clampPillY(
      cardParams?.let { it.y + it.height + (8 * s.density).toInt() } ?: (s.heightPx / 3), w, h, s,
    )
    val lp = WindowManager.LayoutParams(
      w, h,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
      x = posX
      y = posY
    }
    pillParams = lp
    if (!windows.add(OverlayWindows.Slot.PILL, p.view, lp)) {
      pillParams = null
      toast(t("状态药丸创建失败", "Could not create the status pill"))
      return
    }
    p.fadeIn()
  }

  private fun hidePill(animated: Boolean) {
    if (!pillVisible()) return
    val p = pill ?: return
    if (!animated || !DSUiAnimationsEnabled()) {
      windows.remove(OverlayWindows.Slot.PILL)
      pillParams = null
      return
    }
    p.fadeOutAndShrink {
      windows.remove(OverlayWindows.Slot.PILL)
      pillParams = null
    }
  }

  /**
   * 胶囊上推消散。
   *
   * 消散判定统一走 [OverlayMotion.topDrag] / [topRelease]：手写阈值会让「贴近顶部仍可回弹」
   * 「越界先淡出再消散」这两段连续性丢失，用户看到的是一跳一跳的。这里只做坐标搬运与落位。
   */
  private fun handlePillDrag(phase: OverlayDragPhase, dxPx: Float, dyPx: Float, velocityPxPerS: Float) {
    val lp = pillParams ?: return
    val s = screen()
    val policy = motion()
    when (phase) {
      OverlayDragPhase.DOWN -> {
        pillDownX = lp.x
        pillDownY = lp.y
        pillTopStart = lp.y.toFloat()
      }
      OverlayDragPhase.MOVE -> {
        val frame = policy.topDrag(pillTopStart, dyPx, motionTopLimitPx(s))
        lp.x = OverlayWindowFrames.clampPillX(pillDownX + dxPx.toInt(), lp.width, s)
        lp.y = OverlayWindowFrames.clampPillY(frame.topPx.toInt(), lp.width, lp.height, s)
        // 淡出直接作用在视图上：窗口 alpha 会让整个窗口（含阴影）一起变淡，
        // 用户看到的是"窗口在闪"而不是"胶囊内容在消散"。
        pill?.let { p -> p.view.alpha = frame.alpha }
        windows.update(OverlayWindows.Slot.PILL, lp)
      }
      OverlayDragPhase.UP -> {
        val frame = policy.topDrag(pillTopStart, dyPx, motionTopLimitPx(s))
        val release = policy.topRelease(frame)
        lp.x = OverlayWindowFrames.clampPillX(pillDownX + dxPx.toInt(), lp.width, s)
        lp.y = OverlayWindowFrames.clampPillY(frame.topPx.toInt(), lp.width, lp.height, s)
        pill?.setContentAlpha(release.frame.alpha)
        windows.update(OverlayWindows.Slot.PILL, lp)
        if (release.hide) dismissPill()
      }
      OverlayDragPhase.CANCEL -> {
        pill?.setContentAlpha(1f)
        lp.y = OverlayWindowFrames.clampPillY(pillTopStart.toInt(), lp.width, lp.height, s)
        windows.update(OverlayWindows.Slot.PILL, lp)
      }
    }
  }

  /** 消散策略实例：阈值按当前屏幕密度换算，避免硬编码像素在不同机型上失准。 */
  private fun motion(): OverlayMotion = OverlayMotion(OverlayMotionConfig.provisional(screen().density))

  /** 胶囊可拖动的物理上界：状态栏以下，避免拖进系统手势区。 */
  private fun motionTopLimitPx(s: OverlayScreen): Float = s.statusBarPx.toFloat()

  private var pillTopStart = 0f
  private var pillDownX = 0
  private var pillDownY = 0

  private fun dismissPill() {
    val p = pill ?: return
    if (!DSUiAnimationsEnabled()) {
      windows.remove(OverlayWindows.Slot.PILL)
      pillParams = null
      return
    }
    p.fadeOutAndShrink {
      windows.remove(OverlayWindows.Slot.PILL)
      pillParams = null
      // 胶囊消散只是「把界面收起来」，不是取消任务：绝不能 requestStop/stopSelf，
      // 也不能清输入框草稿（用户可能还要接着写）。
      hideComposer()
    }
  }

  /** 只重渲染胶囊（页面不可用/转录结算后都要能单独刷新它，不必动卡片）。 */
  private fun renderPill() {
    val p = pill ?: return
    val pm = OverlayUiModel.pillOf(model, UiText.isEnglish(svc))
    p.render(pm.text, toneOf(pm.tone))
  }

  private fun toneOf(tone: OverlayTone): OverlayUiTone = when (tone) {
    OverlayTone.WORKING -> OverlayUiTone.WORKING
    OverlayTone.WAITING -> OverlayUiTone.WAITING
    OverlayTone.ERROR -> OverlayUiTone.ERROR
    else -> OverlayUiTone.IDLE
  }

  // ── 底部输入区 ──────────────────────────────────────────────────────────

  private fun composerVisible(): Boolean = windows.contains(OverlayWindows.Slot.COMPOSER)

  /**
   * 输入区外点击。
   *
   * 只有「点到真正的空白」才算 outside：点在卡片/胶囊/球/chip/sheet 上的事件由那些窗口
   * 自己消费，但系统仍可能向输入窗补发一个 ACTION_OUTSIDE（相邻窗口的边界），此时收输入区
   * 就是误伤 —— 用户明明点的是另一个浮窗。所以先按坐标排除所有其它槽位的可见区域。
   */
  private fun onInputOutside(event: MotionEvent) {
    if (attachmentInteraction != null) return
    if (event.actionMasked != MotionEvent.ACTION_OUTSIDE) return
    // 一次点击会向每个浮窗各发一次 OUTSIDE；按 downTime 去重，否则同一击会先收 sheet 再收输入区。
    if (event.downTime == outsideHandledDownTime) return
    outsideHandledDownTime = event.downTime
    val x = event.rawX.toInt()
    val y = event.rawY.toInt()
    val others = listOf(
      OverlayWindows.Slot.CARD,
      OverlayWindows.Slot.ENTRY,
      OverlayWindows.Slot.PILL,
      OverlayWindows.Slot.WORKSPACE,
      OverlayWindows.Slot.SESSION,
      OverlayWindows.Slot.DRAWER,
      OverlayWindows.Slot.COMPOSER,
    )
    if (others.any { containsTouch(it, x, y) }) return
    // 有加号卡片（sheet）开着时，空白先收卡片，输入区与草稿都保留 —— 用户基线明确要求
    // 「在有加号卡片的情况下点空白区不会导致输入框收起」。
    if (drawerMode != DrawerMode.NONE) {
      // 顺序不可交换：animateDrawerOut 里会看 drawerOpen，而 drawerOpen 由 drawerMode 推导。
      // 先收窗再改模式，会让「已打开」判据仍然为真，收起动画直接被跳过、sheet 永远留在屏上。
      drawerMode = DrawerMode.NONE
      hideDrawer(true)
      return
    }
    hideComposer()
  }

  /** 某个槽位的窗口是否覆盖这个屏幕坐标（用于区分「点到空白」与「点到别的浮窗」）。 */
  private fun containsTouch(slot: OverlayWindows.Slot, x: Int, y: Int): Boolean {
    val lp = windows.params(slot) ?: return false
    return x >= lp.x && x < lp.x + lp.width && y >= lp.y && y < lp.y + lp.height
  }

  /**
   * 惰性建出 composer 视图，并且只在第一次挂监听。
   *
   * 为什么监听不能挂在 showComposer 里：每次展开都挂一遍会累积成几十个重复回调，
   * 设备上表现为拖动明显掉帧。
   */
  private fun ensureComposerView(): OverlayComposer {
    composer?.let { return it }
    val c = OverlayComposer(svc, object : OverlayComposerListener {
      override fun onComposerSend(text: String) = sendText(text)
      override fun onComposerStop() = svc.requestStop()
      override fun onComposerAttach(kind: String) = startAttachment(kind)
      override fun onComposerRemoveAttachment(index: Int) = removeAttachment(index)
      override fun onComposerWorkspaceChip() = openWorkspacePicker()
      override fun onComposerSessionChip() = openSessionPicker()
      override fun onComposerCommand(line: String) = onDrawerPick(line)
      override fun onComposerLayoutChanged() = refreshComposerWindowHeight()
      override fun onComposerBack() = onComposerBackPressed()
      override fun onComposerToggleDrawer() = toggleDrawer()
    })
    composer = c
    val root = c.view
    // outside 事件只可能发到根视图：子视图各自消费自己的触摸，ACTION_OUTSIDE 是窗口级事件。
    // 不在这里挂监听，WATCH_OUTSIDE_TOUCH 就形同虚设 —— 窗口收到了事件却没人处理。
    root.setOnTouchListener { _, ev ->
      if (ev.actionMasked == MotionEvent.ACTION_OUTSIDE) {
        onInputOutside(ev)
        true
      } else {
        false
      }
    }
    root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
      main.removeCallbacks(syncAttachedChips)
      main.post(syncAttachedChips)
    }
    root.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(v: View) {
        chipObserver = root.viewTreeObserver.also { observer ->
          chipLayout = android.view.ViewTreeObserver.OnGlobalLayoutListener { syncChipWindows() }
          chipPreDraw = android.view.ViewTreeObserver.OnPreDrawListener {
            syncChipWindows()
            true
          }
          observer.addOnGlobalLayoutListener(chipLayout)
          observer.addOnPreDrawListener(chipPreDraw)
        }
      }

      override fun onViewDetachedFromWindow(v: View) {
        val observer = chipObserver
        if (observer != null && observer.isAlive) {
          // 解绑必须按「注册时用的同一个实例」逐个摘：留一个活的 OnPreDrawListener
          // 会让每帧都调一次 syncChipWindows，窗口已经拆了还在算坐标。
          if (chipLayout != null) observer.removeOnGlobalLayoutListener(chipLayout)
          if (chipPreDraw != null) observer.removeOnPreDrawListener(chipPreDraw)
        }
        chipObserver = null
        chipLayout = null
        chipPreDraw = null
        root.removeCallbacks(syncAttachedChips)
      }
    })
    return c
  }


  /**
   * 展开输入区。视图与监听只在 ensureComposerView 里建一次，这里只负责挂窗与渲染。
   *
   * 焦点必须带双重守卫：composerWindowGeneration 挡住「旧窗口的延迟 focus」落到新窗口上，
   * attachmentInteraction 挡住「取件期间抢焦点」—— 取件回来时系统会自己恢复输入法，
   * 我们再主动 focus 一次就会把键盘顶起来又立刻被收回，用户看到的是闪一下。
   */
  internal fun showComposer(focusInput: Boolean) {
    if (destroyed) return
    val c = ensureComposerView()
    val s = screen()
    if (!composerVisible()) {
      val lp = WindowManager.LayoutParams(
        OverlayWindowFrames.composerWidthPx(s), ViewGroup.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        // 可聚焦才能弹输入法；NOT_TOUCH_MODAL：输入区以外的触摸照常穿透到底层应用。
        // WATCH_OUTSIDE_TOUCH 是 outside 语义的前提 —— 没有它窗口根本收不到 ACTION_OUTSIDE，
        // 「点空白收输入区」就永远不会发生（用户会以为点哪都没反应）。
        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
          WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
        PixelFormat.TRANSLUCENT,
      ).apply {
        gravity = Gravity.BOTTOM or Gravity.START
        // 键盘原生顶起：沿用旧面板已验证的 ADJUST_PAN（自己监听 IME insets 的方案已废，design.md §8.2）。
        softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN
        x = (OverlayWindowFrames.COMPOSER_SIDE_MARGIN_DP * s.density).toInt()
        y = OverlayWindowFrames.composerBottomPx(s)
      }
      composerParams = lp
      renderComposer()
      if (!windows.add(OverlayWindows.Slot.COMPOSER, c.view, lp)) {
        composerParams = null
        toast(t("输入区创建失败", "Could not create the input area"))
        return
      }
      // 窗口一 addView 就整块可见：不补一次淡入，用户看到的是"啪一下出现"，
      // 和卡片逐行淡入、sheet 淡入上抬的观感完全不统一。
      c.fadeComposerIn()
    } else {
      renderComposer()
    }
    // 重建过程中不要再推进代次：重建自己会重新挂窗，这里的代次只服务于「旧窗口的延迟 focus」。
    if (!recreatingViews) composerWindowGeneration++
    val focusGeneration = composerWindowGeneration
    refreshPageState()
    refreshCommands()
    val canFocus = {
      composer === c && composerVisible() &&
        composerWindowGeneration == focusGeneration &&
        !destroyed && !uiSuspended && !hostForeground && !composerClosing && attachmentInteraction == null
    }
    if (focusInput) main.post { if (canFocus()) c.focusInput(canFocus) }
    else if (canFocus()) c.focusRoot()
    syncChipWindows()
  }


  /** 立刻收输入窗（不走动画）：界面即将整体重建时用。 */
  private fun hideComposerImmediate() {
    composerClosing = false
    drawerClosing = false
    hideDrawer(false)
    hideChipWindows()
    if (!composerVisible()) return
    composer?.view?.clearFocus()
    windows.remove(OverlayWindows.Slot.COMPOSER)
    composerParams = null
    drawerMode = DrawerMode.NONE
  }

  internal fun hideComposer() {
    if (!composerVisible()) return
    if (composerClosing) return
    val c = composer
    try {
      c?.view?.clearFocus()
    } catch (_: Throwable) {
    }
    // 先收 sheet（不带动画：输入区都要走了，sheet 还慢慢淡出会很怪）。
    hideDrawer(false)
    hideChipWindows()
    // 主动收输入法：窗口移除后 IME 有时会留在屏上，用户会看到一块空键盘。
    val imm = svc.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as? android.view.inputmethod.InputMethodManager
    imm?.hideSoftInputFromWindow(c?.view?.windowToken, 0)
    drawerMode = DrawerMode.NONE
    // 窗口直接 remove 是硬切；走一次淡出下沉再移除，观感才和其余浮层一致。
    // 代次护栏：淡出期间用户可能又点开输入区，迟到的旧回调不得移除新窗口。
    val generation = ++composerWindowGeneration
    composerClosing = true
    val finish = {
      if (generation == composerWindowGeneration) {
        composerClosing = false
        windows.remove(OverlayWindows.Slot.COMPOSER)
        composerParams = null
        // 输入窗收掉后就不再需要跟着页面状态刷新了：不停观察会留一个空转的轮询。
        updatePageWatching()
      }
    }
    if (c == null) {
      finish()
      return
    }
    c.fadeComposerOut(finish)
  }

  private fun refreshComposerWindowHeight() {
    // wrap_content 窗口由系统按内容重排；这里只在抽屉状态变化后重算一次窗口高度，
    // 避免「抽屉展开后窗口高度还是旧值」把内容裁掉（ADJUST_PAN 只管键盘，不管内容变化）。
    val lp = composerParams ?: return
    val c = composer ?: return
    val s = screen()
    val h = c.view.measuredHeight
    if (h <= 0) return
    if (lp.height != h) {
      lp.height = ViewGroup.LayoutParams.WRAP_CONTENT
      lp.width = OverlayWindowFrames.composerWidthPx(s)
      windows.update(OverlayWindows.Slot.COMPOSER, lp)
    }
  }

  /** 发送在飞标记：迟到的发送回执不得清掉用户新输入的内容（见 sendText 的守卫）。 */
  private var sending = false

  /**
   * 发送输入框内容。
   *
   * 三条纪律（每一条都有对应的负控用例，删掉就会静默丢草稿）：
   * 1) 清空输入框必须过「迟到回执」守卫：只允许在 ok、会话没换、代次没变、且输入框内容
   *    仍是当初那一份时才清 —— 否则用户在等待期间补的字会被一并抹掉。
   * 2) 新建会话时先迁移草稿再让观察者接手（}, { created -> 回调里记录 createdDraftMigration），
   *    这样 onSessionChanged 才能把 A 的草稿带到新建的 A 上，而不是被 B 的旧草稿覆盖。
   * 3) 结果未知（UNKNOWN）时既不清空也不回填：此时没有任何证据说明消息已受理。
   */
  private fun sendText(text: String) {
    val trimmed = text.trim()
    val sentSession = svc.activeSessionId
    var admittedSession = sentSession
    // 纯附件消息允许空文本：只要页面草稿里认领到了附件，就不该被「空文本」拦掉。
    val attachments = pageState?.takeIf { it.sessionId == sentSession }?.attachments ?: emptyList()
    if (trimmed.isEmpty() && attachments.isEmpty()) return
    val sentDraft = composer?.inputText().orEmpty()
    val sentGeneration = sessionGeneration
    // 附件还在认领中：此时页面草稿里还没有这条附件，直接发会把它静默丢掉。
    // 让用户等一下，并把认领重新催一遍（页面认领有轮询延迟）。
    val attachmentsPending = OverlayAttachmentBus.pending(sentSession)
    if (attachmentsPending.isNotEmpty()) {
      OverlayAttachmentBus.recheckPending(sentSession)
      svc.flashStatus(t("附件仍在认领中，请稍后", "Attachment still being claimed"))
      return
    }
    // 页面不可用时不能把「带附件的消息」降级成纯文本发出去：附件留在草稿里，
    // 用户会以为发出去了，实际只发了一句话。
    if (!OverlayPageHost.available()) {
      if (attachments.isNotEmpty()) {
        svc.flashStatus(t("请回主界面发送附件", "Send attachments in the main app"))
        return
      }
    }
    // 所有「这条能不能发」的判定都过了才进入在飞状态：先标记再校验，用户会看到
    // 发送按钮闪一下又弹回来。
    sending = true
    // 清空守卫只在「这条确实发出去了」之后才有意义，所以它定义在准入判定之后：
    // 每一项都对应一种会吞掉用户输入的真实情形 —— 界面已销毁、结果是否决、会话已被换掉、
    // 代次已推进（有新的会话/发送事件）、或输入框内容已被用户改写。
    val settled: (Boolean) -> Unit = { ok ->
      if (!destroyed && ok && svc.activeSessionId == admittedSession && sessionGeneration == admittedGeneration && composer?.inputText() == sentDraft) {
        composer?.setInputText("")
      }
    }
    // 页面草稿只属于它自己的会话：切走之后不能拿旧页面的附件去提交新会话的消息。
    if (attachments.isNotEmpty() && OverlayPageHost.available()) {
      // 附件在页面草稿里（file-incoming 管线由页面认领），所以整条消息也必须由页面提交，
      // 否则附件会被留在草稿里发不出去（design.md §8.3 的附件口径）。
      OverlayPageHost.send(trimmed, sentSession) { ok ->
        sending = false
        settled(ok)
        if (ok) {
          svc.markBusyOptimistic()
          refreshPageState()
        } else {
          // 页面侧失败时用壳侧接口复核一次：可能消息其实已受理，只是页面回执丢了。
          svc.recheckTextSendOutcome()
          svc.flashStatus(t("发送失败，请在主界面重试", "Send failed; retry in the main app"))
        }
      }
      return
    }
    svc.sendTextFromOverlay(trimmed, settled, { message ->
      // 结果未知：保留草稿，只提示；不触发清空/回填。
      svc.flashStatus(message)
    }, { created ->
      // 引擎为这条消息新建了会话。只有「同一条在飞发送、且当前没有别的会话被选中」时才迁移：
      // 用户若已在等待期间切到 B，把 A 的草稿写过去就是一次静默的串台。
      if (!destroyed && sentSession.isEmpty() && svc.activeSessionId.isEmpty() && sessionGeneration == sentGeneration) {
        createdDraftMigration = exportDraftSnapshot().copy(sessionId = created)
        admittedSession = created
        admittedGeneration = sentGeneration + 1
      }
    })
  }

  /**
   * 起系统取件（相机/相册/文件）。
   *
   * 同窗保稿的关键纪律：取件期间**只让出触摸权**（yieldInteraction 把 flags 降级、alpha 压低），
   * 绝不 hide/remove 任何窗口，也绝不碰输入框文本与选区 —— 一旦移除输入窗，系统会连带回收
   * 输入法会话，用户回来时草稿和光标就没了。
   */
  private fun startAttachment(kind: String) {
    val mapped = when (kind) {
      "camera" -> OverlayAttachProxyActivity.KIND_CAMERA
      "photo" -> OverlayAttachProxyActivity.KIND_PHOTO
      else -> OverlayAttachProxyActivity.KIND_FILE
    }
    val sid = svc.activeSessionId
    if (sid.isEmpty()) {
      toast(t("会话尚未就绪，请稍后再试", "Session not ready, try again"))
      return
    }
    val requestId = java.util.UUID.randomUUID().toString()
    // 登记必须早于 Activity 启动：同步失败路径也会带着这个 id 回执。
    attachmentRequestIds.getOrPut(sid) { LinkedHashSet() }.add(requestId)
    if (!prepareAttachmentUi(sid, mapped, requestId)) return
    OverlayAttachProxyActivity.start(svc, mapped, sid, requestId)
  }

  /**
   * 取件前的准入：把触摸权让给系统取件界面。
   *
   * 返回 false 表示「现在不能起取件」，调用方必须直接 return —— 此时还没有租约，
   * 也没有任何窗口被动过，用户看到的界面保持原样。
   */
  private fun prepareAttachmentUi(sessionId: String, kind: String, requestId: String): Boolean {
    if (destroyed) return false
    // 任何在飞的过渡都必须先把界面稳定下来再起取件。
    if (cardHandleDragging || morphAnimator?.isRunning == true || drawerClosing || composerClosing) {
      toast(t("界面正在切换，请稍后再试", "Still animating, try again"))
      return false
    }
    val lease = windows.yieldInteraction() ?: return false
    attachmentInteraction = lease
    attachmentInteractionSession = sessionId
    attachmentInteractionRequestId = requestId
    return true
  }

  /**
   * 取件回执回来后的恢复。只认「精确 requestId」，恢复失败时保留租约供有限次重试。
   */
  private fun restoreAttachmentInteraction(sessionId: String, requestId: String) {
    val lease = attachmentInteraction ?: return
    if (attachmentInteractionSession != sessionId) return
    if (attachmentInteractionRequestId != requestId) return
    if (!windows.restoreInteraction(lease)) {
      // 恢复失败：保留原租约与 id，等下一轮有限重试；此时绝不能先清空，否则窗口永远停在
      // NOT_TOUCHABLE 的降级态，用户点哪都没反应。
      if (attachmentRestoreAttempts++ < ATTACHMENT_RESTORE_MAX_ATTEMPTS) {
        main.postDelayed({
          if (!destroyed) restoreAttachmentInteraction(sessionId, requestId)
        }, ATTACHMENT_RESTORE_RETRY_MS)
      }
      return
    }
    attachmentInteraction = null
    attachmentInteractionSession = ""
    attachmentInteractionRequestId = ""
    attachmentRestoreAttempts = 0
    attachmentRequestIds[sessionId]?.remove(requestId)
    if (attachmentRequestIds[sessionId].isNullOrEmpty()) attachmentRequestIds.remove(sessionId)
  }

  /**
   * 取件回执的统一入口：先按「精确 requestId」恢复触摸租约，再决定是否宣布成功。
   *
   * 顺序纪律（两条都不可交换）：
   * 1) restoreAttachmentInteraction 必须早于 sessionId 比对 —— 用户在取件期间切了会话时，
   *    原窗口仍带着临时的 NOT_TOUCHABLE/低 alpha，不先还原就会永久卡住「点哪都没反应」。
   * 2) requestId 归属校验必须早于 onAttachmentResult —— 迟到的旧回执不能弹「已添加」的
   *    提示，也不能触发页面刷新去认领一张不属于当前请求的图。
   */
  private fun onAttachmentReceipt(receipt: OverlayAttachmentBus.Receipt) {
    restoreAttachmentInteraction(receipt.sessionId, receipt.requestId)
    if (receipt.sessionId != svc.activeSessionId) return
    val ids = attachmentRequestIds[receipt.sessionId].orEmpty()
    if (receipt.requestId !in ids) return
    onAttachmentResult(receipt.kind, receipt.path, receipt.error)
  }

  private fun onAttachmentResult(kind: String, path: String, error: String) {
    if (error.isEmpty()) {
      toast(t("附件已添加", "Attachment added"))
      // 页面草稿认领来件有轮询延迟（4s 周期）：两次刷新覆盖「立刻」和「接近一个周期」。
      refreshPageState()
      main.postDelayed({ refreshPageState() }, 1200)
      main.postDelayed({ refreshPageState() }, 4200)
    } else {
      val message = when (error) {
        "attachment-pending" -> t("附件仍在认领中，请稍后", "Attachment still being claimed")
        "permission-denied" -> t("未授予相机权限", "Camera permission denied")
        "camera-unavailable" -> t("未找到可用的相机", "No camera app available")
        "camera-busy" -> t("相机被占用，请稍后重试", "Camera is busy; try again")
        "compress-failed" -> t("照片处理失败，原图已保留", "Photo processing failed; the original is kept")
        "copy-failed" -> t("文件读取失败", "Could not read the file")
        "cancelled" -> t("已取消", "Cancelled")
        else -> t("附件添加失败", "Could not add the attachment")
      }
      toast(message)
    }
  }

  private fun removeAttachment(index: Int) {
    if (!OverlayPageHost.available()) {
      toast(t("仅供主界面管理附件", "Manage attachments in the main app"))
      return
    }
    val ids = (pageState?.attachments ?: emptyList()).map { it.id }
    if (index !in ids.indices) return
    OverlayPageHost.removeAttachment(ids[index]) { ok ->
      if (ok) refreshPageState() else svc.flashStatus(t("删除附件失败", "Could not remove the attachment"))
    }
  }


  /** 「＋」切换抽屉：命令 → 会话 → 工作区 → 收起，循环一格。 */
  private fun toggleDrawer() {
    if (!composerVisible()) return
    when (drawerMode) {
      DrawerMode.NONE -> {
        drawerMode = DrawerMode.COMMANDS
        refreshCommands()
        renderComposer()
        refreshComposerWindowHeight()
        // 只改 drawerMode 不会让 sheet 出现：sheet 是独立窗口，必须显式同步一次。
        syncDrawerWindow()
      }
      DrawerMode.COMMANDS -> openSessionPicker()
      DrawerMode.SESSIONS -> openWorkspacePicker()
      DrawerMode.WORKSPACES -> {
        drawerMode = DrawerMode.NONE
        renderComposer()
        refreshComposerWindowHeight()
        hideDrawer(true)
      }
    }
  }

  /** 返回键三段式：先收抽屉，再收输入窗；不发送、不停止后台任务。 */
  private fun onComposerBackPressed() {
    // 答题态下按返回 = 放弃回答：把进入前留档的消息草稿还回去，不能吞掉用户写了一半的话。
    if (messageDraftBeforeAnswer != null) {
      leaveQuestionAnswer(false)
      return
    }
    if (drawerMode != DrawerMode.NONE) {
      drawerMode = DrawerMode.NONE
      renderComposer()
      refreshComposerWindowHeight()
      return
    }
    hideComposer()
  }

  /**
   * 把工作区/会话两个 chip 摆到输入药丸正上方的独立窗口里。
   *
   * 为什么 chips 住在自己的窗口而不是 composer 的子视图：composer 是 wrap_content，
   * 键盘弹起时整体上移，子视图会跟着走；chip 需要贴着药丸上沿独立定位，且取件期间要让出
   * 触摸权（窗口级 flags），这两件事只有独立窗口能做到。
   *
   * 取件租约非空时直接返回：此时窗口被降级成 NOT_TOUCHABLE，任何 add/update 都会破坏
   * 租约的原子性，回来时 restoreInteraction 就无法把 flags 还原成用户看到的样子。
   */
  private fun syncChipWindows() {
    if (attachmentInteraction != null) return
    val c = composer ?: return
    if (!composerVisible() || !c.chipsVisible() || !c.view.isAttachedToWindow) {
      hideChipWindows()
      return
    }
    val s = screen()
    val sizes = c.chipSizesPx(OverlayWindowFrames.composerWidthPx(s))
    val location = IntArray(2)
    c.view.getLocationOnScreen(location)
    // 物理 top 由「输入窗实际屏幕坐标」推出来，不用状态栏高度推算：状态栏隐藏/显示时
    // 后者会让 chip 跳一下，前者始终贴着药丸走。
    val top = (location[1] - sizes.first.second - c.chipGapPx).coerceAtLeast(0)
    fun place(slot: OverlayWindows.Slot, view: View, size: Pair<Int, Int>, x: Int) {
      val actual = IntArray(2)
      view.getLocationOnScreen(actual)
      val old = windows.params(slot)
      // 早退必须同时比对「请求值」与「WMS 实际落位 + View 渲染尺寸」：只看请求值会在系统
      // 夹取坐标或转屏后被骗过去，chip 就停在旧位置。
      if (old != null && old.x == x && old.y == top && old.width == size.first && old.height == size.second &&
        actual[0] == x && actual[1] == top && view.width == size.first && view.height == size.second) return
      val lp = old ?: WindowManager.LayoutParams(
        size.first, size.second,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
        PixelFormat.TRANSLUCENT,
      ).apply { gravity = Gravity.TOP or Gravity.START }
      lp.width = size.first
      lp.height = size.second
      lp.x = x
      lp.y = top;
      if (old == null) {
        (view.parent as? android.view.ViewGroup)?.removeView(view)
        windows.add(slot, view, lp)
      } else {
        windows.update(slot, lp)
      }
    }
    place(OverlayWindows.Slot.WORKSPACE, c.workspaceView, sizes.first, location[0])
    place(OverlayWindows.Slot.SESSION, c.sessionView, sizes.second, location[0] + sizes.first.first + c.chipGapPx)
  }

  /**
   * 把底部 sheet 摆成一个独立窗口（Slot.DRAWER），覆盖在输入区上方。
   *
   * 用户基线原文：「＋打开独立底部sheet，覆盖其它app及input，input原位置/尺寸不变」。
   * 因此这里绝不碰 composerParams、不做 translationY、不 MATCH_PARENT 撑高输入区。
   *
   * drawerWindowGeneration 是「迟到关闭回调」的护栏：每次开/关都自增，回调只在自己那一代
   * 仍然是最新时才真正 remove，否则会把用户刚重新打开的 sheet 误收掉。
   */
  private fun syncDrawerWindow() {
    val c = composer ?: return
    if (drawerClosing) { c.fadeDrawerIn(); drawerClosing = false }
    // 代次只在「真的新建 sheet 窗口」时推进。无条件自增会让正在收起的动画失效 ——
    // 任何一次几何同步（转屏、键盘高度变化、chip 重排）都会把 remove 回调变成空操作，
    // sheet 就永远留在屏上，用户点空白也关不掉。
    val screen = screen()
    c.setMaxDrawerHeightPx((OverlayWindowFrames.availableHeightPx(screen) * .4f).toInt())
    // sheet 必须把「输入区 + chip 行」整块盖住，否则用户会看到输入框从 sheet 底下露出来。
    // coverBottomControls 用输入窗实际高度加 chip 行高与间距，再加 24dp 视觉余量。
    val coverBottomControls = c.view.height + c.chipSizesPx(
      OverlayWindowFrames.composerWidthPx(screen),
    ).first.second + c.chipGapPx + (24f * screen.density).toInt()
    // 选择器模式（会话/工作区）是"气泡"：宽度贴着被点的 chip，不铺满整行。
    // 命令/附件仍用原来的通栏 sheet —— 那里是三个并排瓦片加命令列表，缩窄反而放不下。
    val picker = drawerMode == DrawerMode.SESSIONS || drawerMode == DrawerMode.WORKSPACES
    c.setPickerMode(picker)
    // 选择器是浮起的气泡（四角全圆、离底有间隙）；命令/附件仍是接底通栏（只圆上两角）。
    c.setDrawerFloating(picker)
    // 选择器是"向上浮起的气泡"：高度按内容收紧，不撑到盖住输入区，底部留出间隙。
    // 命令/附件才需要 coverBottomControls 去盖住输入区（它们是从输入行长出来的通栏）。
    val h = if (picker) {
      c.measureDrawerHeightPx(bubbleWidthPx(screen))
        .coerceIn(1, (OverlayWindowFrames.availableHeightPx(screen) * .4f).toInt().coerceAtLeast(1))
    } else {
      maxOf(c.measureDrawerHeightPx(OverlayWindowFrames.composerWidthPx(screen)), coverBottomControls)
        .coerceIn(1, (OverlayWindowFrames.availableHeightPx(screen) * .4f).toInt().coerceAtLeast(1))
    }
    if (h <= 0) return
    val lp = drawerParams ?: WindowManager.LayoutParams(
      OverlayWindowFrames.composerWidthPx(screen), h,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      // sheet 盖在输入区之上时，composer 收不到它上方区域的 outside；
      // sheet 自己必须也监听 outside，否则「有 sheet 时点空白收 sheet」永远不会发生。
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
        WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.BOTTOM or Gravity.START
      softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
      x = (OverlayWindowFrames.COMPOSER_SIDE_MARGIN_DP * screen.density).toInt()
      y = screen.navBarPx
    }
    drawerParams = lp
    lp.width = OverlayWindowFrames.composerWidthPx(screen)
    lp.height = h
    lp.x = (OverlayWindowFrames.COMPOSER_SIDE_MARGIN_DP * screen.density).toInt()
    lp.y = screen.navBarPx
    if (picker) {
      val margin = (OverlayWindowFrames.COMPOSER_SIDE_MARGIN_DP * screen.density).toInt()
      val rightLimit = screen.widthPx - margin
      val bubbleWidth = bubbleWidthPx(screen)
      lp.width = bubbleWidth
      lp.x = bubbleAnchorX(screen, bubbleWidth).coerceIn(margin, (rightLimit - bubbleWidth).coerceAtLeast(margin))
      // 关键 1：气泡不能贴底。贴底就是"接地的 sheet"，用户要的是"向上飘起"。
      // 关键 2：改成 gravity=TOP 才能用绝对 y。带 gravity=BOTTOM 时 y 是从底边数的，
      // 直接把"从顶边算的 chipRowTop-h-gap"塞进去，窗口会被算到屏幕最上方（实测 y=1330
      // 变成了距顶 165px 的顶部气泡）。
      lp.gravity = Gravity.TOP or Gravity.START
      val location = IntArray(2)
      c.view.getLocationOnScreen(location)
      val chipRowTop = location[1] - c.chipSizesPx(OverlayWindowFrames.composerWidthPx(screen)).first.second
      val gapPx = (10f * screen.density).toInt()
      lp.y = (chipRowTop - h - gapPx).coerceAtLeast(margin)
    } else {
      lp.gravity = Gravity.BOTTOM or Gravity.START
      lp.y = screen.navBarPx
    }
    // sheet 是独立窗口，它自己也要把 outside 转给同一处处理逻辑：
    // 盖住输入区之后，屏幕中部/上方的空白点击只会发给 sheet（composer 收不到）。
    // 每次都重设 listener：drawerView 实例会被反复复用，只在首次挂会在重开后失效。
    c.drawerView.setOnTouchListener { _, ev ->
      if (ev.actionMasked == MotionEvent.ACTION_OUTSIDE) {
        onInputOutside(ev)
        true
      } else {
        false
      }
    }
    if (windows.params(OverlayWindows.Slot.DRAWER) == null) {
      drawerWindowGeneration++
      val parent = c.drawerView.parent as? android.view.ViewGroup
      parent?.removeView(c.drawerView)
      windows.add(OverlayWindows.Slot.DRAWER, c.drawerView, lp)
    } else {
      windows.update(OverlayWindows.Slot.DRAWER, lp)
    }
  }

  /**
   * 选择器气泡的宽度：贴着被点的 chip，但至少 240dp，且不超出输入区右界。
   *
   * 为什么不对齐到屏幕中：气泡盖住它自己的锚点会让用户看不出"这是从哪打开的"。
   */
  private fun bubbleWidthPx(screen: OverlayScreen): Int {
    val c = composer ?: return (240f * screen.density).toInt()
    val margin = (OverlayWindowFrames.COMPOSER_SIDE_MARGIN_DP * screen.density).toInt()
    val sizes = c.chipSizesPx(OverlayWindowFrames.composerWidthPx(screen))
    val chipWidth = if (drawerMode == DrawerMode.WORKSPACES) sizes.first.first else sizes.second.first
    val minBubble = (240f * screen.density).toInt()
    return maxOf(minBubble, chipWidth).coerceAtMost(screen.widthPx - 2 * margin)
  }

  /** 气泡左边界：对齐被点的那个 chip 的左边缘。 */
  private fun bubbleAnchorX(screen: OverlayScreen, bubbleWidth: Int): Int {
    val c = composer ?: return (OverlayWindowFrames.COMPOSER_SIDE_MARGIN_DP * screen.density).toInt()
    val location = IntArray(2)
    c.view.getLocationOnScreen(location)
    val margin = (OverlayWindowFrames.COMPOSER_SIDE_MARGIN_DP * screen.density).toInt()
    return if (drawerMode == DrawerMode.WORKSPACES) {
      location[0] + margin
    } else {
      val sizes = c.chipSizesPx(OverlayWindowFrames.composerWidthPx(screen))
      location[0] + margin + sizes.first.first + c.chipGapPx
    }
  }

  /** 收起 sheet；带代次护栏，迟到的旧回调不得移除刚重开的那一个。 */
  private fun hideDrawer(animated: Boolean) {
    val c = composer ?: return
    if (animated && drawerClosing) return
    val generation = ++drawerWindowGeneration
    val remove = {
      // 代次护栏：关闭动画期间用户可能又打开了 sheet，迟到的旧回调不得移除那一个新的。
      if (generation == drawerWindowGeneration) {
        windows.remove(OverlayWindows.Slot.DRAWER)
        drawerParams = null
        drawerClosing = false
      }
    }
    if (!animated || !c.isDrawerOpen()) { remove(); return }
    drawerClosing = true
    c.animateDrawerOut(remove)
  }


  private var drawerParams: WindowManager.LayoutParams? = null
  private var lastComposerMeasuredHeight = 0


  /** 收起两个 chip 窗口（幂等）。 */
  private fun hideChipWindows() {
    windows.remove(OverlayWindows.Slot.WORKSPACE)
    windows.remove(OverlayWindows.Slot.SESSION)
  }


  // ── 卡片形变（白条下拉 → 长胶囊）────────────────────────────────────

  /**
   * 按 progress 把卡片画成「卡片 ↔ 长胶囊」的中间态。
   *
   * 为什么用同一条 progress 驱动全部视觉（圆角/内边距/透明度/文字淡出）：
   * 分开计时会出现「圆角已经到了、文字还在」的错帧，用户看到的是抖动而非形变。
   */
  private fun applyCardMorph(progress: Float) {
    morphProgress = progress.coerceIn(0f, 1f)
    val pm = OverlayUiModel.pillOf(model, UiText.isEnglish(svc))
    val color = androidx.core.content.ContextCompat.getColor(svc, when (pm.tone) {
      OverlayTone.ERROR -> R.color.ds_danger
      OverlayTone.WAITING -> R.color.ds_warn
      OverlayTone.WORKING -> R.color.ds_accent
      else -> R.color.ds_text_secondary
    })
    card?.let { c ->
      c.applyMorph(morphProgress, (OverlayWindowFrames.PILL_HEIGHT_DP * screen().density).toInt(), capsuleText(), color)
      if (morphProgress > 0f && !c.updateMorphTouchableRegion()) yieldMorphTouch()
    }
  }

  /**
   * 松手后把形变收尾到目标态（collapse=true 收成长胶囊，false 弹回卡片）。
   *
   * generation 护栏：形变途中用户可能又按下/反悔，旧动画的 onEnd 不得作用到新一轮手势上。
   */
  private fun settleCardMorph(collapse: Boolean) {
    val owner = card ?: return
    val generation = ++morphGeneration
    morphAnimator?.cancel(); morphAnimator = null
    val target = if (collapse) 1f else 0f
    val finish = {
      if (generation == morphGeneration && card === owner && !destroyed && !uiSuspended && !recreatingViews && cardVisible()) {
        applyCardMorph(target)
        cardHandleDragging = false
        cardGestureMotion = null
        if (collapse) collapseToPill() else { card?.resetMorph(); restoreMorphTouch() }
      }
    }
    if (!DSUiAnimationsEnabled() || morphProgress == target) { finish(); return }
    val animation = android.animation.ValueAnimator.ofFloat(morphProgress, target)
    morphAnimator = animation
    animation.duration = if (collapse) 180L else 240L
    animation.interpolator = DsUi.ease
    animation.addUpdateListener { if (generation == morphGeneration && card === owner && !uiSuspended && !recreatingViews) applyCardMorph(it.animatedValue as Float) }
    animation.addListener(object : android.animation.AnimatorListenerAdapter() {
      override fun onAnimationEnd(animation: android.animation.Animator) { finish() }
    })
    animation.start()
  }

  /** 形变到长胶囊时让出触摸：此时卡片窗口只剩一条胶囊，不该再吞下方手势。 */
  private fun yieldMorphTouch() {
    val lp = cardParams ?: return
    if (morphInteractionFlags != null) return
    morphInteractionFlags = lp.flags
    morphInteractionAlpha = lp.alpha
    lp.flags = lp.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
    lp.alpha = minOf(lp.alpha, .15f)
    windows.update(OverlayWindows.Slot.CARD, lp)
  }

  /** 形变回卡片时还原触摸。 */
  private fun restoreMorphTouch() {
    val lp = cardParams ?: return
    val flags = morphInteractionFlags ?: return
    lp.flags = flags; lp.alpha = morphInteractionAlpha
    morphInteractionFlags = null
    morphInteractionAlpha = 1f
    windows.update(OverlayWindows.Slot.CARD, lp)
  }

  /** 取消进行中的形变（用户取消/界面重建/销毁），并把代次推进以废弃旧回调。 */
  /**
   * 取消进行中的形变：先把代次推进，再 cancel 动画。
   *
   * 顺序不可换 —— Animator.cancel() 会**同步**派发 onAnimationEnd，如果先 cancel 后增代次，
   * 那个同步回调看到的仍是旧代次，会把刚被取消的形变收尾动作再执行一遍（卡片闪一下）。
   */
  private fun cancelCardInteraction() {
    morphGeneration++
    morphAnimator?.cancel(); morphAnimator = null
    handleHoldFeedback?.let { main.removeCallbacks(it) }
    handleHoldFeedback = null
    cardHandleIntent.cancel()
    cardHandleDragging = false
    cardGestureMotion = null
    morphProgress = 0f
    card?.resetMorph()
    restoreMorphTouch()
  }

  /**
   * 把白条/手柄的视觉复位到「未按住」态。
   *
   * 与 cancelCardInteraction 分开：前者管形变状态机与窗口 flags，这里只管像素表现。
   * 合在一起会让「只想清掉按压高亮」的调用路径也去动窗口 flags，出现触摸权莫名丢失。
   */
  private fun resetCardHandleVisual() {
    cardHandleIntent.cancel()
    card?.let { c ->
      c.resetMorph()
      c.setHandleOffsetPx(0f)
    }
  }

  /** 长胶囊上滚动的文案：取模型里的最新一行，避免长任务时胶囊空着。 */
  private fun capsuleText(): String {
    val pm = OverlayUiModel.pillOf(model, UiText.isEnglish(svc))
    return pm.text
  }

  // ── 抽屉：命令 / 会话 / 工作区 ──────────────────────────────────────────

  private fun onDrawerPick(name: String) {
    when (drawerMode) {
      DrawerMode.SESSIONS -> {
        drawerMode = DrawerMode.NONE
        if (OverlayPageHost.available()) {
          OverlayPageHost.openSession(name) { ok ->
            if (ok) {
              svc.onTargetSessionChanged(name)
              refreshPageState()
            } else {
              svc.flashStatus(t("切换会话失败", "Could not switch session"))
            }
          }
        } else {
          svc.setTargetSession(name)
          refreshPageState()
        }
      }
      DrawerMode.WORKSPACES -> {
        drawerMode = DrawerMode.NONE
        svc.targetWorkspaceIdOverride = name
        refreshPageState()
        svc.flashStatus(t("新会话将使用该工作区", "New sessions will use this workspace"))
      }
      else -> {
        // 命令：走页面真源执行（不硬编码任何命令清单）
        if (OverlayPageHost.available()) {
          OverlayPageHost.execute(name) { ok ->
            if (ok) toast(t("已执行", "Command sent")) else svc.flashStatus(t("命令执行失败", "Command failed"))
          }
        } else {
          toast(t("命令需要主界面在线", "Commands need the main app"))
        }
      }
    }
    renderComposer()
  }

  private fun openSessionPicker() {
    drawerMode = DrawerMode.SESSIONS
    renderComposer()
    syncDrawerWindow()
    // 会话列表复用页面 state 的 workspaces/session 字段不够（只有当前会话），
    // 这里走 page host 的会话列表（页面真源）；页面不可用时退回 RPC session/list。
    if (OverlayPageHost.available()) {
      OverlayPageHost.sessions { list ->
        sessionChoices = list
        renderComposer()
      }
    } else {
      fetchSessionsFromRpc()
    }
  }

  private var sessionChoices: List<OverlayPageHost.PageSession> = emptyList()

  private fun fetchSessionsFromRpc() {
    svc.postRpc("session/list", JSONObject().put("_request", JSONObject())) { code, body ->
      val out = ArrayList<OverlayPageHost.PageSession>()
      if (code == 200) {
        try {
          val items = JSONObject(body).optJSONObject("result")?.let { r ->
            when (val v = r.opt("value")) {
              is JSONObject -> v.optJSONArray("items")
              is String -> JSONObject(v).optJSONArray("items")
              else -> null
            }
          }
          if (items != null) {
            for (i in 0 until items.length()) {
              val it = items.optJSONObject(i) ?: continue
              val sid = it.optString("sessionId", "")
              if (sid.isEmpty()) continue
              val titleObj = it.optJSONObject("projections")?.optJSONObject("values")?.opt("title")
              val title = if (titleObj == null || titleObj === JSONObject.NULL) "" else titleObj.toString()
              out.add(OverlayPageHost.PageSession(sid, title.ifBlank { sid.take(8) }))
            }
          }
        } catch (_: Throwable) {
        }
      }
      sessionChoices = out
      renderComposer()
    }
  }

  private fun openWorkspacePicker() {
    drawerMode = DrawerMode.WORKSPACES
    if (pageState?.workspaces.isNullOrEmpty()) refreshPageState()
    renderComposer()
    syncDrawerWindow()
  }

  // ── 数据接入 ────────────────────────────────────────────────────────────

  /** live 流事件（tool_call/tool_result/text/think/turn_end）。 */
  internal fun onLiveEvent(event: LiveEvent) {
    if (destroyed) return
    val at = event.atMs
    val sessionMatches = svc.activeSessionId.isEmpty() || event.sessionId.isEmpty() || event.sessionId == svc.activeSessionId
    if (!sessionMatches) return
    model = when (event.kind) {
      LiveEvent.KIND_TOOL_CALL -> {
        lastSessionRowId++
        val id = if (event.callId.isNotEmpty()) event.callId else "row-" + lastSessionRowId
        OverlayUiModel.onToolCall(model, id, event.name, event.summary, at)
      }
      LiveEvent.KIND_TOOL_RESULT -> {
        val id = if (event.callId.isNotEmpty()) event.callId else model.toolRows.lastOrNull { it.running }?.callId ?: ""
        if (id.isEmpty()) model else OverlayUiModel.onToolResult(model, id, at)
      }
      LiveEvent.KIND_THINK -> OverlayUiModel.onThink(model, event.text, at)
      LiveEvent.KIND_TEXT -> OverlayUiModel.onText(model, event.text, at)
      LiveEvent.KIND_TURN_END -> OverlayUiModel.onTurnEnd(model, event.turnKind, at, UiText.isEnglish(svc))
      else -> model
    }
    scheduleRender()
  }

  internal fun onAgentStatus(agentId: String, running: Boolean) {
    if (destroyed) return
    // 运行结束不等于用户关闭记录：这里只更新状态、停时钟，绝不 hideCard/collapse/remove，
    // 否则一次任务跑完，用户正在读的转录就整块消失了。
    model = OverlayUiModel.onRuntimeStatus(model, running, System.currentTimeMillis())
    if (running) startClockIfNeeded() else stopClock()
    scheduleRender()
  }

  internal fun onEngineRunning(running: Boolean) {
    if (destroyed) return
    // 重复探测不排渲染：轮询每秒一次，若无条件 scheduleRender 就是每秒一次无意义重绘。
    if (engineRunningCache == running && model.engineOnline == running) return
    engineRunningCache = running
    model = OverlayUiModel.onEngineStatus(model, running, System.currentTimeMillis())
    if (!running) model = model.copy(agent = OverlayAgentState.ERROR)
    if (running) startClockIfNeeded() else stopClock()
    scheduleRender()
  }

  internal fun onPendingChanged() {
    if (destroyed) return
    val items = ArrayList<OverlayPendingItem>()
    for (a in svc.panel.pendingApprovals.values) {
      items.add(OverlayPendingItem(a.eventId, "approval", a.toolName.ifBlank { t("需要审批", "Approval needed") }))
    }
    for (q in svc.panel.pendingQuestions.values) {
      items.add(OverlayPendingItem(q.eventId, "question", t("需要回答", "Question")))
    }
    model = OverlayUiModel.setPending(model, items)
    scheduleRender()
  }

  /**
   * 会话切换。顺序不可换：先存旧草稿、再认领迁移草稿、最后才让观察者接手。
   *
   * 为什么 restoreDraftSnapshot 必须早于 sessionGeneration++：一旦代次先增，后续到达的
   * 发送回执就会被判成「属于旧代次」而拒绝清空，用户会看到草稿在切换后莫名残留；
   * 反过来先恢复再增代次，观察者看到的始终是已经落位的那一份。
   */
  internal fun onSessionChanged() {
    if (destroyed) return
    val previousSession = previousSessionId
    if (previousSession.isNotEmpty() && previousSession != svc.activeSessionId) {
      val previousDraft = exportDraftSnapshot()
      sessionDrafts[previousSession] = previousDraft.copy(sessionId = previousSession)
    }
    previousSessionId = svc.activeSessionId
    val migrated = createdDraftMigration?.takeIf { it.sessionId == svc.activeSessionId }
    createdDraftMigration = null
    val restoredDraft = migrated ?: sessionDrafts[svc.activeSessionId]
    if (restoredDraft != null) restoreDraftSnapshot(restoredDraft)
    sessionGeneration++
    refreshPageState()
    scheduleRender()
  }

  internal fun onDataChanged() {
    if (destroyed) return
    scheduleRender()
  }

  internal fun onConfigurationChanged() {
    if (destroyed) return
    // 只有真正影响内容尺寸的视觉配置变化才重建视图；纯旋转不重建（重建会掉焦点）。
    if (visualConfiguration != currentVisualConfiguration()) {
      visualConfiguration = currentVisualConfiguration()
      recreateViewsPreservingState()
      return
    }
    val s = screen()
    // 转屏/分屏后所有窗口都要按新几何重算（旧实现只重定位了球与面板，卡片/药丸/输入全不会动）。
    entryParams?.let { lp ->
      if (style == STYLE_STRIP) {
        val placement = OverlayWindowFrames.stripPlacement(s, lp.x + lp.width / 2 >= s.widthPx / 2, lp.y, lp.height)
        lp.x = placement.first
        lp.y = placement.second
      } else {
        lp.x = OverlayWindowFrames.clampPillX(lp.x, lp.width, s)
        lp.y = OverlayWindowFrames.clampPillY(lp.y, lp.width, lp.height, s)
      }
      windows.update(OverlayWindows.Slot.ENTRY, lp)
    }
    cardParams?.let { lp ->
      lp.width = OverlayWindowFrames.cardWidthPx(s)
      lp.x = (OverlayWindowFrames.CARD_SIDE_MARGIN_DP * s.density).toInt()
      lp.y = OverlayWindowFrames.cardTopPx(s)
      card?.let { c -> lp.height = OverlayWindowFrames.cardHeightPx(c.measureContentHeightPx(lp.width), s, cardExpanded) }
      windows.update(OverlayWindows.Slot.CARD, lp)
    }
    pillParams?.let { lp ->
      lp.x = OverlayWindowFrames.clampPillX(lp.x, lp.width, s)
      lp.y = OverlayWindowFrames.clampPillY(lp.y, lp.width, lp.height, s)
      windows.update(OverlayWindows.Slot.PILL, lp)
    }
    composerParams?.let { lp ->
      lp.width = OverlayWindowFrames.composerWidthPx(s)
      lp.x = (OverlayWindowFrames.COMPOSER_SIDE_MARGIN_DP * s.density).toInt()
      lp.y = s.navBarPx
      windows.update(OverlayWindows.Slot.COMPOSER, lp)
    }
    // 依赖输入窗几何的窗口必须在输入窗落位之后再算，且取件租约期间一律不动：
    // 租约正把 flags/alpha 降级，此时 add/update sheet 或 chip 会破坏它的原子性。
    if (attachmentInteraction == null) {
      composer?.setMaxDrawerHeightPx((OverlayWindowFrames.availableHeightPx(s) * .4f).toInt())
      syncDrawerWindow()
      // chip 的坐标来自输入窗的真实屏幕位置，必须等这一帧布局完成后再读。
      // 这里只排一次校正，不做逐帧轮询。
      composer?.view?.post {
        if (!destroyed && !uiSuspended && !hostForeground) syncChipWindows()
      }
    }
  }

  private fun scheduleRender() {
    if (destroyed) return
    if (renderPending) return
    renderPending = true
    main.postDelayed({
      renderPending = false
      if (destroyed) return@postDelayed
      if (cardVisible()) renderCard()
      if (pillVisible()) pill?.render(OverlayUiModel.pillOf(model, UiText.isEnglish(svc)).text, toneOf(OverlayUiModel.pillOf(model, UiText.isEnglish(svc)).tone))
      if (composerVisible()) renderComposer()
    }, 100)
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────


  private fun renderCard() {
    val c = card ?: return
    val english = UiText.isEnglish(svc)
    val elapsed = if (model.agent == OverlayAgentState.RUNNING && model.turnStartedAt > 0L) {
      val sec = ((System.currentTimeMillis() - model.turnStartedAt) / 1000L).coerceAtLeast(0L)
      " · " + sec + "s"
    } else ""
    val stateLabel = when (model.agent) {
      OverlayAgentState.RUNNING -> t("工作中", "Working") + elapsed
      OverlayAgentState.WAITING -> t("等待你的回答", "Waiting for you")
      OverlayAgentState.ERROR -> t("引擎离线", "Engine offline")
      // 完成态文案走语义翻译，不改 model：模型是跨层真源，渲染层就地改写会让下一次
      // 状态比较误判「已变化」，触发多余的重建。
      OverlayAgentState.IDLE -> {
        val completionLabel = OverlayUiModel.completionLabelOf(model, english)
        when {
          completionLabel.isNotEmpty() -> completionLabel
          else -> t("空闲", "Idle")
        }
      }
    }
    val questionLabel = if (model.pending.isNotEmpty() && model.pending.any { it.kind == "question" }) {
      t("需要回答", "Question")
    } else {
      ""
    }
    val rows = model.toolRows.map { row ->
      OverlayToolRowItem(
        row.callId,
        row.name.ifBlank { t("工具", "Tool") },
        row.summary,
        when {
          row.failed -> OverlayToolRowState.FAILED
          row.running -> OverlayToolRowState.RUNNING
          else -> OverlayToolRowState.DONE
        },
      )
    }
    val pendingActions = ArrayList<OverlayPendingAction>()
    for (p in model.pending.take(3)) {
      if (p.kind == "approval") {
        pendingActions.add(OverlayPendingAction(p.eventId, "approval", t("审批", "Approval") + "：" + p.title))
      } else {
        pendingActions.add(OverlayPendingAction(p.eventId, "question", t("回答", "Answer") + "：" + p.title))
      }
    }
    val footer = when {
      model.completionLabel.isNotEmpty() -> model.completionLabel
      model.headline.isNotEmpty() -> ""
      else -> ""
    }
    c.render(
      OverlayCardData(
        stateLabel = stateLabel,
        thinkingLine = model.thinkingLine,
        toolCount = model.toolCount,
        rows = rows,
        footerLine = footer,
        pending = pendingActions,
        running = model.agent == OverlayAgentState.RUNNING,
      ),
    )
    resizeCardIfNeeded()
  }

  private fun renderComposer() {
    val c = composer ?: return
    val s = screen()
    val state = pageState
    val english = UiText.isEnglish(svc)
    // 工作区名只能来自「当前会话所属的页面状态」：创建时的目标覆盖值是上一次操作的残留，
    // 用户已经切到别的会话后它还挂在界面上，就会显示成错误的归属。
    val workspaceLabel = when {
      state != null && state.sessionId == svc.activeSessionId && state.workspaceName.isNotBlank() -> state.workspaceName
      else -> t("工作区", "Workspace")
    }
    val sessionLabel = when {
      state != null && state.sessionTitle.isNotBlank() -> state.sessionTitle
      state != null && state.sessionId.isNotBlank() -> state.sessionId.take(8)
      svc.activeSessionId.isNotBlank() -> svc.activeSessionId.take(8)
      else -> t("新会话", "New session")
    }
    val attachments = state?.attachments?.map { OverlayAttachmentChip(it.name, it.kind) } ?: emptyList()
    val items = when (drawerMode) {
      DrawerMode.SESSIONS -> sessionChoices.map { OverlayCommandItem(it.id, it.title, it.id.take(8)) }
      DrawerMode.WORKSPACES -> (state?.workspaces ?: emptyList()).map { OverlayCommandItem(it.id, it.title, "") }
      else -> pageCommands.map { OverlayCommandItem(it.name, it.label, it.description) }
    }
    val pendingHint = model.pending.firstOrNull()?.title.orEmpty()
    c.render(
      OverlayComposerData(
        workspaceLabel = workspaceLabel,
        sessionLabel = sessionLabel,
        attachments = attachments,
        commands = items,
        pendingHint = pendingHint,
        busy = svc.sessionBusy,
        sendEnabled = true,
      ),
    )
    c.setDrawerOpen(drawerMode != DrawerMode.NONE)
    main.post { refreshComposerWindowHeight() }
    if (composerVisible() && composerParams?.width != OverlayWindowFrames.composerWidthPx(s)) {
      composerParams?.let { lp ->
        lp.width = OverlayWindowFrames.composerWidthPx(s)
        windows.update(OverlayWindows.Slot.COMPOSER, lp)
      }
    }
  }

  private fun workspaceNameOf(id: String): String? =
    pageState?.workspaces?.firstOrNull { it.id == id }?.title

  /** 文件名 → 工作区名的兜底（页面不可用时只显示「工作区」）。 */
  private fun refreshPageState() {
    val generation = ++pageReadGeneration
    if (!OverlayPageHost.available()) {
      // 页面不可用：工作区列表退回本仓文件真源（只读展示，切换语义未定，design.md §6.3）。
      if (pageState == null) {
        pageState = OverlayPageHost.PageState(
          sessionId = svc.activeSessionId,
          sessionTitle = "",
          workspaceId = "",
          workspaceName = "",
          workspaces = WorkspaceListParse.parse(readWorkspaceJson()).map {
            OverlayPageHost.PageWorkspace(it.id, it.title)
          },
          busy = svc.sessionBusy,
          attachments = emptyList(),
          draft = "",
        )
      }
      // 页面不可用时不能只刷输入区：卡片上的胶囊/转录若停在旧内容，用户会以为任务没进展。
      // 这里按「已知模型」重渲染当前可见面，不伪造任何新数据。
      if (cardVisible()) renderCard()
      if (pillVisible()) renderPill()
      if (composerVisible()) renderComposer()
      return
    }
    OverlayPageHost.state { s ->
      if (destroyed || generation != pageReadGeneration) return@state
      if (s != null) {
        pageState = s
        if (s.sessionId.isNotEmpty() && s.sessionId != svc.activeSessionId) svc.adoptPageSession(s.sessionId)
      } else {
        pageState = null
      }
      // 只靠订阅是刷不出新到达的转录的：胶囊只有一格文本，页面状态回来时必须显式重渲染，
      // 否则用户看到的永远是他上次展开时的旧输出。
      if (composerVisible()) renderComposer()
      if (pillVisible()) renderPill()
    }
  }

  private fun readWorkspaceJson(): String? = try {
    val file = java.io.File(svc.filesDir, "home/.dsh/storages/workspace.json")
    if (file.isFile) file.readText() else null
  } catch (_: Throwable) {
    null
  }

  private fun refreshCommands() {
    if (!OverlayPageHost.available()) return
    OverlayPageHost.commands { list ->
      if (destroyed) return@commands
      pageCommands = list
      if (composerVisible()) renderComposer()
    }
  }

  // ── 其它 ────────────────────────────────────────────────────────────────

  private fun onPendingAction(eventId: String, kind: String, approve: Boolean, text: String = "") {
    if (kind == "question") {
      // 回答提问会占用输入框，用户正在写的那句话必须先留档：
      // 否则他答完问题回来，原本写了一半的消息就没了。
      messageDraftBeforeAnswer = exportDraftSnapshot()
      showComposer(true)
      return
    }
    // 审批是两步式：v2 只负责把用户带到那张卡（理由填写由既有面板实现），
    // 不在浮窗里直接放行 —— 一步放行会绕过面板里的理由校验。
    selectPending(eventId)
    showPendingPanelFromOverlay()
  }

  /**
   * 提交一条提问的文字答案。
   *
   * 三个保护都在同一个快照上比对，缺一个就会答错地方：
   * 1) 会话必须还是发起时那个 —— 用户切走之后答案会落到另一个会话；
   * 2) 题目必须还是同一道 —— 期间可能又来了新问题；
   * 3) 输入框内容必须没被用户改过 —— 改了说明他在写别的，不该被这条回执清掉。
   */
  private fun sendQuestionAnswer(eventId: String, text: String) {
    val target = questionTarget ?: return
    val sid = svc.activeSessionId
    val sentDraft = composer?.inputText().orEmpty()
    // 迟到回执保护：用户可能已切会话或换了题，此时提交答案会答到错误的问题上。
    if (svc.activeSessionId != sid || questionTarget != target) return
    svc.panel.questionTextAnswer(target.eventId, target.questionId, text, { ok ->
      if (!ok) {
        svc.flashStatus(t("答案未送达，请重试", "Answer not delivered; retry"))
        return@questionTextAnswer
      }
      // 只清「自己写进去的那一份」：等待期间用户补的字不能被一并抹掉。
      if (!destroyed && composer?.inputText() == sentDraft) composer?.setInputText("")
    })
  }

  /**
   * 离开答题态。
   *
   * [submitted] 为 true 表示答案已提交，此时不该回填旧草稿（用户刚答完题，
   * 回到一个塞着旧文字的输入框会误以为要再发一次）；false 表示用户放弃答题，
   * 必须把进入前的草稿原样还回去。
   */
  private fun leaveQuestionAnswer(submitted: Boolean) {
    val saved = messageDraftBeforeAnswer
    messageDraftBeforeAnswer = null
    questionTarget = null
    if (submitted || saved == null) return
    restoreDraftSnapshot(saved)
  }

  /** 打开既有待办面板（审批/提问共用），把两步式确认交给面板完成。 */
  private fun showPendingPanelFromOverlay() = svc.showPendingPanelFromOverlay()

  /** 本次发送可用的附件：只认属于当前会话的页面草稿。 */
  private fun attachmentsForSend(): List<OverlayPageHost.PageAttachment> =
    pageState?.takeIf { it.sessionId == svc.activeSessionId }?.attachments ?: emptyList()

  /** 把当前待办事件固定成一次明确的选择；重复选择同一事件是幂等的。 */
  private fun selectPending(eventId: String) {
    if (selectedPendingEventId == eventId) return
    selectedPendingEventId = eventId
  }

  private fun startClockIfNeeded() {
    if (!cardVisible() || model.agent != OverlayAgentState.RUNNING) return
    if (clockTick != null) return
    val tick = object : Runnable {
      override fun run() {
        if (destroyed || !cardVisible() || model.agent != OverlayAgentState.RUNNING) {
          clockTick = null
          return
        }
        renderCard()
        main.postDelayed(this, 1000)
      }
    }
    clockTick = tick
    main.postDelayed(tick, 1000)
  }

  private fun stopClock() {
    clockTick?.let { main.removeCallbacks(it) }
    clockTick = null
  }

  private fun DSUiAnimationsEnabled(): Boolean = DsUi.animationsEnabled(svc)

  private fun toast(text: String) {
    main.post {
      try {
        Toast.makeText(svc, text, Toast.LENGTH_SHORT).show()
      } catch (_: Throwable) {
        svc.flashStatus(text)
      }
    }
  }

  /** 供服务层读取（测试与契约用）。 */
  internal fun windowSlots(): List<String> = windows.slots().map { it.label }

  // ── Phase 2：UI 暂挂 / 重建 / 草稿搬运（Service 的 legacy 迁移路径依赖这些接口）──

  /** 暂挂前的呈现面，恢复时据此还原（而不是把所有窗口一律重新拉起）。 */
  private data class UiPresentation(
    val entry: Boolean,
    val card: Boolean,
    val pill: Boolean,
    val composer: Boolean,
    val inputFocused: Boolean,
  )


  // ── 卡片形变 / 入口拖拽 / 过渡代次（Phase 2）──────────────────────────
  private var morphAnimator: android.animation.ValueAnimator? = null
  private var morphProgress = 0f
  private var morphInteractionFlags: Int? = null
  private var morphInteractionAlpha = 1f
  private var morphGeneration = 0
  private var cardHandleDragging = false
  private var cardGestureMotion: OverlayMotion? = null
  private var drawerClosing = false
  private var composerClosing = false
  private var drawerWindowGeneration = 0
  private var composerWindowGeneration = 0
  private var pillInitialY: Int? = null
  private var parkedEntryY: Int? = null
  private var outsideHandledDownTime = -1L
  private var outsideClosedCardDownTime = -1L
  private var entryDragState: OverlayEntryDragState? = null
  private var entryPointerDownX = 0f
  private var resizeAnimator: android.animation.ValueAnimator? = null
  private var chipObserver: android.view.ViewTreeObserver? = null
  private var chipLayout: android.view.ViewTreeObserver.OnGlobalLayoutListener? = null
  private var chipPreDraw: android.view.ViewTreeObserver.OnPreDrawListener? = null
  private val syncAttachedChips = Runnable { syncChipWindows() }
  private var handleHoldFeedback: Runnable? = null
  private val cardHandleIntent = OverlayCardHandleIntent(
    ViewConfiguration.getLongPressTimeout().toLong(), ViewConfiguration.get(svc).scaledTouchSlop.toFloat(),
  )

  private var uiSuspended = false
  // 会话代次：每次会话切换自增，用来判「迟到回执是否还属于当前会话」。
  private var sessionGeneration = 0
  // 上一次观察到的会话 id（用于把草稿存回它真正归属的那个会话）。
  private var previousSessionId = ""
  // 上一条发送已获准的代次（建会话路径会 +1，让迁移后的状态被认领）。
  private var admittedGeneration = 0
  // 引擎为当前发送新建会话时暂存的草稿，等 onSessionChanged 认领后置空。
  private var createdDraftMigration: OverlayV2DraftSnapshot? = null
  // 每个会话的草稿快照：切走时存，切回时取，避免来回切换丢字。
  private val sessionDrafts = HashMap<String, OverlayV2DraftSnapshot>()
  // 取件期间让出的触摸权租约：非空即表示「系统取件占着触摸」，chip/drawer 同步都要让路。
  private var attachmentInteraction: OverlayWindows.InteractionLease? = null
  private var attachmentInteractionSession = ""
  private var attachmentInteractionRequestId = ""
  private var attachmentRestoreAttempts = 0
  private val attachmentRequestIds = HashMap<String, MutableSet<String>>()
  private var recreatingViews = false
  // 「动作已发出但还没被确认」的窗口期：Service 回滚草稿时据此拒绝重复提交。
  private var sendPending = false
  private var commandPending = false
  private var suspendedPresentation: UiPresentation? = null
  private var visualConfiguration: OverlayV2VisualConfiguration? = null

  internal fun exportDraftSnapshot(): OverlayV2DraftSnapshot {
    val input = composer?.view?.findViewWithTag<android.widget.EditText>("overlay-composer-input")
    val text = composer?.inputText().orEmpty()
    return OverlayV2DraftSnapshot(
      sessionId = svc.activeSessionId,
      text = text,
      composerVisible = composerVisible(),
      inputFocused = input?.hasFocus() == true,
      selectionStart = (input?.selectionStart ?: text.length).coerceIn(0, text.length),
      selectionEnd = (input?.selectionEnd ?: text.length).coerceIn(0, text.length),
      sendPending = sendPending,
      commandPending = commandPending,
    )
  }

  /** 只同会话恢复 UI 文本，不发送、不开放 unknown 锁，也不复制/取消宿主票据。 */
  internal fun restoreDraftSnapshot(snapshot: OverlayV2DraftSnapshot): Boolean {
    if (destroyed || !snapshot.matchesSession(svc.activeSessionId)) return false
    showComposer(focusInput = false)
    val c = composer ?: return false
    c.setInputText(snapshot.text)
    val input = c.view.findViewWithTag<android.widget.EditText>("overlay-composer-input")
    val selection = snapshot.selection()
    input?.setSelection(selection.first, selection.second)
    return true
  }

  /** 仅暂挂 UI；保留同一个动作观察者与草稿对象，供 Service 原对象回滚复用。 */
  internal fun suspendUi(): OverlayV2DraftSnapshot {
    val snapshot = exportDraftSnapshot()
    if (destroyed || uiSuspended) return snapshot
    suspendedPresentation = UiPresentation(
      entry = windows.contains(OverlayWindows.Slot.ENTRY),
      card = cardVisible(),
      pill = pillVisible(),
      composer = composerVisible(),
      inputFocused = snapshot.inputFocused,
    )
    uiSuspended = true
    OverlayPageHost.watchState(false)
    stopClock()
    // 先作废形变再拆窗：拆窗会让卡片 View 脱离窗口，旧动画若还在跑就会对着一个
    // 已 detach 的 View 继续派发帧，既浪费也会在重建后落到错误的卡片上。
    cancelCardInteraction()
    if (cardVisible()) hideCard()
    hidePill(false)
    hideComposer()
    // 显式摘掉所有仍挂着的窗口：suspend 的语义是「界面完全不占屏」，只依赖 hide* 的
    // 内部实现会在某条分支漏掉一个槽位，留下一个看不见却吃触摸的空窗。
    windows.remove(OverlayWindows.Slot.CARD)
    windows.remove(OverlayWindows.Slot.PILL)
    windows.remove(OverlayWindows.Slot.COMPOSER)
    windows.remove(OverlayWindows.Slot.DRAWER)
    hideChipWindows()
    return snapshot
  }

  /** 还原 [suspendUi] 暂挂的呈现面；只重建原本在屏上的窗口。 */
  internal fun resumeUi() {
    if (destroyed || !uiSuspended) return
    val presentation = suspendedPresentation
    uiSuspended = false
    suspendedPresentation = null
    // 恢复时重新对齐前台真源：暂挂期间用户可能已切走/切回，用旧值判断会错挂窗口。
    hostForeground = OverlayHostVisibility.foreground
    // 先按当前语言/字号重建视图，再挂入口 —— 顺序反了入口会先用旧配置建出来再被重建。
    recreateViewsPreservingState()
    if (presentation == null) return
    if (!hostForeground && !entryHiddenByUser) buildEntry()
    if (presentation.composer) showComposer(focusInput = presentation.inputFocused)
    updatePageWatching()
  }

  /** 语言变了才重建视图：文案在 inflate 时就固化进控件，不重建会留着旧语言。 */
  internal fun onLanguageChanged() {
    if (destroyed || visualConfiguration == currentVisualConfiguration()) return
    recreateViewsPreservingState()
  }

  /** 入口形态（球/条）由设置页改过：按新形态重挂入口，不重建其它窗口。 */
  internal fun onEntryStyleChanged() {
    if (destroyed) return
    // 取件期间不能替换入口：此时窗口带着临时 flags/alpha，换掉会让租约回收到一个不存在的 View。
    if (attachmentInteraction != null) return
    val next = entryStyle(svc)
    if (style == next) return
    style = next
    if (entryHiddenByUser || hostForeground) return
    removeEntryWindow()
    showEntry()
  }

  /** 页面状态被宿主置为失效：节流后重取一次，避免抖动期反复拉取。 */
  internal fun onPageStateInvalidated() {
    if (destroyed || uiSuspended || !observingPage() || pageStateRefreshQueued) return
    pageStateRefreshQueued = true
    main.postDelayed({
      pageStateRefreshQueued = false
      if (!destroyed && !uiSuspended && observingPage()) refreshPageState()
    }, 100)
  }

  private var pageStateRefreshQueued = false
  // 页面读取代次：迟到的旧回调不得覆盖新一次读取的结果。
  private var pageReadGeneration = 0
  private fun observingPage() = cardVisible() || pillVisible() || composerVisible()
  private fun updatePageWatching() =
    OverlayPageHost.watchState(!destroyed && !uiSuspended && !hostForeground && observingPage())

  private fun currentVisualConfiguration(): OverlayV2VisualConfiguration {
    val config = svc.resources.configuration
    return OverlayV2VisualConfiguration(
      localeTags = config.locales.toLanguageTags(),
      uiMode = config.uiMode,
      fontScale = config.fontScale,
      densityDpi = config.densityDpi,
      english = UiText.isEnglish(svc),
    )
  }

  /** 重建缓存颜色/字号/文案的 View；V2 与所有业务模型、代次、票据及数据通道保持原样。 */
  internal fun recreateViewsPreservingState() {
    if (destroyed || recreatingViews || uiSuspended || attachmentInteraction != null) return
    val draft = exportDraftSnapshot()
    val hadEntry = windows.contains(OverlayWindows.Slot.ENTRY)
    val hadCard = cardVisible()
    val hadPill = pillVisible()
    val savedExpanded = cardExpanded
    val savedDrawer = drawerMode
    val savedEntryX = entryParams?.x ?: entryX
    val savedEntryY = entryParams?.y ?: entryY
    val savedPillX = pillParams?.x
    val savedPillY = pillParams?.y
    visualConfiguration = currentVisualConfiguration()
    recreatingViews = true
    cancelCardInteraction()
    try {
      stopClock()
      resizeAnimator?.cancel(); resizeAnimator = null
      card?.view?.animate()?.cancel()
      // Detach 会注销各 View 的动效订阅并废弃旧 finite onEnd，不能先 finish 消散而移错窗。
      hideDrawer(false)
      composerWindowGeneration++; composer?.view?.animate()?.withEndAction(null)?.cancel()
      hideChipWindows()
      windows.remove(OverlayWindows.Slot.COMPOSER)
      windows.remove(OverlayWindows.Slot.PILL)
      windows.remove(OverlayWindows.Slot.CARD)
      windows.remove(OverlayWindows.Slot.ENTRY)
      entryView = null; entryParams = null
      card = null; cardParams = null
      pill = null; pillParams = null
      composer = null; composerParams = null
      entryX = savedEntryX; entryY = savedEntryY
      cardExpanded = savedExpanded
      drawerMode = savedDrawer
      if (hadEntry && !entryHiddenByUser) {
        showEntry()
        entryParams?.let { lp ->
          val s = screen()
          if (style == STYLE_STRIP) {
            val place = OverlayWindowFrames.stripPlacement(s, savedEntryX + lp.width / 2 >= s.widthPx / 2, savedEntryY, lp.height)
            lp.x = place.first; lp.y = place.second
          } else {
            lp.x = OverlayWindowFrames.clampPillX(savedEntryX, lp.width, s)
            lp.y = OverlayWindowFrames.clampPillY(savedEntryY, lp.width, lp.height, s)
          }
          entryX = lp.x; entryY = lp.y
          windows.update(OverlayWindows.Slot.ENTRY, lp)
        }
      }
      if (draft.composerVisible) restoreDraftSnapshot(draft)
      if (hadCard) {
        showCard()
        card?.view?.animate()?.cancel()
        card?.view?.alpha = 1f; card?.view?.translationY = 0f
      } else if (hadPill) {
        showPill()
        pillParams?.let { lp ->
          val s = screen()
          lp.x = OverlayWindowFrames.clampPillX(savedPillX ?: lp.x, lp.width, s)
          lp.y = OverlayWindowFrames.clampPillY(savedPillY ?: lp.y, lp.width, lp.height, s)
          windows.update(OverlayWindows.Slot.PILL, lp)
        }
        pill?.finishAnimations()
      }
      if (draft.composerVisible) {
        showComposer(focusInput = false)
        composer?.finishAnimations()
        val restored = composer
        main.post {
          if (!destroyed && !uiSuspended && !hostForeground && composer === restored && composerVisible()) {
            if (draft.inputFocused) restored?.focusInput() else restored?.focusRoot()
            val input = restored?.view?.findViewWithTag<android.widget.EditText>("overlay-composer-input")
            val selection = draft.copy(text = input?.text?.toString().orEmpty()).selection()
            input?.setSelection(selection.first, selection.second)
          }
        }
      }
    } finally {
      recreatingViews = false
    }
  }



  /** 屏幕几何（可用高 = 屏高 - 状态栏 - 导航/手势条）。每次现算，转屏/分屏后自动跟上。 */
  private fun screen(): OverlayScreen {
    val dm = svc.resources.displayMetrics
    var w = dm.widthPixels
    var h = dm.heightPixels
    var statusBar = 0
    var navBar = 0
    if (Build.VERSION.SDK_INT >= 30) {
      try {
        val metrics = svc.wm.currentWindowMetrics
        w = metrics.bounds.width()
        h = metrics.bounds.height()
        // 用 IgnoringVisibility 而不是 getInsets：系统栏显示/隐藏时后者会让 top 跳变，
        // 卡片/胶囊的物理位置跟着抖一下，用户看到的是"界面在跳"。
        val insets = metrics.windowInsets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars())
        statusBar = insets.top
        navBar = insets.bottom
      } catch (_: Throwable) {
        statusBar = dimenPx("status_bar_height")
        navBar = dimenPx("navigation_bar_height")
      }
    } else {
      statusBar = dimenPx("status_bar_height")
      navBar = dimenPx("navigation_bar_height")
    }
    return OverlayScreen(w, h, statusBar, navBar, dm.density)
  }



  private fun dimenPx(name: String): Int = try {
    val id = svc.resources.getIdentifier(name, "dimen", "android")
    if (id > 0) svc.resources.getDimensionPixelSize(id) else 0
  } catch (_: Throwable) {
    0
  }

  /** 调试转储：给 dumpsys 与设备验收脚本读的窗口/节点快照。 */
  /**
   * 稳定的 View 身份标识。
   *
   * 用 tag + identityHashCode 而不是只取其中一项：tag 说明"这是哪个语义节点"，
   * identityHashCode 说明"是哪一个对象实例"。两者合一才能同时回答"还是同一个 View 吗"
   * 与"还是同一个语义位吗"，外部也才能把槽位与带 tag 的节点对上。
   */
  private fun viewIdentity(view: View, fallbackTag: String = ""): String {
    val tag = (view.tag as? String) ?: fallbackTag.ifEmpty { view.javaClass.simpleName }
    return tag + ":" + System.identityHashCode(view)
  }

  internal fun snapshotDiagnostics(): JSONObject {
    val views = JSONObject()
    val nodes = org.json.JSONArray()
    fun visit(view: View) {
      val tag = view.tag as? String
      if (tag != null && view.isShown) {
        val loc = IntArray(2)
        view.getLocationOnScreen(loc)
        nodes.put(
          JSONObject()
            .put("tag", tag)
            .put("viewId", viewIdentity(view))
            .put(
              "bounds",
              JSONObject()
                .put("left", loc[0]).put("top", loc[1])
                .put("right", loc[0] + view.width).put("bottom", loc[1] + view.height),
            ),
        )
      }
      if (view is android.view.ViewGroup) for (i in 0 until view.childCount) visit(view.getChildAt(i))
    }
    for (slot in windows.slots()) {
      val v = windows.view(slot) ?: continue
      // viewId 用字符串：identityHashCode 是 Int，序列化后外部无法与槽位身份稳定比对。
      // flags/alpha 必须一并输出 —— 取件租约期间窗口被降级成 NOT_TOUCHABLE + 低 alpha，
      // 这正是"租约有没有生效/有没有被破坏"的唯一可核对证据，靠几何推断不可靠。
      val lp = windows.params(slot)
      // viewId 必须与节点遍历里同一个 View 生成的标识逐字相同 —— 外部靠它证明
      // "窗口槽位里的 View 就是那个带 tag 的实际根"，两处各拼各的前缀会让身份永远对不上。
      views.put(
        slot.label,
        JSONObject()
          .put("viewId", viewIdentity(v, slot.label))
          .put("attached", v.isAttachedToWindow)
          .put("flags", lp?.flags ?: 0)
          .put("alpha", (lp?.alpha ?: 1f).toDouble()),
      )
      visit(v)
    }
    return JSONObject()
      .put("schemaVersion", 1)
      .put("processId", android.os.Process.myPid())
      .put("available", true)
      // 取件租约是否仍被持有：外部核对"取件期间窗口没被替换/重建"时，必须能从
      // 诊断里读到这个状态，而不是靠推断。租约期间窗口处于降级 flags，几何断言会失真。
      .put("pickerActive", attachmentInteraction != null)
      .put("views", views)
      .put("nodes", nodes)
      .put("draft", draftDiagnostics())
      .put("motion", motionDiagnostics())
  }

  /**
   * 运动学证据。
   *
   * 外部核对"卡片要拖多远才收起""胶囊能拖到多高"时必须读运行中的真实阈值，
   * 不能用脚本里另抄一份常量 —— 那样两边一旦漂移，验收就会在错误的阈值上通过。
   * 两个值都直接取自本进程实际使用的 [motion] 与几何计算。
   */
  private fun motionDiagnostics(): JSONObject {
    val s = screen()
    val cfg = motion().config
    return JSONObject()
      .put("cardCollapseDistancePx", cfg.cardCollapseDistancePx.toDouble())
      .put("topLimitPx", motionTopLimitPx(s).toDouble())
      .put("topTolerancePx", cfg.topTolerancePx.toDouble())
      .put("topFadeDistancePx", cfg.topFadeDistancePx.toDouble())
  }

  /**
   * 草稿证据。
   *
   * 外部要核对"取件回来草稿和光标还在不在"，只能靠这份快照 —— 截图看不出光标位置，
   * 也无法区分"文本相同"和"同一个草稿对象"。selection 越界会让恢复端 setSelection 抛异常，
   * 所以这里输出的值必须已经钳进文本长度内。
   */
  private fun draftDiagnostics(): JSONObject {
    val text = composer?.inputText().orEmpty()
    val start = (composer?.inputSelectionStart() ?: 0).coerceIn(0, text.length)
    val end = (composer?.inputSelectionEnd() ?: start).coerceIn(start, text.length)
    val ids = org.json.JSONArray()
    (pageState?.attachments ?: emptyList()).forEach { ids.put(it.id) }
    return JSONObject()
      .put("sessionId", svc.activeSessionId)
      .put("text", text)
      .put("selectionStart", start)
      .put("selectionEnd", end)
      .put("attachmentIds", ids)
  }

}

/** live 流事件的统一形态（OverlayLiveFeed → 聚合层；字段全部来自既有 .live.ndjson 行）。 */
/**
 * 视图草稿快照（OverlayService 在 UI 暂挂/重建前后搬运文本与焦点状态用）。
 *
 * 为什么把 sessionId 一起带上：恢复方必须先确认「还是同一个会话」，否则把 A 会话的草稿
 * 写进 B 会话的输入框就是一次静默的数据串台。sendPending/commandPending 是「动作已发出
 * 但还没被确认」的窗口期标记：回滚方据此拒绝重复提交，不能替代或清除真实动作票据。
 */
internal data class OverlayV2DraftSnapshot(
  val sessionId: String,
  val text: String,
  val composerVisible: Boolean,
  val inputFocused: Boolean,
  val selectionStart: Int,
  val selectionEnd: Int,
  val sendPending: Boolean,
  val commandPending: Boolean,
) {
  internal fun matchesSession(active: String): Boolean = sessionId == active

  /** 选区钳到文本长度内，且 end 不越过 start（越界会让 EditText.setSelection 抛异常）。 */
  internal fun selection(): Pair<Int, Int> {
    val max = text.length
    val start = selectionStart.coerceIn(0, max)
    val end = selectionEnd.coerceIn(start, max)
    return start to end
  }
}

/**
 * 影响窗口内容尺寸的视觉配置；变了才重建视图，没变就不重建（避免输入中途掉焦点）。
 * 不含旋转几何：横竖屏由 onConfigurationChanged 单独处理，重复计入会让旋转也触发整窗重建。
 */
internal data class OverlayV2VisualConfiguration(
  val localeTags: String,
  val uiMode: Int,
  val fontScale: Float,
  val densityDpi: Int,
  val english: Boolean,
)

internal data class LiveEvent(
  val kind: String,
  val sessionId: String,
  val callId: String,
  val name: String,
  val summary: String,
  val text: String,
  val turnKind: String,
  val atMs: Long,
  /** 该行是否标记失败（live.ndjson 的 err 位）；默认 false 保持旧行兼容。 */
  val failed: Boolean = false,
) {
  internal companion object {
    internal const val KIND_TOOL_CALL = "tool_call"
    internal const val KIND_TOOL_RESULT = "tool_result"
    internal const val KIND_TEXT = "text"
    internal const val KIND_THINK = "think"
    internal const val KIND_TURN_END = "turn_end"
  }
}
