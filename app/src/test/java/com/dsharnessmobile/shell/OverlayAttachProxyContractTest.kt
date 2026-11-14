package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OverlayAttachProxyContractTest {
  private fun source(name: String): String {
    val candidates = listOf(File("src/main/$name"), File("app/src/main/$name"))
    return candidates.first { it.isFile }.readText()
  }

  @Test fun proxyWaitsForActualResultAndRestoresWithoutLaunchingTwice() {
    val manifest = source("AndroidManifest.xml").substringAfter("""android:name=".OverlayAttachProxyActivity"""").substringBefore("/>")
    assertFalse(manifest.contains("noHistory"))
    val code = source("java/com/dsharnessmobile/shell/OverlayAttachProxyActivity.kt")
    assertTrue(code.contains("if (savedInstanceState != null)"))
    assertTrue(code.contains("""getString("raw")"""))
    assertTrue(code.contains("""getString("target")"""))
    assertTrue(code.contains("processTargetedIncomingPath(this, staged, sessionId, requestId"))
    assertTrue(code.contains("OverlayPageHost.pollIncoming(requestId)"))
    assertTrue(code.contains(""""draft-ready" ->"""))
  }

  @Test fun pickerMimeUsesResolverEvidenceNotExtensionGuesses() {
    assertEquals("image/png", overlayAttachmentMediaType("file", "image/png"))
    assertEquals("image/heic", overlayAttachmentMediaType("photo", "image/heic"))
    assertEquals("image/avif", overlayAttachmentMediaType("photo", "image/avif"))
    assertEquals("application/octet-stream", overlayAttachmentMediaType("photo", null))
    assertEquals("application/octet-stream", overlayAttachmentMediaType("file", "image/*"))
    assertEquals("image/jpeg", overlayAttachmentMediaType("camera", null))
    val code = source("java/com/dsharnessmobile/shell/OverlayAttachProxyActivity.kt")
    assertTrue(code.contains("contentResolver.getType(uri)"))
    assertTrue(code.contains("pickedMediaType = savedInstanceState"))
    assertFalse(code.contains("staged.extension.lowercase()"))
  }

  @Test fun delayedAttachmentAdmissionIsPendingAndRecheckedUnderOriginalIdentity() {
    val code = source("java/com/dsharnessmobile/shell/OverlayAttachProxyActivity.kt")
    assertTrue(code.contains("if (remaining <= 0) { pendingResult(); return }"))
    assertTrue(code.contains("val sessionId: String, val requestId: String"))
    assertTrue(code.contains("existing(sessionId, kind) != null"))
    assertTrue(code.contains("OverlayAttachmentBus.recheckPending(sessionId); return"))
    assertTrue(code.contains("requests.size >= 64"))
    assertTrue(code.contains("requests.remove(requestId)"))
    val pending = code.substringAfter("private fun pendingResult()").substringBefore("private fun fail")
    assertTrue(pending.contains("attachment-pending"))
    assertTrue(pending.contains("sessionId, requestId"))
    assertFalse(pending.contains("attachment-not-ready"))
  }

  @Test fun onlyHostEvaluatorMayRunInBackgroundAndUsesActualDocumentReadiness() {
    val code = source("java/com/dsharnessmobile/shell/MainActivity.kt")
    val evaluator = code.substringAfter("OverlayPageHost.evaluator =").substringBefore("// 本体回到前台")
    assertTrue(evaluator.contains("if (overlayPageReady)"))
    assertFalse(evaluator.contains("pageUiActive"))
    assertTrue(code.contains("pageRecovery.foreground && !pageRecovery.rendererGone"))
    assertTrue(code.contains("OverlayPageHost.readiness = { overlayPageReady }"))
    assertTrue(code.contains("overlayDocumentReady = false"))
    assertTrue(code.contains("overlayDocumentReady = true"))
  }
}
