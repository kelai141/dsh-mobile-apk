package com.dsharnessmobile.shell

import java.io.File
import java.util.zip.ZipFile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 功能 B（0.14.6）回归：诊断包打包 [LogShare]。
 *
 * 锁六件事（缺一即判未完成）：
 *  ① 白名单：**不相关/敏感路径不得进包**——造出真实存在的 home/.dsh 配置、凭据文件、
 *    settings.yaml、工作区与会话文件，断言 ZIP 条目名里一个都没有（Lead 硬要求：只写注释不算）。
 *  ② 缺失日志如实标注：文件不存在 → manifest 里写 absent，而不是静默消失。
 *  ③ 脱敏单出口：条目内容里的真实凭据不得出现在 ZIP 内任何字节里。
 *  ④ 脱敏失败 fail-closed：条目被丢弃且 manifest 标注 sanitize-failed（不是原样写入）。
 *  ⑤ 压缩失败如实报错且不留半截 .tmp 垃圾。
 *  ⑥ 入口判据：证据驱动（boot-fail / boot-diag / 失败相位任一成立），且**不要求必须有日志文件**。
 *
 * 测试直接打真实文件（TemporaryFolder）；打包核心 [LogShare.packTo] 只依赖 File，
 * 不需要 Context（本项目测试面没有 Mockito）。
 */
class LogShareTest {

  @get:Rule
  val tmp = TemporaryFolder()

  private fun filesDir(): File = File(tmp.root, "files").apply { mkdirs() }
  private fun zipTarget(): File = File(tmp.root, "out/dsh-diag.zip")

  private fun entryNames(zip: File): List<String> = ZipFile(zip).use { zf ->
    zf.entries().toList().map { it.name }
  }

  private fun entryText(zip: File, name: String): String = ZipFile(zip).use { zf ->
    zf.getInputStream(zf.getEntry(name)).readBytes().toString(Charsets.UTF_8)
  }

  // ── ① 白名单：敏感/无关路径永不进包 ─────────────────────────────────────────

  @Test
  fun sensitivePrivatePathsNeverEnterThePackage() {
    // 造出一个「什么都存在」的私有区——如果实现靠遍历目录，这些就会被卷进去。
    val files = filesDir()
    File(files, "home/.dsh").mkdirs()
    File(files, "home/.dsh/.credentials.yaml")
      .writeText("records:\n  client-connection/browser-session:\n    secret: c2VjcmV0LXZhbHVl\n")
    File(files, "home/.dsh/settings.yaml").writeText("apiKey: sk-proj-REALKEY1234567890\n")
    File(files, "home/.dsh/workspaces").mkdirs()
    File(files, "home/.dsh/workspaces/session-1.json").writeText("{\"prompt\":\"user private content\"}\n")
    File(files, "home/tmp").mkdirs()
    File(files, "home/tmp/draft.txt").writeText("private draft\n")
    File(files, "log").mkdirs()
    File(files, "log/dsh-2026-10-11.log").writeText("day log line\n")

    val inputs = LogShare.fileEntries(files, File(files, "log"))
    val result = LogShare.packTo(zipTarget(), inputs)
    assertTrue("打包必须成功", result.ok)

    val names = entryNames(zipTarget())
    for (forbidden in listOf(
      ".credentials.yaml", "settings.yaml", "workspaces", "session-1.json", "draft.txt",
    )) {
      assertFalse(
        "私有/敏感路径不得进包（实测条目：" + names.joinToString(",") + "）",
        names.any { it.contains(forbidden) },
      )
    }
    val all = entryText(zipTarget(), LogShare.MANIFEST_NAME)
    assertFalse("凭据内容不得出现在 manifest", all.contains("c2VjcmV0LXZhbHVl"))
  }

  @Test
  fun candidateListIsAWhitelistNotADirectoryScan() {
    val files = filesDir()
    File(files, "engine.log").writeText("engine output\n")
    File(files, "home/.dsh").mkdirs()
    File(files, "home/.dsh/.credentials.yaml").writeText("secret: x\n")
    val candidates = LogShare.candidateFiles(files).map { it.name }
    assertEquals(
      "候选清单必须逐条点名（白名单），不得随目录内容增长",
      listOf(
        "boot-fail.log", "boot-fail.log.1",
        "boot-diag.log", "boot-diag.log.1",
        "boot-segments.log", "boot-segments.log.1",
      ),
      candidates,
    )
  }

  // ── ② 缺失日志如实标注 ──────────────────────────────────────────────────────

  @Test
  fun missingLogsAreReportedAsAbsentInTheManifest() {
    val files = filesDir()
    // 只有 boot-fail.log 存在，其余全缺（issue #1599：engine.log 已不在候选面内）。
    File(files, "boot-fail.log").writeText("dsh: warning: 2 entries did not activate\n")

    val result = LogShare.packTo(zipTarget(), LogShare.fileEntries(files, null))
    assertTrue(result.ok)
    val manifest = entryText(zipTarget(), LogShare.MANIFEST_NAME)
    assertTrue("存在的条目必须是 present", manifest.contains("boot-fail.log=present"))
    assertTrue("缺失的条目必须如实标注 absent", manifest.contains("boot-fail.log.1=absent"))
    assertTrue("boot-diag 缺失也要标注", manifest.contains("boot-diag.log=absent"))
    assertTrue("当日日志没有时不得凭空造", manifest.contains("dsh-day.log=absent"))
    assertFalse("不得出现空状态（例如 name=）", manifest.contains("=\n"))
  }

  @Test
  fun bootLogRotationsAreCollectedWhenPresent() {
    val files = filesDir()
    File(files, "boot-diag.log").writeText("current\n")
    File(files, "boot-diag.log.1").writeText("previous generation\n")
    val result = LogShare.packTo(zipTarget(), LogShare.fileEntries(files, null))
    assertTrue(result.ok)
    val names = entryNames(zipTarget())
    assertTrue(names.contains("boot-diag.log"))
    assertTrue("轮转世代也要收（失败现场常在前一代里）", names.contains("boot-diag.log.1"))
    assertFalse("不存在的世代不得伪造条目", names.contains("boot-diag.log.2"))
  }

  /**
   * issue #1599：诊断包**不得**默认带上引擎会话日志。
   *
   * 缺陷形态：白名单挡的是文件名，挡不住内容。`engine.log` 是引擎 stdout/stderr 的原样重定向，
   * 里面是完整会话（模型读过的文件、工具输出、用户路径），而 LogSanitizer 只认七类凭据形态，
   * 一条都不命中——用户按「分享诊断包」时以为发出去的是脱敏日志，实际是完整对话。
   *
   * 判据是**行为**：造一份真实存在、内容可辨识的 engine.log（含轮转世代），走真实的
   * [LogShare.fileEntries] + [LogShare.packTo]，断言 ZIP 条目名、候选清单与 ZIP 全部字节里
   * 都没有它。把 engine.log 加回白名单，这条立刻红。
   */
  @Test
  fun engineConversationLogNeverEntersTheDiagnosticPackage() {
    val files = filesDir()
    val conversation = "user: 帮我读一下 /home/me/notes/预算.md\nassistant: 好的，内容是……\n"
    File(files, "engine.log").writeText(conversation)
    for (generation in 1..5) File(files, "engine.log." + generation).writeText(conversation)
    File(files, "boot-fail.log").writeText("stage=engine-start-false\n")

    val result = LogShare.packTo(zipTarget(), LogShare.fileEntries(files, null))
    assertTrue("打包本身必须成功（缺 engine.log 不是失败）", result.ok)

    val names = entryNames(zipTarget())
    assertTrue("壳侧自有启动日志必须仍在包里（去掉 engine.log 不得连带丢证据）", names.contains("boot-fail.log"))
    assertFalse(
      "engine.log 不得进包（实测条目：" + names.joinToString(",") + "）",
      names.any { it == "engine.log" || it.startsWith("engine.log.") },
    )
    assertFalse(
      "候选清单同样不得再点名 engine.log",
      LogShare.candidateFiles(files).map { it.name }.any { it == "engine.log" || it.startsWith("engine.log.") },
    )
    // 内容级反证：就算有人只改条目名，ZIP 内也不得出现会话正文。
    ZipFile(zipTarget()).use { zf ->
      for (entry in zf.entries()) {
        val text = zf.getInputStream(entry).readBytes().toString(Charsets.UTF_8)
        assertFalse("ZIP 条目 " + entry.name + " 不得含会话正文", text.contains("预算.md"))
        assertFalse("ZIP 条目 " + entry.name + " 不得含会话正文", text.contains("帮我读一下"))
      }
    }
  }

  // ── ③ 脱敏单出口 ────────────────────────────────────────────────────────────

  @Test
  fun credentialsInLogContentAreMaskedInsideTheZip() {
    val files = filesDir()
    val secret = "sk-proj-AbCd1234EfGh5678IjKl9012"
    val jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"
    File(files, "boot-diag.log").writeText(
      "boot ok\nAuthorization: Bearer " + jwt + "\napiKey: \"" + secret + "\"\n" +
        "dsh web: http://127.0.0.1:3080/?token=SECRETSESSIONTOKEN123\n",
    )
    val result = LogShare.packTo(zipTarget(), LogShare.fileEntries(files, null))
    assertTrue(result.ok)

    val body = entryText(zipTarget(), "boot-diag.log")
    assertFalse("sk- 密钥不得进包", body.contains(secret))
    assertFalse("Bearer 令牌不得进包", body.contains(jwt))
    assertFalse("启动令牌不得进包", body.contains("SECRETSESSIONTOKEN123"))
    assertTrue("打码占位符必须在场", body.contains(LogSanitizer.MASK))
    assertTrue("排障需要的非敏感信息要保留", body.contains("boot ok"))
  }

  @Test
  fun everyTextEntryGoesThroughTheSingleSanitizerSink() {
    // 反证「漏过出口」：用两份不同的日志各埋一个密钥，两份都必须被打码。
    val files = filesDir()
    File(files, "boot-fail.log").writeText("stage=engine-start-false apiKey: sk-proj-AAAABBBBCCCCDDDD\n")
    File(files, "boot-diag.log").writeText("dsh-boot-diag token=SECRETDIAGTOKEN\n")
    val result = LogShare.packTo(zipTarget(), LogShare.fileEntries(files, null))
    assertTrue(result.ok)
    assertFalse(entryText(zipTarget(), "boot-fail.log").contains("sk-proj-AAAABBBBCCCCDDDD"))
    assertFalse(entryText(zipTarget(), "boot-diag.log").contains("SECRETDIAGTOKEN"))
  }

  // ── ④ 脱敏失败 fail-closed ──────────────────────────────────────────────────

  @Test
  fun sanitizeFailureDiscardsTheEntryAndSaysSo() {
    // **fail-closed 的真覆盖**：注入一个必然返回 null 的脱敏器（等价于脱敏这一步抛异常），
    // 断言该条目被**丢弃**且 manifest 如实标注 sanitize-failed —— 而不是原样写进包。
    val secret = "sk-proj-MUSTNEVERLEAK1234567890"
    val inputs = listOf(
      LogShare.InputEntry("engine.log") { "normal line " + secret + "\n" },
      LogShare.InputEntry("boot-fail.log") { "raw content\n" },
    )
    var calls = 0
    val result = LogShare.packTo(zipTarget(), inputs) { _ -> calls += 1; null }
    assertTrue(result.ok)
    assertEquals("每个条目都要过一次脱敏出口", 2, calls)
    val names = entryNames(zipTarget())
    assertFalse("脱敏失败的条目必须被丢弃（绝不允许原样写入）", names.contains("engine.log"))
    assertFalse(names.contains("boot-fail.log"))
    val manifest = entryText(zipTarget(), LogShare.MANIFEST_NAME)
    assertTrue(
      "丢弃必须如实标注（不是静默消失）",
      manifest.contains("engine.log=" + LogSanitizer.DEREDACT_FAILED),
    )
    assertFalse(
      "原始内容不得以任何形式进包",
      ZipFile(zipTarget()).use { zf ->
        zf.entries().toList().any { e ->
          zf.getInputStream(e).readBytes().toString(Charsets.UTF_8).contains(secret)
        }
      },
    )
  }

  @Test
  fun readFailureAndMissingEntriesAreLabeledDistinctly() {
    val inputs = listOf(
      LogShare.InputEntry("engine.log") { "normal line\n" },
      LogShare.InputEntry("boot-fail.log") { throw IllegalStateException("read exploded") },
      LogShare.InputEntry("boot-diag.log") { null },
    )
    val result = LogShare.packTo(zipTarget(), inputs)
    assertTrue(result.ok)
    val names = entryNames(zipTarget())
    assertFalse("读失败的条目不得进包", names.contains("boot-fail.log"))
    assertFalse("缺失的条目不得进包", names.contains("boot-diag.log"))
    val manifest = entryText(zipTarget(), LogShare.MANIFEST_NAME)
    assertTrue("读失败必须如实标注", manifest.contains("boot-fail.log=read-failed"))
    assertTrue("缺失必须如实标注", manifest.contains("boot-diag.log=absent"))
    assertTrue("成功条目仍要在场", names.contains("engine.log"))
  }

  @Test
  fun manifestAlwaysPresentAndCountsMatch() {
    val inputs = listOf(
      LogShare.InputEntry("a.log") { "x\n" },
      LogShare.InputEntry("b.log") { null },
    )
    val result = LogShare.packTo(zipTarget(), inputs)
    assertTrue(result.ok)
    val names = entryNames(zipTarget())
    assertTrue("manifest 恒在（读者第一眼该看到它）", names.contains(LogShare.MANIFEST_NAME))
    assertEquals("两条来源都要被点名", 2, result.report.size)
    assertTrue(entryText(zipTarget(), LogShare.MANIFEST_NAME).contains("条目数=2"))
  }

  // ── ⑤ 压缩失败 ─────────────────────────────────────────────────────────────

  @Test
  fun packFailureReportsReasonAndLeavesNoHalfWrittenTmp() {
    // 确定性地让写包失败：父路径是一个**普通文件**（不是目录），因此既建不了子目录、
    // 也开不了临时文件输出流 → 必然走压缩失败分支。
    val blocker = File(tmp.root, "blocked")
    blocker.writeText("i am a file, not a directory")
    val target = File(blocker, "dsh-diag.zip")
    val result = LogShare.packTo(target, listOf(LogShare.InputEntry("a.log") { "x\n" }))
    assertFalse("必须如实报失败，不得假装成功", result.ok)
    assertTrue("必须给出可读原因", (result.reason ?: "").isNotEmpty())
    assertFalse("失败时不得产出包文件", target.exists())
    // 父路径是普通文件 ⇒ 其下不可能存在任何临时文件（null 父目录同样按「不存在」处理）。
    val parent = target.parentFile
    assertFalse(
      "不得留下半截临时文件",
      parent != null && parent.isDirectory && File(parent, target.name + ".tmp").exists(),
    )
  }

  @Test
  fun totalCapSkipsFurtherEntriesWithoutDroppingTheManifest() {
    val big = "L".repeat(4096)
    val inputs = listOf(
      LogShare.InputEntry("a.log") { big },
      LogShare.InputEntry("b.log") { big },
    )
    val result = LogShare.packTo(zipTarget(), inputs, totalCap = 5000L)
    assertTrue(result.ok)
    val names = entryNames(zipTarget())
    assertTrue("首条进包", names.contains("a.log"))
    assertFalse("超整包上限的条目被跳过（而不是写坏包）", names.contains("b.log"))
    val manifest = entryText(zipTarget(), LogShare.MANIFEST_NAME)
    assertTrue("跳过必须如实标注", manifest.contains("b.log=skipped-total-cap"))
  }

  @Test
  fun oversizedSingleEntryIsTruncatedAndLabeled() {
    val huge = "Z".repeat(LogShare.MAX_ENTRY_BYTES + 100)
    val result = LogShare.packTo(zipTarget(), listOf(LogShare.InputEntry("big.log") { huge }))
    assertTrue(result.ok)
    val manifest = entryText(zipTarget(), LogShare.MANIFEST_NAME)
    assertTrue("超单条上限必须标注 truncated", manifest.contains("big.log=truncated"))
    val body = entryText(zipTarget(), "big.log")
    assertTrue("条目必须有界", body.toByteArray(Charsets.UTF_8).size <= LogShare.MAX_ENTRY_BYTES)
  }

  @Test
  fun truncationIsMeasuredInBytesNotCharacters() {
    // 反证：中文单字符 UTF-8 占 3 字节，因此**按字符** take(N) 时 N 个字符可能是 3N 字节，
    // 「单条上限」就形同不存在。这里造一份「字符数远小于上限、字节数远超上限」的中文日志：
    //   字符数 ≈ MAX/3，字节数 ≈ MAX —— 按字符截断的实现会**完全不截断**（判红），
    //   按字节截断的实现才会真正限住并把条目标成 truncated。
    val perLine = "引擎启动失败：插件装配失败，条目未能激活。\n"
    val perLineBytes = perLine.toByteArray(Charsets.UTF_8).size
    val chinese = perLine.repeat(LogShare.MAX_ENTRY_BYTES / perLineBytes + 200)
    assertTrue(
      "前置：字符数必须远小于字节上限（否则本用例证明不了按字符截断会漏）",
      chinese.length < LogShare.MAX_ENTRY_BYTES,
    )
    assertTrue(
      "前置：字节数必须真的超出上限",
      chinese.toByteArray(Charsets.UTF_8).size > LogShare.MAX_ENTRY_BYTES,
    )
    val result = LogShare.packTo(
      zipTarget(),
      listOf(LogShare.InputEntry("boot-fail.log") { chinese }),
      totalCap = Long.MAX_VALUE,
    )
    assertTrue(result.ok)
    val size = entryText(zipTarget(), "boot-fail.log").toByteArray(Charsets.UTF_8).size
    assertTrue(
      "中文条目的**实际字节数**必须真的被限住（实测 " + size + " > " + LogShare.MAX_ENTRY_BYTES + "）",
      size <= LogShare.MAX_ENTRY_BYTES,
    )
    assertTrue("截断必须标注", entryText(zipTarget(), LogShare.MANIFEST_NAME).contains("boot-fail.log=truncated"))
  }

  @Test
  fun truncateUtf8NeverSplitsAMultibyteCharacter() {
    // 回退到字符边界：不得留下半个 UTF-8 序列（半个字符会变成替换符，把最后一行弄成乱码）。
    val text = "中文中文中文"
    val bytes = text.toByteArray(Charsets.UTF_8)
    for (max in 1 until bytes.size) {
      val cut = LogShare.truncateUtf8(bytes, max)
      assertTrue("截断结果不得超过上限", cut.size <= max)
      val decoded = String(cut, Charsets.UTF_8)
      assertFalse("不得出现替换符（说明切开了多字节序列）", decoded.contains('\uFFFD'))
      assertTrue("必须是原文的前缀", text.startsWith(decoded))
    }
  }

  @Test
  fun truncateUtf8IsIdentityWhenUnderTheCap() {
    val bytes = "short".toByteArray(Charsets.UTF_8)
    assertEquals("short", String(LogShare.truncateUtf8(bytes, 100), Charsets.UTF_8))
  }

  @Test
  fun oldCharacterBasedTruncationWouldHaveExceededTheCapByThreeTimes() {
    // 「原来真的坏」的复算证据（Lead 要求）：旧实现是 body.take(MAX_ENTRY_BYTES)，即**按字符**截断。
    // 中文单字符 UTF-8 占 3 字节，因此中文日志 take(N) 之后实际字节数可达 3N —— 单条上限形同不存在。
    // 本用例把这条换算直接算出来并断言，而不是只在注释里声称。
    val line = "引擎启动失败：插件装配失败，条目未能激活。\n"
    val perLineBytes = line.toByteArray(Charsets.UTF_8).size
    val perLineChars = line.length
    assertTrue("前置：中文行必须一字符多字节（否则本复算不成立）", perLineBytes > perLineChars)

    // 造一份字符数刚好到上限、但字节数远超上限的中文日志。
    val chars = LogShare.MAX_ENTRY_BYTES
    val repeated = line.repeat(chars / perLineChars + 1).take(chars)
    val charBasedResult = repeated                       // 旧实现：take(MAX) 后就是这个字符串
    val charBasedBytes = charBasedResult.toByteArray(Charsets.UTF_8).size
    val byteBasedBytes = LogShare.truncateUtf8(
      repeated.toByteArray(Charsets.UTF_8), LogShare.MAX_ENTRY_BYTES,
    ).size

    assertTrue(
      "旧实现（按字符）实际字节数必须**超出**上限（实测 " + charBasedBytes + " vs 上限 " + LogShare.MAX_ENTRY_BYTES + "）",
      charBasedBytes > LogShare.MAX_ENTRY_BYTES,
    )
    assertTrue(
      "旧实现至少超出一倍（中文 3 字节/字符 ⇒ 可达 3 倍）",
      charBasedBytes >= LogShare.MAX_ENTRY_BYTES * 2,
    )
    assertTrue("新实现（按字节）必须真的守住上限", byteBasedBytes <= LogShare.MAX_ENTRY_BYTES)
    // 同输入下两口径的差距即为「旧口径坏了多少字节」的可核对数字。
    assertTrue("新口径不得比旧口径更宽", byteBasedBytes < charBasedBytes)
  }

  @Test
  fun deviceEntryIsPresentEvenWhenFieldsAreNaSoAbsentStaysUnambiguous() {
    // Lead 第 2b 点：device.txt 的字段写 na（取不到）时，条目本身仍是 present——
    // 于是 manifest 的 present|absent 只表达「这份来源有没有内容」，与「某个字段取不到」互不混淆。
    val files = filesDir()  // 全新空目录：所有可选指纹文件都不存在。
    val inputs = listOf(LogShare.InputEntry(LogShare.DEVICE_NAME) { LogShare.deviceInfo(files) })
    val result = LogShare.packTo(zipTarget(), inputs)
    assertTrue(result.ok)
    val manifest = entryText(zipTarget(), LogShare.MANIFEST_NAME)
    assertTrue(
      "设备信息恒为 present（它总能生成），na 只出现在字段值里",
      manifest.contains(LogShare.DEVICE_NAME + "=present"),
    )
    assertFalse("不得因为字段是 na 就把条目报成 absent", manifest.contains(LogShare.DEVICE_NAME + "=absent"))
    val info = entryText(zipTarget(), LogShare.DEVICE_NAME)
    assertTrue("缺失字段必须显式写 na（不留空）", info.contains("snapshotFingerprint=na"))
    assertFalse("不得留空值字段", info.contains("=\n"))
  }

  // ── ⑥ 入口判据 ─────────────────────────────────────────────────────────────

  @Test
  fun entryOfferedOnAnyDiagnosticEvidence() {
    assertTrue("boot-fail 非空 → 可见", LogShare.hasEvidence(true, false, false))
    assertTrue("boot-diag 非空 → 可见", LogShare.hasEvidence(false, true, false))
    assertTrue("失败相位 → 可见（覆盖尚未写 boot-fail 的插件未激活现场）", LogShare.hasEvidence(false, false, true))
    assertFalse("三者都不成立时不得多摆一个入口", LogShare.hasEvidence(false, false, false))
  }

  @Test
  fun emptyDiagnosticFilesDoNotCountAsEvidence() {
    // 0 字节文件 = 没有诊断内容，不能据此点亮入口（「文件存在」与「有内容」必须分开）。
    val files = filesDir()
    File(files, "boot-fail.log").writeText("")
    File(files, "boot-diag.log").writeText("")
    assertFalse("空文件不构成证据", LogShare.shouldOffer(files, phaseFailed = false))

    File(files, "boot-fail.log").writeText("dsh-boot-fail stage=engine-start-false\n")
    assertTrue("有内容即构成证据", LogShare.shouldOffer(files, phaseFailed = false))
  }

  @Test
  fun phaseFailureAloneOffersTheEntryEvenWithoutAnyLogFile() {
    // B3 的关键：引擎连日志都没写出来的失败，分享入口**仍然要亮**。
    val empty = filesDir()
    assertTrue(LogShare.shouldOffer(empty, phaseFailed = true))
  }

  @Test
  fun deviceInfoReportsFactsWithoutCredentials() {
    val files = filesDir()
    File(files, ".snapshot-fingerprint").writeText("sha-abc123\n")
    val info = LogShare.deviceInfo(files)
    assertTrue("必须带快照指纹", info.contains("sha-abc123"))
    assertTrue("必须带引擎日志状态（缺失本身即判据）", info.contains("engineLog="))
    // 反证：describeEngineLogState 自带 engineLog= 前缀，这里不得再包一层（实测曾出现 engineLog=engineLog=）。
    assertFalse("不得出现重复的 engineLog= 前缀", info.contains("engineLog=engineLog="))
    assertTrue("必须带快照事务残留状态", info.contains("snapshotTransaction="))
    assertFalse("设备信息不得含任何凭据键值", info.contains("secret") || info.contains("apiKey"))
  }

  @Test
  fun productionPackerEmitsARealZipFixtureForExternalAssertions() {
    // 把**生产实现**（LogShare.packTo，非测试自造）产出的真实 ZIP 落到仓外临时目录，
    // 供 .deploy-tmp/dev-share/assert-log-share-zip.ps1 做独立于 JVM 的第三方断言
    // （外部工具解压 + 敏感词扫描）。这是「同一实现被两套独立手段验证」的落点。
    val outDir = File("../.deploy-tmp/dev-share/evidence")
    outDir.mkdirs()
    val files = filesDir()
    // 真实形态的日志 + 真实形态的凭据（必须被打码）。
    File(files, "boot-segments.log").writeText(
      "dsh: warning: 2 entries did not activate\n" +
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sigpart\n" +
        "apiKey: \"sk-proj-FIXTUREKEY1234567890\"\n" +
        "OPENAI_API_KEY=sk-proj-ENVKEY0987654321\n" +
        "dsh web: http://127.0.0.1:3080/?token=FIXTURESESSIONTOKEN123456\n",
    )
    File(files, "boot-fail.log").writeText("dsh-boot-fail stage=engine-start-false\n")
    // 敏感路径存在但不得进包。
    File(files, "home/.dsh").mkdirs()
    File(files, "home/.dsh/.credentials.yaml").writeText("secret: MUSTNOTAPPEAR\n")

    val inputs = ArrayList<LogShare.InputEntry>()
    inputs.add(LogShare.InputEntry(LogShare.DEVICE_NAME) { LogShare.deviceInfo(files) })
    inputs.addAll(LogShare.fileEntries(files, null))
    val target = File(outDir, "dsh-diag-fixture.zip")
    val result = LogShare.packTo(target, inputs)
    assertTrue("生产打包必须成功", result.ok)
    assertTrue("夹具 ZIP 必须真的落盘", target.isFile && target.length() > 0)
    // 夹具本身也要满足脱敏（外部脚本会再独立扫一遍）。
    val all = ZipFile(target).use { zf ->
      zf.entries().toList().joinToString("") { e -> zf.getInputStream(e).readBytes().toString(Charsets.UTF_8) }
    }
    assertFalse("夹具不得含 sk- 明文", all.contains("sk-proj-FIXTUREKEY1234567890"))
    assertFalse("夹具不得含环境变量明文", all.contains("sk-proj-ENVKEY0987654321"))
    assertFalse("夹具不得含启动令牌明文", all.contains("FIXTURESESSIONTOKEN123456"))
    assertFalse("夹具不得含凭据文件内容", all.contains("MUSTNOTAPPEAR"))
  }

  @Test
  fun packIsAtomicAndOverwritesRatherThanAppending() {
    val target = zipTarget()
    val first = LogShare.packTo(target, listOf(LogShare.InputEntry("one.log") { "1\n" }))
    assertTrue(first.ok)
    val second = LogShare.packTo(target, listOf(LogShare.InputEntry("two.log") { "2\n" }))
    assertTrue(second.ok)
    val names = entryNames(target)
    assertTrue("新包覆盖旧包", names.contains("two.log"))
    assertFalse("旧条目不得残留（否则是追加而不是原子替换）", names.contains("one.log"))
  }

  // ── issue #1403：整包上限按**诊断价值**扣减，且 skipped 计入回执 ──────────────────

  @Test
  fun `诊断价值序_device 与 logcat 必须排在所有 engine log 之前`() {
    val device = LogShare.diagnosticPriority(LogShare.DEVICE_NAME)
    val logcat = LogShare.diagnosticPriority("logcat.txt")
    val bootFail = LogShare.diagnosticPriority("boot-fail.log")
    val bootDiag = LogShare.diagnosticPriority("boot-diag.log")
    val engine = LogShare.diagnosticPriority("engine.log")
    val engineOld = LogShare.diagnosticPriority("engine.log.5")
    val day = LogShare.diagnosticPriority("dsh-day.log")
    val other = LogShare.diagnosticPriority("something-else.txt")

    assertEquals("device.txt 必须永远第一", 0, device)
    assertTrue("logcat 必须排在 engine.log 之前（它是唯一记录系统侧事件的来源）", logcat < engine)
    assertTrue("boot-fail 要比 engine.log 靠前", bootFail < engine)
    assertTrue("boot-diag 要比 engine.log 靠前", bootDiag < engine)
    assertTrue("最新一代 engine.log 要比旧代靠前", engine < engineOld)
    assertTrue("dsh-day.log 排在 engine.log 之后（可由 engine.log 部分还原）", day > engineOld)
    assertTrue("未知条目落兜底（最容易因 cap 被丢）", other >= day)
  }

  @Test
  fun `整包上限按价值扣减_logcat 不得被多代 engine log 挤掉`() {
    val big = "x".repeat(1000)
    val entries = ArrayList<LogShare.InputEntry>()
    // 故意按**旧**顺序给：device → 6 代 engine.log → dsh-day → logcat。
    // 旧实现按这个顺序扣减，logcat 会拿到 skipped-total-cap。
    entries.add(LogShare.InputEntry(LogShare.DEVICE_NAME) { "device" })
    for (n in 0..5) {
      entries.add(LogShare.InputEntry(if (n == 0) "engine.log" else "engine.log." + n) { big })
    }
    entries.add(LogShare.InputEntry("dsh-day.log") { big })
    // logcat 也必须**有体积**：6 字节的 logcat 在坏顺序下照样能塞进剩余空间，判据就不判别了
    // （第一版实测踩到：变异「取消排序」后用例仍绿）。真实 logcat 上限是 512KB。
    entries.add(LogShare.InputEntry("logcat.txt") { "L".repeat(1000) })

    val ok = zipTarget()
    // cap 只够 device + logcat + 一份 engine.log 左右
    val result = LogShare.packTo(ok, entries, totalCap = 2500L)
    assertTrue("打包必须成功：" + result.reason, result.ok)
    ZipFile(ok).use { zip ->
      assertNotNull("device.txt 必须在包里", zip.getEntry(LogShare.DEVICE_NAME))
      assertNotNull("logcat.txt 不得被 engine.log 挤掉（本 issue 的缺陷本体）", zip.getEntry("logcat.txt"))
    }
    assertTrue("必须有条目因整包上限被丢，否则夹具没触到 cap：" + result.report,
      result.report.any { it.endsWith("=skipped-total-cap") })
    // 被丢的第一条必须是低价值条目，而不是 logcat/dsh-day 这类高价值项
    val firstSkipped = result.report.first { it.endsWith("=skipped-total-cap") }
    assertTrue("被丢的第一条应是 engine.log 旧代而不是 logcat：" + firstSkipped,
      firstSkipped.startsWith("engine.log."))
  }

  @Test
  fun `回执必须把 skipped-total-cap 计入未收录数`() {
    assertEquals("", LogShare.missingNote(listOf("device.txt=present(6B)", "engine.log=present(10B)")))
    // 只有 absent：沿用原文案
    assertTrue(LogShare.missingNote(listOf("a=absent")).contains("1 项日志缺失"))
    // 只有 skipped：必须单独说明，且说清是"整包上限"而不是"缺失"
    val cappedOnly = LogShare.missingNote(listOf("logcat.txt=skipped-total-cap"))
    assertTrue("skipped 必须计入回执：" + cappedOnly, cappedOnly.contains("1 项"))
    assertTrue("必须说明是整包上限：" + cappedOnly, cappedOnly.contains("整包上限"))
    assertFalse("不得把它说成缺失：" + cappedOnly, cappedOnly.contains("缺失"))
    // 两者都有：分别给出数字
    val mixed = LogShare.missingNote(listOf("a=absent", "b=skipped-total-cap", "c=skipped-total-cap"))
    assertTrue("混合时必须给总数：" + mixed, mixed.contains("3 项"))
    assertTrue(mixed.contains("1 项缺失"))
    assertTrue(mixed.contains("2 项超上限"))
  }

}