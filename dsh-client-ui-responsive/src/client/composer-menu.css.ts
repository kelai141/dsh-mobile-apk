/**
 * Composer popup geometry (upstream ui-input-trigger + ui-model-selection):
 * - The slash menu's scroll container (`.viewport`, the `[role='listbox']`) is a
 *   flex child without flex:1, so when the candidate list exceeds max-height the
 *   viewport grows past the menu and is clipped by the menu's overflow:hidden —
 *   the scrollbar lands outside the visible area and the list appears
 *   unscrollable. Fix: let the viewport fill the menu and scroll inside it.
 * - The upstream menus clamp against viewport y=0 only, and size themselves
 *   against their trigger, so on phones they can leave the viewport sideways or
 *   rise above the fixed top bar. `ComposerPopupGuard` measures each open popup
 *   and writes the caps below; the width cap is applied to the scroll container
 *   and to the painted card alike so the card never stays wider than its
 *   content (a blank strip with a detached scrollbar — issue apk#135).
 */
export const COMPOSER_MENU_CSS: string = `
[data-composer-card] [role='listbox'] > div {
  flex: 1 1 0%;
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

/* The model menu is its own painted surface; its height cap only exists while
   the guard measures one, so the upstream 360px design cap stays in charge. */
html[data-dsh-mobile-form] [data-composer-card] [role='menu'] {
  max-height: var(--dsh-mobile-menu-max-height, none) !important;
}

/* Horizontal containment: the guard marks the painted card of every open
   popup and writes its shift, keeping the card inside the viewport. */
[data-dsh-popup] {
  transform: translateX(var(--dsh-mobile-popup-shift, 0px));
}
`
