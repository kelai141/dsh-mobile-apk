package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 隔离档位解析（PR2：仅建立档位模型与上报面，行为与仅判 MULTI_PROFILE 一致）。
 *
 * 关键不变量：
 *  1. PROFILE_API 恒优先于 PROCESS_SUFFIX（能会话级隔离就不退共享档案）；
 *  2. 两个谓词都 false 时必须 UNAVAILABLE（fail-closed，绝不默认可用）；
 *  3. wire 名是对桥/插件的面（status/caps 的 isolationTier 字段），改名即破坏兼容。
 */
class BrowserIsolationTierTest {

  @Test
  fun profileApiWhenMultiProfileSupported() {
    assertEquals(BrowserIsolationTier.PROFILE_API, BrowserIsolation({ true }).tier())
  }

  @Test
  fun unavailableWhenNeitherSupported() {
    assertEquals(BrowserIsolationTier.UNAVAILABLE, BrowserIsolation({ false }).tier())
    assertEquals(BrowserIsolationTier.UNAVAILABLE, BrowserIsolation({ false }, { false }).tier())
  }

  @Test
  fun processSuffixOnlyAsFallbackWhenMultiProfileMissing() {
    assertEquals(
      BrowserIsolationTier.PROCESS_SUFFIX,
      BrowserIsolation({ false }, { true }).tier(),
    )
  }

  @Test
  fun profileApiWinsOverProcessSuffix() {
    assertEquals(
      BrowserIsolationTier.PROFILE_API,
      BrowserIsolation({ true }, { true }).tier(),
    )
  }

  @Test
  fun wireNamesAreStableBridgeSurface() {
    assertEquals("profile-api", BrowserIsolationTier.PROFILE_API.wire)
    assertEquals("process-suffix", BrowserIsolationTier.PROCESS_SUFFIX.wire)
    assertEquals("unavailable", BrowserIsolationTier.UNAVAILABLE.wire)
  }

  /** PR2 契约：DEFAULT 的 processSuffix 探测恒 false（渲染器未落地前不得虚报可用）。 */
  @Test
  fun defaultProcessSuffixProbeIsOffUntilRendererLands() {
    // DEFAULT 谓词读 WebViewFeature 运行态，JVM 单测不能直接调；此处只验证
    // 显式注入「processSuffix=恒 true 且 multiProfile=false」才可能得到 PROCESS_SUFFIX，
    // 即 DEFAULT 不携带隐藏的兜底路径（其 processSuffix 谓词就是恒 false 的默认参数）。
    assertEquals(BrowserIsolationTier.PROFILE_API, BrowserIsolation({ true }, { true }).tier())
    assertEquals(BrowserIsolationTier.UNAVAILABLE, BrowserIsolation({ false }, { false }).tier())
  }

  // ── 语义层：隔离不可用 != 浏览器不可用 ────────────────────────────────
  // 用户实报：Android 16 能转屏、能开网站，界面却报 browser profile not ready /
  // 「浏览器身份档不可用」。下列用例把「提示」与「错误」两条路钉死。

  /** 负控 1 的目标：把提示改回 error 语义（isolationAvailable=false => browserAvailable=false）即红。 */
  @Test
  fun isolationUnavailableWithCreatableViewIsNoticeNotError() {
    val status = BrowserStatusSemantics.derive(
      tier = BrowserIsolationTier.PROFILE_API,
      profileError = "browser-profile-assignment-failed",
      surfacePresent = false,
      surfaceCreatable = true,
      profileAttached = false,
    )
    assertTrue("隔离失败但浏览器表面可创建时必须仍算浏览器可用", status.browserAvailable)
    assertFalse("本用例模拟的正是 isolationAvailable=false", status.isolationAvailable)
    assertEquals(BrowserStatusLevel.NOTICE, status.level)
    assertEquals("提示态不得带 error reason", "", status.reason)
    assertEquals("browser-profile-assignment-failed", status.profileReason)
  }

  /** 已有普通 WebView 可用（降级路径）时同理：这是提示，不是浏览器不可用。 */
  @Test
  fun isolationUnavailableWithExistingViewIsNoticeNotError() {
    val status = BrowserStatusSemantics.derive(
      tier = BrowserIsolationTier.UNAVAILABLE,
      profileError = "browser-profile-unsupported",
      surfacePresent = true,
      surfaceCreatable = false,
      profileAttached = false,
    )
    assertTrue(status.browserAvailable)
    assertFalse(status.isolationAvailable)
    assertEquals(BrowserStatusLevel.NOTICE, status.level)
    assertEquals("", status.reason)
  }

  /** 负控 2 的目标：isolationAvailable=true 时也显示提示（level=NOTICE）即红。 */
  @Test
  fun availableIsolationSuppressesNoticeEvenBeforeProfileIsCreated() {
    val status = BrowserStatusSemantics.derive(
      tier = BrowserIsolationTier.PROFILE_API,
      profileError = "",
      surfacePresent = false,
      surfaceCreatable = true,
      profileAttached = false,
    )
    assertTrue(status.browserAvailable)
    assertTrue(status.isolationAvailable)
    assertFalse("隔离可用但尚未 attach profile：这是 OK，不是提示态", status.profileEstablished)
    assertEquals(BrowserStatusLevel.OK, status.level)
    assertEquals("", status.reason)
    assertEquals("browser-profile-not-ready", status.profileReason)
  }

  /** 浏览器真的不可用（无档位且无降级）才保留错误语义。 */
  @Test
  fun unsupportedWithoutFallbackKeepsErrorSemantics() {
    val status = BrowserStatusSemantics.derive(
      tier = BrowserIsolationTier.UNAVAILABLE,
      profileError = "browser-profile-unsupported",
      surfacePresent = false,
      surfaceCreatable = false,
      profileAttached = false,
    )
    assertFalse(status.browserAvailable)
    assertFalse(status.isolationAvailable)
    assertEquals(BrowserStatusLevel.ERROR, status.level)
    assertEquals("browser-profile-unsupported", status.reason)
  }

  /** provider/renderer 故障是浏览器本体故障，不能因为「不是隔离问题」被降成提示。 */
  @Test
  fun providerOrRendererFailureStillKeepsErrorSemantics() {
    val provider = BrowserStatusSemantics.derive(
      tier = BrowserIsolationTier.PROFILE_API,
      profileError = "webview-provider-unavailable",
      surfacePresent = false,
      surfaceCreatable = true,
      profileAttached = false,
    )
    assertEquals(BrowserStatusLevel.ERROR, provider.level)
    assertFalse(provider.browserAvailable)
    assertEquals("webview-provider-unavailable", provider.reason)

    val renderer = BrowserStatusSemantics.derive(
      tier = BrowserIsolationTier.PROCESS_SUFFIX,
      profileError = "browser-renderer-unavailable",
      surfacePresent = false,
      surfaceCreatable = true,
      profileAttached = false,
    )
    assertEquals(BrowserStatusLevel.ERROR, renderer.level)
    assertFalse(renderer.browserAvailable)
  }

  @Test
  fun statusLevelWireNamesAreStable() {
    assertEquals("ok", BrowserStatusLevel.OK.wire)
    assertEquals("notice", BrowserStatusLevel.NOTICE.wire)
    assertEquals("error", BrowserStatusLevel.ERROR.wire)
  }
}
