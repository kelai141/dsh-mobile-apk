package com.dsharnessmobile.shell

import java.io.File
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test

/** 协议纯函数 + 生产接线反证；真实mux/IME/底部输入闭环由设备验收。 */
class OverlayPanelQuestionTextTest {
  private fun source() = listOf(
    File("src/main/java/com/dsharnessmobile/shell/OverlayPanel.kt"),
    File("app/src/main/java/com/dsharnessmobile/shell/OverlayPanel.kt"),
  ).first { it.isFile }.readText()

  private fun wire(result: String) = "{\"type\":\"server-response\",\"rpcId\":\"q1\",\"result\":" + result + "}"

  @Test fun strictResultRequiresLiteralBusinessTrueNotJustHttp200() {
    assertEquals(OverlayQuestionResult.ACCEPTED, overlayQuestionResult(200, wire("{\"ok\":true}")))
    assertEquals(OverlayQuestionResult.REJECTED, overlayQuestionResult(200, wire("{\"ok\":false,\"error\":{}}")))
    for (body in listOf("", "{}", "{\"ok\":true}", "{\"result\":{\"ok\":\"true\"}}", "not-json")) {
      assertEquals(body, OverlayQuestionResult.UNKNOWN, overlayQuestionResult(200, body))
    }
    assertEquals(OverlayQuestionResult.UNKNOWN, overlayQuestionResult(-1, ""))
    assertEquals(OverlayQuestionResult.UNKNOWN, overlayQuestionResult(503, ""))
    assertEquals(OverlayQuestionResult.REJECTED, overlayQuestionResult(403, ""))
  }

  @Test fun answerProtocolPreservesQuestionOrderPreviousSelectionsAndMultiCustom() {
    val items = JSONArray("[{\"id\":\"first\"},{\"id\":\"second\",\"multiSelect\":true},{\"id\":\"third\"}]")
    val answers = overlayQuestionAnswers(items,
      mapOf("first" to "A", "third" to "stale-single"),
      mapOf("second" to listOf("B", "C")),
      mapOf("second" to " extra ", "third" to " final text "),
    )
    assertEquals(3, answers.length())
    assertEquals("first", answers.getJSONObject(0).getString("id"))
    assertEquals("A", answers.getJSONObject(0).getJSONArray("selected").getString(0))
    assertEquals(2, answers.getJSONObject(1).getJSONArray("selected").length())
    assertEquals("extra", answers.getJSONObject(1).getString("custom"))
    assertEquals(0, answers.getJSONObject(2).getJSONArray("selected").length())
    assertEquals("final text", answers.getJSONObject(2).getString("custom"))
  }

  @Test fun explicitSkippedQuestionKeepsItsPositionAndEmptySelectedRatherThanDroppingIt() {
    val answers = overlayQuestionAnswers(JSONArray("[{\"id\":\"skip\"},{\"id\":\"answer\"}]"), emptyMap(), emptyMap(), mapOf("answer" to "text"))
    assertEquals(2, answers.length())
    assertEquals("skip", answers.getJSONObject(0).getString("id"))
    assertEquals(0, answers.getJSONObject(0).getJSONArray("selected").length())
    assertFalse(answers.getJSONObject(0).has("custom"))
  }

  @Test fun currentTextTargetIncludesIdentityQuestionPromptAndOriginalCustom() {
    val target = source().substringAfter("internal fun questionTextTarget(").substringBefore("internal fun questionTextAnswer(")
    assertTrue(target.contains("qe.submittedAt > 0L"))
    assertTrue(target.contains("!svc.matchesTargetAgent(qe.agentId)"))
    assertTrue(target.contains("eventResults.containsKey(eventId)"))
    assertTrue(target.contains("svc.activeSessionId, svc.currentAgentId, qid"))
    assertTrue(target.contains("qCustom[qid].orEmpty()"))
    assertTrue(target.contains("ids.toSet().size != ids.size"))
  }

  @Test fun intermediateQuestionSavesAndAdvancesBeforeAnyRpcAndIncompleteFinalDoesNotSubmit() {
    assertQuestionTextContract(source())
    val answer = source().substringAfter("internal fun questionTextAnswer(").substringBefore("/** 展开合体")
    assertTrue(answer.contains("qCustom[questionId] = custom"))
    assertTrue(answer.contains("binding.activeAgentId != svc.currentAgentId"))
    assertTrue(answer.contains("binding.sessionId != svc.activeSessionId"))
    assertTrue(answer.contains("qe !== binding.question"))
    assertTrue(answer.contains("if (!item.optBoolean(\"multiSelect\", false)) qSingle.remove(questionId)"))
    assertFalse(answer.contains("multiSel.clear()"))
    assertTrue(answer.contains("if (unanswered)"))
    assertTrue(answer.indexOf("if (unanswered)") < answer.indexOf("respondQuestion(qe, onResult)"))
  }

  @Test fun strictSubmitCapturesStreamIdentityAndUnknownBlocksAllQuestionResubmission() {
    val source = source()
    val strict = source.substringAfter("private fun postQuestionTextResult(").substringBefore("private fun respondApproval(")
    assertTrue(strict.contains("val clientId = eventsClientId"))
    assertTrue(strict.contains("clientId != eventsClientId"))
    assertTrue(strict.contains("overlayQuestionResult(code, body)"))
    val respond = source.substringAfter("private fun respondQuestion(").substringBefore("/** 跳过提问")
    assertTrue(respond.contains("eventResults[qe.eventId] = OverlayQuestionResult.PENDING"))
    assertTrue(respond.contains("OverlayQuestionResult.ACCEPTED, OverlayQuestionResult.UNKNOWN -> eventResults[qe.eventId] = result"))
    assertTrue(respond.contains("postQuestionTextResult(qe.eventId, outcomeJson, complete)"))
    assertTrue(respond.contains("onResult?.invoke(accepted)"))
    assertTrue(respond.contains("expectedSession == svc.activeSessionId && expectedAgent == svc.currentAgentId"))
    val dismiss = source.substringAfter("private fun dismissQuestion(").substringBefore("internal fun dropPendingFor(")
    assertTrue(dismiss.contains("if (eventResults.containsKey(qe.eventId))"))
  }

  @Test fun perEventDraftKeepsPreviousAnswersWhenApprovalOrAnotherQuestionTakesFocus() {
    val source = source()
    assertTrue(source.contains("saveCurrentQuestionDraft()\n      pendingKey = key"))
    assertTrue(source.contains("qSingle.putAll(draft.singles); qCustom.putAll(draft.customs)"))
    assertTrue(source.contains("for ((id, values) in draft.multis) multiSel[id] = ArrayList(values)"))
    assertTrue(source.contains("qPage = draft.page"))
    assertTrue(source.contains("qSkipped.add(qid)"))
  }

  @Test fun controlledNegativeRejectsSilentIntermediateWholeFormSubmission() {
    val original = source()
    val mutated = original.replace("      qPage++\n      saveCurrentQuestionDraft()", "      respondQuestion(qe, onResult)\n      qPage++\n      saveCurrentQuestionDraft()")
    assertNotEquals(original, mutated)
    var rejected = false
    try { assertQuestionTextContract(mutated) } catch (_: AssertionError) { rejected = true }
    assertTrue(rejected)
  }

  private fun assertQuestionTextContract(source: String) {
    val answer = source.substringAfter("internal fun questionTextAnswer(").substringBefore("/** 展开合体")
    val intermediate = answer.substringAfter("if (qPage < qe.items.length() - 1)").substringBefore("val unanswered")
    assertTrue(intermediate.contains("qPage++"))
    assertTrue(intermediate.contains("saveCurrentQuestionDraft()"))
    assertTrue(intermediate.contains("onResult(true)"))
    assertTrue(intermediate.contains("return"))
    assertFalse(intermediate.contains("respondQuestion("))
    assertFalse(intermediate.contains("postQuestionTextResult("))
  }
}
