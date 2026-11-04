// @ 菜单「添加 N 项」的 in-flight 守卫（issue #1404）。
//
// 缺陷形态：按钮在整段异步插入期间保持可点（每项最长 1500+600ms）。第二次点按立刻进入第二个
// addSelected()，两个循环各自对同一批 key 调 pickByKey，同一文件/会话被插进输入框两次。
//
// 判据落在「点击处理里的守卫」与「插入循环的 try/finally + 按钮态同步」上——本文件读源码文本，
// 不驱动完整的上游 settle-pick 流程（那条路径的回归由 reference-menu-169.spec.ts 覆盖）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/client/mobile/reference-menu.ts', import.meta.url), 'utf8')

describe('@ 菜单「添加 N 项」in-flight 守卫（issue #1404）', () => {
  it('点击处理必须在起循环之前挡住第二次点按', () => {
    const handler = src.slice(src.indexOf('private readonly onMenuClick'), src.indexOf('attach(): void'))
    expect(handler).toContain('if (this.busy) return')
    expect(handler).toContain('void this.addSelected()')
    // 守卫必须在调用之前（否则第二次点击照样起循环）
    expect(handler.indexOf('if (this.busy) return')).toBeLessThan(handler.indexOf('void this.addSelected()'))
  })

  it('插入循环必须包在 try/finally 里，且在途态同步到按钮', () => {
    expect(src).toContain('this.busy = true')
    expect(src).toContain('this.busy = false')
    expect(src).toContain('} finally {')
    expect(src).toContain("add.setAttribute('aria-busy', 'true')")
    expect(src).toContain('add.disabled = this.busy')
  })
})
