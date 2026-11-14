package com.dsharnessmobile.shell

import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * 一次屏幕几何测量的快照（纯数据，不吃 Android 类型）。
 *
 * 为什么把「状态栏/导航条」也塞进来：悬浮层的可用高度不是屏幕高度，而是
 * 扣掉系统占用后的净空（design.md §3.3）。把这五个数一次性传进来，
 * 所有窗口计算就都是同一个口径，避免每个窗口各自减一遍、各自漏一项。
 *
 * @property widthPx 屏幕宽（px）。
 * @property heightPx 屏幕高（px）。
 * @property statusBarPx 状态栏高（px）。
 * @property navBarPx 导航栏/手势条高（px）。
 * @property density 当前 density（dp -> px）。
 */
internal data class OverlayScreen(
  val widthPx: Int,
  val heightPx: Int,
  val statusBarPx: Int,
  val navBarPx: Int,
  val density: Float,
)

/**
 * 悬浮层五个窗口的几何唯一真源（纯函数，JVM 可测）。
 *
 * 为什么抽出来：窗口高度上限、钳制边界、贴边坐标这些数字一旦散落在各 View 的
 * layout 代码里，横竖屏和不同 API 档就会各写一份、各漂一截。这里只做算术，
 * 渲染层只负责把返回值塞进 LayoutParams，单测直接钉住边界。
 */
internal object OverlayWindowFrames {
  /** 卡片收起态高度上限 = 可用高的 32%（design.md §4.2 / R4）。 */
  const val CARD_MAX_RATIO = 0.32f
  /** 卡片下拉展开态高度上限 = 可用高的 40%（design.md §4.2 / R4）。 */
  const val CARD_EXPANDED_RATIO = 0.40f
  /** 卡片左右边距 12dp（design.md §4.1 W3）。 */
  const val CARD_SIDE_MARGIN_DP = 12f
  /** 卡片顶边与状态栏之间的视觉间隙 8dp，避免和状态栏内容贴死。 */
  const val CARD_TOP_GAP_DP = 8f
  /** 高度量化档 4dp：只有跨档才 resize，避免事件风暴下窗口抖动（design.md §7.7）。 */
  const val CARD_HEIGHT_STEP_DP = 4f
  /** 相邻两次窗口高度变更的最小间隔 ms（design.md §7.7）。 */
  const val CARD_RESIZE_MIN_INTERVAL_MS = 120L
  /** 药丸高度 44dp（design.md §9.1 L2）。 */
  const val PILL_HEIGHT_DP = 44f
  /** 药丸宽度上限 = 屏宽的 80%，超长文本必须省略而不是撑满整屏。 */
  const val PILL_WIDTH_MAX_RATIO = 1f
  /** 顶缘二次上推16dp：44dp高窗内可达，仍须起点贴顶+500dp/s（design.md §9.4）。 */
  const val PILL_DISMISS_PUSH_DP = 16f
  /** 药丸消散：末速度阈值 500dp/s（design.md §9.4）。 */
  const val PILL_DISMISS_VELOCITY_DP_PER_S = 500f
  /** 药丸消散：药丸顶边容差 8dp，只有贴顶时上推才解释为消散（design.md §9.4）。 */
  const val PILL_DISMISS_TOP_TOLERANCE_DP = 8f
  /** 入口球直径 34dp（design.md §9.1 L4）。 */
  const val ENTRY_BALL_DP = 34f
  /** 侧边细条可视宽 8dp（design.md §9.2）。 */
  const val ENTRY_STRIP_VISUAL_WIDTH_DP = 8f
  /** 侧边细条可视高 64dp（design.md §9.2）。 */
  const val ENTRY_STRIP_VISUAL_HEIGHT_DP = 64f
  /** 侧边细条窗口高 88dp：只纵向扩大命中区，不向屏内扩展（design.md §9.2）。 */
  const val ENTRY_STRIP_WINDOW_HEIGHT_DP = 88f
  /** 入口距屏幕边缘的兜底内缩 8dp，供贴边冲突时调节。 */
  const val ENTRY_EDGE_MARGIN_DP = 8f
  /** 底部输入区左右边距 12dp（design.md §4.1 W5）。 */
  const val COMPOSER_SIDE_MARGIN_DP = 12f
  /** 独立输入药丸距底12dp，与贴底选择卡片保持可见间隔。 */
  const val COMPOSER_BOTTOM_GAP_DP = 12f

  /** Sheet is an independent overlay: its height must never displace the composer. */
  fun composerBottomPx(screen: OverlayScreen): Int =
    screen.navBarPx + dpPx(COMPOSER_BOTTOM_GAP_DP, screen.density)

  /** dp -> px（四舍五入，负数按 0）。所有窗口尺寸共用同一换算，避免各自取整不同。 */
  private fun dpPx(valueDp: Float, density: Float): Int =
    (valueDp * density).roundToInt().coerceAtLeast(0)

  /**
   * 高度量化步长的像素值，至少 1px。
   *
   * 为什么要下限 1：density 极小的极端取值下 4dp 会取整成 0，
   * 一旦步长为 0 就会出现除零或「永不 resize」，宁可退化成逐 px 量化。
   */
  private fun heightStepPx(density: Float): Int =
    dpPx(CARD_HEIGHT_STEP_DP, density).coerceAtLeast(1)

  /**
   * 可用高度 = 屏高 - 状态栏 - 导航条（按 design.md §3.3 的定义）。
   *
   * 为什么要有 0 下限：旋转/分屏的极短瞬间可能拿到负值，
   * 调用方会拿它算比例上限，负数会传染成负窗口尺寸。
   */
  fun availableHeightPx(screen: OverlayScreen): Int =
    (screen.heightPx - screen.statusBarPx - screen.navBarPx).coerceAtLeast(0)

  /**
   * 卡片窗口顶边 y：状态栏下沿再留 8dp 间隙。
   *
   * 为什么固定取状态栏而不是可用区顶部：卡片是常驻左上角的信息层，
   * 顶部 y 在收起/展开之间不能变（design.md §4.2：下拉只增高不移位），
   * 否则白条拉动时卡片会整体跳一下。
   */
  fun cardTopPx(screen: OverlayScreen): Int =
    screen.statusBarPx.coerceAtLeast(0) + dpPx(CARD_TOP_GAP_DP, screen.density)

  /**
   * 卡片窗口宽 = 屏宽 - 2 x 12dp。
   *
   * 为什么左右对称留边：卡片贴近屏幕边缘会与系统手势区、圆角裁切重叠，
   * 点击和滑动都更容易误触。
   */
  fun cardWidthPx(screen: OverlayScreen): Int =
    (screen.widthPx - 2 * dpPx(CARD_SIDE_MARGIN_DP, screen.density)).coerceAtLeast(0)

  /**
   * 卡片严格高度上限：可用高 x 比例（收起32%，展开40%）。
   *
   * 小屏也不得突破比例；内容必须在有界滚动区内，不能用固定dp地板扩大窗口。
   *
   * @param expanded true = 下拉展开态（40%）。
   */
  fun cardHeightLimitPx(screen: OverlayScreen, expanded: Boolean): Int {
    val available = availableHeightPx(screen)
    if (available <= 0) return 0
    val ratio = if (expanded) CARD_EXPANDED_RATIO else CARD_MAX_RATIO
    // toInt() 对正数是向下取整，符合「上限」语义：宁可少 1px 也不能越界。
    val byRatio = (available * ratio).toInt()
    // 用户的比例是硬上限；横屏可读性由内部滚动解决，不得用180dp地板突破32%/40%。
    return byRatio.coerceAtMost(available)
  }

  /**
   * 按内容测量高度算出窗口高度：先量化到 4dp 档，再夹进 [下限, 上限]。
   *
   * 为什么先量化再夹：量化是「同一档位不动窗口」的节流前提；如果先夹再量化，
   * 贴上限时每次内容抖动都会跨档。内容 <= 0（尚未测量）时给一个最小量化档，
   * 让窗口先有个可布局的高度，而不是 0 高导致内容不测量。
   *
   * @param contentHeightPx 内容测量出的期望高度（px）。
   */
  fun cardHeightPx(contentHeightPx: Int, screen: OverlayScreen, expanded: Boolean): Int {
    val limit = cardHeightLimitPx(screen, expanded)
    if (limit <= 0) return 0
    val step = heightStepPx(screen.density)
    val quantized = quantizeHeightPx(contentHeightPx, screen.density)
    val lower = if (contentHeightPx <= 0) step.coerceAtMost(limit) else 1
    return quantized.coerceIn(lower, limit)
  }

  /**
   * 高度量化：按 4dp x density 向下取整。
   *
   * 向下取整而不是四舍五入：只有跨到下一档（内容确实多出一整档）才变高度，
   * 边界附近的抖动不会来回触发 resize。px <= 0 返回 0，由调用方补最小档。
   */
  fun quantizeHeightPx(px: Int, density: Float): Int {
    if (px <= 0) return 0
    val step = heightStepPx(density)
    return (px / step) * step
  }

  /**
   * 药丸宽度 = min(内容宽, 屏宽 x 80%)。
   *
   * 为什么要上限：药丸是「一眼扫过」的状态条，单行文本过长时不能横向膨胀到盖住整屏；
   * 超限由 TextView 的 ellipsize 收尾。
   *
   * @param contentWidthPx 内容测量宽（px）。
   */
  fun pillWidthPx(contentWidthPx: Int, screen: OverlayScreen): Int {
    val maxPx = minOf(cardWidthPx(screen), (screen.widthPx * PILL_WIDTH_MAX_RATIO).toInt()).coerceIn(0, screen.widthPx)
    return contentWidthPx.coerceIn(0, maxPx)
  }

  /**
   * 药丸 x 钳制到 [0, 屏宽 - 药丸宽]。
   *
   * 为什么必须夹两侧：药丸可自由拖动，拖出屏幕后用户既看不见也可能再也拖不回来。
   */
  fun clampPillX(x: Int, widthPx: Int, screen: OverlayScreen): Int =
    x.coerceIn(0, (screen.widthPx - widthPx).coerceAtLeast(0))

  /**
   * 药丸 y 钳制到 [0, 可用高 - 药丸高]。
   *
   * 注意下限是 0：药丸允许贴到屏幕最顶部（design.md §9.1 R9「顶部不自动隐藏」），
   * 只有额外的上推手势才解释为消散，所以这里不做任何「近顶自动吸附/隐藏」。
   *
   * @param widthPx 与 [clampPillX] 成对的同一份测量值；纵向钳制只用高度，
   *   保留参数是为了调用点不必为 x/y 拆两套签名。
   */
  fun clampPillY(y: Int, widthPx: Int, heightPx: Int, screen: OverlayScreen): Int {
    // 宽度不参与纵向钳制；这里显式判一次，避免「参数没人用」被误读成漏接线。
    if (widthPx < 0) return 0
    val available = availableHeightPx(screen)
    return y.coerceIn(0, (available - heightPx).coerceAtLeast(0))
  }

  /**
   * 细条窗口宽（px）：按可视宽 8dp 建窗。
   *
   * 为什么不加宽：横向扩大命中区会在屏内留隐形触区，与「窗口 = 可视」纪律冲突
   * （design.md §9.2）。命中区只靠纵向窗口高 88dp 扩大。
   */
  fun stripWindowWidthPx(density: Float): Int =
    dpPx(ENTRY_STRIP_VISUAL_WIDTH_DP, density).coerceAtLeast(1)

  /** 细条窗口高（px）：88dp 的纵向命中区，可视仍只画 64dp。 */
  fun stripWindowHeightPx(density: Float): Int =
    dpPx(ENTRY_STRIP_WINDOW_HEIGHT_DP, density).coerceAtLeast(1)

  /**
   * 细条窗口落点：贴左（x=0）或贴右（x=屏宽-窗口宽），y 做纵向钳制。
   *
   * 为什么贴边而不是自由拖：细条的设计前提是「占屏极小、可纵向拖」，
   * 允许横向自由移动就会变成第二个悬浮球。
   *
   * @param rightSide true = 贴右边缘。
   * @param y 期望的纵向位置。
   * @param windowHeightPx 细条窗口高（px）。
   * @returns 第一个值是 x，第二个值是 y。
   */
  fun stripPlacement(
    screen: OverlayScreen,
    rightSide: Boolean,
    y: Int,
    windowHeightPx: Int,
  ): Pair<Int, Int> {
    val windowWidth = stripWindowWidthPx(screen.density)
    val x = if (rightSide) (screen.widthPx - windowWidth).coerceAtLeast(0) else 0
    return x to clampStripY(y, windowHeightPx, screen)
  }

  /**
   * 细条 y 钳制到 [0, 可用高 - 窗口高]。
   *
   * 为什么用窗口高而不是可视高 64dp：命中区是 88dp，窗口本身不能越过可用区，
   * 否则多出来的触区会落到导航条上。
   */
  fun clampStripY(y: Int, windowHeightPx: Int, screen: OverlayScreen): Int =
    y.coerceIn(0, (availableHeightPx(screen) - windowHeightPx).coerceAtLeast(0))

  /**
   * 底部输入区宽 = 屏宽 - 2 x 12dp。
   *
   * 为什么与卡片同边距：两块窗上下叠放时左右边缘对齐，视觉上是一套版式；
   * 也保证输入区不会压到系统手势区。
   */
  fun composerWidthPx(screen: OverlayScreen): Int =
    (screen.widthPx - 2 * dpPx(COMPOSER_SIDE_MARGIN_DP, screen.density)).coerceAtLeast(0)

  /**
   * 药丸上推消散判定：距离、速度、贴顶三条同时满足（design.md §9.4）。
   *
   * 为什么必须三条都满足：只看距离会把「从屏幕中间往上快滑一下」误杀；
   * 只看速度会把轻微滑动误杀；不看贴顶则药丸在任何位置都可能被一次上推弄丢。
   *
   * @param pushUpPx 本手势的净上推距离（px，向上为正）。
   * @param velocityYpxPerS 末速度（px/s，向上为正）。取绝对值的原因：
   *   Android VelocityTracker 的上滑 y 分量为负，本函数也允许调用方统一成正向上，
   *   两种取值都能判对；方向本来就由 [pushUpPx] 的阈值兜底。
   * @param pillTopPx 本次手势 DOWN 时药丸顶边 y（px），不可传移动后的坐标。
   */
  fun pillDismissReached(
    pushUpPx: Float,
    velocityYpxPerS: Float,
    pillTopPx: Int,
    screen: OverlayScreen,
  ): Boolean {
    val pushThreshold = dpPx(PILL_DISMISS_PUSH_DP, screen.density).toFloat()
    val velocityThreshold = dpPx(PILL_DISMISS_VELOCITY_DP_PER_S, screen.density).toFloat()
    val topTolerance = dpPx(PILL_DISMISS_TOP_TOLERANCE_DP, screen.density)
    return pushUpPx >= pushThreshold &&
      abs(velocityYpxPerS) >= velocityThreshold &&
      pillTopPx <= topTolerance
  }
}
