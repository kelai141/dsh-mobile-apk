/**
 * 「Linux环境」设置分区样式：只复用壳侧已有的语义令牌与 `.dsh-dev-btn` 按钮骨架
 * （由 dev-section 样式表提供），本表只补布局与状态色。
 */
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
  padding: 0 16px max(12px, env(safe-area-inset-bottom));
}

.dsh-linux-panel > [data-linux-environment] {
  max-width: 620px;
  margin-inline: auto;
  padding-top: 0;
}

.dsh-linux-panel-header {
  min-height: 56px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.dsh-linux-panel-header > h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.dsh-resource-intro {
  display: grid;
  gap: 16px;
  margin-block: 8px 12px;
  padding: 18px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-2);
}

.dsh-resource-intro-heading {
  display: flex;
  align-items: start;
  gap: 12px;
}

.dsh-resource-glyph {
  display: grid;
  place-items: center;
  flex: 0 0 38px;
  block-size: 38px;
  border-radius: 10px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.dsh-resource-intro-heading h2 {
  margin: 0 0 3px;
  color: var(--dsw-alias-label-primary);
  font-size: 17px;
  line-height: 24px;
  font-weight: 600;
}

.dsh-resource-intro p {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.dsh-resource-intro .dsh-resource-size {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.dsh-resource-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.dsh-resource-intro > button {
  justify-self: start;
}

.dsh-resource-back,
.dsh-resource-link-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  min-width: 44px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.dsh-resource-back:hover, .dsh-resource-link-button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.dsh-resource-back:focus-visible, .dsh-resource-link-button:focus-visible {
  outline: 2px solid var(--dsw-alias-link);
  outline-offset: -2px;
}

.dsh-resource-download-button {
  display: inline-grid;
  place-items: center;
  flex: 0 0 44px;
  min-width: 44px;
  min-height: 44px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-link);
  touch-action: manipulation;
  cursor: pointer;
}

.dsh-resource-download-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
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
  stroke-width: 2;
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
  background: color-mix(in srgb, var(--dsw-alias-bg-mask-1) 45%, transparent);
}

.dsh-resource-popover {
  box-sizing: border-box;
  position: absolute;
  width: min(350px, calc(100vw - 24px));
  padding: 10px 16px 12px;
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent);
}

.dsh-resource-popover > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-inline-end: -6px;
  margin-bottom: 8px;
}

.dsh-resource-popover h2 {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 15px;
  line-height: 1.45;
  font-weight: 600;
}

.dsh-resource-transfer {
  display: grid;
  gap: 8px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.dsh-resource-transfer-status,
.dsh-resource-transfer-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.dsh-resource-transfer-status {
  color: var(--dsw-alias-label-primary);
}

.dsh-resource-transfer-status strong { font-weight: 550; }
.dsh-resource-transfer-footer button { margin-inline-start: auto; }
.dsh-resource-transfer-footer p {
  margin: 0;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}

.dsh-resource-transfer progress {
  width: 100%;
  height: 5px;
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

.dsh-linux-env button.dsh-dev-btn,
.dsh-linux-panel-header > button,
.dsh-linux-terminal-tools > button:not(.dsh-linux-back),
.dsh-linux-tools button:not(.dsh-linux-env-link),
.dsh-linux-env-progress button,
.dsh-linux-env-error button {
  min-height: 44px;
  padding: 8px 14px;
  font-size: 13px;
  line-height: 20px;
}

.dsh-linux-env .dsh-linux-env-primary:not(:disabled) {
  background: var(--dsw-alias-button-primary-fill, #162035);
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font-weight: 600;
}

.dsh-linux-env .dsh-linux-env-primary:not(:disabled):hover {
  background: var(--dsw-alias-button-primary-hover, #303b50);
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
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: start;
  touch-action: manipulation;
}

.dsh-linux-env-link:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); }
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

.dsh-linux-env-actions > button.dsh-dev-btn {
  flex: 0 1 auto;
  width: auto;
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
