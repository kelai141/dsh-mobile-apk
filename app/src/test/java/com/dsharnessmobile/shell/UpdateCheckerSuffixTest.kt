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
}
