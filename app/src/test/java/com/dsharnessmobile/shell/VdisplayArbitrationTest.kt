package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Multi-viewer surface arbitration: one Surface can never be silently attached to two viewers.
 *
 * The controller-level integration is exercised on device; this keeps the fail-closed rule itself
 * testable without an Android display.
 */
class VdisplayArbitrationTest {

  @Test
  fun freeTargetAttachesToFirstViewer() {
    assertEquals(
      VdisplayController.ViewerArbitration.Verdict.ATTACH,
      VdisplayController.ViewerArbitration.decide(null, "viewer-a"),
    )
  }

  @Test
  fun sameViewerMayRebindIdempotently() {
    assertEquals(
      VdisplayController.ViewerArbitration.Verdict.ATTACH,
      VdisplayController.ViewerArbitration.decide("viewer-a", "viewer-a"),
    )
  }

  @Test
  fun foreignViewerIsRefusedInsteadOfStealingTheSurface() {
    assertEquals(
      VdisplayController.ViewerArbitration.Verdict.OCCUPIED,
      VdisplayController.ViewerArbitration.decide("viewer-a", "viewer-b"),
    )
  }

  @Test
  fun releaseReturnsTargetToTheFreePool() {
    // Owner cleared -> next viewer (including the previous foreign one) attaches.
    assertEquals(
      VdisplayController.ViewerArbitration.Verdict.ATTACH,
      VdisplayController.ViewerArbitration.decide(null, "viewer-b"),
    )
  }

  /**
   * D4（0.14.11）：presenting 由「viewerSurface 非空」推出；旧写法先落归属、再 setSurface 并把失败
   * runCatching 吞掉 ⇒ 黑屏也报「已挂」（连验证脚本都判 PASS）。这里钉住顺序与外显原因：
   * 必须先请求输出面、成功才落归属，失败要回结构化 code。
   */
  @Test
  fun attachOnlyClaimsTheSurfaceAfterTheDisplayAcceptsIt() {
    val controller = source("src/main/java/com/dsharnessmobile/shell/VdisplayController.kt")
    val applied = controller.indexOf("val applied = runCatching { record.display.setSurface(surface) }.isSuccess")
    val claim = controller.indexOf("record.viewerSurface = surface")
    assertTrue("必须存在「先请求输出面」这一步", applied >= 0)
    assertTrue("必须先请求输出面、成功后才落归属（旧顺序 = 黑屏也报已挂）", applied in 0 until claim)
    assertTrue("失败要回结构化原因，不能静默", controller.contains("attach-surface-failed"))
  }

  private fun source(relative: String): String {
    val candidates = listOf(java.io.File(relative), java.io.File("app/" + relative))
    val file = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到源码 " + relative + "（工作目录 = " + java.io.File(".").absolutePath + "）")
    return file.readText()
  }

}
