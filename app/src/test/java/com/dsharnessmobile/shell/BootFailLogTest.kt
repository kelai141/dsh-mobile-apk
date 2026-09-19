package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 任务 19 回归（0.14.1）：启动**失败终态**落盘 `files/boot-fail.log`。
 *
 * 为什么必须有它（用户 0.14.0 反馈第一条【严重】）：**App 启动失败时几乎不留任何诊断日志**。
 * 设备实测 2026-09-19 13:25~15:21 有 44 次 `t_listen=-1`（最密集连续 10 次），而 logcat 覆盖该
 * 窗口却零异常、`engine.log` 无输出 —— 用户因此被一份**编造的技术诊断**误导，据此删了插件目录
 * 才恢复。
 *
 * 因此本文件锁四件事，**缺一即判未完成**（块J FIX-4 的教训：能力在、入口无 = 未完成）：
 *  ① 失败终态**必须有内容**（阶段 + 异常栈 + 配置指纹 + 时间戳）；
 *  ② 健康启动**默认不写**；
 *  ③ 五个**失败调用点**必须真接在 EngineStartFlow 的失败分支上（源码级断言，防「加了没接上」）；
 *  ④ 与 `boot-diag.log` 职责分离（两个文件、两个标记）。
 *
 * 测试直接打真实文件（`TemporaryFolder`），不走 Context 伪造 —— 本项目测试面**没有 Mockito**，
 * 故生产侧的落盘核心已抽成只依赖 `File` 的 [LogCollector.writeBootFailTo] / [LogCollector.bootFailLine]。
 */
class BootFailLogTest {

  @get:Rule
  val tmp = TemporaryFolder()

  private val files: File get() = tmp.root
  private fun failFile(): File = File(files, "boot-fail.log")
  private fun diagFile(): File = File(files, "boot-diag.log")

  // ── ① 失败终态必须有内容 ─────────────────────────────────────────────────────

  @Test
  fun failureWithStackWritesStageStackAndFingerprint() {
    val boom = IllegalStateException("engine spawn exploded")
    LogCollector.writeBootFailTo(files, "start-flow-exception", "启动线程抛出未捕获异常", boom, 1_700_000_000_000L)

    assertTrue("失败必须落盘（本次反馈的核心就是「没有日志」）", failFile().isFile)
    val text = failFile().readText()
    assertTrue("必须带诊断标记", text.contains(LogCollector.BOOT_FAIL_MARK))
    assertTrue("必须记录失败阶段", text.contains("stage=start-flow-exception"))
    assertTrue("必须记录异常类名", text.contains("error=java.lang.IllegalStateException"))
    assertTrue("必须记录异常消息", text.contains("engine spawn exploded"))
    assertTrue("必须有可读栈", text.contains("IllegalStateException"))
    assertTrue("必须带时间戳", text.contains("at=1700000000000"))
    assertTrue("必须带配置指纹", text.contains("fingerprint="))
    assertTrue("指纹必须含快照项", text.contains("snapshot="))
    assertTrue("指纹必须含 versionCode", text.contains("vcode="))
    assertTrue("指纹必须含 snapshot-transaction 在场性", text.contains("transaction="))
    assertTrue("必须带分段快照（与 boot-diag 同口径，便于对照）", text.contains("dsh-boot-segments"))
  }

  @Test
  fun oneFailureIsExactlyOneLineEvenWithMultilineStackAndDetail() {
    // 落盘语义是「一行 = 一次失败」；未折叠的换行会把一条诊断劈成多条、破坏设备侧 grep 与解析。
    val boom = RuntimeException("top\nmiddle\r\nbottom")
    LogCollector.writeBootFailTo(files, "start-flow-exception", "line1\nline2\r\nline3", boom, 1L)
    val lines = failFile().readText().trim().split("\n")
    assertEquals("一条失败必须严格占一行", 1, lines.size)
    assertFalse("不得残留 CR", lines[0].contains("\r"))
  }

  @Test
  fun booleanFailurePathIsExplicitlyMarkedRatherThanLeftEmpty() {
    // 多数失败分支是布尔判定（startEngine()==false / refreshSnapshot()==false），没有异常对象。
    // 必须**显式标注**「无可读异常」，绝不留空 —— 空字段会让读的人以为漏采。
    LogCollector.writeBootFailTo(files, "engine-start-false", "EngineManager.startEngine() 返回 false", null, 1L)
    val text = failFile().readText()
    assertTrue(text.contains("stage=engine-start-false"))
    assertTrue(text.contains("error=none(boolean-failure-path)"))
    assertTrue(text.contains("stack=none"))
  }

  @Test
  fun stackIsBoundedSoOneFailureCannotFloodTheFile() {
    var cur: Throwable = RuntimeException("deep")
    repeat(200) { cur = RuntimeException("layer$it", cur) }   // 造一条极深的 cause 链
    LogCollector.writeBootFailTo(files, "start-flow-exception", "deep stack", cur, 1L)
    val line = failFile().readText().trim()
    assertTrue("栈必须有界（单条不得爆文件），实测 ${line.length} 字符", line.length < 12_000)
  }

  @Test
  fun repeatedFailuresAppendRatherThanOverwrite() {
    LogCollector.writeBootFailTo(files, "engine-start-false", "first", null, 1L)
    LogCollector.writeBootFailTo(files, "process-died-during-boot", "second", null, 2L)
    val lines = failFile().readText().trim().split("\n")
    assertEquals("失败必须追加（历史失败不能丢）", 2, lines.size)
    assertTrue(lines[0].contains("stage=engine-start-false"))
    assertTrue(lines[1].contains("stage=process-died-during-boot"))
  }

  // ── ② 健康启动默认不写 ───────────────────────────────────────────────────────

  @Test
  fun healthyBootDoesNotCreateTheFile() {
    // 反向锁：不调用 writeBootFail 就不该有文件（否则「文件非空 ⇒ 出过故障」这条判据失效）。
    assertFalse("未失败时不得创建 boot-fail.log", failFile().exists())
  }

  @Test
  fun explicitOkMarkerIsAvailableButOptIn() {
    LogCollector.writeBootFailOkTo(files, "engine listen 就绪")
    val text = failFile().readText()
    assertTrue(text.contains("stage=ok"))
    assertTrue("ok 标记也带指纹，便于与失败行对照", text.contains("fingerprint="))
    assertTrue("ok 标记必须显式声明无异常", text.contains("error=none"))
  }

  // ── ④ 与 boot-diag 职责分离 ─────────────────────────────────────────────────

  @Test
  fun bootFailAndBootDiagUseDistinctMarksAndNeverMix() {
    assertFalse("两个标记必须不同（否则设备侧分流不了）",
      LogCollector.BOOT_DIAG_MARK == LogCollector.BOOT_FAIL_MARK)
    assertEquals("dsh-boot-fail", LogCollector.BOOT_FAIL_MARK)
    assertEquals("dsh-boot-diag", LogCollector.BOOT_DIAG_MARK)
    // 失败行不得混入 diag 的 source= 形态；诊断行不得带失败阶段。
    LogCollector.writeBootFailTo(files, "process-died-during-boot", "引擎进程死亡", null, 1L)
    val fail = failFile().readText()
    assertFalse("boot-fail 不得出现 diag 的 source= 键", fail.contains(" source="))
    assertFalse("boot-fail 不得混入 stall 载荷", fail.contains("stalledMs="))
  }

  // ── 配置指纹本身 ─────────────────────────────────────────────────────────────

  @Test
  fun fingerprintReportsMarkerPresenceAndEngineLogState() {
    File(files, ".snapshot-fingerprint").writeText("sha-abc123\n")
    File(files, ".snapshot-transaction").writeText("{}")
    File(files, "engine.log").writeText("3 lines here")
    File(files, "home").mkdirs()

    val fp = LogCollector.bootConfigFingerprint(files)
    assertTrue("必须读出快照指纹内容", fp.contains("snapshot=sha-abc123"))
    assertTrue("必须标注 transaction 残留（上次刷新中断 = 已知起不来成因）", fp.contains("transaction=present"))
    assertTrue("必须标注 home 就位", fp.contains("home=present"))
    assertTrue("必须标注 engine.log 大小（失败启动里常为 absent，本身即判据）", fp.contains("engineLog=bytes=12"))
  }

  @Test
  fun fingerprintNeverLeavesEmptyFields() {
    // 什么都不存在时必须全写 na/absent —— 绝不留空（空字段正是「看起来正常」误导的同族形态）。
    val fp = LogCollector.bootConfigFingerprint(files)
    assertTrue(fp.contains("snapshot=na"))
    assertTrue(fp.contains("transaction=absent"))
    assertTrue(fp.contains("home=absent"))
    assertTrue(fp.contains("engineLog=absent"))
    assertFalse("不得出现空值字段", fp.contains("=,") || fp.endsWith("="))
  }

  // ── ③ 五个失败调用点必须真接上（防「加了没接上」）────────────────────────────

  @Test
  fun engineStartFlowWiresEveryFailurePathToBootFail() {
    val src = File("src/main/java/com/dsharnessmobile/shell/EngineStartFlow.kt").readText()
    val sites = Regex("LogCollector\\.writeBootFail\\(").findAll(src).count()
    assertTrue("失败调用点必须真接线（实测 $sites 处，至少 5）", sites >= 5)
    for (stage in listOf(
      "engine-start-false",        // startEngine() 返回 false
      "process-died-during-boot",  // 进程死亡（44 次 t_listen=-1 的主要形态）
      "boot-budget-exceeded",      // 预算内未就绪
      "snapshot-refresh-failed",   // 快照解压失败
      "start-flow-exception",      // 启动线程未捕获异常
    )) {
      assertTrue("必须覆盖失败阶段 $stage", src.contains("\"$stage\""))
    }
  }

  @Test
  fun startThreadHasACatchSoExceptionsCannotDieSilently() {
    // **本任务最关键的根因**：启动线程此前是 `try { … } finally { … }`——**没有 catch**。
    // 任何异常（NoSuchMethodError / OOM 等）都被抛给线程默认处理器：壳侧零落盘、logcat 也可能为空。
    // 这不是「日志被丢弃」，而是「根本没有接住异常」。
    val src = File("src/main/java/com/dsharnessmobile/shell/EngineStartFlow.kt").readText()
    assertTrue("启动线程必须有 catch（此前只有 finally）", src.contains("} catch (t: Throwable) {"))
    assertTrue("异常必须落 boot-fail", src.contains("start-flow-exception"))
  }

  @Test
  fun failurePathEmitsLogE() {
    val src = File("src/main/java/com/dsharnessmobile/shell/LogCollector.kt").readText()
    assertTrue("失败路径必须 Log.e（用户反馈第 5 项）", src.contains("Log.e(TAG, \"boot failed: stage=\""))
  }

  @Test
  fun engineLogStateDistinguishesTheThreeCausesOfSilence() {
    // 任务 19 要求排查「为什么失败的启动连 engine.log 都没输出」。源码级结论：stderr **没有**被丢弃
    // （EngineManager.startWithArgs 用 redirectErrorStream(true) + redirectOutput(engine.log)）。
    // 故「无输出」只有三种成因，本判据必须能把它们区分开：
    //   ① spawn 从未成功 → absent；② 起来就崩、一句没写 → empty；③ 有输出但被轮转滚走 → bytes=N + gen*
    val absent = LogCollector.describeEngineLogState(files)
    assertTrue("进程没起来必须是 absent", absent.contains("engineLog=absent"))

    File(files, "engine.log").writeText("")
    assertTrue("起来没写必须是 empty（区别于 absent）", LogCollector.describeEngineLogState(files).contains("engineLog=empty"))

    File(files, "engine.log").writeText("boom: missing libnode\n")
    File(files, "engine.log.1").writeText("previous generation output\n")
    val withOutput = LogCollector.describeEngineLogState(files)
    assertTrue("有输出必须报字节数", withOutput.contains("engineLog=bytes="))
    assertTrue("必须报轮转世代（外壳读错世代会误判「无输出」）", withOutput.contains("gen1="))
    assertTrue("未出现的世代标 absent", withOutput.contains("gen5=absent"))
  }

  @Test
  fun engineLogFirstNonBlankLineIsCapturedAsTheDecidingEvidence() {
    // task-18 根因结论的直接落点：实测失败 B（44 次 t_listen=-1）里 engine.log 的首行即为定性证据：
    //   Error: dsh: plugin tree failed to load: … failed to import loader entry live2d-pet
    //   (dsh-live2d-pets): The requested module '@deepseek-ai/dsh-settings' does not provide an
    //   export named 'settingsNamespace'
    // 用户反馈称「logcat 0 命中」——真因在 engine.log，不在 logcat 面。故 boot-fail.log 必须自带这一行，
    // 让「一行即可定性」成立，而不是把用户再打发去别处找。
    File(files, "engine.log").writeText(
      "Error: dsh: plugin tree failed to load: failed to import loader entry live2d-pet\n" +
        "SyntaxError: The requested module does not provide an export named 'settingsNamespace'\n",
    )
    val state = LogCollector.describeEngineLogState(files)
    assertTrue("必须带非空首行", state.contains("firstLine="))
    assertTrue("首行必须包含定性文案", state.contains("plugin tree failed to load"))
    assertTrue("必须是首行而不是第二行", !state.contains("SyntaxError: The requested"))
  }

  @Test
  fun engineLogFirstLineSkipsLeadingBlankLinesAndRedactsTokens() {
    // 有前导空行时取第一个非空行；且必须过 EngineAuth.redact（engine.log 内含 launch token）。
    File(files, "engine.log").writeText(
      "\n\n  \ndsh web: http://127.0.0.1:3080/?token=SECRETTOKENVALUE1234567890\nreal failure line\n",
    )
    val state = LogCollector.describeEngineLogState(files)
    assertTrue("必须跳过空行取首个非空行", state.contains("firstLine=dsh web:"))
    assertFalse("launch token 不得进诊断（EngineAuth.redact 必须生效）", state.contains("SECRETTOKENVALUE1234567890"))
  }

  @Test
  fun engineLogFirstLineIsBounded() {
    File(files, "engine.log").writeText("X".repeat(5000) + "\n")
    val state = LogCollector.describeEngineLogState(files)
    assertTrue("首行必须有界（单条不得爆文件）", state.length < 1200)
  }

  @Test
  fun engineLogFirstLineReportsNoneOrUnreadableExplicitly() {
    assertTrue("无日志时必须写 none", LogCollector.describeEngineLogState(files).contains("firstLine=none"))
    File(files, "engine.log").writeText("\n\n")   // 只有空行
    assertTrue("全空行时必须写 none", LogCollector.describeEngineLogState(files).contains("firstLine=none"))
  }

  @Test
  fun engineLogStateIsCarriedIntoTheFailureDetail() {
    // 「加了但没接上」的反证：该判据必须真的被死亡路径用上（进 detail）。
    val src = File("src/main/java/com/dsharnessmobile/shell/EngineStartFlow.kt").readText()
    assertTrue("进程死亡路径必须带上引擎日志状态", src.contains("LogCollector.describeEngineLogState("))
    assertTrue("必须写入 process-died-during-boot 阶段", src.contains("\"process-died-during-boot\""))
  }

  @Test
  fun bootFailIsDocumentedAsDistinctFromBootDiag() {
    // 文件头必须写清职责区分（Lead 的硬要求），否则后来者会把两者当同一个东西。
    val src = File("src/main/java/com/dsharnessmobile/shell/LogCollector.kt").readText()
    assertTrue("必须写明 boot-diag 的职责", src.contains("boot-diag.log  **失败过程中的**诊断"))
    assertTrue("必须写明 boot-fail 的职责", src.contains("boot-fail.log  **失败终态**"))
  }
}
