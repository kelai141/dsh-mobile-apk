package com.dsharnessmobile.shell

/**
 * 把 composer 卡片抬到键盘上沿的注入脚本（issue #197 机制① 的真机残留）。
 *
 * 背景（0.14.11 真机实测：Redmi Note 12 Turbo / Android 13 / WebView 108.0.5359.128）：
 *
 * - `webView.setPadding(0, 0, 0, ime)` 改的是 View 的 padding，**不会改变 WebView 的
 *   CSS 布局视口**。IME 弹出时 `window.innerHeight`、`visualViewport.height`、
 *   `navigator.virtualKeyboard.boundingRect.height` 三者全部恒定（实测 873 / 873 / 0），
 *   页面因此拿不到任何键盘信号，也就不会自己让位；
 * - `--dsh-android-ime-bottom` 已由 [MainActivity.pushWebInsets] 推给页面，但主界面
 *   没有消费者——全仓只有 `plugins/dsh-android-vdisplay` 的键条读它；
 *
 * 结果：键盘弹起后 composer 仍停在页面底部，被键盘整个盖住。
 *
 * 修法：壳侧已经知道 IME 高度，就直接把它作用到 composer 卡片上，不再指望页面自己
 * 感知。注入是幂等且自愈的——每次 insets 变化都会重跑，键盘收起时 ime=0 会把位移清掉。
 *
 * 用 rect 对齐而不是固定位移：卡片自身带的下边距、以及它下面那条状态栏的高度都要
 * 算进去，否则会留出「悬空一截」的缝隙（固定位移实测就是这个毛病）。
 */
internal object ComposerImeOffset {

  /** composer 卡片的稳定选择器（上游 DSH Web 界面自带）。 */
  internal const val CARD_SELECTOR = "[data-composer-card]"

  /** 退化选择器：卡片被拆掉或改名时仍能命中停靠容器。 */
  internal const val DOCK_SELECTOR = "[data-composer-dock]"

  /**
   * @param imeCssPx IME 高度，已由壳侧换算成 CSS 像素（[MainActivity] 的 `webImeBottomInset`）。
   *   非正值按 0 处理：键盘收起时必须清位移，否则卡片会悬在半空。
   * @return 可直接交给 `WebView.evaluateJavascript` 的 IIFE 脚本。
   */
  fun script(imeCssPx: Int): String {
    val kb = if (imeCssPx > 0) imeCssPx else 0
    return "(function(){" +
      "var kb=$kb;" +
      "var c=document.querySelector('$CARD_SELECTOR')||document.querySelector('$DOCK_SELECTOR');" +
      "if(!c)return;" +
      // 幂等：先清掉上一次的位移，才能量到卡片的自然位置。
      "c.style.removeProperty('transform');" +
      "if(kb<=0)return;" +
      // 把卡片底边对齐到键盘顶边；差额为负说明卡片本来就在键盘上方，不动。
      "var r=c.getBoundingClientRect();" +
      "var t=(window.innerHeight||0)-kb;" +
      "var d=Math.round(r.bottom-t);" +
      "if(d>0){c.style.setProperty('transform','translateY(-'+d+'px)','important')}" +
      "})()"
  }
}
