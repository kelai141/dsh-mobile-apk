package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #683：安全模式「部分生效」不收敛。
 *
 * 三个验收点（各有一条用例，改回旧实现时分别变红）：
 *  ① `phase=writing` 中途失败后，下次进入必须**识别并重写**，不能早退报成功；
 *  ② 只有 ⑤ 全部写成功才置 `active=true`；
 *  ③ 旧状态文件（只有 `active:true`、没有 `phase`）必须**兼容**（视为已完成），
 *     否则升级用户第一次点「安全模式启动」就被判成不收敛。
 *
 * 纯 JVM + 真实临时目录（与 SafeModeTest 同款纪律，本仓测试面无 Mockito）。
 */
class SafeModePartialPhaseTest {
  private val hardEntries = setOf(
    PluginMounts.HardEntry("android-manage", "@dsh-android/dsh-android-manage"),
  )

  private fun setup(): Triple<File, File, File> {
    val dir = Files.createTempDirectory("safe-mode-phase").toFile()
    val patch = File(dir, "patch.yml")
    patch.writeText("- insert:\n  - id: third-party\n    name: '@evil/third-party'\n")
    return Triple(patch, File(dir, "home.yml"), File(dir, "auto"))
  }

  private fun stateOf(auto: File): JSONObject = JSONObject(File(auto, SafeMode.STATE_FILE).readText())

  @Test
  fun `旧状态文件没有 phase 时视为已完成并早退`() {
    val (patch, home, auto) = setup()
    auto.mkdirs()
    val legacy = JSONObject().put("active", true).put("profile", "web").put("snapshotId", "old-id")
    File(auto, SafeMode.STATE_FILE).writeText(legacy.toString(2))
    val before = patch.readText()
    val result = SafeMode.enter(patch, home, auto, "new-id", hardManifestAvailable = true, hardEntries = hardEntries)
    assertTrue("旧状态必须早退成功", result.ok)
    assertTrue("文案应为「已开启」", result.message.contains("已开启"))
    assertEquals("早退不得改写 patch", before, patch.readText())
    assertEquals("旧状态不得被覆盖", "old-id", stateOf(auto).optString("snapshotId"))
  }

  @Test
  fun `phase 为 writing 时不得早退必须重写为 active`() {
    val (patch, home, auto) = setup()
    auto.mkdirs()
    File(auto, SafeMode.STATE_FILE).writeText(
      JSONObject().put("active", true).put("phase", SafeMode.PHASE_WRITING).put("profile", "web").put("snapshotId", "stale")
        .toString(2),
    )
    val result = SafeMode.enter(patch, home, auto, "new-id", hardManifestAvailable = true, hardEntries = hardEntries)
    assertTrue(result.ok)
    val after = stateOf(auto)
    assertEquals("重写后必须是 active 阶段", SafeMode.PHASE_ACTIVE, after.optString("phase"))
    assertTrue("重写后必须 active=true", after.optBoolean("active", false))
    assertEquals("必须换成新的 snapshotId", "new-id", after.optString("snapshotId"))
    assertFalse("第三方条目必须被摘除", patch.readText().contains("third-party"))
  }

  @Test
  fun `全部写成功才置 active`() {
    val (patch, home, auto) = setup()
    val result = SafeMode.enter(patch, home, auto, "ok-id", hardManifestAvailable = true, hardEntries = hardEntries)
    assertTrue(result.ok)
    val st = stateOf(auto)
    assertEquals(SafeMode.PHASE_ACTIVE, st.optString("phase"))
    assertTrue(st.optBoolean("active", false))
  }

  @Test
  fun `中途失败时状态停在 writing 且下次能收敛`() {
    val (patch, home, auto) = setup()
    // 让 ⑤ 的 patch 写入失败：把 patch 换成一个目录。
    patch.delete()
    patch.mkdirs()
    val failed = SafeMode.enter(patch, home, auto, "fail-id", hardManifestAvailable = true, hardEntries = hardEntries)
    assertFalse("⑤ 失败必须回 ok=false", failed.ok)
    val stalled = stateOf(auto)
    assertEquals("失败后必须停在 writing", SafeMode.PHASE_WRITING, stalled.optString("phase"))
    assertFalse("失败后不得声称已生效", stalled.optBoolean("active", true))
    // 修好 patch 后再次进入：必须识别 writing 并收敛到 active。
    patch.delete()
    patch.writeText("- insert:\n  - id: third-party\n    name: '@evil/third-party'\n")
    val retry = SafeMode.enter(patch, home, auto, "retry-id", hardManifestAvailable = true, hardEntries = hardEntries)
    assertTrue(retry.ok)
    val done = stateOf(auto)
    assertEquals(SafeMode.PHASE_ACTIVE, done.optString("phase"))
    assertTrue(done.optBoolean("active", false))
  }
}