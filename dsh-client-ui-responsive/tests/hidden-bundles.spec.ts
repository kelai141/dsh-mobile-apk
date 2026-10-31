// @vitest-environment jsdom
// 手机形态插件页：两个在 Android 上装得上、跑不起来的子智能体条目必须看不见（2026-10-31 用户决定）。
//
// 样式表与上游产物各写一半，且失效是静默的：选择器漂移后构建、类型检查、桌面形态截图全都照常绿，
// 只有人把插件页滑到底才会发现条目又回来了。故在源码层钉住四件事：
//   1. 常量确实点名这两个 bundle（清空常量 -> 本组用例必须变红，这就是负控）；
//   2. 每条规则都 gate 在 html[data-dsh-mobile-form] 下 —— 桌面/Web 形态一条都命中不到；
//   3. canary：拿规则去匹配「真实卡片形状」的夹具，每个 id 至少命中 1 个候选行。命中 0 说明上游改了
//      行结构（或这里属性名写错），必须红，不允许静默通过；
//   4. 对照插件（@deepseek-ai/dsh-android-file-open）不被任何规则命中 —— 只藏该藏的。
import { describe, it, expect, beforeEach } from 'vitest'
import { ANDROID_HIDDEN_BUNDLES, HIDDEN_BUNDLES_CSS } from '../src/client/mobile/hidden-bundles.css.ts'

/** 用户决定要藏的两个 bundle；把它写成字面量，常量被清空时用例必须失败。 */
const EXPECTED = ['@deepseek-ai/dsh-subagent-claude-code', '@deepseek-ai/dsh-subagent-codex']

/** 同一页上必须继续可见的对照插件。 */
const CONTROL = '@deepseek-ai/dsh-android-file-open'

/** 手机形态标记：由 mobile/form-marker.ts 发布，缺失即桌面/宽视口形态。 */
const MOBILE_FORM = 'html[data-dsh-mobile-form]'

/** 逐条拆出选择器，只保留真正藏元素（display: none）的规则。 */
function hideSelectors(): string[] {
  const css = HIDDEN_BUNDLES_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1]?.trim() ?? ''
    const body = rule[2] ?? ''
    if (selector === '' || selector.startsWith('@')) continue
    if (!/display:\s*none/.test(body)) continue
    for (const part of selector.split(',')) out.push(part.trim())
  }
  return out
}

/** 上游 PluginManagerPage 的两处行形状：列表卡与它打开的详情页，两者都按包名标注。 */
function rows(pkg: string): string {
  return '<li data-plugin-package="' + pkg + '"><span>' + pkg + '</span></li>'
    + '<div data-plugin-detail="' + pkg + '"></div>'
}

describe('Android 形态隐藏不可用插件条目', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-dsh-mobile-form')
    document.body.innerHTML = '<ul>' + [...EXPECTED, CONTROL].map(rows).join('') + '</ul>'
  })

  it('常量点名这两个 bundle，且规则表非空（清空常量即负控变红）', () => {
    expect(ANDROID_HIDDEN_BUNDLES).toEqual(EXPECTED)
    expect(hideSelectors().length, '隐藏规则表不能为空').toBeGreaterThan(0)
  })

  it('每条规则都 gate 在 html[data-dsh-mobile-form] 下', () => {
    for (const selector of hideSelectors()) {
      expect(selector, '每条规则都必须以手机形态标记开头').toMatch(/^html\[data-dsh-mobile-form\] /)
    }
  })

  it('canary：手机形态下每个 id 的列表卡与详情页都至少命中 1 行', () => {
    document.documentElement.setAttribute('data-dsh-mobile-form', '')
    const selectors = hideSelectors()
    for (const pkg of EXPECTED) {
      for (const attr of ['data-plugin-package', 'data-plugin-detail']) {
        const row = document.querySelector('[' + attr + '="' + pkg + '"]')
        expect(row, '夹具缺少 ' + attr + ' 行').not.toBeNull()
        const hits = selectors.filter(selector => row!.matches(selector)).length
        expect(hits, pkg + ' 的 ' + attr + ' 行命中 0 条规则：上游行结构或属性名已漂移').toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('手机形态下对照插件照常可见', () => {
    document.documentElement.setAttribute('data-dsh-mobile-form', '')
    const selectors = hideSelectors()
    for (const attr of ['data-plugin-package', 'data-plugin-detail']) {
      const row = document.querySelector('[' + attr + '="' + CONTROL + '"]')
      expect(row, '夹具缺少对照行').not.toBeNull()
      expect(selectors.filter(selector => row!.matches(selector)).length, '对照插件被误伤').toBe(0)
    }
  })

  it('桌面形态（无手机标记）两个条目一条规则都命中不到', () => {
    const selectors = hideSelectors()
    expect(selectors.length).toBeGreaterThan(0)
    for (const pkg of EXPECTED) {
      for (const attr of ['data-plugin-package', 'data-plugin-detail']) {
        const row = document.querySelector('[' + attr + '="' + pkg + '"]')
        expect(row, '夹具缺少 ' + attr + ' 行').not.toBeNull()
        expect(selectors.filter(selector => row!.matches(selector)).length, '桌面形态不许命中').toBe(0)
      }
    }
  })
})
