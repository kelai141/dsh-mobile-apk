package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 2026-10-25 审计批（C1 + I2/I3/I4/I6/I7）的源码级断言。
 *
 * ConsoleSession 持有真进程与读线程，JVM 单测无法实例化——这里沿用仓内既有的
 * 「源码文本断言」模式（RepairGateTest / PluginManagement 相关测试同款）：锁住
 * 修复形态不被后续改动无声回退。行为面由设备验证承载（console.html + 真机）。
 */
class ConsoleSessionAuditTest {
  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).first { it.isFile }.readText()

  @Test
  fun `C1 kill 帧直写局部 proc 而非读已置 null 的字段`() {
    val fn = source("ConsoleSession.kt").substringAfter("fun destroy()").substringBefore("companion object")
    assertTrue(
      "destroy 必须在置空字段之前取局部 proc，kill 帧直写该局部——旧实现 send 读字段恒 null，kill 协议是死代码",
      fn.contains("proc.outputStream.write(ConsolePty.KILL_MESSAGE"),
    )
    assertFalse(
      "destroy 的 kill 路径不得再经 send()（它读已置 null 的字段）",
      fn.contains("send(ConsolePty.KILL_MESSAGE"),
    )
    assertTrue("destroy 必须给中继短窗处理 kill（否则紧随的 destroy 与 kill 帧竞争）", fn.contains("waitFor"))
  }

  @Test
  fun `I3 握手窗口输入先缓冲 ready 帧统一重放`() {
    val s = source("ConsoleSession.kt")
    val write = s.substringAfter("fun writeRaw(text: String)").substringBefore("fun writeCommand")
    assertTrue("writeRaw 必须在 usingPty && !ptyReady 时缓冲而非裸写", write.contains("pendingInput.append(text)"))
    val reader = s.substringAfter("if (op == \"ready\")").substringBefore("} else if (op == \"error\")")
    assertTrue("ready must use the serialized handshake", reader.contains("completePtyHandshake(proc, gen)"))
    assertTrue("queued input must use the relay protocol", s.contains("writeMessage(replay)"))
  }

  @Test
  fun `I2 resize 帧只在 PTY 模式发送`() {
    val fn = source("ConsoleSession.kt").substringAfter("fun resize(cols: Int").substringBefore("fun writeCommand")
    assertTrue("resize 必须以 usingPty 守卫（降级路径写 stdin 等于注入命令）", fn.contains("if (usingPty) send("))
  }

  @Test
  fun `I4 中继 error 报 FAILED 而非 READY`() {
    val s = source("ConsoleSession.kt")
    val err = s.substringAfter("} else if (op == \"error\")").substringBefore("} else if (op == \"exit\")")
    assertTrue("error 帧必须报 State.FAILED（中继随即自退，READY 是把死会话说成可用）", err.contains("State.FAILED"))
    assertFalse(err.contains("State.READY"))
    // EOF 兜底：PTY 模式 exit 帧缺席时也要报 onExit
    val tail = s.substringAfter("EOF 兜底").take(800)
    assertTrue("EOF 必须兜底 onExit（error 后没有 exit 帧）", tail.contains("listener.onExit(code)"))
  }

  @Test
  fun `I6 中继 stderr 有专职 drain 且降级路径合并 stderr`() {
    val s = source("ConsoleSession.kt")
    assertTrue("PTY 模式必须有 stderr drain 线程（无人读的管道 64KB 写满即冻结）", s.contains("proc.errorStream.bufferedReader"))
    assertTrue("非 PTY 降级必须 redirectErrorStream 合并", s.contains("if (!canUsePty) p.redirectErrorStream(true)"))
  }

  @Test
  fun `I7 输出按 16KB 或 50ms 聚合`() {
    val s = source("ConsoleSession.kt")
    assertTrue("读线程必须有带独立期限的输出聚合", s.contains("ConsoleOutputBatcher(OUTPUT_FLUSH_BYTES, TimeUnit.NANOSECONDS.toMillis(OUTPUT_FLUSH_NS))"))
    assertTrue("退出和异常路径必须排空并释放聚合器", s.contains("output.close()"))
    assertTrue("data 帧不得逐帧直发 listener.onOutput", !s.contains("if (chunk.isNotEmpty() && generation == gen) listener.onOutput(chunk)"))
  }

  @Test
  fun `I1 submit 直传原文不再 decode`() {
    val bridge = source("ConsoleActivity.kt").substringAfter("fun submit(command: String)").substringBefore("val engine = EngineManager")
    assertTrue("submit 必须走 writeCommand（原文直传）", bridge.contains("session.writeCommand(command)"))
    assertFalse("submit 不得对输入框原文跑 decode（含反斜杠命令被改写/拆分）", bridge.contains("decode(command)"))
  }
}
