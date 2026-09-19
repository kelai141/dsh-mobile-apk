package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 调用点契约回归（与仓内 grep 门禁同思路）：#210.5 / #211.3 / ST-01 / ST-02 的缺陷形态
 * 都是「调用点被漏掉或仍在主线程」，纯 JVM 行为测试覆盖不到（需要 Activity/Context）。
 * 这里直接对壳侧源码断言调用点与真源表达式，撤掉修复即变红。
 */
class CallSiteContractTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  /** 去掉注释行（形态名出现在注释里不算命中——与门禁只看代码的口径一致）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /** 取一个成员体的文本：从签名起，到下一个同级成员声明为止。 */
  private fun memberBody(src: String, signature: String): String {
    val idx = src.indexOf(signature)
    if (idx < 0) throw AssertionError("找不到成员签名 " + signature)
    val rest = src.substring(idx + signature.length)
    val cut = listOf("\n  override fun ", "\n  private fun ", "\n  internal fun ", "\n  fun ")
      .map { rest.indexOf(it) }
      .filter { it >= 0 }
      .minOrNull() ?: rest.length
    return rest.substring(0, cut)
  }

  /**
   * ST-01 已**随内置 adb 退役而退役**（0.14.0 §6）：门1 的 KEY_FULLACCESS prefs 与 `AdbState.kt`
   * 一并删除，特权面改由 Shizuku 承载，不再有「回前台收敛权限判定值」这条路径。
   *
   * 本测试原样断言 `AdbState.syncFullAccess(this)`，在该文件删除后必然失败——属于**测试没跟着退役**
   * （存量假红）。此处改为断言**退役事实**：onResume 里不得再出现该调用，且必须留下退役说明，
   * 这样将来谁把 adb 判定偷偷加回来，这里会立刻报出来。
   */
  @Test
  fun onResumeNoLongerSyncsFullAccessAfterAdbRetirement() {
    // 注意：`codeOnly` 会**剥掉注释**，所以「退役说明」要在原文上断言，
    // 而「不得再出现调用」要在代码上断言——两者用不同视图（我第一版混用了，自己踩了一次）。
    val raw = source("MainActivity.kt")
    val code = codeOnly(raw)
    val onResume = memberBody(code, "override fun onResume()")
    assertFalse(
      "ST-01 退役：内置 adb 已下线，onResume 不得再调 AdbState.syncFullAccess",
      onResume.contains("AdbState.syncFullAccess"),
    )
    assertTrue(
      "退役必须在源码里留下可核对的说明（防止无声回退）",
      raw.contains("内置 adb 退役"),
    )
  }

  /** FX-210.5：onResume 不得同步跑网络探测；探活必须经后台入口。 */
  @Test
  fun onResumeDoesNotProbeTheEngineOnTheMainThread() {
    val onResume = memberBody(codeOnly(source("MainActivity.kt")), "override fun onResume()")
    assertFalse("FX-210.5：onResume 不得同步 EngineProbe.check", onResume.contains("EngineProbe.check("))
    assertTrue("FX-210.5：onResume 的探活必须走后台入口", onResume.contains("probeEngineOffMainThread"))
    assertFalse(
      "旧的主线程合取写法必须消失",
      onResume.contains("webView.visibility != View.VISIBLE && !EngineProbe.check()"),
    )
  }

  /** FX-210.5：onCreate 路径（configureWebView）不得同步 refresh cookie。 */
  @Test
  fun configureWebViewDoesNotRefreshTheCookieOnTheMainThread() {
    val configure = memberBody(codeOnly(source("MainActivity.kt")), "private fun configureWebView()")
    assertTrue("FX-210.5：初始化只允许零网络的本地 cookie", configure.contains("EngineAuth.cookie(this)"))
    val beforeRefresh = configure.substringBefore("EngineAuth.refresh(this)")
    assertTrue("FX-210.5：refresh 只允许出现在后台线程块内", beforeRefresh.contains("Thread {"))
  }

  /** ST-02：开关真源 = 偏好 && 系统权限 && 服务实例在场。 */
  @Test
  fun overlayEnabledMergesPreferencePermissionAndServiceInstance() {
    val body = memberBody(codeOnly(source("OverlayController.kt")), "fun isEnabled(context: Context): Boolean")
    assertTrue("ST-02：必须读偏好", body.contains("enabledPref(context)"))
    assertTrue("ST-02：必须活体查系统权限", body.contains("canDrawOverlays(context)"))
    assertTrue("ST-02：必须要求服务实例在场", body.contains("OverlayService.instance"))
  }

  /** ST-02：权限缺失必须回落偏好（保证 onResume 不再弹页）。 */
  @Test
  fun overlayPermissionLossRollsBackThePreference() {
    val ensure = memberBody(codeOnly(source("OverlayController.kt")), "fun ensureStarted(context: Context): Boolean")
    assertTrue("ST-02：权限缺失必须写入 enabled=false", ensure.contains("putBoolean(KEY_ENABLED, false)"))
    assertTrue("ST-02：权限缺失必须停服务", ensure.contains("stop(context)"))
    assertTrue("ST-02：权限在场才启服务", ensure.contains("startService"))
  }

  /** FX-208.3 / FX-211.3：logcat 管道不得裸读（无上限、无超时）。 */
  @Test
  fun logcatReadGoesThroughBoundedProcIo() {
    val code = codeOnly(source("LogCollector.kt"))
    assertFalse("不得裸读 logcat 管道（门禁新增形态）", code.contains(".bufferedReader().readText()"))
    assertFalse("不得无界 readBytes", code.contains("readBytes()"))
    assertTrue("logcat 读取必须经 ProcIo.readBounded", code.contains("ProcIo.readBounded(proc, 10)"))
  }

  /** FX-211.1：ProcIo 必须给出超时/截断标记（只区分 null/非 null 不解决问题，E-1）。 */
  @Test
  fun procIoKeepsThreeDistinctStates() {
    val code = codeOnly(source("ProcIo.kt"))
    assertTrue("超时标记常量", code.contains("TIMEOUT_FLAG"))
    assertTrue("exit 阶段标记", code.contains("exitTimedOut"))
    assertTrue("drain 阶段标记", code.contains("drainTimedOut"))
    assertTrue("截断标记", code.contains("TRUNCATED_FLAG"))
  }

  /** FX-210.1：启动前置必须把恢复入口与探活顺序固化在可断言的位置。 */
  @Test
  fun startFlowUsesTheRecoveryPrelude() {
    val code = codeOnly(source("EngineStartFlow.kt"))
    assertTrue(
      "FX-210.1：Activity 启动路径必须经 startupRecoverThenProbe（恢复先于探活早退）",
      code.contains("startupRecoverThenProbe("),
    )
    val body = code.substringAfter("internal fun startupRecoverThenProbe(").substringAfter("): Boolean {")
    assertTrue("FX-210.1：函数体必须先 recover 再 probe", body.trimStart().startsWith("recover()"))
  }

  /** FX-210.1：服务路径（EngineService）也要前置恢复入口。 */
  @Test
  fun engineServiceAlsoRunsTheRecoveryPrelude() {
    val code = codeOnly(source("EngineService.kt"))
    val ensureEngine = memberBody(code, "private fun ensureEngine()")
    val recoverAt = ensureEngine.indexOf("recoverInterruptedRefresh()")
    val watchdogAt = ensureEngine.indexOf("WatchdogV2.acquireWakeLock")
    assertTrue("FX-210.1：服务路径必须调恢复入口", recoverAt >= 0)
    assertTrue("FX-210.1：恢复必须先于看门狗装配", watchdogAt < 0 || recoverAt < watchdogAt)
  }

  // ── 0.14.1 块I：取消强制吸附 + 状态描边 ring 的同源契约 ─────────────────
  // 详档 docs/0.14.1-preview-HALO-FREE-MOVE-AND-RING.md §4.3(a)/§6.1 的反证要求：
  // 把 springSnapToEdge 加回去、或新增第二张 ring 色表/第二入口，这里必须变红。

  /** I-A1：松手不得再吸附——ACTION_UP 分支内不得出现 springSnapToEdge，且 spring 面整体退役。 */
  @Test
  fun ballReleaseNoLongerSnapsToTheEdge() {
    val code = codeOnly(source("OverlayService.kt"))
    val touch = memberBody(code, "private fun attachBallTouch(ball: View)")
    assertFalse("I-A1：ACTION_UP 分支不得再调 springSnapToEdge", touch.contains("springSnapToEdge"))
    assertFalse("I-A1：吸附函数体必须删除", code.contains("springSnapToEdge"))
    assertFalse("I-A1：spring 动画字段/取消函数必须一并删除", code.contains("springAnim") || code.contains("cancelSpring"))
    assertFalse("I-A1：dynamicanimation 在壳侧应无使用方", code.contains("SpringAnimation") || code.contains("SpringForce"))
    assertTrue("I-A1：钳制必须保留并走同一具名常量", code.contains("edgeMarginPx"))
    assertTrue("I-A1：具名常量必须存在（供恒等式测试引用）", code.contains("BALL_EDGE_MARGIN_DP"))
  }

  /** I-A1：最小边距不得退化为字面量散落——clampBallPos 必须用 edgeMarginPx，不得再写 `8 * dp`。 */
  @Test
  fun clampBallPosUsesTheNamedEdgeMargin() {
    val body = memberBody(codeOnly(source("OverlayService.kt")), "private fun clampBallPos(")
    assertTrue("I-A1：clampBallPos 必须引用具名边距", body.contains("val margin = edgeMarginPx"))
    assertFalse("I-A1：不得在钳制里写死 8dp 字面量", body.contains("8 * dp"))
    assertTrue("I-A1：四向钳制必须保留", body.contains("coerceIn(margin"))
  }

  /** I-A2：ring 必须与 glow 同 View 合成——光环维不得出现任何窗口操作（不新增窗口）。 */
  @Test
  fun ringIsCompositedInTheSameHaloViewNotANewWindow() {
    val code = codeOnly(source("OverlayHalo.kt"))
    assertTrue("I-A2：background 必须是合成两层", code.contains("LayerDrawable("))
    assertFalse("I-A2：光环维不得自己开窗（不得出现 WindowManager/addView）", code.contains("WindowManager") || code.contains("addView"))
    assertFalse("I-A2：不得出现新的窗口类型常量", code.contains("TYPE_APPLICATION_OVERLAY"))
    assertTrue("I-A2：ring 层用索引取，不新建资源面", code.contains("LAYER_RING"))
  }

  /**
   * I-A3：改色路径恰为两处（构建期 newHaloDrawable + 运行期 setHalo），
   * 且不存在 setRing/setRingColors 之类的第二入口。
   */
  @Test
  fun haloColorsHaveExactlyTwoCallSitesAndNoSecondEntry() {
    val code = codeOnly(source("OverlayHalo.kt"))
    // 1 处声明 + 2 处调用 = 3
    val calls = Regex("setHaloColors\\(").findAll(code).count()
    assertEquals("I-A3：setHaloColors 调用点必须恰为 newHaloDrawable + setHalo 两处", 3, calls)
    assertFalse("I-A3：不得新增 setRing 第二入口", code.contains("setRing"))
    assertFalse("I-A3：不得新增 setRingColors 第二入口", code.contains("setRingColors"))
  }

  /** I-A3：ring 面必须封闭在 OverlayHalo.kt——另三个文件不得出现 ring 的任何符号。 */
  @Test
  fun ringSurfaceStaysInsideOverlayHalo() {
    val ringSymbols = listOf("haloRingPx", "LAYER_RING", "setRing", "haloRingInsetPx")
    for (name in listOf("OverlayService.kt", "OverlayPanel.kt", "OverlayLiveFeed.kt")) {
      val code = codeOnly(source(name))
      for (sym in ringSymbols) {
        assertFalse("I-A3：$name 不得出现 ring 符号 $sym（颜色与状态只走 setHalo 漏斗）", code.contains(sym))
      }
    }
  }

  /**
   * I-A3 反证表第 2 行：**新增第二张 ring 色表必须判红**（task-14 补的缺失断言）。
   *
   * 详档 §4.3 反证表要求「在 `OverlayHalo` 里另写一组 ARGB」→ 判红。判据：
   *  ① 文件里所有 8 位 ARGB 字面量必须**全部落在 `enum class Halo { … }` 块内**
   *     （枚举外出现颜色字面量 = 第二张色表）；
   *  ② 色表规模恰为 8 个（四态 × color/fade），多一个即红；
   *  ③ `Halo` 的构造参数恰为 (color, fade) 两档——新增 `ring` 之类的第三档即红。
   */
  @Test
  fun ringHasNoSecondColorTable() {
    val code = codeOnly(source("OverlayHalo.kt"))
    val argbRe = Regex("""0x[0-9A-Fa-f]{8}\.toInt\(\)""")
    val all = argbRe.findAll(code).toList()
    assertEquals("I-A3：颜色字面量必须恰为四态×两档 = 8 个（多一个即疑似第二张色表）", 8, all.size)
    // ① 全部字面量必须在 enum class Halo 块内
    val enumIdx = code.indexOf("enum class Halo")
    assertTrue("I-A3：必须存在 enum class Halo", enumIdx >= 0)
    val enumBlock = code.substring(enumIdx)
    val outside = all.filter { it.range.first < enumIdx }
    assertTrue(
      "I-A3：枚举块外不得出现任何 ARGB 字面量（即第二张色表）。越界字面量：$outside",
      outside.isEmpty(),
    )
    // enum 块也必须囊括全部 8 个（防「枚举只写一半、另一半散在外面」）
    val inside = argbRe.findAll(enumBlock).count()
    assertEquals("I-A3：8 个颜色字面量必须全部在 Halo 枚举块内", 8, inside)
    // ③ 构造参数恰为两档
    val head = Regex("""enum class Halo\(([^)]*)\)""").find(code)
      ?: throw AssertionError("I-A3：找不到 Halo 枚举的构造参数表")
    val params = head.groupValues[1].split(",").map { it.trim() }.filter { it.isNotEmpty() }
    assertEquals("I-A3：Halo 构造参数必须恰为 (color, fade) 两档（新增第三档即视为第二色表）", 2, params.size)
    assertTrue("I-A3：第一档必须是 val color", params[0].startsWith("val color"))
    assertTrue("I-A3：第二档必须是 val fade", params[1].startsWith("val fade"))
  }

  /**
   * I-A3：**setHalo 是唯一状态/改色委托入口**（task-14 补的缺失断言）。
   *
   * 判据：`OverlayService.kt` 里 `halo.setHalo(` 只出现在 `internal fun setHalo(h: Halo) = halo.setHalo(h)`
   * 这一处委托上；任何绕开该漏斗的直接调用（例如某处 `halo.setHalo(...)`）即红——
   * 绕过漏斗就绕过了「ring 与 glow 同源」的结构性保证。
   */
  @Test
  fun setHaloIsTheSoleDelegateEntryPoint() {
    val svc = codeOnly(source("OverlayService.kt"))
    val delegate = Regex("""internal fun setHalo\(h: Halo\) = halo\.setHalo\(h\)""").find(svc)
      ?: throw AssertionError("I-A3：找不到 setHalo 的唯一委托 `internal fun setHalo(h: Halo) = halo.setHalo(h)`")
    assertTrue("I-A3：委托定义必须在场", delegate.range.first >= 0)
    // halo.setHalo( 的出现次数：委托体 1 次为正常
    val directCalls = Regex("""halo\.setHalo\(""").findAll(svc).count()
    assertEquals(
      "I-A3：halo.setHalo( 必须只出现在唯一委托里（发现 $directCalls 处 = 有人绕过漏斗直接改光环）",
      1,
      directCalls,
    )
    // 状态写入点必须走 svc.setHalo(...) 漏斗
    val funnelCalls = Regex("""\bsetHalo\(""").findAll(svc).count()
    assertTrue("I-A3：状态写入必须经 setHalo 漏斗（至少 3 处：委托 + running=true + 探活）", funnelCalls >= 4)
  }

  /** I-A2/坑 61：setHalo 的改色不得再是 `as? GradientDrawable ?: return@post` 式静默失败。 */
  @Test
  fun setHaloDoesNotSilentlySwallowColorUpdates() {
    val body = memberBody(codeOnly(source("OverlayHalo.kt")), "fun setHalo(halo: Halo)")
    assertFalse("I-A2：不得再对 background 直接 as? GradientDrawable（合成两层后恒 null = 静默吞改色）", body.contains("background as? GradientDrawable"))
    assertTrue("I-A2：必须显式取 LayerDrawable", body.contains("as? LayerDrawable"))
    assertTrue("I-A2：取层失败必须留下可诊断痕迹", body.contains("diagnose("))
  }

  /**
   * I-A3（反假绿）：Halo 不得回退到 Color.argb——否则 JVM 单测下四态全 0，颜色断言恒真。
   *
   * 同时钉死 8 个**正确**字面量：手写十六进制最容易把 g/b 两个字节写反，本轮 PENDING 就实际踩到过
   * （`205,235,190,60` 应为 0xCDEB**BE3C**，曾误写成 0xCDEB**BC3C**）。对照表：
   * IDLE 96,255,255,255→0x60FFFFFF / fade 58,255,255,255→0x3AFFFFFF
   * WORKING 170,92,132,255→0xAA5C84FF / fade 102,92,132,255→0x665C84FF
   * PENDING 205,235,190,60→0xCDEBBE3C / fade 123,235,190,60→0x7BEBBE3C
   * ERROR 160,224,72,72→0xA0E04848 / fade 96,224,72,72→0x60E04848
   */
  @Test
  fun haloEnumUsesPlainKotlinArgbLiterals() {
    val code = codeOnly(source("OverlayHalo.kt"))
    assertFalse("I-A3：不得使用 Color.argb（JVM 下被桩成 0 = 假绿）", code.contains("Color.argb("))
    val expected = listOf(
      "0x60FFFFFF", "0x3AFFFFFF",
      "0xAA5C84FF", "0x665C84FF",
      "0xCDEBBE3C", "0x7BEBBE3C",
      "0xA0E04848", "0x60E04848",
    )
    for (lit in expected) {
      assertTrue("I-A3：字面量 $lit 必须在场（与 HEAD 的 Color.argb 逐字节等价）", code.contains(lit))
    }
    // 明确禁止已知的「g/b 写反」形态——这类错手写时最常发生且单测才抓得到。
    assertFalse("I-A3：PENDING 的 g/b 不得写反（0xCDEBBC3C 是错值）", code.contains("0xCDEBBC3C"))
    assertFalse("I-A3：PENDING.fade 的 g/b 不得写反（0x7BEBBC3C 是错值）", code.contains("0x7BEBBC3C"))
  }

  /** I-A2：haloView 的 background 初值仍走 newHaloDrawable（形态变化但调用点不变）。 */
  @Test
  fun haloViewBackgroundStillComesFromNewHaloDrawable() {
    val code = codeOnly(source("OverlayService.kt"))
    assertTrue("I-A2：初值仍走 newHaloDrawable(Halo.IDLE)", code.contains("newHaloDrawable(Halo.IDLE)"))
    // 窗口数仍为 3：buildRoot 里只有光环 + 球两次 addView（面板窗在 showPanel 里另加），
    // 新增 ring 窗口会让这个计数变大。
    val buildRoot = memberBody(code, "private fun buildRoot()")
    assertEquals(
      "详档 §5.2：窗口数仍为 3（ring 不得新增窗口）",
      2,
      Regex("wm\\.addView\\(").findAll(buildRoot).count(),
    )
  }

  // ── 0.14.1 块H：完成态卡片（A1）+ 报告栏（A2）+ 三击跳转（A3） ──────────
  // 详档 docs/0.14.1-preview-OVERLAY-COMPLETION-CARD.md §5.1/§6.1/§6.2 的落点与反证要求。

  /** H-A1：完成位必须挂在**服务级字段**（面板收起态要能存活），不得用一次性 setText。 */
  @Test
  fun completionNoticeLivesOnTheServiceAndIsConsumedOnFirstOpen() {
    val code = codeOnly(source("OverlayService.kt"))
    assertTrue("A1：完成位必须是服务级字段", code.contains("internal val completion = CompletionNotice()"))
    assertTrue("A1：showPanel 必须消费完成位（首次打开语义）", code.contains("completion.consume()"))
    assertTrue("A1：权威信号 running=false 必须置位", code.contains("onAuthoritativeIdle("))
    assertTrue("A1：running=true 必须清除完成位", code.contains("onTurnStart("))
    // 判定 1：只有在 updateBallOnly 的分支链里渲染，不能用一次性 setText 覆盖（会被下次重跑覆盖）。
    val panel = codeOnly(source("OverlayPanel.kt"))
    assertTrue("A1：必须作为 updateBallOnly 分支链的一个分支", panel.contains("svc.completionLabel().isNotEmpty()"))
    assertTrue("A1：文案必须经 setStatusText 入口", panel.contains("setStatusText(it, svc.completionLabel()"))
  }

  /** H-A1：语义标签必须取 kind（不是布尔 ok）——失败不得伪装成「已完成」。 */
  @Test
  fun completionLabelComesFromTurnEndKindNotFromTheBooleanOk() {
    val live = codeOnly(source("OverlayLiveFeed.kt"))
    assertTrue("A1：turn_end 必须读 kind 字段（语义真源）", live.contains("j.optString(\"kind\""))
    assertTrue("A1：kind 必须经 turnEndLabel 映射", live.contains("turnEndLabel(kind)"))
    val report = codeOnly(source("OverlayReport.kt"))
    assertTrue("A1：kind 映射必须与 notify-projection 口径同构", report.contains("\"completed\" -> \"已完成\""))
    assertTrue("A1：未知 kind 必须兜底「结果未知」而非「已完成」", report.contains("else -> \"结果未知\""))
    assertTrue(
      "A1：只有布尔 ok 时，false 必须落「结果未知」而非「已完成」",
      live.contains("if (j.optBoolean(\"ok\", false)) \"已完成\" else \"结果未知\""),
    )
  }

  /** H-A1：待答分支必须先于完成态分支（待答时不得显示「已完成」）。 */
  @Test
  fun pendingBranchesPrecedeTheCompletionBranch() {
    val body = memberBody(codeOnly(source("OverlayPanel.kt")), "internal fun updateBallOnly()")
    val question = body.indexOf("svc.pendingKind == \"question\"")
    val approval = body.indexOf("svc.pendingKind == \"approval\"")
    val busy = body.indexOf("} else if (svc.sessionBusy) {")
    val completed = body.indexOf("svc.completionLabel().isNotEmpty()")
    assertTrue("A1：待答/工作/完成三分支都必须存在", question >= 0 && approval >= 0 && busy >= 0 && completed >= 0)
    assertTrue("A1：question 分支必须最前", question < completed)
    assertTrue("A1：approval 分支必须早于完成分支", approval < completed)
    assertTrue("A1：完成分支必须在 sessionBusy 分支之后（新一轮优先）", busy < completed)
  }

  /** H-A2：报告栏必须是**独立顶层窗口**，且收口点覆盖 hidePanel 与 onDestroy 两处。 */
  @Test
  fun reportBarIsItsOwnWindowClosedInBothTeardownPaths() {
    val code = codeOnly(source("OverlayService.kt"))
    assertTrue("A2：报告栏必须是独立协作类", code.contains("internal val report = OverlayReport(this)"))
    val hide = memberBody(code, "internal fun hidePanel()")
    assertTrue("A2：hidePanel 必须收口报告栏（FX-212.1 纪律）", hide.contains("report.hideReport()"))
    val destroy = memberBody(code, "override fun onDestroy()")
    assertTrue("A2：onDestroy 必须收口报告栏", destroy.contains("report.hideReport()"))
    val report = codeOnly(source("OverlayReport.kt"))
    assertTrue("A2：必须是独立 TYPE_APPLICATION_OVERLAY 窗口", report.contains("TYPE_APPLICATION_OVERLAY"))
    assertTrue("A2：必须点栏外即关（ACTION_OUTSIDE）", report.contains("ACTION_OUTSIDE"))
    assertTrue("A2：必须有可滚动容器", report.contains("ScrollView("))
    assertTrue("A2：不复用 unit 面板（不得出现面板视图字段）", !report.contains("panel.unitView"))
  }

  /**
   * H-A2 反证的**另一半**（task-14 补）：A2 反证有两半——①内容半边（`reportLines()` 空摘要/无数据
   * 不返回空表，在 OverlayCompletionNoticeTest 覆盖）；②**打开半边**：`showReport()` 的开窗路径
   * **根本不得接触内容**。旧测试只覆盖 ①，于是「内容为空 → 静默不开窗」这种缺陷不会被抓。
   *
   * 判据（结构性，不依赖具体写法）：
   *  - `showReport()` 体内**不得出现任何内容访问**（`reportLines()`/`latestEntry()`/`lines`）——
   *    内容只在 `buildReportBar()` 里取；开窗决策与内容无关。
   *  - 必须无条件走到 `svc.wm.addView(bar, lp)`。
   *  - 早退只允许「已开窗」「构建失败」两处。
   */
  @Test
  fun reportBarOpensRegardlessOfContentEmptiness() {
    val code = codeOnly(source("OverlayReport.kt"))
    val body = memberBody(code, "fun showReport(): Boolean")
    for (sym in listOf("reportLines(", "latestEntry(", "lines", "NotifyStore")) {
      assertFalse(
        "A2：开窗路径不得访问内容（发现 `$sym`）——内容为空必须仍能打开（A2 反证）",
        body.contains(sym),
      )
    }
    assertFalse("A2：开窗路径不得按条目为空提前返回", body.contains("entry == null"))
    assertTrue("A2：必须走到 wm.addView 真正开窗", body.contains("svc.wm.addView(bar, lp)"))
    val earlyReturns = Regex("""\breturn\b""").findAll(body).count()
    assertTrue("A2：return 处数异常（$earlyReturns）——疑似新增了内容相关早退", earlyReturns in 2..4)
  }

  /**
   * H-A2/坑 149：`showReport()` 的构建失败路径必须**留可诊断痕迹**，不得无日志静默返回。
   * 判据：catch 块内必须出现 `LogCollector.log`，且不得是 `catch (_: Exception) { return false }`。
   */
  @Test
  fun reportBarBuildFailureIsLoggedNotSwallowedSilently() {
    val report = codeOnly(source("OverlayReport.kt"))
    val body = memberBody(report, "fun showReport(): Boolean")
    assertFalse(
      "A2/坑149：不得无日志静默吞掉构建失败",
      Regex("""catch\s*\(\s*_\s*:\s*Exception\s*\)\s*\{\s*return\s+false""").containsMatchIn(body),
    )
    assertTrue("A2/坑149：构建失败必须落 LogCollector", body.contains("LogCollector.log"))
    assertTrue("A2/坑149：日志 tag 必须可检索", body.contains("dsh-overlay-report"))
  }

  /** H-A2 防误触：超 touchSlop 判拖动，不得打开报告栏（长按计时器必须被取消）。 */
  @Test
  fun draggingBeyondSlopCancelsTheLongPress() {
    val panel = codeOnly(source("OverlayPanel.kt"))
    val gesture = memberBody(panel, "private fun attachStatusGesture(tv: TextView)")
    assertTrue("A2：阈值必须运行时读取 scaledTouchSlop", gesture.contains("vc.scaledTouchSlop"))
    // ViewConfiguration 的 static/实例面**不一致**（javap android-36 android.jar 实证）：
    // getScaledTouchSlop() 是实例方法，而 getLongPressTimeout()/getDoubleTapTimeout() 是 **static**。
    // 写成实例属性即 Unresolved reference（本轮真实编译错误），故此处钉死正确形态。
    assertTrue(
      "A2：长按阈值必须经 static 方法读取 getLongPressTimeout()",
      gesture.contains("android.view.ViewConfiguration.getLongPressTimeout()"),
    )
    assertTrue(
      "A2：三击窗口必须经 static 方法读取 getDoubleTapTimeout()",
      gesture.contains("android.view.ViewConfiguration.getDoubleTapTimeout()"),
    )
    assertFalse(
      "A2：不得写成实例属性（这些成员是 static，实例属性不解析）",
      gesture.contains("vc.longPressTimeout") || gesture.contains("vc.doubleTapTimeout"),
    )
    assertTrue("A2：超 slop 必须取消长按计时器", gesture.contains("cancelPending()") && gesture.contains("moved = true"))
    assertTrue("A2：长按打开报告栏", gesture.contains("svc.toggleReportBar()"))
  }

  /** H-A3：三击跳转必须带 NEW_TASK + SINGLE_TOP（已在前台时不重建 Activity → WebView 不重载）。 */
  @Test
  fun jumpToAppUsesSingleTopSoForegroundJumpsDoNotRebuildTheActivity() {
    val code = codeOnly(source("OverlayService.kt"))
    assertTrue("A3：必须存在跳转入口", code.contains("internal fun jumpToApp()"))
    val body = memberBody(code, "internal fun jumpToApp()")
    assertTrue("A3：必须指向 MainActivity", body.contains("MainActivity::class.java"))
    assertTrue("A3：必须带 FLAG_ACTIVITY_NEW_TASK", body.contains("Intent.FLAG_ACTIVITY_NEW_TASK"))
    assertTrue(
      "A3：必须带 FLAG_ACTIVITY_SINGLE_TOP（MainActivity 未声明 launchMode，默认 standard；" +
        "缺此 flag 会新建实例 → WebView 重载）",
      body.contains("Intent.FLAG_ACTIVITY_SINGLE_TOP"),
    )
    assertTrue("A3：跳转必须 try/catch（背景启动限制下不得崩）", body.contains("catch"))
    assertFalse("A3：不得新增桥方法/路由", code.contains("addJavascriptInterface"))
  }

  /** H：面板占用标志必须同时进入 autoCollapseOnDone 的守卫（防长按期间被自动收起）。 */
  @Test
  fun autoCollapseGuardHonoursThePanelOccupiedFlag() {
    val body = memberBody(codeOnly(source("OverlayService.kt")), "internal fun applyAgentStatus(")
    assertTrue("A2：守卫必须判断 panelOccupied", body.contains("!panelOccupied"))
    assertTrue("回归：既有「有草稿不收」不得被覆盖", body.contains("!panel.hasDraft()"))
  }
}

/**
 * 块C §2.3/§2.4 源码契约（0.14.1；2026-09-19 由临时判据转正）。
 *
 * 为什么用源码契约而不是行为测试：这四条回调与版本回读都需要真实 WebView/Context 才能触发
 * （Robolectric 也拿不到真实内核版本），而它们要防的缺陷形态恰恰是「**回调/字段被漏掉或收回**」——
 * 那是最适合源码契约断言的形态（与 [CallSiteContractTest] 同一思路）。
 *
 * **反向对照可靠性（本类的教训）**：判据一律用 [memberBody] 取**函数体**、[codeOnly] 剥注释。
 * 整文件范围的正则会跨进相邻成员，把「实现正确」误报成缺陷（实测踩过：判定「是否共用
 * pick-token 判据」时正则跨进相邻 tapIndex）；而按签名取函数体不会。
 */
class BootDiagnosticsContractTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  private fun memberBody(src: String, signature: String): String {
    val idx = src.indexOf(signature)
    if (idx < 0) throw AssertionError("找不到成员签名 " + signature)
    val rest = src.substring(idx + signature.length)
    val cut = listOf("\n  override fun ", "\n  private fun ", "\n  internal fun ", "\n  fun ")
      .map { rest.indexOf(it) }
      .filter { it >= 0 }
      .minOrNull() ?: rest.length
    return rest.substring(0, cut)
  }

  /** §2.3：HTTP 层失败必须落诊断（真因：onReceivedError 不覆盖服务端 5xx）。 */
  @Test
  fun httpErrorCallbackIsPresent() {
    val body = memberBody(codeOnly(source("MainActivity.kt")), "override fun onReceivedHttpError(")
    assertTrue("§2.3：必须落 http-error 诊断", body.contains("\"http-error\""))
    assertTrue("§2.3：必须带状态码", body.contains("statusCode"))
    assertTrue("§2.3：只对引擎同源置位（外部跳转不得污染引擎健康度）", body.contains("isEngineSource("))
  }

  /** §2.3：TLS 失败落诊断，但**不得放行**（安全敏感面不为诊断弱化）。 */
  @Test
  fun sslErrorCallbackIsPresent() {
    val body = memberBody(codeOnly(source("MainActivity.kt")), "override fun onReceivedSslError(")
    assertTrue("§2.3：必须落 ssl-error 诊断", body.contains("\"ssl-error\""))
    assertTrue("§2.3：必须显式取消（保持默认拒绝语义）", body.contains("handler.cancel()"))
    assertFalse("§2.3：绝不得为「让页面能开」而放行", body.contains("handler.proceed()"))
  }

  /** §2.3：渲染进程被杀必须消费并落诊断（此前主 WebView 零实现 → 用户看到「卡死」）。 */
  @Test
  fun renderProcessGoneCallbackIsPresentAndConsumed() {
    val body = memberBody(codeOnly(source("MainActivity.kt")), "override fun onRenderProcessGone(")
    assertTrue("§2.3：必须落 render-gone 诊断", body.contains("\"render-gone\""))
    assertTrue("§2.3：必须置失败态并回引导页", body.contains("enginePageFailed = true") && body.contains("showGuide()"))
    assertTrue("§2.3：必须消费（返回 true），否则留在一个永不响应的 WebView 上", body.contains("return true"))
  }

  /** §2.3 回归：既有 pageReady 前缀分支不得被删（加错误收据时最容易误删）。 */
  @Test
  fun consoleMessageKeepsThePageReadyPrefix() {
    val body = memberBody(codeOnly(source("MainActivity.kt")), "override fun onConsoleMessage(")
    assertTrue("§2.3 回归：pageReady 分支必须保留", body.contains("isPageReadyMessage("))
  }

  /** §2.3 回归：既有 pageStall 前缀分支不得被删。 */
  @Test
  fun consoleMessageKeepsThePageStallPrefix() {
    val body = memberBody(codeOnly(source("MainActivity.kt")), "override fun onConsoleMessage(")
    assertTrue("§2.3 回归：pageStall 分支必须保留", body.contains("isPageStallMessage("))
  }

  /** §2.3：必须新增渲染错误分支（否则页面 JS 错误仍进不了诊断）。 */
  @Test
  fun consoleMessageAddsTheRenderErrorBranch() {
    val body = memberBody(codeOnly(source("MainActivity.kt")), "override fun onConsoleMessage(")
    assertTrue("§2.3：必须新增渲染错误分支", body.contains("isRenderErrorMessage("))
    // 不能吞掉第三方页面日志：错误分支必须返回 false（交回默认 console 行为）。
    val errorBranch = body.substringAfter("isRenderErrorMessage(")
    assertTrue("§2.3：错误分支不得消费（必须返回 false，不吞页面报错）", errorBranch.contains("false"))
  }

  /**
   * §2.3：渲染错误按**结果性**判据（级别）判定，不匹配 "SyntaxError" 文本。
   * 措辞随内核变、级别不会——这是本轮最重要的一条。
   */
  @Test
  fun renderErrorMessageUsesLevelNotText() {
    val body = memberBody(codeOnly(source("MainActivity.kt")), "internal fun isRenderErrorMessage(")
    assertTrue("§2.3：必须按 MessageLevel.ERROR 判定", body.contains("ConsoleMessage.MessageLevel.ERROR"))
    assertFalse("§2.3：不得匹配错误文案（措辞随内核变）", body.contains("SyntaxError"))
  }

  /** §2.3：渲染错误分支必须排除两个自有前缀（否则与上面两条分支重复落盘）。 */
  @Test
  fun renderErrorMessageExcludesTheTwoOwnPrefixes() {
    val body = memberBody(codeOnly(source("MainActivity.kt")), "internal fun isRenderErrorMessage(")
    assertTrue(
      "§2.3：必须排除两个自有前缀",
      body.contains("isPageReadyMessage(") && body.contains("isPageStallMessage("),
    )
  }

  /** §2.3：未设背景色时默认白，白屏与「正常空页」不可区分。 */
  @Test
  fun mainWebViewSetsANeutralBackground() {
    val code = codeOnly(source("MainActivity.kt"))
    assertTrue("§2.3：主 WebView 必须设背景色", code.contains("setBackgroundColor(MAIN_WEBVIEW_BACKGROUND)"))
    assertTrue("§2.3：背景色必须具名（不得内联字面量）", code.contains("MAIN_WEBVIEW_BACKGROUND"))
  }

  /** §2.4：内核版本必须回读——老设备白屏定位闭环的第 1 项（用户拿不到，维护方就要不到）。 */
  @Test
  fun webViewVersionIsReadBack() {
    val code = codeOnly(source("MainActivity.kt"))
    assertTrue("§2.4：必须读内核包", code.contains("WebView.getCurrentWebViewPackage()"))
    assertTrue("§2.4：必须解析 major", code.contains("currentWebViewMajor()"))
  }

  /** §2.4：版本必须落 webview-version 诊断（落盘面）。 */
  @Test
  fun webViewVersionIsWrittenToBootDiag() {
    val code = codeOnly(source("MainActivity.kt"))
    assertTrue("§2.4：必须落 webview-version 诊断", code.contains("\"webview-version\""))
  }

  /** §2.4：版本必须进**首启路径**，不只进诊断包（老设备白屏时用户必须能自助取到）。 */
  @Test
  fun webViewVersionIsReportedOnTheFirstLaunchPath() {
    val code = codeOnly(source("MainActivity.kt"))
    assertTrue("§2.4：onCreate 必须调用版本回读", code.contains("reportWebViewVersion(\"onCreate\")"))
  }

  /**
   * §2.4：判据字段 `syntax_floor_ok` 与门槛常量必须同源。
   * 门槛 = 94（ES2022 类静态块需 Chromium 94+）；改宽门槛即放宽了老设备判据。
   */
  @Test
  fun syntaxFloorUsesTheNinetyFourThreshold() {
    val code = codeOnly(source("MainActivity.kt"))
    assertTrue("§2.4：必须有判据字段 syntax_floor_ok", code.contains("syntax_floor_ok="))
    assertTrue("§2.4：门槛必须为 94（Chromium 94 引入类静态块）", code.contains("WEBVIEW_SYNTAX_FLOOR_MAJOR = 94"))
  }

  /** §2.3/§2.4：诊断写入必须走既有 LogCollector 漏斗（唯一写者纪律），不得直写文件。 */
  @Test
  fun diagnosticsGoThroughTheLogCollectorFunnel() {
    val code = codeOnly(source("MainActivity.kt"))
    val funnelCalls = Regex("LogCollector\\.writeBootDiag\\(").findAll(code).count()
    assertTrue("§2.3/§2.4：四条诊断必须都走 writeBootDiag（实测 $funnelCalls 处，要求 ≥ 4）", funnelCalls >= 4)
    assertFalse("§2.3/§2.4：不得在 MainActivity 直写 boot-diag 文件", code.contains("boot-diag.log"))
  }
}
