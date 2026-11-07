package com.dsharnessmobile.shell

import android.net.Uri

/**
 * 订阅登录回跳链接的判据（0.14.11）。
 *
 * 缺陷形态（真机 2026-11-07）：OAuth 回调页把用户送回应用时用的是
 * `intent://oauth-return#Intent;scheme=com.dsharnessmobile.shell;package=…`，
 * 而 manifest 当时没有任何自定义 scheme —— 系统只能弹「打开方式」，列表里只有钉钉/Edge。
 *
 * 判据只认「scheme + host 完全相等」，不看路径与查询串：URI 不携带 code/state，
 * 授权码的兑换只在引擎侧的回调服务里发生。任何更宽的匹配（例如只比 scheme）都会让
 * 任意页面构造的链接冒充登录回跳。
 */
internal object OAuthReturnLink {
  /** 与 AndroidManifest 里 intent-filter 的 scheme 逐字一致。 */
  const val SCHEME = "com.dsharnessmobile.shell"

  /** host 段：`oauth-return`，语义是「授权页已收到回调」。 */
  const val HOST = "oauth-return"

  /**
   * @param uri 来件 URI。
   * @returns true 表示这是本应用的登录回跳链接。
   */
  fun matches(uri: Uri?): Boolean {
    if (uri == null) return false
    return uri.scheme.equals(SCHEME, ignoreCase = true) && uri.host.equals(HOST, ignoreCase = true)
  }
}
