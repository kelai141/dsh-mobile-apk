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

  private fun harness(sdkInt: Int = 32): Pair<GenerationalNodeRecycler<FakeNode>, MutableList<String>> {
    val order = ArrayList<String>()
    val recycler = GenerationalNodeRecycler<FakeNode>(recycle = { node ->
      node.recycles += 1
      order.add(node.name)
    }, sdkInt = sdkInt)
    return recycler to order
  }

  /**
   * issue #1522：回收点必须有 `SDK_INT < 33` 判据，且判据要能**同时**验两个方向。
   *
   * 直读 `Build.VERSION.SDK_INT` 的写法只能在跑测试的那一档上验证（JVM 单测里它是 0），
   * 另一档永远测不到——所以判定注入到构造参数，判据才可能对两个方向都成立。
   */
  @Test
  fun apiBelow33MustRecycle() {
    val (recycler, order) = harness(sdkInt = 32)
    recycler.retire(listOf(FakeNode("a")), emptyList())
    assertEquals("API<33：换代必须真的回收上一代", 1, recycler.retire(listOf(FakeNode("b")), emptyList()))
    assertEquals(listOf("a"), order)
    assertEquals(1, recycler.recycles)
  }

  @Test
  fun api33AndAboveMustNotRecycleAndMustNotThrow() {
    val (recycler, order) = harness(sdkInt = 33)
    recycler.retire(listOf(FakeNode("a")), emptyList())
    assertEquals("API>=33：recycle() 已是 no-op，不得再调用", 0, recycler.retire(listOf(FakeNode("b")), emptyList()))
    assertEquals("API>=33：一次 recycle 都不许发生", 0, recycler.recycles)
    assertTrue("API>=33：不得抛", order.isEmpty())
    assertEquals("API>=33：drain 同样不回收", 0, recycler.drain())
    assertEquals(0, recycler.recycles)
  }

  @Test
  fun recycleFailureIsNotSwallowedSilently() {
    // 失败必须记账（计数仍前进），不能像旧实现那样被 runCatching 吞掉后无法判断回收有没有发生。
    var attempted = 0
    val recycler = GenerationalNodeRecycler<FakeNode>(recycle = { attempted += 1; throw IllegalStateException("boom") }, sdkInt = 32)
    recycler.retire(listOf(FakeNode("a")), emptyList())
    assertEquals("失败也要记账一次尝试", 1, recycler.retire(listOf(FakeNode("b")), emptyList()))
    assertEquals(1, attempted)
  }

  /**
   * issue #1521：兜底重定位（`nodeAtChildPath` / `nodeByFingerprint`）产生的节点没有持有者，
   * 不进 `rowNodes`，旧实现因此既不回收也不受换代覆盖。
   *
   * 修法是**收编进当前一代**而不是就地回收——动作还带着它出锁 `performAction`，
   * 就地回收就是 #1510 的 use-after-recycle。
   */
  @Test
  fun adoptedFallbackNodeIsRecycledOnNextGenerationNotImmediately() {
    val (recycler, order) = harness()
    val fallback = FakeNode("fallback")
    recycler.adopt(fallback)
    assertEquals("收编不得就地回收（动作还在锁外用着它）", 0, fallback.recycles)
    assertEquals(1, recycler.retiredCount())
    recycler.retire(listOf(FakeNode("g2")), emptyList())
    assertEquals("下一次换代必须把它真正回收", 1, fallback.recycles)
    assertEquals(listOf("fallback"), order)
  }

  @Test
  fun adoptedNodeStillHeldBySnapshotIsNotDoubleRecycled() {
    // 兜底路径返回的节点如果恰好就是快照里那个（stored 命中后仍走 adopt 的将来改动），
    // 收编 + 换代不得让它被回收两次。
    val (recycler, order) = harness()
    val shared = FakeNode("shared")
    recycler.retire(listOf(shared), listOf(shared))
    recycler.adopt(shared)
    recycler.retire(listOf(FakeNode("g2")), emptyList())
    assertEquals("同一实例只能回收一次", 1, shared.recycles)
    assertEquals(listOf("shared"), order)
  }

  @Test
  fun drainRecyclesAdoptedFallbackNodes() {
    val (recycler, _) = harness()
    val fallback = FakeNode("fallback")
    recycler.adopt(fallback)
    assertEquals(1, recycler.drain())
    assertEquals("服务销毁必须把收编的兜底节点也收干净", 1, fallback.recycles)
    assertEquals(0, recycler.retiredCount())
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
    assertTrue("兜底重定位的节点必须被回收器收编（issue #1521）", code.contains("nodeRecycler.adopt("))
    assertTrue("不得再有立即回收整棵树的入口", !code.contains("recycleSnapshot("))
  }

  /**
   * issue #1510：teardown 不得**就地**回收——动作可能正持着节点在锁外 performAction，
   * 立即回收就是 use-after-recycle（API<33 抛 IllegalStateException，动作层又报「行 N 已不存在」）。
   */
  @Test
  fun teardownDefersRecycleInsteadOfRecyclingInPlace() {
    val lines = serviceCode().split("\n")
    val start = lines.indexOfFirst { it.contains("private fun teardown()") }
    assertTrue("找不到 teardown", start >= 0)
    val body = lines.drop(start + 1).takeWhile { it.isNotBlank() }.joinToString("\n")
    assertTrue("teardown 体内必须换代（本代进 retired）", body.contains("nodeRecycler.retire("))
    assertTrue("teardown 必须安排宽限后的回收", body.contains("postDelayed("))
    assertTrue("teardown 不得同步 drain（会与锁外 performAction 竞争）", !body.contains("drain() } } }"))
    assertTrue(
      "drain 只能出现在 postDelayed 的回调里（延迟回收），不得裸调",
      !body.replace("postDelayed({ runCatching { nodeRecycler.drain() } }", "").contains("nodeRecycler.drain()"),
    )
  }
}