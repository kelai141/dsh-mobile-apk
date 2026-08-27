/**
 * Mobile settings-panel adaptation (dsh-client-ui-responsive issue #1).
 * The upstream settings modal is a fixed 800px two-column panel (188px nav
 * rail + content). On portrait phones the panel squeezes to the viewport but
 * the rail stays 188px wide, crushing the content to ~160px. Selectors key
 * off the dialog's ARIA attributes because CSS Modules class names are
 * hashed and unreachable from another plugin; scoped to the mobile breakpoint.
 */
export const MOBILE_SETTINGS_CSS: string = `
@media (max-width: 639px) {
  [role='dialog'][aria-modal='true']:has(> nav) {
    width: calc(100vw - 24px);
    max-width: calc(100vw - 24px);
    height: min(720px, calc(100vh - 24px));
    flex-direction: column;
  }

  [role='dialog'][aria-modal='true']:has(> nav) > nav {
    width: 100%;
    height: auto;
    flex-direction: row;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    overflow-x: auto;
    flex: none;
  }

  [role='dialog'][aria-modal='true']:has(> nav) > nav > div:first-child {
    flex: none;
    padding: 0;
    white-space: nowrap;
  }

  [role='dialog'][aria-modal='true']:has(> nav) > nav > div:nth-child(2) {
    flex-direction: row;
    gap: 4px;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
  }

  /* Content column: flex:1 but min-height:auto would hold the options
     scroll area's full content height and overflow the panel; allow it to
     shrink so the options area scrolls inside. */
  [role='dialog'][aria-modal='true']:has(> nav) > div:nth-child(2) {
    min-height: 0;
  }

  [role='dialog'][aria-modal='true']:has(> nav) > nav > div:nth-child(2) > button {
    /* Review 2026-08-18: the original rule was an unclosed empty block since #2 (two more opening
       than closing braces) and never applied. Completed by container semantics: the nav button
       container is flex-direction: row + overflow-x: auto, so buttons need flex: none to avoid being
       compressed and to scroll horizontally with the container. */
    flex: none;
  }
}
`
