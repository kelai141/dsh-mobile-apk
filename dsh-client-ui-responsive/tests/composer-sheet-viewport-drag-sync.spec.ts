// 拖拽中视口变化必须同步 drag.height 与 appliedY（issue #1380）。
//
// 缺陷形态：relayoutSheet() 按新的 peek/max 重写 style.height，但 drag.height / appliedY 没跟着
// 对齐；下一次 move 的 delta 会叠加到旧基准上，卡片高度瞬跳。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/client/mobile/composer-sheet.ts', import.meta.url), 'utf8')

describe('拖拽中视口变化要同步拖拽基准（issue #1380）', () => {
  it('relayoutSheet 必须在拖拽中重写基准', () => {
    const body = src.slice(src.indexOf('private relayoutSheet(): void'), src.indexOf('private settleTo('))
    expect(body).toContain('if (this.drag !== null) {')
    expect(body).toContain('Number.parseFloat(panel.style.height)')
    expect(body).toContain('this.drag.appliedY = this.drag.lastY')
  })

  it('同步必须发生在 publishGeometry 之前', () => {
    const body = src.slice(src.indexOf('private relayoutSheet(): void'), src.indexOf('private settleTo('))
    expect(body.indexOf('this.drag.height = Number.isFinite(inline)'))
      .toBeLessThan(body.indexOf('this.publishGeometry()'))
  })
})
