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
 * 根因（旧实现的两代写法）：先是 `settings.yaml.imported` 这个 marker 被当成「以后别读
 * settings.yaml」的开关，后来放宽成「patch 层没有任何候选时才回落读它」。两者是同一个误判的
 * 两种强度：marker 只证明**曾经**迁过，既不证明**迁移目标现在还在**，也不证明用户的 provider
 * 都搬进了 patch。只要 patch 层碰巧产出一条候选（哪怕用户根本没在用那条路由），settings.yaml
 * 里真正被选中的那条就彻底不见了——助手报「未读到可用模型」，引擎却明明能用。
 *
 * 本类钉的是**铺底**契约（它取代了已删除的回落契约）：settings.yaml 永远是最低优先级的一层，
 * 无条件读、无条件参与；patch 只在同一个插件 id 上深合并覆盖它，没有任何标记能把它关掉。
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

  // ── 1. 核心缺陷：marker 在，settings.yaml 照样要读 ────────────────────────

  @Test
  fun `marker 存在但没有 profile patch 时照常读 settings yaml`() {
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
  fun `profile patch 无法解析时 settings yaml 不受连累`() {
    marker()
    legacyProvider()
    File(home, ".dsh/profiles/web/cordis.patch.yml").writeText("- id: x\n    config: broken-indent\n")
    val result = RepairModelConfig.loadDetailed(home)
    assertEquals("坏 patch 不该连累旧配置", 1, result.connections.size)
    assertEquals("legacy-model", result.connections.single().model)
  }

  @Test
  fun `profile patch 不含模型配置时 settings yaml 照常参与`() {
    marker()
    legacyProvider()
    // 合法 YAML、能解析、但只有别的插件——迁移后用户只改过 persona。
    File(home, ".dsh/profiles/web/cordis.patch.yml").writeText(
      "- id: persona\n  config:\n    prompt: hello\n")
    val result = RepairModelConfig.loadDetailed(home)
    assertEquals("没有模型键的 patch 不该挡住旧配置", 1, result.connections.size)
    assertEquals("legacy-model", result.connections.single().model)
  }

  // ── 2. 铺底不越级：patch 只在同一 id 上覆盖，关不掉 settings.yaml ──────────

  @Test
  fun `patch 有候选时 settings yaml 仍无条件铺底`() {
    marker()
    legacyProvider()
    // settings.yaml 里再放一条 patch 从未碰过的 provider：铺底一旦被关掉，它会整条消失。
    File(home, ".dsh/settings.yaml").appendText(
      "llm-pi-ai:\n  providers:\n    legacy-route:\n      apiKeyEnv: DEEPSEEK_API_KEY\n" +
        "      baseURL: https://legacy.example/v1\n      models:\n        - id: legacy-model\n")
    File(home, ".dsh/profiles/web/cordis.patch.yml").writeText(
      "- id: llm-deepseek\n  config:\n    baseURL: https://active.example/anthropic\n    model: active-model\n")
    val result = RepairModelConfig.loadDetailed(home)
    val statuses = result.sources.joinToString { it.path + "=" + it.status }
    assertEquals("settings.yaml 必须无条件铺底：patch 没碰过的 provider 仍在（实际：" + statuses + "）",
      2, result.connections.size)
    assertTrue("patch 没碰过的 provider 只能来自 settings.yaml",
      result.connections.any { it.provider == "legacy-route" && it.model == "legacy-model" })
    // 同一个 id 上 patch 覆盖 settings（深合并）：settings 里的 legacy-model 不该再生效。
    assertEquals("同一 id 上 patch 覆盖 settings", "active-model",
      result.connections.single { it.provider == "deepseek-official" }.model)
    assertTrue("settings.yaml 必须记为已读取（实际：" + statuses + "）",
      result.sources.any { it.path.endsWith("settings.yaml") && it.status == "parsed" })
    assertTrue("已删除的回落/跳过状态不得再出现（实际：" + statuses + "）",
      result.sources.none { it.status == "fallback-used" || it.status == "skipped-legacy" })
  }

  @Test
  fun `无 marker 时读 settings yaml 且不重复计候选`() {
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
