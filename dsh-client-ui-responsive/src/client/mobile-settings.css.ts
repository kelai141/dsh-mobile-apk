/**
 * Mobile settings-panel adaptation (dsh-client-ui-responsive issue #1; 2026-09-03 rework).
 * Upstream SettingsRoot renders its fixed inset:0 overlay + 800px two-column panel
 * INLINE in the sidebar subtree (no portal). On the mobile drawer branch the panel must
 * reflow to a single column and fill the viewport (user requirement: 设置页全屏显示).
 *
 * 2026-09-03 rework (0.13.2 fix batch — 0.13.1 user "narrow strip, overlapping elements"
 * bug, investigation confirmed by live CDP measurement):
 * - the old selectors keyed on `:has(> nav)`, which Chromium < 105 drops whole
 *   (MIUI12/Chromium 83 era custom WebViews) → the two-column desktop panel stayed
 *   crammed into the drawer with no reflow. Now scoped through the drawer ancestor
 *   `[class*="mobileDrawer"]` (CSS Modules keeps the original name inside the hashed
 *   class), pure attribute selectors, effective on old kernels too. In the mobile
 *   branch the drawer subtree's only aria-modal dialog is the settings overlay panel,
 *   so the scope has no false hits.
 * - after the drawer hijack removal (AppFrame.module.css margin-left slide), the
 *   overlay's `position: fixed` resolves against the viewport again: the panel is set
 *   to true fullscreen (100vw x 100vh, square corners) — the "settings should be able
 *   to display fullscreen" ask, and it never depended on the 639px media query, so a
 *   mid-width landscape phone (CSS < 640) gets the same fixed layout.
 */
export const MOBILE_SETTINGS_CSS: string = `
  [class*="mobileDrawer"] [role='dialog'][aria-modal='true'] {
    width: 100vw;
    max-width: none;
    height: 100vh;
    max-height: none;
    border-radius: 0;
    flex-direction: column;
  }

  [class*="mobileDrawer"] [role='dialog'][aria-modal='true'] > nav {
    width: 100%;
    height: auto;
    flex: none;
    flex-direction: row;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    overflow-x: auto;
    border-right: none;
    border-bottom: 1px solid var(--dsw-alias-border-l1);
  }

  [class*="mobileDrawer"] [role='dialog'][aria-modal='true'] > nav > div:first-child {
    flex: none;
    padding: 0;
    white-space: nowrap;
  }

  [class*="mobileDrawer"] [role='dialog'][aria-modal='true'] > nav > div:nth-child(2) {
    flex-direction: row;
    gap: 4px;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
  }

  [class*="mobileDrawer"] [role='dialog'][aria-modal='true'] > nav > div:nth-child(2) > button {
    /* Review 2026-08-18: the original rule was an unclosed empty block since #2 and never
       applied. Completed by container semantics: the nav button container is
       flex-direction: row + overflow-x: auto, so buttons need flex: none to avoid being
       compressed and to scroll horizontally with the container. */
    flex: none;
  }

  /* Content column: flex:1 but min-height:auto would hold the options scroll area's
     full content height and overflow the panel; allow it to shrink so the options
     area scrolls inside. */
  [class*="mobileDrawer"] [role='dialog'][aria-modal='true'] > div:nth-child(2) {
    min-height: 0;
  }
`
