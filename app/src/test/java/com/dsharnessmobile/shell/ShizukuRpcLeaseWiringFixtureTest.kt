package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Structural SOURCE fixtures only; these do not pretend to exercise Binder or persisted Android prefs. */
class ShizukuRpcLeaseWiringFixtureTest {
  private fun source(): String {
    val suffix = "app/src/main/java/com/dsharnessmobile/shell/ShizukuTransport.kt"
    val file = listOf(File(suffix), File("dsh-mobile-apk/$suffix"),
      File("src/main/java/com/dsharnessmobile/shell/ShizukuTransport.kt")).firstOrNull { it.isFile }
      ?: error("owned transport source unavailable")
    return file.readText()
  }

  private fun body(name: String): String = source().substringAfter("  private fun $name(")
    .substringBefore("\n  /**")

  @Test fun everyTransferRpcHasAFreshDispatchPointGateInsideItsLoop() {
    val pull = body("pullFileInternal")
    val push = body("pushFileInternal")
    assertTrue(pull.indexOf("java.io.FileOutputStream(target)") < pull.indexOf("lease.beforeRpc(remoteSvc)"))
    assertTrue(pull.indexOf("while (true)") < pull.indexOf("lease.beforeRpc(remoteSvc)"))
    assertTrue(Regex("""lease\.beforeRpc\(remoteSvc\)\?\.let \{ return transferFacts\(it, offset\) }\s+val chunk = remoteSvc\.readChunk""")
      .containsMatchIn(pull))
    assertTrue(push.indexOf("input.read(buf)") < push.indexOf("lease.beforeRpc(remoteSvc)"))
    assertTrue(push.indexOf("val slice =") < push.indexOf("lease.beforeRpc(remoteSvc)"))
    assertTrue(Regex("""lease\.beforeRpc\(remoteSvc\)\?\.let \{ return transferFacts\(it, offset\) }\s+val reply = remoteSvc\.writeChunk""")
      .containsMatchIn(push))
    assertTrue(pull.contains("lease.acknowledged()"))
    assertTrue(push.contains("lease.acknowledged()"))
    assertTrue(pull.contains("transferFacts(lease.failed(failure), offset)"))
    assertTrue(push.contains("transferFacts(lease.failed(failure), offset)"))
    assertFalse(pull.contains("RootAccess."))
    assertFalse(push.contains("RootAccess."))
  }

  @Test fun leaseBeginsOnlyForActualRootAndConsentIsRecheckedAfterPersistence() {
    val lease = source().substringAfter("    fun beforeRpc(").substringBefore("    fun acknowledged()")
    assertTrue(lease.contains("dispatchIdentity(context, remote, applyGate)"))
    assertTrue(lease.contains("if (uid == 0 && !leased)"))
    val begin = lease.indexOf("RootMaintenanceLease.beginOperation(context, operation)")
    assertTrue(begin >= 0)
    assertTrue(lease.indexOf("dispatchIdentity(context, remote, applyGate)", begin) > begin)
    assertTrue(lease.indexOf("inFlight = true") > begin)
    val identity = source().substringAfter("  private fun dispatchIdentity(").substringBefore("  /** One lease")
    assertTrue(identity.contains("remote.uid()"))
    assertTrue(identity.contains("RootGrant.isGranted(context)"))
    assertTrue(identity.contains("uid != 0 && uid != 2000"))
  }

  @Test fun executionGatesAreAfterArgvSetupAndImmediatelyBeforeRpc() {
    val controller = body("runControllerInternal")
    // runController 也有原生诊断用的 authorize 复核：只允许它在 beforeRpc 之后、exec 之前，
    // 且拒绝必须当场结算成 executed=no（不能先跑一次再说没执行）。
    assertTrue(Regex("""lease\.beforeRpc\(remote\)\?\.let \{ return it\.put\("executed", "no"\) }""")
      .containsMatchIn(controller))
    val gate = controller.indexOf("if (authorize != null && !authorize())")
    val exec = controller.indexOf("val reply = remote.exec(")
    assertTrue("authorize 复核必须在 beforeRpc 之后", gate > controller.indexOf("lease.beforeRpc(remote)"))
    assertTrue("authorize 复核必须在真正 exec 之前", exec > gate)
    assertTrue(Regex("""return lease\.complete\(JSONObject\(\)\.put\("ok", false\)\.put\("code", "authorize-denied"\)\.put\("executed", "no"\)\)""")
      .containsMatchIn(controller))
    val shell = body("runShellInternal")
    assertTrue(shell.indexOf("val argv =") < shell.indexOf("lease.beforeRpc(remote)"))
    // 原生诊断面在 RPC 前多一道 authorize 复核（紧贴派发、拒绝即零副作用）；它必须仍在
    // beforeRpc 之后、真正 exec 之前，否则「拒绝」会变成「先跑再报拒绝」。
    assertTrue(Regex("""lease\.beforeRpc\(remote\)\?\.let \{ return it }\s+if \(authorize != null && !authorize\(\)\)""")
      .containsMatchIn(shell))
    assertTrue(Regex("""lease\.acknowledged\(\)\s+return lease\.complete\(JSONObject\(\)\.put\("ok", false\)\.put\("code", "authorize-denied"\)""")
      .containsMatchIn(shell))
    assertTrue(Regex("""val reply = if \(capture\) remote\.execCapture\(argv, timeout, 8 \* 1024\) else remote\.exec\(argv, timeout\)""")
      .containsMatchIn(shell))
  }

  @Test fun unknownRpcCannotFinishLeaseAndAllFencesReceiveContext() {
    val text = source()
    assertTrue(text.contains("val result = if (!definitive || inFlight) unknown"))
    assertTrue(text.contains("RootMaintenanceLease.markUnknown(context, reason)"))
    assertTrue(text.contains("RootMaintenanceLease.finish(context, leaseOperationId)"))
    assertTrue(text.contains("leaseOperationId = begun.first ?: return"))
    assertTrue(text.contains("definitive = !inFlight"))
    assertTrue(text.contains(".put(\"offsetFact\", \"acknowledged-bytes\")"))
    assertTrue(text.contains(".put(\"noReplay\", true)"))
    assertFalse(Regex("""RootExecutionFence\.(?:command|maintenance)\s*\{""").containsMatchIn(text))
    val repair = text.substringAfter("  fun repairOwnership(").substringBefore("  /** Bounded deep walk")
    assertTrue(repair.contains("lease.beforeRpc(remote)"))
    // 信封完整即结算：部分修复/超预算 finish 租约并如实回 repair-incomplete；只有信封缺失才是 UNKNOWN。
    assertTrue(repair.contains("val envelopeComplete = result.opt(\"ok\") is Boolean"))
    assertTrue(repair.contains("lease.complete(result, definitive = false)"))
    assertTrue(repair.contains("lease.complete(settled, definitive = true)"))
    assertFalse(repair.contains("definitive = verified"))
    assertTrue(repair.contains("result.optInt(\"unverifiedMutations\", -1) == 0"))
    assertTrue(repair.contains("result.optInt(\"remaining\", -1) == 0"))
  }
}
