package com.dsharnessmobile.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 控制台验收入口的契约判据。
 *
 * 每一组都对应一个会**悄悄把验收对象换回快照 bash** 的失败形态：
 *  - 相对路径的 shell 会被解析成宿主工作目录里的同名文件；
 *  - args 里混进非字符串会在中继模板里变成 "[object Object]" 之类的假参数；
 *  - 未知键被静默忽略时，人以为"配了却没生效"，排查成本远高于当场拒绝；
 *  - env 键写成 "A=B" 会把值一起吞进键里，最终 shell 环境缺变量却无报错。
 */
class ConsoleShellOverrideTest {

  private fun json(vararg pairs: Pair<String, Any?>): String {
    val root = JSONObject()
    for ((k, v) in pairs) root.put(k, v)
    return root.toString()
  }

  @Test
  fun fullSpecCarriesShellArgvCwdAndEnv() {
    val spec = json(
      "shell" to "/data/user/0/com.dsharnessmobile.shell/files/linux-environment/rootfs/bin/bionilux",
      "args" to listOf("--rootfs", "/rootfs", "--guest-cwd", "/w", "/bin/bash", "-i"),
      "cwd" to "/data/user/0/com.dsharnessmobile.shell/files/linux-environment/workspace",
      "env" to mapOf("BIONILUX_ROOTFS" to "/rootfs"),
    )
    val parsed = ConsoleShellOverride.parse(spec)
    assertNotNull("合规条目必须解析成功", parsed)
    parsed!!
    assertTrue(parsed.shell.endsWith("/bin/bionilux"))
    assertEquals(listOf("--rootfs", "/rootfs", "--guest-cwd", "/w", "/bin/bash", "-i"), parsed.args)
    assertEquals("/data/user/0/com.dsharnessmobile.shell/files/linux-environment/workspace", parsed.cwd)
    assertEquals(mapOf("BIONILUX_ROOTFS" to "/rootfs"), parsed.env)
  }

  @Test
  fun omittedArgsDefaultToInteractiveShell() {
    val parsed = ConsoleShellOverride.parse(json("shell" to "/system/bin/sh"))
    assertNotNull(parsed)
    assertEquals("没写 args 时仍然是交互 shell，而不是空 argv", listOf("-i"), parsed!!.args)
  }

  @Test
  fun relativeShellIsRejected() {
    assertNull("相对路径会随工作目录漂移，必须拒绝", ConsoleShellOverride.parse(json("shell" to "bin/bash")))
    assertNull(ConsoleShellOverride.parse(json("shell" to "")))
    assertNull(ConsoleShellOverride.parse(json()))
  }

  @Test
  fun unknownKeysAreRejectedInsteadOfIgnored() {
    assertNull(
      "未知键静默忽略 = 「配了却没生效」",
      ConsoleShellOverride.parse(json("shell" to "/system/bin/sh", "arg" to listOf("-i"))),
    )
  }

  @Test
  fun nonStringArgsAreRejected() {
    assertNull(ConsoleShellOverride.parse(json("shell" to "/system/bin/sh", "args" to listOf("-i", 1))))
    assertNull(ConsoleShellOverride.parse(json("shell" to "/system/bin/sh", "args" to "-i")))
    assertNull(ConsoleShellOverride.parse(json("shell" to "/system/bin/sh", "args" to JSONObject())))
  }

  @Test
  fun envKeyCarryingAnEqualsSignIsRejected() {
    assertNull(ConsoleShellOverride.parse(json("shell" to "/system/bin/sh", "env" to mapOf("A=B" to "x"))))
    assertNull(ConsoleShellOverride.parse(json("shell" to "/system/bin/sh", "env" to "BIONILUX_ROOTFS=/r")))
  }

  @Test
  fun unsetListDropsHostEnvironmentKeys() {
    val parsed = ConsoleShellOverride.parse(
      json("shell" to "/system/bin/sh", "unset" to listOf("TERMUX__PREFIX", "TERMUX__ROOTFS")),
    )
    assertNotNull(parsed)
    assertEquals(listOf("TERMUX__PREFIX", "TERMUX__ROOTFS"), parsed!!.unset)
  }

  @Test
  fun malformedUnsetIsRejected() {
    assertNull(ConsoleShellOverride.parse(json("shell" to "/system/bin/sh", "unset" to "TERMUX__PREFIX")))
    assertNull(ConsoleShellOverride.parse(json("shell" to "/system/bin/sh", "unset" to listOf(1))))
    assertNull(ConsoleShellOverride.parse(json("shell" to "/system/bin/sh", "unset" to listOf("A=B"))))
  }

  @Test
  fun malformedJsonFallsBackToDefaultByReturningNull() {
    assertNull(ConsoleShellOverride.parse("{not json"))
    assertNull(ConsoleShellOverride.parse("[]"))
  }

  @Test
  fun argsJsonRoundTripsThroughTheRelayContract() {
    val args = listOf("--rootfs", "/r o o t", "/bin/bash", "-i")
    val encoded = ConsoleShellOverride.argsJson(args)
    val decoded = org.json.JSONArray(encoded)
    val back = (0 until decoded.length()).map { decoded.getString(it) }
    assertEquals("中继按 JSON 数组消费，带空格的 rootfs 路径不能被拆开", args, back)
  }
}
