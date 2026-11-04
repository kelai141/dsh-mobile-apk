// 底部 sheet 手势必须跟踪 touch identifier（issue #1379）。
//
// 缺陷形态：start / move 都取 `touches[0]`、end 不判 `touches.length`。两指落下时拖拽记在
// touches[0]，抬起另一根手指会触发结算并把 drag 清空；反之 move 中换指会让 clientY 跳变。
//
// 判据落在「按 identifier 取指」与「抬起别的手指不结算」两处（读源码文本；几何行为由
// composer-sheet.spec.ts 覆盖）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/client/mobile/composer-sheet.ts', import.meta.url), 'utf8')

describe('sheet 手势跟踪 touch identifier（issue #1379）', () => {
  it('起手必须记住 identifier', () => {
    expect(src).toContain('private dragTouchId: number | null = null')
    expect(src).toContain('this.dragTouchId = touch.identifier')
  })

  it('move 必须按 identifier 取指', () => {
    expect(src).toContain('private trackedTouch(event: TouchEvent): Touch | undefined')
    // 用「处理器定义」作边界：addEventListener 里也有这两个名字，且出现在定义之前。
    const move = src.slice(
      src.indexOf('private readonly onSheetTouchMove'),
      src.indexOf('private readonly onSheetTouchEnd'),
    )
    expect(move).toContain('this.trackedTouch(event)')
    expect(move).not.toContain('event.touches[0]')
  })

  it('抬起别的手指不得结算', () => {
    const end = src.slice(src.indexOf('private readonly onSheetTouchEnd'), src.indexOf('private readonly onSheetTouchCancel'))
    expect(end).toContain('if (this.trackedTouch(event) !== undefined) return')
    expect(end).toContain('this.dragTouchId = null')
  })
})
