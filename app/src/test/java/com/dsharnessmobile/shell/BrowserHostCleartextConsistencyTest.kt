package com.dsharnessmobile.shell

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.w3c.dom.Document
import org.w3c.dom.Element

/**
 * Cross-layer HTTP contract: admission must agree with platform cleartext availability.
 * 0.14.3 profile isolation changes loopback admission, not the platform HTTP policy:
 * ordinary loopback needs a verified nonDefault profile; protected engine :4145 stays denied.
 * Pure policy calls exercise URLs; XML parsing excludes comment-only false positives.
 */
class BrowserHostCleartextConsistencyTest {
  @Before
  fun publishProtectedPort() {
    EngineEndpoint.beginBinding()
    EngineEndpoint.markGeneration(1)
    EngineEndpoint.publishReportedPort(4145, 1)
  }

  @After
  fun resetEndpoint() {
    EngineEndpoint.invalidate()
  }

  private fun nsc(): Document {
    val file = listOf(
      File("src/main/res/xml/network_security_config.xml"),
      File("app/src/main/res/xml/network_security_config.xml"),
    ).firstOrNull { it.isFile } ?: throw AssertionError("NSC 文件缺席")
    val factory = DocumentBuilderFactory.newInstance().apply {
      setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
      setFeature("http://xml.org/sax/features/external-general-entities", false)
      setFeature("http://xml.org/sax/features/external-parameter-entities", false)
    }
    return factory.newDocumentBuilder().parse(file)
  }

  private fun assertPlatformOpen() {
    val document = nsc()
    assertEquals("network-security-config", document.documentElement.tagName)
    val base = document.getElementsByTagName("base-config")
    assertEquals("必须恰好一个 base-config", 1, base.length)
    assertEquals("准入接受 HTTP 时平台必须显式放行明文", "true",
      (base.item(0) as Element).getAttribute("cleartextTrafficPermitted"))
    assertEquals("撑开 base 明文时不能重新引入冲突 per-domain 配置", 0,
      document.getElementsByTagName("domain-config").length)
  }

  @Test
  fun publicAndLanHttpAdmissionAgreesWithPlatformPolicy() {
    assertPlatformOpen()
    for (url in listOf("http://192.168.110.40:9090/", "http://10.0.2.2:9090/", "http://neverssl.com/")) {
      for (isolated in listOf(false, true)) {
        assertNotNull("普通 LAN/公网 HTTP 不需要回环隔离资格：$url",
          BrowserHostNavigationPolicy.normalize(url, isolatedProfile = isolated))
        assertNull(BrowserHostNavigationPolicy.blockedRequestReason(url, isolatedProfile = isolated))
      }
    }
  }

  @Test
  fun ordinaryLoopbackRequiresIsolatedProfileAndRemainsPlatformReachable() {
    assertPlatformOpen()
    val ordinary = listOf(
      "http://127.0.0.1:8080/", "http://localhost:8080/", "http://app.localhost:8080/",
      "http://127.1:8080/", "http://2130706433:8080/", "http://0x7f000001:8080/",
      "http://[::1]/", "http://[::ffff:127.0.0.1]:8080/",
    )
    for (url in ordinary) {
      assertNull("Default/尚未验证 profile 的回环必须被拒：$url", BrowserHostNavigationPolicy.normalize(url))
      assertEquals("loopback", BrowserHostNavigationPolicy.blockedRequestReason(url))
      assertNotNull("已验证隔离 profile 的普通回环应可访问：$url",
        BrowserHostNavigationPolicy.normalize(url, isolatedProfile = true))
      assertNull(BrowserHostNavigationPolicy.blockedRequestReason(url, isolatedProfile = true))
    }
    assertEquals("http://127.0.0.1:8080/path?q=1#fragment",
      BrowserHostNavigationPolicy.normalize("http://LOCALHOST.:8080/path?q=1#fragment", isolatedProfile = true))
  }

  @Test
  fun protectedEnginePortStaysBlockedForEveryCanonicalLoopbackAlias() {
    for (scheme in listOf("http", "https", "ws", "wss")) {
      for (host in listOf("127.0.0.1", "localhost", "app.localhost", "127.1", "0x7f000001", "[::1]", "[::ffff:127.0.0.1]")) {
        val url = "$scheme://$host:04145/api"
        assertEquals("protected-engine-origin",
          BrowserHostNavigationPolicy.blockedRequestReason(url, isolatedProfile = true))
        if (scheme == "http" || scheme == "https") {
          assertNull("隔离不是引擎鉴权授权：$url", BrowserHostNavigationPolicy.normalize(url, isolatedProfile = true))
        }
        assertEquals("loopback", BrowserHostNavigationPolicy.blockedRequestReason(url))
      }
    }
  }

  @Test
  fun networkRequestPolicyUsesSameProfileBoundaryAndRejectsUnsafeDestinations() {
    for (url in listOf("ws://127.0.0.1:8080/socket", "wss://localhost/socket")) {
      assertEquals("loopback", BrowserHostNavigationPolicy.blockedRequestReason(url))
      assertNull(BrowserHostNavigationPolicy.blockedRequestReason(url, isolatedProfile = true))
    }
    for (url in listOf("http://0.0.0.0/", "http://169.254.169.254/", "http://[fe80::1]/", "http://user@localhost:8080/", "http://127%2e0%2e0%2e1:8080/")) {
      assertNull(BrowserHostNavigationPolicy.normalize(url, isolatedProfile = true))
      assertNotNull(BrowserHostNavigationPolicy.blockedRequestReason(url, isolatedProfile = true))
    }
    assertFalse("可信配置的引擎例外也不能使 Default profile 获得回环资格",
      BrowserHostNavigationPolicy.normalize("http://localhost:4145/", allowAnonymousEngineAccess = true) != null)
    assertTrue(BrowserHostNavigationPolicy.normalize("https://example.com:4145/", isolatedProfile = true) != null)
  }
}
