// @vitest-environment jsdom
// 公共命令读取层（composer-commands.ts）回归：
//   - 命令清单只来自上游「+」菜单的真实 DOM，**禁止硬编码任何命令表**（反硬编码用例）；
//   - 附件行按标题闭集精确去重（不按位置/前缀，避免误伤「文件预览」这类真实功能项）；
//   - 读完后用上游自己的 Escape 链收起菜单（否则它会浮在页面上遮挡卡片）。
import { describe, it, expect, beforeEach } from 'vitest'
import {
  ADD_BUTTON_SELECTOR,
  ATTACHMENT_ROW_TITLES,
  hasComposerMenuButton,
  readComposerMenuCommands,
} from '../src/client/mobile/composer-commands.ts'

interface FixtureOption {
  label: string
  description?: string
  group?: string
}

/** 按上游真实形状搭夹具：card > button[aria-haspopup=listbox] + editor；菜单在点「+」后提交。 */
function buildComposer(options: readonly FixtureOption[]): { card: HTMLElement; button: HTMLButtonElement; surface: () => Element | null } {
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-haspopup', 'listbox')
  button.setAttribute('aria-expanded', 'false')
  button.setAttribute('aria-label', '添加文件或调用指令')
  card.append(button)
  const editor = document.createElement('div')
  editor.setAttribute('data-composer-input', '')
  editor.setAttribute('contenteditable', 'true')
  card.append(editor)
  document.body.append(card)
  // 上游的关闭链挂在编辑器根元素上（Lexical keydown）；夹具照抄这个形状，
  // 这样「Escape 必须派发到编辑器」这条判据才测得出（document.dispatchEvent 到不了）。
  editor.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    card.querySelector('[data-trigger-menu]')?.remove()
    button.setAttribute('aria-expanded', 'false')
  })
  button.addEventListener('click', () => {
    if (card.querySelector('[data-trigger-menu]') !== null) return
    const surface = document.createElement('div')
    surface.setAttribute('data-trigger-menu', '')
    const list = document.createElement('div')
    list.setAttribute('role', 'listbox')
    surface.append(list)
    card.append(surface)
    for (const option of options) {
      const container = document.createElement(option.group === undefined ? 'div' : 'div')
      if (option.group !== undefined) {
        container.setAttribute('role', 'group')
        container.setAttribute('aria-label', option.group)
      }
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'option')
      item.setAttribute('aria-label', option.label)
      const name = document.createElement('span')
      name.className = 'MenuView_itemName'
      name.textContent = option.label
      item.append(name)
      if (option.description !== undefined) {
        const desc = document.createElement('span')
        desc.className = 'MenuView_itemDescription'
        desc.textContent = option.description
        item.append(desc)
      }
      container.append(item)
      list.append(container)
    }
    button.setAttribute('aria-expanded', 'true')
  })
  return { card, button, surface: () => card.querySelector('[data-trigger-menu]') }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('readComposerMenuCommands', () => {
  it('返回当下上游菜单里的全部命令（反硬编码：夹具换成两条假命令就得到两条）', async () => {
    buildComposer([
      { label: '甲命令', description: '做甲事', group: '常用' },
      { label: '乙命令' },
    ])
    const commands = await readComposerMenuCommands()
    expect(commands.map((command) => command.name)).toEqual(['甲命令', '乙命令'])
    expect(commands[0]).toEqual({
      name: '甲命令',
      label: '甲命令',
      description: '做甲事',
      section: '常用',
    })
    expect(commands[1]).toEqual({ name: '乙命令', label: '乙命令', description: '', section: '' })
  })

  it('附件行按标题闭集精确去重，且不得按前缀误伤「文件预览」', async () => {
    buildComposer([
      { label: '文件' },
      { label: 'file' },
      { label: '文件预览' },
      { label: '命令丙' },
    ])
    const commands = await readComposerMenuCommands()
    expect(commands.map((command) => command.name)).toEqual(['文件预览', '命令丙'])
    // 闭集本身不含前缀项：这条断言把「精确匹配」钉在数据上。
    expect(ATTACHMENT_ROW_TITLES.has('文件预览'.toLowerCase())).toBe(false)
  })

  it('读完用上游自己的 Escape 链关掉菜单（不得留在屏幕上遮挡卡片）', async () => {
    const fixture = buildComposer([{ label: '命令甲' }])
    await readComposerMenuCommands()
    expect(fixture.surface()).toBeNull()
  })

  it('菜单由用户自己开着时也能读，读完同样收起', async () => {
    const fixture = buildComposer([{ label: '命令甲' }])
    // 模拟用户先点了「+」：openedHere = false 的分支。
    fixture.button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(fixture.surface()).not.toBeNull()
    const commands = await readComposerMenuCommands()
    expect(commands.map((command) => command.name)).toEqual(['命令甲'])
    expect(fixture.surface()).toBeNull()
  })

  it('页面没有合成器时返回空数组（不抛、不编）', async () => {
    await expect(readComposerMenuCommands()).resolves.toEqual([])
  })

  it('读不到名字的项跳过（不猜名称）', async () => {
    buildComposer([{ label: '' }])
    const commands = await readComposerMenuCommands()
    expect(commands).toEqual([])
  })
})

describe('hasComposerMenuButton', () => {
  it('有「+」时 true，没有时 false', () => {
    expect(hasComposerMenuButton()).toBe(false)
    buildComposer([])
    expect(hasComposerMenuButton()).toBe(true)
    expect(document.querySelector(ADD_BUTTON_SELECTOR)).not.toBeNull()
  })
})
