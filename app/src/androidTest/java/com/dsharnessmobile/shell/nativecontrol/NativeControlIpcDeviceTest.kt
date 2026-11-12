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

/** 隔离 JNI/文件系统 socket 契约；只允许专用模拟器，不触发真实手势。 */
class NativeControlIpcDeviceTest {
  @Test fun appUidSocketUsesRustAndRejectsRealScreenUnderDefaultScope() {
    assumeTrue("仅在模拟器执行；真机验收另行安排", Build.HARDWARE in setOf("ranchu", "goldfish"))
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

  private fun rpc(host: NativeControlHost, request: JSONObject): JSONObject {
    return LocalSocket().use { socket ->
      socket.soTimeout = 10_000
      socket.connect(LocalSocketAddress(host.endpoint.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
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
