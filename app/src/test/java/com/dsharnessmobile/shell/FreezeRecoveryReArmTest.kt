package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1355 回归：冻结自愈必须能「重新武装」；#1513：判据必须落在**状态机**上。
 *
 * 缺陷形态（#1355）：freezeReloaded 置位后没有任何复位点——同一进程内第二次渲染进程冻结只落一行
 * 日志、不 reload，界面永久停在 Loading，除杀进程没有出口。
 *
 * 复位点必须长在「页面应答」上：startFreezeWatchdog 由 onPageFinished 调用，文档加载完就触发，
 * 此时 JS 可能仍然死着——在那里复位会变成 reload -> onPageFinished -> 复位 -> 再判冻结 -> 再 reload
 * 的循环。
 *
 * #1513 修正的是**判据本身**：旧用例切片取的是 startFreezeWatchdog 到 startUpdateCheck 那 16 行
 * （只含 post 语句），而置位点与复位点都在 freezeRunnable 里，于是「把 freezeReloaded=false 挪进
 * 冻结分支」这种每 10 秒 reload 的错误实现也判绿。现在改为用可注入时钟直接跑
 * [FreezeRecoveryGate] 的状态转换——行为错就红，与源码文本怎么写无关。
 */
class FreezeRecoveryReArmTest {

  // 冻结判定：页面已加载 > 45s 且最近一次应答 > 20s（与生产同值，见 companion）。

  @Test
  fun 同一轮冻结只reload一次_不得每拍都reload() {
    val gate = FreezeRecoveryGate()
    gate.onPageLoaded(0L)
    assertEquals("45s 页面窗 + 20s 应答窗都过了：判定冻结并 reload", FreezeRecoveryGate.Action.RELOAD, gate.tick(46_000L))
    assertTrue("reload 后必须置位", gate.freezeReloaded)
    assertEquals(
      "同一轮冻结里后续每拍都不得再 reload（错误实现会每 10 秒一次）",
      FreezeRecoveryGate.Action.NONE,
      gate.tick(100_000L),
    )
    assertEquals(FreezeRecoveryGate.Action.NONE, gate.tick(200_000L))
  }

  @Test
  fun 页面加载事件不得复位冻结闸门() {
    val gate = FreezeRecoveryGate()
    gate.onPageLoaded(0L)
    assertEquals(FreezeRecoveryGate.Action.RELOAD, gate.tick(46_000L))
    // onPageFinished：文档加载完，但 JS 可能仍然死着（正是 #1355 的坑）。
    gate.onPageLoaded(47_000L)
    assertTrue("页面加载事件不得复位 freezeReloaded", gate.freezeReloaded)
    assertEquals(
      "否则会 reload -> onPageFinished -> 复位 -> 再 reload 的循环",
      FreezeRecoveryGate.Action.NONE,
      gate.tick(200_000L),
    )
  }

  @Test
  fun 应答回调必须重新武装冻结自愈() {
    val gate = FreezeRecoveryGate()
    gate.onPageLoaded(0L)
    assertEquals(FreezeRecoveryGate.Action.RELOAD, gate.tick(46_000L))
    gate.onAck(50_000L)
    assertFalse("应答=页面真活，必须重开自愈预算", gate.freezeReloaded)
    assertEquals("活着的页面照常发心跳", FreezeRecoveryGate.Action.PING, gate.tick(60_000L))
    gate.onPingFailed()
    assertEquals(
      "同一次会话里的第二轮冻结必须还能 reload（#1355 的缺陷本体）",
      FreezeRecoveryGate.Action.RELOAD,
      gate.tick(200_000L),
    )
  }

  @Test
  fun 心跳在飞时不得重复发() {
    val gate = FreezeRecoveryGate()
    gate.onPageLoaded(0L)
    assertEquals(FreezeRecoveryGate.Action.PING, gate.tick(10_000L))
    assertEquals("回执没回来之前不得重发心跳", FreezeRecoveryGate.Action.NONE, gate.tick(20_000L))
    gate.onAck(21_000L)
    assertEquals(FreezeRecoveryGate.Action.PING, gate.tick(30_000L))
  }

  @Test
  fun 页面观察窗内不得判冻结() {
    val gate = FreezeRecoveryGate()
    gate.onPageLoaded(0L)
    // 刚加载 45 秒内即使还没有应答也只是发心跳：冷启动本来就慢，判冻结会变成 reload 环。
    assertEquals(FreezeRecoveryGate.Action.PING, gate.tick(20_000L))
    assertEquals(FreezeRecoveryGate.Action.NONE, gate.tick(40_000L))
    assertFalse(gate.freezeReloaded)
  }

  @Test
  fun 停止监控只清在飞标记_保留闸门() {
    val gate = FreezeRecoveryGate()
    gate.onPageLoaded(0L)
    assertEquals(FreezeRecoveryGate.Action.PING, gate.tick(10_000L))
    gate.onStopped()
    assertFalse("停止监控必须解除在飞标记（否则回来后永不发心跳）", gate.pingOutstanding)
    assertEquals(FreezeRecoveryGate.Action.RELOAD, gate.tick(46_000L))
    gate.onStopped()
    assertTrue("停止监控不得复位闸门", gate.freezeReloaded)
  }

  @Test
  fun 冻结判定窗口与旧实现同值() {
    assertEquals("页面观察窗", 45_000L, FreezeRecoveryGate.PAGE_GRACE_MS)
    assertEquals("应答宽限", 20_000L, FreezeRecoveryGate.ACK_GRACE_MS)
    val gate = FreezeRecoveryGate()
    gate.onPageLoaded(0L)
    assertEquals("44.9 秒不算冻结（边界）", FreezeRecoveryGate.Action.PING, gate.tick(44_900L))
    assertEquals("46 秒即冻结（边界）", FreezeRecoveryGate.Action.RELOAD, gate.tick(46_000L))
  }
}
