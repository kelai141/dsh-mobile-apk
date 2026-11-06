package com.dsharnessmobile.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1611 的行为判据：`browser_js` 的回执必须属于**发起求值的那一代文档**。
 *
 * 缺陷形态：`snapshotOp` / `textOp` / `measurePage` / `resolveRef` 都比对 `tab.generation`，
 * 只有 `browserJsOp` 拿到 `raw` 后只查 `targetProblem`、不查世代。触发路径是表达式自身触发
 * 导航，或页面 meta-refresh / 定时跳转落在 8 秒窗口内：旧文档的返回值以**新文档**的身份交付
 * （`pageReply` 现读 `url/loadState/pageGeneration`，于是回执里 `pageGeneration` 是 N+1 而
 * `value` 是第 N 代的产物）。
 *
 * 判据驱动的是**模型真正收到的那份 JSON**（[BrowserJsReplyGuard.settle] 的返回值），不是布尔：
 * 把世代比较删掉（恒走成功分支）⇒ 第一条用例立刻变红，且报出「旧值以新一代身份交付」。
 *
 * 夹具说明：`pageReply` 用与 `BrowserHost.pageReply` 同形的字段（url/title/loadState/reason/
 * pageGeneration）。这正是缺陷成立的地方——它读的是**当下**的世代，所以没有这道闸门时，
 * 旧值一定被贴上新的 pageGeneration。
 */
class BrowserJsReplyGuardTest {

  private fun replyOf(generation: Long): JSONObject = JSONObject()
    .put("session", "s1").put("tabId", "tab-1")
    .put("url", "https://example.com/").put("title", "Example")
    .put("loadState", "loaded").put("reason", "")
    .put("pageGeneration", generation)

  private fun reject(reason: String): JSONObject = JSONObject().put("ok", false).put("reason", reason)

  private fun settle(problem: String?, started: Long, current: Long, value: String = "old-document-value"): JSONObject =
    BrowserJsReplyGuard.settle(
      problem = problem,
      startedGeneration = started,
      currentGeneration = current,
      value = value,
      pageReply = { replyOf(current) },
      reject = { reject(it) },
    )

  @Test
  fun generationBumpRejectsTheReply() {
    val answer = settle(problem = null, started = 7L, current = 8L)
    assertFalse("导航推进了一代：旧文档的返回值不得以新文档身份交付", answer.getBoolean("ok"))
    assertEquals(
      "拒绝码必须与 snapshotOp/textOp 逐字同形（模型面已认这个字符串）",
      "stale-page-generation", answer.getString("reason"),
    )
    assertFalse("拒绝回执里不得夹带 value（模型会把它当成当前页的读数）", answer.has("value"))
  }

  @Test
  fun sameGenerationDeliversTheValue() {
    val answer = settle(problem = null, started = 7L, current = 7L, value = "42")
    assertTrue("世代未变 = 返回值确实属于这份文档，必须交付", answer.getBoolean("ok"))
    assertEquals("42", answer.getString("value"))
    assertEquals("回执的 pageGeneration 必须与交付值的世代一致", 7L, answer.getLong("pageGeneration"))
  }

  @Test
  fun targetProblemKeepsPriorityOverStaleness() {
    // 页已关闭/已换视图是更具体的原因：模型据此知道「这个 tab 没了」，而不是「重读一次就好」。
    assertEquals("browser-session-closed", settle("browser-session-closed", 7L, 8L).getString("reason"))
    assertEquals("tab-closed", settle("tab-closed", 3L, 3L).getString("reason"))
    assertEquals("stale-browser-view", settle("stale-browser-view", 3L, 4L).getString("reason"))
  }

  @Test
  fun rejectionCodeMatchesTheExistingModelFacingWire() {
    // 模型面已认这个字符串（snapshotOp / textOp 同款）；改名等于让工具层的分类失效。
    assertEquals("stale-page-generation", BrowserJsReplyGuard.STALE_PAGE_GENERATION)
  }
}
