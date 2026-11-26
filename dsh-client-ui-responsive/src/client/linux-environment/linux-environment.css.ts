/** Layout and semantic styles for optional resources, downloads, and Linux tools. */
export const LINUX_ENVIRONMENT_CSS: string = `
[data-plugin='linux-environment'] {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 4px 0 12px;
}

.dsh-linux-panel {
  box-sizing: border-box;
  height: 100%;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 0 20px max(12px, env(safe-area-inset-bottom));
}

.dsh-linux-panel > [data-linux-environment] {
  max-width: 620px;
  margin-inline: auto;
  padding-top: 0;
}

.dsh-linux-panel-header {
  min-height: 52px;
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.dsh-linux-panel-header > h1 {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
}

.dsh-resource-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 64px;
  padding-block: 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  margin-bottom: 12px;
}

.dsh-resource-glyph {
  display: grid;
  place-items: center;
  inline-size: 32px;
  block-size: 32px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.dsh-resource-copy h2 {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
  font-weight: 600;
}

.dsh-resource-copy p {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.dsh-resource-size {
  font-variant-numeric: tabular-nums;
}

.dsh-resource-primary {
  justify-self: end;
  white-space: nowrap;
}

.dsh-resource-group-title {
  margin: 8px 0 2px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
}

.dsh-resource-section-transfer { padding-block: 2px 12px; }

.dsh-resource-back,
.dsh-resource-dismiss {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  inline-size: 32px;
  block-size: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  flex: none;
}

.dsh-resource-dismiss {
  inline-size: 28px;
  block-size: 28px;
}

.dsh-resource-back:focus-visible, .dsh-resource-dismiss:focus-visible {
  outline: 2px solid var(--dsw-alias-link);
  outline-offset: -2px;
}

.dsh-resource-download-button {
  display: inline-grid;
  place-items: center;
  position: relative;
  flex: 0 0 32px;
  min-width: 32px;
  min-height: 32px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-link);
  touch-action: manipulation;
  cursor: pointer;
}

.dsh-resource-primary,
.dsh-linux-uninstall-actions > button {
  position: relative;
}

.dsh-resource-primary::after,
.dsh-resource-back::after,
.dsh-resource-download-button::after,
.dsh-linux-uninstall-actions > button::after {
  content: '';
  position: absolute;
  inset: -4px 0;
}

.dsh-resource-download-button:focus-visible {
  outline: 2px solid var(--dsw-alias-link);
  outline-offset: -2px;
}

.dsh-resource-ring {
  display: inline-grid;
  position: relative;
  place-items: center;
  flex-shrink: 0;
  color: var(--dsw-alias-link);
}

.dsh-resource-ring > svg:first-child {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  stroke-width: 1.5;
  transform: rotate(-90deg);
}

.dsh-resource-ring-track { stroke: var(--dsw-alias-border-l3); }
.dsh-resource-ring-progress { stroke: currentColor; stroke-linecap: round; }
.dsh-resource-ring[data-state='paused'] { color: var(--dsw-alias-label-secondary); }
.dsh-resource-ring[data-state='failed'] { color: var(--dsw-alias-label-error, #b0252b); }

@media (prefers-reduced-motion: no-preference) {
  .dsh-resource-ring-progress[data-moving='true'] {
    transform-origin: 50% 50%;
    animation: dsh-resource-turn 1.4s linear infinite;
  }
}

@keyframes dsh-resource-turn { to { transform: rotate(1turn); } }

.dsh-resource-popover-layer {
  position: fixed;
  inset: 0;
  z-index: 1000;
}

.dsh-resource-popover-outside {
  position: absolute;
  inset: 0;
}

.dsh-resource-popover {
  box-sizing: border-box;
  position: absolute;
  width: min(316px, calc(100% - 32px));
  padding: 12px 16px 14px;
  overflow-y: auto;
  overscroll-behavior: contain;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent);
}

.dsh-resource-popover > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-inline-end: -6px;
  margin-bottom: 4px;
}

.dsh-resource-popover h2 {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
  font-weight: 600;
}

.dsh-resource-download-name {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 600;
}

.dsh-resource-transfer {
  display: grid;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}

.dsh-resource-transfer-status,
.dsh-resource-transfer-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.dsh-resource-transfer-footer > :last-child {
  color: var(--dsw-alias-label-primary);
}

.dsh-resource-transfer progress {
  width: 100%;
  height: 4px;
  overflow: hidden;
  border: 0;
  border-radius: 4px;
  accent-color: var(--dsw-alias-link);
}

.dsh-resource-transfer progress[value] { appearance: none; }
.dsh-resource-transfer progress[value]::-webkit-progress-bar {
  background: var(--dsw-alias-border-l3);
}
.dsh-resource-transfer progress[value]::-webkit-progress-value {
  border-radius: 4px;
  background: var(--dsw-alias-link);
}

.dsh-linux-env-header > span {
  display: grid;
  gap: 4px;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
}

.dsh-linux-env-header small,
.dsh-linux-env-hint,
.dsh-linux-env-status,
.dsh-linux-env-progress {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.dsh-linux-env-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  min-height: 48px;
  justify-content: space-between;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
}

.dsh-linux-env-status { padding-block: 12px 8px; }
.dsh-linux-env-hint { padding-block: 6px; }
.dsh-linux-env-progress { padding-block: 12px 4px; font-variant-numeric: tabular-nums; }
.dsh-linux-env-progress p { margin: 0 0 6px; }
.dsh-linux-env-progress progress { width: 100%; accent-color: var(--dsw-alias-link); }
.dsh-linux-env-actions { padding-block: 16px; }

.dsh-linux-uninstall-dialog[role='dialog'] {
  gap: 8px;
  padding: 20px 24px 22px;
  max-height: calc(100vh - max(24px, var(--dsh-frame-overlay-top, 24px)) - 24px);
  overflow-y: auto;
}

.dsh-linux-uninstall-dialog h2 {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
}

.dsh-linux-uninstall-dialog p {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 14px;
  line-height: 22px;
  overflow-wrap: anywhere;
}

.dsh-linux-uninstall-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}

.dsh-linux-uninstall-actions .dsh-resource-danger {
  color: var(--dsw-alias-state-error-primary);
}

.dsh-linux-env button.dsh-dev-btn,
.dsh-linux-terminal-tools > button:not(.dsh-linux-back),
.dsh-linux-tools button:not(.dsh-linux-env-link),
.dsh-linux-env-progress button,
.dsh-linux-env-error button {
  min-height: 44px;
  padding: 8px 14px;
  font-size: 13px;
  line-height: 20px;
}

.dsh-linux-env-row select {
  min-height: 34px;
  padding: 0 28px 0 10px;
  border: 1px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}

.dsh-linux-env-link {
  justify-content: space-between;
  min-height: 48px;
  padding: 0;
  border: 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: start;
  touch-action: manipulation;
}

@media (hover: hover) {
  .dsh-resource-back:hover, .dsh-resource-dismiss:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }

  .dsh-resource-download-button:hover,
  .dsh-linux-env-link:not(:disabled):not([data-linux-action='settings']):hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}

.dsh-linux-env-link:disabled { color: var(--dsw-alias-label-tertiary); }
.dsh-linux-env-link:focus-visible, .dsh-linux-env-row select:focus-visible {
  outline: 2px solid var(--dsw-alias-link);
  outline-offset: -2px;
}

.dsh-linux-diagnostics summary { cursor: pointer; }
.dsh-linux-diagnostics summary > :last-child { color: var(--dsw-alias-label-secondary); }
.dsh-linux-diagnostics summary > :last-child::after {
  content: '›';
  display: inline-block;
  margin-inline-start: 8px;
}
.dsh-linux-diagnostics[open] summary > :last-child::after { transform: rotate(90deg); }
.dsh-linux-diagnostics dl { margin: 0; padding: 8px 0; }
.dsh-linux-diagnostics dl > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.dsh-linux-diagnostics dd { margin: 0; overflow-wrap: anywhere; text-align: end; }

.dsh-linux-terminal {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.dsh-linux-terminal-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
}

.dsh-linux-terminal-tools > [role='status'] {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.dsh-linux-back {
  align-self: flex-start;
  flex: none;
  min-height: 40px;
  padding-inline: 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}

.dsh-linux-back:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-linux-back:focus-visible { outline: 2px solid var(--dsw-alias-link); }

[data-dsh-settings-depth='1'] .dsh-linux-back {
  display: none;
}

.dsh-linux-terminal-screen {
  box-sizing: border-box;
  height: clamp(156px, 58vh, 640px);
  height: clamp(112px, 58dvh, 640px);
  min-width: 0;
  padding: 8px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #f6f7f9);
  color: var(--dsw-alias-label-primary, #ecedf1);
  border: 1px solid var(--dsw-alias-border-l2);
  overflow: hidden;
}

.dsh-linux-terminal-keys {
  display: flex;
  gap: 6px;
  padding-block: 2px 4px;
  overflow-x: auto;
}

.dsh-linux-terminal-keys > button {
  flex: 1 0 auto;
  min-width: 38px;
  min-height: 44px;
  padding-inline: 9px;
  border: 0;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  touch-action: manipulation;
}

.dsh-linux-tools > button[data-dsh-settings-sublayer-back] { margin-bottom: 8px; }
.dsh-linux-tool-packages { margin: 0; padding: 0; list-style: none; max-height: 320px; overflow: auto; }

.dsh-linux-env-check {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.dsh-linux-env-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

@media (max-width: 359px) {
  .dsh-linux-panel { padding-inline: 16px; }
  .dsh-resource-row { grid-template-columns: minmax(0, 1fr) auto; }
  .dsh-resource-glyph { display: none; }
}

.dsh-linux-env-error {
  display: grid;
  gap: 8px;
  justify-items: start;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
}

.dsh-linux-env-error p {
  margin: 0;
  overflow-wrap: anywhere;
  /* 真因常是跨行的一条断言（含路径与动词），保留宿主给出的换行，不要折成一坨。 */
  white-space: pre-wrap;
}

.dsh-linux-env[data-phase='failed'] .dsh-linux-env-status {
  color: var(--dsw-alias-label-primary);
}

.dsh-linux-env[data-installed='true'] .dsh-linux-env-status {
  color: var(--dsw-alias-link);
}
`
