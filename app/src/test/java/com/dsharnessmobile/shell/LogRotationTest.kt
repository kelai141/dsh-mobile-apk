package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * FX-211.3 回归：日志轮转「先 rename 成功再删旧」。
 *
 * 旧实现 delete(上一代) → renameTo(主文件) → 忽略返回值：rename 失败时唯一旧副本
 * 已被删掉、主文件继续无界增长，且没有任何痕迹。判据：rename 失败时 .1.log 不被删。
 */
class LogRotationTest {

  @get:Rule
  val tmp = TemporaryFolder()

  private fun at(name: String): File = File(tmp.root, name)

  @Test
  fun renameFailureKeepsTheRotatedFileAndTheCurrentOne() {
    val file = at("dsh-2026-01-01.log").apply { writeText("current data") }
    val rotated = at("dsh-2026-01-01.1.log").apply { writeText("previous generation") }
    val superseded = at("dsh-2026-01-01.2.log")

    val ok = LogCollector.rotateDayFile(file, rotated, superseded, rename = { _, _ -> false })

    assertFalse("rename 失败时不得报告轮转成功", ok)
    assertTrue("rename 失败时 .1.log 不得被删（FX-211.3 判据）", rotated.exists())
    assertEquals("previous generation", rotated.readText())
    assertTrue("主文件必须保留（继续追加，不丢日志）", file.exists())
    assertEquals("current data", file.readText())
  }

  @Test
  fun successfulRotationMovesTheCurrentFileIntoTheRotatedSlot() {
    val file = at("dsh-2026-01-01.log").apply { writeText("current data") }
    val rotated = at("dsh-2026-01-01.1.log")
    val superseded = at("dsh-2026-01-01.2.log")

    assertTrue(LogCollector.rotateDayFile(file, rotated, superseded))
    assertFalse(file.exists())
    assertEquals("current data", rotated.readText())
    assertFalse(superseded.exists())
  }

  @Test
  fun previousGenerationIsMovedAsideThenClearedOnlyAfterTheMainRename() {
    val file = at("dsh-2026-01-01.log").apply { writeText("current data") }
    val rotated = at("dsh-2026-01-01.1.log").apply { writeText("previous generation") }
    val superseded = at("dsh-2026-01-01.2.log").apply { writeText("ancient generation") }

    assertTrue(LogCollector.rotateDayFile(file, rotated, superseded))
    assertEquals("current data", rotated.readText())
    assertFalse("更早的一代在本次 rename 成功后才可删", superseded.exists())
  }

  @Test
  fun staleSupersededThatCannotBeClearedSkipsRotationWithoutTouchingDotOne() {
    val file = at("dsh-2026-01-01.log").apply { writeText("current data") }
    val rotated = at("dsh-2026-01-01.1.log").apply { writeText("previous generation") }
    val superseded = at("dsh-2026-01-01.2.log").apply { writeText("ancient generation") }

    val ok = LogCollector.rotateDayFile(file, rotated, superseded, deleteFile = { false })

    assertFalse(ok)
    assertTrue(".1.log 必须原样保留", rotated.exists())
    assertEquals("previous generation", rotated.readText())
  }
}
