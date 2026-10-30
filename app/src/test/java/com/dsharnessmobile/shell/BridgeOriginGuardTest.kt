package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
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
    val js = BridgeOriginGuard.script(listOf(engine), "s3cret")
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
    val js = BridgeOriginGuard.script(listOf(engine), "s")
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
    val js = BridgeOriginGuard.script(listOf("http://127.0.0.1:4145", "http://127.0.0.1:5000"), "s")
    assertTrue("白名单必须是可注入的 JSON 数组", js.contains("[\"http://127.0.0.1:4145\",\"http://127.0.0.1:5000\"]"))
    // 端口是运行期确定的（#1130），不得在源码里写死：换个端口必须产出不同脚本。
    val other = BridgeOriginGuard.script(listOf("http://127.0.0.1:6001"), "s")
    assertNotEquals("白名单必须跟随注入值，不能写死字面量", js, other)
  }

  @Test
  fun scriptNeverLeaksSecretToTopFrameAsEnumerableGlobal() {
    val js = BridgeOriginGuard.script(listOf(engine), "s3cret")
    // secret 只能在顶层帧、且必须不可枚举：否则子帧能枚举出来（条件 5）。
    assertTrue("secret 必须落在 defineProperty 里", js.contains("Object.defineProperty"))
    assertTrue("secret 必须不可枚举", js.contains("enumerable: false"))
    assertTrue("secret 必须不可写", js.contains("writable: false"))
    // 反证：写成 window.__dshPickSecret = SECRET 会让它可枚举。
    assertFalse("不得用可枚举的赋值形式暴露 secret", js.contains("window.__dshPickSecret = "))
  }

  @Test
  fun scriptEscapesInjectionHostileOrigin() {
    val js = BridgeOriginGuard.script(listOf("http://x/\";alert(1);//"), "s")
    assertFalse("引号必须被转义，否则可闭合字符串注入脚本", js.contains("\"\";alert(1)"))
    assertTrue("必须含转义后的字形", js.contains("\\\""))
  }

  @Test
  fun pickSecretIsRandomPerProcessAndLongEnough() {
    val a = BridgePickToken.current()
    val b = BridgePickToken.current()
    assertEquals("同一进程内 secret 必须稳定（守卫与校验读到同一份）", a, b)
    assertEquals("32 字节的 hex 应为 64 字符", 64, a.length)
    assertTrue("secret 必须是 hex", a.all { it in "0123456789abcdef" })
    assertFalse("secret 不得为空", a.isEmpty())
  }

  @Test
  fun pickTokenRequiresMatchingSecret() {
    val bridge = AndroidBridge({ _ -> }, { _ -> }, { _, _ -> }, pickToken = "real-token", isTrustedTopFrame = { true })
    assertEquals("带对 secret 必须拿到真值", "real-token", bridge.getPickToken(BridgePickToken.current()))
    assertEquals("secret 不对必须返回 null（不抛，属可选能力）", null, bridge.getPickToken("wrong"))
    // 零参/null 保持原有语义：现有页面三处调用点都是零参形式，收紧会打断目录选择器链路。
    // 第二层的语义是「能带凭据的调用方多一层校验」，不是「把旧调用方关掉」。
    assertEquals("零参保持原语义（向后兼容）", "real-token", bridge.getPickToken(null))
  }

  @Test
  fun zeroArgOverloadStillExistsForExistingPageCallers() {
    // WebView 的 JS 桥按实参个数匹配 Java 方法：零参调用点（dsh-host-web-compat 三处）
    // 必须仍有零参方法可匹配，否则抛 Method not found，把正常功能弄坏。
    val zeroArg = AndroidBridge::class.java.declaredMethods
      .filter { it.name == "getPickToken" && it.parameterCount == 0 }
    assertEquals("必须保留零参重载", 1, zeroArg.size)
    val oneArg = AndroidBridge::class.java.declaredMethods
      .filter { it.name == "getPickToken" && it.parameterCount == 1 }
    assertEquals("必须存在带 secret 的单参重载", 1, oneArg.size)
  }

  @Test
  fun zeroArgOverloadKeepsBackwardCompatibleSemantics() {
    val bridge = AndroidBridge({ _ -> }, { _ -> }, { _, _ -> }, pickToken = "real-token", isTrustedTopFrame = { true })
    // 零参 = 旧调用点的形态。第二层不能靠收紧它来"加固"，那会直接打断
    // dsh-host-web-compat 的三处 x-dsh-pick-token 链路（AndroidBridgeFrameGuardTest 钉着它）。
    assertEquals("零参必须仍拿得到 token（向后兼容）", "real-token", bridge.getPickToken())
  }
}
