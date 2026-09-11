// @vitest-environment jsdom
// SettingsDocumentAction: claims the upstream open-configuration-file action on mobile and
// routes it to the shell chooser; every missing bridge or refusal keeps upstream behavior.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SettingsDocumentAction } from '../src/client/mobile/settings-document.ts'

let action: SettingsDocumentAction
let dialog: HTMLElement
let button: HTMLButtonElement

beforeEach(() => {
  dialog = document.createElement('div')
  dialog.setAttribute('data-dsh-settings-dialog', '')
  button = document.createElement('button')
  button.textContent = '打开配置文件'
  dialog.appendChild(button)
  document.body.appendChild(dialog)
  action = new SettingsDocumentAction()
})

afterEach(() => {
  action.detach()
  dialog.remove()
  delete (window as unknown as { androidBridge?: unknown }).androidBridge
})

/** Install a shell bridge with the given chooser answer. */
function bridge(answer: string, path = '/data/data/pkg/files/home/.dsh/settings.yaml') {
  const openPathChooser = vi.fn(() => answer)
  const settingsPath = vi.fn(() => path)
  ;(window as unknown as { androidBridge: unknown }).androidBridge = { openPathChooser, settingsPath }
  return { openPathChooser, settingsPath }
}

describe('SettingsDocumentAction', () => {
  it('claims the click and opens the settings document through the shell chooser', () => {
    const { openPathChooser } = bridge('{"ok":true}')
    action.attach()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    button.dispatchEvent(event)
    expect(openPathChooser).toHaveBeenCalledWith('/data/data/pkg/files/home/.dsh/settings.yaml', 'view')
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves the event alone when the chooser refuses (upstream error path stays)', () => {
    bridge('{"ok":false,"reason":"no-handler"}')
    action.attach()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('ignores the action outside the settings dialog', () => {
    const { openPathChooser } = bridge('{"ok":true}')
    const loose = document.createElement('button')
    loose.textContent = '打开配置文件'
    document.body.appendChild(loose)
    action.attach()
    loose.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(openPathChooser).not.toHaveBeenCalled()
    loose.remove()
  })

  it('stays inert without the shell bridge', () => {
    action.attach()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    expect(() => button.dispatchEvent(event)).not.toThrow()
    expect(event.defaultPrevented).toBe(false)
  })

  it('detach stops claiming', () => {
    const { openPathChooser } = bridge('{"ok":true}')
    action.attach()
    action.detach()
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(openPathChooser).not.toHaveBeenCalled()
  })
})
