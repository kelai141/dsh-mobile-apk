package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1366 回归：分段日志的写入必须串行化。
 *
 * 缺陷形态：`markFirstHttp()` 走调用线程直接写，probe 尾线程也写同一个 `boot-segments.log`；
 * 「查长度 → 可能轮转 → 追加」这串非原子操作被两线程交错，轮转瞬间可能把行写进两个不同代。
 */
class SegmentsLogLockTest {

  private fun code(): String = File(
    File("src/main/java/com/dsharnessmobile/shell"),
    "LogCollector.kt",
  ).readText().lineSequence()
    .filterNot { it.trimStart().startsWith("//") || it.trimStart().startsWith("*") }
    .joinToString("\n")

  @Test
  fun `分段日志写入必须在同一把锁内`() {
    val code = code()
    assertTrue("必须有 segmentsLock", code.contains("private val segmentsLock = Any()"))
    assertTrue(
      "appendToSegmentsFile 必须整段 synchronized",
      code.contains("private fun appendToSegmentsFile(ctx: Context, line: String) = synchronized(segmentsLock) {"),
    )
  }

  @Test
  fun `两个入口都必须走加锁的写入函数`() {
    val code = code()
    // 直接调用点：emitBootSegments 内部；不得出现「绕过 appendToSegmentsFile 直接 appendText 到该文件」的写法
    assertTrue(code.contains("appendToSegmentsFile(ctx, line)"))
    assertTrue(
      "不得绕过锁直接对 boot-segments.log appendText",
      !code.contains("SEGMENTS_FILE).appendText"),
    )
  }
}
