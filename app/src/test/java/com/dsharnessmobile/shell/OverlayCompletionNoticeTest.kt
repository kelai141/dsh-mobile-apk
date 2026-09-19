package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 块H（0.14.1）核心逻辑的 JVM 测试：完成位状态机（A1）+ 报告栏渲染（A2）。
 *
 * 详档 docs/0.14.1-preview-OVERLAY-COMPLETION-CARD.md §6.2 的四条反证中，有两条是**状态/渲染语义**，
 * 可以在纯 JVM 上判红（另两条 A2「空摘要不崩」在本类，A3 二次点击在 CallSiteContractTest 组）：
 *  - A1 反证：**无 pending 的普通完成必须显示「已完成」**，而旧实现（只有 `dropped` 才 flashStatus）
 *    在此路径上什么都不显示。故断言必须覆盖「没有任何 pending 参与」的路径——本类全部用例
 *    都不构造 pending，正是为了能区分新旧行为。
 *  - A1 复位反证：连续两轮，第 2 轮开始后不得残留第 1 轮的完成文案。
 *
 * 纯 JVM（无 Robolectric）。CompletionNotice 与 turnEndLabel 均不触碰 Android 类。
 */
class OverlayCompletionNoticeTest {

  // ── A1：完成位置位 / 消费 / 常驻期 ──────────────────────────────────

  /**
   * A1 反证（核心）：**无 pending 的普通完成**必须能置位并显示「已完成」。
   * 旧实现 `flashStatus("已完成")` 的两处调用都在 `if (dropped)` 之内，本路径上**什么都不显示**。
   */
  @Test
  fun plainCompletionWithoutAnyPendingStillArmsAndShows() {
    val c = CompletionNotice()
    // 权威信号 running=false（无任何 pending 参与）
    c.onAuthoritativeIdle("sess-a", "已完成")
    assertTrue("A1 反证：无 pending 的普通完成也必须置位", c.isArmed())
    assertEquals("未消费时面板收起态也应能看到（activeLabel 只在消费后返回）", "", c.activeLabel())
    // 首次打开消费
    c.consume()
    assertEquals("A1 反证：普通完成必须显示「已完成」", "已完成", c.activeLabel())
  }

  /** A1：完成位必须能在「面板收起态」存活到首次打开——即置位与消费是两个独立步骤。 */
  @Test
  fun noticeSurvivesUntilTheFirstOpen() {
    val c = CompletionNotice()
    c.onAuthoritativeIdle("s", "已完成")
    // 模拟自动收起后的一段时间：多次读取不改变状态
    repeat(3) { assertTrue(c.isArmed()) }
    c.consume()
    assertEquals("已完成", c.activeLabel())
  }

  /** A1 判定 1（「首次」限定）：消费后本次展开常驻，**收起再打开即回常态**。 */
  @Test
  fun labelPersistsDuringTheExpandSessionButNotAfter() {
    val c = CompletionNotice()
    c.onAuthoritativeIdle("s", "已完成")
    c.consume()
    assertEquals("本次展开期常驻", "已完成", c.activeLabel())
    // 收起（hidePanel）→ 再打开（showPanel 无新完成位可消费）
    c.onPanelHidden()
    assertFalse("「首次」语义：同一完成位不得被消费两次", c.consume())
    assertEquals("A1 判定 1：再次收起再打开必须回常态", "", c.activeLabel())
  }

  /** A1 复位反证：连续两轮，第 2 轮开始后第 1 轮的完成文案必须消失（防「只置位不清除」的假通过）。 */
  @Test
  fun secondTurnOfATwoTurnRunDoesNotLeakTheFirstTurnsLabel() {
    val c = CompletionNotice()
    // 第 1 轮完成 → 打开消费
    c.onTurnEnd("s", "已完成")
    c.consume()
    assertEquals("第 1 轮完成文案", "已完成", c.activeLabel())

    // 第 2 轮开始（api-session/status running=true 或任一 tool_call）
    c.onTurnStart()
    assertEquals("A1 复位反证：第 2 轮开始后不得残留第 1 轮的完成文案", "", c.activeLabel())
    assertFalse("完成位必须被清除", c.isArmed())

    // 第 2 轮尚未完成时再次打开 → 必须仍是常态
    c.consume()
    assertEquals("A1 复位反证：第 2 轮进行中打开必须仍是常态", "", c.activeLabel())
  }

  /** A1 语义分支：失败类标签不得伪装成「已完成」（kind 映射与 notify-projection 同构）。 */
  @Test
  fun nonSuccessOutcomesNeverReadAsCompleted() {
    for (kind in listOf("error", "blocked", "aborted", "max-tokens", "interrupted")) {
      val label = turnEndLabel(kind)
      assertFalse("kind=$kind 不得映射为「已完成」", label == "已完成")
      assertTrue("kind=$kind 必须有可读标签", label.isNotBlank())
    }
    assertEquals("仅 completed 对应「已完成」", "已完成", turnEndLabel("completed"))
    assertEquals("未知 kind 一律「结果未知」", "结果未知", turnEndLabel("some-future-kind"))
    assertEquals("空 kind 不得当成功", "结果未知", turnEndLabel(""))
  }

  /** A1 语义优先：语义标签（turn_end 的 kind）不得被权威信号 running=false 的默认文案覆盖。 */
  @Test
  fun semanticLabelFromTurnEndWinsOverTheAuthoritativeDefault() {
    val c = CompletionNotice()
    c.onTurnEnd("s", "失败")
    c.onAuthoritativeIdle("s", "已完成")
    c.consume()
    assertEquals("语义标签更精确，不得被默认「已完成」覆盖", "失败", c.activeLabel())
  }

  /**
   * A1 多会话（**task-14 改造：这是一个真断言**）：A 会话完成后，B 会话不得呈现 A 的完成文案。
   *
   * 旧实现（假防线）：断言 `activeLabel()`（无会话形参）恒返回 `"已完成"`——**与 sessionId 无关**，
   * 把 `onTurnEnd`/`onAuthoritativeIdle` 的会话键改成任何值都一样绿，等于没测。
   * 现改为经 `activeLabelFor(当前目标会话)` 断言，并同时覆盖「同会话可见 / 异会话不可见」两侧。
   */
  @Test
  fun aDifferentSessionsIdleSignalDoesNotRewriteAnArmedNotice() {
    val c = CompletionNotice()
    c.onTurnEnd("sess-a", "已完成")
    // 权威默认信号带**别的**会话键：不得抢走完成位的归属（语义标签已在场，直接早退）
    c.onAuthoritativeIdle("sess-b", "已完成")
    assertEquals("完成位归属仍应是 A 会话（未被 B 的权威信号改写）", "sess-a", c.armedSessionId())
    assertTrue("未消费前已置位", c.isArmed())
    c.consume()
    assertEquals("A 会话自己看得到", "已完成", c.activeLabelFor("sess-a"))
    assertEquals("**B 会话不得看到 A 的完成文案**", "", c.activeLabelFor("sess-b"))
    assertFalse("已消费", c.isArmed())
  }

  /**
   * A1 会话分桶的**反向必红判据**（task-14 新增）：无人值守的完成位在异会话下同样不得呈现。
   * 这条能抓住「只存 sessionId 却从不比对」的缺陷形态——旧实现把它存进 pair 就再也读过（`.first` 零命中）。
   */
  @Test
  fun anArmedNoticeIsNotShownWhenTheActiveSessionDiffers() {
    val c = CompletionNotice()
    c.onTurnEnd("sess-a", "已完成")
    assertTrue(c.isArmed())
    assertEquals("未消费 + 异会话：不得呈现", "", c.activeLabelFor("sess-b"))
    c.consume()
    assertEquals("A 会话呈现", "已完成", c.activeLabelFor("sess-a"))
    assertEquals("消费后异会话仍不得呈现", "", c.activeLabelFor("sess-b"))
    // 空键按通配（目标未确定时不应误伤 A1 的可用性）
    assertEquals("空目标会话按通配呈现", "已完成", c.activeLabelFor(""))
  }

  /**
   * A1 详档 §3.2「目标会话切换清除」：切换目标后旧会话的完成位被清除（不只是不显示）。
   * @return 清除语义必须真的发生——`armedSessionId()` 变 null、且文案回常态。
   */
  @Test
  fun targetSessionSwitchClearsTheNotice() {
    val c = CompletionNotice()
    c.onTurnEnd("sess-a", "已完成")
    assertFalse("切到同一会话不应清除", c.onTargetSessionChanged("sess-a"))
    assertTrue("切到别的会话必须清除", c.onTargetSessionChanged("sess-b"))
    assertEquals("清除后不得残留归属", null, c.armedSessionId())
    c.consume()
    assertEquals("清除后 consume 无内容可呈现", "", c.activeLabelFor("sess-b"))
    assertEquals("空目标会话不算切换（避免误清）", false, c.onTargetSessionChanged(""))
  }

  /**
   * A1：面板**此刻已展开**时完成（autoCollapseOnDone 关闭的常见路径）——
   * 完成位必须在置位当刻就被消费并展示，否则展开态永远看不到完成文案
   * （consume 只挂在 showPanel 上；此路径经 applyAgentStatus 显式消费）。
   */
  @Test
  fun completionWhileThePanelIsAlreadyOpenIsConsumedImmediately() {
    val c = CompletionNotice()
    c.onAuthoritativeIdle("s", "已完成")
    assertTrue("展开态置位当刻即消费", c.consume())
    assertEquals("已完成", c.activeLabel())
    assertFalse("消费后不得残留未消费位", c.isArmed())
  }

  /** A1：权威默认文案先到并被展示，随后语义标签到达 → 只升级文案，不得把提示撤下。 */
  @Test
  fun aLateSemanticLabelUpgradesTheShownLabelInsteadOfWithdrawingIt() {
    val c = CompletionNotice()
    c.onAuthoritativeIdle("s", "已完成")
    c.consume()
    assertEquals("已完成", c.activeLabel())
    c.onTurnEnd("s", "失败")
    assertEquals("语义标签后到应就地升级展示文案", "失败", c.activeLabel())
  }

  // ── A2：报告栏渲染（含空摘要反证） ────────────────────────────────

  /** A2 反证：**空摘要必须仍能渲染且不崩**（summary 可空，notify-projection 侧 `?? ''`）。 */
  @Test
  fun emptySummaryStillRendersALineInsteadOfCrashing() {
    val lines = reportLines(
      NotifyEntry(kind = "report", outcome = "completed", outcomeLabel = "已完成", summary = ""),
    )
    assertFalse("A2 反证：空摘要不得静默不显示", lines.isEmpty())
    assertTrue("首行必须非空", lines[0].isNotBlank())
    assertEquals("无摘要时首行只有标签（沿用 reportLine 的 head 兜底口径）", "已完成", lines[0])
  }

  /** A2 反证：本进程还没见过 report（接口返回 null）时必须给占位行、仍能打开。 */
  @Test
  fun missingReportStillYieldsPlaceholderLines() {
    val lines = reportLines(null)
    assertFalse("A2 反证：无汇报数据也不得返回空表（否则窗口内容为空）", lines.isEmpty())
    assertTrue("必须给出可读占位", lines[0].isNotBlank())
  }

  /** A2：正常汇报的文案口径与 NotifyCenter.reportLine/reportBigText 一致。 */
  @Test
  fun reportLinesMirrorTheExistingNotifyCenterLayout() {
    val lines = reportLines(
      NotifyEntry(
        kind = "report",
        outcome = "completed",
        outcomeLabel = "已完成",
        summary = "修好了三处回执",
        durationMs = 42_000,
        toolCount = 7,
        presentedFiles = listOf("a.kt", "b.kt"),
      ),
    )
    assertEquals(3, lines.size)
    assertEquals("已完成 · 修好了三处回执", lines[0])
    assertTrue("次行必须含用时与工具数", lines[1].startsWith("用时 ") && lines[1].contains("工具 ×7"))
    assertEquals("产出：a.kt、b.kt", lines[2])
  }

  /** A2：head 兜底链——outcomeLabel 为空时用 outcomeLabel() 映射，再空则「工作汇报」。 */
  @Test
  fun headFallsBackThroughTheSameChainAsNotifyCenter() {
    val mapped = reportLines(
      NotifyEntry(kind = "report", outcome = "error", outcomeLabel = "", summary = "炸了"),
    )
    assertEquals("失败 · 炸了", mapped[0])

    val blank = reportLines(
      NotifyEntry(kind = "report", outcome = "", outcomeLabel = "", summary = "只有正文"),
    )
    assertEquals("工作汇报 · 只有正文", blank[0])
  }

  /** A2：summary 为空但有 text 时必须回退到 text（reportLine 的既有兜底）。 */
  @Test
  fun emptySummaryFallsBackToTheTextField() {
    val lines = reportLines(
      NotifyEntry(kind = "report", outcome = "completed", outcomeLabel = "已完成", summary = "", text = "正文兜底"),
    )
    assertEquals("已完成 · 正文兜底", lines[0])
  }

  // ── A3 防误触（详档 §6.2 反证 3/4 + §6.1 A3-防误触）────────────────

  /** A3 反证：**二次点击不得跳转**（不足三次）。 */
  @Test
  fun twoTapsNeverJumpToTheApp() {
    assertEquals(StatusGestureAction.NONE, statusUpAction(moved = false, longFired = false, tapCount = 1))
    assertEquals(StatusGestureAction.NONE, statusUpAction(moved = false, longFired = false, tapCount = 2))
    assertEquals("恰好三次才跳", StatusGestureAction.JUMP_TO_APP, statusUpAction(moved = false, longFired = false, tapCount = 3))
  }

  /** A3 反证：长按已成立 → 该手势不得再触发 A3（一次手势只触发一个动作）。 */
  @Test
  fun aLongPressGestureNeverAlsoJumps() {
    assertEquals(
      StatusGestureAction.NONE,
      statusUpAction(moved = false, longFired = true, tapCount = 3),
    )
  }

  /** A2 防误触：按住并滑动（超 scaledTouchSlop）→ 判为拖动，既不长按也不跳转。 */
  @Test
  fun aDragBeyondSlopNeitherOpensTheBarNorJumps() {
    assertEquals(StatusGestureAction.NONE, statusUpAction(moved = true, longFired = false, tapCount = 3))
    assertEquals(StatusGestureAction.NONE, statusUpAction(moved = true, longFired = false, tapCount = 1))
  }

  /** 三击窗口：相邻两次点击必须在 doubleTapTimeout 内累加，超窗口即重新从 1 计。 */
  @Test
  fun tapCountingRespectsTheRuntimeWindow() {
    val window = 300L
    assertEquals("窗口内累加", 2, nextTapCount(now = 1_000L, lastUpAt = 900L, tapWindowMs = window, current = 1))
    assertEquals("超窗口重置为 1", 1, nextTapCount(now = 2_000L, lastUpAt = 900L, tapWindowMs = window, current = 2))
    assertEquals("首次点击（无上次 UP）为 1", 1, nextTapCount(now = 2_000L, lastUpAt = 0L, tapWindowMs = window, current = 0))
  }
}
