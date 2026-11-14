package com.dsharnessmobile.shell.nativecontrol

import android.content.Context
import android.content.Intent
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.provider.Settings
import androidx.test.platform.app.InstrumentationRegistry
import com.dsharnessmobile.shell.NativeControlClickFixtureActivity
import com.dsharnessmobile.shell.ProcIo
import com.dsharnessmobile.shell.ShizukuTransport
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File

/**
 * 专用 MuMu 的 Shizuku 焦点编辑器文本用例。
 *
 * 只走 NativeShizukuExecution：Rust 计划 backend=shizuku 且没有 nodeTarget 时，
 * 才由 NativeShizukuEditor 对焦点编辑器执行唯一的 ACTION_SET_TEXT。
 * A11y 必须离线；A11y 在线时 Rust 会优先选 A11y，本用例前提即不成立。
 */
class NativeShizukuTextDeviceTest {
  private val payload = "中文输入：括号（全角）与 emoji 😀🚀 你好"
  private val suffix = " +追加"

  @Test fun focusedEditorTextRoundTripsWithoutImeOrReplay() {
    val arguments = InstrumentationRegistry.getArguments()
    assumeTrue("仅在专用 MuMu 执行", arguments.getString("nativeTestEmulator") == "mumu")
    assumeTrue("Shizuku 授权由启动器显式开启",
      arguments.getString("nativeTestShizuku") == "yes" && arguments.getString("nativeTestShizukuDenied") != "yes")
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context: Context = instrumentation.targetContext
    val resolver = context.contentResolver
    val priorIme = Settings.Secure.getString(resolver, Settings.Secure.DEFAULT_INPUT_METHOD)
    val activity = instrumentation.startActivitySync(
      Intent(context, NativeControlClickFixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    ) as NativeControlClickFixtureActivity
    try {
      instrumentation.waitForIdleSync()
      val keyboardBefore = keyboardVisible(activity)
      if (arguments.getString("nativeTestRequestShizuku") == "yes") {
        instrumentation.runOnMainSync { ShizukuTransport.requestPermission(activity) }
      }
      val observed = awaitRealText(context)
      val a11y = NativeA11yExecution()
      var scope = "real-only"
      val facts = NativePlatformFacts(context, a11y, { scope })
      NativeControlHost.openIsolated(context, facts, NativeShizukuExecution(a11y)).use { host ->
        var caps = rpc(host, JSONObject("""{"protocolVersion":1,"method":"capabilities"}"""))
        assertTrue(caps.toString(), caps.getBoolean("ok"))
        val channels = caps.getJSONObject("channels")
        val a11yCaps = channels.getJSONObject("a11y")
        assertEquals("本用例只验证 Shizuku，A11y 必须关闭；caps=" + caps, "no", a11yCaps.getString("enabled"))
        assertEquals("本用例只验证 Shizuku，A11y 必须离线；caps=" + caps, "no", a11yCaps.getString("online"))
        val shizukuCaps = channels.getJSONObject("shizuku")
        assertEquals(caps.toString(), "yes", shizukuCaps.getString("functionalReady"))
        assertEquals(caps.toString(), "shell2000", shizukuCaps.getJSONObject("serverUid").getString("kind"))
        assertTrue("未实测焦点编辑器文本能力：" + caps, operations(shizukuCaps).contains("setText"))
        assertEquals("A11y 离线时 setText 仍须由 Shizuku 准备", true, observed)
        var screen = caps.getJSONArray("screens").getJSONObject(0)
        assertEquals("real", screen.getString("screenId"))

        // 1. 无 ref、无焦点：a11y 已离线，Shizuku 适配器只认焦点编辑器，必须在执行前拒绝。
        focus(instrumentation, activity, false)
        val unfocused = rpc(host, request(caps, screen, "setText", "text-unfocused-" + System.nanoTime(),
          JSONObject().put("text", payload).put("clear", true)))
        assertFalse(unfocused.toString(), unfocused.getBoolean("ok"))
        assertEquals(unfocused.toString(), "no", unfocused.getString("executed"))
        assertEquals("", editTextValue(instrumentation, activity))

        // 2. scope 拒绝：真实屏内容在 virtual-only 下不得进入任何适配器。
        focus(instrumentation, activity, true)
        scope = "virtual-only"
        run {
            val deniedCaps = rpc(host, JSONObject("""{"protocolVersion":1,"method":"capabilities"}"""))
            assertEquals("virtual-only", deniedCaps.getString("scope"))
            val scopedScreen = deniedCaps.getJSONArray("screens").getJSONObject(0)
            val reply = rpc(host, request(deniedCaps, scopedScreen, "setText",
              "text-scope-" + System.nanoTime(), JSONObject().put("text", payload).put("clear", true)))
            assertFalse(reply.toString(), reply.getBoolean("ok"))
            assertEquals("no", reply.getString("executed"))
            assertTrue(reply.toString(), reply.getString("code").contains("scope"))
            assertEquals("", editTextValue(instrumentation, activity))
        }
        scope = "real-only"
        caps = rpc(host, JSONObject("""{"protocolVersion":1,"method":"capabilities"}"""))
        screen = caps.getJSONArray("screens").getJSONObject(0)

        // 3. 无 ref 写入：clear=true 清空后写入中文与表情。
        focus(instrumentation, activity, true)
        assertEquals("", editTextValue(instrumentation, activity))
        val writeId = "text-write-" + System.nanoTime()
        val write = rpc(host, request(caps, screen, "setText", writeId,
          JSONObject().put("text", payload).put("clear", true)))
        assertTrue(write.toString(), write.getBoolean("ok"))
        assertEquals(write.toString(), "shizuku-text-confirmed", write.getString("code"))
        assertEquals("yes", write.getString("executed"))
        assertEquals("real", write.getString("screenId"))
        instrumentation.waitForIdleSync()
        assertEquals(payload, editTextValue(instrumentation, activity))

        // 4. 同 callId 重放：只回执，不得追加第二次文本。
        val replay = rpc(host, request(caps, screen, "setText", writeId,
          JSONObject().put("text", payload).put("clear", true)))
        assertTrue(replay.toString(), replay.getBoolean("replayed"))
        assertEquals("yes", replay.getString("executed"))
        instrumentation.waitForIdleSync()
        assertEquals("同一 callId 重放不得再次写入", payload, editTextValue(instrumentation, activity))

        // 5. 追加：clear=false 必须在现有正文后追加。
        val appendRequest = request(caps, screen, "setText", "text-append-" + System.nanoTime(),
          JSONObject().put("text", suffix).put("clear", false))
        val append = rpc(host, appendRequest)
        assertTrue(append.toString(), append.getBoolean("ok"))
        assertEquals(append.toString(), "shizuku-text-confirmed", append.getString("code"))
        assertEquals("yes", append.getString("executed"))
        instrumentation.waitForIdleSync()
        assertEquals(payload + suffix, editTextValue(instrumentation, activity))
        val replayedAppend = rpc(host, appendRequest)
        assertTrue(replayedAppend.toString(), replayedAppend.getBoolean("replayed"))
        assertEquals("追加重放不能重复后缀", payload + suffix, editTextValue(instrumentation, activity))
        val clear = rpc(host, request(caps, screen, "setText", "text-clear-" + System.nanoTime(),
          JSONObject().put("text", "").put("clear", true)))
        assertTrue(clear.toString(), clear.getBoolean("ok"))
        assertEquals("shizuku-text-confirmed", clear.getString("code"))
        assertEquals("", editTextValue(instrumentation, activity))

        // A real model receives refs from dump. Its next input must work through that same ref.
        val dump = rpc(host, request(caps, screen, "snapshot", "text-tree-" + System.nanoTime(), JSONObject()))
        assertTrue(dump.toString(), dump.getBoolean("ok"))
        val nodes = dump.getJSONObject("tree").getJSONArray("nodes")
        val editor = (0 until nodes.length()).map { nodes.getJSONObject(it) }.first { it.optBoolean("editable") }
        val byRef = rpc(host, request(caps, screen, "setText", "text-node-" + System.nanoTime(),
          JSONObject().put("ref", editor.getString("ref")).put("text", payload).put("clear", true)))
        assertTrue(byRef.toString(), byRef.getBoolean("ok"))
        assertEquals("yes", byRef.getString("executed"))
        assertEquals(payload, editTextValue(instrumentation, activity))
        val stale = rpc(host, request(caps, screen, "setText", "text-stale-" + System.nanoTime(),
          JSONObject().put("ref", editor.getString("ref")).put("text", "must not overwrite").put("clear", true)))
        assertFalse(stale.toString(), stale.getBoolean("ok"))
        assertEquals("no", stale.getString("executed"))
        assertEquals(payload, editTextValue(instrumentation, activity))

        val updated = rpc(host, request(caps, screen, "snapshot", "text-updated-" + System.nanoTime(), JSONObject()))
        assertTrue(updated.toString(), updated.getBoolean("ok"))
        val updatedNodes = updated.getJSONObject("tree").getJSONArray("nodes")
        val updatedEditor = (0 until updatedNodes.length()).map { updatedNodes.getJSONObject(it) }.first { it.optBoolean("editable") }
        val detail = rpc(host, request(caps, screen, "nodeText", "text-detail-" + System.nanoTime(),
          JSONObject().put("ref", updatedEditor.getString("ref"))))
        assertTrue(detail.toString(), detail.getBoolean("ok"))
        assertEquals(payload, detail.getJSONObject("data").getString("text"))

        for (operation in listOf("screenshot", "readRegion")) {
          val region = if (operation == "readRegion") JSONObject().put("x1", 0).put("y1", 0)
            .put("x2", minOf(400, screen.getInt("width"))).put("y2", minOf(400, screen.getInt("height"))) else JSONObject()
          val visual = rpc(host, request(caps, screen, operation, "text-image-" + System.nanoTime(), region))
          assertTrue(visual.toString().take(1200), visual.getBoolean("ok"))
          assertTrue(visual.toString().take(1200), visual.has("image"))
          assertEquals("real", visual.getString("screenId"))
        }

        assertEquals("默认 IME 不得改变", priorIme,
          Settings.Secure.getString(resolver, Settings.Secure.DEFAULT_INPUT_METHOD))
        assertEquals("Shizuku 文本不得弹出软键盘", keyboardBefore, keyboardVisible(activity))

        if (arguments.getString("nativeTestNodeInput") == "yes") {
          val files = context.filesDir
          val linker = File("/system/bin/linker64")
          val node = File(files, "usr/bin/node")
          val script = File(files, ".native-control-tests/probe-native-input.mjs")
          val plugin = File(files,
            "home/.dsh/profiles/web/node_modules/@dsh-android/dsh-android-phone-control/lib/index.js")
          for (staged in listOf(linker, node, script, plugin)) {
            assertTrue("主线未 stage 到 " + staged.absolutePath, staged.isFile)
          }
          val builder = ProcessBuilder(linker.absolutePath, node.absolutePath, script.absolutePath,
            plugin.absolutePath, "real", payload)
          builder.environment().apply {
            put("LD_LIBRARY_PATH", File(files, "usr/lib").absolutePath)
            put("HOME", File(files, "home").absolutePath)
            put("DSH_FILES_DIR", files.absolutePath)
          }
          builder.redirectErrorStream(true)
          val process = builder.start()
          val result = ProcIo.readBoundedMillis(process, 10_000, 8192)
          assertTrue("Node 探针未在 10s 内结束：" + result.marker() + " " + result.text, result.complete)
          assertEquals("Node 探针失败：" + result.text, 0, process.exitValue())
          instrumentation.waitForIdleSync()
          assertEquals("Node 工具调用后 EditText 值不符：" + result.text,
            payload, editTextValue(instrumentation, activity))
          assertEquals(priorIme, Settings.Secure.getString(resolver, Settings.Secure.DEFAULT_INPUT_METHOD))
          assertEquals(keyboardBefore, keyboardVisible(activity))
          android.util.Log.i("dsh-native-device-test", "Node registered tool result=" + result.text)
        }

        android.util.Log.i("dsh-native-device-test",
          "shizuku setText chars=" + payload.length + " code=" + write.getString("code") +
            " replay=" + replay.getString("code") + " append=" + append.getString("code") +
            " ime=" + priorIme + " node=" + (arguments.getString("nativeTestNodeInput") == "yes"))
        if (arguments.getString("nativeTestEvidenceHold") == "yes") {
          instrumentation.sendStatus(2, android.os.Bundle().apply {
            putString("nativeTextEvidence", "NATIVE_TEXT_EVIDENCE_READY")
          })
          android.os.SystemClock.sleep(4_000)
        }
      }
    } finally {
      instrumentation.runOnMainSync { activity.finish() }
      instrumentation.waitForIdleSync()
    }
  }


  private fun operations(caps: JSONObject): Set<String> {
    val supported = caps.optJSONObject("supportedOps") ?: return emptySet()
    if (supported.optString("state") != "known") return emptySet()
    val ops = supported.optJSONArray("ops") ?: return emptySet()
    return (0 until ops.length()).map { ops.getString(it) }.toSet()
  }

  private fun request(caps: JSONObject, screen: JSONObject, operation: String, callId: String,
    args: JSONObject): JSONObject = JSONObject().put("protocolVersion", 1).put("method", "execute")
    .put("operation", operation).put("callId", callId).put("epoch", caps.getString("epoch"))
    .put("screenId", "real").put("generation", screen.getString("generation")).put("args", args)

  private fun focus(instrumentation: android.app.Instrumentation,
    activity: NativeControlClickFixtureActivity, wanted: Boolean) {
    instrumentation.runOnMainSync {
      if (wanted) {
        assertTrue("fixture 必须在前台", activity.hasWindowFocus())
        activity.editText.isFocusable = true
        activity.editText.isFocusableInTouchMode = true
        activity.editText.requestFocus()
      } else {
        activity.editText.clearFocus()
        activity.editText.isFocusable = false
        activity.editText.isFocusableInTouchMode = false
      }
    }
    instrumentation.waitForIdleSync()
  }

  private fun editTextValue(instrumentation: android.app.Instrumentation,
    activity: NativeControlClickFixtureActivity): String {
    var value = ""
    instrumentation.runOnMainSync { value = activity.editText.text.toString() }
    return value
  }

  private fun keyboardVisible(activity: NativeControlClickFixtureActivity): Boolean =
    activity.window.decorView.rootWindowInsets?.isVisible(android.view.WindowInsets.Type.ime()) ?: false

  private fun awaitRealText(context: Context): Boolean {
    val deadline = android.os.SystemClock.elapsedRealtime() + 30_000
    while (true) {
      if (ShizukuTransport.observeNativeRealText(context)) return true
      if (android.os.SystemClock.elapsedRealtime() >= deadline) {
        throw AssertionError("Shizuku 焦点文本未就绪：" + NativeShizukuFacts.shared.snapshot())
      }
      android.os.SystemClock.sleep(250)
    }
  }

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
