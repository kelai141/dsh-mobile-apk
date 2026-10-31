package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 修复助手「模型状态提示」的文案归属。
 *
 * 这段逻辑原先内联在 `RepairActivity.applyModelState`，只能靠拉起 Activity 才验得到；
 * 而拉起 Activity 会读真实的 `filesDir/home`，在真机上等于污染用户配置。
 * 抽成纯函数后，判定与渲染分开，这里直接钉「什么情况报哪句话」。
 *
 * 社群现场（2026-10-30）：用户配置搞坏、进不了安全模式，修复助手报「未读到可用模型」，
 * 社区结论是「那没救了」。所以这句话在什么条件下出现、什么条件下不出现，必须有测试守着。
 */
class RepairModelNoticeTest {

  private fun present(
    failure: String? = null,
    candidateCount: Int = 1,
    defaultModelAvailable: Boolean = true,
    diagnosticsReady: Boolean = true,
    rootMissing: Boolean = false,
  ) = RepairModelNotice.present(
    failure = failure,
    candidateCount = candidateCount,
    defaultModelAvailable = defaultModelAvailable,
    diagnosticsReady = diagnosticsReady,
    noModelText = "未读到可用模型。可在控制台修好配置后重新读取，也可直接重试引擎。",
    noDiagnosticsText = "无法读取本轮诊断。可打开控制台或返回启动页重试引擎。",
    defaultUnavailableText = "当前默认模型不可用。请点右上角选择模型，再发送修复需求。",
    rootMissing = rootMissing,
    rootMissingText = "运行时还没解出来（配置目录尚不存在）。请返回启动页重试引擎。",
  )

  // ── 1. 0 候选：社群那句话 ─────────────────────────────────────────────────

  @Test
  fun `空候选时报未读到可用模型`() {
    val notice = present(candidateCount = 0)
    assertTrue("提示必须可见", notice.visible)
    assertTrue("必须是那句「未读到可用模型」，实际：" + notice.text,
      notice.text!!.startsWith("未读到可用模型"))
    assertTrue("必须附上来源表，用户才知道检查了哪些文件", notice.appendSources)
    assertFalse("0 候选时模型选择器必须禁用", notice.modelControlsEnabled)
    assertTrue("但发送键不跟着关（issue #1012 A3）", notice.sendEnabled)
  }

  @Test
  fun `空候选时默认模型状态不影响那句话`() {
    // 0 候选时 defaultModelAvailable 必然是 false，但不能因此改说「默认模型不可用」——
    // 那会让用户以为只要换个默认模型就好，而其实一条可用路由都没有。
    val a = present(candidateCount = 0, defaultModelAvailable = false)
    val b = present(candidateCount = 0, defaultModelAvailable = true)
    assertEquals(a.text, b.text)
    assertTrue(a.text!!.startsWith("未读到可用模型"))
  }

  // ── 2. 读取抛错：原因压过归纳性说法 ───────────────────────────────────────

  @Test
  fun `读取失败时优先报具体原因`() {
    val notice = present(failure = "读取模型配置失败：IllegalStateException", candidateCount = 0)
    assertEquals("读取模型配置失败：IllegalStateException", notice.text)
    assertTrue("也要附来源表", notice.appendSources)
    assertFalse("没有候选，模型选择器仍禁用", notice.modelControlsEnabled)
    assertTrue("但发送键可用（issue #1012 A3）", notice.sendEnabled)
  }

  // ── 3. 有候选但默认不在：能选，所以控件可用 ────────────────────────────────

  @Test
  fun `默认模型不可用时报选择提示且控件保持可用`() {
    val notice = present(candidateCount = 2, defaultModelAvailable = false)
    assertTrue(notice.visible)
    assertTrue("应提示去选模型，实际：" + notice.text, notice.text!!.startsWith("当前默认模型不可用"))
    assertTrue("有候选就必须让用户能选", notice.modelControlsEnabled)
    assertFalse("这条不需要附来源表", notice.appendSources)
  }

  // ── 4. 诊断读不到：提示但不挡模型 ─────────────────────────────────────────

  @Test
  fun `诊断读不到时提示但不影响模型可用`() {
    val notice = present(candidateCount = 1, diagnosticsReady = false)
    assertTrue(notice.visible)
    assertTrue("应提示诊断问题，实际：" + notice.text, notice.text!!.startsWith("无法读取本轮诊断"))
    assertTrue("模型没问题就不该禁用", notice.modelControlsEnabled)
  }

  // ── 5. 一切正常：不显示 ───────────────────────────────────────────────────

  @Test
  fun `一切正常时提示区不显示`() {
    val notice = present(candidateCount = 1)
    assertFalse("不该显示", notice.visible)
    assertNull("不该有正文", notice.text)
    assertTrue("控件可用", notice.modelControlsEnabled)
  }

  // ── 5.4 根缺失（issue #1012 A1）：运行时没解出来，不是没模型 ───────────────

  @Test
  fun `配置根源缺失时提示指向运行时而不是没模型`() {
    // 助手只在引擎连续两次启动失败后被拉起，那正是 home/.dsh 可能还不存在的时刻。
    // 旧实现把它和「用户删了配置」混成一句「未读到可用模型」，用户会去翻配置，
    // 而真正该做的是回启动页重试引擎（让快照解出来）。
    val notice = present(candidateCount = 0, rootMissing = true)
    assertTrue(notice.visible)
    val text = notice.text.orEmpty()
    assertFalse("根缺失不得报「没读到可用模型」（实际：$text）", text.startsWith("未读到可用模型"))
    assertTrue("必须点名运行时/重试引擎（实际：$text）",
      text.contains("运行时") || text.contains("重试引擎"))
    assertTrue("仍要附来源表", notice.appendSources)
  }

  @Test
  fun `根缺失优先于诊断未就绪`() {
    // 根缺失时诊断必然也读不到（引擎没起来）。此时要说的是根因，不是后果。
    val notice = present(candidateCount = 0, diagnosticsReady = false, rootMissing = true)
    assertTrue("必须是根缺失那句话（实际：" + notice.text + "）",
      notice.text.orEmpty().startsWith("运行时还没解出来"))
  }

  // ── 5.5 诊断与 0 候选同时成立（issue #1012）─────────────────────────────

  @Test
  fun `零候选且诊断读不到时正文必须带上更准确的诊断原因`() {
    // 运行时死掉时「0 候选」与「诊断读不到」同时成立，旧实现先判 0 候选，
    // 于是更准确的原因被那句「未读到可用模型」吞掉，用户以为只是没配模型。
    val notice = present(candidateCount = 0, defaultModelAvailable = false, diagnosticsReady = false)
    val text = notice.text.orEmpty()
    assertTrue("诊断原因必须出现在正文里（实际：$text）", text.contains("无法读取本轮诊断"))
    assertTrue("同时仍要说明没有可用模型（实际：$text）", text.contains("未读到可用模型"))
  }

  // ── 5.6 0 候选只关模型选择，不关发送（issue #1012 A3）────────────────────

  @Test
  fun `零候选时发送键不被禁用`() {
    // 旧实现 applyModelState 用同一个 modelControlsEnabled 同时关掉 modelButton 与 send，
    // 于是 0 候选时用户除「退出去」之外没有别的动作。判定抽到 present() 后由本用例钉住。
    val notice = present(candidateCount = 0)
    assertFalse("0 候选时模型选择器必须禁用（点下去只会拿到空列表）", notice.modelControlsEnabled)
    assertTrue("但发送键不能被一起关掉", notice.sendEnabled)
  }

  @Test
  fun `根缺失时发送键同样不被禁用`() {
    val notice = present(candidateCount = 0, rootMissing = true)
    assertFalse(notice.modelControlsEnabled)
    assertTrue("根缺失也属于「没有候选」，发送同样不该被关", notice.sendEnabled)
  }

  @Test
  fun `读取抛错且零候选时发送键仍不被禁用`() {
    val notice = present(failure = "读取模型配置失败：IOException", candidateCount = 0)
    assertFalse("没有候选，选择器禁用", notice.modelControlsEnabled)
    assertTrue("读取失败也要让用户能说话/能重试", notice.sendEnabled)
  }

  @Test
  fun `一切正常时发送键可用`() {
    assertTrue(present(candidateCount = 1).sendEnabled)
  }

  // ── 5.7 0 候选时提交不得静默吞掉草稿（issue #1012 A3）────────────────────

  @Test
  fun `零候选时提交既不发送也不得丢弃草稿`() {
    // 旧实现 submit() 先 input.setText("") 再进 runAgent()，而 runAgent 在
    // connections 为空时静默 return —— 用户打的字凭空消失、界面毫无反应。
    val decision = RepairModelNotice.composer(candidateCount = 0, text = "帮我看看启动日志")
    assertFalse("没有候选就发不出去", decision.send)
    assertTrue("一个字符都不能丢", decision.keepDraft)
    assertTrue("必须告诉用户为什么没发出去", decision.notifyNoModel)
  }

  @Test
  fun `有候选时提交要发送且清空草稿`() {
    val decision = RepairModelNotice.composer(candidateCount = 2, text = "继续修复")
    assertTrue("有候选就该发出去", decision.send)
    assertFalse("发出去之后才允许清空", decision.keepDraft)
    assertFalse("不需要报错", decision.notifyNoModel)
  }

  @Test
  fun `空输入时提交不发送也不打扰用户`() {
    val decision = RepairModelNotice.composer(candidateCount = 0, text = "   ")
    assertFalse(decision.send)
    assertFalse("空输入不该弹出「没有模型」的提示", decision.notifyNoModel)
  }

  // ── 6. 优先级：四条分支互不串味 ───────────────────────────────────────────

  @Test
  fun `四条提示分支各自独占不会串味`() {
    // 同时满足多个条件时，必须按 失败 > 0候选 > 默认不可用 > 诊断 的顺序取第一条。
    val allBad = present(failure = "boom", candidateCount = 0, defaultModelAvailable = false, diagnosticsReady = false)
    assertEquals("读取失败压过其它", "boom", allBad.text)
    val noModel = present(candidateCount = 0, defaultModelAvailable = false, diagnosticsReady = false)
    assertTrue("0 候选压过默认不可用与诊断", noModel.text!!.startsWith("未读到可用模型"))
    // 根缺失比「0 候选」更具体，但仍排在「读取抛错」之后（抛错是当场可证的原因）。
    val rootMissing = present(candidateCount = 0, diagnosticsReady = false, rootMissing = true)
    assertTrue("根缺失压过 0 候选与诊断", rootMissing.text!!.startsWith("运行时还没解出来"))
    val defaultBad = present(candidateCount = 1, defaultModelAvailable = false, diagnosticsReady = false)
    assertTrue("默认不可用压过诊断", defaultBad.text!!.startsWith("当前默认模型不可用"))
  }
}