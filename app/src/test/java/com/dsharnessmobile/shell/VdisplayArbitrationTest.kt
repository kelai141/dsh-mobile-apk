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

  /**
   * D5（0.14.11，PR #833）：屏被 destroy / 空闲回收 / 强制销毁后，宿主必须能**自查**发现并重新绑定。
   *
   * 真机实测（同一 JS turn 内 destroy + create）：修前新屏的 viewer 恒为 presenting=false
   * （连测 5s 都不恢复，侧栏永久停在旧帧）；修后 300ms 内恢复 presenting=true。
   * 根因是宿主只在自己的 release / surfaceDestroyed 里复位 attached —— 屏被别人删掉时它不知道。
   * 这里钉住「绑定前自查真源」的形态，撤掉即红。
   */
  @Test
  fun hostSelfChecksBeforeBindingAfterTheScreenIsRecreated() {
    val host = source("src/main/java/com/dsharnessmobile/shell/VdisplayHost.kt")
    assertTrue(
      "宿主绑定前必须自查 viewer 是否仍持有 Surface（否则重建的屏永远挂不上）",
      host.contains("VdisplayController.holdsViewerSurface(viewerId)"),
    )
    val controller = source("src/main/java/com/dsharnessmobile/shell/VdisplayController.kt")
    assertTrue(
      "controller 必须提供该只读查询",
      controller.contains("fun holdsViewerSurface(viewerId: String): Boolean"),
    )
  }

  private fun source(relative: String): String {
    val candidates = listOf(java.io.File(relative), java.io.File("app/" + relative))
    val file = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到源码 " + relative + "（工作目录 = " + java.io.File(".").absolutePath + "）")
    return file.readText()
  }

}
