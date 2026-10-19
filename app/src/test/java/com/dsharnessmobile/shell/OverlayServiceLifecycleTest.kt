package com.dsharnessmobile.shell

import android.app.Service
import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 悬浮球服务的生命周期契约（引擎未启动时划掉任务 → 球不复活）。
 *
 * 真因：`OverlayService` 此前没有覆写 `onStartCommand`，系统在任务被划掉后按默认
 * `START_STICKY` 重建服务，`onCreate` 重新建窗 —— 现场是「球消失一下又冒出来」。
 * 引擎开着时由 `EngineService.onTaskRemoved` 顺手 stop 掉，所以只有「引擎没启动」这一路暴露。
 *
 * 判红依据是 Kotlin 决定的返回值，不是 Android 桩：删掉覆写后 `Service.onStartCommand`
 * 走默认实现返回 `START_STICKY`，本用例立刻失败。`stopSelf()` 在 JVM 桩里是无副作用的空实现，
 * 故这里只锁「不再选择粘性重启」这一条可观测语义。
 */
class OverlayServiceLifecycleTest {

  @Test
  fun systemRestartWithoutIntentDoesNotOptIntoStickyRestart() {
    assertEquals(
      "重建投递（intent == null）不得选择粘性重启：否则划掉任务后服务会被系统拉起、球自己回来",
      Service.START_NOT_STICKY,
      OverlayService().onStartCommand(null, 0, 1),
    )
  }

  @Test
  fun explicitStartDoesNotOptIntoStickyRestart() {
    assertEquals(
      "显式启动同样不得选择粘性重启",
      Service.START_NOT_STICKY,
      OverlayService().onStartCommand(Intent("com.dsharnessmobile.shell.ACTION_OVERLAY_START"), 0, 1),
    )
  }
}
