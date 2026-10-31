/**
 * The phone form (<768px) over the upstream frame.
 *
 * Upstream keeps ownership of the frame, the columns, and both sidebars; this
 * sheet only re-shapes them for a phone:
 * - the left sidebar becomes an off-canvas drawer (its collapsed rail steps
 *   aside with it; the header's leading toggle is the entry, and the rail's own
 *   toggle keeps working from inside the drawer);
 * - the centre column spans the whole frame and pads only under the system inset;
 * - the right column keeps its zero-width track so the upstream panel (already
 *   fullscreen below 768px of frame width) hangs over the centre as a
 *   slide-over, with the system insets respected;
 * - the desktop drag handles are touch noise and step aside.
 *
 * The frame's track widths are inline styles, so the grid override must be
 * `!important`. Children are placed explicitly: with the sidebar out of flow,
 * auto-placement would otherwise drop the centre column into the first track.
 */
export const MOBILE_FORM_CSS: string = `
:root {
  --dsh-mobile-top-inset: max(env(safe-area-inset-top, 0px), var(--dsh-android-system-top, 0px));
}

/* APK #340: the wide frame also occupies Android's edge-to-edge viewport.
   Reserve the measured top inset once for all three columns, including the
   absolute fullscreen panel anchored in rightbarCol. A 100% grid row would
   retain the old height beneath the padding and clip the bottom controls. */
@media (min-width: 768px) {
  [data-dsh-frame] {
    box-sizing: border-box;
    padding-top: var(--dsh-mobile-top-inset, 0px);
    grid-template-rows: minmax(0, 1fr);
  }
}

@media (max-width: 767px) {
  /* touch-action 在触点按下时采样，touchstart 动态修改对当前手势无效。
     每个触点到最近滚动容器的祖先交集都必须保留 pan-y，而横向滚动容器及其内容
     由手势模块预先标记放行。

     这里**不再放行 pinch-zoom**（2026-10-31 图片预览「放大图片会放大整个屏幕」）：
     pinch-zoom 这个关键字本身就是「允许浏览器把整页捏合缩放」的授权，而这是应用 UI、
     不是可阅读的文档。实测（MuMu Android 15 / WebView 110，设备 450x800）：带
     pinch-zoom 时双指捏合让 visualViewport.scale 1→5、width 450→90，顶栏/输入区跟着
     放大；去掉该关键字后同一手势 scale 恒为 1（对照：给 html 临时加 touch-action:none
     得到同样结果，撤掉即复现）。壳侧 WebSettings 的 supportZoom/builtInZoomControls
     在这一版 WebView 上关不掉页面捏合（两个方向都实测过），因此这一行才是真正的闸门。
     图片自己的缩放在 lightbox 内实现（lightbox-zoom.ts），不依赖浏览器缩放。 */
  /* 页面级捏合的闸门在根上，不在 frame 上：body 层的 portal（预览版说明、各类 aria-modal
     浮层、大图预览）不在 [data-dsh-frame] 子树里，只关 frame 拦不住从浮层上开始的手势。
     这里用 pans 而非 pinch-zoom：pan-x pan-y = 两个方向都允许平移、**不允许捏合缩放**，
     于是纵向滚动、横向滚动容器（下方 auto 规则）、抽屉手势全都不受影响。 */
  html[data-dsh-mobile-form] {
    touch-action: pan-x pan-y;
  }

  [data-dsh-frame], [data-dsh-frame] * {
    touch-action: pan-y;
  }
  [data-dsh-frame][data-dsh-horizontal-scroll],
  [data-dsh-frame] [data-dsh-horizontal-scroll],
  [data-dsh-frame] [data-dsh-horizontal-scroll] * {
    touch-action: auto;
  }

  [data-dsh-frame] {
    grid-template-columns: 0 minmax(0, 1fr) 0 !important;
  }

  [data-dsh-frame] > [class*='sidebarCol'] {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(288px, 82vw);
    z-index: 30;
    background: var(--dsw-specific-sidebar-fill);
    transform: translateX(-100%);
    transition: transform var(--ds-transition-duration-slow, 200ms) var(--ds-ease-in-out, ease);
    /* 顶部安全区（2026-09-11 真机反馈）：关闭沉浸式状态栏时抽屉全高贴顶，上游侧栏的品牌行
       （logo）被状态栏盖住；这里与右栏/中栏用同一个 inset 变量（沉浸式打开时为 0，不影响布局）。 */
    padding-top: var(--dsh-mobile-top-inset, 0px);
    /* 底部安全区（apk #153 / PR #157）：抽屉全高贴底时，底部用户栏里的设置入口与系统手势条
       重叠，点击被拦截。与 composer-insets 的底部 inset 取值保持一致。 */
    padding-bottom: max(env(safe-area-inset-bottom, 0px), var(--dsh-android-system-bottom, 0px));
  }

  [data-dsh-frame]:not([data-sidebar-collapsed]) > [class*='sidebarCol'] {
    transform: none;
  }

  /* The settings overlay renders inside the sidebar subtree: a translated
     (off-canvas) ancestor would carry it off-screen (a transformed ancestor
     becomes the containing block of its fixed-position descendants). The
     drawer therefore stays on screen while the settings panel is up.

     Only the settings panel may pin it. Keying this on the coarse
     data-dsh-modal-open attribute flattened the drawer for every body-level
     aria-modal dialog (session rename, permission risk confirmation, image
     lightbox). data-dsh-settings-open is the settings-only fact published on
     the root by form-marker.ts, so this stays a plain ancestor match with no
     :has() requirement. */
  html[data-dsh-settings-open] [data-dsh-frame] > [class*='sidebarCol'] {
    transform: none;
  }

  /* Both in-flow columns take the explicit first row. The frame's track widths
     are inline styles and upstream declares a single 100% row; a right column
     left on auto-placement lands in an implicit second row (0px tall) and the
     frame's overflow:hidden clips the whole right panel -- toggle, tabs and
     corner expand key included -- out of the viewport. The centre column joins
     it so no second row is materialised at all. */
  [data-dsh-frame] > [class*='centerCol'] {
    grid-column: 1 / -1;
    grid-row: 1;
    /* 0.14.2 P4: the self-drawn 44px top bar is gone (the drawer toggle now sits in
       upstream's own header row), so the centre column no longer reserves a band
       above the header -- only the system/safe-area top inset. */
    padding-top: var(--dsh-mobile-top-inset, 0px);
  }

  [data-dsh-frame] > [class*='rightbarCol'] {
    grid-column: 3;
    grid-row: 1;
  }

  /* Anchored on upstream's own attribute: CSS attribute-substring matching is
     case-sensitive and the real class is widthHandle (capital H), so a
     [class*=handle] selector matches nothing and the desktop drag handles
     stayed live on a phone. */
  [data-dsh-frame] [data-width-handle] {
    display: none;
  }

  [data-sidebar-right-panel='fullscreen'] {
    box-sizing: border-box;
    padding-top: var(--dsh-mobile-top-inset, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  /* 0.14.7 实时跟手（sidebar-gestures.ts 的 DRAWER_DRAGGING_ATTR）。
     两根侧栏都靠 transition 做开合，拖动期间每次 touchmove 写入新位移都会被这 200ms
     过渡追着跑，手感和"人为阻尼"一样迟滞。拖动标记存在时关掉过渡，位移与手指同帧；
     松手撤掉标记，过渡立刻恢复，于是从手指停在的位置平滑收敛到最终态（不会先弹回 0）。
     选择器必须对准**真正带过渡的元素**，两边并不一样：
     - 左抽屉本体就是被位移的那个元素（上方 transform: translateX(-100%)）；
     - 右栏本体没有 transform 过渡，上游把展开/收起位移写在其 dockkit 子元素上
       （ui-sidebar-right 的 lib 内联样式：panel [data-dockkit-host=dock|empty|divider]
       → translateX(var(--dsh-sidebar-width)) + visibility 过渡）。只关右栏本体等于没关，
       右栏拖动期间仍吃那 200ms，表现为"跟不上手"。
     这些选择器与 sidebar-drag-preview.ts 的 RIGHT_SLIDE_SELECTOR 逐字对齐：那里写内联
     位移，这里关过渡，两边必须同一批元素，否则又会漂移成"位移写了但过渡没关"。
     气泡头（.dsh-bubble-header 及其弹层/遮罩，带 data-dsh-bubble-nav 的房间直属子节点）
     也在名单里：它现在同样跟手平移，若只有它保留 200ms 过渡，拖动时顶栏会慢半拍。
     设置面板打开时左抽屉被钉成 transform:none（上方那条规则），拖动预览的位移因此
     被内联样式覆盖 —— 这是有意的：设置态不参与抽屉跟手。 */
  html[data-dsh-drawer-dragging] [data-dsh-frame] > [class*='sidebarCol'],
  html[data-dsh-drawer-dragging] [data-sidebar-right-panel='fullscreen'] [data-dockkit-host='dock'],
  html[data-dsh-drawer-dragging] [data-sidebar-right-panel='fullscreen'] [data-dockkit-empty],
  html[data-dsh-drawer-dragging] [data-sidebar-right-panel='fullscreen'] [data-dockkit-divider],
  html[data-dsh-drawer-dragging] [data-sidebar-right-panel='fullscreen'] > [data-dsh-bubble-nav] {
    transition: none !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-dsh-frame] > [class*='sidebarCol'] {
    transition: none;
  }
}
/* 左栏「更多」入口（上游 sidebar 的 PanelMoreMenu）：用户定例移除。
   它是左栏里唯一带 aria-haspopup=menu 的导航按钮；会话列表底部那个「… 更多」是普通按钮，
   不带该属性，不会被这条规则误伤。 */
html[data-dsh-mobile-form] button[aria-haspopup='menu'][aria-label='更多'],
html[data-dsh-mobile-form] button[aria-haspopup='menu'][aria-label='More'] {
  display: none;
}

/* 「更多工具」入口（上游 sidebar-right 的 guide 页最后一张卡）：用户定例移除。
   它是 guide 列表里唯一带 aria-haspopup=menu 的按钮；按中英两种 aria-label 精确命中，
   不依赖 hashed 类名。 */
html[data-dsh-mobile-form] button[aria-haspopup='menu'][aria-label='更多工具'],
html[data-dsh-mobile-form] button[aria-haspopup='menu'][aria-label='More tools'] {
  display: none;
}
`
