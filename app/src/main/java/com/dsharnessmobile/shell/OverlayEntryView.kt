package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import androidx.core.content.ContextCompat

/**
 * 入口窗内容（§3.1 W1 / §9.1 两种形态）：只负责「看得见的那点东西」，不碰窗口与手势。
 *
 * 为什么要拆成独立类：入口形态（球/细条）是**窗口尺寸**不同的两种东西（球 34dp 方窗、
 * 细条 8x88dp），而窗口管理属于服务。视图层只交付一个与窗口等大的 View，服务把它塞进
 * WindowManager；触摸监听（单/双/长按、拖动）同样由服务挂 OnTouchListener。
 * 根对象在球/条转换时保持不变，终态由服务更新有界窗口尺寸，避免截断同一指针序列。
 *
 * 换形过渡（2026-11 动效补齐）：新表面从 0.92 放大 + 淡入，旧表面同时淡出，两者在同一个根里
 * 交叠 [OverlayMotionSpec.ENTRY_SWAP_MS]；旧表面在过渡结束（或被打断/移出窗口）时移除。
 * 为什么做成「交叠」而不是先消失再出现：入口只有 34dp，一闪而过会被读成「球没了又来一个条」，
 * 交叠才读得出是同一个物件在改形状。过渡期间触摸监听始终挂在稳定的根上（服务在根上挂 listener），
 * 因此不会丢指针序列。时长/幅度取自 [OverlayMotionSpec]，系统关动画时直接换形不留一帧。
 *
 * @param context 取资源/颜色/density 的上下文（壳侧传 Service，/ Theme 不需要 Activity）。
 * @param style 初始入口形态；形态终态切换仍须调用方同步更新窗口几何。
 */
internal class OverlayEntryView(private val context: Context, style: OverlayEntryStyle) {

  private val density = context.resources.displayMetrics.density
  var style: OverlayEntryStyle = style
    private set

  private val root = FrameLayout(context).apply { clipChildren = true; clipToPadding = true }
  private var surface: View = buildSurface(style)
  /** 正在淡出的旧表面：换形过渡期与 surface 短暂共存，过渡结束才移除。 */
  private var retiring: View? = null
  private var swapGeneration = 0
  private var attached = false
  private var motionEnabled = false
  private var unregisterMotionListener: (() -> Unit)? = null

  /** Stable touch target: switching shape does not replace the root or its touch listener. */
  val view: View = root

  init {
    installSurface()
    root.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(v: View) {
        attached = true
        motionEnabled = DsUi.animationsEnabled(context)
        unregisterMotionListener?.invoke()
        unregisterMotionListener = DsUi.registerMotionListener(context) {
          motionEnabled = DsUi.animationsEnabled(context)
          if (!motionEnabled) finishSwap()
        }
        finishSwap()
      }

      override fun onViewDetachedFromWindow(v: View) {
        attached = false
        unregisterMotionListener?.invoke()
        unregisterMotionListener = null
        // 移窗不是过渡完成：立即收口，不能让淡出中的旧表面跟着下一次显示复活。
        finishSwap()
      }
    })
  }

  /**
   * Only call at a terminal shape change; caller owns the matching bounded WM geometry change.
   *
   * 换形走「新旧交叠」：旧表面淡出，新表面从 0.92 缩放进位。动效关闭、未 attached 或时长为 0 时
   * 直接换形（同步移除旧表面），因此关动画的设备上不存在任何中间帧。
   */
  fun renderStyle(next: OverlayEntryStyle) {
    if (next == style) { renderEdgeProgress(0f, OverlayEntryEdge.LEFT); return }
    style = next
    val outgoing = surface
    val incoming = buildSurface(next)
    surface = incoming
    root.removeView(outgoing)
    installSurface()
    val durationMs = OverlayMotionSpec.entrySwapMs(reduced = !motionEnabled)
    if (!attached || durationMs <= 0L) {
      finishSwap()
      return
    }
    // 上一轮未收口的旧表面立刻移除：只保留「当前 + 本轮旧」两层，避免连点边角堆叠。
    finishSwap()
    resetSurfaceTransforms(incoming)
    incoming.alpha = 0f
    incoming.scaleX = OverlayMotionSpec.ENTRY_DIP_SCALE
    incoming.scaleY = OverlayMotionSpec.ENTRY_DIP_SCALE
    root.addView(outgoing, 0, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    retiring = outgoing
    val generation = ++swapGeneration
    incoming.animate().alpha(1f).scaleX(1f).scaleY(1f)
      .setDuration(durationMs).setInterpolator(OverlayEasing.DECELERATE.interpolator()).start()
    outgoing.animate().alpha(0f)
      .setDuration(durationMs).setInterpolator(OverlayEasing.ACCELERATE.interpolator()).withEndAction {
        if (generation == swapGeneration) clearRetiring()
      }.start()
  }

  /** 换形过渡立即收口：移除旧表面、新表面写终态，不发任何后续回调。 */
  fun finishSwap() {
    swapGeneration++
    clearRetiring()
    resetSurfaceTransforms(surface)
  }

  private fun clearRetiring() {
    val old = retiring ?: return
    retiring = null
    old.animate().withEndAction(null).cancel()
    root.removeView(old)
  }

  /** 只复位换形用的两个渲染属性；拖动反馈（renderEdgeProgress）自己拥有 scale/alpha 的口径。 */
  private fun resetSurfaceTransforms(target: View) {
    target.animate().withEndAction(null).cancel()
    target.alpha = 1f
    target.scaleX = 1f
    target.scaleY = 1f
  }

  /** Cheap reversible staged-edge feedback, kept inside existing bounds; no animator/layout loop. */
  fun renderEdgeProgress(progress: Float, side: OverlayEntryEdge) {
    val p = if (progress.isFinite()) progress.coerceIn(0f, 1f) else 0f
    // 与换形过渡的分工：没有拖动量（p=0，换形刚发生的那一帧）时把这一帧让给过渡，
    // 否则这里写的 alpha=1/scale=1 会把刚起步的淡入当帧抹平；一旦有真实拖动量，
    // 反馈立即接管并当帧收口过渡 —— 手指就是过渡本身，不需要两套动画叠加写同一个表面。
    if (retiring != null) {
      if (p <= 0f) return
      finishSwap()
    }
    surface.pivotX = if (side == OverlayEntryEdge.LEFT) 0f else surface.width.toFloat()
    surface.pivotY = surface.height / 2f
    surface.scaleX = if (style == OverlayEntryStyle.BALL) 1f - 0.28f * p else 1f
    surface.scaleY = if (style == OverlayEntryStyle.BALL) 1f - 0.08f * p else 1f - 0.16f * p
    surface.alpha = 1f - 0.08f * p
  }

  private fun buildSurface(style: OverlayEntryStyle): View = when (style) {
    OverlayEntryStyle.BALL -> buildBall(context)
    OverlayEntryStyle.STRIP -> buildStrip(context)
  }

  private fun installSurface() {
    root.addView(surface, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    root.contentDescription = UiText.t(context,
      if (style == OverlayEntryStyle.BALL) "悬浮球" else "悬浮入口条",
      if (style == OverlayEntryStyle.BALL) "Floating ball" else "Floating entry strip")
  }

  /**
   * 球形态：34dp 白底圆 + 黑鲸鱼图标（沿用 OverlayService.buildRoot 的现网观感）。
   *
   * 图标裁剪矩阵逐字搬自 app/src/main/java/com/dsharnessmobile/shell/OverlayService.kt:256-278：
   * ic_launcher_foreground 是 432 画布，内容 bbox 为 (102,130)-(328,300)（227x171），
   * 目标 26x20dp 居中并保持等比（scale 取两轴较小者），这样换密度/换 launch 图内容位置
   * 变化时观感不会跑偏。视图层不重新设计图标，避免两套入口观感打架。
   */
  private fun buildBall(context: Context): View {
    val ballSizePx = dp(34)
    val icon = ContextCompat.getDrawable(context, R.drawable.ic_launcher_foreground)
    val whale = ImageView(context).apply {
      setImageDrawable(icon)
      scaleType = ImageView.ScaleType.MATRIX
      // 内容 bbox -> 26x20dp 目标，居中；注释里的 102/130 是 bbox 左上角，227/171 是内容尺寸。
      val srcW = 227f
      val srcH = 171f
      val dstW = 26 * density
      val dstH = 20 * density
      val scale = minOf(dstW / srcW, dstH / srcH)
      val dx = (dstW - srcW * scale) / 2f - 102f * scale
      val dy = (dstH - srcH * scale) / 2f - 130f * scale
      imageMatrix = android.graphics.Matrix().apply {
        setScale(scale, scale)
        postTranslate(dx, dy)
      }
    }
    // 白底圆是球的唯一视觉；球窗尺寸 = 34dp，因此这里不设额外内边距（窗口矩形就是可见圆）。
    val ball = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(Color.WHITE)
      }
      addView(
        whale,
        LinearLayout.LayoutParams(dp(26), dp(20)),
      )
      // 球是唯一常驻入口，必须有无障碍名（uiautomator 与读屏都靠它识别）。
      contentDescription = UiText.t(context, "悬浮球", "Floating ball")
    }
    return FrameLayout(context).apply {
      addView(ball, FrameLayout.LayoutParams(ballSizePx, ballSizePx))
    }
  }

  /**
   * 细条形态：窗口 8x88dp，可视条 8x64dp 垂直居中（上下各留 12dp 透明）。
   *
   * 为什么窗口比可视条高 24dp：§9.2 拍板「细条只纵向扩大命中区」。横向扩大会在屏内留下
   * 16dp 隐形触区（与边缘手势冲突、违反窗口=可视纪律）；纵向只沿屏幕边缘外侧延展，
   * 对底层应用零侵入。窗口宽度仍 = 可视宽度 8dp，所以根 View 必须与窗口同尺寸并透明，
   * 由居中的子 View 画出 8x64dp 圆角条。
   *
   * 底色口径与隐藏态召回条同源（OverlayTheme.themeColors().recallStrip，中性灰/白半透明、
   * 随主题）：两条入口在用户眼里是同一族「贴边拉手」，新造色相会让同一块屏出现第三套配色。
   */
  private fun buildStrip(context: Context): View {
    val stripWidthPx = dp(10)
    val visibleHeightPx = dp(72)
    // Two-tone pill: the base keeps the recall-strip family color so both edge handles read as one
    // gesture vocabulary, and a soft inner highlight gives it a deliberate, non-scrollbar surface.
    // Pure drawables only: no animator, no layout loop, no extra window bounds.
    val strip = FrameLayout(context).apply {
      background = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = context.resources.getDimension(R.dimen.ds_radius_pill)
        setColor(OverlayTheme(context).themeColors().recallStrip)
      }
      addView(
        View(context).apply {
          background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = context.resources.getDimension(R.dimen.ds_radius_pill)
            setColor(withAlpha(ContextCompat.getColor(context, R.color.ds_text_on_accent), .55f))
          }
        },
        FrameLayout.LayoutParams(dp(2), dp(28), Gravity.CENTER),
      )
      contentDescription = UiText.t(context, "悬浮入口条", "Floating entry strip")
    }
    // 根 View 与窗口同尺寸（8x88dp）：尺寸由服务侧 WindowManager.LayoutParams 按形态给定
    // （OverlayWindowFrames），这里不自设 layoutParams——根 View 的 LayoutParams 会被
    // WindowManager 的 addView(view, params) 覆盖，写在这里只会成为一处误导性的第二口径。
    return FrameLayout(context).apply {
      // 根透明：上下各 12dp 是命中区而不是图形，不能画任何底色。
      addView(
        strip,
        FrameLayout.LayoutParams(stripWidthPx, visibleHeightPx, Gravity.CENTER),
      )
    }
  }

  /** Single alpha source for drawable tints; avoids a second color pipeline in this view. */
  private fun withAlpha(color: Int, alpha: Float): Int =
    Color.argb((alpha.coerceIn(0f, 1f) * 255).toInt(), Color.red(color), Color.green(color), Color.blue(color))

  /** dp 换算统一走整数截断（与仓内 ballSizeDp / edgeMarginPx 同口径）。 */
  private fun dp(value: Int): Int = (value * density).toInt()
}
