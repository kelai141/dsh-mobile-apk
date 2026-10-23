package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.After
import org.junit.Before
import org.junit.Test

class BrowserHostNavigationPolicyTest {
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

  @Test
  fun normalizesOrdinaryHttpAddresses() {
    assertEquals("https://example.com", BrowserHostNavigationPolicy.normalize("example.com"))
    assertEquals("http://example.com/path", BrowserHostNavigationPolicy.normalize("http://example.com/path"))
    assertEquals("about:blank", BrowserHostNavigationPolicy.normalize("about:blank"))
  }

  @Test
  fun rejectsLocalTrustedAndNonHttpSchemes() {
    for (value in listOf(
      "http://127.0.0.1:4145/", "http://localhost:4145/", "http://0.0.0.0/",
      "http://[::1]/", "javascript:alert(1)", "file:///sdcard/a.txt", "content://provider/a", "data:text/html,x",
    )) {
      assertNull("must reject $value", BrowserHostNavigationPolicy.normalize(value))
    }
  }

  @Test
  fun rejectsMissingHostAndCredentialBearingAddresses() {
    assertNull(BrowserHostNavigationPolicy.normalize("https:///path"))
    assertNull(BrowserHostNavigationPolicy.normalize("https://user:pass@example.com/"))
    assertNull(BrowserHostNavigationPolicy.normalize(""))
  }

  /**
   * 中文等非 ASCII 查询串必须**按 UTF-8 百分号编码**成合法地址，且解码回原文。
   *
   * 用户实报（0.14.0）：用中文检索词搜索时返回的是**无关视频**——即查询词在某一层被改写/替换了。
   * 关键在于该层不得「静默丢字符」或「用平台默认字符集编码」：本仓储此前全部收发点都显式写
   * UTF-8（ControlPoller/MuxClient/FileIncoming 等），导航层也必须显式而非交给默认值。
   */
  @Test
  fun keepsNonAsciiQueryTextEncodedAndLossless() {
    val normalized = BrowserHostNavigationPolicy.normalize("https://example.com/s?q=影视飓风")
    assertEquals("https://example.com/s?q=%E5%BD%B1%E8%A7%86%E9%A3%93%E9%A3%8E", normalized)
    // 关键：解码回来必须与输入逐字节相同（有损替换会让模型搜到完全无关的结果）。
    val query = java.net.URI(normalized).rawQuery.removePrefix("q=")
    assertEquals("影视飓风", java.net.URLDecoder.decode(query, "UTF-8"))
  }

  // ── 审查 §3.2-S1：回环准入的**等价写法**必须一并拒绝（旧实现只判字面量） ───────────────
  //
  // 旧实现 `isLocalHost` 只认 `localhost` / `0.0.0.0` / `::1` / `127.` 前缀 / `::ffff:127.` 前缀，
  // 从不把 host 规范化成 IP；而 Chromium 会把这些写法统统解析成 127.0.0.1：
  //   http://2130706433:4145/   十进制整数
  //   http://0x7f000001:4145/   十六进制
  //   http://017700000001:4145/ 八进制
  //   http://0177.0.0.1:4145/   混合八进制的点分写法
  //   http://127.1:4145/        inet_aton 的「最后一段填充剩余字节」
  //   http://[::ffff:7f00:1]/   IPv4-mapped IPv6
  //   http://localhost.:4145/   结尾点（FQDN 根点）
  // 叠加「引擎鉴权 cookie 在进程级 CookieManager 里」，绕过的后果是**以已登录身份读引擎 API**。
  @Test
  fun rejectsLoopbackEquivalentsThatChromiumNormalizesToIp() {
    for (value in listOf(
      "http://2130706433:4145/", "http://0x7f000001:4145/", "http://017700000001:4145/",
      "http://0177.0.0.1:4145/", "http://0177.0.0.1/", "http://127.1:4145/", "http://127.0.1/",
      "http://[::ffff:7f00:1]/", "http://[::ffff:127.0.0.1]/", "http://[0:0:0:0:0:ffff:7f00:1]/",
      "http://localhost.:4145/", "http://LOCALHOST/", "http://localhost./",
      "http://[::1]/", "http://[0:0:0:0:0:0:0:1]/", "http://0/", "http://0.0.0.0/",
    )) {
      assertNull("必须拒绝回环等价写法：$value", BrowserHostNavigationPolicy.normalize(value))
    }
  }

  @Test
  fun ordinaryHostsAreStillAcceptedAndRewrittenToTheCanonicalHost() {
    // 放宽面不得被这次收紧吃掉：公网地址照旧可用。
    assertEquals("https://example.com", BrowserHostNavigationPolicy.normalize("example.com"))
    assertEquals("http://8.8.8.8/", BrowserHostNavigationPolicy.normalize("http://8.8.8.8/"))
    // **规范化后的 host 必须写回 URL**：只判定不重建仍留着「策略看 A 串、浏览器执行 B 串」的差值。
    assertEquals("十六进制写法必须被重建为点分形式（策略与执行同源）",
      "http://8.8.8.8/", BrowserHostNavigationPolicy.normalize("http://0x08080808/"))
    assertEquals("http://8.8.8.8/", BrowserHostNavigationPolicy.normalize("http://134744072/"))
    assertEquals("结尾点必须被规范化掉",
      "http://example.com/", BrowserHostNavigationPolicy.normalize("http://example.com./"))
    assertEquals("http://example.com/", BrowserHostNavigationPolicy.normalize("http://EXAMPLE.com/"))
    // 局域网设备页是 0.14.1 用户裁定要支持的场景：准入**不得**把私网拦掉。
    assertEquals("http://192.168.1.1/admin", BrowserHostNavigationPolicy.normalize("http://192.168.1.1/admin"))
  }

  // ── 审查 §3.2-S4：请求级过滤（顶层导航被查过 ≠ 子请求被查过） ─────────────────────────
  //
  // 旧实现全仓没有 shouldInterceptRequest：放行后的任意站点可用 img/iframe/script/form/fetch
  // 去打回环（引擎同源）、链路本地与元数据地址，壳侧零防线。
  @Test
  fun requestFilterBlocksLoopbackAndLinkLocalTargets() {
    for (case in listOf(
      "http://127.0.0.1:4145/" to "loopback",
      "http://2130706433:4145/" to "loopback",
      "http://localhost:4145/api/x" to "loopback",
      "http://[::ffff:7f00:1]:4145/" to "loopback",
      "http://0.0.0.0/" to "unspecified",
      "http://169.254.169.254/latest/meta-data/" to "link-local",
      "http://[fe80::1]/" to "link-local",
    )) {
      assertEquals("必须拦下：${case.first}", case.second, BrowserHostNavigationPolicy.blockedRequestReason(case.first))
    }
  }

  @Test
  fun requestFilterAllowsOrdinaryResourcesAndNonNetworkSchemes() {
    for (value in listOf(
      "https://example.com/app.js",
      "http://8.8.8.8/style.css",
      "http://192.168.1.1/logo.png",   // 局域网设备页的子资源（0.14.1 裁定支持）
      "data:image/png;base64,AAAA",
      "blob:https://example.com/abc",
      "",                               // 空串不是网络目标
    )) {
      assertNull("不得误拦：$value", BrowserHostNavigationPolicy.blockedRequestReason(value))
    }
  }

  @Test
  fun isolatedProfileAllowsCanonicalOrdinaryLoopbackInBothPolicyLayers() {
    val cases = linkedMapOf(
      "http://127.0.0.1:9090/" to "http://127.0.0.1:9090/",
      "https://127.0.0.1:8443/" to "https://127.0.0.1:8443/",
      "http://127.2.3.4/" to "http://127.2.3.4/",
      "http://2130706433:9090/" to "http://127.0.0.1:9090/",
      "http://0x7f000001:9090/" to "http://127.0.0.1:9090/",
      "http://017700000001:9090/" to "http://127.0.0.1:9090/",
      "http://0177.0.0.1:9090/" to "http://127.0.0.1:9090/",
      "http://127.1:9090/" to "http://127.0.0.1:9090/",
      "http://127.0.1:9090/" to "http://127.0.0.1:9090/",
      "http://LOCALHOST.:9090/" to "http://127.0.0.1:9090/",
      "http://app.localhost:9090/" to "http://127.0.0.1:9090/",
      "http://[::1]:9090/" to "http://[::1]:9090/",
      "http://[0:0:0:0:0:0:0:1]:9090/" to "http://[::1]:9090/",
      "http://[::ffff:7f00:1]:9090/" to "http://127.0.0.1:9090/",
      "http://[::ffff:127.0.0.1]:9090/" to "http://127.0.0.1:9090/",
      "http://[::127.0.0.1]:9090/" to "http://127.0.0.1:9090/",
    )
    for ((raw, canonical) in cases) {
      assertEquals("isolated navigation: $raw", canonical,
        BrowserHostNavigationPolicy.normalize(raw, isolatedProfile = true))
      assertNull("isolated request: $raw",
        BrowserHostNavigationPolicy.blockedRequestReason(raw, isolatedProfile = true))
      assertNull("canonical request: $canonical",
        BrowserHostNavigationPolicy.blockedRequestReason(canonical, isolatedProfile = true))
      // Merely changing a port must NEVER grant an unprofiled/Default caller loopback access.
      assertNull("unprofiled navigation: $raw", BrowserHostNavigationPolicy.normalize(raw))
      assertEquals("unprofiled request: $raw", "loopback", BrowserHostNavigationPolicy.blockedRequestReason(raw))
    }
  }

  @Test
  fun protectedEngineIsStillDeniedInIsolatedProfilesAcrossCanonicalAliases() {
    for (host in listOf("127.0.0.1", "127.1", "2130706433", "0x7f000001", "017700000001",
      "0177.0.0.1", "localhost", "LOCALHOST.", "app.localhost", "[::1]", "[::ffff:7f00:1]")) {
      for (scheme in listOf("http", "https")) {
        val url = "$scheme://$host:4145/api/anonymous-check"
        assertNull(url, BrowserHostNavigationPolicy.normalize(url, isolatedProfile = true))
        assertEquals(url, "protected-engine-origin",
          BrowserHostNavigationPolicy.blockedRequestReason(url, isolatedProfile = true))
      }
    }
  }

  @Test
  fun anonymousEngineOptInIsExplicitAndCannotSubstituteForProfileIsolation() {
    val url = "http://127.0.0.1:4145/"
    assertNull(BrowserHostNavigationPolicy.normalize(url, allowAnonymousEngineAccess = true))
    assertEquals("loopback", BrowserHostNavigationPolicy.blockedRequestReason(url, allowAnonymousEngineAccess = true))
    assertEquals(url, BrowserHostNavigationPolicy.normalize(url,
      isolatedProfile = true, allowAnonymousEngineAccess = true))
    assertNull(BrowserHostNavigationPolicy.blockedRequestReason(url,
      isolatedProfile = true, allowAnonymousEngineAccess = true))
  }

  @Test
  fun isolatedNavigationAndRequestsBothRejectUnspecifiedAndMetadataLinkLocal() {
    for ((url, reason) in listOf(
      "http://0/" to "unspecified",
      "http://0.0.0.0/" to "unspecified",
      "http://[::]/" to "unspecified",
      "http://[::ffff:0.0.0.0]/" to "unspecified",
      "http://169.254.169.254/latest/meta-data/" to "link-local",
      "http://0xa9fea9fe/latest/meta-data/" to "link-local",
      "http://[::ffff:169.254.169.254]/" to "link-local",
      "http://[fe80::1]/" to "link-local",
      "http://[febf::1]/" to "link-local",
    )) {
      for (isolated in listOf(false, true)) {
        assertNull(url, BrowserHostNavigationPolicy.normalize(url, isolatedProfile = isolated))
        assertEquals(url, reason, BrowserHostNavigationPolicy.blockedRequestReason(url, isolatedProfile = isolated))
      }
    }
  }

  @Test
  fun isolationDoesNotAdmitUserinfoUnsafeSchemesMalformedHostsOrPorts() {
    for (url in listOf(
      "http://user:password@127.0.0.1:9090/", "https://user@example.com/",
      "javascript:alert(1)", "file:///sdcard/a.txt", "content://provider/a", "intent://example.com/",
      "https:///missing-host", "http://127.0.0.1:0/", "http://127.0.0.1:65536/",
      "http://127.0.0.1:-1/", "http://127.0.0.1:/", "http://%31%32%37.0.0.1:9090/",
      "http://[fe80::1%25wlan0]/", "http://08.0.0.1/", "http://4294967296/",
    )) {
      assertNull(url, BrowserHostNavigationPolicy.normalize(url, isolatedProfile = true))
      assertTrue("request must reject $url", BrowserHostNavigationPolicy.blockedRequestReason(url, isolatedProfile = true) != null)
    }
    // Ordinary inline resources remain usable, without granting top-level data/blob navigation.
    for (url in listOf("data:image/png;base64,AAAA", "blob:https://example.com/abc")) {
      assertNull(BrowserHostNavigationPolicy.normalize(url, isolatedProfile = true))
      assertNull(BrowserHostNavigationPolicy.blockedRequestReason(url, isolatedProfile = true))
    }
  }

  @Test
  fun isolatedHttpStillSupportsLanPublicUrlsAndLosslessPathsQueriesAndFragments() {
    val url = "http://127.0.0.1:9090/a%2Fb?q=%E4%B8%AD%E6%96%87#fragment"
    assertEquals(url, BrowserHostNavigationPolicy.normalize(url, isolatedProfile = true))
    for (ordinary in listOf("http://192.168.1.1/admin", "http://10.0.2.2:9090/", "http://neverssl.com/")) {
      assertEquals(ordinary, BrowserHostNavigationPolicy.normalize(ordinary, isolatedProfile = true))
      assertNull(BrowserHostNavigationPolicy.blockedRequestReason(ordinary, isolatedProfile = true))
    }
  }

  @Test
  fun webSocketPolicyUsesTheSameProfileAndProtectedPortRules() {
    assertEquals("loopback", BrowserHostNavigationPolicy.blockedRequestReason("ws://127.0.0.1:9090/socket"))
    assertNull(BrowserHostNavigationPolicy.blockedRequestReason("ws://127.0.0.1:9090/socket", isolatedProfile = true))
    assertEquals("protected-engine-origin", BrowserHostNavigationPolicy.blockedRequestReason(
      "wss://localhost:4145/socket", isolatedProfile = true))
    assertNull(BrowserHostNavigationPolicy.normalize("ws://127.0.0.1:9090/socket", isolatedProfile = true))
  }

  @Test
  fun browserSessionProfileNamesAreStableNonDefaultAndDoNotExposeSessionIds() {
    val session = "session-test/unsafe?name:with-separators"
    val first = BrowserHostProfile.nameForSession(session)
    assertEquals(first, BrowserHostProfile.nameForSession(session))
    assertNotEquals(first, BrowserHostProfile.nameForSession("another-session"))
    assertNotEquals(first, BrowserHostProfile.nameForSession("__anonymous__"))
    assertNotEquals("Default", first)
    assertTrue(first.matches(Regex("dsh-browser-session-v1-[a-f0-9]{64}")))
    assertFalse(first.contains(session))
  }

  // ── 审查 §3.1-C3：jsString 必须转义 U+2028/U+2029（Chromium < 92 上是 SyntaxError） ──────
  //
  // 缺陷形态：`JSONObject.quote` 只处理引号/反斜杠与控制字符（< 0x20），**不转义行分隔符**；
  // 而 ES2019 之前 U+2028/U+2029 出现在字符串字面量里即语法错误 —— 模型输入一段含行分隔符的正文时
  // 整段注入脚本解析失败，回执却报 `stale-ref`（与真因毫无关系的错误码）。
  @Test
  fun javascriptStringLiteralsEscapeLineSeparators() {
    // 纯函数面：不依赖 org.json 的实现差异（Android 的 quote 不转义行分隔符，而单测类路径上的
    // org.json:json 会转义——这正是此前「恒等替换 + 断言通过」的假绿来源）。这里按**形态**判：
    val cases = linkedMapOf("\u2028" to "a\\u2028b", "\u2029" to "a\\u2029b")
    for ((code, expected) in cases) {
      val raw = "a" + code + "b"
      val escaped = escapeLineSeparators(raw)
      assertNotEquals("必须是真实替换，恒等替换等于没修：$escaped", raw, escaped)
      assertEquals("裸行分隔符必须变成字面量形态的转义文本", expected, escaped)
      assertFalse("转义后不得再有裸行分隔符：$escaped", escaped.contains(code))
      // 端到端：无论 quote 产出裸字符还是已转义文本，jsString 的输出都不得含裸行分隔符。
      val viaQuote = jsString(raw)
      assertFalse("jsString 输出不得含裸行分隔符：$viaQuote", viaQuote.contains(code))
    }
    // 反向对照：普通文本不得被这次转义改变（否则所有注入脚本都会变形）。
    assertEquals("\"aéb\"", jsString("aéb"))
    assertEquals("\"中文\"", jsString("中文"))
  }
}
