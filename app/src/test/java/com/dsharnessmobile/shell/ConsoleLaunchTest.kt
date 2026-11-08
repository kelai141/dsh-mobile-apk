package com.dsharnessmobile.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 启动描述（ADR-0001）的结构契约：壳侧产出的 JSON 字段名与省略规则是底层（node 中继 / 未来原生 PTY）
 * 的输入契约，改名或改省略规则会让底层解析失败——所以用单测钉住，而不是靠约定。
 */
class ConsoleLaunchTest {

  private fun parse(json: String) = JSONObject(json)

  @Test
  fun defaultLaunchUsesInteractiveBashWithoutCwdOrEnv() {
    val obj = parse(ConsoleLaunch.ofDefault("/abs/bin/bash").toJson())
    assertEquals(1, obj.getInt("schemaVersion"))
    assertEquals("/abs/bin/bash", obj.getString("shell"))
    val argv = obj.getJSONArray("argv")
    assertEquals(1, argv.length())
    assertEquals("-i", argv.getString(0))
    assertFalse(obj.has("cwd"))
    assertFalse(obj.has("env"))
    assertFalse(obj.has("unset"))
  }

  @Test
  fun overrideLaunchCarriesCwdEnvAndUnset() {
    val override = ConsoleShellOverride(
      shell = "/abs/backend/bin/bionilux",
      args = listOf("--rootfs", "/abs/rootfs", "/bin/bash", "-i"),
      cwd = "/abs/cwd",
      env = mapOf("BIONILUX_FAKE_ROOT" to "1"),
      unset = listOf("TERMUX__PREFIX"),
    )
    val obj = parse(ConsoleLaunch.ofOverride(override).toJson())
    assertEquals("/abs/backend/bin/bionilux", obj.getString("shell"))
    assertEquals(4, obj.getJSONArray("argv").length())
    assertEquals("/abs/cwd", obj.getString("cwd"))
    assertEquals("1", obj.getJSONObject("env").getString("BIONILUX_FAKE_ROOT"))
    assertEquals("TERMUX__PREFIX", obj.getJSONArray("unset").getString(0))
  }

  @Test
  fun schemaVersionIsExplicitSoConsumersCanRejectUnknownShapes() {
    val obj = parse(ConsoleLaunch.ofDefault("/abs/bin/bash").toJson())
    assertTrue(obj.has("schemaVersion"))
    assertEquals(ConsoleLaunch.SCHEMA_VERSION, obj.getInt("schemaVersion"))
  }

  @Test
  fun descriptorEnvKeyIsStableAcrossBothSides() {
    assertEquals("DSH_CONSOLE_LAUNCH", ConsoleLaunch.ENV_KEY)
  }
}
