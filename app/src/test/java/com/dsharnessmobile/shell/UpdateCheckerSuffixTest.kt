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
  // ── issue #1365：预发布段必须参与比较 ──────────────────────────────────

  @Test
  fun 同核心的预发布段按序号比较() {
    assertTrue("rc.2 比 rc.1 新（旧实现两者都归约成 [0,14,2] ⇒ 恒 false）",
      UpdateChecker.isNewer("v0.14.2-rc.2", "0.14.2-rc.1"))
    assertFalse("反向不得成立", UpdateChecker.isNewer("v0.14.2-rc.1", "0.14.2-rc.2"))
    assertFalse("同一 rc 不算更新", UpdateChecker.isNewer("v0.14.2-rc.2", "0.14.2-rc.2"))
    assertTrue("按数字比而不是按字典序（rc.10 > rc.9）",
      UpdateChecker.isNewer("v0.14.2-rc.10", "0.14.2-rc.9"))
  }

  @Test
  fun 正式版高于同核心的预发布() {
    assertTrue("rc 用户必须能升到正式版", UpdateChecker.isNewer("v0.14.2", "0.14.2-rc.1"))
    assertFalse("正式版用户不得被同核心的 rc 提示更新",
      UpdateChecker.isNewer("v0.14.2-rc.1", "0.14.2"))
  }

  @Test
  fun 预发布段的解析只认白名单() {
    assertEquals("rc" to listOf(2L), UpdateChecker.prereleaseOf("v0.14.2-rc.2"))
    assertEquals("sn" to listOf(1L, 13L), UpdateChecker.prereleaseOf("v0.14.6-SN-1-13"))
    assertEquals(null, UpdateChecker.prereleaseOf("v0.14.5-fx-3"))
    assertEquals(null, UpdateChecker.prereleaseOf("v0.14.5"))
  }

  @Test
  fun 修订链语义不受影响() {
    assertTrue(UpdateChecker.isNewer("v0.14.5-fx-3", "0.14.5-fx-2"))
    assertFalse(UpdateChecker.isNewer("v0.14.5-fx-2", "0.14.5-fx-2"))
    assertFalse("fx 不是预发布段，正式版与它的关系保持原口径",
      UpdateChecker.isNewer("v0.14.5-fx-2", "0.14.5-fx-2"))
  }

  // ── issue #1524：预发布族名按**显式次序**比较（不再靠字典序碰巧成立） ──────────────

  /**
   * 跨族先后：preview < rc < sn。
   *
   * 旧实现比字符串，结果由字母位置偶然给出（p < r < s 恰好等于想要的先后）。
   * 这几条把「偶然」变成「约定」：任何一边改了族名或次序，这里立刻红。
   */
  @Test
  fun 跨族预发布按显式次序比较() {
    // preview 早于 rc：rc 用户不该被 preview tag 提示更新，preview 用户必须能升到 rc。
    assertTrue("rc.1 比 preview.1 新", UpdateChecker.isNewer("v0.14.6-rc.1", "0.14.6-preview.1"))
    assertFalse("preview 不得被判成比 rc 新", UpdateChecker.isNewer("v0.14.6-preview.1", "0.14.6-rc.1"))
    // rc 早于 sn：快照是发布前的最后一站。
    assertTrue("sn.1 比 rc.1 新", UpdateChecker.isNewer("v0.14.6-sn.1", "0.14.6-rc.1"))
    assertFalse("rc 不得被判成比 sn 新", UpdateChecker.isNewer("v0.14.6-rc.1", "0.14.6-sn.1"))
    // preview < sn（跨两级的对照：证明不是「只修了相邻一对」）。
    assertTrue("sn.1 比 preview.1 新", UpdateChecker.isNewer("v0.14.6-sn.1", "0.14.6-preview.1"))
    assertFalse("preview 不得被判成比 sn 新", UpdateChecker.isNewer("v0.14.6-preview.1", "0.14.6-sn.1"))
    // 大小写不敏感：解析侧已 lowercase，这条守的是「别在比较处又拿原始文本比」。
    assertTrue("SN 与 rc 的先后与大小写无关", UpdateChecker.isNewer("v0.14.6-SN-1-13", "0.14.6-rc.1"))
  }

  /**
   * 未登记的族名退回字典序（**旧口径不变**）：这是「不静默改变既有比较结果」的边界。
   *
   * 为什么直接测判定函数而不是走 isNewer：prereleaseOf 只认白名单，未登记族名在
   * isNewer 这条路上**根本取不到**（上面那条用例里的 dev 其实被判成 null 段，
   * 走的是「有/无预发布段」分支，与字典序无关）。兜底分支今天不可达，但它是白名单
   * 将来扩容时的唯一防线，所以单独钉住。
   */
  @Test
  fun 未登记族名退回字典序且不改变既有结果() {
    // 两边都未登记：字典序（zz > aa）。
    assertTrue("两边都未登记时按字典序", UpdateChecker.prereleaseFamilyIsNewer("zz", "aa"))
    assertFalse("反向不成立", UpdateChecker.prereleaseFamilyIsNewer("aa", "zz"))
    // 一边未登记：仍是字典序（与历史一致）。
    assertTrue("未登记的 dev 比 rc 小（字典序 d < r）", UpdateChecker.prereleaseFamilyIsNewer("rc", "dev"))
    assertFalse("dev 不比 rc 大", UpdateChecker.prereleaseFamilyIsNewer("dev", "rc"))
    // 两边都登记：走显式次序，而不是字典序（字典序在这里恰好同向，所以另钉一组逆序对照）。
    assertTrue("sn 比 rc 新", UpdateChecker.prereleaseFamilyIsNewer("sn", "rc"))
    assertFalse("rc 不比 sn 新", UpdateChecker.prereleaseFamilyIsNewer("rc", "sn"))
    assertTrue("rc 比 preview 新", UpdateChecker.prereleaseFamilyIsNewer("rc", "preview"))
    // 同族仍按序号比（#1365 的判据不受本次改动影响）。
    assertTrue("同族比序号", UpdateChecker.isNewer("v0.14.6-rc.10", "0.14.6-rc.9"))
  }


  /** 族序表本身可读：preview < rc < sn 的排名是**相邻递增**的（防止有人手改成乱序）。 */
  @Test
  fun 族序表是连续递增的() {
    val preview = UpdateChecker.prereleaseOf("v1.0.0-preview.1")!!
    val rc = UpdateChecker.prereleaseOf("v1.0.0-rc.1")!!
    val sn = UpdateChecker.prereleaseOf("v1.0.0-SN-1")!!
    assertEquals("preview", preview.first)
    assertEquals("rc", rc.first)
    assertEquals("sn", sn.first)
    // 用 isNewer 的传递性固定次序：preview < rc < sn。
    assertTrue(UpdateChecker.isNewer("v1.0.0-rc.1", "1.0.0-preview.1"))
    assertTrue(UpdateChecker.isNewer("v1.0.0-sn.1", "1.0.0-rc.1"))
    assertTrue(UpdateChecker.isNewer("v1.0.0-sn.1", "1.0.0-preview.1"))
  }
}
