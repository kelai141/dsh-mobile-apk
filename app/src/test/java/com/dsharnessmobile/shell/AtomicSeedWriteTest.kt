package com.dsharnessmobile.shell

import java.io.File
import org.junit.Test
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue

/**
 * issue #1609：`settings.yaml` 与手机操控预设的写入必须走**唯一原子写入口**。
 *
 * 缺陷形态：本仓对同类文件早已统一走 `AtomicFileReplace`（同文件 `publishFingerprint` /
 * `publishOnlineIdentity` 就是），唯独下面这几处还是裸 `writeText`——而它们是**截断后直写**：
 * 写到一半被杀 / 磁盘满就留下半份文件。
 *
 *  - `repairSettingsSeed` 的 `settings.yaml` 是引擎每次启动都读、且是**唯一**修复坏裸键的路径，
 *    半份 YAML ⇒ 引擎 settings section 解析失败 ⇒ 正是这条修复要治的症状被它自己放大；
 *  - `seedPhoneControlPreset` 的 SKILL.md 每次启动刷新；agent.cordis.yml / preset.yml 播种，
 *    而幂等早退判据正是「preset.yml 存在」⇒ 半份 preset.yml 会让判据成立且永不重试。
 *
 * 判据是**源码级**的（与 AtomicWriteEntryTest 同口径）：这几条路径的失败分支在 JVM 上注入不出来
 * （生产代码没有 publisher 注入口），能离线、可确定复现的判据就是「写入调用点长什么样」。
 * 它能真打红：把任何一处改回裸 `writeText`，这里的断言立刻失败。
 */
class AtomicSeedWriteTest {

  private fun shellSource(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).firstOrNull { it.isFile }
    ?.readText()
    ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /** 取声明行的函数体（含声明行），按行首缩进配平第一个 `}`。 */
  private fun functionBody(source: String, signature: String): String {
    val lines = source.lines()
    val start = lines.indexOfFirst { it.contains(signature) }
    if (start < 0) throw AssertionError("找不到成员声明: " + signature)
    val indent = lines[start].takeWhile { it == ' ' }
    val end = (start + 1 until lines.size).firstOrNull { i ->
      val line = lines[i]
      line.trim() == "}" && line.takeWhile { it == ' ' } == indent
    } ?: throw AssertionError("找不到成员体的结尾: " + signature)
    return lines.subList(start, end + 1).joinToString("\n")
  }

  private val engineManager: String by lazy { codeOnly(shellSource("EngineManager.kt")) }

  /**
   * `repairSettingsSeed`：settings.yaml 的写回必须是原子写。
   *
   * 负控：把 `AtomicFileReplace.writeText(f, fixed)` 改回 `f.writeText(fixed)` ⇒ 本用例红。
   */
  @Test
  fun settingsSeedRepairUsesTheAtomicWriteEntry() {
    val body = functionBody(engineManager, "private fun repairSettingsSeed(")
    assertTrue(
      "settings.yaml 写回必须走唯一原子写入口，实际片段：" + body,
      body.contains("AtomicFileReplace.writeText(f, fixed)"),
    )
    assertFalse(
      "不得再出现裸 f.writeText（截断后直写 = 半份 YAML，正是本 issue 的症状）",
      Regex("\\bf\\.writeText\\(").containsMatchIn(body),
    )
  }

  /**
   * `seedPhoneControlPreset`：四处写入（SKILL.md / customSkillDirs 注入后的 composition /
   * 播种的 agent.cordis.yml 与 preset.yml）必须全部走原子写。
   *
   * 注：函数外的 `catch (Throwable)` 兜底口径不变——`AtomicFileReplace.writeText` 在发布失败时抛
   * `IOException`，与旧 `writeText` 落到同一个 catch，失败语义没有改变。
   */
  @Test
  fun phoneControlSeedingUsesTheAtomicWriteEntryForEveryFile() {
    val body = functionBody(engineManager, "private fun seedPhoneControlPreset(")
    val callSites = Regex("AtomicFileReplace\\.writeText\\(").findAll(body).count()
    assertTrue(
      "播种函数里应有四处原子写（SKILL / composition / agent.cordis.yml / preset.yml），实测 " + callSites,
      callSites >= 4,
    )
    assertFalse(
      "不得再出现裸 skillFile.writeText / composition.writeText / 裸 File(...).writeText，实际片段：" + body,
      Regex("\\bwriteText\\(").findAll(body).count() > callSites,
    )
    assertTrue(
      "SKILL.md 刷新仍在「内容不一致」分支里（不得变成无条件写）",
      body.contains("if (existingSkill?.trim() != PHONE_CONTROL_SKILL.trim())"),
    )
    assertTrue(
      "坑 170 的在场守卫必须保留（否则干净安装时第一步就抛 ENOENT）",
      body.contains("if (skillFile.isFile) skillFile.readText() else null"),
    )
  }

  /** 反向：`ensurePrivateDshData` 的 marker 不在 issue 范围内，但 SETTINGS 面不得有裸写回。 */
  @Test
  fun theRepairPathStillGuardsOnRealChanges() {
    val body = functionBody(engineManager, "private fun repairSettingsSeed(")
    assertTrue(
      "判据必须仍是「有改动且内容确实变了」才写（零改动不得重写 settings.yaml）",
      body.contains("if (changed && fixed != src)"),
    )
  }
}
