package com.dsharnessmobile.shell

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.animation.AlphaAnimation

/**
 * 光环维度协作类：低饱和辉光 drawable、四态切换（setHalo）、光环窗与球窗中心同步（syncHalo）、
 * 状态派生（deriveHalo 唯一权威）。
 * z 序约定（F8，硬约束）：状态切换只走 setHalo()/syncHalo()（换 drawable/updateViewLayout，不改 z 序），
 * 三窗口生命周期内禁止 remove/re-add 重排（光环窗必须先于球窗 addView，见 OverlayService.buildRoot）。
 */
class OverlayHalo(private val svc: OverlayService) {

  // 光晕渐变半径 24dp：球贴边时球心距屏边 = margin 8dp + 球半径 17dp = 25dp > 24dp，
  // 光晕圆任何贴边姿态下完整在屏内。「错位」根因（2026-09-02 用户实测）：halo 窗口 64dp
  // 以球心为中心，球贴边时窗口必然出屏 ≤7dp，径向渐变（旧半径=窗口半宽 32dp）被屏幕
  // 裁掉一角 → 可见光晕偏心。收窄渐变半径后，窗口出屏部分全透明 → 视觉恒同心。
  private val haloGlowPx by lazy { (24 * svc.resources.displayMetrics.density).toInt() }

  /** 光环窗口（NOT_TOUCHABLE 纯视觉）中心始终对齐球窗口中心。 */
  fun syncHalo() {
    val hp = svc.haloParams ?: return
    val p = svc.rootParams ?: return
    hp.x = p.x + svc.ballSizeDp / 2 - svc.haloSizeDp / 2
    hp.y = p.y + svc.ballSizeDp / 2 - svc.haloSizeDp / 2
    try { svc.haloView?.let { svc.wm.updateViewLayout(it, hp) } } catch (_: Exception) {}
  }

  /** 光环 drawable（径向渐变：透明 → 峰值 0.7≈球缘 → 透明；半径 24dp 恒不出屏被裁）。 */
  fun newHaloDrawable(halo: Halo): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.OVAL
    gradientType = GradientDrawable.RADIAL_GRADIENT
    gradientRadius = haloGlowPx.toFloat()
    setHaloColors(this, halo)
  }

  /** setColors 二参形态（自定义渐变 stop 位置）仅 API 29+；26-28 退三等分 stop。 */
  private fun setHaloColors(g: GradientDrawable, halo: Halo) {
    val transparent = Color.argb(0, 255, 255, 255)
    if (android.os.Build.VERSION.SDK_INT >= 29) {
      // 2026-09-10 用户反馈「光晕不够可见」：峰值内移到 0.45、再加一段 0.74 的过渡，
      // 可见环更宽更亮。半径保持 24dp 不变——超过球心到屏幕边的 25dp 会在贴边时被裁
      // （旧「吸边后光环偏心」根因，见 haloGlowPx 注释）。
      g.setColors(
        intArrayOf(transparent, halo.color, halo.fade, transparent),
        floatArrayOf(0f, 0.45f, 0.74f, 1f),
      )
    } else {
      g.setColors(intArrayOf(transparent, halo.color, transparent))
    }
  }

  fun setHalo(halo: Halo) {
    svc.main.post {
      val hv = svc.haloView ?: return@post
      val g = hv.background as? GradientDrawable ?: return@post
      setHaloColors(g, halo)
      // 脉动：WORKING = 缓呼吸（spring 风格）；PENDING = 更快更深的琥珀脉（M8，0.13.8 G3 余项，
      // 待答是「要人动手」的状态，脉动节奏刻意比工作态更急）。IDLE 静止。
      // 统一受 DsUi.animationsEnabled 降级（系统关动画/省电模式 → 全部静止，不耗帧）。
      val pulse = halo == Halo.WORKING || halo == Halo.PENDING
      val anim = AlphaAnimation(1f, if (halo == Halo.PENDING) 0.55f else 0.7f).apply {
        duration = if (halo == Halo.PENDING) 900 else 1100
        repeatMode = AlphaAnimation.REVERSE
        repeatCount = if (pulse) AlphaAnimation.INFINITE else 0
      }
      hv.animation = null
      if (pulse && DsUi.animationsEnabled(svc)) hv.startAnimation(anim) else hv.alpha = 1f
    }
  }

  /** 光环状态派生（唯一权威）。探活 tick 与事件渲染必须共用——探活若自带判定会绕过
   *  PENDING（2026-09-05 实测回归：待答琥珀光环每 10s 被探活盖回白色，「展开面板才见黄」）。 */
  fun deriveHalo(): Halo = when {
    !svc.engineRunning -> Halo.ERROR
    svc.pendingKind.isNotEmpty() -> Halo.PENDING
    svc.sessionBusy -> Halo.WORKING
    else -> Halo.IDLE
  }
}

// ── 光环四态（低饱和：融合优先；2026-09-10 按用户反馈整体提亮一档） ──────────
// PENDING = 待用户处理（AI 提问 / 权限审批等待应答）——低饱和琥珀黄（用户拍板新增）。
// fade = 同一色相的次强档，用于让可见环更宽（见 setHaloColors 的四段 stop）。
enum class Halo(val color: Int, val fade: Int) {
  IDLE(Color.argb(96, 255, 255, 255), Color.argb(58, 255, 255, 255)),
  WORKING(Color.argb(170, 92, 132, 255), Color.argb(102, 92, 132, 255)),
  PENDING(Color.argb(205, 235, 190, 60), Color.argb(123, 235, 190, 60)),
  ERROR(Color.argb(160, 224, 72, 72), Color.argb(96, 224, 72, 72)),
}
