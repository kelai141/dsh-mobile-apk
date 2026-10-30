package com.dsharnessmobile.shell

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 界面层回归：修复助手打开时，模型状态怎么呈现。
 *
 * 与 [RepairModelFallbackDeviceTest] 的分工：那个钉数据层（读到了什么），
 * 这个钉**界面会拿到什么**——0 候选时按钮必须禁用，有候选时可用。
 *
 * ## 隔离
 *
 * 同样注入 `filesDir/test-home-<uuid>`，不碰真实 `filesDir/home`。
 * 这里不拉起 Activity（拉起会读真实 home，等于污染），只验证
 * 「生产 UI 依赖的那份 loadDetailed 结果」在两个现场下分别是什么。
 */
@RunWith(AndroidJUnit4::class)
class RepairUiFallbackDeviceTest {

  private lateinit var filesDir: File
  private lateinit var home: File
  private lateinit var dsh: File

  @Before
  fun setUp() {
    filesDir = InstrumentationRegistry.getInstrumentation().targetContext.filesDir
    home = File(filesDir, "test-home-ui-" + UUID.randomUUID())
    dsh = File(home, ".dsh")
    assertTrue(File(dsh, "profiles/web").mkdirs())
  }

  @After
  fun tearDown() {
    home.deleteRecursively()
    assertTrue("测试目录必须被清理", !home.exists())
    assertTrue("真实 home 必须原样存在", File(filesDir, "home").isDirectory)
  }

  private fun communityScenario() {
    File(dsh, "settings.yaml.imported").writeText(SETTINGS)
    File(dsh, "settings.yaml").writeText(SETTINGS)
    File(dsh, ".credentials.yaml").writeText(CREDENTIALS)
    File(dsh, "profiles/web/cordis.patch.yml").writeText("- id: persona\n  config:\n    prompt: hello\n")
    File(dsh, "cordis.patch.yml").delete()
  }

  @Test
  fun 社群现场下界面能拿到模型() {
    communityScenario()
    val result = RepairModelConfig.loadDetailed(home)
    val statuses = result.sources.joinToString { it.path + "=" + it.status }
    assertTrue("界面必须拿到候选，实际来源：" + statuses, result.connections.isNotEmpty())
    assertTrue("必须留下回落标记：" + statuses,
      result.sources.any { it.status == "fallback-used" })
    // UI 的判据是 connections.isNotEmpty()（见 RepairActivity.applyModelState）。
    // 这里断言的是同一份数据，等价于「模型按钮与发送按钮可用」。
    assertTrue("默认模型可用", result.defaultAvailable)
  }

  @Test
  fun 对照组_零候选时模型选择器禁用而发送键保持可用() {
    File(dsh, "settings.yaml.imported").writeText(SETTINGS)
    File(dsh, "settings.yaml").delete()
    File(dsh, ".credentials.yaml").writeText(CREDENTIALS)
    File(dsh, "profiles/web/cordis.patch.yml").writeText("- id: persona\n  config:\n    prompt: hello\n")
    File(dsh, "cordis.patch.yml").delete()
    val result = RepairModelConfig.loadDetailed(home)
    val statuses = result.sources.joinToString { it.path + "=" + it.status }
    assertTrue("对照组必须零候选：" + statuses, result.connections.isEmpty())
    // issue #1012 起 applyModelState 分开控制：modelButton 跟随 modelControlsEnabled（0 候选禁用），
    // send 跟随 sendEnabled（保持可用，点击由 RepairModelNotice.composer 判定并保留草稿）。
    assertFalse("零候选时默认模型不可用", result.defaultAvailable)
    assertTrue("来源必须记 missing：" + statuses,
      result.sources.any { it.path.endsWith("settings.yaml") && it.status == "missing" })
  }

  @Test
  fun 两组现场都不影响真实home() {
    val realHome = File(filesDir, "home")
    val before = if (realHome.isDirectory) realHome.walkTopDown().count() else -1
    communityScenario()
    RepairModelConfig.loadDetailed(home)
    val after = if (realHome.isDirectory) realHome.walkTopDown().count() else -1
    assertEquals("真实 home 的文件数不得变化", before, after)
  }

  companion object {
    private val SETTINGS = """
      llm-pi-ai:
        providers:
          community-demo:
            displayName: Community Demo
            apiKeyEnv: COMMUNITY_DEMO_KEY
            api: openai-completions
            baseURL: https://community.example/v1
            models:
              - id: demo-model
                name: Demo Model
    """.trimIndent()

    private val CREDENTIALS = """
      version: 1
      refs:
        COMMUNITY_DEMO_KEY: device-secret
      records: {}
    """.trimIndent()
  }
}