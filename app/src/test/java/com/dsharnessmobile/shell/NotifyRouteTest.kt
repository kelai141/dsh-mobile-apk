package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 通知落点判据（0.14.11，N1）：交互类通知只有 agent 键，旧实现只认 session 键 ⇒ 点开不落点。
 *
 * 判据分两半：
 * 1. 纯函数行为（session 优先、agent 兜底、都空则 null）；
 * 2. 源码形态（MainActivity 走 resolveTarget，且旧形态「session 为空就 return」不再出现）
 *    —— 撤掉修复即判红，满足「反向验证」。
 */
class NotifyRouteTest {

  private fun source(relative: String): String {
    val candidates = listOf(File(relative), File("app/$relative"))
    val file = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到源码 $relative（工作目录 = " + File(".").absolutePath + "）")
    return file.readText()
  }

  @Test
  fun sessionKeyWinsWhenBothPresent() {
    assertEquals("session-abc", NotifyCenter.resolveNotifyTarget("session-abc", "agent-xyz"))
  }

  @Test
  fun agentKeyIsAcceptedWhenSessionMissing() {
    // 交互类通知的真实形态：只有 agent target。旧实现这里返回 null（点开不落点）。
    assertEquals("agent-xyz", NotifyCenter.resolveNotifyTarget(null, "agent-xyz"))
    assertEquals("agent-xyz", NotifyCenter.resolveNotifyTarget("", "agent-xyz"))
    assertEquals("agent-xyz", NotifyCenter.resolveNotifyTarget("   ", "agent-xyz"))
  }

  @Test
  fun bothEmptyMeansNoTarget() {
    assertNull(NotifyCenter.resolveNotifyTarget(null, null))
    assertNull(NotifyCenter.resolveNotifyTarget("", ""))
    assertNull(NotifyCenter.resolveNotifyTarget("  ", "  "))
  }

  @Test
  fun mainActivityRoutesThroughResolveTarget() {
    val src = source("src/main/java/com/dsharnessmobile/shell/MainActivity.kt")
    assertTrue("consumeNotifyRoute 必须走纯函数解析", src.contains("NotifyCenter.resolveNotifyTarget("))
    assertTrue("必须同时读 session 与 agent 两个键", src.contains("NotifyCenter.EXTRA_TARGET_AGENT"))
    assertFalse(
      "旧形态（只读 session 键、为空即 return）必须消失，否则交互类通知仍然不落点",
      src.contains("val session = intent?.getStringExtra(NotifyCenter.EXTRA_TARGET_SESSION).orEmpty()"),
    )
  }
}
