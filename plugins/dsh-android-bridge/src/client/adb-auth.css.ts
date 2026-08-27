/** 安卓调试授权分区样式（与 DevSection 同名模式：data-plugin 样式，组件按类名取用）。 */
export const ADB_AUTH_CSS = `
.adb-auth { flex-direction: column; width: 100%; display: flex; gap: 0 }
.adb-auth-note { color: var(--gray-5, #8a8f98); font-size: 0.82rem; line-height: 1.5; margin: 0.25rem 0 0.75rem }
.adb-auth-tier {
  display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 0.75rem;
  border-radius: 8px; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.75rem;
}
.adb-auth-tier-ok { background: rgba(50, 160, 110, 0.12); color: #2f9e68 }
.adb-auth-tier-bad { background: rgba(200, 120, 50, 0.12); color: #b96a2a }
.adb-auth-tier-sub { font-weight: 400; color: var(--gray-5, #8a8f98) }
.adb-auth-gate {
  display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
  padding: 0.6rem 0.75rem; border-top: 1px solid var(--border-color, rgba(128,128,128,.18));
}
.adb-auth-gate-main { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0 }
.adb-auth-gate-title { font-size: 0.88rem; font-weight: 500 }
.adb-auth-gate-desc { font-size: 0.75rem; color: var(--gray-5, #8a8f98); line-height: 1.4 }
.adb-auth-chip {
  flex-shrink: 0; font-size: 0.72rem; padding: 0.15rem 0.5rem; border-radius: 999px;
  border: 1px solid currentColor; white-space: nowrap;
}
.adb-auth-chip-ok { color: #2f9e68 }
.adb-auth-chip-bad { color: #b96a2a }
.adb-auth-btn {
  flex-shrink: 0; font-size: 0.78rem; padding: 0.3rem 0.7rem; border-radius: 6px;
  border: 1px solid var(--border-color, rgba(128,128,128,.4)); background: transparent;
  color: inherit; cursor: pointer;
}
.adb-auth-btn:disabled { opacity: 0.5; cursor: default }
.adb-auth-btn-danger { color: #c0392b; border-color: rgba(192, 57, 43, 0.45) }
.adb-auth-switch-row {
  display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.75rem;
  border-top: 1px solid var(--border-color, rgba(128,128,128,.18)); cursor: pointer;
}
.adb-auth-switch-row input { width: 1.1rem; height: 1.1rem; accent-color: #2f9e68 }
.adb-auth-pair {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem;
  padding: 0.6rem 0.75rem;
  border-top: 1px solid var(--border-color, rgba(128,128,128,.18));
}
.adb-auth-input {
  font-size: 0.9rem; letter-spacing: 0.3em; padding: 0.3rem 0.5rem; width: 7.5rem;
  border: 1px solid var(--border-color, rgba(128,128,128,.4)); border-radius: 6px;
  background: transparent; color: inherit; min-width: 0; box-sizing: border-box;
}
.adb-auth-input-port {
  font-size: 0.8rem; letter-spacing: 0.05em; width: 5.6rem; flex: 1 1 5.6rem;
  padding: 0.3rem 0.4rem;
}
/* 2026-08-24 真机窄屏溢出修复：输入+按钮允许换行；「自动扫描端口」与「配对」按钮整行排布 */
.adb-auth-pair .adb-auth-btn { flex: 1 1 auto; text-align: center; white-space: nowrap }
.adb-auth-error { color: #c0392b; font-size: 0.78rem; margin: 0.5rem 0.75rem 0 }
.adb-auth-ok { color: #2f9e68; font-size: 0.78rem; margin: 0.5rem 0.75rem 0 }
.adb-auth-actions { display: flex; gap: 0.5rem; padding: 0.4rem 0.75rem 0.75rem }
.adb-auth-modal-overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 1000;
  display: flex; align-items: center; justify-content: center; padding: 1rem;
}
.adb-auth-modal {
  background: var(--color-elevated, #26262b); color: var(--color-text, #e8e8ea);
  border: 1px solid var(--border-color, rgba(128,128,128,.35)); border-radius: 10px;
  padding: 1rem; max-width: 22rem; width: 100%;
}
.adb-auth-modal-title { font-size: 0.95rem; font-weight: 600; margin: 0 0 0.5rem }
.adb-auth-modal-desc { font-size: 0.82rem; line-height: 1.55; margin: 0 0 0.9rem; color: var(--gray-5, #8a8f98) }
.adb-auth-modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem }
`
