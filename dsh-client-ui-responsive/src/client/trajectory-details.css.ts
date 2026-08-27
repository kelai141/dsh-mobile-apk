/**
 * Trajectory local details panel (upstream ui-trajectory) on narrow screens
 * (issue apk#67): the upstream ≤760px media query positions the panel
 * absolute within the ledger region — sandwiched between the trajectory
 * timeline bar above and the composer seat below (which also covers its
 * bottom), leaving a cramped reading band. Overlay it full-viewport inside
 * the mobile frame: fixed positioning escapes the ledger, so the panel spans
 * the whole screen (header + tabs fixed, body scrolls) and the input bar
 * never covers it. The upstream col-resize handle is pointless on touch.
 */
export const TRAJECTORY_DETAILS_CSS: string = `
@media (max-width: 760px) {
  /* aside-scoped: the upstream panel's tablist ALSO carries aria-label="Event
     details", so a bare attribute selector would also turn the tabs into a
     fixed full-screen overlay covering the header and the close button. */
  [data-mobile] aside[aria-label="Event details"] {
    position: fixed;
    inset: 0;
    z-index: 40;
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    border-left: none;
    box-shadow: none;
    padding-top: env(safe-area-inset-top, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  [data-mobile] aside[aria-label="Event details"] [aria-label="Resize event details"] {
    display: none;
  }
  /* The panel's fixed z-index lives inside the ledger's stacking context
     (position:relative; z-index:0; isolation:isolate), so it loses to the
     top bar (z3), the tabs and the timeline bar (z1) — the banner then
     covers the panel and the tabs/timeline stay visible above it. While the
     panel is open, raise the ledger itself so the whole subtree (panel
     included) covers them.
     2026-08-23 (#17 回归修复)：:has() 是 Chromium 105+；MIUI12 旧 WebView
     (Chromium 83) 整条规则被丢弃 → 面板遮挡回归。保留 :has() 路径（新内核
     零开销，无 JS 依赖）并追加 class 路径（旧内核由 TrajectoryPanelsObserver
     在面板开合时切换 data-mobile-ledger-raised）。 */
  [data-mobile] [class*="ledger"]:has(aside[aria-label="Event details"]) {
    z-index: 12;
  }
  [data-mobile] [class*="ledger"].data-mobile-ledger-raised {
    z-index: 12;
  }
}
`
