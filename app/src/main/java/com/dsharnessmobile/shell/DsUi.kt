package com.dsharnessmobile.shell

import android.content.Context
import android.content.res.ColorStateList
import android.database.ContentObserver
import android.graphics.drawable.ClipDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.RippleDrawable
import android.view.Gravity
import android.os.Handler
import android.os.Looper
import android.provider.Settings
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
   *
   * 本函数是**判定**，不是**订阅**：它只在被调用的那一刻取样。常驻动画若只在启动时
   * 调一次本函数，用户在动画跑起来之后再去系统设置关动画就**停不下来**——那正是
   * [registerMotionListener] 存在的原因。
   */
  fun animationsEnabled(context: android.content.Context): Boolean = animationsEnabledFrom(
    animatorScale = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f),
    transitionScale = Settings.Global.getFloat(context.contentResolver, Settings.Global.TRANSITION_ANIMATION_SCALE, 1f),
    windowScale = Settings.Global.getFloat(context.contentResolver, Settings.Global.WINDOW_ANIMATION_SCALE, 1f),
    animatorsRunning = android.animation.ValueAnimator.areAnimatorsEnabled(),
  )

  /**
   * 纯判定（抽出以便 JVM 单测，不依赖 Android 运行时）。
   *
   * 四个入参就是 [animationsEnabled] 取样的全部事实：三个系统动画缩放值 + 动画器活动态。
   * 任一为 0（或动画器不活动）即禁止动效。
   */
  internal fun animationsEnabledFrom(
    animatorScale: Float,
    transitionScale: Float,
    windowScale: Float,
    animatorsRunning: Boolean,
  ): Boolean = animatorsRunning && animatorScale != 0f && transitionScale != 0f && windowScale != 0f

  /** 动效开关的订阅者。返回值用于注销；重复注销必须安全。 */
  private val motionListeners = mutableListOf<() -> Unit>()

  /** 单例观察器：监听三个系统动画缩放键，值真正翻转时才通知（避免同值抖动）。 */
  private var motionObserver: ContentObserver? = null
  private var motionObserverContext: Context? = null

  /**
   * 订阅「动效开关翻转」（**主线程调用**）。
   *
   * 为什么需要它：四个常驻 INFINITE 动画（悬浮球呼吸 / 面板待答呼吸 / 状态行扫光 /
   * 引导页状态点脉冲）原先都只在**启动动画那一刻**判一次 [animationsEnabled]。用户
   * 在动画跑起来之后去系统设置关动画，这些动画不会停 —— 144Hz 设备上等于永不空闲。
   *
   * 契约：
   *  - 注册时**不**立刻回调（调用方自己先按当前值渲染一次，避免重复启动）；
   *  - 三个缩放值任一发生变化且**生效值翻转**时回调一次；
   *  - 返回的 lambda 注销该监听；重复调用安全；
   *  - 最后一个监听注销时自动注销 ContentObserver，不留全局引用。
   *
   * 只在主线程使用：listener 会直接改 View 属性，跨线程会抛
   * CalledFromWrongThreadException。
   */
  fun registerMotionListener(context: Context, listener: () -> Unit): () -> Unit {
    val app = context.applicationContext ?: context
    motionListeners += listener
    if (motionObserver == null) {
      val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) = notifyMotionChanged()
      }
      // 三个键都要听：任一个被改都可能翻转生效值。
      for (key in MOTION_SETTING_KEYS) {
        runCatching { app.contentResolver.registerContentObserver(Settings.Global.getUriFor(key), false, observer) }
      }
      motionObserver = observer
      motionObserverContext = app
    }
    var removed = false
    return {
      if (!removed) {
        removed = true
        motionListeners.remove(listener)
        if (motionListeners.isEmpty()) unregisterMotionObserver()
      }
    }
  }

  /** 供 ContentObserver 与单测调用的通知入口（主线程）。 */
  internal fun notifyMotionChanged() {
    // 复制一份再遍历：listener 内部可能注销自己。
    for (listener in motionListeners.toList()) runCatching { listener() }
  }

  private fun unregisterMotionObserver() {
    val observer = motionObserver ?: return
    runCatching { motionObserverContext?.contentResolver?.unregisterContentObserver(observer) }
    motionObserver = null
    motionObserverContext = null
  }

  /**
   * 仅供单测：注册一个不依赖 Android Context 的监听器。
   *
   * 生产路径 [registerMotionListener] 需要 ContentResolver 注册观察器，在纯 JVM 单测里
   * 不可用；本入口只验证「订阅/注销/通知」这套语义本身（对称、幂等、可自注销）。
   */
  internal fun registerMotionListenerForTest(listener: () -> Unit): () -> Unit {
    motionListeners += listener
    var removed = false
    return {
      if (!removed) {
        removed = true
        motionListeners.remove(listener)
      }
    }
  }

  /** 仅供单测：清空订阅状态，避免测试间串味。 */
  internal fun resetMotionListenersForTest() {
    motionListeners.clear()
    unregisterMotionObserver()
  }

  /** 仅供单测：当前订阅数（负控用）。 */
  internal fun motionListenerCountForTest(): Int = motionListeners.size

  private val MOTION_SETTING_KEYS = arrayOf(
    Settings.Global.ANIMATOR_DURATION_SCALE,
    Settings.Global.TRANSITION_ANIMATION_SCALE,
    Settings.Global.WINDOW_ANIMATION_SCALE,
  )

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
