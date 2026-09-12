/**
 * 浏览器档位判定（P0 探针的可执行化）。
 *
 * 判定规则来自 docs/SIDEBAR-BROWSER-PLAN-2026-09-12.md §3.3.1/§3.4/§5.2 与
 * docs/IMPLEMENTATION-ACCEPTANCE-PLAN-2026-09-12.md §4.5；
 * 默认事实来自 .deploy-tmp/iter-0140/browser-p0.md 的设备实测（MuMu x86_64 / WebView 110）。
 *
 * 设计原则：
 *  - **能力未知一律按不支持处理**（fail-safe）：不因为"可能支持"就上报高能力档；
 *  - 每条判定都留下 reason（可审计、可回归），降级项单独进 degradedNotes；
 *  - 纯函数：不读环境、不读时钟，便于离线单测。
 */

/** 判定输入（壳侧/页面侧上报的设备事实；未知用 undefined）。 */
export interface BrowserFacts {
  /** 系统 WebView 主版本（决定 UA-CH 等门槛；116 起有 UA-CH）。 */
  webviewMajor?: number
  /** 页面侧 navigator.userAgentData 是否存在。 */
  uaChAvailable?: boolean
  /** androidx.webkit 依赖已编入 apk（与"能力门是否通过"是两件事：AAR 内含 WebSettingsNoOpAdapter）。 */
  androidxWebkitCompiled?: boolean
  /** androidx.webkit 已编入且 WebViewFeature.USER_AGENT_METADATA 能力门通过。 */
  androidxWebkitAvailable?: boolean
  /** 壳侧可用 applyOverrideConfiguration 覆写 density=1.0（S2b 前提）。 */
  densityOverrideSupported?: boolean
  /** 工位 WebView（BrowserHost）在场。 */
  browserWebViewAvailable?: boolean
  /** 完全访问·调试档（CDP）是否开启。 */
  cdpEnabled?: boolean
  /** 设备物理屏与密度（内存口径用）。 */
  screenWidth?: number
  screenHeight?: number
  densityDpi?: number
}

export type BrowserTier = 'L1-text' | 'L2-native' | 'L3-cdp-debug'
export type ViewportRoute = 'S1' | 'S2' | 'S2b' | 'S3'
export type IdentityRoute = 'ua-ch' | 'ua-string-only'

export interface BrowserTierReport {
  tier: BrowserTier
  viewportRoute: ViewportRoute
  identityRoute: IdentityRoute
  facts: BrowserFacts
  reasons: string[]
  degradedNotes: string[]
}

/** UA-CH（Client Hints）在 WebView 上的起步版本（方案 §3.5 口径）。 */
export const UA_CH_MIN_WEBVIEW_MAJOR = 116

/**
 * 判定浏览器档位。
 * @param facts - 设备事实；缺省字段按"不支持/未知"处理。
 * @returns 档位 + 视口路线 + 身份路线 + 判定理由 + 降级说明。
 */
export function resolveBrowserTier(facts: BrowserFacts): BrowserTierReport {
  const reasons: string[] = []
  const degradedNotes: string[] = []

  const native = facts.browserWebViewAvailable === true
  const tier: BrowserTier = facts.cdpEnabled === true && native
    ? 'L3-cdp-debug'
    : native
      ? 'L2-native'
      : 'L1-text'
  reasons.push(
    native
      ? (facts.cdpEnabled === true
        ? '工位 WebView 在场且调试档开启：可用 CDP 作为调试档能力面（产品面仍走壳桥 op）'
        : '工位 WebView 在场：产品面走壳桥 op（无 CDP 依赖）')
      : '工位 WebView 未就绪：仅 L1 文本模式（不得声称浏览器可用）',
  )

  let viewportRoute: ViewportRoute
  if (facts.densityOverrideSupported === true) {
    viewportRoute = 'S2b'
    reasons.push('density 覆写可用：S2b（1 CSS px = 1 物理 px，光栅面 = 目标视口）')
  } else if (native) {
    viewportRoute = 'S2'
    reasons.push('density 覆写未证实：退 S2（View 变换，光栅面随 density 放大）')
  } else {
    viewportRoute = 'S1'
    reasons.push('无工位 WebView：仅 S1 兜底（useWideViewPort/initial-scale，不能承担桌面伪装）')
  }
  if (facts.cdpEnabled === true) reasons.push('调试档另可用 S3（CDP setDeviceMetricsOverride，实测可精确控 dpr/screen）')

  let identityRoute: IdentityRoute
  if (facts.uaChAvailable === true && facts.androidxWebkitAvailable === true) {
    identityRoute = 'ua-ch'
    reasons.push('UA-CH 可用且 androidx.webkit 能力门通过：UA 串 + UserAgentMetadata 可自洽')
  } else {
    identityRoute = 'ua-string-only'
    reasons.push('UA-CH 不可用：身份档位只能是 UA 串 + JS 指纹（可被检出）')
    if (facts.webviewMajor !== undefined && facts.webviewMajor < UA_CH_MIN_WEBVIEW_MAJOR) {
      degradedNotes.push('WebView ' + String(facts.webviewMajor) + ' < ' + String(UA_CH_MIN_WEBVIEW_MAJOR) + '：本机无 UA-CH（navigator.userAgentData 不存在）')
    }
    if (facts.androidxWebkitCompiled === true && facts.androidxWebkitAvailable !== true) {
      degradedNotes.push('androidx.webkit 已编入但 WebViewFeature.USER_AGENT_METADATA 能力门未通过 → setUserAgentMetadata 走 no-op 路径')
    } else if (facts.androidxWebkitAvailable !== true) {
      degradedNotes.push('androidx.webkit 未编入或能力门未探测：setUserAgentMetadata 不可用')
    }
  }
  degradedNotes.push('触摸能力（maxTouchPoints/ontouchstart）CDP 关不掉、JS 注入仅兜底：桌面伪装存在天然可检出差异')
  if (facts.densityDpi !== undefined && facts.densityDpi > 160 && viewportRoute === 'S2') {
    const scale = facts.densityDpi / 160
    degradedNotes.push('S2 光栅面放大 ' + String(scale) + ' 倍：1280 px 视口需约 ' + String(Math.round(1280 * scale)) + ' px 宽光栅')
  }

  return {
    tier,
    viewportRoute,
    identityRoute,
    facts,
    reasons,
    degradedNotes,
  }
}

/**
 * 本迭代实测的设备基线（.deploy-tmp/iter-0140/browser-p0.md §1/§3.5）。
 * 只作"壳侧尚未上报 browserCaps 时的兜底读数"，并在报告里显式标注来源，绝不当作能力承诺。
 */
export const MEASURED_DEVICE_BASELINE: BrowserFacts = {
  webviewMajor: 110,
  uaChAvailable: false,
  androidxWebkitCompiled: false,
  androidxWebkitAvailable: false,
  densityOverrideSupported: false,
  browserWebViewAvailable: false,
  cdpEnabled: false,
  screenWidth: 900,
  screenHeight: 1600,
  densityDpi: 320,
}
