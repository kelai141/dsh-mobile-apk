package com.dsharnessmobile.shell

import kotlin.math.ceil
import kotlin.math.max

/**
 * 底部系统栏预留的两条通道（issue #783 缺陷 A 的壳侧一半）。
 *
 * 缺陷形态：页面只有一条底部通道 --dsh-android-system-bottom，取值是
 * `max(navigationBars.bottom, mandatorySystemGestures.bottom)`。后者是**手势热区**，
 * 不是遮挡物：AOSP 手势导航的导航条窗口是 `FLAG_NOT_TOUCHABLE | FLAG_NOT_FOCUSABLE`
 * 且合成在 `Z=-1`（永不遮挡页面），它可触摸的那条 48dp 带子是以
 * `mandatorySystemGestures` 另行上报的。于是「屏幕上没有任何系统条」的手势模式下，
 * 交互面仍被要求让出一条 46 CSS px 的纯背景带：抽屉底部（mobile-form.css.ts 的
 * padding-bottom）与输入卡下方各一段。
 *
 * 修法：拆成两条语义明确的通道，见 [Channels]。
 *
 * 手势热区仍可用于**手势排除**（sidebar-gestures.ts 的 32 CSS px 边缘排除是另一条通道），
 * 但不再当作遮挡高度。
 */
internal object BottomInsetPolicy {

  /**
   * 两条底部通道（CSS px），由 [channels] 一次算出，避免两处各自取 max 再漂移。
   *
   * system 是保守值 --dsh-android-system-bottom：系统栏与手势热区取大。给「内容贴底、
   * 但要避开手势把手」的表面（底部 sheet 的 peek、气泡弹层上限、市场滚动内边距）——它们
   * 不与系统栏争抢空间，多让一点只是留白，不会把交互元素推进遮挡区。
   * navBar 是精确值 --dsh-android-navbar-bottom：只算 navigationBars。给「不得被系统
   * 盖住」的交互面（输入卡、抽屉）。手势模式下它是 0 ⇒ 预留归零。
   */
  internal data class Channels(val system: Int, val navBar: Int)

  /**
   * @param barsBottomPx WindowInsetsCompat.Type.navigationBars().bottom（物理 px）
   * @param gestureBottomPx WindowInsetsCompat.Type.mandatorySystemGestures().bottom（物理 px）
   * @param density resources.displayMetrics.density
   */
  fun channels(barsBottomPx: Int, gestureBottomPx: Int, density: Float): Channels =
    Channels(
      system = pxToCssPx(max(barsBottomPx, gestureBottomPx), density),
      navBar = pxToCssPx(barsBottomPx, density),
    )

  /** 物理 px → 整 CSS px，向上取整（不足一像素也要让开，不能压住内容）。 */
  fun pxToCssPx(physicalPx: Int, density: Float): Int {
    if (physicalPx <= 0 || density <= 0f) return 0
    return ceil(physicalPx.toDouble() / density.toDouble()).toInt()
  }
}
