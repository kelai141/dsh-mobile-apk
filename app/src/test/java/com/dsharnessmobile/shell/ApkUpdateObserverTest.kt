package com.dsharnessmobile.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 启动页更新块「永不刷新」缺陷的反证用例（PR #399 引入）。
 *
 * 缺陷真因：控制器原本只有一个 `observer` 槽位，`GuidePageRenderer` 先注册了渲染，
 * `GuideManagementController` 后注册直接把槽位夺走——启动页那张更新卡片从此收不到任何通知。
 * 用户在启动页看到的形态是「点第一次没反馈，点第二次才静默开始下载 169MB」。
 *
 * 判据因此不是「有没有通知」，而是「**两个消费方同时在线时，两个都收到**」。
 * 单槽位实现会让下面第一条用例变红，恢复单槽位同样会变红。
 */
class ApkUpdateObserverTest {

  private fun registry(vararg renders: () -> Unit): ObserverRegistry {
    val r = ObserverRegistry()
    renders.forEach { r.add(it) }
    return r
  }

  @Test
  fun bothRegisteredObserversAreNotified() {
    // 本缺陷的核心反证：多播下不存在的「后注册者夺槽」。
    var rendererHits = 0
    var managementHits = 0
    val r = registry({ rendererHits++ }, { managementHits++ })

    r.dispatch()
    r.dispatch()

    assertEquals("启动页渲染必须收到每一次通知", 2, rendererHits)
    assertEquals("管理中心渲染必须收到每一次通知", 2, managementHits)
    assertEquals("两个消费方并存，不得互相顶替", 2, r.size())
  }

  @Test
  fun clearStopsAllNotifications() {
    var hits = 0
    val r = registry({ hits++ })
    r.dispatch()
    assertEquals(1, hits)

    r.clear()
    r.dispatch()

    assertEquals("释放后不得再回调任何观察者", 1, hits)
    assertEquals(0, r.size())
  }

  @Test
  fun cancelHandleOnlyRemovesItsOwnObserver() {
    var first = 0
    var second = 0
    val firstRender: () -> Unit = { first++ }
    val secondRender: () -> Unit = { second++ }
    val r = registry(firstRender, secondRender)

    r.dispatch()
    assertEquals(1, first)
    assertEquals(1, second)

    r.remove(firstRender)
    r.dispatch()

    assertEquals("被取消的一方不再收到通知", 1, first)
    assertEquals("取消一个观察者不得连带取消另一个", 2, second)
    assertEquals(1, r.size())
  }

  @Test
  fun cancellingTwiceIsHarmless() {
    // 视图重建会让同一个句柄被调用多次：重复注销不得把别人的登记削掉。
    var first = 0
    var second = 0
    val firstRender: () -> Unit = { first++ }
    val secondRender: () -> Unit = { second++ }
    val r = registry(firstRender, secondRender)
    val cancel = { r.remove(firstRender) }

    cancel()
    cancel()
    r.dispatch()

    assertEquals(0, first)
    assertEquals("重复注销不得误删另一个观察者", 1, second)
    assertEquals(1, r.size())
  }

  // ── 只有带有效摘要的结果才能进入可下载状态 ─────────────────────────────────────

  private fun availableWith(sha256: String, name: String = "dsh-mobile-apk-v99.0.0-arm64.apk"): String {
    val s = ApkUpdateState()
    s.beginCheck()
    s.onCheckResult(UpdateChecker.CheckResult.Available("v99.0.0", name, "https://example.test/a.apk", sha256, 169_000_000L), "0.14.5-fx-2")
    return s.snapshotJson()
  }

  @Test
  fun snapshotCarriesDigestWhenReleaseProvidesOne() {
    val j = JSONObject(availableWith("a".repeat(64)))
    assertTrue("发布方给了摘要就必须如实透出", j.has("sha256"))
    assertEquals("a".repeat(64), j.getString("sha256"))
  }

  @Test
  fun releasesWithoutAnyDigestNeverBecomeAvailable() {
    // #728 之后「未提供摘要」不再是 Available(sha256=null) 这种形态，而是根本没有可安装更新。
    // 这条用例守住分流点：摘要缺失必须落 Failed(RELEASE_DATA_BROKEN)，不能退化成"已发现新版"。
    val facts = UpdateChecker.LatestFacts(
      "v99.0.0",
      mapOf("dsh-mobile-apk-v99.0.0-arm64.apk" to 169_000_000L),
      emptyMap(),
    )
    val r = UpdateChecker.classifyFacts(facts, listOf("arm64-v8a"), "arm64", "0.14.5-fx-2")
    assertTrue("缺摘要必须判失败，不得给可安装更新：" + r, r is UpdateChecker.CheckResult.Failed)
    assertEquals(
      "分类必须是发布数据异常（不是设备不支持）",
      UpdateChecker.CheckResult.FailureKind.RELEASE_DATA_BROKEN,
      (r as UpdateChecker.CheckResult.Failed).kind,
    )
  }

  @Test
  fun failedStateDropsDigest() {
    // 下载失败时产物已被删除：此时还留着摘要，界面就会对着一个不存在的文件说「已校验」。
    val s = ApkUpdateState()
    s.beginCheck()
    s.onCheckResult(
      UpdateChecker.CheckResult.Available("v99.0.0", "a.apk", "https://example.test/a.apk", "c".repeat(64), 10L),
      "0.14.5-fx-2",
    )
    s.beginDownload()
    assertTrue(JSONObject(s.snapshotJson()).has("sha256"))

    s.onDownloadFailed("下载失败：sha256 校验不匹配（文件已删除，请重试）", ApkUpdateState.KIND_ARTIFACT_REJECTED)

    assertEquals(ApkUpdateState.STATE_FAILED, s.stateName())
    assertFalse("失败态不得再挂着一份没有对应文件的摘要", JSONObject(s.snapshotJson()).has("sha256"))
  }

  @Test
  fun newCheckRoundDoesNotLeakPreviousDigest() {
    val s = ApkUpdateState()
    s.beginCheck()
    s.onCheckResult(
      UpdateChecker.CheckResult.Available("v99.0.0", "a.apk", "https://example.test/a.apk", "b".repeat(64), 10L),
      "0.14.5-fx-2",
    )
    assertTrue(JSONObject(s.snapshotJson()).has("sha256"))

    // 第二轮发布摘要不同：上一轮的值绝不能贴到这一轮上（否则界面会把旧值当本次结果）。
    s.beginCheck()
    s.onCheckResult(
      UpdateChecker.CheckResult.Available("v99.0.1", "a.apk", "https://example.test/a.apk", "c".repeat(64), 10L),
      "0.14.5-fx-2",
    )
    assertEquals("新一轮必须携带自己的摘要", "c".repeat(64), JSONObject(s.snapshotJson()).getString("sha256"))
  }

  // ── 待装包事实：页面渲染失败态「重试安装」的唯一依据 ────────────────────────────

  @Test
  fun readyArtifactFactIsPresentInEveryPhase() {
    // 页面按「缺席即没有」兼容，但缺席就是逼它靠 kind/state 猜——那是假判据。
    // 因此每个相位的快照都必须带上这个布尔，值为假也要在。
    val s = ApkUpdateState()
    fun facts(state: ApkUpdateState): String = JSONObject(state.snapshotJson()).getString("state")
    assertTrue("idle 相位也要有该字段", JSONObject(s.snapshotJson(hasReadyArtifact = false)).has("hasReadyArtifact"))

    s.beginCheck()
    assertTrue("checking 相位也要有", JSONObject(s.snapshotJson()).has("hasReadyArtifact"))
    s.onCheckResult(UpdateChecker.CheckResult.Available("v99.0.0", "a.apk", "https://example.test/a.apk", "a".repeat(64), 10L), "0.14.5-fx-2")
    assertTrue("available 相位也要有", JSONObject(s.snapshotJson()).has("hasReadyArtifact"))
    assertEquals(ApkUpdateState.STATE_AVAILABLE, facts(s))
  }

  @Test
  fun readyArtifactFactFollowsTheControllerSuppliedValue() {
    // 判据由控制器传（readyToInstall 的生命周期在控制器一侧），state 只负责如实写。
    val s = ApkUpdateState()
    assertFalse("没有传 ≡ 没有待装包", JSONObject(s.snapshotJson()).getBoolean("hasReadyArtifact"))
    assertTrue("传了就必须如实写 true", JSONObject(s.snapshotJson(hasReadyArtifact = true)).getBoolean("hasReadyArtifact"))
    assertFalse("传 false 就必须写 false（不能因为相位而改成 true）", JSONObject(s.snapshotJson(hasReadyArtifact = false)).getBoolean("hasReadyArtifact"))
  }

  @Test
  fun failedStateWithArtifactReportsItSoRetryInstallCanShow() {
    // 安装器拉起失败会留下 readyToInstall（可重试安装），此时 state 是 failed。
    // 页面只有拿到 hasReadyArtifact=true 才敢摆「重试安装」；这条是本轮新增 UI 的唯一依据。
    val s = ApkUpdateState()
    s.beginCheck()
    s.onCheckResult(UpdateChecker.CheckResult.Available("v99.0.0", "a.apk", "https://example.test/a.apk", "a".repeat(64), 10L), "0.14.5-fx-2")
    s.beginDownload()
    s.onFailed("安装器拉起失败，请再点「下载并安装」重试", ApkUpdateState.KIND_INSTALLER_UNAVAILABLE)
    assertEquals(ApkUpdateState.STATE_FAILED, s.stateName())

    assertTrue("失败但手上还有验证过的包：字段必须为 true", JSONObject(s.snapshotJson(hasReadyArtifact = true)).getBoolean("hasReadyArtifact"))
    assertFalse("失败且没有包：字段必须为 false", JSONObject(s.snapshotJson(hasReadyArtifact = false)).getBoolean("hasReadyArtifact"))
  }

  // ── 按钮拆分：检查与下载各受各的约束，不再由同一枚按钮猜状态 ────────────────────

  private fun codeOnly(src: String): String =
    src.replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
      .lineSequence().joinToString("\n") { it.substringBefore("//") }

  private fun shellSource(name: String): String {
    for (root in listOf(File("src/main/java/com/dsharnessmobile/shell"), File("../app/src/main/java/com/dsharnessmobile/shell"))) {
      val x = File(root, name)
      if (x.isFile) return x.readText()
    }
    throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
  }

  @Test
  fun checkButtonOnlyChecksAndDownloadButtonOnlyDownloads() {
    val code = codeOnly(shellSource("ApkUpdateAction.kt"))
    assertFalse("三态按钮必须已删除（调用点改由两个按钮各自硬绑定动作）", code.contains("fun onButtonPressed"))

    val checkBody = code.substringAfter("fun onCheckPressed()").substringBefore("fun onDownloadPressed(): String {")
    assertTrue("忙时不受理", checkBody.contains("state.busy()"))
    assertTrue("检查按钮只发检查", checkBody.contains("check()"))
    assertFalse("检查按钮不得顺带发起下载", checkBody.contains("start()"))

    val downloadBody = code.substringAfter("fun onDownloadPressed(): String {").substringBefore("private fun runCheck(")
    assertTrue("续继链必须在下载按钮这一侧", downloadBody.contains("continueInstallIfPermitted()"))
    assertTrue("available 才允许开始下载", downloadBody.contains("STATE_AVAILABLE"))
    assertFalse("下载按钮不得改发检查", downloadBody.contains("check()"))
  }

  @Test
  fun bridgeReusesTheSameEntriesAsTheNativeButtons() {
    // 桥面与原生按钮必须共用同一对受理入口：两条面各维护一套受理条件，迟早给出不同答案
    // （页面显示「可点」而壳侧不受理）。回执码由这两个入口给出，页面照样读得到原因。
    val code = codeOnly(shellSource("ApkUpdateAction.kt"))
    val bridge = code.substringAfter("fun handleBridgeAction(action: String): String =").substringBefore("fun stateName()")
    assertTrue("check 动作走检查入口", bridge.contains("onCheckPressed()"))
    assertTrue("install 动作走下载入口", bridge.contains("onDownloadPressed()"))
    assertTrue("只读 status 仍直接读快照", bridge.contains("statusJson()"))

    assertTrue("动作闭集不变", code.contains("const val ACTION_STATUS = \"status\""))
    assertTrue(code.contains("const val ACTION_CHECK = \"check\""))
    assertTrue(code.contains("const val ACTION_INSTALL = \"install\""))

    // 回执不得退化成「一律 OK」：下载入口必须给得出拒绝原因。
    val downloadBody = code.substringAfter("fun onDownloadPressed(): String {").substringBefore("private fun runCheck(")
    assertTrue("忙时必须回 busy", downloadBody.contains("reject(\"busy\""))
    assertTrue("无可下载相位必须如实拒绝", downloadBody.contains("not-available"))
  }

  @Test
  fun everyBridgeReceiptCarriesTheReadyArtifactFact() {
    // 桥面的三处回执（status / accepted / reject）都必须走同一个出口带上这个事实：
    // 少了任一处，页面在那条回执上就退回「靠旁证猜」。
    val code = codeOnly(shellSource("ApkUpdateAction.kt"))
    val exit = code.substringAfter("private fun snapshotObject(ok: Boolean = true): JSONObject =").substringBefore("fun statusJson()")
    assertTrue("出口必须把控制器的只读事实传进 state", exit.contains("hasReadyArtifact()"))
    assertTrue("status 走统一出口", code.contains("fun statusJson(): String = snapshotObject().toString()"))

    val rejectBody = code.substringAfter("private fun reject(code: String, reason: String): String =").substringBefore("// ── 引导页动作")
    assertTrue("拒绝回执也走统一出口", rejectBody.contains("snapshotObject(false)"))

    val receiptCount = Regex("snapshotObject\\(\\)\\.put\\(\"code\", \"accepted\"\\)").findAll(code).count()
    assertTrue("受理回执（check / start / 续继）都走统一出口，实际 " + receiptCount + " 处", receiptCount >= 3)
  }

  @Test
  fun installResumesPermissionChainBeforeAskingForPayload() {
    // 页面在 need-permission 态发的仍是 install，而那时 currentResult 已被 install() 清掉、
    // 可续继的载荷是 readyToInstall。start() 若只看 currentResult，设置页那枚「授权后继续安装」
    // 就永远得到 no-pending——按钮可点却永不受理。
    val code = codeOnly(shellSource("ApkUpdateAction.kt"))
    val startBody = code.substringAfter("fun start(): String {").substringBefore("val pending = currentResult")
    assertTrue("受理前必须先看续继链", startBody.contains("readyToInstall != null"))
    assertTrue("等授权相位也算续继链", startBody.contains("state.awaitingPermission()"))
    assertTrue("续继链走的就是下载入口那份分档", startBody.contains("onDownloadPressed()"))

    val needPerm = code.substringAfter("if (!UpdateChecker.canInstall(activity))").substringBefore("if (UpdateChecker.invokeInstaller")
    assertTrue("接受授权时载荷被清掉（所以 start 不能只看它）", needPerm.contains("currentResult = null"))
  }

  @Test
  fun observeReturnsCancelHandleAndReleaseClearsRegistry() {
    // 契约要求 observe 返回取消句柄、release 清空全部：撤掉任一条，下面的断言就变红。
    val code = codeOnly(shellSource("ApkUpdateAction.kt"))
    assertTrue("observe 必须返回取消句柄", code.contains("fun observe(render: () -> Unit): () -> Unit"))
    assertTrue("注册即先渲染一次（既有语义）", code.contains("observers.add(render)"))

    val releaseBody = code.substringAfter("fun release() {").substringBefore("private fun settle()")
    assertTrue("释放必须清空全部观察者", releaseBody.contains("observers.clear()"))
  }

  @Test
  fun downloadUsesDigestFromMetadataInsteadOfDownloadingIt() {
    // 摘要在元数据里（MANIFEST / releases.json 的 sha256 列）。旧代码把 sha256Url 当资产去下载，
    // 而发布链从未产出该附件——那一步恒定失败，校验链因此长期形同虚设。
    val code = codeOnly(shellSource("ApkUpdateAction.kt"))
    val body = code.substringAfter("private fun downloadAndInstall(").substringBefore("private fun onDownloadProgress(")
    assertTrue("摘要必须直接取自元数据", body.contains("val expectedSha = r.sha256"))
    assertFalse("不得再把摘要当资产下载", body.contains("downloadText"))
    assertTrue("体积与摘要校验仍走同一份判定", body.contains("verifyApkArtifact("))
  }
}
