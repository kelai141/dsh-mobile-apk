package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test

class BrowserHostNavigationPolicyTest {
  @Test
  fun normalizesOrdinaryHttpAddresses() {
    assertEquals("https://example.com", BrowserHostNavigationPolicy.normalize("example.com"))
    assertEquals("http://example.com/path", BrowserHostNavigationPolicy.normalize("http://example.com/path"))
    assertEquals("about:blank", BrowserHostNavigationPolicy.normalize("about:blank"))
  }

  @Test
  fun rejectsLocalTrustedAndNonHttpSchemes() {
    for (value in listOf(
      "http://127.0.0.1:3080/", "http://localhost:3080/", "http://0.0.0.0/",
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
  //   http://2130706433:3080/   十进制整数
  //   http://0x7f000001:3080/   十六进制
  //   http://017700000001:3080/ 八进制
  //   http://0177.0.0.1:3080/   混合八进制的点分写法
  //   http://127.1:3080/        inet_aton 的「最后一段填充剩余字节」
  //   http://[::ffff:7f00:1]/   IPv4-mapped IPv6
  //   http://localhost.:3080/   结尾点（FQDN 根点）
  // 叠加「引擎鉴权 cookie 在进程级 CookieManager 里」，绕过的后果是**以已登录身份读引擎 API**。
  @Test
  fun rejectsLoopbackEquivalentsThatChromiumNormalizesToIp() {
    for (value in listOf(
      "http://2130706433:3080/", "http://0x7f000001:3080/", "http://017700000001:3080/",
      "http://0177.0.0.1:3080/", "http://0177.0.0.1/", "http://127.1:3080/", "http://127.0.1/",
      "http://[::ffff:7f00:1]/", "http://[::ffff:127.0.0.1]/", "http://[0:0:0:0:0:ffff:7f00:1]/",
      "http://localhost.:3080/", "http://LOCALHOST/", "http://localhost./",
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
      "http://127.0.0.1:3080/" to "loopback",
      "http://2130706433:3080/" to "loopback",
      "http://localhost:3080/api/x" to "loopback",
      "http://[::ffff:7f00:1]:3080/" to "loopback",
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

  // ── 审查 §3.1-C3：jsString 必须转义 U+2028/U+2029（Chromium < 92 上是 SyntaxError） ──────
  //
  // 缺陷形态：`JSONObject.quote` 只处理引号/反斜杠与控制字符（< 0x20），**不转义行分隔符**；
  // 而 ES2019 之前 U+2028/U+2029 出现在字符串字面量里即语法错误 —— 模型输入一段含行分隔符的正文时
  // 整段注入脚本解析失败，回执却报 `stale-ref`（与真因毫无关系的错误码）。
  @Test
  fun javascriptStringLiteralsEscapeLineSeparators() {
    val lineSeparator = "\u2028"
    val paragraphSeparator = "\u2029"
    for (code in listOf(lineSeparator, paragraphSeparator)) {
      val escaped = jsString("a" + code + "b")
      assertFalse("注入字面量里不得出现裸行分隔符：$escaped", escaped.contains(code))
      assertTrue("必须写成 uXXXX 转义序列（反斜杠 u 打头）：$escaped", escaped.contains("\\u20"))
    }
    // 反向对照：普通文本不得被这次转义改变（否则所有注入脚本都会变形）。
    assertEquals("\"aéb\"", jsString("aéb"))
    assertEquals("\"中文\"", jsString("中文"))
  }
}
