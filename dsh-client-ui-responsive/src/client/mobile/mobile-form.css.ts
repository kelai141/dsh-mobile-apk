/**
 * The phone form (<768px) over the upstream frame.
 *
 * Upstream keeps ownership of the frame, the columns, and both sidebars; this
 * sheet only re-shapes them for a phone:
 * - the left sidebar becomes an off-canvas drawer (its collapsed rail steps
 *   aside with it; the top bar's toggle is the entry, and the rail's own
 *   toggle keeps working from inside the drawer);
 * - the centre column spans the whole frame and pads under that top bar;
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
  --dsh-mobile-topbar-height: 44px;
}

@media (max-width: 767px) {
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
     (off-canvas) ancestor would carry it off-screen. While any modal outside
     the frame's own overlay layer is up, the drawer stays on screen. */
  html[data-dsh-modal-open] [data-dsh-frame] > [class*='sidebarCol'] {
    transform: none;
  }

  [data-dsh-frame] > [class*='centerCol'] {
    grid-column: 1 / -1;
    padding-top: calc(var(--dsh-mobile-topbar-height) + var(--dsh-mobile-top-inset, 0px));
  }

  [data-dsh-frame] > [class*='rightbarCol'] {
    grid-column: 3;
  }

  [data-dsh-frame] [class*='handle'] {
    display: none;
  }

  [data-sidebar-right-panel='fullscreen'] {
    box-sizing: border-box;
    padding-top: var(--dsh-mobile-top-inset, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-dsh-frame] > [class*='sidebarCol'] {
    transition: none;
  }
}
`
