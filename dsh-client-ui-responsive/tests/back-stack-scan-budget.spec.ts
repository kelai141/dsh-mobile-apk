// @vitest-environment jsdom
// back-stack 检测扫描预算（缺陷 3「整体卡顿」的判据之一）。
//
// 真因形状：BackStackSignal 观察整份文档（childList + subtree），每批变更合帧后跑一次
// detect()。detect() 里有 10 处 `document.querySelector(All)` **整文档**扫描，无论当前有没有
// 任何层。流式输出时每个 React 提交都触发一次，会话越长越贵。
//
// 判据（可测量，不读源码字符串）：
//  ① 每批提交的全文档查询次数 ≤ 2（修复前 10.0）；
//  ② 层语义不得改变 —— 与 back-stack-observer.spec.ts 同源的三个反证形状必须照旧成立
//     （属性在创建时写好的 dialog / 触发器菜单 / 附件 sheet 靠 childList 进场，深度=3，
//     uplink 只在可用性翻转时发）。只把查询删掉的改法在 ② 红。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { countDomScans, settle } from './dom-scan-counter.ts'

interface Signal { attach(): void; detach(): void }
let signal: Signal
let uplink: ReturnType<typeof vi.fn>

/** React 提交形状：属性在**创建时**写好，插入这个动作本身不产生属性变更。 */
function commitLayer(parent: Element, tag: string, attributes: Record<string, string>): HTMLElement {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
  parent.append(element)
  return element
}

/**
 * 造会话页并追加 N 批「3 个节点」的流式提交。
 * @param paragraphs - 正文段数。
 * @param batches - 提交批数。
 * @returns 每批全文档查询次数。
 */
async function streamBatches(paragraphs: number, batches: number): Promise<number> {
  document.body.innerHTML = ''
  document.documentElement.setAttribute('data-dsh-mobile-form', '')
  const frameRoot = document.createElement('div')
  frameRoot.setAttribute('data-dsh-frame', '')
  frameRoot.setAttribute('data-sidebar-collapsed', '')
  document.body.appendChild(frameRoot)
  const conversation = document.createElement('div')
  conversation.setAttribute('data-conversation', '')
  frameRoot.appendChild(conversation)
  for (let index = 0; index < paragraphs; index++) {
    const line = document.createElement('p')
    line.textContent = 'line ' + String(index)
    conversation.appendChild(line)
  }
  signal.attach()
  await settle()
  const counter = countDomScans()
  try {
    for (let batch = 0; batch < batches; batch++) {
      const wrapper = document.createElement('div')
      for (let token = 0; token < 3; token++) {
        const span = document.createElement('span')
        span.textContent = 'token'
        wrapper.appendChild(span)
      }
      conversation.appendChild(wrapper)
      await settle()
    }
    return counter.stats.documentCalls / batches
  } finally {
    counter.restore()
  }
}

beforeEach(async () => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-dsh-mobile-form')
  uplink = vi.fn()
  ;(window as unknown as { dshBackBridge: unknown }).dshBackBridge = { setAvailable: uplink }
  const { BackStackSignal } = await import('../src/client/mobile/back-stack.ts')
  signal = new BackStackSignal({ toggleSidebar: () => {}, activePanelId: () => null, leaveMainPanel: () => {} })
})

afterEach(() => {
  signal.detach()
  delete (window as unknown as { dshBackBridge?: unknown }).dshBackBridge
})

describe('back-stack 检测扫描预算', () => {
  it('① 每批提交的全文档查询 ≤ 2 次', async () => {
    const perBatch = await streamBatches(1_200, 20)
    console.log('① per_batch_queries=' + perBatch.toFixed(2))
    expect(perBatch, '每批提交的全文档查询次数（修复前 10.00）').toBeLessThanOrEqual(2)
  }, 120_000)

  it('② 反证：三个「属性在创建时写好」的层仍靠 childList 进场，深度=3', async () => {
    signal.attach()
    await settle()
    commitLayer(document.body, 'div', { role: 'dialog', 'aria-modal': 'true' })
    commitLayer(document.body, 'div', { 'data-trigger-menu': '' })
    commitLayer(document.body, 'div', { 'data-dsh-composer-sheet-backdrop': '' })
    await settle()
    expect((window as unknown as { __dshBackDepth?: number }).__dshBackDepth, '三层都必须被看见').toBe(3)
    // attach 的第一拍发布 false，三层进场后再发布一次 true —— 每次可用性翻转恰好一条。
    expect(uplink, '可用性翻转每次只发一条').toHaveBeenCalledTimes(2)
    expect(uplink).toHaveBeenNthCalledWith(1, false)
    expect(uplink).toHaveBeenNthCalledWith(2, true)
  }, 60_000)

  it('③ 反证：ModelSelect 门户与右侧全屏层仍被识别（合成选择器不得漏层）', async () => {
    signal.attach()
    await settle()
    const portal = commitLayer(document.body, 'div', { role: 'menu' })
    portal.setAttribute('data-dsh-android-model-menu', '')
    commitLayer(document.body, 'div', {
      'data-sidebar-right-panel': 'fullscreen',
      'data-sidebar-right-open': '',
    })
    await settle()
    const kinds = (window as unknown as { __dshBackKinds?: string[] }).__dshBackKinds ?? []
    expect(kinds, 'model-menu 与 right-fullscreen 两层都要在栈里').toContain('model-menu')
    expect(kinds).toContain('right-fullscreen')
  }, 60_000)

  it('④ 交叉场景：一个元素同时命中两个选择器时仍是两层，且顺序与旧实现一致', async () => {
    signal.attach()
    await settle()
    // 旧实现里 detectMenu 与 detectMarketplace 各自独立 querySelector：同一个元素同时带
    // data-trigger-menu 与 .dshm-overlay 时会**各入一层**。合成成一次扫描后必须保持这一点，
    // 且顺序仍是 detect() 的固定顺序（menu 在 marketplace 之前），不能合并、不能吞层。
    const both = commitLayer(document.body, 'div', { 'data-trigger-menu': '' })
    both.classList.add('dshm-overlay')
    await settle()
    const kinds = (window as unknown as { __dshBackKinds?: string[] }).__dshBackKinds ?? []
    expect(kinds, '一个元素命中两个选择器 → 两层，menu 在前').toEqual(['menu', 'marketplace'])
    expect((window as unknown as { __dshBack: () => boolean }).__dshBack(), '返回键必须消费').toBe(true)
  }, 60_000)

  it('⑤ 交叉场景：关系查询 [data-trigger-menu] nav 只认菜单之内的面包屑', async () => {
    signal.attach()
    await settle()
    // 第一个 trigger-menu 没有 nav（只有 listbox），第二个有 nav。旧的关系查询
    // [data-trigger-menu] nav 命中的是**第二个**菜单里的 nav；新实现按文档序取第一个含 nav
    // 的菜单，必须得到同一个元素，不能误配到菜单之外的 nav。
    const outside = commitLayer(document.body, 'nav', {})
    expect(outside.parentElement, '夹具：先放一个菜单之外的 nav').toBe(document.body)
    const withoutNav = commitLayer(document.body, 'div', { 'data-trigger-menu': '' })
    commitLayer(withoutNav, 'div', { role: 'listbox' })
    const withNav = commitLayer(document.body, 'div', { 'data-trigger-menu': '' })
    commitLayer(withNav, 'nav', {})
    await settle()
    const kinds = (window as unknown as { __dshBackKinds?: string[] }).__dshBackKinds ?? []
    expect(kinds, '菜单 + drill 两层（外部的 nav 不算 drill）').toEqual(['menu', 'menu-drill'])
  }, 60_000)
})
