// 输入行 sheet 的手势取消路径（issue #1378）。
//
// 缺陷形态：`touchcancel` 与 `touchend` 绑到同一个处理器，而处理器不接收 event、无法区分
// 「用户松手」与「系统取消」。来电、通知下拉、浏览器接管滚动导致的手势取消会被按「提交」处理：
// 只要回弹量超过阈值就直接 close() —— 用户什么都没做，面板却被关掉。
//
// 判据落在「两个事件必须绑到不同处理器」+「取消路径不得调用 close()」上（读源码文本；拖拽的
// 几何行为由 composer-sheet.spec.ts 覆盖）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/client/mobile/composer-sheet.ts', import.meta.url), 'utf8')

describe('sheet 手势取消不得按提交处理（issue #1378）', () => {
  it('touchcancel 必须绑到独立处理器', () => {
    expect(src).toContain("addEventListener('touchend', this.onSheetTouchEnd)")
    expect(src).toContain("addEventListener('touchcancel', this.onSheetTouchCancel)")
    expect(src).not.toContain("addEventListener('touchcancel', this.onSheetTouchEnd)")
    expect(src).toContain("removeEventListener('touchcancel', this.onSheetTouchCancel)")
  })

  it('取消处理器只吸附、不关闭', () => {
    // 取一段窗口即可：cancel 处理器排在 end 处理器**之后**，用 end 作右边界会切出空串。
    const start = src.indexOf('private readonly onSheetTouchCancel')
    const body = src.slice(start, start + 800)
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain('settleTo(')
    expect(body).not.toContain('this.close()')
  })
})
