package com.dsharnessmobile.shell

import android.os.Binder
import android.os.ParcelFileDescriptor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.core.app.ActivityScenario
import java.lang.reflect.Proxy
import java.io.ByteArrayOutputStream
import java.util.Random
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RendererCapturePipeDeviceTest {
  @Test fun realRendererBinderReturnsDecodablePngBeforeJoinTimeout() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val host = RemoteRendererHost(context, false, object : RemoteRendererHost.Listener {
      override fun onRendererEvent(tabId: String, event: JSONObject) = Unit
      override fun onRendererJsResult(tabId: String, seq: Int, result: JSONObject) = Unit
    })
    ActivityScenario.launch(BrowserRendererHostActivity::class.java).use { scenario ->
      try {
        host.connect()
        assertTrue("Real renderer service did not bind", host.awaitBound())
        var activity: BrowserRendererHostActivity? = null
        scenario.onActivity { activity = it }
        val token = activity!!.hostToken()
        assertNotNull("Test window must provide a host token", token)
        val api = host.renderer!!
        val created = JSONObject(api.ensureTab("writer-eof", token,
          JSONObject().put("widthPx", 512).put("heightPx", 512).put("identityId", "android-real").toString()))
        assertTrue("Real renderer tab was not created: $created", created.optBoolean("ok"))
        val started = System.nanoTime()
        val png = host.capturePng("writer-eof", 512, 512)
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        assertNotNull("Real Binder capture must reach EOF", png)
        assertTrue("Successful capture waited for the join timeout: $elapsedMs ms", elapsedMs < 5_000)
        val decoded = BitmapFactory.decodeByteArray(png!!, 0, png.size)
        assertNotNull("Real renderer output must decode as PNG", decoded)
        try {
          assertEquals(512, decoded.width)
          assertEquals(512, decoded.height)
        } finally { decoded.recycle() }
      } finally {
        runCatching { host.renderer?.destroyTab("writer-eof") }
        host.disconnect()
      }
    }
  }

  private fun host(capture: (ParcelFileDescriptor) -> Boolean): RemoteRendererHost {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val host = RemoteRendererHost(context, false, object : RemoteRendererHost.Listener {
      override fun onRendererEvent(tabId: String, event: JSONObject) = Unit
      override fun onRendererJsResult(tabId: String, seq: Int, result: JSONObject) = Unit
    })
    val api = Proxy.newProxyInstance(IBrowserRenderer::class.java.classLoader, arrayOf(IBrowserRenderer::class.java)) { _, method, args ->
      when (method.name) {
        "capture" -> capture(args!![1] as ParcelFileDescriptor)
        "asBinder" -> Binder()
        else -> null
      }
    } as IBrowserRenderer
    RemoteRendererHost::class.java.getDeclaredField("renderer").apply { isAccessible = true }.set(host, api)
    return host
  }

  @Test(timeout = 25_000) fun largePayloadDrainsWhileCaptureIsStillWriting() {
    val random = Random(607L)
    val pixels = IntArray(512 * 512) { 0xff000000.toInt() or random.nextInt(0x1000000) }
    val bitmap = Bitmap.createBitmap(pixels, 512, 512, Bitmap.Config.ARGB_8888)
    val expected = try {
      ByteArrayOutputStream().use { out ->
        assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, out))
        out.toByteArray()
      }
    } finally { bitmap.recycle() }
    assertTrue("Fixture PNG exceeds the pipe buffer", expected.size > 256 * 1024)
    val host = host { fd ->
      ParcelFileDescriptor.AutoCloseOutputStream(ParcelFileDescriptor.dup(fd.fileDescriptor)).use { it.write(expected) }
      true
    }
    val actual = host.capturePng("fixture", 512, 512)
    assertArrayEquals("Closing the remote duplicate must permit EOF before joining", expected, actual)
    val decoded = BitmapFactory.decodeByteArray(actual!!, 0, actual.size)
    try {
      assertEquals(512, decoded.width)
      assertEquals(512, decoded.height)
    } finally { decoded.recycle() }
  }

}
