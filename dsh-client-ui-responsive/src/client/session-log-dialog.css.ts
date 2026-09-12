/**
 * Hide the upstream session-log-export modal on Android shell builds.
 *
 * The shell APK already owns the export result surface: MainActivity pushes
 * the final success/failure through `window.__dshExportResult`, and
 * `ExportResultDialog` renders it in `shell.overlay`. The upstream
 * `session-log-export` modal also opens (preparing → success/error), so two
 * dialogs stack. The upstream CSS Module class names are hashed, so this
 * stylesheet targets the modal's stable ARIA attributes instead.
 *
 * ST-14: the `:has()` rules are the primary path (Chromium 105+); an old kernel
 * drops the whole rule as a syntax error — the exact shape of the #17 regression
 * the trajectory ledger already hit. So the companion class rules below are the
 * fallback path, applied by `SessionLogDialogObserver` only when
 * `CSS.supports('selector(:has(*))')` is false.
 */

/** Class the fallback path toggles on the modal's `[role=presentation]` (or the dialog itself). */
export const SESSION_LOG_DIALOG_HIDE_CLASS = 'dsh-mobile-hide-session-log-dialog'

/** ARIA labels the upstream export modal opens with (localized; keep in one place). */
export const SESSION_LOG_DIALOG_LABEL_PREFIXES: readonly string[] = [
  '正在导出 Session',
  'Session 导出',
  'Exporting Session',
  'Session download',
  'Session export',
]

export const SESSION_LOG_DIALOG_HIDE_CSS: string = `
[role="presentation"]:has([role="dialog"][aria-label^="正在导出 Session"]),
[role="presentation"]:has([role="dialog"][aria-label^="Session 导出"]),
[role="presentation"]:has([role="dialog"][aria-label^="Exporting Session"]),
[role="presentation"]:has([role="dialog"][aria-label^="Session download"]),
[role="presentation"]:has([role="dialog"][aria-label^="Session export"]) {
  display: none !important;
}

/* ST-14 兜底路径（旧内核无 :has()）：由 SessionLogDialogObserver 打 class。 */
[role="presentation"].${SESSION_LOG_DIALOG_HIDE_CLASS},
[role="dialog"].${SESSION_LOG_DIALOG_HIDE_CLASS} {
  display: none !important;
}
`
