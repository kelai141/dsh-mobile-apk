package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class RepairModelConfigTest {
  private lateinit var home: File

  @Before
  fun setUp() {
    home = Files.createTempDirectory("repair-model-config").toFile()
    File(home, ".dsh/profiles/web").mkdirs()
  }

  @After
  fun tearDown() {
    home.deleteRecursively()
  }

  @Test
  fun activeProfileProvidesRoutesAndSelectsTheDshDefault() {
    File(home, ".dsh/profiles/web/cordis.patch.yml").writeText(
      """
      - id: llm-pi-ai
        config:
          providers:
            d1api:
              displayName: D1API
              apiKeyEnv: D1API_API_KEY
              api: openai-completions
              baseURL: https://d1api.example/v1
              headers:
                x-client: mobile
              models:
                - id: deepseek-v4.1-flash
                  name: DeepSeek V4.1 Flash
      - id: llm-deepseek
        config: {}
      - id: agent-default-model
        config:
          provider: d1api
          model: deepseek-v4.1-flash
          reasoningEffort: high
      """.trimIndent() + "\n",
    )
    File(home, ".dsh/.credentials.yaml").writeText(
      """
      refs:
        D1API_API_KEY: secret-d1
      records:
        unrelated:
          kind: browser
          payload:
            secret: unrelated
      """.trimIndent() + "\n",
    )

    val routes = RepairModelConfig.load(home)
    assertEquals(1, routes.size)
    assertEquals("d1api", routes.single().provider)
    assertEquals("deepseek-v4.1-flash", routes.single().model)
    assertEquals("secret-d1", routes.single().apiKey)
    assertEquals("mobile", routes.single().headers["x-client"])
    assertEquals(null, routes.single().toolHistoryMode)
  }

  @Test
  fun legacySettingsAndOfficialEnvironmentRemainSupported() {
    File(home, ".dsh/settings.yaml").writeText(
      """
      llm-deepseek:
        baseURL: https://official.example/anthropic
        apiKeyEnv: OFFICIAL_KEY
        model: deepseek-chat
      """.trimIndent() + "\n",
    )
    val routes = RepairModelConfig.load(home, mapOf("OFFICIAL_KEY" to "secret-official"))
    assertEquals("deepseek-official", routes.single().provider)
    assertEquals("deepseek-chat", routes.single().model)
    assertEquals("secret-official", routes.single().apiKey)
  }

  @Test
  fun selectedRouteIsOrderedFirstWithoutChangingOtherRoutes() {
    File(home, ".dsh/profiles/web/cordis.patch.yml").writeText(
      """
      - id: llm-pi-ai
        config:
          providers:
            first:
              apiKeyEnv: FIRST_KEY
              api: openai-completions
              baseURL: https://first.example/v1
              models:
                - id: first-model
            selected:
              displayName: Selected
              apiKeyEnv: SELECTED_KEY
              api: anthropic-messages
              baseURL: https://selected.example
              models:
                - id: selected-model
      - id: agent-default-model
        config:
          provider: selected
          model: selected-model
      """.trimIndent() + "\n",
    )
    File(home, ".dsh/.credentials.yaml").writeText(
      "refs:\n  FIRST_KEY: one\n  SELECTED_KEY: two\n",
    )

    val routes = RepairModelConfig.load(home)
    assertEquals(listOf("selected-model", "first-model"), routes.map { it.model })
    assertTrue(routes.first().label.startsWith("selected-model"))
  }

  @Test
  fun modelEffortsAndOnlyExplicitCompatibilityAreExposed() {
    File(home, ".dsh/profiles/web/cordis.patch.yml").writeText(
      """
      - id: llm-pi-ai
        config:
          providers:
            d1api:
              displayName: D1API
              apiKeyEnv: D1API_API_KEY
              api: openai-completions
              baseURL: https://d1api.example/v1
              models:
                - id: deepseek-v4.1-flash
                  name: DeepSeek V4.1 Flash
                  compat:
                    supportsReasoningEffort: false
                    requiresReasoningContentOnAssistantMessages: true
                    thinkingFormat: deepseek
                  reasoningEfforts:
                    off: null
                    low: low
                    medium: medium
                    high: high
      - id: agent-default-model
        config:
          provider: d1api
          model: deepseek-v4.1-flash
          reasoningEffort: medium
      """.trimIndent() + "\n",
    )
    File(home, ".dsh/.credentials.yaml").writeText("refs:\n  D1API_API_KEY: secret\n")

    val route = RepairModelConfig.load(home).single()
    assertEquals("DeepSeek V4.1 Flash · D1API", route.label)
    assertEquals(listOf("off", "low", "medium", "high"), route.reasoningEfforts.map { it.id })
    assertEquals("medium", route.defaultReasoningEffort)
    assertEquals(false, route.supportsReasoningEffort)
    assertEquals("deepseek", route.thinkingFormat)
    assertTrue(route.requiresReasoningContentOnAssistantMessages)
  }
}
