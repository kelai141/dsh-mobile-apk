package com.dsharnessmobile.shell

import android.os.IBinder
import android.os.ParcelFileDescriptor
import androidx.test.platform.app.InstrumentationRegistry
import java.lang.reflect.Proxy
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * tier-2 截图管道读线程回收的**设备层**判据（issue #607 / PR #627）。
 *
 * 用真实 `ParcelFileDescriptor` 管道驱动生产 `RemoteRendererHost.capturePng`，远端回执由
 * `IBrowserRenderer` 的动态代理伪造，覆盖 #607 实测的两种泄漏形态：
 *  1. 回执返回 false，但远端**保留写端未关**；
 *  2. 回执返回 true 之后远端**不结束写入**。
 * 两种情形下 `capturePng` 返回 null 后，`dsh-shot-pipe-reader` 都必须已经不存在。
 */
class RendererCapturePipeTest {

  private fun readers(): Set<Thread> =
    Thread.getAllStackTraces().keys.filter { it.isAlive && it.name == CapturePipeDrain.READER_NAME }.toSet()

  private fun host(capture: (ParcelFileDescriptor) -> Boolean): RemoteRendererHost {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val host = RemoteRendererHost(context, false, object : RemoteRendererHost.Listener {
      override fun onRendererEvent(tabId: String, event: JSONObject) = Unit
      override fun onRendererJsResult(tabId: String, seq: Int, result: JSONObject) = Unit
    })
    val api = Proxy.newProxyInstance(
      IBrowserRenderer::class.java.classLoader,
      arrayOf(IBrowserRenderer::class.java),
    ) { _, method, args ->
      when (method.name) {
        "capture" -> capture(args!![1] as ParcelFileDescriptor)
        "asBinder" -> null as IBinder?
        else -> null
      }
    } as IBrowserRenderer
    RemoteRendererHost::class.java.getDeclaredField("renderer").apply { isAccessible = true }.set(host, api)
    return host
  }

  private fun assertNoReaderLeft(before: Set<Thread>) {
    // 取消预算是 500ms；给 2s 余量再判，避免把调度延迟当成泄漏。
    val deadline = System.currentTimeMillis() + 2_000
    while (System.currentTimeMillis() < deadline && (readers() - before).isNotEmpty()) Thread.sleep(50)
    for (thread in readers() - before) thread.join(2_000)
    val leaked = readers() - before
    assertTrue("capturePng 返回后不得遗留读线程：" + leaked.map { it.name }, leaked.isEmpty())
  }

  /**
   * 判据 1（回执 false）：远端保留写端不放，读线程必须被收掉。
   * 旧实现在这里直接 return null，读线程会一直阻塞到远端关写端。
   */
  @Test
  fun falseReceiptReclaimsReaderWhileRemoteStillHoldsWriter() {
    val before = readers()
    var retained: ParcelFileDescriptor? = null
    try {
      val host = host { fd ->
        retained = ParcelFileDescriptor.dup(fd.fileDescriptor)
        false
      }
      assertNull(host.capturePng("fixture", 100, 100))
      assertNoReaderLeft(before)
    } finally {
      retained?.close()
    }
  }

  /**
   * 判据 2（超时）：回执 true 但远端永不结束写入，`capturePng` 必须在预算内返回 null，
   * 且读线程已被收掉。旧实现在这里同样直接 return，把线程留在管道上。
   */
  @Test
  fun timeoutReclaimsReaderWhileRemoteKeepsWriting() {
    val before = readers()
    var retained: ParcelFileDescriptor? = null
    try {
      val host = host { fd ->
        retained = ParcelFileDescriptor.dup(fd.fileDescriptor)
        true
      }
      val startedAt = System.currentTimeMillis()
      assertNull("远端不结束写入时必须拒收", host.capturePng("fixture", 100, 100))
      val elapsed = System.currentTimeMillis() - startedAt
      assertTrue("必须在 join 预算附近返回，实测 " + elapsed + "ms", elapsed < 20_000)
      assertNoReaderLeft(before)
    } finally {
      retained?.close()
    }
  }

  /**
   * 判据 3（大载荷）：256KiB 超过管道缓冲，必须在远端**仍在写**时被并发排空。
   * 这条同时验证修复没有把正常路径改坏。
   */
  @Test
  fun largePayloadIsDrainedWhileRemoteIsStillWriting() {
    val before = readers()
    val expected = ByteArray(256 * 1024) { (it % 251).toByte() }
    val host = host { fd ->
      // 在 binder 回执内部同步写满 256KiB：若宿主不并发读，这里会阻塞直到缓冲耗尽。
      ParcelFileDescriptor.AutoCloseOutputStream(ParcelFileDescriptor.dup(fd.fileDescriptor)).use {
        it.write(expected)
      }
      true
    }
    assertArrayEquals("256KiB 截图必须完整传回", expected, host.capturePng("fixture", 100, 100))
    assertNoReaderLeft(before)
  }

  /**
   * 判据 4（fd 不增长）：连续 10 次失败截图后，**宿主进程**的管道描述符数量不得增长。
   *
   * 注意这里必须自己关掉 `dup` 出来的那份写端副本：它代表的是**远端**持有的 fd，属于另一个
   * 进程，不该算进本进程的账。早先不关的写法把测试自己的 fd 也算成泄漏，是假红。
   */
  @Test
  fun repeatedFailuresDoNotLeakFileDescriptors() {
    val fdDir = java.io.File("/proc/self/fd")
    val host = host { fd ->
      runCatching { ParcelFileDescriptor.dup(fd.fileDescriptor).close() }
      false
    }
    // 预热一轮，排除首次调用的一次性分配。
    runCatching { host.capturePng("fixture", 100, 100) }
    Thread.sleep(500)
    val baseline = fdDir.listFiles()?.size ?: 0
    repeat(10) { assertNull(host.capturePng("fixture", 100, 100)) }
    Thread.sleep(1_000)
    val after = fdDir.listFiles()?.size ?: 0
    assertTrue("连续 10 次失败后 fd 不得增长（前 " + baseline + " 后 " + after + "）", after - baseline <= 5)
  }

  /**
   * 判据 5（主线程不再等满）：失败回执必须**立即**返回，而不是把调用方拖到 10s 主线程超时。
   * 这里直接在测试线程上计时，阈值取 5s（真实主线程场景由设备手工验收覆盖）。
   */
  @Test
  fun failureReturnsPromptly() {
    val host = host { fd ->
      runCatching { ParcelFileDescriptor.dup(fd.fileDescriptor) }
      false
    }
    val startedAt = System.currentTimeMillis()
    assertNull(host.capturePng("fixture", 100, 100))
    val elapsed = System.currentTimeMillis() - startedAt
    assertTrue("失败回执必须立即返回，实测 " + elapsed + "ms", elapsed < 5_000)
  }
}
