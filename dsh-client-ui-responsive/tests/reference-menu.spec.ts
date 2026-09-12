// @vitest-environment jsdom
// ReferenceMenuEnhancer (apk #163): checkbox multi-select, folder-body drill, file-body pass-through.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ReferenceMenuEnhancer } from '../src/client/mobile/reference-menu.ts'

let enhancer: ReferenceMenuEnhancer
let menu: HTMLElement
let editable: HTMLElement

/** Build the upstream menu shape: a listbox with one directory row and one file row. */
function buildMenu(): void {
  menu = document.createElement('div')
  menu.setAttribute('data-trigger-menu', '')
  const list = document.createElement('div')
  list.setAttribute('role', 'listbox')
  for (const [label, directory] of [['sub/', true], ['alpha.txt', false]] as const) {
    const row = document.createElement('button')
    row.setAttribute('role', 'option')
    const name = document.createElement('span')
    name.className = 'x_itemName'
    name.textContent = label
    row.appendChild(name)
    if (directory) {
      const drill = document.createElement('span')
      drill.setAttribute('role', 'button')
      row.appendChild(drill)
    }
    list.appendChild(row)
  }
  menu.appendChild(list)
  document.body.appendChild(menu)
}

/** Let the enhancer's rAF pass run. */
function flush(): Promise<void> {
  return new Promise((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }) })
}

beforeEach(async () => {
  // 本增强层是**移动形态专用**（#169-4 要求加门）：测试必须站在移动形态里，
  // 否则注入被门拦掉——这正是门生效的证明。
  document.documentElement.setAttribute('data-dsh-mobile-form', '')
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  editable = document.createElement('div')
  editable.setAttribute('contenteditable', 'true')
  card.appendChild(editable)
  document.body.appendChild(card)
  buildMenu()
  enhancer = new ReferenceMenuEnhancer()
  enhancer.attach()
  await flush()
})

afterEach(() => {
  enhancer.detach()
  document.documentElement.removeAttribute('data-dsh-mobile-form')
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('ReferenceMenuEnhancer', () => {
  it('adds a leading checkbox to every row', () => {
    expect(document.querySelectorAll('[data-dsh-ref-check]')).toHaveLength(2)
  })

  it('toggling the checkbox renders the multi-select action bar', () => {
    const box = document.querySelector('[data-dsh-ref-check]') as HTMLInputElement
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    box.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(document.querySelector('[data-dsh-ref-bar]')?.textContent).toContain('已选 1 项')
  })

  it('claims the checkbox gesture before upstream settle-pick', () => {
    const upstream = vi.fn()
    document.querySelector('[role="listbox"]')!.addEventListener('mousedown', upstream)
    const box = document.querySelector('[data-dsh-ref-check]')!
    box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(upstream).not.toHaveBeenCalled()
  })

  it('leaves a directory row body to upstream (the F6 engine patch owns drilling)', () => {
    const dirRow = document.querySelectorAll('[role="option"]')[0]!
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    dirRow.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves a file row body to upstream', () => {
    const fileRow = document.querySelectorAll('[role="option"]')[1]!
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    fileRow.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('detach removes the injected chrome', () => {
    const box = document.querySelector('[data-dsh-ref-check]') as HTMLInputElement
    box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    enhancer.detach()
    expect(document.querySelector('[data-dsh-ref-bar]')).toBeNull()
    const row = document.querySelectorAll('[role="option"]')[0]!
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    row.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})
