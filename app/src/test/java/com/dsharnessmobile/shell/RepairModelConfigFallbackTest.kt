package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 修复助手在「引擎已死」现场还能不能读到模型配置。
 *
 * 社群形态（2026-10-30）：用户把配置搞坏、进不了安全模式，修复助手报「未读到可用模型」，
 * 社区结论是「那没救了」。修复助手最该救的就是这个场景。
 *
 * 根因：`settings.yaml.imported` 这个 marker 被当成了「以后别读 settings.yaml」的开关。
 * 但 marker 只证明**曾经**迁过，不证明**迁移目标现在还在**——profile patch 丢了/坏了/不含 llm 键时，
 * 两边都不读，候选数为 0。
 *
 * 本类钉的是**回落**契约：活动配置读不出候选时，settings.yaml 必须仍被读。
 */
class RepairModelConfigFallbackTest {

  private lateinit var home: File

  @Before
  fun setUp() {
    home = Files.createTempDirectory("repair-model-fallback").toFile()
    File(home, ".dsh/profiles/web").mkdirs()
  }

  @After
  fun tearDown() {
    home.deleteRecursively()
  }

  private fun marker() {
    File(home, ".dsh/settings.yaml.imported").writeText("imported\n")
  }

  private fun legacyProvider() {
    File(home, ".dsh/settings.yaml").writeText(
      "llm-deepseek:\n  baseURL: https://legacy.example/anthropic\n  model: legacy-model\n")
    File(home, ".dsh/.credentials.yaml").writeText("refs:\n  DEEPSEEK_API_KEY: legacy-secret\n")
  }

  // ── 1. 核心缺陷：marker 在、profile patch 不在 → 回落读 settings.yaml ─────

  @Test
  fun `marker 存在但没有 profile patch 时回落读 settings yaml`() {
    marker()
    legacyProvider()
    // 没有 profiles/web/cordis.patch.yml，也没有 home/.dsh/cordis.patch.yml。
    val result = RepairModelConfig.loadDetailed(home)
    assertEquals("marker 不该让 settings.yaml 整体失效", 1, result.connections.size)
    assertEquals("legacy-model", result.connections.single().model)
    assertEquals("deepseek-official", result.connections.single().provider)
    assertEquals("legacy-secret", result.connections.single().apiKey)
  }

  @Test
  fun `profile patch 无法解析时回落读 settings yaml`() {
    marker()
    legacyProvider()
    File(home, ".dsh/profiles/web/cordis.patch.yml").writeText("- id: x\n    config: broken-indent\n")
    val result = RepairModelConfig.loadDetailed(home)
    assertEquals("坏 patch 不该连累旧配置", 1, result.connections.size)
    assertEquals("legacy-model", result.connections.single().model)
  }

  @Test
  fun `profile patch 不含模型配置时回落读 settings yaml`() {
    marker()
    legacyProvider()
    // 合法 YAML、能解析、但只有别的插件——迁移后用户只改过 persona。
    File(home, ".dsh/profiles/web/cordis.patch.yml").writeText(
      "- id: persona\n  config:\n    prompt: hello\n")
    val result = RepairModelConfig.loadDetailed(home)
    assertEquals("没有模型键的 patch 不该挡住旧配置", 1, result.connections.size)
    assertEquals("legacy-model", result.connections.single().model)
  }

  // ── 2. 回落不得越过活动配置：patch 有候选时以 patch 为准 ───────────────────

  @Test
  fun `profile patch 有候选时不回落到 settings yaml`() {
    marker()
    legacyProvider()
    File(home, ".dsh/profiles/web/cordis.patch.yml").writeText(
      "- id: llm-deepseek\n  config:\n    baseURL: https://active.example/anthropic\n    model: active-model\n")
    val result = RepairModelConfig.loadDetailed(home)
    assertEquals(1, result.connections.size)
    assertEquals("活动配置优先，回落不能顶掉它", "active-model", result.connections.single().model)
    // 只断言 model 不够：叠层合并本来就会让 patch 盖住 settings，即使**无条件**回落也能过。
    // 真正的契约是「活动配置有候选时根本没去回落」——用来源标记钉住它。
    assertTrue(
      "活动配置有候选时不该走回落（实际来源：" + result.sources.joinToString { it.path + "=" + it.status } + "）",
      result.sources.none { it.status == "fallback-used" },
    )
    assertTrue(
      "此时 settings.yaml 应标记为「已迁移、本轮未读」",
      result.sources.any { it.path.endsWith("settings.yaml") && it.status == "skipped-legacy" },
    )
  }

  @Test
  fun `无 marker 时仍优先读 settings yaml 且不重复计候选`() {
    legacyProvider()
    val result = RepairModelConfig.loadDetailed(home)
    assertEquals("同一份配置只算一条", 1, result.connections.size)
    assertEquals("legacy-model", result.connections.single().model)
  }

  // ── 3. 「没配置」与「配了但缺凭据」必须能分开 ─────────────────────────────

  @Test
  fun `配了 provider 但缺凭据时来源要说明为什么没候选`() {
    marker()
    File(home, ".dsh/settings.yaml").writeText(
      "llm-deepseek:\n  baseURL: https://legacy.example/anthropic\n  model: legacy-model\n")
    // 没有任何 .credentials.yaml，也没有环境变量。
    val result = RepairModelConfig.loadDetailed(home)
    assertTrue("没有凭据就确实没有候选", result.connections.isEmpty())
    // 但用户必须能看出「配置文件是好的，缺的是凭据」。
    assertTrue(
      "来源里必须留下可判读的说明（实际：" + result.sources.joinToString { it.path + "=" + it.status } + "）",
      result.sources.any { it.status == "no-credential" },
    )
  }

  @Test
  fun `完全没有配置文件时如实报 missing 而不是假装读过`() {
    marker()
    val result = RepairModelConfig.loadDetailed(home)
    assertTrue(result.connections.isEmpty())
    assertTrue("settings.yaml 不存在必须出现在来源表里",
      result.sources.any { it.path.endsWith("settings.yaml") && it.status == "missing" })
  }
}