package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1361：快照节点句柄的**延迟回收**（方案 B）。
 *
 * 判据是**行为**，不是源码文本：假节点 + 可注入 recycle 计数，直接跑回收器。
 * 源码契约另有一条，只作接线补充，不替代行为。
 */
class A11yNodeRecycleTest {

  private class FakeNode(val name: String) {
    var recycles = 0
  }

  private fun harness(): Pair<GenerationalNodeRecycler<FakeNode>, MutableList<String>> {
    val order = ArrayList<String>()
    val recycler = GenerationalNodeRecycler<FakeNode> { node ->
      node.recycles += 1
      order.add(node.name)
    }
    return recycler to order
  }

  @Test
  fun sharedInstanceIsRecycledOnlyOnce() {
    val (recycler, order) = harness()
    val shared = FakeNode("shared")
    recycler.retire(listOf(shared), listOf(shared))
    assertEquals("第一代不下手（延迟一代）", 0, order.size)
    recycler.retire(listOf(FakeNode("g2")), emptyList())
    assertEquals("同一实例只能回收一次", 1, shared.recycles)
  }

  @Test
  fun nodeOnlyInNodesIsStillRecycled() {
    val (recycler, _) = harness()
    val onlyInNodes = FakeNode("only-nodes")
    val rowNode = FakeNode("row")
    recycler.retire(listOf(onlyInNodes, rowNode), listOf(rowNode))
    recycler.retire(emptyList(), emptyList())
    assertEquals("nodes 里的实例也必须回收", 1, onlyInNodes.recycles)
    assertEquals(1, rowNode.recycles)
  }

  @Test
  fun retiredGenerationSurvivesOneRound() {
    val (recycler, order) = harness()
    val node = FakeNode("n1")
    recycler.retire(listOf(node), emptyList())
    assertEquals("刚退休的一代不得立刻回收", 0, node.recycles)
    assertEquals(1, recycler.retiredCount())
    assertTrue(order.isEmpty())
  }

  @Test
  fun secondGenerationRecyclesExactlyTheFirst() {
    val (recycler, _) = harness()
    val first = FakeNode("first")
    val second = FakeNode("second")
    recycler.retire(listOf(first), emptyList())
    val recycled = recycler.retire(listOf(second), emptyList())
    assertEquals("恰好回收第一代的那一个", 1, recycled)
    assertEquals(1, first.recycles)
    assertEquals("第二代不得被动", 0, second.recycles)
    assertEquals(1, recycler.retiredCount())
  }

  @Test
  fun drainRecyclesTheRetainedGeneration() {
    val (recycler, _) = harness()
    val node = FakeNode("live")
    recycler.retire(listOf(node), emptyList())
    assertEquals(1, recycler.drain())
    assertEquals("服务销毁必须收干净", 1, node.recycles)
    assertEquals(0, recycler.retiredCount())
  }

  private fun serviceCode(): String = File(
    File("src/main/java/com/dsharnessmobile/shell"),
    "DeviceControlService.kt",
  ).readText().lineSequence()
    .filterNot { it.trimStart().startsWith("//") || it.trimStart().startsWith("*") }
    .joinToString("\n")

  @Test
  fun serviceWiresTheDeferredRecycler() {
    val code = serviceCode()
    assertTrue("必须用延迟回收器", code.contains("GenerationalNodeRecycler<AccessibilityNodeInfo>"))
    assertTrue("换树必须换代", code.contains("nodeRecycler.retire(nodes.values, rowNodes); snapshot = fresh"))
    assertTrue("服务销毁必须 drain", code.contains("nodeRecycler.drain()"))
    assertTrue("兜底路径的中间跳必须用后即回收", code.contains(".also { runCatching { node.recycle() } }"))
    assertTrue("不得再有立即回收整棵树的入口", !code.contains("recycleSnapshot("))
  }
}