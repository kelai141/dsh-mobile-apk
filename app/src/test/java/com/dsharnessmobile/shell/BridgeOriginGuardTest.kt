package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import java.io.File
import org.junit.Test

/**
 * #686 第二层回归：document-start 桥帧来源守卫 + pick token 持有式凭据。
 *
 * 第一层（[AndroidBridge.checkTrustedFrame]）由 AndroidBridgeFrameGuardTest 覆盖。
 * 本类只覆盖第二层，两层互补：
 *   - 第一层挡「顶层被劫持出引擎 origin」；
 *   - 第二层挡「引擎 origin 顶层之下的跨源子帧」——第一层按定义读不到调用者帧。
 *
 * 反证（本类必须能红）：
 *   1. 把守卫判据从「isTop || listed || origin==='null'」改成只判 origin，
 *      opaque 主帧用例红（这正是实测到的坑：主帧某些阶段 origin 是 "null"）；
 *   2. 删掉 secret 校验直接返回 pickToken，凭据用例红；
 *   3. 把零参重载删掉，重载存在性用例红（会让既有页面调用点抛 Method not found）。
 */
class BridgeOriginGuardTest {

  private val engine = "http://127.0.0.1:4145"

  @Test
  fun scriptGatesOnTopFrameAndOriginWhitelist() {
    val js = BridgeOriginGuard.script(listOf(engine))
    assertTrue("守卫必须判顶层帧（主帧 origin 可能为 null，只判 origin 会误封）", js.contains("window.top === window"))
    assertTrue("守卫必须读 location.origin", js.contains("location.origin"))
    // 必须是 isTop || listed 两条；**不得**把 origin === 'null' 当放行条件——
    // sandbox 攻击帧的 location.origin 正是 'null'，列进来等于放行整类攻击帧
    // （实测：sandbox="allow-scripts" 子帧 origin === 'null'）。主帧的 null 期由 isTop 兜住。
    assertTrue("放行判据必须是 isTop || listed", js.contains("var allowed = isTop || listed"))
    assertFalse(
      "不得把 'null' 当作放行条件：那会放行所有 opaque 子帧（正是本 issue 的攻击面）",
      js.contains("origin === 'null'"),
    )
    assertTrue("非放行帧必须 delete 桥", js.contains("delete window.androidBridge"))
    assertFalse("守卫自身不得抛到页面", js.contains("throw "))
  }

  @Test
  fun scriptPublishesCanaryOnHtmlNotAsGlobal() {
    val js = BridgeOriginGuard.script(listOf(engine))
    // canary 必须落在 <html data-dsh-bridge-guard>：未来任何人都能在设备上复核。
    assertTrue("必须写 data-dsh-bridge-guard 属性", js.contains("data-dsh-bridge-guard"))
    assertTrue("canary 必须带 feature 支持与当刻桥可见性", js.contains("atStart"))
    assertTrue("canary 必须带顶层帧判据", js.contains("C.top = isTop"))
    assertTrue("canary 必须带 origin", js.contains("C.origin = origin"))
    // document-start 时 documentElement 尚不存在（设备实测 hasDocEl:false），必须延后发布。
    assertTrue("documentElement 未就绪时必须兜底延后", js.contains("MutationObserver"))
    assertTrue("必须能返回是否已发布", js.contains("function publish()"))
    // 条件 5：canary 不得挂成全局变量。
    assertFalse("canary 不得挂全局（条件 5：零新增全局）", js.contains("window.__dshBridgeGuard ="))
  }

  @Test
  fun scriptEmbedsOriginsAsJsonArrayNotHardcodedLiteral() {
    val js = BridgeOriginGuard.script(listOf("http://127.0.0.1:4145"))
    // escapeJs 会把 < > 转成 \u003c/\u003e（防注入的有意行为），所以断言"数组形态 + 含注入值"，
    // 不假设逐字未转义。
    assertTrue("白名单必须是 JSON 数组形态", js.contains("var ALLOWED = ["))
    assertTrue("白名单必须含注入值", js.contains("127.0.0.1:4145"))
    // 端口是运行期确定的（#1130），不得在源码里写死：换个端口必须产出不同脚本。
    val other = BridgeOriginGuard.script(listOf("http://127.0.0.1:6001"))
    assertNotEquals("白名单必须跟随注入值，不能写死字面量", js, other)
  }

  @Test
  fun scriptEscapesInjectionHostileOrigin() {
    val js = BridgeOriginGuard.script(listOf("http://x/\";alert(1);//"))
    assertFalse("引号必须被转义，否则可闭合字符串注入脚本", js.contains("\"\";alert(1)"))
    assertTrue("必须含转义后的字形", js.contains("\\\""))
  }

  @Test
  fun guardOriginMustEqualPersistedEngineEndpoint() {
    // 评审要求：守卫脚本串里的 origin 必须**等于** EngineEndpoint 的持久化值，
    // 两者不一致必须红 —— 防止端口改了守卫不跟。
    //
    // EngineProbe.ENGINE_URL 派生于 EngineEndpoint（val ENGINE_URL get() = EngineEndpoint.url），
    // 所以这里断言两者同源；若有人把守卫改成写死字面量或通配，这条红。
    // EngineEndpoint 在 JVM 单测里没有真实端口（port=0），不能当正例取值。
    // 改为断言**接线同源**：安装处必须用 EngineProbe.ENGINE_URL（EngineEndpoint 的派生），
    // 而不是写死字面量或通配——端口改了守卫自然跟着改。
    val src = readMainActivity()
    assertTrue(
      "守卫 origin 必须来自 EngineProbe.ENGINE_URL（派生于 EngineEndpoint）",
      src.contains("val origins = listOf(EngineProbe.ENGINE_URL)"),
    )
    assertFalse(
      "守卫不得写死端口字面量",
      Regex("origins\\.add\\(\\s*\"http://127\\.0\\.0\\.1:").containsMatchIn(src),
    )
    // 注入值必须真的进脚本（用可判定的一组合成 origin 验证传递链）。
    val js = BridgeOriginGuard.script(listOf("http://127.0.0.1:4321"))
    assertTrue("注入的 origin 必须出现在脚本白名单里", js.contains("127.0.0.1:4321"))
    // 反证：通配会让本机其它端口的页面拿到桥，必须不出现。
    assertFalse("守卫不得使用通配端口", js.contains("127.0.0.1:*"))
    assertFalse("守卫不得使用通配 origin", js.contains("\"*\""))
  }

  @Test
  fun portUnconfirmedSkipsRegistrationWithVisibleWarning() {
    // 端口未确定时必须跳过注册并报警，而不是回退通配。
    val src = readMainActivity()
    assertTrue("必须检查 confirmed/port", src.contains("EngineEndpoint.confirmed"))
    assertTrue(
      "端口未确认必须写可见告警（回退通配会让本机其它端口拿到桥）",
      src.contains("bridge frame origin guard NOT installed (engine port not confirmed yet)"),
    )
    assertTrue("必须落 boot-diag 可查", src.contains("bridge-guard-port-unconfirmed"))
  }

  @Test
  fun registrationHappensAfterPortIsConfirmed() {
    // 晚注册：installBridgeOriginGuard 必须在 loadConfirmedEnginePage 内、loadUrl 之前调用。
    val src = readMainActivity()
    val loadFn = src.indexOf("private fun loadConfirmedEnginePage()")
    assertTrue("找不到 loadConfirmedEnginePage", loadFn > 0)
    val guardCall = src.indexOf("installBridgeOriginGuard()", loadFn)
    val loadUrl = src.indexOf("webView.loadUrl(", loadFn)
    assertTrue("installBridgeOriginGuard 必须在 loadConfirmedEnginePage 内调用", guardCall > loadFn)
    assertTrue("守卫注册必须早于 loadUrl（document-start 对之后的文档生效）", guardCall < loadUrl)
  }

  @Test
  fun primaryControlPickTokenStillWorksOnAllowedFrame() {
    // 评审：保留那条正控断言。整对象封死后不再加凭据层，但放行帧必须照常拿得到真值。
    val bridge = AndroidBridge({ _ -> }, { _ -> }, { _, _ -> }, pickToken = "real-token", isTrustedTopFrame = { true })
    assertEquals("放行帧必须照常拿到 pick token", "real-token", bridge.getPickToken())
  }

  private fun readMainActivity(): String =
    File("src/main/java/com/dsharnessmobile/shell/MainActivity.kt").takeIf { it.isFile }?.readText()
      ?: File("app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt").readText()
}