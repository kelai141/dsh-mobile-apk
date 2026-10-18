package com.dsharnessmobile.shell

import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.WindowManager

/**
 * 隐藏态协作类（0.14.9-preview 块J）：球「消失」之后屏幕上剩下的唯一东西——贴边召回条。
 *
 * 形态（用户 2026-09-28 拍板：面板里点「隐藏」→ 球消失 → 边缘留一条半透明条，点它召回）：
 *  - 球窗 + 光环窗在隐藏时**从 WindowManager 移除**，而不是 alpha=0、visibility=GONE
 *    或加 FLAG_NOT_TOUCHABLE。三种「留着窗口」的写法各有死因，见
 *    docs/0.14.9-preview-OVERLAY-BALL-HIDE.md §2：前两种留下**不可见的触摸黑洞**
 *    （34dp 的隐形触区吃掉它下面应用的手势——正是历史「互吞」的同形缺陷）；第三种要改
 *    球窗的 flags，而「球窗尺寸/标志全程不变」是 F8 的硬约束（改了就要重走 WMS 整窗
 *    平移那整套坑）。**移除窗口**是唯一同时满足「真消失」与「零隐形触区」的做法。
 *  - 召回条是本服务**第四个窗口**，与面板窗同口径**懒创建**：只在 [show] 里 add、
 *    [hide] 里 remove。buildRoot 里仍只有两次 addView，CallSiteContractTest 的 I-A2
 *    窗口计数（详档 §5.2）因此不变；常态窗口数仍是 3。
 *  - 条的窗口尺寸 = 条的可视尺寸（8×44dp），没有「窗口比图形大」的隐形边——可点区域
 *    就是看得见的那一条（高 44dp 是仓内 MIN_TOUCH_TARGET_DP 口径，条是唯一的召回入口）。
 *
 * 几何全部落在纯函数 [recallStripPlacement] / [recallBallPlacement] 里（JVM 可测，
 * 与 OverlayReport 的 reportBarInitialHeight 同口径）。本类只做窗口与触摸接线。
 */
class OverlayRecall(private val svc: OverlayService) {

  private val theme = OverlayTheme(svc)

  private var stripView: View? = null
  private var stripParams: WindowManager.LayoutParams? = null

  internal val stripWidthPx by lazy {
    (RECALL_STRIP_WIDTH_DP * svc.resources.displayMetrics.density).toInt()
  }
  internal val stripHeightPx by lazy {
    (RECALL_STRIP_HEIGHT_DP * svc.resources.displayMetrics.density).toInt()
  }

  /** 条是否在场（幂等守卫与诊断用；不对外暴露任何 UI 状态）。 */
  internal fun isShowing(): Boolean = stripView != null

  /**
   * 进入隐藏态：按球的最后位置把条贴到**最近的水平边缘**（左半屏贴左、右半屏贴右）。
   * 幂等——已在场时直接返回，重复调用不会在屏上留第二条。
   */
  internal fun show(ballX: Int, ballY: Int, ballSize: Int) {
    if (isShowing()) return
    val metrics = svc.resources.displayMetrics
    val at = recallStripPlacement(
      ballX, ballY, ballSize,
      stripWidthPx, stripHeightPx,
      metrics.widthPixels, metrics.heightPixels,
    )
    val strip = View(svc).apply {
      // uiautomator / 无障碍认这条（隐藏态里它是**唯一**可操作面，必须有名字）。
      contentDescription = "唤回悬浮球"
      background = stripBackground()
      isClickable = true
      setOnClickListener { svc.recallBall() }
      DsUi.bindPressScale(this)
    }
    val lp = WindowManager.LayoutParams(
      stripWidthPx, stripHeightPx,
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      // NOT_FOCUSABLE：条绝不能抢焦点——抢了就把 WebView 的输入法顶掉（键盘一弹条就在，
      // 用户以为界面坏了）。NOT_TOUCH_MODAL：条矩形之外的触摸照常穿透到应用。
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      // 同球窗/光环窗：禁系统 IME pan（默认 adjust=pan 会在键盘弹出时把条搬走 → 召回时错位）。
      softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
      x = at[0]
      y = at[1]
    }
    stripView = strip
    stripParams = lp
    try { svc.wm.addView(strip, lp) } catch (_: Exception) {}
  }

  /** 退出隐藏态：收条（幂等）。窗口此时可能已被系统回收，异常按「已经不在」处理。 */
  internal fun hide() {
    val v = stripView ?: return
    try { svc.wm.removeView(v) } catch (_: Exception) {}
    stripView = null
    stripParams = null
  }

  /**
   * 召回时球该落在哪（读条当前位置；条不在场返回 null）。返回 null 时调用方保持球的原坐标
   * ——宁可落在旧位置，也不猜。
   */
  internal fun ballPlacementForRecall(ballSize: Int, margin: Int): IntArray? {
    val p = stripParams ?: return null
    val metrics = svc.resources.displayMetrics
    return recallBallPlacement(
      p.x, p.y, stripHeightPx, ballSize, margin,
      metrics.widthPixels, metrics.heightPixels,
    )
  }

  /**
   * 转屏/分屏后重新落位：条是「贴边」的，旧的 x 在新屏幕宽度下可能整条悬空或出屏。
   * 用球的位置重算（与 [show] 同一函数），纵向由纯函数夹回屏内。
   */
  internal fun reposition(ballX: Int, ballY: Int, ballSize: Int) {
    val v = stripView ?: return
    val p = stripParams ?: return
    val metrics = svc.resources.displayMetrics
    val at = recallStripPlacement(
      ballX, ballY, ballSize,
      stripWidthPx, stripHeightPx,
      metrics.widthPixels, metrics.heightPixels,
    )
    p.x = at[0]
    p.y = at[1]
    try { svc.wm.updateViewLayout(v, p) } catch (_: Exception) {}
  }

  /** 换肤（uiMode 变化）：条底色的唯一来源是 OverlayTheme 色板，切深浅色必须重刷一次。 */
  internal fun refreshTheme() {
    stripView?.background = stripBackground()
  }

  /** 条底色 = 色板里的 recallStrip；全圆角（radius = 半宽）= 药丸形，贴边读起来是「拉手」。 */
  private fun stripBackground(): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    cornerRadius = stripWidthPx / 2f
    setColor(theme.themeColors().recallStrip)
  }
}

// ── 召回条尺寸（dp）──────────────────────────────────────────────────────────
//
// 高 = MIN_TOUCH_TARGET_DP（44）：条是隐藏态**唯一**的召回入口，热区必须落在手指尺度上
// （S2-18 的同一口径：两处入口 20dp 命中区曾被 uiautomator 实锤「按不准」）。
// 宽 = 8dp：视觉上是一条贴边拉手，不是第二个球（34dp）。宽度即窗口宽度——不做「窗口宽、
// 图形窄」，见类注释的隐形触区纪律。
internal const val RECALL_STRIP_WIDTH_DP = 8
internal const val RECALL_STRIP_HEIGHT_DP = 44

/**
 * 隐藏后召回条贴哪条边、落在哪个 y（纯函数，JVM 可测）。返回 IntArray(x, y)。
 *
 * 贴边是硬约束：x 恒为 0 或 screenW - stripW「二选一」，绝不悬空——条离了边就成了第二个球，
 * 用户也不知道它在守哪条边。选边用球**中心**（不是左上角）判左右半屏：球贴右缘时
 * `ballX` 本身也已过半屏，但用中心表达「球更偏哪边」在窄球宽下更准。
 *
 * 纵向与球心对齐后夹进屏内（`screenH - stripH` 为下界）：球拖到贴底时条仍要完整可见，
 * 否则「唯一的召回入口」会被屏幕裁掉——那等于球真的丢了。
 */
internal fun recallStripPlacement(
  ballX: Int,
  ballY: Int,
  ballSize: Int,
  stripW: Int,
  stripH: Int,
  screenW: Int,
  screenH: Int,
): IntArray {
  val ballCenterX = ballX + ballSize / 2
  val x = if (ballCenterX * 2 < screenW) 0 else (screenW - stripW).coerceAtLeast(0)
  val centered = ballY + ballSize / 2 - stripH / 2
  val y = centered.coerceIn(0, (screenH - stripH).coerceAtLeast(0))
  return intArrayOf(x, y)
}

/**
 * 召回时球落在哪（纯函数，JVM 可测）。返回 IntArray(x, y)。
 *
 * 两条口径与既有实现**逐字一致**，不得另立：
 *  ① 选边：条贴左（`stripX * 2 < screenW`）→ 球回到左缘；条贴右 → 球回右缘。与
 *     [recallStripPlacement] 的选边表达式同形——两个函数对「哪边」的判断必须同源，
 *     否则会出现「条在左边、球从右边冒出来」。
 *  ② 夹取：上下左右都用 `margin` 留边，且**与 OverlayService.clampBallPos 的 coerceIn
 *     边界完全相同**（含 `coerceAtLeast(margin)` 的窄屏防御）——召回后球必须落在
 *     「拖动能到达的位置集合」里，否则下一次拖动会先跳一下。
 */
internal fun recallBallPlacement(
  stripX: Int,
  stripY: Int,
  stripH: Int,
  ballSize: Int,
  margin: Int,
  screenW: Int,
  screenH: Int,
): IntArray {
  val left = stripX * 2 < screenW
  val x = if (left) margin else (screenW - ballSize - margin)
  val y = stripY + stripH / 2 - ballSize / 2
  return intArrayOf(
    x.coerceIn(margin, (screenW - ballSize - margin).coerceAtLeast(margin)),
    y.coerceIn(margin, (screenH - ballSize - margin).coerceAtLeast(margin)),
  )
}
