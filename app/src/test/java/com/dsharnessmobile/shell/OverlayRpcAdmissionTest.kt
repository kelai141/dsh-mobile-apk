package com.dsharnessmobile.shell

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 实际官方 server-response body 的反证，不把 HTTP200 当消息已受理。 */
class OverlayRpcAdmissionTest {
  private fun wire(result: String): String = """{"type":"server-response","rpcId":"overlay-wire-1","result":$result}"""
  private fun parse(result: String, method: String = "session/prompt", code: Int = 200) =
    parseOverlayRpcAdmission(code, wire(result), method)
  private fun source(): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell/OverlayService.kt"),
    File("app/src/main/java/com/dsharnessmobile/shell/OverlayService.kt"),
  ).first { it.isFile }.readText().lineSequence().filterNot {
    val line = it.trimStart()
    line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")
  }.joinToString("\n")
  private fun member(name: String): String {
    val rest = source().substringAfter(name, "")
    check(rest.isNotEmpty()) { "Missing member $name" }
    val end = listOf("\n  private fun ", "\n  internal fun ", "\n  override fun ")
      .map { rest.indexOf(it) }.filter { it >= 0 }.minOrNull() ?: rest.length
    return rest.take(end)
  }

  @Test fun promptRequiresExplicitBusinessAcceptance() {
    assertEquals(OverlayRpcAdmissionState.ACCEPTED, parse("""{"ok":true,"value":{"accepted":true}}""").state)
    assertEquals(OverlayRpcAdmissionState.REJECTED, parse("""{"ok":true,"value":{"accepted":false}}""").state)
  }

  @Test fun http200RemoteErrorNeverAdmitsEvenWithSpoofedSuccessValue() {
    val reply = parse("""{"ok":false,"error":{"code":"session/agent-busy","message":"prompt rejected","details":{}},"value":{"accepted":true}}""")
    assertEquals(OverlayRpcAdmissionState.REJECTED, reply.state)
    assertFalse(reply.rpcSucceeded)
    assertTrue(reply.reason.contains("session/agent-busy"))
    assertTrue(reply.reason.contains("prompt rejected"))
  }

  @Test fun stringNumericOrMissingOkCannotBecomeBooleanSuccess() {
    for (result in listOf(
      """{"ok":"true","value":{"accepted":true}}""",
      """{"ok":1,"value":{"accepted":true}}""",
      """{"value":{"accepted":true}}""",
      """{"ok":null,"value":{"accepted":true}}""",
    )) assertEquals(result, OverlayRpcAdmissionState.UNKNOWN, parse(result).state)
  }

  @Test fun stringNumericMissingOrNullAcceptedStayUnknown() {
    for (value in listOf("""{"accepted":"true"}""", """{"accepted":1}""", "{}", "null")) {
      assertEquals(value, OverlayRpcAdmissionState.UNKNOWN, parse("""{"ok":true,"value":$value}""").state)
    }
  }

  @Test fun stringifiedBusinessValueIsNotTheOfficialObjectShape() {
    val value = JSONObject.quote("""{"accepted":true}""")
    assertEquals(OverlayRpcAdmissionState.UNKNOWN, parse("""{"ok":true,"value":$value}""").state)
  }

  @Test fun transportMinusOneNeverMeansRejectedOrAccepted() {
    assertEquals(OverlayRpcAdmissionState.UNKNOWN, parse("""{"ok":true,"value":{"accepted":true}}""", code = -1).state)
    assertEquals(OverlayRpcAdmissionState.UNKNOWN, parseOverlayRpcAdmission(-1, "Read timed out", "session/prompt").state)
  }

  @Test fun non200CannotAdmitEvenWithBusinessSuccessBody() {
    for (code in listOf(201, 204, 400, 401, 403, 500)) {
      assertEquals(code.toString(), OverlayRpcAdmissionState.REJECTED,
        parse("""{"ok":true,"value":{"accepted":true}}""", code = code).state)
    }
  }

  @Test fun malformedOrTruncatedBodiesRemainUnknownAndCannotPermitRetry() {
    for (body in listOf("", "not json", "null", "[]", "{", """{"type":"server-response","rpcId":"r","result":{"ok":true""")) {
      assertEquals(body, OverlayRpcAdmissionState.UNKNOWN, parseOverlayRpcAdmission(200, body, "session/prompt").state)
    }
  }

  @Test fun envelopeMustBeAnActualServerResponseNotBareResultOrRequest() {
    for (body in listOf(
      """{"ok":true,"value":{"accepted":true}}""",
      """{"type":"client-request","rpcId":"r","result":{"ok":true,"value":{"accepted":true}}}""",
      """{"type":"server-response","result":{"ok":true,"value":{"accepted":true}}}""",
    )) assertEquals(body, OverlayRpcAdmissionState.UNKNOWN, parseOverlayRpcAdmission(200, body, "session/prompt").state)
  }

  @Test fun createNeedsStrictOkAndActualNonblankSessionIdentity() {
    val accepted = parse("""{"ok":true,"value":{"sessionId":"session-a"}}""", "session/create")
    assertEquals(OverlayRpcAdmissionState.ACCEPTED, accepted.state)
    assertEquals("session-a", accepted.sessionId)
    assertTrue(accepted.rpcSucceeded)
    val error = parse("""{"ok":false,"error":{"code":"internal","message":"create rejected","details":{}},"value":{"sessionId":"forged"}}""", "session/create")
    assertEquals(OverlayRpcAdmissionState.REJECTED, error.state)
    assertEquals("", error.sessionId)
  }

  @Test fun createMalformedSuccessIdentityCannotAuthorizeAnotherCreate() {
    for (value in listOf("{}", """{"sessionId":"   "}""", """{"sessionId":12}""", JSONObject.quote("""{"sessionId":"nested"}"""))) {
      val reply = parse("""{"ok":true,"value":$value}""", "session/create")
      assertEquals(value, OverlayRpcAdmissionState.UNKNOWN, reply.state)
      assertEquals("", reply.sessionId)
    }
  }

  @Test fun cancelRequiresStrictBusinessAcknowledgementToo() {
    assertEquals(OverlayRpcAdmissionState.ACCEPTED, parse("""{"ok":true,"value":{"accepted":true}}""", "session/cancel").state)
    assertEquals(OverlayRpcAdmissionState.REJECTED, parse("""{"ok":true,"value":{"accepted":false}}""", "session/cancel").state)
    assertEquals(OverlayRpcAdmissionState.REJECTED, parse("""{"ok":false,"error":{"code":"session/not-found","message":"missing","details":{}}}""", "session/cancel").state)
    assertEquals(OverlayRpcAdmissionState.UNKNOWN, parse("""{"ok":true,"value":{}}""", "session/cancel").state)
  }

  @Test fun unsupportedMethodCannotBeMisclassifiedAsAdmission() {
    assertEquals(OverlayRpcAdmissionState.UNKNOWN, parse("""{"ok":true,"value":{"accepted":true}}""", "session/list").state)
  }

  @Test fun queueReceiptRequiresExactRequestIdNotBusyOrMessageText() {
    val body = wire("""{"ok":true,"value":{"active":true,"running":true,"queue":[{"id":"m1","rpcId":"request-1","content":[]}]}}""")
    assertTrue(overlayPromptReceiptObserved(200, body, "request-1", "session/state"))
    assertFalse(overlayPromptReceiptObserved(200, body, "request-2", "session/state"))
    assertFalse(overlayPromptReceiptObserved(200, body, "", "session/state"))
    assertFalse(overlayPromptReceiptObserved(-1, body, "request-1", "session/state"))
  }

  @Test fun durableReceiptRequiresUserMessageAndExactUserSourceRpcId() {
    val body = wire("""{"ok":true,"value":{"records":[{"type":"event","event":{"type":"user/message","data":{"source":{"kind":"user","rpcId":"request-1"},"content":[]}}}],"hasMore":false,"cursor":17}}""")
    assertTrue(overlayPromptReceiptObserved(200, body, "request-1", "session/events"))
    assertFalse(overlayPromptReceiptObserved(200, body, "request-10", "session/events"))
    assertFalse(overlayPromptReceiptObserved(200, body.replace("user/message", "assistant/message"), "request-1", "session/events"))
    assertFalse(overlayPromptReceiptObserved(200, body.replace("\"kind\":\"user\"", "\"kind\":\"system\""), "request-1", "session/events"))
  }

  @Test fun missingReceiptDoesNotInventEvidenceFromRunningOrUnrelatedIds() {
    for (value in listOf(
      """{"running":true,"queue":null}""",
      """{"running":true,"queue":[]}""",
      """{"queue":[{"id":"request-1"}]}""",
      """{"records":[],"hasMore":true,"cursor":100}""",
    )) assertFalse(overlayPromptReceiptObserved(200, wire("""{"ok":true,"value":$value}"""), "request-1", "session/state"))
    assertFalse(overlayPromptReceiptObserved(200, wire("""{"ok":false,"value":{"queue":[{"rpcId":"request-1"}]},"error":{"code":"internal","message":"bad"}}"""), "request-1", "session/state"))
  }

  @Test fun senderUnknownBranchDoesNotSettleOrMarkBusyAndRetainsThreeFailureGuards() {
    val send = member("internal fun sendTextFromOverlay(")
    assertEquals(3, Regex("""restoreAfterFailure[(]""").findAll(send).count())
    assertEquals(1, Regex("""System[.]currentTimeMillis[(][)]""").findAll(send).count())
    val unknown = member("private fun reportTextSendUnknown(")
    assertTrue(unknown.contains("pending.unknown = true"))
    assertTrue(unknown.contains("pending.onUnknown?.invoke(message)"))
    assertFalse(unknown.contains("finishTextSend("))
    assertFalse(unknown.contains("markBusyOptimistic("))
    assertFalse(unknown.contains("setText("))
    assertTrue(send.contains("activeSessionId == targetSessionId && panel.inputBox?.text?.toString()?.trim() == text"))
  }

  @Test fun recheckOnlyReadsSameSessionAndIsBoundedWithoutResubmission() {
    val recheck = member("internal fun recheckTextSendOutcome(")
    assertTrue(recheck.contains("pending.rechecking"))
    assertTrue(recheck.contains("postRpc(" + 34.toChar() + "session/state" + 34.toChar()))
    assertTrue(recheck.contains("postRpc(" + 34.toChar() + "session/events" + 34.toChar()))
    assertTrue(recheck.contains(""".put("sessionId", pending.sessionId)"""))
    assertTrue(recheck.contains(""".put("maxMessages", 100)"""))
    assertTrue(recheck.contains("pending.requestId"))
    assertFalse(recheck.contains("postRpc(" + 34.toChar() + "session/prompt" + 34.toChar()))
    assertFalse(recheck.contains("postRpc(" + 34.toChar() + "session/create" + 34.toChar()))
    assertFalse(recheck.contains("while ("))
    assertFalse(recheck.contains("finishTextSend(pending, false)"))
  }

  @Test fun rollbackDraftMergeDoesNotResurrectUnchangedSentTextOrOverwriteNewDraft() {
    assertFalse(shouldImportLegacyOverlayDraft("", "sent text", "sent text"))
    assertTrue(shouldImportLegacyOverlayDraft("", "new text", "sent text"))
    assertTrue(shouldImportLegacyOverlayDraft("old text", "edited in legacy", "old text"))
    assertFalse(shouldImportLegacyOverlayDraft("edited in v2", "edited in legacy", "old text"))
    assertTrue(shouldImportLegacyOverlayDraft("", "first draft", null))
    assertFalse(shouldImportLegacyOverlayDraft("v2 draft", "legacy draft", null))
  }

  @Test fun rollbackUsesTheSameV2AndLanguagePreferenceListenerCoversAllEntrypoints() {
    val switch = member("private fun switchOverlayUi(")
    assertTrue(switch.contains("v2?.suspendUi()"))
    assertTrue(switch.contains("val existing = cachedV2"))
    assertTrue(switch.contains("overlay.resumeUi()"))
    assertFalse(switch.contains(".destroy()"))
    assertFalse(switch.contains("cancelPendingActions"))
    assertTrue(switch.contains("overlay.restoreDraftSnapshot(current.copy("))
    assertTrue(switch.contains("legacyDrafts[activeSessionId]"))
    val code = source()
    assertTrue(code.contains("getSharedPreferences(AppLanguage.PREFS, Context.MODE_PRIVATE)"))
    assertTrue(code.contains("key == AppLanguage.KEY_MODE"))
    assertTrue(code.contains("cachedV2?.onLanguageChanged()"))
    assertTrue(member("override fun onDestroy(").contains("languagePrefs.unregisterOnSharedPreferenceChangeListener(languageListener)"))
  }

  @Test fun destroyReleasesPendingCallbacksAndLateRpcCannotTouchUi() {
    val destroy = member("override fun onDestroy(")
    assertTrue(destroy.contains("rpcLifecycleClosed = true"))
    assertTrue(destroy.contains("pendingTextSend?.releaseCallbacks()"))
    assertTrue(destroy.contains("pendingTextSend = null"))
    assertTrue(member("internal fun postRpc(").contains("if (!rpcLifecycleClosed) onResult(code, body)"))
  }
}
