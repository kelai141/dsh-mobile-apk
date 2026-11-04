package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1511 回归：SN 快照构建必须能收到后续快照。
 *
 * 缺陷形态：`currentVersion()` 在比较**之前**就把 `-SN-.*` 剥掉，于是 `isNewer` 里
 * `prereleaseOf(current)` 恒为 null，走 `preB == null -> false` —— SN 构建恒判「已是最新」，
 * 装快照的测试者只能手装下一版。
 *
 * 为什么用显式版本串而不是只读 [BuildConfig.VERSION_NAME]：JVM 单测里 VERSION_NAME 恒为
 * 不带后缀的发布档，只读它的断言**静默恒真**——这正是本 issue 躲过 #1365 的那条缝。
 * 取值函数因此留了一个 `raw` 参数（默认仍是 VERSION_NAME，生产调用点零改动），
 * 让判据打在**同一个生产函数**上，且能真打红。
 */
class UpdateCheckerSnapshotBuildTest {

  @Test
  fun `取值处不得剥后缀`() {
    // 判据打在**生产取值函数**上：把剥离重新写回 currentVersion() 即红。
    assertEquals(
      "currentVersion 必须原样返回（剥了 SN 就没有预发布段可参与比较）",
      "0.14.6-SN-1-13",
      UpdateChecker.currentVersion("0.14.6-SN-1-13"),
    )
    assertEquals("无后缀时同样是原值", "0.14.9", UpdateChecker.currentVersion("0.14.9"))
    // 默认参数仍是 BuildConfig.VERSION_NAME（生产调用点零改动）
    assertEquals("默认值必须是 VERSION_NAME", BuildConfig.VERSION_NAME, UpdateChecker.currentVersion())
  }

  @Test
  fun `同一核心的后续快照必须判为更新`() {
    val current = UpdateChecker.currentVersion("0.14.6-SN-1-13")
    assertTrue(
      "SN-1-14 比 SN-1-13 新（旧实现恒 false）",
      UpdateChecker.isNewer("v0.14.6-SN-1-14", current),
    )
    assertFalse("反向不得成立", UpdateChecker.isNewer("v0.14.6-SN-1-12", current))
    assertFalse("同一条快照不算更新", UpdateChecker.isNewer("v0.14.6-SN-1-13", current))
    assertTrue(
      "序号按数字比而不是字典序（SN-1-100 > SN-1-99）",
      UpdateChecker.isNewer("v0.14.6-SN-1-100", UpdateChecker.currentVersion("0.14.6-SN-1-99")),
    )
  }

  @Test
  fun `核心版本抬升时快照用户也要收到`() {
    val current = UpdateChecker.currentVersion("0.14.6-SN-1-13")
    assertTrue("0.14.7 正式版高于 0.14.6 的任何快照", UpdateChecker.isNewer("v0.14.7", current))
    assertTrue("0.14.7 的下一轮快照同样成立", UpdateChecker.isNewer("v0.14.7-SN-1-1", current))
  }

  @Test
  fun `正式版用户不会被同核心的快照提示更新`() {
    // 反向保护：修 #1511 不能把「正式版提示装快照」的另一种谎放出来。
    val current = UpdateChecker.currentVersion("0.14.6")
    assertFalse("同核心快照不是正式版的更新", UpdateChecker.isNewer("v0.14.6-SN-1-13", current))
    assertFalse("更早核心的快照更不是", UpdateChecker.isNewer("v0.14.5-SN-1-13", current))
  }

  @Test
  fun `fx 修订链与 SN 叠加时方向不变`() {
    // fx 修订号参与核心数字比较（不在预发布白名单），所以「同核心」那一分支根本走不到；
    // 这里锁住的是它与 SN 后缀叠加时的方向。
    assertTrue(
      "0.13.7fx-2-SN-1-1 必须比 0.13.7fx-1 新（fx 段在前，仍然参与比较）",
      UpdateChecker.isNewer("v0.13.7fx-2-SN-1-1", UpdateChecker.currentVersion("0.13.7fx-1")),
    )
    assertFalse(
      "同一条 fx 快照不算更新",
      UpdateChecker.isNewer("v0.13.7fx-1-SN-1-13", UpdateChecker.currentVersion("0.13.7fx-1-SN-1-13")),
    )
  }

  @Test
  fun `展示形态剥 SN 但不得用来比较`() {
    assertEquals("展示用短形态", "0.14.6", UpdateChecker.displayVersion("0.14.6-SN-1-13"))
    assertEquals("无后缀时原样", "0.14.6", UpdateChecker.displayVersion("0.14.6"))
    // 展示形态**不能**用来比较：这正是 #1511 的缺陷本形，显式锁住。
    assertFalse(
      "拿展示形态去比会丢掉快照序号 —— 本行是缺陷形态的负控",
      UpdateChecker.isNewer("v0.14.6-SN-1-14", UpdateChecker.displayVersion("0.14.6-SN-1-13")),
    )
  }
}
