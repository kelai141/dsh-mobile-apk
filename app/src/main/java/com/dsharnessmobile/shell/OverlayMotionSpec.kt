package com.dsharnessmobile.shell

/**
 * 悬浮窗淡入淡出的纯规格模块（§4.4 出现/消散、§7.7 静止零刷新）。
 *
 * 为什么要有这个文件：壳侧此前把 160L/120L/60L 这类时长直接写在各 View 的 animate() 调用里，
 * 既无法单测，也让「系统关动画」只能靠每处各自判一次开关。本文件把**数值与曲线**收成纯值，
 * View 只做「取时长 → 交给属性动画器」这一件事；时长本身不依赖 Android，可在 JVM 单测里断言。
 *
 * 三条纪律：
 *  1. **动效关闭即 0ms**：所有 xxxMs(reduced) 在 reduced 为真时返回 [INSTANT_MS]，调用方因此
 *     只有一条路径——时长 <= 0 就直接写终态，不允许「零时长动画」再补一帧；
 *  2. **只进不出界**：[OverlayEasing.transform] 与 [fadeFrame] 的输出恒在 0..1（无回弹、无过冲），
 *     非有限输入一律按 0 处理，View 不会拿到 NaN 去写 alpha；
 *  3. **不与距离 morph 抢所有权**：形变/整窗透明度在拖动期归 OverlayMotion 与编排层，本模块只服务
 *     非拖动期的「出现/换文案」这类一次性过渡。
 *
 * 数值选取依据（900x1600 竖屏、密度约 2 的手机档）见各常量注释；本文件不做设备测量。
 */
internal enum class OverlayEasing {
  /** 减速进入：先快后慢。出现用这条，起手第一帧就有位移感。 */
  DECELERATE,

  /** 加速离开：先慢后快。消失用这条，收尾快，不拖住用户下一次操作。 */
  ACCELERATE,

  /** 标准缓动（smoothstep）：与 OverlayMotion 的距离曲线同族，用于内容更新。 */
  STANDARD;

  /**
   * 时间轴 0..1 映射到 0..1 的缓动值。
   *
   * 非有限输入按 0（起点）处理：调用方即使拿到 NaN 也不会把 alpha 写成 NaN。
   * 三条曲线都单调递增且不过冲，因此「进度前进 = 视觉只朝终态走」。
   */
  fun transform(t: Float): Float {
    val value = if (t.isFinite()) t.coerceIn(0f, 1f) else 0f
    return when (this) {
      // 三次方手写：避免 Float.pow 的 Int/Float 重载歧义，也让「三次」这个事实直接可读。
      DECELERATE -> {
        val remaining = 1f - value
        1f - remaining * remaining * remaining
      }
      ACCELERATE -> value * value
      STANDARD -> value * value * (3f - 2f * value)
    }
  }
}

/**
 * 一次出现过渡的帧值：[alpha] 直接写 View.alpha；
 * [travelFraction] 是**剩余位移占比**（1 = 起点、0 = 终位），View 乘以自己那段 dp 距离即可，
 * 这样本模块不引入像素单位，也不会变成第二份屏幕几何口径。
 */
internal data class OverlayFadeFrame(val alpha: Float, val travelFraction: Float) {
  init {
    require(alpha.isFinite() && alpha in 0f..1f)
    require(travelFraction.isFinite() && travelFraction in 0f..1f)
  }
}

internal object OverlayMotionSpec {
  /** 动效关闭时的唯一合法时长：立即到终态，不留一帧动画。 */
  const val INSTANT_MS = 0L

  /** 选择卡片展开：略长于退场，进入要有「铺开」感。 */
  const val DRAWER_SHOW_MS = 170L

  /** 选择卡片收起：比展开快 30ms，收起不拖手。 */
  const val DRAWER_HIDE_MS = 140L

  /** 卡片从下方抬起 24dp：约窗口高度的 3%，读作「从输入区升起」而不是整屏滑入。 */
  const val DRAWER_SLIDE_DP = 24f

  /** 球/条换形：150ms 足够读完「同一个物件换了形状」，又不至于让拖动觉得迟钝。 */
  const val ENTRY_SWAP_MS = 150L

  /** 换形时新表面从 0.92 放大到 1：位移 8% 肉眼可辨，但不会被看成两个图形。 */
  const val ENTRY_DIP_SCALE = 0.92f

  /** 卡片内行/标签出现：140ms，短于一次事件合并窗口（100ms 渲染节拍）的两个节拍。 */
  const val ROW_APPEAR_MS = 140L

  /** 行出现时上移 4dp 收位：手机上一行约 20dp 高，4dp 是「轻轻落下」的量级。 */
  const val ROW_RISE_DP = 4f

  /** 胶囊换文案：旧文案退场 60ms、新文案进场 90ms，合计 150ms 小于常见朗读间隔。 */
  const val LABEL_OUT_MS = 60L
  const val LABEL_IN_MS = 90L

  /** 胶囊出现 120ms / 消散 160ms：出现要快，消散留下「读到了」的余韵（§4.4）。 */
  const val PILL_IN_MS = 120L
  const val PILL_OUT_MS = 160L
  const val PILL_OUT_SCALE = 0.92f

  /** 列表逐行出现的错峰：每行多等 18ms，最多累计 72ms，长列表不会排队到一秒后。 */
  const val STAGGER_STEP_MS = 18L
  const val STAGGER_MAX_MS = 72L

  private fun durationMs(baseMs: Long, reduced: Boolean): Long =
    if (reduced || baseMs <= 0L) INSTANT_MS else baseMs

  fun drawerShowMs(reduced: Boolean): Long = durationMs(DRAWER_SHOW_MS, reduced)

  fun drawerHideMs(reduced: Boolean): Long = durationMs(DRAWER_HIDE_MS, reduced)

  fun entrySwapMs(reduced: Boolean): Long = durationMs(ENTRY_SWAP_MS, reduced)

  /** 内容行/标签出现时长；动画关闭时 0ms。 */
  fun rowAppearMs(reduced: Boolean): Long = durationMs(ROW_APPEAR_MS, reduced)

  /** [rowAppearMs] 的别名：通用「淡入」入口，语义与行出现一致。 */
  fun fadeInMs(reduced: Boolean): Long = rowAppearMs(reduced)

  fun labelOutMs(reduced: Boolean): Long = durationMs(LABEL_OUT_MS, reduced)

  fun labelInMs(reduced: Boolean): Long = durationMs(LABEL_IN_MS, reduced)

  fun pillInMs(reduced: Boolean): Long = durationMs(PILL_IN_MS, reduced)

  fun pillOutMs(reduced: Boolean): Long = durationMs(PILL_OUT_MS, reduced)

  /**
   * 第 [index] 行出现的延迟。bounds 只有上界含义：第 0 行不等，之后每行 +18ms，
   * 累计封顶 72ms；动画关闭或越界索引一律 0。
   */
  fun stagedDelayMs(index: Int, reduced: Boolean): Long {
    if (reduced || index <= 0) return INSTANT_MS
    return (index.toLong() * STAGGER_STEP_MS).coerceAtMost(STAGGER_MAX_MS)
  }

  /**
   * 进度 -> 帧值。progress 非有限按 0；[easing] 默认减速进入。
   *
   * alpha 与剩余位移同步推进：不会出现「已经全不透明但还在上移」的错位感。
   */
  fun fadeFrame(progress: Float, easing: OverlayEasing = OverlayEasing.DECELERATE): OverlayFadeFrame {
    val raw = if (progress.isFinite()) progress.coerceIn(0f, 1f) else 0f
    val eased = easing.transform(raw)
    return OverlayFadeFrame(alpha = eased, travelFraction = 1f - eased)
  }

  /**
   * 是否只是「同一段文字继续变长」（流式追加）。
   *
   * 为什么要判它：流式输出每个渲染节拍都会改文本，若每次改都做淡入淡出，文字会一路闪；
   * 追加视为同一段话继续长，直接同步绑定；只有真正换内容（重写/截断/清空）才值得过渡。
   */
  fun isStreamingGrow(previous: String, next: String): Boolean {
    if (previous.isEmpty() || next.length <= previous.length) return false
    return next.startsWith(previous)
  }
}
