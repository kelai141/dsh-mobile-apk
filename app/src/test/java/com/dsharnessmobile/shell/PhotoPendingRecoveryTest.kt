package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1007：拍照的在途状态必须跨**进程死亡**存活。
 *
 * 为什么是落盘而不是 savedInstanceState：MainActivity 在 AndroidManifest 里声明了
 * configChanges（orientation|screenSize|...），旋转不重建 Activity，所以唯一的重建路径是
 * 「相机在前台时进程被回收」。savedInstanceState 跟着进程走，进程没了它也没了；而相机结果由
 * 系统投给**新进程里新实例**的 launcher。能跨过去的只有文件。
 *
 * 本文件两层判据：
 *  1. 行为层：落盘格式的往返、以及恢复判定的四分叉（没有 / 可续 / 原图没了 / 超时或越界）；
 *  2. 结构层：控制器不得再出现「pending 为空就静默 return」的形态，且必须真的读写落盘状态。
 *     结构层是**源码判据**而不是行为判据 —— 缺陷本体是「根本没写这段代码」，在没有这段代码时
 *     无法用行为断言表达；这条显式标注为源码级判据，不当行为证据用。
 */
class PhotoPendingRecoveryTest {

  private fun tempDir(): File = Files.createTempDirectory("photo-pending").toFile()

  /** 控制器源码（单测工作目录是 app 模块目录）。 */
  private fun controllerSource(): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell/PhotoCaptureController.kt"),
      File("app/src/main/java/com/dsharnessmobile/shell/PhotoCaptureController.kt"),
    )
    for (file in candidates) if (file.isFile) return file.readText()
    throw AssertionError("找不到 PhotoCaptureController.kt（试过：" +
      candidates.joinToString { it.absolutePath } + "）")
  }

  // ── 行为层：落盘格式往返 ──────────────────────────────────────────────────

  @Test
  fun pendingRecordRoundTripsThroughDisk() {
    val cache = tempDir()
    val rawDir = File(cache, "attachments/raw").apply { mkdirs() }
    val outDir = File(cache, "attachments").apply { mkdirs() }
    val raw = File(rawDir, "raw-1.jpg").apply { writeText("bytes") }
    val target = File(outDir, "photo-1.jpg")

    val encoded = PhotoCapture.encodePending(raw, target, 1700000000000L)
    val file = PhotoCapture.pendingStateFile(cache)
    file.writeText(encoded)

    val record = PhotoCapture.decodePending(file.readText())
    assertNotNull(record)
    assertEquals(raw.absolutePath, record!!.raw)
    assertEquals(target.absolutePath, record.target)
    assertEquals(1700000000000L, record.startedAt)
  }

  @Test
  fun malformedPendingRecordDecodesToAbsent() {
    assertNull(PhotoCapture.decodePending("not json"))
    assertNull(PhotoCapture.decodePending("{}"))
    assertNull(PhotoCapture.decodePending(JSONObject().put("raw", "x").toString()))
    assertNull(PhotoCapture.decodePending(
      JSONObject().put("raw", "x").put("target", "y").put("startedAt", 0L).toString(),
    ))
  }

  // ── 行为层：恢复判定的四分叉 ──────────────────────────────────────────────

  @Test
  fun freshRecordWithNonEmptyRawIsResumable() {
    val cache = tempDir()
    val rawDir = File(cache, "attachments/raw").apply { mkdirs() }
    val outDir = File(cache, "attachments").apply { mkdirs() }
    val raw = File(rawDir, "raw-2.jpg").apply { writeText("bytes") }
    val target = File(outDir, "photo-2.jpg")
    val record = PhotoCapture.PendingRecord(raw.absolutePath, target.absolutePath, 1_000L)

    val recovery = PhotoCapture.classifyPending(record, rawDir, outDir, now = 2_000L)

    assertTrue("原图在场且未超时，必须可续上，实际 " + recovery,
      recovery is PhotoCapture.PendingRecovery.Resume)
    recovery as PhotoCapture.PendingRecovery.Resume
    assertEquals(raw.canonicalPath, recovery.raw.canonicalPath)
  }

  @Test
  fun missingRecordMeansNoPendingWork() {
    val cache = tempDir()
    val rawDir = File(cache, "attachments/raw").apply { mkdirs() }
    val outDir = File(cache, "attachments").apply { mkdirs() }
    assertEquals(PhotoCapture.PendingRecovery.None,
      PhotoCapture.classifyPending(null, rawDir, outDir, now = 2_000L))
  }

  @Test
  fun vanishedRawIsReportedAsLostNotSilentlyDropped() {
    val cache = tempDir()
    val rawDir = File(cache, "attachments/raw").apply { mkdirs() }
    val outDir = File(cache, "attachments").apply { mkdirs() }
    val record = PhotoCapture.PendingRecord(
      File(rawDir, "raw-3.jpg").absolutePath, File(outDir, "photo-3.jpg").absolutePath, 1_000L,
    )

    val recovery = PhotoCapture.classifyPending(record, rawDir, outDir, now = 2_000L)

    assertEquals(PhotoCapture.PendingRecovery.Lost("raw-missing"), recovery)
  }

  @Test
  fun emptyRawIsReportedAsLost() {
    val cache = tempDir()
    val rawDir = File(cache, "attachments/raw").apply { mkdirs() }
    val outDir = File(cache, "attachments").apply { mkdirs() }
    val raw = File(rawDir, "raw-4.jpg").apply { writeText("") }
    val record = PhotoCapture.PendingRecord(raw.absolutePath, File(outDir, "photo-4.jpg").absolutePath, 1_000L)

    assertEquals(PhotoCapture.PendingRecovery.Lost("raw-empty"),
      PhotoCapture.classifyPending(record, rawDir, outDir, now = 2_000L))
  }

  @Test
  fun staleRecordIsReportedAsLostSoTheSlotCannotStayBusyForever() {
    val cache = tempDir()
    val rawDir = File(cache, "attachments/raw").apply { mkdirs() }
    val outDir = File(cache, "attachments").apply { mkdirs() }
    val raw = File(rawDir, "raw-5.jpg").apply { writeText("bytes") }
    val record = PhotoCapture.PendingRecord(raw.absolutePath, File(outDir, "photo-5.jpg").absolutePath, 1_000L)

    val recovery = PhotoCapture.classifyPending(
      record, rawDir, outDir, now = 1_000L + PhotoCapture.PENDING_STALE_MS + 1,
    )

    assertEquals(PhotoCapture.PendingRecovery.Lost("stale"), recovery)
  }

  @Test
  fun recordPointingOutsideTheCaptureDirectoriesIsRejected() {
    val cache = tempDir()
    val rawDir = File(cache, "attachments/raw").apply { mkdirs() }
    val outDir = File(cache, "attachments").apply { mkdirs() }
    val outside = File(cache, "elsewhere.jar").apply { writeText("x") }
    val record = PhotoCapture.PendingRecord(outside.absolutePath, File(outDir, "photo-6.jpg").absolutePath, 1_000L)

    assertEquals(PhotoCapture.PendingRecovery.Lost("path-outside-capture-dirs"),
      PhotoCapture.classifyPending(record, rawDir, outDir, now = 2_000L))
  }

  // ── 结构层（源码判据，显式标注）──────────────────────────────────────────

  @Test
  fun controllerNoLongerDropsACameraResultWhenPendingIsNull() {
    val source = controllerSource()
    // 修前的形态：val job = pending ?: return@registerForActivityResult —— 静默丢弃。
    assertFalse(
      "相机回调不得在 pending 为空时静默返回（issue #1007 的缺陷本体）",
      Regex("pending\\\\s*\\\\?:\\\\s*return@registerForActivityResult").containsMatchIn(source),
    )
    assertTrue("相机回调缺少 pending 时必须给结构化回执", source.contains("capture-result-without-pending"))
  }

  @Test
  fun controllerPersistsAndRestoresTheInFlightState() {
    val source = controllerSource()
    assertTrue("在途状态必须落盘", source.contains("PhotoCapture.pendingStateFile"))
    assertTrue("受理拍照时必须写落盘状态", source.contains("persistPendingState"))
    assertTrue("构造时必须尝试恢复", source.contains("restorePendingState"))
    assertTrue("终局路径必须清掉落盘状态", source.contains("clearPendingState"))
  }
}
