package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 属主维护「结算语义 + 清算纪律」源码契约（2026-10-01 无 root/已撤 root 设备卡「等待属主维护」事故换来）：
 * ①拿到完整信封的回执必须 finish 租约（部分修复回 repair-incomplete，而不是 UNKNOWN 隔离到整机重启）；
 * ②su 从未派发出去（spawn 即失败/明确拒绝）同样 finish 租约；
 * ③granted 缓存不得比 su 本体活得久（拉不起进程 ⇒ 立刻降级，别让启动自愈按旧缓存反复误判）；
 * ④残留租约只在**入口**（咨询租约之前、同一临界区内）清算，且**只在 root 通道被肯定判定为不存在时**清；
 * ⑤worker 内不再清算，且 worker 与入口共用同一三态判据（真值表见 [RootChannelDecisionTest]）。
 *
 * 切片纪律（review 2026-10-02 两次收紧）：成员边界取「下一个成员声明」而不是下一个文档注释；
 * 注释用**扫描器**剔除（不是按行首匹配）。否则断言会命中隔壁函数或行尾注释里的同名片段而假绿——
 * 本文件末尾的 `memberBoundaryDoesNotCrossIntoTheNextMember` 就是这条纪律的反证用例。
 */
class OwnershipLeaseSettlementFixtureTest {
  private fun source(name: String): String {
    val suffix = "app/src/main/java/com/dsharnessmobile/shell/$name.kt"
    val file = listOf(File(suffix), File("dsh-mobile-apk/$suffix"),
      File("src/main/java/com/dsharnessmobile/shell/$name.kt")).firstOrNull { it.isFile }
      ?: error("owned source unavailable: $name")
    return stripComments(file.readText())
  }

  /**
   * 真正的注释扫描器：字符串字面量整体保留（断言的靶子就是字面量，里面的 `//` 不是注释起点），
   * 块注释跨行带走，行尾 `//` 也剔除（这正是「行尾注释里的 su-exec-failed 也能满足 contains」的修法）。
   */
  private fun stripComments(text: String): String {
    val out = StringBuilder(text.length)
    var i = 0
    while (i < text.length) {
      val c = text[i]
      if (c == '"') {
        out.append(c); i++
        while (i < text.length) {
          val d = text[i]
          out.append(d)
          if (d == '\\' && i + 1 < text.length) { out.append(text[i + 1]); i += 2; continue }
          i++
          if (d == '"') break
        }
        continue
      }
      if (c == '/' && i + 1 < text.length && text[i + 1] == '/') {
        while (i < text.length && text[i] != '\n') i++
        continue
      }
      if (c == '/' && i + 1 < text.length && text[i + 1] == '*') {
        i += 2
        while (i + 1 < text.length && !(text[i] == '*' && text[i + 1] == '/')) i++
        i = minOf(text.length, i + 2)
        continue
      }
      out.append(c); i++
    }
    return out.toString()
  }

  /**
   * 成员声明边界：注解 + 修饰符（含 suspend/inline/operator…）+ `fun`/`val`/`var`/`object`/`class` 等。
   * 只认**两空格缩进**的顶层成员，所以函数体内的局部 `val`/局部 `fun` 不会误判为边界。
   */
  private val memberBoundary = Regex(
    "(?m)^  (?:@[A-Za-z_][\\w.]*(?:\\([^)]*\\))?\\s+)*" +
      "(?:(?:public|private|protected|internal|open|final|abstract|override|suspend|inline|operator|" +
      "infix|tailrec|external|actual|expect|const|lateinit|crossinline|noinline)\\s+)*" +
      "(?:fun|val|var|object|class|interface|enum class|companion object)\\b",
  )

  private fun body(name: String, signature: String): String {
    val text = source(name)
    val start = text.indexOf(signature)
    if (start < 0) error("missing member $name: $signature")
    val next = memberBoundary.find(text, start + signature.length)?.range?.first ?: text.length
    return text.substring(start, next)
  }

  @Test fun acknowledgedEnvelopeSettlesLeaseEvenWhenRepairIsIncomplete() {
    val repair = body("ShizukuTransport", "fun repairOwnership(")
    val envelope = repair.indexOf("val envelopeComplete =")
    val incomplete = repair.indexOf("lease.complete(result, definitive = false)")
    val settled = repair.indexOf("lease.complete(settled, definitive = true)")
    assertTrue(envelope >= 0 && incomplete > envelope && settled > incomplete)
    assertTrue(repair.contains("put(\"reason\", \"repair-incomplete\")"))
    assertTrue(repair.contains("put(\"remaining\", -1)"))
    assertFalse(repair.contains("definitive = verified"))
  }

  @Test fun suSpawnFailureIsNeverDispatchedAndSettlesLeaseInsteadOfQuarantine() {
    // 边界收紧后这条 contains 钉的确实是 execRoot **自己**新增的拒绝集项；且执行面在隔壁函数里，
    // 用 writeState 的存在与否反证切片没跨过去。
    val entry = body("RootAccess", "fun execRoot(")
    assertTrue(entry.contains("\"su-exec-failed\""))
    assertFalse(entry.contains("writeState("))
    val repair = body("RootAccess", "private fun repairOwned(")
    assertTrue(repair.contains("\"su-exec-failed\""))
    val finishInExec = entry.indexOf("RootMaintenanceLease.finish(app)")
    val markInExec = entry.indexOf("RootMaintenanceLease.markUnknown")
    assertTrue(finishInExec >= 0 && (markInExec < 0 || finishInExec < markInExec))
  }

  @Test fun grantedCacheIsDemotedWhenSuCannotEvenBeSpawned() {
    val dispatch = body("RootAccess", "private fun execPrivileged(")
    val catchBlock = dispatch.substringAfter("} catch (t: Throwable) {")
    assertTrue(catchBlock.contains("writeState(context.applicationContext, STATE_DENIED, -1)"))
    assertTrue(catchBlock.indexOf("writeState") < catchBlock.indexOf("fail(\"su-exec-failed\""))
  }

  @Test fun workerSharesTheSameTriStateCriterionAndNoLongerClearsTheLeaseItself() {
    val direct = body("ShizukuTransport", "internal fun autoHealOwnershipDirect(")
    // 与入口同一判据（同一三态探测），不再自带一套 uid/viaSu 判断。
    val probe = direct.indexOf("val probe = probeRootChannel(app)")
    val fence = direct.indexOf("RootExecutionFence.maintenance(context)")
    assertTrue(probe >= 0 && fence > probe)
    assertFalse(direct.contains("Shizuku.getUid()"))
    assertTrue(direct.contains("probe.state != RootChannel.AVAILABLE"))
    // 不可用报 no-root-path；探测不完备报 root-channel-unknown（不得混为一谈）。
    assertTrue(direct.contains("\"no-root-path\""))
    assertTrue(direct.contains("\"root-channel-unknown\""))
    assertTrue(direct.contains("return RootExecutionFence.maintenance(context) {"))
    assertFalse(direct.contains("clearWhenNoRootChannel"))
  }

  @Test fun entryClearOnlyFiresOnDefiniteAbsenceAndIsGuardedByTheFence() {
    val entry = body("ShizukuTransport", "internal fun clearLeaseWhenNoRootChannel(")
    assertTrue(entry.contains("val probe = probeRootChannel(app)"))
    // 自动清算＝通道被证实不存在 + 租约从未派发 + **租约状态可信** + 无在飞维护（复审第 2 点 + 第四轮）
    assertTrue(entry.contains("val dispatched = lease?.optBoolean(\"dispatched\") == true"))
    assertTrue(entry.contains("val leaseUnknown = lease?.optBoolean(\"unknown\") == true || RootMaintenanceLease.unknown(app)"))
    assertTrue(entry.contains("autoClearAllowed(probe.state, dispatched, leaseUnknown, RootExecutionFence.maintenanceActive)"))
    assertTrue(entry.contains("if (!allowed) return false"))
    assertTrue(entry.contains("LeaseClearProbe.record(app, probe, decisive = true, dispatched = dispatched, allowed = allowed,"))
    // 锁内复核四条件（判断—清除之间：通道可能复活 / 维护可能开始 / 租约可能刚被派发 / 租约状态可能变得不可信）
    assertTrue(entry.contains("!RootExecutionFence.maintenanceActive && !RootAccess.isGranted(app) &&"))
    assertTrue(entry.contains("!RootMaintenanceLease.dispatched(app) && !RootMaintenanceLease.unknown(app)"))
    assertTrue(entry.contains("RootMaintenanceLease.clearWhenNoRootChannel(app)"))
  }

  @Test fun markDispatchedPersistenceFailureMustBlockAutomaticLeaseClear() {
    // 复审第四轮点名的回归：markDispatched 落盘失败 ⇒ 只置 unknown、dispatched 仍是 false
    // ⇒ 若只看 dispatched 就会放行自动清算（而特权 RPC 其实已经/即将派发）✗ ⇒ 必须被 unknown 明确否决。
    // ① 纯判据层面：unknown=true 一律否决
    assertFalse(ShizukuTransport.autoClearAllowed(ShizukuTransport.RootChannel.ABSENT, false, true, false))
    // ② 失败时确实置 unknown（而不是静默当成功）
    val mark = body("RootMaintenanceLease", "fun markDispatched(")
    assertTrue(mark.contains("if (!written) {"))
    assertTrue(mark.contains("unknown = true"))
    assertTrue(mark.contains("return@synchronized false"))
    // ③ 两条派发路径都必须**检查返回值并拒绝派发**（证据落不了盘就不跑特权工作）
    assertTrue(source("ShizukuTransport").contains("if (!RootMaintenanceLease.markDispatched(context, \"shizuku\")) {"))
    assertTrue(source("ShizukuTransport").contains("root-lease-evidence-unavailable"))
    assertTrue(source("RootAccess").contains("!RootMaintenanceLease.markDispatched(context, \"su\")"))
    assertTrue(source("RootAccess").contains("root-lease-evidence-unavailable"))
    // ④ 最终清除路径必须把 unknown 带进判据与锁内 guard（不是只改纯函数）
    val entry = body("ShizukuTransport", "internal fun clearLeaseWhenNoRootChannel(")
    assertTrue(entry.contains("leaseUnknown"))
    assertTrue(entry.contains("!RootMaintenanceLease.unknown(app)"))
    // ⑤ 审计也要留下这个否决项，便于事后复核
    assertTrue(body("LeaseClearProbe", "fun record(").contains(".put(\"leaseUnknown\", leaseUnknown)"))
  }

  @Test fun restoredLeaseFromAnotherProcessIsNeverAutoCleared() {
    // 跨进程/进程重建：新进程恢复旧租约时 restore() 置 unknown=true（结算状态不可信、旧工作终止不可证）
    val restore = body("RootMaintenanceLease", "private fun restore(")
    assertTrue(restore.contains("unknown = pendingEpoch != null"))
    assertFalse(ShizukuTransport.autoClearAllowed(ShizukuTransport.RootChannel.ABSENT, false, true, false))
    // 但人工出口仍可用，且如实回 terminationUnproven（dispatched 或 unknown 任一为真即不可证）
    val forced = body("ShizukuTransport", "internal fun forceClearMaintenanceLease(")
    assertTrue(forced.contains("val unproven = dispatched || leaseUnknown"))
    assertTrue(forced.contains("put(\"terminationUnproven\", unproven)"))
    assertTrue(forced.contains("RootMaintenanceLease.clearWhenNoRootChannel(app)"))
  }

  @Test fun theSingleJudgeReallyAttemptsABindAndNeverFallsBackToUnreliableSignals() {
    // 取「吃 RootProbeEnv 的那个实现」——同名重载（Context 版只是委派）不能算数
    val probe = body("ShizukuTransport", "internal fun probeRootChannel(env: RootProbeEnv): RootChannelProbe {")
    assertTrue(probe.contains("env.bindUserService()"))
    assertTrue(probe.contains("env.boundServiceUid()"))
    assertTrue(probe.contains("decideNoRootChannel("))
    // 复审第 1 点：判据不得退回两个已证明不可靠的信号
    assertFalse(probe.contains("getUid()"))
    assertFalse(probe.contains("checkSelfPermission"))
    // 真绑定在环境实现里，且必须**绕过**不可信的客户端权限预检、且不弹框
    val env = body("ShizukuTransport", "private class SystemRootProbeEnv(")
    assertTrue(env.contains("ignoreGranted = true"))
    assertTrue(env.contains("requestPermission = false"))
    assertTrue(env.contains("readyService(app, applyGate = false"))
    // ensureBound 必须真的支持这条绕过路径（否则又回到「granted=false 就直接返回」）
    val bound = body("ShizukuTransport", "fun ensureBound(")
    assertTrue(bound.contains("ignoreGranted: Boolean = false"))
    assertTrue(bound.contains("if (!ignoreGranted && !before.optBoolean(\"granted\"))"))
    // worker 与入口消费的是同一个探测（判据同源）
    assertTrue(body("ShizukuTransport", "internal fun autoHealOwnershipDirect(").contains("probeRootChannel(app)"))
  }

  @Test fun dispatchEvidenceIsRecordedOnBothTransports() {
    // 复审第 2 点：派发过就必须留痕，让自动清算永久让位于「外部工作可能仍在跑」
    assertTrue(body("RootAccess", "private fun execPrivileged(").contains("RootMaintenanceLease.markDispatched(context, \"su\")"))
    assertTrue(source("ShizukuTransport").contains("RootMaintenanceLease.markDispatched(context, \"shizuku\")"))
    val lease = body("RootMaintenanceLease", "fun markDispatched(")
    assertTrue(lease.contains("putString(KEY_DISPATCHED, transport.take(24))"))
    // 标记写不进 ⇒ 置为结果不明（保守方向），绝不当作「没派发过」
    assertTrue(lease.contains("unknown = true"))
  }

  @Test fun forcedClearRefusesWhileMaintenanceIsActive() {
    val forced = body("ShizukuTransport", "internal fun forceClearMaintenanceLease(")
    assertTrue(forced.contains("if (RootExecutionFence.maintenanceActive)"))
    assertTrue(forced.contains("\"maintenance-active\""))
    assertTrue(forced.contains("RootMaintenanceLease.clearWhenNoRootChannel(app)"))
    // 复审第 3 点：用户确认不是终止证明 —— 如实回 terminationUnproven 并写进审计
    assertTrue(forced.contains("val unproven = dispatched || leaseUnknown"))
    assertTrue(forced.contains("forced = true, dispatched = dispatched, allowed = false, leaseUnknown = leaseUnknown)"))
  }

  @Test fun leaseClearCommitIsBoundedRetriedInsteadOfLeavingAPermanentLease() {
    val lease = body("RootMaintenanceLease", "fun clearWhenNoRootChannel(")
    assertTrue(lease.contains("for (attempt in 1..2)"))
    assertTrue(lease.contains("if (cleared) break"))
    // 复审第 5.6 点：commit 失败后内存状态必须仍然「有租约」（否则会出现「盘上还在、内存说清了」的错位）
    assertTrue(lease.contains("if (cleared) {"))
    assertTrue(lease.contains("pendingEpoch = null"))
  }

  @Test fun backgroundSelfHealNeverRaisesAPermissionDialog() {
    // 后台自愈（repairOwnership）必须在取服务时就禁掉授权请求：否则本机假阴性会让维护卡在系统框上
    val repair = body("ShizukuTransport", "fun repairOwnership(")
    // 后台自愈（repairOwnership）两条约束：不弹授权框 + 绕过不可靠的客户端权限预检
    // （否则本机自检假阴性会让维护卡在系统框上、或永远修不了 —— 复审 B 项）
    assertTrue(repair.contains("readyService(context, applyGate = false, requestPermission = false, ignoreGranted = true)"))
    assertFalse(repair.contains("Shizuku.requestPermission"))
  }

  @Test fun auditTrailKeepsRawSignalsAndWhetherABindWasEvenAttempted() {
    // 复审第 4 点：日志要能一眼区分「没尝试 bind / bind 失败 / 权限拒绝 / binder 未就绪 / 真绑成功」
    val probe = body("ShizukuTransport", "internal fun probeRootChannel(env: RootProbeEnv): RootChannelProbe {")
    assertTrue(probe.contains("\" bind=\" + outcome.name"))
    assertTrue(probe.contains("\" ping=\" + (ping?.toString() ?: \"throw\")"))
    assertTrue(probe.contains("\" suBinary=\" + env.suBinaryPresent"))
    val audit = body("LeaseClearProbe", "fun record(")
    assertTrue(audit.contains(".put(\"dispatched\", dispatched)"))
    assertTrue(audit.contains(".put(\"allowed\", allowed)"))
    assertTrue(audit.contains(".put(\"detail\", probe.detail)"))
  }

  @Test fun forceClearMaintenanceLeaseRefusesIfMaintenanceStartsAfterInitialCheck() {
    // 复审第五轮的竞态：人工路径的 maintenanceActive 只在**锁外**查过一次 ⇒ 中间那段窗口里另一个入口
    // 可以启动维护（拿到新租约）⇒ 不带 guard 的 clear 会把它清掉 ✗。修法＝人工路径也传锁内 guard。
    val forced = body("ShizukuTransport", "internal fun forceClearMaintenanceLease(")
    // ① 锁外那次检查保留（给用户一句明确的话），但**不是**唯一保护
    assertTrue(forced.contains("if (RootExecutionFence.maintenanceActive) {"))
    // ② 真正的清除必须带锁内 guard（与自动路径同一保护）
    assertTrue(forced.contains("RootMaintenanceLease.clearWhenNoRootChannel(app) {"))
    assertTrue(forced.contains("!RootExecutionFence.maintenanceActive"))
    // ③ 结构性契约：**任何** clearWhenNoRootChannel 调用都必须带 guard（防以后有人再加一条裸调用）
    val shellSources = listOf("ShizukuTransport", "RootOwnershipJobs", "RootAccess", "GuidePageRenderer",
      "EngineStartFlow", "EngineService", "RootExecutionFence").joinToString("\n") { source(it) }
    val unguarded = Regex("""clearWhenNoRootChannel\(app\)(?!\s*\{)""").findAll(shellSources).count()
    assertTrue("不得存在不带 guard 的 clearWhenNoRootChannel 调用（发现 $unguarded 处）", unguarded == 0)
    // ④ 租约层：guard 在锁内、且在**任何写盘之前**求值（false 即原样返回、不落任何改动）
    val lease = body("RootMaintenanceLease", "fun clearWhenNoRootChannel(")
    assertTrue(lease.contains("if (!guard()) return@synchronized false"))
    // 更强的一条：guard **不给默认值** ⇒ 「不带 guard 的清除」在编译期就不可能（结构性消除绕过路径）
    assertTrue(lease.contains("guard: () -> Boolean): Boolean"))
    val guardAt = lease.indexOf("if (!guard())")
    val firstWriteAt = lease.indexOf("for (attempt in 1..2)")
    assertTrue("guard 必须早于任何写盘", guardAt in 0 until firstWriteAt)
    // ⑤ 拒绝时不得谎报成功
    assertTrue(forced.contains("put(\"ok\", cleared)"))
  }

  @Test fun waitingPhaseHasASlowRecheckAfterTheBoundedBudget() {
    assertTrue(source("EngineStartFlow").contains("ownershipRetry.nextDelayMs() ?: SLOW_OWNERSHIP_RECHECK_MS"))
    assertTrue(source("EngineService").contains("SLOW_OWNERSHIP_RECHECK_MS = 300_000L"))
    val service = body("EngineService", "private fun ensureEngine(")
    assertTrue(service.contains("epoch.ownershipRetry.nextDelayMs() ?: SLOW_OWNERSHIP_RECHECK_MS"))
    assertTrue(service.contains("scheduleStartup(epoch, delay)"))
    val retire = body("EngineService", "private fun retireEpoch(")
    assertTrue(retire.contains("epoch.startupFuture.getAndSet(null)?.cancel(true)"))
    val schedule = body("EngineService", "private fun scheduleStartup(")
    assertTrue(schedule.contains("if (!isEpochCurrent(epoch)) future.cancel(true)"))
  }

  @Test fun waitingPhaseOffersAProductExitInsteadOfForcingAReboot() {
    val guide = source("GuidePageRenderer")
    assertTrue(guide.contains("confirmClearMaintenanceLease(pending)"))
    assertTrue(guide.contains("ShizukuTransport.forceClearMaintenanceLease"))
    assertTrue(guide.contains("setPositiveButton"))
    assertTrue(guide.contains("清除隔离并重试"))
  }

  @Test fun theProductExitIsActuallyReachableWhileTheLeaseIsUnsettled() {
    // 复审第 3 点的落地判据：出口不能只是「代码里有」——等待相位原本把主按钮**锁死**（S1-3），
    // 于是用户根本点不到那个确认框（2026-10-03 真机实测：点主按钮无反应）。现在仅当租约未结算时解锁。
    val guide = source("GuidePageRenderer")
    assertTrue(guide.contains("val leasePending = phase == GuidePhase.Recovering &&"))
    assertTrue(guide.contains("RootMaintenanceLease.outstanding(activity.applicationContext) != null"))
    assertTrue(guide.contains("val locked = lockPrimary && !leasePending"))
    assertTrue(guide.contains("chrome.primaryButton.isEnabled = !locked"))
    assertTrue(guide.contains("leasePending -> activity.getString(R.string.ds_clear_isolation)"))
    val strings = listOf(File("src/main/res/values/strings.xml"), File("app/src/main/res/values/strings.xml"))
      .first { it.isFile }.readText()
    assertTrue(strings.contains("ds_clear_isolation"))
  }

  @Test fun leaseClearEvaluatesItsGuardInsideTheSameCriticalSectionAsBegin() {
    // 判断—清除与 begin() 共用同一临界区（review 第 4 点）：guard 必须在锁内、清除之前求值。
    val lease = body("RootMaintenanceLease", "fun clearWhenNoRootChannel(")
    val lock = lease.indexOf("synchronized(lock)")
    val guard = lease.indexOf("if (!guard()) return@synchronized false")
    val commit = lease.indexOf("edit().clear().commit()")
    assertTrue(lock >= 0 && guard > lock && commit > guard)
  }

  @Test fun staleLeaseIsClearedInsideTheJobEntryCriticalSection() {
    // 真机实测（2026-10-02）：清算放进本锁、且只在确实有租约时付探测成本；置 running 在同一临界区内。
    val jobs = body("RootOwnershipJobs", "private fun start(")
    val lock = jobs.indexOf("synchronized(entryLock)")
    val runningCheck = jobs.indexOf("if (running) return false")
    val firstOutstanding = jobs.indexOf("RootMaintenanceLease.outstanding(app) != null")
    val clear = jobs.indexOf("ShizukuTransport.clearLeaseWhenNoRootChannel(app)")
    val secondOutstanding = jobs.lastIndexOf("RootMaintenanceLease.outstanding(app) != null")
    val setRunning = jobs.indexOf("running = true")
    assertTrue(lock >= 0 && runningCheck > lock && firstOutstanding > runningCheck)
    assertTrue(clear > firstOutstanding && secondOutstanding > clear)
    assertTrue(setRunning > clear)
  }

  @Test fun rootStatusReadIsNotBlockedByTheEntryProbe() {
    // issue #319（方案来自 PR #322 @Ni-ShuWu）：真绑定探测最长 15s，不得在 state() 共用的状态锁内执行。
    // 反证：探测调用必须出现在 entryLock 内，且**不在任何 synchronized(lock) 块里**。
    val jobs = body("RootOwnershipJobs", "private fun start(")
    val probe = jobs.indexOf("ShizukuTransport.clearLeaseWhenNoRootChannel(app)")
    assertTrue(probe > jobs.indexOf("synchronized(entryLock)"))
    val stateLockBlocks = Regex("""synchronized\(lock\)\s*\{""").findAll(jobs).map { it.range.last }.toList()
    for (open in stateLockBlocks) {
      var depth = 1
      var i = open + 1
      while (i < jobs.length && depth > 0) {
        if (jobs[i] == '{') depth++ else if (jobs[i] == '}') depth--
        i++
      }
      assertFalse("探测落在状态锁内会重现 #319", probe in open..i)
    }
    // state() 只取状态锁，不碰入口锁。
    assertFalse(body("RootOwnershipJobs", "fun state(").contains("entryLock"))
  }

  @Test fun noRootPathClearIsTheOnlyNonOwnerExitAndKeepsUnknownSemanticsElsewhere() {
    val lease = source("RootMaintenanceLease")
    assertTrue(lease.contains("unknown || owner !== Thread.currentThread()"))
    assertTrue(lease.substringAfter("fun finish(").substringBefore("fun markUnknown")
      .doesNotContain("clearWhenNoRootChannel"))
  }

  @Test fun memberBoundaryDoesNotCrossIntoTheNextMember() {
    // 反证：切片右边界必须是下一个成员声明，且注释被扫描器剔除（否则这些断言会因隔壁代码/注释而假绿）。
    assertFalse(body("RootAccess", "fun execRoot(").contains("private fun execPrivileged"))
    assertFalse(body("RootAccess", "fun execRoot(").contains("private fun repairOwned"))
    assertFalse(body("ShizukuTransport", "fun repairOwnership(").contains("internal fun autoHealOwnershipDirect("))
    assertFalse(body("ShizukuTransport", "internal fun rootChannelAvailable(")
      .contains("internal fun classifyRootChannel("))
    // 行尾/块注释里的字面量与说明文字都不该出现在切片里
    assertFalse(body("RootAccess", "private fun execPrivileged(").contains("异常只进日志"))
    assertFalse(body("ShizukuTransport", "internal fun clearLeaseWhenNoRootChannel(").contains("真机实测"))
  }

  private fun String.doesNotContain(other: String): Boolean = !this.contains(other)
}
