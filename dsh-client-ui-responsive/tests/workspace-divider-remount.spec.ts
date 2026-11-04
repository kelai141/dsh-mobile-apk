// 右栏被上游重建时，进行中的分隔条拖动必须先落盘（issue #1382）。
//
// 缺陷形态：`sync()` 发现 panel 变了就 `unmount()`，而 `unmount()` 首行是 `onCancel()`——
// 拖动被丢弃、比例不落盘、也没有提示。旧实现只有「松手」这一个出口会写 resizeSplit。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/client/mobile/mobile-workspaces.ts', import.meta.url), 'utf8')

describe('右栏重建不得丢弃进行中的分隔条拖动（issue #1382）', () => {
  it('必须有 commitDivider 且只在 divider+moved 时落盘', () => {
    expect(src).toContain('private commitDivider(): void')
    const body = src.slice(src.indexOf('private commitDivider(): void'), src.indexOf('private swap(): void'))
    expect(body).toContain("drag.kind !== 'divider'")
    expect(body).toContain('resizeSplit(')
  })

  it('sync 重建前必须先落盘', () => {
    const sync = src.slice(src.indexOf('private sync(): void'), src.indexOf('private commitDivider(): void'))
    const commit = sync.indexOf('this.commitDivider()')
    const unmount = sync.indexOf('this.unmount()')
    expect(commit).toBeGreaterThanOrEqual(0)
    expect(commit).toBeLessThan(unmount)
  })

  it('松手出口也必须走同一段落盘逻辑', () => {
    const up = src.slice(src.indexOf('private readonly onUp'), src.indexOf('private commitDivider(): void'))
    expect(up).toContain('this.commitDivider()')
    expect(up).not.toContain('resizeSplit(')
  })
})
