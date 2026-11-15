package com.dsharnessmobile.shell.nativecontrol

import android.content.Context
import android.content.Intent
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.provider.Settings
import androidx.test.platform.app.InstrumentationRegistry
import com.dsharnessmobile.shell.NativeControlClickFixtureActivity
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.DataInputStream
import java.io.DataOutputStream

/**
 * 专用 MuMu 用例：私有 RPC snapshot -> setText 写入中文与表情，回读 EditText，
 * 旧 ref 不得跨快照复用，默认 IME 不变。
 */
class NativeControlTextDeviceTest {
  private val payload = "中文输入：模型会写 括号（全角）与 emoji 😀🚀 你好"

  @Test fun setTextWritesUnicodeAndKeepsDefaultIme() {
    assumeTrue("仅在专用 MuMu 执行",
      InstrumentationRegistry.getArguments().getString("nativeTestEmulator") == "mumu")
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context: Context = instrumentation.targetContext
    val resolver = context.contentResolver
    val priorIme = Settings.Secure.getString(resolver, Settings.Secure.DEFAULT_INPUT_METHOD)
    val keyboardShownBefore = keyboardVisible(context)
    val activity = instrumentation.startActivitySync(
      Intent(context, NativeControlClickFixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    ) as NativeControlClickFixtureActivity
    try {
      val execution = NativeA11yExecution()
      val facts = NativePlatformFacts(context, execution, { "real-only" })
      NativeControlHost.openIsolated(context, facts, execution).use { host ->
        val caps = awaitAccessibility(host)
        val screen = caps.getJSONArray("screens").getJSONObject(0)
        assertEquals("real", screen.getString("screenId"))
        instrumentation.waitForIdleSync()
        var ready = false
        instrumentation.runOnMainSync {
          ready = activity.hasWindowFocus() && activity.editText.isShown && activity.editText.width > 0
        }
        assertTrue("fixture 必须在前台且输入框已布局", ready)
        assertEquals("", editTextValue(instrumentation, activity))
        instrumentation.runOnMainSync { assertFalse("夹具输入框不得抢焦点", activity.editText.hasFocus()) }

        val first = capture(host, caps, screen, "text-snapshot-first")
        val node = findEditable(first)
        val ref = node.getString("ref")
        assertTrue(ref.isNotEmpty())
        assertEquals("EditText", node.optString("role"))
        assertNotEquals("hint 不得等于写入内容", payload, node.optString("text"))

        val write = rpc(host, execute(caps, screen, "setText", "text-write-" + System.nanoTime(),
          JSONObject().put("ref", ref).put("text", payload).put("clear", true)))
        assertTrue(write.toString(), write.getBoolean("ok"))
        assertEquals("node-set-text-accepted", write.getString("code"))
        assertEquals("yes", write.getString("executed"))
        assertEquals("real", write.getString("screenId"))
        instrumentation.waitForIdleSync()
        assertEquals(payload, editTextValue(instrumentation, activity))

        // 新快照是唯一可信回读：旧快照的节点身份已被写入改动，不能继续复用。
        val second = readBack(host, caps, screen, "text-snapshot-readback")
        val current = findEditable(second)
        val currentRef = current.getString("ref")
        assertNotEquals(ref, currentRef)
        assertEquals(payload, current.optString("text"))
        assertEquals("hint 不得冒充已输入正文", payload, editTextValue(instrumentation, activity))

        val read = rpc(host, execute(caps, screen, "nodeText", "text-read-" + System.nanoTime(),
          JSONObject().put("ref", currentRef)))
        assertTrue(read.toString(), read.getBoolean("ok"))
        assertEquals("node-text-read", read.getString("code"))
        assertEquals(payload, read.getJSONObject("data").getString("text"))
        assertTrue(read.getJSONObject("data").getBoolean("editable"))

        // 旧快照的 ref 必须明确过期；不能静默落到同一控件。
        val stale = rpc(host, execute(caps, screen, "nodeText", "text-stale-" + System.nanoTime(),
          JSONObject().put("ref", ref)))
        assertFalse(stale.toString(), stale.getBoolean("ok"))
        assertEquals("no", stale.getString("executed"))
        assertTrue(stale.toString(), stale.getString("code").contains("stale"))

        instrumentation.waitForIdleSync()
        assertEquals("写入内容不得被旧 ref 改写", payload, editTextValue(instrumentation, activity))
        instrumentation.runOnMainSync {
          assertFalse("setText 不得把焦点移入输入框", activity.editText.hasFocus())
          assertTrue("夹具必须仍在前台", activity.hasWindowFocus())
        }
        assertEquals("默认 IME 不得改变", priorIme,
          Settings.Secure.getString(resolver, Settings.Secure.DEFAULT_INPUT_METHOD))
        assertEquals("setText 不得弹出软键盘", keyboardShownBefore, keyboardVisible(context))
        android.util.Log.i("dsh-native-device-test",
          "setText unicode=" + payload.length + " chars ref=" + ref + " code=" + write.getString("code") +
            " snapshot=" + first.optString("snapshotId") + "->" + second.optString("snapshotId") +
            " ime=" + priorIme)
      }
    } finally {
      instrumentation.runOnMainSync { activity.finish() }
      instrumentation.waitForIdleSync()
    }
  }

  private fun capture(host: NativeControlHost, caps: JSONObject, screen: JSONObject, prefix: String): JSONObject {
    val callId = prefix + "-" + System.nanoTime()
    val snapshot = rpc(host, execute(caps, screen, "snapshot", callId, null))
    assertTrue(snapshot.toString(), snapshot.getBoolean("ok"))
    assertEquals("snapshot-captured", snapshot.getString("code"))
    return snapshot.getJSONObject("tree")
  }

  /** 有界重读：无障碍树允许一次读取代更新，但超过预算仍不一致即判红。 */
  private fun readBack(host: NativeControlHost, caps: JSONObject, screen: JSONObject, prefix: String): JSONObject {
    val deadline = android.os.SystemClock.elapsedRealtime() + 3_000
    var last: JSONObject? = null
    while (true) {
      val tree = capture(host, caps, screen, prefix)
      last = tree
      if (findEditable(tree).optString("text") == payload) return tree
      if (android.os.SystemClock.elapsedRealtime() >= deadline) break
      android.os.SystemClock.sleep(150)
    }
    throw AssertionError("原生树回读未收敛: " + findEditable(last!!).optString("text"))
  }

  private fun keyboardVisible(context: Context): Boolean {
    val input = context.getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager
    return input.isAcceptingText
  }

  private fun execute(caps: JSONObject, screen: JSONObject, operation: String, callId: String,
    args: JSONObject?): JSONObject = JSONObject().put("protocolVersion", 1).put("method", "execute")
    .put("operation", operation).put("callId", callId).put("epoch", caps.getString("epoch"))
    .put("screenId", "real").put("generation", screen.getString("generation"))
    .also { request -> if (args != null) request.put("args", args) }

  private fun findEditable(tree: JSONObject): JSONObject {
    val nodes = tree.getJSONArray("nodes")
    return (0 until nodes.length()).asSequence().map { nodes.getJSONObject(it) }
      .firstOrNull { it.optBoolean("editable") && it.optJSONObject("bounds") != null }
      ?: throw AssertionError("fixture 未暴露可编辑节点；nodes=" + nodes.length())
  }

  private fun editTextValue(instrumentation: android.app.Instrumentation,
    activity: NativeControlClickFixtureActivity): String {
    var value = ""
    instrumentation.runOnMainSync { value = activity.editText.text.toString() }
    return value
  }

  private fun awaitAccessibility(host: NativeControlHost): JSONObject {
    val request = JSONObject("""{"protocolVersion":1,"method":"capabilities"}""")
    val deadline = android.os.SystemClock.elapsedRealtime() + 12_000
    while (true) {
      val caps = rpc(host, request)
      if (caps.optJSONObject("channels")?.optJSONObject("a11y")?.optString("online") == "yes") return caps
      if (android.os.SystemClock.elapsedRealtime() >= deadline) throw AssertionError("A11y offline: " + caps)
      android.os.SystemClock.sleep(200)
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
