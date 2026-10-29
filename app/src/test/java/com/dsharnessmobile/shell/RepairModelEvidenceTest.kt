package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「修复助手为什么说没有模型」必须能被用户读懂，也必须能被用户取走。
 *
 * 两件事各一个契约：
 *  - UI：每个来源状态都要有可判读的中文说明，不能落到兜底句「格式无法解析」；
 *  - 诊断包：`filesDir/repair-model-source.json` 要进共享诊断目录，
 *    否则引擎已死、助手又打不开时，用户没有任何可达路径拿到这份现场。
 *
 * 源码扫描式断言（本仓既有做法）：不引 Robolectric，直接读 .kt 文本。
 */
class RepairModelEvidenceTest {

  private val newline: String = 10.toChar().toString()

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    return (candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name)).readText()
  }

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString(newline)

  // ── 1. 每个来源状态都有可判读说明 ────────────────────────────────────────

  @Test
  fun `来源状态表覆盖读取层产出的每一种状态`() {
    // RepairModelConfig 可能写出的状态集合。新增状态而 UI 没跟上，就会掉进兜底句，
    // 用户看到「格式无法解析」但文件其实只是「已迁移、本轮未读」。
    val produced = listOf(
      "parsed", "missing", "unsafe", "invalid",
      "skipped-legacy", "fallback-used", "no-credential",
    )
    val ui = codeOnly(source("RepairActivity.kt"))
    for (status in produced) {
      assertTrue("UI 必须为状态 " + status + " 给出说明",
        ui.contains("\"" + status + "\" ->"))
    }
  }

  @Test
  fun `缺凭据与没配置必须是两句不同的话`() {
    // 这两种情况的修法完全不同：一个去补 API key，一个去写配置。
    val ui = codeOnly(source("RepairActivity.kt"))
    val noCred = ui.substringAfter("\"no-credential\" ->").substringBefore("\"invalid\" ->");
    assertTrue("缺凭据要明确说缺凭据", noCred.contains("凭据"))
    val missing = ui.substringAfter("\"missing\" ->").substringBefore("\"unsafe\" ->");
    assertFalse("「不存在」不能说成缺凭据", missing.contains("凭据"))
  }

  // ── 2. 诊断包必须含这份证据 ───────────────────────────────────────────────

  @Test
  fun `诊断包镜像修复模型来源证据`() {
    val engine = codeOnly(source("EngineManager.kt"))
    val mirror = engine.substringAfter("fun mirrorDiagnosticsToShared(")
      .substringBefore("private fun ensureDirectory");
    assertTrue("诊断包必须带上 repair-model-source.json",
      mirror.contains("repair-model-source.json"))
    assertTrue("必须写进本轮诊断目录 dir", mirror.contains("File(dir, evidence.name)"))
  }

  @Test
  fun `镜像只读复制不改私有原件`() {
    // 原件是助手离线读取的依据，镜像过程不得改写它。
    val engine = codeOnly(source("EngineManager.kt"))
    val mirror = engine.substringAfter("fun mirrorDiagnosticsToShared(")
    val block = mirror.substringAfter("repair-model-source.json").substringBefore("logcat");
    assertFalse("不得往私有原件写内容", block.contains("evidence.writeText"));
    assertTrue("只从原件读", block.contains("evidence.readText"));
  }

  // ── 3. 回落语义：marker 只决定优先级 ──────────────────────────────────────

  @Test
  fun `marker 不再整体跳过 settings yaml`() {
    // 旧实现是 `if (!marker.isFile) { 读 settings }`——marker 一在就整层跳过。
    // 新实现按「有没有候选」决定是否回落，marker 只参与选择先读哪层。
    val config = codeOnly(source("RepairModelConfig.kt"))
    assertFalse("不得再用 marker 作为「是否读取」的开关",
      config.contains("if (!File(dsh, \"settings.yaml.imported\").isFile)"))
    assertTrue("必须有回落分支", config.contains("includeLegacy = true"))
    assertTrue("回落判据必须是「没有候选」",
      config.contains("resolved.connections.isEmpty()"))
  }

  @Test
  fun `回落只在无候选时发生不会顶掉活动配置`() {
    val config = codeOnly(source("RepairModelConfig.kt"))
    val fallback = config.substringAfter("if (resolved.connections.isEmpty() && migrated)");
    val body = fallback.substringBefore("sources += finalSources");
    assertTrue("回落读到的候选必须非空才采用", body.contains("fallback.connections.isNotEmpty()"))
  }
}