package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 回归：引擎能正常使用、修复助手却读不到模型 / 误报「未配置模型」的 YAML 与凭据盲区。
 *
 * 这些用例刻意使用真机现场常见的写法：BOM + 文档头注释、行内 flow 集合、indentless
 * block sequence、字符串数组 models、base_url / baseUrl、大小写不同的 provider、以及
 * 同目录 .yaml 写坏但 .yml 仍完好的现场。解析失败必须是 invalid，而不是整份配置消失。
 */
class RepairModelConfigYamlCompatTest {
  private lateinit var home: File

  @Before
  fun setUp() {
    home = Files.createTempDirectory("repair-model-yaml-compat").toFile()
    File(home, ".dsh/profiles/web").mkdirs()
  }

  @After
  fun tearDown() {
    home.deleteRecursively()
  }

  private fun writeCredentials(text: String) {
    File(home, ".dsh/.credentials.yaml").writeText(text.trimIndent() + "\n")
  }

  @Test
  fun documentMarkersAndFlowCollectionsAreParsedWithQuotedSeparators() {
    val profile = File(home, ".dsh/profiles/web")
    // BOM、文档头注释、%YAML 指令、--- 与 ... 都必须被跳过；flow 集合里引号内的
    // 逗号/冒号属于标量本身，不能切成两个条目。
    val document = "\uFEFF# hand-written profile patch\n" +
      "%YAML 1.2\n" +
      "---\n" +
      "- {id: llm-pi-ai, config: {providers: {demo: {apiKeyEnv: \"DEMO_API_KEY\", " +
      "baseURL: \"https://demo.example/v1\", models: [{id: \"model-a\"}, \"model-b\"], " +
      "headers: {X-Test: \"a,b\", X-Colon: \"c:d\"}}}}}\n" +
      "- {id: agent-default-model, config: {provider: \"demo\", model: \"model-a\"}}\n" +
      "...\n"
    File(profile, "cordis.patch.yaml").writeText(document)
    writeCredentials("refs: {DEMO_API_KEY: \"secret-flow\"}")

    val result = RepairModelConfig.loadDetailed(home)
    val statuses = result.sources.joinToString { it.path + "=" + it.status }
    assertEquals("flow 文档必须整份可读（实际：$statuses）", 2, result.connections.size)
    assertEquals(listOf("model-a", "model-b"), result.connections.map { it.model })
    assertEquals("demo", result.connections.first().provider)
    assertEquals("a,b", result.connections.first().headers["X-Test"])
    assertEquals("c:d", result.connections.first().headers["X-Colon"])
    assertEquals("secret-flow", result.connections.first().apiKey)
    assertTrue("provider/model 选中后默认模型应可用", result.defaultAvailable)
    assertTrue(result.sources.none { it.status == "invalid" })
  }

  @Test
  fun nullScalarsStayMissingInsteadOfBecomingLiteralStrings() {
    val parsed = RepairYaml.parse(
      "baseURL: null\nmodel: ~\napiKeyEnv: null\nquotedNull: \"null\"\n",
    )
    assertNull(parsed.string("baseURL"))
    assertNull(parsed.string("model"))
    assertNull(parsed.string("apiKeyEnv"))
    assertEquals("引号里的 null 是字符串，不是空值", "null", parsed.string("quotedNull"))
  }

  @Test
  fun blockHeaderSuffixOrdersAreAcceptedAndStayOpaque() {
    val parsed = RepairYaml.parse(
      "a: |2-\n  payload-a\nb: >2+\n  payload-b\nc: |-2\n  payload-c\n",
    ) as RepairYamlValue.Mapping
    for (key in listOf("a", "b", "c")) {
      assertTrue("块标量 $key 必须保持 Opaque，绝不猜成凭据", parsed.values[key] is RepairYamlValue.Opaque)
    }
  }

  @Test
  fun indentlessBlockSequenceIsReadLikeIndentedOne() {
    File(home, ".dsh/profiles/web/cordis.patch.yml").writeText(
      """
      - id: llm-pi-ai
        config:
          providers:
            demo:
              apiKeyEnv: DEMO_KEY
              baseURL: https://demo.example/v1
              models:
              - id: model-a
                name: Model A
              - id: model-b
      """.trimIndent() + "\n",
    )
    writeCredentials("refs:\n  DEMO_KEY: secret-indentless")

    val result = RepairModelConfig.loadDetailed(home)
    assertEquals("indentless sequence 不得让整份 patch 判 invalid", 2, result.connections.size)
    assertEquals(listOf("model-a", "model-b"), result.connections.map { it.model })
    assertEquals("secret-indentless", result.connections.first().apiKey)
  }

  @Test
  fun brokenDotYamlFallsBackToHealthyDotYmlAndRecordsBothStatuses() {
    val profile = File(home, ".dsh/profiles/web")
    File(profile, "cordis.patch.yaml").writeText("- id: llm-pi-ai\n    config: broken-indent\n")
    File(profile, "cordis.patch.yml").writeText(
      """
      - id: llm-pi-ai
        config:
          providers:
            fallback-route:
              apiKeyEnv: FALLBACK_KEY
              baseURL: https://fallback.example/v1
              models:
                - id: fallback-model
      """.trimIndent() + "\n",
    )
    writeCredentials("refs:\n  FALLBACK_KEY: fallback-secret")

    val result = RepairModelConfig.loadDetailed(home)
    assertEquals("坏 .yaml 时必须回退 .yml", 1, result.connections.size)
    assertEquals("fallback-model", result.connections.single().model)
    val statuses = result.sources.joinToString { it.path + "=" + it.status }
    assertTrue("坏 .yaml 必须如实记为 invalid（实际：$statuses）",
      result.sources.any { it.path.endsWith("cordis.patch.yaml") && it.status == "invalid" })
    assertTrue("好 .yml 必须如实记为 parsed（实际：$statuses）",
      result.sources.any { it.path.endsWith("cordis.patch.yml") && it.status == "parsed" })
    assertTrue("采用来源应是 .yml", result.appliedPatches.any { it.endsWith("cordis.patch.yml") })
    assertTrue("坏 .yaml 不应算作采用", result.appliedPatches.none { it.endsWith("cordis.patch.yaml") })
  }

  @Test
  fun dashscopeEnvironmentAndDerivedKeyRefAreBothHonored() {
    File(home, ".dsh/profiles/web/cordis.patch.yml").writeText(
      """
      - id: llm-pi-ai
        config:
          providers:
            dashscope:
              baseURL: https://dashscope.example/v1
              models:
                - id: qwen-vl-max
      """.trimIndent() + "\n",
    )
    writeCredentials("refs:\n  DASHSCOPE_API_KEY: dashscope-secret")

    val result = RepairModelConfig.loadDetailed(home)
    assertEquals("没写 apiKeyEnv 时按 provider 派生引用名", 1, result.connections.size)
    assertEquals("dashscope", result.connections.single().provider)
    assertEquals("dashscope-secret", result.connections.single().apiKey)
    assertTrue(result.unavailable.isEmpty())
    assertEquals("DASHSCOPE_API_KEY", RepairModelConfig.deriveKeyRef("dashscope"))
    assertEquals("MINIMAX_CN_API_KEY", RepairModelConfig.deriveKeyRef("minimax-cn"))
  }

  @Test
  fun contextLoaderInjectsBothPrivateKeyFiles() {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell/RepairModelConfig.kt"),
      File("app/src/main/java/com/dsharnessmobile/shell/RepairModelConfig.kt"),
    )
    val source = candidates.firstOrNull { it.isFile }?.readText()
      ?: throw AssertionError("找不到 RepairModelConfig.kt")
    assertTrue("必须注入 DASHSCOPE_API_KEY（与 EngineManager 对齐）", source.contains("\"DASHSCOPE_API_KEY\""))
    assertTrue("必须读取 dashscope-key.txt", source.contains("dashscope-key.txt"))
    assertTrue("必须继续注入 DEEPSEEK_API_KEY", source.contains("\"DEEPSEEK_API_KEY\""))
    assertTrue("必须读取 deepseek-key.txt", source.contains("deepseek-key.txt"))
  }

  @Test
  fun plaintextKeyWorksInternallyButNeverLeaksIntoDiagnostics() {
    File(home, ".dsh/profiles/web/cordis.patch.yml").writeText(
      """
      - id: llm-pi-ai
        config:
          providers:
            demo:
              apiKey: sk-live-abcdef0123456789abcdef
              baseURL: https://demo.example/v1
              models: ["model-a"]
      """.trimIndent() + "\n",
    )
    val result = RepairModelConfig.loadDetailed(home)
    assertEquals("明文密钥应作为内部 key 生效", 1, result.connections.size)
    assertEquals("sk-live-abcdef0123456789abcdef", result.connections.single().apiKey)
    assertTrue("能用就不该出现在缺凭据报表里", result.unavailable.isEmpty())
    val rendered = result.unavailable.joinToString { it.toString() } +
      result.sources.joinToString { it.toString() }
    for (leak in listOf("sk-live", "abcdef0123456789", "sk-")) {
      assertTrue("明文密钥不得进入诊断字段（泄漏片段：$leak，实际：$rendered）", !rendered.contains(leak))
    }
    assertTrue("20-39 位含分隔符的疑似密钥必须识别", RepairModelConfig.looksLikeSecret("abcd-efgh-ijkl-mnop-qrst"))
    assertTrue("规范大写环境变量名仍应作为引用名", !RepairModelConfig.looksLikeSecret("CUSTOM_OPENAI_API_KEY"))
  }

  @Test
  fun stringModelArraysAndSingleModelFallbacksAreAccepted() {
    File(home, ".dsh/profiles/web/cordis.patch.yml").writeText(
      """
      - id: llm-pi-ai
        config:
          providers:
            strings:
              apiKeyEnv: STR_KEY
              base_url: https://strings.example/v1
              models: ["model-a", "model-b"]
            single:
              apiKeyEnv: SINGLE_KEY
              baseUrl: https://single.example/v1
              model: model-single
      - id: llm-deepseek
        config:
          models: []
          model: official-single
      """.trimIndent() + "\n",
    )
    writeCredentials("refs:\n  STR_KEY: string-secret\n  SINGLE_KEY: single-secret\n  DEEPSEEK_API_KEY: official-secret")

    val result = RepairModelConfig.loadDetailed(home)
    assertEquals(4, result.connections.size)
    val models = result.connections.map { it.model }.toSet()
    assertEquals(setOf("model-a", "model-b", "model-single", "official-single"), models)
    assertEquals("https://strings.example/v1",
      result.connections.single { it.model == "model-a" }.baseUrl)
    assertEquals("https://single.example/v1",
      result.connections.single { it.model == "model-single" }.baseUrl)
  }

  @Test
  fun providerComparisonIsCaseInsensitiveForOrderAndDefaultAvailability() {
    val patch = File(home, ".dsh/profiles/web/cordis.patch.yml")
    patch.writeText(
      """
      - id: llm-pi-ai
        disabled: FALSE
        config:
          providers:
            Demo:
              apiKeyEnv: DEMO_KEY
              baseURL: https://demo.example/v1
              models:
                - id: model-a
      - id: agent-default-model
        config:
          provider: demo
          model: model-a
      """.trimIndent() + "\n",
    )
    writeCredentials("refs:\n  DEMO_KEY: case-secret")

    val result = RepairModelConfig.loadDetailed(home)
    assertEquals(1, result.connections.size)
    assertEquals("小写 provider 必须命中大写路由", "model-a", result.connections.first().model)
    assertTrue("provider 大小写不同也必须判默认可用", result.defaultAvailable)

    patch.appendText("- id: llm-pi-ai\n  disabled: TRUE\n")
    assertTrue("disabled: TRUE 必须按布尔禁用", RepairModelConfig.load(home).isEmpty())
  }

  @Test
  fun halfExtractedDshDirectoryIsReportedAsRootMissing() {
    val bareHome = Files.createTempDirectory("repair-model-half-extracted").toFile()
    try {
      File(bareHome, ".dsh").mkdirs()
      val result = RepairModelConfig.loadDetailed(bareHome)
      assertTrue(result.connections.isEmpty())
      assertTrue("半解压空壳必须判 rootMissing", result.rootMissing)
      val statuses = result.sources.joinToString { it.path + "=" + it.status }
      assertTrue("必须给出可判定的 root-missing（实际：$statuses）",
        result.sources.any { it.status == "root-missing" })
      assertFalse("不得把空壳误报成用户删了五个文件（实际：$statuses）",
        result.sources.any { it.status == "missing" })
    } finally {
      bareHome.deleteRecursively()
    }
  }
}
