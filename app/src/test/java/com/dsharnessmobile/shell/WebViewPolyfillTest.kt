package com.dsharnessmobile.shell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WebViewPolyfill: 垫片脚本的形状与纪律。
 *
 * 为什么测脚本文本而不是跑真 JS：JVM 单测没有浏览器引擎。真正「补上了没有」由设备层
 * CDP/ADB 证明；这里守的是**不破坏内核原生实现**和**探测清单与脚本保持同步**这两件事 ——
 * 它们出错时会静默降级成「页面偶尔崩」，很难从现象反推。
 */
class WebViewPolyfillTest {

  private val script = WebViewPolyfill.SCRIPT

  @Test
  fun polyfillOnlyFillsMissingStaticsInsteadOfOverridingNativeOnes() {
    // 覆盖内核原生实现是错的：原生更快更全，而且在真机上会把好内核改坏。
    assertTrue(script.contains("if(typeof U.canParse!=='function')"))
    assertTrue(script.contains("if(typeof U.parse!=='function')"))
  }

  @Test
  fun canParseReturnsFalseInsteadOfThrowing() {
    // 规范语义：能不能解析只体现在返回值，绝不把 SyntaxError 抛给调用方。
    assertTrue(script.contains("try{new U(input,base);return true}catch(e){return false}"))
  }

  @Test
  fun parseReturnsNullInsteadOfThrowing() {
    assertTrue(script.contains("try{return new U(input,base)}catch(e){return null}"))
  }

  @Test
  fun polyfillNeverThrowsAtDocumentStart() {
    // document-start 里抛异常会连带打断后续注入，必须整体包 try。
    assertTrue(script.startsWith("(function(){"))
    assertTrue(script.contains("}catch(e){}"))
    assertTrue(script.endsWith("})();"))
  }

  @Test
  fun missingUrlObjectIsTreatedAsNothingToPatch() {
    // 内核连 URL 都没有时补不出半成品，应直接退出而不是挂一堆假方法。
    assertTrue(script.contains("if(!U)return;"))
  }

  @Test
  fun probeListMatchesPatchedStatics() {
    // 自检清单和脚本必须同源：清单多一项会让 verify 报假失败，少一项会漏掉真实缺口。
    for (name in WebViewPolyfill.REQUIRED_URL_STATICS) {
      assertTrue("script must patch " + name, script.contains("typeof U." + name + "!=='function'"))
      assertTrue("probe must check " + name, WebViewPolyfill.probeScript().contains("'" + name + "'"))
    }
  }

  @Test
  fun probeReportsMissingNamesRatherThanBoolean() {
    // 只给布尔会让排查回到「页面崩了但不知道缺哪个」。
    val probe = WebViewPolyfill.probeScript()
    assertTrue(probe.contains("var miss=[]"))
    assertTrue(probe.contains("miss.push("))
    assertFalse(probe.contains("return true"))
  }

  @Test
  fun probeQuotesEveryName() {
    val probe = WebViewPolyfill.probeScript(listOf("canParse"))
    assertTrue(probe.contains("['canParse']"))
  }
}
