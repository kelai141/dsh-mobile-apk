/**
 * Export-result dialog store: the single transient in-app feedback surface
 * for the shell's session-export download. The shell pushes the outcome from
 * Kotlin through `window.__dshExportResult`; this store carries it into the
 * `shell.overlay` entry. Module level exports the factory only — a module-level
 * handle would pin store identity across plugin reloads.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Wire payload pushed by the Android shell (JSON-serializable only). */
export type ExportResultPayload = {
  ok: boolean
  title: string
  detail: string
}

/** Store state: one open dialog at a time; the latest result replaces the last. */
type ExportResultState = {
  open: boolean
  ok: boolean
  title: string
  detail: string
}

/** Annotation twin of the actions literal below (drift fails assignability). */
export type ExportResultActions = {
  show: (draft: ExportResultState, result: ExportResultPayload) => void
  close: (draft: ExportResultState) => void
}

/**
 * Create the export-result store handle. `show` replaces whatever dialog was
 * open, so a second export supersedes a still-open first result; `close` only
 * folds the dialog, never mutates the last result.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createExportResultStore(): EngineStoreHandle<ExportResultState, ExportResultActions> {
  return defineStore({
    init: (): ExportResultState => ({ open: false, ok: true, title: '', detail: '' }),
    actions: {
      show: (d, result) => {
        d.open = true
        d.ok = result.ok
        d.title = result.title
        d.detail = result.detail
      },
      close: (d) => {
        d.open = false
      },
    },
  })
}
