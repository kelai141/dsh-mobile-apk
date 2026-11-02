package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 常驻 INFINITE 动画的**动效开关契约**（0.14.x 流畅度审计 Top 5）。
 *
 * 背景（实测口径）：四个常驻无限动画 —— 悬浮球光环呼吸、面板待答呼吸、状态行扫光、
 * 引导页状态点脉冲 —— 原先都只在**启动动画那一刻**判一次 DsUi.animationsEnabled。
 * 用户在动画跑起来之后再去系统设置关动画，它们不会停；144Hz 设备上等于永不空闲。
 * 其中引导页状态点脉冲更是全仓唯一**完全未受门控**的一处。
 *
 * 本文件守三件事：
 *  1. 纯判定逻辑：三个缩放值任一为 0 / 动画器不活动 → 禁止动效（四路输入穷举）。
 *  2. 订阅机制：注册/注销对称、重复注销安全、最后一个注销后计数归零。
 *  3. 四个动画落点**源码级**都真的接上了门控与订阅（防止后人删掉一处而门禁全绿）。
 */
class MotionGateContractTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    return (candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")).readText()
  }

  /** 去掉注释行——与全仓门禁「只看代码」的口径一致。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot { it.trimStart().startsWith("//") || it.trimStart().startsWith("*") || it.trimStart().startsWith("/*") }
    .joinToString("\n")

  // ── 1. 纯判定逻辑 ────────────────────────────────────────────────

  @Test
  fun allScalesOnAndAnimatorsRunning_enablesMotion() {
    assertTrue(DsUi.animationsEnabledFrom(1f, 1f, 1f, animatorsRunning = true))
  }

  @Test
  fun anyZeroScale_disablesMotion() {
    assertFalse("ANIMATOR_DURATION_SCALE=0", DsUi.animationsEnabledFrom(0f, 1f, 1f, true))
    assertFalse("TRANSITION_ANIMATION_SCALE=0", DsUi.animationsEnabledFrom(1f, 0f, 1f, true))
    assertFalse("WINDOW_ANIMATION_SCALE=0", DsUi.animationsEnabledFrom(1f, 1f, 0f, true))
  }

  @Test
  fun animatorsDisabled_disablesMotionEvenWithFullScales() {
    // 省电模式等：缩放值仍是 1，但 ValueAnimator 不活动。
    assertFalse(DsUi.animationsEnabledFrom(1f, 1f, 1f, animatorsRunning = false))
  }

  // ── 2. 订阅机制 ──────────────────────────────────────────────────

  @Test
  fun unsubscribeIsSymmetricAndIdempotent() {
    DsUi.resetMotionListenersForTest()
    var calls = 0
    val off = DsUi.registerMotionListenerForTest { calls++ }
    assertEquals(1, DsUi.motionListenerCountForTest())

    DsUi.notifyMotionChanged()
    assertEquals("注册后通知应回调一次", 1, calls)

    off()
    assertEquals("注销后计数应归零", 0, DsUi.motionListenerCountForTest())
    DsUi.notifyMotionChanged()
    assertEquals("注销后不得再回调", 1, calls)

    off() // 重复注销必须安全
    assertEquals(0, DsUi.motionListenerCountForTest())
  }

  @Test
  fun listenerMayUnsubscribeItselfDuringNotification() {
    DsUi.resetMotionListenersForTest()
    var calls = 0
    var off: (() -> Unit)? = null
    off = DsUi.registerMotionListenerForTest { calls++; off?.invoke() }
    DsUi.notifyMotionChanged()
    assertEquals(1, calls)
    DsUi.notifyMotionChanged()
    assertEquals("自注销后不应再被调用", 1, calls)
    assertEquals(0, DsUi.motionListenerCountForTest())
  }

  // ── 3. 四个落点的源码契约（负控：删掉任一处的订阅/门控本测试应变红）────

  @Test
  fun dsUiExposesListenableGate() {
    val src = codeOnly(source("DsUi.kt"))
    assertTrue("DsUi 必须提供 registerMotionListener", src.contains("fun registerMotionListener("))
    assertTrue("DsUi 必须用 ContentObserver 监听系统设置", src.contains("ContentObserver"))
    assertTrue("必须监听 ANIMATOR_DURATION_SCALE", src.contains("ANIMATOR_DURATION_SCALE"))
    assertTrue("必须监听 TRANSITION_ANIMATION_SCALE", src.contains("TRANSITION_ANIMATION_SCALE"))
    assertTrue("必须监听 WINDOW_ANIMATION_SCALE", src.contains("WINDOW_ANIMATION_SCALE"))
  }

  @Test
  fun allFourInfiniteAnimationsAreGatedAndSubscribed() {
    // 每个落点都必须：① 判 DsUi.animationsEnabled / animationsOn；② 订阅 registerMotionListener。
    val sites = mapOf(
      "OverlayHalo.kt" to "悬浮球光环呼吸",
      "OverlayPanel.kt" to "面板待答呼吸",
      "ShimmerTextView.kt" to "状态行扫光",
      "GuidePageRenderer.kt" to "引导页状态点脉冲",
    )
    for ((file, label) in sites) {
      val src = codeOnly(source(file))
      assertTrue("$label（$file）必须订阅动效开关翻转", src.contains("registerMotionListener"))
      assertTrue(
        "$label（$file）必须按 DsUi.animationsEnabled / animationsOn 门控",
        src.contains("DsUi.animationsEnabled") || src.contains("animationsOn()") || src.contains("animationsEnabled()"),
      )
    }
  }

  @Test
  fun guidePulseIsNoLongerUngated() {
    // 负控锚点：本处原先完全没有动画开关判定，是最典型的回归点。
    val src = codeOnly(source("GuidePageRenderer.kt"))
    val pulse = src.substringAfter("private fun setStatusPulse(", "")
    assertTrue("setStatusPulse 必须存在", pulse.isNotEmpty())
    assertTrue("setStatusPulse 必须在启动前判动效开关", pulse.contains("DsUi.animationsEnabled"))
  }

  @Test
  fun shimmerReusesSingleMatrixInstance() {
    // 每帧 new Matrix() 在 1800ms 内约 60-120 次分配；144Hz 下是纯 GC 压力。
    val src = codeOnly(source("ShimmerTextView.kt"))
    val listener = src.substringAfter("addUpdateListener", "")
    assertTrue("updateListener 里不得再 new Matrix()", !listener.contains("Matrix()"))
    assertTrue("必须复用实例字段 matrix", src.contains("private val matrix"))
  }

  @Test
  fun subscriptionsAreReleasedOnTeardown() {
    // 泄漏防线：订阅了就必须有对应的注销点。
    assertTrue("OverlayHalo 必须有 stopMotionWatch", codeOnly(source("OverlayHalo.kt")).contains("fun stopMotionWatch"))
    assertTrue("OverlayPanel 必须有 stopMotionWatch", codeOnly(source("OverlayPanel.kt")).contains("fun stopMotionWatch"))
    assertTrue("ShimmerTextView 必须在 onDetachedFromWindow 注销",
      codeOnly(source("ShimmerTextView.kt")).substringAfter("onDetachedFromWindow").contains("motionUnsubscribe"))
    assertTrue("GuidePageRenderer 的 cancelPulse 必须注销订阅",
      codeOnly(source("GuidePageRenderer.kt")).substringAfter("fun cancelPulse(").contains("stopMotionWatch"))
    val service = codeOnly(source("OverlayService.kt")).substringAfter("override fun onDestroy(")
    assertTrue("OverlayService.onDestroy 必须注销两个订阅",
      service.contains("halo.stopMotionWatch()") && service.contains("panel.stopMotionWatch()"))
  }
}