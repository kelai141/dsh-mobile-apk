package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 通知面源码门禁（§6.3.2 / §6.7.1 的 L0-L1 层，纯 JVM）：把「不得实现」清单与接线纪律
 * 变成撤掉修复即变红的断言。与 CallSiteContractTest 同思路（对源码断言调用点与真源表达式）。
 *
 * 覆盖的验收条目：NT-01/02/03（渠道与自检）、NT-04（六类 kind）、NT-07（不再走轮询调用点）、
 * NT-09（双读不双发）、NT-11（专用流独立于悬浮球）、NT-15（动作不 startActivity / 无 FSI）、
 * NT-16（RemoteInput mutable）、NT-17（失败可见）、NT-21（无常驻授权承诺）、NT-22/23（D13/D14）。
 */
class NotificationContractTest {

  private fun find(candidates: List<String>): File {
    val f = candidates.map { File(it) }.firstOrNull { it.isFile }
      ?: throw AssertionError(
        "找不到源文件 " + candidates.joinToString(" / ") + "（工作目录 = " + File(".").absolutePath + "）",
      )
    return f
  }

  private fun shellSource(name: String): String = find(
    listOf(
      "src/main/java/com/dsharnessmobile/shell/" + name,
      "app/src/main/java/com/dsharnessmobile/shell/" + name,
    ),
  ).readText()

  private fun manifest(): String = find(
    listOf("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml"),
  ).readText()

  private fun bridgeSource(): String = find(
    listOf(
      "../plugins/dsh-android-bridge/src/index.ts",
      "plugins/dsh-android-bridge/src/index.ts",
      "../../plugins/dsh-android-bridge/src/index.ts",
    ),
  ).readText()

  /** 去掉注释行（形态名出现在注释里不算命中——与门禁只看代码的口径一致）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /** 取成员体：从签名起，到下一个同级 private/internal fun 声明为止。 */
  private fun memberBody(src: String, signature: String): String {
    val idx = src.indexOf(signature)
    if (idx < 0) throw AssertionError("找不到成员签名 " + signature)
    val rest = src.substring(idx + signature.length)
    val cut = listOf("\n  private fun ", "\n  internal fun ", "\n  fun ", "\n  override fun ")
      .map { rest.indexOf(it) }.filter { it >= 0 }.minOrNull() ?: rest.length
    return rest.substring(0, cut)
  }

  private val notifyFiles = listOf(
    "NotifyCenter.kt", "NotifyStore.kt", "NotifyBridge.kt", "NotifyDecisionQueue.kt", "NotifyActionReceiver.kt",
    "NotifyProbe.kt",
  )

  // ── DEF-NOTIFY-01 / DEF-NOTIFY-02：设备实测抓到的两条真缺陷，撤掉修复即变红 ──

  @Test
  fun 单条事件的popup标志必须有消费点() {
    val code = codeOnly(shellSource("NotifyCenter.kt"))
    assertTrue("DEF-01：notifyEvent 必须消费 entry.popup", code.contains("formDecision(face, entry.popup)"))
    assertTrue("DEF-01：popup=false 必须走静默降级分支", code.contains("form.degradeToSilent"))
    assertTrue("DEF-01：降级路径必须换到静默渠道", code.contains("channelFor(app, Face.SILENT)"))
    assertTrue("DEF-01：降级条目必须补静默标志", code.contains("silentOverride"))
    assertTrue(code.contains("fun formDecision("))
  }

  @Test
  fun 交互类不被前台抑制丢弃() {
    val code = codeOnly(shellSource("NotifyCenter.kt"))
    assertTrue(
      "DEF-02：前台抑制只允许作用于 report",
      code.contains("face == Face.REPORT && foreground && suppressForeground(app)"),
    )
    assertFalse("不得再对全部弹窗类做前台抑制", code.contains("face.popup && foreground && suppressForeground"))
  }

  @Test
  fun 投递与帧处理都不允许把异常冒到读线程() {
    val center = codeOnly(shellSource("NotifyCenter.kt"))
    assertTrue("DEF-02：notifyEvent 必须有 Throwable 边界", center.contains("notifyEvent THREW"))
    assertTrue("DEF-02：必须有 ERROR 结果值", center.contains("ERROR,"))
    val bridge = codeOnly(shellSource("NotifyBridge.kt"))
    assertTrue("DEF-02：帧处理必须有 Throwable 边界", bridge.contains("frame handling THREW"))
  }

  @Test
  fun 启动触发点必须重评滞留决策的预算() {
    // 真缺陷（2026-09-13 设备实测）：进程死亡带走重试定时器 + 未就绪期无 flush 触发点
    // → 预算永不被评估 → 决策永久滞留 pending（既不补投也不出现可见失败）。
    val bridge = codeOnly(shellSource("NotifyBridge.kt"))
    assertTrue("NotifyBridge.start 必须调 ensureScheduled", bridge.contains("NotifyDecisionQueue.ensureScheduled(context)"))
    val queue = codeOnly(shellSource("NotifyDecisionQueue.kt"))
    assertTrue("必须有自愈入口", queue.contains("fun ensureScheduled(context: Context)"))
    assertTrue("必须有纯函数重评计划", queue.contains("fun resumePlan("))
    assertTrue("必须在后台线程（主线程会 ANR）", queue.contains("notify-resume"))
  }

  @Test
  fun NOT_READY等待必须有独立退避与墙钟预算() {
    // 2026-09-13 设备实测：引擎冷启动可 >60s；NOT_READY 旧实现恒 2s 重试、不递增、无上限 → 永不失败。
    val queue = codeOnly(shellSource("NotifyDecisionQueue.kt"))
    assertTrue("必须有墙钟预算常量", queue.contains("NOT_READY_BUDGET_MS"))
    assertTrue("必须有独立计数 waitAttempts", queue.contains("waitAttempts"))
    assertTrue("必须有统一处置入口", queue.contains("handleNotReady("))
    assertTrue("到期必须落到可见失败态", queue.contains("postDeliveryFailure(context, d.kind, d.eventId"))
    assertTrue("必须保留实测冷启动上限常量（不许按 60s 卡死）", queue.contains("ENGINE_COLD_START_OBSERVED_MS"))
  }

  @Test
  fun 通知栏提交成功后必须本地结算通知() {
    // DEF-NOTIFY-03（设备实测）：网关只给其它持有者发 cancel，提交者收不到——
    // 提交成功不本地结算，通知就停在「正在发送」并留着可再点的回复框。
    val queue = codeOnly(shellSource("NotifyDecisionQueue.kt"))
    assertTrue("OK 分支必须本地结算", queue.contains("NotifyBridge.markSettled(context, d.eventId, d.kind)"))
    val bridge = codeOnly(shellSource("NotifyBridge.kt"))
    assertTrue("markSettled 不得依赖 pending 表存在才撤通知", bridge.contains("val k = kind ?: p?.kind ?: \"question\""))
    // DEF-NOTIFY-03b（平台契约）：直接回复过的通知被系统加 LIFETIME_EXTENDED_BY_DIRECT_REPLY，
    // cancel() 被忽略；必须先同 (tag,id) 重投一次再撤。
    assertTrue("结算必须走 settleInteractive（重投后撤）", bridge.contains("NotifyCenter.settleInteractive(context, k, eventId)"))
    val centerTxt = codeOnly(shellSource("NotifyCenter.kt"))
    assertTrue("必须有 settleInteractive 载体", centerTxt.contains("fun settleInteractive("))
    assertTrue("必须先 notify 同 id 再 cancel", centerTxt.contains("settle re-post ok"))
  }

  @Test
  fun 应答流必须有耐久探针与连接心跳() {
    val bridge = codeOnly(shellSource("NotifyBridge.kt"))
    assertTrue("必须落探针（设备复验判定断点）", bridge.contains("NotifyProbe.log"))
    assertTrue("必须记 waterfall 事件", bridge.contains("waterfall event="))
    assertTrue("必须记投递结果", bridge.contains("result="))
    assertTrue("必须有连接心跳线程", bridge.contains("notify-probe"))
    val probe = shellSource("NotifyProbe.kt")
    assertTrue("探针文件必须可 run-as 读", probe.contains("notify-responder.log"))
    assertFalse("探针不得把整条正文写进去", probe.contains("bigText"))
  }

  // ── NT-15 / NT-16：动作面与 trampoline 禁令 ─────────────────────────────

  @Test
  fun 动作处理器全程不启动Activity() {
    for (name in listOf("NotifyActionReceiver.kt", "NotifyDecisionQueue.kt", "NotifyBridge.kt")) {
      val code = codeOnly(shellSource(name))
      assertFalse(name + " 的动作路径不得 startActivity（trampoline 禁令）", code.contains("startActivity("))
    }
  }

  @Test
  fun 不使用fullScreenIntent_代码与清单双断言() {
    for (name in notifyFiles) {
      assertFalse(name + " 不得使用 full-screen intent（§6.1.3 R3）", codeOnly(shellSource(name)).contains("setFullScreenIntent"))
    }
    assertFalse("清单不得声明 USE_FULL_SCREEN_INTENT", manifest().contains("USE_FULL_SCREEN_INTENT"))
  }

  @Test
  fun RemoteInput_回复动作才开mutable且显式关闭生成回复() {
    val code = codeOnly(shellSource("NotifyCenter.kt"))
    assertTrue("回复动作必须用 RemoteInput", code.contains("RemoteInput.Builder(NotifyActionReceiver.REPLY_KEY)"))
    assertTrue("必须 FLAG_MUTABLE（结果经 ClipData 注入）", code.contains("FLAG_MUTABLE"))
    assertTrue("只有回复动作开 mutable", code.contains("ACTION_REPLY, mutable = true"))
    assertTrue("必须关闭生成式回复", code.contains("setAllowGeneratedReplies(false)"))
    assertTrue("动作 Intent 必须是显式（component = 本包 receiver）", code.contains("Intent(app, NotifyActionReceiver::class.java)"))
  }

  @Test
  fun 审批动作恒为两个() {
    val body = memberBody(shellSource("NotifyCenter.kt"), "private fun addApprovalActions(")
    assertEquals("审批动作数必须恰为 2（批准一次 / 拒绝）", 2, body.split("Action.Builder(").size - 1)
    assertEquals("审批 addAction 调用必须恰为 2", 2, body.split("b.addAction(").size - 1)
  }

  @Test
  fun 通知面不得出现常驻授权承诺文案() {
    val forbidden = listOf("永久允许", "记住选择", "always allow", "always-allow", "allow-always")
    for (name in notifyFiles) {
      val src = shellSource(name)
      for (word in forbidden) {
        assertFalse(name + " 不得出现「" + word + "」", src.contains(word, ignoreCase = true))
      }
    }
    // 协议闭集：审批只有 allowed-once / rejected 两个结局词汇
    val receiver = shellSource("NotifyActionReceiver.kt")
    assertTrue(receiver.contains("\"allowed-once\""))
    assertTrue(receiver.contains("\"rejected\""))
  }

  // ── 清单加固（准确口径：不存在通知动作 receiver 之外的断言）─────────────

  @Test
  fun 存在通知动作receiver且exported为false() {
    val m = manifest()
    val idx = m.indexOf(".NotifyActionReceiver")
    assertTrue("清单必须声明 NotifyActionReceiver", idx > 0)
    val block = m.substring(idx, m.indexOf("/>", idx).let { if (it < 0) m.length else it })
    assertTrue("通知动作 receiver 必须 exported=false", block.contains("android:exported=\"false\""))
    assertFalse("通知动作 receiver 不得 exported=true", block.contains("android:exported=\"true\""))
    // 口径校正：本 manifest 早已有两个 exported=true 的 receiver —— 断言不得写成「receiver 数量 == 0」
    val exportedTrue = Regex("android:exported=\"true\"").findAll(m).count()
    assertTrue("manifest 既有 exported=true 的 receiver 仍在（断言不得写成数量为 0）", exportedTrue >= 2)
    assertTrue("receiver 声明总数 >= 3（含通知动作 receiver）", m.split("<receiver").size - 1 >= 3)
  }

  // ── NT-07 / NT-09 / NT-11：接线与独立性 ─────────────────────────────────

  @Test
  fun 看门狗不再直接投递通知_改走双读不双发回退() {
    val code = codeOnly(shellSource("WatchdogV2.kt"))
    assertTrue("NT-07：标记消费必须改走 NotifyStore.legacyFallback", code.contains("NotifyStore.legacyFallback("))
    assertFalse("NT-07：consumeTaskDoneMarkers 不得再直连 NotifyCenter.notify", code.contains("NotifyCenter.notify("))
    assertFalse("D14：不得回落字面量「任务完成」", code.contains("\"任务完成\""))
  }

  @Test
  fun 通知应答流独立于悬浮球() {
    val bridge = codeOnly(shellSource("NotifyBridge.kt"))
    assertTrue("必须用专用 streamId", bridge.contains("dsh-notify-responder"))
    assertTrue("必须自建 MuxClient", bridge.contains("MuxClient("))
    assertFalse("不得引用悬浮球服务", bridge.contains("OverlayService"))
    assertFalse("不得引用悬浮球面板", bridge.contains("OverlayPanel"))
    assertTrue("cancel 帧必须撤通知", bridge.contains("markSettled("))
    // 消费点与应答流挂在常驻引擎服务上（不是悬浮球）
    val engine = codeOnly(shellSource("EngineService.kt"))
    assertTrue("EngineService 必须启动信道消费", engine.contains("NotifyStore.start(this)"))
    assertTrue("EngineService 必须启动应答流", engine.contains("NotifyBridge.start(this)"))
  }

  @Test
  fun 双读不双发门与偏移消费在场() {
    val store = codeOnly(shellSource("NotifyStore.kt"))
    assertTrue("必须按字节偏移消费", store.contains("drainBytes("))
    assertTrue("必须持久化偏移", store.contains("KEY_OFFSET"))
    assertTrue("必须有双读不双发门", store.contains("notifyChannelActive"))
    assertTrue("轮转残段要补读", store.contains("ROTATED_NAME"))
    assertFalse("不得用 readLines + writeText 清空旧形态", store.contains("writeText(\"\")"))
  }

  @Test
  fun 失败必须可见且退避封顶60秒() {
    val queue = codeOnly(shellSource("NotifyDecisionQueue.kt"))
    assertTrue(queue.contains("postDeliveryFailure"))
    assertTrue(queue.contains("MAX_BACKOFF_MS = 60_000"))
    assertTrue("先落盘再发送", queue.contains("enqueue(") && queue.contains("appendText("))
    assertTrue(queue.contains("requestId"))
    assertTrue("失效场景要有专门提示", shellSource("NotifyDecisionQueue.kt").contains("该请求已失效"))
    // 文案归属：失败/失效文案由「做终局判定的那一处」给出（NotifyDecisionQueue 的 FAILED/EXPIRED 分支），
    // NotifyCenter 只提供可见态载体 postDeliveryFailure(...)。断言此前指错了文件（测试缺陷）。
    assertTrue("失败文案必须在场", shellSource("NotifyDecisionQueue.kt").contains("提交失败，点击重试"))
    assertTrue("可见态载体必须在场", codeOnly(shellSource("NotifyCenter.kt")).contains("fun postDeliveryFailure("))
  }

  // ── NT-01/02/03/04：渠道、迁移、自检、六类 kind ─────────────────────────

  @Test
  fun 渠道不可逆约束与迁移判定在场() {
    val code = codeOnly(shellSource("NotifyCenter.kt"))
    assertTrue("先查再建", code.contains("getNotificationChannel("))
    assertTrue("S3/S4 需要 hasUserSetImportance", code.contains("hasUserSetImportance()"))
    assertTrue("一次性初始化标记", code.contains("channelsInitialized"))
    assertTrue("候选序列常量表", code.contains("candidates"))
    assertTrue("选中项落 prefs（不得硬编码渠道 ID）", code.contains("KEY_SELECTED_PREFIX"))
  }

  @Test
  fun 自检面四类事实齐全且不可自检项如实标注() {
    val code = codeOnly(shellSource("NotifyCenter.kt"))
    assertTrue(code.contains("areNotificationsEnabled()"))
    assertTrue(code.contains("hasUserSetImportance()"))
    assertTrue(code.contains("hasUserSetSound()"))
    assertTrue("用户是否关掉弹出必须显示为无法检测", code.contains("\"无法检测\""))
    assertTrue("应用级深链", code.contains("ACTION_APP_NOTIFICATION_SETTINGS"))
    assertTrue("渠道级深链", code.contains("ACTION_CHANNEL_NOTIFICATION_SETTINGS"))
  }

  @Test
  fun 六种kind都有分流与未知kind显式忽略() {
    val code = codeOnly(shellSource("NotifyCenter.kt"))
    for (kind in listOf("silent", "todo", "report", "question", "approval", "resolve")) {
      assertTrue("kind 分流缺 " + kind, code.contains("\"" + kind + "\""))
    }
    assertTrue("未知 kind 必须显式忽略并记日志", code.contains("unknown kind"))
    val store = codeOnly(shellSource("NotifyStore.kt"))
    assertTrue("消费侧对未知 kind 也要记日志", store.contains("unknown kind"))
  }

  @Test
  fun 静默两类双保险且进度条形态在场() {
    val code = codeOnly(shellSource("NotifyCenter.kt"))
    assertTrue("实例级 setSilent 是第二道保险", code.contains("setSilent(true)"))
    assertTrue("静默渠道层关声音", code.contains("setSound(null, null)"))
    assertTrue("待办进度用 setProgress", code.contains("setProgress("))
    assertTrue("静默类单条覆盖", code.contains("setOnlyAlertOnce(true)"))
  }

  // ── NT-22/23：引擎侧 D13/D14 ────────────────────────────────────────────

  @Test
  fun 引擎侧不得复活D13与D14误读() {
    val code = codeOnly(bridgeSource())
    assertFalse("D14：不得读 session.header.title", code.contains(".header?.title") || code.contains("header.title"))
    assertFalse("D13：不得把 reason 当 outcome", code.contains("outcome === 'success'") || code.contains("d?.outcome"))
    assertTrue("D13：turn/end 必须走 turnEndOk", code.contains("turnEndOk("))
  }

  @Test
  fun 引擎侧新信道写入在场且旧信道保留一个迭代周期() {
    val src = bridgeSource()
    assertTrue(src.contains(".notify.ndjson"))
    assertTrue(src.contains("kind: 'report'"))
    assertTrue(src.contains("kind: 'todo'"))
    assertTrue("旧信道兼容期保留", src.contains(".task-done.ndjson"))
  }
}
