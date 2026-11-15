// @vitest-environment jsdom
// issue #1782（用户真机 V2425A 1260x2800）：正文整体被挤窄，右侧留出一条空白通道。
//
// 真因（设备 CDP 实测，420 CSS px 视口 = 1260px / density 3）：
//   上游 _scroll      padding: 16px calc(var(--dsh-composer-side-clearance) + 16px)  -> 右侧已有 32px 净空
//   上游 _toBottomSlot padding-right: max(clearance+16, 居中项) = 32px，按钮右缘与正文列对齐
//   本包 #1145       [data-chat-flow]{padding-right:52px}  -> 在已对齐的列里再压一次
// 实测 flow r=381.3 / 正文右缘 335.1 / 视口 420：右侧空白 84.9px，其中 52px 来自本包。
//
// 判据（每条配反证）：
//   A. 净空只在按钮真的在屏上时存在 —— 上游按「是否脱离尾部」挂载 _toBottomSlot，
//      它不存在 ⇔ 没有按钮可挡，此时正文必须吃满整列。
//   B. 按钮在屏上时净空必须仍然存在（否则按钮压住正文 44px，实测）。
//   C. 反证：把规则改回无条件的 [data-chat-flow]{padding-right}，A 必须判红。
import { describe, expect, it } from 'vitest'
import { TO_BOTTOM_GUTTER_CSS } from '../src/client/to-bottom-gutter.css.ts'

/** 按上游真实结构建一段对话：scroll 里有 flow（正文列），slot 是可选的按钮槽。 */
function mount(withSlot: boolean): { flow: HTMLElement; scroll: HTMLElement } {
  document.head.innerHTML = ''
  document.body.innerHTML =
    '<div data-conversation-scroll><div class="EvIC1a_scroll"><div class="EvIC1a_column" data-chat-flow></div></div>' +
    (withSlot ? '<div class="EvIC1a_toBottomSlot"><button aria-label="到最底部">v</button></div>' : '') +
    '</div>'
  const style = document.createElement('style')
  style.textContent = TO_BOTTOM_GUTTER_CSS
  document.head.appendChild(style)
  return {
    flow: document.querySelector<HTMLElement>('[data-chat-flow]')!,
    scroll: document.querySelector<HTMLElement>('[data-conversation-scroll]')!,
  }
}

/** 正文列实际吃到的右内边距（jsdom 对「没有声明」返回空串，与 0px 等价）。 */
function flowPaddingRight(flow: HTMLElement): string {
  const value = getComputedStyle(flow).paddingRight
  return value === '' || value === '0px' ? '0px' : value
}

describe('#1782 回到底部按钮的净空只在按钮在屏上时占用正文列', () => {
  it('A. 按钮槽不在（已跟随尾部）时，正文列不吃任何右侧净空', () => {
    const { flow } = mount(false)
    expect(flowPaddingRight(flow), '没有按钮可挡时正文必须吃满整列').toBe('0px')
  })

  it('B. 按钮槽在屏上时，净空仍然存在（按钮不得压住正文）', () => {
    const { flow } = mount(true)
    expect(flowPaddingRight(flow), '按钮在屏上时正文必须让出 52px').toBe('52px')
  })

  it('C. 反证：改回无条件 padding-right，A 必须判红', () => {
    // 构造缺陷形态：无条件命中正文列（去掉 :has() 作用域）。
    const broken = TO_BOTTOM_GUTTER_CSS.replace(/\[data-conversation-scroll\]:has\(\[class\*='_toBottomSlot'\]\)/, '[data-conversation-scroll]')
    expect(broken, '反证用例必须真的去掉 :has() 作用域').not.toBe(TO_BOTTOM_GUTTER_CSS)
    document.head.innerHTML = ''
    document.body.innerHTML =
      '<div data-conversation-scroll><div class="EvIC1a_scroll"><div class="EvIC1a_column" data-chat-flow></div></div></div>'
    const style = document.createElement('style')
    style.textContent = broken
    document.head.appendChild(style)
    const flow = document.querySelector<HTMLElement>('[data-chat-flow]')!
    expect(flowPaddingRight(flow), '缺陷形态下正文在无按钮时仍被压窄').toBe('52px')
  })
})

describe('#1782 按钮几何不被改坏（#1145 的原始诉求）', () => {
  it('按钮仍是 44x44 触摸目标，且负外边距把槽的 0 高度抵消', () => {
    expect(TO_BOTTOM_GUTTER_CSS).toContain('width: 44px')
    expect(TO_BOTTOM_GUTTER_CSS).toContain('height: 44px')
    expect(TO_BOTTOM_GUTTER_CSS).toContain('margin-top: -44px')
  })
})
