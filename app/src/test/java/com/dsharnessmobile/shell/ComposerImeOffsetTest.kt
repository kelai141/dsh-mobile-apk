package com.dsharnessmobile.shell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ComposerImeOffset：注入脚本的契约。
 *
 * 判据盯的是几何关系与**两个方向的不对称**——真机缺陷有两层：卡片底边没落到
 * `innerHeight - ime` 上（抬不起来），以及收起时等 insets 导致慢半拍（粘滞）。
 * 所以断言查两件事：对齐算法，和 focusout 那条立即回落的挂载。
 */
class ComposerImeOffsetTest {
  @Test fun targetsComposerCardBeforeTheDockFallback() {
    val script = ComposerImeOffset.script(351)
    val card = script.indexOf(ComposerImeOffset.CARD_SELECTOR)
    val dock = script.indexOf(ComposerImeOffset.DOCK_SELECTOR)
    assertTrue(card >= 0 && dock >= 0 && card < dock)
  }

  @Test fun bottomIsAlignedToTheKeyboardTop() {
    val script = ComposerImeOffset.script(351)
    assertTrue(script.contains("getBoundingClientRect"))
    assertTrue(script.contains("(window.innerHeight||0)-v"))
    assertTrue(script.contains("r.bottom-"))
  }

  @Test fun theImeHeightIsSubstitutedVerbatim() {
    assertTrue(ComposerImeOffset.script(351).contains("api.set(351)"))
    assertTrue(ComposerImeOffset.script(298).contains("api.set(298)"))
  }

  @Test fun previousOffsetIsClearedBeforeMeasuring() {
    val script = ComposerImeOffset.script(351)
    val clear = script.indexOf("removeProperty('transform')")
    val measure = script.indexOf("getBoundingClientRect")
    assertTrue(clear >= 0 && measure >= 0 && clear < measure)
  }

  @Test fun hiddenKeyboardClearsTheOffsetBeforeReturning() {
    val script = ComposerImeOffset.script(0)
    assertTrue(script.contains("api.set(0)"))
    // 位移那段代码在字符串里恒存在，能不能执行由提前返回决定——所以判据是顺序。
    assertTrue(
      "零值必须在设位移之前返回",
      script.indexOf("if(v<=0)return;") in 0 until script.indexOf("translateY"),
    )
  }

  @Test fun negativeImeIsTreatedAsHidden() {
    assertTrue(ComposerImeOffset.script(-12).contains("api.set(0)"))
  }

  @Test fun installIsGuardedSoListenersAreRegisteredOnce() {
    val script = ComposerImeOffset.script(351)
    assertTrue("安装必须挂在全局 API 名下", script.contains(ComposerImeOffset.API_NAME))
    assertTrue("重复注入不得重复注册监听器", script.contains("if(!api){"))
  }

  @Test fun focusOutCollapsesWithoutWaitingForInsets() {
    val script = ComposerImeOffset.script(351)
    assertTrue("收起方向靠 focusout 立即回落", script.contains("addEventListener('focusout'"))
    // 必须在安装块里（常驻），而不是绑在单次位移上
    assertTrue(
      script.indexOf("addEventListener('focusout'") in
        script.indexOf("if(!api){") until script.indexOf("api.set("),
    )
  }

  @Test fun riseIsSmoothedButCollapseIsInstant() {
    val script = ComposerImeOffset.script(351)
    // 位移必须瞬时到位：系统原生 App 的输入框就是直接贴在键盘上沿，没有过渡动画。
    assertTrue("不得引入过渡动画", !script.contains("cubic-bezier") && !script.contains("transition='transform"))
    assertTrue("清位移前必须显式关掉过渡", script.contains("c.style.transition='none'"))
  }

  @Test fun clearingAlwaysKillsTransition() {
    val script = ComposerImeOffset.script(0)
    assertTrue(script.contains("c.style.transition='none'"))
    assertTrue("任何方向都不得开过渡", !script.contains("cubic-bezier"))
  }

  @Test fun scriptIsASelfContainedIife() {
    val script = ComposerImeOffset.script(351)
    assertTrue(script.startsWith("(function(){"))
    assertTrue(script.endsWith("})()"))
    assertFalse("模板插值不得残留到脚本里", script.contains('$'))
  }
}
