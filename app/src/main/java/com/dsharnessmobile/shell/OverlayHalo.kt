package com.dsharnessmobile.shell

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.view.animation.AlphaAnimation

/**
 * 光环维度协作类：低饱和辉光 drawable、四态切换（setHalo）、光环窗与球窗中心同步（syncHalo）、
 * 状态派生（deriveHalo 唯一权威）。
 * z 序约定（F8，硬约束）：状态切换只走 setHalo()/syncHalo()（换 drawable/updateViewLayout，不改 z 序），
 * 三窗口生命周期内禁止 remove/re-add 重排（光环窗必须先于球窗 addView，见 OverlayService.buildRoot）。
 *
 * 0.14.1 块I（状态描边 ring）：ring 与 glow **合成在同一个 haloView 的 background**（LayerDrawable 两层），
 * 不是第二个窗口——这样 ① 脉冲动画（挂在 View 上）天然同相位，无需第二段动画代码；② 不触碰
 * FLAG_NOT_TOUCHABLE 触摸语义与 F8 z 序；③ 不新增窗口（窗口数恒为 3）。
 * ring 的颜色**不另立色表**：setHaloColors 里与 glow 共用同一个 Halo 形参，改色入口仍只有
 * newHaloDrawable / setHalo 两处（源码契约测试 CallSiteContractTest 的 I-A2/I-A3 组锁死）。
 */
class OverlayHalo(private val svc: OverlayService) {

  companion object {
    /** LayerDrawable 层索引。用索引而非 res id：本工程无 ids.xml，不为两层 drawable 新建资源面。 */
    private const val LAYER_GLOW = 0
    private const val LAYER_RING = 1
  }

  // 光晕渐变半径 24dp：球贴边时球心距屏边 = margin 8dp + 球半径 17dp = 25dp > 24dp，
  // 光晕圆任何贴边姿态下完整在屏内。「错位」根因（2026-09-02 用户实测）：halo 窗口 64dp
  // 以球心为中心，球贴边时窗口必然出屏 ≤7dp，径向渐变（旧半径=窗口半宽 32dp）被屏幕
  // 裁掉一角 → 可见光晕偏心。收窄渐变半径后，窗口出屏部分全透明 → 视觉恒同心。
  private val haloGlowPx by lazy { (24 * svc.resources.displayMetrics.density).toInt() }

  // ring 几何预算（0.14.1 块I，全部由既有尺寸推导，不新增可调参数面）：
  //   窗口半宽 haloHalf = 25dp（= 贴边 margin 8dp + 球半径 17dp；整数恒等式见 OverlayService.haloSizeDp）
  //   球半宽  ballHalf = 17dp  →  可用环带宽度 = margin = 8dp
  //   描边宽 2dp、中线内缩 4.5dp → ring 外缘 = 25 - 4.5 = 20.5dp，内缘 = 18.5dp
  //   落在 (17, 25) 内：既不压到白球（球面 17dp 以内被球覆盖），也不被窗口裁剪。
  //   「更明显」的第三档来自硬边：glow 是径向渐变（峰值 alpha 随 stop 衰减），ring 是均匀描边。
  private val haloRingPx by lazy { (2 * svc.resources.displayMetrics.density).toInt() }
  private val haloRingInsetPx by lazy { (4.5 * svc.resources.displayMetrics.density).toInt() }

  /** 光环窗口（NOT_TOUCHABLE 纯视觉）中心始终对齐球窗口中心。 */
  fun syncHalo() {
    val hp = svc.haloParams ?: return
    val p = svc.rootParams ?: return
    hp.x = p.x + svc.ballSizeDp / 2 - svc.haloSizeDp / 2
    hp.y = p.y + svc.ballSizeDp / 2 - svc.haloSizeDp / 2
    try { svc.haloView?.let { svc.wm.updateViewLayout(it, hp) } } catch (_: Exception) {}
  }

  /**
   * 光环 drawable = 两层合成（LayerDrawable）：
   * layer 0 = glow（径向渐变，透明 → 峰值≈球缘 → 透明；半径 24dp 恒不出屏被裁）；
   * layer 1 = ring（**硬边** OVAL 描边，颜色与 glow 同源自 Halo.color）。
   * 初值经 setHaloColors 写入，与运行期改色走**同一个函数**（防止两条改色路径漂移）。
   */
  fun newHaloDrawable(halo: Halo): LayerDrawable {
    val glow = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      gradientType = GradientDrawable.RADIAL_GRADIENT
      gradientRadius = haloGlowPx.toFloat()
    }
    val ring = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(Color.TRANSPARENT)
      setStroke(haloRingPx, halo.color)
    }
    return LayerDrawable(arrayOf(glow, ring)).apply {
      setLayerInset(LAYER_RING, haloRingInsetPx, haloRingInsetPx, haloRingInsetPx, haloRingInsetPx)
      setHaloColors(this, halo)
    }
  }

  /**
   * 同时写入两层：glow 的渐变 stop + ring 的描边色。**Halo 是唯一色源**——ring 直接复读
   * `halo.color`（字面同一存储，不存在漂移的可能），不得在此另立第二张色表。
   * setColors 二参形态（自定义渐变 stop 位置）仅 API 29+；26-28 退三等分 stop。
   */
  private fun setHaloColors(layers: LayerDrawable, halo: Halo) {
    val glow = layers.getDrawable(LAYER_GLOW) as? GradientDrawable
    if (glow == null) {
      diagnose("glow layer is not a GradientDrawable")
      return
    }
    val ring = layers.getDrawable(LAYER_RING) as? GradientDrawable
    if (ring == null) {
      diagnose("ring layer is not a GradientDrawable")
      return
    }
    val transparent = Color.TRANSPARENT
    if (android.os.Build.VERSION.SDK_INT >= 29) {
      // 2026-09-10 用户反馈「光晕不够可见」：峰值内移到 0.45、再加一段 0.74 的过渡，
      // 可见环更宽更亮。半径保持 24dp 不变——超过球心到屏幕边的 25dp 会在贴边时被裁
      // （旧「吸边后光环偏心」根因，见 haloGlowPx 注释）。
      glow.setColors(
        intArrayOf(transparent, halo.color, halo.fade, transparent),
        floatArrayOf(0f, 0.45f, 0.74f, 1f),
      )
    } else {
      glow.setColors(intArrayOf(transparent, halo.color, transparent))
    }
    // ring 与 glow 在同一次调用内改色、共用同一个 halo 形参 = A3「同源」的结构性保证。
    ring.setStroke(haloRingPx, halo.color)
  }

  /** 改色/取层的失败痕迹（0.14.1 块I：取代旧 `?: return@post` 式静默失败——坑 61 判据）。 */
  private fun diagnose(msg: String) {
    LogCollector.log("dsh-overlay-halo", msg)
  }

  fun setHalo(halo: Halo) {
    svc.main.post {
      val hv = svc.haloView ?: return@post
      // 0.14.1 块I：旧实现是 `val g = hv.background as? GradientDrawable ?: return@post`。
      // 合成两层后该式恒为 null，会把每一次改色请求**静默吞掉**（不抛错、不日志、门禁全绿），
      // 表现为「状态不更新」。故显式取层并在取不到时留下可诊断痕迹。
      val layers = hv.background as? LayerDrawable
      if (layers == null) {
        diagnose("halo background is not a LayerDrawable (" + (hv.background?.javaClass?.simpleName ?: "null") + ")")
        return@post
      }
      setHaloColors(layers, halo)
      // 脉动：WORKING = 缓呼吸（spring 风格）；PENDING = 更快更深的琥珀脉（M8，0.13.8 G3 余项，
      // 待答是「要人动手」的状态，脉动节奏刻意比工作态更急）。IDLE 静止。
      // 统一受 DsUi.animationsEnabled 降级（系统关动画/省电模式 → 全部静止，不耗帧）。
      // 0.14.1 块I：动画仍挂在 haloView 这个 View 上——ring 与 glow 同在该 View 的 background 内，
      // 故脉冲对两者天然同相位，**此处不改任何脉冲参数**。
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
   *  PENDING（2026-09-05 实测回归：待答琥珀光环每 10s 被探活盖回白色，「展开面板才见黄」）。
   *  0.14.1 块I：ring 不引入任何独立判定，只消费本函数的返回值。 */
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
//
// 0.14.1 块I：**必须用纯 Kotlin ARGB 字面量，不得改回 android.graphics.Color.argb(...)**。
// 真因（反假绿）：app/build.gradle.kts 的 unitTests.isReturnDefaultValues = true 把 android.graphics.Color
// 打桩返回 0 → 枚举在 JVM 单测里全部取值为 0 → 任何「ring 色 == halo 色」断言恒真 = 一道永远不会
// 失败的防线。字面量换算口径 argb = (a shl 24) or (r shl 16) or (g shl 8) or b，逐字节与改前等价。
//
// 逐条人工转写极易把 g/b 两个字节写反（本轮 PENDING 实际踩到：205,235,190,60 的正确拆解是
// a=CD r=EB **g=BE** **b=3C** → 0xCDEBBE3C，曾误写成 0xCDEBBC3C）。改这些字面量后**必须**
// 跑 OverlayHaloInvariantTest.argbLiteralsEqualThePreviousColorArgbValues 逐字节复核。
enum class Halo(val color: Int, val fade: Int) {
  IDLE(0x60FFFFFF.toInt(), 0x3AFFFFFF.toInt()),
  WORKING(0xAA5C84FF.toInt(), 0x665C84FF.toInt()),
  PENDING(0xCDEBBE3C.toInt(), 0x7BEBBE3C.toInt()),
  ERROR(0xA0E04848.toInt(), 0x60E04848.toInt()),
}
