/**
 * Mobile takeover of the upstream "open configuration file" settings action (apk #152).
 *
 * Upstream renders that action while the settings dialog is open and, on click, calls
 * `settings.openSettingsDocument()`: the Host materializes the provider-owned document and
 * hands it to a native desktop text editor (mac/win/linux). Android has no such opener, so the
 * click always ended in the localized 「无法打开配置文件」 error.
 *
 * The shell can open any path the app is allowed to read through its system chooser
 * (`androidBridge.openPathChooser`), and the settings document path is a fixed app-private
 * location the shell can report (`androidBridge.settingsPath`). This handler claims the click
 * while the settings dialog is up and routes it there; when either bridge is missing, or the
 * chooser refuses, the event is left alone so upstream behavior (and its error message) stays.
 */
import { chooserAvailable, openPathChooser } from './open-path.ts'

/** Upstream action labels this handler claims (zh / en dictionaries). */
const ACTION_LABELS = ['打开配置文件', 'Open configuration file']

/** Host bridge surface this handler needs beyond the path chooser. */
interface SettingsPathBridge {
  settingsPath?: () => string
}

/** Read the settings document path from the shell bridge; empty when unavailable. */
function settingsPath(): string {
  const bridge = (window as unknown as { androidBridge?: SettingsPathBridge }).androidBridge
  if (typeof bridge?.settingsPath !== 'function') return ''
  try {
    return bridge.settingsPath() || ''
  } catch {
    return ''
  }
}

/** Whether the clicked element is the upstream open-configuration-file action. */
function isSettingsDocumentAction(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const button = target.closest('button')
  if (button === null) return false
  // The settings dialog marker is set by the mobile form marker; the action lives in its header.
  if (button.closest('[data-dsh-settings-dialog]') === null) return false
  const label = (button.textContent ?? '').trim()
  return ACTION_LABELS.includes(label)
}

/** Claims the upstream action and opens the settings document through the shell chooser. */
export class SettingsDocumentAction {
  private readonly onClick = (event: MouseEvent): void => {
    if (!chooserAvailable()) return
    if (!isSettingsDocumentAction(event.target)) return
    const path = settingsPath()
    if (path === '') return
    // Claim only when the shell really took the path: a refusal keeps upstream's own error path.
    if (!openPathChooser(path, 'view').ok) return
    event.preventDefault()
    event.stopPropagation()
  }

  attach(): void {
    document.addEventListener('click', this.onClick, true)
  }

  detach(): void {
    document.removeEventListener('click', this.onClick, true)
  }
}
