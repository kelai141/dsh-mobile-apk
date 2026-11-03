package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1368 回归：EXECUTE 必须有「尝试退避」记忆。
 *
 * 缺陷形态：只有**成功**才写 `.undo-auto-done`，失败路径没有任何记忆。引擎死透且急救 CLI 起不来时，
 * 闸门每 5 秒一拍继续放行，每拍拉起一次回滚尝试，无上限无退避（后台唤醒与日志一起膨胀）。
 */
class UndoGateAttemptBackoffTest {

  private val now = 1_700_000_000_000L
  private val trigger = UndoGate.TRIGGER_CONSEC_FAILURES
  private val watch = UndoGate.WATCH_MS
  private val backoff = UndoGate.ATTEMPT_BACKOFF_MS

  private fun decide(lastUndoAtMs: Long? = null, armedAtMs: Long? = now - watch, lastAttemptAtMs: Long? = null) =
    UndoGate.decide(trigger, now, lastUndoAtMs, armedAtMs, lastAttemptAtMs)

  @Test
  fun `观察窗走完且没有尝试记录时放行`() {
    assertEquals(UndoGate.GateDecision.EXECUTE, decide())
  }

  @Test
  fun `尝试退避窗口内不再放行`() {
    assertEquals(UndoGate.GateDecision.SUPPRESS, decide(lastAttemptAtMs = now - 1_000))
    assertEquals(
      "边界前一毫秒仍要抑制",
      UndoGate.GateDecision.SUPPRESS,
      decide(lastAttemptAtMs = now - backoff + 1),
    )
  }

  @Test
  fun `退避窗口过后重新放行`() {
    assertEquals(UndoGate.GateDecision.EXECUTE, decide(lastAttemptAtMs = now - backoff))
    assertEquals(UndoGate.GateDecision.EXECUTE, decide(lastAttemptAtMs = now - backoff - 1))
  }

  @Test
  fun `成功退避优先于尝试退避`() {
    assertEquals(
      "距上次成功不足 RETRY_WINDOW 时，无论尝试记录如何都是 SUPPRESS",
      UndoGate.GateDecision.SUPPRESS,
      decide(lastUndoAtMs = now - 1_000, lastAttemptAtMs = now - backoff - 1),
    )
  }

  @Test
  fun `未达触发阈值时不动作`() {
    assertEquals(
      UndoGate.GateDecision.IDLE,
      UndoGate.decide(trigger - 1, now, null, null, now - 1_000),
    )
  }

  @Test
  fun `EXECUTE 分支必须落尝试记录，且 decide 的调用点必须读它`() {
    val code = File(File("src/main/java/com/dsharnessmobile/shell"), "UndoGate.kt").readText()
      .lineSequence()
      .filterNot { it.trimStart().startsWith("//") || it.trimStart().startsWith("*") }
      .joinToString("\n")
    val execute = code.substringAfter("GateDecision.EXECUTE ->").substringBefore("GateDecision.")
    assertTrue("EXECUTE 分支必须写 attempt marker", execute.contains("attemptFile(context).writeText(now.toString())"))
    assertTrue(
      "两个 decide 调用点都必须把 attemptAt 传进去",
      code.contains("decide(consecutiveFailures, now, retry.atMs, armedAt(context), attemptAt(context))") &&
        code.contains("decide(TRIGGER_CONSEC_FAILURES, now, retry.atMs, armedAt(context), attemptAt(context))"),
    )
    assertTrue("退避判据必须在 decide 里", code.contains("nowMs - lastAttemptAtMs < ATTEMPT_BACKOFF_MS"))
  }
}
