package com.dsharnessmobile.shell

import android.util.Log
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * 桥帧来源守卫（issue #686）：只让「顶层帧 + origin 在白名单内」的文档拿到 window.androidBridge。
 *
 * 为什么需要它
 * ------------
 * WebView.addJavascriptInterface 是**整 WebView 级**注入：Android 把同一个对象暴露给该 WebView
 * 里的**每一个 frame**，没有按帧注入的粒度。而 @JavascriptInterface 方法的签名里不携带任何
 * 「调用者帧」信息——Java 侧拿不到发起调用的 frame 的 URL 或 origin。因此判据**只能**落在 JS 侧：
 * 由每个文档自己读 location.origin 与「是否为顶层帧」来决定桥是否可见。
 *
 * 设备实测（emulator-5558 / WebView 110.0.5481.154.1 / Android 15）佐证了这个缺口：
 * 一个 sandbox="allow-scripts" 的子帧（location.origin === "null"，与主帧真正跨源）
 * 可以 Object.keys(window.androidBridge).length === 80、成功调用 a11yStatus()，
 * 并通过 getPickToken() 拿到真实 token 值。
 *
 * 判据为什么是「顶层帧 + origin 白名单（白名单允许 opaque）」
 * -----------------------------------------------------
 * 只比对 origin 字面量会误封主帧：实测主文档在某些阶段 location.origin === "null"
 * （不透明上下文），写死 http://127.0.0.1:<port> 会把合法主帧的桥一起封掉。
 * 只判顶层帧又会误封同源子帧（HTML artifact 预览要用桥）。因此取「或」：
 *   - window.top === window（顶层帧）→ 放行，与 origin 无关，兜住主帧的 "null" 期；
 *   - 否则 location.origin 必须命中白名单（显式含 "null"，兜住同源 artifact 帧）。
 * 跨源 / opaque 子帧两条都不满足 → 封死。
 *
 * 为什么是「零新增全局」
 * ------------------
 * 守卫**不搬移、不代理、不挂新入口**：放行帧完全不动原生 window.androidBridge；
 * 只有非放行帧执行 delete + 不可重定义的 defineProperty(undefined)。
 * 因此没有可枚举的代理对象供子帧摸到——这比「新入口挂 symbol」更小的篡改面。
 *
 * 拆解条件
 * ------
 * 上游若让 addJavascriptInterface 具备按帧粒度，或本仓改为「主帧与子帧分 WebView」，
 * 本文件即整体删除。
 */
internal object BridgeOriginGuard {

    private const val TAG = "dsh-bridge-guard"

    /**
     * 生成 document-start 守卫脚本。
     *
     * @param engineOrigins 允许持有桥的 origin 白名单；至少包含当前引擎 origin
     *   （http://127.0.0.1:<引擎端口>）。端口是运行期确定的（引擎每次启动可能换端口），
     *   所以**不写死字面量**，由调用方按 EngineEndpoint 现值拼入。
     */
    fun script(engineOrigins: Collection<String>): String {
        val originsJson = engineOrigins
            .filter { it.isNotBlank() }
            .joinToString(separator = ",", prefix = "[", postfix = "]") { "\"" + escapeJs(it) + "\"" }
        val sb = StringBuilder()
        sb.append("(function () {\n")
        sb.append("  var ALLOWED = ").append(originsJson).append(";\n")
        // 诊断 canary：未来任何人都能在设备上复核这一层是否生效、以及当刻的判据取值。
        // 落在 <html data-dsh-bridge-guard='{...}'> 上（不是全局变量——条件 5 要求零新增全局）。
        sb.append("  var C = { supported: true, atStart: typeof window.androidBridge,\n")
        sb.append("            top: null, origin: null, allowed: null, applied: null, after: null };\n")
        sb.append("  try {\n")
        sb.append("    var isTop = window.top === window;\n")
        sb.append("    var origin = location.origin;\n")
        sb.append("    var listed = ALLOWED.indexOf(origin) !== -1;\n")
        // 放行判据：顶层帧（不论 origin，覆盖实测到的「主帧 origin 为 null」）
        //           或 origin 命中真实引擎白名单（覆盖同源 iframe，如 HTML artifact 预览）。
        // 刻意**不**把 origin === 'null' 列为放行条件：sandbox 攻击帧的 location.origin
        // 恰是 'null'，列进来等于放行整类攻击帧。主帧的 null 期已由 isTop 兜住。
        sb.append("    var allowed = isTop || listed;\n")
        sb.append("    C.top = isTop; C.origin = origin; C.allowed = allowed;\n")
        sb.append("    if (allowed) {\n")
        sb.append("      C.applied = 'allowed';\n")
        sb.append("    } else {\n")
        sb.append("      C.applied = 'sealed';\n")
        sb.append("      try { delete window.androidBridge; } catch (e) {}\n")
        sb.append("      try {\n")
        sb.append("        Object.defineProperty(window, 'androidBridge', {\n")
        sb.append("          value: undefined, writable: false, configurable: false, enumerable: false\n")
        sb.append("        });\n")
        sb.append("      } catch (e) {}\n")
        sb.append("    }\n")
        sb.append("    C.after = typeof window.androidBridge;\n")
        sb.append("  } catch (e) { C.error = String(e); }\n")
        // document-start 时 document.documentElement **尚不存在**（设备实测 hasDocEl:false），
        // 因此 canary 必须等 <html> 出现后再写：先试一次，失败就挂 MutationObserver +
        // readystatechange 兜底，直到写上为止。
        sb.append("  function publish() {\n")
        sb.append("    try {\n")
        sb.append("      var el = document.documentElement;\n")
        sb.append("      if (!el) return false;\n")
        sb.append("      el.setAttribute('data-dsh-bridge-guard', JSON.stringify(C));\n")
        sb.append("      return true;\n")
        sb.append("    } catch (e) { return false; }\n")
        sb.append("  }\n")
        sb.append("  if (!publish()) {\n")
        sb.append("    try {\n")
        sb.append("      var mo = new MutationObserver(function () { if (publish()) mo.disconnect(); });\n")
        sb.append("      mo.observe(document, { childList: true, subtree: true });\n")
        sb.append("      document.addEventListener('readystatechange', function () { publish(); });\n")
        sb.append("    } catch (e) {}\n")
        sb.append("  }\n")
        sb.append("})();\n")
        return sb.toString()
    }
    /** JS 字符串字面量转义：只处理会提前终止字面量的字符，够本用途。 */
    private fun escapeJs(raw: String): String {
        val out = StringBuilder(raw.length + 8)
        for (ch in raw) {
            when (ch) {
                '\\' -> out.append("\\\\")
                '"' -> out.append("\\\"")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '<' -> out.append("\\u003c")
                '>' -> out.append("\\u003e")
                else -> out.append(ch)
            }
        }
        return out.toString()
    }

    /**
     * 安装守卫。document-start 脚本在每个文档创建时、**页面自身脚本之前**运行。
     *
     * 时序依据（本仓代码事实）：装配点在 MainActivity.loadConfirmedEnginePage()（:494）——
     * installBridgeOriginGuard() 在此调用，紧接着才是同一函数内的 webView.loadUrl()（:502/:505）；
     * addJavascriptInterface 更早，在 MainActivity.configureWebView()（:1527）。两者都在 onCreate
     * 主线程串行执行，而文档由 loadUrl 才创建，故任何文档解析时守卫已就位。**不得后移到 loadUrl
     * 之后**：此后创建的文档拿不到 document-start 脚本，第二层形同不存在。
     *
     * @return true 已安装；false 内核不支持（调用方必须发出**可见告警**，不得静默跳过）。
     */
    fun install(webView: WebView, engineOrigins: Collection<String>): Boolean {
        if (!WebViewShim.supports(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            return false
        }
        return try {
            WebViewCompat.addDocumentStartJavaScript(
                webView,
                script(engineOrigins),
                setOf("*"),
            )
            Log.i(TAG, "bridge frame guard installed for " + engineOrigins.size + " origin(s)")
            true
        } catch (t: Throwable) {
            Log.w(TAG, "bridge frame guard could not be installed: " + t.message)
            false
        }
    }
}