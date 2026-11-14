// @vitest-environment node
// 「关于」入口与页面的样式契约。
//
// 这一层此前零覆盖，而两个真缺陷都是「CSS 写了但从来没生效」：
//  1. 选择器前缀写了两遍——注释夹在两段 `html[data-dsh-mobile-form]` 之间，CSS 注释被丢弃但
//     不产生空白 token，解析出来是 `html … html …` 的后代选择器（html 里再套一个 html），
//     永不匹配。关于页顶部那个「关于」标题因此一直没被收掉；
//  2. 全表 gate 在手机形态标记下，横屏 / 平板（innerWidth > 767，该标记不写）拿到零样式：
//     入口退化成原生 button，关于页失去整页排版。
// 判据钉在**解析后的选择器**上，不靠肉眼比对字符串。
import { describe, it, expect } from 'vitest'
import { ABOUT_ENTRY_CSS } from '../src/client/mobile/about-entry.css.ts'

/**
 * 去掉注释后按规则切分，返回每条规则的选择器文本（空白已归一）。
 *
 * @param css - 样式表源码。
 * @returns 选择器列表，顺序与源码一致。
 */
function ruleSelectors(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
    .map(match => match[1]!.trim().replace(/\s+/g, ' '))
}

describe('关于入口与页面的样式契约', () => {
  it('规则可解析，且没有任何一条选择器把 html 写两遍', () => {
    const selectors = ruleSelectors(ABOUT_ENTRY_CSS)
    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) {
      // 两条 html 连写会被解析成「html 里再套 html」，属于永不匹配的死规则。
      expect((selector.match(/\bhtml\b/g) ?? []).length, '选择器里出现了嵌套 html：' + selector)
        .toBeLessThanOrEqual(1)
    }
  })

  it('横屏 / 平板形态同样有样式（不得 gate 在手机形态标记下）', () => {
    // 入口与关于页都是本包自有节点，没有「上游横屏布局」要保留；带前缀等于让横屏拿到零样式。
    // 同页的 general-settings.css.ts 也是不带前缀的写法，两个面必须一致。
    expect(ABOUT_ENTRY_CSS).not.toContain('data-dsh-mobile-form')
  })

  it('入口、页面、两行版本、链接行都有规则', () => {
    const selectors = ruleSelectors(ABOUT_ENTRY_CSS)
    const needed = [
      '.dsh-about-entry',
      '.dsh-about-page',
      '.dsh-about-version',
      '.dsh-about-engine',
      '[data-plugin="android-about"] .dsh-gs-row',
    ]
    for (const needle of needed) {
      expect(selectors.some(selector => selector.includes(needle)), '缺 ' + needle + ' 的规则').toBe(true)
    }
  })

  it('收掉「第二个关于」用属性判据，不用结构选择器', () => {
    const selectors = ruleSelectors(ABOUT_ENTRY_CSS)
    expect(selectors.some(selector => selector.includes('[data-dsh-settings-bar-title]')),
      '缺标题条规则：移动层那一份「关于」收不掉').toBe(true)
    expect(selectors.some(selector => selector.includes('[data-dsh-about-header]')),
      '缺表头行规则：上游那一份「关于」收不掉').toBe(true)
    // 结构选择器假设内容列第一个孩子是表头；上游把分区根节点直接放进去时会把整页藏掉。
    expect(ABOUT_ENTRY_CSS).not.toContain('div:last-child')
    expect(ABOUT_ENTRY_CSS).not.toContain('div:first-child')
  })

  it('两条收标题的规则都限定在关于页标记下', () => {
    const selectors = ruleSelectors(ABOUT_ENTRY_CSS)
    for (const attr of ['[data-dsh-settings-bar-title]', '[data-dsh-about-header]']) {
      const rule = selectors.find(selector => selector.includes(attr))
      expect(rule, '缺 ' + attr + ' 的规则').toBeDefined()
      // 不限定在 about-active 下就等于「任何设置分区都不显示标题条」。
      expect(rule).toContain('[data-dsh-about-active]')
    }
  })
})
