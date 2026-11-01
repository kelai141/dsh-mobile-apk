package com.dsharnessmobile.shell

/**
 * 内置浏览器的隔离档位（旧 WebView 兼容架构线，spike 记录见
 * docs/BROWSER-COMPAT-SPIKE-2026-10-24.md）。
 *
 * 档位语义：
 *  - [PROFILE_API]    androidx WebView Profile（MULTI_PROFILE，要求 WebView 提供方 114+），
 *                     会话级隔离（每会话独立浏览器档案）；
 *  - [PROCESS_SUFFIX] 独立 :browser 进程 + setDataDirectorySuffix + SurfaceControlViewHost
 *                     投影（API 29+），全 app 共享一个浏览器档案，但与引擎 cookie/存储
 *                     完全隔离（不同进程 + 不同数据目录）；
 *  - [UNAVAILABLE]    无隔离手段可用，fail-closed（绝不降级共享 Default 档案）。
 *
 * 档位优先级：PROFILE_API 优先；PROCESS_SUFFIX 仅在 MULTI_PROFILE 缺位且兼容渲染器
 * 就绪时兜底。
 *
 * 语义边界（本 PR）：档位只回答「隔离手段有没有」。浏览器本身能不能用是另一个事实，
 * 由 [BrowserStatusSemantics] 单独派生；隔离不可用不再自动等于浏览器不可用。
 */
enum class BrowserIsolationTier(val wire: String) {
  PROFILE_API("profile-api"),
  PROCESS_SUFFIX("process-suffix"),
  UNAVAILABLE("unavailable"),
}

/** 档位解析器。谓词可注入，JVM 单测不依赖 WebViewFeature 运行态。 */
class BrowserIsolation(
  private val multiProfileSupported: () -> Boolean,
  private val processSuffixSupported: () -> Boolean = { false },
) {

  fun tier(): BrowserIsolationTier = when {
    multiProfileSupported() -> BrowserIsolationTier.PROFILE_API
    processSuffixSupported() -> BrowserIsolationTier.PROCESS_SUFFIX
    else -> BrowserIsolationTier.UNAVAILABLE
  }

  companion object {
    /**
     * 生产实例。processSuffix 谓词在兼容渲染器（PR3）落地前恒 false；
     * 届时注入「API>=29 且 :browser 渲染进程可用」的实测探测。
     */
    val DEFAULT = BrowserIsolation(multiProfileSupported = { BrowserHostProfile.supported() })
  }
}

/**
 * 浏览器可用性档位：把「浏览器能不能用」与「身份隔离在不在」拆成两个事实。
 *
 * 为什么必须拆：`browser-profile-not-ready` 只说明**没有拿到隔离 profile**，不代表页面打不开。
 * 回退到单一身份档时页面仍可正常浏览；把它当 ERROR 会让界面报「浏览器不可用」，
 * 而用户看到的分明是能转屏、能开网站。只有浏览器本体确实建不起来（provider/renderer 故障，
 * 或 `browser-profile-unsupported` 且没有任何可建表面）才保留 ERROR。
 */
internal enum class BrowserStatusLevel(val wire: String) {
  OK("ok"),
  NOTICE("notice"),
  ERROR("error"),
}

/** 一次派生的只读状态；wire 字段由 status/caps/reply 三个面共用同一份判据。 */
internal data class BrowserStatus(
  val browserAvailable: Boolean,
  val isolationAvailable: Boolean,
  val profileEstablished: Boolean,
  val profileReason: String,
  val reason: String,
  val level: BrowserStatusLevel,
)

/** 纯函数判据（JVM 单测不依赖 Activity/WebView 运行态）。 */
internal object BrowserStatusSemantics {
  /** 这些原因表示浏览器本体不可用，不只是没隔离。 */
  private val FATAL_BROWSER_REASONS = setOf(
    "webview-provider-unavailable",
    "browser-renderer-unavailable",
  )

  /**
   * @param tier 已解析的隔离档位。
   * @param profileError 工作台 profile 错误码；空串 = 无错误。
   * @param surfacePresent 已有浏览器 view / 远端 tab。
   * @param surfaceCreatable 仍能创建浏览器表面（provider 或兼容渲染进程）。
   * @param profileAttached 已 attach 隔离 profile（或已绑定隔离渲染进程）。
   * @returns 分开的 browserAvailable / isolationAvailable 与唯一电平。
   */
  fun derive(
    tier: BrowserIsolationTier,
    profileError: String,
    surfacePresent: Boolean,
    surfaceCreatable: Boolean,
    profileAttached: Boolean,
  ): BrowserStatus {
    val tierAvailable = tier != BrowserIsolationTier.UNAVAILABLE
    val isolationAvailable = tierAvailable && profileError.isEmpty()
    val isolated = isolationAvailable && profileAttached
    val profileReason = profileError.ifEmpty {
      when {
        isolated -> ""
        !tierAvailable -> "browser-profile-unsupported"
        else -> "browser-profile-not-ready"
      }
    }
    // 该码只有在「连表面都建不出来」时才是浏览器故障；已有 view/可建表面 = 降级路径在工作。
    val unsupportedWithoutFallback =
      profileError == "browser-profile-unsupported" && !surfacePresent && !surfaceCreatable
    val browserAvailable = profileError !in FATAL_BROWSER_REASONS &&
      !unsupportedWithoutFallback &&
      (surfacePresent || surfaceCreatable)
    val reason = if (browserAvailable) "" else profileReason.ifEmpty { "browser-unavailable" }
    val level = when {
      !browserAvailable -> BrowserStatusLevel.ERROR
      !isolationAvailable -> BrowserStatusLevel.NOTICE
      else -> BrowserStatusLevel.OK
    }
    return BrowserStatus(
      browserAvailable = browserAvailable,
      isolationAvailable = isolationAvailable,
      profileEstablished = isolated,
      profileReason = profileReason,
      reason = reason,
      level = level,
    )
  }
}
