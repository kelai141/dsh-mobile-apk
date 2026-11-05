package com.dsharnessmobile.shell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #945：覆盖安装后归一起动意图的**纯判据**。
 *
 * 现场：0.14.9 → 0.14.10 覆盖安装后冷启动整屏黑，`boot-diag.log` 连 `note=boot-start` 都没有。
 * 真因是 `autostart_on_open=false` 与 `user_shutdown=true` 同时残留 ⇒ `userClosedEngine=true` ⇒
 * 启动流程根本不发起。
 *
 * 这里守的边界（错一半都会伤用户）：
 *  ① **版本变化**必须归一（否则「装完更新就打不开」）；
 *  ② **同版本内不得归一** —— 用户在同一个版本里关掉引擎是显式选择，重启应用不该被强行拉起；
 *  ③ **首次安装不得归一** —— 没有旧版本记录时默认值本来就对，多清一次是噪音（也可能覆盖用户首次设置）。
 */
class StartupPrefsNormalizerTest {
  private val current = "0.14.10"

  @Test
  fun `覆盖安装（版本变化）必须归一`() {
    assertTrue(StartupPrefsNormalizer.shouldResetStartIntent("0.14.9", current))
    assertTrue(StartupPrefsNormalizer.shouldResetStartIntent("0.13.8", current))
  }

  @Test
  fun `同版本内不得归一（尊重用户的关闭选择）`() {
    assertFalse(StartupPrefsNormalizer.shouldResetStartIntent(current, current))
  }

  @Test
  fun `首次安装不得归一`() {
    assertFalse(StartupPrefsNormalizer.shouldResetStartIntent(null, current))
    assertFalse("空串按未记录处理", StartupPrefsNormalizer.shouldResetStartIntent("", current))
  }
}