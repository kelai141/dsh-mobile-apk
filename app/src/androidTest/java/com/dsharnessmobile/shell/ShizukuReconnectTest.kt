package com.dsharnessmobile.shell

import android.content.ComponentName
import android.content.ServiceConnection
import android.os.IBinder
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** 真实 SDK 与服务端验收；只在已启动并授权 Shizuku 的开发设备运行，无产品测试入口。 */
class ShizukuReconnectTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context get() = instrumentation.targetContext

  private fun connected() {
    val result = ShizukuTransport.ensureBound(context, requestPermission = false)
    assertTrue("Shizuku 未就绪：$result", result.optBoolean("bound"))
  }

  private fun currentConnection(): ServiceConnection {
    // 同一条用例可在修复前运行：旧实现只有一个全局 connection。
    val transport = ShizukuTransport::class.java
    val active = transport.declaredFields.firstOrNull { it.name == "activeAttempt" }
    if (active == null) return transport.getDeclaredField("connection").apply { isAccessible = true }
      .get(ShizukuTransport) as ServiceConnection
    active.isAccessible = true
    val attempt = checkNotNull(active.get(ShizukuTransport))
    return attempt.javaClass.getDeclaredField("connection").apply { isAccessible = true }
      .get(attempt) as ServiceConnection
  }

  private fun currentBinder(): IBinder {
    val remote = ShizukuTransport::class.java.getDeclaredField("service").apply { isAccessible = true }
      .get(ShizukuTransport) as ShizukuUserService
    return remote.asBinder()
  }

  @Test
  fun staleDisconnectDoesNotClearTheReplacement() {
    connected()
    val old = currentConnection()
    ShizukuTransport.resetConnection(context)
    connected()
    // 模拟已经排到 SDK 主线程的旧死亡通知，接收方是当时注册的旧回调。
    instrumentation.runOnMainSync {
      old.onServiceDisconnected(ComponentName(context, ShizukuUserServiceBridge::class.java))
    }
    val after = ShizukuTransport.status(context)
    assertTrue("旧回调清掉了已就绪的新连接：$after", after.optBoolean("bound"))
    assertFalse(after.optBoolean("binding"))
  }

  @Test
  fun repeatedResetRebuildsTheRealUserService() {
    connected()
    repeat(5) {
      val old = currentBinder()
      val reset = ShizukuTransport.resetConnection(context)
      assertTrue(reset.optBoolean("ok"))
      assertTrue(reset.optBoolean("reset"))
      connected()
      assertFalse("重置必须真正移除旧远端，不能只重新绑定同一实例", old.pingBinder())
      assertNotSame("新一轮必须拿到不同的远端 Binder", old, currentBinder())
      val ready = ShizukuTransport.status(context)
      assertTrue("第 $it 次重建失败：$ready", ready.optBoolean("ok"))
      assertFalse(ready.optBoolean("binding"))
    }
  }
}
