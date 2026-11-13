package com.dsharnessmobile.shell.nativecontrol

import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Build
import android.os.Process
import android.system.Os
import androidx.test.platform.app.InstrumentationRegistry
import com.dsharnessmobile.shell.NativeControlClickFixtureActivity
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.DataInputStream
import java.io.DataOutputStream
import java.security.MessageDigest

/** 仅在专用模拟器验证隔离 JNI、私有 socket 与真实 A11y；手势只作用于本测试按钮。 */
class NativeControlIpcDeviceTest {
  @Test fun appUidSocketUsesRustAndRejectsRealScreenUnderDefaultScope() {
    requireTestEmulator()
    val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    val execution = NativeA11yExecution()
    val facts = NativePlatformFacts(context, execution, { "virtual-only" })
    NativeControlHost.openIsolated(context, facts, execution).use { host ->
      assertTrue(host.initialization.getBoolean("identityVerified"))
      assertEquals(Process.myUid(), host.initialization.getInt("appUid"))
      val stat = Os.lstat(host.endpoint.absolutePath)
      assertEquals(Process.myUid(), stat.st_uid)
      assertEquals(384, stat.st_mode and 511) // 0600
      val caps = rpc(host, JSONObject("""{"protocolVersion":1,"method":"capabilities"}"""))
      assertTrue(caps.toString(), caps.getBoolean("ok"))
      assertEquals("virtual-only", caps.getString("scope"))
      assertTrue(caps.get("epoch") is String)
      val screens = caps.getJSONArray("screens")
      val real = (0 until screens.length()).map { screens.getJSONObject(it) }
        .first { it.getString("screenId") == "real" }
      val denied = rpc(host, JSONObject().put("protocolVersion", 1).put("method", "execute")
        .put("callId", "ipc-scope-${System.nanoTime()}").put("epoch", caps.getString("epoch"))
        .put("generation", real.getString("generation")).put("operation", "click")
        .put("screenId", "real").put("args", JSONObject().put("x", 1).put("y", 1)))
      assertFalse(denied.toString(), denied.getBoolean("ok"))
      assertTrue(denied.toString(), denied.getString("code").contains("scope"))
      assertNotEquals("yes", denied.getString("executed"))
      val internal = rpc(host, JSONObject("""{"protocolVersion":1,"method":"capabilities","facts":{}}"""))
      assertEquals("unknown-request-field", internal.getString("code"))
      assertEquals("no", internal.getString("executed"))
    }
  }

  @Test fun realAndroidJniDeliversOnlyTheSettledJpeg() {
    requireTestEmulator()
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val execution = NativeA11yExecution()
    val facts = NativeControlDispatcher.Facts {
      JSONObject("""{"scope":"all","screens":{"real":{"displayId":0,"width":8,"height":4,"rotation":0}},"a11y":{"enabled":"yes","online":"yes","supportedOps":{"state":"known","ops":["readRegion"]},"displaySupport":{"state":"known","values":{"0":true}}}}""")
    }
    NativeControlHost.openIsolated(context, facts, execution).use { host ->
      fun exchange(request: JSONObject) = JSONObject(NativeControlCore.exchange(request.put("protocolVersion", 1).toString()))
      val caps = rpc(host, JSONObject("""{"protocolVersion":1,"method":"capabilities"}"""))
      assertTrue(caps.toString(), caps.getBoolean("ok"))
      val epoch = caps.getString("epoch")
      val generation = caps.getJSONArray("screens").getJSONObject(0).getString("generation")
      val id = "device-frame-${System.nanoTime()}"
      val region = JSONObject("""{"x1":2,"y1":1,"x2":7,"y2":4}""")
      val prepared = exchange(JSONObject().put("kind", "prepare").put("callId", id).put("operation", "readRegion")
        .put("epoch", epoch).put("generation", generation).put("screenId", "real").put("args", region))
      assertEquals(prepared.toString(), "prepared", prepared.getString("code"))
      val committed = exchange(JSONObject().put("kind", "commit").put("callId", id))
      assertEquals(committed.toString(), "permitted", committed.getString("dispatch"))
      val frame = JSONObject().put("callId", id).put("epoch", epoch).put("generation", generation)
        .put("screenId", "real").put("displayId", 0).put("logicalWidth", 8).put("logicalHeight", 4)
        .put("width", 8).put("height", 4).put("rowStride", 32).put("transform", "identity").put("premultipliedAlpha", false)
      val pixels = ByteArray(8 * 4 * 4) { if (it % 4 == 3) 255.toByte() else 70.toByte() }
      val receipt = JSONObject(NativeControlCore.encodeFrame(frame.toString(), pixels))
      assertTrue(receipt.toString(), receipt.getBoolean("ok"))
      assertNull(requireNotNull(NativeControlCore.readImage(id)).jpeg)
      val settled = exchange(JSONObject().put("kind", "settle").put("callId", id).put("receipt", receipt))
      assertTrue(settled.toString(), settled.getBoolean("ok"))
      val status = rpc(host, JSONObject().put("protocolVersion", 1).put("method", "status").put("callId", id))
      assertTrue(status.toString(), status.getBoolean("ok"))
      val image = status.getJSONObject("image")
      val bytes = java.util.Base64.getDecoder().decode(image.getString("data"))
      assertEquals(8, image.getInt("width"))
      assertEquals(4, image.getInt("height"))
      assertEquals(7, image.getJSONObject("region").getInt("x2"))
      assertEquals(MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) },
        image.getString("sha256"))
      val decoded = requireNotNull(android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
      try {
        assertEquals(5, decoded.width)
        assertEquals(3, decoded.height)
      } finally { decoded.recycle() }
    }
  }

  @Test fun accessibilityCapturesTheEmulatorDisplayThroughPrivateIpc() {
    requireTestEmulator()
    assumeTrue("需要显式开启模拟器上的真实截图验证",
      InstrumentationRegistry.getArguments().getString("nativeTestCapture") == "yes")
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val execution = NativeA11yExecution()
    val facts = NativePlatformFacts(context, execution, { "real-only" })
    NativeControlHost.openIsolated(context, facts, execution).use { host ->
      val caps = awaitAccessibility(host)
      val screen = caps.getJSONArray("screens").getJSONObject(0)
      val id = "device-a11y-shot-${System.nanoTime()}"
      val shot = rpc(host, JSONObject().put("protocolVersion", 1).put("method", "execute")
        .put("operation", "screenshot").put("callId", id).put("epoch", caps.getString("epoch"))
        .put("screenId", "real").put("generation", screen.getString("generation")))
      assertTrue("screenshot failed: " + shot.optString("code"), shot.getBoolean("ok"))
      val image = shot.getJSONObject("image")
      assertEquals(screen.getInt("width"), image.getInt("width"))
      assertEquals(screen.getInt("height"), image.getInt("height"))
      val jpeg = java.util.Base64.getDecoder().decode(image.getString("data"))
      val decoded = requireNotNull(android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size))
      try {
        assertTrue(decoded.width > 0 && decoded.height > 0)
        assertTrue(maxOf(decoded.width, decoded.height) <= 1600)
      } finally { decoded.recycle() }
    }
  }

  @Test fun accessibilityReadsARealNodeAndRefusesItsReplacedReference() {
    requireTestEmulator()
    assumeTrue("需要显式开启模拟器上的真实 A11y 验证",
      InstrumentationRegistry.getArguments().getString("nativeTestCapture") == "yes")
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val execution = NativeA11yExecution()
    NativeControlHost.openIsolated(context, NativePlatformFacts(context, execution, { "real-only" }), execution).use { host ->
      val caps = awaitAccessibility(host)
      val screen = caps.getJSONArray("screens").getJSONObject(0)
      fun execute(operation: String, args: JSONObject? = null): JSONObject =
        rpc(host, JSONObject().put("protocolVersion", 1).put("method", "execute")
          .put("operation", operation).put("callId", "device-node-$operation-${System.nanoTime()}")
          .put("epoch", caps.getString("epoch")).put("screenId", "real")
          .put("generation", screen.getString("generation")).apply { args?.let { put("args", it) } })
      fun tree(): JSONObject {
        val response = execute("snapshot")
        assertTrue("snapshot failed: " + response.optString("code"), response.getBoolean("ok"))
        return response.getJSONObject("tree")
      }
      val first = tree()
      val nodes = first.getJSONArray("nodes")
      val label = (0 until nodes.length()).asSequence().map { nodes.getJSONObject(it) }
        .firstOrNull { it.optBoolean("visible", true) && !it.optBoolean("editable") && it.optJSONObject("bounds") != null &&
          it.optString("role") == "TextView" && it.optString("text").length in 2..80 }
        ?: throw AssertionError("Settings did not expose any visible label; nodes=${nodes.length()}")
      val oldRef = JSONObject().put("ref", label.getString("ref"))
      val read = execute("nodeText", oldRef)
      assertTrue("nodeText failed: " + read.optString("code"), read.getBoolean("ok"))
      assertEquals(label.getString("text"), read.getJSONObject("data").getString("text"))
      val second = tree()
      assertNotEquals(first.getString("snapshotId"), second.getString("snapshotId"))
      val denied = execute("nodeText", oldRef)
      assertFalse(denied.getBoolean("ok"))
      assertEquals("stale-snapshot", denied.getString("code"))
      assertEquals("no", denied.getString("executed"))
    }
  }

  @Test fun accessibilityClicksOnceAndReplaysOnlyTheReceipt() {
    requireTestEmulator()
    assumeTrue("需要显式开启模拟器上的真实 A11y 验证",
      InstrumentationRegistry.getArguments().getString("nativeTestCapture") == "yes")
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val activity = instrumentation.startActivitySync(
      Intent(context, NativeControlClickFixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    ) as NativeControlClickFixtureActivity
    try {
      val execution = NativeA11yExecution()
      val facts = NativePlatformFacts(context, execution, { "real-only" })
      lateinit var request: JSONObject
      fun buttonText(): String {
        var text = ""
        instrumentation.runOnMainSync { text = activity.button.text.toString() }
        return text
      }
      NativeControlHost.openIsolated(context, facts, execution).use { host ->
        val caps = awaitAccessibility(host)
        val screen = caps.getJSONArray("screens").getJSONObject(0)
        val bounds = Rect()
        val focusDeadline = android.os.SystemClock.elapsedRealtime() + 5_000
        var ready = false
        do {
          instrumentation.runOnMainSync {
            val button = activity.button
            val location = IntArray(2)
            button.getLocationOnScreen(location)
            bounds.set(location[0], location[1], location[0] + button.width, location[1] + button.height)
            ready = activity.hasWindowFocus() && button.isShown && !bounds.isEmpty
          }
          if (!ready) android.os.SystemClock.sleep(100)
        } while (!ready && android.os.SystemClock.elapsedRealtime() < focusDeadline)
        assertTrue("test button must be visible and focused", ready)
        assertEquals("Clicks: 0", buttonText())
        request = JSONObject().put("protocolVersion", 1).put("method", "execute")
          .put("operation", "click").put("callId", "device-click-${System.nanoTime()}")
          .put("epoch", caps.getString("epoch")).put("screenId", "real")
          .put("generation", screen.getString("generation"))
          .put("args", JSONObject().put("x", bounds.centerX()).put("y", bounds.centerY()))
        val first = rpc(host, request)
        assertTrue(first.toString(), first.getBoolean("ok"))
        assertEquals("gesture-completed", first.getString("code"))
        assertEquals("yes", first.getString("executed"))
        instrumentation.waitForIdleSync()
        assertEquals("Clicks: 1", buttonText())
      }
      // Reconnect over a newly created private IPC listener while the APK remains alive.
      NativeControlHost.openIsolated(context, facts, execution).use { host ->
        val replay = rpc(host, request)
        assertTrue(replay.toString(), replay.getBoolean("ok"))
        assertTrue(replay.toString(), replay.getBoolean("replayed"))
        assertEquals("yes", replay.getString("executed"))
        instrumentation.waitForIdleSync()
        assertEquals("Clicks: 1", buttonText())
      }
    } finally {
      instrumentation.runOnMainSync { activity.finish() }
      instrumentation.waitForIdleSync()
    }
  }

  private fun awaitAccessibility(host: NativeControlHost): JSONObject {
    val request = JSONObject("""{"protocolVersion":1,"method":"capabilities"}""")
    val deadline = android.os.SystemClock.elapsedRealtime() + 12_000
    while (true) {
      val caps = rpc(host, request)
      if (caps.optJSONObject("channels")?.optJSONObject("a11y")?.optString("online") == "yes") return caps
      if (android.os.SystemClock.elapsedRealtime() >= deadline) throw AssertionError("A11y offline: $caps")
      android.os.SystemClock.sleep(200)
    }
  }

  private fun requireTestEmulator() {
    val arguments = InstrumentationRegistry.getArguments()
    assumeTrue("仅在模拟器执行；MuMu 须由测试启动器显式指定",
      Build.HARDWARE in setOf("ranchu", "goldfish") || arguments.getString("nativeTestEmulator") == "mumu")
  }

  private fun rpc(host: NativeControlHost, request: JSONObject): JSONObject {
    return LocalSocket().use { socket ->
      socket.connect(LocalSocketAddress(host.endpoint.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
      socket.soTimeout = 20_000
      val payload = request.toString().toByteArray(Charsets.UTF_8)
      DataOutputStream(socket.outputStream).apply { writeInt(payload.size); write(payload); flush() }
      val input = DataInputStream(socket.inputStream)
      val length = input.readInt()
      assertTrue(length in 1..NativeControlFrames.MAX_RESPONSE_BYTES)
      val bytes = ByteArray(length)
      input.readFully(bytes)
      JSONObject(bytes.toString(Charsets.UTF_8))
    }
  }
}
