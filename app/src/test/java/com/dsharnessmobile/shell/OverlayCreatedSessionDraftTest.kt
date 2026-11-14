package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** Source wiring + real snapshot value semantics; not an Android/RPC/device execution claim. */
class OverlayCreatedSessionDraftTest {
  private fun source(name: String) = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).first { it.isFile }.readText()

  private fun section(text: String, start: String, end: String): String {
    assertTrue("missing " + start, text.contains(start))
    val tail = text.substringAfter(start)
    assertTrue("missing " + end, tail.contains(end))
    return tail.substringBefore(end).replace(Regex("""//[^\r\n]*"""), "")
  }

  private fun assertCreatedDraftContract(v2: String, service: String) {
    val send = section(v2, "  private fun sendText(", "  private var attachmentInteraction:")
    val migration = send.substringAfter("}, { created ->").substringBefore("    })")
    assertTrue("creation callback must exist", send.contains("}, { created ->"))
    val migrationGuard = migration.substringBefore("createdDraftMigration =")
    for (guard in listOf("!destroyed", "sentSession.isEmpty()", "svc.activeSessionId.isEmpty()", "sessionGeneration == sentGeneration"))
      assertTrue("creation may only migrate the same in-flight blank-target draft: " + guard, migrationGuard.contains(guard))
    assertTrue(migration.contains("createdDraftMigration = exportDraftSnapshot().copy(sessionId = created)"))
    assertTrue(migration.contains("admittedSession = created"))
    assertTrue(migration.contains("admittedGeneration = sentGeneration + 1"))
    val settled = send.substringAfter("val settled: (Boolean) -> Unit = { ok ->").substringBefore("if (attachments.isNotEmpty())")
    val clearGuard = settled.substringBefore("composer?.setInputText(\"\")")
    assertTrue("must inspect actual draft clear", settled.contains("composer?.setInputText(\"\")"))
    for (guard in listOf("!destroyed", "ok", "svc.activeSessionId == admittedSession", "sessionGeneration == admittedGeneration", "composer?.inputText() == sentDraft"))
      assertTrue("reject/late reply cannot clear edited or other-session draft: " + guard, clearGuard.contains(guard))
    val changed = section(v2, "  internal fun onSessionChanged()", "  internal fun onDataChanged()")
    assertTrue(changed.contains("sessionDrafts[previousSession] = previousDraft.copy(sessionId = previousSession)"))
    assertTrue(changed.contains("createdDraftMigration?.takeIf { it.sessionId == svc.activeSessionId }"))
    assertTrue(changed.contains("createdDraftMigration = null"))
    assertTrue(changed.contains("val restoredDraft = migrated ?: sessionDrafts[svc.activeSessionId]"))
    assertTrue(changed.contains("if (restoredDraft != null) restoreDraftSnapshot(restoredDraft)"))
    assertTrue("draft/selection is restored before observers can accept the new generation",
      changed.indexOf("restoreDraftSnapshot(restoredDraft)") < changed.indexOf("sessionGeneration++"))
    val restore = section(v2, "  internal fun restoreDraftSnapshot(", "  internal fun suspendUi()")
    assertTrue(restore.contains("snapshot.matchesSession(svc.activeSessionId)"))
    assertTrue(restore.contains("c.setInputText(snapshot.text)"))
    assertTrue(restore.contains("val selection = snapshot.selection()"))
    assertTrue(restore.contains("input?.setSelection(selection.first, selection.second)"))
    val serviceSend = section(service, "  internal fun sendTextFromOverlay(", "  internal fun recheckTextSendOutcome()")
    val create = serviceSend.substringAfter("postRpc(\"session/create\"").substringBefore("    } else {\n      send.run()")
    assertTrue(create.contains("targetSessionId = sid"))
    val adopt = create.substringAfter("if (activeSessionId == initialTarget) {").substringBefore("            }")
    assertTrue("user-selected B cannot be overwritten by late creation", create.contains("if (activeSessionId == initialTarget) {"))
    val notify = adopt.indexOf("onCreated?.invoke(sid)")
    assertTrue("migrate before active sid mutation", notify in 0 until adopt.indexOf("activeSessionId = sid"))
    assertTrue("migrate before target observers save/replace the editor", notify in 0 until adopt.indexOf("onTargetSessionChanged(sid)"))
    assertTrue("send still targets own created A, not the user's later B", serviceSend.contains(".put(\"sessionId\", payloadSessionId(targetSessionId))"))
    val prompt = section(serviceSend, "postRpc(\"session/prompt\"", "    if (payloadSessionId(activeSessionId).isEmpty())")
    assertTrue(prompt.contains("reportTextSendUnknown(pending)"))
    assertTrue(prompt.contains("finishTextSend(pending, false)"))
    val unknown = prompt.substringAfter("reply.state == OverlayRpcAdmissionState.UNKNOWN").substringBefore("        } else {")
    assertFalse("unknown must not settle as rejection/acceptance or release pending lock", unknown.contains("finishTextSend("))
    assertFalse("unknown must never clear or restore over the current editor", unknown.contains("setInputText("))
  }

  @Test fun ownCreateMigratesBeforeSessionObserversAndRejectOrUnknownKeepsDraftAndOtherSessionSelection() {
    assertCreatedDraftContract(source("OverlayV2.kt"), source("OverlayService.kt"))
  }

  @Test fun snapshotMigrationAndSessionRoundTripPreserveTextSelectionAndUnknownLocks() {
    val original = OverlayV2DraftSnapshot("", "prefix 草稿 suffix", true, true, 7, 9, true, true)
    val created = original.copy(sessionId = "created-a")
    val selectedB = OverlayV2DraftSnapshot("user-b", "independent B", true, false, 2, 8, false, false)
    assertEquals(original.text, created.text)
    assertEquals(7 to 9, created.selection())
    assertTrue(created.sendPending)
    assertTrue(created.commandPending)
    assertTrue(created.matchesSession("created-a"))
    assertFalse("migration snapshot cannot be restored over user B", created.matchesSession(selectedB.sessionId))
    val returned = created.copy(sessionId = created.sessionId)
    assertEquals(created, returned)
    assertEquals(7 to 9, returned.selection())
    assertEquals(2 to 8, selectedB.selection())
    assertEquals("independent B", selectedB.text)
  }

  @Test fun controlledNegativesRejectLateCreateRetargetingLostSelectionAndRejectedSendClear() {
    val v2 = source("OverlayV2.kt")
    val service = source("OverlayService.kt")
    assertCreatedDraftContract(v2, service)
    for ((old, replacement) in listOf(
      " && svc.activeSessionId.isEmpty()" to "",
      " && sessionGeneration == sentGeneration" to "",
      " && ok &&" to " &&",
      " && svc.activeSessionId == admittedSession" to "",
      " && composer?.inputText() == sentDraft" to "",
      "input?.setSelection(selection.first, selection.second)" to "Unit",
      "createdDraftMigration?.takeIf { it.sessionId == svc.activeSessionId }" to "createdDraftMigration",
    )) {
      val mutated = v2.replace(old, replacement)
      assertNotEquals("negative must alter actual migration code: " + old, v2, mutated)
      var rejected = false
      try { assertCreatedDraftContract(mutated, service) } catch (_: AssertionError) { rejected = true }
      assertTrue("must reject draft overwrite/loss: " + old, rejected)
    }
    val moved = service.replace("onCreated?.invoke(sid)", "Unit")
    assertNotEquals(service, moved)
    var rejected = false
    try { assertCreatedDraftContract(v2, moved) } catch (_: AssertionError) { rejected = true }
    assertTrue("removing early owner notification must fail", rejected)
  }
}
