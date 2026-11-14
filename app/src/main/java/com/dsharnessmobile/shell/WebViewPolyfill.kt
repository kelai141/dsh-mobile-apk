package com.dsharnessmobile.shell

/**
 * 系统 WebView 内核能力垫片（document-start 注入）。
 *
 * 为什么需要它：壳侧不随应用打包 WebView，用的是设备上的系统内核。本仓实测的 MuMu 模拟器是
 * WebView 110.0.5481.154，而引擎页面用了 Chrome 120 才提供的 `URL.canParse`。缺这个静态方法时
 * 页面在模块求值阶段就抛 TypeError，整块 entry 挂掉 —— 用户看到的是「引擎离线」，
 * 但引擎进程其实活着、端口也在监听，真实故障点在浏览器内核能力缺失。
 *
 * 定案证据（设备 logcat，source=console-error）：
 * ```
 * TypeError: URL.canParse is not a function
 *   at http://127.0.0.1:<port>/assets/index-*.js
 * slot entry crashed in 'conversation.chat.node'
 * webview_version=110.0.5481.154
 * ```
 *
 * 三条纪律：
 *  1. **只补缺失，不覆盖**：内核自带时一律不动（原生实现比这里快，也更全）；
 *  2. **不改 `URL` 的其它行为**：只挂两个静态方法，构造器、实例属性、静态白名单全部保持原样；
 *  3. **失败不抛出**：这段脚本在 document-start 跑，任何异常都会连带打断其它注入，
 *     因此整体包在 try 里，补不上就静默放弃（页面会自己报错，不会被这段代码掩盖）。
 */
internal object WebViewPolyfill {

  internal const val TAG: String = "dsh-polyfill"

  /**
   * 需要探测能力的 URL 静态方法名，供自检与 verify 脚本共用同一份清单。
   *
   * 与 [SCRIPT] 保持同步：这里多一项、那里少一项会让「自检说补上了、实际页面还是崩」。
   */
  internal val REQUIRED_URL_STATICS: List<String> = listOf("canParse", "parse")

  /**
   * document-start 垫片脚本。
   *
   * `URL.parse` 与 `URL.canParse` 是同一批进 Chrome 的（canParse 119、parse 126 前后），
   * 缺失往往成对出现，所以一起补：只补 canParse 时页面换个调用点又崩。
   *
   * 语义严格对齐规范：
   * - `canParse(input, base)` 只在**能构造**时返回 true，构造抛错即 false，不吞其它异常；
   * - `parse(input, base)` 能构造返回 URL 实例，否则返回 null（规范如此，不抛）。
   */
  internal val SCRIPT: String =
    "(function(){" +
      "try{" +
      "var U=window.URL;" +
      // 内核连 URL 都没有时无从补起：直接退出，让页面按原样失败，不制造半成品。
      "if(!U)return;" +
      "if(typeof U.canParse!=='function'){" +
      "U.canParse=function(input,base){" +
      "try{new U(input,base);return true}catch(e){return false}" +
      "};" +
      "}" +
      "if(typeof U.parse!=='function'){" +
      "U.parse=function(input,base){" +
      "try{return new U(input,base)}catch(e){return null}" +
      "};" +
      "}" +
      "}catch(e){}" +
      "})();"

  /**
   * 自检表达式：返回缺失的能力名列表（空数组 = 全部可用）。
   *
   * 为什么返回列表而不是布尔：verify 脚本要能在失败时报出「到底缺哪个」，
   * 只给 false 会让排查回到「页面崩了但不知道为什么」。
   */
  internal fun probeScript(names: List<String> = REQUIRED_URL_STATICS): String {
    val quoted = names.joinToString(",") { "'" + it.replace("\\", "\\\\").replace("'", "\\'") + "'" }
    return "(function(){var miss=[];var ns=[" + quoted + "];" +
      "for(var i=0;i<ns.length;i++){" +
      "if(!window.URL||typeof window.URL[ns[i]]!=='function')miss.push(ns[i]);" +
      "}return miss})()"
  }
}
