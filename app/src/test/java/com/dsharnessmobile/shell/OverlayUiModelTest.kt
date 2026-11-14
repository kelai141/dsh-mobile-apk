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
  fun `同名工具不同 callId 保留两个并发调用且结果只结束对应行`() {
    val first = OverlayUiModel.onToolCall(toolModel(), "c1", "Read", "a.kt", 100L)
    val second = OverlayUiModel.onToolCall(first, "c2", "Read", "b.kt", 110L)
    assertEquals("不同调用不能因同名被覆盖", listOf("c1", "c2"), second.toolRows.map { it.callId })
    assertEquals("两次调用都计数", 2, second.toolCount)
    assertTrue("两条调用同时运行", second.toolRows.all { it.running })

    val firstDone = OverlayUiModel.onToolResult(second, "c1", 120L)
    assertFalse("较早调用的结果仍能配对", firstDone.toolRows[0].running)
    assertTrue("结果不能结束另一个同名调用", firstDone.toolRows[1].running)
    val allDone = OverlayUiModel.onToolResult(firstDone, "c2", 130L, failed = true)
    assertFalse("第二个结果只结束第二条", allDone.toolRows[1].running)
    assertFalse("第一条不能沾染第二条失败位", allDone.toolRows[0].failed)
    assertTrue("第二条携带失败位", allDone.toolRows[1].failed)
  }

  @Test
  fun `旧协议空 callId 只与同样空 id 的同名行合并`() {
    val modern = OverlayUiModel.onToolCall(toolModel(), "c1", "Read", "modern", 100L)
    val legacy = OverlayUiModel.onToolCall(modern, "", "Read", "legacy-1", 110L)
    val updated = OverlayUiModel.onToolCall(legacy, "", "Read", "legacy-2", 120L)
    assertEquals("旧协议不能覆盖现代调用身份", listOf("c1", ""), updated.toolRows.map { it.callId })
    assertEquals("现代调用摘要保留", "modern", updated.toolRows[0].summary)
    assertEquals("旧协议同名原位更新", "legacy-2", updated.toolRows[1].summary)
    assertEquals("无身份事件每次仍算实际调用", 3, updated.toolCount)
  }

  @Test
  fun `有 callId 的调用不回落匹配旧协议同名行`() {
    val legacy = OverlayUiModel.onToolCall(toolModel(), "", "Read", "legacy", 100L)
    val modern = OverlayUiModel.onToolCall(legacy, "c1", "Read", "modern", 110L)
    assertEquals("新协议调用不能吞旧协议行", listOf("", "c1"), modern.toolRows.map { it.callId })
    assertEquals("两次调用分别计数", 2, modern.toolCount)
  }

  @Test
  fun `重复 tool_result 的缺省成功不能抹掉已有失败`() {
    val started = OverlayUiModel.onToolCall(toolModel(), "c1", "Bash", "false", 100L)
    val failed = OverlayUiModel.onToolResult(started, "c1", 120L, failed = true)
    val repeated = OverlayUiModel.onToolResult(failed, "c1", 130L)
    assertTrue("显式失败必须保留", repeated.toolRows.single().failed)
    assertFalse("重复结果不能恢复运行态", repeated.toolRows.single().running)
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
    assertTrue("新轮次占用边界", started.turnActive)
  }

  @Test
  fun `onTurnEnd completed 给出已完成并收口运行行`() {
    val started = OverlayUiModel.onToolCall(toolModel(), "c1", "Bash", "ls", 100L)
    val done = OverlayUiModel.onTurnEnd(started, "completed", 300L, english = false)
    assertEquals("中文结局文案", "已完成", done.completionLabel)
    assertEquals("完成后回到空闲", OverlayAgentState.IDLE, done.agent)
    assertFalse("残留运行行必须收口", done.toolRows[0].running)
    assertFalse("结束释放轮次边界", done.turnActive)
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

  @Test
  fun `重复 running true 不清本轮事件与待答`() {
    var m = OverlayUiModel.onRuntimeStatus(toolModel(), true, 100L)
    m = OverlayUiModel.onToolCall(m, "c1", "Read", "a.kt", 110L)
    m = OverlayUiModel.onThink(m, "继续分析", 120L)
    m = OverlayUiModel.onText(m, "当前进度", 130L)
    m = OverlayUiModel.setPending(m, listOf(pending("e1")))
    val repeated = OverlayUiModel.onRuntimeStatus(m, true, 200L)
    assertEquals("重复 true 只更新时间", m.copy(lastEventAt = 200L), repeated)
    assertEquals("计时不因重复状态重启", 100L, repeated.turnStartedAt)
  }

  @Test
  fun `WAITING 展示态不是新轮边界`() {
    var m = OverlayUiModel.onRuntimeStatus(toolModel(), true, 100L)
    m = OverlayUiModel.onToolCall(m, "c1", "Read", "a.kt", 110L)
    m = OverlayUiModel.setPending(m, listOf(pending("e1"))).copy(agent = OverlayAgentState.WAITING)
    val repeated = OverlayUiModel.onRuntimeStatus(m, true, 200L)
    assertEquals("待答与调用都保留", m.copy(agent = OverlayAgentState.RUNNING, lastEventAt = 200L), repeated)
    assertTrue("仍是同一活动轮次", repeated.turnActive)
  }

  @Test
  fun `两轮运行态边界必须清除上一轮全部累积`() {
    var first = OverlayUiModel.onRuntimeStatus(toolModel(), true, 100L)
    first = OverlayUiModel.onToolCall(first, "c1", "Read", "a.kt", 110L)
    first = OverlayUiModel.onThink(first, "上一轮思考", 120L)
    first = OverlayUiModel.onText(first, "上一轮正文", 130L)
    first = OverlayUiModel.setPending(first, listOf(pending("e1")))
    first = OverlayUiModel.setCompletionLabel(first, "上一轮回执")
    val stopped = OverlayUiModel.onRuntimeStatus(first, false, 200L)
    assertEquals("false 不提前清内容", first.copy(agent = OverlayAgentState.IDLE, lastEventAt = 200L, turnActive = false), stopped)
    val next = OverlayUiModel.onRuntimeStatus(stopped, true, 300L)
    assertEquals("下一轮回到全新聚合", OverlayCardModel(
      agent = OverlayAgentState.RUNNING, turnStartedAt = 300L, lastEventAt = 300L, turnActive = true,
    ), next)
  }

  @Test
  fun `turn_end 后没有 false 仍允许下一轮清空`() {
    val first = OverlayUiModel.onRuntimeStatus(toolModel(), true, 100L)
    val withTool = OverlayUiModel.onToolCall(first, "c1", "Read", "a.kt", 110L)
    val ended = OverlayUiModel.onTurnEnd(withTool, "completed", 200L, english = false)
    val next = OverlayUiModel.onRuntimeStatus(ended, true, 300L)
    assertEquals("turn_end 本身就是轮次边界", OverlayCardModel(
      agent = OverlayAgentState.RUNNING, turnStartedAt = 300L, lastEventAt = 300L, turnActive = true,
    ), next)
  }

  @Test
  fun `turn_end error 后迟到 false 不清错误或结局`() {
    val started = OverlayUiModel.onRuntimeStatus(toolModel(), true, 100L)
    val ended = OverlayUiModel.onTurnEnd(started, "error", 200L, english = true)
    val lateFalse = OverlayUiModel.onRuntimeStatus(ended, false, 300L)
    assertEquals("迟到 false 只更新时间", ended.copy(lastEventAt = 300L), lateFalse)
    assertEquals("错误不是空闲", OverlayAgentState.ERROR, lateFalse.agent)
    assertEquals("失败不是离线", "Failed", OverlayUiModel.pillOf(lateFalse, english = true).text)
    assertFalse("不能再次激活已结束轮次", lateFalse.turnActive)
  }

  @Test
  fun `切会话用独立模型不会继承上一会话事件`() {
    val first = OverlayUiModel.onRuntimeStatus(toolModel(), true, 100L)
    val firstWithTool = OverlayUiModel.onToolCall(first, "c1", "Read", "a.kt", 110L)
    val second = OverlayUiModel.onRuntimeStatus(OverlayCardModel(), true, 200L)
    val secondWithTool = OverlayUiModel.onToolCall(second, "c1", "Read", "b.kt", 210L)
    assertEquals("第一会话内容不受另一模型影响", "a.kt", firstWithTool.toolRows.single().summary)
    assertEquals("另一会话相同 callId 也独立计数", 1, secondWithTool.toolCount)
    assertEquals("新会话只显示自己的调用", "b.kt", secondWithTool.toolRows.single().summary)
    assertEquals("新会话重新计时", 200L, secondWithTool.turnStartedAt)
  }

  @Test
  fun `断线先展示离线且重连恢复当前轮次不清内容`() {
    var running = OverlayUiModel.onRuntimeStatus(toolModel(), true, 100L)
    running = OverlayUiModel.onToolCall(running, "c1", "Read", "a.kt", 110L)
    running = OverlayUiModel.setPending(running, listOf(pending("e1")))
    val offline = OverlayUiModel.onEngineStatus(running, false, 200L)
    assertEquals("离线仅改变连接维度和时间", running.copy(engineOnline = false, lastEventAt = 200L), offline)
    assertEquals("残留运行行和待答不能盖掉离线", "Engine offline", OverlayUiModel.pillOf(offline, english = true).text)
    assertEquals("标题同样明确离线", "引擎离线", OverlayUiModel.headlineOf(offline))
    val online = OverlayUiModel.onEngineStatus(offline, true, 300L)
    val repeated = OverlayUiModel.onRuntimeStatus(online, true, 310L)
    assertEquals("重连 true 不是下一轮", running.copy(lastEventAt = 310L), repeated)
    assertEquals("重连恢复待答提示", "Waiting for your answer", OverlayUiModel.pillOf(repeated, english = true).text)
  }

  @Test
  fun `轮次失败离线重连后仍 Failed 而不是 Idle`() {
    val ended = OverlayUiModel.onTurnEnd(toolModel(), "error", 100L, english = true)
    val offline = OverlayUiModel.onEngineStatus(ended, false, 200L)
    assertEquals("断线独立展示", "Engine offline", OverlayUiModel.pillOf(offline, english = true).text)
    val online = OverlayUiModel.onEngineStatus(offline, true, 300L)
    assertEquals("重连恢复原失败", "Failed", OverlayUiModel.pillOf(online, english = true).text)
    assertEquals("重连不篡改结局或主状态", ended.copy(lastEventAt = 300L), online)
    assertEquals("失败标题不冒充离线", "Failed", OverlayUiModel.headlineOf(online, english = true))
  }

  @Test
  fun `新轮次不擅自把引擎离线改为在线`() {
    val offline = OverlayUiModel.onEngineStatus(toolModel(), false, 100L)
    val started = OverlayUiModel.onRuntimeStatus(offline, true, 200L)
    assertFalse("轮次状态不能覆盖连接事实", started.engineOnline)
    assertEquals("离线仍优先显示", "引擎离线", OverlayUiModel.pillOf(started, english = false).text)
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
  fun `pillOf 在线时等待用户优先级最高`() {
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
  fun `headline 英文兜底与失败工具逐条双语`() {
    val failed = OverlayCardModel(toolRows = listOf(OverlayToolRow("c1", "", "x", running = false, failed = true)))
    assertEquals("缺省保留中文", "失败 工具 · x", OverlayUiModel.headlineOf(failed))
    assertEquals("英文工具和失败前缀", "Failed Tool · x", OverlayUiModel.headlineOf(failed, english = true))
    val fallbacks = listOf(
      Triple(OverlayAgentState.IDLE, "空闲", "Idle"),
      Triple(OverlayAgentState.RUNNING, "工作中", "Working"),
      Triple(OverlayAgentState.WAITING, "等待你的回答", "Waiting for your answer"),
      Triple(OverlayAgentState.ERROR, "失败", "Failed"),
    )
    for ((agent, zh, en) in fallbacks) {
      val m = OverlayCardModel(agent = agent)
      assertEquals("中文状态兜底", zh, OverlayUiModel.headlineOf(m))
      assertEquals("英文状态兜底", en, OverlayUiModel.headlineOf(m, english = true))
    }
  }

  @Test
  fun `completionLabelOf 按kind重新本地化但不篡改旧label`() {
    val zh = OverlayUiModel.onTurnEnd(toolModel(), "completed", 100L, english = false)
    assertEquals("completed", zh.completionKind)
    assertEquals("已完成", zh.completionLabel)
    assertEquals("Completed", OverlayUiModel.completionLabelOf(zh, english = true))
    val failed = OverlayUiModel.onTurnEnd(toolModel(), "error", 100L, english = true)
    assertEquals("失败", OverlayUiModel.completionLabelOf(failed, english = false))
    assertEquals("Failed", OverlayUiModel.pillOf(failed, english = true).text)
    assertEquals("Engine offline", OverlayUiModel.pillOf(failed.copy(engineOnline = false), english = true).text)
    assertEquals("", OverlayUiModel.onTurnStart(zh, 200L).completionKind)
    val custom = OverlayUiModel.setCompletionLabel(zh, "custom receipt")
    assertEquals("", custom.completionKind)
    assertEquals("custom receipt", OverlayUiModel.completionLabelOf(custom, english = false))
    val unknown = OverlayUiModel.onTurnEnd(toolModel(), "future-kind", 1L, english = false)
    assertEquals("Unknown result", OverlayUiModel.completionLabelOf(unknown, english = true))
  }

  @Test
  fun `在线轮次失败不冒充引擎离线`() {
    val error = OverlayCardModel(agent = OverlayAgentState.ERROR)
    assertEquals("中文轮次失败", "失败", OverlayUiModel.pillOf(error, english = false).text)
    assertEquals("英文轮次失败", "Failed", OverlayUiModel.pillOf(error, english = true).text)
    assertEquals("失败仍用错误色调", OverlayTone.ERROR, OverlayUiModel.pillOf(error, english = true).tone)
    assertTrue("轮次错误不代表断线", error.engineOnline)
  }

  @Test
  fun `pillOf 引擎离线与空闲文案`() {
    val offline = OverlayCardModel(engineOnline = false)
    assertEquals("中文离线", "引擎离线", OverlayUiModel.pillOf(offline, english = false).text)
    assertEquals("英文离线", "Engine offline", OverlayUiModel.pillOf(offline, english = true).text)
    assertEquals("离线色调", OverlayTone.ERROR, OverlayUiModel.pillOf(offline, english = false).tone)
    val idle = OverlayCardModel()
    assertEquals("中文空闲", "空闲", OverlayUiModel.pillOf(idle, english = false).text)
    assertEquals("英文空闲", "Idle", OverlayUiModel.pillOf(idle, english = true).text)
    assertEquals("空闲色调", OverlayTone.IDLE, OverlayUiModel.pillOf(idle, english = false).tone)
  }
}
