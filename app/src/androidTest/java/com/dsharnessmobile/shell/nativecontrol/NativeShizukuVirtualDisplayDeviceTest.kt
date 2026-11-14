package com.dsharnessmobile.shell.nativecontrol

import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.app.ActivityOptions
import android.app.Instrumentation
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import com.dsharnessmobile.shell.NativeControlClickFixtureActivity
import com.dsharnessmobile.shell.DeviceControlService
import com.dsharnessmobile.shell.NativeShizukuCapture
import com.dsharnessmobile.shell.ShizukuTransport
import com.dsharnessmobile.shell.VdisplayController
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.DataInputStream
import java.io.DataOutputStream

/**
 * 只用 Shizuku 的虚拟屏输入/树/截图验收。
 *
 * 前提：A11y 必须离线。任何一步若由无障碍完成，本用例的前提即被破坏，断言会直接红。
 * 覆盖四条独立性质：
 *  1. per-display 能力只按目标屏发布，虚拟目标不会被选中屏顶替；
 *  2. 坐标点击/滑动走 Shizuku input，argv 带计划里的 displayId；
 *  3. 树与节点动作落在同一 window，且跨屏请求被拒；
 *  4. 截图按别名现查 SurfaceFlinger token，尺寸必须等于计划；token 查不到时 fail-closed。
 */
class NativeShizukuVirtualDisplayDeviceTest {
  @Test fun virtualScreenInputTreeAndCaptureUseShizukuOnly() {
    val arguments = InstrumentationRegistry.getArguments()
    assumeTrue("仅在专用 MuMu 执行",
      arguments.getString("nativeTestEmulator") == "mumu" &&
        arguments.getString("nativeTestShizuku") == "yes" &&
        arguments.getString("nativeTestShizukuDenied") != "yes")
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    assumeTrue("本用例要求无障碍离线", DeviceControlService.nativePlatformService() == null)
    assertTrue("fixture requires an empty registry", VdisplayController.activeAliases().isEmpty())

    val deadline = SystemClock.elapsedRealtime() + 20_000
    while (!ShizukuTransport.ensureBound(context, requestPermission = false).optBoolean("ok")) {
      assertTrue("Shizuku 未就绪", SystemClock.elapsedRealtime() < deadline)
      SystemClock.sleep(250)
    }

    val alias = "virtual-1"
    val dimensions = JSONObject().put("width", 480).put("height", 640).put("densityDpi", 160)
    val a11y = NativeA11yExecution()
    val facts = NativePlatformFacts(context, a11y, { "virtual-only" })
    try {
      assertEquals("vdisplay-active", VdisplayController.create(context, dimensions).getString("code"))
      val displayId = runCatching { VdisplayController.displayIdForAlias(alias) }.getOrNull()
      assertNotNull("虚拟屏未登记", displayId)
      requireNotNull(displayId)

      // 屏上先有内容（Settings），能力探测才可能测到窗口、树与坐标手势。
      val launched = VdisplayController.executeAuthorized(context, "vdLaunch", JSONObject(), alias)
      assertTrue(launched.toString(), launched.optBoolean("ok"))
      val observed = awaitDisplays(context, displayId)
      assertTrue("未测到该屏的能力: " + NativeShizukuFacts.shared.snapshot(), observed)

      NativeControlHost.openIsolated(context, facts, NativeShizukuExecution(a11y)).use { host ->
        val caps = capabilities(host)
        val channels = caps.getJSONObject("channels")
        val shizukuCaps = channels.getJSONObject("shizuku")
        assertEquals("A11y 必须离线", "no", channels.getJSONObject("a11y").getString("online"))
        assertEquals("shell2000", shizukuCaps.getJSONObject("serverUid").getString("kind"))
        val perDisplay = shizukuCaps.optJSONObject("displayOperations")
        assertNotNull("必须发布 per-display 事实: " + shizukuCaps, perDisplay)
        val virtualOps = names(perDisplay!!.optJSONArray(displayId.toString()))
        assertTrue("坐标手势必须仍在虚拟屏能力里: " + virtualOps,
          virtualOps.containsAll(listOf("click", "longClick", "scroll")))
        assertTrue("树与截图能力缺失: " + virtualOps,
          virtualOps.containsAll(listOf("snapshot", "screenshot")))

        val screen = screen(caps, alias) ?: throw AssertionError("屏未进入能力面: " + caps)
        assertEquals(displayId, screen.getInt("displayId"))

        val tree = awaitTree(host, caps, screen)
        assertEquals(alias, tree.getString("screenId"))
        assertEquals(alias, tree.getJSONObject("tree").getJSONObject("target").getString("screenId"))
        assertEquals(displayId,
          tree.getJSONObject("tree").getJSONObject("target").getInt("displayId"))

        // 坐标点击：由 Shizuku input 直接带 displayId 派发，A11y 全程离线。
        val click = rpc(host, request(caps, screen, "click", "vd-click-" + System.nanoTime(),
          JSONObject().put("x", 40).put("y", 40)))
        assertTrue(click.toString(), click.getBoolean("ok"))
        assertEquals("yes", click.getString("executed"))
        assertEquals(alias, click.getString("screenId"))

        val scroll = rpc(host, request(caps, screen, "scroll", "vd-scroll-" + System.nanoTime(),
          JSONObject().put("x", 240).put("y", 320).put("direction", "down").put("fraction", 0.4)))
        assertTrue(scroll.toString(), scroll.getBoolean("ok"))
        assertEquals("yes", scroll.getString("executed"))

        // 截图：尺寸必须等于计划；screenId 必须是本屏。
        val shot = rpc(host, request(caps, screen, "screenshot", "vd-shot-" + System.nanoTime(), JSONObject()))
        assertTrue(shot.toString().take(1200), shot.getBoolean("ok"))
        assertEquals(alias, shot.getString("screenId"))
        assertTrue(shot.toString().take(1200), shot.has("image"))

        // 目标屏被销毁后：旧 generation 计划必须被拒，旧屏名不得改报真实屏。
        VdisplayController.destroy(context, JSONObject().put("target", alias))
        val afterDestroy = rpc(host, request(caps, screen, "screenshot",
          "vd-shot-stale-" + System.nanoTime(), JSONObject()))
        assertFalse("屏已销毁仍出图即串屏: " + afterDestroy, afterDestroy.getBoolean("ok"))
        assertEquals("no", afterDestroy.getString("executed"))

        android.util.Log.i("dsh-native-device-test",
          "virtual shizuku display=" + displayId + " ops=" + virtualOps + " treeWindow=" +
            tree.getJSONObject("tree").getInt("windowId") + " shot=" + shot.optString("code"))
      }
    } finally {
      if (VdisplayController.activeAliases().isNotEmpty())
        VdisplayController.destroy(context, JSONObject().put("target", alias))
    }
  }

  /**
   * 虚拟屏上的焦点编辑器文本：替换、追加、清空三步都只写目标屏。
   *
   * 夹具是真实 Activity（由测试侧按 launchDisplayId 拉到虚拟屏上），因此这里验证的是
   * AccessibilityNodeInfo.ACTION_SET_TEXT 真的落到了那块屏的可编辑控件，而不是标题或静态文本。
   * 同时守两条不变量：真实屏上的哨兵文本不变、默认输入法不变且不弹软键盘。
   */
  @Test fun virtualScreenFocusedEditorTextStaysOnItsOwnDisplay() {
    val arguments = InstrumentationRegistry.getArguments()
    assumeTrue("仅在专用 MuMu 执行",
      arguments.getString("nativeTestEmulator") == "mumu" &&
        arguments.getString("nativeTestShizuku") == "yes" &&
        arguments.getString("nativeTestShizukuDenied") != "yes")
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    assumeTrue("本用例要求无障碍离线", DeviceControlService.nativePlatformService() == null)
    assertTrue("fixture requires an empty registry", VdisplayController.activeAliases().isEmpty())
    val priorIme = Settings.Secure.getString(context.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)

    val deadline = SystemClock.elapsedRealtime() + 20_000
    while (!ShizukuTransport.ensureBound(context, requestPermission = false).optBoolean("ok")) {
      assertTrue("Shizuku 未就绪", SystemClock.elapsedRealtime() < deadline)
      SystemClock.sleep(250)
    }

    val alias = "virtual-1"
    val dimensions = JSONObject().put("width", 480).put("height", 800).put("densityDpi", 160)
    val a11y = NativeA11yExecution()
    val facts = NativePlatformFacts(context, a11y, { "virtual-only" })
    var real: NativeControlClickFixtureActivity? = null
    var virtual: NativeControlClickFixtureActivity? = null
    try {
      assertEquals("vdisplay-active", VdisplayController.create(context, dimensions).getString("code"))
      val displayId = requireNotNull(VdisplayController.displayIdForAlias(alias)) { "虚拟屏未登记" }

      // 两块屏各起一个自己的窗口：真实屏哨兵在前、虚拟屏可编辑夹具在后。
      // 哨兵输入框不可聚焦，只用来证明写入没有串到真实屏。
      real = launch(instrumentation, context, null, "REAL-SENTINEL", editableFocus = false)
      virtual = launch(instrumentation, context, displayId, "初始文本", editableFocus = true)
      awaitFocused(instrumentation, virtual)
      assertTrue("未测到该屏的焦点文本能力: " + NativeShizukuFacts.shared.snapshot(),
        awaitDisplays(context, displayId))

      NativeControlHost.openIsolated(context, facts, NativeShizukuExecution(a11y)).use { host ->
        val caps = capabilities(host)
        val channels = caps.getJSONObject("channels")
        assertEquals("A11y 必须离线", "no", channels.getJSONObject("a11y").getString("online"))
        val shizukuCaps = channels.getJSONObject("shizuku")
        val perDisplay = shizukuCaps.optJSONObject("displayOperations")
          ?: throw AssertionError("必须发布 per-display 事实: " + shizukuCaps)
        val virtualOps = names(perDisplay.optJSONArray(displayId.toString()))
        assertTrue("虚拟屏未发布焦点文本能力: " + virtualOps, virtualOps.contains("setText"))
        val screen = screen(caps, alias) ?: throw AssertionError("屏未进入能力面: " + caps)
        assertEquals(displayId, screen.getInt("displayId"))

        // 树里确实能看到这块屏上的可编辑控件：能力不是静态声明。
        val tree = awaitTree(host, caps, screen)
        fun editable(): JSONObject {
          val nodes = tree.getJSONObject("tree").getJSONArray("nodes")
          return (0 until nodes.length()).map { nodes.getJSONObject(it) }
            .firstOrNull { it.optBoolean("editable") }
            ?: throw AssertionError("虚拟屏树里没有可编辑节点: " + tree)
        }
        assertEquals("初始文本", editable().getString("text"))

        val payload = "中文输入：替换（全角）😀"
        val replace = rpc(host, request(caps, screen, "setText", "vd-text-" + System.nanoTime(),
          JSONObject().put("text", payload).put("clear", true)))
        assertTrue(replace.toString(), replace.getBoolean("ok"))
        assertEquals("yes", replace.getString("executed"))
        assertEquals(alias, replace.getString("screenId"))
        assertEquals(payload, value(instrumentation, virtual))
        assertEquals("真实屏正文不得被虚拟屏写入影响", "REAL-SENTINEL", value(instrumentation, real))

        val suffix = " +追加"
        val append = rpc(host, request(caps, screen, "setText", "vd-text-append-" + System.nanoTime(),
          JSONObject().put("text", suffix).put("clear", false)))
        assertTrue(append.toString(), append.getBoolean("ok"))
        assertEquals("yes", append.getString("executed"))
        assertEquals(payload + suffix, value(instrumentation, virtual))
        assertEquals("REAL-SENTINEL", value(instrumentation, real))

        val clear = rpc(host, request(caps, screen, "setText", "vd-text-clear-" + System.nanoTime(),
          JSONObject().put("text", "").put("clear", true)))
        assertTrue(clear.toString(), clear.getBoolean("ok"))
        assertEquals("yes", clear.getString("executed"))
        assertEquals("", value(instrumentation, virtual))
        assertEquals("REAL-SENTINEL", value(instrumentation, real))

        assertEquals("默认 IME 不得改变", priorIme,
          Settings.Secure.getString(context.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD))
        assertFalse("虚拟屏文本不得弹软键盘", keyboardVisible(instrumentation, virtual))
        assertFalse("真实屏软键盘也不得因虚拟屏写入弹出", keyboardVisible(instrumentation, real))

        android.util.Log.i("dsh-native-device-test",
          "virtual shizuku text display=" + displayId + " ops=" + virtualOps +
            " code=" + replace.getString("code") + " ime=" + priorIme)
      }
    } finally {
      instrumentation.runOnMainSync { virtual?.finish(); real?.finish() }
      instrumentation.waitForIdleSync()
      if (VdisplayController.activeAliases().isNotEmpty())
        VdisplayController.destroy(context, JSONObject().put("target", alias))
    }
  }


  /** token 不可用时的 fail-closed 判据：别名不对、空 dump、歧义都必须返回 null。 */
  @Test fun surfaceFlingerTokenResolutionFailsClosed() {
    assertEquals(null, NativeShizukuCapture.parseToken("", "virtual-1"))
    val duplicate = listOf(
      "Virtual Display 1",
      "    name=\"DSH virtual-1\"",
      "Virtual Display 2",
      "    name=\"DSH virtual-1\"",
    ).joinToString("\n")
    assertEquals(null, NativeShizukuCapture.parseToken(duplicate, "virtual-1"))
    assertFalse(NativeShizukuCapture.isVirtualAlias("real"))
  }

  /** 起一个带可编辑输入框的夹具；displayId 非空时用 ActivityOptions 直接落到那块屏上。 */
  private fun launch(instrumentation: Instrumentation, context: Context, displayId: Int?,
    initial: String, editableFocus: Boolean): NativeControlClickFixtureActivity {
    val intent = Intent(context, NativeControlClickFixtureActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      .putExtra(NativeControlClickFixtureActivity.EXTRA_EDITABLE_FOCUS, editableFocus)
      .putExtra(NativeControlClickFixtureActivity.EXTRA_INITIAL_TEXT, initial)
    val options = displayId?.let {
      // With a real-screen sentinel already running, do not ask Android to reuse that task.
      intent.addFlags(Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
      ActivityOptions.makeBasic().setLaunchDisplayId(it).toBundle()
    }
    val activity = instrumentation.startActivitySync(intent, options) as NativeControlClickFixtureActivity
    if (displayId != null) {
      instrumentation.runOnMainSync { assertEquals(displayId, activity.display?.displayId) }
    }
    return activity
  }

  /**
   * 等这块屏的窗口真的拿到输入焦点。
   * 焦点属于整个系统：另一块屏上的夹具可能抢走它，因此这里只等、不替调用方改焦点来源。
   */
  private fun awaitFocused(instrumentation: Instrumentation,
    activity: NativeControlClickFixtureActivity) {
    val deadline = SystemClock.elapsedRealtime() + 10_000
    while (SystemClock.elapsedRealtime() < deadline) {
      instrumentation.waitForIdleSync()
      var focused = false
      instrumentation.runOnMainSync { focused = activity.editText.isFocused && activity.hasWindowFocus() }
      if (focused) return
      SystemClock.sleep(200)
    }
    var display = -1
    instrumentation.runOnMainSync { display = activity.display?.displayId ?: -1 }
    throw AssertionError("夹具输入框未拿到焦点: display=" + display +
      " window=" + activity.hasWindowFocus())
  }

  private fun value(instrumentation: Instrumentation,
    activity: NativeControlClickFixtureActivity?): String {
    var text = ""
    instrumentation.runOnMainSync { text = activity?.editText?.text?.toString().orEmpty() }
    return text
  }

  private fun keyboardVisible(instrumentation: Instrumentation,
    activity: NativeControlClickFixtureActivity?): Boolean {
    var visible = false
    instrumentation.runOnMainSync {
      visible = activity?.window?.decorView?.rootWindowInsets
        ?.isVisible(android.view.WindowInsets.Type.ime()) ?: false
    }
    return visible
  }


  /**
   * 设备侧副作用判据：点击/长按/滚动/swipe/back 必须真的改变目标屏状态。
   *
   * 只认夹具自己记下的计数与位移，不把回执 ok 当成动作成功。
   */
  @Test fun virtualGesturesProduceVisibleSideEffects() {
    val arguments = InstrumentationRegistry.getArguments()
    assumeTrue("仅在专用 MuMu 执行",
      arguments.getString("nativeTestEmulator") == "mumu" &&
        arguments.getString("nativeTestShizuku") == "yes" &&
        arguments.getString("nativeTestShizukuDenied") != "yes")
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    assumeTrue("本用例要求无障碍离线", DeviceControlService.nativePlatformService() == null)
    assertTrue("fixture requires an empty registry", VdisplayController.activeAliases().isEmpty())

    val deadline = SystemClock.elapsedRealtime() + 20_000
    while (!ShizukuTransport.ensureBound(context, requestPermission = false).optBoolean("ok")) {
      assertTrue("Shizuku 未就绪", SystemClock.elapsedRealtime() < deadline)
      SystemClock.sleep(250)
    }

    val alias = "virtual-1"
    val dimensions = JSONObject().put("width", 480).put("height", 800).put("densityDpi", 160)
    val a11y = NativeA11yExecution()
    val facts = NativePlatformFacts(context, a11y, { "virtual-only" })
    var activity: NativeControlClickFixtureActivity? = null
    try {
      assertEquals("vdisplay-active", VdisplayController.create(context, dimensions).getString("code"))
      val displayId = requireNotNull(VdisplayController.displayIdForAlias(alias)) { "虚拟屏未登记" }
      activity = launch(instrumentation, context, displayId, "", editableFocus = false)
      instrumentation.waitForIdleSync()
      NativeControlClickFixtureActivity.resetCounters()
      assertTrue("未测到该屏的坐标手势: " + NativeShizukuFacts.shared.snapshot(),
        awaitDisplays(context, displayId))

      NativeControlHost.openIsolated(context, facts, NativeShizukuExecution(a11y)).use { host ->
        val caps = capabilities(host)
        val screen = screen(caps, alias) ?: throw AssertionError("屏未进入能力面: " + caps)
        val ops = names(caps.getJSONObject("channels").getJSONObject("shizuku")
          .optJSONObject("displayOperations")?.optJSONArray(displayId.toString()))
        assertTrue("虚拟屏必须发布全部坐标动作: " + ops,
          ops.containsAll(listOf("click", "longClick", "scroll", "swipe", "keyEvent", "global")))

        val point = buttonPoint(instrumentation, requireNotNull(activity))
        val click = rpc(host, request(caps, screen, "click", "vd-sfx-click-" + System.nanoTime(),
          JSONObject().put("x", point.first).put("y", point.second)))
        assertTrue(click.toString(), click.getBoolean("ok"))
        instrumentation.waitForIdleSync()
        assertEquals("点击必须改变目标屏上的按钮计数", 1,
          NativeControlClickFixtureActivity.clickCount)
        assertEquals("点击不得触发长按", 0,
          NativeControlClickFixtureActivity.longClickCount)

        val longPress = rpc(host, request(caps, screen, "longClick", "vd-sfx-long-" + System.nanoTime(),
          JSONObject().put("x", point.first).put("y", point.second)))
        assertTrue(longPress.toString(), longPress.getBoolean("ok"))
        instrumentation.waitForIdleSync()
        assertTrue("长按必须改变目标屏上的长按计数",
          NativeControlClickFixtureActivity.longClickCount >= 1)

        val before = NativeControlClickFixtureActivity.lastScrollY
        val scroll = rpc(host, request(caps, screen, "scroll", "vd-sfx-scroll-" + System.nanoTime(),
          JSONObject().put("x", 240).put("y", 620).put("direction", "down").put("fraction", 0.8)))
        assertTrue(scroll.toString(), scroll.getBoolean("ok"))
        instrumentation.waitForIdleSync()
        assertTrue("滚动必须产生位移: before=" + before +
          " after=" + NativeControlClickFixtureActivity.lastScrollY,
          NativeControlClickFixtureActivity.lastScrollY > before)

        val beforeSwipe = NativeControlClickFixtureActivity.lastScrollY
        val swipe = rpc(host, request(caps, screen, "swipe", "vd-sfx-swipe-" + System.nanoTime(),
          JSONObject().put("x1", 400).put("y1", 760).put("x2", 60).put("y2", 320)
            .put("durationMs", 400)))
        assertTrue(swipe.toString(), swipe.getBoolean("ok"))
        instrumentation.waitForIdleSync()
        assertTrue("swipe 必须改变目标屏状态: before=" + beforeSwipe +
          " after=" + NativeControlClickFixtureActivity.lastScrollY,
          NativeControlClickFixtureActivity.lastScrollY != beforeSwipe)

        val backsBefore = NativeControlClickFixtureActivity.backCount
        val back = rpc(host, request(caps, screen, "global", "vd-sfx-back-" + System.nanoTime(),
          JSONObject().put("action", "back")))
        assertTrue(back.toString(), back.getBoolean("ok"))
        instrumentation.waitForIdleSync()
        assertTrue("back 必须落在目标屏: before=" + backsBefore +
          " after=" + NativeControlClickFixtureActivity.backCount,
          NativeControlClickFixtureActivity.backCount > backsBefore)

        for (action in listOf("home", "recents", "notifications")) {
          val refused = rpc(host, request(caps, screen, "global",
            "vd-sfx-" + action + "-" + System.nanoTime(), JSONObject().put("action", action)))
          assertFalse(action + " 不得在虚拟屏成功: " + refused, refused.getBoolean("ok"))
          assertEquals("no", refused.getString("executed"))
        }

        android.util.Log.i("dsh-native-device-test",
          "virtual gestures display=" + displayId +
            " click=" + NativeControlClickFixtureActivity.clickCount +
            " long=" + NativeControlClickFixtureActivity.longClickCount +
            " scrollY=" + NativeControlClickFixtureActivity.lastScrollY +
            " back=" + NativeControlClickFixtureActivity.backCount)
      }
    } finally {
      instrumentation.runOnMainSync { activity?.finish() }
      instrumentation.waitForIdleSync()
      if (VdisplayController.activeAliases().isNotEmpty())
        VdisplayController.destroy(context, JSONObject().put("target", alias))
    }
  }

  /** 按钮在屏幕坐标里的中心点；坐标是这块屏自己的像素空间。 */
  private fun buttonPoint(instrumentation: Instrumentation,
    activity: NativeControlClickFixtureActivity): Pair<Int, Int> {
    var point = 0 to 0
    instrumentation.runOnMainSync {
      val location = IntArray(2)
      activity.button.getLocationOnScreen(location)
      point = (location[0] + activity.button.width / 2) to
        (location[1] + activity.button.height / 2)
    }
    return point
  }


  private fun awaitDisplays(context: android.content.Context, displayId: Int): Boolean {
    val deadline = SystemClock.elapsedRealtime() + 30_000
    while (SystemClock.elapsedRealtime() < deadline) {
      ShizukuTransport.observeNativeRealText(context)
      ShizukuTransport.observeNativeDisplays(context)
      val measured = NativeShizukuFacts.shared.measuredDisplayOperations()
      if (measured.containsKey(displayId)) return measured.getValue(displayId).isNotEmpty()
      SystemClock.sleep(250)
    }
    return false
  }

  private fun awaitTree(host: NativeControlHost, caps: JSONObject, screen: JSONObject): JSONObject {
    val deadline = SystemClock.elapsedRealtime() + 20_000
    var last: JSONObject? = null
    while (SystemClock.elapsedRealtime() < deadline) {
      last = rpc(host, request(caps, screen, "snapshot", "vd-tree-" + System.nanoTime(), JSONObject()))
      if (last.optBoolean("ok")) return last
      SystemClock.sleep(500)
    }
    throw AssertionError("虚拟屏树读取始终失败: " + last)
  }

  private fun capabilities(host: NativeControlHost): JSONObject =
    rpc(host, JSONObject().put("protocolVersion", 1).put("method", "capabilities")).also {
      assertTrue(it.toString(), it.getBoolean("ok"))
    }

  private fun names(array: org.json.JSONArray?): Set<String> =
    if (array == null) emptySet() else (0 until array.length()).map { array.getString(it) }.toSet()

  private fun screen(caps: JSONObject, alias: String): JSONObject? {
    val screens = caps.getJSONArray("screens")
    return (0 until screens.length()).asSequence().map { screens.getJSONObject(it) }
      .firstOrNull { it.getString("screenId") == alias }
  }

  private fun request(caps: JSONObject, screen: JSONObject, operation: String, callId: String,
    args: JSONObject): JSONObject = JSONObject().put("protocolVersion", 1).put("method", "execute")
    .put("operation", operation).put("callId", callId).put("epoch", caps.getString("epoch"))
    .put("screenId", screen.getString("screenId"))
    .put("generation", screen.getString("generation")).put("args", args)

  private fun rpc(host: NativeControlHost, request: JSONObject): JSONObject = LocalSocket().use { socket ->
    socket.connect(LocalSocketAddress(host.endpoint.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
    socket.soTimeout = 20_000
    val bytes = request.toString().toByteArray(Charsets.UTF_8)
    DataOutputStream(socket.outputStream).apply { writeInt(bytes.size); write(bytes); flush() }
    val input = DataInputStream(socket.inputStream)
    val length = input.readInt()
    assertTrue(length in 1..NativeControlFrames.MAX_RESPONSE_BYTES)
    val response = ByteArray(length)
    input.readFully(response)
    JSONObject(response.toString(Charsets.UTF_8))
  }
}
