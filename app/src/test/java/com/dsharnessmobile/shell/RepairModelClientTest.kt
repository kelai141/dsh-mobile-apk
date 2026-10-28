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
}
