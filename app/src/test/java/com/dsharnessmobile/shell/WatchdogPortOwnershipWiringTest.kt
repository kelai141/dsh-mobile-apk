package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1576：看门狗的「端口被他人占用」否决必须在**生产接线上**真的能触发。
 *
 * 缺陷形态：`portOwnedByApp` 由 `engineManager.engineProcessAlive()` 提供，而该函数在**没有托管
 * 子进程句柄**时会退回 `portReachable(1000)`；这个否决只在 `DEGRADED_HTTP` 时求值，该状态按定义
 * **端口必然可连** ⇒ 恒返回 true ⇒ `portForeign` 恒假 ⇒「port belongs to another process」那行
 * 永不出现，只有「重启风暴」。
 *
 * 修法（本轮复核确认已接线）：`EngineManager.trackedChildAlive()` 只看托管句柄，`EngineService`
 * 的 `portOwnedByApp` 传它；同一处 planTick 的 `engineProcessAlive` 参数**保持原样**——
 * 两个参数问的是两个不同问题（「我们托管着活子进程吗」vs「探活还认为引擎活着吗」）。
 *
 * 判据是源码级 + 语义级两层：语义层锁「两个谓词对同一状态给出相反结论」，源码层锁生产接线选了哪一个。
 */
class WatchdogPortOwnershipWiringTest {

  private fun shellSource(name: String): String = listOf(
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
   * 语义层：`trackedChildAlive()` 的存在本身就是「不退回端口可达性」的那一半。
   *
   * 它必须是 `engineProcess?.isAlive == true`——不能写 `engineProcess?.isAlive ?: EngineProbe.portReachable(...)`，
   * 否则 #1576 原样回来。这里同时锁住 `engineProcessAlive()` 的兜底仍在（它服务的是冷启动超时口径，
   * 不是归属判据；把它的兜底删掉会误判启动中的引擎死亡）。
   */
  @Test
  fun theOwnershipPredicateNeverFallsBackToPortReachability() {
    val manager = codeOnly(shellSource("EngineManager.kt"))
    assertTrue(
      "必须有只看托管句柄的谓词（#1576 的修法本体）",
      manager.contains("internal fun trackedChildAlive(): Boolean = engineProcess?.isAlive == true"),
    )
    val trackedBody = manager.substringAfter("internal fun trackedChildAlive(")
      .substringBefore("\n\n")
    assertFalse(
      "归属谓词不得退回端口可达性（DEGRADED_HTTP 时端口必然可连 ⇒ 恒真 ⇒ 否决永不触发）",
      trackedBody.contains("portReachable"),
    )
    val aliveBody = manager.substringAfter("fun engineProcessAlive(): Boolean {")
      .substringBefore("internal fun trackedChildAlive(")
    assertTrue(
      "engineProcessAlive 的端口兜底必须保留（冷启动超时口径依赖它，见 #118）",
      aliveBody.contains("EngineProbe.portReachable(1000)"),
    )
  }

  /**
   * 接线层：`EngineService` 的 `portOwnedByApp` 必须传 `trackedChildAlive()`。
   *
   * 负控：把它改回 `engineProcessAlive()` ⇒ 本用例红（那正是 #1576 的缺陷形态）。
   */
  @Test
  fun theWatchdogPassesTheTrackedChildPredicateAsPortOwnership() {
    val service = codeOnly(shellSource("EngineService.kt"))
    val plan = service.substringAfter("val plan = WatchdogV2.planTick(")
      .substringBefore("feedProbe = ")
    assertTrue(
      "portOwnedByApp 必须取 trackedChildAlive()，实际片段：" + plan,
      plan.contains("portOwnedByApp = engineManager.trackedChildAlive()"),
    )
    assertFalse(
      "不得退回 engineProcessAlive()（无句柄时退回端口可达性 ⇒ 否决恒不触发）",
      plan.contains("portOwnedByApp = engineManager.engineProcessAlive()"),
    )
    assertTrue(
      "同一处 planTick 的 engineProcessAlive 参数保持原样（两个参数问的是两个不同问题）",
      plan.contains("engineProcessAlive = engineManager.engineProcessAlive()"),
    )
  }
}
