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
 * 这条分界保证「换形态 = 重建窗口」的实现不被视图层偷偷改成「只换 View」。
 *
 * @param context 取资源/颜色/density 的上下文（壳侧传 Service，/ Theme 不需要 Activity）。
 * @param style 入口形态；决定窗口尺寸与视觉，创建后不可变（换形态必须重建入口窗）。
 */
internal class OverlayEntryView(context: Context, val style: OverlayEntryStyle) {

  private val density = context.resources.displayMetrics.density

  /** 入口视图；尺寸按形态固定，调用方直接作为窗口 contentView（窗口 = 可视，不留隐形触区）。 */
  val view: View = when (style) {
    OverlayEntryStyle.BALL -> buildBall(context)
    OverlayEntryStyle.STRIP -> buildStrip(context)
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
    val stripWidthPx = dp(8)
    val windowHeightPx = dp(88)
    val visibleHeightPx = dp(64)
    val strip = View(context).apply {
      background = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = context.resources.getDimension(R.dimen.ds_radius_pill)
        setColor(OverlayTheme(context).themeColors().recallStrip)
      }
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

  /** dp 换算统一走整数截断（与仓内 ballSizeDp / edgeMarginPx 同口径）。 */
  private fun dp(value: Int): Int = (value * density).toInt()
}
