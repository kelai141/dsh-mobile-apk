package com.dsharnessmobile.shell

import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

/**
 * WebView 统一 shim：壳侧所有 WebView 的「版本敏感面」唯一入口。
 *
 * 为什么存在：此前同一份版本适配被三个调用点各抄一份且已漂移——
 *  - 内核包回读（getCurrentWebViewPackage + 主版本号正则）在 MainActivity /
 *    BrowserHost / EngineManager 各有一份，且「读不到」的哨兵不一致（0 vs -1）；
 *  - `SDK_INT >= 29 → forceDark` 的深色跟随在 MainActivity / BrowserHost /
 *    ConsoleActivity 里重复三遍，且按系统版本判会把「API 26–28 + 新内核」
 *    这类本可跟随的设备错判成不支持（能力在 provider，不在系统）；
 *  - androidx.webkit 能力门只在 BrowserHost 有一份私有实现。
 * 任何一处改版本策略就要三处同改；漏一处 = 同一台设备上不同壳侧 WebView 行为不一致。
 * 本对象把这些点收成单面真源：provider 回读 / 特性门 / 两档 settings 配置。
 *
 * 设计边界（有意收窄）：
 *  - 不做 WebView 子类或包装类——构造器在某些 ROM 上自身就是故障源
 *    （provider 缺失/升级中），包装层解决不了，只会多一个被怀疑对象；
 *  - [LocalDocs] 的静态文档 WebView **不走** baseline：它刻意关 JS，
 *    是最小能力面，统一进基线反而放大攻击面。
 */
internal object WebViewShim {

  // ── 内核 provider 回读（原三处副本的唯一实现）────────────────────────

  /** 内核包名（如 com.google.android.webview）；读不到回空串（显式未知，不抛）。 */
  fun providerPackageName(): String = try {
    WebView.getCurrentWebViewPackage()?.packageName ?: ""
  } catch (_: Throwable) {
    // provider 正在切换/更新时该调用可抛——回读通路不得成为故障源。
    ""
  }

  /** 内核版本名（形如 "110.0.5481.154.1"）；读不到回空串。 */
  fun providerVersionName(): String = try {
    WebView.getCurrentWebViewPackage()?.versionName ?: ""
  } catch (_: Throwable) {
    ""
  }

  /**
   * WebView provider 是否在场。false 有两种真实情形：设备没有 WebView
   * （无 Google 服务的精简 ROM / AOSP 裁剪机），或 provider 正在升级窗口期
   * （此窗口内 `WebView()` 构造本身会抛）。区分于「版本串解析失败」——
   * 那是 provider 在场但 versionName 异形；两者诊断含义不同。
   */
  fun providerAvailable(): Boolean = providerPackageName().isNotEmpty()

  /**
   * 「首个点分段数字」主版本号解析。**纯函数**（不碰 android.*）：JVM 单测直接跑，
   * UA-CH 等需要「任意版本串 → major」的调用点也复用它；版本串异形或空串一律回 0。
   */
  internal fun majorOf(versionName: String): Int =
    Regex("(\\d+)\\.").find(versionName)?.groupValues?.get(1)?.toIntOrNull() ?: 0

  /**
   * Returns the Chromium build version reported by this WebView's actual User-Agent.
   * Vendor provider package versions (for example Huawei's `14.0.0.370`) are not
   * Chromium versions and must not be compared with Chromium syntax or UA-CH floors.
   */
  internal fun chromiumVersionFromUserAgent(userAgent: String): String =
    Regex("(?:^|\\s)Chrome/([0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+)")
      .find(userAgent)?.groupValues?.get(1).orEmpty()

  /** Three-state result prevents a vendor package version or missing UA from masquerading as a Chromium floor failure. */
  internal fun syntaxFloorStatus(chromiumVersion: String, floorMajor: Int): String {
    val major = majorOf(chromiumVersion)
    return when {
      major <= 0 -> "unknown"
      major >= floorMajor -> "true"
      else -> "false"
    }
  }

  // ── androidx.webkit 能力门 ──────────────────────────────────────────

  /**
   * androidx.webkit 特性门：内核包不支持该特性时回 false（不抛）。
   * 与 SDK_INT 门的区别：它按**当前 WebView provider** 的实际能力判，
   * 而不是按系统版本猜——同一台 API 34 机器装旧内核时后者会误判。
   */
  fun supports(feature: String): Boolean = try {
    WebViewFeature.isFeatureSupported(feature)
  } catch (_: Throwable) {
    false
  }

  // ── settings 配置档 ─────────────────────────────────────────────────

  /**
   * 共享基线档：所有承载动态页面的壳侧 WebView（引擎主页 / 控制台 / 隔离浏览器）
   * 必须一致的最小安全与行为集合，版本差异在本函数内一次消化。
   *
   *  - LOAD_NO_CACHE：杜绝 WebView 命中旧 index/旧 bundle 造成「卡 loading 且
   *    无诊断层」（缓存页里没有页面看门狗；荣耀/MagicUI 实测类问题）。
   *  - mediaPlaybackRequiresUserGesture 显式钉 true：值与平台默认一致，但钉死它
   *    才能免疫厂商 ROM 改默认值的漂移——这正是 shim 存在的理由。
   *  - appOwnsTheme：引擎 UI 通过主题服务自行配色，禁止 WebView 再次算法改色。
   *  - textZoom 故意不设：0.13.3 起持久化退役（D6 收益省略），上游 ui-theme 的
   *    fontSize 原生管内容字号；新增调用点**不要**在本函数外自行加回。
   *  - 页面级缩放三连关（图片放大带整屏）：这是**应用 UI**，不是可阅读的网页文档——
   *    整页缩放会把顶栏/输入区一起放大，用户看到的是「整个屏幕被放大」。
   *    真因不是有人打开了它，而是**从来没人关过**：setSupportZoom 的平台默认是 true，
   *    setBuiltInZoomControls 默认 false 并不挡住视觉视口捏合（MuMu Android 15 /
   *    WebView 110 实测：双指捏合 visualViewport.scale 1→5、width 450→90，而 html/body
   *    的 zoom 与 transform 全不变、各元素 rect 不动）。三行必须一起写：supportZoom 关掉
   *    「缩放能力」本身，builtInZoomControls 关掉捏合手势通路，displayZoomControls 关掉
   *    +/- 浮层（前两者为 false 时它已无效，仍显式钉死，与 mediaPlaybackRequiresUserGesture
   *    同一条「钉死默认值以免疫厂商 ROM 漂移」的理由）。图片自己的缩放在页面内实现
   *    （dsh-client-ui-responsive 的 lightbox 手势），不依赖这个通道。
   */
  fun applyBaseline(s: WebSettings, appOwnsTheme: Boolean = false) {
    s.javaScriptEnabled = true
    s.domStorageEnabled = true
    // file 方案内容访问全关；file:///android_asset 与 /android_res 不受此限，
    // 控制台与本地文档的 assets 加载不受影响。
    s.allowFileAccess = false
    s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    s.cacheMode = WebSettings.LOAD_NO_CACHE
    s.mediaPlaybackRequiresUserGesture = true
    // 页面级缩放全关（见上方函数注释）。三行同源，缺一条就可能被厂商 ROM 的默认值放回来。
    s.setSupportZoom(false)
    s.builtInZoomControls = false
    s.displayZoomControls = false
    applyFollowSystemDark(s, appOwnsTheme)
    applyOffscreenPreraster(s)
  }

  /**
   * 隔离档（在 baseline 之上叠加）：专给 [BrowserHost] 承载**不可信外部页面**的
   * WebView——在基线上再砍掉所有「页面可借力」的能力面。
   */
  fun applyIsolation(s: WebSettings) {
    s.allowContentAccess = false
    @Suppress("DEPRECATION")
    s.allowFileAccessFromFileURLs = false
    @Suppress("DEPRECATION")
    s.allowUniversalAccessFromFileURLs = false
    s.javaScriptCanOpenWindowsAutomatically = false
    s.setSupportMultipleWindows(false)
    s.setGeolocationEnabled(false)
    // 分辨率预设 = CSS 视口：document-start 注入 width=<cssW>
    // （见 BrowserHost.applyDocumentStartScript），overview/wideViewport 让
    // 页面按注入视口排版，而不是按物理窗口。
    s.loadWithOverviewMode = true
    s.useWideViewPort = true
    applySafeBrowsing(s)
  }

  /**
   * 外部页面保留系统算法深色；引擎 UI 自己拥有浅色/深色/跟随系统主题，
   * 必须禁用算法改色，否则系统深色下 CSS 白底会被再次压暗，手动浅色看起来仍是黑色。
   * 引擎的系统偏好由 ThemeBridge 提供，不依赖算法改色。
   *
   * 两层按 **provider 能力**择优，不按 SDK_INT 猜：
   *  1. ALGORITHMIC_DARKENING（webkit 1.5+/API 33 推荐路径）：算法级深色，
   *     语义反转更聪明且与 forceDark 互斥——supported 时只用这一路；
   *  2. FORCE_DARK（旧路径）：WebSettingsCompat 把能力门放在 provider 上，
   *     于是 **API 26–28 + 新内核** 也能跟随（旧实现 `SDK_INT>=29` 直接跳过）；
   *  3. 两路都不支持：provider 过旧，留默认（不假装跟随）。
   */
  private fun applyFollowSystemDark(s: WebSettings, appOwnsTheme: Boolean) {
    // 包一层：provider 更新窗口期内「特性门过、setter 抛」的竞态如实放弃（留默认），
    // 不把一个渲染偏好变成崩溃。
    try {
      when {
        supports(WebViewFeature.ALGORITHMIC_DARKENING) ->
          WebSettingsCompat.setAlgorithmicDarkeningAllowed(s, !appOwnsTheme)
        supports(WebViewFeature.FORCE_DARK) ->
          @Suppress("DEPRECATION")
          WebSettingsCompat.setForceDark(
            s,
            if (appOwnsTheme) WebSettingsCompat.FORCE_DARK_OFF else WebSettingsCompat.FORCE_DARK_AUTO,
          )
      }
    } catch (_: Throwable) {
    }
  }

  /**
   * 离屏预光栅：空闲时预渲染屏外 tile，对**旧内核/低端机**的滚动流畅度
   * 是实测有效的一档（webkit 特性门，provider 不支持即跳过，不抛）。
   */
  private fun applyOffscreenPreraster(s: WebSettings) {
    try {
      if (supports(WebViewFeature.OFF_SCREEN_PRERASTER)) {
        WebSettingsCompat.setOffscreenPreRaster(s, true)
      }
    } catch (_: Throwable) {
    }
  }

  /**
   * Safe Browsing：框架 setter API 26 起提供（= minSdk），但实际能力由 provider
   * 决定，旧内核上是静默 no-op；provider 切换窗口期 setter 可能抛——包一层，
   * 失败如实放弃，不让安全开关的缺失变成崩溃。
   */
  private fun applySafeBrowsing(s: WebSettings) {
    try {
      s.safeBrowsingEnabled = true
    } catch (_: Throwable) {
    }
  }
}
