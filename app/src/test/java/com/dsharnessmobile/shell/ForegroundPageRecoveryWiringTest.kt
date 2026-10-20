package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Source call-site coverage supplements pure policy tests where Android callbacks need instrumentation. */
class ForegroundPageRecoveryWiringTest {
  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).first { it.isFile }.readText().lineSequence().filterNot {
    val line = it.trimStart()
    line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")
  }.joinToString("\n")

  private fun between(source: String, start: String, end: String): String {
    require(source.contains(start)) { "missing start: " + start }
    val remaining = source.substringAfter(start)
    require(remaining.contains(end)) { "missing end: " + end }
    return remaining.substringBefore(end)
  }

  private fun ordered(source: String, before: String, after: String): Boolean {
    val first = source.indexOf(before)
    val second = source.indexOf(after)
    return first >= 0 && second > first
  }

  @Test fun pauseStopsOnlyActivityPageWatchdogs() {
    val activity = source("MainActivity.kt")
    val pause = between(activity, "override fun onPause()", "override fun onStart()")
    assertTrue(pause.contains("pageRecovery.pause()"))
    assertTrue(pause.contains("engineFlow.stopMonitoring()"))
    assertFalse(pause.contains("stopService("))
    assertFalse(pause.contains("stopEngine("))
    assertFalse(pause.contains("setUserShutdown"))
    val resume = between(activity, "override fun onResume()", "internal fun provisionPublicRepoAndRefreshChip")
    assertTrue(resume.contains("pageRecovery.resume()"))
    assertTrue(resume.contains("recoverPageIfPending()"))
    assertTrue(resume.contains("engineFlow.startEngineService()"))
  }

  @Test fun bothPageMonitorsRejectPausedAndStaleResultsWithoutToasts() {
    val flow = source("EngineStartFlow.kt")
    val monitors = flow.substringBefore("fun startUpdateCheck()")
    assertTrue(monitors.contains("generation != monitorGeneration || !activity.pageUiActive"))
    assertTrue(monitors.contains("if (!activity.pageUiActive || !activity.webViewReady"))
    assertTrue(monitors.contains("freezeHandler.removeCallbacks(freezeRunnable)"))
    assertTrue(monitors.contains("bootStallHandler.removeCallbacks(bootStallRunnable)"))
    assertTrue(monitors.contains("jsAckAt = now"))
    assertFalse(monitors.contains("Toast.makeText"))
    assertFalse(monitors.contains("activity.webView.reload()"))
  }

  @Test fun rendererGoneDestroysAndDefersInsteadOfReloadingDeadWebView() {
    val gone = between(source("MainActivity.kt"), "override fun onRenderProcessGone(", "override fun onPageStarted(")
    assertTrue(gone.contains("pageRecovery.rendererLost()"))
    assertTrue(gone.contains("engineFlow.stopMonitoring()"))
    assertTrue(gone.contains("removeView(view)"))
    assertTrue(gone.contains("view.destroy()"))
    assertTrue(gone.contains("recoverPageIfPending()"))
    assertFalse(gone.contains("showGuide()"))
    assertFalse(gone.contains("reload()"))
  }

  @Test fun invalidBundledShaCannotEnterRefreshOrSpawnAndMigrationFilterPrecedesJournal() {
    val manager = source("EngineManager.kt")
    val refresh = between(manager, "fun refreshSnapshot(", "private fun refreshSnapshotInternal(")
    assertTrue(ordered(refresh, "snapshotFingerprintProblem()", "refreshSnapshotInternal(onProgress"))
    val spawn = between(manager, "fun startEngine(", "private fun ")
    assertTrue(spawn.contains("snapshotFingerprintProblem()"))
    assertTrue(ordered(spawn, "SnapshotUserData.retireReseededFactorySettings(", "val args = arrayOf("))
    val internalRefresh = between(manager, "private fun refreshSnapshotInternal(", "fun recoverInterruptedRefresh()")
    assertTrue(ordered(internalRefresh, "SnapshotUserData.prepareStagedSnapshot(", "SnapshotTransaction.writeMarker("))
    val flow = source("EngineStartFlow.kt")
    assertTrue(ordered(flow, "snapshotFingerprintProblem()", "if (engineAlreadyRunning)"))
  }

  @Test fun activityRecreationRebindsEveryMainPageOwnerWithoutRestartingTheEngine() {
    val activity = source("MainActivity.kt")
    val recovery = between(activity, "private fun recoverPageIfPending()", "override fun onCreate(")
    assertTrue(recovery.contains("pageRecovery.takeRecovery()"))
    assertTrue(recovery.contains("recreate()"))
    assertFalse(recovery.contains("stopEngine("))
    assertFalse(recovery.contains("startEngine("))
    val creation = between(activity, "override fun onCreate(", "private var pendingNotifySession")
    assertTrue(ordered(creation, "webView = WebView(this)", "webViewRef = webView"))
    assertTrue(creation.contains("browserHost = BrowserHost(this, root, webView)"))
    assertTrue(creation.contains("vdisplayHost = VdisplayHost(root, webView)"))
    assertTrue(creation.contains("BrowserHostHolder.host = browserHost"))
    assertTrue(creation.contains("savedInstanceState?.getBoolean"))
    assertTrue(creation.contains("pageRecovery.restoreRecreationBudget("))
    assertTrue(recovery.contains("ForegroundPageRecoveryPolicy.Recovery.NATIVE_ERROR"))
    // 自动启动现在还有一道用户偏好门（启动页管理里的「打开应用后自动启动」）；
    // 判据只加不减：既要求 userClosedEngine 短路，也要求读偏好，还要求偏好开时才拉起。
    assertTrue(creation.contains("if (!userClosedEngine) {"))
    assertTrue(creation.contains("if (SplashStore.autoStart(this)) {"))
    assertTrue(creation.contains("startEngineFlow()"))
    val destruction = between(activity, "override fun onDestroy()", "override fun onConfigurationChanged(")
    assertTrue(ordered(destruction, "engineFlow.destroy()", "pageRecovery.pause()"))
    assertTrue(destruction.contains("webViewRef === webView"))
    assertTrue(destruction.contains("BrowserHostHolder.host === browserHost"))
    assertTrue(destruction.contains("vdisplayHost.destroy()"))
    assertTrue(destruction.contains("browserHost.destroy()"))
    assertFalse(destruction.contains("stopEngine("))
  }

  @Test fun pageRetryAndDeferredChromeCannotBypassForegroundOrRendererGuards() {
    val activity = source("MainActivity.kt")
    val presentation = between(activity, "internal fun showWeb()", "internal fun reloadEnginePage()")
    assertTrue(ordered(presentation, "if (!pageUiActive)", "pageRecovery.claimLoadErrorRetry()"))
    assertTrue(ordered(presentation, "pageRecovery.claimLoadErrorRetry()", "guideRenderer.showWeb()"))
    val callbacks = between(activity, "private fun pushSystemDark(", "private fun deliverRecoveryNotice()")
    assertTrue(callbacks.contains("if (!pageUiActive || view !== webView) return"))
    assertTrue(callbacks.contains("pageRecovery.accepts(generation)"))
    val flow = source("EngineStartFlow.kt")
    assertTrue(flow.substringBefore("fun startMonitor()").contains("activity.retryFailedEnginePage()"))
    val gone = between(activity, "override fun onRenderProcessGone(", "override fun onPageStarted(")
    assertTrue(ordered(gone, "if (pageRecovery.rendererGone) return true", "pageRecovery.rendererLost()"))
    assertTrue(gone.contains("if (webViewRef === view) webViewRef = null"))
    assertFalse(gone.contains("Toast.makeText"))
  }

  @Test fun configurationBridgeReadsAndWritesTheActualActiveDocument() {
    val activity = source("MainActivity.kt")
    assertTrue(activity.contains("onExportConfig = { engineManager.exportConfig() }"))
    assertTrue(activity.contains("onImportConfig = { engineManager.importConfig() }"))
    assertFalse(activity.contains("ConfigTransfer("))
    val manager = source("EngineManager.kt")
    val document = between(manager, "fun settingsDocumentPath()", "private fun workspaceRootDir()")
    assertTrue(document.contains("SnapshotUserData.configurationDocument("))
    assertTrue(document.contains("SnapshotUserData.exportConfiguration("))
    assertTrue(document.contains("SnapshotUserData.importConfiguration("))
    assertFalse(document.contains("File(File(homeDir, \".dsh\"), \"settings.yaml\")"))
  }

  @Test fun activityGenerationAndPendingPreludeRejectObsoleteEffects() {
    val flow = source("EngineStartFlow.kt")
    val startup = between(flow, "fun start()", "private fun canRunEngineWork()")
    assertTrue(ordered(startup, "canRunEngineWork()", "flowOwnership.begin()"))
    assertTrue(ordered(startup, "startupOwnershipPending(", "startupRecoverThenProbe("))
    assertTrue(startup.contains("flowOwnership.finish(token)"))
    assertFalse(startup.contains("flowRunning.set(false)"))
    val pending = between(startup, "if (startupOwnershipPending(", "if (!ownership.optBoolean")
    assertTrue(pending.contains("ownershipRetry.nextDelayMs()"))
    assertFalse(pending.contains("throw"))
    assertFalse(pending.contains("recoverInterruptedRefresh()"))
    assertFalse(pending.contains("snapshotFresh()"))
    assertFalse(pending.contains("startEngine()"))
    assertFalse(pending.contains("showTestNotification"))
    val guard = between(flow, "private fun canRunEngineWork()", "fun runUpdate()")
    assertTrue(guard.contains("!activity.isDestroyed"))
    assertTrue(guard.contains("!activity.isFinishing"))
    assertTrue(guard.contains("!EngineService.userShutdown"))
    assertTrue(guard.contains("flowOwnership.isCurrent(generation)"))
    assertTrue(guard.contains("flowOwnership.invalidate(destroy = true)"))
  }

  @Test fun serviceRechecksRecoveryAndOwnsEveryWakeOperationByEpoch() {
    val service = source("EngineService.kt")
    val startup = between(service, "private fun ensureEngine(epoch:", "private fun buildNotification()")
    assertTrue(ordered(startup, "startupOwnershipPending(", "engineManager.engineReady"))
    assertTrue(ordered(startup, "recoverInterruptedRefresh()", "WatchdogV2.acquireWakeLock(this, epoch.wakeOwner)"))
    val recoveryReturn = between(startup, "engineManager.recoverInterruptedRefresh()", "WatchdogV2.acquireWakeLock(")
    assertTrue(recoveryReturn.contains("if (!isEpochCurrent(epoch)) return"))
    assertTrue(startup.contains("epoch.watchdog.compareAndSet(null, exec)"))
    assertTrue(startup.contains("epoch.watchdog.get() !== exec"))
    assertTrue(startup.contains("WatchdogV2.refreshWakeLock(this, epoch.wakeOwner)"))
    val pending = between(startup, "if (startupOwnershipPending(", "if (!ownership.optBoolean")
    assertTrue(pending.contains("epoch.ownershipRetry.nextDelayMs()"))
    assertFalse(pending.contains("recoverInterruptedRefresh"))
    val teardown = between(service, "private fun retireEpoch(", "private fun ensureEngine(")
    assertTrue(teardown.contains("serviceEpoch.compareAndSet(epoch, null)"))
    assertTrue(teardown.contains("epoch.watchdog.getAndSet(null)"))
    assertTrue(teardown.contains("WatchdogV2.releaseWakeLock(epoch.wakeOwner)"))
    assertFalse(teardown.contains("join("))
    val watchdog = source("WatchdogV2.kt")
    assertTrue(watchdog.contains("candidate.acquire("))
    assertTrue(watchdog.contains("state.compareAndSet(before, State(resource = candidate))"))
    assertTrue(watchdog.contains("release(candidate)"))
    assertFalse(watchdog.contains("private var wakeLock:"))
    assertFalse(watchdog.contains("fun releaseWakeLock()"))
  }

  @Test fun rendererRecreationNeverClearsSavedOrPersistedUserShutdown() {
    val activity = source("MainActivity.kt")
    val creation = between(activity, "override fun onCreate(", "private var pendingNotifySession")
    assertTrue(creation.contains("getBoolean(\"dsh.engine-user-closed\""))
    assertTrue(creation.contains("EngineService.isUserShutdownPersisted(this)"))
    val startup = between(activity, "internal fun startEngineFlow(", "internal fun applyGuidePhase(")
    assertTrue(ordered(startup, "if (userClosedEngine)", "if (pageRecovery.rendererGone)"))
    assertTrue(startup.contains("if (EngineService.userShutdown) return"))
    val rendererBranch = startup.substringAfter("if (pageRecovery.rendererGone)")
    assertFalse(rendererBranch.contains("setUserShutdown(this, false)"))
    assertFalse(rendererBranch.contains("userClosedEngine = false"))
  }

  @Test fun rootPrebootRepairStillPrecedesAnySnapshotRecovery() {
    val startup = between(source("EngineStartFlow.kt"), "fun start()", "private fun isCurrentEngineFlow(")
    assertTrue(ordered(startup, "ShizukuTransport.prepareStartupOwnership(", "startupRecoverThenProbe("))
    assertTrue(ordered(startup, "startupRecoverThenProbe(", "if (engineAlreadyRunning)"))
    assertFalse(source("MainActivity.kt").contains("autoHealOwnership("))
  }
}
