package com.dsharnessmobile.shell

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * #852：vdisplay 的引导文案不再教用户「点创建按钮」。
 *
 * 本机**未装 Shizuku**，`VdisplayController.status(ctx)` 必定返回 `state=blocked` ——
 * 正是被改的那条引导路径，因此可设备面直接验。
 *
 * 观察点：
 * 1. `guidance` 非空（反向保护：空串上「不含某词」恒成立）；
 * 2. 不得再出现「点创建/新建屏幕」类按钮引导；
 * 3. 必须表达「由模型驱动 / 模型创建」语义。
 *
 * ## 真机写操作：无（只读 status）
 */
@RunWith(AndroidJUnit4::class)
class VdisplayGuidanceDeviceTest {

  private val ctx get() = InstrumentationRegistry.getInstrumentation().targetContext

  @Test
  fun blockedGuidanceDoesNotTellUserToTapACreateButton() {
    val st = VdisplayController.status(ctx)
    val state = st.optString("state", "")
    val guidance = st.optString("guidance", "")
    val ui = st.optString("ui", "") + " " + st.optString("action", "")

    assertTrue("前提：必须取到 guidance（空串上断言无意义）；实得 state=" + state, guidance.isNotBlank())

    // 改前教用户点一个不存在的创建按钮；改后不得再有该引导。
    val forbidden = listOf("点创建", "点击创建", "新建屏幕", "点击新建")
    for (f in forbidden) {
      assertFalse("guidance 不得再教用户点不存在的按钮：「" + f + "」；实得=" + guidance,
        guidance.contains(f) || ui.contains(f))
    }

    // 必须表达「模型驱动」语义（不只删负面，还要有正向说明）。
    val modelDriven = listOf("模型", "对话", "model", "助手")
    assertTrue("guidance 必须说明建屏由模型驱动；实得=" + guidance,
      modelDriven.any { guidance.contains(it, ignoreCase = true) })
  }
}
