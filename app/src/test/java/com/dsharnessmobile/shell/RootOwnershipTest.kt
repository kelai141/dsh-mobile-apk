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
    // 版本号只前进：v4 的 configure/repair 语义必须仍在，后续新增事务不得重编号旧事务。
    val version = Regex("const val PROTOCOL_VERSION = (\\d+)")
      .find(kotlin("ShizukuUserService"))?.groupValues?.get(1)?.toIntOrNull()
    assertTrue("协议版本必须 >= 4（v4 面仍在）", version != null && version >= 4)
    // 编号不重排：这些既有事务号必须逐字保持，新增事务只能往后追加。
    for (anchor in listOf(
      "void configure(int appUid, String appDataDir) = 8",
      "Bundle repairOwnership(in String path, int maxEntries) = 9",
      "Bundle configuration() = 10",
      "int nativeInputCapabilities() = 11",
      "Bundle nativeTapReal(int x, int y) = 12",
    )) {
      assertTrue("既有事务号不得重排：" + anchor, aidl.contains(anchor))
    }
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
    assertTrue(adapter.contains("hardlink-protection-unavailable"))
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
    // start() 现在回传本次 Launch（ID + 闩），未启动返回 null；单飞判据本身不变。
    assertTrue(jobs.contains("if (running) return null"))
    // 等待用的是本次启动自己的闩（ID 与闩成对），不再从共享字段二次读取；30 秒有界不变。
    assertTrue(jobs.contains("launch.latch.await(30, TimeUnit.SECONDS)"))
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
