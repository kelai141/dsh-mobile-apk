package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 事件聚合契约（纯 JVM）。
 *
 * 钉的是 [OverlayUiModel] 的折叠规则：工具行环形上限、去重、tool_result 配对、
 * 文本合并窗口、待答上限、结局文案中英成对、药丸优先级。
 * 这些规则一旦在渲染层重写一遍，事件风暴下的行为就没法用单测兜住。
 */
class OverlayUiModelTest {

  private fun toolModel(): OverlayCardModel = OverlayCardModel()

  private fun pending(eventId: String): OverlayPendingItem =
    OverlayPendingItem(eventId = eventId, kind = "approval", title = "批准命令")

  // ── 工具行 ───────────────────────────────────────────────────────────

  @Test
  fun `tool_call 追加一行并记下时间`() {
    val m = OverlayUiModel.onToolCall(toolModel(), "c1", "Bash", "ls -la", 100L)
    assertEquals("必须追加一行", 1, m.toolRows.size)
    assertEquals("callId 要原样保留", "c1", m.toolRows[0].callId)
    assertEquals("新行默认运行中", true, m.toolRows[0].running)
    assertEquals("计数加一", 1, m.toolCount)
    assertEquals("lastEventAt 要更新", 100L, m.lastEventAt)
  }

  @Test
  fun `同 callId 的重复 tool_call 不新增行`() {
    val first = OverlayUiModel.onToolCall(toolModel(), "c1", "Bash", "旧摘要", 100L)
    val second = OverlayUiModel.onToolCall(first, "c1", "Bash", "新摘要", 110L)
    assertEquals("同一 callId 只保留一行", 1, second.toolRows.size)
    assertEquals("摘要要被新事件覆盖", "新摘要", second.toolRows[0].summary)
    assertEquals("重复事件不重复计数", 1, second.toolCount)
  }

  @Test
  fun `同名工具不同 callId 更新原行而不是再插一行`() {
    val first = OverlayUiModel.onToolCall(toolModel(), "c1", "Read", "a.kt", 100L)
    val second = OverlayUiModel.onToolCall(first, "c2", "Read", "b.kt", 110L)
    assertEquals("同名工具只占一行", 1, second.toolRows.size)
    assertEquals("行内 callId 要更新为最新", "c2", second.toolRows[0].callId)
    assertEquals("调用计数仍要累加", 2, second.toolCount)
  }

  @Test
  fun `工具行超过 50 条时丢最旧`() {
    var m = toolModel()
    for (i in 0 until 55) {
      m = OverlayUiModel.onToolCall(m, "c" + i, "tool" + i, "", 100L + i)
    }
    assertEquals("环形上限 50", OverlayUiModel.MAX_TOOL_ROWS, m.toolRows.size)
    assertEquals("最旧的 5 条被丢弃", "c5", m.toolRows.first().callId)
    assertEquals("最新的一条在队尾", "c54", m.toolRows.last().callId)
    assertEquals("计数不能因丢弃而回退", 55, m.toolCount)
  }

  @Test
  fun `tool_result 把配对行标记为已结束`() {
    val started = OverlayUiModel.onToolCall(toolModel(), "c1", "Bash", "ls", 100L)
    val done = OverlayUiModel.onToolResult(started, "c1", 120L)
    assertFalse("配对行必须结束运行态", done.toolRows[0].running)
    assertEquals("lastEventAt 要更新", 120L, done.lastEventAt)
  }

  @Test
  fun `找不到配对的 tool_result 整体忽略`() {
    val started = OverlayUiModel.onToolCall(toolModel(), "c1", "Bash", "ls", 100L)
    val orphan = OverlayUiModel.onToolResult(started, "c9", 120L)
    assertEquals("不得新增占位行", started, orphan)
  }

  @Test
  fun `空 callId 的 tool_result 不误配`() {
    val started = OverlayUiModel.onToolCall(toolModel(), "", "Bash", "ls", 100L)
    val orphan = OverlayUiModel.onToolResult(started, "", 120L)
    assertEquals("空 callId 不参与配对", started, orphan)
  }

  // ── 合并窗口与文本截断 ───────────────────────────────────────────────

  @Test
  fun `合并窗口边界含 400ms 整`() {
    assertTrue("400ms 内合并", OverlayUiModel.shouldMerge(1000L, 1400L))
    assertTrue("同一时刻合并", OverlayUiModel.shouldMerge(1000L, 1000L))
    assertFalse("401ms 已跨窗口", OverlayUiModel.shouldMerge(1000L, 1401L))
    assertFalse("时钟回退不合并", OverlayUiModel.shouldMerge(1000L, 999L))
  }

  @Test
  fun `mergeThinking 新文本优先且空白不覆盖旧文本`() {
    assertEquals("新文本优先", "新的", OverlayUiModel.mergeThinking("旧的", "新的"))
    assertEquals("空白新文本保留旧内容", "旧的", OverlayUiModel.mergeThinking("旧的", "  "))
    assertEquals("两侧都空则空", "", OverlayUiModel.mergeThinking("", ""))
  }

  @Test
  fun `超长思考行截断到 120 字符以内并带省略号`() {
    val long = "a".repeat(200)
    val merged = OverlayUiModel.mergeThinking("", long)
    assertEquals("总长不得超过上限", OverlayUiModel.MAX_THINKING_CHARS, merged.length)
    assertTrue("截断要带省略号", merged.endsWith("…"))
  }

  @Test
  fun `恰好 120 字符不截断`() {
    val exact = "b".repeat(120)
    assertEquals("等于上限时原样保留", exact, OverlayUiModel.mergeThinking("", exact))
  }

  @Test
  fun `思考行里的换行压成单行`() {
    assertEquals("单行卡片不能出现换行", "第一行 第二行",
      OverlayUiModel.mergeThinking("", "第一行" + 10.toChar() + "第二行"))
  }

  @Test
  fun `onThink 更新思考行与事件时间`() {
    val m = OverlayUiModel.onThink(toolModel(), "先读文件", 100L)
    assertEquals("思考行写入", "先读文件", m.thinkingLine)
    assertEquals("事件时间更新", 100L, m.lastEventAt)
  }

  @Test
  fun `onText 写入 headline 且同样截断`() {
    val m = OverlayUiModel.onText(toolModel(), "答复正文", 100L)
    assertEquals("正文写入 headline", "答复正文", m.headline)
    assertEquals("事件时间更新", 100L, m.lastEventAt)
    val long = OverlayUiModel.onText(toolModel(), "c".repeat(300), 100L)
    assertEquals("正文同样受单行长度约束", OverlayUiModel.MAX_THINKING_CHARS,
      long.headline.length)
  }

  // ── 轮次生命周期 ─────────────────────────────────────────────────────

  @Test
  fun `onTurnStart 清空上一轮累积`() {
    var m = OverlayUiModel.onToolCall(toolModel(), "c1", "Bash", "ls", 100L)
    m = OverlayUiModel.onThink(m, "想想", 100L)
    m = OverlayUiModel.onText(m, "说点什么", 100L)
    m = OverlayUiModel.setPending(m, listOf(pending("e1")))
    m = OverlayUiModel.setCompletionLabel(m, "已完成")
    val started = OverlayUiModel.onTurnStart(m, 200L)
    assertEquals("新一轮是运行态", OverlayAgentState.RUNNING, started.agent)
    assertEquals("工具行清空", 0, started.toolRows.size)
    assertEquals("思考清空", "", started.thinkingLine)
    assertEquals("正文清空", "", started.headline)
    assertEquals("待答清空", 0, started.pending.size)
    assertEquals("结局文案清空", "", started.completionLabel)
    assertEquals("计数归零", 0, started.toolCount)
    assertEquals("轮次开始时间更新", 200L, started.turnStartedAt)
  }

  @Test
  fun `onTurnEnd completed 给出已完成并收口运行行`() {
    val started = OverlayUiModel.onToolCall(toolModel(), "c1", "Bash", "ls", 100L)
    val done = OverlayUiModel.onTurnEnd(started, "completed", 300L, english = false)
    assertEquals("中文结局文案", "已完成", done.completionLabel)
    assertEquals("完成后回到空闲", OverlayAgentState.IDLE, done.agent)
    assertFalse("残留运行行必须收口", done.toolRows[0].running)
  }

  @Test
  fun `onTurnEnd error 给出失败并进入错误态`() {
    val done = OverlayUiModel.onTurnEnd(toolModel(), "error", 300L, english = false)
    assertEquals("中文失败文案", "失败", done.completionLabel)
    assertEquals("错误态", OverlayAgentState.ERROR, done.agent)
  }

  @Test
  fun `onTurnEnd 英文文案逐条成对`() {
    assertEquals("completed 英文", "Completed",
      OverlayUiModel.onTurnEnd(toolModel(), "completed", 1L, english = true).completionLabel)
    assertEquals("interrupted 英文", "Interrupted",
      OverlayUiModel.onTurnEnd(toolModel(), "interrupted", 1L, english = true).completionLabel)
    assertEquals("blocked 英文", "Blocked",
      OverlayUiModel.onTurnEnd(toolModel(), "blocked", 1L, english = true).completionLabel)
    assertEquals("max-tokens 英文", "Output limit reached",
      OverlayUiModel.onTurnEnd(toolModel(), "max-tokens", 1L, english = true).completionLabel)
  }

  @Test
  fun `未知 kind 不得伪装成已完成`() {
    val zh = OverlayUiModel.onTurnEnd(toolModel(), "weird", 1L, english = false)
    assertEquals("未知 kind 中文", "结果未知", zh.completionLabel)
    val en = OverlayUiModel.onTurnEnd(toolModel(), "weird", 1L, english = true)
    assertEquals("未知 kind 英文", "Unknown result", en.completionLabel)
  }

  @Test
  fun `onTurnEnd 清空待答项`() {
    val m = OverlayUiModel.setPending(toolModel(), listOf(pending("e1")))
    val done = OverlayUiModel.onTurnEnd(m, "completed", 1L, english = false)
    assertEquals("轮次结束不再有可回答的待答项", 0, done.pending.size)
  }

  @Test
  fun `onAgentStatus 只切主状态`() {
    val running = OverlayUiModel.onAgentStatus(toolModel(), running = true, at = 50L)
    assertEquals("运行态", OverlayAgentState.RUNNING, running.agent)
    assertEquals("事件时间更新", 50L, running.lastEventAt)
    val idle = OverlayUiModel.onAgentStatus(running, running = false, at = 60L)
    assertEquals("结束回到空闲", OverlayAgentState.IDLE, idle.agent)
    val error = OverlayUiModel.onAgentStatus(toolModel(), running = false, at = 1L)
    error.let { assertEquals("空闲不是错误", OverlayAgentState.IDLE, it.agent) }
    val keepsError = OverlayUiModel.onAgentStatus(
      toolModel().copy(agent = OverlayAgentState.ERROR), running = false, at = 2L,
    )
    assertEquals("错误态不被状态回调抹掉", OverlayAgentState.ERROR, keepsError.agent)
  }

  // ── 待答上限 ─────────────────────────────────────────────────────────

  @Test
  fun `待答项超过 8 条时保留最新`() {
    val items = (0 until 10).map { pending("e" + it) }
    val m = OverlayUiModel.setPending(toolModel(), items)
    assertEquals("上限 8", OverlayUiModel.MAX_PENDING, m.pending.size)
    assertEquals("丢掉最旧两条", "e2", m.pending.first().eventId)
    assertEquals("最新一条保留", "e9", m.pending.last().eventId)
  }

  @Test
  fun `setCompletionLabel 只改结局文案`() {
    val m = OverlayUiModel.setCompletionLabel(toolModel(), "已完成")
    assertEquals("结局文案写入", "已完成", m.completionLabel)
    assertEquals("其余字段不动", toolModel().copy(completionLabel = "已完成"), m)
  }

  // ── 标题与药丸 ───────────────────────────────────────────────────────

  @Test
  fun `headline 优先展示运行中的工具`() {
    val m = OverlayCardModel(
      headline = "正文",
      thinkingLine = "思考",
      toolRows = listOf(
        OverlayToolRow("c1", "Bash", "ls", running = false, failed = false),
        OverlayToolRow("c2", "Edit", "a.kt", running = true, failed = false),
      ),
    )
    assertEquals("最近一条运行中的工具优先", "Edit · a.kt", OverlayUiModel.headlineOf(m))
  }

  @Test
  fun `没有运行中的工具时展示最新工具行`() {
    val m = OverlayCardModel(
      toolRows = listOf(
        OverlayToolRow("c1", "Bash", "ls", running = false, failed = false),
        OverlayToolRow("c2", "Read", "x", running = false, failed = true),
      ),
    )
    assertEquals("失败行要带文字前缀", "失败 Read · x", OverlayUiModel.headlineOf(m))
  }

  @Test
  fun `headline 无工具时依次回落正文思考结局与状态`() {
    assertEquals("正文优先", "正文",
      OverlayUiModel.headlineOf(OverlayCardModel(headline = "正文", thinkingLine = "思考")))
    assertEquals("再看思考", "思考",
      OverlayUiModel.headlineOf(OverlayCardModel(thinkingLine = "思考")))
    assertEquals("再看结局", "已完成",
      OverlayUiModel.headlineOf(OverlayCardModel(completionLabel = "已完成")))
    assertEquals("空模型给空闲文案", "空闲", OverlayUiModel.headlineOf(OverlayCardModel()))
  }

  @Test
  fun `pillOf 等待用户优先级最高`() {
    val m = OverlayCardModel(
      agent = OverlayAgentState.RUNNING,
      toolRows = listOf(OverlayToolRow("c1", "Bash", "ls", running = true, failed = false)),
      pending = listOf(pending("e1")),
    )
    val zh = OverlayUiModel.pillOf(m, english = false)
    assertEquals("中文等待文案", "等待你的回答", zh.text)
    assertEquals("等待色调", OverlayTone.WAITING, zh.tone)
    val en = OverlayUiModel.pillOf(m, english = true)
    assertEquals("英文等待文案", "Waiting for your answer", en.text)
  }

  @Test
  fun `pillOf 工作中带工具名`() {
    val m = OverlayCardModel(
      agent = OverlayAgentState.RUNNING,
      toolRows = listOf(OverlayToolRow("c1", "Bash", "ls", running = true, failed = false)),
    )
    assertEquals("中文工作中带工具名", "工作中：Bash",
      OverlayUiModel.pillOf(m, english = false).text)
    assertEquals("英文工作中带工具名", "Working: Bash",
      OverlayUiModel.pillOf(m, english = true).text)
    assertEquals("工作色调", OverlayTone.WORKING,
      OverlayUiModel.pillOf(m, english = false).tone)
  }

  @Test
  fun `pillOf 没有工具名时给泛化工作中`() {
    val m = OverlayCardModel(agent = OverlayAgentState.RUNNING)
    assertEquals("中文泛化", "工作中", OverlayUiModel.pillOf(m, english = false).text)
    assertEquals("英文泛化", "Working", OverlayUiModel.pillOf(m, english = true).text)
  }

  @Test
  fun `pillOf 引擎离线与空闲文案`() {
    val error = OverlayCardModel(agent = OverlayAgentState.ERROR)
    assertEquals("中文离线", "引擎离线", OverlayUiModel.pillOf(error, english = false).text)
    assertEquals("英文离线", "Engine offline", OverlayUiModel.pillOf(error, english = true).text)
    assertEquals("离线色调", OverlayTone.ERROR, OverlayUiModel.pillOf(error, english = false).tone)
    val idle = OverlayCardModel()
    assertEquals("中文空闲", "空闲", OverlayUiModel.pillOf(idle, english = false).text)
    assertEquals("英文空闲", "Idle", OverlayUiModel.pillOf(idle, english = true).text)
    assertEquals("空闲色调", OverlayTone.IDLE, OverlayUiModel.pillOf(idle, english = false).tone)
  }
}
