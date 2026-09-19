package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #184 回归：日志出口脱敏唯一入口 EngineAuth.redact。
 *
 * **0.14.1 更正（单测实测抓出的 fail-open）**：本测试原有一条
 * `doesNotTouchShortTokenLookalikes`，断言「不足 40 字符的 ?token= 不替换」——那是把
 * **提取用**正则 [EngineAuth.TOKEN_RE]（带 `{40,}` 下限，用于防误命中）**复用到脱敏出口**的
 * 后果：令牌短于 40 位时脱敏完全不生效 → 真令牌原样落进日志/诊断包。该断言把缺陷固化成
 * 「期望行为」，故本轮**反转**为 fail-closed：只要形态像 `?token=` 就一律打码。
 * 取舍方向明确：多打码无害（日志里一个非敏感参数被打码不影响排障），漏打码 = 泄漏。
 */
class LogRedactionTest {

  private val token = "ZPBs2spM1bfLo10cQwEOjV13FvNHBRE0fWd-hGKUG_U" // 43 字符，与产线同形态
  private val line = "dsh web: http://127.0.0.1:3080/?token=$token"

  @Test
  fun redactsSingleTokenLine() {
    val out = EngineAuth.redact("boot ok\n$line\ndone")
    assertFalse("令牌不得残留", out.contains(token))
    assertTrue("必须打码为 token=***", out.contains("token=***"))
    assertTrue("非令牌行不受影响", out.contains("boot ok") && out.contains("done"))
  }

  @Test
  fun redactsBothTokensOnLanLine() {
    // LAN 通告行含两个 token（本机 + 局域网地址，见 web-app.spec:146）
    val lan = "dsh web: http://192.168.1.8:3080/?token=$token  dsh web: http://127.0.0.1:3080/?token=$token"
    val out = EngineAuth.redact(lan)
    assertEquals("双令牌全部替换", 0, out.split(token).size - 1)
    assertEquals("两次替换", 2, out.split("token=***").size - 1)
  }

  @Test
  fun keepsLinesWithoutTokens() {
    val plain = "2026-09-12 00:00:00.000 dsh-shell: engine started\nexit code 0\n"
    assertEquals(plain, EngineAuth.redact(plain))
  }

  @Test
  fun redactsShortTokenLookalikesToo() {
    // **反转点**（原用例名 doesNotTouchShortTokenLookalikes，断言「不替换」= fail-open）：
    // 短令牌同样必须被打码。反证：把 redact 改回用 TOKEN_RE（{40,} 下限）→ 本用例判红。
    val short = "dsh web: http://127.0.0.1:3080/?token=abc123"
    val out = EngineAuth.redact(short)
    assertFalse("短令牌也不得残留", out.contains("abc123"))
    assertTrue("短令牌同样打码", out.contains("token=***"))
  }

  @Test
  fun redactionIsIndependentFromTheExtractionRegex() {
    // 两个正则**刻意分开**（0.14.1）：TOKEN_RE 用于提取（带 40 位下限防误命中），
    // REDACT_RE 用于脱敏（无下限，fail-closed）。断言提取能力未被脱敏改动影响。
    val m = EngineAuth.TOKEN_RE.find(line)
    assertTrue("提取正则必须仍能解析产线形态", m != null)
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
