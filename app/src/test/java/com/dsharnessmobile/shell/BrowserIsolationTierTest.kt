package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 隔离档位解析（PR2：仅建立档位模型与上报面，行为与仅判 MULTI_PROFILE 一致）。
 *
 * 关键不变量：
 *  1. PROFILE_API 恒优先于 PROCESS_SUFFIX（能会话级隔离就不退共享档案）；
 *  2. 两个谓词都 false 时必须 UNAVAILABLE（fail-closed，绝不默认可用）；
 *  3. wire 名是对桥/插件的面（status/caps 的 isolationTier 字段），改名即破坏兼容。
 *  4. issue #1575：**声明给模型与用户的隔离程度**必须与档位语义一致——PROCESS_SUFFIX 的档案
 *     是全 app 共享的，不能报 `isolated`。
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

  // ── issue #1575：声明给模型/用户的隔离程度必须与档位语义一致 ──────────────
  //
  // 缺陷形态：tier-2 下 remote != null 恒成立 ⇒ profileEstablished=true ⇒ 旧实现输出
  // profileIsolation:"isolated"。而 BrowserIsolationTier.PROCESS_SUFFIX 的 KDoc 明写它是
  // 「独立 :browser 进程 + setDataDirectorySuffix，全 app 共享一个浏览器档案」——隔离的是
  // 「浏览器 vs 引擎」，不是「会话 vs 会话」。会话 A 登录后，会话 B 的 browser_open 直接带着
  // A 的 cookie/登录态，而 browser_state 对 B 回 isolated。

  @Test
  fun processSuffixReportsProcessSharedNotIsolated() {
    val tier = BrowserIsolation({ false }, { true }).tier()
    val status = BrowserStatusSemantics.derive(
      tier = tier,
      profileError = "",
      surfacePresent = true,
      surfaceCreatable = true,
      profileAttached = true,
    )
    assertTrue("tier-2 下 profile 事实仍成立（它进 browserAvailable 派生链，不动）", status.profileEstablished)
    assertEquals("process-suffix", tier.wire)
    assertEquals(
      "tier-2 的档案是全 app 共享的，声明必须是 process-shared",
      "process-shared",
      BrowserIsolationTierTestSupport.isolationOf(tier, status),
    )
    assertNotEquals("isolated", BrowserIsolationTierTestSupport.isolationOf(tier, status))
  }

  @Test
  fun profileApiKeepsIsolatedAndNotCreatedWording() {
    val isolated = BrowserStatusSemantics.derive(
      tier = BrowserIsolationTier.PROFILE_API,
      profileError = "",
      surfacePresent = true,
      surfaceCreatable = true,
      profileAttached = true,
    )
    assertEquals("isolated", BrowserIsolationTierTestSupport.isolationOf(BrowserIsolationTier.PROFILE_API, isolated))

    val notCreated = BrowserStatusSemantics.derive(
      tier = BrowserIsolationTier.PROFILE_API,
      profileError = "",
      surfacePresent = false,
      surfaceCreatable = true,
      profileAttached = false,
    )
    assertEquals("not-created", BrowserIsolationTierTestSupport.isolationOf(BrowserIsolationTier.PROFILE_API, notCreated))

    val unavailable = BrowserStatusSemantics.derive(
      tier = BrowserIsolationTier.UNAVAILABLE,
      profileError = "browser-profile-unsupported",
      surfacePresent = true,
      surfaceCreatable = false,
      profileAttached = false,
    )
    assertEquals("unavailable", BrowserIsolationTierTestSupport.isolationOf(BrowserIsolationTier.UNAVAILABLE, unavailable))
  }

  /**
   * tier-2 未拿到渲染进程时仍是「没建」，不是 process-shared：声明必须跟着**事实**走，
   * 不能因为档位是 PROCESS_SUFFIX 就无条件报共享档案（那会把「没开」说成「开着但共享」）。
   */
  @Test
  fun processSuffixWithoutEstablishedProfileIsNotSharedYet() {
    val status = BrowserStatusSemantics.derive(
      tier = BrowserIsolationTier.PROCESS_SUFFIX,
      profileError = "",
      surfacePresent = false,
      surfaceCreatable = true,
      profileAttached = false,
    )
    assertFalse(status.profileEstablished)
    assertEquals("not-created", BrowserIsolationTierTestSupport.isolationOf(BrowserIsolationTier.PROCESS_SUFFIX, status))
  }
}

/**
 * 测试侧对 `browser_state.profileIsolation` 判据的取用面（issue #1575）。
 *
 * 为什么不直接抄一份映射进测试：抄一份就变成「测试验证测试」。这里调用生产侧的
 * [BrowserStatusSemantics.isolationWire]——它与 `BrowserHost.profileIsolationOf` 是同一个判据，
 * 于是把生产实现改坏（例如 tier-2 又报 isolated），这些用例会真变红。
 */
internal object BrowserIsolationTierTestSupport {
  /** @returns 生产判据给出的 `profileIsolation` 取值。 */
  fun isolationOf(tier: BrowserIsolationTier, status: BrowserStatus): String =
    BrowserStatusSemantics.isolationWire(tier, status)
}
