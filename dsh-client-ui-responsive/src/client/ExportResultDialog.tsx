/**
 * Export-result dialog: the `shell.overlay` entry that renders the Android
 * shell's session-export outcome. Pure component: state arrives through the
 * store share, dismissal through the bound action. The markup reuses the
 * web-ui dialog conventions (role=dialog / aria-modal) and the shared design
 * tokens, so the dialog matches the app's modal surfaces.
 */
import { useEffect } from 'react'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createExportResultStore } from './export-result.ts'
import css from './ExportResultDialog.module.css'

/** Composed props: root runtime share (unused) + the export-result store share. */
export type ExportResultDialogProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createExportResultStore>>

/** The single entry component; renders nothing while no result is open. */
export function ExportResultDialog({ useStore, actions }: ExportResultDialogProps) {
  const state = useStore(s => s)

  useEffect(() => {
    if (!state.open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') actions.close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [state.open, actions])

  if (!state.open) return null
  return (
    <div className={css.backdrop} onClick={() => actions.close()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsh-export-result-title"
        className={css.dialog}
        onClick={(event) => { event.stopPropagation() }}
      >
        <h2 id="dsh-export-result-title" className={css.title}>{state.title}</h2>
        <p className={css.detail} data-status={state.ok ? 'success' : 'error'}>{state.detail}</p>
        <div className={css.actions}>
          <button type="button" className={css.button} onClick={() => actions.close()}>关闭</button>
        </div>
      </div>
    </div>
  )
}
