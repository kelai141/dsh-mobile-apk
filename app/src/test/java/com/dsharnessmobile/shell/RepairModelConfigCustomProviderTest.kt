package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Red-first fixtures for the repair assistant's "no model available" false negative.
 *
 * Both cases describe a phone that really can run the engine: the user picked a custom
 * OpenAI-compatible provider (or a newer subscription provider) in "设置 → 模型". A repair
 * loop that cannot see that route tells the user "DSH 尚无可用模型配置" and cannot repair
 * anything, even though normal startup works.
 *
 * A: the migration marker `settings.yaml.imported` must not erase `settings.yaml` as a
 *    candidate source; the marker records that a migration once ran, not that the file is
 *    dead forever.
 * B: provider discovery must not depend on a three-entry plugin-id whitelist; any node that
 *    yields provider + model + reachable baseUrl and a credential reference is a candidate.
 */
class RepairModelConfigCustomProviderTest {
  private lateinit var home: File

  @Before
  fun setUp() {
    home = Files.createTempDirectory("repair-model-config-custom").toFile()
    File(home, ".dsh/profiles/web").mkdirs()
  }

  @After
  fun tearDown() {
    home.deleteRecursively()
  }

  @Test
  fun markedMigrationDoesNotHideACustomProviderThatOnlyLivesInSettingsYaml() {
    File(home, ".dsh/settings.yaml").writeText(
      """
      llm-pi-ai:
        providers:
          my-openai:
            displayName: My OpenAI
            apiKeyEnv: MY_OPENAI_KEY
            api: openai-completions
            baseURL: https://127.0.0.1:9/v1
            models:
              - id: my-model
                name: My Model
      agent-default-model:
        provider: my-openai
        model: my-model
      """.trimIndent() + "\n",
    )
    // The upgrade wrote the migration marker; the user's config still lives in settings.yaml.
    File(home, ".dsh/settings.yaml.imported").writeText("llm-deepseek:\n  model: historical-model\n")
    File(home, ".dsh/.credentials.yaml").writeText("refs:\n  MY_OPENAI_KEY: fixture-secret-a\n")

    val result = RepairModelConfig.loadDetailed(home)
    assertTrue(
      "settings.yaml.imported 不应抹掉 settings.yaml 里的自定义 provider；实际候选数=" + result.connections.size,
      result.connections.isNotEmpty(),
    )
    assertEquals("my-openai", result.connections.single().provider)
    assertEquals("my-model", result.connections.single().model)
    assertEquals("https://127.0.0.1:9/v1", result.connections.single().baseUrl)
    assertEquals("fixture-secret-a", result.connections.single().apiKey)
    assertTrue("默认模型必须判为可用", result.defaultAvailable)
    assertTrue(
      "settings.yaml 仍应作为候选源出现",
      result.sources.any { it.path.endsWith("settings.yaml") && it.status == "parsed" },
    )
  }

  /**
   * A': the residual of root cause 1 that still exists on origin/main.
   *
   * origin/main already relaxed the old `if (!settings.yaml.imported.isFile)` guard into a
   * "fall back to settings.yaml only when the patch layer produced zero candidates" rule
   * (issue #1012 era). That still drops the user's real selection whenever the patch layer
   * yields *any* candidate: the legacy file is then never read, so a route the user actually
   * selected in "设置 -> 模型" stays invisible and the assistant silently offers a foreign one.
   * settings.yaml must always be a candidate source, not only a last resort.
   */
  @Test
  fun markedMigrationStillTreatsSettingsYamlAsACandidateSourceEvenWhenPatchesYieldSomething() {
    File(home, ".dsh/cordis.patch.yml").writeText(
      """
      - id: llm-pi-ai
        config:
          providers:
            spare:
              displayName: Spare
              apiKeyEnv: SPARE_KEY
              api: openai-completions
              baseURL: https://spare.example/v1
              models:
                - id: spare-model
      """.trimIndent() + "\n",
    )
    File(home, ".dsh/settings.yaml").writeText(
      """
      llm-pi-ai:
        providers:
          my-openai:
            displayName: My OpenAI
            apiKeyEnv: MY_OPENAI_KEY
            api: openai-completions
            baseURL: https://127.0.0.1:9/v1
            models:
              - id: my-model
                name: My Model
      agent-default-model:
        provider: my-openai
        model: my-model
      """.trimIndent() + "\n",
    )
    File(home, ".dsh/settings.yaml.imported").writeText("llm-deepseek:\n  model: historical-model\n")
    File(home, ".dsh/.credentials.yaml").writeText(
      "refs:\n  MY_OPENAI_KEY: fixture-secret-a2\n  SPARE_KEY: fixture-secret-spare\n",
    )

    val result = RepairModelConfig.loadDetailed(home)
    assertTrue(
      "marker 存在时 settings.yaml 仍须参与候选，而不是只在 patch 层为空时才回落；实际候选=" +
        result.connections.map { it.provider + "/" + it.model },
      result.connections.any { it.provider == "my-openai" && it.model == "my-model" },
    )
    assertTrue(
      "用户真正选中的路由必须判为可用，不能被另一个候选顶替",
      result.connections.first().provider == "my-openai" && result.defaultAvailable,
    )
    assertEquals("fixture-secret-a2", result.connections.first().apiKey)
  }

  @Test
  fun customProviderPluginIdIsDiscoveredWithoutAWhitelist() {
    File(home, ".dsh/cordis.patch.yml").writeText(
      """
      - insert:
        - id: my-openai
          name: '@user/dsh-llm-openai-compat'
          config:
            displayName: My OpenAI
            apiKeyEnv: MY_OPENAI_KEY
            api: openai-completions
            baseURL: https://127.0.0.1:9/v1
            models:
              - id: my-model
                name: My Model
      - id: agent-default-model
        config:
          provider: my-openai
          model: my-model
      """.trimIndent() + "\n",
    )
    File(home, ".dsh/.credentials.yaml").writeText("refs:\n  MY_OPENAI_KEY: fixture-secret-b\n")

    val result = RepairModelConfig.loadDetailed(home)
    assertTrue(
      "自定义 provider 插件 id 不在内置名单里也必须被采纳；实际候选数=" + result.connections.size,
      result.connections.isNotEmpty(),
    )
    assertEquals("my-openai", result.connections.single().provider)
    assertEquals("my-model", result.connections.single().model)
    assertEquals("fixture-secret-b", result.connections.single().apiKey)
    assertTrue("默认模型必须判为可用", result.defaultAvailable)
  }

  // ── 真实 cordis.patch 片段（脱敏自 ~/.dsh/profiles/desktop/cordis.patch.yml）──
  //
  // 形状取自真机实物：providers 下每条路由自带 apiKeyEnv/api/baseURL/models，
  // 密钥在 .credentials.yaml 的 refs 里。含明文 http + 显式端口的自建网关（zmyf 那条）。

  private val realPatchFragment = """
    - id: llm-pi-ai
      config:
        providers:
          zmyf:
            apiKeyEnv: ZMYF_API_KEY
            api: openai-completions
            baseURL: http://124.220.238.163:40810/v1
            models:
              - id: global:deepseek-v4.1-flash
                name: Deepseek-V4.1-Flash
          faro:
            displayName: faro
            apiKeyEnv: FARO_API_KEY
            api: openai-completions
            baseURL: https://faroapi.com/v1
            models:
              - id: gpt-5.6-terra
                name: GPT-5.6 Terra
  """.trimIndent() + "\n"

  @Test
  fun realPatchFragmentYieldsProvidersModelsAndKeyReferences() {
    File(home, ".dsh/profiles/web/cordis.patch.yml").writeText(realPatchFragment)
    File(home, ".dsh/.credentials.yaml").writeText(
      "refs:\n  ZMYF_API_KEY: secret-zmyf\n  FARO_API_KEY: secret-faro\n",
    )
    val routes = RepairModelConfig.load(home)
    assertEquals(2, routes.size)
    val zmyf = routes.single { it.provider == "zmyf" }
    assertEquals("global:deepseek-v4.1-flash", zmyf.model)
    assertEquals("http://124.220.238.163:40810/v1", zmyf.baseUrl)
    assertEquals("secret-zmyf", zmyf.apiKey)
    val faro = routes.single { it.provider == "faro" }
    assertEquals("gpt-5.6-terra", faro.model)
    assertEquals("secret-faro", faro.apiKey)
  }

  @Test
  fun dotYamlPatchIsReadTheSameAsDotYml() {
    // 真机 16448 实测只有 .yml，但用户自建/手工编辑的现场会出现 .yaml。
    File(home, ".dsh/profiles/web/cordis.patch.yaml").writeText(realPatchFragment)
    File(home, ".dsh/.credentials.yaml").writeText("refs:\n  ZMYF_API_KEY: k1\n  FARO_API_KEY: k2\n")
    val routes = RepairModelConfig.load(home)
    assertEquals("cordis.patch.yaml 必须被读到", 2, routes.size)
    assertTrue(routes.any { it.provider == "zmyf" })
  }

  @Test
  fun bothExtensionsPresentRecordsConflictAndTakesOnlyOne() {
    // 两份都在时只取一份并留痕：叠起来会产出用户没写过的合并结果。
    File(home, ".dsh/profiles/web/cordis.patch.yml").writeText(realPatchFragment)
    File(home, ".dsh/profiles/web/cordis.patch.yaml").writeText(
      "- id: llm-pi-ai\n  config:\n    providers:\n      other:\n        apiKeyEnv: ZMYF_API_KEY\n" +
        "        baseURL: https://other.example/v1\n        models:\n          - id: other-model\n",
    )
    File(home, ".dsh/.credentials.yaml").writeText("refs:\n  ZMYF_API_KEY: k1\n  FARO_API_KEY: k2\n")
    val result = RepairModelConfig.loadDetailed(home)
    assertEquals("只取 .yaml 一份，不得双用", 1, result.connections.size)
    assertEquals("other-model", result.connections.single().model)
    assertTrue(
      "冲突必须留痕（实际：" + result.sources.joinToString { it.path + "=" + it.status } + "）",
      result.sources.any { it.status == "conflict-skipped" },
    )
  }

  @Test
  fun homeLevelDotYamlPatchIsAlsoRead() {
    File(home, ".dsh/cordis.patch.yaml").writeText(realPatchFragment)
    File(home, ".dsh/.credentials.yaml").writeText("refs:\n  ZMYF_API_KEY: k1\n  FARO_API_KEY: k2\n")
    assertEquals(2, RepairModelConfig.load(home).size)
  }

  @Test
  fun bundleDeclaredPatchFallsBackToTheOtherExtension() {
    // bundle 作者把扩展名写成 .yml 而实物是 .yaml：不该让整条 bundle 的 provider 消失。
    val profile = File(home, ".dsh/profiles/web")
    File(profile, "package.json").writeText("""{"dsh":{"profile":{"bundles":["@user/model-config"]}}}""")
    val bundle = File(profile, "node_modules/@user/model-config").apply { mkdirs() }
    File(bundle, "package.json").writeText(
      """{"name":"@user/model-config","dsh":{"bundle":{"patch":"cordis.patch.yaml"}}}""",
    )
    File(bundle, "cordis.patch.yaml").writeText(realPatchFragment)
    File(home, ".dsh/.credentials.yaml").writeText("refs:\n  ZMYF_API_KEY: k1\n  FARO_API_KEY: k2\n")
    assertEquals("bundle 声明的 .yaml 必须被读到", 2, RepairModelConfig.load(home).size)
  }
}
