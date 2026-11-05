package com.dsharnessmobile.shell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #579 台账换源/更新链批次（2026-10-25）中**可在 JVM 直接反证**的两条判据。
 *
 * ## #12：INSTALLING 不再挡新动作
 *
 * 缺陷形态：`busy()` 含 INSTALLING ⇒ 用户在系统侧**取消安装器**后没有任何路径把状态推走，
 * `beginCheck` 永久拒绝；而引导页在 INSTALLING 态把检查按钮渲染为可点（渲染层注释
 * 「恢复可检查」）——按钮点了恒无响应，更新面死锁到杀应用。
 * 判据：INSTALLING 下 `busy()==false` 且 `beginCheck()==true`（取消安装器的事实出路）。
 *
 * ## #10：元数据重定向白名单
 *
 * 摘要权威源（MANIFEST/releases.json 里的 sha256）决定 169MB 载荷的可信度，镜像方一条
 * 302 不能把它劫到任意主机。同域跳转与 GitHub 官方资产域放行，其余拒绝。
 */
class ApkUpdateRegressTest {

  @Test
  fun `installing 状态不再阻塞新的检查`() {
    val s = ApkUpdateState()
    assertTrue(s.beginCheck())
    s.onCheckResult(
      UpdateChecker.CheckResult.Available("v9.9.9", "app-arm64.apk", "https://example.invalid/a.apk", "ab", 1L),
      "0.0.1",
    )
    assertTrue(s.beginDownload())
    s.onInstalling(true)
    // #12：INSTALLING = 控制权在系统安装器手里；取消安装器的出路是再查一轮。
    assertFalse("INSTALLING 不得再算 busy（取消安装器后要能重新检查）", s.busy())
    assertTrue("INSTALLING 下必须受理新检查", s.beginCheck())
  }

  @Test
  fun `元数据重定向只放行同域与GitHub官方资产域`() {
    // 同域（镜像自身的路径调整）与 GitHub 资产域放行。
    assertTrue(UpdateChecker.metadataRedirectAllowed("gh-proxy.com", "gh-proxy.com"))
    assertTrue(UpdateChecker.metadataRedirectAllowed("gh-proxy.com", "objects.githubusercontent.com"))
    assertTrue(UpdateChecker.metadataRedirectAllowed("ghfast.top", "release-assets.githubusercontent.com"))
    // 任意第三方域（劫持形态）拒绝。
    assertFalse(UpdateChecker.metadataRedirectAllowed("gh-proxy.com", "evil.example.com"))
    assertFalse(UpdateChecker.metadataRedirectAllowed("gh-proxy.com", "evil.githubusercontent.com.evil.example.com"))
    assertFalse(UpdateChecker.metadataRedirectAllowed("kelai141.github.io", "mirror.example.net"))
  }
}
