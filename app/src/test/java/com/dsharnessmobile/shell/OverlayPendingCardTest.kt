package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 0.14.1 批 2「点了没反应 / 一次点击做错事」的行为回归（纯 JVM，无 Robolectric）。
 *
 * 覆盖 P0-2 ~ P0-9 里**可离线判定**的那几条。做法沿用本仓既有的两条路子：
 *  1. **纯函数判据**（[pagerIndex] / [optionsShownCount] / [optionsHiddenCount] / [approvalArmed] /
 *     `UpdateManager.UpdateFailures.humanize`）——语义直接可测，改坏即红；
 *  2. **源码级判据**——需要 Activity/View 的交互（按钮 enabled、Toast、flashStatus）在 JVM 里跑不起来，
 *     就断言「调用点与真源表达式在场」（与 `CallSiteContractTest` 同一口径，撤掉修复即红）。
 *
 * 设备层证据另走三层验收的 B 轨（真机/模拟器截图 + 审计日志），不在本文件里。
 */
class OverlayPendingCardTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  /** 只留代码行（注释里会复述旧实现作为背景，直接对全文断言会被自己的说明判红）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  // ── P0-7：多问分页的箭头 ─────────────────────────────────────────────────

  @Test
  fun `上一题必须是 -1 且不回卷`() {
    // 旧实现：(qPage + 1) % n —— 点「上一题」跳下一题，末页回卷到第 1 页。
    assertEquals(2, pagerIndex(3, 5, -1))
    assertEquals(0, pagerIndex(1, 5, -1))
    // 端点不回卷：第 1 页再点「上一题」仍是第 1 页（按钮在端点禁用，这是二重保险）。
    assertEquals(0, pagerIndex(0, 5, -1))
  }

  @Test
  fun `下一题必须是 +1 且末页不回卷`() {
    assertEquals(4, pagerIndex(3, 5, +1))
    assertEquals(4, pagerIndex(4, 5, +1))
  }

  @Test
  fun `翻页判据不得再用取模`() {
    val code = codeOnly(source("OverlayPanel.kt"))
    assertFalse(
      "翻页监听里不得再出现 % n（回卷 = 点上一题跳到下一题，P0-7）",
      code.contains("(qPage + 1) % n"),
    )
    assertTrue("两侧箭头必须各自独立可点（左=上一题）", code.contains("pagerIndex(qPage, n, -1)"))
    assertTrue("两侧箭头必须各自独立可点（右=下一题）", code.contains("pagerIndex(qPage, n, +1)"))
  }

  // ── P0-8：候选被静默丢弃 ────────────────────────────────────────────────

  @Test
  fun `折叠只决定先列几项，绝不丢项`() {
    assertEquals(6, optionsShownCount(9, false))
    assertEquals(9, optionsShownCount(9, true))
    assertEquals(3, optionsHiddenCount(9, false))
    assertEquals(0, optionsHiddenCount(9, true))
    // 6 项以内没有隐藏项（不出现无意义的「还有 0 项」入口）。
    assertEquals(0, optionsHiddenCount(6, false))
    assertEquals(0, optionsHiddenCount(0, false))
  }

  @Test
  fun `折叠态必须给出可点的展开入口`() {
    val code = codeOnly(source("OverlayPanel.kt"))
    assertFalse("不得再用 coerceAtMost(6) 静默丢项", code.contains("coerceAtMost(6)"))
    assertTrue("必须明示还剩多少项", code.contains("还有 \$optsHidden 项"))
    assertTrue("展开入口必须真的可点（写进 qOptsExpanded 并重绘）", code.contains("qOptsExpanded.add(qid)"))
  }

  // ── P0-9：审批单击即放行 ────────────────────────────────────────────────

  @Test
  fun `首点只进入待确认，二点才放行`() {
    // 未臂：任何卡都算未确认。
    assertFalse(approvalArmed(null, 0L, "ev-1", 1_000L))
    // 已臂且同卡且在窗口内：确认。
    assertTrue(approvalArmed("ev-1", 1_000L, "ev-1", 1_500L))
    // 换卡（另一张审批）：撤臂——陈旧状态绝不能吞掉后来的一次单击。
    assertFalse(approvalArmed("ev-1", 1_000L, "ev-2", 1_500L))
    // 超出确认窗口：视为未确认。
    assertFalse(approvalArmed("ev-1", 1_000L, "ev-1", 1_000L + APPROVAL_ARM_MS))
    assertFalse(approvalArmed("ev-1", 1_000L, "ev-1", 1_000L + APPROVAL_ARM_MS + 1))
  }

  @Test
  fun `审批放行不得再挂单击直通`() {
    val code = codeOnly(source("OverlayPanel.kt"))
    assertFalse(
      "「批准一次」不得直接 respondApproval（P0-9：真实工具执行需要二次确认）",
      code.contains("pendingChip(\"批准一次\", filled = true, red = false, dp) { respondApproval(a, \"allowed-once\") }"),
    )
    assertTrue("待确认态必须有可见标签", code.contains("确认批准（执行）"))
    assertTrue("待确认态必须能取消", code.contains("pendingChip(t(\"取消\", \"Cancel\")"))
    assertTrue("换卡必须撤臂", code.contains("approvalArmedId = null\n    }"))
  }

  // ── P0-6：停止按钮置灰但可点 ─────────────────────────────────────────────

  @Test
  fun `停止按钮的禁用必须是真禁用`() {
    val panel = codeOnly(source("OverlayPanel.kt"))
    assertTrue("忙态决定可点性（视觉与行为一致）", panel.contains("it.isEnabled = canStop"))
    assertTrue("禁用时同时不可点", panel.contains("it.isClickable = canStop"))
    val svc = codeOnly(source("OverlayService.kt"))
    val stopBody = svc.substringAfter("internal fun requestStop()").substringBefore("\n  }")
    assertFalse(
      "requestStop 不得在无轮次时静默 return（用户视角就是「点了没反应」，P0-6）",
      stopBody.contains("if (!sessionBusy) return\n"),
    )
    assertTrue("无轮次时必须给出可见回执", stopBody.contains("t(\"当前没有正在运行的任务\", \"Nothing is running right now\")"))
  }

  // ── P0-3：按钮卡在禁用的「下载中 100%」 ──────────────────────────────────

  @Test
  fun `安装权限缺失时按钮必须复原为可点`() {
    // 0.14.6 单一真源重构：安装/授权推进迁到 ApkUpdateController，渲染改由 renderApkUpdate 统一负责。
    // 不变量**没变**（P0-3）：权限缺失时按钮必须是**可点**的「授权后继续安装」，被拒返回后同样可点。
    val renderer = codeOnly(source("GuidePageRenderer.kt"))
    assertTrue("必须存在「授权后继续安装」这一可点态", renderer.contains("ds_apk_grant_install"))
    assertTrue("需授权相位必须渲染为可点", renderer.contains("STATE_NEED_PERMISSION"))
    // 拆成「检查」/「下载」两枚按钮后，这条判据落在**下载按钮**上：续继安装归它，而检查按钮在该相位
    // 是禁用的。旧写法取 STATE_NEED_PERMISSION 之后 400 字符的窗口找 enabled = true，拆按钮后那段
    // 窗口里先出现的是检查按钮的禁用，会误判成红——故改成直接断言该分支的下载按钮渲染。
    val permIdx = renderer.indexOf("ApkUpdateState.STATE_NEED_PERMISSION ->")
    assertTrue("需授权相位分支必须存在", permIdx >= 0)
    val permBody = renderer.substring(permIdx, (permIdx + 800).coerceAtMost(renderer.length))
    assertTrue("续继安装的按钮文案必须仍是「授权后继续安装」", permBody.contains("ds_apk_grant_install"))
    val downloadRender = permBody.substringAfter("setDownloadButton(activity.getString(R.string.ds_apk_grant_install)")
    assertTrue(
      "权限缺失时的下载按钮必须可点（P0-3：旧缺陷是卡在禁用的「下载中 100%」）",
      downloadRender.contains("enabled = true"),
    )

    val controller = codeOnly(source("ApkUpdateAction.kt"))
    val canIdx = controller.indexOf("if (!UpdateChecker.canInstall(activity))")
    assertTrue("必须有权限缺失分支", canIdx >= 0)
    val canBody = controller.substring(canIdx, (canIdx + 900).coerceAtMost(controller.length))
    assertTrue("权限缺失必须拉起授权页并如实回报是否拉起", canBody.contains("requestInstallPermission(activity)"))
    assertTrue("拉不起来必须落到如实失败态（不假装拉起过）", canBody.contains("KIND_INSTALLER_UNAVAILABLE"))
    val settle = controller.substringAfter("fun settleAfterResume()").take(900)
    assertTrue("被拒返回后必须收敛到可解释终态（不会是永远转圈）", settle.contains("onFailed") || settle.contains("install("))
  }

  // ── P0-4：存储授权「点了没反应」 ─────────────────────────────────────────

  @Test
  fun `授权结果必须可见，且永久拒绝与本次拒绝分开说`() {
    val code = codeOnly(source("ConfigTransfer.kt"))
    val launcher = code.substringAfter("storagePermLauncher =")
    val head = launcher.substring(0, 1_600.coerceAtMost(launcher.length))
    assertFalse("授权回调不得在无在途 pick 时静默 return", head.contains("if (callback == null) return@registerForActivityResult"))
    assertTrue("必须给出可见回执", head.contains("toastIfPossible("))
    assertTrue("永久拒绝必须单独说明", head.contains("不再询问"))
    assertTrue("chip 必须跟着真实结果刷新", head.contains("refreshGuideMeta()"))
  }

  @Test
  fun `两级设置页入口都失败时必须说话`() {
    val code = codeOnly(source("ConfigTransfer.kt"))
    val fn = code.substringAfter("fun openAllFilesAccessSettings()").substringBefore("\n  /** 用户可见回执")
    assertTrue("无入口时不得静默忽略", fn.contains("toastIfPossible("))
    assertTrue("失败必须留日志", fn.contains("Log.w("))
  }

  // ── P0-2：未配置发布源被当成故障 ────────────────────────────────────────

  @Test
  fun `未配置发布源是中性事实，不是失败`() {
    val um = codeOnly(source("UpdateManager.kt"))
    assertFalse("不得再抛「未配置发布源」异常（那会让界面走红色错误相位）", um.contains("未配置可信发布源（需 HTTPS"))
    assertTrue("必须回中性终态", um.contains("UpdateOutcome.NotConfigured"))
    val flow = codeOnly(source("EngineStartFlow.kt"))
    assertFalse(
      "界面相位不得再靠字符串前缀猜（旧实现把内部错误串当失败相位）",
      flow.contains("status.startsWith(\"更新失败\")"),
    )
    assertTrue("NotConfigured 必须映射到中性相位 Info", flow.contains("UpdateOutcome.NotConfigured -> GuidePhase.Info"))
  }

  @Test
  fun `失败文案必须说人话且给下一步`() {
    val um = codeOnly(source("UpdateManager.kt"))
    // 内部术语一律不上屏：overrideManifestUrl 是只存在于代码里的名字。
    assertFalse("内部开关名不得出现在用户可见文案里", um.contains("\"在线更新未启用：未配置可信发布源"))
    val humanize = UpdateManager.UpdateFailures.humanize(IllegalStateException("manifest HTTP 404"))
    assertTrue("必须带可读原因（含状态码）", humanize.contains("404"))
    assertTrue("必须给下一步", humanize.contains("请") || humanize.contains("可"))
    // 未归类异常不得把 Java 类名/原始 message 直接倒给用户。
    val unknown = UpdateManager.UpdateFailures.humanize(RuntimeException("com.foo.BarException: boom"))
    assertFalse("未归类异常不得回显内部类名", unknown.contains("com.foo.BarException"))
    assertTrue("未归类异常要指向日志与重试", unknown.contains("日志"))
    // 网络类异常有专门的「网络不可达 + 下一步」文案。
    val net = UpdateManager.UpdateFailures.humanize(java.net.UnknownHostException("example.invalid"))
    assertTrue("网络不可达要说清并给下一步", net.contains("网络"))
  }
}
