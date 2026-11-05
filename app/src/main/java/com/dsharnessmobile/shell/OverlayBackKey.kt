package com.dsharnessmobile.shell

import android.view.KeyEvent

/**
 * 面板的返回键判定（issue #1612）。
 *
 * 缺陷形态：面板窗口的 flags 只有 FLAG_NOT_TOUCH_MODAL（= 可聚焦，弹输入法需要），而全仓没有任何
 * KEYCODE_BACK 处理。展开期间 BACK 被派发到这个 overlay 窗口，视图树无人消费，非 Activity 窗口
 * 没有默认回落 ⇒ 事件被丢弃。用户视角是「返回键死了」：既关不掉面板，也退不出后面引擎页面的
 * 子层（BackGate 同样拿不到这次返回），只能去找 ✕。
 *
 * 判定本身抽成纯函数：`KeyEvent` 是 android.view 类型但这里只读两个 int 参数，JVM 单测可直接打
 * 真值表（Android 桩把 KeyEvent 常量打回 0 也不影响——常量是编译期内联，判据比的是「哪一组」）。
 */
internal object OverlayBackKey {

  /**
   * 这次按键是否应该收起面板。
   *
   * 只认 ACTION_UP：与系统语义一致（按下不动作，抬手才结算），也避免长按重复触发收起。
   * 其余按键一律不处理——面板可聚焦是弹输入法的前提，吞掉别的键等于把输入法/编辑行为弄坏。
   *
   * @param keyCode 按键码（[KeyEvent.KEYCODE_BACK]）。
   * @param action 动作（[KeyEvent.ACTION_UP] / [KeyEvent.ACTION_DOWN]）。
   * @return true = 已处理（调用方收起面板并返回 true）。
   */
  fun shouldCollapse(keyCode: Int, action: Int): Boolean =
    keyCode == KeyEvent.KEYCODE_BACK && action == KeyEvent.ACTION_UP
}
