package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 0.14.0-preview / task-8（B4 壳侧条目）调用点契约回归 —— 与 CallSiteContractTest 同思路：
 * 这些缺陷形态是「调用点被漏掉 / 真源表达式被写回旧形态」，纯 JVM 行为测试覆盖不到
 * （需要 Activity/Service/WebView）。此处直接对壳侧源码断言，**撤掉修复即变红**。
 *
 * 覆盖：FX-212.1（hidePanel 收口 pickerWindow）/ FX-212.2（文案与预算同源）/
 * FX-209.E1（两分支同一份产物校验）/ ST-12（真源探测进 stateJson）/
 * ST-13（握手非 101 → 鉴权刷新）/ ST-10 + ST-11（桥 getter 与真源合取）。
 */
class W3ShellContractTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  /** 去掉注释行（形态名只出现在注释里不算命中——与门禁只看代码的口径一致）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("<!--")
    }
    .joinToString("\n")

  /** 取一个成员体的文本：从签名起，到下一个同级成员声明为止。 */
  private fun memberBody(src: String, signature: String): String {
    val idx = src.indexOf(signature)
    if (idx < 0) throw AssertionError("找不到成员签名 " + signature)
    val rest = src.substring(idx + signature.length)
    val cut = listOf("\n  override fun ", "\n  private fun ", "\n  internal fun ", "\n  fun ", "\n  @JavascriptInterface", "\n  /**")
      .map { rest.indexOf(it) }
      .filter { it >= 0 }
      .minOrNull() ?: rest.length
    return rest.substring(0, cut)
  }

  // ── FX-212.1：hidePanel 必须收口 pickerWindow（独立顶层窗口） ────────────────

  @Test
  fun hidePanelClosesThePickerWindowBeforeTheEarlyReturn() {
    val body = memberBody(codeOnly(source("OverlayService.kt")), "internal fun hidePanel()")
    assertTrue(
      "FX-212.1：收起面板必须调 OverlayPanel.closePicker()（否则选择器顶层窗口留在屏上）",
      body.contains("panel.closePicker()"),
    )
    val closeAt = body.indexOf("panel.closePicker()")
    val earlyReturnAt = body.indexOf("panel.unitView ?: return")
    assertTrue("FX-212.1：收口必须在 unitView 早退之前（视图缺失时也不能漏收）", earlyReturnAt < 0 || closeAt < earlyReturnAt)
  }

  @Test
  fun pickerWindowIsOwnedAndClosedByOverlayPanel() {
    val code = codeOnly(source("OverlayPanel.kt"))
    assertTrue("选择器仍是独立窗口（本缺陷的前提）", code.contains("pickerWindow = container"))
    assertTrue("收口入口 = closePicker()（removeView + 清引用）", code.contains("svc.wm.removeView(w)"))
  }

  // ── FX-212.2：预算与文案同一真源，且调用点不再出现字面量秒数 ────────────────

  @Test
  fun bootProgressTextIsDerivedFromTheSingleBudgetConstant() {
    val code = codeOnly(source("EngineStartFlow.kt"))
    assertTrue("预算常量必须存在", code.contains("internal const val ENGINE_BOOT_BUDGET_MS = 90_000L"))
    assertTrue("轮询必须读该常量", code.contains("val pollBudgetMs = ENGINE_BOOT_BUDGET_MS"))
    assertTrue("文案必须由同源时钟派生", code.contains("engineBootProgressText(clock)"))
    assertFalse("E-9：不得再出现 60 - s 的硬编码换算", code.contains("60 - s"))
    assertFalse("不得再出现字面量预算秒数", code.contains("\${60"))
  }

  // ── FX-209.E1：缓存分支与新下载分支共用同一份校验 ──────────────────────────

  @Test
  fun bothDownloadPathsShareOneArtifactVerification() {
    val body = memberBody(codeOnly(source("GuidePageRenderer.kt")), "private fun downloadAndInstall(")
    assertTrue("必须调用统一的 verifyApkArtifact", body.contains("verifyApkArtifact("))
    assertTrue("缓存复用分支必须走该判定", body.contains("artifactVerdict()"))
    assertFalse(
      "旧的内联大小判定必须消失（两条路径各写一套 = 判定强度不对称）",
      body.contains("dest.length() == r.sizeBytes"),
    )
    val afterDownload = body.substringAfter("val used = UpdateChecker.download")
    assertTrue("新下载分支也必须走同一判定（旧实现只判 HTTP 200）", afterDownload.contains("artifactVerdict()"))
  }

  // ── ST-12：已随内置 adb 退役**迁移**（0.14.0 §6）──
  //
  // 原两条断言直接读 `AdbState.kt` 的 `stateJson` / `WIRELESS_PROBE_TTL_MS`。该文件随内置 adb
  // 一起删除（特权面改由 Shizuku 承载），于是它们必然失败——**测试没跟着代码退役**（存量假红）。
  //
  // 逻辑本身并未失去覆盖：真源探测原语被抽到 `LiveProbe.kt`，行为回归在同目录的
  // `AdbLiveProbeTest.kt`（TTL 内复用 / 过期重探 / 失败不冒充实测成功 / TCP 探测区分端口，4 项全绿）。
  // 因此这里只保留「退役事实」的守卫：**不得**再出现对已删除文件的引用，避免有人日后照旧写法回退。
  @Test
  fun st12LivesInLiveProbeAfterAdbRetirement() {
    assertTrue(
      "ST-12 应已迁移到 LiveProbe.kt（真源探测原语）",
      File("src/main/java/com/dsharnessmobile/shell/LiveProbe.kt").isFile ||
        File("app/src/main/java/com/dsharnessmobile/shell/LiveProbe.kt").isFile,
    )
    assertFalse(
      "AdbState.kt 已删除：不得再有测试引用它",
      java.io.File("src/main/java/com/dsharnessmobile/shell/AdbState.kt").exists() ||
        java.io.File("app/src/main/java/com/dsharnessmobile/shell/AdbState.kt").exists(),
    )
  }

  // ── ST-13：握手非 101 → 按状态码走鉴权刷新；refresh 不得缓存短路 ─────────────

  @Test
  fun muxHandshakeRefusalGoesThroughTheAuthRecovery() {
    val code = codeOnly(source("MuxClient.kt"))
    assertTrue("必须按状态码判定", code.contains("muxHandshakeStatusCode(status)"))
    assertTrue("401/403 必须走鉴权刷新", code.contains("muxRefusalNeedsAuthRefresh(code)"))
    assertTrue("必须调 EngineAuth 的失效+刷新入口", code.contains("EngineAuth.handleUnauthorizedBound()"))
    assertFalse("旧的字符串包含判定必须消失（它无法区分 401 与其它拒绝）", code.contains("contains(\" 101\")"))
  }

  @Test
  fun engineAuthForcedRefreshDoesNotShortCircuitOnTheCache() {
    val code = codeOnly(source("EngineAuth.kt"))
    assertTrue("handleUnauthorized 必须走 force", code.contains("refresh(context, force = true)"))
    assertTrue("refresh 必须经可测的短路口", code.contains("mayReuseCachedCookie(force, cachedCookie)"))
    assertTrue("force 时必须先 invalidate（内存 + prefs）", code.contains("if (force) invalidate(app)"))
    assertFalse(
      "旧的缓存短路（无条件 return 缓存 cookie）必须消失",
      code.contains("cookie(app)?.let { return it }"),
    )
  }

  // ── ST-10 / ST-11：桥 getter 与壳侧真源 ──────────────────────────────────

  @Test
  fun bridgeExposesTheImmersiveGetterBackedByTheShellSource() {
    val code = codeOnly(source("AndroidBridge.kt"))
    assertTrue("ST-10：桥必须有 getter", code.contains("fun getImmersiveMode(): Boolean = onGetImmersiveMode()"))
    assertTrue("getter 默认读壳侧单一真源", code.contains("onGetImmersiveMode: () -> Boolean = { ImmersiveMode.current() }"))
  }

  @Test
  fun devLogGetterConjoinsThePreferenceWithTheRunningCollector() {
    val bridge = codeOnly(source("AndroidBridge.kt"))
    assertTrue(
      "ST-11：展示值 = 偏好 && 采集器在跑（拒绝乐观置位）",
      bridge.contains("onGetDevLogEnabled() && LogCollector.isRunning()"),
    )
    assertTrue("采集器必须暴露只读运行态", codeOnly(source("LogCollector.kt")).contains("fun isRunning(): Boolean = executor != null"))
  }

  @Test
  fun webUiChromeDelegatesInsteadOfKeepingASecondImplementation() {
    val code = codeOnly(source("WebUiChrome.kt"))
    assertTrue(code.contains("ImmersiveMode.isEnabled(activity)"))
    assertTrue(code.contains("ImmersiveMode.apply(activity, enabled)"))
    assertTrue(code.contains("ImmersiveMode.setEnabled(activity, enabled)"))
    assertFalse(
      "本类不得再持有第二份 prefs 读取（两份逐字重复实现 = 三方分裂的来源）",
      code.contains("getSharedPreferences(\"dsh_settings\""),
    )
    assertFalse(code.contains("systemUiVisibility = flags"))
  }

  @Test
  fun shellStateHoldsTheSingleSourcesAndTheIdempotentRestart() {
    val code = codeOnly(source("ShellState.kt"))
    assertTrue(code.contains("internal object ImmersiveMode"))
    assertTrue(code.contains("internal object DevLogControl"))
    assertTrue("日志开关事实 = 偏好 && 采集器在跑", code.contains("isPrefEnabled(context) && LogCollector.isRunning()"))
    assertTrue("onResume 幂等补启入口必须存在", code.contains("fun ensureStarted(context: Context): Boolean"))
    assertTrue("补启必须在偏好开且采集器不在跑时才动", code.contains("if (!LogCollector.isRunning())"))
  }

  // ── 性能 §7.2：C1（P-AC-03）与启动分段插桩（P-AC-04） ─────────────────────

  @Test
  fun shellEnvInjectsTheUvThreadPoolSize() {
    val code = codeOnly(source("EngineManager.kt"))
    assertTrue(
      "C1：shellEnv() 必须注入 UV_THREADPOOL_SIZE = min(8, cores)（引擎进程 env 只能由壳注入）",
      code.contains("\"UV_THREADPOOL_SIZE\" to uvThreadPoolSize(Runtime.getRuntime().availableProcessors())"),
    )
    assertTrue("取值函数必须封顶 8 且下探 1", code.contains("internal fun uvThreadPoolSize(cores: Int): Int = minOf(8, cores.coerceAtLeast(1))"))
  }

  // ── 0.14.1 块K ③（反馈三）：pnpm store 路径别名 ──────────────────────────────

  @Test
  fun shellEnvPinsThePnpmStoreDir() {
    // 判据（值这一半）：store 目录必须与 HOME 同源派生，且落在 pnpm 默认口径
    // （$HOME/.local/share/pnpm/store）——不改变既有 store 位置，已装 node_modules 元数据继续有效。
    // 注意：`File.path` 在 JVM(Windows) 与设备上分隔符不同，故**用 File 逐段比较**，
    // 不比较字符串（否则单测只能在某一平台过 = 假绿/假红）。
    val home = File(System.getProperty("java.io.tmpdir"), "dsh-pnpm-store-test-home")
    assertEquals(
      File(File(File(home, ".local"), "share"), "pnpm/store"),
      File(pnpmStoreDir(home)),
    )
    assertTrue("store 必须落在 HOME 之下（pnpm 默认口径）", File(pnpmStoreDir(home)).startsWith(home))
    // 反证：不得退化成其它位置（例如 profiles 下或 Termux 编译期写死的 /data/data/com.termux）。
    assertFalse("store 不得落在 Termux 编译期路径", pnpmStoreDir(home).contains("com.termux"))
    assertFalse("store 不得落在 profiles 下", pnpmStoreDir(home).contains("profiles"))

    // 判据（注入这一半）：shellEnv() 必须真的把它注入引擎/控制台子进程 env。
    val code = codeOnly(source("EngineManager.kt"))
    assertTrue(
      "③：shellEnv() 必须注入 npm_config_store_dir，否则 pnpm 仍按 CWD/HOME 自推、在 /data/data ↔ /data/user/0 两种写法间判「store 变了」",
      code.contains("\"npm_config_store_dir\" to pnpmStoreDir(homeDir)"),
    )
  }

  @Test
  fun bootSegmentsInstrumentationIsWiredOnBothEnds() {
    val collector = codeOnly(source("LogCollector.kt"))
    for (field in listOf("t_boot_start", "t_listen", "t_compose_total")) {
      assertTrue("P-AC-04：三字段之一缺失：" + field, collector.contains(field))
    }
    val manager = codeOnly(source("EngineManager.kt"))
    assertTrue("引擎启动时刻必须由 spawn 点标记", manager.contains("LogCollector.markBootStart(context)"))
    assertTrue("监听时刻必须由 spawn 起的观察线程标记", manager.contains("LogCollector.markListen(context)"))
    assertTrue("启动主路径必须兜底补一次 listen 标记", codeOnly(source("EngineStartFlow.kt")).contains("LogCollector.markListen(activity)"))
    assertTrue(
      "三字段行必须落壳侧自有判据文件（r10 设备实测：写 engine.log 会被引擎从自己的偏移覆盖）",
      collector.contains("SEGMENTS_FILE = \"boot-segments.log\"") &&
        collector.contains("private fun appendToSegmentsFile(ctx: Context, line: String)"),
    )
    assertFalse(
      "壳侧不得再写 engine.log（引擎 stdout 重定向文件；fd 非 append）",
      collector.contains("appendToEngineLogTail") || collector.contains("File(ctx.filesDir, \"engine.log\").appendText"),
    )
    assertTrue(
      "启动即落一行（引擎没起来时三字段仍在场）",
      collector.contains("emitBootSegments(context, \"note=boot-start\")"),
    )
    assertTrue(
      "compose 口径必须来自探针 TOTAL totalMs=（同源，判据差 <5%）",
      collector.contains("\\[perf\\] TOTAL calls=\\d+ totalMs=(\\d+)"),
    )
  }

  // ── §4.4 S0 死状态清理（ST-21 / ST-22 / ST-24） ──────────────────────────

  @Test
  fun bootReceiverNoLongerReadsTheDeadPreferenceKey() {
    val code = codeOnly(source("BootReceiver.kt"))
    assertFalse("ST-21：无写点的开机自启偏好键读取分支必须消失", code.contains("bootAllowsStart"))
    // review C9：开机自启不再是「无条件」——必须尊重用户手动关停（持久化的 userShutdown）。
    assertTrue("开机自启必须读持久化的用户停机状态", code.contains("isUserShutdownPersisted(context)"))
    assertTrue("用户关停过则不自启（日志留痕）", code.contains("NOT started"))
  }

  /**
   * ST-22 已**随内置 adb 退役而终结**（0.14.0 §6）。
   *
   * 原断言针对 `AdbState.kt` 的两个 prefs 访问器（删除读口、保留写口）。该文件整体随内置 adb
   * 删除，`KEY_FULLACCESS` 的读写通道不复存在，于是这条断言无从落地——**测试没跟着退役**。
   * 保留它作「不得复活」的守卫：AdbState.kt 不得回归（否则等于把已退役的 adb 授权面偷偷加回来）。
   */
  @Test
  fun adbStateStaysRetired() {
    assertFalse(
      "ST-22 终结：AdbState.kt 已随内置 adb 删除，不得复活",
      File("src/main/java/com/dsharnessmobile/shell/AdbState.kt").exists() ||
        File("app/src/main/java/com/dsharnessmobile/shell/AdbState.kt").exists(),
    )
  }


  // ── FX-211.2：来件守卫必须覆盖「投递 + 重试期」，全清须豁免 pending 面 ──────────

  @Test
  fun incomingGuardCoversDeliveryAndRetry() {
    val code = codeOnly(source("FileIncoming.kt"))
    val pipeline = code.substringAfter("fun processIncomingIntent")
    val inc = pipeline.indexOf("activeDeliveries.incrementAndGet()")
    val enqueue = pipeline.indexOf("enqueuePending(context, target.absolutePath)")
    val retry = pipeline.indexOf("while (System.currentTimeMillis() < deadline)")
    val dec = pipeline.indexOf("activeDeliveries.decrementAndGet()")
    assertTrue("守卫必须在投递前起跳", inc in 0 until enqueue)
    assertTrue("入待发清单必须在守卫内", enqueue in 0 until dec)
    assertTrue("20s 重试循环必须在守卫内（划掉应用不再丢件）", retry in 0 until dec)
    val cleanup = code.substringAfter("fun cleanupTmp(context: Context)")
    assertTrue(
      "全清必须同时看「拷贝」与「投递/重试」两个计数",
      cleanup.contains("workspaceWipeAllowed(activeCopies.get(), activeDeliveries.get())"),
    )
    assertTrue(
      "仍有 pending 或未 claim 草稿队列引用的来件与元数据条目不得随全清删除",
      cleanup.contains("cleanupDeletions(entries, pendingPaths(context), queuedSessionPaths(context))"),
    )
    assertTrue(".sessions 的既有豁免必须保留", code.contains("if (f.name == SESSIONS_ENTRY) continue"))
  }

  @Test
  fun incomingContentUriKeepsEncodedDocumentId() {
    val code = codeOnly(source("FileIncoming.kt"))
    assertTrue("content URI 必须原样 Uri.parse，保留 DocumentsProvider 的 %2F document id", code.contains("Uri.parse(uriString)"))
    assertFalse("不得对整个 content URI 做 URLDecoder（会把 document id 的 %2F 变路径分隔符）", code.contains("Uri.parse(URLDecoder.decode(uriString"))
  }

  @Test
  fun configTransferNoLongerWritesTheDeadSafList() {
    val code = codeOnly(source("ConfigTransfer.kt"))
    assertFalse("ST-24：无消费方的 SAF 目录留档表必须删除", code.contains("dsh-saf-dirs"))
    assertTrue("系统持久化授权本身必须保留（真源）", code.contains("takePersistableUriPermission"))
  }
}
