/**
 * Composer popup geometry (upstream ui-input-trigger + ui-model-selection):
 * - The slash menu's listbox is the scroll viewport inside the painted surface.
 *   Let that flex child shrink under the surface's height cap so overflow stays
 *   inside the scroll viewport. Its section and source headings keep their own
 *   row heights so wrapped content and labels cannot overlap adjacent options.
 *
 * - The upstream menus clamp against viewport y=0 only, and size themselves
 *   against their trigger, so on phones they can leave the viewport sideways or
 *   rise above the fixed top bar. `ComposerPopupGuard` measures each open popup
 *   and writes the caps below; the width cap is applied to the scroll container
 *   and to the painted card alike so the card never stays wider than its
 *   content (a blank strip with a detached scrollbar — issue apk#135).
 */
export const COMPOSER_MENU_CSS: string = `
[data-composer-card] [data-menu-material='translucent'] > [role='listbox'] {
  flex: 1 1 auto;
  min-height: 0;
}

/* 宽度钳制只作用在绘制卡片上（[data-dsh-popup]），滚动容器（listbox）必须铺满卡片：
   实测（450px 视口）卡片 424 宽而 listbox 只有 340 → 滚动条离卡片右缘 64px，
   看起来就是「滚动条没吸在最右侧、和布局边界不匹配」（#135 的回归形态）。
   注意：本段注释在模板字符串内，**不要写反引号**（会提前终止字符串，tsc 报 TS1005）。 */
html[data-dsh-mobile-form] [data-composer-card] [data-dsh-popup] {
  max-width: var(--dsh-mobile-popup-max-width, min(96vw, 420px)) !important;
}
html[data-dsh-mobile-form] [data-composer-card] [role='menu'] {
  max-width: var(--dsh-mobile-popup-max-width, min(96vw, 420px)) !important;
}
html[data-dsh-mobile-form] [data-composer-card] [role='listbox'] {
  max-width: none !important;
}

html[data-dsh-mobile-form] [data-composer-card] [role='listbox'] {
  max-height: var(--dsh-mobile-menu-max-height, 320px) !important;
}

/* Android can move the composer as the keyboard closes without the layout
   resize that refreshes the upstream surface's inline max-height. */
[data-composer-card] [data-dsh-tablet-trigger-menu] {
  max-height: var(--dsh-mobile-menu-max-height) !important;
}

/* The model menu is its own painted surface; its height cap only exists while
   the guard measures one, so the upstream 360px design cap stays in charge. */
html[data-dsh-mobile-form] [data-composer-card] [role='menu'] {
  max-height: var(--dsh-mobile-menu-max-height, none) !important;
}

/* ModelSelect is portaled to body, so its role surface is outside the composer
   selectors above. The guard marks only the exact aria-controls target. */
html[data-dsh-mobile-form] body [data-dsh-mobile-model-menu] {
  max-width: var(--dsh-mobile-popup-max-width, min(96vw, 420px)) !important;
  max-height: var(--dsh-mobile-menu-max-height, none) !important;
}

/* 二级模型列表到达边界后仍由菜单消化纵向滚动，避免滚动链传给背景会话。
   overscroll 必须落在实际内部 scrollable 节点；仅设置外层绘制卡片无效。 */
[data-dsh-mobile-model-menu],
[data-dsh-mobile-model-menu] .scrollable {
  overscroll-behavior-y: none;
}

/* Android WebView cannot reliably reproduce the desktop translucent menu
   backdrop. The popup guard tags only an aria-controls-resolved model menu when
   the Android bridge is present. Keep this independent of the narrow-form
   marker: landscape touch layouts are wider than the phone breakpoint. */
body [data-dsh-android-model-menu][data-menu-material='translucent'] > [aria-hidden='true'] {
  background: var(--dsw-alias-bg-module-platform);
  backdrop-filter: none;
}

/* Containment: the guard marks the painted card of every open popup and writes
   its shifts, keeping the card inside the viewport. The Y half of the pair is
   what moves a portaled model menu out from under the soft keyboard: ModelSelect
   anchors from the trigger but clamps against window.innerHeight, which Android
   keeps at full height while the IME is up. */
[data-dsh-popup] {
  transform: translate(var(--dsh-mobile-popup-shift, 0px), var(--dsh-mobile-popup-shift-y, 0px));
}
`
