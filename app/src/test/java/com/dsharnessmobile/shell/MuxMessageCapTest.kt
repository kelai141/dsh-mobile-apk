package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1402 回归：文本帧的**跨分片**累计必须有上限。
 *
 * 缺陷形态：`MAX_FRAME` 只限制单帧大小。一条消息拆成 N 个 `fin=0` 分片时，`textBuf` 会一直
 * 增长到 MAX_FRAME×N——异常或恶意上游能把壳侧直接撑到 OOM。
 *
 * 判据落在「超限即抛 + 缓冲被重置」上：只判大小不判重置的话，超限后缓冲里还留着半条消息，
 * 下一条消息会把它当成自己的开头继续累积。
 */
class MuxMessageCapTest {

  private fun client() = MuxClient("127.0.0.1", 1, "/", {})

  @Test
  fun 累计上限与单帧同量级() {
    assertEquals("跨分片上限取 8 MiB（与 MAX_FRAME 同量级）", 8 * 1024 * 1024, MuxClient.MAX_MESSAGE)
  }

  @Test
  fun 刚好到上限仍可写_再多一字节即断开() {
    val c = client()
    c.appendText(ByteArray(MuxClient.MAX_MESSAGE)) // 边界：不超限
    var thrown: Throwable? = null
    try {
      c.appendText(ByteArray(1))
    } catch (t: Throwable) {
      thrown = t
    }
    assertNotNull("超过累计上限必须抛出（走失败重连，而不是继续吃内存）", thrown)
    assertTrue(
      "异常信息要点明是跨分片累计超限：" + thrown?.message,
      thrown?.message?.contains("message too big") == true,
    )
  }

  @Test
  fun 超限后缓冲被重置_不会被下一条消息继承() {
    val c = client()
    try {
      c.appendText(ByteArray(MuxClient.MAX_MESSAGE + 1))
    } catch (_: Throwable) {
    }
    // 缓冲已 reset：小分片可以重新开始（若没 reset，这里会因为残留而继续逼近上限）
    c.appendText(ByteArray(1))
  }

  @Test
  fun 帧循环的两个文本分支都必须走累计判据() {
    val f = File("src/main/java/com/dsharnessmobile/shell/MuxClient.kt").takeIf { it.isFile }
      ?: File("app/src/main/java/com/dsharnessmobile/shell/MuxClient.kt")
    val code = f.readText().lineSequence()
      .filterNot { it.trimStart().startsWith("//") || it.trimStart().startsWith("*") }
      .joinToString("\n")
    assertTrue(
      "首帧分支必须走 appendText（裸 textBuf.write 会绕过上限）",
      code.contains("0x1 -> { textBuf.reset(); appendText(payload); if (fin) emitText() }"),
    )
    assertTrue(
      "续帧分支必须走 appendText",
      code.contains("0x0 -> { appendText(payload); if (fin) emitText() }"),
    )
  }
}
