package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #177 回归：sanitizeName 白名单化（路径分隔符与 `..` 是路径语义 token，不是「非法字符」）
 * 与 safeTarget 归属断言（外部字符串拼路径的最终结果必须 fail-closed）。
 * 纯 JVM：FileIncoming 的这两个成员不触碰 android.*。
 */
class FileIncomingSafetyTest {

  // ── sanitizeName：恶意名清单（issue #177 取证的同款形态 + 变体）──

  private fun assertNoPathTokens(name: String) {
    assertTrue("不得含 / : $name", !name.contains('/'))
    assertTrue("不得含 \\ : $name", !name.contains('\\'))
    assertTrue("不得含 .. : $name", !name.contains(".."))
  }

  @Test
  fun sanitizesSlashSeparators() {
    assertEquals("a_b.txt", FileIncoming.sanitizeName("a/b.txt"))
    assertEquals("a_b.txt", FileIncoming.sanitizeName("a\\b.txt"))
  }

  @Test
  fun sanitizesDotDotTraversal() {
    assertNoPathTokens(FileIncoming.sanitizeName("../../etc/passwd"))
    assertNoPathTokens(FileIncoming.sanitizeName("a/../../pwn.txt"))
    assertNoPathTokens(FileIncoming.sanitizeName("../../pwn.txt"))
  }

  @Test
  fun sanitizesPercentEncodedTraversal() {
    // ..%2f..%2fpwn2.txt 解码后 = ../../pwn2.txt —— 解码必须先于分隔符处理
    assertNoPathTokens(FileIncoming.sanitizeName("..%2f..%2fpwn2.txt"))
    assertNoPathTokens(FileIncoming.sanitizeName("%2e%2e%2fpwn.txt"))
  }

  @Test
  fun sanitizesMixedDotRuns() {
    // ....//pwn3.txt —— 连点折叠覆盖混合形态
    assertNoPathTokens(FileIncoming.sanitizeName("....//pwn3.txt"))
    assertNoPathTokens(FileIncoming.sanitizeName("..\\..\\pwn4.txt"))
  }

  @Test
  fun keepsNormalNames() {
    assertEquals("普通名字.txt", FileIncoming.sanitizeName("普通名字.txt"))
    assertEquals("alpha.txt", FileIncoming.sanitizeName("alpha.txt"))
    assertEquals("report-2026.v2.pdf", FileIncoming.sanitizeName("report-2026.v2.pdf"))
  }

  @Test
  fun stripsLeadingAndTrailingDots() {
    assertEquals("hidden", FileIncoming.sanitizeName(".hidden"))
    // 尾点（Windows 保留语义）被去掉
    assertEquals("name", FileIncoming.sanitizeName("name."))
    // 内部单点保留
    assertEquals("my.file", FileIncoming.sanitizeName("my.file"))
  }

  @Test
  fun emptyAfterCleaningFallsBackToFile() {
    assertEquals("file", FileIncoming.sanitizeName(""))
    assertEquals("file", FileIncoming.sanitizeName(".."))
    assertEquals("file", FileIncoming.sanitizeName("///"))
  }

  @Test
  fun longNameTruncatesWithHashSuffix() {
    val longName = "很长的文件名字".repeat(40) + ".txt"
    val out = FileIncoming.sanitizeName(longName)
    assertTrue("截断后 ≤ 200 字节: ${out.toByteArray().size}", out.toByteArray().size <= 210)
    assertTrue("带哈希后缀", out.contains('_'))
  }

  // ── safeTarget：归属断言（fail-closed）──

  private fun tempDir(): File {
    val d = File.createTempFile("fisafe", "dir")
    d.delete()
    d.mkdirs()
    return d
  }

  @Test
  fun safeTargetAcceptsPlainNameInsideDir() {
    val dir = tempDir()
    val t = FileIncoming.safeTarget(dir, "ok.txt")
    assertNotNull("正常名必须放行", t)
    assertTrue(t!!.canonicalPath.startsWith(dir.canonicalPath + File.separator))
  }

  @Test
  fun safeTargetRejectsTraversalName() {
    val dir = tempDir()
    // 纵深防御：即使上游漏净化，canonical 归属断言也必须拒绝
    assertNull(".. 逃逸必须被拒", FileIncoming.safeTarget(dir, "../escape.txt"))
    assertNull("多级逃逸必须被拒", FileIncoming.safeTarget(dir, "a/b.txt"))
    assertNull("子目录拼路径必须被拒（落点只在 dir 本层）", FileIncoming.safeTarget(dir, "sub/dir.txt"))
  }

  @Test
  fun safeTargetRejectsDotInsideDir() {
    val dir = tempDir()
    assertNull("落点 = dir 本身必须被拒", FileIncoming.safeTarget(dir, "."))
    assertNull("落点 = dir 父级必须被拒", FileIncoming.safeTarget(dir, ".."))
  }

  @Test
  fun uniqueNameStillSuffixesConflicts() {
    val dir = tempDir()
    File(dir, "dup.txt").writeText("x")
    assertEquals("dup (1).txt", FileIncoming.uniqueName(dir, "dup.txt"))
  }
}
