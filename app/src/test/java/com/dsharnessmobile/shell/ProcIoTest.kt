package com.dsharnessmobile.shell

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #211.1（FX-211.1 / E-1）回归：子进程读取的三态可区分。
 *
 * 旧实现把「排水超时」（进程已退出但管道被持住）与「真空输出」都返回 ""——
 * 调用方无法区分「状态未知」与「确实没有」，UndoGate 因此把超时误判成「无快照可回滚」。
 *
 * 本测试同时给出：
 * - 桩进程（waitFor 成功但 inputStream 永不 EOF）= 持管道不放的进程 → drainTimedOut；
 * - 桩进程（空输入流）= 真空输出 → 非超时；
 * - 真实子进程：正常短命令 + 超时（echo 部分输出后挂住）。
 */
class ProcIoTest {

  @Test
  fun drainTimeoutIsNotTheSameShapeAsVacuousOutput() {
    val blocking = BlockingStream()
    val held = StubProcess(blocking, exitImmediately = true)
    val heldResult = ProcIo.readBounded(held, 1)
    blocking.release()

    val vacuous = ProcIo.readBounded(StubProcess(ByteArrayInputStream(ByteArray(0)), exitImmediately = true), 1)

    // 两者文本都为空——正是旧实现同形之处（E-1）
    assertEquals("", heldResult.text)
    assertEquals("", vacuous.text)

    assertFalse("进程已退出，不是 exit 超时", heldResult.exitTimedOut)
    assertTrue("进程已退出但管道被持住 = drain 超时（第三态）", heldResult.drainTimedOut)
    assertTrue(heldResult.timedOut)
    assertFalse("真空输出不是超时态", vacuous.timedOut)
    assertFalse(vacuous.drainTimedOut)
    assertFalse(vacuous.truncated)
    assertNotEquals(heldResult.marker(), vacuous.marker())
    assertTrue(heldResult.timeoutText("x").contains(ProcIo.TIMEOUT_FLAG))
    assertFalse(vacuous.timeoutText("x").contains(ProcIo.TIMEOUT_FLAG))
  }

  @Test
  fun boundedDrainTruncatesAtTheLimitAndKeepsDraining() {
    val big = ByteArray(4096) { 'a'.code.toByte() }
    val bounded = ProcIo.drainBounded(ByteArrayInputStream(big), 1024)
    assertEquals("超限必须截断到上限", 1024, bounded.text.length)
    assertTrue(bounded.truncated)

    val small = ProcIo.drainBounded(ByteArrayInputStream("ok".toByteArray()), 1024)
    assertEquals("ok", small.text)
    assertFalse(small.truncated)
  }

  @Test
  fun readBoundedMarksTruncatedOutputInTheText() {
    val big = ByteArray(4096) { 'b'.code.toByte() }
    val result = ProcIo.readBounded(StubProcess(ByteArrayInputStream(big), exitImmediately = true), 5, limitBytes = 1024)
    assertTrue(result.truncated)
    assertFalse(result.timedOut)
    assertTrue("截断必须带标注（不得静默）", result.text.contains(ProcIo.TRUNCATED_FLAG))
    assertTrue(result.text.length >= 1024)
  }

  @Test
  fun realProcessNormalOutputIsNotFlagged() {
    val proc = shellProcess("echo hello-procio")
    val result = ProcIo.readBounded(proc, 30)
    assertFalse("正常短命令不得被判超时", result.timedOut)
    assertFalse(result.truncated)
    assertTrue("输出必须被读到: " + result.text, result.text.contains("hello-procio"))
  }

  @Test
  fun realProcessTimeoutKeepsPartialOutputAndAMarker() {
    val proc = holdingProcess()
    val result = ProcIo.readBounded(proc, 1)
    assertTrue("挂住的进程必须判为超时", result.timedOut)
    assertTrue(result.marker().contains(ProcIo.TIMEOUT_FLAG))
    // 已读部分要么在场（排水线程先拿到 echo），要么为空；但超时标记必须与真空输出不同形。
    assertTrue(result.text.isEmpty() || result.text.contains("partial-procio"))
    assertTrue("超时态文本必须带形态标记", result.textWithMarkers().contains(ProcIo.TIMEOUT_FLAG))
  }

  private fun shellProcess(script: String): Process {
    val pb = if (isWindows()) ProcessBuilder("cmd.exe", "/c", script) else ProcessBuilder("/bin/sh", "-c", script)
    return pb.redirectErrorStream(true).start()
  }

  /** 先输出一行、后再挂住约 20s 的真实子进程（Windows 用 ping 代替 sleep）。 */
  private fun holdingProcess(): Process {
    val pb = if (isWindows()) {
      ProcessBuilder("cmd.exe", "/c", "echo partial-procio & ping -n 20 127.0.0.1 >nul")
    } else {
      ProcessBuilder("/bin/sh", "-c", "echo partial-procio; sleep 20")
    }
    return pb.redirectErrorStream(true).start()
  }

  private fun isWindows(): Boolean =
    System.getProperty("os.name").orEmpty().lowercase().contains("win")

  /** 桩进程：waitFor 结果可控，inputStream 可永不 EOF（= 管道被持住）。 */
  private class StubProcess(
    private val input: InputStream,
    private val exitImmediately: Boolean,
  ) : Process() {
    override fun getOutputStream(): OutputStream = java.io.ByteArrayOutputStream()
    override fun getInputStream(): InputStream = input
    override fun getErrorStream(): InputStream = ByteArrayInputStream(ByteArray(0))
    override fun waitFor(): Int = 0
    override fun waitFor(timeout: Long, unit: TimeUnit): Boolean = exitImmediately
    override fun exitValue(): Int = 0
    override fun destroy() {}
    override fun isAlive(): Boolean = !exitImmediately
    override fun destroyForcibly(): Process = this
  }

  /** 永不 EOF 的输入流（持管道不放）；[release] 后返回 EOF 以便测试线程收尾。 */
  private class BlockingStream : InputStream() {
    private val closed = AtomicBoolean(false)
    fun release() { closed.set(true) }
    override fun read(): Int {
      while (!closed.get()) {
        try {
          Thread.sleep(10)
        } catch (_: InterruptedException) {
          return -1
        }
      }
      return -1
    }
    override fun read(b: ByteArray, off: Int, len: Int): Int = read()
  }
}
