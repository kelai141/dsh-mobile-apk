// @vitest-environment node
// 0.14.7-B：竖屏分层样式契约。
//
// 分层是「CSS 看数据属性」的实现，样式表与 settings-nav.ts 各写一半：属性名、层级取值、
// 回退选择器一旦两边漂移，界面上就是「点了分类什么都没变」这种静默失效。故在源码层钉住：
//  1. 两条层级规则存在，且都挂在手机形态标记下（横屏不可能被命中）；
//  2. 无分层模块时（属性缺席）仍有可用布局 —— 不能因为本模块没装配就把设置页变成白屏；
//  3. 新写入的颜色一律走 --dsw-* 主题变量（硬编码色会阻断主题继承）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { MOBILE_SETTINGS_CSS } from '../src/client/mobile-settings.css.ts'

/** 源码级的层级取值：必须与 settings-nav.ts 写进 DOM 的值逐字一致。 */
const LAYER_VALUES = ['home', 'detail']

describe('竖屏设置分层样式', () => {
  it('两条层级规则都在场，且都限定在手机形态标记下', () => {
    for (const level of LAYER_VALUES) {
      const marker = "data-dsh-settings-level='" + level + "']"
      expect(MOBILE_SETTINGS_CSS, '缺少 ' + level + ' 层规则').toContain(marker)
      const rule = MOBILE_SETTINGS_CSS.split(marker)[1] ?? ''
      expect(rule, level + ' 层规则必须存在').not.toBe('')
    }
    // 分层相关选择器一律以手机形态开头：横屏（无该标记）不可能命中任何一条。
    const layered = MOBILE_SETTINGS_CSS.split('}')
      .filter(rule => rule.includes('data-dsh-settings-level'))
    expect(layered.length).toBeGreaterThan(0)
    for (const rule of layered) {
      expect(rule, '分层规则必须 gate 在 html[data-dsh-mobile-form] 下')
        .toContain('html[data-dsh-mobile-form]')
    }
  })

  it('层级取值与 settings-nav.ts 写入 DOM 的值逐字一致', () => {
    const source = readFileSync('src/client/mobile/settings-nav.ts', 'utf8')
    expect(source).toContain("const LEVEL_HOME = 'home'")
    expect(source).toContain("const LEVEL_DETAIL = 'detail'")
    expect(source).toContain("const LEVEL_ATTR = 'data-dsh-settings-level'")
    // 装饰元素也必须是同一批属性名，否则样式落在不存在的节点上。
    for (const attr of ['data-dsh-settings-back', 'data-dsh-settings-bar', 'data-dsh-settings-bar-title',
      'data-dsh-settings-nav-desc', 'data-dsh-settings-nav-chevron', 'data-dsh-settings-nav-icon']) {
      expect(source, 'settings-nav.ts 必须写 ' + attr).toContain("'" + attr + "'")
      expect(MOBILE_SETTINGS_CSS, '样式表必须覆盖 ' + attr).toContain('[' + attr + ']')
    }
  })

  it('首页只显示分类列表、二级页只显示内容列（同一内容列不卸载）', () => {
    // 首页：隐藏内容列（> div:last-child），保留 nav。
    // 判据不能钉死成 > div:last-child：0.2.2 把面板拆成 navTitle/nav/header/options 四个直接子节点，
    // 只盖 last-child 会让 header（含上游关闭叉号）露出来，真机表现为「我方返回条 + 上游叉号」两个退出控件。
    // 这里按「除 [data-dsh-settings-bar] 外的直接子 div 全隐藏」判。
    const home = MOBILE_SETTINGS_CSS.split("data-dsh-settings-level='home'] > div:not([data-dsh-settings-bar])")[1] ?? ''
    expect(home, '首页必须隐藏我方标题条以外的直接子 div').toContain('display: none')
    // 二级页：隐藏 nav，内容列占满。
    const detail = MOBILE_SETTINGS_CSS.split("data-dsh-settings-level='detail'] > nav")[1] ?? ''
    expect(detail, '二级页必须隐藏分类列表').toContain('display: none')
    // 用 display 隐藏而不是卸载：内容列节点始终在场（未保存的编辑不丢）。
    expect(MOBILE_SETTINGS_CSS).not.toContain('content-visibility: hidden')
  })

  it('反证：分层属性缺席时仍有可用布局（本模块未装配也不白屏）', () => {
    expect(MOBILE_SETTINGS_CSS, '缺回退选择器：settings-nav 未装配时设置页会失去导航布局')
      .toContain(":not([data-dsh-settings-level])")
    const fallback = MOBILE_SETTINGS_CSS.split(':not([data-dsh-settings-level])')[1] ?? ''
    expect(fallback, '回退规则不得为空').not.toBe('')
  })

  it('一级行是「图标 + 标题 + 一行短说明 + 箭头」三列两行网格', () => {
    const block = MOBILE_SETTINGS_CSS.split('> nav button {')[1]?.split('}')[0] ?? ''
    expect(block, '一级行必须是网格布局').toContain('grid-template-columns')
    expect(block).toContain("'icon label chevron'")
    expect(block).toContain("'icon desc chevron'")
  })

  it('自有分区的图标：每行只留一个可见图标（上游那个被隐藏，不是并排两个）', () => {
    // 我方图标与上游被隐藏的那个各自要有规则，否则会出现一行两个图标。
    const injected = MOBILE_SETTINGS_CSS.split('svg[data-dsh-settings-nav-icon]')[1] ?? ''
    expect(injected, '缺我方图标的规则：它不占 grid 的 icon 格').toContain('grid-area: icon')
    const hidden = /nav button \[data-dsh-settings-nav-icon-hidden\]\s*\{([^}]*)\}/.exec(MOBILE_SETTINGS_CSS)?.[1] ?? ''
    expect(hidden, '缺隐藏上游图标的规则：一行会出现两个图标').toContain('display: none')
    // 不设 color：图标颜色继承行本身，与我方三个分类外的上游分类观感一致。
    expect(injected.split('}')[0] ?? '', '我方图标不得另设颜色，否则与上游图标色差可见').not.toContain('color:')
  })

  it('不新增硬编码颜色：每个颜色值都取自 --dsw-* 主题变量', () => {
    // 十六进制色在本表里出现 = 阻断主题继承（深色主题下会成为白底白字）。
    const withoutComments = MOBILE_SETTINGS_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(withoutComments.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], '不得硬编码十六进制颜色').toEqual([])
    // 颜色类属性（color / background / border-color…）的取值一律必须是 var(--dsw-*)，
    // 只放行 inherit / currentColor / transparent / none 这类结构性取值。
    const STRUCTURAL = /^(?:inherit|currentcolor|transparent|none|auto)/i
    const declarations = [...withoutComments.matchAll(
      /(?:^|[;{\n])\s*(color|background|background-color|border-color|outline-color):\s*([^;}]+)/g,
    )].map(match => [match[1]!, match[2]!.trim()] as const)
    expect(declarations.length, '本表必须有颜色声明，否则这条断言形同虚设').toBeGreaterThan(0)
    for (const [property, value] of declarations) {
      if (STRUCTURAL.test(value)) continue
      expect(value, property + ': ' + value + ' 必须取自 --dsw-* 主题变量')
        .toMatch(/^var\(--dsw-[a-z0-9-]+/)
    }
  })
})
