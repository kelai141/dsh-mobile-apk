package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 0.14.8 P1 回归（定位报告 §2.3/§2.5）：快照刷新窗口内的启动请求**不得被静默丢弃**，
 * 且「别人正在做」不得被记成「自己失败了」。
 *
 * 缺陷形态（已在 origin/main 核对）：
 *  - `EngineStartFlow.kt:700 val token = flowOwnership.begin() ?: return`：刷新期间
 *    `flowOwnership.running` 恒为 true（`finish(token)` 只在启动线程的 finally 里执行），
 *    于是任何再次进入的启动请求（含安全模式重启）不 spawn、不改相位、不落盘 —— 零痕迹；
 *  - `EngineManager.kt:207 lastRefreshFailureCode = "snapshot-transaction-in-flight"` 把
 *    「另一条事务在飞」记成自己的失败，而同一堵墙上的 startEngine(:1304-1307) 返回 true 让行、
 *    invalidateSnapshotFreshness(:443-446) 返回 false 让行 —— 口径不一致。
 *
 * 判据分三层，缺一层即未验收：
 *  ① **行为层**（真文件 + 注入时钟）：跨进程真源（事务 journal）在场即等待、缺席即立刻放行、
 *     预算用尽即收手、换代即收手；
 *  ② **文案层**（纯函数）：如实中间态，**不得**出现 D3 判据 C3 点名的就绪类词；
 *  ③ **接线层**（源码契约，与 CallSiteContractTest 同思路）：调用点不得回退成裸 `?: return`，
 *     且必须留痕 + 接上等待纯函数 —— 撤掉修复即红。
 *
 * 纯 JVM（无 Robolectric / 无 Mockito）：跨进程真源用真实 journal 文件（TemporaryFolder），
 * 与生产同一套 [SnapshotTransaction] 读写原语。
 */
class DeferredEngineStartTest {

  @get:Rule
  val tmp = TemporaryFolder()

  private val files: File get() = tmp.root

  /** 造一份正在进行中的事务 journal（与 EngineManager 写 journal 用的是同一原语）。 */
  private fun writeInFlightTransaction(startedAt: Long) {
    SnapshotTransaction.writeMarker(
      files,
      SnapshotTransaction.Marker(
        SnapshotTransaction.Phase.STAGED, "fp-under-test", startedAt, purpose = SnapshotTransaction.Purpose.FACTORY,
      ),
    )
  }

  // ── ① 行为层：跨进程真源（journal 文件）驱动的有界等待 ────────────────────────

  /**
   * 真源是**文件**而不是内存标记：journal 被清掉 = 刷新真的收口了，等待必须立刻返回 true。
   * 这条同时是「等待判据没写反」的反证（写反就变成「journal 在场才放行」）。
   */
  @Test
  fun transactionJournalOnDiskIsTheWaitCriterion() {
    writeInFlightTransaction(1_000L)
    assertTrue("前置：journal 必须在场", SnapshotTransaction.readMarker(files) != null)

    var clock = 0L
    var polls = 0
    val settled = awaitSnapshotTransactionSettled(
      budgetMs = 5_000L, pollStepMs = 1_000L,
      now = { clock }, sleep = { clock += it },
      transactionActive = {
        polls++
        // 第 3 拍时事务收口（清 journal）：等待必须立刻结束，不得走满预算。
        if (polls >= 3) SnapshotTransaction.clearMarker(files)
        SnapshotTransaction.readMarker(files) != null
      },
      current = { true },
    )
    assertTrue("事务收口必须返回 true", settled)
    assertEquals("收口即停（不得走满预算）", 3, polls)
    assertTrue("必须远早于预算（实测 clock=" + clock + "）", clock < 5_000L)
  }

  /** 有界性：事务**始终**在场 ⇒ 到预算即收手，返回 false（不是无限等）。 */
  @Test
  fun anEndlessTransactionIsBoundedByTheBudget() {
    var clock = 0L
    var polls = 0
    val settled = awaitSnapshotTransactionSettled(
      budgetMs = 5_000L, pollStepMs = 1_000L,
      now = { clock }, sleep = { clock += it },
      transactionActive = { polls++; true },
      current = { true },
    )
    assertFalse("超预算必须返回 false（有界，不得无限等）", settled)
    assertTrue("必须真的轮询过（不是一次都没试就放弃）", polls >= 5)
    assertTrue("不得超出预算（实测 clock=" + clock + "）", clock <= 6_000L)
  }

  /** 换代/销毁（current=false）：立刻收手，一拍都不轮询（不对废弃世代做动作）。 */
  @Test
  fun anObsoleteGenerationStopsImmediately() {
    var clock = 0L
    var polls = 0
    val settled = awaitSnapshotTransactionSettled(
      budgetMs = 60_000L, pollStepMs = 1_000L,
      now = { clock }, sleep = { clock += it },
      transactionActive = { polls++; true },
      current = { false },
    )
    assertFalse("换代必须立刻收手", settled)
    assertEquals("换代后不得再读事务状态", 0, polls)
  }

  /** 没有事务在场：**不等**（一拍即过），避免把正常启动拖进预算。 */
  @Test
  fun anAbsentTransactionSettlesWithoutWaiting() {
    var clock = 0L
    var polls = 0
    val settled = awaitSnapshotTransactionSettled(
      budgetMs = 60_000L, pollStepMs = 1_000L,
      now = { clock }, sleep = { clock += it },
      transactionActive = { polls++; SnapshotTransaction.readMarker(files) != null },
      current = { true },
    )
    assertTrue("无事务必须立即放行", settled)
    assertEquals(1, polls)
    assertEquals("无事务不得睡眠", 0L, clock)
  }

  /**
   * 生产预算是从「一次全量重解压实测 8-12 分钟」推导出来的**有界**值：
   * 必须大于 12 分钟上限（否则合格的慢刷新会被判超时），且不得无限。
   * 同时步进必须为正 —— 步进为 0 会让 settle 后的 postDelayed 变成忙等。
   */
  @Test
  fun theProductionBudgetCoversTheMeasuredRefreshWindow() {
    assertTrue(
      "预算必须覆盖实测上限 12 分钟（现值 " + SNAPSHOT_TRANSACTION_WAIT_BUDGET_MS + "ms）",
      SNAPSHOT_TRANSACTION_WAIT_BUDGET_MS > 12 * 60_000L,
    )
    assertTrue("预算必须有界", SNAPSHOT_TRANSACTION_WAIT_BUDGET_MS <= 30 * 60_000L)
    assertTrue("轮询步进必须为正（否则退化为忙等）", SNAPSHOT_TRANSACTION_WAIT_POLL_STEP_MS > 0L)
  }

  /** 账龄取的是 journal 自述的 startedAt（跨进程），不是内存时间戳；缺起始时间时**不猜**（0）。 */
  @Test
  fun transactionAccountedAgeComesFromTheJournalAndNeverGoesNegative() {
    val marker = SnapshotTransaction.Marker(SnapshotTransaction.Phase.SWAPPING, "fp", 10_000L)
    assertEquals(5_000L, snapshotTransactionAccountedAgeMs(marker, 15_000L))
    assertEquals("时钟回拨不得产出负账龄", 0L, snapshotTransactionAccountedAgeMs(marker, 1_000L))
    assertEquals("无 journal ⇒ 0（不猜）", 0L, snapshotTransactionAccountedAgeMs(null, 15_000L))
    assertEquals("journal 缺起始时间 ⇒ 0（不猜）", 0L, snapshotTransactionAccountedAgeMs(marker.copy(startedAt = 0L), 15_000L))
    // 真文件对账：写一份 journal 再读回来，账龄必须等于「自述起始时间」到 now 的差。
    writeInFlightTransaction(1_000L)
    val onDisk = SnapshotTransaction.readMarker(files)
    assertEquals(60_000L, snapshotTransactionAccountedAgeMs(onDisk, 61_000L))
  }

  // ── ② 文案层：如实中间态，不得宣称就绪（D3 判据 C3） ──────────────────────────

  /**
   * D3 的 C3 判据（`claimsReady`）点名四个词；本函数的文案必须一个都不含。
   * 同时必须说清**旧引擎仍在运行**与**事务在跑**这两个事实。
   */
  @Test
  fun theWaitTextNeverClaimsReadinessAndStatesTheRealPhase() {
    for (age in listOf(null, 0L, 60_000L, 12 * 60_000L)) {
      val text = snapshotTransactionWaitText("SWAPPING", age)
      assertTrue("文案不得为空（age=" + age + "）", text.isNotBlank())
      assertTrue("必须说明运行时正在解压（age=" + age + "）：" + text, text.contains("正在解压"))
      assertTrue("必须说明旧引擎仍在运行（age=" + age + "）", text.contains("旧引擎仍在运行"))
      assertTrue("必须说明事务收口后会自动继续（age=" + age + "）", text.contains("收口后"))
      assertTrue("必须说明不会先停旧引擎（age=" + age + "）", text.contains("停止旧引擎"))
      for (claim in listOf("已就绪", "启动完成", "已启动完成", "可以开始使用", "已完成")) {
        assertFalse("不得出现就绪类词「" + claim + "」（age=" + age + "）：" + text, text.contains(claim))
      }
    }
  }

  /** 账龄必须如实进文案：未知就说未知，不给假数字（编造百分比是既有 UX 缺陷的同族形态）。 */
  @Test
  fun theWaitTextRendersTheAccountedAgeHonestly() {
    assertTrue("未知时长必须如实标注", snapshotTransactionWaitText("STAGED", null).contains("未知时长"))
    assertTrue("13 分钟必须渲染成 13 分钟", snapshotTransactionWaitText("STAGED", 13 * 60_000L).contains("13 分钟"))
    assertFalse("不得凭空给出未提供的时长", snapshotTransactionWaitText("STAGED", null).contains("分钟"))
  }

  // ── ③ 接线层：调用点不得回退成静默丢弃（撤掉修复即红） ────────────────────────

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /**
   * **本文件的核心反证**：`start()` 里不得再出现裸的 `flowOwnership.begin() ?: return`。
   *
   * 那一行就是缺陷本体（抢不到 = 直接返回，零痕迹）。修复后必须：拿到 null 时走
   * [deferEngineStartWhileSnapshotTransactionBusy] 那条如实处置路径。
   */
  @Test
  fun theSilentDropInStartIsGone() {
    val flow = codeOnly(source("EngineStartFlow.kt"))
    assertFalse(
      "start() 不得再静默丢弃启动请求（val token = flowOwnership.begin() ?: return）",
      flow.contains("val token = flowOwnership.begin() ?: return"),
    )
    val start = flow.substringAfter("fun start() {").substringBefore("private fun canRunEngineWork")
    assertTrue("start() 必须显式分支处理 begin() 返回 null", start.contains("val token = flowOwnership.begin()"))
    assertTrue(
      "begin() 拿不到所有权时必须走如实处置（留痕 + 有界等待）",
      start.contains("deferEngineStartWhileSnapshotTransactionBusy()"),
    )
    assertTrue(
      "destroyed 与非 destroyed 必须分开处置（前者不启动，后者等待）",
      start.contains("flowOwnership.destroyed"),
    )
  }

  /**
   * 留痕必须进 **boot-fail.log** 而不是只进 `LogCollector.log`：后者的 sink 受
   * `DevLogPrefs` 门控且默认关闭、`dsh-day.log` 恒 absent，等于没留痕（报告 §4 可观测性缺口）。
   */
  @Test
  fun deferralIsRecordedInBootFailNotOnlyInTheDisabledCollector() {
    val flow = codeOnly(source("EngineStartFlow.kt"))
    for (stage in listOf(
      "engine-start-deferred",              // 撞上刷新：转为有界等待
      "engine-start-deferred-no-transaction", // 所有权被占但无事务：如实记账（不空等）
      "engine-start-deferred-timeout",      // 等待预算用尽：如实收手
      "snapshot-transaction-wait",          // 安全模式重启的事务等待（进入面）
      "snapshot-transaction-wait-failed",   // 事务未在预算内收口
      "safe-mode-restart-started",          // P2：成功后进入启动流
    )) {
      assertTrue("必须落 boot-fail stage=" + stage, flow.contains("\"" + stage + "\""))
    }
    // 反证：不得只留一句 LogCollector.log 就算完（那正是「零回执」的形态）。
    val defer = flow.substringAfter("private fun deferEngineStartWhileSnapshotTransactionBusy()")
      .substringBefore("private val deferredStartRunnable")
    assertTrue("处置路径必须写 boot-fail", defer.contains("LogCollector.writeBootFail("))
  }

  /** 等待的判据必须是**跨进程真源** journal，而不是本 Activity 实例的内存态。 */
  @Test
  fun theHostSideWaitReadsTheCrossProcessJournal() {
    val flow = codeOnly(source("EngineStartFlow.kt"))
    val defer = flow.substringAfter("private fun deferEngineStartWhileSnapshotTransactionBusy()")
      .substringBefore("private val deferredStartRunnable")
    assertTrue("必须读事务 journal（跨进程真源）", defer.contains("SnapshotTransaction.readMarker(activity.filesDir)"))
    val safe = flow.substringAfter("private fun performSafeModeRestart()")
      .substringBefore("private fun applySafeModeRestartHint(")
    assertTrue(
      "安全模式重启必须**在停旧引擎之前**判事务（先停会让用户白等 8-12 分钟没有引擎）",
      safe.indexOf("SnapshotTransaction.readMarker(activity.filesDir)") in 0 until safe.indexOf("engine.stopOwnedEngine()"),
    )
    assertTrue("事务在场时必须走等待路径，不得直接继续", safe.contains("awaitSnapshotTransactionThenRestartSafeMode()"))
    // 续跑必须同时满足「事务收口」与「所有权空出来」，否则又撞回 L700（等于把丢弃换成忙等）。
    val runnable = flow.substringAfter("private val deferredStartRunnable")
      .substringBefore("private fun canRunEngineWork")
    assertTrue("续跑必须同时判事务与所有权", runnable.contains("!transactionBusy && !flowOwnership.running"))
  }

  /**
   * `safeModeRestartHint` 仍是 4 值枚举的**穷尽** when（本 PR 不扩判定契约）：新增的事务等待
   * 文案必须住在独立纯函数里，不是塞进那个取值域。
   */
  @Test
  fun theWaitTextDoesNotWidenTheSafeModeDecisionContract() {
    val flow = codeOnly(source("EngineStartFlow.kt"))
    val decisions = listOf("PROCEED", "PROCEED_SNAPSHOT_STALE", "REFUSE_LIVE_INCOMPLETE", "REFUSE_OWNERSHIP")
      .filter { flow.contains("SafeModeRestartDecision." + it) }
    assertEquals("判定取值域仍是 4 个（本 PR 不得扩枚举）", 4, decisions.size)
    assertEquals(4, SafeModeRestartDecision.entries.size)
    assertTrue("事务等待文案必须是独立函数", flow.contains("internal fun snapshotTransactionWaitText("))
    assertFalse(
      "事务等待文案不得进入 safeModeRestartHint 的取值域",
      Regex("safeModeRestartHint\\([^)]*\\).contains\\(").containsMatchIn(flow),
    )
  }

  // ── ④ 「别人正在做」不得记成「自己失败」（EngineManager 口径纠正） ─────────────

  /**
   * 同一堵墙上另两处早已是对的（startEngine:1304-1307 返回 true 让行、
   * invalidateSnapshotFreshness:443-446 返回 false 让行），全仓只有 `refreshSnapshotInternal`
   * 把事务在飞记成失败。修复后：**推迟**与**失败**必须是两个可区分的字段。
   */
  @Test
  fun anInFlightTransactionIsNotRecordedAsThisCallerFailure() {
    val code = codeOnly(source("EngineManager.kt"))
    val internalRefresh = code.substringAfter("private fun refreshSnapshotInternal(")
      .substringBefore("private fun liveRuntimeEvidence(")
    val gate = internalRefresh.substringAfter("if (!beginSnapshotTransaction())")
      .substringBefore("val fingerprint = bundledFingerprint()")
    assertFalse(
      "被让行不得冒充失败（不得挂一个属于本次的异常到 lastRefreshFailure）",
      gate.contains("lastRefreshFailure = IllegalStateException") ||
        gate.contains("lastRefreshFailure = SnapshotFsException"),
    )
    assertTrue("被让行必须把失败面显式清成 null（不得留下上一次的异常）", gate.contains("lastRefreshFailure = null"))
    assertTrue("被让行必须标记为「推迟」而不是失败", gate.contains("lastRefreshDeferred = true"))
    assertTrue(
      "推迟的判据是 beginSnapshotTransaction() 的返回值（事务互斥）",
      internalRefresh.contains("if (!beginSnapshotTransaction())"),
    )
    // 推迟不得喂失败账本：否则纯并发争用会把「同快照连续失败达阈」喂出来，降级闸门永久跳过刷新。
    val wrapper = code.substringAfter("fun refreshSnapshot(")
      .substringBefore("private fun refreshSnapshotInternal(")
    assertTrue("推迟时不得写失败账本", wrapper.contains("lastRefreshDeferred"))
    assertTrue("推迟只允许走日志，不得写 afterFailure", Regex("else if \\(lastRefreshDeferred\\)[\\s\\S]{0,400}?Log\\.i").containsMatchIn(wrapper))
  }
}
