/**
 * Composer insets adaptation for mobile/edge-to-edge.
 *
 * 底部预留必须落在 seat **内部的真实盒子**上，不能落在 [data-composer-seat] 自己身上
 * （issue #783 缺陷 B 的真因，设备实测）：
 *   - 上游把 `--dsh-composer-height` 设为 seat.offsetHeight，并在 seat 上挂了
 *     ResizeObserver（默认 content-box）；
 *   - Android WebView 114 上，**只改被观察元素自身的 padding-bottom 时该 RO 不投递**
 *     （隔离实验：seat 128px→174px 而回调 0 次；改 height 或改子元素高度则正常投递），
 *     于是 `--dsh-composer-height` 停在旧值，而 seat 实际已变高；
 *   - 依赖该变量的「回到底部」浮层（bottom: calc(var(--dsh-composer-height) + 16px)）
 *     因此比真实 seat 顶低一个 inset 的高度，按钮压住最后一行正文。
 * 改到 composerStack（seat 内的真实盒子，随 seat 一起做 border-box 布局）后，
 * seat 的高度变化由**子元素**引起，上游 RO 正常投递，变量与 seat.offsetHeight 相等；
 * 视觉几何逐像素不变（输入卡、StatsLine、浮层相对位置都不动）。
 *
 * 取值用 --dsh-android-navbar-bottom（只算真正盖住页面的系统栏），不用
 * --dsh-android-system-bottom（那是栏与手势热区取大的保守值，issue #783 缺陷 A）：
 * 手势模式下没有可遮挡的栏，交互面不该凭空留出一条纯背景带。
 * 壳侧变量缺失时（桌面/旧壳）回落到保守值，再回落到 0px。
 *
 * 键盘高度不进这条 padding（issue #783 已合并的另一半）：壳侧已经把同一个 IME inset
 * 施加到 WebView 自身的布局尺寸上（`MainActivity` 的 `webView.setPadding(0, 0, 0, ime)`），
 * 布局视口因此真的变短，seat 的自然底边早已落在键盘顶。键盘弹起期间这条预留由
 * keyboard-boundary.ts 归零，避免同一个高度被两侧各算一次。
 */
export const COMPOSER_INSETS_CSS: string = `
[data-composer-seat] [class*='composerStack'] {
  padding-bottom: max(
    env(safe-area-inset-bottom, 0px),
    var(--dsh-android-navbar-bottom, var(--dsh-android-system-bottom, 0px))
  );
}
`;
