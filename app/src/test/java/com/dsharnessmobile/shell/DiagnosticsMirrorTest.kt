package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * FX-211.3 回归：诊断镜像有界读（原 readText → redact → writeText 峰值约 3x 单份日志），
 * 且脱敏出口仍然生效（launch token 不进共享副本）。
 */
class DiagnosticsMirrorTest {

  @get:Rule
  val tmp = TemporaryFolder()

  @Test
  fun mirrorIsBoundedAndMarksTheOmittedHead() {
    val src = tmp.newFile("engine.log")
    val line = "0123456789abcdef\n"
    val sb = StringBuilder()
    repeat(1000) { sb.append(line) }
    src.writeText(sb.toString())
    val sourceBytes = src.length()
    assertTrue(sourceBytes > 16_000)

    val dst = File(tmp.root, "engine-copy.log")
    val ok = mirrorLogBounded(src, dst, limitBytes = 4096)

    assertTrue(ok)
    val text = dst.readText()
    assertTrue("读取必须有上限（原实现整份读入）", text.length <= 4096 + 256)
    assertTrue("截断必须带标注", text.contains("diagnostic mirror truncated"))
    // 标注行本身带前导换行，比较尾部内容时先去掉行尾空行。
    val mirroredBody = text.substringBefore("[diagnostic mirror truncated").trimEnd('\n')
    assertTrue("尾部必须保留（现场在尾部）", mirroredBody.endsWith("0123456789abcdef"))
    assertTrue("必须保留的是尾部而不是头部", !mirroredBody.startsWith(line))
  }

  @Test
  fun mirrorNeverLeaksTheLaunchTokenToSharedCopies() {
    val src = tmp.newFile("engine.log")
    val token = "a".repeat(48)
    src.writeText("boot ok\ndsh web: http://127.0.0.1:3080/?token=" + token + "\nready\n")

    val dst = File(tmp.root, "engine-copy.log")
    assertTrue(mirrorLogBounded(src, dst, limitBytes = 64 * 1024))
    val text = dst.readText()
    assertFalse("launch token 不得出现在共享副本", text.contains(token))
    assertTrue(text.contains("***?token=***"))
  }

  @Test
  fun missingSourceIsReportedAsNotWritten() {
    val dst = File(tmp.root, "engine-copy.log")
    assertFalse(mirrorLogBounded(File(tmp.root, "absent.log"), dst, 1024))
    assertFalse(dst.exists())
  }
}
