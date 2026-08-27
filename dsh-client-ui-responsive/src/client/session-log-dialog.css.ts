/**
 * Hide the upstream session-log-export modal on Android shell builds.
 *
 * The shell APK already owns the export result surface: MainActivity pushes
 * the final success/failure through `window.__dshExportResult`, and
 * `ExportResultDialog` renders it in `shell.overlay`. The upstream
 * `session-log-export` modal also opens (preparing → success/error), so two
 * dialogs stack. The upstream CSS Module class names are hashed, so this
 * stylesheet targets the modal's stable ARIA attributes instead.
 */
export const SESSION_LOG_DIALOG_HIDE_CSS: string = `
[role="presentation"]:has([role="dialog"][aria-label^="正在导出 Session"]),
[role="presentation"]:has([role="dialog"][aria-label^="Session 导出"]),
[role="presentation"]:has([role="dialog"][aria-label^="Exporting Session"]),
[role="presentation"]:has([role="dialog"][aria-label^="Session download"]),
[role="presentation"]:has([role="dialog"][aria-label^="Session export"]) {
  display: none !important;
}
`
