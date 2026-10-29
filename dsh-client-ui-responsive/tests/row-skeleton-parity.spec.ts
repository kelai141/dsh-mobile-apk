// 行骨架一致性：本包的三个开发者页与「通用设置」用的是同一套 .dsh-gs-* 类，
// 但分属两张样式表（general-settings.css.ts / dev-section.css.ts）。两处值一旦漂移，
// 同一台设备上的两页会出现不同密度（真机曾出现 16px vs 8px），而功能测试完全看不见。
// 这里把「同一类名在两表里的声明必须一致」变成可判红断言。
import { describe, expect, it } from 'vitest'
import { GENERAL_SETTINGS_CSS } from '../src/client/general-settings/general-settings.css.ts'
import { DEV_SECTION_CSS } from '../src/client/dev-section/dev-section.css.ts'

/**
 * 抽出某个类选择器块里的声明表（同名多块时后者覆盖前者）。
 * 按花括号深度配对，不用 `[^{}]+\{[^{}]*\}`——本包的样式表里有 @media 块，
 * 那条正则会在嵌套处错位，导致目标块整块取不到（本测试第一版就是这么假红的）。
 */
function decls(css: string, selectorSource: RegExp): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) break
    const selector = css.slice(i, open)
    // 深度配对找本块结束位置
    let depth = 0
    let end = -1
    for (let j = open; j < css.length; j++) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') {
        depth--
        if (depth === 0) { end = j; break }
      }
    }
    if (end < 0) break
    const body = css.slice(open + 1, end)
    // 只接受「不含子块」的叶子块：含子块的（@media）继续往下走
    if (!body.includes('{') && selectorSource.test(selector)) {
      for (const decl of body.split(';')) {
        const idx = decl.indexOf(':')
        if (idx < 0) continue
        const prop = decl.slice(0, idx).replace(/\/\*[\s\S]*?\*\//g, '').trim()
        const value = decl.slice(idx + 1).replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' ')
        if (prop && value) out[prop] = value
      }
      i = end + 1
      continue
    }
    // 含子块：把选择器前缀喂进去继续找内部叶子块
    i = open + 1
  }
  return out
}

// 只看「基础行」那一块：把 .dsh-gs-row.dsh-gs-stacked（上下堆叠变体，gap 故意不同）与
// .dsh-gs-row:last-child（末行去分隔线的局部覆盖）都排除掉，否则后者会覆盖前者，
// 把变体的值当成基准值。
const ROW = /\.dsh-gs-row(?![\w.:-])/

describe('行骨架一致性', () => {
  it('三页的行内距、间距与分隔线跟通用设置一致', () => {
    const general = decls(GENERAL_SETTINGS_CSS, ROW)
    const dev = decls(DEV_SECTION_CSS, ROW)
    for (const prop of ['padding', 'gap', 'border-bottom', 'align-items', 'justify-content', 'display']) {
      expect(dev[prop], `dev-section 的 .dsh-gs-row ${prop} 与通用设置不一致`).toBe(general[prop])
    }
  })
})
