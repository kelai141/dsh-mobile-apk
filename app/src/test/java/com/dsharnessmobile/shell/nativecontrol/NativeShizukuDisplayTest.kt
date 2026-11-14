package com.dsharnessmobile.shell.nativecontrol

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * Per-display Shizuku facts and dispatch guards.
 *
 * 每条用例锁一条性质：能力只按屏发布、屏的身份必须对得上、断连/过期/注销立刻收回、
 * 虚拟目标不会被「当前选中屏」顶替、坐标手势带目标 displayId 而全局动作仍限真实屏。
 */
class NativeShizukuDisplayTest {
  private var now = 1_000L
  private val facts = NativeShizukuFacts(clock = { now })

  private fun healthy(generation: Long = 1): LinkToken {
    val token = facts.tokenAt(generation)
    facts.onLink(token, true, true)
    facts.onGranted(token, true)
    facts.onBound(token, true)
    facts.onProbe(token, true, now)
    facts.onServerUid(token, 2000)
    return token
  }

  private fun textBits(token: LinkToken) {
    facts.onRealTapCapability(token, true)
    facts.onRealTextCapability(token, true)
    facts.onRealTreeCapability(token, true)
    facts.onNativeFeatures(token, 8 or 16 or 32)
  }

  private fun opsOf(snapshot: JSONObject, displayId: Int): Set<String> {
    val perDisplay = snapshot.optJSONObject("displayOperations") ?: return emptySet()
    val array = perDisplay.optJSONArray(displayId.toString()) ?: return emptySet()
    return (0 until array.length()).map { array.getString(it) }.toSet()
  }

  private fun allOps(snapshot: JSONObject): Set<String> {
    val supported = snapshot.getJSONObject("supportedOps")
    if (supported.getString("state") != "known") return emptySet()
    val array = supported.getJSONArray("ops")
    return (0 until array.length()).map { array.getString(it) }.toSet()
  }

  // ── 事实面 ────────────────────────────────────────────────────────────────

  @Test fun coldCachePublishesNoDisplayOperationsAtAll() {
    val snapshot = facts.snapshot()
    assertFalse("没有任何实测时整键缺席，Rust 才会走旧的 displaySupport",
      snapshot.has("displayOperations"))
    assertEquals("unknown", snapshot.getJSONObject("displaySupport").getString("state"))
  }

  @Test fun perDisplayFactsAreExactAndNeverPromotedAcrossDisplays() {
    val token = healthy()
    textBits(token)
    facts.onDisplayCapabilities(token, mapOf(
      0 to DisplayCapabilities("real", 1 or 2 or 8),
      7 to DisplayCapabilities("virtual-1", 2),
    ))
    val snapshot = facts.snapshot()
    assertEquals("真实屏 op 只能来自它自己的实测位",
      setOf("click", "longClick", "scroll", "setText", "nodeText", "snapshot", "screenshot",
        "readRegion", "global", "launchApp", "swipe", "keyEvent"),
      opsOf(snapshot, 0))
    assertEquals("虚拟屏只有它自己测到的树能力", setOf("snapshot"), opsOf(snapshot, 7))
    assertFalse("一块屏的能力不得出现在别的屏上", opsOf(snapshot, 7).contains("setText"))
    assertTrue("supportedOps 是各屏并集", allOps(snapshot).containsAll(listOf("setText", "snapshot")))
    assertEquals(setOf("0", "7"),
      snapshot.getJSONObject("displaySupport").getJSONObject("values").keys().asSequence().toSet())
  }

  @Test fun permitsDisplayRequiresExactAliasAndMeasuredBit() {
    val token = healthy()
    facts.onDisplayCapabilities(token, mapOf(7 to DisplayCapabilities("virtual-1", 2 or 8)))
    assertTrue(facts.permitsDisplay(token, 7, "virtual-1", "snapshot"))
    assertTrue(facts.permitsDisplay(token, 7, "virtual-1", "screenshot"))
    assertFalse("别名对不上不得放行", facts.permitsDisplay(token, 7, "virtual-2", "snapshot"))
    assertFalse("未测的 op 不得放行", facts.permitsDisplay(token, 7, "virtual-1", "setText"))
    assertFalse("未测的屏不得放行", facts.permitsDisplay(token, 9, "virtual-9", "snapshot"))
  }

  @Test fun measuredDisplayWithoutAnyBitStaysKnownAndEmpty() {
    val token = healthy()
    facts.onDisplayCapabilities(token, mapOf(7 to DisplayCapabilities("virtual-1", 0)))
    val snapshot = facts.snapshot()
    assertEquals("测过但都不支持 = 空列表，不是缺席", emptySet<String>(), opsOf(snapshot, 7))
    assertTrue(snapshot.getJSONObject("displaySupport").getJSONObject("values").has("7"))
    assertFalse(facts.permitsDisplay(token, 7, "virtual-1", "snapshot"))
  }

  @Test fun connectionLossExpiryAndUnregisterRemoveMeasuredDisplays() {
    val token = healthy()
    facts.onDisplayCapabilities(token, mapOf(7 to DisplayCapabilities("virtual-1", 2)))
    facts.onBound(token, false)
    facts.onBound(token, true)
    assertFalse("同代断连后旧虚拟屏观测作废", facts.snapshot().has("displayOperations"))
    assertFalse(facts.permitsDisplay(token, 7, "virtual-1", "snapshot"))

    // 断连已经把整条连接的就绪/探测结论清空：重新绑定之后必须再探一次才算可用，
    // 否则「绑上了但没探过」会被误判成可派发。
    val fresh = facts.tokenAt(1)
    facts.onBound(fresh, true)
    assertFalse(facts.permitsDisplay(fresh, 7, "virtual-1", "snapshot"))
    facts.onProbe(fresh, true, now)
    facts.onServerUid(fresh, 2000)
    facts.onDisplayCapabilities(fresh, mapOf(7 to DisplayCapabilities("virtual-1", 2)))
    assertTrue(facts.permitsDisplay(fresh, 7, "virtual-1", "snapshot"))
    now += NativeShizukuFacts.DEFAULT_TTL_MS + 1
    assertFalse("过期即未知，不能沿用上次的屏表",
      facts.permitsDisplay(fresh, 7, "virtual-1", "snapshot"))
    assertFalse(facts.snapshot().has("displayOperations"))
  }

  @Test fun displayObservationCanSpanClockTicksButNotReconnects() {
    val started = healthy()
    now += 30
    assertTrue(facts.tokenAt(1).sameConnectionAs(started))
    facts.onBound(facts.tokenAt(1), false)
    assertFalse(facts.tokenAt(1).sameConnectionAs(started))
    assertFalse(facts.tokenAt(2).sameConnectionAs(started))
  }

  @Test fun reobservationReplacesTheWholeTable() {
    val token = healthy()
    facts.onDisplayCapabilities(token, mapOf(
      7 to DisplayCapabilities("virtual-1", 2),
      9 to DisplayCapabilities("virtual-2", 8),
    ))
    now += 10
    val latest = facts.tokenAt(1)
    // 第二块屏已被销毁：这一轮之后它必须消失，不能残留上一轮的截图能力。
    facts.onDisplayCapabilities(latest, mapOf(7 to DisplayCapabilities("virtual-1", 2)))
    assertFalse(facts.permitsDisplay(latest, 9, "virtual-2", "screenshot"))
    assertTrue(facts.permitsDisplay(latest, 7, "virtual-1", "snapshot"))
  }

  @Test fun staleDisplayObservationDoesNotOverrideNewerOne() {
    val token = healthy()
    facts.onDisplayCapabilities(token, mapOf(7 to DisplayCapabilities("virtual-1", 2)))
    now += 5
    val newer = facts.tokenAt(1)
    facts.onDisplayCapabilities(newer, emptyMap())
    facts.onDisplayCapabilities(token, mapOf(7 to DisplayCapabilities("virtual-1", 2)))
    assertFalse("迟到的旧观测不得把已销毁的屏写回来", facts.permitsDisplay(newer, 7, "virtual-1", "snapshot"))
  }

  @Test fun coordinateGestureBitAddsOnlyGestureOperations() {
    val token = healthy()
    facts.onDisplayCapabilities(token, mapOf(7 to DisplayCapabilities("virtual-1", 16)))
    // 位 16 = 坐标/按键手势：坐标 click/longClick/scroll、任意起终点 swipe、固定 keyEvent，
    // 以及 global（其 home/recents/notifications 在执行侧按动作拒绝，back 带目标 display）。
    assertEquals(setOf("click", "longClick", "scroll", "swipe", "keyEvent", "global"),
      opsOf(facts.snapshot(), 7))
    assertTrue(facts.permitsDisplay(token, 7, "virtual-1", "click"))
    assertTrue(facts.permitsDisplay(token, 7, "virtual-1", "swipe"))
    assertTrue(facts.permitsDisplay(token, 7, "virtual-1", "keyEvent"))
    assertTrue(facts.permitsDisplay(token, 7, "virtual-1", "global"))
    assertFalse(facts.permitsDisplay(token, 7, "virtual-1", "snapshot"))
  }

  @Test fun focusedTextNeedsTheTextBitWhileNodeTextUsesTheNodeBit() {
    val token = healthy()
    // 只有节点位：节点 setText 可以，但焦点编辑器文本不行（两块屏上的同一 op 名不同通道）。
    facts.onDisplayCapabilities(token, mapOf(7 to DisplayCapabilities("virtual-1", 4)))
    assertTrue(facts.permitsDisplay(token, 7, "virtual-1", "setText"))
    assertTrue(facts.permitsDisplay(token, 7, "virtual-1", "nodeText"))
    assertFalse(facts.permitsFocusedText(token, 7, "virtual-1"))
    // 只有文本位：焦点文本可以，节点 setText 不行。
    facts.onDisplayCapabilities(token, mapOf(7 to DisplayCapabilities("virtual-1", 1)))
    assertTrue(facts.permitsFocusedText(token, 7, "virtual-1"))
    assertTrue(facts.permitsDisplay(token, 7, "virtual-1", "setText"))
    assertFalse(facts.permitsDisplay(token, 7, "virtual-1", "nodeText"))
    // 别名不符一律拒绝。
    assertFalse(facts.permitsFocusedText(token, 7, "virtual-2"))
  }

  @Test fun nodeReadRequiresNodeBitAndIsNotASeparateOperation() {
    val token = healthy()
    facts.onDisplayCapabilities(token, mapOf(7 to DisplayCapabilities("virtual-1", 4)))
    assertTrue(facts.permitsDisplay(token, 7, "virtual-1", "read"))
    assertTrue(facts.permitsDisplay(token, 7, "virtual-1", "nodeText"))
    facts.onDisplayCapabilities(token, mapOf(7 to DisplayCapabilities("virtual-1", 2)))
    assertFalse("只有树位时不能做节点核对", facts.permitsDisplay(token, 7, "virtual-1", "read"))
  }

  // ── SurfaceFlinger token 反查 ──────────────────────────────────────────────

  @Test fun tokenLookupMatchesExactAliasAndFailsClosed() {
    val dump = listOf(
      "    name=\"mumuscreen000\"",
      "Virtual Display 11529215047793762666",
      "    name=\"DSH virtual-1\"",
      "Virtual Display 11529215049621561620",
      "    name=\"DSH virtual-2\"",
    ).joinToString("\n")
    assertEquals("11529215047793762666",
      com.dsharnessmobile.shell.NativeShizukuCapture.parseToken(dump, "virtual-1"))
    assertEquals("11529215049621561620",
      com.dsharnessmobile.shell.NativeShizukuCapture.parseToken(dump, "virtual-2"))
    assertNull("别名不存在必须 fail-closed",
      com.dsharnessmobile.shell.NativeShizukuCapture.parseToken(dump, "virtual-3"))
    assertNull("空输出不得退化成真实屏",
      com.dsharnessmobile.shell.NativeShizukuCapture.parseToken("", "virtual-1"))
    assertNull("前缀相同的别名不得被吃掉",
      com.dsharnessmobile.shell.NativeShizukuCapture.parseToken(dump, "virtual"))
  }

  @Test fun ambiguousTokenForSameAliasIsRefused() {
    val dump = listOf(
      "Virtual Display 111",
      "    name=\"DSH virtual-1\"",
      "Virtual Display 222",
      "    name=\"DSH virtual-1\"",
    ).joinToString("\n")
    assertNull("同一别名两个 token 即歧义，不能任选其一",
      com.dsharnessmobile.shell.NativeShizukuCapture.parseToken(dump, "virtual-1"))
  }

  @Test fun captureAliasGrammarRejectsNonProductNames() {
    assertFalse("非产品别名不得当虚拟屏",
      com.dsharnessmobile.shell.NativeShizukuCapture.isVirtualAlias("vd1"))
    assertFalse(com.dsharnessmobile.shell.NativeShizukuCapture.isVirtualAlias("virtual-0"))
    assertTrue(com.dsharnessmobile.shell.NativeShizukuCapture.isVirtualAlias("virtual-12"))
  }

  // ── 动作层：displayId 只由计划给出 ────────────────────────────────────────

  private class Reply(val exitCode: Int, val output: String)

  private inner class FakeEnvironment(
    private val uid: Int = 2_000,
    private val executable: Set<String> = setOf("/system/bin/input", "/system/bin/cmd"),
    private val replies: List<Reply> = emptyList(),
  ) : NativeShizukuMotion.Environment {
    val started = mutableListOf<List<String>>()
    private var cursor = 0

    override fun uid(): Int = uid
    override fun canExecute(path: String): Boolean = path in executable
    override fun now(): Long = now
    override fun start(argv: List<String>): Process {
      started += argv.toList()
      val reply = replies.getOrNull(cursor++) ?: Reply(0, "")
      return StubProcess(reply.exitCode, reply.output)
    }
  }

  private class StubProcess(private val code: Int, private val output: String) : Process() {
    override fun getOutputStream(): OutputStream = java.io.ByteArrayOutputStream()
    override fun getInputStream(): InputStream = ByteArrayInputStream(output.toByteArray())
    override fun getErrorStream(): InputStream = ByteArrayInputStream(ByteArray(0))
    override fun waitFor(): Int = code
    override fun waitFor(timeout: Long, unit: TimeUnit): Boolean = true
    override fun exitValue(): Int = code
    override fun destroy() {}
    override fun isAlive(): Boolean = false
    override fun destroyForcibly(): Process = this
  }

  private fun deadline(remaining: Long = 4_000L): Long = now + remaining

  @Test fun virtualTapLongClickAndScrollCarryThePlannedDisplay() {
    val tap = FakeEnvironment(replies = listOf(Reply(0, "")))
    val tapOutcome = NativeShizukuMotion.execute(tap, 7, "click",
      JSONObject().put("x", 12).put("y", 34), deadline())
    assertTrue(tapOutcome.ok)
    assertEquals("yes", tapOutcome.executed)
    assertEquals(listOf("/system/bin/input", "-d", "7", "tap", "12", "34"), tap.started.single())

    val longClick = FakeEnvironment(replies = listOf(Reply(0, "")))
    NativeShizukuMotion.execute(longClick, 7, "longClick",
      JSONObject().put("x", 1).put("y", 2), deadline())
    assertEquals(listOf("/system/bin/input", "-d", "7", "swipe", "1", "2", "1", "2", "600"),
      longClick.started.single())

    val scroll = FakeEnvironment(replies = listOf(Reply(0, "")))
    val scrollOutcome = NativeShizukuMotion.execute(scroll, 7, "scroll",
      JSONObject().put("direction", "down").put("x", 50).put("y", 100)
        .put("fraction", 0.5).put("width", 480).put("height", 640), deadline())
    assertEquals("yes", scrollOutcome.executed)
    assertEquals("-d", scroll.started.single()[1])
    assertEquals("7", scroll.started.single()[2])
    assertEquals("swipe", scroll.started.single()[3])
  }

  @Test fun realTapKeepsTheHistoricNoDisplayForm() {
    val real = FakeEnvironment(replies = listOf(Reply(0, "")))
    NativeShizukuMotion.execute(real, 0, "click", JSONObject().put("x", 5).put("y", 6), deadline())
    assertEquals(listOf("/system/bin/input", "tap", "5", "6"), real.started.single())
  }

  @Test fun virtualBackTargetsItsOwnDisplayAndOtherGlobalsAreRefused() {
    // back 用 keyevent 4 + 目标 display：虚拟屏上是合法动作，且 argv 必须带该屏 id。
    val back = FakeEnvironment(replies = listOf(Reply(0, "")))
    val accepted = NativeShizukuMotion.execute(back, 7, "global",
      JSONObject().put("action", "back"), deadline())
    assertTrue(accepted.ok)
    assertEquals("yes", accepted.executed)
    assertEquals(listOf("/system/bin/input", "-d", "7", "keyevent", "4"), back.started.single())

    // 其余动作都没有带 display 的 argv，虚拟屏不得落到真实屏执行。
    for (action in listOf("home", "recents", "menu", "mediaPlayPause", "notifications",
      "quickSettings", "dismissNotificationShade")) {
      val refused = FakeEnvironment(replies = listOf(Reply(0, "")))
      val outcome = NativeShizukuMotion.execute(refused, 7, "global",
        JSONObject().put("action", action), deadline())
      // 与 Rust 的虚拟 global 判定同码：这两个层面对同一事实给同一个错误码。
      assertEquals(action, "target-unsupported", outcome.code)
      assertEquals(action, "no", outcome.executed)
      assertTrue(action + " 不得在真实屏起进程: " + refused.started, refused.started.isEmpty())
    }
  }

  @Test fun realScreenKeepsEveryVerifiedGlobalAction() {
    val back = FakeEnvironment(replies = listOf(Reply(0, "")))
    NativeShizukuMotion.execute(back, 0, "global", JSONObject().put("action", "back"), deadline())
    assertEquals(listOf("/system/bin/input", "-d", "0", "keyevent", "4"), back.started.single())

    // 逐条锁死真实屏 argv：动作名与命令必须是固定配对。
    val expected = mapOf(
      "home" to listOf("/system/bin/input", "-d", "0", "keyevent", "3"),
      "recents" to listOf("/system/bin/input", "-d", "0", "keyevent", "187"),
      "menu" to listOf("/system/bin/input", "-d", "0", "keyevent", "82"),
      "mediaPlayPause" to listOf("/system/bin/input", "-d", "0", "keyevent", "85"),
      "notifications" to listOf("/system/bin/cmd", "statusbar", "expand-notifications"),
      "quickSettings" to listOf("/system/bin/cmd", "statusbar", "expand-settings"),
      "dismissNotificationShade" to listOf("/system/bin/cmd", "statusbar", "collapse"),
    )
    for ((action, argv) in expected) {
      val fake = FakeEnvironment(replies = listOf(Reply(0, "")))
      val outcome = NativeShizukuMotion.execute(fake, 0, "global",
        JSONObject().put("action", action), deadline())
      assertTrue(action, outcome.ok)
      assertEquals(action, "yes", outcome.executed)
      assertEquals(action, argv, fake.started.single())
    }
  }

  @Test fun unimplementedGlobalActionsAreRefusedOnEveryDisplay() {
    // 没有设备证据的动作不实现：真实屏与虚拟屏都必须 invalid-global-action。
    for (action in listOf("powerDialog", "lockScreen", "toggleSplitScreen", "accessibilityShortcut")) {
      for (displayId in listOf(0, 7)) {
        val fake = FakeEnvironment(replies = listOf(Reply(0, "")))
        val outcome = NativeShizukuMotion.execute(fake, displayId, "global",
          JSONObject().put("action", action), deadline())
        assertEquals(action + "@" + displayId, "invalid-global-action", outcome.code)
        assertTrue(action + "@" + displayId + " 不得起进程: " + fake.started, fake.started.isEmpty())
      }
    }
  }

  @Test fun launchAppStaysRealScreenOnly() {
    val launch = FakeEnvironment()
    val refusedLaunch = NativeShizukuMotion.execute(launch, 7, "launchApp",
      JSONObject().put("pkg", "com.example.app"), deadline())
    assertEquals("invalid-display", refusedLaunch.code)
    assertTrue(launch.started.isEmpty())
  }

  @Test fun swipeUsesAnyStartAndEndPointIncludingReverse() {
    // 反向滑动（右下 -> 左上）合法：端点只做范围校验，不按矩形或方向拒绝。
    val reverse = FakeEnvironment(replies = listOf(Reply(0, "")))
    val outcome = NativeShizukuMotion.execute(reverse, 7, "swipe", JSONObject()
      .put("x1", 300).put("y1", 600).put("x2", 20).put("y2", 40), deadline())
    assertTrue(outcome.ok)
    assertEquals("yes", outcome.executed)
    assertEquals(listOf("/system/bin/input", "-d", "7", "swipe", "300", "600", "20", "40", "300"),
      reverse.started.single())

    // 真实屏也显式指定 display 0，防止当前焦点在虚拟屏时串屏。
    val real = FakeEnvironment(replies = listOf(Reply(0, "")))
    NativeShizukuMotion.execute(real, 0, "swipe", JSONObject()
      .put("x1", 5).put("y1", 6).put("x2", 7).put("y2", 8).put("durationMs", 800), deadline())
    assertEquals(listOf("/system/bin/input", "-d", "0", "swipe", "5", "6", "7", "8", "800"),
      real.started.single())
  }

  @Test fun swipeRejectsOutOfRangeDurationAndDegeneratePoints() {
    val tooShort = FakeEnvironment()
    assertEquals("invalid-duration", NativeShizukuMotion.execute(tooShort, 7, "swipe", JSONObject()
      .put("x1", 1).put("y1", 2).put("x2", 3).put("y2", 4).put("durationMs", 49), deadline()).code)
    assertTrue(tooShort.started.isEmpty())

    val tooLong = FakeEnvironment()
    assertEquals("invalid-duration", NativeShizukuMotion.execute(tooLong, 7, "swipe", JSONObject()
      .put("x1", 1).put("y1", 2).put("x2", 3).put("y2", 4).put("durationMs", 2_001), deadline()).code)
    assertTrue(tooLong.started.isEmpty())

    val same = FakeEnvironment()
    assertEquals("gesture-degenerate", NativeShizukuMotion.execute(same, 7, "swipe", JSONObject()
      .put("x1", 9).put("y1", 9).put("x2", 9).put("y2", 9), deadline()).code)
    assertTrue(same.started.isEmpty())

    // 额外参数（例如自带 argv 或 keycode）一律拒绝。
    val extra = FakeEnvironment()
    assertEquals("invalid-arguments", NativeShizukuMotion.execute(extra, 7, "swipe", JSONObject()
      .put("x1", 1).put("y1", 2).put("x2", 3).put("y2", 4).put("argv", "rm -rf /"), deadline()).code)
    assertTrue(extra.started.isEmpty())
  }

  @Test fun keyEventMapsOnlyTheElevenFixedNames() {
    val expected = mapOf(
      "enter" to "66", "tab" to "61", "escape" to "111", "backspace" to "67",
      "delete" to "112", "space" to "62", "up" to "19", "down" to "20",
      "left" to "21", "right" to "22", "back" to "4",
    )
    for ((name, code) in expected) {
      val fake = FakeEnvironment(replies = listOf(Reply(0, "")))
      val outcome = NativeShizukuMotion.execute(fake, 7, "keyEvent",
        JSONObject().put("key", name), deadline())
      assertTrue(name, outcome.ok)
      assertEquals(name, listOf("/system/bin/input", "-d", "7", "keyevent", code),
        fake.started.single())
    }
    // 真实屏按键也不能跟随当前焦点屏幕。
    val real = FakeEnvironment(replies = listOf(Reply(0, "")))
    NativeShizukuMotion.execute(real, 0, "keyEvent", JSONObject().put("key", "enter"), deadline())
    assertEquals(listOf("/system/bin/input", "-d", "0", "keyevent", "66"), real.started.single())
  }

  @Test fun keyEventRefusesUnknownNamesAndRawKeycodes() {
    // 名字不在固定表里：invalid-key。
    for (args in listOf(JSONObject().put("key", "power"), JSONObject().put("key", "66"))) {
      val fake = FakeEnvironment()
      val outcome = NativeShizukuMotion.execute(fake, 7, "keyEvent", args, deadline())
      assertEquals(args.toString(), "invalid-key", outcome.code)
      assertEquals("no", outcome.executed)
      assertTrue("拒绝路径不得起进程: " + args, fake.started.isEmpty())
    }
    // 想直接传 keycode 或额外参数：参数形状本身就不合法。
    for (args in listOf(
      JSONObject().put("keycode", 66),
      JSONObject().put("key", "enter").put("keycode", 66),
      JSONObject(),
    )) {
      val fake = FakeEnvironment()
      val outcome = NativeShizukuMotion.execute(fake, 7, "keyEvent", args, deadline())
      assertEquals(args.toString(), "invalid-arguments", outcome.code)
      assertTrue("拒绝路径不得起进程: " + args, fake.started.isEmpty())
    }
  }

  @Test fun negativeDisplayStartsNothing() {
    val fake = FakeEnvironment()
    val outcome = NativeShizukuMotion.execute(fake, -1, "click",
      JSONObject().put("x", 1).put("y", 1), deadline())
    assertEquals("invalid-display", outcome.code)
    assertTrue(fake.started.isEmpty())
  }

  @Test fun failedGestureStaysUnknownAndIsNeverRetried() {
    val failed = FakeEnvironment(replies = listOf(Reply(1, "")))
    val outcome = NativeShizukuMotion.execute(failed, 7, "click",
      JSONObject().put("x", 10).put("y", 20), deadline())
    assertEquals("motion-unconfirmed", outcome.code)
    assertEquals("unknown", outcome.executed)
    assertEquals(1, failed.started.size)
  }

  // ── 执行适配器：虚拟目标只认已登记别名 ────────────────────────────────────

  private class Adapter(registered: Map<String, Int> = mapOf("virtual-1" to 7)) {
    var a11yCalls = 0
    val execution = NativeShizukuExecution(object : NativeControlDispatcher.Platform {
      override fun implements(plan: JSONObject) = true
      override fun execute(callId: String, plan: JSONObject, args: JSONObject,
        refreshFacts: () -> Boolean, authorize: () -> Boolean): CompletableFuture<JSONObject> {
        a11yCalls++
        return CompletableFuture.completedFuture(JSONObject().put("executed", "yes"))
      }
    }, { alias -> registered[alias] })

    fun plan(operation: String, alias: String = "virtual-1", displayId: Int = 7,
      nodeTarget: Boolean = false): JSONObject = JSONObject()
      .put("backend", "shizuku").put("operation", operation).put("screenId", alias)
      .put("displayId", displayId).put("width", 480).put("height", 640)
      .put("epoch", "3").put("generation", "8")
      .also {
        if (nodeTarget) it.put("nodeTarget",
          JSONObject().put("windowId", 5).put("path", JSONArray(listOf(0, 1))))
      }
  }

  @Test fun virtualPlansBelongToThisAdapterOnlyWhenTheAliasIsRegistered() {
    val adapter = Adapter()
    // 所有动作都要能被虚拟目标接收：坐标、滑动、按键、全局、文本、树、截图。
    for (operation in listOf("click", "longClick", "scroll", "swipe", "keyEvent", "global",
      "setText", "snapshot", "screenshot", "readRegion")) {
      assertTrue(operation, adapter.execution.implements(adapter.plan(operation)))
    }
    assertTrue(adapter.execution.implements(adapter.plan("click", nodeTarget = true)))
    assertFalse("未登记的别名不得被任何适配器接收",
      adapter.execution.implements(adapter.plan("click", alias = "virtual-9", displayId = 9)))
    assertFalse("displayId 与注册表不一致时必须拒绝",
      adapter.execution.implements(adapter.plan("snapshot", displayId = 9)))
    val withoutDisplayId = JSONObject(adapter.plan("snapshot").toString())
    withoutDisplayId.remove("displayId")
    assertFalse("缺 displayId 不得按选中屏补齐",
      adapter.execution.implements(withoutDisplayId))
    assertTrue("真实屏计划仍由真实屏路径接收，不落到虚拟分支",
      adapter.execution.implements(adapter.plan("screenshot", alias = "real", displayId = 0)))
  }

  @Test fun unregisteredVirtualTargetIsRejectedWithoutTouchingA11y() {
    val adapter = Adapter()
    val reply = adapter.execution.execute("v-1",
      adapter.plan("snapshot", alias = "virtual-9", displayId = 9),
      JSONObject(), { true }, { true }).get()
    assertEquals("platform-adapter-unavailable", reply.getString("code"))
    assertEquals("no", reply.getString("executed"))
    assertEquals("A11y 不得接手虚拟屏计划", 0, adapter.a11yCalls)
    assertFalse(reply.has("screenId"))
  }

  @Test fun oversizedVirtualTextIsRejectedBeforeAnyDispatch() {
    val adapter = Adapter()
    val reply = adapter.execution.execute("v-2", adapter.plan("setText"),
      JSONObject().put("text", "x".repeat(8193)).put("clear", true), { true }, { true }).get()
    assertEquals("invalid-text", reply.getString("code"))
    assertEquals("no", reply.getString("executed"))
    assertEquals(0, adapter.a11yCalls)
  }

  // ── 来源判据：哪段代码允许碰哪块屏 ──────────────────────────────────────

  @Test fun aidlAppendsDisplayTransactionsWithoutRenumbering() {
    val aidl = repoFile("app/src/main/aidl/com/dsharnessmobile/shell/ShizukuUserService.aidl").readText()
    for (anchor in listOf(
      "Bundle nativeSetTextReal(String text, boolean clear, long deadlineMs) = 13;",
      "Bundle nativeSnapshotReal(int displayId, long deadlineMs) = 14;",
      "@nullable android.os.ParcelFileDescriptor nativeCaptureReal(long deadlineMs) = 15;",
      "Bundle nativeMotionReal(String operation, String argsJson, long deadlineMs) = 16;",
    )) {
      assertTrue("既有事务号不得重排：" + anchor, aidl.contains(anchor))
    }
    for (anchor in listOf(
      "int nativeDisplayCapabilities(int displayId, String alias) = 18;",
      "Bundle nativeSetTextDisplay(int displayId, String text, boolean clear, long deadlineMs) = 19;",
      "@nullable android.os.ParcelFileDescriptor nativeCaptureDisplay(int displayId, String alias, long deadlineMs) = 20;",
      "Bundle nativeNodeDisplay(int displayId, int windowId, in int[] path, String operation, String argsJson, String expectedNode, long deadlineMs) = 21;",
      "Bundle nativeMotionDisplay(int displayId, String operation, String argsJson, long deadlineMs) = 22;",
    )) {
      assertTrue("新增事务必须逐字入册：" + anchor, aidl.contains(anchor))
    }
    val service = repoFile("app/src/main/java/com/dsharnessmobile/shell/ShizukuUserService.kt").readText()
    assertEquals("协议版本必须前进到 v6", "6",
      Regex("const val PROTOCOL_VERSION = (\\d+)").find(service)?.groupValues?.get(1))
  }

  @Test fun editorOnlyPicksWindowsOfTheRequestedDisplay() {
    val source = repoFile("app/src/main/java/com/dsharnessmobile/shell/NativeShizukuEditor.kt").readText()
    assertTrue(source.contains("ui.windowsOnAllDisplays[displayId]"))
    assertFalse("不得再用固定 display 0 取窗口", source.contains("windowsOnAllDisplays[0]"))
    assertTrue("全局焦点必须属于目标屏的应用窗口",
      source.contains("appWindows.firstOrNull { it.id == focus.windowId }"))
    assertTrue("真实屏没有焦点就不写", source.contains("if (displayId == 0) return Lookup.Missing"))
    assertTrue(source.contains("MAX_EDITOR_DEPTH"))
    for (fallback in listOf("ClipboardManager", "KeyEvent", "uiautomator", "ProcessBuilder")) {
      assertFalse("编辑器不得出现回退通道 " + fallback, source.contains(fallback))
    }
  }

  @Test fun editorFallbackNeedsASingleWritableEditorAndStaysBounded() {
    val source = repoFile("app/src/main/java/com/dsharnessmobile/shell/NativeShizukuEditor.kt").readText()
    // 无焦点兜底只允许「唯一可写编辑器」：多于一个即判歧义，绝不任取第一个。
    assertTrue(source.contains("if (scan.editables > 1)"))
    assertTrue(source.contains("scan.ambiguous = true"))
    assertTrue(source.contains("focused-editor-ambiguous"))
    assertTrue("兜底只在虚拟屏生效", source.contains("if (displayId == 0) return Lookup.Missing"))
    assertTrue("虚拟屏兜底窗口必须是唯一应用窗口", source.contains("appWindows.singleOrNull()"))
    // 遍历必须有总节点预算，不能只靠深度。
    assertTrue(source.contains("MAX_EDITOR_NODES"))
    assertTrue(source.contains("if (scan.visited > MAX_EDITOR_NODES)"))
    // 查到的节点由统一的 release 归还，探针路径不能留节点。
    assertTrue(source.contains("val release: () -> Unit"))
    assertTrue(source.contains("fun releaseAll(extra: AccessibilityNodeInfo?)"))
    assertTrue("非保留路径必须立即归还", source.contains("if (!keepNode) found.release()"))
    assertTrue("没有候选时也必须归还 root", source.contains("if (!handedOff) scan.releaseAll(root)"))
  }

  @Test fun nodeActionBindsWindowToTheRequestedDisplay() {
    val source = repoFile("app/src/main/java/com/dsharnessmobile/shell/NativeShizukuNode.kt").readText()
    assertTrue(source.contains("ui.windowsOnAllDisplays[displayId]"))
    assertFalse(source.contains("windowsOnAllDisplays[0]"))
    assertTrue("窗口必须来自目标屏列表", source.contains("windows.firstOrNull { it.id == windowId }"))
    assertTrue(source.contains("node-display-unavailable"))
  }

  @Test fun captureResolvesTokenPerCallAndNeverFallsBackToReal() {
    val source = repoFile("app/src/main/java/com/dsharnessmobile/shell/NativeShizukuCapture.kt").readText()
    assertTrue("虚拟屏必须现查 token",
      source.contains("val token = resolveToken(alias, deadlineMs) ?: return null"))
    val virtualBranch = source.substringAfter("else {").substringBefore("val process = try")
    assertTrue("虚拟分支取不到 token 必须直接返回", virtualBranch.contains("?: return null"))
    assertTrue("虚拟分支必须用 -d <token> 取图",
      virtualBranch.contains("\"/system/bin/screencap\", \"-d\", token, \"-p\""))
    assertFalse("虚拟分支不得退回无参 screencap",
      virtualBranch.contains("listOf(\"/system/bin/screencap\", \"-p\")"))
    assertTrue("真实屏显式 display 0", source.contains("private const val REAL_DISPLAY_ID = 0"))
    assertFalse("token 不得缓存", source.contains("tokenCache"))
  }

  @Test fun factsOnlyPublishDisplaysThatWereActuallyMeasured() {
    val facts = repoFile(
      "app/src/main/java/com/dsharnessmobile/shell/nativecontrol/NativeShizukuFacts.kt").readText()
    assertTrue(facts.contains("fun onDisplayCapabilities(token: LinkToken"))
    assertTrue("屏表必须随连接一起失效", facts.contains("displayBits = null"))
    assertTrue(facts.contains("displayOperations"))
    val platform = repoFile(
      "app/src/main/java/com/dsharnessmobile/shell/nativecontrol/NativePlatformFacts.kt").readText()
    assertTrue("只合并仍注册的屏", platform.contains("id in registeredDisplayIds"))
    assertTrue(platform.contains("shizukuFacts.remove(\"displayOperations\")"))
  }

  private fun repoFile(path: String): java.io.File {
    var dir: java.io.File? = java.io.File(".").absoluteFile
    while (dir != null) {
      if (java.io.File(dir, "settings.gradle.kts").isFile) {
        val hit = java.io.File(dir, path)
        if (hit.isFile) return hit
      }
      dir = dir.parentFile
    }
    throw AssertionError("找不到 " + path)
  }

}
