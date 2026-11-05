package com.dsharnessmobile.shell

import android.content.Context
import android.view.KeyEvent
import android.widget.LinearLayout

/**
 * issue #1612：悬浮球面板展开期间返回键完全失效（用户可见的卡死态）。
 *
 * 现象：面板展开、焦点在 overlay 窗口时按返回键/返回手势，什么都不发生 —— 既收不起面板，
 * 也退不出后面引擎页面的子层（BackGate 拿不到这次返回），用户只能去找 ✕。
 *
 * 真因：showPanel() 给面板窗口的 flags 只有 FLAG_NOT_TOUCH_MODAL（即**可聚焦**，弹输入法需要），
 * 而全仓没有任何 KEYCODE_BACK / setOnKeyListener / dispatchKeyEvent 处理。BACK 被派发给获得焦点的
 * overlay 窗口，视图树无人消费；非 Activity 窗口没有「没人消费就回落给系统」这回事 ⇒ 事件被丢弃。
 *
 * @param code - 键码。
 * @param action - 动作（ACTION_DOWN / ACTION_UP / ACTION_MULTIPLE）。
 * @param collapse - 收起动作（调用方注入；单测用桩即可断言「真被调用了一次」）。
 * @returns true = 本次事件已被消费（不得再传给别人）。
 */
internal fun consumePanelBack(code: Int, action: Int, collapse: () -> Unit): Boolean {
  if (code != KeyEvent.KEYCODE_BACK) return false
  // 只认抬起：在按下时就收面板，抬起会落到下一层窗口 —— 一次返回被算两次。
  if (action == KeyEvent.ACTION_UP) collapse()
  return true
}

/**
 * 面板根容器：在**窗口根 View 的派发口**拦下返回键。
 *
 * 为什么是 dispatchKeyEvent 而不是给根容器挂 setOnKeyListener（issue #1612 的建议修法）：
 * ViewRootImpl 把按键交给根 View 的 dispatchKeyEvent；而 ViewGroup.dispatchKeyEvent 在「自己没焦点、
 * 也没有子 View 有焦点」时**直接 return false**，根本走不到挂在 ViewGroup 上的 OnKeyListener。
 * 面板根是 LinearLayout（子控件轮着拿焦点），挂 OnKeyListener 会表现为「有时能返回、有时不能」。
 * 覆盖 dispatchKeyEvent 与焦点无关，正是 overlay 窗口该用的那一层。
 *
 * @param context - 宿主 Context（生产路径就是 OverlayService）。
 * @param onBack - 收起面板的动作（由 buildUnit 注入，避免这里反向依赖服务类的成员）。
 */
internal class BackKeyPanelLayout(
  context: Context,
  private val onBack: () -> Unit,
) : LinearLayout(context) {

  override fun dispatchKeyEvent(event: KeyEvent): Boolean =
    if (dispatchPanelKey(event.keyCode, event.action)) true else super.dispatchKeyEvent(event)

  /**
   * 按键决策本体（独立成函数是为了让它能在 JVM 单测里**在真对象上**跑：android.jar 的桩实现让
   * KeyEvent 的 getter 恒返回 0，只有把键码/动作当参数传进来，行为判据才立得住）。
   */
  internal fun dispatchPanelKey(code: Int, action: Int): Boolean = consumePanelBack(code, action, onBack)
}
