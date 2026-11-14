// @vitest-environment jsdom
// 关于页的「第二个关于」：上游内容列表头行由 about-section 认出**来源节点**后打属性，
// 样式只认属性（`[data-dsh-about-active] [data-dsh-about-header]`）。
//
// 关键在失败保护：内容列第一个孩子就是本页根节点时，宁可留着重复的「关于」，
// 也绝不能给它打标记——标记等于整页 display:none，界面上只剩一条返回条，
// 而这类缺陷在 jsdom / DOM 断言里看不见（不算布局）。
import { describe, it, expect, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AboutSection } from '../src/client/mobile/about-section.tsx'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined

afterEach(async () => {
  if (root !== undefined) {
    const current = root
    await act(async () => { current.unmount() })
  }
  root = undefined
  document.body.innerHTML = ''
})

interface Seeded {
  panel: HTMLElement
  mount: HTMLElement
  header: HTMLElement | null
}

/**
 * 造一个设置面板。
 *
 * @param shape - `header` = 面板 > 内容列 > [表头, 挂载点]；
 *   `wrapped` = 面板 > 内容列 > 滚动容器 > [表头, 挂载点]；
 *   `bare` = 面板 > 内容列 > 挂载点（没有表头行，第一个孩子就是本页根节点）。
 * @returns 面板、挂载点与（存在的）表头行。
 */
function seedPanel(shape: 'header' | 'wrapped' | 'bare'): Seeded {
  const panel = document.createElement('div')
  panel.setAttribute('data-dsh-settings-dialog', '')
  const column = document.createElement('div')
  panel.appendChild(column)
  const host = shape === 'wrapped' ? column.appendChild(document.createElement('div')) : column
  let header: HTMLElement | null = null
  if (shape !== 'bare') {
    header = document.createElement('div')
    header.textContent = '关于'
    host.appendChild(header)
  }
  const mount = document.createElement('div')
  host.appendChild(mount)
  document.body.appendChild(panel)
  return { panel, mount, header }
}

/**
 * 挂载关于页。
 *
 * @param mount - 挂载点。
 */
async function mountAbout(mount: HTMLElement): Promise<void> {
  await act(async () => {
    root = createRoot(mount)
    root.render(createElement(AboutSection, {} as never))
  })
}

describe('关于页收掉上游表头行', () => {
  it('认出内容列的表头行并打标记，离开时撤销', async () => {
    const { panel, mount, header } = seedPanel('header')
    await mountAbout(mount)
    expect(panel.hasAttribute('data-dsh-about-active'), '设置容器应带关于页标记').toBe(true)
    expect(header!.hasAttribute('data-dsh-about-header'), '表头行应被打标记').toBe(true)

    const current = root!
    await act(async () => { current.unmount() })
    root = undefined
    expect(header!.hasAttribute('data-dsh-about-header'), '离开后应撤销标记').toBe(false)
    expect(panel.hasAttribute('data-dsh-about-active'), '离开后应撤销关于页标记').toBe(false)
  })

  it('表头行外面多一层滚动容器时同样认得出来', async () => {
    const { mount, header } = seedPanel('wrapped')
    await mountAbout(mount)
    expect(header!.hasAttribute('data-dsh-about-header')).toBe(true)
  })

  it('没有表头行时什么都不标（失败保护：标了就是整页 display:none）', async () => {
    const { panel, mount } = seedPanel('bare')
    await mountAbout(mount)
    expect(panel.querySelector('[data-dsh-about-header]'), '不得把本页根节点当表头').toBeNull()
    const page = panel.querySelector('[data-plugin="android-about"]')
    expect(page?.hasAttribute('data-dsh-about-header'), '本页根节点绝不能被标记').toBe(false)
  })
})
