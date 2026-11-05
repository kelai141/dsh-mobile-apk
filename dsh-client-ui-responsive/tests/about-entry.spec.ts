// @vitest-environment jsdom
// 「关于」入口（第二版：独立页面）：上游那行版本必须被隐藏并在原位插入「关于」入口；
// 点入口要**点一下导航里的『关于』行**（走移动层的列表→二级页），页面里显示两个版本。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { installAboutEntry, getEngineVersion } from '../src/client/mobile/about-entry.ts'
import { AboutSection } from '../src/client/mobile/about-section.tsx'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let cleanup: (() => void) | undefined

function seed(html: string): HTMLElement {
  const host = document.createElement('div')
  host.setAttribute('data-dsh-settings-dialog', '')
  host.innerHTML = html
  document.body.appendChild(host)
  return host
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe('关于入口（独立页面）', () => {
  beforeEach(() => {
    ;(window as unknown as { androidBridge?: unknown }).androidBridge = { version: () => '0.14.9' }
  })
  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    delete (window as unknown as { androidBridge?: unknown }).androidBridge
    document.body.innerHTML = ''
  })

  it('隐藏版本行并在其后插入「关于」，同时收起导航里的同名行', async () => {
    const host = seed('<div id="v">当前版本：0.2.1-rc.2</div><nav><button id="nav-about">关于</button></nav>')
    cleanup = installAboutEntry()
    await tick()
    expect(host.querySelector<HTMLElement>('#v')!.style.display).toBe('none')
    expect(host.querySelector('[data-dsh-about-entry]')!.textContent).toContain('关于')
    const navRow = host.querySelector<HTMLElement>('#nav-about')!
    expect(navRow.style.display, '导航行应收起').toBe('none')
    expect(getEngineVersion()).toBe('0.2.1-rc.2')
  })

  it('点入口会用导航行切换分区（不是弹层）', async () => {
    const host = seed('<div id="v">当前版本：0.2.1-rc.2</div><nav><button id="nav-about">关于</button></nav>')
    const click = vi.fn()
    host.querySelector('#nav-about')!.addEventListener('click', click)
    cleanup = installAboutEntry()
    await tick()
    host.querySelector<HTMLElement>('[data-dsh-about-entry]')!.click()
    await tick()
    expect(click).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-dsh-about-panel]'), '不得出现遮罩层').toBeNull()
  })

  it('关于页：图标 + 名称 + 版本 + 两条可点链接', async () => {
    const host = seed('<div id="v">当前版本：0.2.1-rc.2</div>')
    cleanup = installAboutEntry()
    await tick()
    const mount = document.createElement('div')
    document.body.appendChild(mount)
    let root: Root | undefined
    const opened: string[] = []
    const originalOpen = window.open
    // 拦截 window.open，确认链接点击真的往外跳
    window.open = ((url: string) => { opened.push(url); return null }) as never
    await act(async () => {
      root = createRoot(mount)
      root.render(createElement(AboutSection, {} as never))
    })
    const logo = mount.querySelector<HTMLImageElement>('.dsh-about-logo')
    expect(logo?.getAttribute('src')?.startsWith('data:image/png;base64,')).toBe(true)
    expect(mount.querySelector('.dsh-about-name')?.textContent).toBe('DeepCode')
    // 两行版本都要带标签（用户定例：DeepCode 版本：x / DeepSeek​Harness 版本：x）
    expect(mount.querySelector('[data-dsh-about-shell-version]')?.textContent).toBe('DeepCode 版本：0.14.9')
    expect(mount.querySelector('[data-dsh-about-engine-version]')?.textContent).toBe('DeepSeek​Harness 版本：0.2.1-rc.2')

    const links = [...mount.querySelectorAll<HTMLButtonElement>('[data-dsh-about-link]')]
    expect(links.length, '应有仓库与社群两条链接').toBe(2)
    expect(links[0]!.dataset.dshAboutLink).toContain('github.com/kelai141/dsh-mobile-apk')
    expect(links[1]!.dataset.dshAboutLink).toContain('qun.qq.com')
    links[0]!.click()
    links[1]!.click()
    expect(opened.length).toBe(2)
    expect(opened[0]).toContain('github.com')
    expect(opened[1]).toContain('qun.qq.com')
    window.open = originalOpen
    await act(async () => { root?.unmount() })
  })

  it('关于页隐藏顶部「关于」标题条（图标+名称已承担标题）', async () => {
    const host = seed('<div id="v">当前版本：0.2.1-rc.2</div>')
    const bar = document.createElement('span')
    bar.setAttribute('data-dsh-settings-bar-title', '')
    bar.textContent = '关于'
    host.appendChild(bar)
    cleanup = installAboutEntry()
    await tick()
    const mount = document.createElement('div')
    document.body.appendChild(mount)
    let root: Root | undefined
    await act(async () => {
      root = createRoot(mount)
      root.render(createElement(AboutSection, {} as never))
    })
    expect(host.hasAttribute('data-dsh-about-active'), '设置容器应带关于页标记').toBe(true)
    await act(async () => { root?.unmount() })
    expect(host.hasAttribute('data-dsh-about-active'), '离开后应撤销').toBe(false)
  })

  it('React 把版本行的 display 写回后，观察器要重新隐藏它', async () => {
    const host = seed('<div id="v">当前版本：0.2.1-rc.2</div>')
    cleanup = installAboutEntry()
    await tick()
    const node = host.querySelector<HTMLElement>('#v')!
    expect(node.style.display).toBe('none')
    // 模拟 React 重渲染：把 inline style 写回原值，再触发一次 childList 变更
    node.style.display = ''
    host.appendChild(document.createElement('div'))
    await tick()
    expect(node.style.display, '版本行必须被重新隐藏').toBe('none')
    expect(host.querySelectorAll('[data-dsh-about-entry]').length, '不得因此多插入入口').toBe(1)
  })

  it('关于页自己的版本行不会被当成上游版本行（否则版本消失、多出两个入口）', async () => {
    const host = seed('<div id="v">当前版本：0.2.1-rc.2</div>')
    cleanup = installAboutEntry()
    await tick()
    const mount = document.createElement('div')
    document.body.appendChild(mount)
    let root: Root | undefined
    await act(async () => {
      root = createRoot(mount)
      root.render(createElement(AboutSection, {} as never))
    })
    await tick()
    // 页面里的两行版本必须仍然可见
    const rows = [...mount.querySelectorAll<HTMLElement>('[data-dsh-about-shell-version],[data-dsh-about-engine-version]')]
    expect(rows.length).toBe(2)
    for (const row of rows) expect(row.style.display, '版本行不得被隐藏').not.toBe('none')
    // 且不得因为它们多插入入口
    expect(document.querySelectorAll('[data-dsh-about-entry]').length).toBe(1)
    await act(async () => { root?.unmount() })
  })

  it('没有「当前版本」文案时不得劫持别的「版本 x.y.z」行', async () => {
    // 其它分区里常见的短信息行（例如插件/模型的「版本 1.2.3」）不能被当成上游版本行：
    // 松匹配会把它隐藏并插上「关于」入口，这是审查中实测到的真 bug。
    const host = seed('<div id="decoy">版本 1.2.3</div>')
    cleanup = installAboutEntry()
    await tick()
    expect(host.querySelector<HTMLElement>('#decoy')!.style.display, '诱饵行不得被隐藏').not.toBe('none')
    expect(document.querySelectorAll('[data-dsh-about-entry]').length).toBe(0)
  })

  it('精确文案存在时仍然正常接管', async () => {
    const host = seed('<div id="decoy">版本 1.2.3</div><div id="real">当前版本：0.2.1-rc.2</div>')
    cleanup = installAboutEntry()
    await tick()
    expect(host.querySelector<HTMLElement>('#real')!.style.display).toBe('none')
    expect(host.querySelector<HTMLElement>('#decoy')!.style.display).not.toBe('none')
    expect(host.querySelectorAll('[data-dsh-about-entry]').length).toBe(1)
  })

  it('导航行被重建后仍保持收起（不会冒出第二个关于）', async () => {
    const host = seed('<div id="v">当前版本：0.2.1-rc.2</div><nav><button id="nav-about">关于</button></nav>')
    cleanup = installAboutEntry()
    await tick()
    const first = host.querySelector<HTMLElement>('#nav-about')!
    expect(first.style.display).toBe('none')
    // 模拟 React 重建导航行：新节点、无标记、无内联样式
    const nav = host.querySelector('nav')!
    nav.innerHTML = '<button id="nav-about2">关于</button>'
    await tick()
    expect(host.querySelector<HTMLElement>('#nav-about2')!.style.display, '重建后仍应收起').toBe('none')
    expect(host.querySelectorAll('[data-dsh-about-entry]').length).toBe(1)
  })

  it('回到一级列表（入口不在 DOM 里）时导航行仍然收起', async () => {
    const host = seed('<div id="v">当前版本：0.2.1-rc.2</div><nav><button id="nav-about">关于</button></nav>')
    cleanup = installAboutEntry()
    await tick()
    // 模拟离开分区：分区内容（含内联入口）被 React 卸载，只剩导航
    host.querySelector('#v')!.remove()
    host.querySelector('[data-dsh-about-entry]')?.remove()
    await tick()
    expect(host.querySelector<HTMLElement>('#nav-about')!.style.display, '导航行不得回到列表').toBe('none')
  })

  it('重复安装（插件重载）不会把导航行放出来，也不会多出入口', async () => {
    const host = seed('<div id="v">当前版本：0.2.1-rc.2</div><nav><button id="nav-about">关于</button></nav>')
    const first = installAboutEntry()
    await tick()
    expect(host.querySelector<HTMLElement>('#nav-about')!.style.display).toBe('none')
    // 插件卸载（热推）后重新安装：DOM 现场还在，新实例必须沿用
    first()
    cleanup = installAboutEntry()
    await tick()
    expect(host.querySelector<HTMLElement>('#nav-about')!.style.display, '导航行不得放出').toBe('none')
    expect(host.querySelectorAll('[data-dsh-about-entry]').length, '不得多出入口').toBe(1)
    // 旧实例插入的按钮仍可点（文档级委托）
    const clicked: string[] = []
    host.querySelector('#nav-about')!.addEventListener('click', () => clicked.push('nav'))
    host.querySelector<HTMLElement>('[data-dsh-about-entry]')!.click()
    await tick()
    expect(clicked.length, '点击应仍然触发分区切换').toBe(1)
  })

  it('从未接管成功时导航行保留（兜底入口）', async () => {
    // 「是否接管过」是模块级状态：这里要一份全新的模块实例，否则会被前面用例污染。
    vi.resetModules()
    const fresh = await import('../src/client/mobile/about-entry.ts')
    const host = seed('<div>没有版本行</div><nav><button id="nav-about">关于</button></nav>')
    cleanup = fresh.installAboutEntry()
    await tick()
    expect(host.querySelector<HTMLElement>('#nav-about')!.style.display).not.toBe('none')
  })

  it('restores a removed entry beside an already handled version row', async () => {
    const host = seed('<div id="v">当前版本：0.2.1-rc.2</div><nav><button id="nav-about">关于</button></nav>')
    cleanup = installAboutEntry()
    await tick()
    host.querySelector('[data-dsh-about-entry]')!.remove()
    await tick()
    expect(host.querySelectorAll('[data-dsh-about-entry]')).toHaveLength(1)
    const clicked: string[] = []
    host.querySelector('#nav-about')!.addEventListener('click', () => clicked.push('about'))
    host.querySelector<HTMLButtonElement>('[data-dsh-about-entry]')!.click()
    expect(clicked).toEqual(['about'])
  })

  it('recovers handled DOM and engine version in a fresh module instance', async () => {
    const host = seed('<div id="v" data-dsh-about-source="0.2.1-rc.3" style="display:none">当前版本：0.2.1-rc.3</div><nav><button id="nav-about">关于</button></nav>')
    vi.resetModules()
    const fresh = await import('../src/client/mobile/about-entry.ts')
    cleanup = fresh.installAboutEntry()
    await tick()
    expect(fresh.getEngineVersion()).toBe('0.2.1-rc.3')
    expect(host.querySelectorAll('[data-dsh-about-entry]')).toHaveLength(1)
    expect(host.querySelector<HTMLElement>('#nav-about')!.style.display).toBe('none')
  })

  it('does not rescan settings for unrelated chat mutations', async () => {
    const host = seed('<div id="v">当前版本：0.2.1-rc.2</div>')
    cleanup = installAboutEntry()
    await tick()
    const scan = vi.spyOn(host, 'querySelectorAll')
    const chat = document.createElement('div')
    document.body.appendChild(chat)
    await tick()
    chat.appendChild(document.createElement('span'))
    await tick()
    expect(scan).not.toHaveBeenCalled()
    scan.mockRestore()
  })

  it('重复渲染不会插入第二个入口', async () => {
    const host = seed('<div id="v">当前版本：0.2.1-rc.2</div>')
    cleanup = installAboutEntry()
    await tick()
    host.appendChild(document.createElement('div'))
    await tick()
    expect(host.querySelectorAll('[data-dsh-about-entry]').length).toBe(1)
  })
})
