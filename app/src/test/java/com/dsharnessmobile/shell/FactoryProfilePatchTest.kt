package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * apk #214 回归：profile `cordis.patch.yml` 的工厂语义纠正。
 *
 * 规格断言（红 = 复现根因）：
 * 旧规则「live 内容为基，只追加缺失工厂块」下，live 里旧版遗留的
 * `- id: ui-layout / disabled: true` 永远不被纠正 → 上游 web-app bundle 的 ui-layout 行被禁
 * → 根服务 layout 不 activate → 13 条客户端插件全 pending。
 */
class FactoryProfilePatchTest {

  /** 旧版权威装配清单里真实出现过的形态（docs/archive/M1-PLAN.md:104-105）。 */
  private val legacyLive = """
    # Android adaptation
    - id: bash-sandbox
      disabled: true
    - insert:
        - id: shell-termux
          name: '@dsh-android/dsh-shell-termux'
    - id: ui-layout
      disabled: true
    - insert:
        - id: ui-responsive
          name: '@dsh-android/dsh-client-ui-responsive'
  """.trimIndent() + "\n"

  /** 0.1.5 起的权威清单：ui-layout 不再禁用（也不再出现在文件里）。 */
  private val currentFactory = """
    # Android adaptation
    - id: bash-sandbox
      disabled: true
    - insert:
        - id: shell-termux
          name: '@dsh-android/dsh-shell-termux'
    - insert:
        - id: ui-responsive
          name: '@dsh-android/dsh-client-ui-responsive'
    - insert:
        - id: android-manage
          name: '@dsh-android/dsh-android-manage'
  """.trimIndent() + "\n"

  @Test
  fun legacyUiLayoutDisableIsReconciledAway() {
    val result = FactoryProfilePatch.merge(legacyLive, currentFactory)

    assertFalse(
      "旧版遗留的 ui-layout disable 必须被纠正（否则根服务 layout 永不起，#214）",
      result.text.contains("ui-layout"),
    )
    assertTrue("必须留下可追溯的纠正说明", result.changes.any { it.contains("ui-layout") })
    // 工厂块与用户块都不受影响
    assertTrue(result.text.contains("bash-sandbox"))
    assertTrue(result.text.contains("shell-termux"))
    assertTrue(result.text.contains("ui-responsive"))
  }

  @Test
  fun factoryDisabledFlagWinsOverTheLiveValue() {
    val factory = """
      - id: open-in-app
        disabled: true
      - id: agent-default-model
        disabled: true
    """.trimIndent() + "\n"
    val live = """
      - id: open-in-app
        disabled: false
      - id: agent-default-model
    """.trimIndent() + "\n"

    val result = FactoryProfilePatch.merge(live, factory)

    val openBlock = FactoryProfilePatch.topLevelBlocks(result.text).first { it.contains("open-in-app") }
    assertEquals("工厂 disabled 语义权威", true, FactoryProfilePatch.disabledValue(openBlock))
    val modelBlock = FactoryProfilePatch.topLevelBlocks(result.text).first { it.contains("agent-default-model") }
    assertEquals("live 缺该键时按工厂补写", true, FactoryProfilePatch.disabledValue(modelBlock))
    assertTrue(result.changes.isNotEmpty())
  }

  @Test
  fun userOwnedBlocksSurviveUntouched() {
    val factory = "- id: bash-sandbox\n  disabled: true\n"
    val live = """
      - id: open-in-app
        disabled: true
      - id: my-third-party-row
        disabled: true
      - insert:
          - id: my-own-plugin
            name: 'some-user-plugin'
    """.trimIndent() + "\n"

    val result = FactoryProfilePatch.merge(live, factory)

    assertTrue("用户自建条目必须原样保留", result.text.contains("my-third-party-row"))
    assertTrue(result.text.contains("some-user-plugin"))
    assertTrue(
      "用户对非退役行的显式 disable 不得被工厂重写",
      FactoryProfilePatch.topLevelBlocks(result.text)
        .first { it.contains("my-third-party-row") }
        .let { FactoryProfilePatch.disabledValue(it) == true },
    )
  }

  @Test
  fun missingFactoryBlocksAreStillAppended() {
    val live = "- id: ui-layout\n  disabled: true\n"
    val result = FactoryProfilePatch.merge(live, currentFactory)

    assertTrue("工厂缺失块照旧追加（#167 语义不回归）", result.text.contains("android-manage"))
    assertTrue(result.text.contains("shell-termux"))
    assertFalse(result.text.contains("ui-layout"))
  }

  @Test
  fun mergeIsIdempotentSoTheFileIsNotRewrittenWithoutRealChanges() {
    val first = FactoryProfilePatch.merge(legacyLive, currentFactory)
    val second = FactoryProfilePatch.merge(first.text, currentFactory)

    assertEquals("第二次合并不得再改一字（否则每次刷新都无谓重写 patch）", first.text, second.text)
    assertTrue("第二次必须无改动可言", second.changes.isEmpty())
  }

  @Test
  fun structurallyUnknownLiveIsLeftAlone() {
    val live = "not: a-list\n"
    val result = FactoryProfilePatch.merge(live, currentFactory)

    assertEquals("live 结构未知时保守保 live（不追加）", live, result.text)
    assertTrue(result.changes.isEmpty())
  }

  @Test
  fun blankLiveReceivesTheFactoryFileVerbatim() {
    val result = FactoryProfilePatch.merge("", currentFactory)

    assertEquals(currentFactory, result.text)
  }

  // ── 启动期一次性迁移（Layer 2，无工厂参考） ────────────────────

  @Test
  fun retiredRepairOnlyTouchesRetiredRows() {
    val live = """
      - id: ui-layout
        disabled: true
      - id: permission
        disabled: true
      - id: open-in-app
        disabled: true
    """.trimIndent() + "\n"

    val result = FactoryProfilePatch.repairRetiredDisabledRows(live)

    assertFalse("退役行 ui-layout 的残留必须清掉", result.text.contains("ui-layout"))
    assertTrue("未取证的行（permission）不得被自愈触碰", result.text.contains("permission"))
    assertTrue(result.text.contains("open-in-app"))
    assertEquals(1, result.changes.size)
  }

  @Test
  fun retiredRepairKeepsBlocksThatStillCarryOtherKeys() {
    val live = """
      - id: ui-layout
        disabled: true
        config:
          someUserTweak: 1
    """.trimIndent() + "\n"

    val result = FactoryProfilePatch.repairRetiredDisabledRows(live)

    assertTrue("只清 disable，用户 config 必须保留", result.text.contains("someUserTweak"))
    assertFalse(result.text.contains("disabled: true"))
  }

  @Test
  fun repairIsIdempotentOnACleanFile() {
    val result = FactoryProfilePatch.repairRetiredDisabledRows(currentFactory)

    assertEquals(currentFactory, result.text)
    assertTrue(result.changes.isEmpty())
  }

  /**
   * 维护约束守卫：权威装配清单（本仓镜像）当前不得把退役行重新写成 disabled。
   * 若未来工厂真的要禁用某行，必须同时把它从 RETIRED_DISABLED_ROW_IDS 移出并另行走查。
   */
  @Test
  fun factoryPatchNeverDisablesRetiredRows() {
    val mirror = listOf(
      File("../scripts/profile-web.cordis.patch.yml"),
      File("scripts/profile-web.cordis.patch.yml"),
    ).firstOrNull { it.isFile }
    if (mirror == null) {
      // 单模块检出（无 scripts/ 镜像）时跳过；CI/构建链内本仓必然在场。
      return
    }
    val text = mirror.readText()
    for (block in FactoryProfilePatch.topLevelBlocks(text)) {
      val ids = FactoryProfilePatch.blockIds(block)
      if (ids.none { it in FactoryProfilePatch.RETIRED_DISABLED_ROW_IDS }) continue
      assertFalse(
        "权威清单 " + mirror.path + " 把退役行 " + ids + " 又写成 disabled——" +
          "必须同步 RETIRED_DISABLED_ROW_IDS 或撤销该 disable",
        FactoryProfilePatch.disabledValue(block) == true,
      )
    }
  }

  /**
   * 接线守卫：自愈必须在引擎读 profile 之前（startEngine 的装配前段）。
   * 仅靠纯函数测试覆盖不到「没接上」这种缺陷形态。
   */
  @Test
  fun profileRepairIsWiredIntoEngineStartBeforeAssembly() {
    val src = listOf(
      File("src/main/java/com/dsharnessmobile/shell/EngineManager.kt"),
      File("app/src/main/java/com/dsharnessmobile/shell/EngineManager.kt"),
    ).firstOrNull { it.isFile }
    if (src == null) {
      // 与 CallSiteContractTest 相同的保守处理：找不到源码即失败（环境异常，不是通过）。
      throw AssertionError("找不到 EngineManager.kt（工作目录 = " + File(".").absolutePath + "）")
    }
    val code = src.readText()
    val start = code.indexOf("fun startEngine(")
    assertTrue(start > 0)
    val body = code.substring(start)
    val repairAt = body.indexOf("repairProfilePatch()")
    val spawnAt = body.indexOf("startWithArgs(")
    assertTrue("startEngine 必须调用 repairProfilePatch()", repairAt > 0)
    assertTrue("自愈必须排在真正 spawn 之前", spawnAt < 0 || repairAt < spawnAt)
  }
}
