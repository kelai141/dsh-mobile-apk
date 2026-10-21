/** Physical layout only; Sidebar retains the native row state and every content ancestor. */
export const MOBILE_WORKSPACES_CSS = `
@media (max-width: 1100px) {
  [data-dsh-workspaces='2'] [data-dockkit-surface] { padding-top: 48px; box-sizing: border-box; }
  /* Tracks and slots are declared here, not written inline: React owns the element style,
     and an inline grid left behind after a collapse laid the single pane out in row 3. */
  [data-dsh-workspaces='2'] [data-dockkit-split] {
    min-height: 0; min-width: 0; background: var(--dsw-specific-sidebar-fill);
    grid-template-columns: var(--dsh-workspace-columns, minmax(0, 1fr)) !important;
    grid-template-rows: var(--dsh-workspace-rows, minmax(0, 1fr)) !important;
  }
  [data-dsh-workspaces='2'][data-dsh-workspace-orientation='horizontal'] [data-dockkit-split] > [data-dockkit-host='dock'][data-dsh-workspace-slot='0'] { grid-column: 1 !important; grid-row: 1 !important; }
  [data-dsh-workspaces='2'][data-dsh-workspace-orientation='horizontal'] [data-dockkit-split] > [data-dockkit-host='dock'][data-dsh-workspace-slot='1'] { grid-column: 3 !important; grid-row: 1 !important; }
  [data-dsh-workspaces='2'][data-dsh-workspace-orientation='vertical'] [data-dockkit-split] > [data-dockkit-host='dock'][data-dsh-workspace-slot='0'] { grid-column: 1 !important; grid-row: 1 !important; }
  [data-dsh-workspaces='2'][data-dsh-workspace-orientation='vertical'] [data-dockkit-split] > [data-dockkit-host='dock'][data-dsh-workspace-slot='1'] { grid-column: 1 !important; grid-row: 3 !important; }
  [data-dsh-workspaces='2'][data-dsh-workspace-orientation='horizontal'] [data-dockkit-split] > [data-dockkit-divider] { grid-column: 2 !important; grid-row: 1 !important; }
  [data-dsh-workspaces='2'][data-dsh-workspace-orientation='vertical'] [data-dockkit-split] > [data-dockkit-divider] { grid-column: 1 !important; grid-row: 2 !important; }
  [data-dsh-workspaces='2'] [data-dockkit-split] > [data-dockkit-host='dock']:not([hidden]) { display: flex; min-width: 0; min-height: 0; }
  [data-dsh-workspaces='2'] [data-dockkit-host='dock'] > section { position: relative; display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; padding-top: 44px; box-sizing: border-box; }
  [data-dsh-workspaces='2'] [data-dockkit-host='dock'] [class*='tabHostHeader'] { display: none; }
  [data-dsh-workspaces='2'] [class*='tabHostBody'] { display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
  [data-dsh-workspaces='2'] [data-dockkit-divider] { background: transparent; display: block; min-width: var(--dsh-divider-hit, 20px); min-height: var(--dsh-divider-hit, 20px); padding: 0; border: 0; touch-action: none !important; position: relative; }
  [data-dsh-workspaces='2'][data-dsh-workspace-orientation='vertical'] [data-dockkit-divider] { width: 100%; height: var(--dsh-divider-hit, 20px); }
  [data-dsh-workspaces='2'][data-dsh-workspace-orientation='horizontal'] [data-dockkit-divider] { width: var(--dsh-divider-hit, 20px); height: 100%; }
  [data-dsh-workspaces='2'] [data-dockkit-divider]::before { content: ''; position: absolute; background: var(--dsw-alias-border-l2); border-radius: 999px; box-shadow: none; }
  [data-dsh-workspaces='2'][data-dsh-workspace-orientation='vertical'] [data-dockkit-divider]::before { left: calc(50% - 18px); right: calc(50% - 18px); top: calc(50% - 1px); height: 2px; }
  [data-dsh-workspaces='2'][data-dsh-workspace-orientation='horizontal'] [data-dockkit-divider]::before { top: calc(50% - 18px); bottom: calc(50% - 18px); left: calc(50% - 1px); width: 2px; }
  [data-dsh-workspaces='2'] [data-dockkit-divider]:focus-visible { outline: none; }
  [data-dsh-workspaces='2'] [data-dockkit-divider]:focus-visible::before { background: var(--dsw-alias-label-primary); }
  [data-dsh-workspaces='2'][data-dsh-workspace-orientation='vertical'] [data-dockkit-divider] { cursor: row-resize; }
  [data-dsh-workspaces='2'][data-dsh-workspace-orientation='horizontal'] [data-dockkit-divider] { cursor: col-resize; }
  [data-dsh-workspaces] .dsh-workspace-bar { position: absolute; inset: 0 0 auto; height: 44px; display: flex; align-items: flex-start; justify-content: center; padding: 0; color: var(--dsw-alias-label-secondary); background: transparent; pointer-events: none; z-index: 3; box-sizing: border-box; }
  [data-dsh-workspaces] .dsh-workspace-bar[hidden] { display: none; }
  [data-dsh-workspaces] .dsh-workspace-title { position: absolute; left: 52px; right: 52px; top: 14px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; line-height: 16px; font-weight: 500; opacity: 1; pointer-events: none; }
  [data-dsh-workspaces] .dsh-workspace-grip, [data-dsh-workspaces] .dsh-workspace-close { position: relative; box-sizing: border-box; border: 0; background: transparent; color: inherit; width: 44px; height: 44px; min-width: 44px; min-height: 44px; padding: 0; display: inline-flex; align-items: center; justify-content: center; pointer-events: auto; -webkit-tap-highlight-color: transparent; }
  [data-dsh-workspaces] .dsh-workspace-grip { cursor: grab; touch-action: none !important; margin-right: auto; }
  [data-dsh-workspaces] .dsh-workspace-grip::after { content: ''; position: absolute; width: 1px; height: 1px; overflow: hidden; }
  [data-dsh-workspaces] .dsh-workspace-grip span { display: block; width: 26px; height: 3px; border-radius: 999px; background: var(--dsh-bubble-pill-indicator); opacity: 1; box-shadow: none; }
  [data-dsh-workspaces] .dsh-workspace-close { margin-left: auto; font-size: 20px; font-weight: 300; opacity: 1; color: var(--dsw-alias-label-secondary); }
  [data-dsh-workspaces] .dsh-workspace-close:hover { color: var(--dsw-alias-label-primary); }
  [data-dsh-workspaces] .dsh-workspace-picker { position: absolute; inset: 44px 0 0; overflow: auto; padding: 16px; background: transparent; color: var(--dsw-alias-label-primary); z-index: 2; }
  [data-dsh-workspace-choosing] > [class*='tabHostBody'] { visibility: hidden; pointer-events: none; }
  [data-dsh-workspaces] .dsh-workspace-picker p { margin: 0 0 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
  [data-dsh-workspaces] .dsh-workspace-picker button { display: block; width: 100%; min-height: 44px; margin: 7px 0; padding: 8px 14px; border: 0; border-radius: 22px; background: var(--dsw-alias-interactive-bg-hover); color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: inherit; text-align: start; }
  [data-dsh-workspaces] .dsh-workspace-picker button:disabled { background: var(--dsh-bubble-pill-bg); color: var(--dsh-bubble-pill-secondary); opacity: 1; }
  [data-dsh-workspaces] .dsh-workspace-picker-empty { margin: 8px 0 0; padding: 12px 14px; border-radius: 12px; background: var(--dsh-bubble-pill-bg); color: var(--dsh-bubble-pill-text); font-size: 13px; text-align: center; }
  [data-dsh-workspaces] .dsh-workspace-picker-note { margin: 0 0 8px; color: var(--dsh-bubble-pill-secondary); font-size: 12px; }
  [data-dsh-workspaces] .dsh-workspace-status { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); max-width: calc(100% - 32px); z-index: 100; pointer-events: none; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); border-radius: 999px; padding: 6px 12px; text-align: center; font-size: 12px; }
  [data-dsh-workspaces] .dsh-workspace-status:empty { display: none; }
  [data-dsh-workspaces] .dsh-bubble-drag-ghost { position: fixed; z-index: 2147483001; pointer-events: none; margin: 0; transition: none; opacity: .95; }
  /* The JS writes the measured title-bar bottom; 52px is the same value before the
     bubble header has mounted, so the first frame cannot expose the float to the bar. */
  [data-sidebar-right-panel] { --dsh-dockkit-float-top: 52px; }
  /* Mobile form pre-sets pan-y on every surface; a vertical press on the float header
     would become a scroll and Blink would cancel the pointer before it can move. */
  [data-dsh-workspaces] [data-dockkit-float-grip], [data-dsh-workspaces] [data-dockkit-float-resize] { touch-action: none !important; }
  [data-dsh-workspaces] [data-dockkit-float-grip] { min-height: 44px; }
  [data-dsh-workspaces] [data-dockkit-float-grip] button { min-width: 44px; min-height: 44px; }
  /* 20px was a hover-sized corner; touch needs a real target and a visible affordance. */
  /* The conversation composer paints above the corner in DOM order; lift the grip so a
     touch at the visible corner always starts the resize rather than focusing the input. */
  [data-dsh-workspaces] [data-dockkit-float-resize] { width: 44px !important; height: 44px !important; z-index: 5 !important; }
  [data-dsh-workspaces] [data-dockkit-float-resize]::after { opacity: .55; }
  /* Navigation drawers are modal on the phone form; the fixed float layer must not
     cover the session list or the back control the user is reaching for. */
  [data-dsh-frame]:not([data-sidebar-collapsed]) [data-dockkit-float] { visibility: hidden !important; }
}
.dsh-workspace-drop-preview { position: fixed; z-index: 2147482999; pointer-events: none; box-sizing: border-box; border: 1.5px solid var(--dsw-alias-border-l2); border-radius: 12px; background: rgba(128,128,128,.12); color: var(--dsw-alias-label-primary); display: flex; align-items: center; justify-content: center; font-size: 13px; }
@media (max-width: 1100px) { [data-dsh-bubble-panel][data-dsh-workspace-orientation='vertical'] [data-dsh-bubble-action][data-dsh-mode-proxy] { display: none; } }
`
