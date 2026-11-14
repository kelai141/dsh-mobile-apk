package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1577：WebView 冻结自愈的三个取时点必须走**单调时钟**。
 *
 * 缺陷形态：`freezeGate.tick(now)` / `onAck(now)` / `onPageLoaded(now)` 的 `now` 都取
 * [System.currentTimeMillis]，而 [FreezeRecoveryGate.isFrozen] 是纯区间比较
 * （`now - pageLoadedAt > 45s && now - jsAckAt > 20s`）。墙钟被校时后**两个方向都真实**：
 *
 *  ① 向前拨几百秒 ⇒ 健康页面立刻被判冻结 ⇒ reloadEnginePage() 把好页面刷掉（表单/滚动丢失）；
 *  ② 向后拨 ⇒ `now - jsAckAt` 恒负 ⇒ isFrozen 永假 ⇒ 渲染进程真冻结时自愈**整段失效**。
 *
 * 同一个文件早已为 boot-stall 的**同一缺陷**整段换成 [bootStallNow]（见其选型注释）。
 *
 * 判据分两层：
 *  - 行为层：把「墙钟前跳 / 后拨」的读数喂给状态机，证明混用基准会误判、同基准不会；
 *  - 接线层：三个取时点都必须是 bootStallNow，且不得再用 currentTimeMillis（否则重犯）。
 */
class FreezeGateClockTest {

  /**
   * 方向①：页面已经加载 60 秒、应答也一直在，此时墙钟被向前拨 300 秒。
   *
   * 若 tick 的 now 取墙钟而 pageLoadedAt 取单调（或反之），差值多出 300 秒 ⇒ 误判冻结。
   * 这里用「混用两个基准」直接演示误判：行为本身由 [FreezeRecoveryGate] 的区间比较决定，
   * 所以断言的就是「跨基准读数 ⇒ RELOAD，同基准读数 ⇒ PING」。
   */
  @Test
  fun mixingWallClockAndMonotonicReadingsWouldFalselyReloadAHealthyPage() {
    val monoPageLoaded = 10_000L          // onPageLoaded 的单调读数
    val monoNow = monoPageLoaded + 60_000L // 真实只过了 60 秒，且有应答
    val gate = FreezeRecoveryGate()
    gate.onPageLoaded(monoPageLoaded)
    gate.onAck(monoPageLoaded + 55_000L)
    assertEquals("同基准：页面刚应答过，只该发心跳", FreezeRecoveryGate.Action.PING, gate.tick(monoNow))

    // 第二轮：把 tick 的读数换成被向前拨 300 秒的墙钟（缺陷形态）——同一拍立刻变 RELOAD。
    val wallNow = System.currentTimeMillis() + 300_000L
    val flawed = FreezeRecoveryGate()
    flawed.onPageLoaded(monoPageLoaded)
    flawed.onAck(monoPageLoaded + 55_000L)
    assertEquals(
      "跨基准的读数会让一个刚应答过的健康页面被判冻结（正是 #1577 方向①）",
      FreezeRecoveryGate.Action.RELOAD,
      flawed.tick(wallNow),
    )
  }

  /** 方向②：墙钟被**向后**拨（now 早于 jsAckAt）⇒ 差值恒负 ⇒ 真冻结也永不 reload。 */
  @Test
  fun aBackwardWallClockShiftWouldDisableFreezeRecoveryEntirely() {
    val ackAt = 1_700_000_000_000L        // 墙钟读数
    val tickAfterBackwardShift = ackAt - 300_000L // 校时把钟拨回 300 秒前
    val gate = FreezeRecoveryGate()
    gate.onPageLoaded(ackAt - 1_000_000L)
    gate.onAck(ackAt)
    // 向后拨之后连发多拍：每拍都只发/等心跳，REL OAD 一次都不会出现。
    repeat(8) {
      assertFalse(
        "now 早于 jsAckAt 时 isFrozen 恒假 ⇒ 真冻结也永不自愈（#1577 方向②）",
        gate.tick(tickAfterBackwardShift) == FreezeRecoveryGate.Action.RELOAD,
      )
    }
    assertFalse("闸门始终没有被置位（自愈整段失效）", gate.freezeReloaded)
  }

  /** 同基准（单调）下，同一组「真实经过时间」得到正确结论——证明换基准本身不改变判据语义。 */
  @Test
  fun aMonotonicBaselineKeepsTheJudgementIntact() {
    val start = 5_000L
    val gate = FreezeRecoveryGate()
    gate.onPageLoaded(start)
    val now = start + 46_000L
    // frozenMs 是诊断日志的读数，必须**在 tick 之前**取：tick 判冻结时会把 jsAckAt 置成 now
    //（同一轮冻结里不再重复 reload 的记账），之后 frozenMs 自然是 0。
    assertEquals(
      "frozenMs 也是同基准做差（诊断日志用的读数不得变成负数或几百秒）",
      46_000L,
      gate.frozenMs(now),
    )
    // 真实过了 46 秒且一直没应答：两个窗口都过 ⇒ 冻结。
    assertEquals(FreezeRecoveryGate.Action.RELOAD, gate.tick(now))
  }

  // ── 接线层：撤掉修复即红 ────────────────────────────────────────────────

  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).firstOrNull { it.isFile }
    ?.readText()
    ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /**
   * 三个取时点（tick / onAck / onPageLoaded）都必须取 [bootStallNow]。
   *
   * 为什么不写「全文不得出现 currentTimeMillis」：该文件里还有合法的墙上时钟用途
   * （事务 journal 的跨进程账龄、页面重载间隔预算等），过宽断言会把它们一起打死，
   * 而真正要守的是这**三个**读数同源。
   */
  @Test
  fun everyFreezeGateClockReadComesFromTheMonotonicSource() {
    val flow = codeOnly(source("EngineStartFlow.kt"))
    val tickBody = flow.substringAfter("private val freezeRunnable = object : Runnable {")
      .substringBefore("fun startMonitor()")
    assertTrue(
      "tick 的 now 必须取 bootStallNow（墙钟会被校时拨动）",
      tickBody.contains("val now = bootStallNow()"),
    )
    assertTrue(
      "应答回调的 onAck 必须取同一个单调基准",
      tickBody.contains("freezeGate.onAck(bootStallNow())"),
    )
    assertFalse(
      "冻结闸门这一路不得再有墙钟取时（tick / onAck 都在 freezeRunnable 里）",
      tickBody.contains("freezeGate.onAck(System.currentTimeMillis())") ||
        tickBody.contains("val now = System.currentTimeMillis()"),
    )
    val loadedBody = flow.substringAfter("fun startFreezeWatchdog()")
      .substringBefore("fun startUpdateCheck()")
    assertTrue(
      "onPageLoaded 的 now 必须与 tick / onAck 同源（跨基准会让区间比较失效）",
      loadedBody.contains("val now = bootStallNow()") &&
        loadedBody.contains("freezeGate.onPageLoaded(now)"),
    )
    assertTrue(
      "单调基准的定义必须仍在（elapsedRealtime，不是 uptimeMillis / currentTimeMillis）",
      flow.contains("internal fun bootStallNow(): Long = android.os.SystemClock.elapsedRealtime()"),
    )
  }
}
