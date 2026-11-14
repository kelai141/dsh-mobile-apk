package com.dsharnessmobile.shell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

/** Epoch decisions and durable admission wiring; actual root/su settlement remains external validation. */
class RootMaintenanceLeaseTest {
  @Test fun missingEpochNeverProvesTermination() {
    for (epoch in listOf<String?>(null, "", "boot-id:one", "boot-count:7")) {
      assertFalse(RootMaintenanceLease.newBoot(epoch, null))
      assertFalse(RootMaintenanceLease.newBoot(null, epoch))
    }
  }
  @Test fun sameBootSourceNeverProvesTermination() {
    assertFalse(RootMaintenanceLease.newBoot("boot-id:one", "boot-id:one"))
    assertFalse(RootMaintenanceLease.newBoot("boot-count:7", "boot-count:7"))
  }
  @Test fun changingEpochSchemeCannotClearSameBootUncertainty() {
    assertFalse(RootMaintenanceLease.newBoot("boot-id:one", "boot-count:7"))
    assertFalse(RootMaintenanceLease.newBoot("boot-count:7", "boot-id:two"))
    assertFalse(RootMaintenanceLease.newBoot("unknown:one", "unknown:two"))
  }
  @Test fun knownNewBootPermitsEarlierProcessLeaseRetirement() {
    assertTrue(RootMaintenanceLease.newBoot("boot-id:one", "boot-id:two"))
    assertTrue(RootMaintenanceLease.newBoot("boot-count:7", "boot-count:8"))
  }
  private fun source(name: String): String = listOf(File("src/main/java/com/dsharnessmobile/shell/$name.kt"),
    File("app/src/main/java/com/dsharnessmobile/shell/$name.kt")).first { it.isFile }.readText()
  @Test fun durableLeasePrecedesSuHelperAndUnknownIsNotOrdinaryFailure() {
    val root = source("RootAccess")
    val begin = root.indexOf("""RootMaintenanceLease.beginOperation(app, "su-ownership")""")
    val dispatch = root.indexOf("val transport = execPrivileged(app, command")
    assertTrue(begin >= 0 && dispatch > begin)
    assertTrue(root.contains("""markUnknown(app, "repair-transport-incomplete")"""))
    assertTrue(root.contains("cleanupIncomplete") && root.contains("readError"))
  }
  @Test fun unknownCannotBeClearedByLateFinishOrNewApplicationProcess() {
    val lease = source("RootMaintenanceLease")
    // finish 现在经纯判据 finishAllowed（owner + unknown + 期望 ID），三条件仍缺一不可。
    assertTrue(lease.contains("ownerMatches = owner === Thread.currentThread()"))
    assertTrue(lease.contains("leaseUnknown = unknown"))
    assertTrue(lease.contains("expectedId = expectedOperationId"))
    assertTrue(lease.contains("unknown = pendingEpoch != null"))
    assertTrue(lease.contains("prefs.edit().clear().commit()"))
    assertTrue(source("RootExecutionFence").contains("read.tryLock(0, TimeUnit.MILLISECONDS)"))
    assertTrue(source("RootOwnershipJobs").contains("RootMaintenanceLease.outstanding(context)"))
  }

  // ── PRD 5.2 / AC-08：唯一操作 ID 与结果归属 ───────────────────────────────

  @Test fun operationIdIsCanonicalAndDistinctPerOperation() {
    // 每次调用都换一个真随机源：判的是「生成器每次都给新 ID」，不是「注入的伪随机序列」。
    val random = java.security.SecureRandom()
    val ids = (0 until 64).map { RootMaintenanceLease.newOperationId { random.nextLong() } }
    for (id in ids) {
      assertTrue("ID 必须是 32 位小写十六进制: " + id, RootMaintenanceLease.isCanonicalOperationId(id))
    }
    assertEquals("同一进程内连续两次操作不得复用 ID", ids.size, ids.toSet().size)
  }

  @Test fun nonCanonicalOperationIdIsRejected() {
    for (bad in listOf(null, "", "abc", "ABCDEF0123456789ABCDEF0123456789",
      "0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcdefg",
      "0123456789abcdef0123456789abcde ")) {
      assertFalse("非法 ID 必须拒绝: " + bad, RootMaintenanceLease.isCanonicalOperationId(bad))
    }
  }

  @Test fun finishRequiresOwnerUnknownAndMatchingOperationId() {
    val id = "0123456789abcdef0123456789abcdef"
    // 正常结算：三者同时成立。
    assertTrue(RootMaintenanceLease.finishAllowed(true, false, id, id))
    // 任何一个不成立都不得清租约。
    assertFalse("非原 owner 线程不得结算", RootMaintenanceLease.finishAllowed(false, false, id, id))
    assertFalse("unknown 租约不得结算", RootMaintenanceLease.finishAllowed(true, true, id, id))
    assertFalse("旧任务 ID 不得清掉新任务的租约",
      RootMaintenanceLease.finishAllowed(true, false, id, "fedcba9876543210fedcba9876543210"))
    // 期望 ID 为「空串」按「未携带」处理（null 与空串同义）：仍受 owner + unknown 约束。
    assertTrue("空期望 ID 等同未携带，仅受 owner/unknown 约束",
      RootMaintenanceLease.finishAllowed(true, false, id, ""))
    // 未携带期望 ID 的调用方仍受 owner + unknown 约束（不放松），而不是无条件放行。
    assertTrue(RootMaintenanceLease.finishAllowed(true, false, id, null))
    assertFalse(RootMaintenanceLease.finishAllowed(false, false, id, null))
    assertFalse(RootMaintenanceLease.finishAllowed(true, true, id, null))
  }

  @Test fun resultMustSelfCertifyBelongingToThisRequest() {
    val id = "0123456789abcdef0123456789abcdef"
    assertTrue(RootOwnershipJobs.resultBelongsToRequest(id, id))
    assertFalse("历史结果不得冒充本次", RootOwnershipJobs.resultBelongsToRequest(
      "fedcba9876543210fedcba9876543210", id))
    assertFalse("没有 ID 的结果无法自证", RootOwnershipJobs.resultBelongsToRequest(null, id))
    assertFalse(RootOwnershipJobs.resultBelongsToRequest("", id))
    assertFalse(RootOwnershipJobs.resultBelongsToRequest(id, null))
  }

  @Test fun startupScansOnlyWhenThereIsUnfinishedOrFailingWork() {
    assertFalse("健康设备启动不做属主扫描", RootOwnershipJobs.startupScanRequired(false, false))
    assertTrue("残留租约时必须复查", RootOwnershipJobs.startupScanRequired(true, false))
    assertTrue("上次报过问题时必须复查", RootOwnershipJobs.startupScanRequired(false, true))
  }

  @Test fun reportedProblemCoversEveryIncompleteEnvelope() {
    fun result(vararg pairs: Pair<String, Any>) = org.json.JSONObject().also {
      for ((k, v) in pairs) it.put(k, v)
    }
    // 无结果不是问题（本进程还没跑过）；健康信封也不是问题。
    assertFalse(RootOwnershipJobs.reportedProblem(null))
    assertFalse(RootOwnershipJobs.reportedProblem(result("ok" to true, "failures" to 0)))
    // 下面每一项都必须触发复查，否则会在启动路径上放过一次未收尾的维护。
    assertTrue("结果不明", RootOwnershipJobs.reportedProblem(result("unknown" to true)))
    assertTrue("显式失败", RootOwnershipJobs.reportedProblem(result("ok" to false)))
    assertTrue("失败计数", RootOwnershipJobs.reportedProblem(result("ok" to true, "failures" to 2)))
    assertTrue("未验证变更", RootOwnershipJobs.reportedProblem(result("ok" to true, "unverifiedMutations" to 1)))
    assertTrue("截断", RootOwnershipJobs.reportedProblem(result("ok" to true, "truncated" to true)))
    assertTrue("超预算", RootOwnershipJobs.reportedProblem(result("ok" to true, "deadlineExceeded" to true)))
  }

  @Test fun followUpRecordChangesOnlyOnRealVerdicts() {
    fun result(vararg pairs: Pair<String, Any>) = org.json.JSONObject().also {
      for ((k, v) in pairs) it.put(k, v)
    }
    // 没有新结论：保持原记录，不得因为一次「没跑」就把上次失败洗成健康。
    assertNull(RootOwnershipJobs.followUpUpdate(null))
    assertNull("无 root 路不算跑过", RootOwnershipJobs.followUpUpdate(result("ok" to true, "skipped" to "no-root-path")))
    assertNull("通道不明不算跑过", RootOwnershipJobs.followUpUpdate(result("ok" to true, "skipped" to "root-channel-unknown")))
    // 真跑过：按结果如实改写。
    assertEquals(false, RootOwnershipJobs.followUpUpdate(result("ok" to true, "failures" to 0)))
    assertEquals(true, RootOwnershipJobs.followUpUpdate(result("ok" to false, "failures" to 1)))
    assertEquals(true, RootOwnershipJobs.followUpUpdate(result("ok" to true, "unverifiedMutations" to 3)))
  }

  @Test fun startupHealthCheckSurvivesProcessRestart() {
    val jobs = source("RootOwnershipJobs")
    // 健康判据必须包含持久记录：只读内存结果会在进程重启后把「上次失败」误判成健康。
    assertTrue("必须持久化复查需求",
      jobs.contains("FOLLOW_UP_PREFS") && jobs.contains("KEY_FOLLOW_UP"))
    assertTrue("启动判据必须合并持久记录",
      jobs.contains("lastReportedProblem = reportedProblem(result) || followUp"))
    // 持久读（prefs IO）不得发生在状态锁内。
    val start = jobs.substringAfter("private fun start(").substringBefore("val worker = Thread(")
    assertTrue("持久记录必须在状态锁外读取", start.indexOf("FollowUp.remembered") in 0 until start.indexOf("synchronized(lock) {", start.indexOf("FollowUp.remembered")))
    assertTrue("只有启动路径才读持久记录", start.contains("val followUp = startup && FollowUp.remembered(app)"))
  }

  @Test fun maintenanceResultIsStampedRecordedAndThenPublished() {
    val jobs = source("RootOwnershipJobs")
    val worker = jobs.substringAfter("val worker = Thread(")
    val stamp = worker.indexOf("isCanonicalOperationId(optString(\"operationId\"))")
    val record = worker.indexOf("FollowUp.record(app, followUpUpdate(stamped))")
    val publish = worker.indexOf("result = stamped")
    // 顺序：先给结果盖本次 ID → 落盘复查需求 → 再发布结果。发布后再落盘会让启动路径短暂读到旧判据。
    assertTrue("必须先盖本次 ID", stamp >= 0 && record > stamp)
    assertTrue("必须先落盘复查需求再发布结果", publish > record)
    // 线程起不来：必须复位、留下带 ID 的失败结果，并记下需要复查（C5）。
    val failure = worker.substringAfter("if (!launched)")
    assertTrue("worker 起不来也要记录复查需求", failure.contains("FollowUp.record(app, true)"))
    assertTrue("失败结果必须带本次 ID", failure.contains(".put(\"operationId\", jobId)"))
    assertTrue("worker 起不来必须复位 running", failure.contains("running = false"))
    assertTrue("worker 起不来必须归零 latch", failure.contains("done.countDown()"))
  }

  @Test fun workerConstructionAndStartShareOneFailurePath() {
    val jobs = source("RootOwnershipJobs")
    val start = jobs.substringAfter("private fun start(").substringBefore("/** UI request returns")
    // 构造函数（含 isDaemon）与 start 必须在同一段 try 覆盖里：只包 start 会让构造阶段的
    // OOM / SecurityException 带着 running=true 与未归零的 latch 逃出去。
    val construction = start.indexOf("val worker = try {")
    val thread = start.indexOf("Thread({", construction)
    val daemon = start.indexOf("isDaemon = true", thread)
    val launchTry = start.indexOf("val launched = try {")
    val launched = start.indexOf("worker.start()", launchTry)
    assertTrue("构造必须在 try 内", construction >= 0 && thread > construction)
    assertTrue("isDaemon 也属于构造，必须被同一个 try 覆盖", daemon in (thread + 1) until launchTry)
    assertTrue("start 必须也在 try 内", launchTry > daemon && launched > launchTry)
    // 构造失败（worker == null）与 start 抛异常都必须落到同一个 launched=false 分支。
    assertTrue(start.contains("null -> false"))
    assertTrue("失败分支必须复位 running 并归零 latch",
      start.substringAfter("if (!launched)").contains("running = false") &&
        start.substringAfter("if (!launched)").contains("done.countDown()"))
    val failureBranch = start.substringAfter("if (!launched)")
    assertTrue("失败分支必须记下本次启动失败 ID", failureBranch.contains("failedLaunchId = jobId"))
  }

  @Test fun launchFailureIsScopedToTheFailedJobOnly() {
    fun failure(id: String) = org.json.JSONObject().put("ok", false)
      .put("code", "repair-worker-unavailable").put("reason", "repair-worker-unavailable")
      .put("failures", 1).put("remaining", -1).put("operationId", id)
    val id = "0123456789abcdef0123456789abcdef"
    assertEquals(id, RootOwnershipJobs.launchFailure(failure(id), id, id)?.optString("operationId"))
    // 旧失败不得冒充另一次作业；没有失败 ID 也不算。
    assertNull(RootOwnershipJobs.launchFailure(failure(id), "", id))
    assertNull(RootOwnershipJobs.launchFailure(failure(id), id, "fedcba9876543210fedcba9876543210"))
    assertNull(RootOwnershipJobs.launchFailure(failure(id), id, ""))
    // 别的失败码不是「起不来」，不能被这条路径领走。
    assertNull(RootOwnershipJobs.launchFailure(org.json.JSONObject().put("ok", false)
      .put("code", "repair-native-failed").put("operationId", id), id, id))
    assertNull(RootOwnershipJobs.launchFailure(null, id, id))
  }

  @Test fun requestReportsAWorkerStartFailureInsteadOfPretendingRunning() {
    val jobs = source("RootOwnershipJobs")
    val request = jobs.substringAfter("fun request(").substringBefore("fun runBlocking(")
    // 起点还是同步提交；失败时必须在回 repair-running 之前拦下。
    val start = request.indexOf("val started = start(context)")
    val guard = request.indexOf("launchFailure(result, failedLaunchId, operationId)")
    val started_ = request.indexOf("\"repair-started\"")
    val running_ = request.indexOf("\"repair-running\"")
    assertTrue("必须核对本次启动失败", start >= 0 && guard > start)
    assertTrue("失败必须先于 repair-running 返回", guard < running_ && guard < started_)
    assertTrue("失败回执必须 ok=false", request.substringAfter("if (failed != null)")
      .substringBefore("if (started == null &&").contains("put(\"ok\", false)"))
    assertTrue("失败回执必须带 operationId", request.contains("put(\"operationId\", failed.optString(\"operationId\"))"))
    assertTrue("request 仍不得阻塞等待", !request.contains("await(") && !request.contains("join("))
  }

  @Test fun startupWaitUsesItsOwnLaunchNotAnotherEntry() {
    val jobs = source("RootOwnershipJobs")
    val runBlocking = jobs.substringAfter("fun runBlocking(")
    // 一次启动凭据 (ID, latch) 成对传递：不复用别的入口的 latch，也不把别的入口的结果当本次结果。
    assertTrue("必须使用本次启动自己的闩", runBlocking.contains("launch.latch.await(30, TimeUnit.SECONDS)"))
    assertTrue("结果必须按本次 ID 校验", runBlocking.contains("resultBelongsToRequest(value.optString(\"operationId\"), launch.id)"))
    // 别的入口已在跑时加入它这一次：ID 与闩在同一临界区内成对取，且只认那个 ID。
    assertTrue("加入在跑作业", runBlocking.contains("Launch(operationId, latch)"))
    assertTrue("成对读取必须在同一临界区",
      runBlocking.contains("synchronized(lock) { if (running) Launch(operationId, latch) else null }"))
    assertTrue("跳过时必须如实报无需维护", runBlocking.contains("\"skipped\", \"no-maintenance-required\""))
    assertTrue("跳过分支不得无条件返回旧结果",
      !runBlocking.contains("return synchronized(lock) { result?.let"))
  }

  @Test fun suAcknowledgementRejectsNegativeExitAndIncompleteReads() {
    fun result(vararg pairs: Pair<String, Any>) = org.json.JSONObject().also {
      for ((k, v) in pairs) it.put(k, v)
    }
    assertTrue(RootAccess.suAcknowledgement(result("exitCode" to 0)))
    assertTrue(RootAccess.suAcknowledgement(result("exitCode" to 1)))
    // C2：退出码 -1（exitValue 抛异常/超时）不能冒充已确认。
    assertFalse(RootAccess.suAcknowledgement(result("exitCode" to -1)))
    assertFalse(RootAccess.suAcknowledgement(result()))
    assertFalse(RootAccess.suAcknowledgement(result("exitCode" to 0, "exitTimedOut" to true)))
    assertFalse(RootAccess.suAcknowledgement(result("exitCode" to 0, "drainTimedOut" to true)))
    assertFalse(RootAccess.suAcknowledgement(result("exitCode" to 0, "cleanupIncomplete" to true)))
    assertFalse(RootAccess.suAcknowledgement(result("exitCode" to 0, "readError" to "boom")))
    assertFalse(RootAccess.suAcknowledgement(result("exitCode" to 0, "truncated" to true)))
  }

  @Test fun authorizeDenialSettlesAsNoSideEffectAndIsNotUnknown() {
    val root = source("RootAccess")
    // 拒绝必须紧贴 start：先复核 authorize，再起进程。
    val check = root.indexOf("if (!safeAuthorize(authorize))")
    val start = root.indexOf("ProcessBuilder(su, \"-c\", command).redirectErrorStream(true).start()")
    assertTrue("authorize 复核必须在 start 之前", check >= 0 && start > check)
    assertTrue("拒绝路径必须返回 authorize-denied", root.contains("fail(\"authorize-denied\""))
    // 拒绝属于「确定没派发」：结算租约而不是留成 unknown。
    assertTrue("authorize-denied 必须归入派发前拒绝集合", root.contains("\"root-lease-evidence-unavailable\", \"authorize-denied\")"))
    // 回调抛异常一律按不授权处理（fail-closed）。
    assertTrue(RootAccess.safeAuthorize { true })
    assertFalse(RootAccess.safeAuthorize { false })
    assertFalse(RootAccess.safeAuthorize { throw IllegalStateException("boom") })
  }

  @Test fun preselectedJobIdIsAdoptedByTheLeaseAndScopedToTheThread() {
    val jobId = "0123456789abcdef0123456789abcdef"
    // 线程外：没有预置 ID（不得泄漏到别的线程/调用）。
    assertNull("预置 ID 不得泄漏到线程之外", RootMaintenanceLease.currentJobId())
    var inside: String? = null
    RootMaintenanceLease.withOperationId(jobId) { inside = RootMaintenanceLease.currentJobId() }
    assertEquals("维护线程内必须看得到本次 ID", jobId, inside)
    assertNull("退出后必须清掉", RootMaintenanceLease.currentJobId())
  }

  @Test fun bridgeResultReadbackRejectsForeignOrMalformedIds() {
    val bridge = source("AndroidBridge")
    val body = bridge.substringAfter("fun rootOwnershipResult(operationId: String?)").substringBefore("\n  @JavascriptInterface")
    assertTrue("必须校验 ID 形态", body.contains("RootMaintenanceLease.isCanonicalOperationId(expected)"))
    assertTrue("ID 不符必须明确拒绝，不得回既有结果", body.contains("\"operation-id-mismatch\""))
    assertTrue("运行中只回 running", body.contains("\"repair-running\""))
    assertTrue("无结果必须如实报 unknown", body.contains("\"repair-result-unknown\""))
    assertTrue("回执必须带本次 ID", body.contains("put(\"operationId\", expected)"))
    // 结算读面同样必须先过帧信任校验。
    assertTrue("必须做顶层帧校验", body.contains("checkTrustedFrame()"))
  }

  @Test fun startupPathIsTheNativeRuntimeEntryAndSkipsWhenHealthy() {
    val transport = source("ShizukuTransport")
    val startup = transport.substringAfter("fun prepareStartupOwnership(").substringBefore("\n  internal fun autoHealOwnershipDirect")
    assertTrue("启动入口必须走单飞且可复用近况",
      startup.contains("RootOwnershipJobs.runBlocking(context, reuseRecent = true)"))
    val jobs = source("RootOwnershipJobs")
    val runBlocking = jobs.substringAfter("fun runBlocking(").substringBefore("val wait =")
    assertTrue("runBlocking 必须以启动语义进入（跳过健康启动扫描）", runBlocking.contains("startup = true"))
    assertTrue("跳过时必须如实返回 skipped", runBlocking.contains("\"skipped\", \"no-maintenance-required\""))
    // 启动跳过的判定必须发生在置 running 之前：否则会真的起一次空转维护。
    val start = jobs.substringAfter("private fun start(").substringBefore("val worker = Thread(")
    assertTrue("跳过判定必须先于 running = true",
      start.indexOf("startupScanRequired") in 0 until start.indexOf("running = true"))
  }
}
