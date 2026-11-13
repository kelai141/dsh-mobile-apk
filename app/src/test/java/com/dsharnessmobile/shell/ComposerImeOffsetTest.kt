package com.dsharnessmobile.shell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ComposerImeOffset：注入脚本的契约。
 *
 * 判据盯的是几何关系本身——真机缺陷就是卡片底边没有落到 `innerHeight - ime` 上，
 * 所以断言查「脚本里有没有这条对齐」，而不是查文案。
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
    assertTrue(script.contains("(window.innerHeight||0)-kb"))
    assertTrue(script.contains("r.bottom-t"))
  }

  @Test fun theImeHeightIsSubstitutedVerbatim() {
    assertTrue(ComposerImeOffset.script(351).contains("var kb=351;"))
    assertTrue(ComposerImeOffset.script(298).contains("var kb=298;"))
  }

  @Test fun previousOffsetIsClearedBeforeMeasuring() {
    val script = ComposerImeOffset.script(351)
    val clear = script.indexOf("removeProperty('transform')")
    val measure = script.indexOf("getBoundingClientRect")
    assertTrue(clear >= 0 && measure >= 0 && clear < measure)
  }

  @Test fun hiddenKeyboardClearsTheOffsetBeforeReturning() {
    val script = ComposerImeOffset.script(0)
    assertTrue(script.contains("var kb=0;"))
    assertTrue(script.contains("removeProperty('transform')"))
    // 位移那段代码在字符串里恒存在，能不能执行由提前返回决定——所以判据是顺序，不是存在性。
    assertTrue(
      "零值必须在设位移之前返回",
      script.indexOf("if(kb<=0)return;") in 0 until script.indexOf("translateY"),
    )
  }

  @Test fun negativeImeIsTreatedAsHidden() {
    assertTrue(ComposerImeOffset.script(-12).contains("var kb=0;"))
  }

  @Test fun scriptIsASelfContainedIife() {
    val script = ComposerImeOffset.script(351)
    assertTrue(script.startsWith("(function(){"))
    assertTrue(script.endsWith("})()"))
    assertFalse("模板插值不得残留到脚本里", script.contains('$'))
  }
}
