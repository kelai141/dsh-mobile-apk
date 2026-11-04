// 吸附过渡中起手不得读动画中间值（issue #1381）。
//
// 缺陷形态：`onSheetTouchStart` 用 `currentHeight()`（优先 getBoundingClientRect）当拖拽起点。
// 吸附动画进行中 rect 还在动，读到的是中间值 ⇒ 连点时 peek / expanded 判定可能反掉。
// 本文件自己的 `publishGeometry` 早已用「内联值优先」规避了同一问题。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/client/mobile/composer-sheet.ts', import.meta.url), 'utf8')

describe('起手基准高度必须用内联值（issue #1381）', () => {
  it('必须有 settledHeight 且优先读内联值', () => {
    expect(src).toContain('private settledHeight(): number')
    const helper = src.slice(src.indexOf('private settledHeight(): number'), src.indexOf('private setHeight('))
    expect(helper).toContain("Number.parseFloat(panel.style.height)")
    expect(helper.indexOf('Number.parseFloat(panel.style.height)'))
      .toBeLessThan(helper.indexOf('this.currentHeight()'))
  })

  it('touchstart 不得再用 currentHeight 当起点', () => {
    const start = src.slice(
      src.indexOf('private readonly onSheetTouchStart'),
      src.indexOf('private readonly onSheetTouchMove'),
    )
    expect(start).toContain('const height = this.settledHeight()')
    expect(start).not.toContain('this.currentHeight()')
  })
})
