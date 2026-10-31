// @vitest-environment node
// 「设置 → 模型」页的插件自注入面**不得再回来**（负控）。
//
// 背景（2026-10-31 用户裁决）：本插件曾往模型编辑页注入一整块「从剪贴板填充」附属 UI
// （按钮 + 预览面板 + 模型字段下拉 + 识别失败提示 + 自动展开折叠的模型行）。用户当面确认
// **API 密钥输入框长按本来就能粘贴**，故这套是纯冗余，整套移除（PR 见分支
// fix/model-page-aux-buttons-prune）。
//
// 这个用例守两件事，缺一条就退化成「永远绿的幽灵用例」：
//   1. 注册面：index.ts 不再有 installClipboardModelDrafts 的调用与 import；
//   2. 产物面：源码树里不再存在该注入器的实现文件与桥声明。
// 判据故意用**源码**而非运行时 DOM——运行时 DOM 用例会在「注入器被删但调用还在」时因为
// 静默 no-op 而假绿；源码面在任一半边回来时立刻变红。
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

const INDEX = 'src/client/index.ts'
const BRIDGE = 'src/client/android-bridge.ts'

describe('model page carries no plugin-injected clipboard UI', () => {
  it('never registers a clipboard draft installer', () => {
    const source = readFileSync(INDEX, 'utf8')
    expect(source).not.toContain('installClipboardModelDrafts')
    expect(source).not.toContain('clipboard-model-drafts')
    // ctx.effect 的注册串也得一起没了，否则删了 import 还会留下一条无主 effect。
    expect(source).not.toContain('clipboard model drafts')
  })

  it('keeps the removed installer and parser out of the source tree', () => {
    expect(existsSync('src/client/mobile/clipboard-model-drafts.ts')).toBe(false)
    expect(existsSync('src/client/mobile/clipboard-model-config.ts')).toBe(false)
    expect(existsSync('src/client/mobile/clipboard-model-config.test.ts')).toBe(false)
    expect(existsSync('../tests/clipboard-model-drafts.spec.tsx')).toBe(false)
  })

  it('no longer declares the clipboard read bridge the installer needed', () => {
    const source = readFileSync(BRIDGE, 'utf8')
    expect(source).not.toContain('requestClipboardText')
    expect(source).not.toContain('cancelClipboardText')
  })

  it('leaves the upstream model editor contract untouched', () => {
    // 我们只删自己注入的东西：上游那些输入框的选择器一个字都不该被我们改写。
    // 本用例断言的是「删除没有顺手改到上游契约」——上游输入框仍是普通 input。
    const source = readFileSync(INDEX, 'utf8')
    expect(source).not.toContain('aria-label="API key"')
    expect(source).not.toContain('aria-label="API 密钥"')
  })
})
