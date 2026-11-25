/** Desktop-landscape toolbar [↗] action slot over previewable & unpreviewable documents. */
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { FILE_ACTION_TRIGGER_ICON } from './sidebar-file-actions.ts'

export interface DocumentExternalMenuInjected {
  readonly openMenu: (anchor: HTMLElement, path: string) => void
}

type Props = PropsRuntime<'sidebar.right.tab.document.actions'>
  & PropsLocale<'androidSidebarFileActions'> & InjectFace<DocumentExternalMenuInjected>

/** Renders the monochrome [↗] menu trigger in the document preview toolbar (hidden outside desktop-landscape / split / float). */
export function DocumentExternalMenuAction({ absolutePath, openMenu, t }: Props) {
  const label = t('trigger')
  return (
    <button
      type="button"
      className="dsh-doc-action-trigger"
      data-dsh-doc-action-trigger=""
      aria-haspopup="menu"
      aria-expanded="false"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        openMenu(event.currentTarget, absolutePath)
      }}
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={FILE_ACTION_TRIGGER_ICON} />
      </svg>
    </button>
  )
}
