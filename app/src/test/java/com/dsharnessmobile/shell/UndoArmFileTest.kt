package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1369 回归：自动回滚的 arm 文件必须原子写，且「存在但解析不出」要判成损坏。
 *
 * 缺陷形态：`writeText` 先截断后写，进程在观察窗内被硬杀（或磁盘满）会留下 0 字节文件；
 * 读取侧把「文件存在」当「值有效」，`armedAt` 恒为 null ⇒ 每拍都判 ARM 并重写 ⇒
 * 观察窗永不结束，自动回滚静默失效。
 */
class UndoArmFileTest {

  private fun src(): String =
    File(File("src/main/java/com/dsharnessmobile/shell"), "UndoGate.kt").readText()

  private fun codeOnly(s: String): String = s.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  @Test
  fun `缺失判缺失`() {
    assertEquals(UndoGate.ArmState.MISSING, UndoGate.armState(false, null))
    assertEquals(UndoGate.ArmState.MISSING, UndoGate.armState(false, "123"))
  }

  @Test
  fun `可解析的毫秒值判有效`() {
    assertEquals(UndoGate.ArmState.VALID, UndoGate.armState(true, "1700000000000"))
    assertEquals(UndoGate.ArmState.VALID, UndoGate.armState(true, " 1700000000000 \n"))
  }

  @Test
  fun `空文件与半截内容判损坏`() {
    // 0 字节（写盘被硬杀）、空串、非数字、只有空白——都必须算损坏，不能当成「没有值」
    assertEquals(UndoGate.ArmState.CORRUPT, UndoGate.armState(true, ""))
    assertEquals(UndoGate.ArmState.CORRUPT, UndoGate.armState(true, "   "))
    assertEquals(UndoGate.ArmState.CORRUPT, UndoGate.armState(true, "17000"))
    assertEquals(UndoGate.ArmState.CORRUPT, UndoGate.armState(true, "not-a-number"))
    assertEquals(UndoGate.ArmState.CORRUPT, UndoGate.armState(true, null))
  }

  @Test
  fun `arm 文件必须原子写，不得再出现裸 writeText`() {
    val code = codeOnly(src())
    val arm = code.substringAfter("GateDecision.ARM ->").substringBefore("GateDecision.")
    assertTrue("arm 写入必须走 writeAtomicText", arm.contains("writeAtomicText(armFile(context), now.toString())"))
    assertFalse("不得回到裸 writeText（先截断后写）", arm.contains("armFile(context).writeText("))
    assertTrue("原子写必须用 ATOMIC_MOVE", code.contains("StandardCopyOption.ATOMIC_MOVE"))
    assertTrue("写后必须 fsync", code.contains("out.fd.sync()"))
  }

  @Test
  fun `读取侧必须把损坏判成损坏而不是静默当空`() {
    val code = codeOnly(src())
    assertTrue("armedAt 必须经 armState 分类", code.contains("when (armState(exists, raw))"))
    assertTrue("损坏分支必须删文件", code.contains("ArmState.CORRUPT -> {"))
    assertTrue("损坏必须留一行记录", code.contains("arm file corrupt"))
  }
}
