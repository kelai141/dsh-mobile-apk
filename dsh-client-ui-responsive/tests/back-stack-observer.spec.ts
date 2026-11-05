// @vitest-environment jsdom
// 审计 §7.3（back-stack 那一行）：观察者回调直接 sync()，没有合帧。
//
// 审计给的修法是「去掉 childList，只留 OBSERVED_ATTRIBUTES」，理由是「返回键前已有一次
// 同步 sync() 兜底」。本 spec 先证明那条兜底**到不了**，再钉住实际采用的修法：
//
//  ① 反证：childList 一去掉，React 风格的「属性在创建时写好、随后整棵子树插入」一个都看不见
//     （dialog / 触发器菜单 / 附件来源菜单），层栈深度停在 0；
//  ② 那些层看不见的后果不是「少一层」，而是壳侧根本不调 window.__dshBack（BackGate.decide
//     只在 pageStackAvailable 为真时走 DISPATCH_PAGE_STACK），返回键直接 finish 应用；
//  ③ 因此保留 childList，改为合帧：一阵 DOM 变更只做一次检测，且信号最终仍然送达。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackStackSignal } from '../src/client/mobile/back-stack.ts'

let signal: BackStackSignal
let uplink: ReturnType<typeof vi.fn>

/** 等观察者微任务 + 合帧宏任务都跑完。 */
async function flush(): Promise<void> {
  await new Promise(resolve => { setTimeout(resolve, 0) })
  await new Promise(resolve => { setTimeout(resolve, 0) })
}

/** React 提交形状：属性在**创建时**写好，插入文档这个动作本身不产生属性变更。 */
function commitLayer(parent: Element, tag: string, attributes: Record<string, string>): HTMLElement {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
  parent.append(element)
  return element
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-dsh-mobile-form')
  uplink = vi.fn()
  window.dshBackBridge = { setAvailable: uplink }
  signal = new BackStackSignal({ toggleSidebar: () => {}, activePanelId: () => null, leaveMainPanel: () => {} })
})

afterEach(() => {
  signal.detach()
  delete window.dshBackBridge
})

describe('审计 §7.3：childList 是必需的（层是靠插入进场的）', () => {
  it('属性在创建时写好的层，插入后仍被观察到（dialog / 菜单 / 附件菜单）', async () => {
    signal.attach()
    await flush()

    const dialog = commitLayer(document.body, 'div', { role: 'dialog', 'aria-modal': 'true' })
    await flush()
    expect(window.__dshBackDepth, 'dialog 靠 childList 进场').toBe(1)
    dialog.remove()

    commitLayer(document.body, 'div', { 'data-trigger-menu': '' })
    await flush()
    expect(window.__dshBackDepth, '触发器菜单靠 childList 进场').toBe(1)
    document.body.innerHTML = ''

    commitLayer(document.body, 'div', { 'data-dsh-composer-sheet-backdrop': '' })
    await flush()
    expect(window.__dshBackDepth, '附件来源菜单靠 childList 进场').toBe(1)
  })

  it('反证：去掉 childList 后这三层一条都看不见（深度停在 0）', async () => {
    // 旧观察面与「去掉 childList」的观察面各建一个，喂同一份 DOM。
    const withChildList = new BackStackSignal({ toggleSidebar: () => {}, activePanelId: () => null, leaveMainPanel: () => {} })
    const attributesOnly = new MutationObserver(() => {})
    // 直接构造「只观察属性」的等价夹具：以 attributes-only 观察 documentElement。
    attributesOnly.observe(document.documentElement, {
      subtree: true, attributes: true,
      attributeFilter: ['role', 'aria-modal', 'data-trigger-menu', 'data-dsh-composer-sheet-backdrop'],
    })
    let attributeOnlyHits = 0
    const attributeOnlyObserver = new MutationObserver((records) => { attributeOnlyHits += records.length })
    attributeOnlyObserver.observe(document.documentElement, {
      subtree: true, attributes: true,
      attributeFilter: ['role', 'aria-modal', 'data-trigger-menu', 'data-dsh-composer-sheet-backdrop'],
    })

    withChildList.attach()
    await flush()
    commitLayer(document.body, 'div', { role: 'dialog', 'aria-modal': 'true' })
    commitLayer(document.body, 'div', { 'data-trigger-menu': '' })
    commitLayer(document.body, 'div', { 'data-dsh-composer-sheet-backdrop': '' })
    await flush()

    expect(window.__dshBackDepth, '带 childList：三层都看得见').toBe(3)
    expect(attributeOnlyHits, '只要属性观察：零条记录（属性是插入前写好的）').toBe(0)
    withChildList.detach()
    attributesOnly.disconnect()
    attributeOnlyObserver.disconnect()
  })

  it('漏层的后果是壳侧不调 __dshBack：整栈为空时返回键直接 finish 应用', async () => {
    signal.attach()
    await flush()
    expect(uplink).toHaveBeenLastCalledWith(false)
    // 壳侧 BackGate.decide 的第三支：canGoBack=false 且 pageStackAvailable=false → finish。
    // 页面这一侧能证明的就是「有没有层」这一个布尔信号。
    expect(window.__dshBackDepth).toBe(0)

    commitLayer(document.body, 'div', { role: 'dialog', 'aria-modal': 'true' })
    await flush()
    expect(uplink, '层出现时必须把 available=true 送上去，否则壳侧不会问页面').toHaveBeenLastCalledWith(true)
  })
})

describe('审计 §7.3：观察者回调合帧，一阵变更只检测一次', () => {
  it('同一个合帧窗口内的多批 DOM 变更只结算一次检测', async () => {
    signal.attach()
    await flush()
    const syncSpy = vi.spyOn(signal as unknown as { sync: () => void }, 'sync')
    const before = syncSpy.mock.calls.length

    // 五批变更，每批都让出到微任务（观察者回调照常派发），但**不**让出到宏任务 ——
    // 这正是流式渲染的形状：一个 rAF 窗口里上游提交了好几次。
    for (let batch = 0; batch < 5; batch++) {
      document.body.append(document.createElement('span'))
      await Promise.resolve()
      await Promise.resolve()
    }
    const mid = syncSpy.mock.calls.length
    await flush()
    const detections = syncSpy.mock.calls.length - before
    expect(mid, '合帧窗口没结束前不该结算').toBeLessThanOrEqual(before)
    expect(detections, '五批变更合帧成一次检测').toBe(1)
    syncSpy.mockRestore()
  })

  it('反证：不合帧的回调对同一个窗口内的五批变更各检测一次', async () => {
    // 旧形状：MutationObserver(() => { sync() })，回调里直接检测，没有合帧。
    let detections = 0
    const observer = new MutationObserver(() => { detections += 1 })
    observer.observe(document.body, { childList: true, subtree: true })
    for (let batch = 0; batch < 5; batch++) {
      document.body.append(document.createElement('span'))
      await Promise.resolve()
      await Promise.resolve()
    }
    observer.disconnect()
    expect(detections, '旧形状：五批就检测五次（全文档查询也跟着做五次）').toBe(5)
  })

  it('合帧不吞掉信号：变更之后层栈仍然按新 DOM 结算', async () => {
    signal.attach()
    await flush()
    expect(window.__dshBackKinds).toEqual([])
    commitLayer(document.body, 'div', { role: 'dialog', 'aria-modal': 'true' })
    commitLayer(document.body, 'div', { 'data-trigger-menu': '' })
    await flush()
    expect(window.__dshBackKinds, '同一批里出现的两层都要算进来').toEqual(['dialog', 'menu'])
  })
})
