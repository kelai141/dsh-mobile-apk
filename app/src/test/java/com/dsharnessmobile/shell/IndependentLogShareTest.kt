package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.zip.ZipFile

/**
 * tester 独立验证：0.14.6 功能 B（启动页错误日志快捷分享）。
 *
 * 本文件**不复用** dev-share 的 LogShareTest / LogSanitizerTest（职责分离）。
 * 用例由 tester 从 SPEC B1-B7 与验收判据自行推导，重点是**独立构造的反例**：
 *  - 反例 1：候选清单是**闭集**，不得包含配置 / 凭据 / 工作区 / 会话类路径（B4 结构性禁止）；
 *  - 反例 2：脱敏失败必须 **fail-closed**（丢弃整条 + manifest 如实标注），绝不原样写入；
 *  - 反例 3：缺失日志必须如实标 absent，不得留空、不得凭空造条目；
 *  - 反例 4：压缩失败必须**不留半截产物**且如实返回原因；
 *  - 反例 5：入口可见性判据不得「无证据也点亮」（B1/B3），也不得「有证据却隐藏」。
 *
 * 打包核心是纯 IO，可直接打真实文件；本用例集不依赖设备。
 */
class IndependentLogShareTest {

  @get:Rule
  val tmp = TemporaryFolder()

  // ── 反例 1：候选清单是闭集，不得含凭据/配置/工作区/会话 ─────────────────────
  @Test
  fun candidateFilesAreAClosedSetWithoutSensitivePaths() {
    val filesDir = tmp.newFolder("files")
    val names = LogShare.candidateFiles(filesDir).map { it.name }
    // 必须逐一等于声明的白名单（不是「包含」，是「恰好」——多一个就是越界）
    // issue #1599：engine.log 及其轮转世代已移出候选面（白名单挡的是文件名，挡不住内容：
    // 那份文件就是完整会话）。闭集判据不变，只是闭集本身变小了。
    val expected = listOf(
      "boot-fail.log", "boot-fail.log.1",
      "boot-diag.log", "boot-diag.log.1",
      "boot-segments.log", "boot-segments.log.1",
    )
    assertEquals("候选清单必须恰好等于白名单（多/少都是缺陷）", expected, names)
    // 反例：凭据 / 配置 / 工作区 / 会话类名一律不得出现
    val banned = listOf(
      "settings.yaml", "credentials", "credential.json", "token", "apiKey",
      "cordis.patch.yml", ".snapshot-fingerprint", "package.json",
    )
    for (b in banned) {
      assertFalse("候选清单不得含 $b（B4：不主动包含无关数据）", names.any { it.contains(b) })
    }
    // 所有候选都必须落在 filesDir 直下（不得做目录遍历、不得指到 .dsh）
    for (f in LogShare.candidateFiles(filesDir)) {
      assertEquals("候选必须直接在 filesDir 下", filesDir.absolutePath, f.parentFile.absolutePath)
    }
  }

  // ── 反例 3：缺失日志如实标 absent，不凭空造条目 ─────────────────────────────
  @Test
  fun missingLogsAreReportedAbsentAndNoEntryIsFabricated() {
    val filesDir = tmp.newFolder("files")
    val zip = File(tmp.root, "diag.zip")
    val inputs = LogShare.fileEntries(filesDir, null)
    val result = LogShare.packTo(zip, inputs)
    assertTrue("打包应成功（条目全缺也要出包，附 manifest）", result.ok)
    // 除 manifest 外不得有任何文件条目
    ZipFile(zip).use { zf ->
      val names = zf.entries().toList().map { it.name }
      assertEquals("只应含 manifest.txt", listOf(LogShare.MANIFEST_NAME), names)
      val manifest = zf.getInputStream(zf.getEntry(LogShare.MANIFEST_NAME)).readBytes().toString(Charsets.UTF_8)
      // 如实标注：每个缺失日志都必须有一条 =absent
      val absents = manifest.lines().count { it.endsWith("=absent") }
      // 候选面 6 条 + dsh-day.log 1 条 = 7 条全缺（issue #1599 后 engine.log 不再计入）。
      assertTrue("manifset 必须如实标注缺失条目，实得 $absents 条", absents >= 7)
      assertTrue("manifest 必须自我说明「没有任何条目被静默丢弃」", manifest.contains("没有"))
    }
    // 报告里也要如实
    assertTrue("report 必须有 absent 项", result.report.any { it.endsWith("=absent") })
  }

  // ── 反例 2：脱敏失败必须 fail-closed ────────────────────────────────────────
  @Test
  fun sanitizeFailureDiscardsEntryAndIsReported() {
    val filesDir = tmp.newFolder("files")
    // 造一份「一定存在」的日志（issue #1599：engine.log 已不在候选面内，改用壳侧启动日志）。
    File(filesDir, "boot-diag.log").writeText("SECRET-RAW-CONTENT token=abc123\n")
    val zip = File(tmp.root, "diag.zip")
    val inputs = LogShare.fileEntries(filesDir, null)
    // 注入一个必然失败的脱敏器（覆盖 fail-closed 分支）
    val result = LogShare.packTo(zip, inputs) { null }
    assertTrue(result.ok)
    ZipFile(zip).use { zf ->
      val names = zf.entries().toList().map { it.name }
      assertFalse("脱敏失败时绝不写入该条目", names.contains("boot-diag.log"))
      val manifest = zf.getInputStream(zf.getEntry(LogShare.MANIFEST_NAME)).readBytes().toString(Charsets.UTF_8)
      assertTrue(
        "manifest 必须标注 sanitize-failed",
        manifest.contains("boot-diag.log=" + LogSanitizer.DEREDACT_FAILED),
      )
      // 更强：整个包里不得出现原始密文
      for (e in zf.entries()) {
        val text = zf.getInputStream(e).readBytes().toString(Charsets.UTF_8)
        assertFalse("ZIP 任何条目都不得含被丢弃条目的原文（条目 " + e.name + "）", text.contains("SECRET-RAW-CONTENT"))
      }
    }
  }

  // ── 正例：有内容时确实写入且经过脱敏 ────────────────────────────────────────
  @Test
  fun presentLogIsPackedAfterSanitizing() {
    val filesDir = tmp.newFolder("files")
    File(filesDir, "boot-diag.log").writeText("dsh web: http://127.0.0.1:3080/?token=FIXTURESESSIONTOKEN1234567890ABCDEFGHIJKLM\n")
    val zip = File(tmp.root, "diag.zip")
    val result = LogShare.packTo(zip, LogShare.fileEntries(filesDir, null))
    assertTrue(result.ok)
    ZipFile(zip).use { zf ->
      val entry = zf.getEntry("boot-diag.log")
      assertNotNull("有内容的日志应被写入", entry)
      val text = zf.getInputStream(entry).readBytes().toString(Charsets.UTF_8)
      assertFalse("启动令牌必须已被脱敏", text.contains("FIXTURESESSIONTOKEN1234567890ABCDEFGHIJKLM"))
      assertTrue("脱敏后应保留 URL 形状", text.contains("token=***"))
    }
    assertTrue("report 应标 present", result.report.any { it.startsWith("boot-diag.log=present") })
  }

  // ── manifest 必须恒定在场，且逐条状态与 report 一致 ─────────────────────────
  @Test
  fun manifestIsAlwaysPresentAndMatchesReport() {
    val filesDir = tmp.newFolder("files")
    File(filesDir, "boot-diag.log").writeText("ok\n")
    val zip = File(tmp.root, "diag.zip")
    val result = LogShare.packTo(zip, LogShare.fileEntries(filesDir, null))
    ZipFile(zip).use { zf ->
      assertNotNull("manifest.txt 恒在场（B6 如实标注的载体）", zf.getEntry(LogShare.MANIFEST_NAME))
      val manifest = zf.getInputStream(zf.getEntry(LogShare.MANIFEST_NAME)).readBytes().toString(Charsets.UTF_8)
      // report 的每一条都应出现在 manifest 里（不得自相矛盾）
      for (line in result.report) {
        assertTrue("manifest 应含 report 行：$line", manifest.contains(line))
      }
      assertTrue("manifest 应写条目数", manifest.contains("条目数="))
    }
  }

  // ── 反例 4：压缩失败必须不留半截产物 ────────────────────────────────────────
  @Test
  fun packFailureLeavesNoPartialArtifact() {
    val root = tmp.newFolder("root")
    // 目标父路径被一个**普通文件**占住 => mkdirs 失败 => 进入 catch 分支
    val blocker = File(root, "blocked")
    blocker.writeText("not a directory")
    val zip = File(blocker, "diag.zip")
    val result = LogShare.packTo(zip, listOf(LogShare.InputEntry("x.txt") { "hello" }))
    assertFalse("父路径不可建时必须判失败", result.ok)
    assertNull("失败时不得给出产物", result.zipFile)
    assertNotNull("失败必须带可读原因", result.reason)
    assertTrue("原因应可辨识", (result.reason ?: "").isNotBlank())
    // 不得留下 .tmp 半截：临时文件与目标同目录，两处都查（blocked 是文件，故其"下"不可能有；
    // root 下也不许有——覆盖实现把 tmp 放错位置的情形）
    assertFalse("不得残留 " + File(blocker, "diag.zip.tmp").absolutePath, File(blocker, "diag.zip.tmp").exists())
    assertFalse("不得残留 " + File(root, "diag.zip.tmp").absolutePath, File(root, "diag.zip.tmp").exists())
    // 也不得在别处留下任何 .tmp
    val stray = root.walkTopDown().filter { it.name.endsWith(".tmp") }.toList()
    assertTrue("不得残留任何 .tmp：$stray", stray.isEmpty())
  }

  // ── B1/B3：入口可见性判据 ───────────────────────────────────────────────────
  @Test
  fun offerVisibilityFollowsEvidence() {
    val filesDir = tmp.newFolder("files")
    // 反例：无任何证据且相位未失败 => 不得点亮
    assertFalse("无证据不得点亮分享入口", LogShare.shouldOffer(filesDir, phaseFailed = false))
    // 反例：空文件不算证据（0 字节不是诊断）
    File(filesDir, "boot-fail.log").writeText("")
    assertFalse("空的 boot-fail.log 不构成证据", LogShare.shouldOffer(filesDir, phaseFailed = false))
    // 正例：boot-fail 有内容即点亮
    File(filesDir, "boot-fail.log").writeText("stage=engine-start-false\n")
    assertTrue("boot-fail 有内容应点亮", LogShare.shouldOffer(filesDir, phaseFailed = false))
    // 正例：相位失败即点亮（无需日志文件——引擎起不来时最需要它）
    val clean = tmp.newFolder("files2")
    assertTrue("相位已失败应点亮（B3：不依赖故障中的服务）", LogShare.shouldOffer(clean, phaseFailed = true))
    // 正例：boot-diag 有内容即点亮
    val diagDir = tmp.newFolder("files3")
    File(diagDir, "boot-diag.log").writeText("x\n")
    assertTrue("boot-diag 有内容应点亮", LogShare.shouldOffer(diagDir, phaseFailed = false))
    // hasEvidence 的真值表（穷举）
    for (a in listOf(true, false)) for (b in listOf(true, false)) for (c in listOf(true, false)) {
      assertEquals("hasEvidence($a,$b,$c)", a || b || c, LogShare.hasEvidence(a, b, c))
    }
  }

  // ── 反例：ZIP 条目名必须恰好是候选名（不得带路径前缀/穿越）────────────────────
  @Test
  fun zipEntryNamesHaveNoTraversalOrPrefixes() {
    val filesDir = tmp.newFolder("files")
    File(filesDir, "boot-diag.log").writeText("ok\n")
    File(filesDir, "boot-diag.log").writeText("ok\n")
    val zip = File(tmp.root, "diag.zip")
    LogShare.packTo(zip, LogShare.fileEntries(filesDir, null))
    ZipFile(zip).use { zf ->
      for (e in zf.entries()) {
        val n = e.name
        assertFalse("条目名不得含 ..", n.contains(".."))
        assertFalse("条目名不得以 / 开头", n.startsWith("/"))
        assertFalse("条目名不得含绝对路径分隔", n.contains(":"))
        assertFalse("条目名不得是目录", e.isDirectory)
      }
    }
  }
}
