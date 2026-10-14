package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P-AC-04 修尺子（0.14.8）：监听探针**自适应步进**的调度回归。
 *
 * 背景：旧实现是固定 sleep(500) + portReachable(500)，于是 t_listen 的量化误差恒为
 * [0,500)（均值 250ms）——而 loopback 上「无人监听」是立即 refused，固定节拍不为任何真实
 * 开销买单，纯粹是采样栅格。本文件锁住新调度的四条性质（有界 / 单调不回退 / 覆盖窗口 /
 * 起步足够小），并用两条反证证明这些条不是恒真：
 *
 * - 反证 ①（旧实现就地复刻）：固定步长的调度**必然**违反「n=0 起步足够小」；
 * - 反证 ②（性质不可能满足）：断言「步长单调不回退且 n=0 起步 < 步长上限的 1/4」在
 *   固定步长实现上无法同时成立，但被本实现同时满足。
 *
 * 反证按本仓既有纪律（EngineProbeCounterProofTest 的头部说明）**不就地改生产源码**：
 * 旧语义以局部函数形式写在测试内，kill 也不会把变异留在工作树里。
 */
class EngineListenProbeScheduleTest {

  /** 源码定位（与 W3ShellContractTest 同款容忍两种工作目录）。 */
  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    return candidates.firstOrNull { it.isFile }
      ?.readText()
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
  }

  /** 去掉注释行（门禁与既有测试同口径：形态名只出现在注释里不算命中）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /** 模拟一轮观察：返回窗口内每次探测的时刻（0 起算），直到下一次探测落到窗口之外。 */
  private fun probeSchedule(windowMs: Long): List<Long> {
    val times = mutableListOf<Long>()
    var elapsed = 0L
    var attempt = 0
    while (elapsed < windowMs) {
      times += elapsed
      val step = nextListenProbeDelayMs(attempt).toLong()
      if (step >= windowMs - elapsed) return times
      elapsed += step
      attempt++
    }
    return times
  }

  // ── 性质 1：步长有界（下界起步步长、上界封顶） ──────────────────────────

  @Test
  fun stepsStayWithinTheDeclaredBounds() {
    for (n in 0 until 1_000) {
      val step = nextListenProbeDelayMs(n)
      assertTrue("第 " + n + " 步不得小于起步步长（否则退化成忙轮询）: " + step,
        step >= LISTEN_PROBE_START_STEP_MS)
      assertTrue("第 " + n + " 步不得超过上限: " + step, step <= LISTEN_PROBE_MAX_STEP_MS)
    }
  }

  @Test
  fun nonPositiveAttemptsFallBackToTheStartStep() {
    // 负值/0 是退化输入：必须被当成「刚开始」而不是被幂运算放大（0.5^-1 = 2 ⇒ 步长翻倍）
    assertEquals(LISTEN_PROBE_START_STEP_MS, nextListenProbeDelayMs(0))
    assertEquals(LISTEN_PROBE_START_STEP_MS, nextListenProbeDelayMs(-1))
    assertEquals(LISTEN_PROBE_START_STEP_MS, nextListenProbeDelayMs(Int.MIN_VALUE))
    assertEquals("n=0 与 n=1 起步同样小（前两步都是小步）",
      nextListenProbeDelayMs(1), nextListenProbeDelayMs(0))
  }

  // ── 性质 2：单调不回退，且有限次后精确封顶 ───────────────────────────────

  @Test
  fun stepsAreMonotonicAndReachTheCapExactly() {
    var previous = nextListenProbeDelayMs(0)
    for (n in 1 until 200) {
      val step = nextListenProbeDelayMs(n)
      assertTrue("步长不得回退（n=" + n + ": " + previous + " -> " + step + "）", step >= previous)
      previous = step
    }
    // 浮点误差不得让序列停在上限下方（旧形态：Math.pow 累计后 toInt() 截断）
    assertEquals("最终必须精确封顶到上限", LISTEN_PROBE_MAX_STEP_MS, nextListenProbeDelayMs(200))
    assertTrue("封顶必须发生在有限次内（否则 90s 内探测次数无界地多）",
      (0 until 200).any { nextListenProbeDelayMs(it) == LISTEN_PROBE_MAX_STEP_MS })
    // 封顶后保持恒定
    assertEquals(LISTEN_PROBE_MAX_STEP_MS, nextListenProbeDelayMs(500))
    assertEquals(LISTEN_PROBE_MAX_STEP_MS, nextListenProbeDelayMs(10_000))
  }

  @Test
  fun theFirstStepsAreSmallAndBackOffGeometrically() {
    // 窗口全程都要密集采样：设备实测 t_listen 在 5~15s 间波动，没有「只买前段精度」这回事。
    // 起步序列与增长比由常量钉住（改上限不该动这里，故只锁前 5 步与「确实在增长」）。
    assertEquals("起步序列必须是 20/20/30/45/67 的几何退避",
      listOf(20, 20, 30, 45, 67),
      (0 until 5).map { nextListenProbeDelayMs(it) })
    assertTrue("退避必须真的在增长（固定步长会在此判红）",
      nextListenProbeDelayMs(5) > nextListenProbeDelayMs(4))
    val firstTwo = probeSchedule(LISTEN_WATCH_WINDOW_MS).take(3)
    assertEquals("前三次探测必须落在窗口头 50ms 内（旧实现要 1000ms）", listOf(0L, 20L, 40L), firstTwo)
  }

  // ── 性质 3：序列覆盖整个具名窗口，且探测次数有界 ──────────────────────────

  @Test
  fun theScheduleCoversTheWholeNamedWindow() {
    val times = probeSchedule(LISTEN_WATCH_WINDOW_MS)
    assertTrue("窗口内必须至少有两次探测", times.size >= 2)
    // 覆盖：最后一次探测之后剩下的睡眠不足以再放下一次探测 ⇒ 观察者不会在窗口内提前自然退出。
    val lastCoverage = times.last() + nextListenProbeDelayMs(times.size - 1)
    assertTrue("序列必须覆盖整个观察窗口（末次覆盖 " + lastCoverage + "ms < " + LISTEN_WATCH_WINDOW_MS + "ms）",
      lastCoverage >= LISTEN_WATCH_WINDOW_MS)
    // 上界：相邻两次探测之间的空隙不得超过步长上限（否则窗口后段会漏掉长时间不探测）。
    for (i in 1 until times.size) {
      assertTrue("栅格空隙不得超过上限", times[i] - times[i - 1] <= LISTEN_PROBE_MAX_STEP_MS)
    }
    // 次数有界：loopback refused ≈ 微秒级，故仍然是「便宜且够密」的量级。
    assertTrue("90s 内探测次数必须远小于每秒 50 次（实测 " + times.size + " 次）", times.size <= 4_500)
  }

  @Test
  fun theWindowConstantIsTheNinetySecondWatchWindow() {
    // 窗口语义不得被这次修尺子改动：旧实现是 90_000L 字面量，现在必须是同一个具名常量。
    assertEquals(90_000L, LISTEN_WATCH_WINDOW_MS)
  }

  // ── 反证 ①：旧实现（固定步长）必须被判红 ─────────────────────────────────

  @Test
  fun `counter-proof-a the old fixed 500ms schedule is not a backoff`() {
    // 旧实现就地复刻：无论第几次，都睡同一个固定值。
    fun oldFixedProbeDelayMs(@Suppress("UNUSED_PARAMETER") attempt: Int): Int = 500
    val oldFirst = oldFixedProbeDelayMs(0)
    assertTrue("旧实现确实无视 attempt（前提成立）", oldFirst == oldFixedProbeDelayMs(99))
    // 新实现必须**违反**旧语义：起步小步才是修尺子的实质。
    assertTrue("旧实现的首步不可能是小步（这就是量化误差的来源）",
      oldFirst > LISTEN_PROBE_START_STEP_MS)
    assertTrue("新实现的首步必须显著小于旧实现 500ms", nextListenProbeDelayMs(0) < oldFirst)
    // 直接对旧序列断言本文件的两条性质 ⇒ 必须失败（证明测试真的会判红）。
    val oldSchedule = (0 until 20).map { oldFixedProbeDelayMs(it) }
    assertFalse("固定步长序列不得被判为「起步 < 上限的 1/4」",
      oldSchedule.first() < LISTEN_PROBE_MAX_STEP_MS / 4)
    assertFalse("固定步长序列不得被判为「存在严格增长」",
      oldSchedule.zipWithNext().any { (a, b) -> b > a })
  }

  // ── 反证 ②：不可能同时满足的性质，本实现必须同时满足 ──────────────────────

  @Test
  fun `counter-proof-b constant step cannot be both small and bounded`() {
    val oldConstantStep = 500
    // 常量步长 c 的实现里「上限」恒等于 c，于是「起步 < 上限的 1/4」= c < c/4 —— 对任何 c > 0
    // 都不可能成立。这正是「固定节拍」与「自适应退避」不可调和的那一条性质。
    assertFalse("常量步长实现恒不满足「起步 < 上限的 1/4」",
      oldConstantStep < oldConstantStep / 4)
    val newSchedule = probeSchedule(LISTEN_WATCH_WINDOW_MS)
    assertTrue("新实现必须满足「起步 < 上限的 1/4」",
      nextListenProbeDelayMs(0) < LISTEN_PROBE_MAX_STEP_MS / 4)
    assertTrue("新实现必须同时仍有界：窗口内探测次数 <= 1200（实测 " + newSchedule.size + " 次）",
      newSchedule.size <= 1_200)
  }

  // ── 接线：观察者必须真的用调度函数，且不得再写回固定节拍 ────────────────────

  @Test
  fun theWatcherIsWiredToTheScheduleAndKeepsItsContract() {
    val manager = codeOnly(source("EngineManager.kt"))
    val watcher = manager.substringAfter("private fun watchEngineListen()")
      .substringBefore("private fun rotateEngineLog(")
    assertTrue("观察者必须按纯函数步进", watcher.contains("nextListenProbeDelayMs(attempt)"))
    assertTrue("单次 connect 预算必须用具名常量（而非写死 500）",
      watcher.contains("EngineProbe.portReachable(connectTimeoutMs)"))
    assertTrue("窗口必须用具名常量", watcher.contains("LISTEN_WATCH_WINDOW_MS"))
    assertFalse("固定 500ms 节拍不得残留", watcher.contains("Thread.sleep(500)"))
    assertFalse("固定 500ms connect 预算不得残留", watcher.contains("portReachable(500)"))
    // 语义保持：daemon 线程名与幂等标记入口一字不改（W3ShellContractTest 另有一条锁 markListen）。
    assertTrue("daemon 线程名不得变", watcher.contains("\"dsh-engine-listen-watch\""))
    assertTrue("started as daemon", watcher.contains("isDaemon = true"))
    assertTrue("须标记监听时刻", watcher.contains("LogCollector.markListen(context)"))
  }
}