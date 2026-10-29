package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * §3.3 通知结构族（S3-1…S3-12）的判据（0.14.1 批 8）。
 *
 * 这一族的共同形态是「界面上看起来对、实际不是那么回事」——只能靠设备复现，于是此前没有任何离线判据。
 * 本类把每条都落成可判红的断言：能抽成纯函数的抽出来直接测，落在 Android 胶水里的用源码形态断言
 * （「修好的形态在场 + 旧形态缺席」，撤掉修复即判红）。
 */
class NotifyStructureBatch8Test {

  private fun source(relative: String): String {
    val candidates = listOf(File(relative), File("app/$relative"))
    val file = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到源码 $relative（工作目录 = " + File(".").absolutePath + "）")
    return file.readText()
  }

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  private fun centerCode(): String = codeOnly(source("src/main/java/com/dsharnessmobile/shell/NotifyCenter.kt"))
  private fun bridgeCode(): String = codeOnly(source("src/main/java/com/dsharnessmobile/shell/NotifyBridge.kt"))
  private fun queueCode(): String = codeOnly(source("src/main/java/com/dsharnessmobile/shell/NotifyDecisionQueue.kt"))

  private fun question(id: String, options: List<String>) =
    NotifyQuestion(id = id, header = "标题", question = "问题 " + id, options = options)

  // ── S3-1 渠道被系统降级 → 通知自带解释 ─────────────────────────────────

  @Test
  fun channelDegradeExplainsItselfOnTheNotification() {
    val code = centerCode()
    // 旧形态：降级只写探针 + 一行 flashStatus（面板收起时看不到）。
    assertTrue("降级必须产生随通知走的说明", code.contains("degradedNotice"))
    assertTrue("说明必须点名是哪个类别被降级", code.contains("系统已把「"))
    assertTrue("说明必须给出恢复路径", code.contains("到系统设置里可恢复"))
    assertTrue("说明必须落到通知上（subText）", code.contains("if (degradedNotice != null) b.setSubText(degradedNotice)"))
    assertTrue("只在交互类且渠道不可用时才说", code.contains("channelId == null && face.interactive"))
  }

  // ── S3-2 迁移不得留下同名重复渠道 ──────────────────────────────────────

  @Test
  fun migrationRetiresTheSupersededCandidates() {
    // 迁移：首选存在但 importance 太低（用户没改过）→ 建 h2，并**回收**被替代的首选。
    val migrated = NotifyCenter.selectChannel(
      listOf("dsh-auth", "dsh-auth-h2"),
      android.app.NotificationManager.IMPORTANCE_HIGH,
      mapOf(
        "dsh-auth" to NotifyCenter.ChannelFact("dsh-auth", android.app.NotificationManager.IMPORTANCE_LOW, false),
      ),
    )
    assertEquals("dsh-auth-h2", migrated.channelId)
    assertEquals("migrated", migrated.reason)
    assertEquals("被替代的旧候选必须交给调用方回收", listOf("dsh-auth"), migrated.retire)

    // 首次创建：前面的候选都不存在，没有可回收的。
    val created = NotifyCenter.selectChannel(
      listOf("dsh-question", "dsh-question-h2"),
      android.app.NotificationManager.IMPORTANCE_HIGH,
      mapOf("dsh-question" to null),
    )
    assertEquals("create", created.reason)
    assertTrue("首次创建不得误删别的渠道", created.retire.isEmpty())

    // 直接选中：不迁移、不回收。
    val selected = NotifyCenter.selectChannel(
      listOf("dsh-report"),
      android.app.NotificationManager.IMPORTANCE_HIGH,
      mapOf("dsh-report" to NotifyCenter.ChannelFact("dsh-report", android.app.NotificationManager.IMPORTANCE_HIGH, false)),
    )
    assertEquals("selected", selected.reason)
    assertTrue(selected.retire.isEmpty())

    // 调用点必须真的删（否则判据只是「返回了列表」）。
    assertTrue("调用方必须回收旧渠道", centerCode().contains("manager.deleteNotificationChannel(old)"))
  }

  // ── S3-3 无 sessionId 的汇报不得互相覆盖 ───────────────────────────────

  @Test
  fun reportsWithoutSessionDoNotCollapseIntoOneNotification() {
    val a = NotifyEntry(kind = "report", eventId = "e1", title = "会话一")
    val b = NotifyEntry(kind = "report", eventId = "e2", title = "会话二")
    assertNotEquals("分桶键必须区分", NotifyCenter.reportBucketKey(a), NotifyCenter.reportBucketKey(b))
    assertNotEquals(
      "无 sessionId 的两条汇报不得共用同一通知 ID（旧实现全部挤进 dsh-report:）",
      NotifyCenter.notificationId(a, NotifyCenter.Face.REPORT),
      NotifyCenter.notificationId(b, NotifyCenter.Face.REPORT),
    )
    // 同一会话同一桶（覆盖式语义必须保住）。
    val a2 = NotifyEntry(kind = "report", eventId = "e9", sessionId = "s1", title = "会话一")
    val a3 = NotifyEntry(kind = "report", eventId = "e10", sessionId = "s1", title = "会话一（改名）")
    assertEquals(NotifyCenter.notificationId(a2, NotifyCenter.Face.REPORT), NotifyCenter.notificationId(a3, NotifyCenter.Face.REPORT))
    assertNotEquals(
      "不同会话不得共用同一条",
      NotifyCenter.notificationId(a2, NotifyCenter.Face.REPORT),
      NotifyCenter.notificationId(NotifyEntry(kind = "report", sessionId = "s2"), NotifyCenter.Face.REPORT),
    )
  }

  // ── S3-4 提问正文不得为空 ──────────────────────────────────────────────

  @Test
  fun blankQuestionFallsBackToCopy() {
    val code = centerCode()
    // 旧写法 `first?.question ?: entry.text.ifBlank {...}`：question 为空串（非 null）时正文空白。
    assertFalse("不得再用 elvis 兜空串", code.contains("first?.question ?: entry.text"))
    assertTrue("必须能把空串也落到兜底", code.contains("first?.question?.ifBlank { null }"))
  }

  // ── S3-5 选项多于两个要给作答入口 ──────────────────────────────────────

  @Test
  fun multiOptionQuestionGetsAnAppEntry() {
    assertTrue("三个选项 ⇒ 通知里给不出按钮，必须有应用入口", NotifyCenter.questionNeedsAppEntry(
      NotifyEntry(kind = "question", eventId = "e", questions = listOf(question("q", listOf("a", "b", "c")))),
    ))
    assertFalse("两个选项可以给按钮，不需要应用入口", NotifyCenter.questionNeedsAppEntry(
      NotifyEntry(kind = "question", eventId = "e", questions = listOf(question("q", listOf("a", "b")))),
    ))
    assertFalse("没有选项也不触发（自由文本有回复框）", NotifyCenter.questionNeedsAppEntry(
      NotifyEntry(kind = "question", eventId = "e", questions = listOf(question("q", emptyList()))),
    ))
    val code = centerCode()
    assertTrue("动作必须真的加上", code.contains("打开应用作答"))
    assertTrue("正文也要说明去哪儿答", code.contains("请打开应用作答"))
  }

  // ── S3-6 通知寿命必须与引擎侧的「无超时」对齐 ──────────────────────────

  @Test
  fun questionNotificationDoesNotExpireSilently() {
    assertEquals("提问超时必须是 0（不超时）", 0L, NotifyCenter.QUESTION_TIMEOUT_MS)
    val code = centerCode()
    assertFalse("不得再对提问设置到期自动撤销", code.contains("setTimeoutAfter(QUESTION_TIMEOUT_MS)"))
  }

  // ── S3-7 授权正文要保住「动的是什么」 ───────────────────────────────────

  @Test
  fun approvalCopyKeepsTheTargetTail() {
    val redacted = NotifyCenter.redactPathsKeepingTail("删除 /data/local/tmp/build/output.apk 吗？")
    assertTrue("必须保住目标末段，实际：$redacted", redacted.contains("output.apk"))
    assertFalse("不得把整条路径摊出来", redacted.contains("/data/local/tmp/build/"))
    assertFalse("也不得抹成只剩 [路径]", redacted.contains("[路径]"))
    // token 遮挡与长度上限沿用原口径。
    assertTrue(NotifyCenter.redactPathsKeepingTail("token=abcdef").contains("***"))
    assertTrue(NotifyCenter.redactPathsKeepingTail("x".repeat(400)).length <= 180)
    // 审批行必须走这条（而不是旧的 sanitize）。
    assertTrue("审批正文必须保留目标", centerCode().contains("redactPathsKeepingTail(reason)"))
  }

  // ── S3-8 授权标题要带具体对象 ──────────────────────────────────────────

  @Test
  fun approvalTitleNamesTheConcreteSubject() {
    val code = centerCode()
    assertTrue("标题必须用工具名（具体对象）", code.contains("「\" + it + \"」需要授权"))
    assertTrue("没有工具名时才回落类别词", code.contains("entry.displayTitle().ifBlank { UserCopy.notifyCategory(Face.APPROVAL.category) }"))
  }

  // ── S3-9 本机提交 vs 别处已答/引擎撤销 ─────────────────────────────────

  @Test
  fun settleCopyDistinguishesLocalSubmitFromRemoteSettle() {
    val localQ = NotifyCenter.settleCopy("question", remote = false)
    val remoteQ = NotifyCenter.settleCopy("question", remote = true)
    val localA = NotifyCenter.settleCopy("approval", remote = false)
    val remoteA = NotifyCenter.settleCopy("approval", remote = true)
    // 非本机结算**不得**说「已提交」——那是用户没做过的事。
    assertNotEquals("本机与别处必须说不同的话", localQ.title, remoteQ.title)
    assertNotEquals(localA.title, remoteA.title)
    assertFalse("别处结算不得声称已提交", remoteQ.title.contains("已提交"))
    assertFalse("别处结算不得声称已提交", remoteA.title.contains("已提交"))
    assertTrue(remoteQ.text.contains("别处"))
    assertTrue(remoteA.text.contains("别处"))
    assertEquals("本机提交仍是已提交", "已提交", localQ.title)
    assertEquals("本机提交仍是已提交", "已提交", localA.title)
    // cancel 帧必须走 remote 分支。
    assertTrue("cancel 帧必须标记为非本机提交", bridgeCode().contains("markSettled(context, id, remote = true)"))
  }

  // ── S3-10 进程重启后不得按错的 face 结算 ───────────────────────────────

  @Test
  fun untrackedSettleCancelsBothFaces() {
    val code = bridgeCode()
    assertFalse("不得再回落成 question", code.contains("?: \"question\""))
    assertTrue("无记录时必须两个 face 都撤", code.contains("NotifyCenter.cancel(context, eventId)"))
    assertTrue("必须留下可 grep 的记录", code.contains("settled(untracked eventId="))
  }

  // ── S3-11 失效通知上的「重试」不得是死按钮 ─────────────────────────────

  @Test
  fun expiredFailureOffersNoRetryAction() {
    val code = queueCode()
    assertTrue("失效（EXPIRED）必须明确不可重试", code.contains("retryable = false"))
    assertTrue("可重试的失败仍要有重试", code.contains("retryable = true"))
    // 通知侧按 retryable 决定要不要加重试动作；不可重试时给「点击打开应用」。
    val center = centerCode()
    assertTrue("重试动作必须是条件加的", center.contains("if (retryable) {"))
    assertTrue("不可重试也要有下一步（打开应用）", center.contains("setContentIntent(contentIntent(app, NotifyEntry(kind = kind, eventId = eventId, title = title)))"))
  }

  // ── S3-12 失败通知不得覆盖原提问/审批 ──────────────────────────────────

  @Test
  fun deliveryFailureDoesNotClobberTheInteractionNotification() {
    val q = NotifyEntry(kind = "question", eventId = "e1")
    val a = NotifyEntry(kind = "approval", eventId = "e1")
    assertNotEquals(
      "失败通知必须有独立 ID 桶",
      NotifyCenter.notificationId(q, NotifyCenter.Face.QUESTION),
      NotifyCenter.failureId("question", "e1"),
    )
    assertNotEquals(
      NotifyCenter.notificationId(a, NotifyCenter.Face.APPROVAL),
      NotifyCenter.failureId("approval", "e1"),
    )
    assertNotEquals("不同 kind 的失败不得互相覆盖", NotifyCenter.failureId("question", "e1"), NotifyCenter.failureId("approval", "e1"))
    assertEquals("同一条失败重复投递要覆盖自己", NotifyCenter.failureId("question", "e1"), NotifyCenter.failureId("question", "e1"))
    val code = centerCode()
    assertTrue("失败时要撤掉原交互通知（它的按钮已无意义）", code.contains("cancel(app, eventId)"))
    assertTrue("正文要带上失败的那次作答", code.contains("你所提交的内容："))
    // 队列侧要真的把作答摘要传进去。
    assertTrue("队列必须提供作答摘要", queueCode().contains("detail = answerSummary("))
  }

  // ── S3-26 测试通知入口必须真的可达（sendTest 此前零调用点）──────────────

  @Test
  fun sendTestEntryIsWiredToTheRealImplementation() {
    assertTrue("必须有五类测试入口", centerCode().contains("fun sendTestAll("))
    val bridge = codeOnly(source("src/main/java/com/dsharnessmobile/shell/AndroidBridge.kt"))
    assertTrue("桥面必须有出口", bridge.contains("fun notifySendTest()"))
    assertTrue("出口必须挂在真源默认实现（不得是未接线桩）", bridge.contains("NotifyCenter.sendTestAll(app)"))
    assertTrue("必须返回真实条数（页面据此如实提示）", bridge.contains("private val onNotifySendTest: () -> Int"))
    assertFalse("不得回落到恒 0 的桩", bridge.contains("onNotifySendTest: () -> Int = { 0 }"))
  }

  @Test
  fun answerSummaryReadsTheOutcomeWithoutInventing() {
    fun summary(json: String) = NotifyDecisionQueue.answerSummary(
      NotifyDecisionQueue.Decision("r1", "e1", "question", json, 0L),
    )
    assertEquals("选项型", "a", summary("{\"label\":\"a\"}"))
    assertEquals("自由文本型", "你好", summary("{\"text\":\"你好\"}"))
    assertEquals("审批决定", "allowed-once", summary("{\"outcome\":\"allowed-once\"}"))
    assertEquals("取不到就给空串（不编造）", "", summary("{}"))
    assertEquals("非法 JSON 不抛异常", "", summary("not json"))
  }

  /**
   * N2（0.14.11）：plan-review 的计划正文放在 `detail`，旧实现只拼 question，
   * 于是通知栏里只有「Approve this plan and leave plan mode?」+ 按钮 —— 用户盲批。
   */
  @Test
  fun questionBodyCarriesThePlanDetail() {
    val review = NotifyQuestion("plan-review", "Plan review", "Approve this plan and leave plan mode?", listOf("Approve", "Keep planning"))
    val plan = "# 迁移到新队列\n- 先落盘再投递\n- 退避封顶 60s"
    val withDetail = review.copy(detail = plan)
    val entry = NotifyEntry(kind = "question", eventId = "e1", questions = listOf(withDetail))
    val body = NotifyCenter.questionBigText(entry)
    assertTrue("必须带上正文（否则用户看不到计划就要批）", body.contains("迁移到新队列"))
    assertTrue("问题本身仍在", body.contains("Approve this plan"))

    val noDetail = NotifyCenter.questionBigText(NotifyEntry(kind = "question", eventId = "e2", questions = listOf(review)))
    assertFalse("没有正文时不得凭空造", noDetail.contains("迁移到新队列"))

    val long = "# 长计划\n" + "x".repeat(NotifyCenter.DETAIL_LIMIT + 200)
    val clipped = NotifyCenter.questionBigText(
      NotifyEntry(kind = "question", eventId = "e3", questions = listOf(review.copy(detail = long))),
    )
    assertTrue("超长必须截断且截断可见", clipped.endsWith("…"))
    assertTrue("截断后长度受控", clipped.length < NotifyCenter.DETAIL_LIMIT + 200)

    val withPath = NotifyCenter.questionBigText(
      NotifyEntry(
        kind = "question", eventId = "e4",
        questions = listOf(review.copy(detail = "计划：读取 /data/data/com.dsharnessmobile.shell/files/x 后继续")),
      ),
    )
    assertTrue("正文同样要脱敏（绝对路径）", withPath.contains("[路径]"))
    assertFalse("不得原样带出绝对路径", withPath.contains("/data/data/"))

    val bridge = codeOnly(source("src/main/java/com/dsharnessmobile/shell/NotifyBridge.kt"))
    assertTrue("解析侧必须读 detail 字段", bridge.contains("q.optString(\"detail\""))
   * N5（0.14.11）：失败通知里的「你所提交的内容」曾经是**原始 JSON**。
   *
   * 现场形状来自 NotifyActionReceiver.outcomeFor（线上唯一构造点），不是想象出来的：
   *   审批 -> {"kind":"result","value":"allowed-once"}
   *   选答 -> {"kind":"result","value":{"answers":[{"id":"q1","selected":["方案A"]}]}}
   *   回复 -> {"kind":"result","value":{"answers":[{"id":"q1","selected":[],"custom":"我选第二个方案"}]}}
   * 旧实现只取 optString("value")，对象形态会拿到它的 JSON 文本 ⇒ 用户看到一串花括号。
   */
  @Test
  fun answerSummaryRendersTheRealOutcomeShapes() {
    fun summary(json: String) = NotifyDecisionQueue.answerSummary(
      NotifyDecisionQueue.Decision("r1", "e1", "question", json, 0L),
    )

    assertEquals("审批通过", "allowed-once", summary("{\"kind\":\"result\",\"value\":\"allowed-once\"}"))
    assertEquals("审批拒绝", "rejected", summary("{\"kind\":\"result\",\"value\":\"rejected\"}"))
    assertEquals(
      "单选选项",
      "方案A",
      summary("{\"kind\":\"result\",\"value\":{\"answers\":[{\"id\":\"q1\",\"selected\":[\"方案A\"]}]}}"),
    )
    assertEquals(
      "自由文本回复",
      "我选第二个方案",
      summary("{\"kind\":\"result\",\"value\":{\"answers\":[{\"id\":\"q1\",\"selected\":[],\"custom\":\"我选第二个方案\"}]}}"),
    )
    assertEquals(
      "多问合成一行",
      "甲；乙",
      summary(
        "{\"kind\":\"result\",\"value\":{\"answers\":[" +
          "{\"id\":\"q1\",\"selected\":[],\"custom\":\"甲\"}," +
          "{\"id\":\"q2\",\"selected\":[],\"custom\":\"乙\"}]}}",
      ),
    )
    val rendered = summary("{\"kind\":\"result\",\"value\":{\"answers\":[{\"id\":\"q1\",\"selected\":[\"方案A\"]}]}}")
    assertFalse("不得把原始 JSON 甩到用户脸上", rendered.contains("{") || rendered.contains("answers"))
    assertEquals("空对象不编造", "", summary("{}"))
  }
}
