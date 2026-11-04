package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * arm 标记文件的**写读契约**回归（issues #1369 #1508 #1515 #1530）。
 *
 * 旧实现的两个缺陷形态（都在本文件里被反证）：
 *  - #1508：判据是「能不能 toLongOrNull」，于是被截断的 1700000000000 -> 1700000000 依然合法，
 *    armedAt 远在过去 ⇒ 观察窗被**静默跳过**（引擎还没确认健康就回滚）；
 *  - #1530：读失败与「内容为空」同形，一次瞬时 IO 抖动就把有效记录删掉、观察窗从头重计。
 *
 * 判据全部走**真文件 + 真闸门**（dir 版入口），不再用源码文本切片：文本只能证明「写了某个调用」，
 * 而这两条缺陷恰恰是「调用在、语义错」。
 */
class UndoArmFileTest {

  private val t0 = 1_700_000_000_000L
  private val identity = UndoGate.RetryIdentity("install-a", "patch-a")

  private fun tempDir(): File {
    val dir = File(System.getProperty("java.io.tmpdir"), "undo-arm-" + System.nanoTime())
    dir.mkdirs()
    return dir
  }

  private fun gate(dir: File, clock: Long, notes: UndoGate.GateNotes, log: MutableList<String>): Boolean =
    UndoGate.onProbeFailureIn(
      dir = dir,
      consecutiveFailures = UndoGate.TRIGGER_CONSEC_FAILURES,
      evidence = UndoGate.RollbackEvidence.NONE,
      identity = identity,
      nowMs = clock,
      notes = notes,
      note = { log.add(it) },
    )

  @Test
  fun `标记编解码往返且旧裸值继续认`() {
    val encoded = UndoGate.encodeMarker(t0)
    assertEquals("13 位毫秒值必须往返相等", t0, UndoGate.decodeMarker(encoded, t0))
    assertEquals("上一个版本写的裸值升级当拍不得被判损坏", t0, UndoGate.decodeMarker(t0.toString(), t0))
    assertEquals(UndoGate.ArmMarker.Armed(t0), UndoGate.armMarker(true, encoded, t0))
    assertEquals(UndoGate.ArmMarker.Missing, UndoGate.armMarker(false, null, t0))
    assertEquals(UndoGate.ArmMarker.Missing, UndoGate.armMarker(false, "123", t0))
  }

  @Test
  fun `截断与拼接的时间戳一律判损坏`() {
    // #1508：这些都是「能 toLongOrNull」的串，旧判据会把它们当有效 ⇒ ARMED 远在过去 ⇒ 跳过观察窗。
    val cases = listOf(
      "17000",
      "1700000000",
      "170000000000",
      "17000000000000",
      "v2:1700000000",
      "1700000000000abc",
      "v2:",
      "not-a-number",
      "",
      "   ",
    )
    for (raw in cases) {
      assertEquals("必须判损坏: [" + raw + "]", UndoGate.ArmMarker.Corrupt, UndoGate.armMarker(true, raw, t0))
    }
    // 时钟回拨造出的未来起点不许把观察窗冻住。
    assertEquals(
      UndoGate.ArmMarker.Corrupt,
      UndoGate.armMarker(true, UndoGate.encodeMarker(t0 + UndoGate.WATCH_MS + 1), t0),
    )
  }

  @Test
  fun `观察窗起点必须由带版本前缀的原子写落下`() {
    val dir = tempDir()
    val notes = UndoGate.GateNotes()
    val log = mutableListOf<String>()
    assertFalse("起窗这一拍不放行", gate(dir, t0, notes, log))
    val arm = File(dir, ".undo-auto-armed")
    assertTrue("起窗必须落盘", arm.isFile)
    assertEquals("写侧必须是版本化标记（读侧才有东西可校验）", UndoGate.encodeMarker(t0), arm.readText().trim())
    assertEquals("落盘的起点必须能解回本拍", t0, UndoGate.decodeMarker(arm.readText(), t0))
    assertFalse(
      "原子写不得留下临时文件",
      dir.list()!!.any { it.endsWith(".tmp") },
    )
  }

  @Test
  fun `内容损坏时删掉并按本拍重起观察窗`() {
    // #1369 的既有语义必须保住：半截值不能当有效起点，否则「永不结束」会变成「永不重试」。
    val dir = tempDir()
    val notes = UndoGate.GateNotes()
    val log = mutableListOf<String>()
    val arm = File(dir, ".undo-auto-armed")
    arm.writeText("17000")
    gate(dir, t0, notes, log)
    assertTrue("损坏必须留一行", log.any { it.contains("arm file corrupt") })
    assertEquals("损坏值必须被本拍起点替换", UndoGate.encodeMarker(t0), arm.readText().trim())
    assertNotEquals("绝不允许继续用半截值当起点", "17000", arm.readText().trim())
  }

  @Test
  fun `读失败保留记录且不重置观察窗`() {
    // #1530：用同名目录制造 readText 抛异常（文件存在、内容读不出来，等价于瞬时权限抖动）。
    val dir = tempDir()
    val notes = UndoGate.GateNotes()
    val log = mutableListOf<String>()
    val arm = File(dir, ".undo-auto-armed")
    arm.mkdirs()
    arm.setLastModified(t0)
    gate(dir, t0 + 5_000L, notes, log)
    assertTrue("读失败绝不允许删掉 arm 记录", arm.exists())
    assertTrue("读失败必须留一行", log.any { it.contains("arm file unreadable") })
    assertFalse("读失败不得被当成损坏而重新起窗", log.any { it.startsWith("armed failures=") })
    assertFalse("读失败不得被当成损坏", log.any { it.contains("arm file corrupt") })
    assertEquals(
      "起点取文件写入时刻：窗口既不被重置、也不会被永久冻结",
      UndoGate.ArmMarker.Unreadable(t0),
      UndoGate.armMarker(true, null, t0 + 5_000L, t0),
    )
  }

  @Test
  fun `原子发布降级必须留痕且目标保持完整`() {
    // #1515：FUSE / emulated 挂载不支持 ATOMIC_MOVE。真文件系统上复现不了，用注入的发布器
    // 模拟「原子 move 抛异常、降级为普通 move」这一支，断言它必须留痕（否则退避静默失效）。
    val dir = tempDir()
    val log = mutableListOf<String>()
    val target = File(dir, ".undo-auto-attempt")
    target.writeText("old")
    UndoGate.writeAtomicText(target, UndoGate.encodeMarker(t0), { log.add(it) }) { tmp, dst, degrade ->
      degrade("AtomicMoveNotSupportedException: simulated")
      java.nio.file.Files.move(tmp.toPath(), dst.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING)
      true
    }
    assertEquals("降级后目标必须是完整新值", UndoGate.encodeMarker(t0), target.readText())
    assertTrue("降级必须留痕", log.any { it.contains("atomic move unsupported") })
    assertFalse("临时文件不得残留", dir.list()!!.any { it.endsWith(".tmp") })
  }

  @Test
  fun `硬杀残留的临时文件只清旧的且只清本类`() {
    // #1515：硬杀会把「临时文件已写、目标还没发布」的中间态留在 filesDir 里，长期累积。
    val dir = tempDir()
    val stale = File(dir, "..undo-auto-armed-111.tmp")
    stale.writeText("x")
    stale.setLastModified(t0 - UndoGate.STALE_TEMP_MS - 1_000L)
    val inFlight = File(dir, "..undo-auto-attempt-222.tmp")
    inFlight.writeText("x")
    inFlight.setLastModified(t0)
    val unrelated = File(dir, "boot-diag.log")
    unrelated.writeText("x")
    unrelated.setLastModified(t0 - UndoGate.STALE_TEMP_MS * 10)
    assertEquals("只清一条", 1, UndoGate.purgeStaleTemps(dir, t0) { })
    assertFalse("超龄残留必须清掉", stale.exists())
    assertTrue("可能仍在写的临时文件不许动", inFlight.exists())
    assertTrue("别的日志不归本类清", unrelated.exists())
    // 闸门第一拍必须真的调它：helper 再正确，没人调就等于线上永远不清。
    val lateStale = File(dir, "..undo-auto-done-333.tmp")
    lateStale.writeText("x")
    lateStale.setLastModified(t0 - UndoGate.STALE_TEMP_MS - 1_000L)
    gate(dir, t0, UndoGate.GateNotes(), mutableListOf())
    assertFalse("进闸门第一拍必须把超龄残留清掉", lateStale.exists())
    assertEquals(
      listOf("..undo-auto-armed-111.tmp", "..undo-auto-attempt-222.tmp"),
      UndoGate.staleTempNames(listOf("..undo-auto-armed-111.tmp", "..undo-auto-attempt-222.tmp", ".undo-auto-armed", "boot-diag.log", "x.tmp")),
    )
  }
}