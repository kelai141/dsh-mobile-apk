package com.dsharnessmobile.shell.nativecontrol

import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import com.dsharnessmobile.shell.ShizukuTransport
import com.dsharnessmobile.shell.VdisplayController
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.DataInputStream
import java.io.DataOutputStream

class NativeVirtualDisplayDeviceTest {
  @Test fun ownedAllocationIsPublishedAndRecreatedTargetRejectsOldPlan() {
    val args = InstrumentationRegistry.getArguments()
    assumeTrue("Only the dedicated, pre-authorized MuMu instance may create a display",
      args.getString("nativeTestEmulator") == "mumu" && args.getString("nativeTestShizuku") == "yes")
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    assertTrue("fixture requires an empty registry", VdisplayController.activeAliases().isEmpty())
    val deadline = SystemClock.elapsedRealtime() + 8_000
    while (true) {
      val bound = ShizukuTransport.ensureBound(context, requestPermission = false)
      if (bound.optBoolean("ok")) break
      assertTrue("Shizuku unavailable: $bound", SystemClock.elapsedRealtime() < deadline)
      SystemClock.sleep(250)
    }

    val a11y = NativeA11yExecution()
    val facts = NativePlatformFacts(context, a11y, { "virtual-only" })
    val alias = "virtual-1"
    val dimensions = JSONObject().put("width", 480).put("height", 640).put("densityDpi", 160)
    fun create() {
      val response = VdisplayController.create(context, dimensions)
      assertEquals(response.toString(), "vdisplay-active", response.getString("code"))
    }

    try {
      NativeControlHost.openIsolated(context, facts, a11y).use { host ->
        fun capabilities(): JSONObject = rpc(host, JSONObject().put("protocolVersion", 1)
          .put("method", "capabilities")).also { assertTrue(it.toString(), it.getBoolean("ok")) }

        assertNull(screen(capabilities(), alias))
        create()
        val first = capabilities()
        val before = requireNotNull(screen(first, alias)) { first.toString() }
        val allocation = facts.capture().getJSONObject("screens").getJSONObject(alias).getString("allocationId")
        assertTrue(before.toString(), before.getInt("displayId") > 0)
        assertEquals(480, before.getInt("width"))
        assertEquals(640, before.getInt("height"))
        assertFalse(before.has("allocationId"))
        assertEquals(before.getString("generation"), screen(capabilities(), alias)?.getString("generation"))

        val destroyed = VdisplayController.destroy(context, JSONObject().put("target", alias))
        assertEquals(destroyed.toString(), "ready", destroyed.getString("state"))
        assertTrue(VdisplayController.activeAliases().isEmpty())
        // No capabilities read while absent: a client need not witness the removal to reject its old generation.
        create()
        val second = capabilities()
        val after = requireNotNull(screen(second, alias)) { second.toString() }
        val nextAllocation = facts.capture().getJSONObject("screens").getJSONObject(alias).getString("allocationId")
        assertNotEquals(allocation, nextAllocation)
        assertEquals(before.getInt("width"), after.getInt("width"))
        assertEquals(before.getInt("height"), after.getInt("height"))
        assertNotEquals(before.getString("generation"), after.getString("generation"))

        val stale = rpc(host, JSONObject().put("protocolVersion", 1).put("method", "execute")
          .put("callId", "device-virtual-stale-${System.nanoTime()}").put("epoch", first.getString("epoch"))
          .put("operation", "click").put("screenId", alias).put("generation", before.getString("generation"))
          .put("args", JSONObject().put("x", 1).put("y", 1)))
        assertEquals(stale.toString(), "generation-mismatch", stale.getString("code"))
        assertEquals("no", stale.getString("executed"))

        VdisplayController.destroy(context, JSONObject().put("target", alias))
        assertNull(screen(capabilities(), alias))
        android.util.Log.i("dsh-native-device-test",
          "virtual display ${before.getInt("displayId")} -> ${after.getInt("displayId")}; " +
            "generation ${before.getString("generation")} -> ${after.getString("generation")}; ${stale.getString("code")}")
      }
    } finally {
      if (VdisplayController.activeAliases().isNotEmpty()) {
        VdisplayController.destroy(context, JSONObject().put("target", alias))
      }
    }
  }

  private fun screen(capabilities: JSONObject, alias: String): JSONObject? {
    val screens = capabilities.getJSONArray("screens")
    return (0 until screens.length()).asSequence().map { screens.getJSONObject(it) }
      .firstOrNull { it.getString("screenId") == alias }
  }

  private fun rpc(host: NativeControlHost, request: JSONObject): JSONObject = LocalSocket().use { socket ->
    socket.connect(LocalSocketAddress(host.endpoint.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
    socket.soTimeout = 10_000
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
