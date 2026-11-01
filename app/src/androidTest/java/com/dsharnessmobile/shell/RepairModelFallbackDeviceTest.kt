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
 * 设备层回归：修复助手在「引擎已死」现场能不能读到模型配置。
 *
 * 为什么是 instrumentation 而不是 JVM 单测：JVM 单测跑在宿主机临时目录，
 * 碰不到真实设备上的目录形态——尤其 `settings.yaml.imported` 由引擎迁移写下，
 * 而 `selectedBundlePatches()` 会去 `home.parentFile/usr/lib/node_modules/...` 找运行时清单。
 *
 * 当前契约：settings.yaml 无条件铺底、patch 按同一插件 id 深合并覆盖；marker 不参与读取，
 * 也没有任何「按候选数回落」的分支。所以这里既断言候选读到了，也断言那两个旧状态再不会出现。
 *
 * ## 为什么不直接读写 filesDir/home
 *
 * 那个目录是**用户真实配置**。测试往里写等于改用户数据，跑崩了还会留下残骸。
 * 所以这里注入一个 `filesDir/test-home-<uuid>` 的副本目录，调生产重载 `loadDetailed(home)`。
 *
 * **等价性**：`loadDetailed(home)` 只用 `home` 与 `home.parentFile` 两个锚点——
 * 前者定位 `.dsh`，后者定位 `usr/lib/node_modules/...`（运行时清单）与 `privateRoot` 边界。
 * 把测试目录放在 `filesDir` 下，`home.parentFile` 仍等于 `filesDir`，与生产完全一致；
 * 差别只在 `home` 本身指向副本。生产路径 `loadDetailed(context)` 内部也是
 * `loadDetailed(File(context.filesDir, "home"), ...)`，走的是同一份实现。
 */
@RunWith(AndroidJUnit4::class)
class RepairModelFallbackDeviceTest {

  private lateinit var filesDir: File
  private lateinit var home: File
  private lateinit var dsh: File

  @Before
  fun setUp() {
    filesDir = InstrumentationRegistry.getInstrumentation().targetContext.filesDir
    // 放在 filesDir 下：保证 home.parentFile == filesDir，与生产锚点一致。
    home = File(filesDir, "test-home-" + UUID.randomUUID())
    dsh = File(home, ".dsh")
    assertTrue("必须能建出隔离的测试 home", File(dsh, "profiles/web").mkdirs())
    assertFalse("测试目录不得与真实 home 重合",
      home.canonicalPath == File(filesDir, "home").canonicalPath)
  }

  @After
  fun tearDown() {
    // 只删自己造的隔离目录；真实 filesDir/home 全程没被碰过。
    val removed = home.deleteRecursively()
    assertTrue("测试目录必须被清理干净：" + home.absolutePath, removed || !home.exists())
    assertTrue("真实 home 必须原样存在", File(filesDir, "home").isDirectory)
  }

  /** 社群现场：marker 在（现已不影响读取）、settings.yaml 有 provider、凭据有 key、patch 不含模型键。 */
  private fun communityScenario() {
    File(dsh, "settings.yaml.imported").writeText(COMMUNITY_SETTINGS)
    File(dsh, "settings.yaml").writeText(COMMUNITY_SETTINGS)
    File(dsh, ".credentials.yaml").writeText(COMMUNITY_CREDENTIALS)
    // 活动配置只剩非模型键——迁移后用户只改过 persona 的典型形态。
    File(dsh, "profiles/web/cordis.patch.yml").writeText(PERSONA_ONLY)
    File(dsh, "cordis.patch.yml").delete()
  }

  // ── 1. 铺底生效（社群现场）────────────────────────────────────────────────

  @Test
  fun 社群现场下修复助手照样从settings读到模型() {
    communityScenario()
    val result = RepairModelConfig.loadDetailed(home)
    val statuses = result.sources.joinToString { it.path + "=" + it.status }
    assertTrue("settings.yaml 必须无条件铺底，实际来源：" + statuses,
      result.connections.isNotEmpty())
    assertEquals("demo-model", result.connections.single().model)
    assertEquals("community-demo", result.connections.single().provider)
    assertEquals("device-secret", result.connections.single().apiKey)
    assertTrue("来源表必须把 settings.yaml 记为已读取：" + statuses,
      result.sources.any { it.path.endsWith("settings.yaml") && it.status == "parsed" })
    assertFalse("回落/跳过状态已不再产出：" + statuses,
      result.sources.any { it.status == "fallback-used" || it.status == "skipped-legacy" })
  }

  // ── 2. 叠层：patch 只覆盖同名键，settings.yaml 里其余的仍参与 ──────────────

  @Test
  fun 活动配置与旧文件同时参与而不是互相顶掉() {
    File(dsh, "settings.yaml.imported").writeText(COMMUNITY_SETTINGS)
    File(dsh, "settings.yaml").writeText(COMMUNITY_SETTINGS)
    File(dsh, ".credentials.yaml").writeText(COMMUNITY_CREDENTIALS)
    File(dsh, "profiles/web/cordis.patch.yml").writeText(
      "- id: llm-pi-ai\n" +
        "  config:\n" +
        "    providers:\n" +
        "      active-demo:\n" +
        "        displayName: Active Demo\n" +
        "        apiKeyEnv: COMMUNITY_DEMO_KEY\n" +
        "        api: openai-completions\n" +
        "        baseURL: https://active.example/v1\n" +
        "        models:\n" +
        "          - id: active-model\n",
    )
    val result = RepairModelConfig.loadDetailed(home)
    val statuses = result.sources.joinToString { it.path + "=" + it.status }
    // 深合并只合并同名键：patch 新增了 active-demo，settings.yaml 里的 community-demo 不会被顶掉。
    assertEquals("两条路由必须都在（实际：" + statuses + "）",
      listOf("community-demo", "active-demo"), result.connections.map { it.provider })
    assertEquals("patch 的模型值照旧生效", "active-model",
      result.connections.single { it.provider == "active-demo" }.model)
    assertTrue("settings.yaml 必须记为已读取：" + statuses,
      result.sources.any { it.path.endsWith("settings.yaml") && it.status == "parsed" })
    assertFalse("回落/跳过状态已不再产出：" + statuses,
      result.sources.any { it.status == "fallback-used" || it.status == "skipped-legacy" })
  }

  // ── 3. 缺凭据：配了但用不了，必须与「没配置」分开 ─────────────────────────

  @Test
  fun 配了provider但缺凭据时来源说明是缺凭据() {
    File(dsh, "settings.yaml.imported").writeText(COMMUNITY_SETTINGS)
    File(dsh, "settings.yaml").writeText(COMMUNITY_SETTINGS)
    File(dsh, ".credentials.yaml").writeText("version: 1\nrefs: {}\nrecords: {}\n")
    File(dsh, "profiles/web/cordis.patch.yml").delete()
    File(dsh, "cordis.patch.yml").delete()
    val result = RepairModelConfig.loadDetailed(home)
    assertTrue("没有 key 就确实没有候选", result.connections.isEmpty())
    val statuses = result.sources.joinToString { it.path + "=" + it.status }
    assertTrue("必须留下缺凭据的说明，实际：" + statuses,
      result.sources.any { it.status == "no-credential" })
  }

  // ── 4. 对照组：settings.yaml 不在时零候选（修前行为等价现场）─────────────────

  @Test
  fun 对照组_没有settings时确实零候选() {
    File(dsh, "settings.yaml.imported").writeText(COMMUNITY_SETTINGS)
    File(dsh, "settings.yaml").delete()
    File(dsh, ".credentials.yaml").writeText(COMMUNITY_CREDENTIALS)
    File(dsh, "profiles/web/cordis.patch.yml").writeText(PERSONA_ONLY)
    File(dsh, "cordis.patch.yml").delete()
    val result = RepairModelConfig.loadDetailed(home)
    val statuses = result.sources.joinToString { it.path + "=" + it.status }
    assertTrue("没有 settings.yaml 就没有候选：" + statuses, result.connections.isEmpty())
    assertTrue("来源必须如实记 missing：" + statuses,
      result.sources.any { it.path.endsWith("settings.yaml") && it.status == "missing" })
    assertFalse("回落/跳过状态已不再产出：" + statuses,
      result.sources.any { it.status == "fallback-used" || it.status == "skipped-legacy" })
  }

  // ── 5. 隔离性自证：本类全程不碰真实 home ─────────────────────────────────

  @Test
  fun 测试只写隔离目录不碰真实home() {
    val realHome = File(filesDir, "home")
    val before = if (realHome.isDirectory) realHome.walkTopDown().count() else -1
    communityScenario()
    RepairModelConfig.loadDetailed(home)
    val after = if (realHome.isDirectory) realHome.walkTopDown().count() else -1
    assertEquals("真实 home 的文件数不得变化", before, after)
    assertTrue("测试目录里必须有内容（证明确实写在副本上）",
      File(dsh, "settings.yaml").isFile)
  }

  companion object {
    private val PERSONA_ONLY = "- id: persona\n  config:\n    prompt: hello\n"

    private val COMMUNITY_SETTINGS = """
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

    private val COMMUNITY_CREDENTIALS = """
      version: 1
      refs:
        COMMUNITY_DEMO_KEY: device-secret
      records: {}
    """.trimIndent()
  }
}