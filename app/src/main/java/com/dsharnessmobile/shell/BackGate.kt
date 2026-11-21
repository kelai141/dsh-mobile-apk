package com.dsharnessmobile.shell

import android.webkit.JavascriptInterface
import android.util.Log

/** Native fallback after the visible WebUI has handled the press or reported its root. */
enum class BackDecision {
  CONSUME,
  GO_BACK_HISTORY,
  FINISH_ACTIVITY,
}

object BackGate {
  const val TAG: String = "dsh-back"

  // Old snapshots expose a boolean entry. Re-read their depth in the same JS turn so a
  // failed dismissal protects the Activity without relying on the observer's cached signal.
  const val DISPATCH_SCRIPT: String =
    """(() => {
      if (typeof window.__dshNavigationBack === 'function') return window.__dshNavigationBack('android');
      if (typeof window.__dshBack !== 'function') return 'unavailable';
      const handled = window.__dshBack();
      return handled ? 'handled' : window.__dshBackDepth > 0 ? 'blocked' : 'root';
    })()"""

  const val READ_DEPTH_SCRIPT: String = "window.__dshBackDepth|0"

  fun parseDepth(raw: String?): Int = raw?.trim()?.trim('"')?.toIntOrNull()?.coerceAtLeast(0) ?: 0

  fun decide(canGoBack: Boolean, pageResult: String?, legacyAvailable: Boolean = false): BackDecision =
    when {
      pageResult == "\"root\"" || (pageResult == "\"unavailable\"" && !legacyAvailable) ->
        if (canGoBack) BackDecision.GO_BACK_HISTORY else BackDecision.FINISH_ACTIVITY
      else -> BackDecision.CONSUME
    }
}

/**
 * 页面层栈信号缓存（页面 → 壳，同步）。
 *
 * 写入方是 addJavascriptInterface 的 JavaBridge 线程，读取方是 UI 线程上的返回回调，
 * 因此两个字段都是 @Volatile；本类不持有任何视图引用，避免跨线程触碰 UI。
 */
class BackGateState {
  /** 旧客户端兼容信号，仅在入口缺席时保护已有层。 */
  @Volatile
  var pageStackAvailable: Boolean = false
    private set

  /** 最近一次页面自报的层数（onPageFinished 拉平；用于日志与诊断，不参与判定）。 */
  @Volatile
  var pageStackDepth: Int = 0
    private set

  /**
   * 页面主动推送的层栈信号。
   * @param available - 页面是否还有可退的层。
   */
  fun onSignal(available: Boolean) {
    if (pageStackAvailable == available) return
    pageStackAvailable = available
    if (!available) pageStackDepth = 0
    Log.i(BackGate.TAG, "page stack signal: available=" + available)
  }

  /** 新文档开始加载：上一文档的层栈信号一律作废。 */
  fun onPageStarted() {
    if (!pageStackAvailable && pageStackDepth == 0) return
    pageStackAvailable = false
    pageStackDepth = 0
    Log.i(BackGate.TAG, "page stack reset (page started)")
  }

  /**
   * 页面就绪后拉平缓存（页面插件可能晚于首帧挂载，桥上推的初始信号会漏）。
   * @param depth - 页面自报层数；>0 即视为有层可退。
   */
  fun onPageFinished(depth: Int) {
    val available = depth > 0
    pageStackDepth = depth.coerceAtLeast(0)
    if (pageStackAvailable == available) return
    pageStackAvailable = available
    Log.i(BackGate.TAG, "page stack pulled: available=" + available + " depth=" + depth)
  }
}

/**
 * 页面 → 壳的返回层栈上行接口（window.dshBackBridge）。
 *
 * 独立接口对象：只暴露一个布尔信号的 set/get，授权面比把方法挂进 androidBridge
 * （34 个方法的特权面）更窄；setAvailable 与 getBackAvailable 成对，满足桥面对称性
 * 要求（设备侧状态必须有只读 getter）。
 */
class BackGateBridge(private val state: BackGateState) {
  /**
   * 上行信号：页面层栈是否非空（同步调用，页面在自身层栈变化时推送）。
   * @param available - 层栈非空为 true。
   */
  @JavascriptInterface
  fun setAvailable(available: Boolean) {
    state.onSignal(available)
  }

  /**
   * 只读回读：壳侧缓存的「页面层栈非空」同步布尔（供页面自证与设备侧断言）。
   * @returns 当前缓存的可用性。
   */
  @JavascriptInterface
  fun getBackAvailable(): Boolean = state.pageStackAvailable
}

