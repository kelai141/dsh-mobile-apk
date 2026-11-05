/**
 * Composer insets adaptation for mobile/edge-to-edge:
 * On Android edge-to-edge mode, the shell supplies --dsh-android-system-bottom
 * (gesture / nav-bar height) and --dsh-android-ime-bottom (soft keyboard height).
 * Padding the whole composer seat ([data-composer-seat]) pushes the input card,
 * mode pills, anchored command menu, and the StatsLine footer above the navigation
 * bar / gesture pill.
 * On desktop / non-Android environments where CSS variables are unset,
 * max(0px, 0px) evaluates cleanly to 0px (zero side-effects).
 *
 * 键盘高度**不进**这条 padding（issue #783）：壳侧已经把同一个 IME inset 施加到
 * WebView 自身的布局尺寸上（`MainActivity.kt` 的 `webView.setPadding(0, 0, 0, ime)`），
 * 布局视口因此真的变短，seat 的自然底边早已落在键盘顶。这里再按同一个量加一份
 * padding，就是同一个高度被两侧各算一次 —— 键盘弹起时输入卡下方多出一条与键盘
 * 等高的纯色空带（用户报的「底部大面积无意义留白」），且 seat 被撑高后
 * `--dsh-composer-height` 跟着变大，把「回到底部」浮层又往上顶。
 * 键盘关闭时该变量回到 0px，与系统条 / 安全区取值互不影响。
 */
export const COMPOSER_INSETS_CSS: string = `
[data-composer-seat] {
  padding-bottom: max(
    env(safe-area-inset-bottom, 0px),
    var(--dsh-android-system-bottom, 0px)
  );
}
`
