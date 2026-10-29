package com.dsharnessmobile.shell

import android.content.res.ColorStateList
import android.graphics.drawable.ClipDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.RippleDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.animation.PathInterpolator

/** Shared drawables, motion, and press feedback for the native shell UI. */
internal object DsUi {
  val ease = PathInterpolator(0.32f, 0.72f, 0f, 1f)

  /**
   * 动效总开关（0.13.8 G3-M11，降级统一入口）：系统「关闭动画」三开关任一关闭、
   * 或 ValueAnimator 不活动（省电模式等）→ 所有 overlay 动效直接设终态。
   * 复用 ShimmerTextView.kt 的既有判定口径（单一来源原则）。
   */
  fun animationsEnabled(context: android.content.Context): Boolean {
    if (!android.animation.ValueAnimator.areAnimatorsEnabled()) return false
    val resolver = context.contentResolver
    val scale = { key: String -> android.provider.Settings.Global.getFloat(resolver, key, 1f) }
    return scale(android.provider.Settings.Global.ANIMATOR_DURATION_SCALE) != 0f &&
      scale(android.provider.Settings.Global.TRANSITION_ANIMATION_SCALE) != 0f &&
      scale(android.provider.Settings.Global.WINDOW_ANIMATION_SCALE) != 0f
  }

  fun roundRect(
    color: Int,
    radius: Float,
    strokeColor: Int? = null,
    strokePx: Int = 1,
  ): GradientDrawable = GradientDrawable().apply {
    setColor(color)
    cornerRadius = radius
    if (strokeColor != null) setStroke(strokePx, strokeColor)
  }

  fun oval(color: Int): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.OVAL
    setColor(color)
  }

  fun ripple(fill: GradientDrawable, rippleColor: Int): RippleDrawable {
    val mask = GradientDrawable().apply {
      setColor(0xFFFFFFFF.toInt())
      cornerRadius = fill.cornerRadius
    }
    return RippleDrawable(ColorStateList.valueOf(rippleColor), fill, mask)
  }

  fun progressLayer(trackColor: Int, fillColor: Int, radius: Float): LayerDrawable {
    val track = GradientDrawable().apply {
      setColor(trackColor)
      cornerRadius = radius
    }
    val fill = GradientDrawable().apply {
      setColor(fillColor)
      cornerRadius = radius
    }
    val clip = ClipDrawable(fill, Gravity.START, ClipDrawable.HORIZONTAL)
    return LayerDrawable(arrayOf(track, clip)).apply {
      setId(0, android.R.id.background)
      setId(1, android.R.id.progress)
    }
  }

  // ── 设置页卡片外壳（与 WebView 侧同一套规格）────────────────────────────────
  //
  // 基准是 WebView 侧设置页的卡片外壳（#860 之后「应用更新」分区就用它）：
  //   dsh-client-ui-responsive/src/client/dev-section/dev-section.css.ts 的 .dsh-screen-control-card
  //     padding: 12px; border: 1px solid var(--dsw-alias-border-l3);
  //     border-radius: 12px; background: var(--dsw-alias-bg-layer-2);
  // 上游令牌取值（packages/client/ui-theme/src/styles/design-platform.css 与 base.css）：
  //   --dsw-alias-bg-layer-2  浅色 = neutral-bluish-00 rgb(255,255,255) / 深色 = neutral-bluish-850 rgb(44,44,46)
  //   --dsw-alias-border-l3   浅色 = rgba(0,0,0,0.12) / 深色 = rgba(255,255,255,0.16)
  //   --dsw-radius-md         12px（base.css；卡片外壳用的就是这一档）
  //
  // 原生侧对应关系（本函数是唯一落点，调用方不再各自写数值）：
  //   背景 bg-layer-2  -> R.color.ds_surface（浅 #FFFFFF / 深 #1C1C1E，同属「卡片面」语义）
  //   描边 border-l3   -> R.color.ds_hairline（浅 #1A000000 约 0.10 / 深 #2EFFFFFF 约 0.18）+ 1 物理像素
  //   圆角 12px        -> R.dimen.ds_radius_settings_card（12dp）

  /**
   * 设置页卡片外壳的背景：卡片面 + 圆角 + 描边。
   *
   * 为什么不能拿现有的两档圆角近似：WebView 侧卡片是 12px（上游 --dsw-radius-md），而原生侧
   * ds_radius_sm 是 8dp（对应 --dsw-radius-sm）、ds_radius_md 是 16dp（对应 --dsw-radius-lg），
   * 中间这一档此前缺位。任取一档都会让两侧卡片差 4dp，而这两个入口在同一台设备上肉眼可比。
   *
   * @param context 取资源与颜色的上下文。
   * @returns 已设好填充、圆角与描边的 drawable。
   */
  fun settingsCardBackground(context: android.content.Context): GradientDrawable {
    val res = context.resources
    return roundRect(
      context.getColor(R.color.ds_surface),
      res.getDimension(R.dimen.ds_radius_settings_card),
      context.getColor(R.color.ds_hairline),
      res.displayMetrics.density.toInt().coerceAtLeast(1),
    )
  }

  /**
   * 设置页卡片外壳的内边距（左、上、右、下）——WebView 侧是 padding: 12px，四边同值。
   *
   * @param context 取资源的上下文。
   * @returns 四个方向的内边距（像素），顺序为左、上、右、下（View.setPadding 的口径）。
   */
  fun settingsCardPaddingPx(context: android.content.Context): IntArray {
    val p = context.resources.getDimensionPixelSize(R.dimen.ds_space_12)
    return intArrayOf(p, p, p, p)
  }

  fun bindPressScale(view: View, scale: Float = 0.975f) {
    view.setOnTouchListener { v, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN ->
          v.animate().scaleX(scale).scaleY(scale).setDuration(90).setInterpolator(ease).start()
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL ->
          v.animate().scaleX(1f).scaleY(1f).setDuration(160).setInterpolator(ease).start()
      }
      false
    }
  }
}
