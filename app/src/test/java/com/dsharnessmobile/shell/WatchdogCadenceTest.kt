package com.dsharnessmobile.shell

import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * §6.3 看门狗健康态降频（0.14.10 功耗面）的回归。
 *
 * 缺陷形态（审计 §6.3）：EngineService 每 5 秒一拍 assessProbe，而它包含
 * 「HTTP 探活（超时预算 2.5 秒）+ 读 engine.log 尾部 4KB + portReachable(1s)」，
 * 健康时多数拍的结果完全一样——纯白烧 CPU。
 *
 * 陷阱（审计原文点名）：DEGRADED_SLOW_GRACE_TICKS 与阶梯拍数**按 5 秒拍标定**。
 * 若只把调度降到 20 秒而不换算，进入 DEGRADED_HTTP 后的 30 秒阶梯会变成 120 秒、
 * 90 秒的慢宽限变成 360 秒。
 *
 * 本用例集锁死：
 *  ① 拍长选择：健康 20 秒、DEGRADED/DEAD/冷启动立刻回 5 秒；
 *  ② 标准拍折算：20 秒拍折 4 个标准拍，故「6 个标准拍」仍是 30 秒；
 *  ③ 端到端时间：健康态进入 DEGRADED_HTTP 后，重启触发点与降频前**同一时刻**，
 *     熔断（DEAD）仍在 60 秒量级——这两条是审计要求的判据本身。
 */
class WatchdogCadenceTest {

  @Before fun setUp() = WatchdogV2.reset()

  @After fun tearDown() = WatchdogV2.reset()

  // ── ① 拍长选择 ─────────────────────────────────────────────

  @Test
  fun 健康态降频到二十秒_其余状态立刻回五秒() {
    assertEquals("健康态：审计要求 15–30 秒，取 20 秒", 20_000L, WatchdogV2.HEALTHY_TICK_MS)
    assertEquals("非健康态必须保留 5 秒拍", 5_000L, WatchdogV2.ACTIVE_TICK_MS)
    assertEquals(WatchdogV2.HEALTHY_TICK_MS, WatchdogV2.nextTickDelayMs(WatchdogV2.ProbeState.HEALTHY))
    // 三种 DEGRADED/DEAD 都必须回 5 秒：恢复动作不能被长间隔拖成三倍时长。
    for (state in listOf(
      WatchdogV2.ProbeState.DEGRADED_HTTP,
      WatchdogV2.ProbeState.DEGRADED_LOG,
      WatchdogV2.ProbeState.DEAD,
    )) {
      assertEquals(state.toString() + " 必须回到 5 秒拍", WatchdogV2.ACTIVE_TICK_MS, WatchdogV2.nextTickDelayMs(state))
    }
    assertEquals(
      "冷启动窗口即便探活健康也要 5 秒拍（每拍都在判「起来没有」）",
      WatchdogV2.ACTIVE_TICK_MS,
      WatchdogV2.nextTickDelayMs(WatchdogV2.ProbeState.HEALTHY, booting = true),
    )
  }

  // ── ② 标准拍折算 ───────────────────────────────────────────

  @Test
  fun 拍长折算成标准拍_二十秒折四拍() {
    assertEquals("5 秒 = 1 个标准拍", 1, WatchdogV2.tickUnits(5_000L))
    assertEquals("20 秒 = 4 个标准拍", 4, WatchdogV2.tickUnits(20_000L))
    assertEquals("12.5 秒向上取整 = 3 拍", 3, WatchdogV2.tickUnits(12_500L))
    assertEquals("首拍（elapsed 0）按 1 拍", 1, WatchdogV2.tickUnits(0L))
    assertEquals("时钟回退/负值按 1 拍", 1, WatchdogV2.tickUnits(-9_000L))
    assertEquals("调度抖动（4.2 秒）不得折成 0 拍", 1, WatchdogV2.tickUnits(4_200L))
    assertEquals("单拍最多折算到阶梯阈值，防 Doze 后一拍顶满熔断", WatchdogV2.MAX_TICK_UNITS, WatchdogV2.tickUnits(600_000L))
    assertEquals("折算上限即阶梯阈值", WatchdogV2.DEGRADED_RESTART_CONFIRMATIONS, WatchdogV2.MAX_TICK_UNITS)
  }

  // ── ③ 端到端：阶梯总时长与降频前一致（审计要求的判据） ──────────

  /** 生产同构的逐拍驱动结果。 */
  private class CadenceRun(
    val actionAtMs: Long,
    val action: WatchdogV2.TickAction,
    val delaysMs: List<Long>,
    val units: List<Int>,
  )

  /**
   * 与 EngineService.watchdogTick 同构：每拍按 nextTickDelayMs 取间隔、按 tickUnits 折算
   * 标准拍、再把 units 交给 planTick 记账。
   */
  private fun driveFailingState(
    state: WatchdogV2.ProbeState,
    startState: WatchdogV2.ProbeState,
    maxTicks: Int = 40,
  ): CadenceRun {
    var now = 0L
    var lastTickAt = 0L
    var tickDelay = WatchdogV2.nextTickDelayMs(startState)
    val delays = ArrayList<Long>()
    val units = ArrayList<Int>()
    repeat(maxTicks) {
      now += tickDelay
      delays += tickDelay
      val u = WatchdogV2.tickUnits(now - lastTickAt)
      units += u
      lastTickAt = now
      val plan = WatchdogV2.planTick(
        state = state,
        now = now,
        nextRestartAllowedAt = 0L,
        engineReady = true,
        engineProcessAlive = false,
        bootAgeMs = 999_999L,
        restartDeadConfirmations = 2,
        feedProbe = {},
        consumeMarkers = {},
        refreshWake = {},
        undoReady = { false },
        units = u,
      )
      if (plan.action == WatchdogV2.TickAction.RESTART) return CadenceRun(now, plan.action, delays, units)
      tickDelay = WatchdogV2.nextTickDelayMs(state)
    }
    return CadenceRun(-1L, WatchdogV2.TickAction.HOLD, delays, units)
  }

  @Test
  fun 健康态降频后半死阶梯仍在三十秒量级触发重启() {
    // 反证：若把 5 秒拍直接换成「固定 20 秒」而不折算，这条会变成 120 秒（6 拍 × 20 秒）。
    val run = driveFailingState(WatchdogV2.ProbeState.DEGRADED_HTTP, WatchdogV2.ProbeState.HEALTHY)
    assertEquals("阶梯必须仍然触发重启", WatchdogV2.TickAction.RESTART, run.action)
    assertTrue(
      "降频后进入 DEGRADED_HTTP 到重启仍须在 30 秒量级（实测 " + run.actionAtMs + "ms），不得变成 120 秒",
      run.actionAtMs in 25_000L..35_000L,
    )
    assertEquals(
      "阶梯总时长必须与降频前的 6 个标准拍 = 30 秒一致",
      WatchdogV2.DEGRADED_RESTART_AFTER_MS,
      run.actionAtMs,
    )
  }

  @Test
  fun 纯健康态下每拍按二十秒走() {
    var now = 0L
    var lastTickAt = 0L
    val units = ArrayList<Int>()
    repeat(5) {
      now += WatchdogV2.nextTickDelayMs(WatchdogV2.ProbeState.HEALTHY)
      units += WatchdogV2.tickUnits(now - lastTickAt)
      lastTickAt = now
    }
    assertEquals("健康态每拍折算成 4 个标准拍", listOf(4, 4, 4, 4, 4), units)
    assertEquals("5 拍共 100 秒", 100_000L, now)
  }

  @Test
  fun 死引擎恢复仍按五秒拍_不被降频拖慢() {
    val run = driveFailingState(WatchdogV2.ProbeState.DEAD, WatchdogV2.ProbeState.DEAD)
    // DEAD + restartDeadConfirmations = 2：第 2 拍即 RESTART（既有语义，本用例只锁节奏）。
    assertEquals("死亡观察窗走完必须恢复", WatchdogV2.TickAction.RESTART, run.action)
    assertTrue("死亡恢复不得被降频拖成 3 倍时长（实测 " + run.actionAtMs + "ms）", run.actionAtMs <= 15_000L)
  }

  @Test
  fun 慢宽限与熔断的时间口径不变() {
    assertEquals(18, WatchdogV2.DEGRADED_SLOW_GRACE_TICKS)
    assertEquals("慢宽限时间口径 = 90 秒", 90_000L, WatchdogV2.DEGRADED_SLOW_GRACE_AFTER_MS)
    assertEquals("熔断时间口径 = 60 秒", 60_000L, WatchdogV2.CIRCUIT_OPEN_AFTER_MS)
    assertEquals("阶梯时间口径 = 30 秒", 30_000L, WatchdogV2.DEGRADED_RESTART_AFTER_MS)
    // 5 秒拍下逐拍累积到 18 个标准拍，正好 90 秒。
    var now = 0L
    var count = 0
    while (count < WatchdogV2.DEGRADED_SLOW_GRACE_TICKS) {
      now += WatchdogV2.nextTickDelayMs(WatchdogV2.ProbeState.DEGRADED_HTTP)
      count += WatchdogV2.tickUnits(WatchdogV2.ACTIVE_TICK_MS)
    }
    assertEquals("18 个标准拍 = 90 秒", WatchdogV2.DEGRADED_SLOW_GRACE_AFTER_MS, now)
  }

  // ── 源码契约：调度真的按状态自适应，不是固定节奏 ────────────────

  private fun source(name: String): String {
    val f = listOf(
      File("src/main/java/com/dsharnessmobile/shell/" + name),
      File("app/src/main/java/com/dsharnessmobile/shell/" + name),
    ).firstOrNull { it.isFile }
      ?: throw AssertionError("找不到 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  @Test
  fun 服务必须按状态重排而不是固定五秒() {
    val code = codeOnly(source("EngineService.kt"))
    assertFalse(
      "不得再用固定 5 秒的 scheduleWithFixedDelay（降频与恢复都无从谈起）",
      code.contains("scheduleWithFixedDelay"),
    )
    assertTrue("必须存在逐拍重排", code.contains("private fun scheduleWatchdogTick("))
    assertTrue("第一拍必须按健康节奏挂上", code.contains("scheduleWatchdogTick(epoch, exec, WatchdogV2.HEALTHY_TICK_MS)"))
    assertTrue("每拍末尾必须按 nextDelayMs 重排", code.contains("scheduleWatchdogTick(epoch, exec, nextDelayMs)"))
    assertTrue("下一拍间隔必须由状态决定", code.contains("WatchdogV2.nextTickDelayMs("))
    assertTrue("标准拍折算必须进每拍", code.contains("val units = WatchdogV2.tickUnits(tickMs)"))
    assertTrue("标准拍必须传给 planTick", code.contains("units = units,"))
    val tick = code.substringAfter("private fun watchdogTick(").substringBefore("private fun buildNotification(")
    assertTrue("异常拍必须回到 5 秒节奏", tick.contains("nextDelayMs = WatchdogV2.ACTIVE_TICK_MS"))
    assertTrue("冷启动窗口判据必须存在（booting）", tick.contains("isBootingWindow()"))
  }

  // ── issue #1354：修复态分支不得把 tick 链断死 ──────────────────────────

  @Test
  fun 修复态分支必须把下一拍挂回去() {
    val code = codeOnly(source("EngineService.kt"))
    val tick = code.substringAfter("private fun watchdogTick(").substringBefore("private fun buildNotification(")
    // 边界用**分支自己的收尾花括号**，不用注释行：codeOnly 已把注释整行删掉，
    // 拿注释当分隔符会 substringBefore 不到（Kotlin 回落成整段），断言就退化成整条 tick 上找。
    val repair = tick
      .substringAfter("if (RepairState.required(this)")
      .substringBefore("\n      }")
    assertTrue("修复态分支必须存在", repair.isNotEmpty())
    assertTrue("修复态保持非健康节奏（5 秒）复看", repair.contains("nextDelayMs = WatchdogV2.ACTIVE_TICK_MS"))
    // 判据落在「重排的位置」上：scheduleWatchdogTick 全仓只有首拍与尾部两个调用点，
    // 只要重排留在 try 之后，修复态那句 return 就会跳过它，链子永久断死。
    assertTrue("重排必须在 finally 里（任何早退都要挂回下一拍）", tick.contains("} finally {"))
    assertTrue(
      "finally 里必须按 nextDelayMs 重排",
      tick.substringAfter("} finally {").contains("scheduleWatchdogTick(epoch, exec, nextDelayMs)"),
    )
  }

  @Test
  fun 阶梯阈值必须同时给出时间口径() {
    val code = codeOnly(source("WatchdogV2.kt"))
    assertTrue("标准拍常量必须存在", code.contains("const val STANDARD_TICK_MS = 5_000L"))
    assertTrue("阶梯时间口径必须存在", code.contains("const val DEGRADED_RESTART_AFTER_MS"))
    assertTrue("慢宽限时间口径必须存在", code.contains("const val DEGRADED_SLOW_GRACE_AFTER_MS"))
    assertTrue(
      "阶梯常量必须由标准拍推导（不是第二个魔数）",
      code.contains("DEGRADED_RESTART_CONFIRMATIONS.toLong() * STANDARD_TICK_MS"),
    )
    assertTrue("计数必须按标准拍加权", code.contains("fun nextDegradedCount(state: ProbeState, count: Int, units: Int = 1)"))
    assertTrue("探活记账必须按标准拍加权", code.contains("fun recordProbe(state: ProbeState, signature: String? = lastLogSignature, units: Int = 1)"))
  }
}
