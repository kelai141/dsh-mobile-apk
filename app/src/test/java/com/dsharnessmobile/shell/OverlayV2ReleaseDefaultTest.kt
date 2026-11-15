package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/**
 * 悬浮 v2 必须能在 **release 包**里真正生效（issue 面：v2 代码已合入但用户看不到）。
 *
 * ## 为什么要这条判据
 *
 * Phase 2 把 v2 落成「默认 false + 只有 debug 能打开」的组合：
 *
 *  - 缺省值 `entry_ui_v2 = false`（OverlayV2.kt）；
 *  - 唯一能把它写成 true 的运行期通道是 OverlayLiveFeed 里 `.overlay-test-pending` 的
 *    `v2-on`，而那条分支要求 `ApplicationInfo.FLAG_DEBUGGABLE`。
 *
 * 两条单独看都合理，叠起来的后果是：**release 包永远进不去 v2**。功能写完了、
 * 单测过了、APK 里也能在 dex 中搜到 OverlayV2，但用户在正式包里看到的始终是旧三窗实现。
 * 这类「代码在、开关关着、而且关着的那把钥匙只在 debug 包里」的缺陷，
 * 编译、单测、装包、覆盖安装全都不会报，只能靠一条盯着**缺省值本身**的判据守住。
 *
 * 判据是源码级的（JVM 单测，不是 Android 运行验收）：它断言的是「默认行为」这个事实，
 * 而默认行为由一行常量决定，源码就是它的唯一真源。
 */
class OverlayV2ReleaseDefaultTest {
  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).first { it.isFile }.readText()

  /** 缺省值常量必须是 true：release 装完即 v2，不需要任何调试通道。 */
  @Test fun defaultIsOnSoReleaseGetsV2WithoutDebugChannel() {
    val text = source("OverlayV2.kt")
    assertTrue(
      "ENTRY_UI_V2_DEFAULT 必须为 true，否则 release 包拿不到 v2",
      Regex("""const\s+val\s+ENTRY_UI_V2_DEFAULT\s*=\s*true""").containsMatchIn(text),
    )
  }

  /**
   * `enabled()` 必须读这个常量，而不是硬编码字面量。
   *
   * 反证：若有人把 `getBoolean(KEY_ENTRY_UI_V2, false)` 写回去，默认值就绕过常量静默变 off，
   * 而上面那条判据仍然绿——所以这两条必须同时成立。
   */
  @Test fun enabledReadsTheConstantNotALiteral() {
    val body = source("OverlayV2.kt").substringAfter("internal fun enabled(")
      .substringBefore("internal fun entryStyle(")
    assertTrue(
      "enabled() 必须用 ENTRY_UI_V2_DEFAULT 作为缺省值",
      body.contains("getBoolean(KEY_ENTRY_UI_V2, ENTRY_UI_V2_DEFAULT)"),
    )
    assertFalse(
      "enabled() 不得再出现写死的 false 缺省值",
      Regex("""getBoolean\(\s*KEY_ENTRY_UI_V2\s*,\s*false\s*\)""").containsMatchIn(body),
    )
  }

  /**
   * 读偏好抛错时必须回落到与默认值一致，而不是回落到「关」。
   *
   * 反证：`catch { false }` 会让一次 prefs 读失败静默退回旧三窗，
   * 在用户侧表现为「新样式偶尔不见了」——比稳定不可用更难排查。
   */
  @Test fun prefReadFailureFallsBackToDefaultNotToOff() {
    val body = source("OverlayV2.kt").substringAfter("internal fun enabled(")
      .substringBefore("internal fun entryStyle(")
    val catchBlock = body.substringAfter("catch (_: Throwable) {").substringBefore("}")
    assertTrue(
      "catch 分支必须回落到 ENTRY_UI_V2_DEFAULT，不能写死 false",
      catchBlock.contains("ENTRY_UI_V2_DEFAULT"),
    )
    assertFalse(
      "catch 分支不得写死 false（会让读失败静默退回旧实现）",
      catchBlock.contains("false"),
    )
  }
}
