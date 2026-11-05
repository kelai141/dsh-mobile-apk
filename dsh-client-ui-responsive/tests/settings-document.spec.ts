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

// ── 0.14.1 批 9（§3.3 S3-20）：打开的是**副本**必须说明，否则用户以为改的是真源 ──
describe('打开配置文件时说明「这是副本」（S3-20）', () => {
  it('走导出副本路径时给出说明（含「改完要导入」的下一步）', () => {
    const events: CustomEvent[] = []
    const listener = (e: Event): void => { events.push(e as CustomEvent) }
    window.addEventListener('dsh:export-result', listener)
    // 注意：文件既有的 bridge() 工厂**返回的对象与挂到 window 的不是同一个**（各建一次字面量），
    // 所以这里自己装一份完整桥（首版在返回值上加方法，没生效——测试自身的坑）。
    ;(window as unknown as { androidBridge: unknown }).androidBridge = {
      openPathChooser: vi.fn(() => '{"ok":true}'),
      settingsPath: vi.fn(() => '/data/data/pkg/files/home/.dsh/settings.yaml'),
      exportSettingsDocument: vi.fn(() => '/storage/emulated/0/Documents/dshdata/exports/config/settings.yaml'),
    }
    action.attach()
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    window.removeEventListener('dsh:export-result', listener)
    expect(events.length, '必须发出一条用户可见说明').toBe(1)
    expect(String(events[0].detail.title)).toContain('副本')
    expect(String(events[0].detail.detail)).toContain('导入配置')
  })
})

// ── 2026-10-25：观察器只在「变更碰到设置对话框」时扫按钮 ──
// 背景：此前的加固（PR #559）用 textContent 早退 + queueMicrotask 合帧，实测两条都不成立
// （按钮隐藏后文案仍在 DOM，判据恒真；MutationObserver 本就按任务合并）。这里换成作用域判据，
// 并给每条判据配一条能在旧实现下变红的用例。
describe('隐藏上游按钮的扫描范围', () => {
  /** 等观察器回调（微任务）落地。 */
  const settle = (): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

  it('挂上即隐藏表头按钮，并打上已处理标记', async () => {
    action.attach()
    await settle()
    expect(button.style.display).toBe('none')
    expect(button.dataset.dshSettingsDocHidden).toBe('1')
  })

  it('对话框外的变更不触发按钮扫描（聊天流式输出那条路径）', async () => {
    action.attach()
    await settle()
    const spy = vi.spyOn(dialog, 'querySelectorAll')
    // 模拟聊天流式输出：对话框外部持续追加节点
    for (let i = 0; i < 20; i += 1) {
      const chunk = document.createElement('div')
      chunk.textContent = 'stream ' + i
      document.body.appendChild(chunk)
    }
    await settle()
    expect(spy, '对话框外的变更不得扫描按钮').not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('对话框内重建表头按钮时仍然隐藏（切换分区）', async () => {
    action.attach()
    await settle()
    const rebuilt = document.createElement('button')
    rebuilt.textContent = '打开配置文件'
    dialog.appendChild(rebuilt)
    await settle()
    expect(rebuilt.style.display, '分区切换后新表头按钮必须继续被隐藏').toBe('none')
  })
})
