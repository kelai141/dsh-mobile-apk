package com.dsharnessmobile.shell.nativecontrol

import android.content.Context
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Build
import android.os.Process
import android.system.Os
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.DataInputStream
import java.io.DataOutputStream
import java.security.MessageDigest

/** 隔离 JNI/文件系统 socket 契约；只允许专用模拟器，不触发真实手势。 */
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
      val request = JSONObject("""{"protocolVersion":1,"method":"capabilities"}""")
      val deadline = android.os.SystemClock.elapsedRealtime() + 12_000
      var caps = rpc(host, request)
      while (caps.optJSONObject("channels")?.optJSONObject("a11y")?.optString("online") != "yes" &&
        android.os.SystemClock.elapsedRealtime() < deadline) {
        android.os.SystemClock.sleep(200)
        caps = rpc(host, request)
      }
      val a11y = caps.getJSONObject("channels").getJSONObject("a11y")
      assertEquals(caps.toString(), "yes", a11y.getString("online"))
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
