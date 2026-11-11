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
  private val style: String = entryStyle(svc)
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
  private var hostForeground = false
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
    buildEntry()
    OverlayAttachmentBus.handler = { kind, path, err -> onAttachmentResult(kind, path, err) }
    refreshPageState()
    refreshCommands()
  }

  internal fun destroy() {
    destroyed = true
    OverlayAttachmentBus.handler = null
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
        val insets = metrics.windowInsets.getInsets(WindowInsets.Type.systemBars())
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

  private fun t(zh: String, en: String): String = UiText.t(svc, zh, en)

  // ── 入口 ────────────────────────────────────────────────────────────────

  private fun buildEntry() {
    if (destroyed) return
    if (entryHiddenByUser || hostForeground) return
    val s = screen()
    val styleEnum = if (style == STYLE_STRIP) OverlayEntryStyle.STRIP else OverlayEntryStyle.BALL
    val view = OverlayEntryView(svc, styleEnum).also { entryView = it }
    val w: Int
    val h: Int
    if (styleEnum == OverlayEntryStyle.STRIP) {
      w = OverlayWindowFrames.stripWindowWidthPx(s.density)
      h = OverlayWindowFrames.stripWindowHeightPx(s.density)
      // 细条贴边：默认贴右（上次拖到哪边就继续贴那边，右侧是主手位）。
      val placement = OverlayWindowFrames.stripPlacement(s, true, entryY, h)
      entryX = placement.first
      entryY = placement.second
    } else {
      w = (OverlayWindowFrames.ENTRY_BALL_DP * s.density).toInt()
      h = w
      // 初始右上角：与旧实现同口径（距右缘 12dp、竖直 1/3 处）。
      if (entryX <= 0 && entryY <= 0) {
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
    val longPress = Runnable {
      if (router.onLongPress(SystemClock.uptimeMillis()) == EntryGesture.LONG_PRESS) {
        onEntryLongPress()
      }
    }
    val resolveTap = Runnable {
      if (router.resolvePendingTap(SystemClock.uptimeMillis()) == EntryGesture.TAP) onEntryTap()
    }
    view.setOnTouchListener { _, ev ->
      val lp = entryParams ?: return@setOnTouchListener false
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          router.onDown(SystemClock.uptimeMillis())
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
            EntryGesture.TAP -> onEntryTap()
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

  private fun onEntryTap() {
    if (cardVisible()) hideCard() else showCard()
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
    buildEntry()
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
      buildEntry()
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
      // 「点卡片外部收起」：非焦点 overlay 窗收不到 backdrop 手势，只能靠 WATCH_OUTSIDE_TOUCH
      // 的 ACTION_OUTSIDE（design.md §3.4 首选路径）；失败时还有返回键/再点入口两条保底。
      view.view.setOnTouchListener { _, ev ->
        if (ev.actionMasked == MotionEvent.ACTION_OUTSIDE) {
          hideCard()
          true
        } else {
          false
        }
      }
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

  private fun handlePillDrag(phase: OverlayDragPhase, dxPx: Float, dyPx: Float, velocityPxPerS: Float) {
    val lp = pillParams ?: return
    val s = screen()
    when (phase) {
      OverlayDragPhase.DOWN -> {
        pillDownX = lp.x
        pillDownY = lp.y
      }
      OverlayDragPhase.MOVE -> {
        lp.x = OverlayWindowFrames.clampPillX(pillDownX + dxPx.toInt(), lp.width, s)
        lp.y = OverlayWindowFrames.clampPillY(pillDownY + dyPx.toInt(), lp.width, lp.height, s)
        windows.update(OverlayWindows.Slot.PILL, lp)
      }
      OverlayDragPhase.UP -> {
        lp.x = OverlayWindowFrames.clampPillX(pillDownX + dxPx.toInt(), lp.width, s)
        lp.y = OverlayWindowFrames.clampPillY(pillDownY + dyPx.toInt(), lp.width, lp.height, s)
        windows.update(OverlayWindows.Slot.PILL, lp)
        // 消散判定：只有「已经贴顶 + 明确上推 + 够快」三条同时成立才消散（design.md §9.4）。
        if (OverlayWindowFrames.pillDismissReached(-dyPx, -velocityPxPerS, lp.y, s)) {
          dismissPill()
        }
      }
      OverlayDragPhase.CANCEL -> Unit
    }
  }

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
    }
  }

  private fun toneOf(tone: OverlayTone): OverlayUiTone = when (tone) {
    OverlayTone.WORKING -> OverlayUiTone.WORKING
    OverlayTone.WAITING -> OverlayUiTone.WAITING
    OverlayTone.ERROR -> OverlayUiTone.ERROR
    else -> OverlayUiTone.IDLE
  }

  // ── 底部输入区 ──────────────────────────────────────────────────────────

  private fun composerVisible(): Boolean = windows.contains(OverlayWindows.Slot.COMPOSER)

  internal fun showComposer(focusInput: Boolean) {
    if (destroyed) return
    if (composer == null) {
      composer = OverlayComposer(svc, object : OverlayComposerListener {
        override fun onComposerSend(text: String) = sendText(text)
        override fun onComposerStop() = svc.requestStop()
        override fun onComposerAttach(kind: String) = startAttachment(kind)
        override fun onComposerRemoveAttachment(index: Int) = removeAttachment(index)
        override fun onComposerWorkspaceChip() = openWorkspacePicker()
        override fun onComposerSessionChip() = openSessionPicker()
        override fun onComposerCommand(line: String) = onDrawerPick(line)
        override fun onComposerLayoutChanged() = refreshComposerWindowHeight()
      })
    }
    val c = composer ?: return
    val s = screen()
    if (!composerVisible()) {
      val lp = WindowManager.LayoutParams(
        OverlayWindowFrames.composerWidthPx(s), ViewGroup.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        // 可聚焦才能弹输入法；NOT_TOUCH_MODAL：输入区以外的触摸照常穿透到底层应用。
        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
        PixelFormat.TRANSLUCENT,
      ).apply {
        gravity = Gravity.BOTTOM or Gravity.START
        // 键盘原生顶起：沿用旧面板已验证的 ADJUST_PAN（自己监听 IME insets 的方案已废，design.md §8.2）。
        softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN
        x = (OverlayWindowFrames.COMPOSER_SIDE_MARGIN_DP * s.density).toInt()
        y = s.navBarPx
      }
      composerParams = lp
      renderComposer()
      if (!windows.add(OverlayWindows.Slot.COMPOSER, c.view, lp)) {
        composerParams = null
        toast(t("输入区创建失败", "Could not create the input area"))
        return
      }
      c.view.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> refreshComposerWindowHeight() }
    } else {
      renderComposer()
    }
    refreshPageState()
    refreshCommands()
    if (focusInput) main.post { composer?.focusInput() }
    if (svc.sessionBusy) composer?.let { }
  }

  internal fun hideComposer() {
    if (!composerVisible()) return
    val c = composer
    try {
      c?.view?.clearFocus()
    } catch (_: Throwable) {
    }
    windows.remove(OverlayWindows.Slot.COMPOSER)
    composerParams = null
    drawerMode = DrawerMode.NONE
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

  private fun sendText(text: String) {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return
    val attachments = pageState?.attachments ?: emptyList()
    if (attachments.isNotEmpty() && OverlayPageHost.available()) {
      // 附件在页面草稿里（file-incoming 管线由页面认领），所以整条消息也必须由页面提交，
      // 否则附件会被留在草稿里发不出去（design.md §8.3 的附件口径）。
      OverlayPageHost.send(trimmed) { ok ->
        if (ok) {
          composer?.setInputText("")
          svc.markBusyOptimistic()
          refreshPageState()
        } else {
          svc.flashStatus(t("发送失败，请在主界面重试", "Send failed; retry in the main app"))
        }
      }
      return
    }
    svc.sendTextFromOverlay(trimmed)
  }

  private fun startAttachment(kind: String) {
    val mapped = when (kind) {
      "camera" -> OverlayAttachProxyActivity.KIND_CAMERA
      "photo" -> OverlayAttachProxyActivity.KIND_PHOTO
      else -> OverlayAttachProxyActivity.KIND_FILE
    }
    OverlayAttachProxyActivity.start(svc, mapped)
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
    OverlayPageHost.removeAttachment(index) { ok ->
      if (ok) refreshPageState() else svc.flashStatus(t("删除附件失败", "Could not remove the attachment"))
    }
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
    model = OverlayUiModel.onAgentStatus(model, running, System.currentTimeMillis())
    if (running) startClockIfNeeded() else stopClock()
    scheduleRender()
  }

  internal fun onEngineRunning(running: Boolean) {
    if (destroyed) return
    engineRunningCache = running
    if (!running) {
      model = OverlayUiModel.onAgentStatus(model, false, System.currentTimeMillis()).copy(agent = OverlayAgentState.ERROR)
      scheduleRender()
    }
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

  internal fun onSessionChanged() {
    if (destroyed) return
    refreshPageState()
    scheduleRender()
  }

  internal fun onDataChanged() {
    if (destroyed) return
    scheduleRender()
  }

  internal fun onConfigurationChanged() {
    if (destroyed) return
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
      OverlayAgentState.IDLE -> t("空闲", "Idle")
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
    val workspaceLabel = when {
      svc.targetWorkspaceIdOverride != null -> workspaceNameOf(svc.targetWorkspaceIdOverride!!) ?: t("工作区", "Workspace")
      state != null && state.workspaceName.isNotBlank() -> state.workspaceName
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
      if (composerVisible()) renderComposer()
      return
    }
    OverlayPageHost.state { s ->
      if (destroyed) return@state
      if (s != null) {
        pageState = s
        if (s.sessionId.isNotEmpty() && s.sessionId != svc.activeSessionId) svc.adoptPageSession(s.sessionId)
      }
      if (composerVisible()) renderComposer()
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

  private fun onPendingAction(eventId: String, kind: String, approve: Boolean) {
    if (kind == "question") {
      // 提问的选项语义（单选/多选/custom）由既有面板完整实现；v2 只负责把用户带到那张卡。
      svc.showPendingPanelFromOverlay()
      return
    }
    svc.panel.respondApprovalFromUi(eventId, approve)
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
}

/** live 流事件的统一形态（OverlayLiveFeed → 聚合层；字段全部来自既有 .live.ndjson 行）。 */
internal data class LiveEvent(
  val kind: String,
  val sessionId: String,
  val callId: String,
  val name: String,
  val summary: String,
  val text: String,
  val turnKind: String,
  val atMs: Long,
) {
  internal companion object {
    internal const val KIND_TOOL_CALL = "tool_call"
    internal const val KIND_TOOL_RESULT = "tool_result"
    internal const val KIND_TEXT = "text"
    internal const val KIND_THINK = "think"
    internal const val KIND_TURN_END = "turn_end"
  }
}
