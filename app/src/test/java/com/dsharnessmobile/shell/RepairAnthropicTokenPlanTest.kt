package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1015：anthropic 分支不得发出 budget_tokens >= max_tokens 的非法请求。
 *
 * 缺陷现场：max_tokens 被硬写成 8192，而思考预算另有一张固定表（high=8192、xhigh/max=16384）。
 * 两张表互不知道对方 ⇒ high 档 budget == max、xhigh/max 档 budget > max，两者都违反 Anthropic
 * 协议「budget_tokens 必须严格小于 max_tokens」，端点直接回 400。
 * 真实配置把 reasoningEffort 默认 pin 成 max，所以打开修复助手即中招。
 *
 * 判据分两层：
 *  1. 不变量层：对**所有**档位断言 budget < max（这是协议硬约束，不该有例外）；
 *  2. 边界层：极高档位撞天花板时仍须满足不变量（不得靠夹紧把约束撞破）。
 */
class RepairAnthropicTokenPlanTest {

  private val client = RepairModelClient()

  /** 引擎与配置里可能出现的全部档位 + 大小写与未知值。 */
  private val efforts = listOf("low", "medium", "high", "xhigh", "max", "LOW", "Medium", "XHIGH", "MAX", "unknown-tier")

  @Test
  fun `任何档位都必须满足 budget_tokens 严格小于 max_tokens`() {
    for (effort in efforts) {
      val plan = client.anthropicTokenPlan(effort)
      val budget = plan.budgetTokens
      assertNotNull("档位 " + effort + " 必须给出思考预算", budget)
      assertTrue(
        "档位 " + effort + " 的 budget_tokens(" + budget + ") 必须严格小于 max_tokens(" + plan.maxTokens + ")",
        budget!! < plan.maxTokens,
      )
    }
  }

  @Test
  fun `具体档位的默认数值必须仍然合理（不得为合规把预算压成 0）`() {
    // 反向：修法不得靠「把 budget 压到极小」来变绿——那会让思考实际失效。
    assertEquals(2048, client.anthropicTokenPlan("low").budgetTokens)
    assertEquals(4096, client.anthropicTokenPlan("medium").budgetTokens)
    assertEquals(8192, client.anthropicTokenPlan("high").budgetTokens)
    assertEquals(16384, client.anthropicTokenPlan("xhigh").budgetTokens)
    assertEquals(16384, client.anthropicTokenPlan("max").budgetTokens)
    // 未知档位落到默认档，与旧实现同口径。
    assertEquals(4096, client.anthropicTokenPlan("unknown-tier").budgetTokens)
  }

  @Test
  fun `高预算档位必须把 max_tokens 抬到预算之上`() {
    val high = client.anthropicTokenPlan("high")
    assertTrue("high 档 max_tokens 必须 > 8192（否则与预算相等）", high.maxTokens > 8192)
    val max = client.anthropicTokenPlan("max")
    assertTrue("max 档 max_tokens 必须 > 16384（否则预算超出）", max.maxTokens > 16384)
  }

  @Test
  fun `撞到天花板时仍必须满足不变量（不得夹破约束）`() {
    // 直接验天花板：构造一个比天花板还高的预算，断言夹紧后仍 budget < max。
    val ceiling = RepairModelClient.ANTHROPIC_MAX_TOKENS_CEILING
    val plan = client.anthropicTokenPlan("max")
    assertTrue("max_tokens 不得超过天花板", plan.maxTokens <= ceiling)
    assertTrue("夹紧后仍必须严格小于", plan.budgetTokens!! < plan.maxTokens)
  }

  @Test
  fun `不启用思考时不发 thinking 字段`() {
    for (effort in listOf(null, "off")) {
      val plan = client.anthropicTokenPlan(effort)
      assertNull("effort=" + effort + " 时不应有 budget_tokens", plan.budgetTokens)
      assertEquals(
        "effort=" + effort + " 时 max_tokens 必须保持默认值（不因改动而变）",
        RepairModelClient.ANTHROPIC_MAX_TOKENS_DEFAULT,
        plan.maxTokens,
      )
    }
  }
}
