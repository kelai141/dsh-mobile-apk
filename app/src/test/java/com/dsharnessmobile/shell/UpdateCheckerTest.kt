package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 0.13.8 批 H 回归：启动页 APK 自更新的两个契约——
 * ① 版本比较（tag vs BuildConfig.VERSION_NAME，快照后缀不参与）；
 * ② 资产命名（与 build-apk-013.ps1 产物名逐字一致，配错就是「检查永远说已是最新」或「永远失败」）。
 */
class UpdateCheckerTest {

  @Test
  fun newerTagsAreDetected() {
    assertTrue(UpdateChecker.isNewer("v0.13.8", "0.13.7fx-1"))
    assertTrue(UpdateChecker.isNewer("v0.14.0", "0.13.8"))
    assertTrue(UpdateChecker.isNewer("0.13.10", "0.13.9"))
    assertTrue(UpdateChecker.isNewer("v1.0.0", "0.99.99"))
  }

  @Test
  fun sameOrOlderTagsAreNotNewer() {
    assertFalse(UpdateChecker.isNewer("v0.13.8", "0.13.8"))
    assertFalse(UpdateChecker.isNewer("v0.13.7", "0.13.8"))
    // 段数不齐按缺省 0 补齐：0.13 与 0.13.0 等价
    assertFalse(UpdateChecker.isNewer("v0.13", "0.13.0"))
    assertTrue(UpdateChecker.isNewer("v0.13.1", "0.13"))
    // 无修订号的正式 tag 不是 0.13.7fx-1 的更新（同基版本，避免无谓降级路径）
    assertFalse(UpdateChecker.isNewer("v0.13.7", "0.13.7fx-1"))
  }

  @Test
  fun fxRevisionNumberIsCompared() {
    // 本项目修订命名 0.13.7fx-N：fx-2 必须被识别为比 fx-1 新（device 实测暴露的缺陷）
    assertTrue(UpdateChecker.isNewer("v0.13.7fx-2", "0.13.7fx-1"))
    assertTrue(UpdateChecker.isNewer("v0.13.7fx-10", "0.13.7fx-9"))
    assertFalse(UpdateChecker.isNewer("v0.13.7fx-1", "0.13.7fx-2"))
    assertFalse(UpdateChecker.isNewer("v0.13.7fx-1", "0.13.7fx-1"))
  }

  @Test
  fun snapshotSuffixDoesNotAffectComparison() {
    // BuildConfig.VERSION_NAME 形如 0.13.8-SN-1-13（快照档）——去 -SN-* 后比较
    assertFalse(UpdateChecker.isNewer("v0.13.8", "0.13.8"))
    assertTrue(UpdateChecker.isNewer("v0.13.9", "0.13.8"))
    // 快照档与同版正式 tag 等价（开发机不被反复提示升级到同一版）
    assertFalse(UpdateChecker.isNewer("v0.13.7fx-1", "0.13.7fx-1"))
  }

  @Test
  fun assetNameMatchesBuildScriptProductName() {
    assertEquals("dsh-mobile-apk-v0.13.8-arm64.apk", UpdateChecker.assetName("v0.13.8", "arm64"))
    assertEquals("dsh-mobile-apk-v0.13.8-x86_64.apk", UpdateChecker.assetName("v0.13.8", "x86_64"))
    // tag 无 v 前缀也要归一到同一资产名（GitHub tag 口径不一）
    assertEquals("dsh-mobile-apk-v0.13.8-x86_64.apk", UpdateChecker.assetName("0.13.8", "x86_64"))
  }

  @Test
  fun abiSelectionPrefersPrimaryAbi() {
    // MuMu/Android 15 实测：abilist = x86_64,arm64-v8a,x86（arm64 只是翻译层）
    // ——按「任一含 arm64 即 arm64」会下错包，必须以首选 ABI 为准。
    assertEquals("x86_64", UpdateChecker.abiFrom(listOf("x86_64", "arm64-v8a", "x86")))
    assertEquals("arm64", UpdateChecker.abiFrom(listOf("arm64-v8a", "armeabi-v7a", "armeabi")))
    // 老式纯 x86 设备（无翻译层）：退化为扫描，仍不误判为 arm64
    assertEquals("x86_64", UpdateChecker.abiFrom(listOf("x86", "x86_64")))
    assertEquals("arm64", UpdateChecker.abiFrom(emptyList()))
  }
}
