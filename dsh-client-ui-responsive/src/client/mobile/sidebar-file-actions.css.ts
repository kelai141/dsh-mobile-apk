/** Right-sidebar header [↗] light menu & desktop document toolbar trigger styles. */
export const SIDEBAR_FILE_ACTIONS_CSS = `
.dsh-bubble-trailing {
  flex: none;
  display: inline-flex;
  align-items: center;
}
.dsh-bubble-trailing:empty {
  display: none;
}
.dsh-file-action-trigger,
.dsh-doc-action-trigger {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.dsh-doc-action-trigger {
  width: 28px;
  height: 28px;
}
.dsh-file-action-trigger svg,
.dsh-doc-action-trigger svg {
  width: 17px;
  height: 17px;
  flex: none;
}
.dsh-file-action-trigger:hover,
.dsh-file-action-trigger[aria-expanded='true'],
.dsh-doc-action-trigger:hover,
.dsh-doc-action-trigger[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
html[data-dsh-device-form='phone-landscape'] [data-dsh-bubble-panel] .dsh-file-action-trigger {
  width: 34px;
  height: 34px;
}
html[data-dsh-device-form='phone-landscape'] [data-dsh-bubble-panel] .dsh-file-action-trigger svg {
  width: 16px;
  height: 16px;
}
/* Desktop document toolbar button only appears in desktop-landscape main pane, never in splits, floats, or compact forms. */
html:not([data-dsh-device-form='desktop-landscape']) [data-dsh-doc-action-trigger] {
  display: none !important;
}
[data-dockkit-host='float'] [data-dsh-doc-action-trigger] {
  display: none !important;
}
[data-dsh-workspaces='2'] [data-dsh-doc-action-trigger] {
  display: none !important;
}
.dsh-file-action-menu {
  position: fixed;
  z-index: 2147483002;
  min-width: 184px;
  max-width: min(260px, calc(100vw - 24px));
  padding: 6px;
  box-sizing: border-box;
  border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .22));
  background: var(--dsw-alias-bg-layer-2, var(--dsw-specific-sidebar-fill, #1f1f1f));
  color: var(--dsw-alias-label-primary, #f3f3f3);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .28);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dsh-file-action-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 8px 12px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13.5px;
  line-height: 1.3;
  text-align: start;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.dsh-file-action-item:hover,
.dsh-file-action-item:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, .16));
  outline: none;
}
.dsh-file-action-item svg {
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--dsw-alias-label-secondary, currentColor);
}
.dsh-file-action-toast {
  position: fixed;
  left: 50%;
  bottom: max(72px, calc(var(--dsh-android-system-bottom, 0px) + 56px));
  transform: translateX(-50%);
  z-index: 2147483003;
  max-width: min(320px, calc(100vw - 32px));
  padding: 8px 14px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .22));
  background: var(--dsw-alias-bg-layer-2, var(--dsw-specific-sidebar-fill, #242424));
  color: var(--dsw-alias-label-primary, #f3f3f3);
  font-size: 12.5px;
  line-height: 1.35;
  text-align: center;
  box-shadow: 0 4px 16px rgba(0, 0, 0, .24);
  pointer-events: none;
}
`
