package com.dsharnessmobile.shell

import android.os.Binder
import android.os.ParcelFileDescriptor
import androidx.test.platform.app.InstrumentationRegistry
import java.lang.reflect.Proxy
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RendererCapturePipeDeviceTest {
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

  private fun readers() = Thread.getAllStackTraces().keys.filter { it.isAlive && it.name == "dsh-shot-pipe-reader" }.toSet()

  @Test fun largePayloadDrainsWhileCaptureIsStillWriting() {
    val expected = ByteArray(256 * 1024) { (it % 251).toByte() }
    val host = host { fd ->
      ParcelFileDescriptor.AutoCloseOutputStream(ParcelFileDescriptor.dup(fd.fileDescriptor)).use { it.write(expected) }
      true
    }
    assertArrayEquals(expected, host.capturePng("fixture", 100, 100))
  }

  @Test fun falseReceiptMustNotLeaveABlockedReader() = retainedWriter(0)
  @Test fun joinTimeoutMustNotLeaveABlockedReader() = retainedWriter(1)

  @Test fun exceptionalReceiptMustNotLeaveABlockedReader() = retainedWriter(2)

  @Test fun successfulReceiptWithoutBytesIsRejected() {
    assertNull(host { true }.capturePng("fixture", 100, 100))
  }

  @Test fun interruptionPreservesTheSignalAndCancelsTheReader() {
    val before = readers()
    var retained: ParcelFileDescriptor? = null
    try {
      val host = host { fd -> retained = ParcelFileDescriptor.dup(fd.fileDescriptor); true }
      Thread.currentThread().interrupt()
      assertNull(host.capturePng("fixture", 100, 100))
      assertTrue(Thread.currentThread().isInterrupted)
      assertTrue((readers() - before).isEmpty())
    } finally {
      Thread.interrupted()
      retained?.close()
      for (reader in readers() - before) reader.join(2000)
    }
  }

  private fun retainedWriter(receipt: Int) {
    val before = readers()
    var retained: ParcelFileDescriptor? = null
    try {
      val host = host { fd ->
        retained = ParcelFileDescriptor.dup(fd.fileDescriptor)
        if (receipt == 2) throw IllegalStateException("fixture capture failure")
        receipt == 1
      }
      assertNull(host.capturePng("fixture", 100, 100))
      Thread.sleep(150)
      assertTrue("capture returned with a blocked pipe reader", (readers() - before).isEmpty())
    } finally {
      retained?.close()
      for (reader in readers() - before) reader.join(2000)
    }
  }
}
