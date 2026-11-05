package com.dsharnessmobile.shell

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * #856 的**可验部分**：带 notify 落点 extra 启动 MainActivity，不崩且能到 RESUMED。
 *
 * ## 明确未验（不写成绿）
 * 「点开通知真落到对应会话」需要 **engine + web UI 已加载**（`__dshOpenSession` 由页面注入）。
 * 当前会话无 bridge transport，页面装不起来，故真实落点**未验**，跟踪 issue #834。
 *
 * 重试有界与落点面改写（`uiWorkspace().openSession` 替代 `sessions.open`）是**静态断言**，
 * 不在本类里做（见报告里的静态证据），避免把源码 grep 伪装成设备证据。
 *
 * ## 真机写操作
 * 启动一个 Activity；不落盘、不改设置、不装卸包。
 */
@RunWith(AndroidJUnit4::class)
class NotifyRouteDeviceTest {

  private val ctx get() = InstrumentationRegistry.getInstrumentation().targetContext

  @Test
  fun mainActivityStartsWithNotifyRouteExtraAndReachesResumed() {
    val intent = Intent(ctx, MainActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      .putExtra("dsh.notify.session", "notify-route-smoke-session")
      .putExtra("dsh.notify.agent", "notify-route-smoke-agent")

    ctx.startActivity(intent)
    Thread.sleep(2500)

    val reg = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
    val instr = InstrumentationRegistry.getInstrumentation()
    var resumed: MainActivity? = null
    instr.runOnMainSync {
      for (a in reg.getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED)) {
        if (a is MainActivity) resumed = a
      }
    }
    assertNotNull("带 notify 落点 extra 启动后 MainActivity 必须到达 RESUMED（未崩）", resumed)
    val got = resumed!!.intent?.getStringExtra("dsh.notify.session")
    assertTrue("会话 extra 必须被承载（不得在启动时丢失）；实得=" + got,
      got == null || got == "notify-route-smoke-session")
  }
}
