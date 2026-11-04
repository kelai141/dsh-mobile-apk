package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1361 回归：无障碍快照换树/清空时必须回收节点句柄。
 *
 * 缺陷形态：每次重建快照都新建最多 MAX_NODES 个 `AccessibilityNodeInfo` 并覆盖旧 Snapshot，
 * 旧树直接丢弃不回收。minSdk 26——API<33 上不 `recycle()` 会让节点池耗尽，`getChild` 开始返回
 * null，动作层报「行 N 已不存在」的假失败。
 */
class A11yNodeRecycleTest {

  private fun code(): String = File(
    File("src/main/java/com/dsharnessmobile/shell"),
    "DeviceControlService.kt",
  ).readText().lineSequence()
    .filterNot { it.trimStart().startsWith("//") || it.trimStart().startsWith("*") }
    .joinToString("\n")

  @Test
  fun `必须有回收辅助并按 identity 去重`() {
    val code = code()
    assertTrue("必须有 recycleSnapshot", code.contains("private fun recycleSnapshot(target: Snapshot?)"))
    assertTrue(
      "必须按 identity 去重（nodes 与 rowNodes 共享实例）",
      code.contains("java.util.IdentityHashMap<AccessibilityNodeInfo, Boolean>()"),
    )
    assertTrue("必须真的调用 recycle()", code.contains("node.recycle()"))
  }

  @Test
  fun `换树与清空都必须先回收`() {
    val code = code()
    assertTrue(
      "换树前必须回收旧树",
      code.contains("recycleSnapshot(snapshot)\n      snapshot = fresh"),
    )
    assertTrue(
      "清空快照时必须回收",
      code.contains("synchronized(lock) { recycleSnapshot(snapshot); snapshot = null }"),
    )
  }
}
