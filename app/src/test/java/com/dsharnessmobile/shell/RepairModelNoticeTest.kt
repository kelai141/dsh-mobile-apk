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
  ) = RepairModelNotice.present(
    failure = failure,
    candidateCount = candidateCount,
    defaultModelAvailable = defaultModelAvailable,
    diagnosticsReady = diagnosticsReady,
    noModelText = "未读到可用模型。可在控制台修好配置后重新读取，也可直接重试引擎。",
    noDiagnosticsText = "无法读取本轮诊断。可打开控制台或返回启动页重试引擎。",
    defaultUnavailableText = "当前默认模型不可用。请点右上角选择模型，再发送修复需求。",
  )

  // ── 1. 0 候选：社群那句话 ─────────────────────────────────────────────────

  @Test
  fun `空候选时报未读到可用模型`() {
    val notice = present(candidateCount = 0)
    assertTrue("提示必须可见", notice.visible)
    assertTrue("必须是那句「未读到可用模型」，实际：" + notice.text,
      notice.text!!.startsWith("未读到可用模型"))
    assertTrue("必须附上来源表，用户才知道检查了哪些文件", notice.appendSources)
    assertFalse("0 候选时模型控件必须禁用", notice.modelControlsEnabled)
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
    assertFalse("没有候选，控件仍禁用", notice.modelControlsEnabled)
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

  // ── 6. 优先级：四条分支互不串味 ───────────────────────────────────────────

  @Test
  fun `四条提示分支各自独占不会串味`() {
    // 同时满足多个条件时，必须按 失败 > 0候选 > 默认不可用 > 诊断 的顺序取第一条。
    val allBad = present(failure = "boom", candidateCount = 0, defaultModelAvailable = false, diagnosticsReady = false)
    assertEquals("读取失败压过其它", "boom", allBad.text)
    val noModel = present(candidateCount = 0, defaultModelAvailable = false, diagnosticsReady = false)
    assertTrue("0 候选压过默认不可用与诊断", noModel.text!!.startsWith("未读到可用模型"))
    val defaultBad = present(candidateCount = 1, defaultModelAvailable = false, diagnosticsReady = false)
    assertTrue("默认不可用压过诊断", defaultBad.text!!.startsWith("当前默认模型不可用"))
  }
}