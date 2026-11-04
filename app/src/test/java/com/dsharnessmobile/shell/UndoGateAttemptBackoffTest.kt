package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 尝试退避（attempt marker）回归（issues #1368 #1507 #1514）。
 *
 * 缺陷形态：
 *  - #1368：只有**成功**才写 `.undo-auto-done`，失败路径没有记忆 ⇒ 引擎死透且急救 CLI 起不来时，
 *    闸门每 5 秒一拍继续放行，每拍拉起一次回滚；
 *  - #1507：退避只覆盖了看门狗入口，client-plugin 入口拿到 EXECUTE 直接返回、从不记账 ⇒
 *    「每拍拉起一次」在这条路径上原样保留；
 *  - #1514：标记损坏时先删文件再返回 now ⇒ tick1 抑制、tick2 文件已不存在 ⇒ 退避只维持一拍。
 *
 * 后两条的判据必须是**行为**：传参不等于记账（#1507 原文），所以本文件用真目录 + 推进时钟
 * 跑完整窗口，数「放行了几次」，而不是在源码里找调用。
 */
class UndoGateAttemptBackoffTest {

  private val now = 1_700_000_000_000L
  private val trigger = UndoGate.TRIGGER_CONSEC_FAILURES
  private val watch = UndoGate.WATCH_MS
  private val backoff = UndoGate.ATTEMPT_BACKOFF_MS
  private val identity = UndoGate.RetryIdentity("install-a", "patch-a")

  private fun decide(lastUndoAtMs: Long? = null, armedAtMs: Long? = now - watch, lastAttemptAtMs: Long? = null) =
    UndoGate.decide(trigger, now, lastUndoAtMs, armedAtMs, lastAttemptAtMs)

  private fun tempDir(): File {
    val dir = File(System.getProperty("java.io.tmpdir"), "undo-attempt-" + System.nanoTime())
    dir.mkdirs()
    return dir
  }

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
  fun `半截的尝试标记不得被解析成有效时间`() {
    assertEquals(
      UndoGate.AttemptMarker.Recorded(now),
      UndoGate.attemptMarker(true, UndoGate.encodeMarker(now), now),
    )
    assertEquals(
      "旧版本写的裸值继续认",
      UndoGate.AttemptMarker.Recorded(now),
      UndoGate.attemptMarker(true, now.toString(), now),
    )
    // #1508 的同款失效面：截断值若能解析，退避会显示「早已过期」⇒ 每拍重新放行。
    for (raw in listOf("17000", "1700000000", "170000000000", "abc", "", "   ")) {
      assertTrue("必须判损坏: [" + raw + "]", UndoGate.attemptMarker(true, raw, now, now) is UndoGate.AttemptMarker.Corrupt)
    }
    assertEquals(UndoGate.AttemptMarker.Missing, UndoGate.attemptMarker(false, null, now))
    assertEquals(
      "读失败也算损坏：文件在、时间不可知",
      UndoGate.AttemptMarker.Corrupt(now),
      UndoGate.attemptMarker(true, null, now, now),
    )
  }

  @Test
  fun `损坏标记不得删除且退避维持整个窗口`() {
    // #1514：旧实现 tick1 判 SUPPRESS 并删文件、tick2 已是 Missing ⇒ 立刻放行（坏标记让回滚提前）。
    val dir = tempDir()
    val attempt = File(dir, ".undo-auto-attempt")
    attempt.writeText("garbage")
    attempt.setLastModified(now)
    val notes = UndoGate.GateNotes()
    val log = mutableListOf<String>()
    fun tick(clock: Long) =
      UndoGate.onClientPluginTreeFailureIn(dir, "detail", identity, clock, notes) { log.add(it) }
    assertFalse("tick1 必须抑制", tick(now + 5_000L))
    assertTrue("坏标记不得被删掉（删了下一拍就退化成「没尝试过」）", attempt.isFile)
    assertFalse("tick2 必须仍然抑制（旧实现这里已经放行）", tick(now + 10_000L))
    assertFalse("退避边界前一毫秒仍须抑制", tick(now + backoff - 1))
    assertTrue("退避窗口走完必须放行", tick(now + backoff))
    assertNotEquals("放行后标记必须被改写成合法值", "garbage", attempt.readText().trim())
    assertEquals(
      "改写出来的必须能解回本拍",
      now + backoff,
      UndoGate.decodeMarker(attempt.readText(), now + backoff),
    )
    assertTrue("损坏必须留一行", log.any { it.contains("attempt marker corrupt") })
  }

  @Test
  fun `client-plugin 入口每退避窗口只放行一次`() {
    // #1507 的行为判据：120 拍 × 5 秒 = 10 分钟。放行只允许发生在 t=0 与 t=5min 两处；
    // 旧实现（拿到 EXECUTE 直接返回、从不记账）会放行 **120** 次，即每拍拉起一次回滚。
    val dir = tempDir()
    val notes = UndoGate.GateNotes()
    val log = mutableListOf<String>()
    var allowed = 0
    var clock = now
    repeat(120) {
      if (UndoGate.onClientPluginTreeFailureIn(dir, "detail", identity, clock, notes) { log.add(it) }) allowed++
      clock += 5_000L
    }
    assertEquals("10 分钟内只允许两次尝试", 2, allowed)
    assertEquals(
      "最后一次尝试必须落盘（第二窗口起点）",
      now + backoff,
      UndoGate.decodeMarker(File(dir, ".undo-auto-attempt").readText(), now + backoff + 5_000L),
    )
  }

  @Test
  fun `看门狗入口按观察窗与退避窗口放行`() {
    val dir = tempDir()
    val notes = UndoGate.GateNotes()
    val log = mutableListOf<String>()
    fun probe(clock: Long) = UndoGate.onProbeFailureIn(
      dir = dir,
      consecutiveFailures = trigger,
      evidence = UndoGate.RollbackEvidence.NONE,
      identity = identity,
      nowMs = clock,
      notes = notes,
      note = { log.add(it) },
    )
    assertFalse("首拍只起窗", probe(now))
    assertEquals(
      "起窗起点必须落盘",
      now,
      UndoGate.decodeMarker(File(dir, ".undo-auto-armed").readText(), now),
    )
    assertFalse("观察窗内不放行", probe(now + watch - 1))
    assertTrue("观察窗走完必须放行", probe(now + watch))
    assertEquals(
      "EXECUTE 必须记账（#1368）",
      now + watch,
      UndoGate.decodeMarker(File(dir, ".undo-auto-attempt").readText(), now + watch),
    )
    assertFalse("失败后的下一拍必须被尝试退避压住", probe(now + watch + 5_000L))
    assertTrue("退避窗口走完重新放行", probe(now + watch + backoff))
  }
}