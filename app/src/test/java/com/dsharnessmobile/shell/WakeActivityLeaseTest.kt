package com.dsharnessmobile.shell

import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * §6.2 唤醒锁按活动持有（0.14.10 功耗面）的回归。
 *
 * 缺陷形态（审计 §6.2，功耗最大单项）：服务启动即 acquireWakeLock，此后每拍 refreshWake
 * **无条件** acquire（refreshWakeLock 原本就是 acquireWakeLock 的别名），于是「没有任何 turn
 * 在跑」与「正在跑 turn」在功耗面上完全一样——CPU 不允许深睡，实测连续持锁 7 分钟以上。
 *
 * 本用例集锁死的语义：
 *  ① 活动租约：turn 在跑 / 控制请求在途 / 启动或重启窗口 三类事件刷新，60 秒内续持、过期释放；
 *  ② 释放必须走**非终态**路径（EpochResourceOwner.drop），否则重取静默失效 = 锁永久没了；
 *  ③ 终态释放（onDestroy / retireEpoch）语义不变：close 后一律拒绝重新 install。
 *
 * 反证口径：把 refreshWakeLock 改回「acquireWakeLock 的别名」、或把空闲释放改成 close()，
 * 下面每条都会变红。
 */
class WakeActivityLeaseTest {

  @Before
  fun resetLease() {
    WatchdogV2.WakeActivityLease.reset()
  }

  @After
  fun clearLease() {
    WatchdogV2.WakeActivityLease.reset()
  }

  // ── ① 租约判据 ──────────────────────────────────────────────

  @Test
  fun 冷启动无活动时必须判为不该持锁() {
    // 修复前：refreshWake 无条件 acquire ⇒ 这一拍仍会续持。租约判据必须说 RELEASE。
    assertFalse("从未有过活动不得当新鲜", WatchdogV2.WakeActivityLease.holdable(0L))
    assertEquals(WatchdogV2.WakeTick.RELEASE, WatchdogV2.wakeTickDecision(0L))
    assertTrue("哨兵不得被当成时间戳", WatchdogV2.WakeActivityLease.lastActivityAt() < 0L)
  }

  @Test
  fun 活动后六十秒内续持_到期即释放() {
    val t0 = 1_000_000L
    WatchdogV2.WakeActivityLease.note(t0)
    assertEquals(WatchdogV2.WakeTick.HOLD, WatchdogV2.wakeTickDecision(t0))
    assertEquals("最后一刻仍新鲜", WatchdogV2.WakeTick.HOLD, WatchdogV2.wakeTickDecision(t0 + 59_999L))
    assertEquals(
      "满 60 秒必须放锁（用户口径：空闲 60 秒释放）",
      WatchdogV2.WakeTick.RELEASE,
      WatchdogV2.wakeTickDecision(t0 + WatchdogV2.WakeActivityLease.IDLE_RELEASE_MS),
    )
  }

  @Test
  fun 每次活动都重置空闲窗口() {
    var now = 5_000L
    WatchdogV2.WakeActivityLease.note(now)
    // 每 50 秒来一次活动：任何时刻都不该到期（旧实现这一点永远成立，新实现必须保住）。
    repeat(10) {
      now += 50_000L
      assertEquals("活动窗口内不得放锁", WatchdogV2.WakeTick.HOLD, WatchdogV2.wakeTickDecision(now))
      WatchdogV2.WakeActivityLease.note(now)
    }
  }

  @Test
  fun 空闲后一次活动立刻恢复持锁() {
    WatchdogV2.WakeActivityLease.note(0L)
    assertEquals(WatchdogV2.WakeTick.RELEASE, WatchdogV2.wakeTickDecision(120_000L))
    WatchdogV2.WakeActivityLease.note(120_000L)
    assertEquals("有事件立即重取（不等下一拍）", WatchdogV2.WakeTick.HOLD, WatchdogV2.wakeTickDecision(120_000L))
  }

  @Test
  fun 时钟域异常时宁可放锁也不锁死() {
    // last > now（测试注入/时钟域混用）：不能当成「刚活动过」，否则唤醒锁就是永久持有。
    WatchdogV2.WakeActivityLease.note(500_000L)
    assertEquals(WatchdogV2.WakeTick.RELEASE, WatchdogV2.wakeTickDecision(10_000L))
  }

  /** 生产节奏模拟：健康态 20 秒一拍、无任何活动 ⇒ 第一拍之后最多一拍内必须放锁。 */
  @Test
  fun 健康态降频后的空闲时序必须在一拍内放锁() {
    WatchdogV2.WakeActivityLease.note(0L)
    val decisions = ArrayList<Pair<Long, WatchdogV2.WakeTick>>()
    for (tick in 1..6) {
      val now = tick * 20_000L
      decisions += now to WatchdogV2.wakeTickDecision(now)
    }
    assertEquals(
      "0/20/40 秒续持，60 秒那一拍放锁：不得出现「一直续持」",
      listOf(WatchdogV2.WakeTick.HOLD, WatchdogV2.WakeTick.HOLD, WatchdogV2.WakeTick.RELEASE,
        WatchdogV2.WakeTick.RELEASE, WatchdogV2.WakeTick.RELEASE, WatchdogV2.WakeTick.RELEASE),
      decisions.map { it.second },
    )
  }

  // ── ② 非终态释放：drop() 与 close() 的差别 ───────────────────

  @Test
  fun 空闲释放后必须还能重新取到锁() {
    val released = mutableListOf<String>()
    val owner = EpochResourceOwner<String> { released += it }
    assertTrue(owner.install(acquire = { "held" }))
    assertEquals("held", owner.drop())
    assertEquals(listOf("held"), released)
    // 关键：drop 不是终态 —— 重取必须成功（旧写法用 close() 时这里恒 false，唤醒锁永久失效）。
    assertTrue("空闲放锁后必须能重取", owner.install(acquire = { "reacquired" }))
    assertEquals(listOf("held"), released)
    owner.close()
    assertEquals(listOf("held", "reacquired"), released)
  }

  @Test
  fun 终态关闭后不得再取锁且drop为空操作() {
    val released = mutableListOf<String>()
    val owner = EpochResourceOwner<String> { released += it }
    assertTrue(owner.install(acquire = { "held" }))
    owner.close()
    assertNull("close 之后 drop 不得再释放任何句柄", owner.drop())
    assertFalse("close 是终态：不得重新 install", owner.install(acquire = { "never" }))
    assertEquals(listOf("held"), released)
  }

  @Test
  fun 无句柄时drop不制造副作用() {
    val released = mutableListOf<String>()
    val owner = EpochResourceOwner<String> { released += it }
    assertNull(owner.drop())
    assertTrue(released.isEmpty())
  }

  // ── ③ 源码契约：接线在，且不是别名 ───────────────────────────

  private fun source(name: String): String {
    val f = listOf(
      File("src/main/java/com/dsharnessmobile/shell/$name"),
      File("app/src/main/java/com/dsharnessmobile/shell/$name"),
    ).firstOrNull { it.isFile }
      ?: throw AssertionError("找不到 $name（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  @Test
  fun 续期必须按租约判决而不是无条件acquire() {
    val code = codeOnly(source("WatchdogV2.kt"))
    val body = code.substringAfter("internal fun refreshWakeLock(").substringBefore("internal fun releaseWakeLockIdle(")
    assertTrue("续期必须读租约判决", body.contains("wakeTickDecision("))
    assertTrue("过期必须走非终态释放", body.contains("releaseWakeLockIdle(owner)"))
    assertTrue("新鲜时必须取锁", body.contains("acquireWakeLock(context, owner)"))
    assertFalse(
      "不得退回「refreshWake 就是 acquireWake 的别名」（审计 §6.2 的缺陷本体）",
      code.contains("internal fun refreshWakeLock(context: Context, owner: WakeLockOwner) = acquireWakeLock(context, owner)"),
    )
    assertTrue("非终态释放必须走 drop（close 是终态，会锁死在放锁态）", code.contains("owner.acquisition.drop()"))
  }

  /**
   * 活动来源必须接到同一个租约入口。
   *
   * 迁移说明：旧 ControlPoller 已随原生宿主退役，「控制请求在途」不再是独立来源——
   * 新链里只剩三类真实来源（启动窗口、重启窗口、每拍 live 流/启动冷却）。本用例改为
   * 钉住这三条接线，并守住「入口唯一」：任何模块不得绕开 [EngineService.noteWakeActivity]
   * 直接写 [WatchdogV2.WakeActivityLease]，否则租约就变成不可核对的隐式约定。
   */
  @Test
  fun 每类真实活动来源都必须接到同一个租约入口() {
    val service = codeOnly(source("EngineService.kt"))
    val watchdog = codeOnly(source("WatchdogV2.kt"))
    assertTrue("活动租约必须有唯一实现", watchdog.contains("internal object WakeActivityLease"))
    // 启动窗口：先记活动再取锁，否则租约为空时取到的锁下一拍就会被放掉。
    val ensure = service.substringAfter("private fun ensureEngine(epoch: ServiceEpoch)")
    assertTrue("启动窗口必须记活动，且先于取锁",
      ensure.indexOf("noteWakeActivity()") in 0 until ensure.indexOf("WatchdogV2.acquireWakeLock"))
    // 重启窗口：noteWakeActivity 必须先于 startEngine。
    val restartBranch = service.substringAfter("WatchdogV2.TickAction.RESTART -> {")
    assertTrue("重启窗口必须先记活动再拉起引擎",
      restartBranch.indexOf("noteWakeActivity()") in 0 until restartBranch.indexOf("startEngine(force = plan.force)"))
    // turn 在跑 / 启动冷却：每拍观测。
    assertTrue("每拍必须观测 live 流与启动冷却窗", service.contains("noteWakeActivityForTick(epoch)"))
    assertTrue("live 流观测只做一次 length", watchdog.contains("internal fun liveFeedLength(context: Context)"))
    val tick = service.substringAfter("private fun noteWakeActivityForTick(epoch: ServiceEpoch)")
      .substringBefore("private fun ")
    assertTrue("live 流变长才记活动（空转不得续持）", tick.contains("liveLength > previous"))
    assertTrue("启动冷却窗内记活动", tick.contains("START_COOLDOWN_MS"))
    // 入口唯一：只有 EngineService 的公开入口可以写租约。
    val shellDir = File("src/main/java/com/dsharnessmobile/shell")
    val directWriters = shellDir.walkTopDown().filter { it.isFile && it.extension == "kt" }
      .filter { it.name != "WatchdogV2.kt" && it.name != "EngineService.kt" }
      .filter { codeOnly(it.readText()).contains("WakeActivityLease.note(") }
      .map { it.name }.toList()
    assertTrue("租约写入必须集中在单一入口，实际另有：" + directWriters, directWriters.isEmpty())
  }

  @Test
  fun 终态释放路径保持不变() {
    val service = codeOnly(source("EngineService.kt"))
    val teardown = service.substringAfter("private fun retireEpoch(epoch: ServiceEpoch)").substringBefore("private fun ensureEngine(")
    assertTrue("onDestroy/retireEpoch 仍必须走终态释放", teardown.contains("WatchdogV2.releaseWakeLock(epoch.wakeOwner)"))
    assertFalse("retireEpoch 不得改用非终态释放（否则换代后旧 owner 仍可被重装）", teardown.contains("releaseWakeLockIdle"))
  }
}
