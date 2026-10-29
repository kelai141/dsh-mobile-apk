package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FX-209.2（E-5/E-11）回归：剥后缀必须**白名单**（只剥 rc / preview / SN），
 * 且 `-fx-N` 修订更新链必须保留。
 *
 * 缺陷形态：不剥任何后缀时 `v0.13.7-rc.1` 的数字段 [0,13,7,1] 被当成比 [0,13,7] 高 →
 * 预发布 tag 被提示「有新版本」；反向的粗糙修法（剥掉所有非数字尾巴）会把 fx-2 判成与
 * fx-1 同版 → 修订链被切断（E-11 判回退）。
 */
class UpdateCheckerSuffixTest {

  @Test
  fun whitelistStripsOnlyPrereleaseAndSnapshotSuffixes() {
    assertEquals("v0.13.7", UpdateChecker.stripPrereleaseSuffix("v0.13.7-rc.1"))
    assertEquals("0.13.8", UpdateChecker.stripPrereleaseSuffix("0.13.8-rc"))
    assertEquals("v0.13.7", UpdateChecker.stripPrereleaseSuffix("v0.13.7-preview.2"))
    assertEquals("v0.13.7", UpdateChecker.stripPrereleaseSuffix("v0.13.7-preview2"))
    assertEquals("v0.13.7fx-1", UpdateChecker.stripPrereleaseSuffix("v0.13.7fx-1-SN-1-13"))
    assertEquals("v0.13.9", UpdateChecker.stripPrereleaseSuffix("v0.13.9-sn.4"))
    // 不在白名单内的一律保留（修订号 / 渠道段）
    assertEquals("v0.13.7fx-2", UpdateChecker.stripPrereleaseSuffix("v0.13.7fx-2"))
    assertEquals("v0.13.7+build.7", UpdateChecker.stripPrereleaseSuffix("v0.13.7+build.7"))
  }

  /** 判据要求：复算 6 组 tag 形态。 */
  @Test
  fun sixTagFormsRecompute() {
    // ① 正式版递增
    assertTrue(UpdateChecker.isNewer("v0.13.8", "0.13.7"))
    // ② 同版不再提示
    assertFalse(UpdateChecker.isNewer("v0.13.7", "0.13.7"))
    // ③ rc 序号后缀不误判为更高版本（旧实现的假更新）
    assertFalse(UpdateChecker.isNewer("v0.13.7-rc.1", "0.13.7"))
    assertFalse(UpdateChecker.isNewer("v0.13.7-preview.3", "0.13.7"))
    // ④ rc 但基版本确实更高 → 仍提示
    assertTrue(UpdateChecker.isNewer("v0.13.8-rc.2", "0.13.7"))
    // ⑤ -fx-N 修订更新链必须保留（E-11：切断即回退）
    assertTrue(UpdateChecker.isNewer("v0.13.7fx-2", "0.13.7fx-1"))
    assertTrue(UpdateChecker.isNewer("v0.13.7fx-10", "0.13.7fx-9"))
    assertFalse(UpdateChecker.isNewer("v0.13.7fx-1", "0.13.7fx-2"))
    // ⑥ 快照后缀不参与比较（带序号后缀同样不误判）
    assertFalse(UpdateChecker.isNewer("v0.13.7fx-1-SN-1-13", "0.13.7fx-1"))
    assertTrue(UpdateChecker.isNewer("v0.13.9-SN-1-13", "0.13.8"))
    assertFalse(UpdateChecker.isNewer("v0.13.7-SN-2-3", "0.13.7"))
  }

  /** 反向自证核心：若把后缀剥成「所有非数字尾巴」，fx-2 与 fx-1 会变成同版（本条即红）。 */
  @Test
  fun fxRevisionMustSurviveTheStrip() {
    val stripped = UpdateChecker.stripPrereleaseSuffix("v0.13.7fx-2")
    assertTrue("fx 后缀不得被剥（否则修订链断裂）", stripped.contains("fx-2"))
    assertTrue(UpdateChecker.isNewer(stripped, "0.13.7fx-1"))
  }


  /** #513：重定向链白名单——镜像域内跟随合法，越域（劫持 302）整链放弃。 */
  @Test
  fun redirectChainAllowedAcceptsOnlyKnownHosts() {
    assertEquals(true, UpdateChecker.redirectChainAllowed(listOf(
      "https://gh-proxy.com/https://github.com/a/b/releases/download/v1/x.apk")))
    assertEquals(true, UpdateChecker.redirectChainAllowed(listOf(
      "https://github.com/...",
      "https://objects.githubusercontent.com/...",
      "https://release-assets.githubusercontent.com/...")))
    assertEquals("劫持到任意域必须整链拒绝", false,
      UpdateChecker.redirectChainAllowed(listOf(
        "https://ghfast.top/https://github.com/a",
        "https://evil.example.com/x.apk")))
    assertEquals("空链拒绝", false, UpdateChecker.redirectChainAllowed(emptyList()))
  }

  // ---- 2026-10-28 自查：SemVer build metadata（+xxx）不参与优先级 ----

  @Test
  fun `build metadata 不得让同一个版本被判成更新`() {
    // 不切掉 `+…` 时 parts 会多出一个数字组 [.., 7] > [.., 0] ⇒ 每轮报"发现新版"，
    // 然后去要一个不存在的 asset 名，最终把"版本号写法"错报成"没有适配架构的包"。
    assertFalse("v0.14.5+build.7 不高于 0.14.5", UpdateChecker.isNewer("v0.14.5+build.7", "0.14.5"))
    assertFalse("0.14.5+build.7 与 0.14.5+build.9 同级", UpdateChecker.isNewer("v0.14.5+build.7", "0.14.5+build.9"))
    // 反向：真正更高的版本仍要判出来（切 +build 不能把比较弄坏）
    assertTrue("0.14.6 高于 0.14.5", UpdateChecker.isNewer("v0.14.6+build.1", "0.14.5+build.9"))
    assertTrue("0.14.5 高于 0.14.4", UpdateChecker.isNewer("v0.14.5", "0.14.4"))
    // 既有两种命名不受影响
    assertTrue("fx 修订号仍参与", UpdateChecker.isNewer("v0.13.7fx-2", "0.13.7fx-1"))
    assertFalse("rc 段仍不参与", UpdateChecker.isNewer("v0.13.7-rc.1", "0.13.7"))
  }
}
