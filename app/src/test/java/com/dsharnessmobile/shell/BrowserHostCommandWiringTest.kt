package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Source-only JVM contracts for trusted UI command/cleanup wiring that needs Android WebView.
 * Scoped member slices and ordering assertions catch removed guards, not comment-only mentions.
 * These are not runtime proof of cookies, renderer behavior or stale callback interleavings.
 */
class BrowserHostCommandWiringTest {
  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).firstOrNull { it.isFile }?.readText()?.lineSequence()?.filterNot {
    val line = it.trimStart()
    line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")
  }?.joinToString("\n") ?: throw AssertionError("找不到壳侧源码 $name")

  private fun body(name: String, signature: String): String {
    val text = source(name)
    val start = text.indexOf(signature)
    if (start < 0) throw AssertionError("找不到成员 $name: $signature")
    val next = Regex("(?m)^  (?:(?:private|internal|override) )?fun ")
      .find(text, start + signature.length)?.range?.first ?: text.length
    return text.substring(start, next)
  }

  private fun assertBefore(text: String, first: String, second: String) {
    val a = text.indexOf(first)
    val b = text.indexOf(second)
    assertTrue("$first 必须在 $second 之前且都在执行代码中", a >= 0 && b > a)
  }

  @Test
  fun trustedBridgeForwardsPayloadToTheActivityOwnedCommandHost() {
    assertTrue(body("AndroidBridge.kt", "fun browserHostCommand(")
      .contains("= trusted { onBrowserHostCommand(payload) }"))
    assertTrue(source("MainActivity.kt").contains("onBrowserHostCommand = { payload -> browserHost.command(payload) }"))
    assertTrue(source("MainActivity.kt").contains("onBrowserHostBounds = { bounds -> browserHost.setStageBounds(bounds) }"))
    assertFalse("不可信浏览器 renderer 不能获得原生桥", source("BrowserHost.kt").contains("addJavascriptInterface("))
  }

  @Test
  fun commandsValidateSizeVocabularySessionAndOccurrenceBeforeWorkspaceMutation() {
    val command = body("BrowserHost.kt", "fun command(")
    assertBefore(command, "raw.length > 20_480", "JSONObject(raw)")
    assertBefore(command, "validUiId(session, 2048)", "workspaceFor(session)")
    assertBefore(command, "browser-tab-id-invalid", "workspaceFor(session)")
    assertTrue(command.contains("""setOf("open", "back", "forward", "reload", "select", "close", "status", "tabs")"""))
    assertTrue(command.contains("browser-command-invalid") && command.contains("browser-command-unknown"))
    assertBefore(command, "browser-ui-tab-conflict", "currentWorkspace = workspace")
    assertBefore(command, "browser-ui-tab-mismatch", "currentWorkspace = workspace")
    assertTrue(command.contains("tab.uiTabId != uiId && action != \"select\""))
    assertFalse("UI 命令不是任意 JS 或 shell 派发器", command.contains("evaluateJavascript(") || command.contains("runShell("))
  }

  @Test
  fun statusAndTabPollingDoNotCreateViewsOrClaimTheForegroundStage() {
    val command = body("BrowserHost.kt", "fun command(")
    assertBefore(command, """if (action == "tabs" || action == "status")""", "val previous = currentWorkspace")
    assertBefore(command, "return@onMain nativeReply(workspace, tab).toString()", "ensureSurface(target)")
    assertTrue(command.contains("finally {") && command.contains("currentWorkspace = previous"))
    assertBefore(command, "currentWorkspace = previous", "applyStageBounds()")
    assertBefore(command, "currentWorkspace = previous", "applyVisibility()")
    val reply = body("BrowserHost.kt", "private fun nativeReply(")
    assertTrue(reply.contains("workspace.profile.isAssigned"))
    for (field in listOf("session", "ownerSessionId", "profileAvailable", "profileReason", "tabs", "activeTabId")) {
      assertTrue("UI 回执必须带已捕获工作台的 $field", reply.contains(".put(\"$field\","))
    }
  }

  @Test
  fun openingAndPageRequestsUseTheVerifiedOwningProfileBeforeLoading() {
    val command = body("BrowserHost.kt", "fun command(")
    assertBefore(command, "ensureSurface(target)", "normalizeForWorkspace(workspace, address)")
    assertBefore(command, "normalizeForWorkspace(workspace, address)", "loadInto(target, normalized)")
    val create = body("BrowserHost.kt", "private fun ensureViewFor(")
    assertBefore(create, "sessionProfile.attach(created)", "created.apply {")
    assertBefore(create, "sessionProfile.attach(created)", "settings.apply {")
    assertBefore(create, "sessionProfile.attach(created)", "root.addView(created,")
    assertTrue(create.contains("created.destroy()") && create.contains("return null"))
    assertTrue(create.contains("sessionProfile.normalize(raw)"))
    assertTrue(create.contains("sessionProfile.blockedRequestReason(url)"))
    assertTrue(create.contains("handler.cancel()"))
    val profile = source("BrowserHostProfile.kt")
    assertTrue(profile.contains("if (isAssigned) BrowserHostNavigationPolicy.normalize("))
    assertTrue(profile.contains("if (isAssigned) BrowserHostNavigationPolicy.blockedRequestReason("))
    assertTrue(profile.contains("isolatedProfile = true"))
    assertTrue(profile.contains("else \"browser-profile-not-ready\""))
    val attach = body("BrowserHostProfile.kt", "fun attach(")
    assertBefore(attach, "WebViewCompat.setProfile(browser, name)", "WebViewCompat.getProfile(browser)")
    assertBefore(attach, "it.name != name || it.name == Profile.DEFAULT_PROFILE_NAME", "active = true")
    assertBefore(attach, "workers.setServiceWorkerClient(", "active = true")
    assertBefore(attach, "active = true", "workers.serviceWorkerWebSettings.blockNetworkLoads = false")
  }

  @Test
  fun staleNativeUiDetachOnlyHidesItsCapturedActiveOccurrence() {
    val bounds = body("BrowserHost.kt", "fun setStageBounds(")
    assertBefore(bounds, "workspaces[session]", "if (!visible)")
    assertBefore(bounds, "workspace.tabs[tabId]", "if (!visible)")
    assertBefore(bounds, "tab.uiTabId != uiId", "if (!visible)")
    val start = bounds.indexOf("if (!visible)")
    val end = bounds.indexOf("workspace.activeTabId = tabId", start)
    assertTrue(start >= 0 && end > start)
    val detach = bounds.substring(start, end)
    assertBefore(detach, "if (workspace.activeTabId == tabId)", "workspace.stageVisible = false")
    assertBefore(detach, "if (workspace.activeTabId == tabId)", "workspace.requestedVisible = false")
    assertTrue(detach.contains("return@onMain nativeReply(workspace, tab)"))
    assertFalse("清理 A 的 UI 不应全局隐藏/关闭 B", detach.contains("hide()") || detach.contains("close()") || detach.contains("switchTo("))
    val command = body("BrowserHost.kt", "fun command(")
    assertTrue(command.contains("""closeTabOp(JSONObject().put("tabId", target.id))"""))
    assertTrue(command.contains(""".put("closedTabId", target.id)"""))
  }

  @Test
  fun targetedIdentityAndViewportRestorePreviousWorkspaceAndTab() {
    val target = body("BrowserHost.kt", "private fun withUiTarget(")
    assertBefore(target, "workspaces[session]", "currentWorkspace = workspace")
    assertBefore(target, "workspace.tabs[args.optString", "currentWorkspace = workspace")
    assertBefore(target, "tab.uiTabId != uiId", "currentWorkspace = workspace")
    assertTrue(target.contains("val previousTab = workspace.activeTabId"))
    assertTrue(target.contains("finally {") && target.contains("workspace.activeTabId = previousTab"))
    assertTrue(target.contains("currentWorkspace = previous"))
  }

  @Test
  fun modelControlCapturesSessionTabAndRestoresForegroundBeforeLeavingEveryMainSlice() {
    val control = body("BrowserHost.kt", "fun controlOp(")
    assertBefore(control, "workspaceFor(session)", "ControlTarget(workspace,")
    assertTrue(control.contains("workspace.modelTabId ?: workspace.activeTabId"))
    assertFalse(control.contains("switchTo(") || control.contains("controlJson(show("))
    val scope = body("BrowserHost.kt", "private fun <T> withModelTarget(")
    assertBefore(scope, "val foreground = currentWorkspace", "currentWorkspace = workspace")
    assertTrue(scope.contains("workspace.activeTabId = target.tab?.id"))
    val restore = scope.substring(scope.indexOf("finally {"))
    assertBefore(restore, "workspace.activeTabId = foregroundTab", "currentWorkspace = foreground")
    assertBefore(restore, "currentWorkspace = foreground", "applyStageBounds()")
    assertBefore(restore, "currentWorkspace = foreground", "applyVisibility()")
    assertFalse(scope.contains("awaitNavigation(") || scope.contains("awaitMain(") || scope.contains("synchronized("))
  }

  @Test
  fun atomicOpenValidatesOptionsAndRebuildsOnlyTargetWithoutReplayingOldUrl() {
    val control = body("BrowserHost.kt", "fun controlOp(")
    assertBefore(control, "openConfigProblem(args)", "workspaceFor(session)")
    val open = body("BrowserHost.kt", "private fun navigateOp(")
    assertBefore(open, "openConfigProblem(args)", "controlOnMain(captured)")
    assertBefore(open, "navigationTarget = ControlTarget(workspace, tab)", "tab.requestedViewport = nextViewport")
    assertBefore(open, "tab.requestedViewport = nextViewport", "ensureSurface(tab)")
    assertBefore(open, "tab.identityId = nextIdentity", "ensureSurface(tab)")
    assertBefore(open, "recycleView(reloadPreviousUrl = false)", "loadInto(tab, normalized)")
    assertBefore(open, "ensureSurface(tab)", "normalizeForWorkspace(workspace, raw)")
    assertBefore(open, "normalizeForWorkspace(workspace, raw)", "loadInto(tab, normalized)")
    assertBefore(open, "awaitNavigation(tab,", "return controlOnMain(target) { status() }")
    assertFalse(open.contains("identityApply(") || open.contains("viewportOp(") || open.contains("tabOrNull("))
    val recycle = body("BrowserHost.kt", "private fun recycleView(")
    assertTrue(recycle.contains("reloadPreviousUrl && it != \"about:blank\""))
  }

  @Test
  fun asynchronousSnapshotAndRefDispatchUseOnlyCapturedOwnTabAndRejectReplacedViews() {
    val snapshot = body("BrowserHost.kt", "private fun snapshotOp(")
    assertBefore(snapshot, "val startedGeneration = tab.generation.get()", "evaluateOnTab(tab, SNAPSHOT_JS")
    assertBefore(snapshot, "targetProblem(target, tab.view)", "tab.snapshotGeneration = startedGeneration")
    assertBefore(snapshot, "tab.generation.get() != startedGeneration", "tab.snapshotGeneration = startedGeneration")
    assertTrue(snapshot.contains("synchronized(tab.refs)") && snapshot.contains("pageReply(target)"))
    assertFalse(snapshot.contains("lastRefs") || snapshot.contains("activeTab()"))
    val ref = body("BrowserHost.kt", "private fun resolveRef(")
    assertTrue(ref.contains("tab.snapshotGeneration") && ref.contains("tab.generation.get()") && ref.contains("ref in tab.refs"))
    assertFalse(ref.contains("lastSnapshotGeneration") || ref.contains("lastRefs"))
    val tap = body("BrowserHost.kt", "private fun tapOp(")
    assertBefore(tap, "targetProblem(target, tab.view)", "tapOnTab(tab,")
    val callback = tap.substring(tap.indexOf("evaluateOnTab(tab, RESOLVE_REF_JS"))
    assertBefore(callback, "resolveRef(args, target)", "tapOnTab(tab,")
    assertTrue(tap.contains("main.postDelayed") && tap.contains("pageReply(target)"))
    assertFalse(tap.contains("activeTab()") || tap.contains(".put(\"url\", url)"))
    val problem = body("BrowserHost.kt", "private fun targetProblem(")
    assertTrue(problem.contains("target.workspace.tabs[target.tab.id] !== target.tab"))
    assertTrue(problem.contains("target.tab?.view !== browser"))
  }

  @Test
  fun modelCloseAndVisibilityCannotDestroyOrPaintANeighbourSessionOrTab() {
    val control = body("BrowserHost.kt", "fun controlOp(")
    assertTrue(control.contains("dropWorkspace(target.workspace)"))
    assertFalse(control.contains("disposeView()"))
    val close = body("BrowserHost.kt", "private fun closeTabOp(")
    assertBefore(close, "val workspace = requireWorkspace()", "workspace.profile.dispose()")
    assertTrue(close.contains("workspace.modelTabId == tab.id"))
    assertTrue(close.contains("tab.snapshotGeneration = -1L") && close.contains("tab.refs.clear()"))
    assertFalse(body("BrowserHost.kt", "private fun dropWorkspace(").contains("workspaces.values.lastOrNull()"))
    assertTrue(body("BrowserHost.kt", "private fun applyVisibility(")
      .contains("visible && tab.id == workspace.activeTabId"))
  }

  @Test
  fun profileCleanupNeverObtainsDefaultOrGlobalCookieStorage() {
    val profile = source("BrowserHostProfile.kt")
    assertFalse(profile.contains("CookieManager.getInstance(") || profile.contains("WebStorage.getInstance("))
    val dispose = body("BrowserHostProfile.kt", "fun dispose(")
    assertBefore(dispose, "active = false", "own.serviceWorkerController.serviceWorkerWebSettings.blockNetworkLoads = true")
    assertTrue(dispose.contains("own.name == name && own.name != Profile.DEFAULT_PROFILE_NAME"))
    assertTrue(dispose.contains("setServiceWorkerClient(") && dispose.contains("= blockedResponse()"))
    val clear = body("BrowserHostProfile.kt", "fun clearCookieAndWebStorageData(")
    assertBefore(clear, "check(!active)", "own.webStorage.deleteAllData()")
    assertBefore(clear, "own.name == name && own.name != Profile.DEFAULT_PROFILE_NAME", "own.cookieManager.removeAllCookies")
    assertTrue(clear.contains("own.cookieManager.flush(); completed()"))
    val drop = body("BrowserHost.kt", "private fun dropWorkspace(")
    assertBefore(drop, "browser.destroy()", "workspace.profile.dispose()")
  }
}
