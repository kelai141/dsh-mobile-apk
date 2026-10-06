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

  /**
   * review C8：按 id 粒度清 disabled——`- insert:` 混合块里清退役行不得连带清未取证条目
   * （旧实现 removeDisabledTrue 清块内**所有** `disabled: true`，多 id 块会误伤 permission 等）。
   */
  @Test
  fun retiredRepairClearsOnlyTheRetiredIdInsideAMixedBlock() {
    val live = """
      - insert:
          - id: ui-layout
            disabled: true
          - id: permission
            disabled: true
    """.trimIndent() + "\n"

    val result = FactoryProfilePatch.repairRetiredDisabledRows(live)

    val block = FactoryProfilePatch.topLevelBlocks(result.text).single()
    assertTrue("非退役条目仍在场", block.contains("id: permission"))
    val disabledLines = block.lines().withIndex().filter { it.value.contains("disabled:") }
    assertEquals("只允许剩一条 disabled（permission 的）", 1, disabledLines.size)
    val permissionAt = block.lines().indexOfFirst { it.contains("id: permission") }
    assertTrue("剩余 disabled 必须归属于 permission（按 id 粒度）", disabledLines.single().index > permissionAt)
    assertEquals("changes 只记退役行", 1, result.changes.size)
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

  // ── 0.14.2 D10：合并粒度 = 条目（反证用例） ─────────────────────────────

  /**
   * P-1 反证（永不追加）：live 里某个 insert 组**只含工厂组的前半子条目**时，
   * 工厂组的后半子条目必须被追加到 live 的同一个组里。
   *
   * 旧实现把 `- insert:` 组当一个块、块内任意深度的 `id:` 都算该块 id ⇒ 只要 live 里
   * 「任何块」含了工厂块的 id，整个工厂块即被判「已存在」⇒ `host-web-compat` 静默不补齐，
   * `changes=0` 且**零日志**（这正是用户担心的「更新后掉插件」的形态）。
   */
  @Test
  fun p1_partialInsertGroupStillReceivesTheMissingSibling() {
    val factory = """
      - insert:
          - id: shell-termux
            name: '@dsh-android/dsh-shell-termux'
          - id: host-web-compat
            name: '@dsh-android/dsh-host-web-compat'
    """.trimIndent() + "\n"
    val live = """
      - insert:
          - id: shell-termux
            name: '@dsh-android/dsh-shell-termux'
            config:
              writeMode: workspace-write
    """.trimIndent() + "\n"

    val result = FactoryProfilePatch.merge(live, factory)

    assertTrue(
      "P-1：live 只含组内一半时，缺失的兄弟条目必须被补进**同一个** insert 组",
      result.text.contains("id: host-web-compat"),
    )
    assertTrue(result.text.contains("name: '@dsh-android/dsh-host-web-compat'"))
    assertTrue("原有子条目与它的配置一字不动", result.text.contains("writeMode: workspace-write"))
    assertEquals("该组仍只有一个顶层块", 1, FactoryProfilePatch.topLevelBlocks(result.text).size)
    assertTrue("必须有可追溯的改动说明（旧实现在这里是零日志）", result.changes.any { it.contains("host-web-compat") })
  }

  /** P-1 反证（反向）：live 只含工厂组的**后半**子条目时，前半照样补。 */
  @Test
  fun p1_missingSiblingIsAppendedWhenOnlyTheSecondChildIsPresent() {
    val factory = """
      - insert:
          - id: shell-termux
            name: '@dsh-android/dsh-shell-termux'
          - id: host-web-compat
            name: '@dsh-android/dsh-host-web-compat'
    """.trimIndent() + "\n"
    val live = """
      - insert:
          - id: host-web-compat
            name: '@dsh-android/dsh-host-web-compat'
    """.trimIndent() + "\n"

    val result = FactoryProfilePatch.merge(live, factory)

    assertTrue("P-1：组首子条目缺席时也必须补", result.text.contains("id: shell-termux"))
    val block = FactoryProfilePatch.topLevelBlocks(result.text).first { it.startsWith("- insert:") }
    assertEquals(
      "补进来的条目必须落在同一个组里（顺序 = 组首缺席项先补）",
      listOf("shell-termux", "host-web-compat"),
      FactoryProfilePatch.blockIds(block),
    )
  }

  /**
   * P-2 反证（误归属）：工厂对 insert 组内**非首个子条目**声明的 `disabled` 必须落在
   * **该子条目自己**那一行上。
   *
   * 旧实现按「块」纠正 ⇒ 把 disabled 插到**组首子条目**之后，目标子条目一字未动
   * （设备实读复现：声明纠正 `host-web-compat`，实际改的是 `shell-termux`）。
   */
  @Test
  fun p2_disabledCorrectionLandsOnTheTargetChildNotTheGroupHead() {
    val factory = """
      - id: host-web-compat
        disabled: true
    """.trimIndent() + "\n"
    val live = """
      - insert:
          - id: shell-termux
            name: '@dsh-android/dsh-shell-termux'
          - id: host-web-compat
            name: '@dsh-android/dsh-host-web-compat'
    """.trimIndent() + "\n"

    val result = FactoryProfilePatch.merge(live, factory)

    val lines = result.text.lines()
    val shellAt = lines.indexOfFirst { it.trim() == "- id: shell-termux" }
    val siblingAt = lines.indexOfFirst { it.trim() == "- id: host-web-compat" }
    val disabledAt = lines.indexOfFirst { it.trim() == "disabled: true" }
    assertTrue("两个子条目都必须在场", shellAt >= 0 && siblingAt >= 0)
    assertTrue("P-2：disabled 必须写出来", disabledAt >= 0)
    assertTrue(
      "P-2：disabled 必须落在目标子条目之后（旧实现落在组首之后）",
      disabledAt > siblingAt,
    )
    assertTrue("组首子条目不得被误加 disabled", disabledAt > shellAt)
    assertEquals("只能有一条 disabled 行", 1, lines.count { it.trim() == "disabled: true" })
  }

  /**
   * P-1/P-2 的**串扰**反证：工厂同时含一个顶层 disabled 行与一个 insert 组，
   * 且组内出现了与顶层行同名的 id —— 两者必须各自处理，互不吞并。
   */
  @Test
  fun p1p2_topLevelRowAndInsertGroupWithTheSameIdAreBothHonoured() {
    val factory = """
      - id: agent-default-model
        disabled: true
      - insert:
          - id: mobile-default-model
            name: '@deepseek-ai/dsh-agent-default-model'
    """.trimIndent() + "\n"
    val live = """
      - insert:
          - id: mobile-default-model
            name: '@deepseek-ai/dsh-agent-default-model'
    """.trimIndent() + "\n"

    val result = FactoryProfilePatch.merge(live, factory)

    assertTrue(
      "顶层工厂行（id 与组内子条目同名）必须照旧追加",
      result.text.contains("- id: agent-default-model"),
    )
    assertTrue("组内子条目原样保留", result.text.contains("mobile-default-model"))
    val group = FactoryProfilePatch.topLevelBlocks(result.text).first { it.startsWith("- insert:") }
    assertFalse("组首子条目不得被顶层行的 disabled 串扰", group.contains("disabled: true"))
  }

  /** live 为显式空序列 `[]`（3 字节、非空）时必须按「空」处理并落工厂件（旧实现阻断全部追加）。 */
  @Test
  fun emptySequenceLiveStillReceivesTheFactoryFile() {
    val factory = "- id: bash-sandbox\n  disabled: true\n- insert:\n    - id: shell-termux\n      name: '@dsh-android/dsh-shell-termux'\n"

    val result = FactoryProfilePatch.merge("[]\n", factory)

    assertEquals("显式空序列 = 空，工厂件原样落盘", factory, result.text)
    assertTrue(result.changes.isNotEmpty())
  }

  /** 裸 `-`（行尾无空格）是合法列表项，不得把两个块并成一个；tab 缩进的子条目不得被当顶层项。 */
  @Test
  fun bareDashAndTabIndentedChildrenDoNotBreakBlockSplitting() {
    val live = "- id: first-row\n-\n  id: second-row\n  disabled: false\n"
    val blocks = FactoryProfilePatch.topLevelBlocks(live)
    assertEquals("裸 - 必须切开两块", 2, blocks.size)
    assertEquals(listOf("first-row"), FactoryProfilePatch.blockIds(blocks[0]))
    assertEquals(listOf("second-row"), FactoryProfilePatch.blockIds(blocks[1]))

    val tabbed = "- insert:\n\t- id: tabbed-child\n\t  name: '@dsh-android/dsh-shell-termux'\n"
    assertEquals(
      "tab 缩进的子条目仍是条目（不是顶层项）",
      listOf("tabbed-child"),
      FactoryProfilePatch.blockIds(FactoryProfilePatch.topLevelBlocks(tabbed).single()),
    )
  }

  /**
   * 条目级 `blockIds`：配置块内的 `- id:`（模型表）不是条目。
   * 旧实现把它们算作块 id ⇒ 既让 disabled 归属判断失效，也让追加判据把「配置里提过」当成「条目已在场」。
   */
  @Test
  fun configNestedIdsAreNotEntries() {
    val live = """
      - id: llm-deepseek
        config:
          models:
            - id: deepseek-chat
              name: DeepSeek Chat
            - id: deepseek-reasoner
              name: DeepSeek Reasoner
    """.trimIndent() + "\n"

    val block = FactoryProfilePatch.topLevelBlocks(live).single()
    assertEquals("只认顶层条目自身的 id", listOf("llm-deepseek"), FactoryProfilePatch.blockIds(block))
  }

  /** 工厂件里的配置块不得污染 disabled 归属：id 行与 disabled 行各自只看自己那一层。 */
  @Test
  fun nestedConfigDisabledDoesNotBecomeTheEntryDisabled() {
    val factory = """
      - id: ui-theme
        config:
          preference: dark
          nested:
            disabled: true
    """.trimIndent() + "\n"
    val live = """
      - id: ui-theme
        config:
          preference: light
    """.trimIndent() + "\n"

    val result = FactoryProfilePatch.merge(live, factory)

    assertEquals("嵌套配置里的 disabled 不是条目级 disabled，不得触发纠正", live, result.text)
    assertTrue(result.changes.isEmpty())
  }

  /**
   * 真实工厂件（本仓镜像 `scripts/profile-web.cordis.patch.yml`）的**逐字节自一致**：
   * 零改动必须零重写。这是 D10 重写「块级 → 条目级」后最容易回归的性质——全文重建一旦漏字节，
   * 每次快照刷新都会无谓重写 patch（并可能把 CRLF/LF 与尾行吃掉）。
   * 同时锁定工厂件的结构事实（21 个顶层条目；唯一多子条目组 = shell-termux + host-web-compat），
   * 该事实是 P-1/P-2 触发的唯一靶子；工厂变了这里必须先红。
   * 条目数自 20 增至 22 是 0.14.2-fx-1 的产品改动：新增 `ptc-runtime` 行把 PTC 代码执行的
   * `nodeExecutable` 钉死——linker64 回落会把 process.execPath 污染成 linker64，堆参数被当成程序路径。
   * 22 减为 21 是 0.14.2-fx-2（task-80）的产品改动：`agent-default-model` 不再走
   * 「disable 上游行 + 换 `agent-default-model-mobile` 新 id insert」两条顶层块，改为**同 id 就地
   * 覆盖 config**（一条顶层块）⇒ 顶层条目数少一条。旧写法使 session-controller 的
   * `agentDefaultModel` 供给依赖一条自定义 id 的条目，它 pending 即整个 session 面静默消失。
   * 21 增回 22 是 0.14.3 追版 0.2.0-rc.2 的产品改动：上游 `bundle/web-app/cordis.patch.yml` 新增
   * `desktop-product-telemetry` 与 `product-analytics` 两行（桌面产品遥测/分析，不是 Android 服务），
   * 我方按 Android 面显式 disable 这两行——不禁则设备上会去连桌面遥测端点。两条都经
   * `check-contract.mjs` §8 核对「上游确实存在该 id」后才允许写入，不存在空指向。
   */
  @Test
  fun realFactoryFileSelfMergeIsByteIdentical() {
    val mirror = listOf(
      File("../scripts/profile-web.cordis.patch.yml"),
      File("scripts/profile-web.cordis.patch.yml"),
    ).firstOrNull { it.isFile } ?: return
    val text = mirror.readText()

    val result = FactoryProfilePatch.merge(text, text)
    assertEquals("真实工厂件自合并必须逐字节相同（否则每次刷新都重写）", text, result.text)
    assertTrue("零改动时不得有改动说明", result.changes.isEmpty())

    val blocks = FactoryProfilePatch.topLevelBlocks(text)
    // 23 = 22 个 `- ` 顶层条目 + 1 个「首个条目之前的注释头」块（parseBlocks 会把它们冲成独立块）。
    // 历史锚点：0.14.2 时代 20 个条目 ⇒ 21 块，正是本断言当时的期望值。
    assertEquals("顶层条目数（工厂件结构改变时同步本断言）", 23, blocks.size)
    val groups = blocks.map { FactoryProfilePatch.blockIds(it) }.filter { it.size > 1 }
    assertEquals("唯一多子条目组 = shell-termux + host-web-compat", 1, groups.size)
    assertEquals(listOf("shell-termux", "host-web-compat"), groups.single())
  }

  /**
   * D10 的**真实形态**反证：拿仓库里的权威工厂件，人为抹掉 @BQ@host-web-compat@BQ@ 这一条
   * （设备上真实发生过的「同一组里少一个插件」形态），merge 必须把它补回**同一个** insert 组，
   * 且其余 20 个顶层条目（21 - 1 = shell-termux 所在组）一字不动。
   *
   * 旧实现在这里 @BQ@changes=0@BQ@ 且零日志：工厂件里 @BQ@shell-termux@BQ@ 已让该块被判定「存在」。
   */
  @Test
  fun realFactoryMissingSiblingIsRestoredIntoItsOwnGroup() {
    val mirror = listOf(
      File("../scripts/profile-web.cordis.patch.yml"),
      File("scripts/profile-web.cordis.patch.yml"),
    ).firstOrNull { it.isFile } ?: return
    val factory = mirror.readText()
    val live = factory
      .lines()
      .filterNot { it.contains("host-web-compat") }
      .joinToString("\n") + if (factory.endsWith("\n")) "\n" else ""

    assertFalse("构造前提：live 里确实没有 host-web-compat 了", live.contains("host-web-compat"))

    val result = FactoryProfilePatch.merge(live, factory)

    assertTrue("D10：缺失的组内兄弟必须被补回", result.text.contains("id: host-web-compat"))
    assertTrue("补回的是同一个组（shell-termux 仍是组首）", result.text.contains("id: shell-termux"))
    assertEquals("顶层条目数不变（补进组内，不是追加成新块）", 23, FactoryProfilePatch.topLevelBlocks(result.text).size)
    val group = FactoryProfilePatch.topLevelBlocks(result.text)
      .first { FactoryProfilePatch.blockIds(it).contains("shell-termux") }
    assertEquals(listOf("shell-termux", "host-web-compat"), FactoryProfilePatch.blockIds(group))
    assertTrue("改动必须有可追溯说明（旧实现零日志）", result.changes.any { it.contains("host-web-compat") })

    // 再次合并必须稳定（幂等），否则每次快照刷新都会重写 patch。
    val second = FactoryProfilePatch.merge(result.text, factory)
    assertEquals("补齐后必须稳定", result.text, second.text)
  }

  // ── 0.14.2-fx-2 迁移：旧「单点」写法归一（issue: 升级设备上 task-80 A 修法失效）──
  //
  // 真实现场来自 emulator-5554（已升级设备，live patch 17934 B）—— 形态逐字取自设备。

  /** 设备实测的旧形态（含用户值 xiaomimimo / mimo-v2.5）。 */
  private val legacySinglePointLive = """
    # 设置界面 agent-default-model 段为用户级（UI 保存会覆盖此默认）。
    - id: agent-default-model
      disabled: true
    - insert:
        - id: agent-default-model-mobile
          name: '@deepseek-ai/dsh-agent-default-model'
          config:
            provider: xiaomimimo
            model: mimo-v2.5
    - insert:
        - id: shell-termux
          name: '@dsh-android/dsh-shell-termux'
  """.trimIndent() + "\n"

  /** 新形态（工厂件；就地覆盖 config，不再 disable / 不再换 id）。 */
  private val newShapeFactory = """
    - id: agent-default-model
      config:
        provider: deepseek-official
        model: deepseek-v4-flash
    - insert:
        - id: shell-termux
          name: '@dsh-android/dsh-shell-termux'
  """.trimIndent() + "\n"

  /** 正例（判据本体）：旧形态必须迁成新形态，且**用户值一字不差保留**。 */
  @Test
  fun legacySinglePointIsNormalizedKeepingTheUserValueVerbatim() {
    val result = FactoryProfilePatch.normalizeLegacyAgentDefaultModel(legacySinglePointLive)

    assertFalse("旧自定义 id 必须消失（单点消失）", result.text.contains("agent-default-model-mobile"))
    val upstream = FactoryProfilePatch.topLevelBlocks(result.text)
      .first { FactoryProfilePatch.blockIds(it).contains("agent-default-model") }
    assertEquals("上游行不得再被 disable", null, FactoryProfilePatch.disabledValue(upstream))
    assertTrue("用户 provider 必须逐字保留", result.text.contains("provider: xiaomimimo"))
    assertTrue("用户 model 必须逐字保留", result.text.contains("model: mimo-v2.5"))
    assertFalse("不得保留工厂 pin 的 provider", result.text.contains("provider: deepseek-official"))
    assertTrue("无关的工厂/用户块不得受影响", result.text.contains("shell-termux"))
    assertTrue("必须留下可追溯说明", result.changes.any { it.contains("归一") })
  }

  @Test
  fun legacyNormalizationReplacesPreexistingEntryConfigAndPassesStrictYaml() {
    val live = """
      - id: agent-default-model
        disabled: true
        config:
          provider: stale-provider
          nested:
            keepOld: false
      - insert:
          - id: agent-default-model-mobile
            name: '@deepseek-ai/dsh-agent-default-model'
            config:
              provider: xiaomimimo
              model: mimo-v2.5
              options:
                disabled: false
    """.trimIndent() + "\n"

    val result = FactoryProfilePatch.normalizeLegacyAgentDefaultModel(live)

    assertFalse("旧上游 config 子树必须被替换，不能与新 config 重复", result.text.contains("stale-provider"))
    assertTrue("用户 provider 必须保留", result.text.contains("provider: xiaomimimo"))
    assertTrue("用户嵌套 disabled 是数据，不是迁移控制字段", result.text.contains("disabled: false"))
    assertEquals(null, FactoryProfilePatch.verifyNormalization(live, result.text))
    SnapshotTransaction.validatePatchYaml(result.text, "cordis.patch.yml")
  }

  /** 反例 A：把触发条件放宽成「见到 -mobile 就删」⇒ 必须判红（窄条件是判据本体）。 */
  @Test
  fun aBareMobileIdWithoutOurNameMustNotBeTouched() {
    // 用户自装的同名 id（name 不是我们的包）—— 不得动。
    val userOwned = """
      - id: agent-default-model
        disabled: true
      - insert:
          - id: agent-default-model-mobile
            name: 'some-user-package'
            config:
              provider: user-choice
    """.trimIndent() + "\n"
    val result = FactoryProfilePatch.normalizeLegacyAgentDefaultModel(userOwned)
    assertEquals("name 不匹配时一律不动（宁可少迁，不可错迁）", userOwned, result.text)
    assertTrue("不该有改动", result.changes.isEmpty())
  }

  /** 反例 B：上游行**未** disabled ⇒ 不满足触发条件 ⇒ 不动。 */
  @Test
  fun alreadyNormalizedShapeIsLeftAlone() {
    val alreadyNew = """
      - id: agent-default-model
        config:
          provider: xiaomimimo
          model: mimo-v2.5
      - insert:
          - id: shell-termux
            name: '@dsh-android/dsh-shell-termux'
    """.trimIndent() + "\n"
    val result = FactoryProfilePatch.normalizeLegacyAgentDefaultModel(alreadyNew)
    assertEquals("已归一形态不得被再改", alreadyNew, result.text)
    assertTrue(result.changes.isEmpty())
  }

  /** 反例 C：完全无关的 patch 不得被改动。 */
  @Test
  fun unrelatedPatchIsUntouched() {
    val unrelated = "- id: my-row\n  disabled: true\n"
    val result = FactoryProfilePatch.normalizeLegacyAgentDefaultModel(unrelated)
    assertEquals("无关 patch 一字不动", unrelated, result.text)
    assertTrue(result.changes.isEmpty())
  }

  /** 幂等：二次运行零改写。 */
  @Test
  fun normalizationIsIdempotent() {
    val first = FactoryProfilePatch.normalizeLegacyAgentDefaultModel(legacySinglePointLive)
    val second = FactoryProfilePatch.normalizeLegacyAgentDefaultModel(first.text)
    assertEquals("第二次不得再改一字", first.text, second.text)
    assertTrue("第二次必须无改动可言", second.changes.isEmpty())
  }

  /** 端到端：经 merge() 后旧形态也必须消失（迁移挂在 merge 入口）。 */
  @Test
  fun mergeAlsoNormalizesTheLegacySinglePoint() {
    val result = FactoryProfilePatch.merge(legacySinglePointLive, newShapeFactory)
    assertFalse("经 merge 也不得残留旧 id", result.text.contains("agent-default-model-mobile"))
    assertTrue("用户值仍须保留", result.text.contains("provider: xiaomimimo"))
    assertFalse("上游行不得仍被 disable", result.text.contains("disabled: true\n  config:\n    provider: xiaomimimo"))
    // 幂等：二次 merge 零改写
    val second = FactoryProfilePatch.merge(result.text, newShapeFactory)
    assertEquals("二次 merge 不得再改", result.text, second.text)
  }

  @Test
  fun mergeMovesAuditedMnemonSourceIncludeAfterItsProvider() {
    val live = """
      # Audited Android Source fixes; the original rows remain disabled for rollback.
      # This regular Include resolves patched packages from its own local node_modules.
      - insert:
          - id: mnemon-audited-sources
            name: '@deepseek-ai/cordis-plugin-include'
            config:
              path: 'file:///data/user/0/com.dsharnessmobile.shell/files/home/.dsh/profiles/web/mnemon-runtime-fixes-20260919/cordis.yml'
      - id: mnemon-bundle
        disabled: false
      - id: mnemon
        disabled: false
        config:
          writeEnabled: true
      - id: unrelated-user-row
        name: 'user-owned-plugin'
    """.trimIndent() + "\n"
    val factory = "- id: factory-row\n"

    val result = FactoryProfilePatch.merge(live, factory)

    assertTrue(
      "main provider row must precede the Source Include which imports dsh-mnemon/client",
      result.text.indexOf("- id: mnemon\n") < result.text.indexOf("- id: mnemon-audited-sources"),
    )
    assertTrue("Include comments move with the Include", result.text.contains("# Audited Android Source fixes"))
    assertTrue("the Include path is retained verbatim", result.text.contains("mnemon-runtime-fixes-20260919/cordis.yml"))
    assertTrue("user-owned rows survive", result.text.contains("user-owned-plugin"))
    assertEquals(
      "ordering migration must not add or remove ids",
      FactoryProfilePatch.blockIds(live).toSet() + "factory-row",
      FactoryProfilePatch.blockIds(result.text).toSet(),
    )
    assertEquals("the migration must be idempotent", result.text, FactoryProfilePatch.merge(result.text, factory).text)
  }

  @Test
  fun mnemonSourceOrderMigrationDoesNotOverrideDisabledProvider() {
    val live = """
      - insert:
          - id: mnemon-audited-sources
            name: '@deepseek-ai/cordis-plugin-include'
            config:
              path: 'file:///data/user/0/com.dsharnessmobile.shell/files/home/.dsh/profiles/web/mnemon-runtime-fixes-20260919/cordis.yml'
      - id: mnemon
        disabled: true
    """.trimIndent() + "\n"

    val result = FactoryProfilePatch.normalizeMnemonSourceOrder(live)

    assertEquals("a disabled provider is intentional user state; do not reorder around it", live, result.text)
    assertTrue(result.changes.isEmpty())
  }

  // ── 结构校验的判别力（Lead 追加的两条反证）───────────────────────────────
  //
  // 校验若只是「看着对」的摆设，这两条用来钉它：删掉校验 / 漏搬一个键，都必须判红。

  /** 校验的正例：合法归一结果必须通过四条判据。 */
  @Test
  fun verifyNormalizationAcceptsAWellFormedResult() {
    val after = """
      - id: agent-default-model
        config:
          provider: xiaomimimo
          model: mimo-v2.5
      - insert:
          - id: shell-termux
            name: '@dsh-android/dsh-shell-termux'
    """.trimIndent() + "\n"
    assertEquals(
      "合法结果必须通过校验",
      null,
      FactoryProfilePatch.verifyNormalization(legacySinglePointLive, after),
    )
  }

  /**
   * 反证（Lead 追加 ①）：**只搬 provider、漏掉 model** ⇒ 必须判红。
   * 证明 (c)「用户 config 逐行保留」是判据本体，不是摆设。
   */
  @Test
  fun verifyNormalizationRejectsAResultThatDroppedOneConfigKey() {
    val lostModel = """
      - id: agent-default-model
        config:
          provider: xiaomimimo
      - insert:
          - id: shell-termux
            name: '@dsh-android/dsh-shell-termux'
    """.trimIndent() + "\n"
    val why = FactoryProfilePatch.verifyNormalization(legacySinglePointLive, lostModel)
    assertTrue("漏搬 model 必须被判红，实得: " + why, why != null)
  }

  /**
   * 反证（Lead 追加 ②）：**归一结果里 -mobile 没删掉** ⇒ id 集合不符 ⇒ 判红。
   * 等价于「删掉校验」时会被放过的坏结果之一。
   */
  @Test
  fun verifyNormalizationRejectsAResultThatKeptTheLegacyId() {
    val keptMobile = """
      - id: agent-default-model
        config:
          provider: xiaomimimo
          model: mimo-v2.5
      - insert:
          - id: agent-default-model-mobile
            name: '@deepseek-ai/dsh-agent-default-model'
      - insert:
          - id: shell-termux
            name: '@dsh-android/dsh-shell-termux'
    """.trimIndent() + "\n"
    val why = FactoryProfilePatch.verifyNormalization(legacySinglePointLive, keptMobile)
    assertTrue("残留 -mobile 必须被判红，实得: " + why, why != null)
  }

  /** 反证：上游 id 仍带 disabled: true ⇒ 判红。 */
  @Test
  fun verifyNormalizationRejectsAResultThatLeftTheDisableInPlace() {
    val stillDisabled = """
      - id: agent-default-model
        disabled: true
        config:
          provider: xiaomimimo
          model: mimo-v2.5
      - insert:
          - id: shell-termux
            name: '@dsh-android/dsh-shell-termux'
    """.trimIndent() + "\n"
    val why = FactoryProfilePatch.verifyNormalization(legacySinglePointLive, stillDisabled)
    assertTrue("残留 disabled 必须被判红，实得: " + why, why != null)
  }

  /** 校验取值与归一实际搬的是同一份（同一 helper）——防「校验与实现漂移」。 */
  @Test
  fun legacyMobileConfigLinesIsTheSharedSourceOfTruth() {
    val lines = FactoryProfilePatch.legacyMobileConfigLines(legacySinglePointLive)
    assertTrue("必须取到 config 键行", lines.any { it.trim() == "config:" })
    assertTrue("必须含用户 provider", lines.any { it.contains("provider: xiaomimimo") })
    assertTrue("必须含用户 model", lines.any { it.contains("model: mimo-v2.5") })
    assertTrue(
      "不满足形态时返回空（用于「不动」判定）",
      FactoryProfilePatch.legacyMobileConfigLines("- id: unrelated\n").isEmpty(),
    )
  }
}
