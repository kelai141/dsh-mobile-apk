package com.dsharnessmobile.shell

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * #582 里两块 SafeMode 修复的回归面（M-7A / M-7B）。这两块是 #614/#615 都**没有**覆盖的部分。
 *
 * M-7A：`filterThirdPartyInserts` 的组终止边界只认顶层列表项，insert 组后跟随的**列 0 注释**
 * 被吞进组体，随第三方条目过滤一起被静默丢弃——与函数文档「其余内容逐字保留」矛盾。
 *
 * M-7B：legacy 状态迁移的写序是「原子写 current → 删 legacy」，两步之间被打断会留下两份
 * **逐字节相同**的状态文件。旧实现一律拒绝且不给任何出路，用户被永久锁死。
 */
class SafeModeInsertBoundaryTest {

  @get:Rule val temporary = TemporaryFolder()

  // ── M-7A：insert 组边界 ────────────────────────────────────────────────

  /** 缺陷原形：列 0 注释跟在 insert 组后面，必须逐字保留。 */
  @Test
  fun columnZeroCommentsAfterInsertGroupArePreserved() {
    val patch = listOf(
      "# 顶部说明",
      "- insert:",
      "    - id: prod-one",
      "      name: prod-one-pkg",
      "# 组间注释（列 0）——不得随第三方条目过滤被吞",
      "",
      "- insert:",
      "    - id: third-party",
      "      name: evil-pkg",
      "      config:",
      "        x: 1",
      "# 尾注释",
    ).joinToString("\n") + "\n"
    val entries = setOf(PluginMounts.HardEntry("prod-one", "prod-one-pkg"))
    val filtered = SafeMode.filterThirdPartyInserts(patch, entries)

    assertFalse("第三方条目必须被摘除", filtered.contains("evil-pkg"))
    assertTrue("产品条目必须保留", filtered.contains("prod-one-pkg"))
    assertTrue("顶部注释必须逐字保留（M-7A）", filtered.contains("# 顶部说明"))
    assertTrue("组间列 0 注释必须保留（M-7A）", filtered.contains("# 组间注释（列 0）"))
    assertTrue("尾注释必须保留（M-7A）", filtered.contains("# 尾注释"))
  }

  /**
   * 缺陷的破坏力：旧判据下注释被吞进组体，若组内条目全被摘光，整组连注释一起删掉——
   * 于是注释**静默消失**，而不是「被挪了位置」。
   */
  @Test
  fun commentsSurviveWhenTheWholeGroupIsRemoved() {
    val patch = listOf(
      "- insert:",
      "    - id: only-third-party",
      "      name: evil-pkg",
      "# 紧跟在这个空组后面的注释",
      "- insert:",
      "    - id: prod-one",
      "      name: prod-one-pkg",
    ).joinToString("\n") + "\n"
    val entries = setOf(PluginMounts.HardEntry("prod-one", "prod-one-pkg"))
    val filtered = SafeMode.filterThirdPartyInserts(patch, entries)

    assertFalse("整组被摘光时第三方条目必须消失", filtered.contains("evil-pkg"))
    assertTrue("但注释不得跟着消失（M-7A）", filtered.contains("# 紧跟在这个空组后面的注释"))
    assertTrue("后面的产品条目必须保留", filtered.contains("prod-one-pkg"))
  }

  /** 子条目恒有缩进：带缩进的注释属于组体，必须跟着组一起处理，不能被当成新组边界。 */
  @Test
  fun indentedCommentsStillBelongToTheGroup() {
    val patch = listOf(
      "- insert:",
      "    - id: prod-one",
      "      name: prod-one-pkg",
      "      # 组内缩进注释",
      "      config:",
      "        x: 1",
      "- insert:",
      "    - id: prod-two",
      "      name: prod-two-pkg",
    ).joinToString("\n") + "\n"
    val entries = setOf(
      PluginMounts.HardEntry("prod-one", "prod-one-pkg"),
      PluginMounts.HardEntry("prod-two", "prod-two-pkg"),
    )
    val filtered = SafeMode.filterThirdPartyInserts(patch, entries)
    assertTrue("组内缩进注释随组保留", filtered.contains("# 组内缩进注释"))
    assertTrue(filtered.contains("prod-one-pkg"))
    assertTrue(filtered.contains("prod-two-pkg"))
  }

  /** 无改动时输出必须与输入逐字节相同（调用方据此跳过写盘）。 */
  @Test
  fun untouchedPatchIsByteIdentical() {
    val patch = listOf(
      "# 头注释",
      "- insert:",
      "    - id: prod-one",
      "      name: prod-one-pkg",
      "# 中注释",
      "",
      "# 尾注释",
    ).joinToString("\n") + "\n"
    val entries = setOf(PluginMounts.HardEntry("prod-one", "prod-one-pkg"))
    assertTrue("无第三方条目时必须逐字节不变", SafeMode.filterThirdPartyInserts(patch, entries) == patch)
  }

  // ── M-7B：迁移崩溃窗口 ────────────────────────────────────────────────

  private fun autoDir(): File = File(temporary.newFolder(), "auto").apply { mkdirs() }

  /** 崩溃窗口现场：current 已写、legacy 未删，两份逐字节相同。必须收敛而不是拒绝。 */
  @Test
  fun identicalDuplicateStateConvergesInsteadOfRefusing() {
    val dir = autoDir()
    val body = JSONObject().put("active", false).put("snapshotId", "st-interrupted").toString()
    File(dir, SafeMode.STATE_FILE).writeText(body)
    val legacy = File(dir, "safe-mode-state.json")
    legacy.writeText(body)

    val status = SafeMode.status(dir)
    assertTrue("内容相同必须自动收敛（M-7B），实际：" + status.message, status.ok)
    assertFalse("收敛后旧状态文件必须被清理", legacy.exists())
    assertTrue("新状态文件必须保留", File(dir, SafeMode.STATE_FILE).isFile)
  }

  /** 反面：两份内容**不一致**是真歧义，仍必须拒绝，且两份都不动。 */
  @Test
  fun conflictingDuplicateStateIsStillRefused() {
    val dir = autoDir()
    File(dir, SafeMode.STATE_FILE).writeText(
      JSONObject().put("active", false).put("snapshotId", "cur").toString(),
    )
    val legacy = File(dir, "safe-mode-state.json")
    legacy.writeText(JSONObject().put("active", false).put("snapshotId", "other").toString())

    val status = SafeMode.status(dir)
    assertFalse("内容不一致必须仍拒绝（M-7B 反面）", status.ok)
    assertTrue("旧状态文件必须保留（不给猜测）", legacy.isFile)
    assertTrue("新状态文件必须保留", File(dir, SafeMode.STATE_FILE).isFile)
  }

  /** 拒绝文案必须给出出路，不能只说「拒绝猜测恢复来源」。 */
  @Test
  fun refusalMessageTellsTheUserWhatToDo() {
    val dir = autoDir()
    File(dir, SafeMode.STATE_FILE).writeText(JSONObject().put("active", false).put("snapshotId", "cur").toString())
    File(dir, "safe-mode-state.json").writeText(JSONObject().put("active", false).put("snapshotId", "other").toString())
    val status = SafeMode.status(dir)
    assertFalse(status.ok)
    assertTrue("文案必须说明两份文件不一致：" + status.message, status.message.contains("不一致"))
    assertTrue("文案必须给出处置指引：" + status.message, status.message.contains("控制台") || status.message.contains("手动"))
  }

  // ---- 2026-10-28 自查：config 子树的 name 不得参与条目归属判定（误摘方向） ----

  @Test
  fun `config 里有 name 的产品条目必须保留`() {
    // 旧实现取「片段里第一个 name:」⇒ 取到 config 里的那个 ⇒ 与 Hard 清单的 name 不匹配
    // ⇒ 判成第三方整条摘掉。而文档承诺「没有 name 就保留（宁可不摘也不误伤）」。
    val patch = listOf(
      "- insert:",
      "    - id: prod-one",
      "      config:",
      "        name: whatever-the-plugin-calls-itself",
    ).joinToString("\n") + "\n"
    val entries = setOf(PluginMounts.HardEntry("prod-one", "prod-one-pkg"))
    val filtered = SafeMode.filterThirdPartyInserts(patch, entries)
    assertTrue("没有键层 name 的条目不得被摘：" + filtered, filtered.contains("- id: prod-one"))
    assertTrue(filtered.contains("name: whatever-the-plugin-calls-itself"))
  }

  @Test
  fun `config 里再深一层 name 的第三方条目仍要摘`() {
    val patch = listOf(
      "- insert:",
      "    - id: evil",
      "      name: evil-pkg",
      "      config:",
      "        name: nested-must-not-matter",
    ).joinToString("\n") + "\n"
    val entries = setOf(PluginMounts.HardEntry("prod-one", "prod-one-pkg"))
    val filtered = SafeMode.filterThirdPartyInserts(patch, entries)
    assertFalse("真第三方（键层 name 不匹配）必须摘掉：" + filtered, filtered.contains("- id: evil"))
  }

  @Test
  fun `键层 name 在 config 之后出现时仍按最浅缩进认出来`() {
    val patch = listOf(
      "- insert:",
      "    - id: prod-one",
      "      config:",
      "        name: shadow-inside-config",
      "      name: prod-one-pkg",
    ).joinToString("\n") + "\n"
    val entries = setOf(PluginMounts.HardEntry("prod-one", "prod-one-pkg"))
    val filtered = SafeMode.filterThirdPartyInserts(patch, entries)
    assertTrue("键层 name 与 Hard 清单一致 ⇒ 保留：" + filtered, filtered.contains("- id: prod-one"))
  }
}
