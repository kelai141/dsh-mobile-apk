/** The preview owner supplies the resolved file path, including for cross-Session tabs. */
import { useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CardBridgeResult } from './file-card-actions.ts'
import type { PreviewExternalKey } from './preview-external.locales.ts'
import css from './PreviewExternalAction.module.css'

/** Inject only the existing chooser operation; the shell retains path and URI authorization. */
export interface PreviewExternalInjected {
  readonly openExternal: (path: string) => CardBridgeResult
}

type Props = PropsRuntime<'sidebar.right.tab.document.unpreviewable'>
  & PropsLocale<'androidPreviewExternal'> & InjectFace<PreviewExternalInjected>

/** A single file-scoped, localized result; a failed attempt never disables retry. */
function failureKey(result: CardBridgeResult): PreviewExternalKey {
  if (result.reason === 'unavailable') return 'unavailable'
  if (result.error === 'no-receiver') return 'noReceiver'
  if (result.error === 'io') return 'notReadable'
  if (result.error === 'uri-denied') return 'notAllowed'
  return 'failed'
}

/** Render in the owner's empty-state flow, without a viewport or orientation gate. */
export function PreviewExternalAction({ absolutePath, openExternal, t }: Props) {
  const [failure, setFailure] = useState<{ path: string; key: PreviewExternalKey }>()
  return (
    <div className={css.action} data-dsh-preview-external="">
      <button type="button" className={css.button} onClick={() => {
        const result = openExternal(absolutePath)
        setFailure(result.ok ? undefined : { path: absolutePath, key: failureKey(result) })
      }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 4h6v6M20 4l-9 9M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
        </svg>
        <span>{t('open')}</span>
      </button>
      <p className={css.failure} role="status">
        {failure?.path === absolutePath ? t(failure.key) : ''}
      </p>
    </div>
  )
}
