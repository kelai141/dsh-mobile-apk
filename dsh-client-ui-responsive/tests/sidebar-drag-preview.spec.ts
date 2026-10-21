// @vitest-environment jsdom
// 0.14.7 §2.1 实时跟手的**落点契约**守卫。
//
// 缺陷现场（2026-10-11）：CSS 侧的拖动关过渡规则只写了右栏本体
// （html[data-dsh-drawer-dragging] [data-sidebar-right-panel='fullscreen']），而右栏真正带
// transform 过渡的元素是它的 dockkit 子元素（上游 lib 内联样式：
// panel [data-dockkit-host=dock|empty|divider] → translateX(var(--dsh-sidebar-width))）。
// 于是拖动期间右栏那 200ms 过渡从未被关掉，表现为「跟不上手」，而左抽屉正常 —— 单测全绿，
// 因为没有任何一条用例把「写位移的选择器」与「关过渡的选择器」绑在一起。
//
// 本文件守的就是这条绑定：两处模块必须指向同一批 dockkit 节点，任一侧单边演进即判红。
//
// 注意 sidebar-drag-preview.ts 用模板串拼选择器（`${RIGHT_PANEL_SELECTOR} [data-dockkit-...]`），
// 所以它的源码里**不存在**拼好的整串 —— 断言必须按「面板选择器常量 + 三个 dockkit 片段」分别核，
// 不能拿拼好的字符串去 toContain（那会得到一个恒假的断言）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MOBILE_FORM_CSS } from '../src/client/mobile/mobile-form.css.ts'
import { SidebarDragPreview } from '../src/client/mobile/sidebar-drag-preview.ts'

/** 剥掉注释：断言不能被散文满足，也不能被散文击破。 */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 属性值的引号风格只是写法，统一成双引号后再比较。 */
const normalize = (text: string): string => text.replace(/'/g, '"')

const previewSource = normalize(code(readFileSync(
  join(process.cwd(), 'src', 'client', 'mobile', 'sidebar-drag-preview.ts'), 'utf8')))
const formCss = normalize(code(MOBILE_FORM_CSS))

/** 右栏滑动元素的三个 dockkit 片段（两处模块都必须覆盖）。 */
const DOCKKIT_PARTS = [
  '[data-dockkit-host="dock"]',
  '[data-dockkit-empty]',
  '[data-dockkit-divider]',
]

/**
 * 0.14.9：气泡头（顶栏）也是滑动元素。它挂在面板根节点下（sidebar-bubbles.ts 的
 * panel.append），不在 dockkit 子树里 —— 不纳入这批落点时，拖动期间内容跟手而顶栏钉在原地，
 * 松手提交后顶栏才随收起态瞬移消失（用户报告的原话）。
 */
const BUBBLE_CHROME_PART = '> [data-dsh-bubble-nav]'

/** 上游右栏本体的稳定属性；两处都必须以它为前缀限定，避免误伤浮动窗与其他面板。 */
const PANEL_SELECTOR = '[data-sidebar-right-panel="fullscreen"]'

describe('0.14.7 跟随位移的落点契约', () => {
  it('写位移侧（sidebar-drag-preview.ts）覆盖三个 dockkit 滑动元素，并以右栏本体限定', () => {
    expect(previewSource).toContain(PANEL_SELECTOR)
    for (const part of DOCKKIT_PARTS) {
      expect(previewSource).toContain(part)
    }
  })

  it('0.14.9：气泡头两处都覆盖（写位移侧按模板串片段核，关过渡侧核完整组合）', () => {
    // preview 侧是 `${RIGHT_PANEL_SELECTOR} > [data-dsh-bubble-nav]`，源码里没有拼好的整串。
    expect(previewSource).toContain(BUBBLE_CHROME_PART)
    expect(formCss).toContain('html[data-dsh-drawer-dragging] ' + PANEL_SELECTOR + ' ' + BUBBLE_CHROME_PART)
  })

  it('关过渡侧（mobile-form.css.ts）覆盖同一批元素 —— 只关右栏本体是缺陷形态', () => {
    for (const part of DOCKKIT_PARTS) {
      // 必须是「拖动标记 + 右栏本体 + dockkit 元素」的完整组合选择器，而不是裸的片段。
      expect(formCss).toContain('html[data-dsh-drawer-dragging] ' + PANEL_SELECTOR + ' ' + part)
    }
  })

  it('左抽屉仍在本体上关过渡（它本体就是被位移的元素，与右栏形态不同）', () => {
    expect(formCss).toContain(
      'html[data-dsh-drawer-dragging] [data-dsh-frame] > [class*="sidebarCol"]')
  })

  it('反证：只关右栏本体的旧规则不满足契约（证明本守卫不是恒真）', () => {
    const legacy = normalize([
      "html[data-dsh-drawer-dragging] [data-dsh-frame] > [class*='sidebarCol'],",
      "html[data-dsh-drawer-dragging] [data-sidebar-right-panel='fullscreen'] {",
      '  transition: none !important;',
      '}',
    ].join('\n'))
    // 旧形态有左抽屉与右栏本体，但一个 dockkit 滑动元素都没关。
    expect(legacy).toContain('html[data-dsh-drawer-dragging] ' + PANEL_SELECTOR)
    for (const part of DOCKKIT_PARTS) {
      expect(legacy).not.toContain('html[data-dsh-drawer-dragging] ' + PANEL_SELECTOR + ' ' + part)
    }
  })

  it('反证：把 dockkit 选择器从 CSS 里删掉，第一条断言必须判红', () => {
    const broken = formCss.replace(/\[data-dockkit-host="dock"\]/g, '')
    expect(broken).not.toContain(
      'html[data-dsh-drawer-dragging] ' + PANEL_SELECTOR + ' ' + DOCKKIT_PARTS[0]!)
  })
})

describe('0.14.9 跟手位移落点行为（jsdom）', () => {
  it('右栏按像素行程统一换算：气泡头与 dock 子元素同帧同值；左抽屉仍按自身宽度百分比', () => {
    document.body.innerHTML = [
      '<div data-sidebar-right-panel="fullscreen">',
      '<div data-dockkit-host="dock"></div>',
      '<div class="dsh-bubble-header" data-dsh-bubble-nav></div>',
      '</div>',
      '<div data-dsh-frame><div class="sidebarCol-x"></div></div>',
    ].join('')
    const preview = new SidebarDragPreview()
    preview.previewRight(0.5)
    const host = document.querySelector<HTMLElement>('[data-dockkit-host]')!
    const header = document.querySelector<HTMLElement>('.dsh-bubble-header')!
    // 半程位移必须是像素值（split 下百分比会随元素自身宽度漂移），且两处逐字一致。
    expect(host.style.transform).toMatch(/^translateX\(\d+(\.\d+)?px\)$/)
    expect(header.style.transform).toBe(host.style.transform)
    expect(header.style.visibility).toBe('visible')
    preview.endPreview()
    expect(host.style.transform).toBe('')
    expect(header.style.transform).toBe('')
    expect(header.style.visibility).toBe('')
    preview.previewLeft(0.5)
    const drawer = document.querySelector<HTMLElement>('[data-dsh-frame] > .sidebarCol-x')!
    expect(drawer.style.transform).toBe('translateX(-50%)')
  })
})
