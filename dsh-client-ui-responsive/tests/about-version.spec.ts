// @vitest-environment jsdom
// 引擎版本兜底。
//
// 版本原先只存在 about-entry 的模块变量里：模块重载（热推 / 页面重载 / 插件重新装配）之后
// 变量归零，而用户可能先落在别的设置分区——那时上游「当前版本」那行不在 DOM 里，抓不到，
// 关于页就显示 `—`，看起来像引擎版本取不到。DOM 上的 `data-dsh-about-source` 是跨实例真源。
//
// 本文件必须独占一个模块实例（vitest 默认按文件隔离），否则别的用例先把内存值填上了。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

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

/**
 * 造一个「接管过、但模块已经重载」的现场：面板里有打过标记的上游版本行，内存里没有值。
 *
 * @param version - 标记属性上的引擎版本。
 * @returns 设置面板。
 */
function seedHandledRow(version: string): HTMLElement {
  const panel = document.createElement('div')
  panel.setAttribute('data-dsh-settings-dialog', '')
  const row = document.createElement('div')
  row.setAttribute('data-dsh-about-source', version)
  row.setAttribute('style', 'display:none')
  row.textContent = '当前版本：' + version
  panel.appendChild(row)
  document.body.appendChild(panel)
  return panel
}

describe('引擎版本兜底', () => {
  it('内存里没有值时回读 DOM 上的 data-dsh-about-source', async () => {
    seedHandledRow('0.2.2-rc.1')
    const entry = await import('../src/client/mobile/about-entry.ts')
    expect(entry.getEngineVersion()).toBe('0.2.2-rc.1')
  })

  it('关于页渲染出回读到的版本，而不是占位符', async () => {
    seedHandledRow('0.2.2-rc.1')
    const { AboutSection } = await import('../src/client/mobile/about-section.tsx')
    const mount = document.createElement('div')
    document.body.appendChild(mount)
    await act(async () => {
      root = createRoot(mount)
      root.render(createElement(AboutSection, {} as never))
    })
    const engine = mount.querySelector('[data-dsh-about-engine-version]')?.textContent ?? ''
    expect(engine).toContain('0.2.2-rc.1')
    expect(engine, '不得落到占位符').not.toContain('—')
  })

  it('没有任何来源时如实返回空串（由页面显示占位符）', async () => {
    document.body.innerHTML = ''
    // 换一份全新的模块实例，确保内存值也是空的。
    vi.resetModules()
    const fresh = await import('../src/client/mobile/about-entry.ts')
    expect(fresh.getEngineVersion()).toBe('')
  })
})
