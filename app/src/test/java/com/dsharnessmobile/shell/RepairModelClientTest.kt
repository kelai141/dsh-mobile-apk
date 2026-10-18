package com.dsharnessmobile.shell

import org.junit.Assert.assertFalse
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
}
