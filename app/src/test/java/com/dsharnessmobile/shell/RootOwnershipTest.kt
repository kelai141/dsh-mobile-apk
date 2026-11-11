package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Wiring guards only; OwnershipRepairCoreTest exercises the injected walker behavior. */
class RootOwnershipTest {
  private fun source(rel: String): String = listOf(File("src/main/$rel"), File("app/src/main/$rel"))
    .firstOrNull { it.isFile }?.readText() ?: throw AssertionError("找不到 $rel")
  private fun kotlin(name: String) = source("java/com/dsharnessmobile/shell/$name.kt")

  @Test fun `protocol v4 appends acknowledged configuration without renumbering`() {
    val aidl = source("aidl/com/dsharnessmobile/shell/ShizukuUserService.aidl")
    assertTrue(aidl.contains("void configure(int appUid, String appDataDir)"))
    assertTrue(aidl.contains("Bundle repairOwnership(in String path, int maxEntries)"))
    assertTrue(aidl.contains("Bundle configuration() = 10"))
    assertTrue(kotlin("ShizukuUserService").contains("PROTOCOL_VERSION = 4"))
    val transport = kotlin("ShizukuTransport")
    assertTrue(transport.contains("val ack = remote.configuration()"))
    assertTrue(transport.contains("if (valid) configuredForAge = age"))
  }

  @Test fun `service configuration binds full calling UID and trusted anchor`() {
    val service = kotlin("ShizukuUserService")
    assertTrue(service.contains("Binder.getCallingUid() != appUid"))
    assertTrue(service.contains("OwnershipRepair.isTrustedAppDataAnchor(appDataDir, appUid)"))
    assertTrue(service.contains("OwnershipRepair.repair(appDataDir, path, appUid"))
    assertTrue(service.contains("not-configured"))
    assertTrue(service.contains("repairAfterWrite(file)"))
  }

  @Test fun `repair pins metadata and mutates only held ordinary inodes`() {
    val adapter = kotlin("OwnershipRepair")
    assertTrue(adapter.contains("0x200000 or OsConstants.O_NOFOLLOW"))
    assertTrue(adapter.contains("Os.fstat"))
    assertTrue(adapter.contains("Os.fchown((handle as AndroidHandle).fd, uid, gid)"))
    // 内核硬链接保护不是本原语的安全前提（逐条 linkCount == 1 已覆盖），因此这里守的是
    // 「不要再用整体拒绝把它关掉」，以及探测结果必须出现在结果里（诊断可见）。
    assertFalse(adapter.contains("rejected(\"hardlink-protection-unavailable\")"))
    assertTrue(adapter.contains(""""hardlinkProtection" to protectedHardlinksEnabled()"""))
    assertTrue(adapter.contains("pinned-inode-changed"))
    assertFalse(adapter.contains("Os.lchown("))
    assertFalse(adapter.contains("Os.chown("))
    assertTrue(adapter.contains(""""selinuxRelabeled" to false"""))
  }

  @Test fun `startup repair walks deeply within the shared single flight`() {
    val transport = kotlin("ShizukuTransport")
    assertTrue(transport.contains("RootOwnershipJobs.runBlocking(context)"))
    assertTrue(transport.contains("no-root-path"))
    assertTrue(transport.contains("OwnershipRepairCore.MAX_ENTRIES, 20_000L"))
    assertFalse(transport.contains("owner == 0"))
    val jobs = kotlin("RootOwnershipJobs")
    assertTrue(jobs.contains("if (running) return false"))
    assertTrue(jobs.contains("wait.await(30, TimeUnit.SECONDS)"))
    assertTrue(jobs.contains("repair-result-unknown"))
    val bridge = kotlin("AndroidBridge")
    assertTrue(bridge.contains("RootOwnershipJobs.request(app)"))
    assertTrue(kotlin("RootGrant").contains("RootOwnershipJobs.state(context)"))
  }

  @Test fun `preboot repair precedes transaction recovery and fresh decision`() {
    val flow = kotlin("EngineStartFlow")
    val heal = flow.indexOf("prepareStartupOwnership")
    assertTrue(heal >= 0)
    assertTrue(heal < flow.indexOf("snapshotFresh()"))
    assertTrue(heal < flow.indexOf("recoverInterruptedRefresh()"))
    val guide = kotlin("GuidePageRenderer")
    assertTrue(guide.contains("autoRepairOwnershipOnFailure()"))
    assertTrue(guide.contains("ownershipRepairRunning"))
    assertTrue(guide.contains("已自动修复"))
  }

  @Test fun `trusted anchor keeps full work-profile UID`() {
    assertTrue(OwnershipRepair.isTrustedAppDataAnchor("/data/user/10/com.dsharnessmobile.shell", 1_010_241))
    assertFalse(OwnershipRepair.isTrustedAppDataAnchor("/data/user/0/com.dsharnessmobile.shell", 1_010_241))
    assertFalse(OwnershipRepair.isTrustedAppDataAnchor("/data/user/10/another.package", 1_010_241))
  }

  @Test fun `helper rejects path escapes and non-positional arguments`() {
    val good = arrayOf("10241", "/data/user/0/com.dsharnessmobile.shell", "files", "100", "20000")
    assertEquals("files", RootRepairMain.parse(good)?.relativeTarget)
    for (path in listOf("../outside", "/outside", "files/../outside", "files//leaf", ".")) {
      assertNull(path, RootRepairMain.parse(good.copyOf().also { it[2] = path }))
    }
    assertNull(RootRepairMain.parse(good + "extra"))
  }

  @Test fun `helper rejects unbounded caps deadlines and numeric ambiguity`() {
    val good = arrayOf("10241", "/data/user/0/com.dsharnessmobile.shell", "files", "100", "20000")
    for (cap in listOf("0", "200001", "-1", "+1", "0100")) {
      assertNull(cap, RootRepairMain.parse(good.copyOf().also { it[3] = cap }))
    }
    for (timeout in listOf("0", "120001", "-1", "99999999999999999999")) {
      assertNull(timeout, RootRepairMain.parse(good.copyOf().also { it[4] = timeout }))
    }
  }

  @Test fun `su maintenance loads installed APK and verifies complete helper result`() {
    val root = kotlin("RootAccess")
    assertTrue(root.contains("app.applicationInfo.sourceDir"))
    assertTrue(root.contains("com.dsharnessmobile.shell.RootRepairMain"))
    assertTrue(root.contains("requireAiGrant = false"))
    assertTrue(root.contains("ProcIo.readBoundedMillis"))
    assertTrue(root.contains(""""unverifiedMutations", -1) == 0"""))
    assertTrue(root.contains(""""remaining", -1) == 0"""))
    assertTrue(root.contains("repair-transport-incomplete"))
    assertFalse(root.contains("find "))
  }
}
