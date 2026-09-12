package com.dsharnessmobile.shell

import android.webkit.JavascriptInterface
import android.util.Log

/**
 * 系统返回策略的纯逻辑面（计划 §5.1 方案 1；源诊断 §6）。
 *
 * 拆分理由：handleOnBackPressed() 必须**同步**决定是否消费，而这条判定只有三个输入
 * （跨文档历史 / 页面层栈缓存 / 都没有），把它抽成不依赖 Android 框架的纯函数后即可用
 * JVM 单测覆盖三个分支（BackGateTest），MainActivity 只保留接线与副作用。
 *
 * 硬约束（文档已核实，违反即返工）：
 * - 不得在返回回调里 evaluateJavascript 现问页面（异步 API；判定必须同步）；
 * - 跨文档历史优先于页面层栈（canGoBack() 不认 same-document 条目，故它只能当历史腿）；
 * - 层穷尽后才允许 finish；「观测不到/关不掉的层」一律消费，不得误退应用。
 */
enum class BackDecision {
  /** 浏览器历史可退（跨文档）：交给 WebView.goBack()。 */
  GO_BACK_HISTORY,

  /** 页面层栈非空：JS 侧执行关闭，壳侧消费本次返回。 */
  DISPATCH_PAGE_STACK,

  /** 无历史、无层：交回 Activity 默认行为（finish）。 */
  FINISH_ACTIVITY,
}

/** 返回决策与两条页面脚本契约。 */
object BackGate {
  /** 返回策略日志标签（设备侧断言 adb logcat -d | grep dsh-back）。 */
  const val TAG: String = "dsh-back"

  /**
   * 页面层栈入口脚本（JS 侧 window.__dshBack() 关最上层并返回是否命中）。
   * && 短路保证通道缺席时求值为 undefined 而不抛错。
   */
  const val DISPATCH_SCRIPT: String = "window.__dshBack && window.__dshBack()"

  /**
   * 页面层数回读脚本（onPageFinished 拉平缓存；|0 让 undefined/null 归零）。
   * 返回数字，evaluateJavascript 结果按 JSON 文本解析见 parseDepth。
   */
  const val READ_DEPTH_SCRIPT: String = "window.__dshBackDepth|0"

  /**
   * 三输入判定（单一职责：只回答「这次返回该走哪条腿」）。
   * @param canGoBack - WebView.canGoBack()，只代表跨文档历史。
   * @param pageStackAvailable - 页面通过桥主动推送的「层栈非空」同步缓存。
   * @returns 本次返回的处理分支。
   */
  fun decide(canGoBack: Boolean, pageStackAvailable: Boolean): BackDecision = when {
    canGoBack -> BackDecision.GO_BACK_HISTORY
    pageStackAvailable -> BackDecision.DISPATCH_PAGE_STACK
    else -> BackDecision.FINISH_ACTIVITY
  }

  /**
   * 本次返回是否被应用消费（消费 = 不退到桌面）。
   * @param decision - decide 的结果。
   * @returns true 表示消费（历史回退或页面层栈），false 表示必须 finish。
   */
  fun consumed(decision: BackDecision): Boolean = decision != BackDecision.FINISH_ACTIVITY

  /**
   * 解析 evaluateJavascript 的层数回读结果。
   * @param raw - JSON 文本（"2" / null / 空串 / 任意非数字）。
   * @returns 非负层数；无法解析一律 0（缓存宁可退回「无层」，与「观测不到不消费」同向）。
   */
  fun parseDepth(raw: String?): Int {
    val text = raw?.trim()?.trim('"') ?: return 0
    return text.toIntOrNull()?.coerceAtLeast(0) ?: 0
  }
}

/**
 * 页面层栈信号缓存（页面 → 壳，同步）。
 *
 * 写入方是 addJavascriptInterface 的 JavaBridge 线程，读取方是 UI 线程上的返回回调，
 * 因此两个字段都是 @Volatile；本类不持有任何视图引用，避免跨线程触碰 UI。
 */
class BackGateState {
  /** 「页面层栈非空」的同步缓存；返回回调只读它，绝不等待页面。 */
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

