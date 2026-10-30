/**
 * Hide the upstream session-log-export modal on Android shell builds.
 *
 * The shell APK already owns the export result surface: MainActivity pushes
 * the final success/failure through `window.__dshExportResult`, and
 * `ExportResultDialog` renders it in `shell.overlay`. The upstream
 * `session-log-export` modal also opens (preparing -> success/error), so two
 * dialogs stack. The upstream CSS Module class names are hashed, so this
 * stylesheet targets the modal's stable ARIA attributes instead.
 *
 * ST-14: the `:has()` rules are the primary path (Chromium 105+); an old kernel
 * drops the whole rule as a syntax error — the exact shape of the #17 regression
 * the trajectory ledger already hit. So the companion class rules below are the
 * fallback path, applied by `SessionLogDialogObserver` only when
 * `CSS.supports('selector(:has(*))')` is false.
 *
 * #919: the modal's `aria-label` is the **status title**, and the three statuses
 * use three different titles. The old rule matched the shared `Session 导出` /
 * `Session export` prefix, which is a prefix of BOTH `Session 导出已开始下载`
 * (success) and `Session 导出失败` (error) — so the error modal was hidden too.
 * When the engine's HEAD precheck fails it publishes only that error modal, so
 * the user saw nothing at all: no dialog, no file, no chooser, no log line.
 * The rule now lists the exact per-status titles, and the error state is hidden
 * **only** while the shell has already reported an outcome of its own — an
 * event-driven fact, never a timer.
 */

/** Class the fallback path toggles on the modal's `[role=presentation]` (or the dialog itself). */
export const SESSION_LOG_DIALOG_HIDE_CLASS = 'dsh-mobile-hide-session-log-dialog'

/** `<html>` attribute set while the shell's own export-result dialog owns the outcome. */
export const SHELL_OUTCOME_ATTR = 'data-dsh-export-outcome-shown'

/**
 * Upstream status titles hidden **unconditionally**: the in-flight `preparing`
 * state and the `success` state. Both are fully covered by the shell's own
 * surface, so leaving them visible only stacks a second dialog.
 * The `error` titles are deliberately absent (#919). Localized; keep in one place.
 */
export const SESSION_LOG_DIALOG_HIDE_LABEL_PREFIXES: readonly string[] = [
  '正在导出 Session',
  'Exporting Session',
  'Session 导出已开始下载',
  'Session download started',
]

/**
 * Upstream `error` status titles. #919 keeps these visible: when the engine
 * refuses the export they are the user's only feedback. Hidden only while the
 * shell's own result dialog is showing, so the two never stack.
 */
export const SESSION_LOG_DIALOG_ERROR_LABEL_PREFIXES: readonly string[] = [
  'Session 导出失败',
  'Session export failed',
]

/** Every upstream title this plugin knows about (hidden or kept). */
export const SESSION_LOG_DIALOG_LABEL_PREFIXES: readonly string[] = [
  ...SESSION_LOG_DIALOG_HIDE_LABEL_PREFIXES,
  ...SESSION_LOG_DIALOG_ERROR_LABEL_PREFIXES,
]

const selectors = (prefixes: readonly string[], scope = ''): string =>
  prefixes
    .map((prefix) => `${scope}[role="presentation"]:has([role="dialog"][aria-label^="${prefix}"])`)
    .join(',\n')

/** 无条件隐藏的选择器串（在模板外拼好：模板里带 ${} 会让花括号计数门禁误判）。 */
const HIDE_SELECTORS: string = selectors(SESSION_LOG_DIALOG_HIDE_LABEL_PREFIXES)

/** error 状态的选择器串：作用域到「壳侧已接管结论」这一个事实标记上。 */
const ERROR_SELECTORS: string = selectors(
  SESSION_LOG_DIALOG_ERROR_LABEL_PREFIXES,
  'html[' + SHELL_OUTCOME_ATTR + '] ',
)

export const SESSION_LOG_DIALOG_HIDE_CSS: string = `
/* 1) preparing / success: the shell's own surface always covers these. */
${HIDE_SELECTORS} {
  display: none !important;
}

/* 2) error (#919): visible by default — it is the user's only feedback when the
   engine's precheck refuses the export. Hidden only once the shell reported an
   outcome of its own. */
${ERROR_SELECTORS} {
  display: none !important;
}

/* ST-14 fallback for kernels without :has(); SessionLogDialogObserver applies the
   class using the same two predicates as rules 1 and 2. */
[role="presentation"].${SESSION_LOG_DIALOG_HIDE_CLASS},
[role="dialog"].${SESSION_LOG_DIALOG_HIDE_CLASS} {
  display: none !important;
}
`
