package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 在线更新入口的准入判据（审查 §5.10 / S-10）。
 *
 * 缺陷形态：默认 manifest 地址是 `http://10.0.2.2:8899/manifest.json`（**模拟器别名**）且全仓
 * 没有生产覆盖点 ⇒ 真机上只能得到「连接超时」，而文档仍把它当可用能力写；同时留下一条明文 HTTP
 * + 同信道 sha256 的更新路径（完整性基准与载荷同源，对主动 MITM 零效力）。
 *
 * 0.14.1 裁定：**显式下线**（默认关闭），需要本地联调时用显式覆盖打开，且明文只允许回环/模拟器别名。
 */
class UpdateManagerPolicyTest {

  @Test
  fun onlineUpdateIsDisabledByDefault() {
    assertEquals("生产默认必须是「未启用」（不再指向模拟器别名）", "", UpdateManager.DEFAULT_MANIFEST_URL)
    val verdict = UpdateManager.validateManifestUrl("")
    assertEquals("", verdict.accepted)
    assertNull(verdict.refusal)
    assertNull("null 同样等价于关闭", UpdateManager.validateManifestUrl(null).refusal)
  }

  @Test
  fun plainHttpIsOnlyAllowedForLoopbackAndTheEmulatorAlias() {
    assertNull(UpdateManager.validateManifestUrl("http://10.0.2.2:8899/manifest.json").refusal)
    assertNull(UpdateManager.validateManifestUrl("http://127.0.0.1:8899/manifest.json").refusal)
    assertNull(UpdateManager.validateManifestUrl("https://updates.example.com/manifest.json").refusal)
    val refusal = UpdateManager.validateManifestUrl("http://updates.example.com/manifest.json").refusal
    assertTrue("非回环的明文 http 必须拒（否则「完整性与载荷同源」的旧问题原样回来）",
      refusal != null && refusal.contains("明文 http"))
  }

  @Test
  fun nonHttpSchemesAreRefused() {
    for (bad in listOf("file:///sdcard/manifest.json", "content://x/manifest.json")) {
      val refusal = UpdateManager.validateManifestUrl(bad).refusal
      assertTrue("必须拒非 http(s) 地址：$bad", refusal != null)
    }
  }

  @Test
  fun acceptedUrlIsReturnedVerbatim() {
    val verdict = UpdateManager.validateManifestUrl("  https://updates.example.com/m.json  ")
    assertEquals("https://updates.example.com/m.json", verdict.accepted)
  }
}
