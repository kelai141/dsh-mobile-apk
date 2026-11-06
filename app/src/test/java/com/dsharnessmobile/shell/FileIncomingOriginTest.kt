package com.dsharnessmobile.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * 来件**来源**（origin）判据（缺陷 1：拍照后附件被投进新会话）。
 *
 * 缺陷现场：拍照成品与「外部分享」走同一条投递链——
 * [PhotoCaptureController.deliver] → [FileIncoming.processIncomingPath] → enqueuePending →
 * POST /api/android/file-incoming，body 只有 `{path}`。引擎侧 dsh-android-file-open 的
 * enqueueSession 因此只能落一条**没有目标会话**的记录，页面侧 incoming-draft 见
 * `sessionId === undefined` 就 createSession + openSession ⇒ 拍照结果进了新会话。
 *
 * 修法：投递时把**来源**一起送过去。外部来件仍是 external（PRD F5.2：强制新会话），
 * 壳侧自产来件（拍照）是 camera，页面侧据此并入当前会话。
 *
 * 本文件锁的是**行为**（不是接线；接线由 PhotoCaptureOriginWiringTest 的源码断言守）：
 *  ① POST body 必须带 origin，且归一成闭集内的值；
 *  ② 缺省来源必须是 external —— F5.2 的守门值，漏传不得升级成「并入既有会话」；
 *  ③ **待发清单必须携带来源**：清单是重试的唯一真源（flushPending 也被引擎就绪钩子调用），
 *    只存路径的话拍照来件会在补投那一步重新变成「强制新会话」；
 *  ④ 老格式清单（只有路径）按 external 解读 —— 升级后旧清单行为不变。
 */
class FileIncomingOriginTest {

  // ── ① 投递 body ───────────────────────────────────────────────────────────

  @Test
  fun incomingBodyCarriesOriginForCamera() {
    val body = FileIncoming.incomingRequestBody("/data/incoming/photo-1.jpg", FileIncoming.ORIGIN_CAMERA)
    val json = JSONObject(body)
    assertEquals("path 必须原样带上", "/data/incoming/photo-1.jpg", json.getString("path"))
    assertEquals(
      "拍照来件必须标明来源 camera（页面侧据此并入当前会话，而不是新建会话）",
      "camera",
      json.getString("origin"),
    )
  }

  @Test
  fun incomingBodyCarriesOriginForExternalShare() {
    val json = JSONObject(FileIncoming.incomingRequestBody("/data/incoming/share.pdf", FileIncoming.ORIGIN_EXTERNAL))
    assertEquals("external", json.getString("origin"))
  }

  @Test
  fun unknownOriginFallsBackToExternal() {
    // 负控：来源是闭集。拼错/伪造的值必须塌回 external（= 强制新会话），
    // 绝不能因为一个没见过的字符串而获得「并入用户当前会话」的能力。
    val json = JSONObject(FileIncoming.incomingRequestBody("/data/incoming/x.bin", "camer"))
    assertEquals("external", json.getString("origin"))
    assertFalse(json.getString("origin") == FileIncoming.ORIGIN_CAMERA)
    assertEquals("external", FileIncoming.normalizeOrigin(null))
    assertEquals("external", FileIncoming.normalizeOrigin(""))
    assertEquals("external", FileIncoming.normalizeOrigin("CAMERA"))
    assertEquals("camera", FileIncoming.normalizeOrigin("camera"))
  }

  @Test
  fun originClosedSetIsExplicit() {
    assertEquals(setOf("external", "camera"), FileIncoming.KNOWN_ORIGINS)
    assertTrue(FileIncoming.ORIGIN_CAMERA in FileIncoming.KNOWN_ORIGINS)
    assertEquals("缺省来源必须是外部分享（F5.2 守门值）", "external", FileIncoming.ORIGIN_EXTERNAL)
  }

  // ── ② 待发清单携带来源（重试不丢目标）────────────────────────────────────

  @Test
  fun pendingLineRoundTripsOrigin() {
    val line = FileIncoming.encodePendingLine(FileIncoming.ORIGIN_CAMERA, "/ws/photo-1.jpg")
    assertEquals(FileIncoming.ORIGIN_CAMERA to "/ws/photo-1.jpg", FileIncoming.decodePendingLine(line))
  }

  @Test
  fun legacyPendingLineWithoutSeparatorIsExternal() {
    // 升级前落盘的清单行只有路径。必须原样可读，且按外部分享处理（行为不变）。
    assertEquals(
      FileIncoming.ORIGIN_EXTERNAL to "/ws/legacy.pdf",
      FileIncoming.decodePendingLine("/ws/legacy.pdf"),
    )
    // 含空格/中文的路径也不得被误拆。
    assertEquals(
      FileIncoming.ORIGIN_EXTERNAL to "/ws/带 空格 的文件.pdf",
      FileIncoming.decodePendingLine("/ws/带 空格 的文件.pdf"),
    )
  }

  @Test
  fun blankPendingLinesDecodeToNothing() {
    assertNull(FileIncoming.decodePendingLine(""))
    assertNull(FileIncoming.decodePendingLine("   "))
    // origin 有、路径为空的行没有意义（不得当成一条可投递条目）。
    assertNull(FileIncoming.decodePendingLine(FileIncoming.ORIGIN_CAMERA + FileIncoming.PENDING_SEPARATOR))
  }

  @Test
  fun pendingLedgerRoundTripsThroughDisk() {
    val dir = Files.createTempDirectory("origin-ledger").toFile()
    try {
      val ledger = File(dir, ".pending-notify.ndjson")
      FileIncoming.writePending(
        ledger,
        listOf(
          FileIncoming.ORIGIN_CAMERA to "/ws/photo-1.jpg",
          FileIncoming.ORIGIN_EXTERNAL to "/ws/share.pdf",
        ),
      )
      assertEquals(
        listOf(
          FileIncoming.ORIGIN_CAMERA to "/ws/photo-1.jpg",
          FileIncoming.ORIGIN_EXTERNAL to "/ws/share.pdf",
        ),
        FileIncoming.readPending(ledger),
      )
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun legacyLedgerOnDiskStillReadsAsExternal() {
    val dir = Files.createTempDirectory("legacy-ledger").toFile()
    try {
      val ledger = File(dir, ".pending-notify.ndjson")
      // 老版本写的形态：纯路径、换行分隔。
      ledger.writeText("/ws/a.pdf\n/ws/b.jpg\n")
      assertEquals(
        listOf(FileIncoming.ORIGIN_EXTERNAL to "/ws/a.pdf", FileIncoming.ORIGIN_EXTERNAL to "/ws/b.jpg"),
        FileIncoming.readPending(ledger),
      )
    } finally {
      dir.deleteRecursively()
    }
  }
}
