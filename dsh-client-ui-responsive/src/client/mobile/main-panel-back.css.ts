/**
 * Skin for the injected main-panel back control (mobile/main-panel-back.ts).
 *
 * The page head (PluginManagerPage `.pageHead`) is a `space-between` flex row of
 * [title block, toolbar]. Our button becomes its first child, so the row needs three
 * adjustments on the phone:
 * - `justify-content: flex-start` stops the three items being spread across the row;
 * - the title block takes the remaining width (`flex: 1`, `min-width: 0`) so it
 *   truncates instead of pushing the toolbar past the edge;
 * - the toolbar stops being the `space-between` end and is pinned right by the title
 *   block's growth, which keeps the refresh button and "add plugin" at their own gap.
 *
 * AT 360px the row is the tightest case the phone form serves: the head measured
 * refresh [196,224] and add [240,336], i.e. a 16px gap with 24px of right padding.
 * The back control is therefore `flex: none` and sized to its content rather than
 * taking a share of the row, and the title block absorbs the squeeze (it wraps).
 */
export const MAIN_PANEL_BACK_CSS: string = `
@media (max-width: 767px) {
  html[data-dsh-mobile-form] [data-plugin-panel] > header[data-window-drag] {
    justify-content: flex-start;
    gap: 10px;
  }

  html[data-dsh-mobile-form] [data-plugin-panel] > header[data-window-drag] > div:first-of-type {
    flex: 1 1 auto;
    min-width: 0;
  }

  html[data-dsh-mobile-form] [data-dsh-main-panel-back] {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 2px;
    height: 28px;
    /* Aligns with the head's first text line rather than the row's top edge. */
    margin-top: 1px;
    padding: 0 8px 0 2px;
    border: 0;
    border-radius: var(--dsw-radius-md, 6px);
    background: transparent;
    color: var(--dsw-alias-label-tertiary);
    font-size: 13px;
    line-height: 28px;
    white-space: nowrap;
    cursor: pointer;
  }

  html[data-dsh-mobile-form] [data-dsh-main-panel-back]:hover,
  html[data-dsh-mobile-form] [data-dsh-main-panel-back]:focus-visible {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
}
`
