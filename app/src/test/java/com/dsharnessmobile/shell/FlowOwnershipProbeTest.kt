package com.dsharnessmobile.shell

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 所有权取证探针（只加日志，不改行为）。
 *
 * ## 为什么需要
 *
 * 设备实测（`127.0.0.1:16448`，v0.14.9）：冷启时 `engine-start-deferred-no-transaction`
 * 与它的 `-timeout` **成对稳定复现**，日志宣称「未拉起引擎」，而 `node` 进程其实早 2 秒就在跑。
 * 真正被丢弃的是**这一次**启动请求；把它拉起来的另有其流。
 *
 * 排障者拿不到的关键信息是「**当时到底是谁持有所有权**」。旧实现 `begin()`/`finish()`
 * 一行日志都没有，只能从候选清单（`start` / `restart` / onCreate / onResume / 看门狗）里猜。
 *
 * ## 本文件的判据
 *
 * ① 三处留痕都必须真的发射（begin 授予 / begin 拒绝 / finish 释放 / defer 快照）；
 * ② 字段只有 generation 与 caller 标识 —— **不得含用户数据**（路径、会话、prompt）；
 * ③ 探针**不改变行为**：有无 sink，grant/deny/finish 的结果必须完全一致。
 *
 * 判据全部走真实 [StartupFlowOwnership]（注入记录型 sink），不依赖 Android 的 LogCollector
 * （它在 JVM 单测里没有 appContext，是静默 no-op —— 那样探针在测试里等于不存在，是假绿）。
 */
class FlowOwnershipProbeTest {

  private class Recorder {
    val lines = java.util.Collections.synchronizedList(mutableListOf<String>())
    fun sink(): (String) -> Unit = { message -> lines.add(message); Unit }
    fun joined(): String = lines.joinToString(" | ")
  }

  @Test
  fun beginGrantIsProbedWithGenerationAndCaller() {
    val rec = Recorder()
    val gate = StartupFlowOwnership(rec.sink())
    val token = gate.begin()
    assertNotNull("首选 begin 必须成功", token)
    val text = rec.joined()
    assertTrue("必须记下授予及其 generation，实得：" + text, text.contains("flow.begin granted generation=" + token!!.generation))
    assertTrue("必须带 caller 标识", text.contains("caller="))
    gate.finish(token)
  }

  /**
   * defer 分支的判据：**必写一行**，且那行必须能回答「谁在占」。
   *
   * 这是本 PR 的核心——设备现场真正缺的就是这一行。
   */
  @Test
  fun deferredSnapshotAlwaysCarriesOwnerGenerationAndCaller() {
    val rec = Recorder()
    val gate = StartupFlowOwnership(rec.sink())
    val owner = gate.begin()!!
    // 第二个请求抢不到 —— 这正是 defer 分支的前置条件
    assertNull("第二次 begin 必须被拒（另一个已持有）", gate.begin())

    val snapshot = gate.deferredOwnerSnapshot()
    assertTrue("defer 快照必须报出持有者的 generation，实得：" + snapshot,
      snapshot.contains("ownerGeneration=" + owner.generation))
    assertTrue("defer 快照必须带 caller", snapshot.contains("caller="))
    assertTrue("defer 快照必须报出 running 状态", snapshot.contains("running="))
    assertTrue("defer 快照必须报出 destroyed 状态", snapshot.contains("destroyed="))
    gate.finish(owner)
  }

  @Test
  fun beginDenialIsProbedWithOwnerIdentity() {
    val rec = Recorder()
    val gate = StartupFlowOwnership(rec.sink())
    val owner = gate.begin()!!
    rec.lines.clear()
    assertNull(gate.begin())
    val text = rec.joined()
    assertTrue("抢不到时必须留痕，实得：" + text, text.contains("flow.begin denied"))
    assertTrue("抢不到时必须报出占用者的 generation，实得：" + text,
      text.contains("ownerGeneration=" + owner.generation))
    gate.finish(owner)
  }

  @Test
  fun finishReleaseIsProbed() {
    val rec = Recorder()
    val gate = StartupFlowOwnership(rec.sink())
    val token = gate.begin()!!
    rec.lines.clear()
    gate.finish(token)
    val text = rec.joined()
    assertTrue("释放必须留痕，实得：" + text, text.contains("flow.finish released generation=" + token.generation))
  }

  /** 幂等 finish 的重复调用也要留痕（它正是「generation 已换代」的诊断线索）。 */
  @Test
  fun redundantFinishIsProbedAsIgnored() {
    val rec = Recorder()
    val gate = StartupFlowOwnership(rec.sink())
    val token = gate.begin()!!
    gate.finish(token)
    rec.lines.clear()
    gate.finish(token)
    val text = rec.joined()
    assertTrue("重复 finish 必须记为 ignored，实得：" + text, text.contains("flow.finish ignored generation=" + token.generation))
  }

  /**
   * 探针**不得改变行为**：同一个序列在「有 sink」与「无 sink」下结果必须一致。
   *
   * 这条防的是「为了留痕顺手改了判据」——取证代码最坏的结果就是把启动流带偏。
   */
  @Test
  fun probeDoesNotChangeDecisionOutcomes() {
    fun run(withSink: Boolean): String {
      val gate = if (withSink) StartupFlowOwnership({ }) else StartupFlowOwnership()
      val sb = StringBuilder()
      val first = gate.begin()
      sb.append("first=").append(first?.generation ?: "null").append(';')
      val second = gate.begin()
      sb.append("second=").append(second?.generation ?: "null").append(';')
      sb.append("running=").append(gate.running).append(';')
      if (first != null) gate.finish(first)
      sb.append("afterFinish=").append(gate.running).append(';')
      val third = gate.begin()
      sb.append("third=").append(third?.generation ?: "null").append(';')
      if (third != null) gate.finish(third)
      return sb.toString()
    }
    assertEquals("探针不得改变任何决策结果", run(withSink = false), run(withSink = true))
  }

  /** 探针自身抛异常不得冒到调用方（取证把启动流带崩是本末倒置）。 */
  @Test
  fun throwingSinkNeverBreaksTheGate() {
    val gate = StartupFlowOwnership({ throw IllegalStateException("sink boom") })
    val token = gate.begin()
    assertNotNull("sink 抛异常时 begin 仍必须成功", token)
    gate.finish(token!!)
    assertTrue("finish 之后所有权必须空出来", gate.begin() != null)
  }

  /** 并发下探针不丢行、不串行化门禁（begin 只应授予一次）。 */
  @Test
  fun concurrentBeginGrantsExactlyOneOwner() {
    val rec = Recorder()
    val gate = StartupFlowOwnership(rec.sink())
    val n = 8
    val start = CountDownLatch(1)
    val done = CountDownLatch(n)
    val granted = java.util.concurrent.atomic.AtomicInteger(0)
    val tokens = java.util.Collections.synchronizedList(mutableListOf<StartupFlowOwnership.Token>())
    for (i in 0 until n) {
      Thread {
        start.await()
        val t = gate.begin()
        if (t != null) {
          granted.incrementAndGet()
          tokens.add(t)
        }
        done.countDown()
      }.start()
    }
    start.countDown()
    assertTrue("并发 begin 必须收敛", done.await(10, TimeUnit.SECONDS))
    assertEquals("同一时刻只允许一个持有者", 1, granted.get())
    val grantedLines = rec.lines.count { it.startsWith("flow.begin granted") }
    assertEquals("授予留痕必须恰好一条", 1, grantedLines)
    tokens.toList().forEach { gate.finish(it) }
  }
}
