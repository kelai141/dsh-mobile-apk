package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 0.14.1 批 6「引导页 / 权限 / 更新」的行为回归（纯 JVM，无 Robolectric）。
 *
 * 对应审查档 §3.1 的 S1-1…S1-18。做法与批 2/批 5 一致：
 *  1. **纯函数判据**——语义直接可测（副文案仲裁、进度百分比、回撤文案、控制台状态契约）；
 *  2. **源码级判据**——需要 View/Activity/WebView 的形态（按钮锁、Toast、通知渠道名、
 *     JS 钩子接线）在 JVM 里跑不起来，就断言「修复形态在场 + 旧形态不在场」，撤掉修复即红。
 *
 * 设备层证据走三层验收的 B 轨（见 `docs/0.14.1-preview-UI-AUDIT.md` 的批 6 记录）。
 */
class GuideAndConsoleBatch6Test {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  private fun asset(name: String): String {
    val candidates = listOf(File("src/main/assets", name), File("app/src/main/assets", name))
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到前端资源 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  /** 只留代码行（注释里会复述旧实现作为背景，直接对全文断言会被自己的说明判红）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  // ── S1-2：副文案仲裁（旧实现五个来源无优先级抢写）──────────────────────────

  @Test
  fun `不可打断的副文案只能被同级或更高优先级顶掉`() {
    // 锁定期（正在解压/启动/回滚）：旁路回执与流程进度都不得顶掉相位文案。
    assertFalse(
      "旁路回执不得顶掉「正在更新运行时」",
      hintAccepted(HintSource.PHASE, currentSticky = true, incoming = HintSource.SIDE),
    )
    assertFalse(
      "流程进度也不得顶掉不可打断的相位文案",
      hintAccepted(HintSource.PHASE, currentSticky = true, incoming = HintSource.FLOW),
    )
    assertTrue(
      "相位文案之间可以互相顶（后一个相位就是新事实）",
      hintAccepted(HintSource.PHASE, currentSticky = true, incoming = HintSource.PHASE),
    )
    // 非锁定期：后写者赢（正常路径不受影响）。
    assertTrue(hintAccepted(HintSource.PHASE, currentSticky = false, incoming = HintSource.SIDE))
    assertTrue("还没有人写过时一律接受", hintAccepted(null, currentSticky = false, incoming = HintSource.SIDE))
    // 优先级顺序必须是 PHASE > FLOW > SIDE（改了这里必须连带想清文案归属）。
    assertTrue(HintSource.PHASE.priority > HintSource.FLOW.priority)
    assertTrue(HintSource.FLOW.priority > HintSource.SIDE.priority)
  }

  @Test
  fun `所有副文案写入都必须经唯一漏斗`() {
    val code = codeOnly(source("GuidePageRenderer.kt"))
    // 唯一一处直接写 statusHint.text（漏斗内部），其余一律走 pushHint。
    val direct = Regex(Regex.escape("chrome.statusHint.text =")).findAll(code).count()
    assertEquals("statusHint.text 只允许在 pushHint 里出现一次（旧实现有 5 处各自写）", 1, direct)
    assertTrue("必须存在仲裁漏斗", code.contains("private fun pushHint(text: String, source: HintSource"))
    assertTrue("相位文案走 PHASE", code.contains("pushHint(resolvedHint, HintSource.PHASE"))
    assertTrue("旁路回执走 SIDE", code.contains("pushHint(text, HintSource.SIDE)"))
  }

  // ── S1-3：自动恢复期间主按钮必须锁住 ─────────────────────────────────────

  @Test
  fun `自动恢复期间主按钮必须锁住且文案不是重试`() {
    val code = codeOnly(source("GuidePageRenderer.kt"))
    assertTrue(
      "lockPrimary 必须包含 Recovering——否则用户会去点一个与自动流程打架的「重试」",
      Regex("""phase == GuidePhase\.Recovering\s*$""", RegexOption.MULTILINE).containsMatchIn(code) ||
        code.contains("phase == GuidePhase.Recovering"),
    )
    assertTrue("Recovering 的按钮文案必须是「正在自动恢复」", code.contains("GuidePhase.Recovering -> activity.getString(R.string.ds_recovering)"))
    assertFalse(
      "不得再把 Recovering 归到 ds_retry（旧形态：Error, Recovering -> ds_retry）",
      code.contains("GuidePhase.Error, GuidePhase.Recovering -> activity.getString(R.string.ds_retry)"),
    )
  }

  // ── S1-4 → 0.14.2 P2：进度去数字 + 阶段车轱辘话（旧判据按新口径改写，不是删除）──

  @Test
  fun `阶段文案只有车轱辘话且不含任何数字`() {
    // 用户口径（2026-09-26 原话）：「改成不显示数字，只画一个进度条，然后底下小字就只显示：
    // 正在解压，正在处理残留数据，正在准备运行时这种车轱辘话」。
    assertTrue("至少要给三条阶段句（覆盖解压/残留/收尾）", RUNTIME_STAGE_PHRASES.size >= 3)
    for (phrase in RUNTIME_STAGE_PHRASES) {
      assertTrue("阶段句必须自证无数字无百分比：$phrase", stagePhraseHasNoNumbers(phrase))
    }
    // 三条必须点名用户说的那三类阶段（不能拿三句同义话凑数）。
    assertTrue("必须覆盖「正在解压」", RUNTIME_STAGE_PHRASES.any { it.contains("正在解压") })
    assertTrue("必须覆盖「正在处理残留数据」", RUNTIME_STAGE_PHRASES.any { it.contains("残留数据") })
    assertTrue("必须覆盖「正在准备运行时」", RUNTIME_STAGE_PHRASES.any { it.contains("准备运行时") })
  }

  @Test
  fun `阶段文案按 tick 确定轮换且负数不越界`() {
    // 轮换是「还在动」的唯一表达方式；确定性保证测试与 UI 读到同一条。
    assertEquals(RUNTIME_STAGE_PHRASES[0], runtimeStagePhrase(0))
    assertEquals(RUNTIME_STAGE_PHRASES[1], runtimeStagePhrase(1))
    assertEquals(RUNTIME_STAGE_PHRASES[2], runtimeStagePhrase(2))
    assertEquals("回到本轮第一句", RUNTIME_STAGE_PHRASES[0], runtimeStagePhrase(RUNTIME_STAGE_PHRASES.size))
    assertEquals("负数 tick 不得越界", RUNTIME_STAGE_PHRASES[RUNTIME_STAGE_PHRASES.size - 1], runtimeStagePhrase(-1))
    assertEquals(RUNTIME_STAGE_PHRASES[0], runtimeStagePhrase(-RUNTIME_STAGE_PHRASES.size))
  }

  @Test
  fun `进度面不再出现任何数字文案与确定档（设备实测缺陷）`() {
    // 设备读数（真机）：「已写入 1157 MB / 约 700 MB（99%）」——分子大于分母还报 99%。
    // 真因是分母（700MB）本身编造，而真实解压是增量的 ⇒ 任何固定分母都在造事实。
    // 本用例锁「三种数字输出全部下线 + 进度条恒不确定态 + 编造常数与其派生函数一并删除」。
    val code = codeOnly(source("GuidePageRenderer.kt"))
    // ① 编造的分母及其两个派生输出：一条都不许留（死码）。
    assertFalse("编造常数必须删除", code.contains("RUNTIME_UNCOMPRESSED_APPROX_BYTES"))
    assertFalse("百分比函数必须删除", code.contains("runtimeProgressPercent"))
    assertFalse("带数字的进度文案函数必须删除", code.contains("runtimeProgressLabel"))
    assertFalse("确定档入口必须删除（它宣称的正是编造比例）", code.contains("setDeterminateProgress"))
    assertFalse("进度状态位必须删除", code.contains("progressDeterminate"))
    // ② 三种数字输出的字面形态一个都不许回来。
    assertFalse("不得出现「已写入」", code.contains("已写入"))
    assertFalse("不得出现「约 」+ MB 的分母形态", code.contains("/ 约 "))
    assertFalse("不得出现百分比拼接", code.contains("%\"") || code.contains("%）") || code.contains("（\" + pct"))
    // ③ 进度条必须恒为不确定态（不宣称比例），且相位切换与阶段入口两处都要置位。
    val indeterminate = Regex(Regex.escape("progressBar.isIndeterminate = true")).findAll(code).count()
    assertTrue("相位切换处必须置不确定态", code.contains("progressBar.isIndeterminate = true"))
    assertTrue("进度条不得被切回确定态", !code.contains("isIndeterminate = pct") && !code.contains("progressBar.progress ="))
    assertTrue("确定态置位点至少两处（相位切换 + 阶段入口）: 实测 $indeterminate", indeterminate >= 2)
    // ④ 旧形态（旧注释里的实现在场即判红——反证锚点）。
    assertFalse("旧的确定档渲染不得留存桩", code.contains("val pct = runtimeProgressPercent"))
  }

  @Test
  fun `解压流程只推阶段轮换而不渲染任何数字`() {
    val flow = codeOnly(source("EngineStartFlow.kt"))
    // FX1-A：调用点从「次数驱动」改成「时间驱动」——传单调时钟而不是 tick 计数。
    // 旧形态 `showRuntimeStage(progressTick++)` = 每次回调换一句 = 用户看到的「一直在闪」。
    assertTrue(
      "流程必须走阶段入口（传单调时钟）",
      flow.contains("showRuntimeStage(SystemClock.elapsedRealtime())"),
    )
    assertFalse("不得退回按回调次数换句（闪的成因）", flow.contains("progressTick++"))
    assertTrue("刷新开始前必须复位轮换（第一句立刻可见、时间窗重新起算）", flow.contains("resetRuntimeStageRotation()"))
    assertFalse("流程不得再调确定档", flow.contains("setDeterminateProgress"))
    assertFalse("流程不得再拼带数字的进度文案", flow.contains("runtimeProgressLabel"))
    assertFalse("流程不得再引用编造常数", flow.contains("RUNTIME_UNCOMPRESSED_APPROX_BYTES"))
    // onStage 的 stage 句来自 EngineManager，本身就是无数字车轱辘话——直接沿用，不另造口径。
    assertTrue("onStage 必须沿用 EngineManager 的阶段句", flow.contains("progressText.text = stage"))
    // 反证：flow 里若出现任何字节数渲染（/ 1024 / 1024 或 MB 拼接）即判红。
    assertFalse("flow 不得做任何字节→MB 换算", flow.contains("/ 1024 / 1024"))
    assertFalse("flow 不得拼 MB", flow.contains("MB\"") || flow.contains(" MB"))
  }

  // ── FX1-A：阶段文案的时间轮换（修「一直在闪」）────────────────────────────

  /**
   * 反证核心 (a)：**同一时间窗内连续多次回调，文案不得变**——这就是「不闪」的机器判据。
   *
   * 旧实现按回调次数换句，而解压每 1MB 回调一次（2.5GB 约 2500 次、间隔 ~30ms），
   * 于是 1.3s 的窗内会换 40 多句。这里喂 2500 次「同一时刻附近」的回调，必须一次都不换。
   */
  @Test
  fun `同一时间窗内连续回调文案不得变（不闪的判据）`() {
    val r = RuntimeStageRotation(STAGE_ROTATE_INTERVAL_MS)
    val t0 = 1_000_000L
    // 首次调用立刻给一句（不得先空一个窗，否则用户看到的是「没反应」）。
    assertTrue("首次调用必须立刻放行", r.advanceIfDue(t0))
    val first = r.currentPhrase()
    assertEquals("首次必须显示第一句", RUNTIME_STAGE_PHRASES[0], first)
    // 窗内的 2500 次回调（模拟 2.5GB 解压：每 1MB 一次）全部必须被拒。
    var advanced = 0
    for (i in 1..2500) {
      val now = t0 + (i * 30L) % (STAGE_ROTATE_INTERVAL_MS - 1) // 始终落在同一个窗内
      if (r.advanceIfDue(now)) advanced++
    }
    assertEquals("同一窗内 2500 次回调一次都不许换句——换一次就是闪一次", 0, advanced)
    assertEquals("文案必须仍是第一句", first, r.currentPhrase())
    assertEquals("序号不得前进", 0, r.index)
  }

  /** 反证 (b)：跨过时间窗后**必须**推进到下一句（否则修成了「冻住」）。 */
  @Test
  fun `跨过时间窗后必须推进到下一句`() {
    val r = RuntimeStageRotation(STAGE_ROTATE_INTERVAL_MS)
    val t0 = 500L
    r.advanceIfDue(t0)
    val first = r.currentPhrase()
    // 差 1ms 还不到点：不得换。
    assertFalse("差 1ms 不得换句", r.advanceIfDue(t0 + STAGE_ROTATE_INTERVAL_MS - 1))
    assertEquals(first, r.currentPhrase())
    // 正好到点：必须换。
    assertTrue("到点必须换句", r.advanceIfDue(t0 + STAGE_ROTATE_INTERVAL_MS))
    assertEquals("必须推进到第二句", RUNTIME_STAGE_PHRASES[1], r.currentPhrase())
    assertEquals(1, r.index)
    // 再跨两窗：走满一轮并回绕，且期间每一句都仍是合法阶段句。
    assertTrue(r.advanceIfDue(t0 + STAGE_ROTATE_INTERVAL_MS * 2))
    assertEquals(RUNTIME_STAGE_PHRASES[2], r.currentPhrase())
    assertTrue(r.advanceIfDue(t0 + STAGE_ROTATE_INTERVAL_MS * 3))
    assertEquals("应回绕到第一句", RUNTIME_STAGE_PHRASES[0], r.currentPhrase())
    assertEquals("序号按模回绕（不靠 Int 溢出）", 0, r.index)
    for (p in RUNTIME_STAGE_PHRASES) assertTrue("轮换出的句子必须仍是无数字阶段句", stagePhraseHasNoNumbers(p))
  }

  /** 反证 (c)：异常输入（负 tick / 极大 tick / 时钟回拨）仍安全，且不制造闪烁或冻死。 */
  @Test
  fun `异常时钟输入下轮换既不闪也不冻`() {
    val r = RuntimeStageRotation(STAGE_ROTATE_INTERVAL_MS)
    // 时钟从 0 起（SystemClock.elapsedRealtime() 的合法值）——不能被当成「没有上次」。
    assertTrue("t=0 是合法时钟值，首次调用必须放行", r.advanceIfDue(0L))
    assertEquals(RUNTIME_STAGE_PHRASES[0], r.currentPhrase())
    // 时钟回拨：不得换句（否则抖动就变成连续换句），也不得让闸门永久卡死。
    assertFalse("时钟回拨不得换句", r.advanceIfDue(-100L))
    assertEquals("回拨期间文案不得变", RUNTIME_STAGE_PHRASES[0], r.currentPhrase())
    assertFalse("回拨后仍在新锚点的窗内，不得换句", r.advanceIfDue(-100L + STAGE_ROTATE_INTERVAL_MS - 1))
    assertTrue("回拨后跨过新锚点的一个窗必须能恢复轮换（不得冻死）", r.advanceIfDue(-100L + STAGE_ROTATE_INTERVAL_MS))
    // 极大时间戳：不得抛异常、不得越界。
    val huge = Long.MAX_VALUE - 1
    val okHuge = r.advanceIfDue(huge)
    assertTrue("极大时间戳后当前句仍在合法集合内", RUNTIME_STAGE_PHRASES.contains(r.currentPhrase()))
    assertEquals("极大时间戳后序号仍在合法范围", true, r.index in RUNTIME_STAGE_PHRASES.indices)
    // 极大之后再来一个「小」时间戳（等价回拨）：同样安全。
    r.advanceIfDue(1L)
    assertTrue("回拨后当前句仍合法", RUNTIME_STAGE_PHRASES.contains(r.currentPhrase()))
    assertTrue(okHuge || r.index in RUNTIME_STAGE_PHRASES.indices)
    // reset 后回到起点，且下一次调用立刻放行（相位重跑语义）。
    r.reset()
    assertEquals(0, r.index)
    assertEquals("reset 后 currentPhrase 回到第一句", RUNTIME_STAGE_PHRASES[0], r.currentPhrase())
    assertTrue("reset 后下一次调用必须立刻放行", r.advanceIfDue(9_999_999L))
    assertEquals(RUNTIME_STAGE_PHRASES[0], r.currentPhrase())
  }

  /** 间隔常量本身必须落在「人读得完一句」又不「像冻住」的区间（判据不是拍脑袋）。 */
  @Test
  fun `轮换间隔落在可读且不僵死的区间`() {
    assertTrue(
      "低于 1.2s 会被读成「在抖」而不是一句完整的话（实测 $STAGE_ROTATE_INTERVAL_MS ms）",
      STAGE_ROTATE_INTERVAL_MS >= 1_200L,
    )
    assertTrue(
      "高于 1.5s 长时间解压会让人怀疑界面冻住（实测 $STAGE_ROTATE_INTERVAL_MS ms）",
      STAGE_ROTATE_INTERVAL_MS <= 1_500L,
    )
  }

  // ── S1-5：诊断包路径不得进标题 ───────────────────────────────────────────

  @Test
  fun `错误标题不得拼诊断包绝对路径`() {
    val flow = codeOnly(source("EngineStartFlow.kt"))
    assertFalse(
      "标题里不得再拼 diagnosticsLocationHint（旧形态把绝对路径塞进 18sp 标题，窄屏撑成三行）",
      flow.contains("\"运行时更新失败（\" + diagnosticsLocationHint(dir) + \"）\""),
    )
    assertFalse(
      "引擎启动失败的标题同样",
      flow.contains("\"引擎启动失败（\" + diagnosticsLocationHint(dir) + \"）\""),
    )
    assertTrue("标题只说事实", flow.contains("GuidePhase.Error,\n                \"运行时更新失败\",") || flow.contains("\"运行时更新失败\","))
    assertTrue("路径挪到副文案", flow.contains("diagnosticsLocationHint(dir) + \"。可复制该路径或打开控制台查看 engine.log。\""))
  }

  // ── S1-6：回撤文案不再是内部判定句 ───────────────────────────────────────

  @Test
  fun `回撤不可用的副文案必须是用户口径`() {
    val internal = "插件清单已变化但点名不出失败插件：不做整份回滚（避免连用户其它插件一起回退）"
    val shown = undoUnavailableHint(internal)
    assertFalse("不得把内部判定句原样当副文案", shown.contains("点名不出失败插件"))
    assertTrue("必须说清「没有回滚」这件事（用户要知道自己的插件没被动）", shown.contains("没有"))
    assertTrue("必须给下一步", shown.contains("控制台"))
    assertTrue("超时与「无快照」必须给出不同的说法", undoUnavailableHint("急救 CLI 超时：快照清单状态未知（非「无快照可回滚」）").contains("超时"))
    assertTrue("无快照可回滚", undoUnavailableHint("无快照可回滚").contains("回滚点"))
    assertTrue("未知摘要必须落到兜底句而不是空", undoUnavailableHint("??? ").contains("自动回撤没能完成"))
    val flow = codeOnly(source("EngineStartFlow.kt"))
    assertFalse("调用点不得再用 summary.take(120)", flow.contains("result.summary.take(120)"))
    assertTrue(flow.contains("undoUnavailableHint(result.summary)"))
  }

  // ── S1-1：复制日志不得静默 ───────────────────────────────────────────────

  @Test
  fun `日志不存在时复制必须有回执`() {
    val code = codeOnly(source("GuidePageRenderer.kt"))
    assertTrue("必须给出「没有可复制的日志」回执", code.contains("R.string.ds_copy_log_empty"))
    assertFalse("不得再静默 return", code.contains("if (text.isNullOrBlank()) return"))
    assertTrue("成功也要回执", code.contains("R.string.ds_log_copied"))
  }

  // ── S1-7 / S1-8 / S1-9：存储 chip 的观感与动作 ───────────────────────────

  @Test
  fun `可点 chip 与纯事实 chip 必须外观可分`() {
    val chrome = codeOnly(source("GuideChrome.kt"))
    assertTrue("必须有按状态切换观感的入口", chrome.contains("internal fun styleStorageChip("))
    assertTrue("可动作用强调色描边", chrome.contains("DsUi.roundRect(activity.getColor(R.color.ds_chip), pill, ink, hairline)"))
    assertTrue("纯事实用中性色无描边", chrome.contains("DsUi.roundRect(activity.getColor(R.color.ds_chip), pill)"))
    assertFalse(
      "构建期不得再无条件绑定 onGrantStorage（旧形态：任何状态点它都弹授权页）",
      chrome.contains("setOnClickListener { callbacks.onGrantStorage() }"),
    )
    val renderer = codeOnly(source("GuidePageRenderer.kt"))
    assertTrue("动作随状态走", renderer.contains("runStorageChipAction(action)"))
    assertTrue("未探测时重新探测", renderer.contains("StorageChipAction.PROBE_AGAIN"))
    assertTrue("写入失败时复制失败详情", renderer.contains("StorageChipAction.COPY_FAILURE_DETAIL"))
  }

  // ── S1-10：授权页拉不起来不得谎报 ────────────────────────────────────────

  @Test
  fun `授权页拉起结果必须如实回报`() {
    val checker = codeOnly(source("UpdateChecker.kt"))
    assertTrue(
      "requestInstallPermission 必须返回 Boolean（旧实现 void：两级 catch 都失败也不吭声）",
      checker.contains("fun requestInstallPermission(activity: android.app.Activity): Boolean"),
    )
    assertTrue("两条路径都成功才回 true", checker.contains("return true") && checker.contains("return false"))
    val renderer = codeOnly(source("GuidePageRenderer.kt"))
    assertTrue("调用方必须按结果分支", renderer.contains("if (opened)"))
    assertTrue("拉不起来时给可执行的替代路径", renderer.contains("R.string.ds_apk_permission_page_failed"))
  }

  // ── S1-11 / S1-12：通知权限 ──────────────────────────────────────────────

  @Test
  fun `冷启动不得弹通知权限且渠道名不得是 dsh`() {
    val activity = codeOnly(source("MainActivity.kt"))
    assertFalse(
      "onCreate 里不得再直接 launch 通知权限（旧形态：应用刚打开、用户还不知道这是干什么的就弹窗）",
      activity.contains("registerNotificationAsync"),
    )
    assertTrue("冷启动只记录状态", activity.contains("noteNotificationPermissionState()"))
    assertTrue("到需要时才请求", activity.contains("fun ensureNotificationPermission(rationale: String): Boolean"))
    assertTrue("前提说明必须在请求之前给出", activity.contains("Toast.makeText(this, rationale, Toast.LENGTH_LONG).show()"))
    assertTrue("一次会话只请求一次", activity.contains("notifPermissionAsked"))
    assertTrue(
      "渠道名必须来自字符串资源（旧形态 NotificationChannel(\"dsh\", \"dsh\", …) 在系统里就显示 dsh）",
      activity.contains("getString(R.string.ds_notify_channel_name)"),
    )
    assertFalse("不得再把渠道名写成 dsh", activity.contains("NotificationChannel(\"dsh\", \"dsh\""))
    assertTrue("渠道 ID 必须仍是 dsh（保留用户既有渠道设置）", activity.contains("private const val NOTIF_CHANNEL_ID = \"dsh\""))
  }

  @Test
  fun `通知权限缺失时内容不得被吞掉`() {
    val activity = codeOnly(source("MainActivity.kt"))
    assertTrue(
      "内容必须先在应用内落地（Toast title+text）再退出——这是「不丢」的实现",
      activity.contains("Toast.makeText(this, title + \"：\" + text, Toast.LENGTH_LONG).show()"),
    )
    assertFalse(
      "不得再只 launch 然后 return（旧形态：内容消失，而调用点都是引擎重启/导出结果这类必须知道的事）",
      activity.contains("notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)\n      return"),
    )
  }

  // ── S1-13 / S1-14 / S1-15：首屏解释、版本号、最大宽度 ────────────────────

  @Test
  fun `首屏必须解释这是什么与为什么授权`() {
    val chrome = codeOnly(source("GuideChrome.kt"))
    assertTrue("品牌区必须有解释行", chrome.contains("R.string.ds_brand_explain"))
    val renderer = codeOnly(source("GuidePageRenderer.kt"))
    assertTrue(
      "Idle 副文案必须说明存储权限的用途（不是劝，是说清为什么）",
      renderer.contains("首次使用需授予存储权限"),
    )
  }

  @Test
  fun `版本号 pill 必须单行省略且宽度受限`() {
    val chrome = codeOnly(source("GuideChrome.kt"))
    assertTrue("单行", chrome.contains("maxLines = 1"))
    assertTrue("省略号", chrome.contains("ellipsize = TextUtils.TruncateAt.END"))
    assertTrue("宽度上限（否则长版本号把标题挤成两行）", chrome.contains("maxWidth = (res.displayMetrics.widthPixels * 0.34f).toInt()"))
  }

  @Test
  fun `ds_guide_max_width 必须真的被引用`() {
    val chrome = codeOnly(source("GuideChrome.kt"))
    assertTrue("必须引用该 dimen（旧形态：全仓零引用，平板/折叠屏上卡片拉满整屏）", chrome.contains("R.dimen.ds_guide_max_width"))
    assertTrue("必须同时用上 gutter", chrome.contains("R.dimen.ds_guide_gutter"))
    assertTrue("宽度变化时要重算（旋转/分屏）", chrome.contains("addOnLayoutChangeListener"))
  }

  // ── S1-16 / S1-17 / S1-18：控制台 ────────────────────────────────────────

  /** 剥掉 HTML/JS 注释（注释里会复述旧实现作为背景，直接对全文断言会被自己的说明判红）。 */
  private fun htmlCode(src: String): String =
    src.replace(Regex("""/\*[\s\S]*?\*/"""), "")
      .lineSequence()
      .filterNot { it.trimStart().startsWith("//") }
      .joinToString("\n")

  @Test
  fun `控制台状态是显式契约而不是文案正则`() {
    val html = htmlCode(asset("console.html"))
    assertFalse(
      "不得再对文案做子串正则判就绪（旧形态 /已启动/ 与 /退出|失败|缺失/）",
      html.contains("/已启动/") || html.contains("退出|失败|缺失"),
    )
    assertTrue("必须按显式状态判", html.contains("window.__consoleState = function (state, text)"))
    assertTrue("快照缺失必须是独立状态", html.contains("missingState"))
    assertTrue("缺失时按钮换语义而不是留一个必然失败的重连", html.contains("restartBtn.textContent = missingState ? '返回应用' : '重连'"))
    assertTrue("缺失时必须说清怎么办", html.contains("快照缺失：控制台依赖运行时里的 bash"))
    val act = codeOnly(source("ConsoleActivity.kt"))
    assertTrue("壳侧必须推状态+文案两个参数", act.contains("window.__consoleState && window.__consoleState("))
    // 状态 wire 字符串是两侧共享契约：改名即与页面失配。
    assertEquals("starting", ConsoleSession.State.STARTING.wire)
    assertEquals("ready", ConsoleSession.State.READY.wire)
    assertEquals("failed", ConsoleSession.State.FAILED.wire)
    assertEquals("exited", ConsoleSession.State.EXITED.wire)
    assertEquals("missing", ConsoleSession.State.MISSING.wire)
    val wires = ConsoleSession.State.entries.map { it.wire }
    assertEquals("状态 wire 必须互不相同", wires.size, wires.toSet().size)
  }

  @Test
  fun `引擎离线必须给动作`() {
    val html = asset("console.html")
    assertTrue("离线文案要指向可点的动作", html.contains("引擎离线（点此重试）"))
    assertTrue("必须有一行说清出路", html.contains("setEngineHint("))
    assertTrue("引擎栏必须可点重试", html.contains("document.getElementById('enginePill').addEventListener('click'"))
    assertTrue("必须有承载说明的元素", html.contains("id=\"engineHint\""))
  }
}