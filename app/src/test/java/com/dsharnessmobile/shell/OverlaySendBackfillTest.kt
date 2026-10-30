package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1042 + #1043「发送 -> 失败回填」链路的行为回归（纯 JVM，无 Robolectric）。
 *
 * 两条缺陷缠在同一处编排里，所以用同一个测试类：
 *  - #1042 目标=新会话时 payload 在 `session/create` **之前**构建，`sessionId` 恒为空串；
 *  - #1043 失败回填 `setText(text)` 不判用户是否已经重新输入（`postRpc` 读超时 8s 的窗口）。
 *
 * 判据分两层（沿用本仓既有的两条路子）：
 *  1. **纯函数判据**——[payloadSessionId] / [failureBackfillPlan] 是 `OverlayService.kt` 里的
 *     internal 顶层纯函数（Service 在 JVM 里实例化不了，故判定必须离开类实例），语义直接可测；
 *  2. **源码级判据**——EditText/Service 跑不起来，就断言「修复形态在场 + 旧形态不在场」。
 *
 * **反向判据**（证明修复不是靠删功能/改成永不发生变绿）：
 *  - `payloadSessionIdTakesTheKnownSession`：非空目标仍必须用它（过度修复成「一律当新会话」即红）；
 *  - `sendUsesSessionIdResolvedAtSendTime` 里 create 分支与 `activeSessionId = sid` 必须在场
 *    （靠删掉建会话功能变绿即红）；
 *  - `backfillStillRestoresWhenUserLeftTheBoxEmpty`：用户没动过必须照旧回填（改成「永不回填」即红）；
 *  - `backfillPreservesOriginalWhenUserTypedSomethingElse`：被拦下的原文必须可找回（改成「直接丢弃」即红）。
 */
class OverlaySendBackfillTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  /** 只留代码行（注释里会复述旧实现作为背景，直接对全文断言会被自己的说明判红）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /** 取一个成员体的文本：从签名起，到下一个同级成员声明为止。 */
  private fun memberBody(src: String, signature: String): String {
    val idx = src.indexOf(signature)
    if (idx < 0) throw AssertionError("找不到成员签名 " + signature)
    val rest = src.substring(idx + signature.length)
    val cut = listOf("\n  override fun ", "\n  private fun ", "\n  internal fun ", "\n  fun ")
      .map { rest.indexOf(it) }
      .filter { it >= 0 }
      .minOrNull() ?: rest.length
    return rest.substring(0, cut)
  }

  // ── #1042：payload 用哪个 sessionId（纯函数） ──────────────────────────────

  @Test
  fun newSessionTargetHasNoPayloadSessionBeforeCreate() {
    // 目标=新会话：create 成功之前确实还没有 id。修复前 send 拿到的就是这个空串（缺陷本体）。
    assertEquals("", payloadSessionId(""))
  }

  @Test
  fun payloadSessionIdTakesTheKnownSession() {
    // 反向判据：已有 id 必须原样用。若「过度修复」成一律当新会话（恒返回 ""），本断言立刻红。
    assertEquals("sess-42", payloadSessionId("sess-42"))
    assertEquals("agent-73", payloadSessionId("agent-73"))
    // 空白不得被当成合法 id（否则 create 分支被跳过、prompt 带 "   "）。
    assertEquals("", payloadSessionId("   "))
    assertEquals("", payloadSessionId("\n\t "))
  }

  @Test
  fun sendUsesSessionIdResolvedAtSendTime() {
    val code = codeOnly(source("OverlayService.kt"))
    val body = memberBody(code, "internal fun requestSend()")
    // 1) 旧形态不得在场：把 activeSessionId 直接塞进请求发起前构建的 payload 就是 #1042 的本体。
    assertFalse(
      "旧形态仍在（payload 在 create 前就把 activeSessionId 写死）：\n" + body,
      body.contains(".put(\"sessionId\", activeSessionId)"),
    )
    // 2) 发出去的 sessionId 必须是**发送时刻**现算的。
    assertTrue(
      "payload 的 sessionId 必须在 send 时用 payloadSessionId(activeSessionId) 现算：\n" + body,
      body.contains("\"sessionId\", payloadSessionId(activeSessionId)"),
    )
    // 3) 反向判据：建会话分支、「成功后记住新 id」、以及「建完再发」都必须仍在场
    //    （靠删掉建会话功能让判据变绿，这里会红）。
    assertTrue("建会话分支必须仍在：\n" + body, body.contains("postRpc(\"session/create\""))
    // 4) 分支必须**真的可达**：入口判据就是「发送时刻解析出的 sessionId 为空」。
    //    只断言 "postRpc(\"session/create\"" 在场还不够——把条件改成 if (false) 时那段代码仍在，
    //    但整条「新会话」路径已经死了（反向判据：这条断言会红）。
    assertTrue(
      "建会话分支的入口判据必须是 payloadSessionId(activeSessionId).isEmpty()（不得写成恒假/别的字段）：\n" + body,
      body.contains("if (payloadSessionId(activeSessionId).isEmpty()) {"),
    )
    assertTrue("create 成功后必须把新 id 记进 activeSessionId：\n" + body, body.contains("activeSessionId = sid"))
    assertEquals(
      "send.run() 必须仍是两条路径（create 成功后 / 已有会话）各自一次：\n" + body,
      2,
      Regex("send\\.run\\(\\)").findAll(body).count(),
    )
  }

  @Test
  fun requestIdIsFixedOncePerSendSoTheRetryIsIdempotent() {
    val code = codeOnly(source("OverlayService.kt"))
    val body = memberBody(code, "internal fun requestSend()")
    // requestId 是幂等键：同一次用户发送必须复用同一个值。若「把 payload 构建挪到发送时」
    // 顺手在 Runnable 里再生成一次，create 与 prompt 就成了两次不同请求（重试不再幂等）。
    assertEquals(
      "requestId 在 requestSend 体内只许生成一次：\n" + body,
      1,
      Regex("System\\.currentTimeMillis\\(\\)").findAll(body).count(),
    )
    val gen = body.indexOf("val requestId")
    val send = body.indexOf("val send = Runnable")
    assertTrue("requestId 必须先于 Runnable 定好：gen=" + gen + " send=" + send + "\n" + body, gen in 0 until send)
    assertTrue(
      "payload 必须复用同一个 requestId 变量：\n" + body,
      body.contains(".put(\"requestId\", requestId)"),
    )
  }

  // ── #1043：失败时要不要回填（纯函数） ────────────────────────────────────

  @Test
  fun backfillStillRestoresWhenUserLeftTheBoxEmpty() {
    // 反向判据：用户没动过（框是空的）时**必须**照旧回填——否则修复变成「永不回填」，
    // 原文随失败一起消失，比覆盖更糟。
    val plan = failureBackfillPlan(current = "", sent = "安排一下今天的日程", reason = "发送失败（HTTP 500）")
    assertTrue("用户没重新输入时必须回填：" + plan, plan.shouldRestore)
    assertEquals("安排一下今天的日程", plan.restoreText)
    assertFalse("正常回填不需要把原文另外存起来：" + plan, plan.originalElsewhere)
    assertEquals("发送失败（HTTP 500）", plan.reason)
  }

  @Test
  fun backfillStillRestoresWhenTheBoxStillHoldsTheSentText() {
    // 用户把同一段文字又敲回来了（或框根本没被清空）——仍是「没动过」，回填内容相同，不算覆盖。
    val plan = failureBackfillPlan(current = "  安排一下今天的日程  ", sent = "安排一下今天的日程", reason = "离线")
    assertTrue("当前内容仍等于本次原文时必须回填：" + plan, plan.shouldRestore)
    assertEquals("安排一下今天的日程", plan.restoreText)
  }

  @Test
  fun backfillPreservesOriginalWhenUserTypedSomethingElse() {
    // 缺陷本体：用户已经敲了新内容，回填会把它整段覆盖。
    val plan = failureBackfillPlan(current = "顺便问下明天的天气", sent = "安排一下今天的日程", reason = "发送失败（HTTP 500）")
    assertFalse("用户已改过输入框时不得覆盖：" + plan, plan.shouldRestore)
    assertEquals("被保护的用户输入不得被替换", "", plan.restoreText)
    // 反向判据：原文必须可找回（不是「直接丢弃」）——文案里带原文 + 说明去向。
    assertTrue("回填被拒时原文必须出现在提示里：" + plan, plan.reason.contains("安排一下今天的日程"))
    assertTrue("回填被拒时必须声明原文已另存：" + plan, plan.originalElsewhere)
    assertTrue("去向要写清楚（剪贴板）：" + plan, plan.reason.contains("剪贴板"))
    assertEquals("原文本身必须原样交回调用方：" + plan, "安排一下今天的日程", plan.original)
  }

  @Test
  fun backfillDecisionTreatsBlankInputAsUntouched() {
    // 空框 / 纯空白框都算「没动过」；纯空白不等于用户的新内容。
    assertTrue(failureBackfillPlan(current = "", sent = "A", reason = "x").shouldRestore)
    assertTrue(failureBackfillPlan(current = "   \n ", sent = "A", reason = "x").shouldRestore)
    assertEquals("A", failureBackfillPlan(current = "", sent = "A", reason = "x").restoreText)
    // 只差首尾空白的「同一句话」也算没动过。
    assertTrue(failureBackfillPlan(current = "  A ", sent = "A", reason = "x").shouldRestore)
  }

  // ── 调用点：三处失败分支都必须走判据 ────────────────────────────────────

  @Test
  fun failureBranchesAskThePlanInsteadOfBackfillingBlindly() {
    val code = codeOnly(source("OverlayService.kt"))
    val body = memberBody(code, "internal fun requestSend()")
    // 旧实现：三处失败分支无条件 setText(text)。
    assertFalse(
      "仍有绕过判据的无条件回填：\n" + body,
      Regex("inputBox\\?\\.setText\\(\\s*text\\s*\\)").containsMatchIn(body),
    )
    assertEquals(
      "三处失败分支（send / create 解析 / create HTTP）都必须走回填判据：\n" + body,
      3,
      Regex("restoreAfterFailure\\(").findAll(body).count(),
    )
  }

  @Test
  fun backfillGuardLooksAtTheCurrentInputAndPublishesTheReason() {
    val code = codeOnly(source("OverlayService.kt"))
    val body = memberBody(code, "private fun restoreAfterFailure(")
    // 判据的输入必须是**当前**输入框内容（只看本次 text 就退化成无条件回填）。
    assertTrue("必须读当前输入框内容：\n" + body, body.contains("current = panel.inputBox?.text?.toString()"))
    assertTrue("必须把本次原文交给判据：\n" + body, body.contains("sent = text"))
    // 文案必须来自判据（否则「原文已复制到剪贴板」这类说明不会出现在状态行）。
    assertTrue("状态行文案必须取判据结果：\n" + body, body.contains("flashStatus(plan.reason)"))
    // 只有拒绝回填那一支才写剪贴板；用户没动过时不许产生这个副作用。
    // 判据是「守卫内**真的**调了 copyFailedSend」——只断言守卫在场的话，把调用换成 Unit
    // （即「不回填也不另存」= 原文直接丢失）仍然绿，那正是本条要挡的假修复。
    assertTrue(
      "拒绝回填分支必须真的把原文另存（不是只留个空守卫）：\n" + body,
      Regex("if \\(!plan\\.shouldRestore\\) \\{\\s*copyFailedSend\\(plan\\.original\\)").containsMatchIn(body),
    )
  }

  @Test
  fun backfillKeepsTheOriginalRecoverableInClipboard() {
    val code = codeOnly(source("OverlayService.kt"))
    assertTrue(
      "回填被拒时原文必须落到剪贴板（唯一能跨面板收起存活的找回面）：\n" + code,
      code.contains("ClipData.newPlainText(\"dsh-overlay-failed-send\"") && code.contains("Context.CLIPBOARD_SERVICE"),
    )
    // 剪贴板可能被系统拒绝：日志里再留一份全文，保证「不覆盖」不等于「弄丢了」。
    assertTrue(
      "原文必须同时落日志：\n" + code,
      Regex("LogCollector\\.log\\(\"dsh-overlay\", \"[^\"]*\" \\+ text\\)").containsMatchIn(code),
    )
  }
}
