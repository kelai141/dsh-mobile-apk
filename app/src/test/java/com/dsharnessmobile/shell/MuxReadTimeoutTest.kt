package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1401 回归：Mux 客户端全链路必须有读超时。
 *
 * 缺陷形态：从不设置 `soTimeout`——网关 accept 后不回 upgrade、或引擎被杀而 TCP 未 RST 时，
 * 握手 `readLine` 与帧循环 `ins.read()` 都永久阻塞。读线程卡死意味着重连循环里的退避与自愈
 * 都不进入，审批卡与提问卡静默不弹，直到重启应用。
 *
 * 判据落在「两个阶段各自设了超时」+「超时被翻译成失败（走退避）」上：
 * 只设握手不设帧读，帧循环照样能挂死；超时被吞掉不抛，退避同样进不去。
 */
class MuxReadTimeoutTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  @Test
  fun 握手与帧循环都必须有读超时() {
    val code = codeOnly(source("MuxClient.kt"))
    assertTrue("握手阶段必须设 soTimeout", code.contains("s.soTimeout = HANDSHAKE_TIMEOUT_MS"))
    assertTrue("帧循环必须设 soTimeout", code.contains("s.soTimeout = READ_TIMEOUT_MS"))
    assertTrue(
      "超时必须翻译成失败（SocketTimeoutException → IOException，走 loop 的退避）",
      code.contains("catch (timeout: java.net.SocketTimeoutException)"),
    )
    assertTrue("握手超时值必须是有名字的常量", code.contains("private const val HANDSHAKE_TIMEOUT_MS = 5_000"))
    assertTrue("帧读超时值必须是有名字的常量", code.contains("private const val READ_TIMEOUT_MS = 60_000"))
  }

  @Test
  fun 帧读超时必须发生在握手之后() {
    val code = codeOnly(source("MuxClient.kt"))
    val handshake = code.indexOf("s.soTimeout = HANDSHAKE_TIMEOUT_MS")
    val frame = code.indexOf("s.soTimeout = READ_TIMEOUT_MS")
    val loop = code.indexOf("frameLoop(ins, out)")
    assertTrue("两处超时都必须存在", handshake >= 0 && frame >= 0 && loop >= 0)
    assertTrue("握手超时必须先设（否则握手阶段仍会挂死）", handshake < frame)
    assertTrue("帧读超时必须紧接在进入帧循环之前设置", frame < loop)
  }
}
