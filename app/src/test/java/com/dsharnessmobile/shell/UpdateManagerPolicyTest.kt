package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 在线更新入口的准入判据（审查 §5.10 / S-10）。
 *
 * 缺陷形态：默认 manifest 地址是 `http://10.0.2.2:8899/manifest.json`（**模拟器别名**）且全仓
 * 没有生产覆盖点 ⇒ 真机上只能得到「连接超时」，而文档仍把它当可用能力写；同时留下一条明文 HTTP
 * + 同信道 sha256 的更新路径（完整性基准与载荷同源，对主动 MITM 零效力）。
 *
 * 0.14.1 裁定：**显式下线**（默认关闭），需要本地联调时用显式覆盖打开，且明文只允许回环/模拟器别名。
 */
class UpdateManagerPolicyTest {

  @Test
  fun onlineUpdateIsDisabledByDefault() {
    assertEquals("生产默认必须是「未启用」（不再指向模拟器别名）", "", UpdateManager.DEFAULT_MANIFEST_URL)
    val verdict = UpdateManager.validateManifestUrl("")
    assertEquals("", verdict.accepted)
    assertNull(verdict.refusal)
    assertNull("null 同样等价于关闭", UpdateManager.validateManifestUrl(null).refusal)
  }

  @Test
  fun plainHttpIsOnlyAllowedForLoopbackAndTheEmulatorAlias() {
    assertNull(UpdateManager.validateManifestUrl("http://10.0.2.2:8899/manifest.json").refusal)
    assertNull(UpdateManager.validateManifestUrl("http://127.0.0.1:8899/manifest.json").refusal)
    assertNull(UpdateManager.validateManifestUrl("https://updates.example.com/manifest.json").refusal)
    val refusal = UpdateManager.validateManifestUrl("http://updates.example.com/manifest.json").refusal
    assertTrue("非回环的明文 http 必须拒（否则「完整性与载荷同源」的旧问题原样回来）",
      refusal != null && refusal.contains("明文 http"))
  }

  @Test
  fun nonHttpSchemesAreRefused() {
    for (bad in listOf("file:///sdcard/manifest.json", "content://x/manifest.json")) {
      val refusal = UpdateManager.validateManifestUrl(bad).refusal
      assertTrue("必须拒非 http(s) 地址：$bad", refusal != null)
    }
  }

  @Test
  fun acceptedUrlIsReturnedVerbatim() {
    val verdict = UpdateManager.validateManifestUrl("  https://updates.example.com/m.json  ")
    assertEquals("https://updates.example.com/m.json", verdict.accepted)
  }

  @Test
  fun updateEntryPointsShareAnInFlightGateAndReleaseItForRetry() {
    val flow = java.io.File("src/main/java/com/dsharnessmobile/shell/EngineStartFlow.kt").let {
      (if (it.isFile) it else java.io.File("app/src/main/java/com/dsharnessmobile/shell/EngineStartFlow.kt")).readText()
    }
    assertTrue(flow.substringAfter("fun startUpdateCheck()").substringBefore("fun shutdownToGuide()")
      .contains("OnlineUpdateGate.begin()"))
    assertTrue(flow.substringAfter("fun runUpdate()").substringBefore("fun startEngineService()")
      .contains("OnlineUpdateGate.begin()"))
    OnlineUpdateGate.end()
    assertTrue(OnlineUpdateGate.begin())
    try {
      assertFalse("ACTION_UPDATE and the button share one process gate", OnlineUpdateGate.begin())
    } finally {
      OnlineUpdateGate.end()
    }
    assertTrue("terminal cleanup allows a later retry", OnlineUpdateGate.begin())
    OnlineUpdateGate.end()
  }

  @Test
  fun onlineDoneRequiresCommittedMarkerAndIdentityToBeSettled() {
    val expected = "a".repeat(64)
    val base = "b".repeat(64)
    val prior = "c".repeat(64)
    fun classify(marker: Boolean, pending: Boolean, live: String, onlineBase: String, onlineArchive: String) =
      UpdateManager.OnlineSettlement.classify(marker, pending, live, onlineBase, onlineArchive, expected, base, prior)

    assertEquals(UpdateManager.OnlineSettlement.State.PENDING,
      classify(true, true, expected, base, expected))
    assertEquals(UpdateManager.OnlineSettlement.State.PENDING,
      classify(false, true, expected, base, expected))
    assertEquals(UpdateManager.OnlineSettlement.State.COMMITTED,
      classify(false, false, expected, base, expected))
    assertEquals("embedded base mismatch cannot report Done", UpdateManager.OnlineSettlement.State.INCONSISTENT,
      classify(false, false, expected, prior, expected))
    assertEquals("restored prior fingerprint is a rollback outcome", UpdateManager.OnlineSettlement.State.ROLLED_BACK,
      classify(false, false, prior, base, expected))
    assertEquals(UpdateManager.OnlineSettlement.State.INCONSISTENT,
      classify(false, false, "", "", ""))
    assertEquals("same-archive fingerprint with missing identity is not proof of rollback",
      UpdateManager.OnlineSettlement.State.INCONSISTENT,
      UpdateManager.OnlineSettlement.classify(false, false, expected, "", "", expected, base, expected))
  }

  @Test
  fun updateReportsVerificationBeforeDoneAndUsesCandidateHardHealth() {
    val update = java.io.File("src/main/java/com/dsharnessmobile/shell/UpdateManager.kt").let {
      (if (it.isFile) it else java.io.File("app/src/main/java/com/dsharnessmobile/shell/UpdateManager.kt")).readText()
    }
    val manager = java.io.File("src/main/java/com/dsharnessmobile/shell/EngineManager.kt").let {
      (if (it.isFile) it else java.io.File("app/src/main/java/com/dsharnessmobile/shell/EngineManager.kt")).readText()
    }
    assertTrue(update.indexOf("UpdateOutcome.Verifying") < update.indexOf("awaitOnlineSettlement(expectedSha"))
    assertTrue("Done is emitted only after committed settlement", update.contains("State.COMMITTED -> return UpdateStatus(UpdateOutcome.Done"))
    val flow = java.io.File("src/main/java/com/dsharnessmobile/shell/EngineStartFlow.kt").let {
      (if (it.isFile) it else java.io.File("app/src/main/java/com/dsharnessmobile/shell/EngineStartFlow.kt")).readText()
    }
    assertEquals("both UI entry points discard callbacks from replaced/destroyed Activities", 2,
      Regex("updateGeneration != updateUiGeneration").findAll(flow).count())
    assertTrue("Verifying stays nonterminal and keeps the update button disabled",
      flow.contains("st.outcome != UpdateManager.UpdateOutcome.Working && st.outcome != UpdateManager.UpdateOutcome.Verifying"))
    assertTrue("online three-tick commit must use the candidate Hard manifest and the shared read-only health probe",
      manager.contains("PluginMounts.ensureHard(context, marker.fingerprint)") &&
        manager.contains("EngineProbe.completeSoftHealth(context, hard)"))
  }

  @Test
  fun factoryAndOnlineTransactionsUseOneAtomicAdmissionLock() {
    val manager = java.io.File("src/main/java/com/dsharnessmobile/shell/EngineManager.kt").let {
      (if (it.isFile) it else java.io.File("app/src/main/java/com/dsharnessmobile/shell/EngineManager.kt")).readText()
    }
    val update = java.io.File("src/main/java/com/dsharnessmobile/shell/UpdateManager.kt").let {
      (if (it.isFile) it else java.io.File("app/src/main/java/com/dsharnessmobile/shell/UpdateManager.kt")).readText()
    }
    assertTrue(manager.contains("private fun beginSnapshotTransaction(): Boolean = synchronized(EngineManager.transactionStateLock)"))
    assertTrue(manager.contains("internal fun beginOnlineUpdateTransaction(): Boolean = synchronized(EngineManager.transactionStateLock)"))
    assertTrue("both transaction entry paths must call the tested shared admission policy",
      manager.contains("SnapshotTransaction.canBeginFactoryTransaction") &&
        manager.contains("SnapshotTransaction.canBeginOnlineTransaction"))
    assertTrue(update.contains("manager.beginOnlineUpdateTransaction()"))
    assertTrue("unowned shared stage residue must block online admission", manager.contains("stageResiduePresent = SnapshotFs.exists(SnapshotTransaction.stageRoot(context.filesDir))"))
    assertTrue("recovery must not clean shared stage while the online probation owns it",
      manager.contains("if (onlineUpdateActive.get()) return"))
  }

  @Test
  fun updateFailureCleanupRemovesArchiveAndOnlyRemovesStageWithoutJournal() {
    val update = java.io.File("src/main/java/com/dsharnessmobile/shell/UpdateManager.kt").let {
      (if (it.isFile) it else java.io.File("app/src/main/java/com/dsharnessmobile/shell/UpdateManager.kt")).readText()
    }
    val cleanup = update.substringAfter("} finally {")
    assertTrue(cleanup.contains("SnapshotFs.deletePath(archive)"))
    assertFalse("legacy stage may be user-owned and is not recursively deleted", update.contains("legacyStage"))
    assertTrue(cleanup.contains("if (ownsTransactionStage && SnapshotTransaction.readMarker(context.filesDir) == null) SnapshotFs.deletePath(stage)"))
    assertTrue(update.contains("UUID.randomUUID()"))
    assertTrue(cleanup.contains("OnlineUpdateGate.end()"))
    assertFalse("legacy usr-old must never be deleted to start a new transaction", update.contains("SnapshotFs.deletePath(old)"))
  }

  @Test
  fun preflightAndPreExtractChecksIncludeDownloadAndUnpackedBudgets() {
    val dlReq = UpdateManager.preDownloadRequiredBytes(100L * 1024L * 1024L)
    assertTrue("pre-download must cover archive + 5x unpack + 64 MiB slack", dlReq >= 664L * 1024L * 1024L)
    val tmp = java.nio.file.Files.createTempFile("upd-preflight", ".tar.xz").toFile()
    try {
      tmp.writeBytes(ByteArray(1024))
      val extReq = UpdateManager.preExtractRequiredBytes(tmp, 200L * 1024L * 1024L)
      assertEquals(264L * 1024L * 1024L, extReq)
    } finally {
      tmp.delete()
    }
    val engine = java.io.File("src/main/java/com/dsharnessmobile/shell/EngineManager.kt").let {
      (if (it.isFile) it else java.io.File("app/src/main/java/com/dsharnessmobile/shell/EngineManager.kt")).readText()
    }
    assertTrue(
      "EngineManager must run preExtractionRequiredBytes + insufficientSpaceReason before extractAndValidate",
      engine.indexOf("preExtractionRequiredBytes") in 1 until engine.indexOf("SnapshotRefreshStage.extractAndValidate("),
    )
  }
}
