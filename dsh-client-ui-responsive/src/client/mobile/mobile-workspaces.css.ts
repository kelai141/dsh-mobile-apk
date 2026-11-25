/** Physical layout only; Sidebar retains the native row state and every content ancestor. */
export const MOBILE_WORKSPACES_CSS = `
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'] [data-dockkit-surface] { padding-top: 48px; box-sizing: border-box; }
/* Tracks and slots are declared here, not written inline: React owns the element style,
   and an inline grid left behind after a collapse laid the single pane out in row 3. */
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'] [data-dockkit-split] {
  min-height: 0; min-width: 0; background: var(--dsw-specific-sidebar-fill);
  grid-template-columns: var(--dsh-workspace-columns, minmax(0, 1fr)) !important;
  grid-template-rows: var(--dsh-workspace-rows, minmax(0, 1fr)) !important;
}
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'][data-dsh-workspace-orientation='horizontal'] [data-dockkit-split] > [data-dockkit-host='dock'][data-dsh-workspace-slot='0'] { grid-column: 1 !important; grid-row: 1 !important; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'][data-dsh-workspace-orientation='horizontal'] [data-dockkit-split] > [data-dockkit-host='dock'][data-dsh-workspace-slot='1'] { grid-column: 3 !important; grid-row: 1 !important; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'][data-dsh-workspace-orientation='vertical'] [data-dockkit-split] > [data-dockkit-host='dock'][data-dsh-workspace-slot='0'] { grid-column: 1 !important; grid-row: 1 !important; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'][data-dsh-workspace-orientation='vertical'] [data-dockkit-split] > [data-dockkit-host='dock'][data-dsh-workspace-slot='1'] { grid-column: 1 !important; grid-row: 3 !important; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'][data-dsh-workspace-orientation='horizontal'] [data-dockkit-split] > [data-dockkit-divider] { grid-column: 2 !important; grid-row: 1 !important; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'][data-dsh-workspace-orientation='vertical'] [data-dockkit-split] > [data-dockkit-divider] { grid-column: 1 !important; grid-row: 2 !important; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'] [data-dockkit-split] > [data-dockkit-host='dock']:not([hidden]) { display: flex; min-width: 0; min-height: 0; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'] [data-dockkit-host='dock'] > section { position: relative; display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; padding-top: var(--dsh-workspace-bar-height, 44px); box-sizing: border-box; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'] [data-dockkit-host='dock'] [class*='tabHostHeader'] { display: none; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'] [class*='tabHostBody'] { display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'] [data-dockkit-divider] { background: transparent; display: block; min-width: var(--dsh-divider-hit, 20px); min-height: var(--dsh-divider-hit, 20px); padding: 0; border: 0; touch-action: none !important; position: relative; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'][data-dsh-workspace-orientation='vertical'] [data-dockkit-divider] { width: 100%; height: var(--dsh-divider-hit, 20px); }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'][data-dsh-workspace-orientation='horizontal'] [data-dockkit-divider] { width: var(--dsh-divider-hit, 20px); height: 100%; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'] [data-dockkit-divider]::before { content: ''; position: absolute; background: var(--dsw-alias-label-tertiary, var(--dsw-alias-border-l4)); border-radius: 999px; box-shadow: none; opacity: .9; right: auto; bottom: auto; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'][data-dsh-workspace-orientation='vertical'] [data-dockkit-divider]::before { left: calc(50% - 24px); top: calc(50% - 2px); width: 48px; height: 4px; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'][data-dsh-workspace-orientation='horizontal'] [data-dockkit-divider]::before { left: calc(50% - 2px); top: calc(50% - 24px); width: 4px; height: 48px; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'] [data-dockkit-divider]:focus-visible { outline: none; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'] [data-dockkit-divider]:focus-visible::before,
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'] [data-dockkit-divider][data-dockkit-pointer]::before { background: var(--dsw-alias-label-primary); opacity: 1; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'] [data-dockkit-divider][data-dockkit-pointer]::before { box-shadow: 0 0 0 6px rgba(128, 128, 128, .18); }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'][data-dsh-workspace-orientation='vertical'] [data-dockkit-divider] { cursor: row-resize; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces='2'][data-dsh-workspace-orientation='horizontal'] [data-dockkit-divider] { cursor: col-resize; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-bar { position: absolute; inset: 0 0 auto; height: var(--dsh-workspace-bar-height, 44px); display: flex; align-items: flex-start; justify-content: center; padding: 0; color: var(--dsw-alias-label-secondary); background: transparent; pointer-events: none; z-index: 3; box-sizing: border-box; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-bar[hidden] { display: none; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-title { position: absolute; left: 52px; right: 52px; top: 14px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; line-height: 16px; font-weight: 500; opacity: 1; pointer-events: none; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-grip,
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-close { position: relative; box-sizing: border-box; border: 0; background: transparent; color: inherit; width: var(--dsh-workspace-bar-height, 44px); height: var(--dsh-workspace-bar-height, 44px); min-width: 36px; min-height: 36px; padding: 0; display: inline-flex; align-items: center; justify-content: center; pointer-events: auto; -webkit-tap-highlight-color: transparent; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-grip { cursor: grab; touch-action: none !important; margin-right: auto; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-grip::after { content: ''; position: absolute; width: 1px; height: 1px; overflow: hidden; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-grip span { display: block; width: 26px; height: 3px; border-radius: 999px; background: var(--dsh-bubble-pill-indicator); opacity: 1; box-shadow: none; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-grip[data-dockkit-pointer] { cursor: grabbing; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-grip[data-dockkit-pointer] span { box-shadow: 0 3px 10px rgba(0, 0, 0, .35); }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] [data-dsh-workspace-swap-target] { outline: 2px dashed var(--dsw-alias-link); outline-offset: -3px; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-close { margin-left: auto; font-size: 20px; font-weight: 300; opacity: 1; color: var(--dsw-alias-label-secondary); }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-close:hover { color: var(--dsw-alias-label-primary); }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-picker { position: absolute; inset: var(--dsh-workspace-bar-height, 44px) 0 0; overflow: auto; padding: 16px; background: transparent; color: var(--dsw-alias-label-primary); z-index: 2; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspace-choosing] > [class*='tabHostBody'] { visibility: hidden; pointer-events: none; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-picker p { margin: 0 0 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-picker button { display: block; width: 100%; min-height: 44px; margin: 7px 0; padding: 8px 14px; border: 0; border-radius: 22px; background: var(--dsw-alias-interactive-bg-hover); color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: inherit; text-align: start; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-picker button:disabled { background: var(--dsh-bubble-pill-bg); color: var(--dsh-bubble-pill-secondary); opacity: 1; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-picker-empty { margin: 8px 0 0; padding: 12px 14px; border-radius: 12px; background: var(--dsh-bubble-pill-bg); color: var(--dsh-bubble-pill-text); font-size: 13px; text-align: center; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-picker-note { margin: 0 0 8px; color: var(--dsh-bubble-pill-secondary); font-size: 12px; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-status { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); max-width: calc(100% - 32px); z-index: 100; pointer-events: none; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); border-radius: 999px; padding: 6px 12px; text-align: center; font-size: 12px; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-workspace-status:empty { display: none; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] .dsh-bubble-drag-ghost { position: fixed; z-index: 2147483001; pointer-events: none; margin: 0; transition: none; opacity: .95; }
/* The JS writes the measured title-bar bottom; 52px is the same value before the
   bubble header has mounted, so the first frame cannot expose the float to the bar. */
[data-sidebar-right-panel] { --dsh-dockkit-float-top: 52px; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] [data-dockkit-float-grip],
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] [data-dockkit-float-resize] { touch-action: none !important; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] [data-dockkit-float-grip] { min-height: 44px; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] [data-dockkit-float-grip] button { min-width: 44px; min-height: 44px; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] [data-dockkit-float-resize] { width: 44px !important; height: 44px !important; z-index: 5 !important; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-workspaces] [data-dockkit-float-resize]::after { opacity: .55; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-frame]:not([data-sidebar-collapsed]) [data-dockkit-float] { visibility: hidden !important; }
html[data-dsh-device-form='phone-landscape'] [data-dsh-workspaces] { --dsh-workspace-bar-height: 36px; }
html[data-dsh-device-form='phone-landscape'] [data-dsh-workspaces='2'] [data-dockkit-surface] { padding-top: 38px; }
html[data-dsh-device-form='phone-landscape'] [data-dsh-workspaces] .dsh-workspace-title { top: 10px; }
.dsh-workspace-drop-preview { position: fixed; z-index: 2147482999; pointer-events: none; box-sizing: border-box; border: 1.5px solid var(--dsw-alias-border-l2); border-radius: 12px; background: rgba(128,128,128,.12); color: var(--dsw-alias-label-primary); display: flex; align-items: center; justify-content: center; font-size: 13px; }
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-bubble-panel][data-dsh-workspace-orientation='vertical'] [data-dsh-bubble-action][data-dsh-mode-proxy] { display: none; }
`
