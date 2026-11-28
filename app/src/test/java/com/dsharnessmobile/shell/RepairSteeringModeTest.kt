package com.dsharnessmobile.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 修复助手运行中插话形态（形态 A）与安全护栏辅助纯函数回归测试。
 */
class RepairSteeringModeTest {

  private fun hasCjk(text: String): Boolean = text.any { it.code in 0x4E00..0x9FFF }

  @Test
  fun actionModeKeepsSendWhenIdleAndSwitchesBetweenStopAndSteerWhenBusy() {
    assertEquals(RepairActionMode.SEND, repairActionMode(busy = false, draftText = null))
    assertEquals(RepairActionMode.SEND, repairActionMode(busy = false, draftText = ""))
    assertEquals(RepairActionMode.SEND, repairActionMode(busy = false, draftText = "   "))
    assertEquals(RepairActionMode.SEND, repairActionMode(busy = false, draftText = "fix config"))

    assertEquals(RepairActionMode.STOP, repairActionMode(busy = true, draftText = null))
    assertEquals(RepairActionMode.STOP, repairActionMode(busy = true, draftText = ""))
    assertEquals(RepairActionMode.STOP, repairActionMode(busy = true, draftText = "  \n\t "))

    assertEquals(RepairActionMode.STEER_SEND, repairActionMode(busy = true, draftText = "check port 3080"))
    assertEquals(RepairActionMode.STEER_SEND, repairActionMode(busy = true, draftText = "  补充一条  "))
  }

  @Test
  fun stopReasonMessagesAreBilingualAndSpecificForEveryGuardReason() {
    val reasons = listOf(
      "max-steps",
      "max-tool-calls",
      "max-total-output-bytes",
      "consecutive-no-progress-batches",
      "consecutive-invalid-tool-batches",
      "unexpected-reason",
      null,
    )
    val seenZh = HashSet<String>()
    val seenEn = HashSet<String>()
    for (reason in reasons) {
      val zh = repairStopReasonMessage(reason, english = false)
      val en = repairStopReasonMessage(reason, english = true)
      assertTrue("中文提示不得为空: $reason", zh.isNotBlank())
      assertTrue("中文提示必须含中文: $reason -> $zh", hasCjk(zh))
      assertTrue("英文提示不得为空: $reason", en.isNotBlank())
      assertFalse("英文提示不得含中文: $reason -> $en", hasCjk(en))
      if (reason != null) {
        assertTrue("不同原因中文文案应区分: $reason", seenZh.add(zh))
        assertTrue("不同原因英文文案应区分: $reason", seenEn.add(en))
      }
    }
  }

  @Test
  fun structuredRefusalAndInvalidArgumentPayloadsStayValidJson() {
    for (reason in listOf("duplicate-tool-call", "max-tool-calls", "max-total-output-bytes", null)) {
      val parsed = JSONObject(repairToolRefusalJson(reason))
      assertFalse(parsed.getBoolean("ok"))
      assertEquals(reason ?: "tool-call-refused", parsed.getString("error"))
      assertTrue(parsed.getString("message").isNotBlank())
    }
    val invalid = JSONObject(repairToolInvalidArgumentsJson("Unexpected end of input"))
    assertFalse(invalid.getBoolean("ok"))
    assertEquals("invalid-arguments", invalid.getString("error"))
    assertTrue(invalid.getString("message").contains("Unexpected end of input"))
  }

  @Test
  fun argumentObjectParserAcceptsOnlyCompleteJsonObjects() {
    assertEquals(0, parseToolArgumentsObject("")!!.length())
    assertEquals(0, parseToolArgumentsObject("   ")!!.length())
    val valid = parseToolArgumentsObject("""{"path":"engine.log","tail":true}""")
    assertNotNull(valid)
    assertEquals("engine.log", valid!!.getString("path"))
    assertTrue(valid.getBoolean("tail"))

    assertNull(parseToolArgumentsObject("{broken"))
    assertNull(parseToolArgumentsObject("[1, 2, 3]"))
    assertNull(parseToolArgumentsObject("\"plain string\""))
    assertNull(parseToolArgumentsObject("""{"a":1} trailing"""))
  }

  @Test
  fun batchProgressTrackerTracksReadWindowsMutationsAndStateResets() {
    assertTrue(isStateChangingRepairTool("write"))
    assertTrue(isStateChangingRepairTool("edit"))
    assertTrue(isStateChangingRepairTool("restart_engine"))
    assertTrue(isStateChangingRepairTool("refresh_runtime"))
    assertFalse(isStateChangingRepairTool("read"))
    assertFalse(isStateChangingRepairTool("preflight"))

    val progress = RepairBatchProgressTracker()

    val firstRead = progress.observe(
      "read",
      """{"path":"a.log","offset":0}""",
      """{"ok":true,"path":"/files/a.log","offset":0,"readBytes":100,"size":200}""",
      stateVersion = 0,
    )
    assertFalse(firstRead.stateChanged)
    assertTrue(firstRead.madeProgress)
    assertNull(firstRead.errorCode)

    val repeatRead = progress.observe(
      "read",
      """{"path":"a.log","offset":0,"limit":1024}""",
      """{"ok":true,"path":"/files/a.log","offset":0,"readBytes":100,"size":200}""",
      stateVersion = 0,
    )
    assertFalse(repeatRead.madeProgress)

    val nextWindow = progress.observe(
      "read",
      """{"path":"a.log","offset":100}""",
      """{"ok":true,"path":"/files/a.log","offset":100,"readBytes":100,"size":200}""",
      stateVersion = 0,
    )
    assertTrue(nextWindow.madeProgress)

    val noopEdit = progress.observe(
      "edit",
      """{"path":"a.yml","oldText":"x","newText":"x"}""",
      """{"ok":true,"path":"/files/a.yml","changed":false,"backedUp":false}""",
      stateVersion = 0,
    )
    assertTrue(noopEdit.stateChanged)
    assertFalse(noopEdit.madeProgress)

    val realEdit = progress.observe(
      "edit",
      """{"path":"a.yml","oldText":"x","newText":"y"}""",
      """{"ok":true,"path":"/files/a.yml","changed":true,"backedUp":true}""",
      stateVersion = 0,
    )
    assertTrue(realEdit.stateChanged)
    assertTrue(realEdit.madeProgress)

    // 状态版本推进后，同窗口重读视为新状态下的有效验证。
    val rereadAfterEdit = progress.observe(
      "read",
      """{"path":"a.log","offset":0}""",
      """{"ok":true,"path":"/files/a.log","offset":0,"readBytes":100,"size":200}""",
      stateVersion = 1,
    )
    assertTrue(rereadAfterEdit.madeProgress)

    val deferredRestart = progress.observe(
      "restart_engine",
      "{}",
      """{"restarted":false,"deferred":true,"reason":"snapshot-refresh-in-flight"}""",
      stateVersion = 1,
    )
    assertFalse(deferredRestart.stateChanged)
    assertFalse(deferredRestart.madeProgress)
    assertNull(deferredRestart.errorCode)

    val statusDown = progress.observe(
      "engine_status",
      "{}",
      """{"ok":false,"processAlive":false}""",
      stateVersion = 1,
    )
    assertTrue(statusDown.madeProgress)
    assertNull(statusDown.errorCode)
    assertFalse(progress.observe("engine_status", "{}", """{"ok":false,"processAlive":false}""", 1).madeProgress)

    val toolErr = progress.observe(
      "read",
      """{"path":"missing"}""",
      """{"ok":false,"error":"not-found","message":"missing"}""",
      stateVersion = 1,
    )
    assertFalse(toolErr.stateChanged)
    assertFalse(toolErr.madeProgress)
    assertEquals("not-found", toolErr.errorCode)
  }
}
