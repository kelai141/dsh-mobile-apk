package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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

  /** 页面侧（dsh-client-ui-responsive）源文件：apk 仓镜像与本仓权威源两种布局都接受。 */
  private fun uiSource(rel: String): String = find(
    listOf(
      "../dsh-client-ui-responsive/" + rel,
      "dsh-client-ui-responsive/" + rel,
      "../../dsh-client-ui-responsive/" + rel,
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

  // ── 0.14.1 块J：前台抑制默认关闭 + 抑制=延后 + 可见反馈 + 设置入口 ──────────

  @Test
  fun 前台抑制默认值必须是false() {
    // 用户 2026-09-19 拍板取 A：「前台也发系统通知（真·实时）」。
    val code = codeOnly(shellSource("NotifyCenter.kt"))
    assertTrue("默认值必须由常量承载（不得散落字面量）", code.contains("DEFAULT_SUPPRESS_FOREGROUND = false"))
    assertTrue("读口必须以该常量为默认值（缺键即「不抑制」）",
      code.contains("getBoolean(KEY_SUPPRESS_FOREGROUND, DEFAULT_SUPPRESS_FOREGROUND)"))
    assertFalse("不得残留缺键返回 true 的旧默认值",
      code.contains("getBoolean(KEY_SUPPRESS_FOREGROUND, true)"))
  }

  @Test
  fun 抑制必须是延后而非丢弃() {
    // FIX-1：旧实现命中抑制即 return 终态 → 该条永久消失（消费侧已推进字节偏移）。
    val code = codeOnly(shellSource("NotifyCenter.kt"))
    assertTrue("命中抑制必须入待投队列", code.contains("NotifySuppressQueue.enqueue(app, entry, deferredKey(entry))"))
    val queue = codeOnly(shellSource("NotifySuppressQueue.kt"))
    assertTrue("队列必须有 TTL（防退后台弹一堆陈旧汇报）", queue.contains("TTL_MS"))
    assertTrue("队列必须有界", queue.contains("MAX_PENDING") && queue.contains("MAX_DELIVER_PER_FLUSH"))
    assertTrue("补投必须复用正常投递路径（不得自建第二份投递实现）",
      code.contains("fun deliverDeferred(") && queue.contains("NotifyCenter.deliverDeferred(app, item.entry)"))
  }

  @Test
  fun listener必须有真实实现且被有界注册() {
    // FIX-2：listener 旧态全仓零赋值 → onForegroundSuppressed 是空操作（静默失败形态）。
    val code = codeOnly(shellSource("NotifyCenter.kt"))
    assertTrue("必须有默认 listener 实现", code.contains("ShellListener : Listener"))
    assertTrue("必须有幂等安装入口", code.contains("fun installShellListener()"))
    assertTrue("反馈必须复用既有 flashStatus（不得新造第二套提示面）", code.contains("OverlayService.instance?.flashStatus(msg)"))
    val store = codeOnly(shellSource("NotifyStore.kt"))
    assertTrue("必须在消费链生命周期入口安装（不是随 Activity 重复注册）",
      store.contains("NotifyCenter.installShellListener()"))
  }

  @Test
  fun 设置入口必须可读写且拒绝乐观置位() {
    // FIX-4：setSuppressForeground/setEnabled 旧态零调用 → 开关存在但不可达。
    val code = codeOnly(shellSource("NotifyCenter.kt"))
    assertTrue("必须有读快照入口", code.contains("fun settingsSnapshot("))
    assertTrue("必须有写入口", code.contains("fun applySetting("))
    assertTrue("未知 key 必须拒绝（不得静默吞掉误写）", code.contains("unknown-key"))
    assertTrue("必须写后读回判定（拒绝乐观置位）", code.contains("readback-mismatch"))
    assertTrue("关掉抑制必须立刻补投延后条目", code.contains("fun onSuppressForegroundChanged("))
  }

  @Test
  fun FIX4设置键判定必须真跑_未知键不得放行() {
    // 「未知 key 必须拒绝」此前只在源码里断言 `unknown-key` 字面量在场（文本在场，不是行为）。
    // settingKeyKnown 是纯函数（不碰 Context），因此可以直接真跑：撤掉拒绝分支即判红。
    assertTrue("suppressForeground 必须放行", NotifyCenter.settingKeyKnown("suppressForeground"))
    for (face in NotifyCenter.Face.values()) {
      assertTrue("cat." + face.category + " 必须放行", NotifyCenter.settingKeyKnown("cat." + face.category))
    }
    // 未知键：拼错的分类名、缺前缀、空串、前缀对但不存在的类别——一律拒绝。
    assertFalse("拼错的分类名必须拒绝", NotifyCenter.settingKeyKnown("cat.reprot"))
    assertFalse("缺 cat. 前缀必须拒绝", NotifyCenter.settingKeyKnown("report"))
    assertFalse("空串必须拒绝", NotifyCenter.settingKeyKnown(""))
    assertFalse("不存在的类别必须拒绝", NotifyCenter.settingKeyKnown("cat.task"))
    assertFalse("大小写敏感（不得放宽成包含匹配）", NotifyCenter.settingKeyKnown("cat.REPORT"))
    assertFalse("旧渠道类别不得复活", NotifyCenter.settingKeyKnown("cat.unknown"))
    // 写入口必须先过这道判定（单一真源：不得在 applySetting 里另写一份 key 判定）。
    val code = codeOnly(shellSource("NotifyCenter.kt"))
    assertTrue("applySetting 必须复用 settingKeyKnown（不得两处判定漂移）",
      code.contains("if (!settingKeyKnown(key))"))
  }

  @Test
  fun FIX4设置入口必须真的可达_桥面与页面两侧都在场() {
    // J-1 真缺陷：上面那条测试只断言「NotifyCenter.kt 里存在这些成员」——纯文本在场。
    // 而实测这些成员在 app/src/main 全仓**零外部调用点**、桥面 35 个 @JavascriptInterface 无一
    // 涉及 notify、页面侧 grep 0 命中 ⇒ 能力在、入口无，那条测试因实现不可达而**假绿**。
    //
    // 本测试把「可达性」本身变成断言：可达 = ①壳侧有 @JavascriptInterface 出口且**挂在真源默认实现**上
    // （不依赖 MainActivity 传参，漏接线在结构上不可能复发）；②页面侧类型面声明了同名成员；
    // ③页面侧确实调用它。三处任一缺失即判红——撤掉桥出口/撤掉页面接线/改成 {ok:false} 桩都会红。
    val bridge = codeOnly(shellSource("AndroidBridge.kt"))
    assertTrue("桥面必须有通知设置读出口", bridge.contains("fun getNotifySetting("))
    assertTrue("桥面必须有通知设置写出口", bridge.contains("fun setNotifySetting("))
    assertTrue("读出口必须挂在真源默认实现（不得是未接线桩）",
      bridge.contains("NotifyCenter.settingsSnapshot(app)"))
    assertTrue("写出口必须挂在真源默认实现（不得是未接线桩）",
      bridge.contains("NotifyCenter.applySetting(app, key, value)"))
    assertFalse("读出口不得回落到「未接线」文案（那就是不可达本身）",
      Regex("""getNotifySetting[\s\S]{0,400}?未接线""").containsMatchIn(bridge))

    // 页面侧类型面（android-bridge.ts）必须声明两个成员，否则调用没有类型面、漂移无人拦。
    val ts = uiSource("src/client/android-bridge.ts")
    assertTrue("页面类型面必须声明 getNotifySetting", ts.contains("getNotifySetting?:"))
    assertTrue("页面类型面必须声明 setNotifySetting", ts.contains("setNotifySetting?:"))

    // 页面侧必须有真实调用点（不是只声明不用）。
    val ui = uiSource("src/client/dev-section/notify-settings.tsx")
    assertTrue("页面必须调用读出口", ui.contains("getNotifySetting?.("))
    assertTrue("页面必须调用写出口", ui.contains("setNotifySetting?.("))
    assertTrue("写后必须读回判定（applied 不为 true 不得置位）", ui.contains("applied !== true"))

    // 页面必须真的挂在开发者选项分区里（否则组件存在但没人渲染 = 另一种不可达）。
    val section = uiSource("src/client/dev-section/DevSection.tsx")
    assertTrue("通知设置行必须挂进开发者选项分区", section.contains("<NotifySettingsRow />"))
  }

  @Test
  fun J2投递结果必须写进判据grep的那个文件() {
    // J-2 真缺陷：判据（详档 §6.2/§6.3）grep `result=` 于 files/notify-responder.log，而实现
    // 用 LogCollector.log 只写 day-file（仅在调试采集器开启时存在）⇒ 设备实测该文件 667 行、
    // `result=` 命中 0、`migration` 命中 1（证明文件确有写入）。判据结构性取不到数。
    // 修法：结果记账改走 NotifyProbe（双写 logcat/day-file + notify-responder.log）。
    val store = codeOnly(shellSource("NotifyStore.kt"))
    assertTrue("投递结果必须走 NotifyProbe（写进通知探针文件）",
      store.contains("NotifyProbe.log(context.applicationContext, TAG, \"notify dispatch kind=\""))
    assertFalse("结果记账不得再走 LogCollector（只写 day-file，判据取不到）",
      Regex("""LogCollector\.log\(TAG, "notify dispatch""").containsMatchIn(store))
    // 同一段链路的其它记账同样必须可 run-as 读到（否则分流表与延迟打点一起失效）。
    assertTrue("消费延迟打点必须走 NotifyProbe", store.contains("NotifyProbe.log(context.applicationContext, TAG, \"notify kind=\""))
    assertTrue("不可解析行记账必须走 NotifyProbe", store.contains("notify line ignored (unparsable): "))
    assertFalse("drain 失败记账不得走 LogCollector（与判据同源要求）",
      Regex("""LogCollector\.log\(TAG, "notify drain failed""").containsMatchIn(store))

    // 探针文件是唯一可 run-as 直读的面，判据依赖它：文件名与双写实现都必须在场。
    val probe = codeOnly(shellSource("NotifyProbe.kt"))
    assertTrue("探针文件名必须是判据 grep 的那个", probe.contains("\"notify-responder.log\""))
    assertTrue("探针必须真的落文件（追加）", probe.contains("f.appendText("))
  }

  @Test
  fun 存量升级迁移必须幂等且不静默改写用户显式选择() {
    // FIX-3 的存量路径：缺键（旧默认造出的抑制）→ 新默认值即被修好；显式值原样保留。
    val code = codeOnly(shellSource("NotifyCenter.kt"))
    assertTrue("必须有一次性迁移入口", code.contains("fun ensureSuppressForegroundMigrated("))
    assertTrue("必须有 schema 代次防重复执行", code.contains("KEY_SUPPRESS_SCHEMA"))
    assertTrue("显式值必须备份留痕（不得静默丢弃）", code.contains("KEY_SUPPRESS_LEGACY"))
    assertTrue("缺键分支不得写 suppressForeground 键（否则把默认值固化成用户选择）",
      !code.contains("putBoolean(KEY_SUPPRESS_FOREGROUND, DEFAULT_SUPPRESS_FOREGROUND)"))
    val store = codeOnly(shellSource("NotifyStore.kt"))
    assertTrue("迁移必须在启动路径执行", store.contains("NotifyCenter.ensureSuppressForegroundMigrated(app)"))
  }

  @Test
  fun 拒因必须可区分_表驱动() {
    // 详档 §7.1 G-N3：每个 Result 取值都必须有**独立可观测**路径，且四种拒因的记账串互不相同。
    // 为什么这是制度锁：§6.3 的分流表靠「探针里只会有 ONE 个 result=」一步定位真因；一旦两个拒因
    // 共用同一串（或新加取值不带记账），分流表就失效，误诊成主缺陷或被当假绿放过。
    val center = codeOnly(shellSource("NotifyCenter.kt"))
    val store = codeOnly(shellSource("NotifyStore.kt"))

    // ① 每个 Result 取值都必须经 dispatch 的 result= 记账（`result=` + 枚举名，逐值覆盖）。
    val resultEnum = Regex("""enum class Result \{([^}]*)\}""").find(center)?.groupValues?.get(1)
      ?: throw AssertionError("找不到 Result 枚举")
    val values = Regex("""\b([A-Z][A-Z_]+)\b""").findAll(resultEnum)
      .map { it.groupValues[1] }.toList().distinct()
    assertTrue("Result 取值解析为空", values.size >= 6)
    assertTrue("每个 Result 取值都必须有可观测记账（dispatch 落 result=）", store.contains("result=\" + result"))

    // ② 四种拒因的记账串必须两两不同（表格驱动，新增取值而不加记账即判红）。
    val denyMars = mapOf(
      "SUPPRESSED_FOREGROUND" to "notify suppressed (foreground): ",
      "PERMISSION_DENIED" to "notify skipped (POST_NOTIFICATIONS not granted): ",
      "DISABLED_CATEGORY" to "notify skipped (category disabled): ",
      "DISABLED_CHANNEL" to "notify dropped (no usable channel): ",
      "UNKNOWN_KIND" to "notify skipped (unknown kind): ",
      "ERROR" to "notifyEvent THREW kind=",
      "POSTED" to "notify: kind=",
    )
    val missing = denyMars.filterValues { !center.contains(it) }.keys
    assertTrue("拒因记账串缺席（新增取值必须补记账）：" + missing.joinToString(","), missing.isEmpty())
    val dupes = denyMars.values.groupBy { it }.filterValues { it.size > 1 }.keys
    assertTrue("拒因记账串不得重复（重复即分流表失效）：" + dupes.joinToString(","), dupes.isEmpty())

    // ③ 反向对照：前台抑制的串必须与权限/类别/渠道三串都不同（防「都写着 suppressed」式合并）。
    val suppressed = denyMars.getValue("SUPPRESSED_FOREGROUND")
    for (other in listOf("PERMISSION_DENIED", "DISABLED_CATEGORY", "DISABLED_CHANNEL")) {
      assertNotEquals("SUPPRESSED_FOREGROUND 不得与 $other 共用记账串",
        denyMars.getValue(other), suppressed)
    }
  }

  @Test
  fun 最近汇报窄接口签名稳定() {
    // T5（OverlayReport）依赖此签名；改它就等于破坏跨任务契约。
    val store = codeOnly(shellSource("NotifyStore.kt"))
    assertTrue("必须暴露 `fun latestReportLine(): String?`",
      store.contains("fun latestReportLine(): String? = lastReportLineRaw"))
    assertTrue("挂点必须在 dispatch 的 report 分支", store.contains("if (entry.kind == \"report\") lastReportLineRaw = line"))
    assertTrue("登记必须在投递判定之前（被抑制也要能看到内容）",
      store.indexOf("lastReportLineRaw = line") < store.indexOf("NotifyCenter.notifyEvent(context, entry"))
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
