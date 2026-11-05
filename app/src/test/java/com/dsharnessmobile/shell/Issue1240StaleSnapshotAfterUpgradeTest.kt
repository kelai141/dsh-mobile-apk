package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1240：**覆盖安装后引擎仍在跑 ⇒ 快照刷新被静默跳过**的判据与接线回归测试（JVM，无需设备）。
 *
 * ## 缺陷形态
 * 设备上已装过本 App 且引擎在跑，覆盖安装一个内嵌快照不同的 APK，安装完成后系统拉起应用：
 * 探活命中 OUR_PROCESS / OUR_HTTP ⇒ 旧实现直接早退 ⇒ 后面那段
 * 刷新分支（`if (!snapshotFresh())` → `refreshSnapshot(...)`）永远不执行。
 * 不报错、不提示、不降级，只是继续跑上一版 runtime（指纹不翻转、事务文件从不出现）。
 * 快照新鲜度判据本身是对的，缺陷是它**轮不到被执行**。
 *
 * ## 本类钉住什么
 * 本 issue 的修法有两个**方向相反**的必须同时成立，且各自都能单独变红，缺一条都不是修好了：
 *   - 正控 A（陈旧 ⇒ 必须刷新）：引擎在跑 + 快照陈旧时**不得早退**，必须先停旧引擎再走刷新链；
 *   - 负控 B（新鲜 ⇒ 必须早退）：引擎在跑 + 快照新鲜时**必须早退**，不得为「保险」无故杀掉
 *     一个正在服务的引擎（一次多余的重抽取 = 8-12 分钟前台中断 + 用户会话被打断）。
 * 只做 A 不做 B 的「修法」等于把每次启动都变成一次无谓刷新，比不修更坏。
 *
 * 判据半靠纯函数传参（`alreadyRunningSnapshotDecision`），接线半靠源码级断言
 * （与 `Issue309StartRecoveryTest` / `ForegroundPageRecoveryWiringTest` 同族）——
 * 因为本缺陷正藏在「调用点在不在、顺序对不对」这类纯逻辑看不见的地方。
 */
class Issue1240StaleSnapshotAfterUpgradeTest {

  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).firstOrNull { it.isFile }
    ?.readText()
    ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")

  /** 去掉整行注释：注释里出现的标识符不得让顺序/存在性断言假绿。 */
  private fun code(name: String): String = source(name).lineSequence().filterNot {
    val line = it.trimStart()
    line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")
  }.joinToString("\n")

  /** 注释放行后仍保留行号无关的切片能力：只按字面锚点切。 */
  private fun between(text: String, start: String, end: String): String {
    require(text.contains(start)) { "missing start: " + start }
    val remaining = text.substringAfter(start)
    require(remaining.contains(end)) { "missing end: " + end }
    return remaining.substringBefore(end)
  }

  // ── 正控 A：引擎在跑 + 快照陈旧 ⇒ 必须走刷新，不得早退 ────────────────────────

  /**
   * 核心正控（本 issue 的缺陷本身）：快照陈旧时，探活分支**不得**给出「早退」结论。
   *
   * 反证形态：把 `alreadyRunningSnapshotDecision` 改成无条件返回 EARLY_EXIT_FRESH
   * （即恢复旧行为），本用例立即变红。
   */
  @Test
  fun staleSnapshotWithARunningEngineMustNotEarlyExit() {
    assertEquals(
      "引擎在跑但快照陈旧（覆盖安装后跑的是上一版 runtime）时，必须转去刷新而不是早退",
      AlreadyRunningSnapshotDecision.STOP_THEN_REFRESH,
      alreadyRunningSnapshotDecision(snapshotFresh = false),
    )
    assertFalse(
      "陈旧时不得早退——早退正是本 issue 的根因",
      alreadyRunningSnapshotDecision(snapshotFresh = false) ==
        AlreadyRunningSnapshotDecision.EARLY_EXIT_FRESH,
    )
  }

  /**
   * 接线正控 A：探活分支里必须先判新鲜度、陈旧时**先停本壳托管的引擎**、再落到刷新。
   *
   * 三件事缺一不可：
   *   ① 早退已被 `when` 分流（不能残留无条件 `return@Thread`）；
   *   ② 停止走既有的 `stopOwnedEngine()`（只停本壳持有句柄的子进程，绝不按名字杀未归属监听器）；
   *   ③ 停失败时如实停在可读错误页并落盘，**不得**带着活动引擎进 refreshSnapshot
   *      （刷新要 swap usr/ 树，带活动引擎解压会写坏正在使用的路径）。
   */
  @Test
  fun theRunningEngineBranchDecidesBeforeReturningAndStopsTheOwnedEngine() {
    val flow = code("EngineStartFlow.kt")
    val branch = between(flow, "if (engineAlreadyRunning) {", "if (!isCurrentEngineFlow(generation)) return@Thread")
    // ① 判据真在分支里，且接的是既有的 snapshotFresh() 口径（不新造判法）。
    assertTrue(
      "探活分支必须以 snapshotFresh() 为依据分流",
      branch.contains("when (alreadyRunningSnapshotDecision(activity.engineManager.snapshotFresh()))"),
    )
    assertTrue("新鲜方向必须保留早退", branch.contains("AlreadyRunningSnapshotDecision.EARLY_EXIT_FRESH ->"))
    // ② 陈旧方向必须真去停旧引擎，而不是只打日志/只加提示。
    assertTrue("陈旧方向必须调用 stopOwnedEngine()", branch.contains("activity.engineManager.stopOwnedEngine()"))
    val stopAt = branch.indexOf("activity.engineManager.stopOwnedEngine()")
    val logAt = branch.indexOf("runtime snapshot is stale")
    assertTrue(
      "必须先有「快照陈旧」这条事实记录，再有停止动作（否则日志无法归因到本路径）",
      logAt >= 0 && logAt < stopAt,
    )
    // ③ 停失败必须如实收口：写 boot-fail + 错误页，且**不得**继续往下走刷新。
    val refused = branch.substring(stopAt)
    assertTrue(
      "停失败必须落一条独立的 boot-fail stage（不得复用 deferred-no-transaction 的文案）",
      refused.contains("\"snapshot-refresh-blocked-engine-running\""),
    )
    assertTrue("停失败必须停在可读错误页", refused.contains("GuidePhase.Error"))
    assertTrue(
      "停失败必须在写盘与报错之后 return（不得落进 refreshSnapshot）",
      refused.indexOf("\"snapshot-refresh-blocked-engine-running\"") < refused.indexOf("return@Thread"),
    )
  }

  /**
   * 顺序正控：新鲜度判定必须**先于**早退，而不是早退之后。
   *
   * 这是本 issue 的唯一语义改动，也是最容易被写回旧形态的地方（把 when 挪回 return 之后仍然
   * 「看起来加了判据」）。用分支体内的相对位置钉住。
   */
  @Test
  fun theFreshnessDecisionPrecedesTheEarlyReturn() {
    val flow = code("EngineStartFlow.kt")
    val branch = between(flow, "if (engineAlreadyRunning) {", "if (!isCurrentEngineFlow(generation)) return@Thread")
    val freshAt = branch.indexOf("snapshotFresh()")
    val earlyExitAt = branch.indexOf("AlreadyRunningSnapshotDecision.EARLY_EXIT_FRESH ->")
    val showWebAt = branch.indexOf("activity.showWeb()")
    assertTrue("分支里必须出现新鲜度判定", freshAt >= 0)
    assertTrue("新鲜度判定必须先于早退结论", freshAt < earlyExitAt)
    assertTrue("showWeb() 只能出现在「新鲜」这一条早退分支里", showWebAt > earlyExitAt)
    // 反证「只是把判定写在 return 之后」：陈旧方向之后不得还有 showWeb。
    val staleAt = branch.indexOf("AlreadyRunningSnapshotDecision.STOP_THEN_REFRESH")
    assertTrue("陈旧方向必须在 when 里显式列出", staleAt > earlyExitAt)
    assertFalse(
      "陈旧方向之后不得再无条件 showWeb（那等于把陈旧当就绪）",
      branch.substring(staleAt).contains("activity.showWeb()"),
    )
  }

  // ── 负控 B（反方向）：引擎在跑 + 快照新鲜 ⇒ 必须保持早退，不得无故杀引擎 ──────────

  /**
   * 核心负控：快照新鲜时**必须**早退。
   *
   * 反证形态：把 `alreadyRunningSnapshotDecision` 改成无条件返回 STOP_THEN_REFRESH
   * （即「保险起见每次都刷」），本用例立即变红。
   */
  @Test
  fun freshSnapshotWithARunningEngineMustStillEarlyExit() {
    assertEquals(
      "快照新鲜时在跑的就是这一版的运行时：必须保持早退，不得无故杀引擎重抽",
      AlreadyRunningSnapshotDecision.EARLY_EXIT_FRESH,
      alreadyRunningSnapshotDecision(snapshotFresh = true),
    )
    assertFalse(
      "新鲜时不得转去刷新（一次无谓的重抽取 = 8-12 分钟前台中断）",
      alreadyRunningSnapshotDecision(snapshotFresh = true) ==
        AlreadyRunningSnapshotDecision.STOP_THEN_REFRESH,
    )
  }

  /**
   * 接线负控 B：新鲜方向的早退必须是**干净**的——照旧只补 listen/C1 标记然后 showWeb()，
   * 不得在此之前出现任何停止/刷新动作。
   *
   * 这条防的是「为了修 #1240 顺手把停止动作提到分流之前」：那样新鲜时也会杀引擎，
   * 本 issue 的修复就变成一个新的回归。
   */
  @Test
  fun theFreshDirectionKeepsTheOriginalEarlyExitClean() {
    val flow = code("EngineStartFlow.kt")
    val branch = between(flow, "if (engineAlreadyRunning) {", "if (!isCurrentEngineFlow(generation)) return@Thread")
    val freshAt = branch.indexOf("AlreadyRunningSnapshotDecision.EARLY_EXIT_FRESH ->")
    val beforeFresh = branch.substring(0, freshAt)
    assertFalse("新鲜方向之前不得有任何停止动作", beforeFresh.contains("stopOwnedEngine()"))
    assertFalse("新鲜方向之前不得进入刷新", beforeFresh.contains("refreshSnapshot("))
    // 早退分支体内只做两件事：标记 + showWeb + return。
    val freshBlock = branch.substring(freshAt, branch.indexOf("AlreadyRunningSnapshotDecision.STOP_THEN_REFRESH"))
    assertTrue("新鲜方向必须 showWeb()", freshBlock.contains("activity.showWeb()"))
    assertTrue("新鲜方向必须 return@Thread（保持早退）", freshBlock.contains("return@Thread"))
    assertFalse("新鲜方向不得停止引擎", freshBlock.contains("stopOwnedEngine()"))
    assertFalse("新鲜方向不得刷新快照", freshBlock.contains("refreshSnapshot("))
    assertFalse("新鲜方向不得写失败记录（它就是正常路径）", freshBlock.contains("writeBootFail("))
  }

  /**
   * 负控 B 的落盘面：新鲜路径**不得**往 boot-fail.log 写任何东西。
   *
   * 理由：boot-fail.log 的判据是「文件非空 = 出过故障」。每次正常启动都写一条「引擎在跑且快照
   * 新鲜」，会让这条最简单的现场判据失效——而定式缺陷正是靠它被读出来的。
   */
  @Test
  fun theFreshPathWritesNothingToTheBootFailLedger() {
    val flow = code("EngineStartFlow.kt")
    val branch = between(flow, "if (engineAlreadyRunning) {", "if (!isCurrentEngineFlow(generation)) return@Thread")
    val freshBlock = branch.substring(
      branch.indexOf("AlreadyRunningSnapshotDecision.EARLY_EXIT_FRESH ->"),
      branch.indexOf("AlreadyRunningSnapshotDecision.STOP_THEN_REFRESH"),
    )
    assertFalse(
      "新鲜路径不得写 boot-fail（文件非空 = 出过故障，是现场唯一判据）",
      freshBlock.contains("writeBootFail"),
    )
  }

  // ── 判据本身没有被改坏：仍然以 snapshotFresh() 为唯一口径 ────────────────────

  /**
   * 判据反向约束：本修复**不得**顺手改写 snapshotFresh 的语义（AGENTS.md 高频雷点 2 的口径：
   * 指纹翻转 + 事务文件消失）。这里只断言它仍是刷新判据，避免「为了修早退而放宽新鲜度」。
   */
  @Test
  fun theRefreshGateIsStillTheExistingSnapshotFreshCriterion() {
    val flow = code("EngineStartFlow.kt")
    assertTrue(
      "刷新判据必须仍是 if (!snapshotFresh())（#309 的删指纹恢复路径依赖它）",
      flow.contains("if (!activity.engineManager.snapshotFresh()) {"),
    )
    val manager = source("EngineManager.kt")
    assertTrue("snapshotFresh 的口径未变", manager.contains("fun snapshotFresh(): Boolean {"))
    assertTrue(
      "快照新鲜度仍由 SnapshotFingerprintPolicy 回答（不得在本 issue 里换判据）",
      manager.contains("SnapshotFingerprintPolicy.fresh("),
    )
  }
}
