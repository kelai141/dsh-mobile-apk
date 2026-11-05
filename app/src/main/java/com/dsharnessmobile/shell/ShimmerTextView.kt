package com.dsharnessmobile.shell

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.LinearGradient
import android.graphics.Shader
import android.util.AttributeSet
import android.widget.TextView

/**
 * DeepSeek 官方「Deep diving...」动效的原生复刻（PRD-overlay-v2 §3.5；调研
 * .tmp-verify/deep-diving-motion-research.md 方案 A）。
 *
 * 官方 CSS（ChatView.module.css .turnStatus）：品牌蓝渐变扫光文字——
 * gradient stops D500 0%→40% / D200 50% / D500 60%→100%（#4176E6 与 #D3E2FF，
 * 子代理实测取证），background-size 250%、background-position 100%→0%、
 * 1.8s linear infinite。Android 等价：TextView + 动态 LinearGradient Shader
 * （渐变宽 2.5W、水平平移 -1.5W→0、TileMode.REPEAT），shader 只落在字形
 * alpha 上（等同 CSS background-clip:text，无需 XferMode）。
 *
 * reduced-motion：系统动画关闭时静态渐变（D200 带定格文字中部，官方同款降级）。
 */
class ShimmerTextView @JvmOverloads constructor(
  context: Context,
  attrs: AttributeSet? = null,
) : TextView(context, attrs) {

  private val brand500 = 0xFF4176E6.toInt()
  private val brand200 = 0xFFD3E2FF.toInt()

  private var animator: ValueAnimator? = null
  private var running = false

  /** 扫光用的唯一 Matrix 实例（每帧复用，避免高频分配）。 */
  private val matrix = android.graphics.Matrix()

  /** 动效开关订阅的注销句柄（onAttached 注册、onDetached 注销）。 */
  private var motionUnsubscribe: (() -> Unit)? = null

  /** 启动/停止扫光（工作中 true；空闲/离线 false → 静态文本色）。 */
  fun setShimmering(on: Boolean) {
    if (on == running) return
    running = on
    if (on && animationsEnabled()) {
      startShimmer()
    } else {
      animator?.cancel(); animator = null
      // 静态渐变：D200 带定格中部（官方 reduced-motion 等价：size 100%，D500 主色）
      paint.shader = null
      setTextColor(brand500)
      invalidate()
    }
  }

  private fun animationsEnabled(): Boolean {
    val cr = context.contentResolver
    val scale = android.provider.Settings.Global.getFloat(
      cr, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f,
    )
    val trans = android.provider.Settings.Global.getFloat(
      cr, android.provider.Settings.Global.TRANSITION_ANIMATION_SCALE, 1f,
    )
    val win = android.provider.Settings.Global.getFloat(
      cr, android.provider.Settings.Global.WINDOW_ANIMATION_SCALE, 1f,
    )
    return scale != 0f && trans != 0f && win != 0f
  }

  private fun startShimmer() {
    val w = width.coerceAtLeast(1)
    // 渐变宽 2.5W，translate -1.5W→0（等价 background-position 100%→0%：
    // 偏移 = (W-2.5W)*p = -1.5W*p；D200 高光带自左向右扫过文字）
    val gradient = LinearGradient(
      -1.5f * w, 0f, w.toFloat(), 0f,
      intArrayOf(brand500, brand500, brand200, brand500, brand500),
      floatArrayOf(0f, 0.4f, 0.5f, 0.6f, 1f),
      Shader.TileMode.REPEAT,
    )
    animator = ValueAnimator.ofFloat(0f, 1f).apply {
      duration = 1800
      repeatCount = ValueAnimator.INFINITE
      addUpdateListener { a ->
        val p = a.animatedValue as Float
        // 复用同一个 Matrix 实例：原先每帧 new 一个（1800ms 内约 60-120 次分配），
        // 在 144Hz 下是纯粹的 GC 压力，对结果没有任何影响（setLocalMatrix 是覆盖语义）。
        matrix.setTranslate(-1.5f * w * p, 0f)
        paint.shader = gradient
        gradient.setLocalMatrix(matrix)
        invalidate()
      }
      start()
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    // 用户可能在动画跑起来之后才去系统设置关动画：订阅开关翻转，立刻停下。
    motionUnsubscribe?.invoke()
    motionUnsubscribe = DsUi.registerMotionListener(context) { applyShimmerState() }
  }

  override fun onDetachedFromWindow() {
    motionUnsubscribe?.invoke(); motionUnsubscribe = null
    animator?.cancel(); animator = null
    super.onDetachedFromWindow()
  }

  /**
   * 按**当前**开关状态落实渲染：开 → 扫光，关 → 静态渐变。
   *
   * 与 [setShimmering] 的区别：[setShimmering] 由业务状态驱动且带幂等短路
   * （on == running 时直接返回），而本函数是**开关翻转**的响应——此时业务状态
   * running 没变，但渲染必须跟着变，所以不能走那个短路。
   */
  private fun applyShimmerState() {
    val on = running && animationsEnabled()
    if (on) {
      if (animator == null) startShimmer()
    } else {
      animator?.cancel(); animator = null
      paint.shader = null
      setTextColor(brand500)
      invalidate()
    }
  }
}