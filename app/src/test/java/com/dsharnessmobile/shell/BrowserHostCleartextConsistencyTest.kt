package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 跨层明文一致性（0.14.1 块K）：**准入面放行的 http host 必须在平台 NSC 策略下真的可达**。
 *
 * 为什么必须有这一条（issue #232 的结构性成因）：三层各自无法自证一致——
 *  - `BrowserHostNavigationPolicy` 决定「准入放行什么」；
 *  - `network_security_config.xml` 决定「平台允许什么」；
 *  - `BrowserHost` 的错误码映射决定「失败怎么显示」。
 * 旧状态是准入放行 `http://neverssl.com`、而 NSC 只白名单回环 ⇒ **准入说行、平台必炸**，
 * 侧栏必然出错误页，工具回执却仍报「已打开」。任何单层门禁都发现不了这个矛盾。
 *
 * 本测试的做法（**对真实函数调用 + 解析 NSC 本体**，禁文本在场式判据）：
 *  ① 解析 `network_security_config.xml` 得出「平台允许明文」的事实（存在 base-config=true）；
 *  ② 对**非本机、非回环**的 http 地址真实调用 [BrowserHostNavigationPolicy.normalize]；
 *  ③ 断言二者**同向**：准入接受 ⟺ 平台撑开明文。
 *
 * 反向对照（本测试不是「不会失败的测试」）：把 NSC 的 base-config 回退成
 * `cleartextTrafficPermitted="false"`（即 #232 的原始状态），本测试**必须判红**；
 * 同时 check-manifest-hardening.mjs 的 NSC 段也会判红（两侧各自独立可红）。
 */
class BrowserHostCleartextConsistencyTest {

  private fun nsc(): String? = listOf(
    "src/main/res/xml/network_security_config.xml",
    "app/src/main/res/xml/network_security_config.xml",
  ).map { File(it) }.firstOrNull { it.isFile }?.readText()

  /** 平台是否对**任意 host** 撑开明文（base-config cleartextTrafficPermitted="true"）。 */
  private fun platformAllowsCleartextAnywhere(text: String): Boolean {
    val baseConfigs = Regex("<base-config\\b[^>]*>").findAll(text).toList()
    if (baseConfigs.size != 1) return false
    return Regex("""cleartextTrafficPermitted\s*=\s*"true"""").containsMatchIn(baseConfigs[0].value)
  }

  @Test
  fun nscFileIsPresentAndParsable() {
    val text = nsc()
    assertNotNull("NSC 必须可定位（服务出去的隐私姿态依赖它）", text)
    assertTrue("必须恰好一个 base-config", Regex("<base-config\\b").findAll(text!!).count() == 1)
  }

  @Test
  fun admissionAcceptsPlainHttpOnlyWhenPlatformDoes() {
    val text = nsc() ?: throw AssertionError("NSC 文件缺席")
    val platformOpen = platformAllowsCleartextAnywhere(text)
    // 非本机、非回环的明文地址：这是 #232 报告的实际形态（局域网设备管理页 / 公网明文站点）。
    val lanHttp = BrowserHostNavigationPolicy.normalize("http://192.168.110.40:9090/")
    val publicHttp = BrowserHostNavigationPolicy.normalize("http://neverssl.com/")
    assertTrue("准入面必须继续接受 http（0.14.1 裁定方向：撑开平台策略，而非收紧准入）",
      lanHttp != null && publicHttp != null)
    assertTrue(
      "跨层同向被破坏：准入面放行明文 http，而平台 NSC 未撑开明文（这正是 issue #232 的成因）",
      platformOpen,
    )
  }

  @Test
  fun loopbackRemainsAdmittedAndItsExplicitSurfaceIsKept() {
    // 回环由 isLocalHost 设计拒绝（可信 DSH 回环源），与明文策略无关——它必须**继续被拒**。
    for (value in listOf("http://127.0.0.1:3080/", "http://localhost:3080/", "http://[::1]/")) {
      assertTrue("可信回环源必须继续被准入面拒绝：$value",
        BrowserHostNavigationPolicy.normalize(value) == null)
    }
    // NSC 的回环覆盖面（**0.14.1 更正：断言对象已改**）。
    //
    // 原断言要求 NSC 里保留 `>127.0.0.1<` / `>localhost<` / `>10.0.2.2<` 三条 **domain-config**。
    // 但块K 收口时**必须删掉**该 domain-config：它与 `base-config cleartextTrafficPermitted="true"`
    // 共存会触发 Android `ApplicationConfig.handleNewApplication()` 的
    //   `throw new RuntimeException("Found multiple conflicting per-domain rules")`
    // ——因为「base 与 per-domain 对明文的判定不一致，且存在 per-domain 配置」。
    // 设备实测后果是 Shizuku UserService 起不来（虚拟屏全线不可用）。故原断言已失效，
    // 且它锁的是**崩溃源**而不是安全性质。
    //
    // 真正要守的不变量有两条，且都不依赖 domain-config：
    //   ① 回环在**准入面**仍被拒（上面已断言）；
    //   ② NSC 必须**不能同时**存在 base 明文与 per-domain 明文（那正是崩溃形态）。
    val text = nsc() ?: throw AssertionError("NSC 文件缺席")
    assertTrue("NSC 必须显式声明 base-config 明文判定", text.contains("cleartextTrafficPermitted=\"true\""))
    assertFalse(
      "base 撑开明文时不得再并存 domain-config（Android 会抛 Found multiple conflicting per-domain rules，实测打死 Shizuku UserService）",
      Regex("<domain-config").containsMatchIn(text),
    )
  }
}
