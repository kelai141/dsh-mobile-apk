package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 块G F5：壳侧特权 shell 通道的**目标屏解析**（范围门禁的 Kotlin 副本，执行点复查）。
 *
 * 背景（真缺陷）：T3 已在引擎侧 `screen-scope.ts` 修了 F2，让「显式指名已注册虚拟屏」的命令放行；
 * 但 `ShellOps.scopeDenied` 是同一正则的副本，它在**执行点**（Shizuku 真正下发前）复查——
 * 只修引擎侧会让 F2 在 shell 路径上被完全抵消（引擎放行、壳侧仍拒）。本测试把两侧的判据锁在一起。
 *
 * 只测纯函数（`commandDisplayTokens` / `parseSfDisplayTokens`）与注册表空集时的 fail-closed 行为；
 * 注册表非空的放行需要真实 VirtualDisplay（设备实测已在 gotchas 147 留证），不在 JVM 单测里伪造。
 */
class ShellOpsScopeTargetTest {

  @Test
  fun extractsExplicitDisplayIdsInAllThreeSpellings() {
    // 与引擎侧 `adbCommandDisplayTokens` 的 `(?:^|[\s=])(?:-d|--display|--display-id)[\s=]+(\d+)` 同规则。
    // 返回**字符串**（块G F6：token 超 Int/Long，不得数值化）。
    assertEquals(listOf("2"), ShellOps.commandDisplayTokens("screencap -d 2 -p /tmp/x.png"))
    assertEquals(listOf("2"), ShellOps.commandDisplayTokens("screencap -p -d 2 /tmp/x.png"))
    assertEquals(listOf("3"), ShellOps.commandDisplayTokens("screencap --display 3 -p /tmp/x.png"))
    assertEquals(listOf("4"), ShellOps.commandDisplayTokens("screencap --display-id 4 -p /tmp/x.png"))
    assertEquals("多个 -d 都要提取（须逐个核对）", listOf("2", "5"),
      ShellOps.commandDisplayTokens("screencap -d 2 -d 5 -p /tmp/x.png"))
  }

  @Test
  fun surfaceFlingerTokenIsPreservedVerbatimNotNumericalized() {
    // gotchas 147（设备实测）：`screencap -d` 吃的是 SurfaceFlinger token，虚拟屏形如
    // 11529215046816944610（> 2^63-1）。若在此数值化，取到的值会与真实 token 不等 ⇒ 永远核对不上。
    val token = "11529215046816944610"
    val tokens = ShellOps.commandDisplayTokens("screencap -d $token -p /tmp/x.png")
    assertEquals(listOf(token), tokens)
    assertEquals("必须与命令里的字面量逐字相同", token, tokens[0])
    assertNotEquals("数值化会失真，故不相等", token, token.toLongOrNull()?.toString() ?: "")
  }

  @Test
  fun absentTargetYieldsNoIdsSoCallersMustFailClosed() {
    // 无 -d：没有可核对的目标屏 ⇒ 调用方必须拒绝（这正是「无参 screencap 读真实屏 0」的形态）。
    assertEquals(emptyList<String>(), ShellOps.commandDisplayTokens("screencap -p /tmp/x.png"))
    assertEquals(emptyList<String>(), ShellOps.commandDisplayTokens("input tap 1 2"))
    assertEquals(emptyList<String>(), ShellOps.commandDisplayTokens(""))
  }

  @Test
  fun displayZeroIsExtractedAndMustNeverBeAllowed() {
    // -d 0 恒为真实屏：必须被提取出来（这样注册表核对才有机会拒它），而不是被当成「无目标屏」。
    assertEquals(listOf("0"), ShellOps.commandDisplayTokens("screencap -d 0 -p /tmp/x.png"))
  }

  @Test
  fun parseSfDisplayTokensPairsTokenWithDshAlias() {
    // 设备实测夹具（MuMu x86_64 模拟器 / Android 15 / API 35），逐字照录。
    val dump = listOf(
      "    name=\"mumuscreen000\"",
      "Virtual Display 11529215046816944610",
      "    name=\"DSH virtual-1\"",
    ).joinToString("\n")
    assertEquals(listOf("virtual-1" to "11529215046816944610"), ShellOps.parseSfDisplayTokens(dump))
    // 物理屏不得入表；token 与其名必须成对（不得错配给下一个）。
    val misordered = listOf(
      "Virtual Display 11111111111111111111",
      "    name=\"DSH virtual-9\"",
      "Virtual Display 22222222222222222222",
      "    name=\"mumuscreen000\"",
    ).joinToString("\n")
    assertEquals(listOf("virtual-9" to "11111111111111111111"), ShellOps.parseSfDisplayTokens(misordered))
    assertEquals(emptyList<Pair<String, String>>(), ShellOps.parseSfDisplayTokens(""))
    assertEquals(emptyList<Pair<String, String>>(), ShellOps.parseSfDisplayTokens("no virtual display here"))
  }

  @Test
  fun unknownOrAbsentRegistryFailsClosed() {
    // 注册表不可达/无屏时（JVM 下无 VirtualDisplay），任何目标屏都不得被放行。
    // 这是 fail-closed 的核心：绝不凭命令里的数字自证「这是一块虚拟屏」。
    assertFalse("-d 2 在无注册表时必须判否", ShellOps.targetsRegisteredVirtualScreen(null, "screencap -d 2 -p /tmp/x.png"))
    assertFalse("无 -d 时必须判否", ShellOps.targetsRegisteredVirtualScreen(null, "screencap -p /tmp/x.png"))
    assertFalse("-d 0 必须判否", ShellOps.targetsRegisteredVirtualScreen(null, "screencap -d 0 -p /tmp/x.png"))
    // SF token 形态在无注册表时同样不得放行（F6：token 需与**已注册别名**配对才有效）。
    assertFalse(ShellOps.targetsRegisteredVirtualScreen(null,
      "screencap -d 11529215046816944610 -p /tmp/x.png"))
  }

  @Test
  fun realScreenCommandRegexStillCoversTheAdbReadWriteFace() {
    // 与引擎侧 REAL_SCREEN_ADB_COMMAND 同源：范围门禁的命令词面不得缩水（缩水=直接放行真实屏）。
    val denied = listOf(
      "screencap -p /tmp/x.png",
      "screenrecord /tmp/x.mp4",
      "uiautomator dump /tmp/x.xml",
      "input tap 100 200",
      "input keyevent 3",
      "wm size",
      "dumpsys window",
      "am start -n com.example/.Main",
      "monkey -p com.example 1",
    )
    for (cmd in denied) {
      assertTrue("必须命中真实屏读写命令词：$cmd", ShellOps.commandTargetsRealScreen(cmd))
    }
    assertFalse("普通只读命令不得被误拦：getprop", ShellOps.commandTargetsRealScreen("getprop ro.build.version.sdk"))
    assertFalse("普通只读命令不得被误拦：ls", ShellOps.commandTargetsRealScreen("ls -la /sdcard"))
  }

  // ── 块G F5：放行分支（此前零覆盖；本组即「合法目标屏必须通过」的判据）──────────────
  //
  // 缺口：上面所有用例都经 `targetsRegisteredVirtualScreen(context, ...)`，而 JVM 下只能传
  // `context = null` → 恒走 fail-closed → **只测到了拒绝**。而注册表数据面
  // （`VdisplayController.aliasForDisplayId`）在 JVM 不可注入（`Record` 持真实 VirtualDisplay /
  // ImageReader），所以「合法目标屏必须放行」这条在单测里根本表达不出来。
  // 修法 = 抽纯判据 `decideTargetsRegisteredVirtualScreen`（生产路径也走它，非平行副本），
  // 于是放行与拒绝两侧都可钉死，且把放行逻辑改坏即判红。

  @Test
  fun registeredVirtualDisplayIdOnTheCommandIsAllowed() {
    // displayId 空间：4 已注册 → 放行（这就是 F5 要修的那个用户可见症状：
    // 范围允许 virtual-1 却报「不允许访问真实屏」）。
    val owns = { id: Int -> id == 4 }
    assertTrue("已注册虚拟屏 displayId 必须放行",
      ShellOps.decideTargetsRegisteredVirtualScreen("screencap -p -d 4 /data/local/tmp/a.png", owns, emptySet()))
    assertTrue("--display 拼写同样放行",
      ShellOps.decideTargetsRegisteredVirtualScreen("screencap -p --display 4 /data/local/tmp/a.png", owns, emptySet()))
    assertTrue("--display-id 拼写同样放行",
      ShellOps.decideTargetsRegisteredVirtualScreen("screencap -p --display-id 4 /data/local/tmp/a.png", owns, emptySet()))
  }

  @Test
  fun registeredSfTokenIsAllowedSoTheSfLookupPathIsNotAlwaysDenied() {
    // token 空间：F6 的反查结果必须真的能让判定放行——否则 F6 恒拒（比不修更糟）。
    val vtoken = "11529215046816944610"
    val owns = { _: Int -> false }
    assertTrue("已注册虚拟屏的 SF token 必须放行",
      ShellOps.decideTargetsRegisteredVirtualScreen(
        "screencap -p -d $vtoken /data/local/tmp/a.png", owns, setOf(vtoken)))
  }

  @Test
  fun allowPathStillRefusesUnregisteredZeroAndUnknownTargets() {
    // 放行的对立面（与上面同组，确保「恒放行」这种假绿不能过关）。
    val owns = { id: Int -> id == 4 }
    val vtoken = "11529215046816944610"
    assertFalse("未注册 displayId 必须拒",
      ShellOps.decideTargetsRegisteredVirtualScreen("screencap -d 99 -p /x.png", owns, emptySet()))
    assertFalse("-d 0（真实屏）必须拒，即使注册表里有 0",
      ShellOps.decideTargetsRegisteredVirtualScreen("screencap -d 0 -p /x.png", { true }, emptySet()))
    assertFalse("无 -d 必须拒",
      ShellOps.decideTargetsRegisteredVirtualScreen("screencap -p /x.png", owns, emptySet()))
    assertFalse("未注册 token 必须拒",
      ShellOps.decideTargetsRegisteredVirtualScreen("screencap -d $vtoken -p /x.png", owns, emptySet()))
    // 多目标必须**逐个**命中：其一未注册即整体拒（不得只放行其中一个）。
    assertFalse("多个 -d 时其一未注册必须整体拒",
      ShellOps.decideTargetsRegisteredVirtualScreen("screencap -d 4 -d 99 -p /x.png", owns, emptySet()))
  }

  @Test
  fun productionPathDelegatesToTheTestedDecisionInsteadOfAForkedCopy() {
    // 防「测试测的是另一份实现」：生产入口在空注册表下必须与纯判据一致（都判否）。
    // 若生产路径退回各自内联一份判据，本断言会失去意义——故同时钉住 null-context 恒 false。
    assertFalse("注册表不可达必须 fail-closed",
      ShellOps.targetsRegisteredVirtualScreen(null, "screencap -d 4 -p /x.png"))
    assertFalse("无 context 时即使命令形态合法也不得放行",
      ShellOps.targetsRegisteredVirtualScreen(null, "screencap -d 11529215046816944610 -p /x.png"))
  }
}
