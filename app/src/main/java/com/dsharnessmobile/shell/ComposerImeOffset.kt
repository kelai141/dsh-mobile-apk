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
 * 修法：壳侧已经知道 IME 高度，就直接把它作用到 composer 卡片上。
 *
 * 两个方向**故意不对称**，这是真机时序决定的：
 *
 * - **弹出**等 insets：抬多少必须由键盘高度决定，没有别的来源；
 * - **收起不等 insets**：IME inset 在收起动画期间保持旧值、动画走完才一次性归零
 *   （实测收起全程只推一条 `ime=0`），等它会让卡片慢半拍滑落，观感是「粘滞」。
 *   所以收起改由 `focusout` 立即触发回落——点空白把焦点打掉的那一刻就落。
 *
 * 注入脚本是**常驻**的：第一次执行安装监听器并把 API 挂到 `window.__dshComposerIme`，
 * 之后每次 insets 变化只调用 `set(kb)`。这样焦点监听不会被重复注册，也能在
 * 页面重载后自动重建。
 *
 * 用 rect 对齐而不是固定位移：卡片自身带的下边距、以及它下面那条状态栏的高度都要
 * 算进去，否则会留出「悬空一截」的缝隙（固定位移实测就是这个毛病）。
 */
internal object ComposerImeOffset {

  /** composer 卡片的稳定选择器（上游 DSH Web 界面自带）。 */
  internal const val CARD_SELECTOR = "[data-composer-card]"

  /** 退化选择器：卡片被拆掉或改名时仍能命中停靠容器。 */
  internal const val DOCK_SELECTOR = "[data-composer-dock]"

  /** 常驻 API 的全局名，也是「是否已安装」的判据。 */
  internal const val API_NAME = "__dshComposerIme"

  /**
   * @param imeCssPx IME 高度，已由壳侧换算成 CSS 像素（[MainActivity] 的 `webImeBottomInset`）。
   *   非正值按 0 处理：键盘收起时必须清位移，否则卡片会悬在半空。
   * @return 可直接交给 `WebView.evaluateJavascript` 的 IIFE 脚本。
   */
  fun script(imeCssPx: Int): String {
    val kb = if (imeCssPx > 0) imeCssPx else 0
    return "(function(){" +
      "var api=window.$API_NAME;" +
      "if(!api){" +
      "var find=function(){return document.querySelector('$CARD_SELECTOR')" +
      "||document.querySelector('$DOCK_SELECTOR')};" +
      "var last=0;" +
      "var clear=function(){var c=find();if(c){c.style.transition='none';c.style.removeProperty('transform')}};" +
      "var apply=function(v){" +
      "var c=find();if(!c)return;" +
      "var rising=v>last;last=v;" +
      // 幂等：先清掉上一次的位移与过渡，才能量到卡片的自然位置。
      "c.style.transition='none';" +
      "c.style.removeProperty('transform');" +
      "void c.offsetHeight;" +
      "if(v<=0)return;" +
      // 把卡片底边对齐到键盘顶边；差额为负说明卡片本来就在键盘上方，不动。
      "var r=c.getBoundingClientRect();" +
      "var d=Math.round(r.bottom-((window.innerHeight||0)-v));" +
      "if(d<=0)return;" +
      // 弹起给一段短过渡：IME inset 是跳变的（比键盘动画还早），直接套用会「抢跑」；
      // 收起不给过渡——那一步要求瞬时回落，焦点一离开就落。
      "if(rising){c.style.transition='transform 220ms cubic-bezier(.2,.7,.3,1)'}" +
      "c.style.setProperty('transform','translateY(-'+d+'px)','important')};" +
      "api={set:apply,clear:clear};" +
      "window.$API_NAME=api;" +
      // 收起方向不等 insets：焦点离开输入框的那一刻立即回落。
      "document.addEventListener('focusout',function(){" +
      "setTimeout(function(){" +
      "var a=document.activeElement;" +
      "if(!a||a===document.body||a===document.documentElement)clear()" +
      "},0)},true);" +
      "}" +
      "api.set($kb);" +
      "})()"
  }
}
