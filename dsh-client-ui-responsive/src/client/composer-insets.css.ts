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
 * The Android host reports keyboard overlap without resizing the WebView.
 * The keyboard motion owns the settled layout overlap. Older hosts supply the current overlap.
 *
 * #1782（用户真机 V2425A 1260x2800）：**键盘展开 + 输入框里有附件**时，输入框被抬到
 * 特别高。实测 ime=0px 时同样复现，问题出在
 * seat 与它的滚动容器之间的高度关系：
 *   - 上游 `scrollBody` 是 `flex:1; min-height:0; overflow-y:auto` 的滚动盒；
 *   - seat 是 `flex:none` + `position:sticky; bottom:0`，**没有任何高度上限**；
 *   - 键盘展开后 scrollBody 只剩 ~180-300px，而带附件缩略图的 seat 实测 218px。
 *   一旦 seat 高于 scrollBody，sticky 的「贴底」锚点就把 seat 的**顶边**顶到容器
 *   顶边之上（实测 bodyTop=119 / seatTop=82 甚至 42），看起来就是输入框被抬到半空。
 *
 * 修法：给 seat 一个不超过滚动容器的**高度上限**，并允许其内部滚动。超过上限的部分
 * 在 seat 内部滚，而不是把整块内容往上顶。
 * 判据（见 tests/composer-insets-seat-cap.spec.ts）：seat 的 max-height 必须是 100%，
 * 且 overflow-y 不是 visible —— 两条缺一：只有上限时内容会被裁掉，只有滚动时上限不生效。
 */
export const COMPOSER_INSETS_CSS: string = `
[data-composer-seat] [class*='composerStack'] {
  padding-bottom: max(0px, calc(
    max(env(safe-area-inset-bottom, 0px),
        var(--dsh-android-navbar-bottom, var(--dsh-android-system-bottom, 0px)))
    - var(--dsh-composer-ime-overlap, 0px)
  ));
}

html[data-dsh-ime] [data-composer-seat] [class*='composerStack'] {
  --dsh-composer-ime-overlap: var(--dsh-android-ime-bottom, 0px);
}

/* Equal spacers center the hero throughout the viewport resize.
   Both reach zero in short viewports, keeping overflow scrollable. */
html [data-conversation-content][data-content-phase='hero'] > [data-conversation-scroll] {
  justify-content: flex-start;
}

html [data-conversation-content][data-content-phase='hero'] > [data-conversation-scroll]::before,
html [data-conversation-content][data-content-phase='hero'] > [data-conversation-scroll]::after {
  content: '';
  flex: 1 0 0px;
}

/* #1782：seat 不得高过它的滚动容器，否则 sticky 贴底会把 seat 顶边顶出容器。 */
[data-composer-seat] {
  max-height: 100%;
  overflow-y: auto;
}

/* The @ and / lists are anchored above the card and need to paint outside the
   seat. Bound the scrollable draft against the conversation viewport instead. */
@supports (height: 1cqh) {
  [data-conversation-scroll]:has([data-composer-seat] [data-input-scroll]) {
    container-type: size;
    container-name: dsh-conversation-scroll;
  }

  [data-composer-seat]:has([data-composer-card] > [data-input-scroll]) {
    overflow: visible;
  }

  @container dsh-conversation-scroll (min-height: 0px) {
    [data-composer-seat] [data-input-scroll] {
      max-height: clamp(36px, calc(100cqh - 108px), min(336px, 52cqh));
    }

    [data-content-phase='hero'] [data-composer-seat] [data-input-scroll] {
      max-height: clamp(36px, calc(100cqh - 176px), min(336px, 52cqh));
    }
  }
}

[data-composer-seat] [data-input-scroll] {
  overscroll-behavior-y: contain;
  touch-action: pan-y;
}

html[data-dsh-ime] {
  --dsh-visible-ime-overlap: var(--dsh-android-page-ime-overlap, 0px);
}

html[data-dsh-ime-transition] {
  --dsh-visible-ime-overlap: var(--dsh-page-ime-layout, var(--dsh-android-page-ime-target, 0px));
}

[data-dsh-ime-motion] {
  clip-path: inset(0);
}

html:is([data-dsh-ime], [data-dsh-ime-transition]) [data-dsh-frame] {
  height: max(0px, calc(100% - var(--dsh-visible-ime-overlap, 0px)));
}

html:is([data-dsh-ime], [data-dsh-ime-transition]) [data-dsh-settings-dialog] {
  max-height: max(0px, calc(100% - var(--dsh-visible-ime-overlap, 0px)));
}
`;
