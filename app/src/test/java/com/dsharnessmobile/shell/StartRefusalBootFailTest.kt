package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * issue #657：`EngineManager.startEngine()` 的**每一条**失败出口都必须留痕。
 *
 * 缺陷形态：7 条失败出口原先没有一条写 boot-fail.log。`hard-bundle-selection` 那两条是被
 * 调用方 `EngineStartFlow` 的 early return 跳过了写盘，其余几条则从来没写过。结果是
 * 「引擎为什么没起来」在 boot-fail.log 里查不到——而诊断包与控制台都只读这个文件。
 *
 * ## 这份测试的负控为什么可信（第一版是假绿，已重写）
 *
 * 第一版只调 `LogCollector.writeBootFailTo` 断言「文件里有内容」——那测的是 LogCollector，
 * 不是收口逻辑。把生产侧 `refuse()` 里的落盘调用删掉，测试**照样绿**。
 *
 * 现在断言的是 [startRefusalBootFailRecord] 这个**生产分支真正调用的纯函数**：
 * - 改坏它（返回空 stage / 丢掉 reason）→ 本文件必红；
 * - 删掉 `refuse()` 里对它的调用 → 由设备层验收（boot-fail.log 出现记录）兜住，
 *   纯函数层无法覆盖，这一条如实登记在 PR 描述里。
 */
class StartRefusalBootFailTest {

  @get:Rule val temporary = TemporaryFolder()

  /** 六类结构化拒启码，逐条都必须产出可归属的 (stage, detail)。 */
  private val refusalCodes = listOf(
    EngineManager.REFUSAL_RUNTIME_UNAVAILABLE,
    EngineManager.REFUSAL_LIVE_RUNTIME_INCOMPLETE,
    EngineManager.REFUSAL_HARD_BUNDLE_SELECTION,
    EngineManager.REFUSAL_STORAGE_FULL,
    EngineManager.REFUSAL_PRIVATE_STORAGE_DENIED,
    EngineManager.REFUSAL_PORT_FOREIGN,
  )

  @Test
  fun everyRefusalCodeYieldsItsOwnStage() {
    val stages = refusalCodes.map { code ->
      startRefusalBootFailRecord(code, "原因-" + code, emptyList()).first
    }
    assertEquals("每个码必须映射到同名 stage", refusalCodes, stages)
    assertEquals("各出口 stage 不得重复", refusalCodes.size, stages.toSet().size)
    for (stage in stages) assertTrue("stage 不得为空", stage.isNotBlank())
  }

  @Test
  fun unclassifiedExitFallsBackToANamedStage() {
    val (stage, detail) = startRefusalBootFailRecord(null, "未归类原因", emptyList())
    assertEquals("engine-start-refused", stage)
    assertTrue("detail 必须带上原因", detail.contains("未归类原因"))
    assertTrue("必须写明是 startEngine 拒启", detail.contains("startEngine()"))
  }

  /** 空字符串码/原因同样不得产生 `stage= ` 或空 reason——这两者是排障时的死胡同。 */
  @Test
  fun blankCodeAndBlankReasonStillProduceUsableRecord() {
    val (stage, detail) = startRefusalBootFailRecord("   ", "", emptyList())
    assertEquals("engine-start-refused", stage)
    assertTrue("空原因必须回落到占位文案", detail.contains("无 refusal 文案"))
  }

  /** 确诊项必须进 detail——它是「自动恢复为什么没触发」的唯一线索。 */
  @Test
  fun confirmedEntriesAreCarriedIntoDetail() {
    val (_, detail) = startRefusalBootFailRecord(
      EngineManager.REFUSAL_LIVE_RUNTIME_INCOMPLETE,
      "live 树残缺",
      listOf("bin/node", "lib/bin.js"),
    )
    assertTrue("必须带上 confirmed 列表", detail.contains("confirmed=bin/node,lib/bin.js"))
  }

  @Test
  fun confirmedIsOmittedWhenEmpty() {
    val (_, detail) = startRefusalBootFailRecord(null, "原因", emptyList())
    assertTrue("空确诊项不该产出 confirmed= 字段", !detail.contains("confirmed="))
  }

  /** 端到端：把纯函数的产出真的写进 boot-fail.log，读到的是同一条。 */
  @Test
  fun recordSurvivesAnActualWrite() {
    val dir = temporary.newFolder("files")
    val (stage, detail) = startRefusalBootFailRecord(
      EngineManager.REFUSAL_HARD_BUNDLE_SELECTION,
      "Hard 清单缺失",
      emptyList(),
    )
    LogCollector.writeBootFailTo(dir, stage, detail, null, 1_700_000_000_000L)
    val log = File(dir, "boot-fail.log")
    assertTrue("必须落盘", log.isFile)
    val line = log.readLines().single { it.isNotBlank() }
    assertTrue("行内必须含 stage", line.contains("stage=" + stage))
    assertTrue("行内必须含原因", line.contains("Hard 清单缺失"))
  }
}
