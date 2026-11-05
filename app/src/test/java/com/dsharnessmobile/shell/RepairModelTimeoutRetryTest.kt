package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1370：读超时**不得**被当成可重试的传输失败。
 *
 * 缺陷形态：`isTransientTransportFailure` 把 `timed out` / `timeout` 也算作 transient，
 * 于是一次读超时（`readTimeout = 180s`）会把同一个 body 原样再发一遍 —— 单次调用最坏 2×180s，
 * 且网关可能已经处理过第一次请求，重发就是让模型重复生成、用户重复计费。
 *
 * 判据打在「哪些失败值得重发」这条语义上：能重试的必须**没送达**，读超时属于已送达。
 */
class RepairModelTimeoutRetryTest {

  private val client = RepairModelClient()

  @Test
  fun readTimeoutIsNotRetryable() {
    assertFalse(
      "读超时意味着请求已发出，重发会让模型重复生成（issue #1370）",
      client.isTransientTransportFailure("模型连接失败：Read timed out"),
    )
    assertFalse("同上（小写形态）", client.isTransientTransportFailure("模型连接失败：timeout"))
    assertFalse(
      "同上（网关侧 timed out 文案）",
      client.isTransientTransportFailure("模型连接失败：connect timed out while reading response"),
    )
  }

  @Test
  fun connectionLevelFailuresAreStillRetryable() {
    listOf(
      "模型连接失败：Socket closed",
      "模型连接失败：Connection reset",
      "模型连接失败：Broken pipe",
      "模型连接失败：unexpected end of stream",
      "模型连接失败：Connection refused",
    ).forEach { message ->
      assertTrue("连接期失败应当仍可重试一次：" + message, client.isTransientTransportFailure(message))
    }
  }

  @Test
  fun nonTransportFailuresAreNeverRetryable() {
    assertFalse("HTTP 错误已带诊断，不得重试", client.isTransientTransportFailure("模型请求失败（HTTP 500）：boom"))
    assertFalse("协议错误不得重试", client.isTransientTransportFailure("模型响应缺少 choices"))
  }
}