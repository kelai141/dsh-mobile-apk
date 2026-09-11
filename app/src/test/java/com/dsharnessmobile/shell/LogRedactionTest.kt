package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #184 回归：日志出口脱敏唯一入口 EngineAuth.redact（正则来源 = TOKEN_RE，与
 * tokenFromLog 解析同源）。表驱动覆盖单令牌 / LAN 双令牌 / 无令牌 / 短令牌不误伤。
 */
class LogRedactionTest {

  private val token = "ZPBs2spM1bfLo10cQwEOjV13FvNHBRE0fWd-hGKUG_U" // 43 字符，与产线同形态
  private val line = "dsh web: http://127.0.0.1:3080/?token=$token"

  @Test
  fun redactsSingleTokenLine() {
    val out = EngineAuth.redact("boot ok\n$line\ndone")
    assertFalse("令牌不得残留", out.contains(token))
    assertTrue("保留 URL 形状", out.contains("dsh web: ***?token=***"))
    assertTrue("非令牌行不受影响", out.contains("boot ok") && out.contains("done"))
  }

  @Test
  fun redactsBothTokensOnLanLine() {
    // LAN 通告行含两个 token（本机 + 局域网地址，见 web-app.spec:146）
    val lan = "dsh web: http://192.168.1.8:3080/?token=$token  dsh web: http://127.0.0.1:3080/?token=$token"
    val out = EngineAuth.redact(lan)
    assertEquals("双令牌全部替换", 0, out.split(token).size - 1)
    assertEquals("两次替换", 2, out.split("***?token=***").size - 1)
  }

  @Test
  fun keepsLinesWithoutTokens() {
    val plain = "2026-09-12 00:00:00.000 dsh-shell: engine started\nexit code 0\n"
    assertEquals(plain, EngineAuth.redact(plain))
  }

  @Test
  fun doesNotTouchShortTokenLookalikes() {
    // 不足 40 字符的 ?token= 不匹配产线正则——避免误伤其他 URL 参数
    val short = "dsh web: http://127.0.0.1:3080/?token=abc123"
    assertEquals(short, EngineAuth.redact(short))
  }

  @Test
  fun regexIsSameSourceAsTokenParser() {
    // 同一正则必须既能解析（tokenFromLog）又能脱敏——防止两份正则漂移
    val m = EngineAuth.TOKEN_RE.find(line)
    assertTrue(m != null)
    assertEquals(token, m!!.groupValues[1])
  }

  @Test
  fun emptyAndBinarySafe() {
    assertEquals("", EngineAuth.redact(""))
    val weird = "dsh web: /?token=" + "A".repeat(50) + "\u4e2d\u6587"
    assertFalse(EngineAuth.redact(weird).contains("A".repeat(50)))
    assertTrue(EngineAuth.redact(weird).contains("\u4e2d\u6587"))
  }
}
