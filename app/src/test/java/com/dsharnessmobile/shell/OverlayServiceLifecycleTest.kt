package com.dsharnessmobile.shell

import android.app.Service
import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

  /**
   * 取件代理（透明、独立 taskAffinity、只活一两秒）消失时也会回调 onTaskRemoved。
   *
   * 现场实测：点「文件」拉起取件后，浮窗连球带窗全部消失、草稿被清空。真因是这里无条件
   * stopSelf()，把「代理任务结束」当成「用户划掉主任务」。这条测试锁住判据本身：
   * 只有 MAIN/LAUNCHER 的 rootIntent 才算主任务，代理任务与系统取件任务都不算。
   */
  @Test
  fun onlyMainLauncherTaskRemovalCountsAsUserDismissal() {
    assertTrue(
      "用户从最近任务划掉主入口才算主动关闭",
      OverlayService.isMainTaskIntentForTest(Intent.ACTION_MAIN, listOf(Intent.CATEGORY_LAUNCHER)),
    )
    assertFalse(
      "取件代理任务消失不得拆浮窗",
      OverlayService.isMainTaskIntentForTest("com.dsharnessmobile.shell.ACTION_OVERLAY_START", null),
    )
    assertFalse("系统取件窗口没有 rootIntent", OverlayService.isMainTaskIntentForTest(null, null))
    assertFalse(
      "只有 MAIN 但没有 LAUNCHER 分类不算主任务",
      OverlayService.isMainTaskIntentForTest(Intent.ACTION_MAIN, emptyList()),
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
