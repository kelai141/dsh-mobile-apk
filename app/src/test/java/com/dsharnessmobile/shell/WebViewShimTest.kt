package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WebViewShim 契约 + 纯函数测试。
 *
 * 两类判据：
 *  1. **纯函数**：`majorOf` 不碰 android.*，JVM 上真实执行（与 CoordBasisPolicy 同手法）。
 *  2. **源码契约**：WebView 的「版本敏感面」（provider 回读 / SDK_INT 设置门 / androidx
 *     特性门）必须只住在 WebViewShim.kt——防副本再次漂移（本 shim 就是为此而生）。
 */
class WebViewShimTest {

  private fun sourceRoot(): File {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell"),
      File("app/src/main/java/com/dsharnessmobile/shell"),
    )
    return candidates.firstOrNull { it.isDirectory }
      ?: throw AssertionError("找不到壳侧源码目录（工作目录 = " + File(".").absolutePath + "）")
  }

  private fun source(name: String): String =
    File(sourceRoot(), name).takeIf { it.isFile }?.readText()
      ?: throw AssertionError("找不到壳侧源码 $name")

  /** 去掉注释行（与 CallSiteContractTest 同口径：注释里出现形态名不算命中）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /** 全部壳侧 main 源码（含子目录）。 */
  private fun allMainSources(): List<File> =
    sourceRoot().walkTopDown().filter { it.isFile && it.name.endsWith(".kt") }.toList()

  /** 某 token 出现在哪些 main 源文件的**代码**里（注释剥离后）。 */
  private fun filesContaining(token: String): List<String> =
    allMainSources().filter { codeOnly(it.readText()).contains(token) }.map { it.name }

  // ── majorOf 纯函数行为 ─────────────────────────────────────────────

  @Test
  fun majorOfParsesTheFirstDottedSegment() {
    assertEquals(110, WebViewShim.majorOf("110.0.5481.154.1"))
    assertEquals(9, WebViewShim.majorOf("9.9"))
    assertEquals(94, WebViewShim.majorOf("94.0.4606.85"))
  }

  @Test
  fun majorOfReturnsZeroOnUnreadableInput() {
    // 0 = 显式未知：判据侧（syntax_floor_ok）必须拿不到版本就失败，不许冒充通过。
    assertEquals(0, WebViewShim.majorOf(""))
    assertEquals(0, WebViewShim.majorOf("unknown"))
    assertEquals(0, WebViewShim.majorOf(".5"))
  }

  @Test
  fun chromiumVersionComesFromTheEngineUserAgentNotVendorPackageVersion() {
    assertEquals(
      "99.0.4844.88",
      WebViewShim.chromiumVersionFromUserAgent("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/99.0.4844.88 Mobile Safari/537.36"),
    )
    assertEquals("", WebViewShim.chromiumVersionFromUserAgent("14.0.0.370"))
    assertEquals("", WebViewShim.chromiumVersionFromUserAgent("Mozilla/5.0 VendorWebView/14.0.0.370"))
    assertEquals("unknown", WebViewShim.syntaxFloorStatus(WebViewShim.chromiumVersionFromUserAgent("14.0.0.370"), 94))
    assertEquals("unknown", WebViewShim.syntaxFloorStatus("", 94))
    assertEquals("false", WebViewShim.syntaxFloorStatus("93.0.4577.82", 94))
    assertEquals("true", WebViewShim.syntaxFloorStatus("99.0.4844.88", 94))
  }

  // ── 单面真源契约 ────────────────────────────────────────────────────

  @Test
  fun providerReadbackLivesOnlyInTheShim() {
    val files = filesContaining("getCurrentWebViewPackage")
    assertEquals(
      "provider 回读必须只有 WebViewShim 一份实现（历史：三处副本、哨兵不一致）",
      listOf("WebViewShim.kt"),
      files,
    )
  }

  @Test
  fun versionGatedSettingsLiveOnlyInTheShim() {
    for (token in listOf("setForceDark", "setAlgorithmicDarkeningAllowed", "setOffscreenPreRaster", "safeBrowsingEnabled")) {
      val files = filesContaining(token)
      assertEquals(
        "版本敏感设置 $token 必须只出现在 WebViewShim.kt（重复即漂移源）",
        listOf("WebViewShim.kt"),
        files,
      )
    }
  }

  @Test
  fun allDynamicPageWebViewsGoThroughTheShim() {
    assertTrue("引擎主页必须吃 baseline", codeOnly(source("MainActivity.kt")).contains("WebViewShim.applyBaseline"))
    assertTrue("控制台必须吃 baseline", codeOnly(source("ConsoleActivity.kt")).contains("WebViewShim.applyBaseline"))
    val browser = codeOnly(source("BrowserHost.kt"))
    assertTrue("隔离浏览器必须叠加 isolation 档", browser.contains("WebViewShim.applyIsolation"))
    assertTrue("隔离浏览器必须先吃 baseline", browser.contains("WebViewShim.applyBaseline"))
    assertTrue("特性门必须走 shim", browser.contains("WebViewShim.supports("))
  }

  @Test
  fun authoredEngineThemeDisablesAlgorithmicRecoloringWithoutChangingExternalPages() {
    val main = codeOnly(source("MainActivity.kt"))
    val shim = codeOnly(source("WebViewShim.kt"))
    assertTrue("引擎 UI 必须声明主题归自己管理", main.contains("WebViewShim.applyBaseline(webView.settings, appOwnsTheme = true)"))
    assertTrue("外部页面默认继续允许算法深色", shim.contains("appOwnsTheme: Boolean = false"))
    assertTrue("新版 provider 必须按主题所有权关闭算法深色", shim.contains("setAlgorithmicDarkeningAllowed(s, !appOwnsTheme)"))
    assertTrue("旧版 provider 必须在引擎 UI 上关闭 Force Dark", shim.contains("if (appOwnsTheme) WebSettingsCompat.FORCE_DARK_OFF else WebSettingsCompat.FORCE_DARK_AUTO"))
    assertTrue("隔离浏览器仍用默认策略", codeOnly(source("BrowserHost.kt")).contains("WebViewShim.applyBaseline(this)"))
  }

  @Test
  fun diagnosticsReadTheProviderThroughTheShim() {
    val engine = codeOnly(source("EngineManager.kt"))
    assertTrue("info.txt 的版本字段必须经 shim 取值", engine.contains("WebViewShim.providerVersionName()"))
    assertTrue("MainActivity 版本回读必须经 shim", codeOnly(source("MainActivity.kt")).contains("WebViewShim.provider"))
  }

  @Test
  fun shimKeepsBothDarkModeAndSafeBrowsing() {
    val shim = codeOnly(source("WebViewShim.kt"))
    assertTrue("深色跟随必须保留在 shim 内", shim.contains("FORCE_DARK_AUTO"))
    assertTrue("safe browsing 必须在隔离档里", shim.contains("safeBrowsingEnabled = true"))
    assertTrue("baseline 必须保留 NO_CACHE 语义", shim.contains("LOAD_NO_CACHE"))
    assertTrue("baseline 必须保留混合内容拒绝", shim.contains("MIXED_CONTENT_NEVER_ALLOW"))
  }

  @Test
  fun darkFollowIsProviderGatedNotSdkGated() {
    val shim = codeOnly(source("WebViewShim.kt"))
    // 低版本兼容的核心承诺：深色跟随按 **provider 能力** 判（WebSettingsCompat +
    // WebViewFeature 门），不再按 SDK_INT 硬切——API 26–28 的新内核也能跟随。
    assertFalse("shim 内不得再有 SDK_INT 版本硬门", shim.contains("VERSION.SDK_INT"))
    assertTrue(shim.contains("WebSettingsCompat.setForceDark"))
    assertTrue(shim.contains("WebSettingsCompat.setAlgorithmicDarkeningAllowed"))
    val algo = shim.indexOf("WebViewFeature.ALGORITHMIC_DARKENING")
    val force = shim.indexOf("WebViewFeature.FORCE_DARK")
    assertTrue("ALGORITHMIC_DARKENING 必须先于 FORCE_DARK（新路径优先）", algo >= 0 && force > algo)
    // 每一路都必须先过 supports() 门再调 setter（否则旧 provider 上 UnsupportedOperationException）。
    assertTrue(shim.contains("supports(WebViewFeature.ALGORITHMIC_DARKENING)"))
    assertTrue(shim.contains("supports(WebViewFeature.FORCE_DARK)"))
  }

  @Test
  fun offscreenPrerasterIsFeatureGated() {
    val shim = codeOnly(source("WebViewShim.kt"))
    // OFF_SCREEN_PRERASTER 为旧内核/低端机的滚动流畅度档位；setter 在未支持 provider 上会抛，
    // 必须先过 supports() 门。
    val gate = shim.indexOf("supports(WebViewFeature.OFF_SCREEN_PRERASTER)")
    val call = shim.indexOf("WebSettingsCompat.setOffscreenPreRaster")
    assertTrue("离屏预光栅必须先判特性再调 setter", gate >= 0 && call > gate)
    assertTrue("必须挂在 baseline 档", shim.indexOf("applyOffscreenPreraster(s)") < shim.indexOf("applyIsolation"))
  }

  @Test
  fun providerAvailabilitySurfacesInDiagnostics() {
    val shim = codeOnly(source("WebViewShim.kt"))
    assertTrue("provider 在场性必须是显式谓词", shim.contains("fun providerAvailable()"))
    val field = "webview_provider_available"
    assertTrue("boot-diag 必须写 provider 在场性", codeOnly(source("MainActivity.kt")).contains(field))
    assertTrue("诊断包必须写 provider 在场性（与 boot-diag 字段名逐字一致）", codeOnly(source("EngineManager.kt")).contains(field))
    // 缺席路径要能走到：MainActivity 构造 WebView 不得裸抛（无 GMS/裁剪 ROM 上点开即崩）。
    val activity = codeOnly(source("MainActivity.kt"))
    assertTrue("构造失败必须落诊断", activity.contains("\"webview-construct\""))
    assertTrue("构造失败必须有用户可见告知", activity.contains("ds_webview_provider_missing"))
  }

  @Test
  fun pageLevelZoomIsPinnedOffOnEveryBaselineSurface() {
    // 「放大图片会放大整个屏幕」的根因：页面级缩放**从来没人关过**，不是有人打开了它。
    // setSupportZoom 的平台默认是 true，setBuiltInZoomControls 默认 false 并不挡住视觉视口
    // 捏合（设备实测：visualViewport.scale 1→5、width 450→90，html/body 的 zoom 与 transform
    // 全不变）。三行必须成组出现：少 builtInZoomControls 就留下捏合通路，少 supportZoom
    // 就留下能力面，displayZoomControls 则钉死厂商 ROM 可能放回来的 +/- 浮层。
    val shim = codeOnly(source("WebViewShim.kt"))
    assertTrue("baseline 必须显式关掉缩放能力", shim.contains("setSupportZoom(false)"))
    assertTrue("baseline 必须关掉捏合手势通路", shim.contains("builtInZoomControls = false"))
    assertTrue("baseline 必须关掉缩放浮层控件", shim.contains("displayZoomControls = false"))
    // 三条都必须落在 baseline 档内（在 applyIsolation 之前），否则引擎主页拿不到。
    val isolation = shim.indexOf("fun applyIsolation")
    for (token in listOf("setSupportZoom(false)", "builtInZoomControls = false", "displayZoomControls = false")) {
      val at = shim.indexOf(token)
      assertTrue("$token 必须在 applyBaseline 内（applyIsolation 之前）", at >= 0 && at < isolation)
    }
    // 页面级缩放一旦重开，lightbox 的手势就会重新落到整屏上——这是那条 bug 的复现条件，
    // 所以「谁能打开它」必须同样只有这一处（与其它版本敏感面同一条铁律）。
    assertEquals(
      "页面级缩放只允许在 WebViewShim.kt 里出现（重复即漂移源）",
      listOf("WebViewShim.kt"),
      filesContaining("setSupportZoom"),
    )
  }

  @Test
  fun localDocsStaysOffTheBaseline() {
    // 静态文档面刻意关 JS、最小能力：统一进 baseline 反而放大攻击面（shim KDoc 已声明此边界）。
    val docs = codeOnly(source("LocalDocs.kt"))
    assertTrue("LocalDocs 必须保持 JS 关闭", docs.contains("javaScriptEnabled = false"))
    assertFalse("LocalDocs 不得吃 baseline（baseline 会开 JS）", docs.contains("applyBaseline"))
  }
}
