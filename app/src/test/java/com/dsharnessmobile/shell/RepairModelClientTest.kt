package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RepairModelClientTest {
  @Test
  fun onlyIdenticalTransportFailuresAreRetried() {
    val client = RepairModelClient()

    assertTrue(client.isTransientTransportFailure("模型连接失败：Socket closed"))
    assertTrue(client.isTransientTransportFailure("模型连接失败：Connection reset"))
    assertTrue(client.isTransientTransportFailure("模型连接失败：unexpected end of stream"))
    assertFalse(client.isTransientTransportFailure(
      "模型请求失败（HTTP 400）：tool calls and tool results do not match",
    ))
    assertFalse(client.isTransientTransportFailure(
      "模型端点返回重定向（HTTP 302）；为避免凭据发送到其它域，已拒绝跟随",
    ))
  }

  /** M-R4：结构化判定——"error": null 的正常回答不得被误判为接口错误。 */
  @Test
  fun gatewayErrorIgnoresNullErrorFieldOnAnOtherwiseNormalResponse() {
    val client = RepairModelClient()
    assertNull(
      "自建网关常见的 error:null 形态不是错误",
      client.gatewayErrorOf("""{"choices":[{"message":{"role":"assistant","content":"修好了"}}],"error":null}""", "sk-x"),
    )
    assertNull("没有 error 键的正常回答", client.gatewayErrorOf("""{"choices":[{"message":{"role":"assistant","content":"done"}}]}""", "sk-x"))
    assertNull(
      "error.message 为 null/NULL 不算错误（optString 的 \"null\" 陷阱）",
      client.gatewayErrorOf("""{"error":{"message":null}}""", "sk-x"),
    )
  }

  /** M-R3：真错误的回显消息必须与 post() 同口径替换 apiKey。 */
  @Test
  fun gatewayErrorRedactsTheApiKeyFromEchoedMessages() {
    val client = RepairModelClient()
    val message = client.gatewayErrorOf("""{"error":{"message":"invalid key sk-secret-123 for auth"}}""", "sk-secret-123")
    assertNotNull(message)
    assertFalse("回显里的 apiKey 必须被打码", message!!.contains("sk-secret-123"))
    assertTrue(message.contains("***"))
  }

  /** 真 error 结构仍要如实上报（不被 M-R4 的收紧吞掉）。 */
  @Test
  fun gatewayErrorStillReportsRealErrorObjects() {
    val client = RepairModelClient()
    assertEquals("模型接口错误：quota exceeded", client.gatewayErrorOf("""{"error":{"message":"quota exceeded"}}""", "sk-x"))
  }

  /** M4（2026-10-28 扫描）：空 apiKey 时不得走字面 replace("")——那会在每个字符间插 *** 把消息毁成乱码。 */
  @Test
  fun gatewayErrorWithEmptyApiKeyKeepsTheMessageIntact() {
    val client = RepairModelClient()
    assertEquals(
      "空凭据没有可打码的内容，消息必须原样保留",
      "模型接口错误：quota exceeded",
      client.gatewayErrorOf("""{"error":{"message":"quota exceeded"}}""", ""),
    )
  }

  // ── 端点准入（用户 2026-11-01 明确要求：允许本地地址与明文 HTTP）───────────
  //
  // 旧实现只放行 https:// 与两个回环字面量，于是自建网关（局域网 IP、内网域名、
  // http://host:8000/v1）在修复助手里被判「端点不合法」——引擎能用、助手用不了。
  // 平台侧 network_security_config 的 base-config 早已 cleartextTrafficPermitted="true"，
  // 所以这是「准入面与平台面对齐」，不是新开明文口子。

  private fun base(raw: String): String? = RepairModelClient().normalizeModelBase(raw)

  /**
   * 走真实准入路径（[RepairModelClient.endpointFor]），而不是只测规范化函数。
   *
   * 这一点是实测教训：只钉 normalizeModelBase 时，把 endpointFor 改回旧的 https-only 白名单
   * 负控**不会红**——测试绕过了被改的那一层。这里返回 null 表示「被拒」，否则返回拼好的端点。
   */
  private fun admit(raw: String, api: String = "openai-completions"): String? = runCatching {
    RepairModelClient().endpointFor(
      RepairModelConnection(
        provider = "probe", providerLabel = "Probe", modelLabel = "m", model = "m",
        baseUrl = raw, api = api, key = "sk-test",
      ),
    )
  }.getOrNull()

  @Test
  fun plainHttpAndLocalEndpointsAreAccepted() {
    // 用户 2026-11-01 明确列出的 6 条接受例（自部署/局域网模型）。
    //
    // 全部走 admit()（= endpointFor 真实准入 + 拼路径），而不是只测 normalizeModelBase：
    // 只测规范化函数时，把准入改回旧白名单这条负控**不会红**（测试绕过了被改的那一层）。
    assertEquals("https://api.x.com/chat/completions", admit("https://api.x.com"))
    assertEquals("http://192.168.1.10:8000/v1/chat/completions", admit("http://192.168.1.10:8000/v1"))
    assertEquals("http://10.0.0.5/chat/completions", admit("http://10.0.0.5"))
    assertEquals("http://[::1]:1234/chat/completions", admit("http://[::1]:1234"))
    assertEquals("http://localhost:8080/chat/completions", admit("http://localhost:8080"))
    assertEquals("http://myserver.lan:3000/v1/chat/completions", admit("http://myserver.lan:3000/v1"))
    // 172.16-31 段同样放行（自部署常见网段），规范化结果单独钉一遍。
    assertEquals("http://172.20.3.4:9000/v1/chat/completions", admit("http://172.20.3.4:9000/v1"))
    assertEquals("http://192.168.1.10:8000/v1", base("http://192.168.1.10:8000/v1"))
  }

  @Test
  fun endpointNormalizationKeepsPortAndPathPrefix() {
    // 末尾斜杠收敛：否则 "…/v1/" + "/chat/completions" 会拼出双斜杠。
    assertEquals("http://host:8000/v1", base("http://host:8000/v1/"))
    assertEquals("http://host:8000/v1", base("  http://host:8000/v1//  "))
    // 显式端口与路径前缀必须原样保留，否则自建网关的 /v1 前缀会丢。
    assertTrue(base("http://host:8000/v1")!!.endsWith(":8000/v1"))
  }

  @Test
  fun nonHttpSchemesAndCredentialBearingUrlsAreRejected() {
    // 用户 2026-11-01 明确列出的 4 条拒绝例（同样走真实准入路径）。
    assertNull("空 host 不接受", admit("http://"))
    assertNull("空 host（带斜杠）不接受", admit("http:///v1"))
    assertNull("ftp:// 不是模型端点", admit("ftp://host/v1"))
    assertNull("file:/// 不是模型端点", admit("file:///x"))
    assertNull("http://user:pw@h/v1 必须拒绝（userinfo 会进对端日志与重定向链）", admit("http://user:pw@h/v1"))
    // 规范化函数层面的同一批拒绝（两道都要守住）。
    assertNull("空 host 不接受（规范化层）", base("http://"))
    assertNull("ftp:// 不接受（规范化层）", base("ftp://host/v1"))
    // 放宽的边界：仍然是「只放行 http(s)」，content:// 与 javascript: 不在其中。
    assertNull("content:// 不放行", base("content://media/external/images/1"))
    assertNull("javascript: 不放行", base("javascript:alert(1)"))
    assertNull("data: 不放行", base("data:text/plain,x"))
    assertNull("空串不接受", base(""))
    assertNull("https 内嵌账号密码同样拒绝", base("https://user:pass@api.example/v1"))
  }

  @Test
  fun queryStringSurvivesPathAppendInsteadOfSwallowingIt() {
    // 自部署网关常见 http://host:8000/v1?token=…：路径必须插在查询串之前。
    assertEquals(
      "http://host:8000/v1/chat/completions?token=abc",
      RepairModelClient().appendEndpointPath("http://host:8000/v1?token=abc", "/chat/completions"),
    )
    assertEquals(
      "http://host:8000/v1/messages?token=abc",
      RepairModelClient().appendEndpointPath("http://host:8000/v1?token=abc", "/messages"),
    )
    assertEquals(
      "http://host:8000/v1/chat/completions",
      RepairModelClient().appendEndpointPath("http://host:8000/v1", "/chat/completions"),
    )
  }

  @Test
  fun urlQueryStringsNeverReachFailureText() {
    // 放宽明文后端点可能带 token；异常消息会把整条 URL 带出来，进聊天记录与诊断包。
    val redacted = RepairModelClient().redactUrlQuery(
      "模型连接失败：failed to connect to http://192.168.1.10:8000/v1?token=sk-live-abcdef (port 8000)",
    )
    assertFalse("查询串内容不得出现", redacted.contains("sk-live-abcdef"))
    assertTrue("路径仍要保留，否则用户没法定位端点", redacted.contains("http://192.168.1.10:8000/v1"))
    assertTrue("必须显式标出被抹掉", redacted.contains("<redacted>"))
    // 无查询串的文本原样保留（不误伤普通路径）。
    val plain = "模型连接失败：Connection refused"
    assertEquals(plain, RepairModelClient().redactUrlQuery(plain))
  }

  @Test
  fun ipv6LoopbackKeepsItsBrackets() {
    assertEquals("http://[::1]:8000/v1", base("http://[::1]:8000/v1"))
    assertEquals("https://[2001:db8::1]/v1", base("https://[2001:db8::1]/v1"))
    assertNull("未闭合的 IPv6 方括号不接受", base("http://[::1:8000/v1"))
  }

  @Test
  fun admissionPathAcceptsLanAndDomainEndpoints() {
    assertEquals("http://192.168.1.20:8000/v1/chat/completions", admit("http://192.168.1.20:8000/v1"))
    assertEquals("http://my-nas.local:1234/v1/chat/completions", admit("http://my-nas.local:1234/v1"))
    assertEquals("http://124.220.238.163:40810/v1/chat/completions", admit("http://124.220.238.163:40810/v1"))
    assertEquals("https://api.deepseek.com/anthropic/v1/messages", admit("https://api.deepseek.com/anthropic", "anthropic-messages"))
  }

  @Test
  fun admissionPathRejectsWhatMustStayRejected() {
    assertNull("file:// 必须被准入层拒绝", admit("file:///etc/passwd"))
    assertNull("javascript: 必须被准入层拒绝", admit("javascript:alert(1)"))
    assertNull("空 host 必须被准入层拒绝", admit("http:///v1"))
    assertNull("内嵌账号密码必须被准入层拒绝", admit("http://user:pass@host:8000/v1"))
  }
}