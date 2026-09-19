/**
 * Developer-options settings-page styles: reuse --dsw-* semantic tokens (auto light/dark), buttons in
 * a wrapping row layout; on narrow screens (mobile form) buttons become a two-column grid.
 * Injection matches mobile-settings.css.ts (style tag + data-plugin attribute; this page's root
 * selector uses [data-plugin='dev-section'] against class-hash churn).
 */
export const DEV_SECTION_CSS: string = `
[data-plugin='dev-section'] {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0 12px;
}

.dsh-dev-note {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary, #666);
}

.dsh-dev-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.dsh-dev-btn {
  min-height: 36px;
  padding: 6px 14px;
  border: 1px solid var(--dsw-alias-border-strong, #ccc);
  border-radius: 8px;
  background: var(--dsw-alias-bg-elevated, #fff);
  color: var(--dsw-alias-label-primary, #222);
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}

.dsh-dev-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.dsh-dev-danger {
  border-color: var(--dsw-alias-danger-fg, #c0392b);
  color: var(--dsw-alias-danger-fg, #c0392b);
}

.dsh-dev-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  padding: calc(20px + var(--dsh-mobile-top-inset, 0px)) 20px 20px;
}

.dsh-dev-modal {
  width: 100%;
  max-width: 360px;
  padding: 18px 20px;
  border: 1px solid var(--dsw-alias-border-strong, #ccc);
  border-radius: 12px;
  background: var(--dsw-alias-bg-elevated, #fff);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25);
}

.dsh-dev-modal-title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #222);
}

.dsh-dev-modal-desc {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary, #666);
}

.dsh-dev-modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.dsh-dev-switch {
  font-size: 14px;
  color: var(--dsw-alias-label-primary, #222);
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
}

.dsh-dev-switch input {
  width: 16px;
  height: 16px;
  margin: 0;
}

.dsh-screen-scope-row {
  justify-content: space-between;
  padding: 10px 0;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dsh-screen-scope-row > span {
  display: grid;
  gap: 4px;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
}
.dsh-screen-scope-row small {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-screen-scope-row select {
  min-height: 34px;
  max-width: min(100%, 190px);
  padding: 0 28px 0 10px;
  border: 1px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}

.dsh-screen-control-card {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-screen-control-header {
  display: flex;
  gap: 10px;
  justify-content: space-between;
  align-items: flex-start;
}
.dsh-screen-control-header > span:first-child {
  display: grid;
  gap: 4px;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
}
.dsh-screen-control-header small {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-screen-control-state {
  flex: 0 0 auto;
  padding: 3px 8px;
  border: 1px solid var(--dsw-alias-border-l4);
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-screen-control-state[data-state='ready'],
.dsh-screen-control-state[data-state='active'] {
  border-color: var(--dsw-specific-primary);
  color: var(--dsw-specific-primary);
}
.dsh-screen-control-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-screen-control-detail strong { color: var(--dsw-alias-label-primary); }

.dsh-dev-error {
  color: var(--dsw-specific-danger, #d33);
  font-size: 12px;
  line-height: 18px;
}

.dsh-dev-label {
  font-size: 14px;
  color: var(--dsw-alias-label-primary, #222);
  min-width: 64px;
}

.dsh-dev-value {
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, #666);
  min-width: 44px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.dsh-dev-row input[type='range'] {
  flex: 1;
  min-width: 120px;
}

.dsh-dev-hint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #666);
}

.dsh-dev-warn {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-danger-fg, #c0392b);
}

/* 0.14.1 块 E：运行时缓存清理块（清单行 + 跳过明细折叠）。标签一律为
 * $DSH_HOME/$DSH_FILES_DIR 形态，绝不出现应用私有目录的绝对路径。 */
.dsh-dev-cache {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l3, #e3e3e8);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, #fafafa);
}

.dsh-dev-cache-list {
  margin: 0;
  padding-left: 18px;
  max-height: 180px;
  overflow: auto;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #666);
  word-break: break-all;
}

/* 0.14.1 块J FIX-4：通知设置块（前台抑制 + 五类分类开关）。 */
.dsh-dev-notify {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l3, #e3e3e8);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, #fafafa);
}

.dsh-dev-notify-cats {
  display: grid;
  gap: 4px;
}

/* Dark-theme fallback (#43, 2026-08-18): in some environments --dsw-alias-bg-elevated is undefined
 * and falls back to #fff (white bg), while label-primary is white text in dark mode → white-on-white.
 * Provide explicit theme-consistent fallbacks for tokens that may not exist. */
@media (prefers-color-scheme: dark) {
  .dsh-dev-btn {
    background: var(--dsw-alias-bg-elevated, #26262b);
    color: var(--dsw-alias-label-primary, #f2f2f4);
    border-color: var(--dsw-alias-border-strong, #55555c);
  }
  .dsh-dev-note, .dsh-dev-hint {
    color: var(--dsw-alias-label-secondary, #c9c9cf);
  }
  .dsh-dev-warn {
    color: var(--dsw-alias-danger-fg, #ff9c9c);
  }
  .dsh-dev-danger {
    border-color: var(--dsw-alias-danger-fg, #ff9c9c);
    color: var(--dsw-alias-danger-fg, #ff9c9c);
  }
  .dsh-dev-modal {
    background: var(--dsw-alias-bg-elevated, #26262b);
    border-color: var(--dsw-alias-border-strong, #55555c);
  }
  .dsh-dev-modal-title {
    color: var(--dsw-alias-label-primary, #f2f2f4);
  }
  .dsh-dev-modal-desc {
    color: var(--dsw-alias-label-secondary, #c9c9cf);
  }
  .dsh-dev-cache {
    background: var(--dsw-alias-bg-layer-2, #26262b);
    border-color: var(--dsw-alias-border-l3, #3a3a42);
  }
  .dsh-dev-cache-list {
    color: var(--dsw-alias-label-secondary, #c9c9cf);
  }
  .dsh-dev-notify {
    background: var(--dsw-alias-bg-layer-2, #26262b);
    border-color: var(--dsw-alias-border-l3, #3a3a42);
  }
}

@media (max-width: 639px) {
  .dsh-dev-btn {
    flex: 1 1 calc(50% - 5px);
    text-align: center;
  }
}
`
