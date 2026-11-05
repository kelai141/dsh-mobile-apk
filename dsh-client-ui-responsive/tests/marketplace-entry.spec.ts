// @vitest-environment jsdom
// 插件市场入口（0.15.0 用户定例）：整页由市场插件自己的浮层承载，入口只在「添加插件」下拉。
// 这里钉两件事：派发的是同一条 `store` 命令回执；缺通道/抛异常时安全降级。
import { describe, expect, it, vi } from 'vitest'
import { openMarketplaceDialog } from '../src/client/marketplace/marketplace-entry.tsx'

describe('插件市场入口', () => {
  it('派发 command/executed 的 store 回执（市场插件据此打开整页）', () => {
    const emit = vi.fn()
    expect(openMarketplaceDialog({ emit })).toBe(true)
    expect(emit).toHaveBeenCalledOnce()
    const [name, sessionId, command, result] = emit.mock.calls[0]!
    expect(name).toBe('command/executed')
    expect(sessionId).toBeNull()
    expect(command).toBe('store')
    expect(result).toEqual({ kind: 'success', query: '' })
  })

  it('没有 emit 通道时安全降级', () => {
    expect(openMarketplaceDialog(undefined)).toBe(false)
    expect(openMarketplaceDialog({})).toBe(false)
  })

  it('emit 抛异常时也被吞掉', () => {
    const emit = vi.fn(() => { throw new Error('boom') })
    expect(openMarketplaceDialog({ emit })).toBe(false)
  })
})
