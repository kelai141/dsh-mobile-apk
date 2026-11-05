package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 壳侧行为批（issue #1594 / #1598 / #1599 / #1601 / #1605 / #1612 / #1623）的离线判据。
 *
 * 这些缺陷的共同形态是「界面上看起来对、实际不是那么回事」——只能靠设备复现，于是此前没有离线判据。
 * 本类按本仓既有两条路子落判据：
 *  1. 纯函数/常量判据：语义直接可测，改坏即红；
 *  2. 源码形态判据：需要 View/Window/Binder 的形态在 JVM 里跑不起来，就断言「修复形态在场 +
 *     旧形态不在场」，撤掉修复即红（与 NotificationContractTest / OverlayBatch5Test 同思路）。
 *
 * 每条都做过负控（把实现改回旧形态 → 该用例真变红），见 PR 正文。
 */
class ShellBehaviorBatchTest {

  private fun source(relative: String): String {
    val candidates = listOf(File(relative), File("app/" + relative))
    val file = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到源码 " + relative + "（工作目录 = " + File(".").absolutePath + "）")
    return file.readText()
  }

  /** 只留代码行（注释里会复述旧实现作为背景，直接对全文断言会被自己的说明判红）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  private fun shellCode(name: String): String =
    codeOnly(source("src/main/java/com/dsharnessmobile/shell/" + name))

  // ── issue #1594：UserService 的 exec 不得与维护面共用一把锁 ──────────────────

  /**
   * 缺陷形态：exec/execCapture 与 configure/repairOwnership/writeChunk/removePath 全部
   * @Synchronized（同一把 monitor）。exec 的超时上限 120s、Binder 调用无超时，于是模型跑长命令
   * 期间，应用重启路径上的 configure 在服务端排队到长命令结束，界面停在「正在启动引擎…」。
   *
   * 判据：exec/execCapture 的声明行上不得有 @Synchronized；维护面四条必须仍有。
   */
  @Test
  fun userServiceExecDoesNotShareTheMaintenanceMonitor() {
    val lines = source("src/main/java/com/dsharnessmobile/shell/ShizukuUserService.kt").lines()
    fun annotated(declFragment: String): Boolean {
      val index = lines.indexOfFirst { it.contains(declFragment) }
      assertTrue("找不到声明：" + declFragment, index >= 0)
      // 注解在紧邻上方（跳过空行与注释）。
      var i = index - 1
      while (i >= 0) {
        val t = lines[i].trim()
        if (t.isEmpty() || t.startsWith("*") || t.startsWith("/*") || t.startsWith("//")) { i--; continue }
        return t == "@Synchronized"
      }
      return false
    }
    assertFalse("exec 不得持实例锁（issue #1594）",
      annotated("override fun exec(argv: Array<String>, timeoutMs: Int): Bundle {"))
    assertFalse("execCapture 不得持实例锁（issue #1594）",
      annotated("override fun execCapture(argv: Array<String>, timeoutMs: Int, inlineBytes: Int): Bundle {"))
    // 维护面保持串行：它们真的改共享的落盘状态。
    assertTrue("configure 必须仍然串行", annotated("override fun configure(appUid: Int, appDataDir: String) {"))
    assertTrue("repairOwnership 必须仍然串行",
      annotated("override fun repairOwnership(path: String, maxEntries: Int): Bundle {"))
    assertTrue("writeChunk 必须仍然串行",
      annotated("override fun writeChunk(path: String, data: ByteArray, append: Boolean): Bundle {"))
    assertTrue("removePath 必须仍然串行", annotated("override fun removePath(path: String): Bundle {"))
  }

  /** 身份字段必须是 @Volatile：exec 不再持锁后它们由维护面写、执行面读。 */
  @Test
  fun userServiceIdentityFieldsAreVolatile() {
    val code = shellCode("ShizukuUserService.kt")
    assertTrue("appUid 必须 @Volatile", code.contains("@Volatile private var appUid"))
    assertTrue("appDataDir 必须 @Volatile", code.contains("@Volatile private var appDataDir"))
  }

  // ── issue #1601：停机必须等执行线程离开；审计时间戳必须线程安全 ──────────────

  /**
   * 缺陷形态：stop() 只置 running=false + interrupt() 就清引用；阻塞点在 Binder 调用上，
   * interrupt() 打断不了。重启后旧线程仍在跑当前 op ⇒ 两条特权命令并发执行，而 reqId 去重 LRU
   * 是实例级的，新实例 map 为空 ⇒ 同一条请求被执行第二次。
   */
  @Test
  fun pollerStopWaitsForTheWorkerInsteadOfOnlyFlippingTheFlag() {
    val code = shellCode("ControlPoller.kt")
    assertTrue("stop() 必须走有界等待（issue #1601）", code.contains("WorkerJoin.joinQuietly(worker, STOP_JOIN_MS)"))
    assertTrue("等待必须有上界（停机不能无限挂住）", code.contains("internal const val STOP_JOIN_MS"))
    assertTrue("超时后必须留痕，而不是假装停干净", code.contains("worker still running after"))
    // 旧形态（只翻标志位 + interrupt 就返回）不得回归：等待必须真的发生在 stop() 体内。
    val stopBody = code.substringAfter("fun stop() {").substringBefore("\n  }")
    assertTrue("等待必须在 stop() 体内，而不是别处", stopBody.contains("WorkerJoin.joinQuietly"))
  }

  /** 载体停机时 appContext 必须一并清空，否则已死的 Context 仍会被拿去真执行 op。 */
  @Test
  fun carrierStopClearsTheApplicationContext() {
    val code = shellCode("ControlCarrier.kt")
    val stopBody = code.substringAfter("fun stop() {").substringBefore("\n  }")
    assertTrue("stop() 必须清 appContext（issue #1601）", stopBody.contains("appContext = null"))
  }

  /**
   * 缺陷形态：ControlAudit.TS 是 object 级共享的 SimpleDateFormat（非线程安全）。并发 format()
   * 会产出错乱时间戳或抛异常，而 log() 外层 catch 把它静默吞掉——审计行直接消失。
   *
   * 判据是行为：并发调用 entry() 必须全部成功且时间戳格式恒定。
   */
  @Test
  fun auditTimestampsStayWellFormedUnderConcurrency() {
    val pattern = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z")
    val errors = java.util.concurrent.ConcurrentLinkedQueue<Throwable>()
    val stamps = java.util.concurrent.ConcurrentLinkedQueue<String>()
    val threads = (0 until 8).map {
      Thread {
        try {
          repeat(200) {
            stamps += ControlAudit.entry("shExec", ControlAudit.RESULT_OK, mapOf("op" to "shExec")).getString("ts")
          }
        } catch (t: Throwable) {
          errors += t
        }
      }
    }
    threads.forEach { it.start() }
    threads.forEach { it.join() }
    assertTrue("并发格式化不得抛异常（旧 SimpleDateFormat 形态）：" + errors.firstOrNull(), errors.isEmpty())
    assertEquals("每条记录都必须产出时间戳", 1600, stamps.size)
    for (stamp in stamps) {
      assertTrue("时间戳必须保持 ISO8601 毫秒 UTC 形态，实得：" + stamp, pattern.matches(stamp))
    }
  }

  // ── issue #1598：审批动作在锁屏可直接点 ────────────────────────────────────

  /**
   * 缺陷形态：正文做了锁屏脱敏（VISIBILITY_PRIVATE + 公版文案），动作按钮没做。设备锁屏放在
   * 桌上时，路人点「批准一次」即放行待批的工具调用——可能是 bash。
   *
   * 判据：常量必须为 true，且两条审批动作都走 setAuthenticationRequired(true)。
   */
  @Test
  fun approvalActionsRequireUnlockLikeTheBodyDoes() {
    assertTrue("APPROVAL_REQUIRE_UNLOCK 必须为 true（issue #1598）", NotifyCenter.APPROVAL_REQUIRE_UNLOCK)
    val code = shellCode("NotifyCenter.kt")
    val body = code.substringAfter("private fun addApprovalActions(").substringBefore("\n  }")
    assertTrue("批准动作必须要求解锁", body.contains("approve.setAuthenticationRequired(true)"))
    assertTrue("拒绝动作必须要求解锁", body.contains("reject.setAuthenticationRequired(true)"))
  }

  // ── issue #1599：诊断包不得默认带上引擎会话日志 ─────────────────────────────

  /**
   * 缺陷形态：白名单挡的是文件名，挡不住内容。engine.log 是引擎 stdout/stderr 原样重定向
   * （完整会话 + 模型读过的文件内容），而 LogSanitizer 只覆盖七类凭据形态，一条都不命中。
   *
   * 判据：候选清单里不得出现 engine.log 及其轮转世代。打包行为判据见 LogShareTest
   * engineConversationLogNeverEntersTheDiagnosticPackage。
   */
  @Test
  fun diagnosticWhitelistDropsTheEngineConversationLog() {
    val tmp = java.nio.file.Files.createTempDirectory("dsh-logshare").toFile()
    try {
      File(tmp, "engine.log").writeText("x")
      File(tmp, "engine.log.1").writeText("x")
      val names = LogShare.candidateFiles(tmp).map { it.name }
      assertFalse("engine.log 不得再进候选面（issue #1599）：" + names, names.contains("engine.log"))
      assertFalse("轮转世代同样不得进候选面：" + names, names.any { it.startsWith("engine.log.") })
      assertTrue("壳侧自有启动日志必须仍在白名单里", names.contains("boot-fail.log"))
    } finally {
      tmp.deleteRecursively()
    }
  }

  // ── issue #1605：MainActivity 必须 singleTop，且热路径也处理来件 ─────────────

  /**
   * 缺陷形态：manifest 没有 launchMode，来件只在 onCreate 处理。发送方带
   * FLAG_ACTIVITY_SINGLE_TOP/CLEAR_TOP 时走 onNewIntent，文件既不拷贝也不提示。
   */
  @Test
  fun mainActivityIsSingleTopAndHandlesIncomingOnBothPaths() {
    val manifest = source("src/main/AndroidManifest.xml")
    val activity = manifest.substringAfter("android:name=\".MainActivity\"").substringBefore("</activity>")
    assertTrue("MainActivity 必须声明 singleTop（issue #1605）",
      activity.contains("android:launchMode=\"singleTop\""))
    val code = shellCode("MainActivity.kt")
    assertTrue("来件处理必须抽成共用入口", code.contains("private fun handleIncomingIntent(intent: Intent?)"))
    // 声明一次 + 两个调用点。
    assertEquals("onCreate 与 onNewIntent 都必须处理来件", 3,
      Regex("handleIncomingIntent\\(").findAll(code).count())
    // 旧形态是「onCreate 里直调」；现在它只允许出现在共用入口里（恰好一次）。
    assertEquals("FileIncoming 只允许被共用入口调用一次（旧形态 = onCreate 里直调）", 1,
      Regex("FileIncoming\\.processIncomingIntent\\(").findAll(code).count())
  }

  // ── issue #1612：面板展开期间返回键必须能收起面板 ───────────────────────────

  /**
   * 缺陷形态：面板窗口 flags 只有 FLAG_NOT_TOUCH_MODAL（= 可聚焦，弹输入法需要），而全仓没有任何
   * KEYCODE_BACK 处理。展开期间 BACK 被派发到 overlay 窗口，视图树无人消费，非 Activity 窗口没有
   * 默认回落 ⇒ 事件被丢弃，用户视角是「返回键死了」。
   */
  @Test
  fun overlayPanelConsumesBackToCollapse() {
    val code = shellCode("OverlayService.kt")
    assertTrue("面板根 View 必须消费 BACK（issue #1612）", code.contains("unit.setOnKeyListener"))
    // 判定真值表本身有独立的行为判据（ShellStopAndBackKeyTest）；这里守「面板真的接上了它」。
    assertTrue("必须走 OverlayBackKey 判定", code.contains("OverlayBackKey.shouldCollapse(code, event.action)"))
    val showPanel = code.substringAfter("private fun showPanel()").substringBefore("internal fun hidePanel")
    assertTrue("收起必须真的调 hidePanel", showPanel.contains("hidePanel()"))
    assertTrue("不得为了返回键去掉可聚焦（那是弹输入法的前提）",
      showPanel.contains("FLAG_NOT_TOUCH_MODAL") && !showPanel.contains("FLAG_NOT_FOCUSABLE"))
  }

  // ── issue #1623：工厂 disabled 语义对多子条目 insert 组同样有效 ───────────────

  /**
   * 缺陷形态：merge() 收集工厂 disabled 权威时条件是 want != null && block.entries.size == 1。
   * 任何 insert 组只要有两个及以上子条目，组子条目声明的 disabled 就被静默丢弃。
   *
   * 行为判据见 FactoryProfilePatchTest（正反两条）。这里补一条常量级判据：块级限制不得回到实现里。
   */
  @Test
  fun factoryDisabledCollectionHasNoSingleEntryRestriction() {
    val code = shellCode("FactoryProfilePatch.kt")
    assertFalse("不得再用 block.entries.size == 1 限制工厂 disabled 收集（issue #1623）",
      code.contains("block.entries.size == 1"))
    assertTrue("条目级判据必须在场", code.contains("if (want != null) factoryDisabled[entry.id] = want"))
  }
}
